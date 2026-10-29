/**
 * dsh-waifu-agents — 团队定义、选择器流水线与存储。
 *
 * 刻意做成叶子模块：它不从 `index.js` 导入任何东西，也不依赖 `node:` 内置
 * 模块之外的任何包，因此可以离线做单元测试，`index.js` 导入它也不会形成
 * 循环。它需要的宿主能力（人设匹配器、日志器）都以参数形式传入。
 *
 * 这里有两样东西，而且它们是两种不同性质的东西：
 *
 *   1. **存储。** `teams.json`，与 `overrides.json` 并排。它保存 `selection`
 *      （用户选了什么），并且绝不把解析后的成员列表当作输入——解析出的列表
 *      在每次读取时重新推导。定义是某个分组的团队会跟随分组：在面板里改
 *      一个人设的 `group:`，下一次运行就会吸收这个改动。这正是分组无需
 *      第二份存储就能作为执行单元使用的全部原因。
 *
 *   2. **选择器流水线。** 收集 → 去重 → 过滤 → 排序 → 定容。
 *      它的输出刻意区分「哪些会运行」与「定义点了名但无法运行的人」——
 *      团队悄悄缩水是这个项目一直在拒绝的失败模式。
 *
 * v2 文本层已经移除：这里不再有成员提示词、回执协议和对话记录渲染器，
 * 因为再也不会单独启动任何一个成员。团队就是一次模拟调用，其提示词在
 * `team-simulate.js` 中；本模块只回答 *谁在房间里*。
 */

import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------- 常量 */

/** 本插件用于存放团队定义的文件，与 `overrides.json` 并排。 */
export const TEAM_FILE = "teams.json";
/**
 * 追加式运行台账，与 `teams.json` 并排。
 *
 * 每行一个 JSON 对象：每次团队运行花了多少、耗时多久、如何收场。刻意用
 * JSONL 而不是一整个 JSON 数组——被杀掉的进程最多只会在 **最后** 一行留下
 * 半截内容，之前的行仍然可读；重写数组做不到这一点。
 */
export const RUN_LOG_FILE = "runs.jsonl";
/** 只有当更旧的读取方会误读新文件时才递增。 */
export const TEAM_VERSION = 1;
/** 团队很廉价；设个上限防止损坏的文件塞满面板。 */
export const TEAM_LIMIT = 100;
/** 面板接受的最长团队名。 */
export const NAME_LIMIT = 60;
/** 显式设置的 `maxTeamSize` 被超出时的处理方式。 */
export const CAP_POLICIES = ["refuse", "truncate"];
/** @deprecated 两种展示模式已合并为一种：成员在共享总线上自由对话。仅保留用于读取旧版 teams.json。 */
/**
 * UI 对「完全没有分组」的伪分组。这不是一个人设可以拥有的名字（`group:` 是
 * 自由文本，但选择器把空值映射成这个哨兵值），所以向它派发会一次拉进所有
 * 未打标签的人设。
 */
