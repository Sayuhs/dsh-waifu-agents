/**
 * dsh-waifu-agents — 角色长期记忆（persona memory）的存储与召回。
 *
 * 这一层只回答三个问题：**她记得什么**、**哪些该在这一轮给她看**、
 * **配置允许到什么程度**。它不认识团队运行时，也不认识宿主 ——
 * 团队剧情记忆（`team-memory.js`）是另一个东西，两者不共用文件、不共用窗口语义：
 *
 *   - 剧情记忆按 `session × team` 存，回答"这一局演到哪了"，会 fold、会过期；
 *   - 长期记忆按 `personaId` 存，回答"她这个人经历过什么"，不 fold、不过期，
 *     只有条数上限。
 *
 * 把两者混进一个文件，等于让某一局的临时事件变成角色的永久经历 ——
 * 而这恰好是本模块要防的第一件事。
 *
 * ## 为什么写盘是 temp-then-rename
 *
 * 一个角色的记忆文件可能正在被写：回合结束时追加、用户在面板上删除。
 * 直接 `writeFile` 在崩溃或断电时留下的是一个**截断的 JSON**，而
 * `readStore` 只能把它当损坏文件降级成空 —— 也就是一次写失败抹掉全部记忆。
 * 先写 `.tmp` 再 `rename`，崩溃时旧的完整文件仍在原处。
 *
 * ## 为什么不引入分词库
 *
 * 中文场景下"分词 + IDF"确实能提升召回，但本模块的语料尺度是
 * **每个角色几十条短句**：IDF 需要文档频率统计，在这个量级上退化成噪声；
 * 引入分词依赖则要把一个纯 Rule 的插件变成带词典的插件。
 * 所以这里用 2-gram + 停用词过滤，够用，且零依赖。
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** 单个人设记忆文件的 schema 版本号。 */
export const PERSONA_MEMORY_VERSION = 1;

/** 人设保留的条目数，超过后最旧的未固定条目会被丢弃。 */
export const DEFAULT_MAX_ENTRIES = 20;

/** 每个人设 `maxEntries` 设置的取值边界。 */
export const MIN_MAX_ENTRIES = 1;
export const MAX_MAX_ENTRIES = 200;

/** 单个条目可占用的字符数。更长的文本会按词边界截断。 */
export const ENTRY_MAX_CHARS = 60;

/** 每一轮为单个人设注入的条目数。存储深度再大也不会抬高这个值。 */
export const INJECT_PER_TURN = 3;

/**
 * 去掉标点和空白后仍短于这个长度的，不算一段经历。阈值定在 6，
 * 因为恰恰是那些短句不能保留 —— `哈哈哈`、`好的没问题`、`我知道了` ——
 * 而本插件房间里真正的对话台词远超这个长度。错杀一条临界短句，
 * 代价是丢一条记忆；留下一句凑数的话，代价是永久占一个名额。
 */
export const MIN_ENTRY_CHARS = 6;

/** 与各人设文件放在一起的共享配置文件名。 */
export const CONFIG_FILE = "_config.json";

/**
 * 一眼就是「机器产物」的标记，不是任何角色的经历。
 *
 * 三条都是实测从真机记忆里捞出来的：`<｜｜DSML｜｜ parameter name="command"`
 * 是闸门生效后模型把调用协议当正文吐出来的那段残片；围栏代码块是在工作模式
 * 里被当成「最长的一句」选中的；`antml` 是供应商的另一种协议写法。它们一旦
 * 写进记忆，下一轮命中查询词就会被当作「她记得的事」注入 —— 等于把乱码教给
 * 模型，而且会被它一轮轮抄下去。
 */
