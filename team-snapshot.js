/**
 * 一次运行的冻结半边：团队*当时是什么*，以哈希的形式记录下来。
 *
 * ## 它解决的问题
 *
 * 账本已经记录了"运行发生过、花了多少"，却回答不了
 * "究竟运行了什么"，因为决定答案的一切都在账本之外且不断变动：
 * 人设 `.md` 被编辑、团队的名单被重新排序、共享规则被改写、
 * 任务是一条很快滚出视线的消息。一行写着 `team: "monster"`、
 * `size: 3` 的记录描述的只是一个形状，而两次不同的讨论可以共享同一个形状。
 *
 * ## 为什么用哈希而不是文本
 *
 * 把提示词（或三个人设正文）复制进 `runs.jsonl` 会让账本变成
 * 角色台词的第二份副本 —— 这正是 §5.5 禁止的事，而且它会无限制地
 * 增长。一段短哈希加上一个长度，足以回答事后唯一重要的问题：
 * **磁盘上的文本仍然是产生这次运行的那份文本吗？** 如果是，
 * 这次运行就能按目录现状复现；如果不是，这一行就诚实地写
 * "不可复现"，而不是暗示它可以。
 *
 * 所以方向保持单向。账本永远不携带正文；想要正文的人得主动来要，
 * 导出功能（见下）在那一刻从目录读取它们，并给每一个之后变过的
 * 正文打上标记。
 *
 * ## 为什么要记录人设模式
 *
 * `personaOf` 在宿主支持时只取正文，否则取拼装后的文本
 * （见 `team-runtime.js`）。两者是不同的字符串，一种模式下取的
 * 哈希在另一种模式下毫无意义。`personaSource` 说明被哈希的是
 * 哪种字符串 —— 当宿主对某个成员返回纯正文、对另一个却回退到
 * 拼装文本时则是 `"mixed"`，这是一种真实存在的形状
 * （宿主无法隔离某人设的正文），否则它就会被描述成它不是的东西。
 *
 * @module
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 只在快照自身结构变化时递增，内容变化从不递增。 */
export const CONFIG_VERSION = 1;

/**
 * 摘要保留多少位。
 *
 * 12 个十六进制字符是 48 位：足以让同一人设文件的两次修订不碰撞，
 * 又短到一行记录仍然可读。这是变更探测器，不是签名 ——
 * 这里没有任何东西能抵御蓄意伪造。
 */
export const HASH_CHARS = 12;

/**
 * 单个字符串的稳定短摘要。
 *
 * 尾部空白刻意原样保留：提示词是由磁盘上的字节构建的，
 * 在这里做规范化会让两个不同的提示词哈希出相同的结果。
 *
 * @param {unknown} text
 * @returns {string} 12 个小写十六进制字符
 */
export function shortHash(text) {
  const body = typeof text === "string" ? text : String(text ?? "");
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, HASH_CHARS);
}

/** 值按字符串计的长度，"什么都没有"时为 0。 */
function charsOf(value) {
  if (typeof value !== "string") return 0;
  return value.length;
}

/**
 * 冻结一次讨论的配置。
 *
 * 这里的全部内容都派生自调用方在构建请求那一刻就已经拿到的输入，
 * 因此代价是每个人设一次哈希，再加上规则和提示词的几次 ——
 * 相对一次模型调用只是微秒级。
 *
 * @param {object} input
 * @param {{name?: string, background?: string, roles?: Record<string, string>}} input.team
 * @param {ReadonlyArray<{id: string, name?: string}>} input.members 按发言顺序
 * @param {(id: string) => string} input.personaOf 注入提示词的原文
 * @param {"body" | "assembled"} [input.personaSource] 用的是哪种变体，
 *   当调用方能全局知晓时
 * @param {(id: string) => ("body" | "assembled")} [input.sourceOf] 逐成员的
 *   变体，用于只能隔离部分正文的宿主
 * @param {ReadonlyArray<string>} [input.rules] 共享规则块，按行给出
 * @param {string} [input.task]
 * @param {{provider?: string, model?: string, maxTokens?: number, maxRounds?: number, scale?: string}} [input.model]
 *   `maxRounds` 只在读取"轮次数被移除之前"写入的行时使用；
 *   新行不传它、得到 `null`，这才是真正的"没有这个参数"，
 *   而不是一个没人理会的数字。
 * @param {{text?: string, shape?: string}} [input.prompt]
 * @returns {object} 一个 JSON 安全的对象：标量、哈希，没有正文
 */
