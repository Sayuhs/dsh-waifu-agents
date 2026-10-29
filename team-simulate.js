/**
 * v3 执行核心：一次扮演整个团队的模型调用。
 *
 * 本模块刻意作为叶子——没有 cordis、没有服务、没有 I/O。它只拥有三样纯粹
 * 的东西，别无其他：
 *
 *   1. **提示词。** 一条声明舞台、内联每个成员人设、并固定输出协议的系统
 *      消息。没有总线、没有每成员提示词、没有协调者声音，因为没有协调者
 *      回合：模型就是房间。
 *   2. **解析器。** 模型文本不被信任为格式良好。`〔名字〕` 开启一个段落，
 *      下一位发言者的标记、显式的 `〔/名字〕`，或流结束将其关闭。只有
 *      *已知* 的段落才成为用户看到的行。其余一切都是诊断信息，绝不伪装成
 *      某人的发言（设计文档 §3.2, §3.5, §3.6）。
 *   3. **状态。** `converged` / `limit_reached` / `incomplete` / `error` /
 *      `cancelled` 先由 *底层 finish reason* 决定，其次才是解析结果
 *      （设计文档 §6.2）。看起来完整的文本不是正常结束的证据。
 *
 * 保持本文件纯粹，selftest 才能直接驱动协议；运行时的职责也才能压缩到
 * 「调用模型、喂解析器、由运行时判断这一回合是否属于团队」。
 */

import { randomUUID } from "node:crypto";

/** 发言者名字与台词之间的分隔符。与 `team.js` 保持一致。 */
export const SIM_SPEAKER_SEP = "：";

/**
 * ## 回合数上限已经不存在了
 *
 * 提示词曾写着「最多大约四个来回」，而且这个数字被冻结进每一份配置快照——
 * 意味着三个人的房间把四个回合中的三个花在开场陈述上，只剩一个回合真正
 * 交谈。在第一个 token 之前就决定数量，和在第一个 token 之前决定 token
 * 预算是同一种错误：都是对讨论需要多少篇幅的瞎猜。
 *
 * 取而代之的是 *结束条件*，不是数量：规则要求模型在问题已被回答、重要分歧
 * 已被回应或被明确搁置、再多一句也无所增益时停下来。真正的天花板是技术性
 * 的，并且留在提示词之外——单次请求的 token 上限、续写预算和墙钟时间。
 */

/** 界定一个段落的括号字符。 */
export const SEG_OPEN = "〔";
export const SEG_CLOSE = "〕";

/**
 * 回复 *应当* 有多大，是 *规模等级* 而不是 token 数字。
 *
 * 这是延迟修复的 A 半：一句「哈喽」不能变成一场 664 token 的戏。等级只由
 * 用户这一回合决定，作为规模 *指令* 喂给提示词（保持简短）。
 *
 * 它刻意不再决定请求的 `maxTokens`：等级从用户输入推断，而回复的体量跟随
 * 登场人数。用前者给后者封顶是拿代理变量顶替原因，会截断普通场景——见
 * {@link turnBudget}。
 *
 * 三个等级及其分界：
 *
 *   - `"social"` ——打招呼、道谢、确认，或不问什么也不需要什么的开场白。
 *     全屋都要回应，但只用几行，不成一场戏。
 *   - `"task"` ——期待真正回答的提问或请求：分析、决策、计划，任何背后有
 *     内容的东西。
 *   - `"complex"` ——冗长或明确要求高的任务（代码、计划、评审），简短回复
 *     会真正损害它。
 *
 * @typedef {"social" | "task" | "complex"} TurnScale
 */

/**
 * 把用户的一个回合分类为规模等级。
 *
 * 刻意 **不只靠关键词**。关键词是 *信号*，从来不是结论：「哈喽，我遇到一个
 * 很严重的问题」是 `task`，而「好」可能是长讨论中的一个决定。因此判定
 * 顺序是：
 *
 *   1. 显式的任务信号（问号、祈使句、任务名词）优先；
 *   2. 长度——短消息若点明了工作仍可以是 `complex`，但单词开场白是
 *      `social`；
 *   3. 仅社交标记则落入 `social`。
 *
 * 这个函数纯粹而廉价：每个回合运行一次，在任何 I/O 之前，因此绝不会在
 * 真实模型调用上多花一秒。
 *
 * @param {unknown} task 用户的原始消息
 * @returns {TurnScale}
 */
