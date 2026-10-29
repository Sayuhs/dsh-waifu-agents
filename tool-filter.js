/**
 * dsh-waifu-agents — 运行时工具闸门：把"这个会话一个工具都没有"变成硬事实。
 *
 * ## 为什么注册期删 capability 行不够
 *
 * `chatRows()`（index.js）做的是**注册期**裁剪：它决定这个预设要挂哪些
 * capability 行。它在自己的行里是准的，但它删不掉**别人挂的东西** ——
 * profile 层的 `dsh-base` 早已把工具注册进全局层，而预设行只能追加。
 * 于是"纯聊天"预设的会话照样带着 30 来个工具（实测 30/31），团队会话在
 * 讨论之外的一次普通回合还带着 31/76 个（`.workbuddy/review/token-audit/`
 * 里 `cells.mjs` 的 `request/header` 统计就是这个事实的账）。
 *
 * ## 参考实现：qq-chat 的运行时过滤
 *
 * `qq-agent-presets/qq-tool-restrict.mjs` 是同一问题的既定解法，两层：
 *
 *   1) `ctx.tools.restrict({ ... })` —— 注册期可见性。被 restrict 掉的工具
 *      **不进 schema**，所以模型既看不到也调不到，token 一分不花。
 *   2) `ctx.tools.guard(fn)` —— 执行期单调守卫。返回理由即拒绝，且后续任何
 *      监听器都无法把这条拒绝翻回允许。
 *
 * 它在注释里专门写了"只 guard 不 restrict"为什么不行：guard 只能拒绝**执行**，
 * 工具名仍在 schema 里，既违反"不得拥有该能力"的要求，又会诱导模型去调它。
 * 本文件照抄这个判断，并且**两层都装**。
 *
 * ## 与 qq-tool-restrict 的三处必要差异
 *
 * 1. **它是黑名单，我们是全封**。它要留 `mcp__*` 与 `ask_user_question`；
 *    这里的目标是"一个都没有"，所以用 `restrict({ allow: [] })`。
 *    `allow: []` 不是笔误：`restrict` 只在 `allow`/`deny` **都** 为 undefined
 *    时才报 no-op，空数组是合法的"什么都不放行"。
 * 2. **它按名字逐个 restrict，我们不打名字**。它那份名单要跟着宿主版本对账，
 *    漏一个就静默失效（它自己的注释里有这条教训）。名字一个都不点，就不存在
 *    "名单过期"这回事 —— 新工具一注册就已经被挡住。
 * 3. **作用域是 agent，不是 preset 行**。它作为 preset 行装在 preset 的 scope
 *    里；本插件是 profile 级单例，管着一堆 agent，所以只能在 `agent.ctx` 上调
 *    —— `restrict()` 本身就会拒绝非 scoped 上下文（"a context-global
 *    restriction would mask every agent"）。
 *
 * ## 为什么 restrict 打得到预设行注册的工具
 *
 * 预设行不是注册进 agent 自己的层：`dsh-agent-preset-registry` 用
 * `createScope(owner, key)` 建一个 registry 自己的 scope，再把 agent 的 scope
 * **父链接**过去（`bindScopeParent(agentKey, generationKey)`）。所以那些工具是
 * "祖先贡献"，而 `view(scope)` 的可见性规则是
 * `layers.every(layer => layer.admits(name))` —— agent 自己层上一条
 * `allow: []` 就让整条链一个都不放行。
 *
 * 反过来，**agent 自己层注册的工具不受 restrict 影响**（宿主有意如此：子 agent
 * 的 structured-output 工具就注册在自己的层上）。这正是 guard 存在的第二个理由：
 * 可见性漏掉的东西，执行期还会被拦住。
 *
 * ## 什么时候封、什么时候解
 *
 * 判定不在这里 —— 这里只收一个 `decide(agent) -> { seal, why }`。因为"这个会话
 * 归不归本插件管"（人设行、会话覆盖、团队绑定）是本插件 index.js 的知识，
 * 而这个文件要能在没有宿主的离线自测里跑。
 *
 * 封是**可逆**的：`restrict`/`guard` 都返回精确的 disposer，`reconcile()` 只
 * 在"该封却没封 / 不该封却封着"时动手，所以每轮都调也不会抖（不产生
 * `tools/change` 抖动 —— 宿主只在真的变化时才发事件）。
 *
 * ## 失败时的姿态
 *
 * 一律"保持现状 + 记一条日志"，绝不抛：这两个调用发生在会话创建的串行监听器
 * 和每次 `turn/start` 上，一个抛出去的异常会把整轮对话带走。宿主没有
 * `ctx.tools` 时不算错误（老宿主/子 agent 上下文），只是封不上，如实记进
 * `stateOf()` 的 `error` 里让面板/自测能看见。
 */

/** 一次全封用的过滤器：不放行任何继承来的工具。 */
export const SEAL_FILTER = Object.freeze({ allow: Object.freeze([]) });

/**
 * 执行期拒绝理由。
 *
 * 说人话，并且说清"这是设计，不是故障"：模型看到的是拒绝理由，用户看到的是
 * 一个不出工具调用的回合；两边都不该以为是坏了。
 * @param {unknown} name 被拒绝的工具名
 * @returns {string}
 */
export function denyReason(name) {
  const tool = typeof name === "string" && name.trim() !== "" ? name.trim() : "这个工具";
  return `「${tool}」在这个会话里不可用：聊天模式与团队模式都不向模型发送任何工具（这是设定，不是故障）。`;
}

