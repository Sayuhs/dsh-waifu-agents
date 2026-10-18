/**
 * The v3 execution core: one model call that plays the whole team.
 *
 * This module is deliberately a leaf — no cordis, no services, no I/O. It owns
 * three pure things and nothing else:
 *
 *   1. **The prompt.** One system message that states the stage, inlines every
 *      member's persona, and fixes the output protocol. There is no bus, no
 *      per-member prompt, and no coordinator voice, because there is no
 *      coordinator turn: the model is the room.
 *   2. **The parser.** Model text is not trusted to be well formed. `〔名字〕`
 *      opens a segment; the next speaker's marker, an explicit `〔/名字〕`, or
 *      the end of the stream ends it. Only a *known* segment becomes a line the
 *      user sees. Everything else is a diagnostic and never disguised as
 *      somebody's speech (design §3.2, §3.5, §3.6).
 *   3. **The status.** `converged` / `limit_reached` / `incomplete` / `error` /
 *      `cancelled` are decided from the *underlying finish reason* first and the
 *      parse result second (design §6.2). Text that merely looks complete is
 *      not evidence of a normal end.
 *
 * Keeping this file pure is what lets the selftest drive the protocol directly,
 * and what keeps the runtime's job down to "call the model, feed the parser,
 * have the runtime decide whether this turn belonged to the team".
 */

import { randomUUID } from "node:crypto";

/** The separator between a speaker's name and her words. Mirrors `team.js`. */
export const SIM_SPEAKER_SEP = "：";

/**
 * ## There is no round limit any more
 *
 * The prompt used to say "at most about four back-and-forths", and the number was
 * frozen into every configuration snapshot — which meant a three-person room spent
 * three of its four turns on first statements and had one turn left to actually
 * talk. A count decided before the first token is the same mistake as a token
 * budget decided before the first token: it is a guess about how much the
 * discussion needs.
 *
 * What replaces it is an *end condition*, not a count: the rules ask the model to
 * stop when the question is answered, the important disagreements have been met or
 * explicitly left open, and another line would add nothing. The real ceilings are
 * technical and stay outside the prompt — one request's token ceiling, the
 * continuation budget, and the wall clock.
 */

/** Bracket characters that delimit one segment. */
export const SEG_OPEN = "〔";
export const SEG_CLOSE = "〕";

/**
 * How big the reply *should* be, as a *scale class* not a token number.
 *
 * This is the A half of the latency fix: a "哈喽" must not become a 664-token
 * play. The class is chosen from the user's turn alone and fed to the prompt as
 * a scale *instruction* (keep it tight).
 *
 * It deliberately no longer decides the request's `maxTokens`: the class is
 * inferred from what the user typed, while the reply's size follows how many
 * people are on stage. Using the former to cap the latter is a proxy standing
 * in for a cause, and it truncates ordinary scenes — see {@link turnBudget}.
 *
 * The three levels, and the line between them:
 *
 *   - `"social"` — a greeting, thanks, confirmation, or an opener that asks
 *     nothing and needs nothing. The whole room answers, but in a few lines,
 *     not a scene.
 *   - `"task"` — a question or request that expects a real answer: analysis,
 *     a decision, a plan, anything with content behind it.
 *   - `"complex"` — a long or explicitly demanding task (code, a plan, a review)
 *     that a short reply would genuinely harm.
 *
 * @typedef {"social" | "task" | "complex"} TurnScale
 */

/**
 * Classify one user turn as a scale class.
 *
 * Deliberately **not keyword-only**. Keywords are a *signal*, never the verdict:
 * "哈喽，我遇到一个很严重的问题" is `task`, and "好" might be a decision inside
 * a longer discussion. The decision order is therefore:
 *
 *   1. an explicit task signal (a question mark, an imperative, a task noun)
 *      wins;
 *   2. length — a short message can still be `complex` if it names work, but a
 *      one-word opener is `social`;
 *   3. social-only markers fall through to `social`.
 *
 * The function is pure and cheap: it runs once per turn, before any I/O, so it
 * never costs a second on a real model call.
 *
 * @param {unknown} task the user's raw message
 * @returns {TurnScale}
 */