const PROTOCOL_SHAPED = /<｜｜|｜｜>|DSML|parameter\s+name\s*=|<\/?antml:|```/i;

/**
 * 代码味儿的行不算经历。
 *
 * 判据是「同时命中两类以上特征」，不是黑名单：单个 `(` 或一个下划线在中文
 * 台词里很常见（`（她把茶杯推过来）`、`feed_area` 这种名字也可能出现在闲聊
 * 里），但一条**被当成记忆**的句子同时带反引号和下划线标识符、或同时带 SQL
 * 关键字和括号，那基本就是工作模式下的一段代码，而不是她说过的话。
 * 宁可漏掉一条真台词，也不要把代码永久占掉一个名额 —— 后者还会被注入。
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeCode(text) {
  const body = String(text ?? "");
  let signals = 0;
  /* 单个反引号：中文台词里极少出现，出现多半是在引用代码。 */
  if (/`/.test(body)) signals += 1;
  /* 下划线/驼峰标识符：`feed_area`、`sortNo`、`camelCase`。 */
  if (/[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+|\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(body)) signals += 1;
  /* 赋值、箭头、分号收尾：`x = 1`、`=>`、`foo();`。 */
  if (/[A-Za-z0-9_)\]]\s*(?:=|=>|\+=)\s*[A-Za-z0-9_"'[{]/.test(body)) signals += 1;
  /* SQL / shell / 反斜杠路径。 */
  if (/\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/i.test(body)) signals += 1;
  if (/[A-Za-z]:\\|\/(?:usr|etc|home|var)\//.test(body)) signals += 1;
  /* 花括号里的键值对：`{"a": 1}`、`{ token }`。 */
  if (/\{[^}]*[:;,][^}]*\}/.test(body)) signals += 1;
  /* 函数调用形态：`name(arg)`，参数里至少有一个标识符。 */
  if (/\b[a-z_][A-Za-z0-9_]*\([A-Za-z_][A-Za-z0-9_]*[,)]/.test(body)) signals += 1;
  return signals >= 2;
}

/**
 * 在中文闲聊里不携带任何检索信号的词。只要 2-gram 中任一字符在这里，
 * 这个 gram 就被丢弃 —— 若按"整个 gram 不是停用词"来过滤，
 * `什么` 这类字对仍会以 `什么` 的形式漏进来。
 */
const STOP_CHARS = new Set(
  "的了是在我你他她它们这那有和就不也都说要会去来上下个一二三四五六七八九十多少很太更最又还再只把被给对从向到为以于之其而且但却吗呢吧啊呀哦嗯".split(
    "",
  ),
);

/** 过于常见、无法区分两条记忆的拉丁词。 */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "is", "are", "was",
  "were", "be", "been", "to", "of", "in", "on", "at", "for", "with", "by",
  "it", "this", "that", "i", "you", "we", "they", "me", "my", "your", "do",
  "does", "did", "not", "no", "so", "as", "can", "will", "would", "should",
]);

/** 把人设 id 收紧成任何平台文件名都能承载的形式。 */
export function safePersonaId(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return "";
  return text
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
}

/** 单个人设记忆文件的绝对路径。 */
export function storeFilePath(dir, personaId) {
  return path.join(dir, `${safePersonaId(personaId)}.json`);
}

/** 共享配置文件的绝对路径。 */
export function configFilePath(dir) {
  return path.join(dir, CONFIG_FILE);
}

/** 什么都没设置的配置：启用，所有人设都用默认深度。 */
export function emptyConfig() {
  /*
   * `captureToolTurns` 默认关：工作模式的回合里，被选中的「最长的一句」几乎
   * 总是代码或命令（实测里出现过整行 SQL），而角色记忆是给剧情用的。想让她
   * 连干活时的经历也记，面板上打开这一项即可。
   */
  return { v: PERSONA_MEMORY_VERSION, enabled: true, captureToolTurns: false, personas: {} };
}

/**
 * 把磁盘上的任意内容整理成一份可用的配置。
 *
 * 不认识的人设直接丢弃而不是留着：这个文件以人设 id 为键，
 * 一个已不在花名册里的 id 只是噪声，还得让面板去解释它。
 * 越界的 `maxEntries` 一律收紧，绝不信任 —— 否则手改的 `100000`
 * 会让某个人设无限制地增长。
 * @param {unknown} raw
 */
