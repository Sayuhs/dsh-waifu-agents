/**
 * 注册引擎、面板 op 表，以及团队预设同步。
 *
 * 从 `index.js` 中搬出；除两处外代码原样未动：
 *
 *   1. 原来该区域从 `apply()` 闭包里取的所有东西，现在统一以一个 deps 袋
 *      传入。这袋子是搬动付出的诚实代价——插件的这一部分碰到了所有东西
 *      （目录、注册锁、团队运行时、模式切换），而这袋子就是把这一事实
 *      落到纸面上的样子。
 *   2. `apply()` 里有五个绑定是 `let`，值拷贝会说谎。它们以 thunk 的形式
 *      传入：`teamRuntimeOf` / `toolFilterOf` / `currentModeOf` /
 *      `defaultCache` 读，`setCurrentMode` / `markScanned` 写。它们的使用
 *      位置读起来与旧代码完全一样，只少了个裸名字。
 *
 * 面板 op 的名字经返回值保留下来：`index.js` 会对它解构，所以本模块之外
 * 的 op 分发器和启动链不受影响。
 */
import fs from "node:fs";
import path from "node:path";

/*
 * registry 实例的身份证。
 *
 * 为什么它不是 `instToken`：那两个问题不一样。`instToken` 回答「这一行账本
 * 是谁写的」——宿主每 apply 一次就换一个，`scanOnce` 靠它决定接管；而这里要
 * 回答的是「此刻这个 id 上的注册，是不是登记在**我现在说话的这个注册表**里」。
 * 两个插件实例可以共享同一个 registry 对象（正常重载），也可以各自拿着不同的
 * 一个（宿主的注册表自己被重建），这两种情形下 `instToken` 都不同，但答案
 * 必须不同。
 *
 * 令牌按**对象身份**发放：同一个 registry 对象永远拿到同一个令牌，换一个对象
 * 就换一个令牌。`WeakMap` 保证 registry 被回收之后令牌跟着消失，不会把死掉的
 * 注册表钉在内存里。
 *
 * 它证明不了的事也要写清楚：令牌只说明「读的是不是同一个对象」，不说明那次
 * 读取发生在什么时刻，也不说明那个对象里有没有别人的注册。所以它只在
 * `presenceOf()` 里当**前置条件**用，不能单独当证据。
 *
 * @type {WeakMap<object, {serial: number}>}
 */
const REGISTRY_TOKENS = new WeakMap();
let registrySerial = 0;

/**
 * @param {unknown} registry
 * @returns {{serial: number} | null} 不是对象就没有身份可言
 */
function registryTokenOf(registry) {
  if (registry === null || registry === undefined) return null;
  if (typeof registry !== "object" && typeof registry !== "function") return null;
  const known = REGISTRY_TOKENS.get(registry);
  if (known !== undefined) return known;
  registrySerial += 1;
  const token = { serial: registrySerial };
  REGISTRY_TOKENS.set(registry, token);
  return token;
}

/**
 * @param {object} ctx 插件自身的 context
 * @param {object} deps 模块常量、闭包句柄与活动绑定的 thunk
 * @returns {object} 面板分发器与 apply() 其余部分按名字调用的所有 op
 */