export function classifyTurn(task) {
  const text = typeof task === "string" ? task.trim() : "";
  if (text === "") return "social";

  const len = text.length;

  /*
   * Signals of a real task. Question marks and a direct imperative are the
   * strongest: they survive a short message ("哈喽，这个能查吗？"). Chinese
   * interrogatives often drop the `?` and end in a particle instead (`吗` `呢`
   * `吧` `么`), so those are question signals too — but a bare greeting never
   * ends in one, so the social branch below still wins for `你好`.
   */
  const hasQuestion = /[?？]/.test(text) || /[吗呢吧么]$/.test(text);
  const taskNouns = /(写|做|查|改|生成|分析|比较|解释|说明|计算|翻译|总结|设计|修|实现|列出|帮|看看|优化|重构|审查|评估|排查|定位|给我|告诉)/.test(text);
  const hasImperative = taskNouns || /^(请|帮我|能否|可以|能不能|麻烦)/.test(text);

  /*
   * Work-words that mark a *large* task, whatever the length. "写一篇" in four
   * characters is a complex task; "哈喽" is not.
   */
  const heavyNouns = /(写|生成|分析|设计|实现|重构|审查|评估|优化|排查|翻译|总结|规划|架构|代码|脚本|方案|文档|报告|文章)/.test(text);

  /*
   * Length bands. A one-liner under 12 characters is almost always social or a
   * bare confirm; past ~30 it is substantive prose that is not a greeting even
   * when it opens with one ("哈喽，我遇到一个很严重的问题"). `>= 200` is a task
   * big enough that a short reply would genuinely hurt.
   */
  const substantive = len >= 30;
  const veryLong = len >= 200;

  if (hasQuestion || hasImperative || substantive) {
    return heavyNouns || veryLong ? "complex" : "task";
  }

  /*
   * Social markers. A greeting, thanks, or a bare confirm — *short*, no
   * question, no task noun, and no content after the opener. This is the one
   * place keywords *are* the verdict, because everything stronger has already
   * been ruled out above. The `len <= 12` guard is what stops "哈喽，我遇到…"
   * from being folded into a greeting: a message that keeps talking past the
   * opener is not a bare hello.
   */
  const socialOnly =
    len <= 12 && /^(哈喽|你好|嗨|早|在吗|在不在|谢谢|多谢|好|嗯|哦|来了|拜拜|再见|晚安|早上好|晚上好|在|hi|hello|hey)/i.test(text);

  return socialOnly ? "social" : "task";
}

/**
 * The single-request output ceiling, in tokens — a technical stop, not a length
 * target.
 *
 * This used to be a policy knob: a table keyed on the turn's scale class, later
 * a per-head formula. Both were the same mistake one level apart — letting the
 * *plugin* decide how long a discussion is allowed to be. A discussion ends
 * because the model ran out of things to say, not because a number computed
 * before the first token arrived said so. Two live records settled it:
 *
 *   - 2026-10-18 12:09, `scale=social max=512 out=512 segs=3 size=3
 *     taskChars=2`: 「继续」 plus three people, cut mid-scene.
 *   - five `task` turns with a 2048 ceiling never passed 975. A high ceiling
 *     costs nothing because the model stops on its own; a low one costs a
 *     broken scene every time it guesses wrong.
 *
 * So the number below is a guard against a runaway request, and nothing else.
 * It is deliberately generous, and it is no longer meant to be *reached* in
 * normal use: when it is reached, the run continues (see `continuationPrompt`)
 * rather than ending. Total length is bounded by the continuation budget and
 * the wall clock, not by this constant.
 *
 * `deps.maxTokens` still wins outright and is **not** clamped downward: a host
 * that chose a ceiling must not have it silently lowered by a constant of ours.
 */