export function normalizeConfig(raw) {
  const out = emptyConfig();
  if (raw === null || typeof raw !== "object") return out;
  out.enabled = raw.enabled !== false;
  out.captureToolTurns = raw.captureToolTurns === true;
  const rows = raw.personas;
  if (rows === null || typeof rows !== "object" || Array.isArray(rows)) return out;
  for (const [id, value] of Object.entries(rows)) {
    const key = safePersonaId(id);
    if (key === "" || value === null || typeof value !== "object") continue;
    out.personas[key] = {
      enabled: value.enabled !== false,
      maxEntries: clampMaxEntries(value.maxEntries),
    };
  }
  return out;
}

/** 把任意值收紧到合法的深度范围内。 */
export function clampMaxEntries(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_MAX_ENTRIES;
  return Math.min(MAX_MAX_ENTRIES, Math.max(MIN_MAX_ENTRIES, n));
}

/** 单个人设的设置，由配置默认值落实而成。 */
export function personaConfigOf(config, personaId) {
  const id = safePersonaId(personaId);
  const row = config?.personas?.[id];
  return {
    enabled: row === undefined ? true : row.enabled !== false,
    maxEntries: row === undefined ? DEFAULT_MAX_ENTRIES : clampMaxEntries(row.maxEntries),
  };
}

/**
 * 所有调用方都必须经过的总开关。
 *
 * 全局关闭就是对所有人关闭 —— 不读、不注入、不写 —— 而重新打开后
 * 会恢复每个人设自己的选择，这正是每个人设的开关从不被全局开关改写的原因。
 */
export function effectiveEnabled(config, personaId) {
  if (config === null || typeof config !== "object") return false;
  if (config.enabled === false) return false;
  return personaConfigOf(config, personaId).enabled;
}

/** 读取共享配置；文件缺失或损坏时返回默认值。 */
export async function readConfig(dir) {
  let raw;
  try {
    raw = await fs.readFile(configFilePath(dir), "utf8");
  } catch {
    return emptyConfig();
  }
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return emptyConfig();
  }
}

/** 用与各存储相同的"先写临时文件再改名"纪律持久化配置。 */
export async function writeConfig(dir, config) {
  const body = JSON.stringify(normalizeConfig(config), null, 2);
  await writeAtomic(configFilePath(dir), body);
}

/**
 * 把补丁合并进配置并持久化。
 *
 * `patch.persona` 针对单个人设的条目（按需创建）；不带它时只会动
 * 全局的 `enabled`，别的一概不碰。这里是唯一的写入方，因此
 * "关掉全局开关不会清掉任何自己的开关"是结构上保证的，
 * 而不是靠每个调用点的自觉。
 * @param {string} dir
 * @param {{enabled?: boolean, captureToolTurns?: boolean, persona?: string, personaEnabled?: boolean, maxEntries?: number}} patch
 */
export async function updateConfig(dir, patch) {
  const current = await readConfig(dir);
  if (typeof patch?.enabled === "boolean") current.enabled = patch.enabled;
  if (typeof patch?.captureToolTurns === "boolean")
    current.captureToolTurns = patch.captureToolTurns;
  const id = safePersonaId(patch?.persona);
  if (id !== "") {
    const row = personaConfigOf(current, id);
    current.personas[id] = {
      enabled: typeof patch.personaEnabled === "boolean" ? patch.personaEnabled : row.enabled,
      maxEntries: patch.maxEntries === undefined ? row.maxEntries : clampMaxEntries(patch.maxEntries),
    };
  }
  await writeConfig(dir, current);
  return current;
}

/** 单个人设的空存储。 */
export function emptyStore(personaId) {
  return { v: PERSONA_MEMORY_VERSION, personaId: safePersonaId(personaId), entries: [] };
}

/** 把一行文本裁剪到条目预算内，且不切开代理对。 */
export function clampEntryText(text, cap = ENTRY_MAX_CHARS) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= cap) return flat;
  return `${flat.slice(0, cap - 1)}…`;
}