export const UNGROUPED = "__none__";
/** 折叠空白并去除首尾——与 `index.js` 的读取方式一致。 */
export function oneLine(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

/** JSON 能承载的任何形状下的空值。 */
function blank(value) {
  return value === undefined || value === null || oneLine(value) === "";
}

/**
 * 花名册使用的排序键，让团队与选择器对顺序达成一致。
 *
 * `order` 是人设自带的 front-matter 编号；没有编号的人设排在最后而不是
 * 最前，这与选择器的做法一致（`choosableRows`）。名字是平局裁决，并且
 * `localeCompare` 显式传入 locale，这样中文名和拉丁名在两次运行之间不会
 * 互换位置。
 */
export function orderKey(row) {
  return typeof row?.order === "number" && Number.isFinite(row.order)
    ? row.order
    : Number.MAX_SAFE_INTEGER;
}

export function compareRows(a, b) {
  const byOrder = orderKey(a) - orderKey(b);
  if (byOrder !== 0) return byOrder;
  return String(a?.name ?? a?.id ?? "").localeCompare(
    String(b?.name ?? b?.id ?? ""),
    "zh-Hans-CN",
  );
}

/** 空存储，也是每个读取方都可以依赖的形状。 */
export function emptyStore() {
  return {
    version: TEAM_VERSION,
    maxTeamSize: null,
    groupCapPolicy: "refuse",
    teams: [],
  };
}

/**
 * 读取一个存储，尽最大容忍。
 *
 * 文件缺失、文件被截断、或文件被人手改过，对读取方来说都是同一件事：保留
 * 所有能解析的，丢弃其余，绝不为此让启动失败。用户是在面板里发现问题的——
 * 与隔壁目录的 `readOverrides()` 做出同样的选择。
 */
export function adoptStore(parsed) {
  const out = emptyStore();
  if (parsed === null || typeof parsed !== "object") return out;
  const cap = Number(parsed.maxTeamSize);
  if (Number.isSafeInteger(cap) && cap >= 2) out.maxTeamSize = cap;
  if (CAP_POLICIES.includes(parsed.groupCapPolicy)) {
    out.groupCapPolicy = parsed.groupCapPolicy;
  }
  const rows = Array.isArray(parsed.teams) ? parsed.teams : [];
  const seen = new Set();
  for (const raw of rows) {
    if (out.teams.length >= TEAM_LIMIT) break;
    if (raw === null || typeof raw !== "object") continue;
    const name = oneLine(raw.name).slice(0, NAME_LIMIT);
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.teams.push(adoptTeam(name, raw));
  }
  return out;
}

/** 单个团队，读取方可依赖的每个字段都在。 */

/**
 * 归一化保留期字段：非负整数天数，`0` 表示「永久保留」，其余一律取随附的
 * 默认值 7。
 * @param {unknown} value
 */
function memoryTtlDaysOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 7;
  return Math.floor(n);
}

/**
 * 归一化每队人数覆盖：当团队应跟随全库上限时为 `null`，自设上限时为
 * ≥ 2 的安全整数。
 *
 * 与全局 `maxTeamSize` 不同，这里绝不拒绝保存：该字段是覆盖项，格式错误的
 * 值（1、0、"3 people"、2.5）会被读成「本队没有自己的意见」——由全局设置
 * 代替回答。容量 1 在这里同样没有意义（`|team| < 2` 已经是单人模式），所以
 * 直接归一化掉，而不是存下来口是心非。
 * @param {unknown} value
 * @returns {number|null}
 */
function maxMembersOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 2) return null;
  return n;
}

export function adoptTeam(name, raw) {
  /*
   * `thinking` 曾经是每队的场景选项（"stage" / "ventriloquist"）。
   * 它已移除：团队说话的方式只有一种——成员在共享总线上为自己发声。旧文件
   * 仍带有该字段，因此读取时接受它但不向后传递；下一次保存会把它丢掉。
   */
  return {
    name,
    selection: adoptSelection(raw?.selection),
    // personaId -> 角色描述句。缺失角色不是错误：成员仍然会拿到任务，
    // 只是提示词里没有特长那一行。
    roles: adoptMap(raw?.roles),
    // personaId -> glob。该成员写入时声明的通道。
    writeScope: adoptMap(raw?.writeScope),
    // `cards` 是唯一存活的场景选项：每次运行一张卡。
    scenes: { cards: "perRun" },
    // 团队级常驻背景（创建团队时设置一次）。它会在每次运行时注入每个成员
    // 的提示词，所以像「托尔和康娜彼此不知道是什么关系」这样的事实只需
    // 陈述一次，不必在每个任务里重复。
    background: oneLine(raw?.background) || "",
    // 该团队是否跨回合携带记忆（见 `team-memory.js`）。
    // 缺省即开启——记忆是默认体验；`false` 让团队退回旧的每回合无状态
    // 形态及其固定开销。
    memory: raw?.memory !== false,
    // 一次会话的记忆能存活多少个闲置日（0 = 永久保留）。
    // 面板像编辑分页数字一样编辑它：任意非负整数。
    // 缺失或格式错误回退到随附默认值 7——字段缺失时 `memoryTtlMsFromDays`
    // 采用同样的默认值。
    memoryTtlDays: memoryTtlDaysOf(raw?.memoryTtlDays),
    // 每队人数上限，覆盖全库的 `maxTeamSize`（null = 跟随全局设置）。
    // 聊天二人组保持 2 人，而剧情团队可以跑 5 人。
    maxMembers: maxMembersOf(raw?.maxMembers),
    // 仅用于审计。执行流程从不读取它——见模块文档。
    lastResolved: Array.isArray(raw?.lastResolved)
      ? raw.lastResolved.map(oneLine).filter((id) => id !== "")
      : [],
    lastResolvedAt: oneLine(raw?.lastResolvedAt) || null,
  };
}