/**
 * 建一个工具闸门。
 *
 * @param {object} options
 * @param {(agent: object) => boolean | { seal: boolean, why?: string }} options.decide
 *        这个 agent 现在该不该被封。每次 reconcile 都会问一次，所以它必须便宜、
 *        同步、且不抛。
 * @param {() => object[] | undefined} [options.listAgents] 当前活着的 agent
 * @param {{ warn?: (message: string) => void }} [options.logger]
 */
export function createToolFilter({ decide, listAgents, logger }) {
  /**
   * agent -> 记录。用 agent 对象本身做键：它同时是宿主 scope 链上的 key
   * （`dsh-agent` 用 `scopeTarget(agent, agent)`），生命周期与 agent 同长，
   * 所以不会出现"两个会话共用一个键"的错配。
   */
  const held = new Map();

  const warn = (message) => {
    try {
      logger?.warn?.(`dsh-waifu-agents: ${message}`);
    } catch {
      /* 记日志失败不能反过来炸掉一轮对话 */
    }
  };

  function ask(agent) {
    try {
      const answer = decide(agent);
      if (typeof answer === "boolean") return { seal: answer, why: "" };
      return { seal: answer?.seal === true, why: typeof answer?.why === "string" ? answer.why : "" };
    } catch (error) {
      return { seal: false, why: `判定失败：${error?.message ?? error}` };
    }
  }

  function record(agent) {
    const found = held.get(agent);
    if (found !== undefined) return found;
    const fresh = {
      sealed: false,
      why: "",
      /** @type {null | (() => void)} */
      liftRestrict: null,
      /** @type {null | (() => void)} */
      liftGuard: null,
      error: "",
    };
    held.set(agent, fresh);
    return fresh;
  }

  /**
   * 装上两层闸门。顺序是有意的：先 restrict（schema 里就没这些工具），再
   * guard（万一有自己层注册的东西漏过来，执行期兜底）。
   */
  function seal(agent, state) {
    const tools = agent?.ctx?.tools;
    if (tools === null || tools === undefined) {
      state.error = "这个 agent 上下文里没有 tools 服务，封不上";
      return false;
    }
    let sealed = false;
    if (typeof tools.restrict === "function") {
      try {
        const lift = tools.restrict({ allow: [...SEAL_FILTER.allow] });
        state.liftRestrict = typeof lift === "function" ? lift : null;
        sealed = true;
        state.error = "";
      } catch (error) {
        state.error = `tools.restrict 拒绝执行：${error?.message ?? error}`;
        warn(`${state.error}（这个会话仍会尝试执行期守卫）`);
      }
    } else {
      state.error = "宿主没有 ctx.tools.restrict，只有执行期守卫";
      warn(state.error);
    }
    if (typeof tools.guard === "function") {
      try {
        const lift = tools.guard((exec) => denyReason(exec?.name));
        state.liftGuard = typeof lift === "function" ? lift : null;
      } catch (error) {
        warn(`tools.guard 挂不上：${error?.message ?? error}`);
      }
    }
    return sealed;
  }

  /** 解开两层。守卫先撤：先放开可见性会让"执行期还能拦"这个中间态失去意义。 */
  function unseal(state) {
    for (const key of ["liftGuard", "liftRestrict"]) {
      const lift = state[key];
      state[key] = null;
      if (typeof lift !== "function") continue;
      try {
        lift();
      } catch (error) {
        // 作用域可能已经没了，disposer 跟着一起走；不构成错误。
        warn(`撤销工具闸门失败：${error?.message ?? error}`);
      }
    }
  }

  /**
   * 让一个 agent 的闸门与当前状态一致。幂等。
   * @param {object} agent
   * @returns {{ sealed: boolean, changed: boolean, why: string, error: string }}
   */
  function reconcile(agent) {
    const state = record(agent);
    const want = ask(agent);
    state.why = want.why;
    if (want.seal === state.sealed) {
      return { sealed: state.sealed, changed: false, why: state.why, error: state.error };
    }
    if (want.seal) {
      const ok = seal(agent, state);
      state.sealed = ok;
    } else {
      unseal(state);
      state.sealed = false;
    }
    return { sealed: state.sealed, changed: true, why: state.why, error: state.error };
  }

  /** 按 sessionId 找活着的 agent 再 reconcile；找不到就当无事发生。 */
  function reconcileFor(sessionId) {
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    if (id === "") return undefined;
    const live = typeof listAgents === "function" ? listAgents() : undefined;
    if (!Array.isArray(live)) return undefined;
    const agent = live.find((item) => String(item?.session?.id ?? "").trim() === id);
    if (agent === undefined) return undefined;
    return reconcile(agent);
  }

  /** 每个活着的 agent 都对齐一次。模式开关、目录变更之后调用。 */
  function reconcileAll() {
    const live = typeof listAgents === "function" ? listAgents() : undefined;
    if (!Array.isArray(live)) return;
    for (const agent of live) reconcile(agent);
  }

  /**
   * 忘掉一个 agent。`restrict`/`guard` 的 effect 本来就挂在 agent 的 fiber 上，
   * agent 销毁时宿主会自己撤；这里只清理本文件的记账，免得 Map 长命。
   */
  function forget(agent) {
    const state = held.get(agent);
    if (state === undefined) return;
    held.delete(agent);
  }

  /** 诊断/自测用：这个 agent 现在的闸门状态。 */
  function stateOf(agent) {
    const state = held.get(agent);
    if (state === undefined) return { known: false, sealed: false, why: "", error: "" };
    return { known: true, sealed: state.sealed, why: state.why, error: state.error };
  }

  function dispose() {
    for (const state of held.values()) unseal(state);
    held.clear();
  }

  return { reconcile, reconcileFor, reconcileAll, forget, stateOf, dispose };
}