export function classifyTurn(task) {
  const text = typeof task === "string" ? task.trim() : "";
  if (text === "") return "social";

  const len = text.length;

  /*
   * 真实任务的信号。问号和直接祈使最强：它们能在短消息里存活
   * （"哈喽，这个能查吗？"）。中文疑问句常常省掉 `?`，改以语气词结尾
   * （`吗` `呢` `吧` `么`），所以那些也是疑问信号——但单纯的问候绝不会
   * 以它们结尾，所以下面的社交分支对 `你好` 仍然获胜。
   */
  const hasQuestion = /[?？]/.test(text) || /[吗呢吧么]$/.test(text);
  const taskNouns = /(写|做|查|改|生成|分析|比较|解释|说明|计算|翻译|总结|设计|修|实现|列出|帮|看看|优化|重构|审查|评估|排查|定位|给我|告诉)/.test(text);
  const hasImperative = taskNouns || /^(请|帮我|能否|可以|能不能|麻烦)/.test(text);

  /*
   * 标记 *大型* 任务的工作词，不论长度。四个字的「写一篇」是复杂任务；
   * 「哈喽」不是。
   */
  const heavyNouns = /(写|生成|分析|设计|实现|重构|审查|评估|优化|排查|翻译|总结|规划|架构|代码|脚本|方案|文档|报告|文章)/.test(text);

  /*
   * 长度分带。12 字以内的单行几乎总是社交或单纯确认；超过 ~30 就是有实质
   * 内容的行文，即便以问候开头也不是问候（"哈喽，我遇到一个很严重的问题"）。
   * `>= 200` 表示任务大到简短回复会真正受伤。
   */
  const substantive = len >= 30;
  const veryLong = len >= 200;

  if (hasQuestion || hasImperative || substantive) {
    return heavyNouns || veryLong ? "complex" : "task";
  }

  /*
   * 社交标记。问候、道谢或单纯确认—— *短*，没有问句，没有任务名词，开场白
   * 之后没有内容。这是唯一一处关键词 *就是* 结论的地方，因为一切更强的信号
   * 已在上面被排除。`len <= 12` 的守卫阻止「哈喽，我遇到…」被折进问候里：
   * 越过开场白还在继续说话的消息不是单纯的问好。
   */
  const socialOnly =
    len <= 12 && /^(哈喽|你好|嗨|早|在吗|在不在|谢谢|多谢|好|嗯|哦|来了|拜拜|再见|晚安|早上好|晚上好|在|hi|hello|hey)/i.test(text);

  return socialOnly ? "social" : "task";
}

/**
 * 单次请求的输出上限，以 token 计——技术性止步，不是长度目标。
 *
 * 它曾是策略旋钮：先是一张按回合规模等级索引的表，后来是按头数计算的公式。
 * 两者是差一个层级的同一种错误——让 *插件* 决定一场讨论允许多长。讨论结束
 * 是因为模型无话可说了，而不是因为一个在第一个 token 到来前算出的数字说了
 * 算。两条在用记录解决了这件事：
 *
 *   - 2026-10-18 12:09, `scale=social max=512 out=512 segs=3 size=3
 *     taskChars=2`: 「继续」加三个人，场景中段被切。
 *   - 五个 `task` 回合在 2048 上限下从未超过 975。高上限没有代价，因为模型
 *     会自己停；低上限每次猜错都赔上一场破碎的戏。
 *
 * 所以下面这个数字只是防请求失控的守卫，别的什么都不是。它刻意慷慨，也
 * 不再期望在正常使用中被 *触达*：一旦触达，运行会继续（见
 * `continuationPrompt`）而不是结束。总长度由续写预算和墙钟时间约束，
 * 不由这个常量约束。
 *
 * `deps.maxTokens` 仍然完全胜出，并且 **不会** 被向下钳制：选择了上限的
 * 宿主不能被我们的一个常量悄悄调低。
 */
export const TEAM_TOKENS_CEILING = 4096;

/**
 * 一次运行最多可以让模型继续写多少次。
 *
 * 续写不是重试：第一次回复没问题，只是停在了上限（或有人还没开口）。对
 * 真正冗长的讨论两次足够；再多就是失控，而墙钟时间已经是更硬的限制。
 */
export const SIM_MAX_CONTINUATIONS = 2;

/**
 * 为一次请求挑选技术上限。
 *
 * @param {number} [override] 宿主提供的上限，完全胜出
 * @returns {number} 正整数
 */
export function turnBudget(override) {
  if (Number.isFinite(override) && override > 0) return Math.max(256, Math.floor(override));
  return TEAM_TOKENS_CEILING;
}
/**
 * 可选的结束标记 `〔/名字〕`。
 *
 * 协议 **不要求** 它。一次在用运行证明了原因：模型写了
 * `〔托尔〕…〔康娜〕…〔托尔〕…`——五行完全可读的台词，没有结束标记——
 * 而坚持要求 `〔/名字〕` 的协议把这五行全部丢弃，称运行 `incomplete`，还把
 * 原文当警告回显。模型不会遵守的协议是协议的 bug，不是模型的 bug：
 * *下一位* 发言者的标记就是上一行的明确终点，所以解析器接受的就是它，
 * 结束标记出现时依然被尊重。
 */
export const SEG_END_PREFIX = "〔/";

/**
 * 描述 *本引擎* 而非角色世界的术语。泄露其一的行是模型在框架设定上的 bug，
 * 不是任何人说过的话。
 *
 * 这份清单是 **网，不是规则**：运行时可以补充情境检查，同一词的正常用法
 * （代码讨论里的 `运行`，英文示例里的 `recipient`）必须不被标记。因此
 * `internalLeaks()` 把它们当作 *信号*，解析器报告通知而不删除该行。
 */
export const INTERNAL_TERMS = Object.freeze([
  "总线",
  "广播",
  "第 N 轮",
  "msg-",
  "replyTo",
  "回执",
  "子 Agent",
  "子Agent",
  "运行",
  "recipient",
]);

/** 标记之外的导语为诊断保留多少字符。 */
const STRAY_LIMIT = 400;