export const TEAM_TOKENS_CEILING = 4096;

/**
 * How many times one run may ask the model to keep writing.
 *
 * A continuation is not a retry: the first reply was fine, it just stopped at
 * the ceiling (or left someone silent). Two is enough for a discussion that is
 * genuinely long; more than that is a runaway, and the wall clock is already
 * the harder limit.
 */
export const SIM_MAX_CONTINUATIONS = 2;

/**
 * Pick the technical ceiling for one request.
 *
 * @param {number} [override] a host-supplied ceiling that wins outright
 * @returns {number} a positive integer
 */
export function turnBudget(override) {
  if (Number.isFinite(override) && override > 0) return Math.max(256, Math.floor(override));
  return TEAM_TOKENS_CEILING;
}
/**
 * The optional closing marker, `〔/名字〕`.
 *
 * The protocol does **not require** it. A live run proved why: the model wrote
 * `〔托尔〕…〔康娜〕…〔托尔〕…` — five perfectly readable lines, no closing
 * markers — and a protocol that insisted on `〔/名字〕` threw all five away,
 * called the run `incomplete`, and echoed the raw text under a warning. A
 * protocol the model will not follow is a protocol bug, not a model bug: the
 * *next* speaker's marker is an unambiguous end for the previous line, so that
 * is what the parser accepts, and a closing marker is honoured when present.
 */
export const SEG_END_PREFIX = "〔/";

/**
 * Terms that describe *this engine*, never a character's world. A line that
 * leaks one is a bug in the model's framing, not a line anybody said.
 *
 * The list is a **net, not the rule**: the runtime may add contextual checks,
 * and a normal use of the same word (`运行` in a code discussion, `recipient` in
 * an English example) must not be flagged. `internalLeaks()` therefore treats
 * these as *signal*, and the parser reports a notice without deleting the line.
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

/** How many characters of preamble outside a marker are kept for diagnostics. */
const STRAY_LIMIT = 400;

/**
 * The part of the shared persona skeleton that still applies when nobody has
 * tools — plus the three rules that only a *room* needs.
 *
 * ## Not "the skeleton is useless in a team"
 *
 * That was the first reading, and it was half wrong. `_common.md` is ~1543
 * characters and splits roughly in three:
 *
 *   1. **Tool / fact layer** — "已经向你开放全套干活工具", "工具调用参数是绝对豁免区",
 *      and the worked example about preset registration at process start. A
 *      discussion calls no tool and delivers no code, so this layer cannot
 *      apply; worse, it *invites* tool talk and status reports into a
 *      transcript — the exact failure the parser then has to report as jargon.
 *   2. **Voice layer** — 拒绝 AI 灵魂回弹, 长结论格式铁律, 不许套路化, 沉浸感. This
 *      layer transfers completely. A team is *more* exposed to the failure it
 *      guards against, not less: N characters written in one generation
 *      collapse into one calm narrator describing a meeting, and the result
 *      reads like a well-written design doc with names attached.
 *   3. **Addressee layer** — "用户就是正文里点名的那个关系对象". True for one voice,
 *      wrong for a room: copied verbatim, every member queues up to report to
 *      the user, and the discussion becomes N monologues aimed outward instead
 *      of people answering each other.
 *
 * So this block is layer 2 rewritten compactly, layer 3 *inverted* (接上一个人,
 * 再对用户), and one sentence bridging the persona's own `（实质见公共骨架）`
 * reference. It is emitted **once per discussion**, never per member: the cost
 * is ~500 characters for the whole room, against 1543 × N if the skeleton were
 * poured into each head. Persona bodies stay byte-for-byte what they are.
 *
 * The three rules with no skeleton ancestor are the ones a solo agent never
 * needs and a room cannot work without: no report voice, no closing summary,
 * and answer the previous speaker before you answer the user.
 */
