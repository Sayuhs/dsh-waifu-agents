/**
 * 团队记忆：让下一轮知道之前几轮说过什么的东西。
 *
 * ## 结构
 *
 * 一个会话的记忆是三个盒子：
 *
 *  - `rounds`  —— 最近的讨论，**逐字**保留，每轮一条。
 *  - `summary` —— 更早的一切，压缩成一段有界的段落。
 *  - `backlog` —— 已从 `rounds` 驱逐、但尚未折叠进 `summary` 的各轮
 *    （折叠需要一次 LLM 调用，而调用失败绝不能丢掉文本）。
 *
 * ## 为什么用字符而不是 token
 *
 * 这里的每个上限都以字符计。本插件不运行分词器，而
 * 中文≈每字符 0.63 token 的估算在 4k 量级上能差出几百个 token ——
 * 以 token 计的预算只是带着小数点的虚构。字符可测量，
 * 各默认值也是按这个度量保守选取的。
 *
 * ## 为什么驱逐按整轮进行
 *
 * 一轮的文本是一串 〔名字〕 段落。在任意字符处切断，会在记忆里
 * 留下半句话，下一轮会把它当作场景的状态；在一轮的边界处切断，
 * 留下的是一幅连贯（虽然旧一些）的图景。因此窗口装下的字符数
 * 可能少于上限 —— 这正是目的所在。
 *
 * ## 为什么折叠是惰性的
 *
 * 把 `backlog` 折进 `summary` 要花一次 LLM 调用。放在驱逐时刻做，
 * 就会落在运行的 `finally` 里：慢调用不会延误任何看得见的东西，
 * 但错误处理面很难看（回复流已关闭）。放在下一轮的开头做，
 * 调用就能留在一个有真正错误处理的活跃 fiber 里 —— 代价是
 * 驱逐后的那一轮多等几秒，而这可以摊平：只有窗口填满才会驱逐。
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** 磁盘文件的 schema 版本号。 */
export const MEMORY_VERSION = 1;

/** 逐字保留供注入的最近各轮的字符数。 */
export const MEMORY_WINDOW_CHARS = 4800;

/** 折叠后的梗概可占用的字符数。 */
export const MEMORY_SUMMARY_CHARS = 800;

/** 记忆闲置这么久即告死亡：加载时过期。 */
export const MEMORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 把团队的保留选项映射成 `readMemory` 能理解的 TTL。
 *
 * `memoryTtlDays` 是团队记录里存的值（面板编辑的标量）：
 * `0` 表示"永久保留"，正数是以天计的闲置窗口，
 * 其他任何值都回退到随附的默认一周。`Infinity` —— 而不是某个
 * 巨大的数 —— 才是"永不过期"的哨兵值，否则 `readMemory` 里的
 * `Number.isFinite` 守卫会把它吞成默认值。
 * @param {unknown} days 团队记录的 `memoryTtlDays`
 * @returns {number} 以毫秒计的 TTL，永久保留时为 `Infinity`
 */
export function memoryTtlMsFromDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n < 0) return MEMORY_TTL_MS;
  return n === 0 ? Infinity : n * 24 * 60 * 60 * 1000;
}

/** 折叠持续失败时保留的被驱逐批次。超过此数，最旧的批次会被真正丢弃。 */
export const MEMORY_BACKLOG_MAX = 3;

/**
 * 单个会话记忆的安全文件名。
 *
 * 会话 id 是宿主形状的，不是文件形状的。文件名保留在哪儿都安全的
 * 字符，替换其余字符，限制长度，并附加原始 id 的短摘要，
 * 这样两个清洗后前缀相同的长 id 仍会得到两个文件。
 * @param {string} sessionId
 */
export function memoryFileName(sessionId) {
  const raw = String(sessionId ?? "");
  let digest = 5381;
  for (let i = 0; i < raw.length; i += 1) {
    digest = ((digest * 33) ^ raw.charCodeAt(i)) >>> 0;
  }
  const safe = raw.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 80);
  return `${safe || "session"}-${digest.toString(16).padStart(8, "0")}.json`;
}