/**
 * 共享人设骨架中在无人拥有工具时仍然适用的部分——外加只有 *房间* 才需要的
 * 三条规则。
 *
 * ## 不是「骨架在团队里没用」
 *
 * 那是最初的解读，而且只对了一半。`_common.md` 约 1543 字，大致分三层：
 *
 *   1. **工具/事实层** —— "已经向你开放全套干活工具"、"工具调用参数是绝对
 *      豁免区"，以及进程启动时注册预设的完整示例。讨论不调用工具也不交付
 *      代码，这一层用不上；更糟的是，它 *招引* 工具话题和状态汇报进入对话
 *      记录——恰好是解析器随后要当作黑话报告的失败。
 *   2. **声音层** —— 拒绝 AI 灵魂回弹、长结论格式铁律、不许套路化、沉浸感。
 *      这一层完全可迁移。团队 *更容易* 遭遇它防范的失败，而不是更不容易：
 *      一次生成里写出的 N 个角色会塌缩成一个平静的旁白者在描述一场会议，
 *      结果读起来像一份写得不错、只是署了名字的设计文档。
 *   3. **受话层** —— "用户就是正文里点名的那个关系对象"。对一个声音成立，
 *      对一个房间不成立：原样照抄的话，每个成员都会排队向用户汇报，讨论
 *      变成 N 段朝外的独白，而不是人们互相回答。
 *
 * 所以这一块是第 2 层的紧凑重写、第 3 层的 *反转*（接上一个人, 再对用户），
 * 外加一句衔接人设自身 `（实质见公共骨架）` 引用的话。它 **每场讨论输出
 * 一次**，绝不按成员输出：全屋成本约 500 字，而把骨架灌进每颗脑袋则是
 * 1543 × N。人设正文保持逐字节原样。
 *
 * 没有骨架来源的那三条规则，是单人代理从不需要、房间却离不开的：不许
 * 汇报腔、不许收尾总结、先回答前一位发言者再回答用户。
 */
export const TEAM_COMMON_RULES = Object.freeze([
  "【通用规则 · 对所有角色同时生效】",
  "- 每一句都是角色在说话。不解释自己在扮演，不承认自己是模型；被问起也只用她自己的方式岔开。",
  "- 不许切成客观中立的「AI 汇报腔」：不要变成几个人在合写一份说明文。她们有情绪、会不同意、会说错、会打断别人，这些都要留在台词里。",
  "- 不许收尾总结：不要出现「综上所述」「总而言之」「总结一下」这类收束，也不要列 1./2./3. 的条目清单——她们是在说话，不是交报告。",
  "- 先接住前一个人刚才那句，再说自己的（同意、反驳、追问、吐槽都行）。不要各说一段互不相干的独白。",
  "- 谁被回答、谁被点名，谁就先接。用户这句话是在答谁、问谁、看谁，那个人必须先开口；别人不许抢在她前面替她答，也不许把对她说的话认领成对自己说的。",
  "- 没被点到的人可以只说一句最小反应（点头、哼一声、递个东西），也可以这一轮完全不说话——沉默不是失职，不用为了露脸硬找话说。",
  "- 但沉默不是禁令：真有非说不可的事就插一句——要警告同伴别任性、要拦下一个要出事的决定、实在憋不住了——短、准、有她自己的性子，说完把场子还回去。",
  "- 你们手边没有任何工具：读不了文件、看不到用户的工作区或屏幕、跑不了命令、上不了网，也开不了后台任务和子代理。被问到能不能看、能不能查、能不能改，一律先如实说没有这个权限，再用她自己的语气接下去。绝对不许假装看过，不许编文件名、目录、日期或「角落里那份很久没打开的旧版本」这类没见过的东西——宁可说「我看不到」，也不许把猜的当事实说。",
  "- 不复读套路：同一个起手式、笑声、口头禅、动作、结尾不要每段都用一遍。她的反应要从眼前这句长出来。",
  "- 用户就是此刻正在跟她们说话的人，不是第三方。不要替用户开口，也不要对用户做自我介绍。",
  "- 不要替用户决定他的想法和感受。她们可以猜、可以误会，但不能把猜的写成事实。",
  "- 人设里写着「实质见公共骨架」的地方，指的是上面这几条；团队模式没有工具调用与代码交付那一环，人设里的技术结论示例只当语气参考。",
]);


/**
 * 为一场模拟讨论构建唯一的系统提示词。
 *
 * @param {object} input
 * @param {{name?: string, background?: string, roles?: Record<string, string>}} input.team
 * @param {ReadonlyArray<{id: string, name: string}>} input.members
 * @param {(id: string) => string} input.personaOf 某个 id 解析后的人设文本。
 *   团队模式下这里 **只有正文**：单人骨架不灌入，因为
 *   {@link TEAM_COMMON_RULES} 携带了其中仍然适用的部分，而按成员灌入会为
 *   每个人重复同样的 1543 字。
 * @param {string} input.task 用户的消息（在用户回合中重复出现）
 * @param {TurnScale} [input.scale] 回复期望的规模等级；只驱动提示词的
 *   紧凑/澄清子句——绝不驱动 token 上限，那是 {@link turnBudget} 里的
 *   技术性止步
 * @returns {string}
 */