export const TEAM_COMMON_RULES = Object.freeze([
  "【通用规则 · 对所有角色同时生效】",
  "- 每一句都是角色在说话。不解释自己在扮演，不承认自己是模型；被问起也只用她自己的方式岔开。",
  "- 不许切成客观中立的「AI 汇报腔」：不要变成几个人在合写一份说明文。她们有情绪、会不同意、会说错、会打断别人，这些都要留在台词里。",
  "- 不许收尾总结：不要出现「综上所述」「总而言之」「总结一下」这类收束，也不要列 1./2./3. 的条目清单——她们是在说话，不是交报告。",
  "- 先接住前一个人刚才那句，再说自己的（同意、反驳、追问、吐槽都行）。不要各说一段互不相干的独白。",
  "- 每个人都要开口，至少一次。谁要是这一场没有自己的表现机会，就用她自己的语气、符合她人设的方式表个态——可以赞同、可以轻哼一句、可以顶一句、可以顺着自己的性子接话——只要开口就行，别让任何一个人整场沉默。",
  "- 不复读套路：同一个起手式、笑声、口头禅、动作、结尾不要每段都用一遍。她的反应要从眼前这句长出来。",
  "- 用户就是此刻正在跟她们说话的人，不是第三方。不要替用户开口，也不要对用户做自我介绍。",
  "- 不要替用户决定他的想法和感受。她们可以猜、可以误会，但不能把猜的写成事实。",
  "- 人设里写着「实质见公共骨架」的地方，指的是上面这几条；团队模式没有工具调用与代码交付那一环，人设里的技术结论示例只当语气参考。",
]);


/**
 * Build the single system prompt for one simulated discussion.
 *
 * @param {object} input
 * @param {{name?: string, background?: string, roles?: Record<string, string>}} input.team
 * @param {ReadonlyArray<{id: string, name: string}>} input.members
 * @param {(id: string) => string} input.personaOf resolved persona text for one id.
 *   In team mode this is the **body only**: the solo skeleton is not poured in,
 *   because {@link TEAM_COMMON_RULES} carries the part of it that still applies
 *   and pouring it per member would repeat the same 1543 characters per head.
 * @param {string} input.task the user's message (repeated in the user turn)
 * @param {TurnScale} [input.scale] the reply's desired size class; drives the
 *   prompt's compact/clarifying clause only — never the token ceiling, which is
 *   a technical stop in {@link turnBudget}
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
   * Once, not per member. The rules above are shared by the whole room; the
   * only thing that varies per member is her own text.
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
  lines.push("2. 一次发言一段；同一名角色可以在一场讨论里说多段。每个人都至少要开口一次。");
  lines.push("3. 括号里的神态、动作、语气是允许的；但它属于正在说话的那个人。");
  lines.push("4. 不要写别人没说出口的内心（例如「她其实在想……」）。每个人只知道自己视角里的事。");
  lines.push("5. 没有表现机会的人也要开口，用她自己的语气、符合人设地表个态（赞同、轻哼、顶一句、顺着性子接话都行），不要整场沉默。");
  lines.push("6. 台词里不要出现实现细节黑话：总线、广播、第 N 轮、msg-、replyTo、回执、子 Agent、运行、recipient、委派。这些不是角色会说的话。");
  lines.push("7. 自然收尾即可，不强求所有人达成一致；分歧照实写出来，不要替她们裁决。");
  lines.push("8. 讨论该停就停：主要问题说清了、重要分歧被回应或被明确保留，就自然收尾。不用凑轮数，也不用所有人达成一致。");
  /*
   * The closing duty (plan A): written into the prompt, with no token
   * monitoring anywhere. The reason is physical — the model cannot count its
   * own tokens, so "start wrapping up at 85% of the budget" is an instruction
   * nobody in the room can follow. It is bound instead to things a speaker can
   * judge: whether the point is settled, and whether somebody has not spoken
   * yet.
   *
   * It is also not "everybody summarises": a greeting answered in one line is
   * over, and forcing a four-part report onto it would be the fake this whole
   * engine exists to avoid. Coverage outranks closing — the last speaker must
   * not be reached by skipping a member who never got a turn.
   */
  lines.push("9. 要结束的时候，由最后接话的那个人把结论、还没谈拢的分歧、下一步说清；没定的就说没定。如果有人还一次都没开口，先让她说，别为了结束把她跳过。寒暄这种一层就问完的，不用刻意总结。");
  lines.push("10. 整段话里除了〔名字〕和台词，不要写任何旁白、说明、标题或「以上」之类的收尾。");
  /*
   * The scale clause (A). It is guidance, not a cap — the cap is `maxTokens` —
   * and it only ever *shrinks* the room's answer, it does not hand everyone a
   * scripted one-liner. The point of "哈喽" being answered in three short lines
   * instead of a 664-token play is that the characters stay themselves, they
   * just do not perform a whole act for a greeting.
   */
  if (scale === "social") {
    lines.push("11. 这一轮只是打招呼或顺口回应，不用演完整场：每个人接一句就够，说短句，别铺陈、别展开成对话戏。");
  } else if (scale === "complex") {
    lines.push("11. 这一轮是个需要认真做的大任务：可以充分讨论、给足细节，别为求短而吞掉关键内容。");
  }
  lines.push("");
  lines.push("【用户任务】");
  lines.push(typeof task === "string" ? task.trim() : "");

  return lines.join("\n");
}