/** 一份全新的空记忆。 */
export function emptyMemory() {
  return { v: MEMORY_VERSION, seq: 0, summary: "", rounds: [], backlog: [], updatedAt: 0 };
}

/**
 * 把加载的文件校验成当前结构。任何读不懂的东西都变成空记忆 ——
 * 损坏的记忆绝不能弄垮一轮。
 * @param {unknown} raw
 */
export function normalizeMemory(raw) {
  const base = emptyMemory();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return base;
  const out = base;
  const seq = Number(raw.seq);
  out.seq = Number.isInteger(seq) && seq >= 0 ? seq : 0;
  out.summary = typeof raw.summary === "string" ? raw.summary : "";
  if (Array.isArray(raw.rounds)) {
    for (const one of raw.rounds) {
      if (one === null || typeof one !== "object") continue;
      const n = Number(one.n);
      const text = typeof one.text === "string" ? one.text : "";
      if (text === "") continue;
      out.rounds.push({ n: Number.isInteger(n) && n >= 0 ? n : out.seq, text });
    }
  }
  if (Array.isArray(raw.backlog)) {
    for (const one of raw.backlog) {
      if (typeof one === "string" && one !== "") out.backlog.push(one);
    }
  }
  const at = Number(raw.updatedAt);
  out.updatedAt = Number.isFinite(at) && at > 0 ? at : 0;
  return out;
}

/**
 * 单轮贡献的内容，逐字保留。用户的话也要一并记下：
 * 没有它们，"好的，就这么办"就是一段关于空无的记忆。
 * @param {string} input 那一轮用户的发言
 * @param {string} output 房间里说的一切，含协议标记
 */
export function roundText(input, output) {
  const said = typeof input === "string" ? input.trim() : "";
  const spoken = typeof output === "string" ? output.trim() : "";
  return `【用户说】${said}\n${spoken}`;
}

/**
 * 追加一轮，然后通过丢弃最旧的**整轮**来裁剪窗口。
 * 会修改 `memory`（运行时把它当作缓存的事实来源），并把被驱逐的
 * 文本作为一个批次字符串返回 —— 没有驱逐时为 ""。
 * @param {object} memory 一个活跃的记忆对象
 * @param {{input: string, output: string}} round
 * @param {number} [windowChars]
 * @returns {string} 被驱逐的文本，窗口仍装得下时为 ""
 */
export function appendRound(memory, round, windowChars = MEMORY_WINDOW_CHARS) {
  memory.seq += 1;
  memory.rounds.push({ n: memory.seq, text: roundText(round?.input, round?.output) });
  const size = () => memory.rounds.reduce((sum, one) => sum + one.text.length + 8, 0);
  const evicted = [];
  while (memory.rounds.length > 0 && size() > windowChars) {
    evicted.push(memory.rounds[0].text);
    memory.rounds.shift();
  }
  if (evicted.length === 0) return "";
  return evicted.join("\n");
}

/**
 * 注入到当前轮之前的文本，没有内容时为 ""。
 *
 * 标记刻意用 【】：段落协议归 〔〕 所有，两者绝不能混淆 ——
 * 解析器只读 OUTPUT，但人工把这段文本贴回去时，
 * 也不该能伪造出一个说话者。
 * @param {object} memory
 * @returns {string}
 */
export function renderMemoryBlock(memory) {
  if (memory === null || typeof memory !== "object") return "";
  const rounds = Array.isArray(memory.rounds) ? memory.rounds : [];
  const summary = typeof memory.summary === "string" ? memory.summary.trim() : "";
  if (summary === "" && rounds.length === 0) return "";
  const parts = ["【之前发生的事】"];
  if (summary !== "") parts.push(`[梗概] ${summary}`);
  for (const one of rounds) {
    parts.push(`[第${one.n}场]\n${one.text}`);
  }
  parts.push("（以上是之前发生的事，只用来衔接剧情；下面才是这一轮。）");
  return parts.join("\n");
}