export function snapshotOf({
  team,
  members,
  personaOf,
  personaSource = "body",
  sourceOf,
  rules = [],
  task = "",
  model = {},
  prompt = {},
} = {}) {
  const rows = Array.isArray(members) ? members : [];
  const persona = typeof personaOf === "function" ? personaOf : () => "";
  const text = (value) => (typeof value === "string" ? value : "");
  const roles = team !== null && typeof team === "object" && team.roles !== null && typeof team.roles === "object" ? team.roles : {};
  const background = text(team?.background);
  const sourceFor = (id) => {
    if (typeof sourceOf !== "function") return personaSource === "assembled" ? "assembled" : "body";
    try {
      return sourceOf(id) === "assembled" ? "assembled" : "body";
    } catch {
      return "body";
    }
  };
  const rowsWithBody = rows.map((row) => ({ row, body: text(persona(row?.id)) }));
  const sources = new Set(rowsWithBody.map((item) => sourceFor(item.row?.id)));
  /*
   * `mixed` 很重要：它说明下面的成员哈希并非都在描述同一种字符串，
   * 读取方不能指望它们与任何一种纯模式对得上。
   */
  const oneSource = sources.size === 1 ? [...sources][0] : "mixed";

  return {
    version: CONFIG_VERSION,
    /*
     * 成员哈希描述的是哪种字符串。把"宿主带 `personaBodyOf` 的运行"
     * 与"不带"的运行放在一起比较的读取方，不能指望哈希对得上，
     * 这个字段就是说明这件事的。
     */
    personaSource: oneSource,
    team: {
      name: text(team?.name),
      backgroundChars: background.length,
      backgroundHash: shortHash(background),
      /** 该团队是否跨轮保留记忆（一个标量，不是正文）。 */
      memory: team?.memory !== false,
      /** 空闲保留天数（0 = 永久保留）；adoptTeam 已经做过规范化。 */
      memoryTtlDays:
        Number.isFinite(Number(team?.memoryTtlDays)) && Number(team?.memoryTtlDays) >= 0
          ? Math.floor(Number(team?.memoryTtlDays))
          : 7,
      /** 单团队人数上限（null = 遵循全局的 maxTeamSize）。 */
      maxMembers:
        Number.isSafeInteger(team?.maxMembers) && team.maxMembers >= 2 ? team.maxMembers : null,
      /*
       * 角色标签写在团队上、按成员区分，而不是写在人设上，因此
       * 它们可以变动而任何一个人设文件都不必移动。用有序数组而非
       * 对象，能让 JSON 键序保持有意义，并与 `members` 一一对应。
       */
      roles: rows.map((row) => ({ id: text(row?.id), role: text(roles[row?.id]) })),
    },
    /*
     * 发言顺序很重要，因此被显式记录而不是隐含：`members` 就是
     * 提示词列出它们的顺序，也就是引导模型让它们发言的顺序。
     */
    members: rowsWithBody.map(({ row, body }, index) => ({
      order: index,
      id: text(row?.id),
      name: text(row?.name) || text(row?.id),
      role: text(roles[row?.id]),
      bodyChars: body.length,
      bodyHash: shortHash(body),
    })),
    rules: {
      count: Array.isArray(rules) ? rules.length : 0,
      chars: Array.isArray(rules) ? rules.reduce((total, line) => total + charsOf(line), 0) : 0,
      hash: shortHash(Array.isArray(rules) ? rules.join("\n") : ""),
    },
    task: { chars: charsOf(task), hash: shortHash(text(task)) },
    model: {
      provider: text(model?.provider),
      model: text(model?.model),
      maxTokens: Number.isFinite(model?.maxTokens) ? model.maxTokens : null,
      maxRounds: Number.isFinite(model?.maxRounds) ? model.maxRounds : null,
      scale: text(model?.scale) || null,
    },
    prompt: {
      chars: charsOf(prompt?.text),
      hash: shortHash(text(prompt?.text)),
      shape: text(prompt?.shape),
    },
  };
}

/**
 * 把冻结的配置与目录当前的样子做比较。
 *
 * 纯函数：它只向 `personaOf` 索要当前文本，调用方无需动用
 * 自己的磁盘即可运行。这是"快照"诚实的那一半 ——
 * 从不复查的哈希只是装饰。
 *
 * @param {object} input
 * @param {object} input.config 来自 {@link snapshotOf} 的快照
 * @param {(id: string) => string} input.personaOf 某 id 的*当前*文本
 * @returns {{matched: object[], drifted: object[], missing: object[]}}
 */
