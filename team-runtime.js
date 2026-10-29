/**
 * 团队模式的运行时：会话绑定、团队解析，以及接管。
 *
 * 旁边的 `team.js` 是整个决策层，并且保持为叶子模块——不依赖 cordis、不依赖
 * 服务，除了读写一个 JSON 文件外没有任何 I/O。本模块是必须接触宿主的那一部分：
 * 它回答「这个会话当前在哪个团队上」，然后在属于团队的回合上，**就是**模型本身。
 *
 * ## 一次调用，而不是每个成员一次调用
 *
 * v2 给每个成员分配各自的子会话，并在它们之间跑一条共享消息总线。它能工作，
 * 但慢得从内部无法修复：N 名成员跑 R 个回合需要 N×R 次子会话模型调用，每次
 * 都带完整的激活生命周期，另外还要二次重放总线来生成回复。
 *
 * v3 彻底移除了那个模式。没有成员会话、没有总线、没有协调者回合、也没有委派
 * 工具——一个团队就是**一次**写完整段对话的模型调用。`team-simulate.js` 负责
 * 提示词与分段协议；本文件负责触发、幂等，以及让结果成为一条合法回复。
 *
 * ## 为什么回复在 `llm/stream` 内部产生
 *
 * `agent/pre-step` 是 `step/start` 之前唯一的钩子，而被拒绝的 step 永远不会
 * 打开——所以从那里写入的任何东西都不可能变成可见回复。模型调用是插件第一次
 * 能「成为」答案的位置，而且 `dsh-llm` 把 `llm/stream` 定义为 cordis 瀑布：
 * 一个不调用 `next()` 而直接返回 chunk 流的监听器**就是**响应。之后 agent 循环
 * 自己写入 `assistant/message` 并关闭回合，于是日志的形状与其他任何回复一致，
 * 冷读也看不出异常。
 *
 * 两次更早的尝试值得记住，因为它们当时看起来都是对的：从 `pre-step` 把回复写成
 * `assistant/message` 产生了再也无法读取的会话（`Relationships.tool`：assistant
 * 消息必须落在**打开着的** step 里，而被拒绝的 step 永远不会打开）；把它写成
 * `user/message`——当时的修复——则让回复不可见，因为那一行是客户端的*输入*侧，
 * 会渲染成一条通知。两者都已废弃；现在的路径两边都不写。
 *
 * ## 为什么重建请求而不是改写请求
 *
 * `next()` 无法携带修改过的请求：cordis 的 `waterfall` 闭包捕获了
 * `args`（`next = () => (cbs.shift() ?? inner)(...args)`）。所以监听器自己调用
 * `llm.stream(request)`，传入为模拟构建的请求，并在一个 `WeakSet` 里标记该对象，
 * 让重入的瀑布轮次认出它并原样放行。`prepared` 可能是 undefined；`adapterStream`
 * 正好有为这种情况准备的分支。
 *
 * ## 为什么不再往人设文本里塞任何东西
 *
 * v2 不得不把舞台规则附加到服务出的人设后面，因为本插件的 `template.json` 给
 * 人设行标了 `complete: true`，`SystemPrompt.assemble` 随后会丢掉其他所有小节。
 * v3 完全不服务任何舞台文本——模拟提示词在模型调用时从头组装——所以单人模式和
 * 团队模式服务出逐字节相同的人设。
 *
 * @module
 */
import {
  TEAM_FILE,
  adoptTeam,
  emptyStore,
  readStore,
  writeStore,
  storeProblem,
  findTeam,
  availableGroups,
  resolveTeam,
  oneLine,
} from "./team.js";
import {
  SIM_MAX_CONTINUATIONS,
  SIM_SILENCE,
  TAIL_RESUME_MIN_CHARS,
  TEAM_COMMON_RULES,
  classifyTurn,
  createSegmentParser,
  internalLeaks,
  isTailIncomplete,
  renderSegment,
  silentMembers,
  simulationMessages,
  simulationStatus,
  simulationSystemPrompt,
  textOf,
  turnBudget,
} from "./team-simulate.js";
import { exportSnapshot, snapshotOf } from "./team-snapshot.js";
import {
  MEMORY_SUMMARY_CHARS,
  MEMORY_WINDOW_CHARS,
  appendRound,
  applySummary,
  emptyMemory,
  memoryTtlMsFromDays,
  readMemory,
  renderMemoryBlock,
  summaryPrompt,
  trimBacklog,
  writeMemory,
} from "./team-memory.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * 值得再请求一次的失败类别，以及各自要花掉多少次尝试。
 *
 * 这份清单与 `llm-retry` 视为瞬态的类别一致（它的常规模式覆盖 `EMPTY_RESPONSE`、
 * `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`），但去掉了 `RATE_LIMIT`：
 * 尊重限流意味着等待服务方自己的 `Retry-After`，而固定的本地退避做不到这一点，
 * 往限流上撞正是把一个慢回合变成被封 key 的方式。`AUTH`/`INVALID`/上下文类
 * 失败第二次必然同样失败，所以那些类别立即给出答复。
 */
export const RETRYABLE_FAILURES = Object.freeze([
  "TIMEOUT",
  "TRANSPORT",
  "SERVER",
  "EMPTY_RESPONSE",
]);

/**
 * 各次尝试之间的退避，单位毫秒：每次重试一项。
 *
 * 刻意偏短。这份清单是为十秒连接超时写的——套接字从未打开，所以没有什么需要
 * 等过去，第一次重试通常就落到可用的路径上。整个过程中用户都盯着一条空回复，
 * 所以预算是两次重试，而不是平台的五次。
 */
export const RETRY_DELAYS_MS = Object.freeze([600, 1500]);

/**
 * **单次**模型尝试的挂钟时间上限，单位毫秒。
 *
 * 上面的重试预算是为十秒的*连接*超时写的——套接字从未打开，失败立即发生，
 * 第一次重试就会落到可用的路径上。线上日志显示的是另一种失败形态：一个**打开了**
 * 然后停滞的流。`deepseek-v4.1-flash` 在某次 16:50 的运行中，第 2 次尝试闲置了
 * 430 933 毫秒才被上游切断——七分钟的黑屏回复。本地退避帮不了服务方尚未判定的
 * 停滞，因为本应携带失败信息的终结 chunk 根本不会到来；唯一的约束办法是我们
 * 自己停止等待。
 *
 * 因此这是一个*本地*中止，与用户的取消不同：它触发时，该次尝试被放弃并按
 * `TIMEOUT` 处理，让下面的重试闸门看到一个它已经知道怎么修复的类别。这个数字
 * 是一笔权衡——长得足以熬过一次慢但仍存活的预填充，又短得让用户面前的最坏情况
 * 是「大约两分钟后重试」，而不是「七分钟后什么都没有」。
 */
export const ATTEMPT_TIMEOUT_MS = 120000;

/**
 * 讨论无法产出时告诉用户的话。
 *
 * 三件事，按此顺序：用插件其余部分所说的语言表达；保留服务方的原话（一句未翻译
 * 的 `Request timed out.` 是事后诊断仅有的证据）；说明下一步怎么办。把裸异常
 * 字符串当作整条消息是旧行为，读起来像崩溃，而不像一条再发一次就能好的回合。
 *
 * @param {string} code 终结 chunk 里的 `failure.code`
 * @param {string} message 终结 chunk 里的 `failure.message`
 * @param {number} attempts 实际发出的请求数
 * @returns {string}
 */
export function explainFailure(code, message, attempts = 1) {
  const kind = oneLine(code);
  const raw = oneLine(message);
  const tail = attempts > 1 ? `（已自动重试 ${attempts - 1} 次）` : "";
  const quoted = raw === "" ? "" : `：${raw}`;
  if (kind === "TIMEOUT") {
    return `连不上模型服务${quoted}${tail}。多半是网络或代理的问题，过一会儿再发一次就好。`;
  }
  if (kind === "TRANSPORT") {
    return `和模型服务的连接断了${quoted}${tail}。过一会儿再发一次就好。`;
  }
  if (kind === "RATE_LIMIT") {
    return `模型服务在限流${quoted}${tail}。等一会儿再发。`;
  }
  return `${raw || "模型调用失败"}${tail}`;
}

/**
 * 为一个宿主安装团队模式。
 *
 * @param {object} ctx 根插件上下文
 * @param {object} deps 只有 `index.js` 能提供的东西（deps 袋）
 * @param {string} deps.storeFile `teams.json` 的绝对路径
 * @param {() => object[]} deps.roster 人设目录里的每一行
 * @param {(id: string) => object | null} deps.personaTextOf 为一个人设组装出的文本
 * @param {(id: string) => object | null} [deps.personaBodyOf] 仅正文，不含单人
 *   骨架；团队模式在存在时优先使用
 * @param {(agent: object) => object | null} deps.coordinatorOf 会话自己的人设
 * @param {(name: string) => object | undefined} deps.serviceOf 懒加载的服务查找
 * @param {(sessionId: string) => object | undefined} deps.liveAgentFor
 * @param {number} [deps.maxTokens] 覆盖单次运行的输出上限
 * @param {number[]} [deps.retryDelaysMs] 各次尝试之间的退避；每次重试一项。
 *   由测试传入，让重试不必消耗真实的秒数。
 * @param {number} [deps.attemptTimeoutMs] 单次尝试的挂钟上限。
 *   默认为 `ATTEMPT_TIMEOUT_MS`；测试会把它调小，让停滞测试瞬时完成。
 * @param {(agent: object, teamName: string) => boolean} [deps.moveChipToTeam]
 *   把会话 chip 移到该团队的预设上。chip 归宿主管，所以以回调形式跨过来；
 *   尽力而为——缺了就只是不动它。
 * @param {string} [deps.runLogFile] `runs.jsonl` 的绝对路径；缺省 = 不记账本
 * @param {{ warn?: Function }} [deps.logger]
 * @returns {object} `index.js` 和客户端需要的对外接口
 */