/**
 * 折叠调用所用用户侧提示词。要求纯正文：列表或标题会混进
 * `[梗概]` 里，读起来像剧本的舞台提示。
 * @param {{oldSummary: string, batch: string, cap?: number}} input
 */
export function summaryPrompt({ oldSummary, batch, cap = MEMORY_SUMMARY_CHARS }) {
  return [
    "把下面这场多人对话的旧内容并入剧情梗概。只保留：谁做了什么、关键决定、伏笔、人物关系的变化；丢掉寒暄、重复和过程性对话。",
    "直接输出梗概正文，不要任何说明、标题、序号或列表符号。",
    `最多 ${cap} 字。`,
    "",
    "【已有梗概】",
    typeof oldSummary === "string" && oldSummary.trim() !== "" ? oldSummary.trim() : "（无）",
    "",
    "【要并入的内容】",
    typeof batch === "string" ? batch : "",
  ].join("\n");
}

/** 把折叠结果收紧到上限内，并剥去某些模型加的包裹引号。 */
export function clampSummary(text, cap = MEMORY_SUMMARY_CHARS) {
  let out = typeof text === "string" ? text.trim() : "";
  if (out.length >= 2 && ((out.startsWith("「") && out.endsWith("」")) || (out.startsWith("『") && out.endsWith("』")))) {
    out = out.slice(1, -1).trim();
  }
  return out.slice(0, cap);
}

/**
 * 把一个被驱逐的批次折叠进梗概。会修改 `memory`。
 * @param {object} memory
 * @param {string} text 模型的折叠输出
 * @param {number} [cap]
 */
export function applySummary(memory, text, cap = MEMORY_SUMMARY_CHARS) {
  memory.summary = clampSummary(text, cap);
  memory.backlog = [];
}

/** 折叠失败次数过多时，丢弃最旧的 backlog 批次。 */
export function trimBacklog(memory, max = MEMORY_BACKLOG_MAX) {
  while (Array.isArray(memory.backlog) && memory.backlog.length > max) {
    memory.backlog.shift();
  }
}

/* ---------------------------------------------------------------- 读写 */

/**
 * 读取单个会话的记忆，或一份全新的。过期记忆当场删除并按全新处理：
 * 超过 TTL 的记忆不是历史，是带着旧剧情的杂物。
 * @param {string} dir
 * @param {string} sessionId
 * @param {{now?: number, ttlMs?: number}} [opts]
 */
export async function readMemory(dir, sessionId, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const forever = opts.ttlMs === Infinity;
  const ttl = Number.isFinite(opts.ttlMs) ? opts.ttlMs : MEMORY_TTL_MS;
  const file = path.join(dir, memoryFileName(sessionId));
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return emptyMemory();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyMemory();
  }
  const memory = normalizeMemory(parsed);
  if (!forever && memory.updatedAt > 0 && now - memory.updatedAt > ttl) {
    await fs.rm(file, { force: true }).catch(() => {});
    return emptyMemory();
  }
  return memory;
}

/**
 * 持久化一份记忆。先写临时文件再改名：写到一半崩溃时旧文件原封不动，
 * 绝不会留下被截断的半段对话。
 * @param {string} dir
 * @param {string} sessionId
 * @param {object} memory
 */
export async function writeMemory(dir, sessionId, memory) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, memoryFileName(sessionId));
  const tmp = path.join(dir, `.${memoryFileName(sessionId)}.${randomUUID().slice(0, 8)}.tmp`);
  const body = JSON.stringify({
    v: MEMORY_VERSION,
    seq: memory.seq,
    summary: memory.summary,
    rounds: memory.rounds,
    backlog: memory.backlog,
    updatedAt: Number.isFinite(memory.updatedAt) && memory.updatedAt > 0 ? memory.updatedAt : Date.now(),
  });
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, file);
}

/** 删除单个会话的记忆。不存在也没关系。 */
export async function removeMemory(dir, sessionId) {
  await fs.rm(path.join(dir, memoryFileName(sessionId)), { force: true }).catch(() => {});
}