export function simulationSystemPrompt({ team, members, personaOf, task, scale = "task" }) {
  const name = oneLine(team?.name) || "临时小队";
  const rows = Array.isArray(members) ? members : [];
  const background = typeof team?.background === "string" ? team.background.trim() : "";
  const lines = [];

  lines.push("【团队讨论 · 单次生成】");
  lines.push(
    `你要在一段话里写出「${name}」这 ${rows.length} 个人围绕用户任务的一场自然讨论。你不是主持人，也不是旁白：没有你的台词，没有总结，没有「以上」。你只负责把她们各自会说的话按顺序写出来。`,
  );
  lines.push("");

  if (background !== "") {
    lines.push("【团队背景】");
    lines.push(background);
    lines.push("");
  }

  lines.push("【角色】");
  for (const row of rows) {
    const memberName = oneLine(row?.name) || oneLine(row?.id);
    const role = oneLine(team?.roles?.[row?.id]);
    const persona = textOf(personaOf, row?.id);
    lines.push(`◆ ${memberName}${role === "" ? "" : `（${role}）`}`);
    if (persona !== "") {
      lines.push(persona);
    } else {
      lines.push("（没有额外人设；只按她的名字和身份说话。）");
    }
    lines.push("");
  }

  /*
   * 一次，而不是每成员一次。上面的规则由全屋共享；唯一随成员变化的是
   * 她自己的文本。
   */
  lines.push(...TEAM_COMMON_RULES);
  lines.push("");

  lines.push("【输出格式】");
  lines.push("每一次发言单独成段：段首写她的名字，名字夹在〔〕里，名字后面直接接着台词。");
  lines.push("");
  lines.push(`${SEG_OPEN}${rows[0] ? oneLine(rows[0].name) || oneLine(rows[0].id) : "名字"}${SEG_CLOSE}（神态或动作）台词正文。`);
  lines.push(`${SEG_OPEN}${rows[1] ? oneLine(rows[1].name) || oneLine(rows[1].id) : "名字"}${SEG_CLOSE}（神态或动作）台词正文。`);
  lines.push("");
  lines.push("下一个人开口时另起一段，同样用〔名字〕开头。不需要写结束标记——段与段之间空一行就够了。");
  lines.push("标点、括号、台词正文都按角色原本会说的样子写，不要改写、不要润色成旁白。名字后面不要再加冒号。");
  lines.push("");

  lines.push("【规矩】");
  lines.push(`1. 只能使用这些名字：${rows.map((row) => oneLine(row?.name) || oneLine(row?.id)).join("、")}。不要造新角色，不要写主持人或系统的句子。`);
  lines.push("2. 一次发言一段；同一名角色可以在一场讨论里说多段。被回答、被点名的人这一轮必须开口；其他人可以只说一句，也可以不说。");
  lines.push("3. 括号里的神态、动作、语气是允许的；但它属于正在说话的那个人。");
  lines.push("4. 不要写别人没说出口的内心（例如「她其实在想……」）。每个人只知道自己视角里的事。");
  lines.push("5. 没被点名不代表封嘴：真有非说不可的事（警告、拦人、忍不住）就插一句短的；没事就安静听着，不用为了凑齐人数硬挤一句。");
  lines.push("6. 台词里不要出现实现细节黑话：总线、广播、第 N 轮、msg-、replyTo、回执、子 Agent、运行、recipient、委派。这些不是角色会说的话。");
  lines.push("7. 自然收尾即可，不强求所有人达成一致；分歧照实写出来，不要替她们裁决。");
  lines.push("8. 讨论该停就停：主要问题说清了、重要分歧被回应或被明确保留，就自然收尾。不用凑轮数，也不用所有人达成一致。");
  /*
   * 收尾义务（plan A）：写进提示词，全程不做任何 token 监控。原因是物理性
   * 的——模型数不了自己的 token，所以「在预算的 85% 开始收尾」是房间里
   * 谁都执行不了的指令。它改为绑定在发言者能够判断的事情上：要点是否已
   * 了结，以及是否还有人没开口。
   *
   * 它也不是「人人总结」：一句问候被一行答完就结束了，硬塞给它一份四段式
   * 报告正是这个引擎存在的意义所要避免的假象。覆盖优先于收尾——绝不能靠
   * 跳过一个从未得到回合的成员来到达最后一位发言者。
   */
  lines.push("9. 要结束的时候，由最后接话的那个人把结论、还没谈拢的分歧、下一步说清；没定的就说没定。没被点名、也没插话的人不必为了凑齐而补一句——这一轮谁开口由内容决定，不由人数决定。寒暄这种一层就问完的，不用刻意总结。");
  lines.push("10. 整段话里除了〔名字〕和台词，不要写任何旁白、说明、标题或「以上」之类的收尾。");
  /*
   * 规模子句（A）。它是引导，不是上限——上限是 `maxTokens`——并且它只会
   * *收窄* 房间的回答，不会给每个人发一句写好的台词。「哈喽」用三行短句
   * 回答而不是一场 664 token 的戏，意义在于角色仍是她们自己，只是不为
   * 一句问候演出整整一幕。
   */
  if (scale === "social") {
    lines.push("11. 这一轮只是打招呼或顺口回应，不用演完整场：被回应的人接一句就够，说短句，别铺陈、别展开成对话戏，别人可以不出声。");
  } else if (scale === "complex") {
    lines.push("11. 这一轮是个需要认真做的大任务：可以充分讨论、给足细节，别为求短而吞掉关键内容。");
  }
  lines.push("");
  lines.push("【用户任务】");
  lines.push(typeof task === "string" ? task.trim() : "");

  return lines.join("\n");
}