/**
 * 用解析出的任意内容重建一个存储，丢弃无法使用的行。
 * 没有文本的行不是记忆；kind 未知的行按剧情（episode）处理，
 * 因为猜成"stable"会让它跨团队生效。
 * @param {unknown} raw
 * @param {string} personaId
 */
export function normalizeStore(raw, personaId) {
  const out = emptyStore(personaId);
  if (raw === null || typeof raw !== "object") return out;
  const rows = Array.isArray(raw.entries) ? raw.entries : [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const text = clampEntryText(row.text);
    if (text === "") continue;
    out.entries.push({
      id: typeof row.id === "string" && row.id !== "" ? row.id : randomUUID().slice(0, 12),
      text,
      kind: row.kind === "stable" ? "stable" : "episode",
      source: normalizeSource(row.source),
      at: Number.isFinite(row.at) && row.at > 0 ? row.at : Date.now(),
      pinned: row.pinned === true,
    });
  }
  return out;
}

/** 规范一条记忆的来源：出自谁、出自哪里。 */
function normalizeSource(raw) {
  if (raw === null || typeof raw !== "object") return { kind: "unknown" };
  const kind = raw.kind === "team" ? "team" : raw.kind === "solo" ? "solo" : "unknown";
  const out = { kind };
  const team = String(raw.team ?? "").trim();
  if (team !== "") out.team = team;
  const session = String(raw.session ?? "").trim();
  if (session !== "") out.session = session;
  return out;
}

/**
 * 读取单个人设的记忆。文件损坏时返回一个标记 `broken` 的空存储，
 * 让面板能提示"这个文件读不出来"，而不是悄悄展示一个失忆的人设。
 * @param {string} dir
 * @param {string} personaId
 */
export async function readStore(dir, personaId) {
  const id = safePersonaId(personaId);
  if (id === "") return { ...emptyStore(""), broken: false };
  let raw;
  try {
    raw = await fs.readFile(storeFilePath(dir, id), "utf8");
  } catch {
    return { ...emptyStore(id), broken: false };
  }
  try {
    return { ...normalizeStore(JSON.parse(raw), id), broken: false };
  } catch {
    return { ...emptyStore(id), broken: true };
  }
}

/** 原子地写入单个人设的记忆。 */
export async function writeStore(dir, store) {
  const id = safePersonaId(store?.personaId);
  if (id === "") throw new Error("persona-memory: 缺少 personaId，无法写入");
  const body = JSON.stringify(
    {
      v: PERSONA_MEMORY_VERSION,
      personaId: id,
      entries: Array.isArray(store.entries) ? store.entries : [],
    },
    null,
    2,
  );
  await writeAtomic(storeFilePath(dir, id), body);
}

/** 先写临时文件再改名，存储与配置共用。 */
async function writeAtomic(file, body) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, file);
}

/**
 * 持续丢弃条目，直到存储满足 `maxEntries`。
 *
 * 固定的行最后动：用户固定一条是在说"这条比其余的都重要"，
 * 悄悄删掉它是唯一一个在面板上无法挽回的失败。当仅固定行本身就
 * 超过上限时，什么都不删，由 `overflow` 报告缺口 —— 调用方必须
 * 告知用户，而不是悄悄挑选牺牲品。
 * @param {object} store
 * @param {number} maxEntries
 * @returns {{store: object, dropped: number, overflow: number}}
 */
export function trimToLimit(store, maxEntries) {
  const cap = clampMaxEntries(maxEntries);
  const entries = Array.isArray(store?.entries) ? store.entries : [];
  const pinned = entries.filter((one) => one.pinned === true);
  const loose = entries.filter((one) => one.pinned !== true);
  if (entries.length <= cap) return { store: { ...store, entries }, dropped: 0, overflow: 0 };
  if (pinned.length >= cap) {
    return { store: { ...store, entries }, dropped: 0, overflow: pinned.length - cap };
  }
  const keepLoose = loose.slice(loose.length - (cap - pinned.length));
  const keep = new Set([...pinned, ...keepLoose]);
  const next = entries.filter((one) => keep.has(one));
  return { store: { ...store, entries: next }, dropped: entries.length - next.length, overflow: 0 };
}