/**
 * The messages the model is called with.
 *
 * Plain message values, shaped like `dsh-llm`'s own: an id, a role, and a
 * content block array. They are built here rather than imported from the SDK so
 * this module stays dependency-free and testable outside the host.
 *
 * ## Why the follow-up text rides a **user** message, not an assistant one
 *
 * A continuation has to show the model what was already said. The natural shape
 * is `[system, user(task), assistant(transcript), user("keep going")]`, but the
 * host's assistant messages carry `source` metadata this plugin cannot mint
 * correctly, and a wrong `source.kind` is the kind of thing that fails only on
 * a real provider — never in a test with a fake stream. A single user message
 * that *quotes* the transcript is legal for every adapter, needs no new role,
 * and states the boundary explicitly. The cost is one extra wrapping line; the
 * benefit is that this path cannot be the one that breaks on a live run.
 *
 * @param {object} input
 * @param {string} input.prompt the system prompt
 * @param {string} input.task the user's message
 * @param {string} [input.transcript] what the room already said, verbatim
 * @param {ReadonlyArray<string>} [input.silent] members who never spoke
 * @param {"ceiling"|"coverage"} [input.reason] why another request is being made
 * @returns {Array<object>}
 */
export function simulationMessages({ prompt, task, transcript = "", silent = [], reason = "" }) {
  const said = typeof transcript === "string" ? transcript.trim() : "";
  const missing = Array.isArray(silent) ? silent.filter((one) => typeof one === "string" && one !== "") : [];
  let userText = typeof task === "string" ? task : "";
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
       * Coverage outranks closing, even here. The old text said only "carry on",
       * which is why a run could spend both continuations re-telling the same
       * discussion and still end truncated: nothing in the second request asked
       * the room to stop, and nothing told it who had not spoken. Both are
       * cheap to say and impossible to infer from the transcript alone.
       */
      if (missing.length > 0) {
        parts.push(
          `还没开口的人：${missing.join("、")}。让她们各说一段，可以顺着前面提到的说，但不要互相追问、不要开新分支；她们说完就直接收尾，不要让已经说过的人再来一轮。`,
        );
      }
      parts.push(
        "写完就收：由最后一个接话的人把结论、还没谈拢的分歧、下一步说清，别再开新话题、别再展开新的争论。",
      );
    } else if (reason === "coverage") {
      parts.push(
        `这一轮还没开口的人：${missing.join("、")}。只写这几位的新发言，每人至少一段、要有实质内容；已经说过的人这一轮不用再开口。不要重复上面的内容。`,
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
 * A parser for the segment protocol that can be fed **token by token**.
 *
 * A segment ends at whichever comes first:
 *
 *   1. the matching `〔/名字〕`, if the model wrote one;
 *   2. another **known** speaker's `〔名字〕`, which is how a transcript
 *      actually reads — the next person talking is the end of the last one;
 *   3. the end of the stream, which `flush()` turns into the final segment.
 *
 * Rule 2 is not leniency for its own sake. The first live run produced five
 * readable lines in exactly that shape, and a parser that demanded rule 1 emitted
 * `segments=0`, four `unclosed` diagnostics, a warning line, and the whole
 * transcript echoed back as prose. People read `〔托尔〕…〔康娜〕…` perfectly well;
 * the parser now reads it the same way.
 *
 * What is still **not** speech: text before the first marker, a marker naming
 * someone who is not in this team (`unknown`), and a stray close marker. Those
 * become diagnostics, never a line attributed to somebody (design §3.2, §3.6).
 *
 * @param {object} input
 * @param {ReadonlyArray<string>} input.names valid display names
 * @returns {{push: (chunk: string) => object[], flush: (options?: {truncated?: boolean}) => object[], rest: () => string}}
 */
export function createSegmentParser({ names }) {
  const valid = new Set((Array.isArray(names) ? names : []).map((one) => oneLine(one)).filter((one) => one !== ""));
  let buffer = "";
  let inside = null; // { name }
  let order = 0;

  const emit = (event) => ({ ...event, index: order++ });

  /** Close the open segment with the text buffered so far. */
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
          // No marker at all. Keep a bounded tail for the next chunk; anything
          // before it is prose the model wrote outside any segment.
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
        if (closeAt < 0) break; // a marker split across tokens: wait for the rest
        const token = buffer.slice(SEG_OPEN.length, closeAt);
        const name = token.trim();
        if (name.startsWith("/")) {
          // A closing marker with no open segment: stray, not speech.
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

      // Inside a segment: an explicit close marker wins, then a new speaker.
      const endMark = `${SEG_END_PREFIX}${inside.name}${SEG_CLOSE}`;
      const endAt = buffer.indexOf(endMark);
      const nextOpen = buffer.indexOf(SEG_OPEN);
      if (endAt >= 0 && (nextOpen < 0 || endAt <= nextOpen)) {
        // An explicit `〔/名字〕`: the marker goes, the words stay.
        const rest = buffer.slice(endAt + endMark.length);
        buffer = buffer.slice(0, endAt);
        close(events);
        buffer = rest;
        continue;
      }
      if (nextOpen >= 0 && readOpen(buffer, nextOpen, valid) !== null) {
        // The next known speaker starts: this line ends where that marker begins.
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
     * End of stream.
     *
     * A leftover open segment is the last line, not a broken one — unless
     * `truncated` says the stream was cut, which is the caller's knowledge (it
     * has the finish reason) and is not guessed here.
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
       * Prose after the last segment is still output. It used to be
       * dropped in silence — and so was a whole reply that never opened a
       * segment at all, which is the one case where the user loses an answer
       * that was actually written (design §3.6). Reporting it here is what makes
       * "nobody spoke" and "nobody followed the format" distinguishable.
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
 * Batch form of the parser, for tests and for one-shot rendering.
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
 * Split raw parser events into speech and diagnostics.
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
 * One segment as the line a reader sees: `名字：台词`.
 *
 * The dialogue is kept verbatim apart from outer whitespace. Collapsing inner
 * whitespace here would quietly rewrite somebody's paragraph, which is exactly
 * what the protocol forbids.
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
   * The prompt asks for the name and the words with nothing between them, but a
   * model that writes `〔托尔〕：台词` is not wrong about the world — it is just
   * redundant with the separator this renderer adds. Dropping that one leading
   * colon is the difference between `托尔：：台词` and `托尔：台词`.
   */
  const text = raw.replace(/^[：:]\s*/, "");
  if (text === "") return name;
  return `${name}${sep}${text}`;
}

/**
 * Render closed segments as the reply body.
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

/** The one sentence used when nobody spoke, so an empty reply is never blank. */
export const SIM_SILENCE = "（这一轮没有人开口。）";

/**
 * Members who never produced a segment.
 *
 * Note what this is *not*: it is not "who stayed quiet in round two". The design
 * forbids deriving rounds from segment order (§4.1), so the only honest question
 * the runtime can answer is "did this person speak at all in this run" — and the
 * wording below says exactly that instead of implying a per-round ledger.
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
 * The line that names who stayed out of the conversation.
 *
 * @param {ReadonlyArray<string>} names
 * @returns {string}
 */
export function renderSilence(names) {
  const list = (Array.isArray(names) ? names : []).map(oneLine).filter((name) => name !== "");
  if (list.length === 0) return "";
  return `（这一场 ${list.join("、")} 没有开口。）`;
}

/**
 * Decide the run status from the **finish reason first**, parse result second.
 *
 * This is the §6.2 table in code. A finish reason is the only evidence that the
 * model ended on purpose; a buffer that merely looks complete is not.
 *
 * @param {object} input
 * @param {string|null} [input.finishKind] `stop` | `max-tokens` | `aborted` | `error` | `refusal`
 * @param {boolean} [input.aborted] the caller's signal was aborted
 * @param {number} [input.segments] number of rendered segments
 * @param {number} [input.structural] unknown-speaker events
 * @param {number} [input.stray] prose found outside any segment
 * @param {boolean} [input.endedWithoutFinish] the iterable ended without a finish chunk
 * @param {boolean} [input.tailIncomplete] the text stops inside an unclosed quote/parenthetical
 * @returns {string}
 */
/**
 * How much prose outside the segment protocol a run may carry and still count
 * as a normal ending.
 *
 * Zero would be wrong in both directions. The model reliably writes a short
 * interjection between two lines ("（她顿了顿）", a scene beat, a stage
 * direction) and a run that failed because of forty such characters would
 * report `incomplete` on a perfectly readable conversation — the notice
 * "产物没有完整解析" tells the user something went wrong when nothing did.
 *
 * A whole paragraph of framing ("以上是大家的意见，希望大家满意") is a different
 * event: it is the protocol not being followed, and the transcript that gets
 * shown omits it, so calling the run normal would hide a real defect. 120
 * characters is roughly one such paragraph and comfortably more than any
 * legitimate beat between two speakers.
 */
export const STRAY_TOLERANCE_CHARS = 120;

/**
 * The minimum amount of text a "cut mid-sentence" reply must already carry
 * before it is worth another request. A three-character reply that happens to
 * end on an opening bracket is not a discussion that lost its ending; a
 * paragraph is. Kept low on purpose — the precision lives in the detector, not
 * in this floor — but non-zero so a stray `「` from a model that answered in a
 * single line cannot start a 60-second continuation.
 */
export const TAIL_RESUME_MIN_CHARS = 80;

/**
 * Whether a reply was cut **mid-sentence**, as opposed to ending on purpose.
 *
 * `max-tokens` is not the only way a reply stops short. A provider connection
 * that stalls mid-stream makes the attempt end with `stop` (the stream closed,
 * so the last chunk really was terminal), and the text then ends inside a
 * structure it never closed: `「` with no `」`, `（` with no `）`. The parser
 * cannot see that — the last segment is a legal segment, it just stops in the
 * middle of a word — so `simulationStatus` used to call such a run `converged`
 * and the other half was never asked for.
 *
 * The check is deliberately narrow: only the final fragment (the text after the
 * last sentence boundary) is inspected, and only an **unclosed** delimiter
 * counts. A reply ending `。` / `！` / `？` / `……` opens nothing and is not
 * flagged; a reply ending `（她笑了笑）` has balanced parens and is not flagged.
 * False positives cost a whole extra request, so the signal is "we are inside a
 * quote or parenthetical that never closed" — something a reply that meant to
 * stop almost never leaves behind.
 *
 * @param {string} text the raw reply, protocol markers included
 * @returns {boolean}
 */
export function isTailIncomplete(text) {
  const raw = typeof text === "string" ? text : "";
  const t = raw.replace(/\s+$/, "");
  if (t.length === 0) return false;
  /*
   * The final fragment: everything after the last place a sentence could have
   * ended. Blank lines are boundaries too, because a segment's closing blank
   * line means the next thing starts fresh.
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
  // Ends on a dangling opening character with nothing after it.
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
    // No speech and no structural damage is the legal "everybody stayed silent"
    // case (design §6.2). Speech plus an unknown speaker is a partial parse, not
    // success: "some lines are readable" is not "the run completed normally" (§3.6).
    if (Number(structural) > 0) return "incomplete";
    /*
     * An empty reply is a legal silence; a reply full of prose and no segment is
     * not. The difference matters because the second one is how a model that
     * ignored the protocol looks, and calling that "nobody spoke" both mislabels
     * the run and hides the text (§6.3: unparsable output → `incomplete`).
     */
    if (Number(segments) === 0 && Number(stray) > 0) return "incomplete";
    /*
     * Readable segments **plus** a paragraph of framing is a partial parse, not
     * a clean run. The lines are kept and shown — they were written — but the
     * status has to say the transcript is not all the model said, otherwise the
     * frameless reply looks complete while the part the protocol rejected
     * silently disappears (design §3.6: never swallow output).
     *
     * The threshold, not the count, is the decision: see `STRAY_TOLERANCE_CHARS`
     * for why zero would mislabel every run that contains a stage direction.
     */
    if (Number(segments) > 0 && Number(strayChars) > STRAY_TOLERANCE_CHARS) return "incomplete";
    /*
     * `stop` only says the stream closed, not that the model chose to close it.
     * A connection that dies mid-stream ends with `stop` and a reply that stops
     * inside an unclosed `「`/`（`. Calling that `converged` is how a truncated
     * run got recorded as a complete one — and never asked to finish.
     */
    if (tailIncomplete === true) return "incomplete";
    return "converged";
  }
  return "incomplete";
}

/**
 * Internal-jargon hits, as data rather than a boolean.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function internalLeaks(text) {
  const haystack = typeof text === "string" ? text : "";
  return INTERNAL_TERMS.filter((term) => haystack.includes(term));
}

/** Trimmed, whitespace-collapsed display name; never throws. */
function oneLine(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/**
 * The persona text as the prompt will contain it: trimmed, and tolerant of both
 * host shapes (`"text"` or `{ ok, text }`).
 *
 * Exported because the runtime hashes the same string the prompt was built
 * from. A hash taken over the *untrimmed* file would stop matching the moment a
 * snapshot was compared against the assembled prompt, and the snapshot would
 * then report drift on a run that reproduced perfectly.
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
 * If `buffer` at `at` starts a complete, valid open marker, return its name.
 * Otherwise `null` — the caller waits for more tokens.
 */
function readOpen(buffer, at, valid) {
  const close = buffer.indexOf(SEG_CLOSE, at + SEG_OPEN.length);
  if (close < 0) return null;
  const token = buffer.slice(at + SEG_OPEN.length, close).trim();
  if (token === "" || token.startsWith("/")) return null;
  return valid.has(token) ? token : null;
}