/**
 * 调用模型时使用的消息。
 *
 * 纯消息值，形状与 `dsh-llm` 自己的一致：一个 id、一个 role、一个 content
 * 块数组。在这里构造而不是从 SDK 导入，是为了让本模块保持零依赖，并可在
 * 宿主之外测试。
 *
 * ## 为什么追问文本搭乘 **用户** 消息而不是 assistant 消息
 *
 * 续写必须向模型展示已经说过的内容。自然的形状是
 * `[system, user(task), assistant(transcript), user("keep going")]`，但宿主的
 * assistant 消息携带本插件无法正确铸造的 `source` 元数据，而错误的
 * `source.kind` 恰是那种只在真实 provider 上才会失败的东西——在用假流的
 * 测试里永远不会。一条 *引用* 对话记录的单一用户消息对每个适配器都合法，
 * 不需要新 role，还把边界说得明明白白。代价是多一行包装；好处是这条路
 * 不可能成为在用运行中出问题的地方。
 *
 * @param {object} input
 * @param {string} input.prompt 系统提示词
 * @param {string} input.task 用户的消息
 * @param {string} [input.memory] 此前回合说了什么，由 `renderMemoryBlock`
 *   预先构建——记忆关闭或为空时为 ""
 * @param {string} [input.transcript] 房间已经说过的内容，逐字
 * @param {ReadonlyArray<string>} [input.silent] 从未发言的成员
 * @param {"ceiling"} [input.reason] 为什么再发起一次请求
 * @returns {Array<object>}
 */
export function simulationMessages({ prompt, task, memory = "", transcript = "", silent = [], reason = "" }) {
  const said = typeof transcript === "string" ? transcript.trim() : "";
  const missing = Array.isArray(silent) ? silent.filter((one) => typeof one === "string" && one !== "") : [];
  const past = typeof memory === "string" ? memory.trim() : "";
  let userText = typeof task === "string" ? task : "";
  if (past !== "") {
    /*
     * 记忆总是搭在当前请求 *前面*，并且始终在同一个用户消息里。单独的
     * assistant 消息是宿主无法安全铸造的形状（见下），而第二条用户消息
     * 会让记忆看起来像用户刚输入的东西。一块内容、一条边界线，完事。
     */
    userText = `${past}\n\n${userText}`;
  }
  if (said !== "" || missing.length > 0) {
    const parts = ["【用户这一轮说的】", userText];
    if (said !== "") {
      parts.push("", "【你们已经说过的】", said);
    }
    parts.push("", "【接下来】");
    if (reason === "ceiling") {
      parts.push(
        "上面那段话写到一半被中途掐断了（可能是长度限制，也可能是连接断掉），这是这一轮的最后一段。接着往下写：从下一位发言者的〔名字〕开始，不要重复、概括或改写上面任何一句，也不要写「继续」之类的说明。如果上一句还没说完，先用原说话人的〔名字〕重开一段把它补完整。",
      );
      /*
       * 覆盖优先于收尾，这里也一样。旧文本只说「接着写」，所以一次运行
       * 可以把两次续写都花在复述同一场讨论上，而且仍以截断告终：第二个
       * 请求里没有任何话要求房间停下，也没有任何话告诉它谁还没开口。
       * 这两件事说起来很便宜，却无法从对话记录本身推断出来。
       */
      if (missing.length > 0) {
        parts.push(
          `还没开口的人：${missing.join("、")}。当下的内容真需要她们接，就顺势给一句；不需要就别为了凑齐硬塞。说完直接收尾，别让已经说过的人再来一轮。`,
        );
      }
      parts.push(
        "写完就收：由最后一个接话的人把结论、还没谈拢的分歧、下一步说清，别再开新话题、别再展开新的争论。",
      );
    }
    userText = parts.join("\n");
  }
  return [
    {
      id: randomUUID(),
      role: "system",
      content: prompt === "" ? [] : [{ type: "text", text: prompt }],
      source: { kind: "system-prompt" },
    },
    {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: userText }],
      source: { kind: "user" },
    },
  ];
}

/**
 * 一种可以 **逐 token** 喂入的段落协议解析器。
 *
 * 一个段落以下列情形中最先出现者结束：
 *
 *   1. 匹配的 `〔/名字〕`，如果模型写了的话；
 *   2. 另一位 **已知** 发言者的 `〔名字〕`，对话记录实际读起来正是如此——
 *      下一个人开口就是上一个人的结束；
 *   3. 流结束，由 `flush()` 转成最终段落。
 *
 * 规则 2 不是为了宽容而宽容。第一次在用运行产出的正是这种形状的五行可读
 * 台词，而要求规则 1 的解析器输出了 `segments=0`、四条 `unclosed` 诊断、
 * 一行警告，以及整段被当作散文回显的记录。人读 `〔托尔〕…〔康娜〕…` 完全
 * 没问题；解析器现在也这样读。
 *
 * 仍然 **不是** 台词的东西：第一个标记之前的文本、标记了不属于本团队之人
 * 的名字（`unknown`），以及游离的关闭标记。它们成为诊断信息，绝不作为
 * 某人的发言行（设计文档 §3.2, §3.6）。
 *
 * @param {object} input
 * @param {ReadonlyArray<string>} input.names 有效的显示名
 * @returns {{push: (chunk: string) => object[], flush: (options?: {truncated?: boolean}) => object[], rest: () => string}}
 */