export function installTeamRuntime(ctx, deps) {
  const store = { current: readStore(deps.storeFile) };
  /** sessionId -> 团队名。刻意放在内存里；见设计文档 §7.8。 */
  const bound = new Map();
  /**
   * sessionId -> 建立绑定时会话标签停在哪个预设上。
   *
   * 存在的唯一理由是「用标签察觉用户绕过本插件换了人」。`bound` 只在
   * `bind` / `unbind` 时变，而用户可以用宿主自己的预设选择器换人——
   * 那条路不经过本插件任何代码，`bound` 会原地不动。于是团队仍然服务
   * 那个会话：用户在「达克妮斯」人设下说一句话，回答他的是托尔和康娜；
   * 这一轮还会被写进 `team-memory`，下一轮单人回答引用它，看起来就像
   * 「换了人还带着前一个人的记忆」。
   *
   * 只比对「标签变了没有」，不比对「标签应该是什么」：`/waifu-team` 在
   * 团队预设还没注册成功时仍然允许绑定（那种情况下标签停在单人上），
   * 拿「标签必须是团队预设」当条件会把这条合法路径一起判死。
   */
  const boundChip = new Map();
  /**
   * sessionId -> 进队**之前**这一场在跑的那位单人设。
   *
   * 与 {@link boundChip} 是两件事，曾经被并成一个，于是 `/waifu-reset` 在
   * 团队会话里根本没退出团队：对账基准要的是「标签此刻在哪」（挪成功后就是
   * 团队预设），而 reset 要的是「我进队之前是谁」（一定是某个单人设）。共
   * 用一张表时，后写的那次把前者覆盖成团队预设，`unbind()` 便把一个团队当
   * 成人设交回去——命令报「已清掉团队绑定 · 回到团队「X」」，下一轮团队又
   * 从标签上复活，`team-memory` 继续写。
   *
   * 只在**从单人进入团队**时记一次：标签当时得是本插件注册的单人预设，
   * 否则（出生就在团队、或从另一支队转过来）没有「进队前那位单人」可记，
   * 留着空值让调用方走「没有落点」那条路，比编一个答案好。
   */
  const prevChip = new Map();
  /**
   * 被要求退出团队模式、但出生时就在团队上的会话。
   *
   * 团队预设是一个默认值，所以「没有绑定」不再等于「单人模式」：以团队预设创建
   * 的会话在 `bound` 里根本没有条目，却仍要按那个团队运行。因此退出必须记录一次
   * 显式拒绝，否则它看起来像是成功了，下一次组装读回预设时又会被撤销。命令拼法
   * 已经移除（会话通过 `/waifu-change` 或 `/waifu-reset` 退出），但 `forget` 和
   * 面板用空名字调用 `bind` 仍会在这里记录拒绝。
   */
  const off = new Set();
  const warn = (message) => {
    try {
      deps.logger?.warn?.(`dsh-waifu-agents: ${message}`);
    } catch {
      /* 抛异常的 logger 不许拖垮一个回合 */
    }
  };

  /*
   * 团队瘦身只有一个依赖，值得在它缺失时大声说出来。
   *
   * 团队模式承诺「无骨架、只要正文」（设计 §4.4）。这只有在宿主能交出人设正文
   * 时才可能；只会提供组装全文的宿主会落入下面的回退，然后每个成员都悄悄为那
   * 1543 字符的单人骨架再次付费——正是这次优化要移除的成本。不说出来的话，
   * 第三方宿主会以三倍价格运行却看不出原因，所以这里在安装时警告一次，而不是
   * 每回合都警告。
   *
   * 这不是错误：回退仍然可用，只是回到了旧价格。
   */
  if (typeof deps.personaBodyOf !== "function") {
    warn(
      "宿主没有提供 personaBodyOf，团队模式会退回「人设全文（含公共骨架）」：功能正常，但每个成员多付约 1543 字符。",
    );
  }

  /**
   * 团队模式灌进提示词的那份人设文本——也就是要拿去做哈希的那份。
   *
   * 两件事共用同一个读取器，因为哈希必须描述*发送出去*的字节，而不是磁盘上的
   * 字节。分两次调用就有读到中途被改过的文件的风险，而一份与实际运行内容不符的
   * 快照比没有快照更糟。
   *
   * 之所以处理三种形态，是因为宿主有三种：`deps.personaBodyOf` 可能完全缺失
   * （较旧的宿主），而且任一读取器都可能返回字符串或 `{ ok, text }`。`source`
   * 标明是哪一个答的，这正是让记录下来的哈希可比较的关键：仅正文的哈希和组装
   * 全文的哈希描述的是不同的字符串。
   *
   * @returns {{ text: string, source: "body" | "assembled", present: boolean }}
   */
  function personaEntry(id) {
    const read = (fn) => {
      if (typeof fn !== "function") return undefined;
      try {
        return fn(id);
      } catch {
        return undefined;
      }
    };
    const body = read(deps.personaBodyOf);
    const from = body === undefined || body === null ? read(deps.personaTextOf) : body;
    const source = body === undefined || body === null ? "assembled" : "body";
    if (from === undefined || from === null) return { text: "", source, present: false };
    const text = textOf(() => from, id);
    return { text, source, present: true };
  }

  /** 作为提示词构建器回调的 {@link personaEntry}：只给文本，绝不为 null。 */
  function personaFor(id) {
    return personaEntry(id).text;
  }

  /**
   * 每次运行一行，追加到 `runs.jsonl`。
   *
   * ## 为什么是文件而不是 Map
   *
   * `runs` 是内存里的幂等窗口，重启就全丢，这让「这次花了多少钱」在事后无从
   * 回答。账本只追加，所以能挺过重启；每次运行一行也保证一次写坏不会破坏它
   * 之前的任何内容。
   *
   * ## 为什么缺失值是 `null`
   *
   * `dsh-llm` 的适配器**无条件**发一个 `usage` chunk，起点是
   * `{inputTokens: 0, outputTokens: 0}`，只有服务方真的上报了数字才会覆盖它。
   * 所以「0」并不是测得为零的证据，`null` 才是「没有测量」唯一诚实的值。账本
   * 消费者必须把 `usageSource: "absent"` 当作*未知*，绝不能当作免费。
   *
   * `totalTokens` 按服务方上报原样记录，但它**不是**账单数字：适配器把它算作
   * `input + output + cacheRead + cacheWrite`
   * （`dsh-llm-deepseek` 的 `translate()`），所以缓存命中的输入被按全价计入。
   * 跨变更比较成本需要四个分量和服务方自己的价目表，而不是这个和。
   *
   * @param {object} line 这条记录；`usageSource` 决定其余字段怎么读
   */
  function recordRun(line) {
    const file = oneLine(deps.runLogFile);
    if (file === "") return;
    try {
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
    } catch (error) {
      // 回复已经发生了。一本写不进去的账本只是一个诊断信号，绝不能成为
      // 让回合失败的理由。
      warn(`写运行账本失败：${error?.message ?? error}`);
    }
  }

  /* ------------------------------------------------------------ 解析 */

  /** 目录里的每一行，按选择管线想要的形态给出。 */
  function rosterRows() {
    try {
      const rows = deps.roster();
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      warn(`读人设目录失败：${error?.message ?? error}`);
      return [];
    }
  }

  /**
   * 把存储的团队对着此刻的目录现场解析。
   *
   * 从不缓存：一个组是对 front matter 的实时查询，缓存的结果会在有人改了一行
   * `group:` 的那一刻过期。`resolveTeam` 是纯函数，所以每次组装付一次也只是对
   * 一个目录做一遍过滤——而且只对真的处于团队模式的会话付出。
   */
  /**
   * 这个会话当前以哪个团队运行，把三级梯子全部考虑进去。
   *
   *   - 显式的 `/waifu-team <name>` 绑定优先；
   *   - 显式拒绝（`off` 集合——由 `forget` 或空的 `bind` 记录）意味着没有团队，
   *     无论会话出生时是什么；
   *   - 否则是会话创建时带的团队预设（如果有的话）。
   *
   * 「没有团队」用 `undefined` 而不是 `null` 表示，因为一个绑定后又被删除的团队
   * 同样不在 `bound` 里，对负责汇报原因的调用方来说这两者必须保持可区分。
   */
  function teamNameFor(sessionId, agent) {
    if (bound.has(sessionId)) {
      const name = bound.get(sessionId);
      const chip = oneLine(deps.chipOf?.(agent));
      /* 拿不到标签（旧宿主、没有投影服务）时不动：误解绑比不解除更贵。 */
      if (chip === "") return name;
      const chipTeam = deps.teamForPreset?.(agent);
      /* 标签还停在这支队上：正常。 */
      if (chipTeam === name) {
        boundChip.set(sessionId, chip);
        return name;
      }
      /* 用户在预设选择器里挑了另一支队：跟着标签走。 */
      if (typeof chipTeam === "string" && chipTeam !== "") {
        bound.set(sessionId, chipTeam);
        boundChip.set(sessionId, chip);
        return chipTeam;
      }
      /* 标签与绑定时一致：团队预设没注册成的那种绑定，照旧服务。 */
      if (chip === boundChip.get(sessionId)) return name;
      /*
       * 标签被换成本插件注册的单人预设 —— 用户换了人，团队就此退出。
       *
       * 这是唯一能察觉「绕过本插件换人」的地方：宿主的选择器不经过我们任何
       * 代码，`bound` 不会自己动。少了这一步，用户以为已经切到达克妮斯，
       * 实际回答的仍是托尔和康娜，而且这一轮还会被写进 `team-memory`。
       */
      if (deps.isPersonaPreset?.(chip) === true) {
        bound.delete(sessionId);
        boundChip.delete(sessionId);
        prevChip.delete(sessionId);
        return undefined;
      }
      /* 认不出的预设（宿主默认、别人的）：不改判定，只跟上标签。 */
      boundChip.set(sessionId, chip);
      return name;
    }
    if (off.has(sessionId)) return undefined;
    const born = deps.teamForPreset?.(agent);
    return typeof born === "string" && born !== "" ? born : undefined;
  }

  /**
   * 记下「进队之前这一场在跑的那位单人设」。
   *
   * 只在第一次从单人进入团队时写，之后改绑另一支队、或在选择器里换队都
   * 不再覆盖它——`/waifu-reset` 要撤的是「进队」这件事，不是最后一次改绑。
   * 标签当时不是本插件的单人预设（出生即在团队、或从另一支队转来）就什么
   * 都不记：那种情况下没有「进队前那位单人」可交回，调用方走「没有落点」
   * 那条路，比编一个答案诚实。
   */
  function rememberPrevChip(sessionId, agent) {
    if (prevChip.has(sessionId)) return;
    const chip = oneLine(deps.chipOf?.(agent));
    if (chip === "" || deps.isPersonaPreset?.(chip) !== true) return;
    prevChip.set(sessionId, chip);
  }

  function resolveFor(sessionId, agent) {
    const name = teamNameFor(sessionId, agent);
    if (name === undefined) return null;
    const team = findTeam(store.current, name);
    if (team === null) return { ok: false, error: `团队「${name}」不在 ${TEAM_FILE} 里了。` };
    return {
      ...resolveTeam({
        team,
        roster: rosterRows(),
        coordinator: deps.coordinatorOf(agent),
        store: store.current,
      }),
      team,
    };
  }

  /**
   * 回答「这个会话现在是什么模式」，供一次组装使用。
   *
   * 由 `index.js` 的人设变量提供器调用，所以本插件服务的每个 agent 每次组装都会
   * 跑一次它。每个提前返回都是文本为空的 `off`，这正是让单人模式保持零开销的
   * 原因：一次 Map 查找、不读目录、人设逐字节保持原样。
   *
   * @returns {{ mode: "off" | "single" | "team", text: string, notices: string[], error?: string }}
   */
  function ensureTeam(agent) {
    const off = { mode: "off", text: "", notices: [] };
    const sessionId = oneLine(agent?.session?.id);
    if (sessionId === "") return off;
    /*
     * 被委派的子会话永远不会在团队上。
     *
     * 平台仍然会为其他工具创建子会话，而 `dsh-subagent` 的 `childSessionMeta`
     * **会把父会话的 `agentPreset` 复制进子会话的头部**——于是一个团队预设会话
     * 的子会话会解析出它出生的那个团队。没有这道防线，子会话会报告团队模式，
     * 而子会话自己的下一回合就会成为团队接管的候选，用一个模拟的讨论去回答
     * 交给它的问题，而不是让它做自己的工作。
     *
     * `isDelegated` 是让这个检查成为可能的东西；至于为什么看会话头部而不是
     * `session.meta`，见它自己的说明。
     */
    if (isDelegated(agent)) return off;
    if (teamNameFor(sessionId, agent) === undefined) return off;
    const problem = storeProblem(store.current);
    if (problem !== null) return { ...off, error: problem };
    const resolved = resolveFor(sessionId, agent);
    if (resolved === null) return off;
    if (resolved.ok !== true) return { ...off, error: resolved.error };
    // `|team| < 2` 是唯一决定回退的地方（闸门 S3 ≡ H4），而且不达标要宣布出来
    // 而不是静默：用户要的是一支团队，他们有理由知道为什么没拿到。
    if (resolved.single) {
      const why = resolved.members.length === 0
        ? `「${resolved.team.name}」现在一个成员都解析不出来。`
        : `「${resolved.team.name}」只解析出 1 名成员（${resolved.members[0].name}）。`;
      return { ...off, mode: "single", notices: [...(resolved.notices ?? []), `${why}已按单人模式执行。`] };
    }
    /*
     * 不按会话安装任何东西，这正是 v3 的全部意义。
     *
     * 没有协调者回合可以给工具：`discussionStream` 自己构建那一次模拟请求。
     * `text` 为空，因为服务出的人设必须逐字节保持原样——模拟提示词在模型调用时
     * 从头组装，而不是附加到根人设后面。
     */
    return { mode: "team", text: "", notices: resolved.notices ?? [] };
  }

  /**
   * 这个 agent 是被委派出来的子会话吗？
   *
   * ## 读的是 header，因为平台就放在那里
   *
   * `dsh-subagent` 的 `childSessionMeta(parent, depth, seeded)` 返回
   *
   *     { cwd?, agentPreset?, parentSession, isSeeded, origin: 'subagent', delegationDepth }
   *
   * 而那个对象**会成为子会话的 `session.header`**——`Session` 上有 `header`，
   * 没有 `meta`。这个函数曾经读 `session.meta`，它在每个真实会话上都是
   * `undefined`，所以它对每个真实的子会话都回答 `false`，只在对着 selftest 的
   * 桩（那个桩设置了 `meta`）时才工作过。
   *
   * 在唯一调用者还是委派工具的年代这没有被发现：子会话反正看不到那个工具
   * （它注册在*父会话*自己的层级里），所以那道防线是从来没用咬合过的保险。
   * 接管钩子改变了这一点。`agent/pre-step` 注册在根上下文上一次，会对进程里的
   * **每一个** agent 触发，子会话也包括在内，于是一个永远回答「不是」的防线
   * 意味着团队自己的成员各自开一支团队，再各自生出成员，直到进程死掉。
   * 这是观察到的事实，不是推理：一次真实运行产生了 root → `49afe7fb` →
   * `5eddbef3` 并继续往下走。
   *
   * 三个信号全部检查，因为漏报的代价是失控递归，误报的代价是一个回合被 Agent
   * 自己抢答：
   *
   *   - `header.origin === "subagent"`；
   *   - `header.delegationDepth > 0`，它能挺过持久化和恢复；
   *   - 非空的 `header.parentSession`，这是结构性的——就算某个子会话不知怎么
   *     丢了它的分类，它也仍然叫得出父会话。
   *
   * `meta` 仍然会读，这样现有的桩形态测试继续描述同一件事，而不是围绕一个实现
   * 细节被重写。
   */
  function isDelegated(agent) {
    const session = agent?.session;
    if (session === null || typeof session !== "object") return false;
    for (const source of [session.header, session.meta]) {
      if (source === null || typeof source !== "object") continue;
      if (source.origin === "subagent") return true;
      const depth = source.delegationDepth;
      if (typeof depth === "number" && depth > 0) return true;
      if (typeof source.parentSession === "string" && source.parentSession !== "") return true;
    }
    return false;
  }

  /* ------------------------------------------------------------- 接管 */

  /**
   * 讨论此刻正在进行的会话。
   *
   * 这是纵深防御，不是锁。一个 Agent 一次只跑一个回合——`kick()` 是
   * `while (await this.turn())`——而讨论进行到一半到达的消息会被拼接收件箱、
   * 由*更晚的*一个回合认领，所以「同时两场讨论」本应不可达。万一可达，正确的
   * 应对是让开，而不是把团队跑两遍、追加两条回复。
   */
  const midDiscussion = new Set();

  /**
   * 这个 step 要不要被接管？以什么任务接管？
   *
   * `null` 表示「让 Agent 自己答」，凡本代码不确定的情况都返回它。这种不对称是
   * 刻意的：放行一条消息的代价是用户付一个协调者回合，而错误接管的代价是他们
   * 付一个永远看不见的答案。
   *
   * 各道防线及其理由：
   *
   *   - **step 1**——一个回合的第一个 step 是收件箱认领里包含用户 `next-turn`
   *     消息的唯一一个。step 2 起都是 Agent 在自己的工具结果上循环。
   *   - **真正的用户消息**——`userTaskIn` 按 `source.kind` 匹配，所以驻留成员
   *     的 `agent-message` 中继、`subagent-settled` 通知、`system-prompt` 上下文
   *     全都放行。这让钩子不会吃掉自己团队的流量。
   *   - **不是被委派的子会话**——见 `isDelegated`。
   *   - **团队模式真的解析得出来**——出生在团队预设上、但团队后来缩到只剩一名
   *     成员的会话处于*单人*模式，`ensureTeam` 已经做出了那个判断；接管它等于
   *     用一支不存在的团队回答一个单人会话。
   *
   * @param {object} payload - `agent/pre-step` 瀑布的 payload。
   * @returns {{agent: object, sessionId: string, task: string} | null}
   */
  function takeoverFor(payload) {
    const agent = payload?.agent;
    const sessionId = oneLine(agent?.session?.id);
    if (sessionId === "") return null;
    if (Number(payload?.step) !== 1) return null;
    if (isDelegated(agent)) return null;
    if (teamNameFor(sessionId, agent) === undefined) return null;
    const task = userTaskIn(payload?.messages);
    if (task === null) return null;
    const resolved = resolveFor(sessionId, agent);
    if (resolved === null || resolved.ok !== true) return null;
    if (resolved.single || resolved.members.length === 0) return null;
    /*
     * 消息 id 是幂等身份，在这里——回合开始之前、只此一次——就捕获下来，而不是
     * 拖到模型调用时，这样重复触发不可能铸出第二个 key。没有 id 的消息（一条
     * 合成的收件箱行）回退用 step，它对整个回合是稳定的。
     */
    const taskId = userMessageIdIn(payload?.messages) || `step-${Number(payload?.step) || 0}`;
    return { agent, sessionId, task, taskId, resolved };
  }

  /**
   * 欠着团队下一次模型调用的会话。
   *
   * `agent/pre-step` 只判断一个回合*是否*属于团队；它不再亲自回答回合。答案在
   * 晚一个钩子的 {@link discussionStream} 里交付——那是插件唯一被允许成为模型的
   * 地方。
   *
   * 按会话为键，由第一个匹配的 `llm/stream` 消费，同时还有 TTL 兜底：如果两个
   * 钩子之间任何东西抛了异常，一条过期条目绝不能拿一场旧讨论去回答*更晚的*
   * 某个回合。
   */
  const owed = new Map();

  /**
   * 一条未被认领的接管保持可认领多久。比两个钩子之间的任何停顿都长，比人打下
   * 一条消息所需要的时间短。
   */
  const OWED_TTL_MS = 5 * 60 * 1000;

  /**
   * 本进程启动过的每一次 v3 运行，键为 `sessionId::taskId`。
   *
   * 这个键就是幂等身份：同一条用户消息可能两次到达钩子（两条触发路径），而第二次
   * **不许**再调一次模型。`claim` 是同步的——查找与插入之间没有 `await`——所以
   * 同一个 tick 里的两次触发不可能同时胜出。
   *
   * 记录只活在内存里。把它们持久化到桌面重启之后属于尚未在这里接线的 M1 工作；
   * 因此重启规则是「一条不是本进程启动的 `running` 记录不存在」，这是设计 §2.5
   * 保守的那一半（绝不要重跑一个你无法确认结果的调用）。
   */
  const runs = new Map();
  /** 把已结束的记录多留一阵，好让重复触发能找到它。 */
  const RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

  /**
   * 模型无视协议时，把多少无法解析的散文回显给用户。
   *
   * 有上界，因为回复是一条聊天消息：要点是不丢掉那个答案，而不是把一段无界的
   * 补全整段倒进去。
   */
  const PROSE_FALLBACK_LIMIT = 4000;

  /**
   * 本模块自己构建的请求，让 `llm/stream` 监听器能把自己的重入模拟调用与第二次
   * 触发区分开。
   *
   * 用 `WeakSet` 而不是请求上的字段：请求会交给适配器，而一个把未知键展开进
   * 服务方 payload 的适配器是不值得冒的险。身份就够了——`llm.stream(request)`
   * 把同一个对象传进瀑布。
   */
  const simulationCalls = new WeakSet();

  /**
   * 每个会话的团队记忆，缓存在磁盘文件前面。
   *
   * 进程活着期间，缓存就是事实来源：某回合的流一落定，该回合就追加进缓存对象，
   * 磁盘写入随后 fire-and-forget。正是这个顺序让紧接着的下一回合不会读到落后
   * 一回合的记忆——用户的下一条消息可以跑赢一次慢的磁盘写，但它仍必须看到
   * 刚刚结束的那一回合。
   */
  const memoryCache = new Map();

  function pruneRuns() {
    const now = Date.now();
    for (const [key, run] of [...runs.entries()]) {
      if (run.terminal === true && now - run.finishedAt > RUN_WINDOW_MS) runs.delete(key);
    }
  }

  /**
   * 把被逐出的回合折进会话摘要——记忆的「懒」的那一半。
   *
   * 在记忆还背着积压的回合的*开头*调用，所以这个调用跑在有真实错误处理的活动
   * fiber 里，而不是回复关闭后的 fire-and-forget。返回 `null` 表示折叠没有发生
   * （积压原地保留，回合不带它继续）：一次 LLM 故障不能变成一次记忆故障，也
   * 不能阻塞用户真正要的那个回合。
   *
   * 请求在 `llm.stream` 之前就标记进 `simulationCalls`，与主调用完全一样——
   * `llm/stream` 瀑布看得见进程里的每一条流，必须认出这一条是我们自己的重入。
   *
   * @returns {Promise<string|null>} 折叠出的文本，失败时为 null
   */
  async function foldSummary(llm, { options, budget, oldSummary, batch }) {
    const request = {
      provider: options?.provider,
      model: options?.model,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: summaryPrompt({ oldSummary, batch }) }],
          source: { kind: "user" },
        },
      ],
      maxTokens: budget,
    };
    simulationCalls.add(request);
    const attempts = RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        let text = "";
        for await (const chunk of llm.stream(request)) {
          if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
          else if (chunk?.type === "block-end" && chunk.block?.type === "text" && text === "") {
            text = String(chunk.block.text ?? "");
          }
        }
        if (text.trim() === "") {
          throw Object.assign(new Error("梗概调用返回了空内容"), { code: "EMPTY_RESPONSE" });
        }
        return text;
      } catch (error) {
        const code = String(error?.code ?? error?.failureCode ?? "");
        if (attempt < attempts && RETRYABLE_FAILURES.includes(code)) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  /**
   * 一个有缓冲、单消费者的 chunk 队列。
   *
   * 讨论往里推，流向外出拉，这层间接不是装饰：一回合的结束是在 `async` 回调
   * （`onRound`）里发现的，而生成器没法从回调里 `yield`。它也是让一个回合
   * *在发生时*就可见的原因——该回合最后一名成员答完的那一刻，队列就把这一回合
   * 交给客户端，而不是等整场讨论结束。
   */
  function makeChunkQueue() {
    const buffer = [];
    let closed = false;
    let wake = null;
    const nudge = () => {
      const resume = wake;
      wake = null;
      if (resume !== null) resume();
    };
    return {
      push(chunk) {
        buffer.push(chunk);
        nudge();
      },
      close() {
        closed = true;
        nudge();
      },
      async *drain() {
        while (true) {
          while (buffer.length > 0) {
            const chunk = buffer.shift();
            if (chunk !== undefined) yield chunk;
          }
          if (closed) return;
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
      },
    };
  }

  /**
   * 为团队答不了的回合构造一条完整、合法的流。
   *
   * 上层循环拒绝任何不以 `finish` 结尾的回复，所以每个提前退出（重复消息、
   * 没有成员、没有 LLM 服务）也都必须长得像一次模型回答——一个文本块，然后停。
   */
  async function* fixedStream(text) {
    const value = typeof text === "string" && text !== "" ? text : SIM_SILENCE;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: value };
    yield { type: "block-end", index: 0, block: { type: "text", text: value } };
    yield { type: "finish", reason: { kind: "stop" } };
  }

  /**
   * v3：一次模型调用，解析成闭合的分段，逐条流出。
   *
   * 旧路径为每名成员每回合开一个子会话再重放总线。那已经没有了。这个函数通过
   * `llm` 服务做**一次**调用（与 `llm/stream` 瀑布包裹的是同一个服务，请求在这里
   * 构建而不是用根的），把 token 流喂给分段解析器，只在一段闭合时才吐出一行。
   * token 级的活性得以保留，且不再需要第二次重放。
   *
   * 设计里的两条规则在这里是被强制执行的，不只是被记录：
   *
   *   - **终态只写一次。**`settle` 拒绝覆盖一场已经结束的运行，所以一次被中止
   *     调用的迟到 finish 不可能把 `cancelled` 翻回 `converged`（§5.4）。
   *   - **状态首先来自 finish 原因**（§6.2）。一个只是看起来完整的缓冲永远不足
   *     以宣称正常结束。
   */
  async function* discussionStream(asked, options) {
    const sessionId = oneLine(asked?.sessionId);
    const taskId = oneLine(asked?.taskId) || "turn";
    const key = `${sessionId}::${taskId}`;

    /*
     * 原子认领。一条消息的两个触发会在同一个同步 tick 内到达这里，所以一次
     * 查找后紧跟插入、中间没有 `await`，就是幂等保证的全部（§5.1）。重复触发
     * 永远不会调用模型；它说明情况然后结束。
     */
    const prior = runs.get(key);
    if (prior !== undefined) {
      yield* fixedStream(`! 这条消息已经有一场讨论（${prior.status}），没有重复生成。`);
      return;
    }

    const resolved = asked?.resolved;
    const members = Array.isArray(resolved?.members) ? resolved.members : [];
    if (resolved?.ok !== true || members.length === 0) {
      yield* fixedStream("! 这一轮团队没跑起来：团队没有解析出成员。");
      return;
    }

    const run = {
      key,
      runId: randomUUID(),
      /**
       * 本次运行发出的**最后一个**模型请求的身份。
       *
       * 它不是服务方请求 id：`dsh-llm` 和适配器都不暴露这种 id，编一个看起来像
       * 的值还不如承认没有。这是插件自己握住的调用把手，在 `llm.stream` 之前
       * 铸出，这样即使调用根本没到服务方，账本上也有一行。
       *
       * 一次运行可能发出多个请求（见 `requests`），顶层的 `requestId` 和 usage
       * 列描述的是**最后一个**——文本进入回复的那一次尝试。把它留在顶层只是为了
       * 与按次核算出现之前的旧行保持连续；`requests` 数组才是完整的记录。
       */
      requestId: randomUUID(),
      /**
       * ## 每一次真实的服务方请求一条，包括失败的
       *
       * 一次运行是一场**逻辑**讨论：一条用户触发，一条回复。它不是一次 HTTP
       * 调用。当连接超时吃掉第一次尝试、第二次成功时，顶层的 usage 列只能描述
       * 第二次——而第一次付掉的 token 就这么从账本上消失了。这就是「这次运行花
       * 了 2400 输入 token」和「这次运行花了 2400 输入 token 加上重试烧掉的」
       * 之间的区别，只有后一句是真的。
       *
       * 所以每次尝试在这里推入自己的一行：自己的 requestId、自己的 usage、自己的
       * 时长、自己的失败类别，以及它是否被重试。这个数组里没有一个字符是对白——
       * 账本规则（§5.5）没有被触碰：仍然每次运行一行，仍然没有正文。
       *
       * 重试只可能发生在**什么都没显示**的时候（`wrote === 0`），所以成功的那次
       * 尝试总是最后一条，它的 usage 就是顶层 usage。把这个数组加总是这次运行的
       * 真实成本；加总顶层是这条回复的成本。这是两个不同的问题。
       */
      requests: [],
      /** 是哪种生成策略产出了这次运行；今天只有一个值。 */
      strategy: "team-single",
      provider: oneLine(options?.provider),
      model: oneLine(options?.model),
      sessionId,
      taskId,
      status: "running",
      terminal: false,
      /**
       * 这次运行实际发出了多少次服务方请求。
       *
       * 健康的回合是一次。更多意味着第一次尝试在显示任何字符之前就死了并被重试；
       * 账本必须把这一点写下来，因为一行 token 来自第 2 次尝试的记录，与一行
       * 一次成功的记录不是同一种证据，而 usage 列只能描述其中一次尝试。
       */
      attempts: 0,
      startedAt: Date.now(),
      finishedAt: 0,
      team: oneLine(resolved.team?.name),
      size: members.length,
      segments: 0,
      /*
       * 请求的字符数规模，提示词组装好后填入。初始化为 `null` 而不是留空，
       * 这样一次在构建请求之前就失败的运行仍会写出一行看起来完整的记录——
       * 缺键和 null 在每个 JSON 消费者眼里读起来都不一样。
       */
      promptChars: null,
      taskChars: null,
      requestShape: null,
      /**
       * 回复的规模类别（`social` / `task` / `complex`）与它对应的 token 上限。
       * 两者都在提示词构建好后填入，但初始化为 `null`，让一次在构建请求之前
       * 就死掉的运行仍写出一行看起来完整的记录。
       */
      scale: null,
      maxTokens: null,
      /**
       * 回复的进展阶段，用于「准备中 vs 流式输出中」的两态区分（C）。`preparing`
       * 表示请求已发出但一个字符都没到；`streaming` 表示第一个 token 已落地；
       * 终态会取代两者。它是*测量出来的*事实，绝不是一个伪造的进度条。
       */
      phase: "preparing",
      /**
       * 第一个 `text-delta` 到达的时刻，以及等了多久。
       *
       * `firstTokenAt` 在 token 落地前一直是 0；`firstTokenMs` 是发出请求到那个
       * 第一个 token 之间的挂钟间隔——92 秒「黑屏」在账本里的现形方式。记录它
       * 是为了让预填充等待只凭账本就可诊断，不必去重读会话日志。它是延迟，
       * 不是进度声明。
       */
      firstTokenAt: 0,
      firstTokenMs: null,
      /**
       * 团队*当时*的样子，冻结成哈希——见 `team-snapshot.js`。
       *
       * 账本曾经只按形状（`team` + `size`）描述一次运行，而两场不同的讨论可以
       * 共享同一形状：改一个人设正文、给花名册重排序、或改写共享规则，行看起来
       * 一模一样，提示词却不是。哈希加长度让这种差异可见，又不用把角色文本的
       * 任何一个字符抄进一份 §5.5 规定它们永远不该出现的文件。
       *
       * 提示词构建之前一直是 `null`，于是在那之前死掉的运行仍写出一行看起来
       * 完整的记录——而且这里的 `null` 本身就是「什么都没组装过」的证据。
       */
      config: null,
      diagnostics: [],
      /** 从未产出闭合分段的成员；只填一次，在 settle 时。 */
      silent: [],
      /**
       * 这次运行为了让讨论继续下去而额外发出的请求数。
       *
       * 不是重试次数：这里面每一次都产出了留在回复里的文本。记录它是因为一场
       * 三请求的运行和一场单请求的运行在回复里可能看起来一样，而成本差别是真的。
       */
      continuations: 0,
    };
    runs.set(key, run);
    pruneRuns();
    midDiscussion.add(sessionId);

    const queue = makeChunkQueue();
    let full = "";
    /** 模型写的全部内容，解析器碰过之前的原样。 */
    let raw = "";
    /**
     * 服务方的 `usage` chunk，最后原样转发一次。
     *
     * `usage` 是一种**独立的 chunk 类型**，不是 `finish` 上的字段
     * （`dsh-llm/lib/invariant.js` 允许它在终结 finish 之前出现，至多一次）。
     * 流循环曾经把它整个丢掉，代价是从外面看不见：`BlockAssembler._usage` 一直是
     * undefined，于是团队回合从不写 `assistant/message.usage`——token 花掉了，
     * 却没有任何东西记录。按原样转发而不是折进 `finish`，平台自己的记账就
     * 无需改动地工作。
     */
    let providerUsage = null;
    const emit = (text) => {
      if (typeof text !== "string" || text === "") return;
      full += text;
      queue.push({ type: "text-delta", index: 0, text });
    };
    /** 往回复已有内容的后面追加一段。 */
    const append = (text) => {
      if (typeof text !== "string" || text === "") return;
      emit(full === "" ? text : `\n\n${text}`);
    };
    // 块在任何东西被推进去之前先打开：不变量会拒绝一个索引没有打开块的
    // `text-delta`。
    queue.push({ type: "block-start", index: 0, blockType: "text" });

    /** 只写一次的终态。第一个答案获胜；迟到的回调被丢弃。 */
    const settle = (status) => {
      if (run.terminal === true) return run.status;
      run.terminal = true;
      run.status = status;
      run.finishedAt = Date.now();
      return status;
    };

    /*
     * 刻意声明在 `try` **外面**。
     *
     * 它们描述模型调用是怎么结束的，下面的 `finally` 需要它们来写账本。`try`
     * 块里的 `let` 在 `finally` 里不可见——而且失败模式很难看：构建记录时抛出的
     * `ReferenceError` 会被 `work.catch` 吞掉，于是回合看起来一切正常、账本悄悄
     * 永远少一行，而在 `queue.close()` 挪到记录之前时，整条流直接挂死。
     */
    let finishKind = null;
    let finishFailure = "";
    /**
     * 终结 chunk 里的失败类别（`TIMEOUT`、`TRANSPORT`……）。
     *
     * 与消息分开存放，因为消息是来自服务方 SDK 的散文，而代码才是可以据以决策的
     * 东西：要不要重试是关于类别的问题，与异常用了哪些词无关。
     */
    let finishCode = "";
    let endedWithoutFinish = true;
    let wrote = 0;

    /*
     * 团队记忆，与上面的 `finishKind` 出于同样的 TDZ 理由声明在 `try` 外面：
     * `finally` 要把回合记进记忆，在抛异常的路径上也需要这些。当这个团队关了
     * 记忆、或没接目录时，`mem` 保持 `null`——下面的每个消费者都做 null 检查，
     * 所以「关闭」只花一个布尔值的成本。
     */
    let mem = null;
    let memBlock = "";
    let memoryOn = false;
    let memKey = "";
    let finalRaw = "";

    /*
     * 思考链，作为原生 reasoning 块转发（§8 reasoning）。
     *
     * `dsh-llm` 0.2.1 把模型的推理作为一等公民的流式块发出——
     * `block-start { blockType: "reasoning" }`，然后若干 `reasoning-delta`，
     * 再一个块为 `{ type: "reasoning" }` 的 `block-end`。下面的 chunk 循环曾经
     * 把它们全部丢掉（没有分支命中），这就是团队模式从不显示思考链的原因：
     * 平台本来能原生渲染 `reasoning` 块，只是本插件从未交出过。
     *
     * reasoning 块用自己的索引（1），永远不与索引 0 上的文本块冲突——索引 0
     * 是分段协议的。我们自己累积文本，让收尾的 `block-end` 能带上完整的推理——
     * 组装器把 delta 追加进 `reasoningText`，而闭合的块必须写明它的全文，与下面
     * 文本块用 `full` 做的完全一样。
     */
    let reasoningOpen = false;
    let reasoningText = "";

    const work = (async () => {
      try {
        const llm = deps.serviceOf("llm");
        if (typeof llm?.stream !== "function") {
          settle("error");
          emit("! 这一轮团队没跑起来：这个 profile 没有可用的 LLM 服务。");
          return;
        }
        const names = members.map((row) => oneLine(row?.name) || oneLine(row?.id)).filter((one) => one !== "");
        /*
         * 宿主给得出就只用正文：讨论不调工具，单人骨架等于每颗头重复同一段
         * 1543 字符。没有 `personaBodyOf` 的宿主回退到组装全文、付旧价格——
         * 仍然正确，只是更贵。起名字而不是内联，是因为快照要对提示词构建所用的
         * *同一批*字符串做哈希；见 `personaFor`。
         */
        /*
         * 回复期望的规模类别，只由回合本身决定（A）。它只塑造提示词里的紧凑/
         * 澄清条款——硬上限（B）来自台上的人数，因为协议要求每个人都开口。
         * 把上限绑在用户字数上正是当年的 bug：三人间里的「继续」至少也需要
         * 三行。宿主设置了 `deps.maxTokens` 时它直接获胜，不会被我们自己的
         * 下限或上限调低。
         */
        const scale = classifyTurn(asked.task);
        const budget = turnBudget(deps.maxTokens);
        run.scale = scale;
        run.maxTokens = budget;
        /*
         * 载入（或复用）这个会话的记忆，并结清更早一次逐出留下的折叠积压——
         * 在第一个请求构建之前完成，这样这一回合已经能看到折叠后的摘要。
         * `resolved.team.memory` 是按团队的开关；缺省表示开（用户可见的默认）。
         * 缺 `memoryDir`（selftest 宿主，或没有家目录的探针）时整条路径无声禁用。
         */
        memoryOn = resolved.team?.memory !== false;
        const memoryDirOk = typeof deps.memoryDir === "string" && deps.memoryDir !== "";
        /*
         * 键是会话 × 团队，不只是会话：`/waifu-team` 可以在会话中途换绑，A 队的
         * 剧情绝不能漏进 B 队的回合。因此给团队改名等于开始一份新记忆——旧文件
         * 走保留窗口自然过期。
         */
        memKey = memoryOn && memoryDirOk ? `${sessionId}::${resolved.team?.name ?? ""}` : "";
        if (memoryOn && memoryDirOk) {
          mem = memoryCache.get(memKey);
          if (mem === undefined) {
            mem = await readMemory(deps.memoryDir, memKey, {
            /*
             * 保留期按团队：面板像改分页数字一样改 `memoryTtlDays`（0 = 永久保留）。
             * 有限的 `deps.memoryTtlMs` 仍是 selftest 的离线覆盖。
             */
            ttlMs:
              Number.isFinite(deps.memoryTtlMs) && deps.memoryTtlMs > 0
                ? deps.memoryTtlMs
                : memoryTtlMsFromDays(resolved.team?.memoryTtlDays),
          });
            memoryCache.set(memKey, mem);
          }
          if (mem.backlog.length > 0) {
            const folded = await foldSummary(llm, {
              options,
              budget,
              oldSummary: mem.summary,
              batch: mem.backlog.join("\n"),
            });
            if (folded !== null) applySummary(mem, folded);
            else trimBacklog(mem);
          }
          memBlock = renderMemoryBlock(mem);
        }
        run.memChars = memBlock.length;
        /*
         * 人设的长期记忆与剧情记忆乘同一条 user 消息，且排在剧情记忆*前面*：
         * 剧情是刚刚发生的事，人设记忆是她进来时随身带的。合并而不是堆成第二条
         * 消息，因为房间提示词恰好只有一个 user 回合——再冒出一条会被读成用户
         * 说了两次话。
         *
         * 没有该提供者的宿主（每个 selftest、没有家目录的探针）只是拿不到这个块，
         * `personaMemChars` 保持 0——这同时也是「关了就是零字符」的断言。
         */
        let personaMemBlock = "";
        if (typeof deps.personaMemoryOf === "function") {
          try {
            const block = await deps.personaMemoryOf({
              members,
              task: asked.task,
              team: resolved.team,
            });
            if (typeof block === "string") personaMemBlock = block.trim();
          } catch (error) {
            warn(`组装角色长期记忆失败：${error?.message ?? error}`);
          }
        }
        run.personaMemChars = personaMemBlock.length;
        const memoryText =
          personaMemBlock === "" || memBlock === ""
            ? `${personaMemBlock}${memBlock}`
            : `${personaMemBlock}\n\n${memBlock}`;
        const prompt = simulationSystemPrompt({
          team: resolved.team,
          members,
          personaOf: personaFor,
          task: asked.task,
          scale,
        });
        let messages = simulationMessages({ prompt, task: asked.task, memory: memoryText });
        /*
         * 账本的基线那一半：这个请求*长什么样*，与它花了多少无关。
         *
         * `usage` 的质量只取决于服务方的上报——被取消或缺席的运行什么都测不到。
         * 字符永远可测，所以即使一次从未上报 token 的运行，骨架去重前后的对比
         * 依然可能。这些是**字符，不是 token**：这里不跑分词器，把字符数冒充
         * token 数，正是「省了 50%」最后被证明是舍入误差的原因。
         */
        run.promptChars = prompt.length;
        run.taskChars = typeof asked.task === "string" ? asked.task.length : 0;
        run.requestShape = messages.map((message) => oneLine(message?.role)).join(">");
        /*
         * 在这里冻结配置——提示词已存在、第一个请求尚未发出——这样快照描述的
         * 永远是真实发送出去的字节。改为再读一遍人设文件，就会冒两次读之间
         * 文件被改、哈希到新内容的风险。
         *
         * `personaSource` 记录灌进去的是哪个变体：宿主暴露 `personaBodyOf` 时是
         * 仅正文，否则是组装全文。这两个字符串的哈希不可比较，读者也没有别的
         * 办法知道一行记录描述的是哪一个。
         */
        run.config = snapshotOf({
          team: resolved.team,
          members,
          personaOf: personaFor,
          sourceOf: (id) => personaEntry(id).source,
          rules: TEAM_COMMON_RULES,
          task: asked.task,
          model: {
            provider: options?.provider,
            model: options?.model,
            maxTokens: budget,
            /*
             * 没有回合数：提示词要的是一个结束条件，不是回合数，所以这里没有
             * 什么可冻结的。`maxRounds` 在 `snapshotOf` 里仍可读（旧行还带着它），
             * 新行返回 `null`——这是诚实的「没有这个参数」，而不是一个没人理会
             * 的数字。
             */
            scale,
          },
          prompt: { text: prompt, shape: run.requestShape },
        });
        /*
         * ## 尝试循环，以及平台为什么不提供它
         *
         * `llm-retry` 在 agent 循环的 step 边界上重试失败的模型请求。它的 README
         * 一口气写明了边界与例外：重试「在同一个打开的回合里重跑失败的 step，
         * 而**直接的 `ctx.llm.stream()` 调用保持单次尝试**」，因为「一条裸流无法
         * 持久地分离已发出的 chunk」。
         *
         * 这次接管*恰恰*就是这样一次调用。于是普通回合能靠最多五次重试熬过一次
         * 传输抖动，而团队回合在第一次就死了——线上日志正是这样：十秒内两次
         * `Request timed out.`，夹在中间的单人回合却正常完成。
         *
         * 我们可以在平台做不到的地方重试，因为我们知道一件它不知道的事：屏幕上
         * 是否已经出现过任何东西。一次以**零个已发出分段、零个原始字符**收尾的
         * 尝试一个字都没显示过，所以再问一次是不可见的，也不可能重复任何一行。
         * 在第一段渲染出的分段之后，这种修复就不存在了——文本已经进了记录，
         * 无法收回——所以部分失败只上报，绝不重试。
         *
         * 预算是两次重试，不是五次。它针对的失败是十秒连接超时：没有任何挂起
         * 的东西值得更久的等待，而每多一次尝试，就是用户面前多十秒的空回复。
         */
        const delays =
          Array.isArray(deps.retryDelaysMs) && deps.retryDelaysMs.length > 0
            ? deps.retryDelaysMs
            : RETRY_DELAYS_MS;
        const maxAttempts = delays.length + 1;
        const retryable = new Set(RETRYABLE_FAILURES);

        /*
         * ## 续写：一次运行，多次请求
         *
         * 一场讨论不是一条消息的长度。在此之前，一次运行恰好只有一个请求（外加
         * 重试），所以 token 上限实际上就*是*论证的长度：撞上它，场景停在半个词
         * 中间。现在上限只是技术防线，撞上时运行会再要一条回复，让它接着已经说过
         * 的内容往下说——总长度由续写预算约束，而不是由单次请求的上限约束。
         *
         * 再要一次还有第二个理由：一场运行可以干净地结束，却仍有人没开口。规则
         * 要求每名成员都发言，所以「收敛了但 C 从头到尾没张嘴」不是一场完整的
         * 讨论；一次补齐请求专门要回恰好缺失的那些声音。
         *
         * `transcript` 累积原始文本（含协议标记），这样续写引用的是真正写过的
         * 内容，不是对它的重新渲染。`spokenAll` 是横跨所有请求的覆盖证据——
         * 在第一条回复里开过口的成员，之后沉默也算覆盖。
         */
        let round = 0;
        let roundReason = "initial";
        let continuations = 0;
        let transcript = "";
        const spokenAll = [];

        for (;;) {
          let again = false;
          for (let attempt = 1; ; attempt += 1) {
            run.attempts = attempt;
          /*
           * 每次尝试的身份与时钟。`run.requestId` 指向这一次尝试，让顶层永远指向
           * 其 usage 被顶层各列描述的那个请求；下面的数组条目把每一次都留住。
           */
          const attemptRequestId = randomUUID();
          run.requestId = attemptRequestId;
          const attemptStartedAt = Date.now();
          const segmentsBefore = wrote;
          /*
           * 每次尝试重置，不是因为重试会丢工作——重试条件禁止了这一点——而是因为
           * 这些值正是那个条件读取的依据，过期的 `wrote` 会让条件依赖上一次尝试的
           * 数字。`providerUsage` 出于同类理由重置：顶层 usage 列必须描述文本进入
           * 回复的那一次尝试。
           */
          raw = "";
          finishKind = null;
          finishFailure = "";
          finishCode = "";
          endedWithoutFinish = true;
          providerUsage = null;

          /*
           * 请求在这里构建，不是继承而来。在这个 cordis 版本里 `next()` 无法携带
           * 改写过的请求（它的 `waterfall` 闭包捕获了原始参数），所以模拟自己调用
           * 服务。`owed` 已经被 `llm/stream` 监听器删除，这正是这次调用不会被误认
           * 成第二次接管的原因。
           */
          /*
           * 每次尝试的挂钟上限（§attempt timeout）。用户的信号被转发进这次尝试的
           * 控制器，让取消仍然立即中止，而停滞被本地约束。`timedOut` 在*我们的*
           * 计时器触发时锁存（不是用户的），因为这是重试闸门唯一被允许称作
           * `TIMEOUT` 的中止。
           */
          const attemptController = new AbortController();
          let timedOut = false;
          const timeoutHandle = setTimeout(() => {
            timedOut = true;
            attemptController.abort();
          }, Number.isFinite(deps.attemptTimeoutMs) ? deps.attemptTimeoutMs : ATTEMPT_TIMEOUT_MS);
          // 把用户的取消转发进我们的信号；没有就什么都不做。
          if (options?.signal) {
            if (options.signal.aborted === true) attemptController.abort();
            else options.signal.addEventListener("abort", () => attemptController.abort(), { once: true });
          }
          const request = {
            provider: options?.provider,
            model: options?.model,
            messages,
            signal: attemptController.signal,
            sessionId: options?.sessionId,
            /*
             * 硬上限，起名而不是继承（§4.2）。`dsh-llm` 读 `config.maxTokens`，
             * 缺失时回退到 `modelInfo.defaultMaxTokens`——「一场讨论可以跑多长」
             * 就是这样悄悄变成服务方的决定的。
             *
             * 它是每回合的预算（`turnBudget`），不是全局常量，且它跟随人数而不是
             * 提问的字数：上限只约束一场失控的讨论，别的什么都不决定——它从不
             * 裁决什么是好答案，而且必须高于任何普通场景，因为撞上它不会缩短
             * 一段发言，只会把最后一段切在半个词中间。
             */
            maxTokens: budget,
          };
          // 调用前先标记：监听器在 `llm.stream` 内部同步运行，必须认出这是我们
          // 自己的重入。
          simulationCalls.add(request);
          const stream = llm.stream(request);

          const parser = createSegmentParser({ names });
          const diagnostics = [];

          /**
           * 渲染一批解析器事件。
           *
           * `push()` 和 `flush()` 都可能产出台词，所以它们走同一扇门。这段逻辑
           * 曾经内联在 chunk 循环里，悄悄假设 `flush()` 只会用诊断事件应答——
           * 后来解析器学会了在流结束时交回最后一行，于是最后一位说话人的台词
           * 被当成诊断，再也没显示过。
           */
          const take = (events) => {
            for (const event of events) {
              if (event.type !== "segment") {
                diagnostics.push(event);
                continue;
              }
              /*
               * 内部黑话**记录在案，而不是删除**。设计里的检查是情境感知的，理由
               * 充分：在聊软件的对话里「运行」是寻常词，因为子串匹配就删掉一行
               * 等于改写某人的发言——这是协议明令禁止的事。M4 读这些诊断来调
               * 提示词；面向用户的通知只会是噪音。
               */
              const leaks = internalLeaks(event.text);
              if (leaks.length > 0) diagnostics.push({ type: "jargon", terms: leaks });
              spokenAll.push(event);
              const line = renderSegment(event);
              if (line === "") continue;
              emit(wrote === 0 ? line : `\n\n${line}`);
              wrote += 1;
              run.segments += 1;
            }
          };

          for await (const chunk of stream) {
            if (options?.signal?.aborted === true) break;
            /*
             * 我们的挂钟上限在流中途触发了。`timedOut` 把它和上面用户的取消区分开：
             * 停滞必须修复，不能被当作选择上报。流的 `finally` 会调用适配器的
             * `return()`，真正释放套接字的正是它。
             */
            if (timedOut === true) break;
            if (chunk?.type === "block-start" && chunk.blockType === "reasoning") {
              /*
               * 在索引 1 上打开我们自己的 reasoning 块。上游索引被刻意忽略：
               * 索引 0 属于文本块，而 `reasoning-delta` 必须指向一个恰好是这种
               * 类型的打开块，所以在这里重新持有它才让不变量成立。
               */
              if (!reasoningOpen) {
                reasoningOpen = true;
                reasoningText = "";
                queue.push({ type: "block-start", index: 1, blockType: "reasoning" });
              }
            } else if (chunk?.type === "reasoning-delta" && typeof chunk.text === "string") {
              if (reasoningOpen) {
                reasoningText += chunk.text;
                queue.push({ type: "reasoning-delta", index: 1, text: chunk.text });
              }
              // 没有打开块的 reasoning-delta 不归我们渲染；平台无法接受它，所以
              // 丢弃而不是错路由进台词文本。
            } else if (chunk?.type === "block-end" && chunk?.block?.type === "reasoning") {
              if (reasoningOpen) {
                queue.push({ type: "block-end", index: 1, block: { type: "reasoning", text: reasoningText } });
                reasoningOpen = false;
              }
            } else if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
              /*
               * 第一个 token 是「准备中」阶段的终点（C）。`attemptStartedAt` 到
               * 此刻的间隔就是预填充等待——黑屏区间——它被记录，而不是被猜测。
               * 从未拿到 token 的运行保持 `firstTokenMs: null`，这是诚实的
               * 「没有测量」。
               */
              if (run.firstTokenAt === 0) {
                run.firstTokenAt = Date.now();
                run.firstTokenMs = run.firstTokenAt - attemptStartedAt;
                run.phase = "streaming";
              }
              raw += chunk.text;
              take(parser.push(chunk.text));
            } else if (chunk?.type === "usage") {
              /*
               * 原样保留，最后转发一次。服务方可能在 `message_start` 和
               * `message_delta` 各报一次 usage；适配器把它们折叠成一个最终 chunk，
               * 所以这里出现第二个就是畸形流——保留第一个并写进诊断，而不是
               * 因此扔掉整场运行。
               */
              if (providerUsage === null) providerUsage = chunk.usage;
              else diagnostics.push({ type: "usage-duplicate" });
            } else if (chunk?.type === "finish") {
              finishKind = oneLine(chunk.reason?.kind) || "stop";
              /*
               * 服务方自己的话，如果它有的话。`dsh-llm` 把失败类别和消息放在终结
               * chunk 上；把它丢掉、只说「模型调用失败」，会让一次真实的
               * 鉴权/限流失败被当成代码回归白查一遍。
               */
              finishFailure = oneLine(chunk.reason?.failure?.message);
              finishCode = oneLine(chunk.reason?.failure?.code).toUpperCase();
              endedWithoutFinish = false;
              /*
               * 把适配器留在终结 chunk 处还没关的 reasoning 块关掉。有些适配器自己
               * 发 reasoning 的 `block-end`；不发的那些会让索引 1 一直开到流结束，
               * 而下面的 drain 后收尾器分不清「从没打开过」和「打开过但没关」。
               */
              if (reasoningOpen) {
                queue.push({ type: "block-end", index: 1, block: { type: "reasoning", text: reasoningText } });
                reasoningOpen = false;
              }
            }
          }
          // 这次尝试已（以某种方式）落定；上限计时器完成使命。
          clearTimeout(timeoutHandle);
          /*
           * 我们的挂钟上限触发了（§attempt timeout）。适配器把一次中止转成
           * `kind:"aborted"` 的 finish，其失败代码是它自己的（`ABORTED` 或类似），
           * 重试闸门不认识它。重新映射，让停滞被修复而不是被误读成取消：
           *
           *  - 屏幕上什么都没到（`wrote === 0 && raw === ""`）：这是黑屏停滞，
           *    正是重试闸门为之存在的形态。标记 `TIMEOUT`，让闸门重试。
           *  - 已经渲染过内容：收回是不可能的（队列只写一次），所以保留这段
           *    不完整的讨论，以被截断的 `stop` 收尾，而不是把说出的字扔掉。
           *    用户保住已说的部分，并得到一行说明它被切了的通知。
           */
          if (timedOut === true) {
            if (wrote === 0 && raw === "") {
              finishKind = "error";
              finishCode = "TIMEOUT";
              endedWithoutFinish = false;
            } else {
              finishKind = "stop";
              finishCode = "";
              endedWithoutFinish = false;
            }
            // 上限是一个*原因*，不是解析产物：记录下来，让「保留但被截断」的运行
            // 之后能和一次干净的 stop 区分开。
            diagnostics.push({ type: "attempt-timeout" });
          }
          /*
           * `truncated` 是调用方的知识，不是解析器的：只有 finish 原因能说明
           * 最后一行是被模型收尾的还是被上限切断的。解析器仍会把那行交回来——
           * 字是写出来了的——并记录它的结尾是一刀。
           */
          const truncated = finishKind === "max-tokens" || finishKind === "aborted" || options?.signal?.aborted === true;
          take(parser.flush({ truncated }));
          run.diagnostics = diagnostics.map((event) => event.type);

          /*
           * 回复可以不经 `max-tokens` 被切断。一条中途死掉的连接以 `stop` 收尾
           * （流关闭了，所以最后一个 chunk 是终结性的），而文本停在没闭合的引号
           * 或括号里。`isTailIncomplete` 是 finish 原因给不出的第二意见：`stop`
           * 说的是流关闭了，不是说模型选择收尾。
           *
           * `wrote > 0` 把散文回退的情况排除在外：没有分段就意味着没有讨论可以
           * 续，只有文本可以回显。长度下限防止一个混进单行回答的孤立 `「` 白白
           * 花掉一整个额外请求。
           */
          const tailCut = wrote > 0 && isTailIncomplete(raw);
          const resumableCut = tailCut === true && raw.length >= TAIL_RESUME_MIN_CHARS;

          /*
           * 在写终态**之前**决定。`settle` 只写一次，所以即将重试的尝试绝不能
           * 碰到它：一场被标成 `error` 的运行，之后不可能再报告成第二次尝试
           * 产出的那个成功。
           */
          const worthRetrying =
            attempt < maxAttempts &&
            wrote === 0 &&
            raw === "" &&
            options?.signal?.aborted !== true &&
            retryable.has(finishCode);
          /*
           * 在分支**之前**记录，这样一次失败的尝试也会被写下，尽管它的重试即将把
           * 它在回复里的一切痕迹抹掉。只看见幸存尝试的账本，会让一次抖动的运行
           * 和一次干净的运行在成本上一模一样。
           */
          run.requests.push({
            requestId: attemptRequestId,
            attempt,
            /*
             * 这是运行内的第几个逻辑请求：0 是用户要的那个回合，1 起是续写。
             * `reason` 说明它为什么被发出（`initial` / `ceiling`）——没有它，
             * 一场花了三个请求的运行看起来就像重试风暴。
             */
            round,
            reason: roundReason,
            /** 注入在请求前面的团队记忆字符数（0 = 关闭）。 */
            memChars: memBlock.length,
            durationMs: Date.now() - attemptStartedAt,
            segments: wrote - segmentsBefore,
            rawChars: raw.length,
            finishKind,
            failureCode: finishCode === "" ? null : finishCode,
            retried: worthRetrying === true,
            usageSource: providerUsage === null ? "absent" : "provider",
            inputTokens: providerUsage?.inputTokens ?? null,
            outputTokens: providerUsage?.outputTokens ?? null,
            cacheReadTokens: providerUsage?.cacheReadTokens ?? null,
            cacheWriteTokens: providerUsage?.cacheWriteTokens ?? null,
            totalTokens: providerUsage?.totalTokens ?? null,
          });
          if (worthRetrying) {
            const wait = delays[attempt - 1] ?? delays[delays.length - 1];
            warn(`团队第 ${attempt} 次请求失败（${finishCode}），${wait}ms 后重试。`);
            await new Promise((resolve) => setTimeout(resolve, wait));
            /*
             * 用户可能在退避期间取消。在被中止的信号下继续重试，等于发出一个
             * 结果注定被扔掉的请求，还会把一场其实是由请求者本人叫停的运行
             * 报告成 `error`。
             */
            if (options?.signal?.aborted === true) {
              settle("cancelled");
              append("! 这一轮讨论已取消。");
              break;
            }
            continue;
          }

          const structural = diagnostics.filter((event) => event.type === "unknown").length;
          const stray = diagnostics.filter((event) => event.type === "stray").length;
          /*
           * 落在协议之外的散文有多少，按字符计。按字符数而不是只按事件数，因为
           * 一篇 400 字的短文和一条 12 字的舞台指示都是 `stray`，只有前一种才
           * 说明模型不再遵守格式。
           */
          const strayChars = diagnostics.reduce(
            (total, event) => (event.type === "stray" ? total + oneLine(event.text).length : total),
            0,
          );
          const verdict = simulationStatus({
            finishKind,
            aborted: options?.signal?.aborted === true,
            segments: wrote,
            structural,
            stray,
            strayChars,
            endedWithoutFinish,
            tailIncomplete: tailCut,
          });

          /*
           * ## 在落定之前决定：再来一条回复，还是就此结束？
           *
           * `settle` 只写一次，所以续写请求必须发生在它*之前*——一场已经说过
           * `limit_reached` 的运行，之后绝不可能再报告续写产出的完整讨论。
           *
           * 再要一次的理由只有一个：
           *
           *   - `ceiling`——回复停在了技术上限。到切断处为止的字是我们的，
           *     所以续写引用它们，请模型从下一位说话人接着说。
           *
           * 有人整场没开口 **不再** 是再来一次的理由：发言策略是「被点名的人
           * 先接，其他人可沉默、也可在该插话时插一句」，所以沉默是合法的表达，
           * 不是缺失。`silent` 仍然记进账本供面板显示，但绝不追着补。
           *
           * 两者都受 `SIM_MAX_CONTINUATIONS` 约束。补齐额外最多试一次：如果第二次
           * 请求仍然没能让 C 开口，再来一次也不会，装作能行只是花一分钟生产
           * 同样的沉默。
           */
          const missing = silentMembers(names, spokenAll);
          const askable =
            options?.signal?.aborted !== true &&
            continuations < SIM_MAX_CONTINUATIONS &&
            /*
             * 停滞不是简短的回答。`timedOut` 把 finish 改写成 `stop` 以保留文本，
             * 这让一场被切的运行*看起来*干净——然后缺失的声音就会被读成选择、
             * 被另一个请求追着要。那不是选择，是套接字，而刚刚超时的那个请求
             * 不该是再去要的那个。
             *
             * 例外是*可续的切断*：套接字在半句话上死掉，但屏幕上已有文本。让一个
             * 新请求从接缝处接着说正是修复，而新尝试有自己的挂钟上限，停滞的那次
             * 不会被复活。
             */
            (timedOut !== true || resumableCut === true) &&
            verdict !== "error" &&
            verdict !== "cancelled";
          let followUp = "";
          if (askable === true && verdict === "limit_reached" && raw !== "") {
            /*
             * `raw !== ""` 很重要：一个什么都没写出来的 `max-tokens` finish，
             * 意味着模型把整个上限花在了推理或空回复上。没有接缝可以续，用同样的
             * 请求再问一次只会再花一个上限，到达同样的空无。
             */
            followUp = "ceiling";
          } else if (askable === true && resumableCut === true) {
            /*
             * 连接在半句话上死掉了。即使这里 `ceiling` 也是正确的提示词：它已经
             * 告诉模型最后一行被切了，在同一个说话人名下重新打开并把它说完，
             * 与 token 切断需要的指示是同一条。这个分支的 `verdict` 是
             * `incomplete`（尾部被切，不是解析失败），所以只会被切断续写触发。
             */
            followUp = "ceiling";
          }
          if (followUp !== "") {
            continuations += 1;
            /*
             * 原始文本，协议标记也一起——不是解析分段的重新渲染。那是模型写的，
             * 它就应该读到那个，包括最后半句没写完的行：被要求「接着说」的续写
             * 需要看到切断发生在哪里，而重新渲染会悄悄修平它必须接着的那个接缝。
             */
            transcript = transcript === "" ? raw : `${transcript}\n${raw}`;
            run.continuations = continuations;
            messages = simulationMessages({
              prompt,
              task: asked.task,
              /*
               * 记忆乘这次运行的每一个请求，续写也不例外：一次丢掉记忆的上限重试
               * 会让模型在回合中途「忘记」前几轮——记忆正是为防这个失败而存在的，
               * 又在一次次续写后被重新引入。
               */
              memory: memoryText,
              transcript,
              /*
               * 续写仍然带上缺失的名字，但只作**可选建议**：收尾前若真轮到她们
               * 就顺势给一句，不为凑齐而硬塞（见 `simulationMessages` 里
               * `reason === "ceiling"` 那段）。在这里传空列表，会把「谁还没开口」
               * 这条本来便宜的提示一起丢掉。
               */
              silent: missing,
              reason: followUp,
            });
            round += 1;
            roundReason = followUp;
            again = true;
            break;
          }

          /*
           * 运行在这里是终态——上面的每条续写路径都 `continue` 了。冻结房间真正
           * 说过的话（跨续写累积），让 `finally` 能把它交给记忆。
           */
          finalRaw = transcript === "" ? raw : `${transcript}\n${raw}`;
          const status = settle(verdict);
          /*
           * 覆盖率在**每一个**终态上测量，而不只在干净结束时。旧的算法把它算在
           * `status === "converged"` 里面，让账本在最需要它的那些行上变得含糊：
           * 一场被截断的运行记录 `silent: []`，读者分不清「没人缺席」和「没人
           * 测量」。建立在这个字段上的覆盖率指标会悄悄把每次截断都算成全覆盖。
           *
           * 测量与告知是两件事，现在彻底分开：`silent` 每个终态都写，而**正文
           * 从不点名**。切断之后缺失的声音更可能是上限而不是选择；正常结束时它
           * 又只是选择——两种都不该被读成故障，所以只有账本回答这个问题。
           */
          run.silent = silentMembers(names, spokenAll);

          /*
           * 一切正常的回复不多说一个字。
           *
           * 页脚（`〔团队「X」 · 2 人〕`）曾经给每条回复收尾。它在那里是为了证明
           * 运行结束了，而一次真实运行展示了代价：五行的干净对话以一行没人要的
           * 机器注脚结束。运行记录已经带着团队、人数、状态和谁沉默了，所以现在
           * 回复就是对话本身，别无其他——只在真的出了问题时多一行，且只有一行。
           */
          if (status === "error") {
            append(`! 这一轮团队没跑起来：${explainFailure(finishCode, finishFailure, run.requests.length)}`);
          } else if (status === "cancelled") {
            append("! 这一轮讨论已取消。");
          } else {
            const prose = raw.trim();
            if (wrote === 0 && prose !== "") {
              /*
               * 模型答了，只是没按协议答。打上标签原样回显是唯一诚实的选项：
               * 渲染成 `名字：台词` 是伪造分段，丢掉则丢掉一个真实的回答。
               * 设计禁止前者，后者正是这场运行的存在要消灭的东西（§3.6）。
               */
              append(prose.slice(0, PROSE_FALLBACK_LIMIT));
              append("! 这段不是按分段协议写的，原文照上。");
            } else if (wrote === 0) {
              append(SIM_SILENCE);
            }
            if (status === "limit_reached") {
              /*
               * 说清楚上限是路的尽头，还是仅仅一条请求的尽头。两次续写之后的
               * 「截断」意味着讨论真的长出了预算；零次续写的「截断」意味着续写
               * 路径根本没跑，这是值得看见的 bug，不是值得抹平的事。
               */
              append(
                continuations > 0
                  ? `! 这一轮到了长度上限（已自动续写 ${continuations} 次），后面被截断了。`
                  : "! 这一轮到了长度上限，后面被截断了。",
              );
            } else if (status === "incomplete" && wrote > 0 && tailCut !== true) {
              /*
               * 是解析失败，不是切断：文本在那里，但协议没被遵守。半句被切的
               * 情况在下面另行上报，用那行真正描述它的文案。
               */
              append("! 产物没有完整解析，已保留可读部分。");
            } else if (status === "incomplete" && prose === "") {
              append("! 这一轮没有拿到完整输出。");
            }
            /*
             * 已经产出过文本的挂钟停滞在这里收尾：不完整的讨论被保留，这一行说明
             * 它为什么停下。与 `limit_reached`（模型撞了 token 上限）不同，也与
             * 解析失败不同——字没问题，是连接死了。
             */
            if ((timedOut === true || tailCut === true) && wrote > 0) {
              /*
               * 回复停在半途，而续写预算已经花完（或者这是一场续写请求也停滞了的
               * 停滞）。字被保留，这一行说明为什么停下。
               *
               * 两种形态会到这里：一次挂钟停滞（套接字死了，最后一行闭合与否都
               * 有可能——`tailCut` 只是症状之一），以及一次仍然停在未闭合引号里的
               * 干净 `stop`。连接的情况点明是连接，因为当用户在决定要不要重试时，
               * 这才是更有用的诊断。
               */
              append(
                timedOut === true
                  ? "! 这一轮因为连接卡住被截断了，已保留说出的部分。"
                  : "! 这一轮输出被中途截断了，已保留说出的部分。",
              );
            }
            /*
             * 谁没开口 **不再** 说给用户听：发言策略是「被点名的人先接，其他人
             * 可沉默、也可在该插话时插一句」，所以一句「某某没开口」会把正常
             * 的选择读成故障。账本仍记 `silent`，面板能查，正文不打扰。
             */
          }
          break;
        }
        /*
         * 内层循环只有两条离开路径：请求了续写（`again`），或运行结束。
         * `continue` 带着新的 `messages` 回到外层循环；其他任何情况都结束运行，
         * 让 `finally` 写下它的那一行账本。
         */
          if (again === true) continue;
          break;
        }
      } catch (error) {
        // 一场连尝试都没能开始的讨论，仍然是用户必须看到的答案。这条流*就是*
        // 回复，所以沉默是这条路径唯一要消灭的结果。
        warn(`接管这一轮失败：${error?.message ?? error}`);
        settle(options?.signal?.aborted === true ? "cancelled" : "error");
        emit(`! 这一轮团队没跑起来：${oneLine(error?.message) || "未知错误"}`);
      } finally {
        /*
         * 账本行，每次运行一条，在终态决定之后、usage chunk（如果有）被看到之后。
         *
         * 写在这里而不是各个出口路径，让失败和取消与正常结束落在同一个地方：
         * 一场从未到达服务方的运行，恰恰是成本基线需要的那一行；以「什么都没花」
         * 为由丢掉它，正是无声回归藏身的方式。
         */
        const usage = providerUsage;
        /*
         * 关队列排在**第一**。此刻回复已经写完，下面任何东西都不许让流继续开着——
         * 一本会抛异常的账本只配付出一行日志的代价，绝不能挂死一个回合。
         */
        queue.close();
        const endedAt = run.finishedAt || Date.now();
        recordRun({
          v: 1,
          runId: run.runId,
          requestId: run.requestId,
          sessionId: run.sessionId,
          taskId: run.taskId,
          strategy: run.strategy,
          provider: run.provider,
          model: run.model,
          team: run.team,
          size: run.size,
          segments: run.segments,
          status: run.terminal === true ? run.status : "error",
          finishReason: finishKind,
          /*
           * 这一行实际描述的服务方请求数。
           *
           * 1 是正常情况。更大的数字不是细节：下面的 usage 列来自**最后**一次
           * 尝试，所以对比成本的读者必须知道更早的一次尝试付了钱却没被计入。
           * 那最后一次尝试的失败类别也在这里，理由相同——日志里的一句
           * `Request timed out.` 只有连同催生重试决策的类别一起写下才可诊断。
           *
           * 从 `requests` 计数而不是从循环计数器：有续写在场时，计数器对每个逻辑
           * 请求都从 1 重新开始，`run.attempts` 就只描述最后一次。
           */
          attempts: run.requests.length,
          /*
           * 为让讨论继续下去而发的额外请求（上限或补齐）。与 `attempts` 分开，
           * 后者数的是*同一个*请求的尝试次数：续写是新文本，重试是同一文本
           * 再要一遍。
           */
          continuations: run.continuations,
          /*
           * 这次运行发出的每一个真实请求，各带自己的 usage、时长和失败类别。
           * 上面的 `attempts` 只是它的长度；让钱可追溯的是这个数组，因为上面的
           * 四个 `*Tokens` 列只来自**最后**一次尝试。
           */
          requests: run.requests,
          failureCode: finishCode === "" ? null : finishCode,
          /*
           * 请求的结构与规模，按字符计。永远在场——即使服务方什么都没报——因为
           * 它是在这里测量的，不是由服务方。
           */
          requestShape: run.requestShape,
          promptChars: run.promptChars,
          taskChars: run.taskChars,
          /** 本次运行注入的团队记忆字符数（0 = 记忆关闭）。 */
          memChars: typeof run.memChars === "number" ? run.memChars : 0,
          /*
           * 规模类别与它对应的上限（A + B）。`scale` 是 `classifyTurn` 的判定；
           * `maxTokens` 是真正放到请求上的数字。它们一起回答「这条回复短，是被
           * 要求短的，还是撞了上限」——裸的输出 token 数回答不了这个问题。
           */
          scale: run.scale,
          maxTokens: run.maxTokens,
          /*
           * 两态进展事实（C）：回复为第一个 token 等了多久，以及当时处于哪个阶段。
           * `firstTokenMs: null` 表示 token 从未到来（失败或被取消的运行）。
           * 这是测量出的延迟，不是进度条。
           */
          phase: run.phase,
          firstTokenMs: run.firstTokenMs,
          /*
           * 冻结的配置：只有哈希和长度，永远没有正文。
           *
           * 正是这个字段让一行记录成为可复用的证据。`team: "x"` 加 `size: 3`
           * 描述一个两场不同讨论可以共享的形状；某位成员的 `bodyHash` 不是。
           * 复现一次运行，意味着*现在*向目录要文本并做比较——`exportSnapshot`
           * 做的正是这件事，并把每一个此后变过的成员标注出来。
           */
          config: run.config,
          startedAt: run.startedAt,
          finishedAt: endedAt,
          durationMs: endedAt - run.startedAt,
          /*
           * 只有两个值。"provider" 表示下面的数字来自服务方；"absent" 表示什么
           * 都没测到，每个 token 字段都是 `null`。刻意没有 "estimated"：这一列里
           * 的猜测之后将与测量无法区分，而这正是这本账本存在的意义所要阻止的事。
           */
          usageSource: usage === null ? "absent" : "provider",
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          cacheReadTokens: usage?.cacheReadTokens ?? null,
          cacheWriteTokens: usage?.cacheWriteTokens ?? null,
          totalTokens: usage?.totalTokens ?? null,
          diagnostics: run.diagnostics,
        });
        /*
         * `midDiscussion` **不**在这里清除。工作循环随模型流结束而结束，但外层
         * 生成器可能还在排空缓冲的 chunk；现在清除会开出一扇窗口，第二个触发
         * 会从窗口漏下去，变成一次真实的模型调用。回复真正结束后，外层的
         * `finally` 才清除它。
         */
        /*
         * 记忆记录，放在最后。什么都没说的回合什么也不记（`finalRaw === ""` 覆盖
         * 无服务、空回复以及退避期间的取消）；半句被切的回合仍然在屏幕上发生过，
         * 所以按它的原样被记住——包括那一切断。逐出后可能欠下的折叠在下一回合的
         * *开头*结算（那里的 `foldSummary`），让这个 finally 里没有模型调用。
         */
        if (mem !== null && finalRaw !== "") {
          const evicted = appendRound(
            mem,
            { input: typeof asked.task === "string" ? asked.task : "", output: finalRaw },
            Number.isFinite(deps.memoryWindowChars) ? deps.memoryWindowChars : MEMORY_WINDOW_CHARS,
          );
          if (evicted !== "") {
            mem.backlog.push(evicted);
            trimBacklog(mem);
          }
          mem.updatedAt = Date.now();
          writeMemory(deps.memoryDir, memKey, mem).catch((error) => {
            warn(`写团队记忆失败：${error?.message ?? error}`);
          });
        }
      }
    })();
    // `work` 不可能 reject——上面每条路径要么被捕获要么在 `finally` 里——但这个
    // promise 仍被钉住：`drain()` 才是决定这条流何时结束的东西，一次漂浮的
    // rejection 会无人看见。
    work.catch(() => {});
    try {
      for await (const chunk of queue.drain()) yield chunk;
      /*
       * 块在终结 finish 之前关闭，且闭合块的文本必须是整条回复：两者都由不变量
       * 检查。
       *
       * `usage` 走在两者**之间**，至多一次，且只在服务方真的上报时。不变量允许它
       * 在 `finish` 之前出现至多一次；在这里伪造一个 `{inputTokens: 0}` 比什么都不
       * 发更糟，因为平台会为一个它从未测量过的回合记下一个看起来测量过的零。
       */
      yield { type: "block-end", index: 0, block: { type: "text", text: full } };
      if (providerUsage !== null) yield { type: "usage", usage: providerUsage };
      yield { type: "finish", reason: { kind: "stop" } };
    } finally {
      midDiscussion.delete(sessionId);
    }
  }

  /*
   * 接管，分两半。
   *
   * ## 前一半——`agent/pre-step`：只做判断，别的什么都不做
   *
   * `agent/pre-step` 是唯一在 `step/start` 之前运行的扩展点，而且它是一个瀑布：
   * 不调用 `next()` 就返回的监听器会短路它，`preStep` 随后读到 `{kind:"reject"}`。
   * 这个钩子曾经就是这样回答回合的，也是它为什么无法可见地回答——被拒绝的 step
   * 永远不会打开，于是在它内部不存在合法的回复。
   *
   * 所以拒绝没有了。这一半只做判断，把判断记进 {@link owed}，然后放行 step；
   * 回复发生在模型调用处。判断本身没变，仍然要求全部条件：step 1、真正的用户
   * 消息、不是被委派子会话的会话、以及一支真的解析出至少一名代表的团队。每个
   * 不确定的情况都返回 `next()`，因为放行一条消息的代价是一个协调者回合，而错误
   * 接管的代价是一个没人看得见的答案。
   */
  ctx.on("agent/pre-step", async (payload, next) => {
    let asked = null;
    try {
      asked = takeoverFor(payload);
    } catch (error) {
      warn(`判定要不要接管失败，这一轮交给主 Agent：${error?.message ?? error}`);
      return next();
    }
    if (asked === null) {
      // 这个会话不欠什么。留下一条过期条目，会让团队去回答一个它从未认领的 step。
      owed.delete(oneLine(payload?.agent?.session?.id));
      return next();
    }
    if (midDiscussion.has(asked.sessionId)) return next();
    owed.set(asked.sessionId, {
      ...asked,
      team: teamNameFor(asked.sessionId, asked.agent) ?? "",
      at: Date.now(),
    });
    return next();
  });

  /*
   * ## 后一半——`llm/stream`：插件被允许成为模型的地方
   *
   * 一个监听器处理进程里的每一次模型调用，所以它做的第一件事是回答「这次调用
   * 是不是欠团队的？」。`options.sessionId` 是循环为其构建请求的那个会话，恰好
   * 就是 `pre-step` 为判断所用的那个身份——而条目在讨论开始前就被删除，所以子
   * 会话自己的模型调用（同一个瀑布、它们自己的会话 id）径直透传给服务方。
   *
   * 一切不被认出的、过期的、或已经在讨论中的东西都返回 `next()`，那是寻常路径：
   * 真正的服务方来答。
   *
   * `global: true` 不是可选项，也不是扩大监听范围。一次 dispatch 只保留上下文与
   * 发出服务的 isolate 相共享的监听器（`cordis` 的 `dispatch()`：
   * `hook.global || filter.call(thisArg, hook.ctx)`），所以从插件注册的普通监听器
   * 可能被某个服务自己的瀑布过滤掉，取决于那个服务挂在哪里。平台自己的
   * `dsh-session-title` 正是因此以 `{ global: true, prepend: true }` 在这里监听。
   * 这个监听器*不* prepend，是刻意的：流不变量是 prepend 的，它包裹我们的返回值
   * 并做校验。
   *
   * `prepend: false` 也理顺了责任的顺序：我们的监听器在不变量之后看到请求，
   * 并且可以返回自己的流而不调用 `next()`。
   */
  ctx.on("llm/stream", (options, next) => {
    /*
     * ## 辅助调用不是本回合的模型调用
     *
     * 这个监听器看得见进程里的**每一次** `llm.stream`，而一个会话不止一次调用：
     * 会话标题生成器和压缩器都会带着 sessionId 调模型，指向它们正在总结的那个
     * 会话。平台用 `purpose` 标记那些调用（`"session-title"`、`"compaction"`）；
     * agent 循环自己的请求——由 `dsh-agent-loop` 的 `buildRequest` 构建为
     * `{...config, messages, toolHistory, tools?, sessionId, signal}`——没有这个
     * 字段。
     *
     * 先跳过它们不是防御性的整洁。一次真实运行把会话标题成了**「! 这条消息已经有
     * 一场讨论在进行，没有重复生成。」**：标题调用在回合自己的请求之后四毫秒到达，
     * 发现一场讨论正在进行，就把那句话当作它的模型答案收下了。这道防线也必须放在
     * `owed.get` 之前——在标题调用上消费掉认领，回合本身就会交给 `next()`，让根
     * Agent 去回答一个欠团队的问题。
     */
    if (oneLine(options?.purpose) !== "") return next();
    const sessionId = oneLine(options?.sessionId);
    if (sessionId === "") return next();
    /*
     * 我们自己的重入调用。`discussionStream` 调用 `llm.stream` 来发出那一次模拟
     * 请求；瀑布会再看见它，不这样做的话它要么递归，要么被误认成重复触发。
     */
    if (simulationCalls.has(options)) {
      simulationCalls.delete(options);
      return next();
    }
    const asked = owed.get(sessionId);
    if (asked === undefined) {
      /*
       * 没有被认领的回合。如果一场讨论已在进行，这就是同一条消息的第二次触发
       * ——拒绝它正是幂等的意义所在。放行给 `next()` 会让根模型再答一次，即使
       * 没有创建第二场运行，那也是一条重复的回复。
       */
      if (midDiscussion.has(sessionId)) {
        return fixedStream("! 这条消息已经有一场讨论在进行，没有重复生成。");
      }
      return next();
    }
    owed.delete(sessionId);
    if (Date.now() - Number(asked.at) > OWED_TTL_MS) return next();
    if (midDiscussion.has(sessionId)) {
      return fixedStream("! 这条消息已经有一场讨论在进行，没有重复生成。");
    }
    return discussionStream(asked, options);
  }, { global: true });

  /* ------------------------------------------------------------ 命令 */

  ctx.commands.register({
    name: "waifu-team",
    description: "把这次会话交给一个团队：看有哪些队、选一个。",
    input: { hint: "队名" },
    /*
     * 参数是 `rawInput`，而且没有第二种拼法。
     *
     * `dsh-commands` 的 `execute` 把调用构建为
     * `{ commandId, agent, rawInput, attachments, signal }`——唯一携带用户在命令名
     * 之后所打内容的字段就是 `rawInput`。处理函数曾经从它上面解构 `args`，而它在
     * 每一次调用上都是 `undefined`，于是 `/waifu-team 素晴三人` 落进「没有参数」
     * 分支，用用法说明应答——从来没有真正选上。
     *
     * 是验证过的，不是推断的：一个探针启动了真实的树，列出注册表（`waifu-team`
     * 在场），并跑了三种拼法——三种都返回同样的用法文本。修复之后
     * `/waifu-team <name>` 会围绕那个名字作答。
     *
     * 已经没有「退出」拼法了：离开一支团队用 `/waifu-change`（切回单人设定）或
     * `/waifu-reset`（回到会话自己的人设），一个选队器只应该选队。
     */
    handler: async ({ agent, rawInput }) => {
      const sessionId = oneLine(agent?.session?.id);
      if (sessionId === "") return { kind: "error", text: "这个命令只能在会话里用。" };
      const problem = storeProblem(store.current);
      if (problem !== null) return { kind: "error", text: problem };
      const wanted = oneLine(rawInput);
      const names = store.current.teams.map((team) => team.name);
      if (wanted === "") {
        const now = teamNameFor(sessionId, agent);
        const head = now === undefined ? "这次会话现在是单人模式。" : `这次会话现在用的是团队「${now}」。`;
        const groups = availableGroups(rosterRows());
        const body =
          names.length === 0
            ? `还没有团队。到 设置 → waifu-agents → 团队 里新建一支（可以按单人挑，也可以把某个组整个加进来）。这个目录里已有这些组名：${groups.join(" / ") || "（一个组标签都没有）"}。`
            : `可选：${names.join(" / ")}。`;
        return { kind: "success", text: `${head}\n${body}\n用法：/waifu-team <队名> 选队；想回到单人人设，用 /waifu-change 或 /waifu-reset。` };
      }
      const team = findTeam(store.current, wanted);
      if (team === null) {
        return { kind: "error", text: `没有叫「${wanted}」的团队。现有的：${names.join(" / ") || "（一个都没有）"}。` };
      }
      bound.set(sessionId, team.name);
      /*
       * 对账基准：此刻标签停在哪。移动标签发生在下面，见 `moveChipToTeam`。
       * 这张表后面还会被改成落点（那是它该记的），所以「进队之前是谁」必须
       * 在此之前单独记一份，见 `rememberPrevChip`。
       */
      boundChip.set(sessionId, oneLine(deps.chipOf?.(agent)));
      rememberPrevChip(sessionId, agent);
      off.delete(sessionId);
      const state = ensureTeam(agent);
      if (state.error !== undefined) {
        bound.delete(sessionId);
        boundChip.delete(sessionId);
        prevChip.delete(sessionId);
        return { kind: "error", text: `没切成团队模式：${state.error}` };
      }
      if (state.mode !== "team") {
        return {
          kind: "success",
          text: [
            `已选团队「${team.name}」，但这次按单人模式执行。`,
            ...(state.notices ?? []).map((line) => `· ${line}`),
            "想让她俩真开口，先让这个队至少解析出 2 名成员。",
          ].join("\n"),
        };
      }
      /*
       * 把会话 chip 移到所选团队的预设上。只有绑定的话只改变模型被告知的内容；
       * 没有这一步，对话上方的标签会一直叫着会话出生时的团队，于是从
       * 素晴三人 -> 龙女仆 看起来像什么都没发生。
       *
       * 挪不挪得动是两件事，所以结果要接住：挪不动时标签留在原处（很可能
       * 是用户刚换的那位人设），`/waifu-current` 会照着标签念出她的名字，
       * 于是一场由团队回答的对话看起来像单人。命令必须把这件事说出来，
       * 不能把它留成一个只有日志知道的失败。
       */
      const moved = (await deps.moveChipToTeam?.(agent, team.name)) === true;
      /* 对账基准改成**落点**：绑定记的是「标签此刻在哪」，不是「它本来该在
       * 哪」。移动成功记团队预设，失败记旧名字，两种情况下下一轮都不会被
       * 误判成「用户换了人」。 */
      boundChip.set(sessionId, oneLine(deps.chipOf?.(agent)));
      const chipAfter = oneLine(deps.chipOf?.(agent));
      const resolved = resolveFor(sessionId, agent);
      const roster = resolved?.ok === true ? resolved.members.map((row) => row.name).join("、") : "";
      return {
        kind: "success",
        text: [
          `已切到团队模式：${team.name}。`,
          `本次成员：${roster}。`,
          "下一条消息由她们一起回答",
          ...(moved
            ? []
            : [
                `· 对话上方的标签没挪到团队预设上，还写着「${chipAfter === "" ? "（没有预设）" : chipAfter}」。` +
                  "回答你的是上面这些人，只是标签名不副实——重启 DSH 后这支队会从这个会话掉线（绑定只活在运行期）。",
              ]),
          ...(state.notices ?? []).map((line) => `· ${line}`),
        ].join("\n"),
      };
    },
  });

  return {
    /*
     * `stage(agent)` 曾经住在这里。它解析团队并返回人设应追加的文本——v3 里永远
     * 是 `""`——人设变量提供器在每次组装、为每个会话调用它。
     *
     * 那让每个会话的每个 step 都为一条没人渲染的字符串付一次完整的团队解析
     * （读存储、扫人设目录、解析成员）：平台无论模板是否引用，都会解析每个变量。
     * 它仅有的另一个产物是一行日志，而用户真正能看见团队降级的两个地方——绑定
     * 时的 `/waifu-team`，以及通过 `stateOf` 的面板——本来就会报告。
     *
     * 移除它就是修复本身，不是顺手清理：对团队会话，人设提供器现在在碰任何文件
     * 之前就返回。
     */
    /**
     * 这个 agent **此刻**是否以团队运行——那个轻量问题。
     *
     * 与 `ensureTeam` 不同，它什么都不解析、不从磁盘读任何东西：就是 `isDelegated`
     * 加 `teamNameFor`，也就是两次 Map/Set 查找加一次 `teamForPreset` 读取。
     * `index.js` 的人设变量提供器在每次组装、每个会话上都调用它（平台无条件解析
     * 每个变量），所以它必须保持这个廉价度——「闸门零 IO」规则的全部意义。
     *
     * 一个出生在团队预设上、但后来 `/waifu-team off` 过的会话在这里回答 `false`，
     * 因为会话一旦进入 `off` 集合，`teamNameFor` 就返回 `undefined`。恰恰是这个
     * 差别让提供器可以停止给一个已离开团队模式的会话服务空人设。
     *
     * @param {object} agent
     * @returns {boolean}
     */
    isTeamSession(agent) {
      if (isDelegated(agent)) return false;
      const sessionId = oneLine(agent?.session?.id);
      if (sessionId === "") return false;
      return teamNameFor(sessionId, agent) !== undefined;
    },

    /**
     * 显式绑定到这个会话的团队——即 `/waifu-team` 的覆盖，**不是**会话出生时的
     * 团队。没有显式绑定时为 `undefined`。
     *
     * `/waifu-reset` 需要它，因为团队绑定同样是一种覆盖：必须把它清掉，否则
     * 「本来就没有覆盖」是在撒谎，下一回合仍按绑定的团队运行。
     */
    boundNameOf(sessionId) {
      const id = oneLine(sessionId);
      return id !== "" && bound.has(id) ? bound.get(id) : undefined;
    },

    /**
     * 摘掉显式的团队覆盖（以及任何「off」拒绝），返回原来的值让调用方可以汇报。
     * chip 的恢复归宿主管——这里只碰内存里的两级梯子。
     */
    unbind(sessionId) {
      const id = oneLine(sessionId);
      if (id === "") return { bound: undefined, off: false, chip: undefined };
      const had = bound.has(id) ? bound.get(id) : undefined;
      /*
       * 顺手交出「进队之前这一场在跑的那位单人设」。团队绑定不写覆盖记录，
       * 所以 `overrides.json` 里没有 `resting` 可退回；少了这个值，退出团队
       * 时只能回落到会话头（= 出生那一刻的全局默认），于是「回到我进队之前
       * 那位」会变成「回到一个我从没选过的人」。
       *
       * 交的是 `prevChip` 而不是 `boundChip`：后者是对账基准，`/waifu-team`
       * 挪完标签后会把它改成团队预设本身，拿它当落点会让 `/waifu-reset`
       * 把「一个团队」当成「一位人设」恢复回去——团队当场复活，而命令报的
       * 是「已清掉团队绑定」。
       */
      const chip = prevChip.get(id);
      const wasOff = off.delete(id);
      bound.delete(id);
      boundChip.delete(id);
      prevChip.delete(id);
      return { bound: had, off: wasOff, chip };
    },

    /**
     * 明确把这一场钉在「不在任何团队上」。
     *
     * 只在一种情况下需要：调用方已经摘掉绑定，却没有可恢复的单人落点，标签
     * 于是仍停在团队预设上。`teamNameFor` 在没有绑定时会回落到「出生时带的
     * 团队预设」，所以不补这一下，下一轮团队就从这个标签上自己活过来。
     */
    holdOff(sessionId) {
      const id = oneLine(sessionId);
      if (id === "") return false;
      bound.delete(id);
      boundChip.delete(id);
      prevChip.delete(id);
      off.add(id);
      return true;
    },

    /** 不经过命令直接把团队绑到会话（面板用）。 */
    bind(sessionId, name) {
      if (oneLine(sessionId) === "") return { ok: false, error: "没有会话 id。" };
      if (oneLine(name) === "") {
        bound.delete(sessionId);
        boundChip.delete(sessionId);
        prevChip.delete(sessionId);
        off.add(sessionId);
        return { ok: true, mode: "off", text: "", notices: [] };
      }
      const team = findTeam(store.current, name);
      if (team === null) return { ok: false, error: `没有叫「${name}」的团队。` };
      bound.set(sessionId, team.name);
      /*
       * 记下此刻标签停在哪——绑定可以先于标签移动，对账时要以「标签是否
       * 变过」为准，不能要求它一开始就是团队预设。移动之前另记一份「进队
       * 之前那位单人」，见 `rememberPrevChip`：下面这行之后它会被落点覆盖。
       */
      const before = deps.liveAgentFor(sessionId);
      boundChip.set(sessionId, oneLine(deps.chipOf?.(before)));
      rememberPrevChip(sessionId, before);
      off.delete(sessionId);
      const agent = deps.liveAgentFor(sessionId);
      if (agent === undefined) {
        return { ok: true, mode: "off", text: "", notices: ["会话不在线，等它下次组装时再生效。"] };
      }
      const state = ensureTeam(agent);
      if (state.mode === "team") deps.moveChipToTeam?.(agent, team.name);
      return { ok: true, ...state };
    },
    /** 会话当前绑着什么，供 `/waifu-current` 和面板使用。 */
    stateOf(sessionId) {
      const agent = deps.liveAgentFor(sessionId);
      const name = teamNameFor(sessionId, agent);
      if (name === undefined) return { mode: "off", team: null, text: "", notices: [] };
      if (agent === undefined) return { mode: "unknown", team: name, text: "", notices: [] };
      return { ...ensureTeam(agent), team: name };
    },
    /**
     * 一支存储的团队*此刻*解析成什么，与任何会话无关——面板的预览。
     *
     * 刻意用 `coordinator: null` 解析而不是猜一个：「谁是协调者」是运行中会话的
     * 属性，而面板看的是文件。没有协调者时 `inTeam` 为 false，于是每个成员都
     * 显示为「会被委派给的人」，这正是选人器想问的答案。
     */
    preview(name) {
      const wanted = oneLine(name);
      const team = findTeam(store.current, wanted);
      if (team === null) return { ok: false, error: `没有叫「${wanted}」的团队。` };
      let rows = [];
      try {
        rows = rosterRows();
      } catch {
        rows = [];
      }
      try {
        return {
          ...resolveTeam({ team, roster: rows, coordinator: null, store: store.current }),
          team,
        };
      } catch (error) {
        return { ok: false, error: oneLine(error?.message) || "解析这个团队时出错了。" };
      }
    },
    /*
     * 冻结的配置，供不是一次运行的调用方使用。
     *
     * 把它暴露出来而不是留在内部有两个理由。面板想在回合存在之前显示「这支团队
     * 会哈希成什么」；下面的导出需要别人把快照递给它——由调用方从一行 `runs.jsonl`
     * 读出来递入，因为本文件被禁止回读账本。
     */
    /** 不运行就冻结一支存储的团队。 */
    configOf(name) {
      const wanted = oneLine(name);
      const team = findTeam(store.current, wanted);
      if (team === null) return { ok: false, error: `没有叫「${wanted}」的团队。` };
      try {
        const resolved = resolveTeam({ team, roster: rosterRows(), coordinator: null, store: store.current });
        if (resolved.ok !== true) return { ok: false, error: resolved.error };
        return {
          ok: true,
          config: snapshotOf({
            team: resolved.team ?? team,
            members: resolved.members,
            personaOf: personaFor,
            sourceOf: (id) => personaEntry(id).source,
            rules: TEAM_COMMON_RULES,
            /*
             * 上限是冻结配置的一部分，所以它从房间而不是从某个回合算出：同一支
             * 团队在这里永远得到同一个数字，这正是两份快照可比较的原因。规模
             * 类别是单个回合的属性，不是配置的属性，所以不记录。
             */
            model: {
              maxTokens: turnBudget(deps.maxTokens),
            },
          }),
        };
      } catch (error) {
        return { ok: false, error: oneLine(error?.message) || "生成配置快照失败。" };
      }
    },
    /**
     * 把一份冻结配置写出去，包括正文。
     *
     * 快照的另一半：账本从不持有正文，所以「把当时运行的文本给我看」是一个显式
     * 请求。文件在运行之后变过的成员，会带着 `.drifted` 后缀写出，并在
     * `verify.json` 里列出——一个看起来像某次运行的忠实拷贝、实际已不再匹配的
     * 目录，正是这里绝不能产出的结局。
     */
    exportConfig({ config, outDir } = {}) {
      try {
        return {
          ok: true,
          ...exportSnapshot({
            config,
            /*
             * 目录里已经不存在的 id 用 `null`——不是 `""`。导出会把它报告为缺失；
             * 一个空文件会和其他任何空字符串哈希成一样，被读成一次内容修改。
             */
            personaOf: (id) => {
              const entry = personaEntry(id);
              return entry.present ? entry.text : null;
            },
            outDir,
          }),
        };
      } catch (error) {
        return { ok: false, error: oneLine(error?.message) || "导出配置快照失败。" };
      }
    },
    /** 目录里实际带着的组标签，供选择器使用。 */
    groups() {
      try {
        return availableGroups(rosterRows());
      } catch (error) {
        warn(`读人设分组失败：${error?.message ?? error}`);
        return [];
      }
    },
    /** 别处写入之后重新读文件。 */
    reload() {
      store.current = readStore(deps.storeFile);
      return store.current;
    },
    /**
     * 摘掉所有指向已不存在名字的绑定。
     *
     * 删除一支团队必须做这件事，否则删除只做了一半：留下的绑定在每一次组装上
     * 都解析成一个错误，会话就永远坐在团队模式里却无队可跑。由面板的 `remove`
     * 调用；命令路径从不需要它，因为 `/waifu-team` 总是按已存在的名字重新绑定。
     */
    forget(name) {
      const wanted = oneLine(name);
      let dropped = 0;
      for (const [sessionId, held] of [...bound.entries()]) {
        if (held !== wanted) continue;
        bound.delete(sessionId);
        boundChip.delete(sessionId);
        prevChip.delete(sessionId);
        dropped += 1;
      }
      return dropped;
    },
    /**
     * 把所有绑定从一个团队名挪到另一个。
     *
     * 由面板的改名调用。绑定是一个以会话为键、以名字为值的 Map，所以一次只改了
     * 文件的改名，会让每个在线会话都指向一个已不存在的名字——它们的余生都会
     * 一直在报「团队不在文件里了」，而不是运行用户刚刚改好名的那支团队。
     *
     * 与 `forget` 不是同一个操作：这里什么都不摘除，这正是它的全部意义。
     *
     * @returns 挪动了多少个绑定。
     */
    rename(from, to) {
      const was = oneLine(from);
      const now = oneLine(to);
      if (was === "" || now === "" || was === now) return 0;
      let moved = 0;
      for (const [sessionId, held] of [...bound.entries()]) {
        if (held !== was) continue;
        bound.set(sessionId, now);
        moved += 1;
      }
      return moved;
    },
    /** 面板读写的存储；`adoptTeam` 校验单个条目。 */
    store: () => store.current,
    adoptTeam,
    emptyStore,
    save() {
      const ok = writeStore(deps.storeFile, store.current) === true;
      if (!ok) warn(`写 ${TEAM_FILE} 失败。`);
      return ok;
    },
    /** 拆卸。不给 id 表示本模块拥有的一切。 */
    dispose(sessionId) {
      const id = oneLine(sessionId);
      if (id === "") {
        bound.clear();
        boundChip.clear();
        prevChip.clear();
        off.clear();
        memoryCache.clear();
        return;
      }
      bound.delete(id);
      boundChip.delete(id);
      prevChip.delete(id);
      off.delete(id);
      /*
       * 缓存键是会话 × 团队（见 `memKey`），所以解绑叫不出单独一支团队的名字
       * ——把这个会话所有团队的缓存记忆全部丢弃。磁盘文件保留；重新绑定时
       * 会经 `readMemory` 读回。
       */
      for (const key of [...memoryCache.keys()]) {
        if (key.startsWith(`${id}::`)) memoryCache.delete(key);
      }
    },
    /**
     * 忘掉每个会话的团队记忆——面板的「清空团队记忆」。
     *
     * 先清缓存（活缓存底下磁盘被清空，下次读取会把回合复活），然后是记忆目录里
     * 的每一个 `.json`。
     * @returns {Promise<number>} 删除了多少个文件。
     */
    async clearMemory() {
      memoryCache.clear();
      if (typeof deps.memoryDir !== "string" || deps.memoryDir === "") return 0;
      let removed = 0;
      let entries = [];
      try {
        entries = await fs.promises.readdir(deps.memoryDir);
      } catch {
        return 0;
      }
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        try {
          await fs.promises.rm(path.join(deps.memoryDir, name), { force: true });
          removed += 1;
        } catch {
          /* 一个顽固的文件不许拦住其余的 */
        }
      }
      return removed;
    },
    /** 暴露给 selftest，让递归防线可以离线驱动。 */
    isDelegated,
    /**
     * v3 的运行登记表，供 selftest 与诊断使用。
     *
     * 契约上只读：在这里改状态的调用方就是在绕过 `settle` 写入，而那是终态唯一
     * 的裁决地。
     */
    runs: () => [...runs.values()].map((run) => ({
      key: run.key,
      runId: run.runId,
      sessionId: run.sessionId,
      taskId: run.taskId,
      status: run.status,
      terminal: run.terminal,
      team: run.team,
      size: run.size,
      segments: run.segments,
      /** 这次运行发出的服务方请求数；健康回合为 1。 */
      attempts: run.requests.length,
      /** 把讨论续下去的额外请求（上限或补齐）。 */
      continuations: run.continuations,
      /** 回复的规模类别与它对应的 token 上限。 */
      scale: run.scale,
      maxTokens: run.maxTokens,
      /** 本次运行注入的团队记忆字符数。 */
      memChars: typeof run.memChars === "number" ? run.memChars : 0,
      /** 进展阶段与首 token 延迟（C）。 */
      phase: run.phase,
      firstTokenMs: run.firstTokenMs,
      /** 最后一个请求的身份；下面的数组有每一次。 */
      requestId: run.requestId,
      requests: run.requests.map((entry) => ({ ...entry })),
      silent: run.silent.slice(),
      diagnostics: run.diagnostics.slice(),
    })),
  };
}