export function installPanelOps(ctx, deps) {
  const {
    ID_OK,
    MODES,
    PROMPT_VARIABLES,
    PROMPT_VARIABLE_NAME,
    REG_STATE,
    RESERVED,
    SKELETON_FILE,
    TEAM_ORDER_BASE,
    assemble,
    buildDefinition,
    buildZip,
    documentText,
    migratePersona,
    normalizeMode,
    normalizeOrder,
    oneLine,
    parseFrontMatter,
    presetPlacement,
    registrationRev,
    renderPersona,
    reserved,
    revision,
    skeletonFor,
    templateProblem,
    PERSONA_PLACEHOLDER,
    SELF_IDS,
    MODE_FILE,
    PACKAGE_DIR,
    REGISTRY_NS,
    TEAM_PRESET_PREFIX,
    anchorOf,
    config,
    dir,
    dirSource,
    fileFor,
    foreign,
    ghosts,
    holdRegistration,
    instEpoch,
    instToken,
    listFiles,
    owned,
    personaMemoryDir,
    readOnly,
    readPersona,
    readSkeleton,
    refreshDefault,
    refreshMemorySnapshot,
    registering,
    releaseRegistration,
    resettleUnstarted,
    serviceOf,
    templatePath,
    templateRowsFor,
    verifyDefault,
    writable,
    writeAtomic,
    writeStoredMode,
    teamRuntimeOf,
    toolFilterOf,
    currentModeOf,
    setCurrentMode,
    markScanned,
    defaultCache,
  } = deps;


  /**
   * 每个团队都注册成一个 agent preset，这正是它出现在新会话页、与人设
   * 并列的原因。
   *
   * 这与「人设之于会话」是同一种关系，值得点破：会话创建（CREATED）时选
   * 团队是默认，`/waifu-team` 是其上按会话的覆盖——与全局默认人设和
   * `/waifu-change` 之间的关系如出一辙。一个只作为命令存在的团队，会是
   * 那一页上唯一无法被选中的东西。
   *
   * 两张映射表，而非一张：`teamPresets` 是 id -> 团队名（用来辨认一个
   * 运行中的会话），`teamOwned` 是 id -> 注册过什么（用来收回它）。
   * `anchorOf` 能读到的只有会话自己的 preset id，所以没有第一张表，就
   * 无从得知一个会话诞生于某个团队。
   *
   * 两者都放在 `REG_STATE` 里，由本插件所有活跃的 apply() 共享，理由与
   * `owned` 相同：一个看不见对方注册的孪生实例，要么把对方的注册再注册
   * 一遍（注册表拒绝重复，团队悄悄落得没有任何预设），要么——更糟——
   * 把它们当陌生人拆掉。宿主在安装和重载期间会重新 apply 本插件，所以
   * 这个窗口期是真实存在的。
   */
  const teamPresets = REG_STATE.teamPresets;
  const teamOwned = REG_STATE.teamOwned;

  /**
   * 本次 apply() 的身份标识，盖在它写下的每一个团队行上。
   *
   * 共享映射表消除了盲目，却没消除归属问题：一张表里躺着两个实例的行，
   * 「删掉这个 id 的行」就不再是安全操作，除非能证明这行是我的。每次
   * apply() 用一个新对象就够了——对 `entry.applied` 的引用相等即可回答
   * 「这行是我写的吗？」，除此之外不需要存任何东西。
   */
  const teamToken = {};

  /*
   * 本实例说话的那个 registry，以及它的身份证。
   *
   * 第一次用到时解析，之后一直用**同一个对象**：注册走它，复核也走它。中途
   * 如果 `ctx.agentPresets` 换了对象（宿主重建了注册表），那不是我们能替它
   * 回答的问题——`registryToken` 保持指向我们登记时的那一个，复核时身份对不上
   * 就一律回 `unreadable`。
   *
   * 解析时连续读两次，是为了验证服务面给得出稳定身份。这里有个真宿主
   * （2026-11-01 诊断落盘实锤）教会我们的坑：cordis 对带 tracker 的服务，
   * 每次属性访问都现包一层 traceable 代理（`createTraceable`）——裸比对象
   * 身份，两次**永远**不相等，令牌会被永久置空，此后所有「确认摘除」都是
   * `unreadable`，改一个人设就弹一次「注销失败」。所以身份比的是解包后的
   * 底层服务对象（cordis 在代理上留了官方开瓶器，见 {@link registryIdentity}）；
   * 底层两次都同一个，才发令牌。宁可全部看不清，也不要拿一个每次访问都
   * 换底的引用去当证据。
   */
  let registryRef = null;
  let registryToken = null;

  /**
   * 解到 cordis traceable 包装下的底层服务对象。
   *
   * cordis 的 traceable 代理专门留了这个读口：读
   * `Symbol.for("cordis.original")` 返回代理目标（真正的服务对象）；不是
   * 包装就是普通对象，符号读出来是 `undefined`，原样返回。用全局注册表
   * 符号而不是 import，是为了不对宿主的模块布局做硬依赖。
   *
   * @param {object} value 属性访问刚拿到的（可能是包装的）服务对象
   * @returns {object} 底层服务对象
   */
  function registryIdentity(value) {
    const inner = value[Symbol.for("cordis.original")];
    return inner === undefined || inner === null ? value : inner;
  }

  /**
   * @returns {object | null} 本实例登记用的 registry（可能还没就绪）
   */
  function registryNow() {
    if (registryRef !== null) return registryRef;
    const first = ctx.agentPresets;
    if (first === undefined || first === null) return null;
    const second = ctx.agentPresets;
    const identity = registryIdentity(first);
    registryRef = first;
    registryToken = identity === registryIdentity(second) ? registryTokenOf(identity) : null;
    return registryRef;
  }

  /**
   * 平台用稳定的 `code` 报「没有这个预设」。判别只认 code：官方注释写明
   * 「Discrimination is always by `code`, never by instanceof」，而跨 realm
   * 的 `instanceof` 本来就不可靠。
   *
   * @param {unknown} error
   * @returns {boolean}
   */
  function isPresetNotFound(error) {
    if (error === null || typeof error !== "object") return false;
    return error.code === "agent-preset/not-found";
  }

  /**
   * 这个 id 此刻在注册表里吗——**只回答这一件事**。
   *
   * 三种结果，因为宿主能给我们的就是三种：
   *
   *  - `absent`      registry 明确回了 `agent-preset/not-found`。这是「摘除」
   *                  唯一的证据形态；它不证明资源已销毁，也不证明是谁摘的。
   *  - `present`     registry 明确读到了这一行。**它不证明这一行是我们的**：
   *                  内容指纹可以被复制，账本行可以被改写，而 disposer 根本
   *                  不携带身份。所以 `present` 只能把问题交回给调用方当
   *                  `unknown`，不能拿去当"还在"或"不是我们的"。
   *  - `unreadable`  其它一切：服务缺席、身份对不上（另一个 registry 实例、
   *                  令牌为空的抖动 getter）、普通 Error、序列化失败、空返回。
   *                  一律不算"不在"——**看不清楚的时候，唯一安全的答案是不知道**。
   *
   * 刻意不用 `list()`：它逐条 `await diagnostic()`，返回的是调用瞬间的快照，
   * 中途被删的行照样出现在结果里。也不用 `resolve()`：同理，它在拿到记录之后
   * 还会 await。`readDocument()` 是唯一同步读 `definitions` 的读法。
   *
   * @param {string} id
   * @param {{serial: number} | null | undefined} ownerToken 账本行登记时用的 registry 身份
   * @returns {Promise<"absent" | "present" | "unreadable">}
   */
  async function presenceOf(id, ownerToken) {
    try {
      if (ownerToken === undefined || ownerToken === null) return "unreadable";
      if (registryToken === null || registryToken !== ownerToken) return "unreadable";
      const registry = registryRef;
      if (registry === null || typeof registry.readDocument !== "function") return "unreadable";
      const document = await registry.readDocument(id);
      return document === undefined || document === null ? "unreadable" : "present";
    } catch (error) {
      return isPresetNotFound(error) ? "absent" : "unreadable";
    }
  }


  /** 会话诞生时所在的团队，否则为 `null`。 */
  function teamNameForPreset(presetId) {
    const found = teamPresets.get(oneLine(presetId));
    return typeof found === "string" ? found : null;
  }

  /**
   * 一个团队名对应的 preset id。
   *
   * 团队名是用户输入的任何东西——空格、标点，随便什么——而 preset id 得
   * 满足 {@link ID_OK}。所以 id 是派生的，派生的 id 可能撞车（「素晴 三人」
   * 和「素晴三人」展平后是同一个字符串），这正是 `taken` 集合和数字后缀
   * 的用途。
   * @param {string} name
   * @param {Set<string>} taken 这一轮里已被占用的 id
   */
  function teamPresetIdFor(name, taken) {
    const flat = `${TEAM_PRESET_PREFIX}${oneLine(name).replace(/\s+/gu, "-")}`;
    // 丢掉 preset id 带不了的东西。`a` 前缀是诀窍：`ID_OK` 拒绝以 `-` 开头，
    // 直接单测这个候选会丢掉所有连字符，而 `a-` 是合法 id——这恰好就是
    // 想要的答案：一个除了开头之外处处合法的字符。
    const kept = [...flat].filter((ch) => ID_OK.test(`a${ch}`)).join("");
    const base = ID_OK.test(kept) ? kept : `${TEAM_PRESET_PREFIX}team`;
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  /** 团队名对应的已注册 preset id，不属于任何团队时为 `""`。 */
  function teamPresetIdByName(name) {
    const wanted = oneLine(name);
    if (wanted === "") return "";
    for (const [id, held] of teamPresets) {
      if (held === wanted) return id;
    }
    return "";
  }

  /**
   * 把会话标签挪到一个团队 preset 上。
   *
   * 追加动作与 {@link rememberSessionPreset} 相同，守卫不同：人设 id 必须
   * 在 `owned` 里，团队 id 必须在 `teamPresets`（注册表的团队那一半）里。
   * 没有这个区分，`/waifu-team` 永远挪不动标签——团队 id 不是人设。
   */
  function rememberTeamPreset(agent, id) {
    if (config.syncSessionChip === false) return false;
    const session = agent?.session;
    if (session === undefined || session === null) return false;
    if (id === "" || !teamPresets.has(id)) return false;
    try {
      session.append("agent-preset/selected", { agentPreset: id });
      return true;
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 会话标签没跟上（团队 ${id}）：${error?.message ?? error}`,
      );
      return false;
    }
  }

  /**
   * 让已注册的团队预设与 `teams.json` 保持一致。
   *
   * 每次写入之后调用，安装时也调用一次：只存在于文件里的团队在会话创建
   * 时没法被选中，而那正是注册它的全部意义。重新注册以描述为键，因为
   * 成员列表在描述里——团队加了人就得重新注册，否则新会话页一直挂的是
   * 旧阵容。
   *
   * 永不抛出：注册不上的团队仍然可以用 `/waifu-team` 选到，而让创建它的
   * 那次写入失败，比警告一声更糟。
   */
  /**
   * 卸下一个团队行：先卸注册、复核注册表、确认摘除之后才记账。
   *
   * 两半一起动是刻意的。id -> 名字的映射是 `/waifu-team` 和默认 preset 行
   * 读取的东西，映射比注册活得久，会把它们送向注册表里已经没有的预设——
   * 在用户列表里看得见的团队上出现「那个团队不存在了」。只有当映射仍然
   * 描述的是这一行（`=== entry.name`）时才丢弃：孪生实例可能已把两半都
   * 换掉了，抹掉它的映射就是把同样的错误反着再犯一遍。
   *
   * 失败**不再等于「注册还在」**：宿主在抛错之前就把名册行删了。所以判定
   * 只看 `releaseEntry` 的结论——`present` 与 `unreadable` 都算 `unknown`，
   * 行留着，映射也留着，下一轮同步会**重新问一次注册表**（不会再发一次
   * disposer，那个已经花掉了）。
   *
   * @param {string} id
   * @param {{ dispose: () => Promise<unknown>, name: string }} entry
   * @returns {Promise<boolean>} 注册是否**已确认**摘除（`false` = 不是我们的，或看不清）
   */
  async function detachTeamRow(id, entry) {
    try {
      /*
       * 身份、单飞、三态判定都在 `releaseEntry` 里，这里只剩团队自己那点
       * 副作用：名字映射。它只在「确实删掉了自己那一行」之后才该走——孪生
       * 换过行之后，映射描述的是孪生。
       */
      const released = await releaseEntry(teamOwned, id, entry, () => {
        if (teamPresets.get(id) === entry.name) teamPresets.delete(id);
      });
      if (!released) {
        ctx.logger?.warn?.(`dsh-waifu-agents: 团队预设「${entry.name}」：${releaseDiagnostic(entry.releaseError)}`);
      }
      return released;
    } catch (error) {
      /*
       * 走到这里只可能是 `releaseEntry` 自己出了意外（它内部已经把 disposer
       * 与复核的异常都收干净了）。行原样留着，下一轮再判断。
       */
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 卸下团队预设「${entry.name}」失败：${error?.message ?? error}`,
      );
      return false;
    }
  }

  async function runTeamPresetSync() {
    if (teamRuntimeOf() === null) return;
    /* 登记用的 registry 就是我们复核时问的那一个；见 `registryNow`。 */
    const registry = registryNow() ?? ctx.agentPresets;
    const store = teamRuntimeOf().store();
    const wanted = new Map();
    const taken = new Set();
    for (const team of store.teams) {
      const id = teamPresetIdFor(team.name, taken);
      taken.add(id);
      const preview = teamRuntimeOf().preview(team.name);
      const members =
        preview.ok === true ? (preview.members ?? []).map((row) => row.name) : [];
      const description =
        members.length === 0
          ? "团队模式 · 这一队现在解析不出成员。"
          : `团队模式 · ${members.length} 人：${members.join("、")}`;
      wanted.set(id, { name: team.name, description });
    }
    /*
     * 退掉本次 apply() 写下、且如今不再需要的行。
     *
     * `entry.applied !== teamToken` 正是共享这张表的全部意义：属于孪生实例
     * 的行绝不能在这里拆掉。那个实例还在运行、还认为这个预设活着；删掉
     * 它的行也会连带删掉它的名字映射，它自己的同步随后就会往一个它已经
     * 放弃的 id 上重新注册。只有写下某行的实例才有资格退掉它——若它没退
     * 就死了，它的 dispose 钩子会在那时退掉。
     */
    for (const [id, entry] of [...teamOwned]) {
      if (entry.applied !== teamToken) continue;
      /*
       * 只有 `active` 的行才算健康。`releasing` 正在飞（等它自己结束，不许再发
       * 一次请求）；`suspect` / `unknown` 是「上一次判定没结论」——行留着是对
       * 的，但**不能当成健康行跳过**：下一轮必须再问一次注册表，而那次重试
       * 只发生在 `detachTeamRow` 里。老构建写下的行没有 `state`，按健康算。
       */
      const want = wanted.get(id);
      if (
        isHealthyRow(entry) &&
        want !== undefined &&
        want.name === entry.name &&
        want.description === entry.description
      )
        continue;
      await detachTeamRow(id, entry);
    }
    let at = 0;
    for (const [id, want] of wanted) {
      at += 1;
      let held = teamOwned.get(id);
      if (
        held !== undefined &&
        isHealthyRow(held) &&
        held.applied === teamToken &&
        held.name === want.name &&
        held.description === want.description
      )
        continue;
      /*
       * 看不清的行不许自动接管：我们既证明不了它是我们的，也证明不了它不是我
       * 们的，而任何「重新注册」都会先要求一次注销。出口只有一个——那个 id
       * 从注册表消失。`presenceOf` 只读名册、不发平台调用，所以可以放心地
       * 每轮问一次；问到 `absent` 才清账本行，然后照常注册。
       */
      if (held !== undefined && held.state === "unknown") {
        if ((await presenceOf(id, held.registry)) !== "absent") continue;
        if (teamOwned.get(id) === held) {
          teamOwned.delete(id);
          if (teamPresets.get(id) === held.name) teamPresets.delete(id);
        }
        held = undefined;
      }
      /*
       * 别的实例写下的行——或者我们自己的过期行，或者文本变了的行——
       * 不能直接收编。它的 disposer 属于一个随创建它的 fiber 一起消亡的
       * 注册，复用会让本实例抱着一具尸体，团队直到下次重启都选不中。
       * 把它卸下再重新注册，与人设那一半在 `scanOnce` 里的做法完全一致。
       *
       * 共享账本让本实例「知道」有一行存在，但这不是跳过注册的许可。
       */
      if (held !== undefined && !(await detachTeamRow(id, held))) continue;
      try {
        // 正文只做校验，从不对外提供：preset 行只是占位符，
        // `resolvePersonaText` 对团队预设返回 `""`（讨论会构建自己的请求）。
        // 所以不会有任何人设文本经这个预设到达模型——到达模型的是团队
        // 提示词。
        const definition = buildDefinition(
          id,
          { name: want.name, description: want.description, order: at },
          `你与「${want.name}」这一队一起工作。`,
          // 一律聊天行：无论开关如何，团队模式就是聊天模式。
          templateRowsFor("team"),
          null,
          TEAM_ORDER_BASE,
        );
        const platformDispose = await registry.register(definition);
        /*
         * 与人设那一半同构：一次性消费 + `releasing` 防重复 + 三态复核，全部
         * 走 `makeRetirement` / `releaseEntry`，团队这一侧不再有自己的一套。
         *
         * 单飞仍然承重：同一个原始 disposer 有两条生命周期会来要它——
         * `detachTeamRow`（同步、卸载）与本 fiber 的 dispose 钩子（死亡）。两条
         * 撞在一起时，平台的 disposer 按 id 删、不认持有者，第二次调用删的是
         * 「此刻占着这个 id 的那一份」，而那可能已经是孪生刚注册上的。
         *
         * 但「可重试」不再靠清空槽位：失败之后 disposer 已经花掉，重试**只**
         * 重新问一次注册表（`presenceOf`），不会再发一次平台调用。
         */
        const retirement = makeRetirement(platformDispose);
        const retire = retirement.dispose;
        const entry = {
          dispose: retire,
          applied: teamToken,
          registry: registryToken,
          state: "active",
          name: want.name,
          description: want.description,
        };
        /*
         * 本 fiber 消亡时退掉这一行，且仅当账本里仍是这份注册时才退：孪生
         * 实例可能已经把它换掉了，本实例死亡不得抹掉替换者的记录或它的名字
         * 映射。
         *
         * 状态由 `releaseEntry` 写：`detached`/`cleanupError` 时行已经没了，
         * `unknown` 时行留着且 `state !== "active"`，下一轮同步因此不会把它
         * 当健康行跳过——那正是原来 `stale` 标记在做的事，现在由判定本身给出，
         * 不需要再手工补一个字段。
         */
        ctx.on("dispose", () => {
          return releaseEntry(teamOwned, id, entry, () => {
            if (teamPresets.get(id) === want.name) teamPresets.delete(id);
          }).then((released) => {
            if (!released) ctx.logger?.warn?.(`dsh-waifu-agents: 团队预设「${want.name}」：${releaseDiagnostic(entry.releaseError)}`);
          });
        });
        teamOwned.set(id, entry);
        teamPresets.set(id, want.name);
      } catch (error) {
        ctx.logger?.warn?.(
          `dsh-waifu-agents: 团队「${want.name}」没能注册成预设（还能用 /waifu-team 选它）：${error?.message ?? error}`,
        );
      }
    }
  }

  /*
   * 串行化，因为它既在安装时被一个 `void` 调用，又被每个 `teamSet` 写入
   * await——所以安装期那轮还在遍历 store 时落下的写入，会让两轮同时跑。
   * 两轮交错就成了「注册对方正在注册的 id」，注册表拒绝重复，团队悄悄
   * 落得没有任何预设。
   *
   * 链放在 `REG_STATE` 里，理由与账本相同：一次重载会把上一个实例的
   * `void syncTeamPresets()` 留在飞行中，实例本地的链会让新实例与它并行
   * 跑自己的那一轮。共享映射却不共享链，比两者都不共享还糟——两轮读
   * 同一本账，各自断定对方的行是过期的。
   *
   * 用链而不是丢弃：一轮因为有轮在飞行而被跳过，就会错过调用方刚写完的
   * 那个团队。
   */
  function syncTeamPresets() {
    REG_STATE.teamSyncs = REG_STATE.teamSyncs.then(
      () => runTeamPresetSync(),
      () => runTeamPresetSync(),
    );
    return REG_STATE.teamSyncs;
  }

  /*
   * 不 await：`apply` 不能在注册表上阻塞，而注册失败的团队仍能通过
   * `/waifu-team` 选到。绝不能发生的是未处理的 rejection，所以失败在
   * 这里记日志，而不是被 `void` 吞掉。
   */
  void syncTeamPresets().catch((error) => {
    ctx.logger?.warn?.(`dsh-waifu-agents: 同步团队预设失败：${error?.message ?? error}`);
  });

  /** 目录里的最大 order 加一——面板从不主动要它。 */
  function nextOrder() {
    let max = 0;
    for (const item of listFiles()) {
      if (typeof item.order === "number" && item.order > max) max = item.order;
    }
    return max + 1;
  }

  /**
   * 显示名对应的文件名：名字变成 slug，并对照目录里所有其他文件保持
   * 唯一。
   *
   * id 是不可见的，所以把「文件名、`name` 字段、行标题」系为一体的只有
   * 这里。`self` 是正在保存的文件：没有它，保存一个没改过的名字就会撞上
   * 它自己的文件，落到 `name-2`——一个无操作编辑曾把一个 wife 一分为二，
   * 正是这个缘故。Unicode 原样保留，所以 `后藤一里` 既是名字 *也是* 文件
   * 名；只有文件名带不了的东西（空格、`/`、标点）折叠成 `-`，折叠后什么
   * 都不剩的名字回落到 `persona`，然后是 `persona-2`、`persona-3`……
   * @param {string} name 显示名
   * @param {string | null} [self] 当前持有这个 wife 的 id，如果有
   * @returns {string} 一个合法且当前空闲的 id
   */
  function idForName(name, self = null) {
    const slug = oneLine(name)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const taken = new Set(listFiles().map((item) => item.id));
    if (self !== null) taken.delete(self);
    const base = ID_OK.test(slug) ? slug : "persona";
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  /**
   * 这一行是不是「登记着、而且我们有理由相信它还登记着」。
   *
   * 只有 `active` 算健康。`releasing` 在飞、`suspect` 刚失手、`unknown` 看不清、
   * `detached`/`cleanupError` 已经从账本里删掉了（正常情况下读不到）。老构建
   * 写下的行没有 `state` 字段，按健康算——升级之前它们确实是健康的。
   *
   * @param {{ state?: string }} entry
   * @returns {boolean}
   */
  function isHealthyRow(entry) {
    return entry.state === undefined || entry.state === "active";
  }

  /**
   * 把平台的 disposer 包成**一次性**的，并且记住它第一次的结果。
   *
   * 一劳永逸的理由不是安全（宿主自己就有 `disposed` 标志，第二次调用是空转），
   * 而是**诚实**：第一次若抛错，槽位原来会被清空，下一轮于是再发一次同一个
   * disposer——那一次在宿主侧什么都不做、但会 resolve，于是插件把一次空转
   * 记成了成功。用户看到的是「第一次说没卸下来，第二次什么都没变却说好了」。
   *
   * 所以三条：
   *
   *  1. `spent` 保存**第一次**调用产生的 promise，永不重发；
   *  2. reject 也照样留着——调用方每次 `await` 都会拿到同一个失败，而不是
   *     一个假的成功；
   *  3. 创建时立刻挂一个空 `catch`，否则没人 await 的 rejected promise 会升级
   *     成 `unhandledRejection`，在高版本 Node 上直接终止进程。
   *
   * @param {() => Promise<unknown>} platformDispose
   * @returns {{ dispose: () => Promise<unknown>, outcome: () => ({ ok: boolean, error: unknown } | null) }}
   */
  function makeRetirement(platformDispose) {
    let spent = null;
    let outcome = null;
    const dispose = () => {
      if (spent === null) {
        spent = (async () => platformDispose())().then(
          (value) => {
            outcome = { ok: true, error: null };
            return value;
          },
          (error) => {
            outcome = { ok: false, error };
            throw error;
          },
        );
        spent.catch(() => {});
      }
      return spent;
    };
    return { dispose, outcome: () => outcome };
  }

  /**
   * 释放一份注册的**唯一**写法。
   *
   * 四条路径（`unregister`、人设 dispose 钩子、`detachTeamRow`、团队 dispose
   * 钩子）共用它。它现在管的不只是顺序，还有**判定**：
   *
   *   1. **身份**：账本里那一行不是这一份注册，就不是我的事——不动。孪生实例
   *      可能已经把行换成它的了。
   *   2. **状态先落地**：`active → releasing` 写在第一个 `await` **之前**。
   *      扫描用的是循环外取的花名册快照，不同步登记就会对同一行再发一次释放
   *      请求；写在这里，第二次请求看到 `releasing` 就并到同一个 promise 上。
   *   3. **单飞**：第二次请求拿到的是 `releasePromise`，不是第二次平台调用。
   *   4. **判定不看 disposer 的返回值**：宿主唯一会抛的地方在
   *      `definitions.delete` **之后**，所以 reject 不等于"还在"、resolve 也不
   *      等于"销毁了"。真正的判据只有一次 `presenceOf()`：
   *
   *        | disposer | presence    | 结果                                        |
   *        |----------|-------------|---------------------------------------------|
   *        | resolve  | absent      | `detached`   —— 摘除了，资源状态不可观测     |
   *        | reject   | absent      | `cleanupError` —— 摘除了，但后续清理报了错    |
   *        | 任意     | present     | `unknown`    —— 有人在，但证明不了是我们     |
   *        | 任意     | unreadable  | `unknown`    —— 看不清，不许猜               |
   *
   * 只有 `absent` 允许清账本行——行留着会让扫描以为这份注册还在，清早了则
   * 会把一份还活着的注册变成孤儿。两者都只能在证据到位时选。
   *
   * `unknown` 的行留在原地：它的 disposer 已经花掉（`retire` 的 `spent`），
   * 再调也不会产生任何平台动作，于是下一轮可以安全地**只再问一次**
   * `presenceOf()`。这就是 `unknown` 唯一的自动出口：等那个 id 从注册表消失。
   *
   * @param {Map<string, object>} ledger `owned` 或 `teamOwned`
   * @param {string} id
   * @param {{ dispose: () => Promise<unknown>, registry?: object, state?: string }} entry
   * @param {() => void} [onReleased] 只在确认摘除并删掉了自己那一行之后才跑
   * @returns {Promise<boolean>} 这份注册是否**已确认**不在了（`false` = 不是我们的，或看不清）
   */
  async function releaseEntry(ledger, id, entry, onReleased) {
    if (ledger.get(id) !== entry) return false;
    if (entry.releasePromise !== undefined) return entry.releasePromise;

    entry.state = "releasing";
    entry.releasePromise = (async () => {
      let failure = null;
      try {
        await entry.dispose();
      } catch (error) {
        failure = error ?? new Error("dispose failed");
        entry.state = "suspect";
      }
      const presence = await presenceOf(id, entry.registry);
      if (presence !== "absent") {
        entry.state = "unknown";
        entry.releaseError = failure ?? new Error("无法确认这个 id 上的注册是否仍然存在");
        return false;
      }
      entry.state = failure === null ? "detached" : "cleanupError";
      entry.releaseError = failure;
      if (failure !== null) {
        /*
         * 清理失败只在这一处报告：每一条释放路径（面板 op、扫描、两条钩子、
         * 团队同步）都从这里过，散在调用方里就会漏掉 `remove`/`update` 这种
         * 不经过钩子的路径——那正是它以前完全不可见的原因。
         */
        ctx.logger?.warn?.(`dsh-waifu-agents: ${cleanupDiagnostic(failure)}（${id}）`);
      }
      if (ledger.get(id) === entry) {
        ledger.delete(id);
        if (typeof onReleased === "function") onReleased();
      }
      return true;
    })();

    try {
      return await entry.releasePromise;
    } finally {
      /*
       * 槽位只用来合并**同时在飞**的请求，用完就清：`unknown` 的行还留在账本
       * 里，下一轮必须能再问一次 `presenceOf()`（问的只是注册表，不是 disposer，
       * 不会产生第二次平台调用）。
       */
      entry.releasePromise = undefined;
    }
  }


  /**
   * 卸下一个人设的注册。
   *
   * 返回的不再是布尔：调用方需要分清「确认摘除了」与「说不清」——前者可以
   * 接着注册新的，后者必须停下并如实报告。`state` 取自账本行本身（`releaseEntry`
   * 在返回之前就写好了），所以它描述的是**这一次**判定的结论。
   *
   * 账本里没有这一行时回 `foreign`：我们手里没有任何「这一份注册」的凭据，
   * 调用方不该据此宣称卸掉了什么（`remove` 的 `wasRegistered` 就是这么来的）。
   *
   * @param {string} id
   * @returns {Promise<{ ok: boolean, state: string, error: unknown }>}
   */
  async function unregister(id) {
    const entry = owned.get(id);
    if (entry === undefined) return { ok: false, state: "foreign", error: null };
    const ok = await releaseEntry(owned, id, entry);
    return { ok, state: entry.state, error: entry.releaseError ?? null };
  }

  /**
   * 平台用 `Duplicate agent preset` 拒绝我们时，原因几乎总是同一个：这个
   * id 还登记在上一个实例名下（宿主没有 dispose 它），而平台按 id 注册、
   * 不接受覆盖，也没有按 id 移除的 API。
   *
   * 原文对用户没有意义——它读起来像插件自己有 bug，可实际能做的事只有
   * 一件：完全退出 DSH 再打开。这里只换措辞，不吞掉别的错误：任何不属于
   * 这个形状的异常按原样返回给调用方。
   */
  function registrationFailure(error) {
    const text = String(error?.message ?? error ?? "");
    if (!text.includes("Duplicate agent preset")) return text;
    return "这一位还登记在 DSH 的上一个实例名下（那个实例没被卸载干净），所以现在改不动——完全退出 DSH 再打开就能改。文件没有改动。";
  }

  /**
   * 「这一位的注册此刻说不清」的人话。
   *
   * 读宿主源码之前，这条文案说的是「旧注册这次没卸下来」——那是错的：宿主
   * 的 disposer 在抛错之前就已经把 `definitions` 那一行删了，所以「失败」从来
   * 不等于「还在」。现在能说的只有一句实话：**看不清**。说不清就不动文件，
   * 也不宣称任何一侧的结果。
   *
   * 与 {@link registrationFailure} 分开，是因为下一步不同：那条讲「这个 id
   * 被上一版实例占着」，能做的只有重启；这条讲「刷新会重新确认一次」。
   *
   * **不带平台原文。** 以前这里拼的是 `：${registrationFailure(error)}`，而
   * `registrationFailure` 只翻译 `Duplicate agent preset` 那一种，其余原样返回
   * ——于是用户在面板上读到的是一条「……无法确认是否还挂在 DSH 上：dispose
   * cleanup boom(after-delete)」的句子（R14）。那句原文是给我们看的证据，不是
   * 给用户看的解释，现在只走 {@link releaseDiagnostic} 进日志。
   */
  function releaseFailure() {
    return (
      "这一位的注册此刻无法确认是否还挂在 DSH 上。" +
      "文件没有改动；刷新或再点一次都会重新确认，完全退出 DSH 再打开也能恢复。"
    );
  }

  /**
   * {@link releaseFailure} 的日志版本：同一句话 + 平台原文。
   *
   * 只许出现在 `logger.warn` 里。`unknown` 这一格最缺的正是证据——面板上必须
   * 是干净的人话，日志里必须有「到底是什么抛了」，两边不能是同一份文本。
   *
   * @param {unknown} error
   */
  function releaseDiagnostic(error) {
    return withDetail(releaseFailure(), error);
  }

  /**
   * 「注册摘掉了，但 DSH 那边的资源清理报了错」。
   *
   * 只报事实，不许说成「资源还在」——`users > 0` 时宿主本来就会推迟销毁，
   * 插件看不到 `users`、也看不到 `scope.disposed`，两种情形在观测面上完全一样。
   *
   * 同样不带平台原文：`cleanupError` 的行会进 `scan` 的 `problems`，那是面板
   * 渲染的字段（R14 的另一处）。
   */
  function cleanupFailure() {
    return "这一位的注册已经从 DSH 摘下来了，但它那边的资源清理报了一个错。这不影响使用，也不需要重试。";
  }

  /**
   * {@link cleanupFailure} 的日志版本。理由同上：原文进日志，不进面板。
   *
   * @param {unknown} error
   */
  function cleanupDiagnostic(error) {
    return withDetail(cleanupFailure(), error);
  }

  /**
   * 把一句人话和一条原始错误接起来。原文缺失时只回人话，不留一个空括号。
   *
   * @param {string} text
   * @param {unknown} error
   */
  function withDetail(text, error) {
    const detail = String(error?.message ?? error ?? "").trim();
    return detail === "" ? text : `${text}（原始错误：${detail}）`;
  }

  /**
   * 新建任务页的读法：默认人设 → 有分组的人设 → 没分组的人设。
   *
   * 这三段由 {@link presetPlacement} 算成注册表的排序键，而组与组之间的
   * 先后只有这里知道——要读整份目录。扫描在循环外读一次（`seatingOf`），
   * 单点注册（新建/编辑）现读一次：它们本来就是"一次目录读取换一次顺序
   * 正确"，而扫描里逐条读会把 N 份人设读成 N² 份。
   */
  function seatingOf(rows) {
    return {
      groups: [...new Set(rows.map((row) => oneLine(row.group)).filter((name) => name !== ""))].sort((a, b) =>
        a.localeCompare(b),
      ),
      mark: oneLine(defaultCache?.()?.id),
    };
  }

  /**
   * 一位人设的排位。`seating` 缺省时现读一份目录——调用方只有新建/编辑那
   * 两个本来就不在扫描里的路径。
   * @param {string} id
   * @param {{group?: unknown, order?: unknown}} meta
   * @param {{groups: string[], mark: string}} [seating]
   */
  function placementOf(id, meta, seating) {
    const frame = seating ?? seatingOf(listFiles());
    const group = oneLine(meta?.group);
    const rank = group === "" ? 0 : frame.groups.indexOf(group);
    return presetPlacement({
      isDefault: frame.mark !== "" && frame.mark === id,
      group,
      /* 组名不在表里（刚写下的新组）：排在已有的组之后，仍在意料之中。 */
      groupRank: rank < 0 ? frame.groups.length : rank,
      localOrder: normalizeOrder(meta?.order),
    });
  }

  /**
   * 先组装，再注册。校验放在这里而不是每个调用方，任何一条路径——面板、
   * 命令或扫描——都注册不出提示词渲染器咽不下去的正文。
   */
  async function registerOne(id, meta, body, seating) {
    const templateIssue = templateProblem(meta);
    if (templateIssue !== null) throw new Error(templateIssue);
    const skeleton = skeletonFor(meta, readSkeleton());
    const name = oneLine(meta.name) || id;
    const poured = assemble(
      name,
      body,
      skeleton === null ? null : skeleton.text,
    );
    if (!poured.ok) throw new Error(poured.problems.join("；"));
    const seat = placementOf(id, meta, seating);
    const registry = registryNow() ?? ctx.agentPresets;
    const platformDispose = await registry.register(
      buildDefinition(id, meta, body, templateRowsFor("persona"), skeleton, undefined, seat),
    );
    /*
     * 最终只有一次调用会到达 `platformDispose`。
     *
     * 有两个调用方可能想让这份注册消失：本实例 fiber 的消亡，以及在更新
     * 实例接管该行时的 `unregister`。平台的 disposer 按 id 删预设、完全
     * 不知道自己在删哪份注册，所以接管方 `register` 之后再落进来一次调用，
     * 就会删掉接管方（TAKER）的预设——这正是死实例越界掏空活实例的路径。
     *
     * 单飞（single-flight）补上了身份检查补不上的时序漏洞：两个调用方同时
     * 请求时，第二次拿到的是同一个 promise，不是第二次平台调用。
     *
     * 一次性（`makeRetirement`）补的是另一半：失败之后槽位**不再清空**，所以
     * 下一轮拿到的是同一个失败的 promise，而不是第二次平台调用——那一次在
     * 宿主侧只会空转并 resolve，把一次空转记成成功（R6）。
     */
    const { dispose: retire } = makeRetirement(platformDispose);
    /*
     * 一个钩子里干两件事。显而易见的那件：本实例 fiber 消亡时注销预设。
     * 记账的那件：把我们自己的条目从 `REG_STATE.owned` 里移除——且只移除
     * 我们的：孪生实例可能已经换掉了这一行（它的 disposer 在映射表里），
     * 本实例死亡不得抹掉替换者的记录。没有这次清理，幸存的孪生实例会
     * 一直跳过一个注册刚随死 fiber 消失的 id，每个会话都会用平台兜底
     * 回答，直到手动刷新。
     *
     * 替换的情形绝不能 dispose。接管该行的路上会跑本实例的 disposer（见
     * `unregister`），所以这里的第二次调用不是无害的重复——它是对当前
     * 持有该 id 者的一次删除。身份就是全部守卫。
     *
     * 与 `unregister` 的契约是「先卸、复核、再清账」（见 `releaseEntry`）：
     * 显式拆除到达这里时，账本里**仍然是这一行**（`current.dispose === retire`），
     * 于是并到同一个 `releasePromise` 上。两条路都不会产生第二次平台调用。
     *
     * **账本里没有这一行时什么也不做（R3）。** 这个分支以前是 `return retire()`
     * ——它假定「行没了 ⇒ 那份注册还是我的」，而这两件事之间没有任何证明：
     *
     *  - 帐本行可以被外力抹掉（孪生实例写过、就地升级共享了同一个对象、D1
     *    时代的残留形状）；
     *  - 而 `retire()` 删的是**注册表里那个 id**，不是「我注册的那一份」——平台
     *    的 disposer 携带不了身份（H1/H2）。行没了、id 又被别人占着时，这一下
     *    删的就是别人的注册，而对方没有任何办法自动恢复（R1b 演示的就是它）。
     *
     * 代价是一座极窄的孤儿窗口：`await registry.register(...)` 返回到
     * `owned.set(...)` 之间，fiber 若恰好在此消亡，钩子看到的是「无行而有注册」，
     * 于是那份注册会留下。按「安全边界优先于自动恢复」，这个代价是接受的
     * ——留下的孤儿是可见的（扫描读到 `Duplicate` 就会提示重启），误删的是
     * 另一个实例正在服务的会话，看不见也修不回来。
     */
    ctx.on("dispose", () => {
      const current = owned.get(id);
      if (current === undefined) return undefined;
      if (current.dispose !== retire) return undefined;
      return releaseEntry(owned, id, current).then((released) => {
        /* `cleanupError` 的日志在 `releaseEntry` 里（每条路径都会走到），这里只补一句「说不清」。 */
        if (!released) ctx.logger?.warn?.(`dsh-waifu-agents: ${id}: ${releaseDiagnostic(current.releaseError)}`);
      });
    });
    owned.set(id, {
      dispose: retire,
      rev: registrationRev(skeleton, body, currentModeOf(), seat),
      applied: instToken,
      epoch: instEpoch,
      /*
       * 这一行登记在**哪个注册表对象**里。复核（`presenceOf`）拿它和当前
       * registry 的身份比值：对不上就不许下结论——那是 R13 的边界，热重载
       * 之后新实例的 `not-found` 不代表旧实例已经摘除。
       */
      registry: registryToken,
      state: "active",
    });
  }

  /**
   * 这个 id 的占用者能否被证明就是本插件？
   *
   * 写于读过平台源码（`dsh-agent-preset-registry`）之后，那份源码曾两次
   * 毙掉之前的回收设计：
   *
   *  - `list()` 的行只带 `id/name/description/order/broken`——注册时的
   *    `plugins` 数组并不暴露，花名册行指纹永远无从命中；
   *  - `register()` 在 id 被占用时抛 `Duplicate agent preset`——它从不
   *    upsert，而幽灵行的 disposer 攥在上一个死掉的实例手里。没有按 id
   *    移除的 API，所以没有什么可以盖注册：幽灵行的唯一解药是重启。
   *
   * 唯一可读的指纹是 `readDocument(id)`，声明背后的组合 YAML：我们的
   * 定义内嵌了以 `PERSONA_PLACEHOLDER` 改写为前缀的人设插件行
   * （`@deepseek-ai/dsh-persona`）——这个组合没有别的东西会注册。特性
   * 探测式：服务面并未在契约上承诺暴露它。
   *
   * 文本来自 `documentText()`，它同时接受服务实际 resolve 出的包装对象
   * 和纯字符串。只读字符串形态曾让这个检查死了一整个发布周期：指纹永远
   * 匹配不上，`ghost` 不可达，每个残留都被报成陌生占用者。
   *
   * 这里识别出的占用者可能是死实例（热重载幽灵行），也可能是活的孪生
   * （宿主在安装/重载期间会重新 apply 插件，两个实例会并存一阵）。共享
   * 的 `REG_STATE.owned` 通常让孪生在任何指控之前先合作，所以走到这个
   * 检查，无论哪种情况都说明占用者早于共享记账——解法相同：重启之后
   * 恰好剩一个实例持有这个 id。
   *
   * @param {string} id
   * @returns {Promise<string | null>} 能证明是我们的，返回面板提示；否则 null
   */
  async function ownGhostNote(id) {
    try {
      if (typeof ctx.agentPresets?.readDocument !== "function") return null;
      const text = documentText(await ctx.agentPresets.readDocument(id));
      if (text === "") return null;
      if (!text.includes("@deepseek-ai/dsh-persona")) return null;
      if (!text.includes(PERSONA_PLACEHOLDER)) return null;
      return "本插件另一个实例仍持有这个 id（热重载或升级期间新旧实例并存），当前实例接不过来；重启 DSH 后只保留一个实例，即可恢复";
    } catch {
      return null;
    }
  }

  /**
   * 注册每个尚未被本实例或其他持有者占用的文件，并重新注册文本自注册
   * 以来变过的那些。
   *
   * 后一半是让「刷新」在编辑之后有意义的关键：只收编新文件的扫描，会让
   * 改过的 wife 一直用旧文本回答到下一次重启，而这正是面板挨骂的那种
   * 意外。
   */
  async function scanOnce() {
    /*
     * 每次重算，绝不累积：一个靠重命名文件化解的冲突，必须停止被上报。
     * `foreign` 是面板指控某行被别的持有者占用前读的证据，一条过期条目
     * 会是修复之后还活着的谎言。
     */
    foreign.clear();
    ghosts.clear();
    const roster = new Map();
    try {
      for (const preset of await ctx.agentPresets.list())
        roster.set(preset.id, preset);
    } catch (error) {
      return {
        added: [],
        reloaded: [],
        skipped: [],
        problems: [`读不到名册：${error.message ?? error}`],
      };
    }
    const added = [];
    const reloaded = [];
    const skipped = [];
    const problems = [];
    const rows = listFiles();
    /*
     * 一次目录读取定下组与组的先后，循环里只查表。排位进 rev，所以「谁被
     * 设成默认」「谁换了组」这类不碰正文的改动也会在下一次扫描时重新注册
     * ——否则新建任务列表的顺序要等到重启才变。
     */
    const seating = seatingOf(rows);
    for (const item of rows) {
      if (!item.idOk) {
        problems.push(
          `${item.id}.md: 文件名不是合法的 preset id（只允许字母、数字、连字符，可以中文）`,
        );
        continue;
      }
      if (item.problems.length > 0) {
        problems.push(`${item.id}.md: ${item.problems.join("；")}`);
        continue;
      }
      const parsed = readPersona(fileFor(item.id));
      if (!parsed.body) {
        problems.push(`${item.id}.md: 正文是空的`);
        continue;
      }
      const rev = registrationRev(
        skeletonFor(parsed.meta, readSkeleton()),
        parsed.body,
        currentModeOf(),
        placementOf(item.id, item, seating),
      );
      /*
       * 下方所有分支共用的一道守卫：一个正在注册途中的 id（由本扫描在
       * 循环更早处、由并发 op、或由孪生实例的扫描造成——锁存在共享的
       * `registering` 映射里）按定义就是我们自己的。把这个空窗读成冲突，
       * 面板曾因此指控一个 wife 偷了她自己的 id。
       */
      if (registering.has(item.id)) continue;
      const owner = owned.get(item.id);
      if (owner !== undefined) {
        const mine = owner.applied === instToken;
        /*
         * `releasing` 在飞：这批行是循环外取的花名册快照对应的账本，而释放
         * 正拿着同一个 id 在等宿主。再发一次请求没有意义（`releaseEntry` 会
         * 并到同一个 promise），扫描也不该等它——等就等于把整条 `scans` 链
         * 押在别人的释放上（R7 的形态）。
         */
        if (owner.state === "releasing") continue;
        /*
         * `unknown`：上一次释放既没拿到 `absent`、也没能证明这一行不是我们的。
         * 不许自动注销（那要再动一次 disposer，而它已经花掉了），不许强制
         * 接管（会在一个可能还活着的注册上再注册一次）。
         *
         * 唯一的出口是**重新问一次注册表**：`presenceOf` 只读 `definitions`，
         * 不发平台调用，所以问多少次都不会再碰那枚花掉的 disposer。问到了
         * `absent` 才算拿到结论——账本行这时才可以清，然后照常接回来。
         * 看不清就继续留着，把话说清楚，出口留给人（改名、或重启）。
         */
        if (owner.state === "unknown") {
          const presence = await presenceOf(item.id, owner.registry);
          if (presence !== "absent") {
            problems.push(
              `${item.id}: ${releaseFailure()}${
                owner.releaseNote === undefined ? "" : `（${owner.releaseNote}）`
              }`,
            );
            continue;
          }
          if (owned.get(item.id) === owner) owned.delete(item.id);
          holdRegistration(item.id);
          try {
            await registerOne(item.id, parsed.meta, parsed.body, seating);
            reloaded.push(item.id);
          } catch (error) {
            problems.push(`${item.id}: ${error.message ?? error}`);
          } finally {
            releaseRegistration(item.id);
          }
          continue;
        }
        /*
         * 三个问题，三个回答：
         *
         *  - 我们的、文本相同、花名册一致 → 无事可做。
         *  - 有更新（NEWER）的实例写过它 → 不要碰。在这里接管该行就是乒乓
         *    球：两个活实例各自刷新、各自看到外来 token、各自重新注册，
         *    disposer 永远易手。
         *  - 我们的但过期了，或属于更旧（OLDER）实例的 → 重建。重建是更新
         *    实例在旧实例还活着时成为持有者的方式，这样旧实例的 fiber 日后
         *    死亡时什么也带不走。
         *
         * 没有数字 `epoch` 的行早于这套排序（就地升级保留了共享对象）。它
         * 被当作更旧的——写下它的代码运行在一个比我们更早 apply 的实例里
         * ——而接管本身依然安全：`unregister` 只从账本删除这一个 id，只
         * dispose 这个 id 的注册，其余的行一概不动。
         */
        if (mine && owner.rev === rev && roster.has(item.id)) continue;
        if (!mine && typeof owner.epoch === "number" && owner.epoch >= instEpoch)
          continue;
        /*
         * rev 检查需要花名册的背书。孪生实例死后，它按 id 的 dispose 钩子
         * 会删掉共享记录——但如果一次扫描恰好溜进了注册表行消失与那次
         * 清理之间（或垂死 fiber 的卸载还在飞行中），`owned` 里就躺着一行
         * 注册表里已经没有的行。只看 rev 就跳过，会让这个 wife 一直处于
         * 未注册状态直到手动刷新；要求花名册行在场，就把这个空窗变成一次
         * 平常的重载。
         */
        holdRegistration(item.id);
        try {
          const released = await unregister(item.id);
          /*
           * `foreign` 是「行在我读它之后被别人换掉了」——没有可释放的东西，
           * 接着注册是对的。其余 `false` 只有一个来源：`unknown`，那时候
           * 重新注册就是在赌，赌输的代价是一份活着的注册变成孤儿。
           */
          if (!released.ok && released.state !== "foreign") {
            problems.push(`${item.id}: ${releaseFailure()}`);
            continue;
          }
          if (released.ok && released.state === "cleanupError") {
            problems.push(`${item.id}: ${cleanupFailure()}`);
          }
          await registerOne(item.id, parsed.meta, parsed.body, seating);
          reloaded.push(item.id);
        } catch (error) {
          problems.push(`${item.id}: ${error.message ?? error}`);
        } finally {
          releaseRegistration(item.id);
        }
        continue;
      }
      if (roster.has(item.id)) {
        /*
         * 被占用，且不是本实例注册的任何东西。平台拒绝重复注册（从不
         * upsert）也没有移除 API，所以没有任何安全的尝试可做——扫描的
         * 全部职责是说清是谁占着：是我们热重载的幽灵行（重启即清），还是
         * 真正的陌生人（重命名文件）。
         */
        const ghostNote = await ownGhostNote(item.id);
        if (ghostNote !== null) {
          ghosts.add(item.id);
          foreign.add(item.id);
          skipped.push({ id: item.id, reason: ghostNote });
          continue;
        }
        foreign.add(item.id);
        skipped.push({ id: item.id, reason: "已经有人注册了这个 id" });
        continue;
      }
      holdRegistration(item.id);
      try {
        await registerOne(item.id, parsed.meta, parsed.body, seating);
        added.push(item.id);
      } catch (error) {
        /*
         * 这里的重复意味着在花名册读取与本次注册之间冒出了占用者——共享
         * 状态和扫描互斥本应防住的孪生/幽灵行形态，在它们的最后关头被
         * 抓个正着。如果组合指纹证明占用者可证明是本插件，就按它本来的
         * 身份报告为已识别的幽灵行，而不是抛给用户一个无从下手的裸
         * 「Duplicate agent preset」。
         */
        const ghostNote = await ownGhostNote(item.id);
        if (ghostNote !== null) {
          ghosts.add(item.id);
          foreign.add(item.id);
          skipped.push({ id: item.id, reason: ghostNote });
        } else {
          problems.push(`${item.id}: ${error.message ?? error}`);
        }
      } finally {
        releaseRegistration(item.id);
      }
    }
    // 花名册读得到，且每个文件都走了一遍：`owned` 从「还没有」变成了一个
    // 答案，面板因此才画得出「未注册」。
    markScanned();
    return { added, reloaded, skipped, problems };
  }

  /**
   * 任何人跑扫描的唯一入口：排在其他所有扫描之后，横跨本插件所有活跃的
   * apply()（链在 `REG_STATE` 里）。
   *
   * 一次扫描的决策横跨多个 await——花名册读取、每一次注册——所以两个
   * 重叠的扫描即使各自内部一致，读/注册窗口也会交错。全新安装时，启动
   * 扫描与重载触发的 re-apply 扫描可能对同一个 id 都看到空花名册、都去
   * 尝试注册；败者的「Duplicate agent preset」就是面板显示的 同名 Id
   * 失败。串行化让第二次扫描成为空转而非竞争者：轮到它时花名册已经带上
   * 第一次扫描的行，`owned`（共享）写明了它们的持有者。
   *
   * 失败的扫描不得毒化链，所以链里存一个已 settle 的吞异常 promise，而
   * 调用方仍拿到真实结果。
   */
  function scan() {
    const run = REG_STATE.scans.then(
      () => scanOnce(),
      () => scanOnce(),
    );
    REG_STATE.scans = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * 下一个会话实际会用的那个 wife。
   *
   * 花名册是权威，但服务在不止一个表面上暴露它，而这些表面不可互换：
   *   - `remoteExportList()` 返回 `AgentPresetRow`，文档写明
   *     `isDefault: boolean`（「是默认时会被标记」）；
   *   - `compositionInventory()` 返回 `AgentPresetComposition`，同样声明
   *     `isDefault: boolean`；
   *   - `list()` 返回 `AgentPreset`，其形态根本没有承诺携带这个标志。
   * 所以按这个顺序探测全部三个面，取第一个有回答的。只信 `list()` 正是
   * 面板丢掉选中行的原因。
   *
   * `source` 是第一个真正返回了行的面，正是它把「没有人是默认」和
   * 「这个面不报告默认」区分开。
   *
   * @returns {Promise<{ id: string | null, source: string | null, error: string | null }>}
   */
  async function readDefaultId() {
    let source = null;
    // settings 面上所见的显式 `selectedDefault`：字符串，或刻意未设时的
    // `null`。`undefined` 意味着这个 profile 上没有任何面能表达这层差异，
    // 写入方据此判断一次 CLEAR（清除）究竟可不可检查。
    let field;
    const failures = [];
    // 本面板要写（WRITE）的那个字段，先读回。`selectedDefault` 是注册表
    // 给新会话真正挂载的东西，所以改信花名册的 `isDefault`，正是开关与
    // 高亮边框各说各话的原因：面板写了一个字段、显示了另一个。
    try {
      const settings = ctx.get("settings");
      const described =
        settings === undefined || settings === null
          ? null
          : settings.describe?.();
      if (Array.isArray(described)) {
        if (source === null) source = "settings";
        for (const row of described) {
          if (oneLine(row?.ns) !== REGISTRY_NS) continue;
          const picked = oneLine(row?.value?.selectedDefault);
          field = picked === "" ? null : picked;
          if (picked !== "")
            return { id: picked, source: "settings", error: null, field };
          break;
        }
        // 兼容网：注册表是唯一声明这个字段的行，但部署若挪走了它，也不能
        // 丢掉默认。
        for (const row of described) {
          const picked = oneLine(row?.value?.selectedDefault);
          if (picked !== "")
            return { id: picked, source: "settings", error: null, field: picked };
        }
      }
    } catch (error) {
      failures.push(`settings: ${error?.message ?? error}`);
    }
    for (const [face, read] of [
      [
        "remoteExportList",
        async () => (await ctx.agentPresets.remoteExportList?.())?.presets,
      ],
      [
        "compositionInventory",
        async () => await ctx.agentPresets.compositionInventory?.(),
      ],
      ["list", async () => await ctx.agentPresets.list?.()],
    ]) {
      try {
        const rows = await read();
        if (!Array.isArray(rows)) continue;
        if (source === null) source = face;
        const hit = rows.find((row) => row?.isDefault === true);
        if (hit !== undefined && typeof hit.id === "string" && hit.id !== "") {
          return { id: hit.id, source: face, error: null, field };
        }
      } catch (error) {
        failures.push(`${face}: ${error?.message ?? error}`);
      }
    }
    return {
      id: null,
      source,
      error: failures.length > 0 ? failures.join("；") : null,
      field,
    };
  }

  /**
   * 面板状态。`defaultId` 来自活花名册而非配置文件：`selectedDefault` 可能
   * 过期，或指向一个已解析不出的预设，而真正决定下一个会话的是花名册。
   *
   * 打开面板也是一个修复点——见 `reconcileDefault`，它在这里先跑。一个
   * 什么也不指的默认不只是显示错误：注册表会以 `agent-preset/not-found`
   * 拒绝每一个新会话，所以面板只报告不修复，等于报告一个坏掉的应用。
   */
  async function status() {
    const healed = await reconcileDefault();
    // 取活的，不直接取缓存：`selectedDefault` 可能过期或指向解析不出的
    // 预设，而真正决定下一个会话的是花名册。报缓存 id 的结果，就是默认的
    // 高亮边框停在用户早已移开的行上。
    await refreshDefault();
    const skeleton = readSkeleton();
    return {
      ok: true,
      dir,
      dirSource,
      writable,
      dirExists: fs.existsSync(dir),
      template: templatePath,
      configurable: Boolean(ctx.get("configEditor")),
      /*
       * 聊天或工具全开。面板由此画出一个开关，团队预设按构造忽略它
       * （`templateRowsFor("team")`）。
       */
      mode: currentModeOf(),
      modes: MODES,
      defaultId: defaultCache().id,
      defaultSource: defaultCache().source,
      defaultError: defaultCache().error,
      /*
       * 修复做了什么，仅在用户必须知道的那一种情形里：他们设的默认没了。
       * 没有可修的东西时是 `null`。`ok: false` 是降级路径，必须可见——
       * 什么也不指的默认仍然挡着每个新会话，这里的静默失败看起来会和它
       * 本要修的 bug 一模一样。
       */
      defaultHeal:
        healed.healed !== null
          ? {
              ok: true,
              from: healed.healed,
              nowDefault: healed.nowDefault ?? null,
              moved: healed.moved ?? [],
            }
          : healed.from === undefined
            ? null
            : { ok: false, from: healed.from, reason: healed.reason },
      skeleton: {
        present: skeleton !== null,
        file: skeleton === null ? path.join(dir, SKELETON_FILE) : skeleton.file,
        chars: skeleton === null ? 0 : skeleton.chars,
        slots:
          skeleton === null ? 0 : skeleton.text.split("[[body]]").length - 1,
        rev: skeleton === null ? null : skeleton.rev,
      },
      owned: [...owned.keys()].sort(),
      files: listFiles(),
    };
  }

  /** 编辑器填表所需的一切——外加保存时递回来的 token。 */
  function readOne(request) {
    const id = String(request.id ?? "").trim();
    if (!ID_OK.test(id))
      return { ok: false, error: `id 不合法：${id || "(空)"}` };
    const full = fileFor(id);
    if (!fs.existsSync(full))
      return { ok: false, error: `文件不存在：${full}` };
    const parsed = readPersona(full);
    const name = oneLine(parsed.meta.name) || id;
    const skeleton = skeletonFor(parsed.meta, readSkeleton());
    const poured = assemble(
      name,
      parsed.body,
      skeleton === null ? null : skeleton.text,
    );
    return {
      ok: true,
      id,
      name,
      order: normalizeOrder(parsed.meta.order) ?? null,
      description: oneLine(parsed.meta.description) || "",
      group: oneLine(parsed.meta.group) || "",
      template: oneLine(parsed.meta.template) || "",
      body: parsed.body,
      chars: parsed.chars,
      charsFull: poured.text.length,
      problems: poured.problems,
      skeletonChars: skeleton === null ? 0 : skeleton.chars,
      rev: parsed.rev,
      mtimeMs: parsed.mtimeMs,
      size: parsed.size,
      file: full,
      // 组装后的提示词，只给开口要的读者。编辑器频繁打开行、从来用不上
      // 它——`charsFull` 已经回答了「这会有多长」——而预览窗口只要这
      // 整个、别无其他。让每个 `get` 都带着它，等于把每次点击的载荷抬到
      // 那个唯一读它的按钮的花名册载荷。
      ...(request.assembled === true ? { assembled: poured.text } : null),
    };
  }

  /** 在碰磁盘之前就拒绝：另一个持有者已经占了这个 id。 */
  async function ensureFree(id) {
    if (owned.has(id)) return null;
    try {
      const taken = new Set(
        (await ctx.agentPresets.list()).map((preset) => preset.id),
      );
      if (taken.has(id))
        return `${id} 已经被别的所有者注册，dsh-waifu-agents 不接管它`;
    } catch {
      // 花名册读不到：让 `register` 自己去报重复。
    }
    return null;
  }

  async function create(request) {
    if (!writable) return readOnly();
    const id = String(request.id ?? "").trim() || idForName(request.name);
    if (!ID_OK.test(id)) {
      return {
        ok: false,
        error: `id 不合法（只允许字母、数字、连字符，可以中文）：${id}`,
      };
    }
    if (reserved(id))
      return { ok: false, error: `「${id}」是保留名字，扫描时会跳过它` };
    const full = fileFor(id);
    if (fs.existsSync(full))
      return { ok: false, error: `已经有一个 wife 用这个 id 了：${id}` };
    const body = String(request.body ?? "").trim();
    if (!body) return { ok: false, error: "「回答方式」不能为空" };
    const available = readSkeleton();
    const order = normalizeOrder(request.order) ?? nextOrder();
    const meta = {
      name: request.name,
      order,
      description: request.description,
      group: request.group,
      // 新人设加入共享骨架（如果存在），这样「只写她的性格」就是默认，
      // 而不是一件需要记住的事。
      template:
        request.template ?? (available === null ? undefined : SKELETON_FILE),
    };
    const templateIssue = templateProblem(meta);
    if (templateIssue !== null) return { ok: false, error: templateIssue };
    const skeleton = skeletonFor(meta, available);
    const poured = assemble(
      oneLine(meta.name) || id,
      body,
      skeleton === null ? null : skeleton.text,
    );
    if (!poured.ok) return { ok: false, error: poured.problems.join("；") };
    const conflict = await ensureFree(id);
    if (conflict !== null) return { ok: false, error: conflict };
    writeAtomic(full, renderPersona({ ...meta, body }));
    holdRegistration(id);
    try {
      await registerOne(id, meta, body);
    } catch (error) {
      try {
        fs.unlinkSync(full);
      } catch {
        // 尽力而为：一个孤儿文件在 `list` 里仍然可见。
      }
      return {
        ok: false,
        error: `注册失败（文件已回滚）：${registrationFailure(error)}`,
      };
    } finally {
      releaseRegistration(id);
    }
    /*
     * 新写下的人设可能带来一个新的组名，而组与组的先后是全体共享的：
     * 新组插进字母序中间，别的组的名次就变了。排位进了 rev，所以一次
     * 后台扫描正好重建那些受影响的行——不等它，新建的响应不该为排序拖延。
     */
    void scan().catch(() => {});
    return {
      ok: true,
      id,
      order,
      rev: revision(fs.readFileSync(full, "utf8")),
      file: full,
    };
  }

  /**
   * 编辑一个 wife。id 不可见，所以文件跟着显示名走：改名会把 `<old>.md`
   * 挪到新名字的 slug 上，重指默认并以新 id 重新注册。其余改动原地写入。
   *
   * `idForName` 被传入 `self`，让当前文件留在碰撞集之外：否则保存一个没
   * 改过的名字会撞上它自己的文件，把 wife 分叉到 `name-2` 上。
   */
  async function update(request) {
    if (!writable) return readOnly();
    const id = String(request.id ?? "").trim();
    if (!ID_OK.test(id))
      return { ok: false, error: `id 不合法：${id || "(空)"}` };
    const full = fileFor(id);
    if (!fs.existsSync(full))
      return { ok: false, error: `文件不存在：${full}` };
    const original = fs.readFileSync(full, "utf8");
    const current = readPersona(full);
    /*
     * 乐观锁。外部编辑器（或另一个窗口里的本面板）可能在调用方读取之后
     * 换掉了文件，而调用方的草稿是按旧文本写的——保存它会悄悄抹掉另一个
     * 写入者放进来的东西。拒绝是唯一诚实的回答。
     */
    const expected = String(request.rev ?? "").trim();
    if (expected !== "" && expected !== current.rev) {
      return {
        ok: false,
        conflict: true,
        rev: current.rev,
        error:
          `${id}.md 在磁盘上变过（外部编辑器或另一个窗口改过），这次保存没有写入。` +
          "重新打开这一行看一遍，再把两边的改动合并。",
      };
    }
    const next = {
      name:
        request.name !== undefined
          ? oneLine(request.name)
          : oneLine(current.meta.name),
      order:
        request.order !== undefined
          ? normalizeOrder(request.order)
          : normalizeOrder(current.meta.order),
      description:
        request.description !== undefined
          ? oneLine(request.description)
          : oneLine(current.meta.description),
      group:
        request.group !== undefined
          ? oneLine(request.group)
          : oneLine(current.meta.group),
      template:
        request.template !== undefined
          ? oneLine(request.template)
          : oneLine(current.meta.template),
      body: request.body !== undefined ? String(request.body) : current.body,
    };
    if (!next.body.trim()) return { ok: false, error: "「回答方式」不能为空" };
    const templateIssue = templateProblem(next);
    if (templateIssue !== null) return { ok: false, error: templateIssue };
    const skeleton = skeletonFor(next, readSkeleton());
    const poured = assemble(
      oneLine(next.name) || id,
      next.body,
      skeleton === null ? null : skeleton.text,
    );
    if (!poured.ok) return { ok: false, error: poured.problems.join("；") };
    // 清空名字不得挪动任何东西：`idForName('')` 回答 `persona`，而空字段
    // 不是把文件改名为它的指令。这一行随即回落为显示 id，就像没有名字的
    // 文件那样。
    const to = next.name === "" ? id : idForName(next.name, id);
    const moved = to !== id;
    const target = moved ? fileFor(to) : full;
    if (moved && fs.existsSync(target))
      return { ok: false, error: `已经有一个 wife 用这个文件名了：${to}` };
    const conflict = await ensureFree(to);
    if (conflict !== null) return { ok: false, error: conflict };
    // 先挪，后写：任一时刻存在的文件都是二者之一，绝不会是两者的半成品
    // 合体。
    if (moved) fs.renameSync(full, target);
    writeAtomic(target, renderPersona(next));
    /*
     * 两个 id 都在交换期间被持有。旧 id 在上面的 `renameSync` 之前仍是文件
     * 的名字，新 id 是从那一刻起花名册读到的名字——而两者都不在 `owned`
     * 里，因为平台一次只知道一份注册。这正是面板曾误读成
     * 「被别的所有者占用了」的窗口。
     */
    holdRegistration(id);
    holdRegistration(to);
    /*
     * 分两步记下失败发生在哪一段：注销还是注册。两者的下一步不一样——注销
     * 拿到了 `unknown` 时旧注册可能还活着，补注册必然撞 `Duplicate`；注册
     * 失败时旧注册已经卸掉了，必须补回来，否则那一行到下次刷新前都是空的。
     *
     * `cleanupError` 不算注销失败：注册**确实**摘掉了，只是宿主那边的资源
     * 清理报了错。停在这里什么也不做，反而会把一个可以继续的状态当成坏的。
     */
    let stage = "release";
    let releaseProblem = null;
    try {
      const released = await unregister(id);
      if (!released.ok && released.state !== "foreign") {
        stage = "release";
        releaseProblem = releaseFailure();
      } else {
        stage = "register";
        await registerOne(to, next, next.body);
      }
      if (releaseProblem !== null) throw new Error(releaseProblem);
    } catch (error) {
      if (moved) {
        try {
          fs.rmSync(target, { force: true });
        } catch {
          // 新名字下残留的文件在 `list` 里仍然可见。
        }
      }
      writeAtomic(full, original);
      if (!owned.has(id)) {
        try {
          await registerOne(id, current.meta, current.body);
        } catch {
          // 无论如何文本都在磁盘上；缺一份注册，刷新一下就能补上。
        }
      }
      return {
        ok: false,
        error:
          stage === "release" && releaseProblem !== null
            ? `注销失败（文件已还原，点刷新可重试）：${releaseProblem}`
            : `注册失败（文件已还原，点刷新可重试）：${registrationFailure(error)}`,
      };
    } finally {
      releaseRegistration(id);
      releaseRegistration(to);
    }
    const defaultFollowed = moved ? await repointDefault(id, to) : "unchanged";
    /*
     * 换了组就换了排位，而组的名次是全体共享的（新组名会挤动别的组）。
     * 一次后台扫描把受影响的行重建；组没变时它什么也不做。
     */
    if (oneLine(next.group) !== oneLine(current.meta.group)) void scan().catch(() => {});
    return {
      ok: true,
      id: to,
      previousId: id,
      moved,
      order: normalizeOrder(next.order) ?? null,
      rev: revision(fs.readFileSync(target, "utf8")),
      file: target,
      defaultFollowed,
    };
  }

  /** id 本身就是身份，所以改名意味着挪文件。 */
  async function rename(request) {
    if (!writable) return readOnly();
    const from = String(request.id ?? "").trim();
    const to = String(request.to ?? "").trim();
    if (!ID_OK.test(from))
      return { ok: false, error: `原 id 不合法：${from || "(空)"}` };
    if (!ID_OK.test(to)) {
      return {
        ok: false,
        error: `新 id 不合法（只允许字母、数字、连字符，可以中文）：${to || "(空)"}`,
      };
    }
    if (reserved(to))
      return { ok: false, error: `「${to}」是保留名字，扫描时会跳过它` };
    if (from === to) return { ok: true, id: to, unchanged: true };
    const fromFile = fileFor(from);
    const toFile = fileFor(to);
    if (!fs.existsSync(fromFile))
      return { ok: false, error: `文件不存在：${fromFile}` };
    if (fs.existsSync(toFile))
      return { ok: false, error: `已经有一个 wife 叫 ${to} 了` };
    const conflict = await ensureFree(to);
    if (conflict !== null) return { ok: false, error: conflict };
    const wasOwned = owned.has(from);
    const { meta, body } = parseFrontMatter(fs.readFileSync(fromFile, "utf8"));
    fs.renameSync(fromFile, toFile);
    // 交换期间两个名字都归我们；见 `update` 里的说明。
    holdRegistration(from);
    holdRegistration(to);
    try {
      const released = await unregister(from);
      if (!released.ok && released.state !== "foreign") {
        /*
         * 旧注册此刻说不清（`unknown`），而文件已经改名了。**必须搬回去**：
         * 留着「新名字的文件 + 旧名字的注册」，用户在面板里点旧行拿到的是
         * 空正文（文件不在那里），点新行又打不开（没注册）——两边都是坏的，
         * 而且刷新救不了旧 id（扫描只遍历 `*.md`，孤儿注册再没人回收）。
         *
         * 搬不回去就让 fs 的错误照常冒上去（与下面注册失败那条路一致）：
         * 文件停在新名字上，下一次扫描会把它收编，这比在一个已知损坏的状态
         * 上再叠一次注册安全，也比谎称「已回滚」诚实。
         */
        fs.renameSync(toFile, fromFile);
        throw new Error(releaseFailure());
      }
      try {
        await registerOne(to, meta, body);
      } catch (error) {
        fs.renameSync(toFile, fromFile);
        if (wasOwned) {
          try {
            await registerOne(from, meta, body);
          } catch {
            // 回滚失败仍然让两个文件留在磁盘上、可读。
          }
        }
        return {
          ok: false,
          error: `改名失败（已回滚）：${registrationFailure(error)}`,
        };
      }
    } finally {
      releaseRegistration(from);
      releaseRegistration(to);
    }
    // `selectedDefault` 以 id 存储，所以它必须跟着挪：否则默认指向一个
    // 已不存在的预设，每个新会话都以 `agent-presets/not-found` 失败。
    const defaultFollowed = await repointDefault(from, to);
    /*
     * 记忆库以 id 为键，而 id 就是文件名。没有这一步，旧文件会变成面板
     * 永远展示不了的孤儿，改名后的人设会悄悄什么都记不住。尽力而为：
     * 跑不动的迁移不得让已经成功的改名失败——但会报告，让「她怎么忘了」
     * 有个答案。
     */
    const memory = await migratePersona(personaMemoryDir, from, to);
    await refreshMemorySnapshot();
    return {
      ok: true,
      id: to,
      from,
      order: normalizeOrder(meta.order) ?? null,
      file: toFile,
      defaultFollowed,
      memory,
    };
  }

  /**
   * 让注册表的 `selectedDefault` 跟上一次改名。
   *
   * 尽力而为，与 `setDefault` 一致：没有 `configEditor` 服务就没有可写的
   * 地方，改名不得因此失败。
   *
   * @param {string} from - 默认当前可能指向的 id
   * @param {string} to - 应当改为指向的 id
   * @returns {Promise<'moved' | 'unchanged' | 'unavailable' | 'failed'>}
   */
  async function repointDefault(from, to) {
    const configEditor = ctx.get("configEditor");
    if (configEditor === undefined || configEditor === null)
      return "unavailable";
    let entry;
    try {
      entry = findRegistryEntry(configEditor);
    } catch {
      return "failed";
    }
    if (entry === undefined) return "failed";
    const before = await refreshDefault({ force: true });
    let seen = {};
    try {
      await configEditor.edit(entry, (current) => {
        seen = current ?? {};
        if (seen.selectedDefault !== from) return seen;
        return { ...seen, selectedDefault: to };
      });
    } catch {
      return "failed";
    }
    if (seen?.selectedDefault !== from) return "unchanged";
    /*
     * 与 `setDefault` 同一规则：活注册表认可之后写入才算数。在这里伪造
     * 缓存比在 `setDefault` 里更糟——伪造的 id 活过改名，面板继续把默认
     * 画在旧行上，平台挂载一个已不存在的预设。
     */
    const settled = await verifyDefault(to, {
      previous: before.field,
      checkable: before.field !== undefined,
    });
    if (settled.verified) return "moved";
    // 不可检查的 profile 回落到写入自己的说法，与本 op 在校验存在之前的
    // 行为一致；只有主动与写入相矛盾的面才值得判为失败。
    return settled.checkable ? "failed" : "moved";
  }

  /**
   * 让一个 wife 退场而不丢失她：注销预设，把文件改名为 `<id>.md.off`。
   *
   * 直接删文件无法撤销，而原地放着也不是选项——`scan()` 会重新注册它
   * 找到的每个 `*.md`，留在原地的文件会径直走回花名册。`.off` 后缀在
   * `listFiles()` 和扫描器之外，所以文本留存、wife 离开花名册。把文件改
   * 回 `<id>.md` 即可让她复活。
   */
  async function remove(request) {
    if (!writable) return readOnly();
    const id = String(request.id ?? "").trim();
    if (!ID_OK.test(id))
      return { ok: false, error: `id 不合法：${id || "(空)"}` };
    const full = fileFor(id);
    if (!fs.existsSync(full))
      return { ok: false, error: `文件不存在：${full}` };
    const archived = nextArchiveName(id);
    /*
     * 归档改名期间持有锁：在 `unregister` 与 `renameSync` 之间，文件仍是
     * `<id>.md` 却没有注册护着，这个空窗里的一次花名册读取，曾把
     * 「未注册 · 被别的所有者占用了」画在一个用户刚刚主动归档的 wife 上。
     */
    holdRegistration(id);
    let wasRegistered = false;
    let releaseError = null;
    try {
      /*
       * 注销失败与归档失败要分开：前者文件一个字都没动，可以说「文件内容没有
       * 改动」；后者是磁盘自己的错，那句话就成了谎。两条都照旧冒到 HTTP 层
       * （一次失败的删除不该以 200 回来），只是文案各自归位。
       *
       * 「失败」现在的含义是 **`unknown`**（说不清那一份注册还在不在），不再
       * 是「disposer 抛了」——后者在宿主侧往往已经摘除成功。
       */
      try {
        const released = await unregister(id);
        wasRegistered = released.ok;
        /*
         * 不要在这里再拼一句 `releaseFailure()` 当兜底错误：`unregister` 报
         * `ok:false` 且不是 `foreign` 时只有 `unknown` 一种来源，而下面那行
         * 本来就会把它翻成人话——两处各拼一次，用户读到的是同一句话套自己
         * （「……无法确认是否还挂在 DSH 上。文件没有改动；……。文件没有改动；
         * ……」）。这里只要一个「有失败」的标记。
         */
        if (!released.ok && released.state !== "foreign") releaseError = released.error ?? new Error("unknown");
      } catch (error) {
        releaseError = error;
      }
      if (releaseError === null) fs.renameSync(full, archived);
    } finally {
      releaseRegistration(id);
    }
    if (releaseError !== null) {
      /*
       * 面板只拿人话；原文落日志。`remove` 不经过任何钩子，漏了这一行，
       * `unknown` 唯一的那点证据就彻底没有了（R14）。
       */
      ctx.logger?.warn?.(`dsh-waifu-agents: ${id}: ${releaseDiagnostic(releaseError)}`);
      throw new Error(releaseFailure());
    }
    /*
     * 过去，把默认所指的 wife 退场会让 `selectedDefault` 指向空处，注册表
     * 随后以 `agent-preset/not-found`（`registry.js:643`）拒绝每一个新会话
     * ——于是唯一一个主动移除人设的操作，恰恰也是能弄坏下一个新任务的
     * 操作，而归档文件就摆在那里，仿佛一切安好。`rename()` 跟随 id 已经
     * 有一阵了（`repointDefault`）；remove 却没有这一步。
     *
     * 设计上尽力而为：文件已经归档，不能因配置写入失败而撤销，所以改为
     * 报告结果。
     */
    const dropped = await moveDefaultOff(id);
    const follow =
      dropped.ok === true
        ? { defaultFollowed: "cleared", defaultCleared: true }
        : dropped.skipped === true
          ? { defaultFollowed: "unchanged" }
          : { defaultFollowed: "failed", defaultError: dropped.reason };
    return { ok: true, id, file: full, archived, wasRegistered, ...follow };
  }

  /**
   * 先 `<id>.md.off`，然后 `<id>.md.off.2`、`.3`……归档两次也不会覆写
   * 第一份。朴素的 `<id>.off.md` 是错的：它仍以 `.md` 结尾，扫描器会把它
   * 立刻捡回去。
   */
  function nextArchiveName(id) {
    const first = path.join(dir, `${id}.md.off`);
    if (!fs.existsSync(first)) return first;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = path.join(dir, `${id}.md.off.${n}`);
      if (!fs.existsSync(candidate)) return candidate;
    }
    return path.join(dir, `${id}.md.off.${Date.now()}`);
  }

  /** `<id>.md.off`、`<id>.md.off.2`……花名册看不见的一切。 */
  function hiddenList() {
    if (!fs.existsSync(dir)) return { ok: true, files: [] };
    const files = [];
    for (const entry of fs.readdirSync(dir).sort()) {
      const match = /^(.*)\.md\.off(?:\.(\d+))?$/.exec(entry);
      if (match === null) continue;
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      files.push({
        id: match[1],
        archived: entry,
        seq: match[2] === undefined ? 1 : Number(match[2]),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { ok: true, files };
  }

  /**
   * 把一个隐藏的 wife 请回来：挑一个空闲 id，把归档改名为 `<id>.md`，然后
   * 重新注册她。
   *
   * 挑 id 是人类容易搞砸的部分。`<id>.md` 可能已属于一个复用了名字的
   * 更新的 wife，归档得落到 `<id>-2.md` 上，而不是把她盖掉。
   */
  async function restore(request) {
    if (!writable) return readOnly();
    const archived = path.basename(String(request.archived ?? "").trim());
    if (archived === "" || !/\.md\.off(?:\.\d+)?$/.test(archived)) {
      return { ok: false, error: `不是归档文件：${archived || "(空)"}` };
    }
    const source = path.join(dir, archived);
    if (!fs.existsSync(source))
      return { ok: false, error: `归档不存在：${source}` };
    const base = archived.replace(/\.md\.off(?:\.\d+)?$/, "");
    const id = fs.existsSync(fileFor(base)) ? idForName(base) : base;
    if (!ID_OK.test(id))
      return { ok: false, error: `恢复不了：「${base}」不是合法的 id` };
    const target = fileFor(id);
    if (fs.existsSync(target))
      return { ok: false, error: `已经有一个 wife 用这个 id 了：${id}` };
    const parsed = readPersona(source);
    const templateIssue = templateProblem(parsed.meta);
    if (templateIssue !== null) return { ok: false, error: templateIssue };
    const skeleton = skeletonFor(parsed.meta, readSkeleton());
    const meta = { ...parsed.meta, name: oneLine(parsed.meta.name) || id };
    const poured = assemble(
      meta.name,
      parsed.body,
      skeleton === null ? null : skeleton.text,
    );
    if (!poured.ok) return { ok: false, error: poured.problems.join("；") };
    fs.renameSync(source, target);
    holdRegistration(id);
    try {
      await registerOne(id, meta, parsed.body);
    } catch (error) {
      fs.renameSync(target, source);
      return {
        ok: false,
        error: `恢复失败（已放回归档）：${error.message ?? error}`,
      };
    } finally {
      releaseRegistration(id);
    }
    return { ok: true, id, archived, file: target, renamed: id !== base };
  }

  /**
   * 一个动作作用于多个 wife。每一项都走同一条单项代码路径，单项失败按项
   * 报告而不是中止整批：半途而废的批次会让调用方说不清发生了什么。
   */
  async function batch(request) {
    const action = String(request.action ?? "").trim();
    const ids = Array.isArray(request.ids)
      ? request.ids
          .map((value) => String(value ?? "").trim())
          .filter((value) => value !== "")
      : [];
    const archived = Array.isArray(request.archived)
      ? request.archived
          .map((value) => String(value ?? "").trim())
          .filter((value) => value !== "")
      : [];
    const results = [];
    if (action === "hide") {
      if (ids.length === 0) return { ok: false, error: "没有选中任何东西" };
      for (const id of ids) {
        const payload = await remove({ id });
        results.push({
          key: id,
          ok: payload.ok === true,
          error: payload.ok === true ? null : payload.error,
        });
      }
      return { ok: true, action, results };
    }
    if (action === "restore") {
      if (archived.length === 0)
        return { ok: false, error: "没有选中任何归档" };
      for (const name of archived) {
        const payload = await restore({ archived: name });
        results.push({
          key: name,
          ok: payload.ok === true,
          error: payload.ok === true ? null : payload.error,
        });
      }
      return { ok: true, action, results };
    }
    if (action === "group" || action === "order") {
      if (ids.length === 0) return { ok: false, error: "没有选中任何东西" };
      const group =
        request.group === undefined ? undefined : oneLine(request.group);
      let order = normalizeOrder(request.order);
      for (const id of ids) {
        const payload =
          action === "group"
            ? await update({
                id,
                group,
                rev: request.revs === undefined ? undefined : request.revs[id],
              })
            : await update({
                id,
                order,
                rev: request.revs === undefined ? undefined : request.revs[id],
              });
        results.push({
          key: id,
          ok: payload.ok === true,
          error: payload.ok === true ? null : payload.error,
        });
        if (
          payload.ok === true &&
          action === "order" &&
          typeof order === "number"
        )
          order += 1;
      }
      return { ok: true, action, results };
    }
    return {
      ok: false,
      error: `不认识的批量动作：${action || "(空)"}（可用：hide / restore / group / order）`,
    };
  }

  /** 面板视角下的共享骨架：原文、槽位数、校验。 */
  function skeletonOp() {
    const skeleton = readSkeleton();
    if (skeleton === null) {
      return {
        ok: true,
        present: false,
        file: path.join(dir, SKELETON_FILE),
        chars: 0,
        slots: 0,
        rev: null,
        text: "",
        problems: [],
      };
    }
    const slots = skeleton.text.split("[[body]]").length - 1;
    const problems = [];
    if (slots !== 1)
      problems.push(
        slots === 0 ? "骨架里没有 [[body]]" : `骨架里有 ${slots} 个 [[body]]`,
      );
    for (const match of skeleton.text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const variable = match[1].trim();
      if (
        !PROMPT_VARIABLE_NAME.test(variable) ||
        !PROMPT_VARIABLES.has(variable)
      ) {
        problems.push(
          `骨架里的 {{${match[1]}}} 会让整份系统提示词渲染失败：只支持 provider / model / cwd`,
        );
      }
    }
    return {
      ok: true,
      present: true,
      file: skeleton.file,
      chars: skeleton.chars,
      slots,
      rev: skeleton.rev,
      text: skeleton.text,
      problems,
    };
  }

  /**
   * 写共享骨架，然后给所有人重新注册。
   *
   * 改框架就改了每一段组装出的前缀，所以一个保存了却没应用的骨架是两头
   * 不讨好：文件说一套，每个活会话读的是另一套。
   */
  async function setSkeleton(request) {
    if (!writable) return readOnly();
    const text = String(request.text ?? "");
    if (text.trim() === "")
      return { ok: false, error: "骨架不能是空的：要删掉它就直接删文件。" };
    const slots = text.split("[[body]]").length - 1;
    if (slots === 0)
      return {
        ok: false,
        error: "骨架里必须有 [[body]]，否则人设正文没有地方可放",
      };
    if (slots > 1)
      return { ok: false, error: `骨架里有 ${slots} 个 [[body]]，只能有一个` };
    for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const variable = match[1].trim();
      if (
        !PROMPT_VARIABLE_NAME.test(variable) ||
        !PROMPT_VARIABLES.has(variable)
      ) {
        return {
          ok: false,
          error: `骨架里的 {{${match[1]}}} 会让整份系统提示词渲染失败：只支持 provider / model / cwd`,
        };
      }
    }
    const full = path.join(dir, SKELETON_FILE);
    const current = readSkeleton();
    const expected = String(request.rev ?? "").trim();
    if (expected !== "" && current !== null && expected !== current.rev) {
      return {
        ok: false,
        conflict: true,
        rev: current.rev,
        error:
          "骨架在磁盘上变过（外部编辑器改过），这次保存没有写入。重新打开看一遍。",
      };
    }
    const finalText = text.endsWith("\n") ? text : `${text}\n`;
    writeAtomic(full, finalText);
    const result = await scan();
    // 每个人设会话在自己的下一个回合重读骨架——这是按次组装解析文本的
    // 代价——所以这个数字是「谁即将察觉」，恰好就是面板该大声说出的。
    let liveSessions = 0;
    try {
      const registry = ctx.get("agents", false);
      const live = typeof registry?.list === "function" ? registry.list() : [];
      liveSessions = live.filter((agent) => owned.has(anchorOf(agent))).length;
    } catch {
      liveSessions = 0;
    }
    return {
      ok: true,
      liveSessions,
      chars: finalText.length,
      slots,
      rev: revision(finalText),
      reloaded: result.reloaded,
      added: result.added,
      problems: result.problems,
    };
  }

  /**
   * 搜索模型将读到的文本，不外发任何内容。
  /**
   * 搜索模型将读到的文本，不外发任何内容。
   *
   * 面板只收到片段及其出处（共享骨架还是她自己的部分），于是一整个目录
   * 的长人设在浏览器里搜索分文不费。
   */
  function search(request) {
    const needle = String(request.query ?? "").trim();
    if (needle === "")
      return { ok: true, query: needle, hits: [], truncated: false };
    const lower = needle.toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(request.limit ?? 50) || 50));
    const skeleton = readSkeleton();
    const hits = [];
    for (const item of listFiles()) {
      const parsed = readPersona(fileFor(item.id));
      const frame = skeletonFor(parsed.meta, skeleton);
      // 两块分开搜，命中才能说清出处。组装后的文本答不了这个：正文槽位
      // 之后的匹配仍是骨架文本，拿偏移对照槽位会得出相反结论。
      const pieces = [];
      if (frame !== null) pieces.push({ source: "skeleton", text: frame.text });
      pieces.push({ source: "body", text: parsed.body });
      for (const piece of pieces) {
        const haystack = piece.text.toLowerCase();
        let from = 0;
        while (hits.length < limit) {
          const at = haystack.indexOf(lower, from);
          if (at < 0) break;
          const start = Math.max(0, at - 40);
          const end = Math.min(piece.text.length, at + needle.length + 40);
          hits.push({
            id: item.id,
            name: item.name,
            source: piece.source,
            index: at,
            snippet: `${start > 0 ? "…" : ""}${piece.text.slice(start, end)}${end < piece.text.length ? "…" : ""}`,
          });
          from = at + needle.length;
        }
        if (hits.length >= limit) break;
      }
      if (hits.length >= limit) break;
    }
    return { ok: true, query: needle, hits, truncated: hits.length >= limit };
  }

  /**
   * 存一整个 markdown 文件。有 front matter 就照它来，导出的文件原样导回；
   * 没有 front matter 的文件变成一整段回答方式。
   */
  async function importMd(request) {
    const content = String(request.content ?? "");
    if (!content.trim()) return { ok: false, error: "导入的内容是空的" };
    const { meta, body } = parseFrontMatter(content);
    if (!body)
      return { ok: false, error: "这个 md 的 front matter 之后没有内容" };
    const id =
      String(request.id ?? "").trim() || idForName(meta.name || request.name);
    return create({
      id,
      name: meta.name ?? request.name,
      order: meta.order,
      description: meta.description ?? request.description,
      body,
    });
  }

  function exportOne(request) {
    const id = String(request.id ?? "").trim();
    if (!ID_OK.test(id))
      return { ok: false, error: `id 不合法：${id || "(空)"}` };
    const full = fileFor(id);
    if (!fs.existsSync(full))
      return { ok: false, error: `文件不存在：${full}` };
    return {
      ok: true,
      id,
      filename: `${id}.md`,
      content: fs.readFileSync(full, "utf8"),
    };
  }

  /**
   * 每个文件的原文并入一次响应。
   *
   * 为 `/persona` 命令以及对这条路由做脚本的任何东西保留。面板不用它：
   * 一个装着所有正文的 JSON 数组会是这里想避免的多兆字节响应，所以批量
   * 导出走 `exportArchive`（一个 `.zip`、一次下载），单文件走 `export`。
   * 下面的上限就是防止命令路径不小心变成那样：一个没人能触到的上限不叫
   * 上限。
   */
  const EXPORT_ALL_LIMIT = 8 * 1024 * 1024;

  function exportAll() {
    const files = [];
    let total = 0;
    for (const item of listFiles()) {
      const content = fs.readFileSync(fileFor(item.id), "utf8");
      total += Buffer.byteLength(content, "utf8");
      if (total > EXPORT_ALL_LIMIT) {
        return {
          ok: false,
          truncated: true,
          error: `导出全部超过上限（${Math.round(EXPORT_ALL_LIMIT / 1024 / 1024)}MB）：改用逐条导出，或者直接去目录里拿文件。`,
        };
      }
      files.push({ id: item.id, filename: `${item.id}.md`, content });
    }
    return { ok: true, files, bytes: total };
  }

  /**
   * 批量导出为一个归档。
   *
   * 面板过去回答「导出全部」是逐个拉文件、给浏览器每个文件一次下载：
   * 十二个人设意味着十二次保存对话框，而且没有东西阻止它们落进十二个
   * 不同的文件夹。单个 `.zip` 让整批变成一次对话框、一个目的地——没法
   * 告诉浏览器一个目录，所以目录只能靠暗示。
   *
   * `ids` 可选，默认是每个可见文件。隐藏人设（`.md.off`）不包含：它们
   * 不在花名册里，装着它们的归档会复活用户特意收起来的文件。
   */
  /*
   * 16MB 的原始 markdown，塞进一个 JSON 响应的 base64 后约 21MB——单个
   * 回环响应在渲染器开始同时攥着它的三份拷贝（字符串、base64、Blob）
   * 之前，差不多就该到此为止了。这么大的目录是几千个人设；带着数字拒绝
   * 胜过截断。
   */
  const EXPORT_PACK_LIMIT = 16 * 1024 * 1024;

  function exportArchive(request) {
    const asked = Array.isArray(request?.ids) ? request.ids.map((id) => String(id)) : null;
    const ids = asked === null ? listFiles().map((item) => item.id) : asked;
    const entries = [];
    const missing = [];
    let total = 0;
    for (const id of ids) {
      if (!ID_OK.test(id) || !fs.existsSync(fileFor(id))) {
        missing.push(id);
        continue;
      }
      let data;
      try {
        data = fs.readFileSync(fileFor(id));
      } catch {
        missing.push(id);
        continue;
      }
      total += data.length;
      if (total > EXPORT_PACK_LIMIT) {
        return {
          ok: false,
          truncated: true,
          error: `一次导出超过上限（${Math.round(EXPORT_PACK_LIMIT / 1024 / 1024)}MB）：分批导出，或者直接去目录里拿文件。`,
        };
      }
      entries.push({ name: `${id}.md`, data });
    }
    if (entries.length === 0) return { ok: false, error: "没有可导出的文件。" };

    const stamp = new Date();
    const tag = [
      stamp.getFullYear(),
      String(stamp.getMonth() + 1).padStart(2, "0"),
      String(stamp.getDate()).padStart(2, "0"),
    ].join("");
    let archive;
    try {
      archive = buildZip(entries, { date: stamp });
    } catch (failure) {
      return { ok: false, error: String(failure?.message ?? failure) };
    }
    /*
     * 用 base64 而非字节数组：路由回答 JSON，300 个条目的归档写成
     * `[12,34,…]` 会把载荷放大好几倍而毫无收益。面板把它变回 Blob，交给
     * 一次下载。
     */
    return {
      ok: true,
      filename: `waifu-personas-${tag}.zip`,
      count: entries.length,
      bytes: total,
      missing,
      base64: archive.toString("base64"),
    };
  }

  /**
   * 本包附带的那个人设，用户可以本地编辑后导回。
   *
   * 名字刻意不写死。附带文件是真实人设——一旦换人随包，它就会被改名——
   * 而钉死一个名字会把那次改名变成一个只会回答「包内没有模板」的按钮。
   * 所以由目录决定：第一个不是保留名的 `*.md`，而 `RESERVED` 已经列出了
   * 那些保留名（`README.md`、遗留的 `_template.json`）。
   */
  function shippedPersona() {
    const home = path.join(PACKAGE_DIR, "personas");
    let entries;
    try {
      entries = fs.readdirSync(home).sort();
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md") || RESERVED.has(entry.toLowerCase())) continue;
      const full = path.join(home, entry);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // 扫描途中消失的条目不构成让这个 op 失败的理由。
      }
    }
    return null;
  }

  function exportTemplate() {
    const file = shippedPersona();
    if (file === null)
      return {
        ok: false,
        error: `包内 personas/ 里没有可下载的人设文件：${path.join(PACKAGE_DIR, "personas")}`,
      };
    return {
      ok: true,
      filename: path.basename(file),
      content: fs.readFileSync(file, "utf8"),
    };
  }

  /** 通过可选的 configEditor 服务把 `config.dir` 写回去。 */
  async function setDir(request) {
    const configEditor = ctx.get("configEditor");
    if (configEditor === undefined || configEditor === null) {
      return {
        ok: false,
        error:
          "这个环境没有 configEditor 服务，改不了配置；请直接编辑 profile 的补丁文件。",
      };
    }
    const next = String(request.dir ?? "").trim();
    let entry;
    try {
      entry = configEditor
        .entries()
        .find(
          (row) =>
            SELF_IDS.includes(row.id) ||
            row.id === name ||
            row.patchId === name,
        );
    } catch (error) {
      return { ok: false, error: `读不到配置项：${error.message ?? error}` };
    }
    if (entry === undefined)
      return { ok: false, error: `找不到 ${name} 这条配置项` };
    try {
      await configEditor.edit(entry, (current) => {
        const copy = { ...(current ?? {}) };
        if (next) copy.dir = next;
        else delete copy.dir;
        return copy;
      });
    } catch (error) {
      return { ok: false, error: `写入失败：${error.message ?? error}` };
    }
    return {
      ok: true,
      dir: next || null,
      note: "配置已写入；插件会重启并重新扫描目录。",
    };
  }

  /**
   * 在纯聊天与完整工具集之间切换。
   *
   * 写入顺序有讲究。`mode.json` 先落，然后 `scan()`：两者之间崩溃会让
   * 文件说 `chat` 而注册表还揣着旧行，下一次启动读文件并修正注册表。
   * 反过来的顺序会让进程相信一件文件与之矛盾的事。
   *
   * 每个人设都重新注册，因为 `registrationRev` 包含模式；rev 不变的扫描
   * 按设计是空转。团队预设有意跳过——`templateRowsFor("team")` 无视这个
   * 开关，它们的能力列表没有变化。
   */
  async function setMode(request) {
    const requested = String(request?.mode ?? "").trim();
    if (!MODES.includes(requested)) {
      return { ok: false, error: `mode 只能是 ${MODES.join(" / ")}。` };
    }
    const mode = normalizeMode(requested);
    const previous = currentModeOf();
    if (mode !== previous) {
      setCurrentMode(mode);
      try {
        writeStoredMode(mode);
      } catch (error) {
        setCurrentMode(previous);
        return {
          ok: false,
          error: `写 ${MODE_FILE} 失败，模式没有改：${error?.message ?? error}`,
        };
      }
      try {
        await scan();
      } catch (error) {
        /*
         * 文件已是事实，报告切换失败就是撒谎——但保持沉默也是撒谎：模型
         * 会一直揣着旧工具集，直到扫描成功。说清哪一半落地了。
         */
        return {
          ok: false,
          mode,
          error: `已写入 ${MODE_FILE}（下次启动生效），但这次重新注册失败：${error?.message ?? error}`,
        };
      }
    }
    /*
     * 运行中的会话，闸门也跟着开关走。
     *
     * `scan()` 重新注册预设，但活的 agent 仍揣着它出生时的工具列表——
     * 重新注册只决定下一个会话挂载什么。没有这一行，切到聊天模式会显示
     * 「已切换」，而每个打开的会话直到重启前都揣着 30 个工具。幂等，所以
     * 切回去同样立即抬起闸门。
     */
    toolFilterOf()?.reconcileAll();
    return {
      ok: true,
      mode,
      changed: mode !== previous,
      state: await status(),
    };
  }

  /*
   * 默认人设住在 `agent-preset-registry` 这个条目上，不在本条目上：
   * `default` 是必需的，而易失的 `selectedDefault` 压过它。官方的
   * agent-preset 设置页写的就是那个字段，本面板也是——两者指向同一处，
   * 所以两个入口不可能各说各话。`default` 本身原样保留作为兜底。
   */
  const REGISTRY_ENTRY_ID = "agent-preset-registry";
  const REGISTRY_PACKAGE = "@deepseek-ai/dsh-agent-preset-registry";

  /**
   * 拥有 `selectedDefault` 的那条 profile 行。
   *
   * `entries()` 交回 Loader 的 `Entry` 对象，其可寻址字段是
   * `options.id` / `options.name` / `options.config`——正是 `dsh-settings`
   * 匹配的形状（它的 `write()` 里是 `row.options.id === ns`）。裸的
   * `row.id` / `row.name` / `row.patchId` 从来不在这个类上，所以它们是
   * 次选：`row.id` 确实存在，但作为一个给所属树加前缀的 getter
   * （`include:agent-preset-registry`），这也是要检查带前缀形式的原因。
   * @param {object} configEditor configEditor 服务
   * @returns {object | undefined} 那个条目；没有匹配时 undefined
   */
  function findRegistryEntry(configEditor) {
    const idsOf = (row) =>
      [row?.options?.id, row?.id].filter((value) => typeof value === "string");
    const namesOf = (row) =>
      [row?.options?.name, row?.name].filter((value) => typeof value === "string");
    return configEditor
      .entries()
      .find(
        (row) =>
          namesOf(row).includes(REGISTRY_PACKAGE) ||
          idsOf(row).includes(REGISTRY_ENTRY_ID) ||
          idsOf(row).includes(`include:${REGISTRY_ENTRY_ID}`) ||
          row?.patchId === REGISTRY_ENTRY_ID,
      );
  }

  /**
   * profile 实际暴露了哪些 id，用于一个人类能据以行动的失败。
   *
   * 一句光秃秃的「找不到 …这条配置项」没法诊断：id 可能被改名，行可能
   * 藏在嵌套 Include 里，或者 profile 干脆没有这个服务能寻址的 loader 树。
   * 报出当时（WAS）在那里的是什么，三种情况都变成一行答案。
   * @param {object} configEditor configEditor 服务
   * @returns {string} 一行文字，绝不抛出
   */
  function describeEntries(configEditor) {
    try {
      const seen = configEditor
        .entries()
        .map((row) => oneLine(row?.options?.id) || oneLine(row?.id) || "?");
      return seen.length === 0 ? "(一个都没有)" : seen.join(" / ");
    } catch (error) {
      return `(读不到：${error?.message ?? error})`;
    }
  }

  /**
   * 按平台自己的方式写注册表的 `selectedDefault`。
   *
   * `Settings → Agent Presets` 经
   * `ctx.remote.settings.update("agent-preset-registry", { selectedDefault })`
   * （`ui-agent-preset`）写入，而不是经 `configEditor.edit`——差别不是
   * 装饰性的。`settings.update()` 以调用 `describe()` 收尾，而 `describe()`
   * 是唯一发出 `settings/document-updated` 的东西。`ui-agent-preset` 给
   * 这个事件只挂了一个监听器：
   *
   *     ctx.remote.$on("settings/document-updated", (ns) => {
   *       if (ns !== "agent-preset-registry") return;
   *       refresh();   // 每个席位：新任务标签、它的设置行、……
   *     })
   *
   * 光秃的 `configEditor.edit()` 把同样的字节落进同一个补丁文件，却什么
   * 也不发，于是应用继续用旧快照回答：面板显示新默认，下一个新任务起的
   * 却是上一个（PREVIOUS），而在 Agent 预设页改同一个字段又一切正常。
   * 那就是「在插件页面更新默认人设后，新对话没有同步；在 Agent 预设里改
   * 就正常」。
   *
   * 经服务路由还免去了对写入的猜测：`settings.write()` 在收尾前自己重读
   * 投影后的形态，所以下游校验器检查的是一个应用已经采纳的值。
   *
   * `configEditor.edit()` 路径保留，作为没有 settings 服务的 profile、或
   * 注册表行无法按条目 id 寻址的 profile 的兜底（`settings.write` 匹配
   * `row.options.id === ns`；`findRegistryEntry` 更宽容，也匹配包名）。
   *
   * @param {{ entry: object, id: string | null }} options `null` 清除字段
   * @returns {Promise<{ ok: true, via: string } | { ok: false, error: string }>}
   */
  async function writeDefault({ configEditor, entry, id }) {
    const settings = serviceOf("settings");
    if (settings !== undefined && typeof settings.update === "function") {
      try {
        if (id === null) {
          await settings.mutate(REGISTRY_NS, [
            { op: "unset", path: ["selectedDefault"] },
          ]);
        } else {
          await settings.update(REGISTRY_NS, { selectedDefault: id });
        }
        return { ok: true, via: "settings" };
      } catch (error) {
        // 注册表行无法按条目 id 寻址的 profile 完全用不了服务。落到下面
        // 的编辑器路径再试——它对行的命名方式更宽容。
        //
        // 把话说出口。这个兜底落下同样的字节、叫不醒任何人，所以它恰好
        // 复现最初的 bug；悄无声息地退化到它，就是一个修复在毫发无损的
        // 表象下不再是修复的方式。
        const viaEditor = await editDefault({ configEditor, entry, id });
        if (viaEditor.ok) {
          ctx.logger?.warn?.(
            `dsh-waifu-agents: settings.update 走不通（${error?.message ?? error}），` +
              `退回配置编辑器写默认——磁盘会变，但平台收不到通知，新任务页可能不跟。`,
          );
          return { ok: true, via: "configEditor" };
        }
        return {
          ok: false,
          error: `${error?.message ?? error}；改用配置编辑器也不行：${viaEditor.error}`,
        };
      }
    }
    const viaEditor = await editDefault({ configEditor, entry, id });
    return viaEditor.ok ? { ok: true, via: "configEditor" } : viaEditor;
  }

  /**
   * `settings` 出现之前的写入路径，仅作兜底保留。
   *
   * 它叫不醒应用——没有 `settings/document-updated`——这正是它不再首选
   * 的原因。它在磁盘上仍然正确。
   *
   * @param {{ configEditor: object, entry: object, id: string | null }} options
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async function editDefault({ configEditor, entry, id }) {
    try {
      await configEditor.edit(entry, (current) => {
        const copy = { ...(current ?? {}) };
        if (id === null) delete copy.selectedDefault;
        else copy.selectedDefault = id;
        return copy;
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * 把默认从一个 id 上挪走，并带走尚未开口的会话。
   *
   * `setDefault` 的对应面，用于所指 id 已不可用的情形。注册表在会话创建
   * 时解析默认——
   * `get defaultId() { return this.config.selectedDefault.get() ?? this.config.default }`
   * （`registry.js:494`）——而当没有任何东西持有它时，`retain()` 抛出
   *
   *     agent-preset/not-found: Unknown agent preset: <id>
   *
   * （`registry.js:643`，`resolve()` 与 `readDocument()` 同）。
   * 所以悬空的默认不是能自愈的显示问题：它挡住每一个新会话，拒绝来自
   * 服务本身，于是合成器的兜底
   * `presets.find(p => p.isDefault)?.id ?? presets[0]?.id`
   * （`ui-agent-preset.js:1263`）根本轮不到运行。
   *
   * 与 `setDefault` 相同的两步、相同的理由：经 settings 服务写、让应用
   * 重读花名册；靠重读（REREAD）确认而不是相信写入；把仍跟着被弃 id 的
   * 空白会话重新安置。
   *
   * @param {string} from 预期默认当前持有的 id
   * @param {{ before?: object }} [context] 调用方已做过的
   *   `refreshDefault({force:true})`，这里不必重读
   * @returns {Promise<{ ok: boolean, reason: string | null, skipped?: boolean,
   *   nowDefault?: string | null, via?: string, moved?: string[], refused?: number }>}
   */
  async function moveDefaultOff(from, context = {}) {
    const wanted = oneLine(from);
    if (wanted === "")
      return { ok: false, skipped: true, reason: "没有指定默认" };
    const before = context.before ?? (await refreshDefault({ force: true }));
    if (oneLine(before.id) !== wanted)
      return { ok: false, skipped: true, reason: "默认已经不是它了" };
    const configEditor = ctx.get("configEditor");
    if (configEditor === undefined || configEditor === null)
      return {
        ok: false,
        reason: "这个环境没有 configEditor 服务，改不了配置。",
      };
    let entry;
    try {
      entry = findRegistryEntry(configEditor);
    } catch (error) {
      return { ok: false, reason: `读不到配置项：${error.message ?? error}` };
    }
    if (entry === undefined)
      return { ok: false, reason: `找不到 ${REGISTRY_PACKAGE} 这条配置项` };
    const written = await writeDefault({ configEditor, entry, id: null });
    if (!written.ok) return { ok: false, reason: `清不掉：${written.error}` };
    const settled = await verifyDefault(null, {
      previous: before.field,
      checkable: before.field !== undefined,
    });
    if (!settled.verified && settled.checkable)
      return {
        ok: false,
        reason: `写进去了，但读回来还是「${settled.id ?? "（没指定）"}」`,
      };
    /*
     * 这个字段决定之后（LATER）创建的会话得到什么；这里决定已经停在新任务
     * 界面上的会话得到什么。没有这一步，空白会话继续揣着其页眉盖章时的
     * 死 id——一个名字指向已不存在 wife 的标签，以及一条因同样原因失败
     * 的创建路径。
     */
    const resettled = await resettleUnstarted({
      to: oneLine(defaultCache().id),
      from: wanted,
    });
    return {
      ok: true,
      reason: null,
      nowDefault: defaultCache().id,
      via: written.via,
      moved: resettled.moved,
      refused: resettled.refused,
    };
  }

  /**
   * 清掉一个指向无人注册的预设的 `selectedDefault`。
   *
   * 由 `status()`（所以打开面板即修复）、启动扫描和 `remove()` 触发。这些
   * 时刻都能看出默认已死，而它造成的失败是本插件能产出的最坏结果：每个
   * 新会话都被 `agent-preset/not-found` 拒绝，UI 里既没有解释、也没有
   * 可以点出去的地方。
   *
   * 它只清空——绝不改指另一个 wife。替用户挑一个人设，是比撤销一个坏掉
   * 的选择更响亮的另一个决定，而字段会回落到 profile 默认。
   *
   * @returns {Promise<{ healed: string | null, from?: string, reason: string | null,
   *   nowDefault?: string | null, moved?: string[], refused?: number, via?: string }>}
   */
  async function reconcileDefault() {
    const before = await refreshDefault({ force: true });
    const picked = oneLine(before.id);
    if (picked === "")
      return { healed: null, reason: "没指定默认" };
    let rows;
    try {
      rows = await ctx.agentPresets.list();
    } catch (error) {
      return { healed: null, reason: `读不到名册：${error?.message ?? error}` };
    }
    if (!Array.isArray(rows)) return { healed: null, reason: "名册没回数组" };
    /*
     * 空花名册是「还没人注册」，不是「谁都指不到」。若在这一行 apply 之后
     * 才注册自己预设的插件，它的默认会无缘无故被清掉——而等待的代价为
     * 零，因为 `status()` 每次打开面板都会重跑这里。
     */
    if (rows.length === 0)
      return { healed: null, reason: "名册还是空的，先不动" };
    if (rows.some((row) => oneLine(row?.id) === picked))
      return { healed: null, reason: "默认指的这个人设还在" };
    const dropped = await moveDefaultOff(picked, { before });
    if (!dropped.ok) {
      // 把话说出口：什么也不指的默认挡住每一个新会话，静默修复失败正是
      // 它从前的样子——什么都没错，直到下一个新任务拒绝打开。
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 默认人设「${picked}」已经不在名册里了（新会话会被 ` +
          `agent-preset/not-found 直接挡掉），可是清不掉它：${dropped.reason}`,
      );
      return { healed: null, from: picked, reason: dropped.reason };
    }
    const now = oneLine(dropped.nowDefault);
    ctx.logger?.warn?.(
      `dsh-waifu-agents: 默认人设「${picked}」已经不在名册里了（新会话会被 ` +
        `agent-preset/not-found 直接挡掉），已清掉这条默认，新会话回落到` +
        `${now === "" ? " profile 默认" : `「${now}」`}` +
        (dropped.moved.length > 0
          ? `，顺手把 ${dropped.moved.length} 个还没开口的会话也挪过去了。`
          : "。"),
    );
    return {
      healed: picked,
      from: picked,
      nowDefault: dropped.nowDefault,
      moved: dropped.moved,
      refused: dropped.refused,
      via: dropped.via,
      reason: null,
    };
  }

  /** 把注册表的 `selectedDefault` 指向一个 wife，或谁也不指。 */
  async function setDefault(request) {
    const id = String(request.id ?? "").trim();
    // 空 id 是「谁都不指定」——设置行的 关掉 按钮和关掉的花名册行发的
    // 正是这个。拒绝它，就是为什么关掉默认后上一行的高亮边框还带着错误
    // 提示留在屏幕上。
    const clearing = id === "";
    if (!clearing && !ID_OK.test(id))
      return { ok: false, error: `id 不合法：${id}` };
    /*
     * 能持有这个字段的预设有两种：人设，和团队——每个团队都注册成 agent
     * preset（`runTeamPresetSync`），这正是它能出现在新会话页上的原因。
     *
     * 要求存在 `.md` 文件让「把这一队设成默认」变得不可能：id 是真的，
     * 注册表持有它，写入却因不指任何文件被拒。`teamPresets` 是那一半的
     * 权威——而不是「团队-」前缀，人设文件也可能合法带着它。
     */
    if (!clearing && !teamPresets.has(id) && !fs.existsSync(fileFor(id)))
      return { ok: false, error: `没有这个人设，也没有这个团队：${id}` };
    const configEditor = ctx.get("configEditor");
    if (configEditor === undefined || configEditor === null) {
      return {
        ok: false,
        error: "这个环境没有 configEditor 服务，改不了默认人设。",
      };
    }
    let entry;
    try {
      entry = findRegistryEntry(configEditor);
    } catch (error) {
      return { ok: false, error: `读不到配置项：${error.message ?? error}` };
    }
    if (entry === undefined)
      return {
        ok: false,
        error: `找不到 ${REGISTRY_PACKAGE} 这条配置项（配置里现在有：${describeEntries(configEditor)}）`,
      };
    const before = await refreshDefault({ force: true });
    /*
     * 经 settings 服务写，好让应用收到通知（见 `writeDefault`）。单靠
     * `configEditor.edit()` 落下值却叫不醒任何人，面板与新任务标签各说
     * 各话就是这么来的。
     */
    const written = await writeDefault({
      configEditor,
      entry,
      id: clearing ? null : id,
    });
    if (!written.ok)
      return { ok: false, error: `写入失败：${written.error}` };
    /*
     * 写入不是事实；重读才是。
     *
     * `configEditor.edit()` 在 Loader 尚未重新激活该行前就收尾了补丁文件，
     * 所以此处立刻发起的读取仍可能答出上一个（PREVIOUS）id。在这时相信
     * 写入，正是面板与平台各说各话的原因：花名册把高亮边框留在用户刚把
     * 默认挪走的那行上，而下一个新任务起的是 profile 默认。所以在说
     * 「已移动」之前，先对照活注册表确认；没移动就大声说出来。
     */
    const wanted = clearing ? null : id;
    const settled = await verifyDefault(wanted, {
      previous: before.field,
      checkable: before.field !== undefined,
    });
    if (!settled.verified && settled.checkable) {
      return {
        ok: false,
        error: `写进去了，但读回来还是「${settled.id ?? "（没指定）"}」——这一行没能生效。再点一次；再不行就是这条配置被别处的 patch 覆盖了（profile 的 cordis.patch.yml 与 home patch / 命令行 --patch）。`,
        id: wanted,
        verified: false,
        checkable: true,
        attempts: settled.attempts,
        defaultId: defaultCache().id,
      };
    }
    /*
     * 写入决定之后（LATER）创建的会话得到什么。这里决定已经在屏幕上的
     * 会话得到什么——即用户操作时看着的那个新任务标签。两者都需要；而
     * 过去只有前者。
     */
    const resettled = await resettleUnstarted({
      to: oneLine(defaultCache().id),
      from: before.id,
    });
    if (resettled.moved.length > 0) {
      ctx.logger?.info?.(
        `dsh-waifu-agents: 默认改成 ${oneLine(defaultCache().id)}，` +
          `顺手把 ${resettled.moved.length} 个还没开口的会话挪过去（${resettled.moved.join("、")}）。`,
      );
    }
    /*
     * 默认人设排在新任务列表的第一格，所以换默认就是换顺序——而顺序是
     * 注册时写死的排序键。排位进了 rev，于是这里只需叫一次扫描：旧默认与
     * 新默认这两行的 rev 变了，扫描只重建这两份注册，其余行空转。
     *
     * 不等它：用户等的是「默认已改」，不是「列表已重排」；扫描失败也只
     * 影响顺序，不影响默认本身，所以不让它挡住这一次成功。
     */
    void scan().catch(() => {});
    return {
      ok: true,
      id: wanted,
      verified: settled.verified,
      // `false` = 这个 profile 既不暴露 `settings` 也不暴露 `isDefault`
      // 标志，所以写入无论哪边都无法确认。面板如实相告，而不是装作读取
      // 也同意了。
      checkable: settled.checkable,
      attempts: settled.attempts,
      // 本次写入提交的锚点，已从活注册表读回。面板在它自己的重读之后
      // 落地它，这样仍答出上一个 id 的 `list` 就没法让用户刚挪开的那行
      // 继续戴着高亮边框。
      defaultId: defaultCache().id,
      defaultSource: defaultCache().source,
      // 写入经由哪条路抵达配置，以及空白会话有没有跟上。两者都是给
      // 「面板与新任务标签仍各说各话」报告的诊断——它们指名缺的是哪
      // 一半。
      via: written.via,
      resettled: resettled.moved,
      resettleSkipped: resettled.reason,
    };
  }

  return {
    batch,
    create,
    exportAll,
    exportArchive,
    exportOne,
    exportTemplate,
    findRegistryEntry,
    hiddenList,
    importMd,
    moveDefaultOff,
    readDefaultId,
    readOne,
    reconcileDefault,
    rememberTeamPreset,
    remove,
    rename,
    repointDefault,
    restore,
    scan,
    search,
    setDefault,
    setDir,
    setMode,
    setSkeleton,
    skeletonOp,
    status,
    syncTeamPresets,
    teamNameForPreset,
    teamPresetIdByName,
    update,
    writeDefault,
  };
}