export function adoptSelection(input) {
  const out = [];
  if (!Array.isArray(input)) return out;
  for (const raw of input) {
    const kind = raw?.kind === "group" ? "group" : raw?.kind === "persona" ? "persona" : null;
    if (kind === null) continue;
    const ref = oneLine(raw?.ref);
    if (ref === "" || blank(ref)) continue;
    out.push({ kind, ref });
  }
  return out;
}

/** 剔除空白条目后的 `{ key: text }` 映射。 */
function adoptMap(input) {
  const out = {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    const id = oneLine(key);
    const text = oneLine(value);
    if (id === "" || text === "") continue;
    out[id] = text;
  }
  return out;
}

export function readStore(file) {
  try {
    return adoptStore(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return emptyStore();
  }
}

/**
 * 写入存储，确保磁盘上的文件永远不会是两个版本各一半。
 *
 * 与 `index.js` 中的 `writeAtomic` 相同的先暂存再改名，理由也相同：一个
 * 捕获到写了一半的 `teams.json` 的读取方将不得不去猜用户是有一个团队
 * 还是没有。
 */
export function writeStore(file, store) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stage = `${file}.stage-${process.pid}`;
    const payload = {
      version: TEAM_VERSION,
      maxTeamSize: store.maxTeamSize ?? null,
      groupCapPolicy: store.groupCapPolicy,
      teams: store.teams,
    };
    fs.writeFileSync(stage, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(stage, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 这个存储不能使用的原因，可用时返回 `null`。
 *
 * P1 里唯一的拒绝条件是 `maxTeamSize < 2`，而且它是刻意拒绝而不是钳制。
 * 容量 1 不意味着「委派一名成员」——`|team| < 2` 已经是单人模式——所以
 * 这个数字表达的是「永远别以团队方式运行」，而那件事有直接的表达方式
 * （不开团队模式）。钳制成 2 会让文件说的和插件做的不一致，这正是整个
 * 功能要规避的 bug 类型。
 */
export function storeProblem(store) {
  const cap = store?.maxTeamSize;
  if (cap === null || cap === undefined) return null;
  if (!Number.isSafeInteger(cap) || cap < 2) {
    return `maxTeamSize 只能是 ≥ 2 的整数（现在是 ${JSON.stringify(cap)}）。写成 1 表达的是「永远别开团队模式」，那件事请直接不开团队模式，别用容量配置兼职。`;
  }
  return null;
}

export function findTeam(store, name) {
  const wanted = oneLine(name);
  if (wanted === "") return null;
  return store.teams.find((team) => team.name === wanted) ?? null;
}

/**
 * 一次 `save` 写入哪个已存的团队，以及这次保存是否为改名。
 *
 * 团队没有 id——它的名字就是它在文件中的身份——所以「保存这个编辑器」
 * 本身有歧义：新名字可能匹配不到任何条目（改名），也可能什么都不是
 * （创建）。只按名字做键会让每次改名看起来都像创建，结果旧条目留在原处，
 * 又多出一个以新名字重复它的团队。
 *
 * `original` 是编辑器打开时的名字，用它弥补这个缺口：
 *
 * - `original` 为空，或等于 `name` → 按名字普通的创建或替换；
 * - `original` 不同 → 原地改名；若旧条目已消失（在别处被删）或新名字已被
 *   占用（那会悄悄覆盖一个不同的团队），则为错误。
 *
 * @param {Array} teams - 存储中的团队，按文件顺序。
 * @param {string} name - 要写入的名字。
 * @param {string} original - 编辑器打开时的名字。
 * @returns {{at: number, renamed: boolean, error: string|null}} `at` 是要
 *   写入的下标（-1 = 追加），绝不是冲突团队所在的位置。
 */
export function saveTarget(teams, name, original) {
  const list = Array.isArray(teams) ? teams : [];
  const wanted = oneLine(name);
  const was = oneLine(original);
  if (was !== "" && was !== wanted) {
    const src = list.findIndex((team) => team.name === was);
    if (src < 0) {
      return { at: -1, renamed: false, error: `没有叫「${was}」的团队了，可能刚在别处被删掉。` };
    }
    if (list.some((team) => team.name === wanted)) {
      return { at: -1, renamed: false, error: `已经有一个叫「${wanted}」的团队了，换个名字。` };
    }
    return { at: src, renamed: true, error: null };
  }
  return { at: list.findIndex((team) => team.name === wanted), renamed: false, error: null };
}

/**
 * 团队改名时全局默认值必须跟着移动的情形。
 *
 * 团队的预设 id 是从名字 **派生** 的（`团队-<name>`），因此改名会注销旧
 * 预设、以不同 id 注册新预设。默认值以 id 形式保存，于是指向旧者的默认值
 * 就悬空了——悬空的默认值不是小事：注册表会以 `agent-preset/not-found`
 * 拒绝每一个新会话，而不是回退到第一行。
 *
 * 无需移动时返回 `null`，这是常见情形（默认值指向某个人设或另一个团队），
 * 也让调用方可以无条件安全运行。
 *
 * @param {{defaultId?: string|null, from?: string, to?: string}} input
 * @returns {{from: string, to: string} | null}
 */
export function defaultRenameFollow({ defaultId, from, to }) {
  const held = oneLine(defaultId);
  const before = oneLine(from);
  const after = oneLine(to);
  if (held === "" || before === "" || after === "") return null;
  if (before === after) return null;
  if (held !== before) return null;
  return { from: before, to: after };
}

/**
 * 默认值是否指向这个团队——同一问题的删除侧。
 *
 * 理由同 {@link defaultRenameFollow}：删除一个其预设正是默认值的团队，会让
 * 该字段指向一个无人注册的 id，新会话将失败且屏幕上没有任何可点的东西。
 * 两侧都按 id 比较，因为字段里存的就是 id；只比名字不够，因为人设文件
 * 完全可能合法地携带同一个字符串。
 *
 * @param {{defaultId?: string|null, presetId?: string}} input
 */
export function defaultNamesTeam({ defaultId, presetId }) {
  const held = oneLine(defaultId);
  const preset = oneLine(presetId);
  return held !== "" && preset !== "" && held === preset;
}

/** 当前目录可以据以派发的每个分组名。 */
export function availableGroups(roster) {
  const names = new Set();
  for (const row of roster ?? []) {
    const group = oneLine(row?.group);
    if (group !== "" && group !== UNGROUPED) names.add(group);
  }
  return [...names].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

/* ----------------------------------------------------- 选择器流水线 */

/**
 * 把一个选择器展开成成员行。
 *
 * 流水线即规格，顺序如下：收集（成员 ∪ 分组）→ 按人设 id 去重 → 过滤掉
 * 无法挂载的 → 排序 → 定容。先去重后过滤，这样经两条路径可达的同一人设
 * 只报告一次。
 *
 * `strict` 区分两类调用方，而且不是装饰性的差异：
 *   - `strict: true` ——这是用户或模型刚输入的。解析不了的名字就是笔误，
 *     所以让整次调用带着候选列表失败。这是设计文档 §7.4 的「分组未找到 →
 *     报错」扩展到具名人设。
 *   - `strict: false` ——这来自一个可能已漂移的存储定义（人设被归档、改名，
 *     或其 `group:` 被编辑）。该成员被剔除并在 `removed` 里 *点名*，绝不静默。
 *
 * @param {object} input
 * @param {{kind: string, ref: string}[]} input.selection
 * @param {object[]} input.roster `listFiles()` 形状的行
 * @param {boolean} [input.strict]
 * @returns {{ok: boolean, error?: string, hint?: string, members: object[],
 *   removed: object[], unknownGroups: string[], unknownRefs: string[]}}
 */
export function expandSelection({ selection, roster, strict = false }) {
  const rows = Array.isArray(roster) ? roster : [];
  const byId = new Map();
  const byName = new Map();
  for (const row of rows) {
    const id = oneLine(row?.id);
    if (id === "") continue;
    byId.set(id, row);
    const name = oneLine(row?.name);
    if (name !== "" && !byName.has(name)) byName.set(name, row);
  }

  const picked = [];
  const source = new Map();
  const unknownGroups = [];
  const unknownRefs = [];

  for (const entry of adoptSelection(selection)) {
    if (entry.kind === "group") {
      if (entry.ref === UNGROUPED) {
        unknownGroups.push(entry.ref);
        continue;
      }
      const hit = rows.filter((row) => oneLine(row?.group) === entry.ref);
      if (hit.length === 0) {
        unknownGroups.push(entry.ref);
        continue;
      }
      for (const row of hit) {
        const id = oneLine(row.id);
        if (!source.has(id)) source.set(id, `group:${entry.ref}`);
        picked.push(row);
      }
      continue;
    }
    const row = byId.get(entry.ref) ?? byName.get(entry.ref);
    if (row === undefined) {
      unknownRefs.push(entry.ref);
      continue;
    }
    const id = oneLine(row.id);
    if (!source.has(id)) source.set(id, `persona:${entry.ref}`);
    picked.push(row);
  }

  if (strict && (unknownGroups.length > 0 || unknownRefs.length > 0)) {
    const parts = [];
    if (unknownGroups.length > 0) parts.push(`组「${unknownGroups.join("、")}」找不到任何成员`);
    if (unknownRefs.length > 0) parts.push(`人设「${unknownRefs.join("、")}」不在目录里`);
    return {
      ok: false,
      error: `${parts.join("；")}。`,
      hint: unknownGroups.length > 0 ? availableGroups(rows) : [],
      members: [],
      removed: [],
      unknownGroups,
      unknownRefs,
    };
  }

  const seen = new Set();
  const members = [];
  const removed = [];
  for (const row of picked) {
    const id = oneLine(row.id);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    const name = oneLine(row.name) || id;
    if (row.idOk !== true) {
      removed.push({ id, name, reason: "名字里带了文件名放不下的字符", from: source.get(id) });
      continue;
    }
    const problems = Array.isArray(row.problems) ? row.problems : [];
    if (problems.length > 0) {
      removed.push({
        id,
        name,
        reason: `现在组装不出来（${problems.join("；")}）`,
        from: source.get(id),
      });
      continue;
    }
    members.push({
      id,
      name,
      group: oneLine(row.group) || null,
      order: typeof row.order === "number" ? row.order : null,
      description: oneLine(row.description) || null,
      from: source.get(id) ?? null,
    });
  }
  members.sort(compareRows);
  return {
    ok: true,
    members,
    removed,
    unknownGroups,
    unknownRefs,
  };
}

/**
 * 为一次会话解析一个已存的团队。
 *
 * 返回调用方需要的切分：`members` 是将要运行的行，`removed` 是定义点了名
 * 但目录无法提供的，`drift` 是自上次派发以来的变化，`notices` 是欠用户的
 * 说明句。`single` 是兜底判定——`|team| < 2`——它在这里只计算一次，这样
 * 工具注册、提示词段落和报告就不可能对它各执一词（gate S3 ≡ H4）。
 */
export function resolveTeam({ team, roster, coordinator, store }) {
  const selection = Array.isArray(team?.selection) ? team.selection : [];
  const expanded = expandSelection({ selection, roster, strict: false });
  const notices = [];

  /*
   * 目录从未听说过的分组是笔误，而笔误绝不能被吸收（gate S4）：回退到单人
   * 模式会让用户误以为团队运行过了。此后被删除的人设是普通的漂移，只做
   * 公告（设计文档 §7.8）——两者刻意不对称，因为分组名是 *命名空间* 引用，
   * 根本无从解释，而人设引用指向的是确实存在过的东西。
   */
  if (expanded.unknownGroups.length > 0) {
    return {
      ok: false,
      error: `团队「${team?.name ?? "临时小队"}」里的组「${expanded.unknownGroups.join("、")}」找不到任何成员。检查一下名字，或者先在设置里给成员打上这个组标签。`,
      hint: availableGroups(Array.isArray(roster) ? roster : []),
      notices,
      members: [],
      removed: [],
      drift: { added: [], removed: [], comparable: false },
    };
  }

  for (const ref of expanded.unknownRefs) {
    notices.push(`人设「${ref}」不在目录里了，这次没算上她。`);
  }
  for (const gone of expanded.removed) {
    notices.push(`${gone.name} 被剔除了：${gone.reason}。`);
  }

  const before = Array.isArray(team?.lastResolved) ? team.lastResolved : [];
  const now = expanded.members.map((row) => row.id);
  const drift = before.length === 0
    ? { added: [], removed: [], comparable: false }
    : {
        added: now.filter((id) => !before.includes(id)),
        removed: before.filter((id) => !now.includes(id)),
        comparable: true,
      };
  if (drift.added.length > 0 || drift.removed.length > 0) {
    /*
     * id 是审计快照保存的东西（改名不能破坏记录），但通知是给人读的，所以
     * 写名字。花名册不再持有的 id 就回退为它自身——那正是「被移除」的情形，
     * 原始 id 是剩下最能诚实展示的东西。
     */
    const nameOf = new Map((Array.isArray(roster) ? roster : []).map((row) => [oneLine(row?.id), oneLine(row?.name)]));
    const label = (id) => nameOf.get(id) || id;
    const parts = [];
    if (drift.added.length > 0) parts.push(`新增 ${drift.added.map(label).join("、")}`);
    if (drift.removed.length > 0) parts.push(`少了 ${drift.removed.map(label).join("、")}`);
    notices.push(`团队「${team.name}」的成员自上次运行后变了（${parts.join("，")}）。`);
  }

  /*
   * 上限先看每队，再看全局：自述 `maxMembers` 的团队覆盖 `store.maxTeamSize`，
   * 没有自述的（归一化后的 `null`）跟随全库。`adoptTeam` 保证形状，但
   * resolveTeam 也会在从更旧文件重建的定义上运行，所以这里的守卫重复一遍
   * 不变式而不是盲目信任。
   */
  const cap =
    Number.isSafeInteger(team?.maxMembers) && team.maxMembers >= 2
      ? team.maxMembers
      : store?.maxTeamSize ?? null;
  const policy = CAP_POLICIES.includes(store?.groupCapPolicy) ? store.groupCapPolicy : "refuse";
  let members = expanded.members;
  let truncated = [];
  if (cap !== null && members.length > cap) {
    if (policy === "refuse") {
      return {
        ok: false,
        error: `这次解析出 ${members.length} 名成员，超过了上限 ${cap}${Number.isSafeInteger(team?.maxMembers) && team.maxMembers >= 2 ? "（这一队自己设的）" : ""}。收窄一下选择，或者把上限调掉（这一队编辑器里的「本队人数上限」留空就是跟随全局；teams.json 里的 maxTeamSize 设成 null 就是全局不设限）。完整名单：${members
          .map((row) => row.name)
          .join("、")}。`,
        notices,
        members,
        removed: expanded.removed,
        drift,
      };
    }
    // `truncate` 按顺序保留前 `cap` 名并说明谁被跳过了：一份省略她们的报告
    // 与一个真的只有这么小的团队无法区分。
    const skipped = members.slice(cap);
    members = members.slice(0, cap);
    truncated = skipped;
    notices.push(
      `按 order 只取了前 ${cap} 名，这几位这次没上：${skipped.map((row) => row.name).join("、")}。`,
    );
  }

  const coordinatorId = oneLine(coordinator?.id);
  const inTeam = coordinatorId !== "" && members.some((row) => row.id === coordinatorId);
  // 人数就是 |team|，仅此而已。v3 曾经还会报告谁会得到子运行（除协调者外的
  // 所有人）；现在已经不会单独启动任何人了，所以剩下唯一的问题是房间里
  // 有几个声音。
  const single = members.length < 2;

  return {
    ok: true,
    single,
    members,
    removed: expanded.removed,
    truncated,
    notices,
    drift,
    // 会话自身的人设是否是发言者之一。仅用于展示：
    // 在 v3 中她和其他人一样发言，并不领导房间。
    coordinator: {
      id: coordinatorId || null,
      name: oneLine(coordinator?.name) || null,
      inTeam,
    },
    capacity: { max: cap, policy },
    team: { name: team?.name ?? null, selection },
  };
}

/* --------------------------------------------------------------- 路由 */