export function createSegmentParser({ names }) {
  const valid = new Set((Array.isArray(names) ? names : []).map((one) => oneLine(one)).filter((one) => one !== ""));
  let buffer = "";
  let inside = null; // { name }
  let order = 0;

  const emit = (event) => ({ ...event, index: order++ });

  /** 用目前缓冲的文本关闭打开中的段落。 */
  function close(events) {
    const name = inside.name;
    const text = buffer;
    buffer = "";
    inside = null;
    events.push(emit({ type: "segment", name, text, closed: true }));
  }

  function drain() {
    const events = [];
    while (true) {
      if (inside === null) {
        const open = buffer.indexOf(SEG_OPEN);
        if (open < 0) {
          // 完全没有标记。为下一个数据块保留有界的尾部；它之前的内容是
          // 模型写在任何段落之外的散文。
          if (buffer.length > STRAY_LIMIT) {
            const stray = buffer.slice(0, buffer.length - STRAY_LIMIT);
            if (stray.trim() !== "") events.push(emit({ type: "stray", text: stray.trim() }));
            buffer = buffer.slice(-STRAY_LIMIT);
          }
          break;
        }
        if (open > 0) {
          const stray = buffer.slice(0, open);
          if (stray.trim() !== "") events.push(emit({ type: "stray", text: stray.trim() }));
          buffer = buffer.slice(open);
        }
        const closeAt = buffer.indexOf(SEG_CLOSE);
        if (closeAt < 0) break; // 标记被拆到多个 token：等剩余部分
        const token = buffer.slice(SEG_OPEN.length, closeAt);
        const name = token.trim();
        if (name.startsWith("/")) {
          // 没有打开段落的关闭标记：游离内容，不是台词。
          events.push(emit({ type: "stray", text: `${SEG_OPEN}${token}${SEG_CLOSE}` }));
          buffer = buffer.slice(closeAt + SEG_CLOSE.length);
          continue;
        }
        if (!valid.has(name)) {
          events.push(emit({ type: "unknown", name }));
          buffer = buffer.slice(closeAt + SEG_CLOSE.length);
          continue;
        }
        inside = { name };
        buffer = buffer.slice(closeAt + SEG_CLOSE.length);
        continue;
      }

      // 段落内部：显式关闭标记优先，其次是新发言者。
      const endMark = `${SEG_END_PREFIX}${inside.name}${SEG_CLOSE}`;
      const endAt = buffer.indexOf(endMark);
      const nextOpen = buffer.indexOf(SEG_OPEN);
      if (endAt >= 0 && (nextOpen < 0 || endAt <= nextOpen)) {
        // 显式的 `〔/名字〕`：标记去掉，台词保留。
        const rest = buffer.slice(endAt + endMark.length);
        buffer = buffer.slice(0, endAt);
        close(events);
        buffer = rest;
        continue;
      }
      if (nextOpen >= 0 && readOpen(buffer, nextOpen, valid) !== null) {
        // 下一位已知发言者开口：这一行在该标记开始处结束。
        const rest = buffer.slice(nextOpen);
        buffer = buffer.slice(0, nextOpen);
        close(events);
        buffer = rest;
        continue;
      }
      break;
    }
    return events;
  }

  return {
    push(chunk) {
      if (typeof chunk !== "string" || chunk === "") return [];
      buffer += chunk;
      return drain();
    },
    /**
     * 流结束。
     *
     * 残留的打开段落是最后一行，而不是坏行——除非 `truncated` 说明流被
     * 切断，那是调用方的知识（它持有 finish reason），不在这里猜测。
     *
     * @param {{truncated?: boolean}} [options]
     * @returns {object[]}
     */
    flush({ truncated = false } = {}) {
      if (inside !== null) {
        const name = inside.name;
        const text = buffer;
        buffer = "";
        inside = null;
        return [emit({ type: "segment", name, text, closed: truncated !== true, truncated: truncated === true })];
      }
      /*
       * 最后一个段落之后的散文仍然是输出。它曾被执行的静默丢弃——一段
       * 从未打开任何段落的完整回复同样如此，而那正是用户会丢失一条实际
       * 写出的回答的唯一情形（设计文档 §3.6）。在这里报告它，才能把
       * 「没人说话」和「没人遵守格式」区分开。
       */
      const leftover = buffer.trim();
      buffer = "";
      if (leftover === "") return [];
      return [emit({ type: "stray", text: leftover.slice(0, STRAY_LIMIT) })];
    },
    rest() {
      return buffer;
    },
  };
}

/**
 * 解析器的批处理形态，供测试和一次性渲染使用。
 *
 * @param {string} text
 * @param {ReadonlyArray<string>} names
 * @returns {{segments: object[], diagnostics: object[]}}
 */
export function parseSegments(text, names) {
  const parser = createSegmentParser({ names });
  const events = [...parser.push(typeof text === "string" ? text : ""), ...parser.flush()];
  return splitEvents(events);
}

/**
 * 把解析器原始事件切分为台词与诊断。
 *
 * @param {ReadonlyArray<object>} events
 * @returns {{segments: object[], diagnostics: object[]}}
 */
export function splitEvents(events) {
  const segments = [];
  const diagnostics = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "segment") segments.push(event);
    else diagnostics.push(event);
  }
  return { segments, diagnostics };
}

/**
 * 把一个段落渲染成读者看到的那一行：`名字：台词`。
 *
 * 除首尾空白外对话逐字保留。在这里折叠内部空白会悄悄改写某人的段落，
 * 而这正是协议禁止的。
 *
 * @param {{name?: string, text?: string}} segment
 * @param {string} [sep]
 * @returns {string}
 */