export function verifySnapshot({ config, personaOf } = {}) {
  const rows = Array.isArray(config?.members) ? config.members : [];
  const persona = typeof personaOf === "function" ? personaOf : () => "";
  const matched = [];
  const drifted = [];
  const missing = [];

  for (const row of rows) {
    const found = typeof persona === "function" ? persona(row?.id) : null;
    const now = typeof found === "string" ? found : null;
    /*
     * `null` 不是 `""`。被删除的人设文件从宿主返回 `null`；
     * 空文件返回 `""`，并像其他文本一样参与哈希。把两者都折进
     * "已变更"会让删除藏身于内容编辑之后，而两者的修复方式不同。
     */
    if (now === null) {
      missing.push({ order: row?.order, id: row?.id, name: row?.name });
      continue;
    }
    const hash = shortHash(now);
    if (hash === row?.bodyHash) {
      matched.push({ order: row?.order, id: row?.id, name: row?.name, chars: now.length });
    } else {
      drifted.push({
        order: row?.order,
        id: row?.id,
        name: row?.name,
        wasChars: row?.bodyChars ?? null,
        nowChars: now.length,
        wasHash: row?.bodyHash ?? "",
        nowHash: hash,
      });
    }
  }

  return { matched, drifted, missing };
}

/** 把 id 变成可安全用作文件名的形式，同时不丢失它是哪个 id。 */
function fileNameFor(row) {
  const id = typeof row?.id === "string" && row.id !== "" ? row.id : "member";
  const safe = id.replace(/[^\p{L}\p{N}._-]/gu, "_");
  const order = Number.isInteger(row?.order) ? String(row.order).padStart(2, "0") : "??";
  return `${order}-${safe}`;
}

/**
 * 把一份冻结的配置连同它所描述的正文写入一个目录。
 *
 * ## 为什么要显式导出，而不是把正文写进账本
 *
 * 两个不同的问题，两种不同的生命周期。账本永远回答"发生过什么"，
 * 必须保持为摘要；导出只回答一次"给我看确切的文本"，服务于
 * 单次运行，且允许很大。把两者分开，账本才能既守住"无正文"的
 * 规矩，又不放弃可复现性。
 *
 * ## 漂移只做标记，绝不覆盖
 *
 * 如果某个成员的文本自运行以来已经变化，它的当前文本会写成
 * `<order>-<id>.drifted.md`，并列入 `verify.json`。若用普通文件名
 * 写入，得到的目录会*看起来*像一次它已不再对应的运行的忠实副本 ——
 * 这正是快照要防止的失败模式。
 *
 * @param {object} input
 * @param {object} input.config 来自 {@link snapshotOf} 的快照
 * @param {(id: string) => string} input.personaOf 每个 id 的当前文本
 * @param {string} input.outDir 写入的目录（必要时创建）
 * @returns {{dir: string, written: string[], matched: object[], drifted: object[], missing: object[]}}
 */
export function exportSnapshot({ config, personaOf, outDir } = {}) {
  const dir = typeof outDir === "string" && outDir !== "" ? outDir : "";
  if (dir === "") throw new Error("exportSnapshot 需要一个输出目录。");
  const verdict = verifySnapshot({ config, personaOf });
  const persona = typeof personaOf === "function" ? personaOf : () => "";
  const written = [];

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify(config ?? {}, null, 2)}\n`, "utf8");
  written.push("config.json");
  fs.writeFileSync(
    path.join(dir, "verify.json"),
    `${JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        matched: verdict.matched,
        drifted: verdict.drifted,
        missing: verdict.missing,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  written.push("verify.json");

  const rows = Array.isArray(config?.members) ? config.members : [];
  for (const row of rows) {
    if (verdict.missing.some((item) => item.id === row?.id)) continue;
    const text = persona(row?.id);
    if (typeof text !== "string") continue;
    const changed = verdict.drifted.some((item) => item.id === row?.id);
    const name = `${fileNameFor(row)}${changed ? ".drifted" : ""}.md`;
    fs.writeFileSync(path.join(dir, name), text, "utf8");
    written.push(name);
  }

  return { dir, written, ...verdict };
}