/**
 * 被认领的收件箱批次里的任务，没有时为 `null`。
 *
 * 「一条用户消息」不等于「`role === "user"`」：Agent 收件箱里的每条消息都是
 * `role: "user"`——子 agent 的中继回答、`subagent-settled` 通知、模型选择上下文
 * 块、压缩检查点。它们靠 `source.kind` 区分，只有 `"user"` / `"user-rpc"` 是真人
 * 在打字。`user-rpc` 是同一件事，只是来自一个会带上 RPC id 和时区的客户端；
 * 它是真实的用户消息，绝不能丢。
 *
 * 两个值同样被视为「没有任务」：
 *
 *   - **空文本**——纯图片或纯附件的消息没有可供构建团队提示词的内容，编造一个
 *     等于回答一个没人问的问题；
 *   - **以 `/` 开头**——命令由 `dsh-commands` 处理，永远到不了收件箱
 *     （`command/run` / `command/done` 是直接的日志追加，结果是一条 UI 通知），
 *     所以实践中不可达。它保留下来是因为在这里出错的代价是一场关于字面文本
 *     `/waifu-team 素晴三人` 的讨论，而防线的代价只是一次比较。
 *
 * **最后**一条合格的消息获胜：一个回合会先整体认领 `next-step`，才轮到那条
 * `next-turn` 消息，而更晚的消息取代更早的。
 *
 * @param {readonly object[]} messages - `agent/pre-step` payload 的 `messages`。
 * @returns {string | null}
 */