export function renderSegment(segment, sep = SIM_SPEAKER_SEP) {
  const name = oneLine(segment?.name);
  if (name === "") return "";
  const raw = typeof segment?.text === "string" ? segment.text.trim() : "";
  /*
   * 提示词要求名字和台词之间什么都不加，但写出 `〔托尔〕：台词` 的模型对
   * 世界并没有理解错——只是与本渲染器添加的分隔符重复了。去掉那个行首
   * 冒号，区别就是 `托尔：：台词` 和 `托尔：台词`。
   */
  const text = raw.replace(/^[：:]\s*/, "");
  if (text === "") return name;
  return `${name}${sep}${text}`;
}

/**
 * 把已关闭的段落渲染为回复正文。
 *
 * @param {ReadonlyArray<object>} segments
 * @returns {string}
 */
export function renderTranscript(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => renderSegment(segment))
    .filter((line) => line !== "")
    .join("\n\n");
}

/** 没人发言时使用的那一句话，让空回复永不空白。 */
export const SIM_SILENCE = "（这一轮没有人开口。）";

/**
 * 从未产出段落的成员。
 *
 * 注意这 *不是* 什么：它不是「谁在第二轮保持沉默」。设计禁止从段落顺序
 * 推导回合（§4.1），所以运行时能诚实回答的唯一问题是「这个人在本次运行中
 * 到底开没开口」——下面的措辞说的正是这个，而不暗示一个按回合记账的台账。
 *
 * @param {ReadonlyArray<string>} names
 * @param {ReadonlyArray<{name?: string}>} segments
 * @returns {string[]}
 */
export function silentMembers(names, segments) {
  const spoke = new Set();
  for (const segment of Array.isArray(segments) ? segments : []) {
    const name = oneLine(segment?.name);
    if (name !== "") spoke.add(name);
  }
  const silent = [];
  for (const candidate of Array.isArray(names) ? names : []) {
    const name = oneLine(candidate);
    if (name === "" || spoke.has(name) || silent.includes(name)) continue;
    silent.push(name);
  }
  return silent;
}

/**
 * **先看 finish reason**、再看解析结果地决定运行状态。
 *
 * 这是 §6.2 表格的代码化。finish reason 是模型有意结束的唯一证据；仅仅
 * 看起来完整的缓冲区不是。
 *
 * @param {object} input
 * @param {string|null} [input.finishKind] `stop` | `max-tokens` | `aborted` | `error` | `refusal`
 * @param {boolean} [input.aborted] 调用方的信号已被中止
 * @param {number} [input.segments] 渲染出的段落数
 * @param {number} [input.structural] 未知发言者事件数
 * @param {number} [input.stray] 段落之外发现的散文
 * @param {boolean} [input.endedWithoutFinish] 可迭代对象在没有 finish 块的情况下结束
 * @param {boolean} [input.tailIncomplete] 文本停在未闭合的引号/括号内
 * @returns {string}
 */
/**
 * 一次运行可以携带多少段落协议之外的散文而仍算正常结束。
 *
 * 零在两个方向上都是错的。模型稳定地会在两行之间写一句短插话（"（她顿了顿）"、
 * 一个场景节拍、一个舞台指示），而因为四十个这样的字符就失败的运行会在
 * 一段完全可读的对话上报告 `incomplete`——「产物没有完整解析」的通知会
 * 告诉用户出了问题，而实际上什么都没发生。
 *
 * 一整段框架话（"以上是大家的意见，希望大家满意"）是另一回事：那是协议
 * 没有被遵守，而且展示的对话记录会略去它，所以称运行正常会掩盖一个真实
 * 缺陷。120 字符大致就是一段这样的话，并且远多于任意两位发言者之间任何
 * 合法的节拍。
 */
export const STRAY_TOLERANCE_CHARS = 120;

/**
 * 一句「句子中段被切」的回复必须已经携带的最少文本量，才值得再发一次请求。
 * 碰巧停在开括号上的三个字的回复不是丢了结尾的讨论；一段话才是。刻意保持
 * 很低——精确性活在检测器里，不在这个下限里——但必须非零，这样一句以
 * 单行作答的模型留下的游离 `「` 就不能启动一次 60 秒的续写。
 */
export const TAIL_RESUME_MIN_CHARS = 80;

/**
 * 一句回复是否被切在 **句子中段**，而不是有意结束。
 *
 * `max-tokens` 不是回复半途而废的唯一方式。在流中途停滞的 provider 连接会
 * 让这次尝试以 `stop` 结束（流已关闭，所以最后一个 chunk 确实是终点的），
 * 文本于是停在一个它从未闭合的结构里：`「` 没有 `」`，`（` 没有 `）`。
 * 解析器看不出这一点——最后一个段落是合法段落，它只是停在了一个词的
 * 中间——所以 `simulationStatus` 曾把这种运行称为 `converged`，而另一半
 * 永远没被要过。
 *
 * 检查刻意收窄：只检查最后片段（最后一个句子边界之后的文本），且只统计
 * **未闭合** 的定界符。以 `。` / `！` / `？` / `……` 结束的回复什么也没
 * 打开，不会被标记；以 `（她笑了笑）` 结束的回复括号平衡，也不会被标记。
 * 假阳性的代价是整整一次额外请求，所以信号是「我们正处在一个从未闭合的
 * 引号或括号内」——有意停止的回复几乎不会留下这种东西。
 *
 * @param {string} text 原始回复，包含协议标记
 * @returns {boolean}
 */