/**
 * 这段文本到底该不该存？
 *
 * 三种拒绝，全部基于规则、全部廉价：空/短到不构成经历、
 * 与她已记得的内容完全重复、纯粹凑数的一行。原因由调用方记录，
 * 本函数从不猜测。
 * @param {ReadonlyArray<object>} entries 现有条目
 * @param {string} text 候选文本
 * @returns {{ok: boolean, reason?: string, text?: string}}
 */
export function screenEntry(entries, text) {
  const cleaned = clampEntryText(text);
  /*
   * 机器产物先于长度判断：`<｜｜DSML｜｜ …` 这种残片既不短也不重复，
   * 只靠「太短 / 重复」两道闸一条都拦不住。
   */
  if (PROTOCOL_SHAPED.test(cleaned)) return { ok: false, reason: "tool-protocol" };
  if (looksLikeCode(cleaned)) return { ok: false, reason: "code" };
  if (cleaned.replace(/[\s\p{P}]/gu, "").length < MIN_ENTRY_CHARS) return { ok: false, reason: "too-short" };
  const key = dedupKey(cleaned);
  if (key === "") return { ok: false, reason: "empty" };
  for (const one of Array.isArray(entries) ? entries : []) {
    if (dedupKey(one?.text) === key) return { ok: false, reason: "duplicate" };
  }
  return { ok: true, text: cleaned };
}

/** 用于比对的键：标点、空白与大小写在这里都没有意义。 */
function dedupKey(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/**
 * 追加一条通过筛查的条目，并在同一次写入中执行深度上限。
 *
 * `at` 在这里设置而不是由调用方传入：每个条目的时间戳回答的是
 * "她什么时候经历过这件事"，调用方时钟不准会让最新的记忆
 * 排成最旧的。
 * @param {object} store
 * @param {{text: string, kind?: 'episode'|'stable', source?: object, at?: number}} input
 * @param {number} maxEntries
 * @returns {{store: object, added: object|null, reason?: string, dropped: number, overflow: number}}
 */
export function appendEntry(store, input, maxEntries) {
  const base = store ?? emptyStore("");
  const screen = screenEntry(base.entries, input?.text);
  if (!screen.ok) {
    return { store: base, added: null, reason: screen.reason, dropped: 0, overflow: 0 };
  }
  const entry = {
    id: randomUUID().slice(0, 12),
    text: screen.text,
    kind: input?.kind === "stable" ? "stable" : "episode",
    source: normalizeSource(input?.source),
    at: Number.isFinite(input?.at) && input.at > 0 ? input.at : Date.now(),
    pinned: false,
  };
  const trimmed = trimToLimit({ ...base, entries: [...base.entries, entry] }, maxEntries);
  return { ...trimmed, added: entry, reason: undefined };
}

/** 一个条目在本轮能否被使用。见 {@link recallEntries}。 */
function usableInScope(entry, scope) {
  if (entry.kind === "stable") return true;
  const where = entry.source?.kind;
  if (scope?.mode === "team") {
    /* 一个故事自己的事件只留在那个故事里。单人剧情里的片段也
       不能当作团队剧情的证据 —— 她或许在那里"见过"用户，
       但那个房间从未目睹。 */
    return where === "team" && entry.source?.team === scope.team;
  }
  return where === "solo";
}

/**
 * 从中/英文查询里提取检索词。
 *
 * 中文没有空格，所以单位是 2-gram；含停用字符的 gram 会被丢弃，
 * 这正是无需词典就能把 `什么` 和 `我们` 挡在外面的原因。
 * 拉丁字母串按非字母切分，再经停用词过滤。
 * @param {string} query
 * @returns {Set<string>}
 */
export function queryTokens(query) {
  const text = String(query ?? "").toLowerCase();
  const tokens = new Set();
  for (const run of text.match(/[a-z0-9_]+/g) ?? []) {
    if (run.length < 2 || STOP_WORDS.has(run)) continue;
    tokens.add(run);
  }
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (STOP_CHARS.has(gram[0]) || STOP_CHARS.has(gram[1])) continue;
      tokens.add(gram);
    }
  }
  return tokens;
}