export function userTaskIn(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  let found = null;
  for (const message of rows) {
    if (oneLine(message?.role) !== "user") continue;
    const kind = oneLine(message?.source?.kind);
    if (kind !== "user" && kind !== "user-rpc") continue;
    found = message;
  }
  if (found === null) return null;
  const blocks = Array.isArray(found.content) ? found.content : [];
  const text = blocks
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("\n")
    .trim();
  if (text === "" || text.startsWith("/")) return null;
  return text;
}

/**
 * {@link userTaskIn} 选中的同一条消息的稳定 id。
 *
 * `userTaskIn` 刻意返回文本而不是行，因为讨论只需要那句话。幂等需要的是身份，
 * 所以这里把同一条规则再走一遍：**最后**一条 `source.kind` 为 `user` /
 * `user-rpc` 的消息，且只有那一条。收件箱里的其他任何东西（中继、结算通知、
 * 检查点）都不是真人在打字，绝不能铸出运行键。
 *
 * @param {readonly object[]} messages
 * @returns {string} 没有合格消息时为 `""`
 */
export function userMessageIdIn(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  let found = null;
  for (const message of rows) {
    if (oneLine(message?.role) !== "user") continue;
    const kind = oneLine(message?.source?.kind);
    if (kind !== "user" && kind !== "user-rpc") continue;
    found = message;
  }
  return found === null ? "" : oneLine(found.id);
}

