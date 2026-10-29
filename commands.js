/**
 * 三个 `/waifu-*` 命令：换掉这个会话正在跑的人设、问它现在是谁、再把它放回去。
 *
 * 从 `index.js` 拆出；处理函数本身未改。它们触到的一切都是宿主半边持有的
 * 句柄 —— 覆盖存储、影子预设、团队绑定 —— 所以边界就是一袋 `deps` 袋，而
 * 不是共享闭包。这袋东西只在安装时读一次，且每一项都是函数，这也是可变项
 * 保持诚实的方式：`teamRuntimeOf` 是个 thunk，因为团队运行时在本调用点之后
 * 的 `apply()` 里才创建，捕获下来的值会永远是 `null`。
 */
import { oneLine } from "./text.js";

/**
 * @param {object} ctx 插件自己的上下文
 * @param {object} deps 处理函数所需的全部闭包句柄
 * @returns void
 */
export function installCommands(ctx, deps) {
  const {
    anchorOf,
    applySessionMode,
    cachedDefault,
    choosableRows,
    dropShadow,
    ensureShadow,
    hasPersonaRow,
    matchPersona,
    modeInfoOf,
    overrideOf,
    parseModeCommand,
    refreshDefault,
    rememberSessionPreset,
    restoreSessionPreset,
    restingOf,
    safeText,
    sessionPersona,
    setGlobalMode,
    setOverride,
    teamNameForPreset,
    teamRuntimeOf,
  } = deps;

  const sidOf = (agent) => oneLine(agent?.session?.id);
  /**
   * 锚点读取放在 {@link anchorOf} 里：会话头只会写会话出生时挂的预设，而
   * `agentPreset` 投影则跟随其后每一次 `agent-preset/selected`。
   */
  const mountedOf = (agent) => anchorOf(agent);
  const modeLabel = (mode) => (mode === "chat" ? "聊天模式" : "工作模式");
  const SOURCE_LABEL = {
    override: "本会话覆盖",
    mounted: "会话挂载",
    default: "全局默认回落",
    none: "无",
  };
  /**
   * `/waifu-reset` 的两种拼法。
   *
   * 默认那种是**会话级**的：撤掉插件在这个会话里做的改动，回到它自己原本
   * 在跑的那位。`global` 是另一件事——把这一场搬到**当前**全局默认上，明确
   * 地、一次性地跟随出去。
   *
   * 为什么不让默认行为指向全局默认：全局默认是给未来新会话的配置，是一个
   * 会变的活值。让它当 reset 的落点，同一个会话今天回 A、下周回 C，中间你
   * 什么都没做，命令就不再幂等；而且它把「第三档回落」写成了第二档挂载
   * （见 `orderPersonaIds`），之后改全局默认这一场反而不跟了。10-29 那次
   * 「我没选过她，她怎么变成达克妮斯了」正是这个方向的产物。
   */
  function parseResetCommand(raw) {
    const text = oneLine(raw).toLowerCase();
    if (text === "") return { kind: "session" };
    if (["global", "default", "全局", "全局默认", "默认"].includes(text)) return { kind: "global" };
    return {
      kind: "error",
      text: `不认识的参数「${oneLine(raw)}」。不带参数＝回到这个会话自己的那位；/waifu-reset global＝搬回当前全局默认。`,
    };
  }

  ctx.commands.register({
    name: "waifu-change",
    description:
      "换掉这个会话正在用的人设：不带参数会打开选择器，带名字就直接切换（下一轮生效）。",
    input: { hint: "名字" },
    handler: async ({ agent, rawInput }) => {
      const sessionId = sidOf(agent);
      if (sessionId === "")
        return { kind: "error", text: "这个命令只能在会话里用。" };
      const wanted = oneLine(rawInput);
      const rows = choosableRows();
      if (wanted === "") {
        return {
          kind: "error",
          text: `没有给出名字。Web 端打 /waifu-change 会打开选择器；这里请直接写名字：/waifu-change ${rows[0]?.name ?? "名字"}\n现有：${rows.map((row) => row.name).join(" / ")}`,
        };
      }
      const matched = matchPersona(wanted, rows);
      if (matched.ok !== true) {
        return {
          kind: "error",
          text: `${matched.error}${(matched.candidates ?? []).length > 0 ? `\n${(matched.candidates ?? []).join(" / ")}` : ""}`,
        };
      }
      const found = safeText(matched.id);
      if (found === null) {
        return {
          kind: "error",
          text: `「${matched.id}」现在组装不出来（少了 [[body]]、或正文里混进了非法的 {{…}}），没有替换，这一轮仍然用原来那个人设。`,
        };
      }
      const already = overrideOf(sessionId);
      /*
       * 切换到单人设会退出团队模式。没有这一步，内存里的绑定会在下次组装时
       * 压过刚选的人设（`teamNameFor` 先读 `bound`），于是 `/waifu-change`
       * 会报告一次模型永远看不到的切换。
       */
      teamRuntimeOf()?.unbind?.(sessionId);
      setOverride(sessionId, matched.id, mountedOf(agent));
      // 覆盖才是模型被告知的；这个是会话上方那枚标签显示的。没有它，一个
      // 运行中的会话会一直挂着它出生那位的标签（见 `rememberSessionPreset`）。
      rememberSessionPreset(agent, matched.id);
      let note = "";
      if (!hasPersonaRow(mountedOf(agent))) {
        const shadow = ensureShadow(agent);
        note =
          shadow.ok === true
            ? "（这个会话原本没挂人设，已经单独给它挂上）"
            : `（这个会话原本没人设，兜底也失败了：${shadow.error}）`;
      }
      /*
       * 「已切换」 是对会话状态的断言，所以当会话本来就已经是她时不得打印。
       * 重复执行同一条命令曾回答 「已切换：大肥鱼」 而实际下发的提示词毫无
       * 变化 —— 循环看到文本相同，不会提交新的 system 节点，锚点也就什么
       * 都没有重新落。从外面看就是"换人没生效"，这句措辞的存在正是为了防止
       * 这种困惑。
       */
      if (already === matched.id) {
        return {
          kind: "success",
          text: `本来就是 ${found.name} · 来源：本会话 · 没有改动${note}`,
        };
      }
      return {
        kind: "success",
        text: `已切换：${found.name} · 来源：本会话 · 从下一轮开始生效${note}`,
      };
    },
  });

  ctx.commands.register({
    name: "waifu-current",
    description: "看这个会话现在在用谁，以及这个值是从哪来的。",
    handler: async ({ agent }) => {
      const sessionId = sidOf(agent);
      if (sessionId === "")
        return { kind: "error", text: "这个命令只能在会话里用。" };
      await refreshDefault();
      const mountedId = mountedOf(agent);
      const team = oneLine(teamRuntimeOf()?.stateOf?.(sessionId)?.team);
      const found = sessionPersona(sessionId, mountedId);
      const override = overrideOf(sessionId);
      /*
       * 团队优先，标签其次。
       *
       * `mountedId` 只是那枚标签：`/waifu-team` 有可能没把它挪过去（注册表的
       * 团队预设还没就位，见 `moveChipToTeam`），这时标签上写着一位人设，而
       * 实际回答你的是整支队。先念标签，用户就会得到「本会话人设：达克妮斯」
       * ——而托尔和康娜刚刚才回过话。2026-10-29 那次就是这么被误读成「记忆
       * 残留」的。
       */
      const lines =
        team === ""
          ? []
          : [
              mountedId === team || mountedId === ""
                ? `本会话：团队「${team}」`
                : `本会话：团队「${team}」· 标签停在「${mountedId}」（名字没跟上，回答你的仍是这支队）`,
            ];
      if (team === "" && found.id === null)
        return { kind: "error", text: "这个会话现在没有可用的人设。" };
      if (team === "") {
        /*
         * 这个 id 是有意不显示的 —— 文件名跟随显示名 —— 所以对每个名字就是
         * 文件名的人设来说，这一行曾显示成 「阿库娅 · 阿库娅」。id 只有在它
         * 说了名字没说的事时才值得打印：`/waifu-change` 和 `overrides.json`
         * 都是按它匹配的，所以名字被迫 slug 化的人设（`Bad Name` -> `bad-name`）
         * 仍然会把 id 显示出来。
         */
        lines.push(
          found.id === found.name
            ? `本会话人设：${found.name}`
            : `本会话人设：${found.name} · ${found.id}`,
        );
        if (override !== null && override !== found.id) {
          lines.push(
            `（记录里是「${override}」，它已经不可用，所以退到了上面这个。清掉记录：/waifu-reset）`,
          );
        } else if (
          override === null &&
          mountedId !== "" &&
          mountedId !== found.id
        ) {
          lines.push(
            `（会话挂载的「${mountedId}」已经不可用，所以回落到了全局默认。换人：/waifu-change 名字）`,
          );
        }
        // `/waifu-reset` 会落到的位置；一旦本会话切换过，它就不再是挂载 id：
        // 那时标签写的是覆盖。
        const home = restingOf(sessionId);
        if (override !== null && home !== "" && home !== found.id) {
          lines.push(`（清掉覆盖会回到「${home}」：/waifu-reset）`);
        }
      }
      /*
       * 模式也在这条命令里报。`/waifu-current` 回答的是「这个会话现在是什么
       * 状态」，而紧接着被问的几乎总是「那她为什么没有工具」。答案有两半：
       * 全局开关，和这一场自己的钉子——只报前一半，会让一个被钉在聊天的会话
       * 看起来不可解释。
       */
      const mode = modeInfoOf(sessionId);
      lines.push(
        mode.teamMode
          ? "模式：团队讨论（本来就不带工具）"
          : `模式：${modeLabel(mode.global)}（全局）${
              mode.session === ""
                ? " · 本会话跟随全局"
                : ` · 本会话单独设成了${modeLabel(mode.session)}`
            }`,
      );
      return { kind: "success", text: lines.join("\n") };
    },
  });

  ctx.commands.register({
    name: "waifu-reset",
    description:
      "回到这个会话自己原本在跑的那位：清掉人设覆盖与团队绑定，落点是「插件接手之前这一场的人设」；本来就没有覆盖时什么都不做（不会去动你在宿主自己的选择器里挑的人）。加 global 则改成搬回当前全局默认。",
    input: { hint: "global" },
    handler: async ({ agent, rawInput }) => {
      const sessionId = sidOf(agent);
      if (sessionId === "")
        return { kind: "error", text: "这个命令只能在会话里用。" };
      const parsed = parseResetCommand(rawInput);
      if (parsed.kind === "error") return { kind: "error", text: parsed.text };
      const hadPersona = overrideOf(sessionId);
      // 先读再清：清掉的动作正是把这条记录删掉的那一步。没有它，本插件挪到
      // 覆盖上的那枚标签就成了唯一可读的东西，会话会回到最后一次切换到的那
      // 位，而不是这次对话开始时的那位。
      const remembered = restingOf(sessionId);
      /*
       * `global` 要现读一次，而且必须在 `unbind` **之前**：读不出来时这条
       * 命令只能报错返回，若那时绑定已经被摘掉，用户得到一句「读不出全局
       * 默认」加一个悄悄退出团队的事实——两件事都发生了，只有一件被说出来。
       * `cachedDefault` 也可能停在两秒窗口里、或停在用户刚在设置里换掉之前，
       * 所以用 `force`。
       */
      let globalHome = "";
      if (parsed.kind === "global") {
        await refreshDefault({ force: true });
        globalHome = oneLine(cachedDefault().id);
        if (globalHome === "") {
          return {
            kind: "error",
            text: "读不出全局默认人设（settings 里没有选定默认）。想直接指定一位：/waifu-change 名字",
          };
        }
      }
      /*
       * `/waifu-team` 的绑定也是覆盖的一种。只清人设记录会留下团队，于是
       * reset 回答"本来就没有覆盖"，而下一轮却仍以那个团队在跑 —— 恰是让
       * 这条命令显得坏了的那种反馈。
       *
       * 交回来的 `chip` 是「进队之前那位单人」，不是「绑定时标签停在哪」：
       * 后者挪完标签后等于团队预设本身（见 `team-runtime.js` 的 `prevChip`），
       * 拿它当落点会把一个团队当成一位人设恢复回去。
       */
      const team = teamRuntimeOf()?.unbind?.(sessionId) ?? {
        bound: undefined,
        off: false,
        chip: undefined,
      };
      const hadTeam = team.bound !== undefined || team.off === true;

      /*
       * "什么都没清"必须是**不写**的分支，而且要在动标签之前就返回。
       *
       * 这一段曾经是反的：先 `setOverride(null)`、先
       * `restoreSessionPreset(agent, home)`，然后才判断有没有东西可清。于是
       * 一次空转的 reset 也会追加 `agent-preset/selected`，把会话从用户手上
       * 那一位挪到 `session.header.agentPreset`——也就是全局默认。
       * 用户看到的现象是「我没选过她，她自己变成达克妮斯了」，而命令同时在
       * 说「什么都没改」；两句都真，合起来是假。
       *
       * 会话头在出生时被盖上全局默认，之后只有 `agent-preset/selected` 能
       * 移动标签，所以头与标签本来就可以不同（在新建任务屏里另选过、被团队
       * 绑过、或直接在宿主的选择器里换过）。没有记录可复原时，那个头不是
       * 答案，只是旧章。
       *
       * `global` 不受这条约束：它本来就是「主动搬到别处」，没有覆盖也照做。
       */
      if (parsed.kind === "session" && hadPersona === null && !hadTeam) {
        const chipNow = mountedOf(agent);
        return {
          kind: "success",
          text: [
            "这个会话本来就没有覆盖，什么都没改。",
            chipNow === ""
              ? "（标签上没有预设，也就没有可复原的东西。）"
              : `（标签仍停在「${chipNow}」——它不是本插件换的，插件没有它的记录，也就不会去动它。）`,
            "想搬回当前全局默认：/waifu-reset global",
          ].join("\n"),
        };
      }
      if (
        parsed.kind === "global" &&
        hadPersona === null &&
        !hadTeam &&
        mountedOf(agent) === globalHome
      ) {
        await refreshDefault();
        const same = sessionPersona(sessionId, globalHome);
        return {
          kind: "success",
          text: `本来就在全局默认（${same.name ?? globalHome}）上，没有改动。`,
        };
      }
      /*
       * 落点：`resting`（第一次覆盖之前的身份）→ 进队前那位 → 空（交给
       * `restoreSessionPreset` 回落到会话头）。前两档都必须是**单人设**；
       * 团队算不算落点，两种拼法的答案相反，见下面。
       */
      const candidate =
        parsed.kind === "global" ? globalHome : remembered !== "" ? remembered : oneLine(team.chip);
      const candidateTeam = candidate === "" ? null : teamNameForPreset(candidate);
      /*
       * 两种拼法对「落点是团队」的答案相反，不能共用一条规则。
       *
       * 会话级 reset 撤的正是「进队」这件事，所以团队在这里不是落点而是要撤
       * 掉的东西：越过它、交一个空的，让 `restoreSessionPreset` 去读会话头，
       * 比把一个团队当人设恢复回去诚实。
       *
       * `global` 不一样——用户点名要搬到**当前全局默认**，而团队预设本身可以
       * 就是那个默认（`team-mode.js` 的 `defaultNamesTeam` 正是为这种情况写
       * 的）。把它一起判死，命令就会一边说「搬回全局默认」一边把那一队停掉，
       * 或者落到会话头那个谁也没选过的预设上；用户看到的是一次自相矛盾的
       * 复位。
       */
      const home = candidateTeam !== null && parsed.kind !== "global" ? "" : candidate;
      setOverride(sessionId, null);
      // 把标签放回会话所在处：`restoreSessionPreset` 会回落到会话头（它出生
      // 时挂的预设），那是团队切换从未改过的东西。
      restoreSessionPreset(agent, home);
      await refreshDefault();
      dropShadow(sessionId);
      /*
       * 落到标签上的东西才是真的。`restoreSessionPreset` 可能在两处失败：
       * 标签同步被关掉，或平台拒绝了这次 append；`home` 为空时它还会回落到
       * 会话头，而会话头有可能正是团队预设（会话出生在团队上）。这两种情况
       * 都让标签继续指着团队，而 `teamNameFor` 在**没有绑定**时会回落到
       * 「出生时带的团队预设」——不补这一下，下一轮团队就从这个标签上自己
       * 活过来，而命令刚报过「已清掉团队绑定」。10-29 那场「换了人设还带着
       * 康娜留的布丁」就是这个机制的产物（那一轮写进了 team-memory）。
       */
      const chip = mountedOf(agent);
      const chipTeam = chip === "" ? null : teamNameForPreset(chip);
      const homeIsPersona = home === "" || teamNameForPreset(home) === null;
      const heldOff = chipTeam !== null && homeIsPersona;
      if (heldOff) teamRuntimeOf()?.holdOff?.(sessionId);
      // 落点在哪。`home` 是本次要回到的那位；`heldOff` 时标签还指着团队，
      // 但它已经不生效了，报一个人设名就是答非所问。
      const found = chipTeam !== null && !heldOff ? null : sessionPersona(sessionId, chip);
      const where = heldOff
        ? `标签还停在「${chip}」（没有你进队之前那位的记录，那一队不会再生效）`
        : chipTeam !== null
          ? `回到团队「${chipTeam}」`
          : found === null || found.id === null
            ? "这个会话现在没有可用的人设"
            : `回到 ${found.name}（${SOURCE_LABEL[found.source] ?? found.source}）`;
      const parts = [];
      if (hadPersona !== null) parts.push(`人设覆盖（之前是「${hadPersona}」）`);
      if (team.bound !== undefined) parts.push(`团队绑定（之前是「${team.bound}」）`);
      /*
       * 落点正好就是刚摘掉的那支队时，「已清掉团队绑定」与「回到团队「X」」
       * 会在同一行里相撞。两句都真：运行期的绑定确实没了，这一场现在靠
       * **团队预设**（它就是全局默认）继续跑。不说这一句，读起来像命令同时
       * 做成了两件相反的事。
       */
      const viaPreset =
        candidateTeam !== null &&
        team.bound !== undefined &&
        candidateTeam === team.bound
          ? `\n（绑定关系摘掉了，但这一场仍按团队「${candidateTeam}」运行——它现在是全局默认）`
          : "";
      const cleared = parts.length > 0 ? `已清掉${parts.join("、")}` : "已取消团队模式";
      /*
       * 标签是这件事的持久化一半：会话是按其投影所写的名字重新挂载的，所以
       * 留在被清掉的覆盖上会让它在下次恢复时又变回来。如果追加没成功（标签
       * 同步关闭，或平台拒绝了），就要说出来，而不是把迁移报成已完成 ——
       * 否则这个失败会以 「重启后怎么又是她」 的形式重新冒出来。
       */
      const drift =
        !heldOff && home !== "" && chip !== "" && chip !== home
          ? `\n（会话标签没跟上：现在还写着「${chip}」，重启这个会话可能又变回它）`
          : "";
      /*
       * `resting` 这个字段比 0.2.4 新。旧记录读回来是空的，于是落点只能退回
       * 会话头——那个出生时的全局默认，而不是用户当时在新建任务屏里挑的那位。
       *
       * 这是数据缺口，不是这次命令的选择，所以必须说出来。静默地落到一个陌生
       * 名字上，看起来正是这条命令最该避免的那种「她自己变了」。
       */
      const legacyHome =
        !heldOff &&
        parsed.kind === "session" &&
        hadPersona !== null &&
        remembered === "" &&
        oneLine(team.chip) === ""
          ? "\n（这条覆盖是旧版本写的，没记下这一场原本是谁——所以回了会话出生时那位）"
          : "";
      /*
       * 模式是与人设正交的开关，reset 不动它——`/waifu-mode` 有自己的报告与
       * 撤销（`here inherit`）。但什么都不说会制造第二次追问：「reset 过了
       * 怎么还是没工具」。所以只在**这一场被钉住**时提一句。
       */
      const mode = modeInfoOf(sessionId);
      const modeNote =
        mode.session === "" || mode.teamMode
          ? ""
          : `\n（模式没动：本会话单独设的还是${modeLabel(mode.session)}。改回跟随全局：/waifu-mode here inherit）`;
      return {
        kind: "success",
        text: `${cleared} · ${where} · 从下一轮开始生效${viaPreset}${drift}${legacyHome}${modeNote}`,
      };
    },
  });

  /*
   * `/waifu-mode` —— 聊天 / 工作两档的开与关。
   *
   * 为什么不在 `/waifu-change` 里加一个 `mode` 拼法：那条命令的第一个动作是
   * `matchPersona`，而它带**前缀匹配**（`index.js` 里 `startsWith`）。目录里
   * 只要有人设叫 `Model`、`Modesty` 或 `mode-chan`，`/waifu-change mode`
   * 就会被吃成一个名字——要么切错人，要么报「能对上 2 个」。保留字靠抢是抢
   * 不过前缀匹配的，所以给它自己一条命令。
   *
   * 两种作用域必须说清，因为它们是相反的东西：不带 `here` 改的是整个
   * profile 的一份 `mode.json`（所有会话一起变），带 `here` 只钉这一场
   * （写进 `overrides.json` 的 `modes` 表，走运行时闸门）。文案里「全局」
   * 和「这 个 会 话」这两个词是刻意写死的——用户误判作用域，代价是别的会话
   * 悄悄没了工具。
   */
  ctx.commands.register({
    name: "waifu-mode",
    description:
      "看/切聊天与工作模式：不带参数看现状，chat | work 改全局，here chat | work 只改这个会话，here inherit 改回跟随全局。",
    input: { hint: "chat | work | here chat" },
    handler: async ({ agent, rawInput }) => {
      const sessionId = sidOf(agent);
      if (sessionId === "")
        return { kind: "error", text: "这个命令只能在会话里用。" };
      const parsed = parseModeCommand(rawInput);
      const info = modeInfoOf(sessionId);
      if (parsed.kind === "error") return { kind: "error", text: parsed.text };

      /* ---------- 只看 ---------- */
      if (parsed.kind === "show") {
        const lines = [`现在：${modeLabel(info.global)}（全局）`];
        if (info.teamMode) {
          lines.push(
            "这个会话是团队讨论，本来就不带工具——模式开关对它没有影响。",
          );
        } else if (info.session === "") {
          lines.push(`本会话：跟随全局（${modeLabel(info.global)}）`);
        } else {
          lines.push(`本会话：单独设成了${modeLabel(info.session)}（要它跟随全局：/waifu-mode here inherit）`);
        }
        if (!info.teamMode) {
          lines.push(
            info.sealed
              ? "这个会话此刻没有工具（闸门：关着）。"
              : "这个会话此刻带着工具。",
          );
        }
        lines.push(
          "改全局：/waifu-mode chat | work　　只改这一场：/waifu-mode here chat | work | inherit",
        );
        return { kind: "success", text: lines.join("\n") };
      }

      /* ---------- 只改这一场 ---------- */
      if (parsed.kind === "session") {
        applySessionMode(sessionId, parsed.mode);
        const after = modeInfoOf(sessionId);
        const head =
          parsed.mode === null
            ? `这个会话恢复跟随全局（现在是${modeLabel(after.global)}）`
            : `这个会话单独设成了${modeLabel(parsed.mode)}`;
        const tail = info.teamMode
          ? "（团队讨论本来就不带工具，这一条对当前会话没有可见变化。）"
          : `（只影响这一场，别的会话仍跟随全局：${modeLabel(after.global)}）`;
        /*
         * 反方向要如实说：全局是聊天模式时，人设预设注册时就已经被裁成
         * 「人设 + 时钟 + 压缩」，模板里的 skill / command 行不在了。这一场
         * 就算放开闸门，也只拿得回宿主那层工具，拿不回那些行。想让双方都
         * 完整，方向应该反过来——全局留在工作模式，用 here chat 钉住想聊天
         * 的那一场；那个方向是无损的。
         */
        const caveat =
          parsed.mode === "tools" && info.global === "chat"
            ? "\n注意：全局现在是聊天模式，人设注册时已裁掉模板里的 skill / command 行，这一场只拿得回宿主那层工具。要两边都完整，反过来用：全局留在工作模式，再用 here chat 把想聊天的那场单独设成聊天。"
            : "";
        return {
          kind: "success",
          text: `${head} · 从下一个请求开始生效${tail}${caveat}`,
        };
      }

      /* ---------- 改全局 ---------- */
      const result = await setGlobalMode(parsed.mode);
      if (result?.ok !== true) {
        return {
          kind: "error",
          text: `没切成：${result?.error ?? "原因不明"}。模式仍是${modeLabel(info.global)}。`,
        };
      }
      const now = modeInfoOf(sessionId);
      if (result.changed !== true) {
        return {
          kind: "success",
          text: `本来就是${modeLabel(info.global)}，没有改动。${
            now.session !== ""
              ? `\n（这一场另外单独设成了${modeLabel(now.session)}；要它跟随全局：/waifu-mode here inherit）`
              : ""
          }`,
        };
      }
      const parts = [
        `已切到${modeLabel(parsed.mode)} · 全局 · 从下一个请求开始生效`,
        `（所有会话一起变。只想改这一场：/waifu-mode here ${parsed.mode === "chat" ? "chat" : "work"}）`,
      ];
      if (now.session !== "" && now.session !== parsed.mode) {
        parts.push(
          `注意：这个会话单独设成了${modeLabel(now.session)}，不跟着变。要它跟随全局：/waifu-mode here inherit。`,
        );
      }
      if (info.teamMode) {
        parts.push("（这个会话是团队讨论，本来就不带工具，看不出变化是正常的。）");
      }
      return { kind: "success", text: parts.join("\n") };
    },
  });
}