/**
 * 为当前轮次对单个人设的记忆排序。
 *
 * 评分刻意粗钝，因为另一种选择就是假装它理解语义：
 *
 *   - 文本中每命中一个不同的查询词：+3
 *   - `stable` 记忆：+2（它们才是能挺过场景切换的那部分）
 *   - 与当前场景同一团队：+1
 *   - 新近度：最多 +0.5，让"最新"永远压不过"命中"
 *
 * 排序必须**确定** —— 相同输入，相同输出 —— 否则注入块会莫名其妙
 * 每轮都变，提示词前缀也就不再稳定。平局先按 `at`（新的在前），
 * 再按 id。
 *
 * 没有命中就什么都不返回：空结果必须完全不产出块，
 * 绝不能是一个下面空空如也的标题。
 * @param {ReadonlyArray<object>} entries
 * @param {string} query
 * @param {{limit?: number, scope?: {mode: 'solo'|'team', team?: string}}} [options]
 */
export function recallEntries(entries, query, options = {}) {
  const limit = Math.max(0, Math.trunc(Number(options.limit ?? INJECT_PER_TURN)));
  if (limit === 0) return [];
  const tokens = queryTokens(query);
  const scope = options.scope ?? { mode: "solo" };
  const rows = [];
  const pool = Array.isArray(entries) ? entries : [];
  /*
   * 新近度按 `at` 度量，而不是按数组下标：下标会让分数取决于行被
   * 追加的顺序，文件换个顺序重写就会毫无理由地打乱注入块 ——
   * 恰是整个设计要避免的提示词抖动。
   */
  let newest = 0;
  let oldest = 0;
  for (const entry of pool) {
    const at = Number.isFinite(entry?.at) ? entry.at : 0;
    if (at > newest) newest = at;
    if (oldest === 0 || at < oldest) oldest = at;
  }
  const span = newest - oldest;
  pool.forEach((entry) => {
    if (entry === null || typeof entry !== "object") return;
    if (!usableInScope(entry, scope)) return;
    const text = String(entry.text ?? "").toLowerCase();
    let hits = 0;
    for (const token of tokens) if (text.includes(token)) hits += 1;
    if (hits === 0) return;
    const at = Number.isFinite(entry.at) ? entry.at : 0;
    const recency = span <= 0 ? 0 : ((at - oldest) / span) * 0.5;
    const score =
      hits * 3 + (entry.kind === "stable" ? 2 : 0) + (scope?.mode === "team" && entry.source?.team === scope.team ? 1 : 0) + recency;
    rows.push({ entry, score, hits });
  });
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((b.entry.at ?? 0) !== (a.entry.at ?? 0)) return (b.entry.at ?? 0) - (a.entry.at ?? 0);
    return String(a.entry.id).localeCompare(String(b.entry.id));
  });
  return rows.slice(0, limit).map((row) => row.entry);
}

/**
 * 在当前作用域内合法的最新记忆，忽略查询词。
 *
 * 这是没有可用查询的那一轮的兜底 —— 面板预览，或最后一条用户消息
 * 读不出来的会话。没有查询就谈不上召回：`recallEntries` 在没有词
 * 命中时正确地返回空，而每个无法查询的轮次都返回空会让整个功能
 * 看起来坏了。新近度是诚实的第二选择，也正是存储上限已经在用的
 * 同一条规则。
 * @param {ReadonlyArray<object>} entries
 * @param {{limit?: number, scope?: {mode: 'solo'|'team', team?: string}}} [options]
 */
export function recentEntries(entries, options = {}) {
  const limit = Math.max(0, Math.trunc(Number(options.limit ?? INJECT_PER_TURN)));
  if (limit === 0) return [];
  const scope = options.scope ?? { mode: "solo" };
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry !== null && typeof entry === "object" && usableInScope(entry, scope))
    .slice()
    .sort((a, b) => {
      const at = Number.isFinite(b?.at) ? b.at : 0;
      const bt = Number.isFinite(a?.at) ? a.at : 0;
      if (at !== bt) return at - bt;
      return String(a.id).localeCompare(String(b.id));
    })
    .slice(0, limit);
}