export function isTailIncomplete(text) {
  const raw = typeof text === "string" ? text : "";
  const t = raw.replace(/\s+$/, "");
  if (t.length === 0) return false;
  /*
   * 最后片段：句子可能结束的最后位置之后的一切。空行也是边界，因为一个
   * 段落的收尾空行意味着下一个东西重新开始。
   */
  const boundary = Math.max(
    t.lastIndexOf("\n\n"),
    t.lastIndexOf("。"),
    t.lastIndexOf("！"),
    t.lastIndexOf("？"),
    t.lastIndexOf("…"),
  );
  const fragment = boundary >= 0 ? t.slice(boundary + 1) : t;
  if (fragment.trim() === "") return false;
  const pairs = [
    ["「", "」"],
    ["“", "”"],
    ["（", "）"],
    ["《", "》"],
    ["(", ")"],
  ];
  for (const [open, close] of pairs) {
    const lastOpen = fragment.lastIndexOf(open);
    const lastClose = fragment.lastIndexOf(close);
    if (lastOpen !== -1 && lastOpen > lastClose) return true;
  }
  // 以悬空的开字符结束，后面什么都没有。
  if (/[「“（《(]$/.test(t)) return true;
  return false;
}

export function simulationStatus({
  finishKind = null,
  aborted = false,
  segments = 0,
  structural = 0,
  stray = 0,
  strayChars = 0,
  endedWithoutFinish = false,
  tailIncomplete = false,
} = {}) {
  if (aborted === true) return "cancelled";
  const kind = oneLine(finishKind);
  if (kind === "aborted") return "cancelled";
  if (kind === "error") return "error";
  if (kind === "max-tokens") return "limit_reached";
  if (kind === "refusal") return "incomplete";
  if (endedWithoutFinish === true) return "incomplete";
  if (kind === "stop" || kind === "completed") {
    // 无发言且无结构性损坏就是合法的「全员沉默」情形（设计文档 §6.2）。
    // 有发言但存在未知发言者是部分解析，不是成功：「有些行可读」不等于
    // 「运行正常完成」（§3.6）。
    if (Number(structural) > 0) return "incomplete";
    /*
     * 空回复是合法的沉默；塞满散文而没有段落的回复不是。这个区别很重要，
     * 因为第二种正是无视协议的模型的样子，而把它称为「没人说话」既给运行
     * 贴错标签，又把文本藏起来（§6.3: 无法解析的输出 → `incomplete`）。
     */
    if (Number(segments) === 0 && Number(stray) > 0) return "incomplete";
    /*
     * 可读段落 **加上** 一段框架话是部分解析，不是干净的运行。这些行保留
     * 并展示——它们被写出来了——但状态必须说明对话记录并不是模型说的
     * 全部，否则无框架的回复看起来是完整的，而被协议拒绝的部分悄悄消失
     * （设计文档 §3.6: 绝不吞掉输出）。
     *
     * 起决定作用的是阈值，不是计数：为什么零会给每个含舞台指示的运行贴错
     * 标签，见 `STRAY_TOLERANCE_CHARS`。
     */
    if (Number(segments) > 0 && Number(strayChars) > STRAY_TOLERANCE_CHARS) return "incomplete";
    /*
     * `stop` 只说明流关闭了，不说明模型选择关闭它。在流中途死掉的连接以
     * `stop` 结束，回复停在一个未闭合的 `「`/`（` 里。把这称为 `converged`，
     * 就是被截断的运行被记录成完整的——而且永远不会再被要求补完。
     */
    if (tailIncomplete === true) return "incomplete";
    return "converged";
  }
  return "incomplete";
}

/**
 * 内部黑话命中项，作为数据而不是布尔值。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function internalLeaks(text) {
  const haystack = typeof text === "string" ? text : "";
  return INTERNAL_TERMS.filter((term) => haystack.includes(term));
}

/** 去首尾、折叠空白的显示名；绝不抛出。 */
function oneLine(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/**
 * 提示词将会包含的人设文本：去首尾，并兼容宿主的两种形状（`"text"` 或
 * `{ ok, text }`）。
 *
 * 导出是因为运行时对提示词构建所用的同一字符串做哈希。对 *未去首尾* 的
 * 文件取的哈希会在快照与组装出的提示词对比的那一刻失配，快照随后就会对
 * 一次完美复现的运行报告漂移。
 */
export function textOf(personaOf, id) {
  if (typeof personaOf !== "function") return "";
  try {
    const found = personaOf(id);
    if (typeof found === "string") return found.trim();
    if (found && typeof found.text === "string") return found.text.trim();
    return "";
  } catch {
    return "";
  }
}

/**
 * 如果 `buffer` 从 `at` 开始是一个完整、有效的打开标记，返回其名字。
 * 否则返回 `null`——调用方等待更多 token。
 */
function readOpen(buffer, at, valid) {
  const close = buffer.indexOf(SEG_CLOSE, at + SEG_OPEN.length);
  if (close < 0) return null;
  const token = buffer.slice(at + SEG_OPEN.length, close).trim();
  if (token === "" || token.startsWith("/")) return null;
  return valid.has(token) ? token : null;
}