/**
 * 注入到本轮之前的块，无话可说时返回 ""。
 *
 * 两条边界直接写进块里，因为提示词是唯一能告知模型的地方：
 *
 *   1. 每个人设的台词都带她自己的协议名 `〔名字〕`，
 *      多角色的房间才不会认错归属；
 *   2. 静态人设优先于这些记忆 —— 记忆记录的是发生过什么，
 *      它不重写她是谁。
 *
 * 单人模式传入 `tagNames: false` 并用自己的标题：没有第二个归属者
 * 需要消歧，而单一声部的提示词里出现 `〔名字〕` 行读起来像一段
 * 该由模型续写的对话记录。
 * @param {ReadonlyArray<{name: string, entries: ReadonlyArray<object>}>} rows
 * @param {{heading?: string, note?: string, tagNames?: boolean}} [options]
 */
export function renderMemoryBlock(rows, options = {}) {
  const heading = String(options.heading ?? "【各人记得的事】");
  const note = String(
    options.note ??
      "（以上是各位角色各自的经历片段，只属于括号里的人。不要把自己以外的人的回忆当成自己的；"
        + "人设里写定的性格与设定优先于这些经历，不确定某件事是否发生在当前故事里时不要断言。）",
  );
  const tagNames = options.tagNames !== false;
  const parts = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row?.name ?? "").trim();
    const entries = Array.isArray(row?.entries) ? row.entries : [];
    if (entries.length === 0) continue;
    if (tagNames && name === "") continue;
    if (tagNames) parts.push(`〔${name}〕`);
    const lines = entries.map((one, index) => `${index + 1}. ${one.text}`);
    parts.push(...lines);
  }
  if (parts.length === 0) return "";
  return [heading, ...parts, note].join("\n");
}

/**
 * 把单个人设的记忆迁移到新 id。
 *
 * id 就是文件名（也是预设 id），否则一次改名就会让整个文件成为孤儿，
 * 看起来恰恰像"她忘了一切"。目标位置绝不覆盖：如果那里已有文件，
 * 就拒绝改名、由调用方决定，而不是把两个角色的人生合并到一起。
 * @param {string} dir
 * @param {string} fromId
 * @param {string} toId
 * @returns {Promise<{moved: boolean, reason?: string}>}
 */
export async function migratePersona(dir, fromId, toId) {
  const from = safePersonaId(fromId);
  const to = safePersonaId(toId);
  if (from === "" || to === "" || from === to) return { moved: false, reason: "noop" };
  const source = storeFilePath(dir, from);
  const target = storeFilePath(dir, to);
  try {
    await fs.access(source);
  } catch {
    return { moved: false, reason: "absent" };
  }
  try {
    await fs.access(target);
    return { moved: false, reason: "target-exists" };
  } catch {
    // 目标位置空闲：这正是我们想要的情况。
  }
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.rename(source, target);
  } catch (error) {
    return { moved: false, reason: `failed:${error?.message ?? error}` };
  }
  /* 每人设的配置行随文件一起迁移，否则新 id 会悄悄继承默认值
     （启用，20 条），而不是用户设置的内容。 */
  const config = await readConfig(dir);
  if (config.personas[from] !== undefined) {
    config.personas[to] = config.personas[from];
    delete config.personas[from];
    await writeConfig(dir, config);
  }
  return { moved: true };
}

/** 删除单个人设的记忆文件。不存在也没关系。 */
export async function clearStore(dir, personaId) {
  const id = safePersonaId(personaId);
  if (id === "") return false;
  try {
    await fs.rm(storeFilePath(dir, id), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 当前拥有记忆文件的人设 id 列表。 */
export async function listStoredIds(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && name !== CONFIG_FILE)
    .map((name) => name.slice(0, -5))
    .filter((id) => id !== "");
}
