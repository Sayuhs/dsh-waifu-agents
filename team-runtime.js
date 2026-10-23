/**
 * Team mode at runtime: session binding, team resolution, and the takeover.
 *
 * `team.js` next door is the whole decision layer and stays a leaf — no cordis,
 * no services, no I/O beyond reading and writing one JSON file. This module is
 * the part that has to touch the host: it answers "which team is this session
 * on", and then, on a turn that belongs to the team, **is** the model.
 *
 * ## One call, not one call per member
 *
 * v2 gave every member her own child session and ran a shared message bus
 * between them. It worked, and it was slow in a way that could not be fixed
 * from the inside: a team of N over R rounds cost N×R child-session model
 * calls, each with a full activation lifecycle, plus a second pass to replay
 * the bus into a reply.
 *
 * v3 removes that mode entirely. There is no member session, no bus, no
 * coordinator turn, and no delegation tool — a team is **one** model call that
 * writes the whole conversation. `team-simulate.js` owns the prompt and the
 * segment protocol; this file owns the trigger, the idempotency, and making the
 * result a legal reply.
 *
 * ## Why the reply is produced inside `llm/stream`
 *
 * `agent/pre-step` is the only hook before `step/start`, and a refused step
 * never opens — so nothing written from there can become a visible reply. The
 * model call is the first point where a plugin can *be* the answer, and
 * `dsh-llm` documents `llm/stream` as a cordis waterfall: a listener that
 * returns a chunk stream without calling `next()` **is** the response. The
 * agent loop then writes `assistant/message` and closes the turn itself, so the
 * log is the same shape as any other reply and a cold read sees nothing odd.
 *
 * Two earlier attempts are worth remembering, because both looked right:
 * writing the reply as `assistant/message` from `pre-step` produced sessions
 * that could never be read again (`Relationships.tool`: an assistant message
 * must fall inside an **open** step, and a refused step never opens), and
 * writing it as `user/message` — the repair — made the reply invisible, because
 * that row is the client's *input* side and renders as a notification. Both are
 * gone; the current path writes neither.
 *
 * ## Why the request is rebuilt instead of rewritten
 *
 * `next()` cannot carry a modified request: cordis's `waterfall` closes over
 * `args` (`next = () => (cbs.shift() ?? inner)(...args)`). So the listener calls
 * `llm.stream(request)` itself with a request built for the simulation, and
 * marks that object in a `WeakSet` so the re-entrant waterfall pass recognises
 * it and passes it through. `prepared` may be undefined; `adapterStream` has a
 * branch for exactly that.
 *
 * ## Why nothing rides the persona text any more
 *
 * v2 had to append its stage rules to the served persona, because this plugin's
 * `template.json` gives its persona row `complete: true` and
 * `SystemPrompt.assemble` then drops every other section. v3 serves no stage
 * text at all — the simulation prompt is assembled from scratch at the model
 * call — so single mode and team mode serve a byte-identical persona.
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
  renderSilence,
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
 * Failure classes worth a second request, and how many attempts to spend.
 *
 * The list mirrors the classes `llm-retry` treats as transient (its normal mode
 * covers `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`), minus
 * `RATE_LIMIT`: honouring a rate limit means waiting out the provider's own
 * `Retry-After`, which a fixed local backoff does not do, and retrying into a
 * limit is how a slow turn becomes a blocked key. An `AUTH`/`INVALID`/context
 * failure would fail identically the second time, so those are answered at once.
 */
export const RETRYABLE_FAILURES = Object.freeze([
  "TIMEOUT",
  "TRANSPORT",
  "SERVER",
  "EMPTY_RESPONSE",
]);

/**
 * Backoff between attempts, in milliseconds: one entry per retry.
 *
 * Deliberately short. The failure this was written for is a ten-second connect
 * timeout — the socket never opened, so there is nothing to wait out and the
 * first retry usually lands on a working path. The user is staring at an empty
 * reply for the whole of it, so the budget is two retries, not the platform's
 * five.
 */
export const RETRY_DELAYS_MS = Object.freeze([600, 1500]);

/**
 * Wall-clock ceiling on a **single** model attempt, in milliseconds.
 *
 * The retry budget above was written for a ten-second *connect* timeout — the
 * socket never opens, the failure is immediate, and the first retry lands on a
 * working path. The live log shows the other failure shape: a stream that
 * **opens** and then stalls. `deepseek-v4.1-flash` served one 16:50 run where
 * attempt 2 sat idle for 430 933 ms before the upstream finally cut it — seven
 * minutes of a black reply. No local backoff can help a stall the provider has
 * not yet classified, because the terminal chunk that *would* carry the failure
 * never arrives; the only way to bound it is to stop waiting ourselves.
 *
 * This is therefore a *local* abort, distinct from the user's cancellation:
 * when it fires, the attempt is abandoned and treated as a `TIMEOUT` so the
 * retry gate below sees a class it already knows how to repair. The number is a
 * trade — long enough to ride out a slow-but-alive prefill, short enough that
 * the worst case in front of the user is "about two minutes, then a retry",
 * not "seven minutes, then nothing".
 */
export const ATTEMPT_TIMEOUT_MS = 120000;

/**
 * What to tell the user when a discussion could not be produced.
 *
 * Three jobs, in this order: say it in the language the rest of the plugin
 * speaks, keep the provider's own words (an untranslated `Request timed out.`
 * is the only evidence a later diagnosis has), and say what to do next. A raw
 * exception string as the whole message was the old behaviour and it reads like
 * a crash rather than a turn that can simply be sent again.
 *
 * @param {string} code `failure.code` from the terminal chunk
 * @param {string} message `failure.message` from the terminal chunk
 * @param {number} attempts how many requests were actually made
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
 * Install team mode for one host.
 *
 * @param {object} ctx root plugin context
 * @param {object} deps what only `index.js` can supply
 * @param {string} deps.storeFile absolute path to `teams.json`
 * @param {() => object[]} deps.roster every row the persona directory holds
 * @param {(id: string) => object | null} deps.personaTextOf assembled text for a persona
 * @param {(id: string) => object | null} [deps.personaBodyOf] body only, no solo
 *   skeleton; preferred for team mode when present
 * @param {(agent: object) => object | null} deps.coordinatorOf the session's own persona
 * @param {(name: string) => object | undefined} deps.serviceOf lazy service lookup
 * @param {(sessionId: string) => object | undefined} deps.liveAgentFor
 * @param {number} [deps.maxTokens] override the per-run output ceiling
 * @param {number[]} [deps.retryDelaysMs] backoff between attempts; one entry
 *   per retry. Passed by tests so a retry does not cost real seconds.
 * @param {number} [deps.attemptTimeoutMs] wall-clock ceiling on one attempt.
 *   Defaults to `ATTEMPT_TIMEOUT_MS`; tests shrink it so a stall test is instant.
 * @param {(agent: object, teamName: string) => boolean} [deps.moveChipToTeam]
 *   moves the session chip onto that team's preset. The host owns the chip, so
 *   it crosses as a callback; best-effort — a missing one just leaves it alone.
 * @param {string} [deps.runLogFile] absolute path to `runs.jsonl`; omitted = no ledger
 * @param {{ warn?: Function }} [deps.logger]
 * @returns {object} the surface `index.js` and the client need
 */
export function installTeamRuntime(ctx, deps) {
  const store = { current: readStore(deps.storeFile) };
  /** sessionId -> team name. In memory on purpose; see design doc §7.8. */
  const bound = new Map();
  /**
   * Sessions told to leave team mode even though they were BORN on a team.
   *
   * A team preset is a default, so "no binding" no longer means "single mode":
   * a session created with a team preset has no entry in `bound` at all and
   * must still run as that team. Leaving therefore has to record an explicit
   * refusal, or it would look like it worked and be undone by the next assembly
   * reading the preset again. The command spelling is gone (a session leaves by
   * `/waifu-change` or `/waifu-reset`), but `forget` and the panel's empty-name
   * `bind` still record the refusal here.
   */
  const off = new Set();
  const warn = (message) => {
    try {
      deps.logger?.warn?.(`dsh-waifu-agents: ${message}`);
    } catch {
      /* a logger that throws must not take a turn down */
    }
  };

  /*
   * The team diet has one dependency, and it is worth saying out loud when it
   * is missing.
   *
   * Team mode promises "no skeleton, body only" (design §4.4). That is only
   * possible when the host can hand over a persona BODY; a host that offers
   * nothing but the assembled text forces the fallback below, and then every
   * member quietly pays for the 1543-character solo skeleton again — the exact
   * cost the optimisation was written to remove. Failing to say so would let a
   * third-party host run three times more expensive with no visible reason, so
   * this warns once at install rather than per turn.
   *
   * Not an error: the fallback still works, it is just the old price.
   */
  if (typeof deps.personaBodyOf !== "function") {
    warn(
      "宿主没有提供 personaBodyOf，团队模式会退回「人设全文（含公共骨架）」：功能正常，但每个成员多付约 1543 字符。",
    );
  }

  /**
   * The persona text team mode pours into the prompt — and hashes.
   *
   * One reader for both jobs, because the hash has to describe the bytes that
   * were *sent*, not the bytes on disk. Two calls would risk reading a file that
   * changed in between, and a snapshot that does not match what ran is worse than
   * no snapshot at all.
   *
   * Three shapes are handled because the host has three: `deps.personaBodyOf` may
   * be missing entirely (an older host), and either reader may answer with a
   * string or with `{ ok, text }`. `source` says which one answered, which is
   * what makes the recorded hash comparable: a body-only hash and an assembled
   * hash describe different strings.
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

  /** {@link personaEntry} as the prompt builder's callback: text only, never null. */
  function personaFor(id) {
    return personaEntry(id).text;
  }

  /**
   * One line per run, appended to `runs.jsonl`.
   *
   * ## Why this is a file and not a Map
   *
   * `runs` is an in-memory idempotency window and loses everything on restart,
   * which made "how much did this cost" unanswerable after the fact. The ledger
   * is append-only so it survives restarts, and one line per run keeps a partial
   * write from corrupting anything before it.
   *
   * ## Why absent values are `null`
   *
   * `dsh-llm`'s adapters emit a `usage` chunk **unconditionally**, starting from
   * `{inputTokens: 0, outputTokens: 0}` and only overwriting it when the
   * provider actually reported numbers. So "0" is not evidence of a measured
   * zero, and `null` is the only honest value for "no measurement". A ledger
   * consumer must treat `usageSource: "absent"` as *unknown*, never as free.
   *
   * `totalTokens` is recorded as the provider reported it, but it is **not** a
   * billing figure: the adapter computes it as
   * `input + output + cacheRead + cacheWrite`
   * (`dsh-llm-deepseek`'s `translate()`), so cached input is counted into it at
   * full weight. Comparing cost across changes needs the four components and
   * the provider's own price sheet, not this sum.
   *
   * @param {object} line the record; `usageSource` decides how the rest is read
   */
  function recordRun(line) {
    const file = oneLine(deps.runLogFile);
    if (file === "") return;
    try {
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
    } catch (error) {
      // The reply already happened. A ledger that cannot be written is a
      // diagnosis, never a reason to fail the turn.
      warn(`写运行账本失败：${error?.message ?? error}`);
    }
  }

  /* ------------------------------------------------------------ resolution */

  /** Every row the directory holds, as the selection pipeline wants them. */
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
   * Resolve a stored team against the directory as it is right now.
   *
   * Never cached: a group is a live query over front matter, so a cached answer
   * would go stale the moment someone edits a `group:` line. `resolveTeam` is
   * pure, so paying it per assembly is one filtering pass over one directory —
   * and only for sessions that are actually in team mode.
   */
  /**
   * The team this session runs as, taking all three rungs into account.
   *
   *   - an explicit `/waifu-team <name>` binding wins;
   *   - an explicit refusal (the `off` set — recorded by `forget` or an empty
   *     `bind`) means no team, whatever the session was born as;
   *   - otherwise the team preset the session was created with, if any.
   *
   * `undefined` — not `null` — is what "no team" looks like, because a bound
   * team that has since been deleted is also absent from `bound` and the two
   * have to stay distinguishable to the caller that reports the reason.
   */
  function teamNameFor(sessionId, agent) {
    if (bound.has(sessionId)) return bound.get(sessionId);
    if (off.has(sessionId)) return undefined;
    const born = deps.teamForPreset?.(agent);
    return typeof born === "string" && born !== "" ? born : undefined;
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
   * Answer "what mode is this session in", for one assembly.
   *
   * Called from `index.js`'s persona-variable provider, so it runs once per
   * assembly for every agent this plugin serves. Every early return is `off`
   * with an empty text, which is what keeps single mode free: one Map lookup, no
   * directory read, and a persona that is byte-for-byte what it was.
   *
   * @returns {{ mode: "off" | "single" | "team", text: string, notices: string[], error?: string }}
   */
  function ensureTeam(agent) {
    const off = { mode: "off", text: "", notices: [] };
    const sessionId = oneLine(agent?.session?.id);
    if (sessionId === "") return off;
    /*
     * A delegated child is never on a team.
     *
     * The platform still creates child sessions for other tools, and
     * `dsh-subagent`'s `childSessionMeta` **copies the parent's `agentPreset`
     * into the child's header** — so a child of a team-preset session resolves
     * to the same team it was spawned from. Without this guard, a child would
     * report team mode and the *child's* next turn would be a candidate for the
     * team takeover, which would answer a question the child was asked with a
     * simulated discussion instead of its own work.
     *
     * `isDelegated` is what makes the check possible; see it for why the session
     * header, not `session.meta`, is the place to look.
     */
    if (isDelegated(agent)) return off;
    if (teamNameFor(sessionId, agent) === undefined) return off;
    const problem = storeProblem(store.current);
    if (problem !== null) return { ...off, error: problem };
    const resolved = resolveFor(sessionId, agent);
    if (resolved === null) return off;
    if (resolved.ok !== true) return { ...off, error: resolved.error };
    // `|team| < 2` is the one place the fallback is decided (gate S3 ≡ H4), and
    // falling short is announced rather than silent: the user asked for a team
    // and is owed the reason they did not get one.
    if (resolved.single) {
      const why = resolved.members.length === 0
        ? `「${resolved.team.name}」现在一个成员都解析不出来。`
        : `「${resolved.team.name}」只解析出 1 名成员（${resolved.members[0].name}）。`;
      return { ...off, mode: "single", notices: [...(resolved.notices ?? []), `${why}已按单人模式执行。`] };
    }
    /*
     * Nothing is installed per session, and that is the whole point of v3.
     *
     * There is no coordinator turn to give a tool to: `discussionStream` builds
     * the one simulation request itself. `text` is empty because the served
     * persona must stay byte-for-byte what it was — the simulation prompt is
     * assembled from scratch at the model call, not appended to the root's.
     */
    return { mode: "team", text: "", notices: resolved.notices ?? [] };
  }

  /**
   * Is this agent a delegated child?
   *
   * ## It reads the header, because that is where the platform puts this
   *
   * `dsh-subagent`'s `childSessionMeta(parent, depth, seeded)` returns
   *
   *     { cwd?, agentPreset?, parentSession, isSeeded, origin: 'subagent', delegationDepth }
   *
   * and that object **becomes the child's `session.header`** — `Session` has
   * `header`, not `meta`. This function used to read `session.meta`, which is
   * `undefined` on every real session, so it answered `false` for every real
   * child and only ever worked against the selftest's stub (which set `meta`).
   *
   * That went unnoticed while the only caller was the delegation tool: a child
   * cannot see the tool anyway (it is registered in the *parent's* own layer),
   * so the guard was belt-and-braces that never had to bite. The takeover hook
   * changed that. `agent/pre-step` is registered once on the root context and
   * fires for **every** agent in the process, children included, so a guard that
   * always answers "no" means the team's own members each start a team, which
   * spawn further members, until the process dies. Observed, not theorised: a
   * live run produced root → `49afe7fb` → `5eddbef3` and kept going.
   *
   * Three signals, all checked, because the cost of a false negative is
   * runaway recursion and the cost of a false positive is one turn that the
   * Agent answers itself:
   *
   *   - `header.origin === "subagent"`;
   *   - `header.delegationDepth > 0`, which survives persistence and resume;
   *   - a non-empty `header.parentSession`, which is structural — even a
   *     child that somehow lost its classification still names its parent.
   *
   * `meta` is still read, so the existing stub-shaped tests keep describing the
   * same thing rather than being rewritten around an implementation detail.
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

  /* ------------------------------------------------------------- the takeover */

  /**
   * Sessions whose discussion is running right now.
   *
   * Defence in depth, not a lock. One Agent runs one turn at a time — `kick()`
   * is `while (await this.turn())` — and a message arriving mid-discussion is
   * spliced into the inbox and claimed by a *later* turn, so "two discussions at
   * once" should be unreachable. If it ever is not, the answer is to step aside
   * rather than to run the team twice and append two replies.
   */
  const midDiscussion = new Set();

  /**
   * Should this step be taken over, and with what task?
   *
   * `null` means "let the Agent answer" and is returned for every case this code
   * is not certain about. That asymmetry is deliberate: passing a message
   * through costs the user a coordinator turn, while taking one over costs them
   * an answer they never see.
   *
   * The guards, and each one's reason:
   *
   *   - **step 1** — the first step of a turn is the only one whose inbox claim
   *     includes the user's `next-turn` message. Steps 2+ are the Agent looping
   *     over its own tool results.
   *   - **a real user message** — `userTaskIn` matches on `source.kind`, so a
   *     `agent-message` relay from a resident member, a `subagent-settled`
   *     notice, or a `system-prompt` context all pass through. This is what
   *     keeps the hook from eating its own team's traffic.
   *   - **not a delegated child** — see `isDelegated`.
   *   - **team mode actually resolves** — a session born on a team preset whose
   *     team has since shrunk to one member is in *single* mode, and
   *     `ensureTeam` already decided that; taking over would answer a
   *     single-mode session with a team that does not exist.
   *
   * @param {object} payload - the `agent/pre-step` waterfall payload.
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
     * The message id is the idempotency identity, and it is captured here —
     * once, before the turn starts — rather than at the model call, so a
     * duplicate trigger cannot mint a second key. A message without an id (a
     * synthetic inbox row) falls back to the step, which is stable for the turn.
     */
    const taskId = userMessageIdIn(payload?.messages) || `step-${Number(payload?.step) || 0}`;
    return { agent, sessionId, task, taskId, resolved };
  }

  /**
   * Sessions that owe their next model call to the team.
   *
   * `agent/pre-step` decides *whether* a turn belongs to the team; it no longer
   * answers the turn itself. The answer is handed over one hook later, in
   * {@link discussionStream} — which is the only place a plugin may be the model.
   *
   * Keyed by session, consumed by the first matching `llm/stream`, and dropped
   * by a TTL as well: if anything between the two hooks throws, a stale entry
   * must not be able to answer some *later* turn with an old discussion.
   */
  const owed = new Map();

  /**
   * How long an unclaimed takeover stays claimable. Longer than any pause
   * between the two hooks, shorter than the time it takes a human to type the
   * next message.
   */
  const OWED_TTL_MS = 5 * 60 * 1000;

  /**
   * Every v3 run this process has started, keyed by `sessionId::taskId`.
   *
   * The key is the idempotency identity: the same user message may reach the
   * hook twice (two trigger paths), and the second one must **not** call the
   * model again. `claim` is synchronous — there is no `await` between the lookup
   * and the insert — so two triggers in one tick cannot both win.
   *
   * Records live in memory. Persisting them across a desktop restart is M1 work
   * that is not wired here; the restart rule is therefore "a `running` record
   * that this process did not start does not exist", which is the conservative
   * half of design §2.5 (never re-run a call you cannot confirm).
   */
  const runs = new Map();
  /** Keep a finished record long enough for a duplicate trigger to find it. */
  const RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

  /**
   * How much unparsable prose is echoed back when the model ignores the protocol.
   *
   * Bounded because the reply is a chat message: the point is to not lose the
   * answer, not to dump an unbounded completion into it.
   */
  const PROSE_FALLBACK_LIMIT = 4000;

  /**
   * Requests this module built itself, so the `llm/stream` listener can tell
   * its own re-entrant simulation call apart from a second trigger.
   *
   * A `WeakSet` rather than a field on the request: the request is handed to
   * adapters, and an adapter that spread unknown keys into a provider payload
   * is not a risk worth taking. Identity is enough — `llm.stream(request)`
   * passes that same object to the waterfall.
   */
  const simulationCalls = new WeakSet();

  /**
   * Per-session team memory, cached in front of the disk file.
   *
   * The cache IS the source of truth while the process lives: a round is
   * appended to the cached object the moment its stream settles, and the disk
   * write follows fire-and-forget. That ordering is what keeps the very next
   * round from reading a memory that is one round behind — the user's next
   * message can beat a slow disk write, and it must still see the round that
   * just finished.
   */
  const memoryCache = new Map();

  function pruneRuns() {
    const now = Date.now();
    for (const [key, run] of [...runs.entries()]) {
      if (run.terminal === true && now - run.finishedAt > RUN_WINDOW_MS) runs.delete(key);
    }
  }

  /**
   * Fold evicted rounds into the session summary — the lazy half of memory.
   *
   * Called at the START of a round whose memory still carries a backlog, so
   * the call runs inside a live fiber with real error handling instead of a
   * fire-and-forget after the reply closed. `null` means the fold did not
   * happen (the backlog stays put and the round proceeds without it): an
   * LLM outage must not become a memory outage, and it must not block the
   * turn the user actually asked for.
   *
   * The request is marked in `simulationCalls` before `llm.stream`, exactly
   * like the main call — the `llm/stream` waterfall sees every stream in the
   * process and must recognise this one as our own re-entry.
   *
   * @returns {Promise<string|null>} the folded text, or null on failure
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
   * A buffered, single-consumer chunk queue.
   *
   * The discussion pushes, the stream pulls, and the indirection is not
   * decoration: a finished round is discovered inside an `async` callback
   * (`onRound`), and a generator cannot `yield` from a callback. It is also what
   * makes a round visible *when it happens* — the queue hands that round to the
   * client the moment the last member of it has answered, not when the whole
   * discussion ends.
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
   * A complete, valid stream for a turn the team cannot answer.
   *
   * The loop refuses a reply that ends without `finish`, so every early exit
   * (duplicate message, no members, no LLM service) still has to look like a
   * model answer — one text block, then stop.
   */
  async function* fixedStream(text) {
    const value = typeof text === "string" && text !== "" ? text : SIM_SILENCE;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: value };
    yield { type: "block-end", index: 0, block: { type: "text", text: value } };
    yield { type: "finish", reason: { kind: "stop" } };
  }

  /**
   * v3: one model call, parsed into closed segments, streamed one by one.
   *
   * The old path spawned one child per member per round and replayed the bus.
   * That is gone. This function makes **one** call through the `llm` service
   * (the same service the `llm/stream` waterfall wraps, with the request built
   * here rather than the root's), feeds the token stream to the segment parser,
   * and emits a line only when a segment is closed. Token-level liveness is
   * preserved without a second replay pass.
   *
   * Two rules from the design are enforced here, not merely documented:
   *
   *   - **Terminal state is write-once.** `settle` refuses to overwrite a run
   *     that already ended, so a late finish from an aborted call cannot flip
   *     `cancelled` back to `converged` (§5.4).
   *   - **Status comes from the finish reason first** (§6.2). A buffer that
   *     merely looks complete is never enough to claim a normal end.
   */
  async function* discussionStream(asked, options) {
    const sessionId = oneLine(asked?.sessionId);
    const taskId = oneLine(asked?.taskId) || "turn";
    const key = `${sessionId}::${taskId}`;

    /*
     * Atomic claim. Both triggers for one message reach this function in the
     * same synchronous tick, so a lookup-then-insert without an `await` between
     * them is the whole idempotency guarantee (§5.1). A duplicate never calls
     * the model; it says so and ends.
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
       * The identity of the **last** model request this run made.
       *
       * It is not a provider request id: neither `dsh-llm` nor the adapters
       * surface one, and inventing a value that looks like one would be worse
       * than admitting it. This is the plugin's own handle on the call, minted
       * before `llm.stream` so a ledger line exists even when the call never
       * reaches the provider.
       *
       * One run may make several requests (see `requests`), and the top-level
       * `requestId` and usage columns describe the **last** one — the attempt
       * whose text is in the reply. It is kept at the top level only for
       * continuity with rows written before per-attempt accounting existed; the
       * `requests` array is the complete record.
       */
      requestId: randomUUID(),
      /**
       * ## One entry per real provider request, including the failed ones
       *
       * A run is a **logical** discussion: one user trigger, one reply. It is
       * not one HTTP call. When a connect timeout eats the first attempt and
       * the second one succeeds, the top-level usage columns can only describe
       * the second — and the tokens paid for the first one are simply gone from
       * the ledger. That is the difference between "this run cost 2400 input
       * tokens" and "this run cost 2400 input tokens plus whatever the retry
       * burned", and only the second one is true.
       *
       * So each attempt pushes its own row here: its own requestId, its own
       * usage, its own duration, its own failure class, and whether it was
       * retried. Nothing in this array is a character of dialogue — the ledger
       * rule (§5.5) is untouched: still one line per run, still no bodies.
       *
       * A retry can only happen while **nothing has been shown** (`wrote === 0`),
       * so a successful attempt is always the last entry and its usage is the
       * top-level usage. Summing this array is the run's real cost; summing the
       * top level is the reply's cost. They are different questions.
       */
      requests: [],
      /** Which generation strategy produced this run; one value today. */
      strategy: "team-single",
      provider: oneLine(options?.provider),
      model: oneLine(options?.model),
      sessionId,
      taskId,
      status: "running",
      terminal: false,
      /**
       * How many provider requests this run actually made.
       *
       * One on a healthy turn. More means the first attempt died before it
       * showed a character and was retried; the ledger has to say so, because a
       * row whose tokens came from attempt 2 is not the same evidence as a row
       * that succeeded first time, and the usage columns can only describe one
       * of the attempts.
       */
      attempts: 0,
      startedAt: Date.now(),
      finishedAt: 0,
      team: oneLine(resolved.team?.name),
      size: members.length,
      segments: 0,
      /*
       * Request size in characters, filled once the prompt is assembled.
       * Initialised to `null` rather than left absent so a run that failed
       * before building a request still writes a complete-looking line — a
       * missing key and a null read differently to every JSON consumer.
       */
      promptChars: null,
      taskChars: null,
      requestShape: null,
      /**
       * The reply's scale class (`social` / `task` / `complex`) and the token
       * ceiling it produced. Both are filled once the prompt is built, but
       * initialised to `null` so a run that died before building a request still
       * writes a complete-looking line.
       */
      scale: null,
      maxTokens: null,
      /**
       * The reply's progress phase, for the two-state "preparing vs streaming"
       * distinction (C). `preparing` means the request is out and no character
       * has arrived; `streaming` means the first token landed; a terminal status
       * replaces both. It is a *measured* fact, never a fabricated progress bar.
       */
      phase: "preparing",
      /**
       * When the first `text-delta` arrived, and how long the wait was.
       *
       * `firstTokenAt` is 0 until a token lands; `firstTokenMs` is the wall-clock
       * gap between sending the request and that first token — the number that
       * the 92-second "black screen" shows up as in the ledger. Recorded so the
       * prefill wait is diagnosable from the ledger alone, without re-reading a
       * session log. It is latency, not a progress claim.
       */
      firstTokenAt: 0,
      firstTokenMs: null,
      /**
       * What the team *was*, frozen as hashes — see `team-snapshot.js`.
       *
       * The ledger used to describe a run only by its shape (`team` + `size`),
       * which two different discussions can share: edit one persona body, reorder
       * the roster, or reword the shared rules, and the row reads identical while
       * the prompt is not. Hashes plus lengths make that difference visible
       * without copying a single character of the cast's text into a file §5.5
       * says they never see.
       *
       * `null` until the prompt is built, so a run that dies before then still
       * writes a complete-looking line — and a `null` here is itself evidence
       * that nothing was assembled.
       */
      config: null,
      diagnostics: [],
      /** Members who never produced a closed segment; filled once, on settle. */
      silent: [],
      /**
       * How many extra requests this run made to keep the discussion going.
       *
       * Not a retry count: every one of these produced text that stayed in the
       * reply. Recorded because a three-request run and a one-request run can
       * look identical in the reply, and the cost difference is real.
       */
      continuations: 0,
    };
    runs.set(key, run);
    pruneRuns();
    midDiscussion.add(sessionId);

    const queue = makeChunkQueue();
    let full = "";
    /** Everything the model wrote, before the parser touched it. */
    let raw = "";
    /**
     * The provider's `usage` chunk, forwarded once at the end.
     *
     * `usage` is a **chunk type of its own**, not a field on `finish`
     * (`dsh-llm/lib/invariant.js` allows it, at most once, before the terminal
     * finish). The stream loop used to ignore it, and the cost was invisible
     * from the outside: `BlockAssembler._usage` stayed undefined, so
     * `assistant/message.usage` was never written for a team turn — the tokens
     * were spent and nothing recorded them. It is forwarded verbatim rather
     * than folded into `finish`, so the platform's own accounting works
     * unchanged.
     */
    let providerUsage = null;
    const emit = (text) => {
      if (typeof text !== "string" || text === "") return;
      full += text;
      queue.push({ type: "text-delta", index: 0, text });
    };
    /** Append a paragraph to whatever is already in the reply. */
    const append = (text) => {
      if (typeof text !== "string" || text === "") return;
      emit(full === "" ? text : `\n\n${text}`);
    };
    // The block opens before anything can be pushed into it: the invariant
    // refuses a `text-delta` whose index has no open block.
    queue.push({ type: "block-start", index: 0, blockType: "text" });

    /** Write-once terminal state. The first answer wins; late callbacks are dropped. */
    const settle = (status) => {
      if (run.terminal === true) return run.status;
      run.terminal = true;
      run.status = status;
      run.finishedAt = Date.now();
      return status;
    };

    /*
     * Declared **outside** the `try` on purpose.
     *
     * These describe how the model call ended, and the `finally` below needs
     * them to write the ledger. A `let` inside the `try` block is not visible
     * in `finally` — and the failure mode is nasty: the `ReferenceError` thrown
     * while building the record is swallowed by `work.catch`, so the turn looks
     * fine, the ledger silently never gets a line, and before `queue.close()`
     * moved above the record the whole stream hung instead.
     */
    let finishKind = null;
    let finishFailure = "";
    /**
     * The failure class from the terminal chunk (`TIMEOUT`, `TRANSPORT`, …).
     *
     * Kept apart from the message because the message is prose from a provider
     * SDK and the code is the thing a decision can be made on: retrying is a
     * question about the class, not about which words the exception used.
     */
    let finishCode = "";
    let endedWithoutFinish = true;
    let wrote = 0;

    /*
     * Team memory, declared outside the `try` for the same TDZ reason as
     * `finishKind` above: the `finally` records the round into memory and
     * needs these even on a path that threw. `mem` stays `null` when memory
     * is off for this team or no directory was wired — every consumer below
     * null-checks it, so "off" costs nothing but the boolean.
     */
    let mem = null;
    let memBlock = "";
    let memoryOn = false;
    let memKey = "";
    let finalRaw = "";

    /*
     * The thinking chain, forwarded as a native reasoning block (§8 reasoning).
     *
     * `dsh-llm` 0.2.1 emits the model's reasoning as a first-class streamed
     * block — `block-start { blockType: "reasoning" }`, then `reasoning-delta`s,
     * then a `block-end` whose block is `{ type: "reasoning" }`. The chunk loop
     * below used to drop all of it (no branch matched), which is why team mode
     * never showed a thinking chain: the platform renders a `reasoning` block
     * natively, but this plugin never handed one over.
     *
     * The reasoning block rides its own index (1) so it never collides with the
     * text block on index 0, which stays the segment protocol's. We accumulate
     * the text ourselves so the closing `block-end` can carry the full reasoning
     * — the assembler appends deltas into `reasoningText`, and the closed block
     * must state its whole text, exactly as the text block below does with `full`.
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
         * Body only when the host can give it: a discussion calls no tools, so
         * the solo skeleton would repeat the same 1543 characters per head. A
         * host without `personaBodyOf` falls back to the assembled text and pays
         * the old price — correct, just more expensive. Named rather than inlined
         * because the snapshot hashes the *same* strings the prompt was built
         * from; see `personaFor`.
         */
        /*
         * The reply's desired size class, from the turn alone (A). It shapes the
         * prompt's compact/clarifying clause and nothing else — the hard ceiling
         * (B) comes from how many people are on stage, because the protocol
         * requires every one of them to speak. Tying the ceiling to the user's
         * word count was the bug: 「继续」 in a three-person room still needs
         * three lines at least. `deps.maxTokens`, when a host sets it, wins
         * outright and is never lowered by our own floor or ceiling.
         */
        const scale = classifyTurn(asked.task);
        const budget = turnBudget(deps.maxTokens);
        run.scale = scale;
        run.maxTokens = budget;
        /*
         * Load (or reuse) this session's memory, and settle any fold backlog
         * left by an earlier eviction — BEFORE the first request is built, so
         * this round already sees the folded summary. `resolved.team.memory`
         * is the per-team switch; absent means on (the user-visible default).
         * A missing `memoryDir` (a selftest host, or a probe with no home)
         * disables the whole path without a trace.
         */
        memoryOn = resolved.team?.memory !== false;
        const memoryDirOk = typeof deps.memoryDir === "string" && deps.memoryDir !== "";
        /*
         * The key is session × team, not session alone: `/waifu-team` can
         * rebind mid-session, and A 队的剧情 must never leak into B 队的
         * rounds. Renaming a team therefore starts a fresh memory — the old
         * file ages out through the retention window instead.
         */
        memKey = memoryOn && memoryDirOk ? `${sessionId}::${resolved.team?.name ?? ""}` : "";
        if (memoryOn && memoryDirOk) {
          mem = memoryCache.get(memKey);
          if (mem === undefined) {
            mem = await readMemory(deps.memoryDir, memKey, {
            /*
             * Retention is per team: the panel edits `memoryTtlDays` like the
             * paging number (0 = keep forever). A finite `deps.memoryTtlMs`
             * stays the offline override for selftests.
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
        const prompt = simulationSystemPrompt({
          team: resolved.team,
          members,
          personaOf: personaFor,
          task: asked.task,
          scale,
        });
        let messages = simulationMessages({ prompt, task: asked.task, memory: memBlock });
        /*
         * The baseline half of the ledger: what the request *looked like*,
         * independent of what it cost.
         *
         * `usage` is only as good as the provider's reporting — and a cancelled
         * or absent run measures nothing at all. Characters are always
         * measurable, so a before/after comparison of the skeleton de-duplication
         * stays possible even on a run that never reported tokens. These are
         * **characters, not tokens**: no tokenizer runs here, and pretending a
         * character count is a token count is how a "50% saving" turns out to be
         * a rounding error.
         */
        run.promptChars = prompt.length;
        run.taskChars = typeof asked.task === "string" ? asked.task.length : 0;
        run.requestShape = messages.map((message) => oneLine(message?.role)).join(">");
        /*
         * Freeze the configuration here — after the prompt exists, before the
         * first request — so a snapshot always describes bytes that were actually
         * sent. Reading the persona files a second time instead would risk
         * hashing a file that changed between the two reads.
         *
         * `personaSource` records which variant was poured in: body-only when the
         * host exposes `personaBodyOf`, the assembled text otherwise. The hashes
         * of those two strings are not comparable, and a reader has no other way
         * to know which one a row is describing.
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
             * No round count: the prompt asks for an end condition, not a
             * number of turns, so there is nothing here to freeze. `maxRounds`
             * stays readable in `snapshotOf` (older rows still carry it) and
             * comes back `null` for new ones — which is the honest "there is no
             * such parameter" rather than a number nobody honours.
             */
            scale,
          },
          prompt: { text: prompt, shape: run.requestShape },
        });
        /*
         * ## The attempt loop, and why the platform will not provide one
         *
         * `llm-retry` retries a failed model request at the agent loop's step
         * boundary. Its README states the boundary and the exception in one
         * breath: retries "re-run the failed step in the same open turn, while
         * **direct `ctx.llm.stream()` calls remain single-attempt**", because "a
         * raw stream cannot separate already-emitted chunks durably".
         *
         * This takeover *is* such a call. So a normal turn rides out a transport
         * blip with up to five retries, and a team turn died on the first one —
         * the live log shows exactly that: `Request timed out.` ten seconds in,
         * twice, while a solo turn between them finished normally.
         *
         * We can retry where the platform cannot, because we know one thing it
         * does not: whether anything reached the screen. An attempt that ends
         * with **zero emitted segments and zero raw characters** never showed a
         * single character, so asking again is invisible and cannot duplicate a
         * line. After the first rendered segment that repair is gone — the text
         * is already in the transcript and cannot be unwound — so a partial
         * failure is reported, never retried.
         *
         * The budget is two retries, not five. The failure this answers is a
         * ten-second connect timeout: nothing is pending that a longer wait
         * helps, and every extra attempt is another ten seconds of an empty
         * reply in front of the user.
         */
        const delays =
          Array.isArray(deps.retryDelaysMs) && deps.retryDelaysMs.length > 0
            ? deps.retryDelaysMs
            : RETRY_DELAYS_MS;
        const maxAttempts = delays.length + 1;
        const retryable = new Set(RETRYABLE_FAILURES);

        /*
         * ## Continuations: one run, several requests
         *
         * A discussion is not one message long. Before this, the run had exactly
         * one request (plus retries), so the token ceiling silently *was* the
         * length of the argument: hit it and the scene stopped mid-word. The
         * ceiling is now a technical guard, and when it is reached the run asks
         * for another reply that carries what was already said — so the total
         * length is bounded by the continuation budget, not by one request's
         * ceiling.
         *
         * There is a second reason to ask again: a run can end cleanly with
         * somebody still silent. The rules require every member to speak, so
         * "converged but C never opened her mouth" is not a finished discussion;
         * one coverage request asks for exactly the missing voices.
         *
         * `transcript` accumulates the raw text (protocol markers included) so a
         * continuation quotes what was actually written, not a re-render of it.
         * `spokenAll` is the coverage evidence across every request — a member
         * who spoke in the first reply counts as covered even if she stays quiet
         * afterwards.
         */
        let round = 0;
        let roundReason = "initial";
        let continuations = 0;
        let coverageTried = false;
        let transcript = "";
        const spokenAll = [];

        for (;;) {
          let again = false;
          for (let attempt = 1; ; attempt += 1) {
            run.attempts = attempt;
          /*
           * Per-attempt identity and clock. `run.requestId` moves to this
           * attempt so the top level always names the request whose usage the
           * top-level columns describe; the array entry below keeps every one.
           */
          const attemptRequestId = randomUUID();
          run.requestId = attemptRequestId;
          const attemptStartedAt = Date.now();
          const segmentsBefore = wrote;
          /*
           * Reset per attempt, not because a retry can lose work — the retry
           * condition forbids it — but because these values are what that
           * condition is read from, and a stale `wrote` would make it depend on
           * the previous attempt's numbers. `providerUsage` is reset for the
           * same class of reason: the top-level usage columns must describe the
           * attempt whose text is in the reply.
           */
          raw = "";
          finishKind = null;
          finishFailure = "";
          finishCode = "";
          endedWithoutFinish = true;
          providerUsage = null;

          /*
           * The request is built here, not inherited. `next()` cannot carry a
           * rewritten request in this cordis version (its `waterfall` closes over
           * the original arguments), so the simulation calls the service itself.
           * `owed` was already deleted by the `llm/stream` listener, which is what
           * keeps this call from being mistaken for a second takeover.
           */
          /*
           * The per-attempt wall-clock ceiling (§attempt timeout). The user's
           * signal is forwarded into the attempt controller so a cancel still
           * aborts immediately while a stall is bounded locally. `timedOut` is
           * latched when *our* timer fires (not the user's), because that is the
           * only abort the retry gate is allowed to call a `TIMEOUT`.
           */
          const attemptController = new AbortController();
          let timedOut = false;
          const timeoutHandle = setTimeout(() => {
            timedOut = true;
            attemptController.abort();
          }, Number.isFinite(deps.attemptTimeoutMs) ? deps.attemptTimeoutMs : ATTEMPT_TIMEOUT_MS);
          // Forward a user cancel into our signal; no-op when there is none.
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
             * The hard stop, named rather than inherited (§4.2). `dsh-llm` reads
             * `config.maxTokens` and falls back to `modelInfo.defaultMaxTokens`
             * when it is absent — which is how "how long may a discussion run"
             * quietly became the provider's decision.
             *
             * It is the per-turn budget (`turnBudget`), not a global constant, and
             * it follows the head count rather than the words asked: the ceiling
             * caps a runaway discussion and nothing else — it never decides what
             * a good answer is, and it must sit above any ordinary scene, because
             * hitting it does not shorten a speech, it cuts the last one mid-word.
             */
            maxTokens: budget,
          };
          // Marked before the call: the listener runs synchronously inside
          // `llm.stream`, and must recognise this as our own re-entry.
          simulationCalls.add(request);
          const stream = llm.stream(request);

          const parser = createSegmentParser({ names });
          const diagnostics = [];

          /**
           * Render one batch of parser events.
           *
           * Both `push()` and `flush()` can produce speech, so they go through the
           * same door. This used to be inlined in the chunk loop, which quietly
           * assumed `flush()` only ever answers with diagnostics — and then the
           * parser learned to hand back the last line at end of stream, so the
           * final speaker's words were counted as a diagnostic and never shown.
           */
          const take = (events) => {
            for (const event of events) {
              if (event.type !== "segment") {
                diagnostics.push(event);
                continue;
              }
              /*
               * Internal jargon is **recorded, not removed**. The design's check is
               * context-aware for a reason: "运行" is ordinary in a conversation
               * about software, and deleting a line because a substring matched
               * would rewrite somebody's speech — the one thing the protocol
               * forbids. M4 reads these diagnostics to tune the prompt; a
               * user-facing notice would be noise.
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
             * Our wall-clock ceiling fired mid-stream. `timedOut` distinguishes
             * this from the user's cancel above: a stall must be repaired, not
             * reported as a choice. The stream's `finally` will call the adapter's
             * `return()`, which is what actually releases the socket.
             */
            if (timedOut === true) break;
            if (chunk?.type === "block-start" && chunk.blockType === "reasoning") {
              /*
               * Open our own reasoning block on index 1. The upstream index is
               * ignored on purpose: index 0 belongs to the text block, and a
               * `reasoning-delta` must target an open block of exactly this type,
               * so re-owning it here is what makes the invariant hold.
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
              // A reasoning-delta with no open block is not ours to render; the
              // platform cannot accept it, so it is dropped rather than misrouted
              // into the speaking text.
            } else if (chunk?.type === "block-end" && chunk?.block?.type === "reasoning") {
              if (reasoningOpen) {
                queue.push({ type: "block-end", index: 1, block: { type: "reasoning", text: reasoningText } });
                reasoningOpen = false;
              }
            } else if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
              /*
               * The first token is the end of the "preparing" phase (C). The gap
               * between `attemptStartedAt` and now is the prefill wait — the
               * black-screen interval — and it is recorded, not guessed. A run
               * that never gets a token keeps `firstTokenMs: null`, which is the
               * honest "no measurement".
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
               * Kept as-is and forwarded once. The provider may report usage at
               * `message_start` and again at `message_delta`; the adapter folds
               * those into one final chunk, so a second one here would be a
               * malformed stream — keep the first and say so in the diagnostics
               * instead of throwing the run away over it.
               */
              if (providerUsage === null) providerUsage = chunk.usage;
              else diagnostics.push({ type: "usage-duplicate" });
            } else if (chunk?.type === "finish") {
              finishKind = oneLine(chunk.reason?.kind) || "stop";
              /*
               * The provider's own words, when it has them. `dsh-llm` puts the
               * failure class and message on the terminal chunk; dropping it and
               * saying "模型调用失败" is how a real auth/rate-limit failure gets
               * spent looking like a code regression.
               */
              finishFailure = oneLine(chunk.reason?.failure?.message);
              finishCode = oneLine(chunk.reason?.failure?.code).toUpperCase();
              endedWithoutFinish = false;
              /*
               * Close a reasoning block the adapter left open at the terminal
               * chunk. Some adapters emit the reasoning `block-end` themselves;
               * the ones that do not would otherwise leave index 1 open when the
               * stream ends, and the post-drain closer below cannot tell the
               * difference between "never opened" and "opened, never closed".
               */
              if (reasoningOpen) {
                queue.push({ type: "block-end", index: 1, block: { type: "reasoning", text: reasoningText } });
                reasoningOpen = false;
              }
            }
          }
          // The attempt settled (one way or another); the ceiling timer is done.
          clearTimeout(timeoutHandle);
          /*
           * Our wall-clock ceiling fired (§attempt timeout). The adapter turns an
           * abort into a `kind:"aborted"` finish whose failure code is its own
           * (`ABORTED` or similar), which the retry gate does not recognise. Re-map
           * it so a stall is repaired rather than misread as a cancellation:
           *
           *  - Nothing reached the screen (`wrote === 0 && raw === ""`): this is a
           *    black-screen stall, exactly the shape the retry gate exists for.
           *    Mark it `TIMEOUT` and let the gate retry.
           *  - Something already rendered: unwinding it is impossible (the queue
           *    is write-once), so keep the partial discussion and end it as a
           *    truncated `stop` instead of throwing the words away. The user keeps
           *    what was said, and gets a one-line notice that it was cut.
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
            // The ceiling is a *cause*, not a parse artifact: record it so a
            // kept-but-truncated run is distinguishable from a clean stop later.
            diagnostics.push({ type: "attempt-timeout" });
          }
          /*
           * `truncated` is the caller's knowledge, not the parser's: only the
           * finish reason says whether the last line was ended by the model or cut
           * by the ceiling. The parser still hands that line back — the words were
           * written — and records that its end was a cut.
           */
          const truncated = finishKind === "max-tokens" || finishKind === "aborted" || options?.signal?.aborted === true;
          take(parser.flush({ truncated }));
          run.diagnostics = diagnostics.map((event) => event.type);

          /*
           * A reply can be cut without `max-tokens`. A connection that dies
           * mid-stream ends with `stop` (the stream closed, so the last chunk
           * was terminal) and the text stops inside an unclosed quote or
           * parenthetical. `isTailIncomplete` is the second opinion the finish
           * reason cannot give: `stop` says the stream closed, not that the
           * model chose to close it.
           *
           * `wrote > 0` keeps the prose-fallback case out: no segment means
           * there is no discussion to resume, only text to echo. The length
           * floor keeps a stray `「` from a one-line answer from spending a
           * whole extra request.
           */
          const tailCut = wrote > 0 && isTailIncomplete(raw);
          const resumableCut = tailCut === true && raw.length >= TAIL_RESUME_MIN_CHARS;

          /*
           * Decide **before** writing the terminal state. `settle` is
           * write-once, so an attempt that is about to be retried must never
           * reach it: a run marked `error` cannot afterwards be reported as the
           * success the second attempt produced.
           */
          const worthRetrying =
            attempt < maxAttempts &&
            wrote === 0 &&
            raw === "" &&
            options?.signal?.aborted !== true &&
            retryable.has(finishCode);
          /*
           * Recorded **before** the branch, so a failed attempt is written down
           * even though its retry is about to erase every trace of it from the
           * reply. A ledger that only saw surviving attempts would make a
           * flaky run and a clean run look identical in cost.
           */
          run.requests.push({
            requestId: attemptRequestId,
            attempt,
            /*
             * Which logical request this is inside the run: 0 is the turn the
             * user asked for, 1+ is a continuation. `reason` says why it was
             * made (`initial` / `ceiling` / `coverage`) — without it, a run
             * that cost three requests looks like a retry storm.
             */
            round,
            reason: roundReason,
            /** Characters of team memory injected ahead of the ask (0 = off). */
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
             * The user may cancel during the backoff. Retrying under an aborted
             * signal would send a request whose result is thrown away, and it
             * would also report the run as `error` when it was in fact stopped
             * by the person who asked for it.
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
           * How much prose fell outside the protocol, in characters. Counted
           * rather than merely counted-by-event because one 400-character
           * essay and one twelve-character stage direction are both `stray`, and
           * only the first one means the model stopped following the format.
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
           * ## Decide before settling: one more reply, or the end?
           *
           * `settle` is write-once, so asking for a continuation has to happen
           * *before* it — a run that already said `limit_reached` can never
           * afterwards report the complete discussion the continuation produced.
           *
           * Two reasons to ask again, and only two:
           *
           *   - `ceiling` — the reply stopped at the technical ceiling. The words
           *     are ours up to the cut, so the continuation quotes them and asks
           *     the model to carry on from the next speaker.
           *   - `coverage` — the reply finished cleanly but somebody never spoke.
           *     The rules require every member to open her mouth, so this is not
           *     a complete discussion; ask once for exactly the missing voices.
           *
           * Both are bounded by `SIM_MAX_CONTINUATIONS`. Coverage is additionally
           * tried at most once: if a second request still cannot get C to talk,
           * another one will not either, and pretending otherwise spends a
           * minute to produce the same silence.
           */
          const missing = silentMembers(names, spokenAll);
          const askable =
            options?.signal?.aborted !== true &&
            continuations < SIM_MAX_CONTINUATIONS &&
            /*
             * A stall is not a short answer. `timedOut` rewrites the finish to
             * `stop` so the text is kept, which makes a cut run *look* clean —
             * and then the missing voice would be read as a choice and chased
             * with another request. It was not a choice, it was the socket, and
             * the request that just timed out is not the one to ask again.
             *
             * The exception is a *resumable cut*: the socket died mid-sentence
             * with text already on screen. Asking a fresh request to continue
             * from the seam is exactly the repair, and the new attempt gets its
             * own wall-clock ceiling, so the stalled one is not resurrected.
             */
            (timedOut !== true || resumableCut === true) &&
            verdict !== "error" &&
            verdict !== "cancelled";
          let followUp = "";
          if (askable === true && verdict === "limit_reached" && raw !== "") {
            /*
             * `raw !== ""` matters: a `max-tokens` finish with nothing written
             * means the model spent the whole ceiling on reasoning or on an
             * empty reply. There is no seam to continue from, and asking again
             * with the identical request would spend another ceiling to arrive
             * at the same nothing.
             */
            followUp = "ceiling";
          } else if (askable === true && resumableCut === true) {
            /*
             * The connection died mid-sentence. `ceiling` is the right prompt
             * even here: it already tells the model the last line was cut and
             * to reopen it under the same speaker's name and finish it, which
             * is the same instruction a token cut needs. `verdict` is
             * `incomplete` for this branch (tail cut, not a parse failure), so
             * the two `converged`-only reasons above and below cannot fire.
             */
            followUp = "ceiling";
          } else if (askable === true && verdict === "converged" && missing.length > 0 && coverageTried !== true) {
            followUp = "coverage";
          }
          if (followUp !== "") {
            continuations += 1;
            if (followUp === "coverage") coverageTried = true;
            /*
             * The raw text, protocol markers and all — not a re-render of the
             * parsed segments. The model wrote it, so it should read exactly
             * that, including a half-finished last line: a continuation asked to
             * "carry on" needs to see where the cut happened, and re-rendering
             * would quietly repair the very seam it has to continue from.
             */
            transcript = transcript === "" ? raw : `${transcript}\n${raw}`;
            run.continuations = continuations;
            messages = simulationMessages({
              prompt,
              task: asked.task,
              /*
               * Memory rides every request of the run, continuations included:
               * a ceiling retry that dropped it would let the model "forget"
               * the previous rounds mid-turn — the exact failure memory exists
               * to prevent, reintroduced one continuation later.
               */
              memory: memBlock,
              transcript,
              /*
               * Both kinds of follow-up need the missing names now: a ceiling
               * continuation must cover them before it closes, and a coverage
               * request exists for nothing else. Passing an empty list here was
               * how "cover everybody first" got dropped on the truncation path.
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
           * The run is terminal here — every continuation path `continue`d
           * above. Freeze what the room actually said (accumulated across
           * continuations) so `finally` can hand it to memory.
           */
          finalRaw = transcript === "" ? raw : `${transcript}\n${raw}`;
          const status = settle(verdict);
          /*
           * Coverage is measured on **every** terminal state, not only a clean
           * end. The old placement computed it inside `status === "converged"`,
           * which made the ledger ambiguous in exactly the rows that need it
           * most: a truncated run recorded `silent: []`, and a reader could not
           * tell "nobody was missing" from "nobody measured". A coverage metric
           * built on that field would have silently counted every truncation as
           * full coverage.
           *
           * The *user-facing* notice stays on the clean end only — after a cut,
           * a missing voice is more likely the ceiling than a choice, and
           * naming her would be a claim the run cannot back. The two uses are
           * different questions and are now answered separately.
           */
          run.silent = silentMembers(names, spokenAll);

          /*
           * A reply that went fine says nothing extra.
           *
           * The footer (`〔团队「X」 · 2 人〕`) used to close every reply. It was
           * there to prove the run had finished, and a live run showed what that
           * costs: a clean five-line conversation ended with a machine line nobody
           * asked for. The run record already carries the team, the size, the
           * status and who stayed silent, so the reply is now the conversation and
           * nothing else — plus one line, and only one, when something actually
           * went wrong.
           */
          if (status === "error") {
            append(`! 这一轮团队没跑起来：${explainFailure(finishCode, finishFailure, run.requests.length)}`);
          } else if (status === "cancelled") {
            append("! 这一轮讨论已取消。");
          } else {
            const prose = raw.trim();
            if (wrote === 0 && prose !== "") {
              /*
               * The model answered, just not in the protocol. Echoing it under a
               * label is the only honest option: rendering it as `名字：台词` would
               * fake a segment, and dropping it loses a real answer. The design
               * forbids the first, and the second is what this whole run exists to
               * stop doing (§3.6).
               */
              append(prose.slice(0, PROSE_FALLBACK_LIMIT));
              append("! 这段不是按分段协议写的，原文照上。");
            } else if (wrote === 0) {
              append(SIM_SILENCE);
            }
            if (status === "limit_reached") {
              /*
               * Say whether the ceiling was the end of the road or merely the
               * end of one request. "Truncated" after two continuations means
               * the discussion genuinely outgrew the budget; "truncated" with
               * none means the continuation path did not run, which is a bug
               * worth seeing rather than smoothing over.
               */
              append(
                continuations > 0
                  ? `! 这一轮到了长度上限（已自动续写 ${continuations} 次），后面被截断了。`
                  : "! 这一轮到了长度上限，后面被截断了。",
              );
            } else if (status === "incomplete" && wrote > 0 && tailCut !== true) {
              /*
               * A parse failure, not a cut: the text was there but the protocol
               * was not followed. A mid-sentence cut is reported below instead,
               * with the line that actually describes it.
               */
              append("! 产物没有完整解析，已保留可读部分。");
            } else if (status === "incomplete" && prose === "") {
              append("! 这一轮没有拿到完整输出。");
            }
            /*
             * A wall-clock stall that had already produced text ends here: the
             * partial discussion is kept and this one line says why it stops.
             * Distinct from `limit_reached` (the model hit the token ceiling) and
             * from a parse failure — the words are fine, the connection died.
             */
            if ((timedOut === true || tailCut === true) && wrote > 0) {
              /*
               * The reply stopped short and the continuation budget is spent
               * (or this is a stall whose resumed request also stalled). The
               * words are kept and this one line says why it stops.
               *
               * Two shapes reach here: a wall-clock stall (the socket died, and
               * the last line may or may not have closed — `tailCut` is only
               * one of the symptoms) and a clean `stop` that still ends inside
               * an unclosed quote. The connection case names the connection,
               * because that is the more useful diagnosis when the user is
               * deciding whether to retry.
               */
              append(
                timedOut === true
                  ? "! 这一轮因为连接卡住被截断了，已保留说出的部分。"
                  : "! 这一轮输出被中途截断了，已保留说出的部分。",
              );
            }
            /*
             * Who stayed out, said to the user. Only on a normal end: after a
             * truncation or a parse failure the missing voice is likely the
             * cut, not a choice, and saying "she did not speak" would be a
             * claim the run cannot back. The ledger still records it above.
             */
            if (status === "converged" && run.silent.length > 0) {
              append(renderSilence(run.silent));
            }
          }
          break;
        }
        /*
         * The inner loop only ever leaves two ways: a continuation was requested
         * (`again`) or the run is over. `continue` goes back to the outer loop
         * with fresh `messages`; anything else ends the run and lets `finally`
         * write its one ledger line.
         */
          if (again === true) continue;
          break;
        }
      } catch (error) {
        // A discussion that could not even be attempted is still an answer the
        // user must see. This stream *is* the reply, so silence is the one
        // outcome the path exists to remove.
        warn(`接管这一轮失败：${error?.message ?? error}`);
        settle(options?.signal?.aborted === true ? "cancelled" : "error");
        emit(`! 这一轮团队没跑起来：${oneLine(error?.message) || "未知错误"}`);
      } finally {
        /*
         * The ledger line, written once per run, after the terminal state is
         * decided and after the usage chunk (if any) has been seen.
         *
         * Written here rather than at each exit path so failure and cancellation
         * land in the same place as a normal end: a run that never reached the
         * provider is exactly the line a cost baseline needs, and dropping it
         * because "nothing was spent" is how a silent regression hides.
         */
        const usage = providerUsage;
        /*
         * Closing the queue comes **first**. The reply is already written at
         * this point, so nothing below may be allowed to keep the stream open —
         * a ledger that throws must cost a log line, never a hung turn.
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
           * How many provider requests this line actually describes.
           *
           * One is the normal case. A larger number is not a detail: the usage
           * columns below come from the **last** attempt, so a reader comparing
           * costs has to know that an earlier attempt was paid for and not
           * counted. The failure class of that last attempt is here for the same
           * reason — `Request timed out.` in a log is only diagnosable when the
           * class that produced the retry decision is written down too.
           *
           * Counted from `requests` rather than from the loop counter: with
           * continuations in play, the counter restarts at 1 for every logical
           * request, so `run.attempts` would describe the last one only.
           */
          attempts: run.requests.length,
          /*
           * Extra requests made to keep the discussion going (ceiling or
           * coverage). Separate from `attempts`, which counts tries at the
           * *same* request: a continuation is new text, a retry is the same
           * text asked for again.
           */
          continuations: run.continuations,
          /*
           * Every real request this run made, with its own usage, duration and
           * failure class. `attempts` above is just its length; this array is
           * what makes the money traceable, because the four `*Tokens` columns
           * above come from the **last** attempt only.
           */
          requests: run.requests,
          failureCode: finishCode === "" ? null : finishCode,
          /*
           * Structure and size of the request, in characters. Always present —
           * even when the provider reported nothing — because it is measured
           * here rather than by the provider.
           */
          requestShape: run.requestShape,
          promptChars: run.promptChars,
          taskChars: run.taskChars,
          /** Characters of team memory injected this run (0 = memory off). */
          memChars: typeof run.memChars === "number" ? run.memChars : 0,
          /*
           * The scale class and the ceiling it produced (A + B). `scale` is the
           * verdict `classifyTurn` made; `maxTokens` is the number that actually
           * went on the request. Together they answer "was this reply short
           * because it was asked to be, or because it hit the ceiling" — which a
           * raw output-token count cannot.
           */
          scale: run.scale,
          maxTokens: run.maxTokens,
          /*
           * The two-state progress fact (C): how long the reply spent waiting
           * for its first token, and the phase it was in. `firstTokenMs: null`
           * means no token ever arrived (a failed or cancelled run). This is the
           * measured latency, not a progress bar.
           */
          phase: run.phase,
          firstTokenMs: run.firstTokenMs,
          /*
           * The frozen configuration: hashes and lengths only, never a body.
           *
           * This is the field that makes a row re-usable evidence. `team: "x"` and
           * `size: 3` describe a shape two different discussions can share; a
           * member's `bodyHash` does not. Reproducing a run means asking the
           * directory for the text *now* and comparing — `exportSnapshot` does
           * exactly that, and labels every member that has since changed.
           */
          config: run.config,
          startedAt: run.startedAt,
          finishedAt: endedAt,
          durationMs: endedAt - run.startedAt,
          /*
           * Two values only. "provider" means the numbers below came from the
           * provider; "absent" means nothing was measured and every token field
           * is `null`. There is deliberately no "estimated": a guess in this
           * column would be indistinguishable from a measurement later, which
           * is the one thing this ledger exists to prevent.
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
         * `midDiscussion` is **not** cleared here. The work loop ends when the
         * model stream does, but the outer generator may still be draining
         * buffered chunks; clearing now would open a window in which a second
         * trigger falls through to a real model call. The outer `finally`
         * clears it once the reply is actually finished.
         */
        /*
         * Memory recording, last of all. A round that said nothing records
         * nothing (`finalRaw === ""` covers no-service, empty replies and a
         * cancel during backoff alike); a round that was cut mid-sentence
         * still happened on screen, so it is remembered as what it was —
         * including the cut. The fold that the eviction might now owe is
         * taken at the START of the next round (`foldSummary` there), which
         * keeps this finally free of model calls.
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
    // `work` cannot reject — every path above is caught or in `finally` — but the
    // promise is still pinned down: `drain()` is what decides when this stream
    // ends, and a floating rejection would be invisible.
    work.catch(() => {});
    try {
      for await (const chunk of queue.drain()) yield chunk;
      /*
       * Blocks close before the terminal finish, and the text of the closing
       * block must be the whole reply: both are checked by the invariant.
       *
       * `usage` goes **between** them, exactly once, and only when the provider
       * actually reported it. The invariant allows it at most once and before
       * `finish`; emitting a synthesised `{inputTokens: 0}` here would be worse
       * than emitting nothing, because the platform would then record a
       * measured-looking zero for a turn it never measured.
       */
      yield { type: "block-end", index: 0, block: { type: "text", text: full } };
      if (providerUsage !== null) yield { type: "usage", usage: providerUsage };
      yield { type: "finish", reason: { kind: "stop" } };
    } finally {
      midDiscussion.delete(sessionId);
    }
  }

  /*
   * The takeover, in two halves.
   *
   * ## Half one — `agent/pre-step`: decide, and do nothing else
   *
   * `agent/pre-step` is the *only* extension point that runs before
   * `step/start`, and it is a waterfall: a listener that returns without calling
   * `next()` short-circuits it, and `preStep` then reads `{kind:"reject"}`. That
   * is how this hook used to answer the turn, and why it could not answer it
   * visibly — a refused step never opens, so no legal reply exists inside it.
   *
   * So the rejection is gone. This half only decides, records the decision in
   * {@link owed}, and passes the step through; the reply happens at the model
   * call. The decision itself is unchanged and still requires all of: step 1, a
   * real user message, a session that is not a delegated child, and a team that
   * actually resolves to at least one delegate. Every uncertain case returns
   * `next()`, because passing a message through costs a coordinator turn while
   * taking one over costs an answer nobody sees.
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
      // Nothing is owed for this session. Leaving a stale entry behind would let
      // the team answer a step it never claimed.
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
   * ## Half two — `llm/stream`: where a plugin is allowed to be the model
   *
   * One listener handles every model call in the process, so the first thing it
   * does is answer "is this call owed to the team?". `options.sessionId` is the
   * session the loop built the request for, which is exactly the identity
   * `pre-step` keyed its decision by — and the entry is deleted before the
   * discussion starts, so the children's own model calls (same waterfall, their
   * own session ids) pass straight through to the provider.
   *
   * Anything unrecognised, expired, or already being discussed returns `next()`,
   * which is the ordinary path: the real provider answers.
   *
   * `global: true` is not optional and is not a broadening. A dispatch keeps
   * only the listeners whose context shares the emitting service's isolate
   * (`cordis` `dispatch()`: `hook.global || filter.call(thisArg, hook.ctx)`), so
   * a plain listener registered from a plugin can be filtered out of a service's
   * own waterfall depending on where that service was mounted. The platform's
   * own `dsh-session-title` listens here with `{ global: true, prepend: true }`
   * for exactly that reason. This one is *not* prepended, deliberately: the
   * stream invariant is, so it wraps ours and validates what we return.
   *
   * `prepend: false` also fixes the order of responsibility: our listener sees
   * the request after the invariant, and may return its own stream instead of
   * calling `next()`.
   */
  ctx.on("llm/stream", (options, next) => {
    /*
     * ## Auxiliary calls are not this turn's model call
     *
     * This listener sees **every** `llm.stream` in the process, and a session
     * has more than one: the session-title generator and the compactor both call
     * the model with `sessionId` set to the session they are summarising. The
     * platform marks those calls with `purpose` (`"session-title"`,
     * `"compaction"`); the agent loop's own request — built in
     * `dsh-agent-loop`'s `buildRequest` as
     * `{...config, messages, toolHistory, tools?, sessionId, signal}` — has no
     * such field.
     *
     * Skipping them first is not defensive tidiness. A live run titled the
     * session **"! 这条消息已经有一场讨论在进行，没有重复生成。"**: the title call
     * arrived four milliseconds after the turn's own request, found a discussion
     * in flight, and got that sentence back as its model answer. The guard has
     * to come before `owed.get`, too — consuming the claim on a title call would
     * hand the turn itself to `next()` and let the root Agent answer a question
     * the team was owed.
     */
    if (oneLine(options?.purpose) !== "") return next();
    const sessionId = oneLine(options?.sessionId);
    if (sessionId === "") return next();
    /*
     * Our own re-entrant call. `discussionStream` calls `llm.stream` to make the
     * one simulation request; the waterfall sees it again, and without this it
     * would either recurse or be mistaken for a duplicate.
     */
    if (simulationCalls.has(options)) {
      simulationCalls.delete(options);
      return next();
    }
    const asked = owed.get(sessionId);
    if (asked === undefined) {
      /*
       * No claimed turn. If a discussion is already in flight, this is a second
       * trigger for the same message — refusing it is the point of idempotency.
       * Falling through to `next()` would have the root model answer a second
       * time, which is a duplicate reply even though no second run was created.
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

  /* ------------------------------------------------------------- the command */

  ctx.commands.register({
    name: "waifu-team",
    description: "把这次会话交给一个团队：看有哪些队、选一个。",
    input: { hint: "队名" },
    /*
     * The argument is `rawInput`, and there is no second spelling.
     *
     * `dsh-commands`'s `execute` builds the invocation as
     * `{ commandId, agent, rawInput, attachments, signal }` — the only field
     * carrying what the user typed after the command name is `rawInput`. The
     * handler used to destructure `args` off it, which is `undefined` on every
     * single call, so `/waifu-team 素晴三人` fell into the "no argument" branch
     * and answered with the usage line — never selecting.
     *
     * Proven, not inferred: a probe booted the real tree, listed the registry
     * (`waifu-team` present), and ran the three spellings — all three returned
     * the same usage text. After this fix `/waifu-team <name>` answers about
     * that name.
     *
     * There is no "off" spelling any more: leaving a team is `/waifu-change`
     * (switch to a single persona) or `/waifu-reset` (back to the session's own
     * persona), and a team picker should only ever pick a team.
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
      off.delete(sessionId);
      const state = ensureTeam(agent);
      if (state.error !== undefined) {
        bound.delete(sessionId);
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
       * Move the session chip onto the chosen team's preset. The binding alone
       * only changes what the model is told; without this the label above the
       * conversation keeps naming the team the session was born with, so
       * switching 素晴三人 -> 龙女仆 looked like it did nothing.
       */
      deps.moveChipToTeam?.(agent, team.name);
      const resolved = resolveFor(sessionId, agent);
      const roster = resolved?.ok === true ? resolved.members.map((row) => row.name).join("、") : "";
      return {
        kind: "success",
        text: [
          `已切到团队模式：${team.name}。`,
          `本次成员：${roster}。`,
          "下一条消息由她们一起回答",
          ...(state.notices ?? []).map((line) => `· ${line}`),
        ].join("\n"),
      };
    },
  });

  return {
    /*
     * `stage(agent)` used to live here. It resolved the team and returned the
     * text the persona should gain — always `""` in v3 — and the persona
     * variable provider called it on every assembly, for every session.
     *
     * That made every step of every session pay a full team resolve (read the
     * store, scan the persona directory, resolve the members) for a string
     * nobody rendered: the platform resolves every variable whether or not the
     * template references it. Its only other product was a log line, and the
     * two places a user can actually see a degraded team — `/waifu-team` at
     * bind time, and the panel through `stateOf` — already report it.
     *
     * Removing it is the fix, not a tidy-up: the persona provider now returns
     * before touching any file for a team session.
     */
    /**
     * Is this agent running as a team **right now** — the light question.
     *
     * Unlike `ensureTeam` this resolves nothing and reads nothing from disk: it
     * is `isDelegated` plus `teamNameFor`, i.e. two Map/Set lookups and a
     * `teamForPreset` read. The persona-variable provider in `index.js` calls it
     * on every assembly of every session (the platform resolves every variable
     * unconditionally), so it must stay this cheap — the whole point of the
     * "闸门零 IO" rule.
     *
     * A session that was born on a team preset but then `/waifu-team off`ed it
     * answers `false` here, because `teamNameFor` returns `undefined` once the
     * session is in the `off` set. That is exactly the difference that lets the
     * provider stop serving an empty persona to a session that left team mode.
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
     * The team explicitly bound to this session — the `/waifu-team` override,
     * NOT the team the session was born on. `undefined` when there is no
     * explicit binding.
     *
     * `/waifu-reset` needs this because a team binding is an override too: it
     * has to clear it, or "本来就没有覆盖" is a lie while the next turn still
     * runs as the bound team.
     */
    boundNameOf(sessionId) {
      const id = oneLine(sessionId);
      return id !== "" && bound.has(id) ? bound.get(id) : undefined;
    },

    /**
     * Drop the explicit team override (and any "off" refusal), returning what
     * was there so the caller can report it. Chip restoration stays with the
     * host — this only touches the two in-memory rungs.
     */
    unbind(sessionId) {
      const id = oneLine(sessionId);
      if (id === "") return { bound: undefined, off: false };
      const had = bound.has(id) ? bound.get(id) : undefined;
      const wasOff = off.delete(id);
      bound.delete(id);
      return { bound: had, off: wasOff };
    },

    /** Bind a team to a session without the command (panel use). */
    bind(sessionId, name) {
      if (oneLine(sessionId) === "") return { ok: false, error: "没有会话 id。" };
      if (oneLine(name) === "") {
        bound.delete(sessionId);
        off.add(sessionId);
        return { ok: true, mode: "off", text: "", notices: [] };
      }
      const team = findTeam(store.current, name);
      if (team === null) return { ok: false, error: `没有叫「${name}」的团队。` };
      bound.set(sessionId, team.name);
      off.delete(sessionId);
      const agent = deps.liveAgentFor(sessionId);
      if (agent === undefined) {
        return { ok: true, mode: "off", text: "", notices: ["会话不在线，等它下次组装时再生效。"] };
      }
      const state = ensureTeam(agent);
      if (state.mode === "team") deps.moveChipToTeam?.(agent, team.name);
      return { ok: true, ...state };
    },
    /** What a session is bound to right now, for `/waifu-current` and the panel. */
    stateOf(sessionId) {
      const agent = deps.liveAgentFor(sessionId);
      const name = teamNameFor(sessionId, agent);
      if (name === undefined) return { mode: "off", team: null, text: "", notices: [] };
      if (agent === undefined) return { mode: "unknown", team: name, text: "", notices: [] };
      return { ...ensureTeam(agent), team: name };
    },
    /**
     * What a stored team resolves to *right now*, with no session in the
     * picture — the panel's preview.
     *
     * Deliberately resolved with `coordinator: null` rather than guessing one:
     * "who is the coordinator" is a property of a running session, and the
     * panel is looking at the file. Without a coordinator `inTeam` is false, so
     * every member shows as someone who would be delegated to, which is exactly
     * the answer the picker is asking for.
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
     * The frozen configuration, for callers that are not a run.
     *
     * Two reasons this is exposed rather than kept internal. The panel wants to
     * show "what would this team hash to" before a turn exists; and the export
     * below needs a snapshot handed to it — read from a `runs.jsonl` line by the
     * caller, because this file is forbidden to read the ledger back.
     */
    /** Freeze a stored team without running it. */
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
             * The ceiling is part of the frozen configuration, so it is computed
             * from the room rather than from a turn: the same team always gets the
             * same number here, which is what makes two snapshots comparable. The
             * scale class is a property of one turn, not of the configuration, so
             * it is not recorded.
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
     * Write one frozen configuration out, bodies included.
     *
     * The other half of the snapshot: the ledger never holds a body, so "show me
     * the text that ran" is an explicit request. Members whose file has changed
     * since the run are written with a `.drifted` suffix and listed in
     * `verify.json` — a directory that looks like a faithful copy of a run it no
     * longer matches is the one outcome this must not produce.
     */
    exportConfig({ config, outDir } = {}) {
      try {
        return {
          ok: true,
          ...exportSnapshot({
            config,
            /*
             * `null` — not `""` — for an id the directory no longer has. The
             * export reports that as missing; an empty file would hash like any
             * other empty string and read as a content edit instead.
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
    /** The group tags the directory actually carries, for the picker. */
    groups() {
      try {
        return availableGroups(rosterRows());
      } catch (error) {
        warn(`读人设分组失败：${error?.message ?? error}`);
        return [];
      }
    },
    /** Re-read the file after a write from anywhere else. */
    reload() {
      store.current = readStore(deps.storeFile);
      return store.current;
    },
    /**
     * Drop every binding that points at a name which no longer exists.
     *
     * Deleting a team has to do this or the deletion is only half done: a
     * binding left behind resolves to an error on every single assembly, so the
     * session sits in team mode forever with nothing to run. Called by the
     * panel's `remove`; the command path never needs it because `/waifu-team`
     * always re-binds by an existing name.
     */
    forget(name) {
      const wanted = oneLine(name);
      let dropped = 0;
      for (const [sessionId, held] of [...bound.entries()]) {
        if (held !== wanted) continue;
        bound.delete(sessionId);
        dropped += 1;
      }
      return dropped;
    },
    /**
     * Move every binding from one team name to another.
     *
     * Called by the panel's rename. A binding is a Map keyed on the session and
     * valued with a NAME, so a rename that only rewrote the file would leave
     * every live session pointed at a name that no longer exists — they would
     * spend the rest of their lives reporting "团队不在文件里了" instead of
     * running the team the user just renamed under them.
     *
     * Not the same operation as `forget`: nothing is dropped here, which is the
     * whole point.
     *
     * @returns how many bindings moved.
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
    /** The store the panel reads and writes; `adoptTeam` validates one entry. */
    store: () => store.current,
    adoptTeam,
    emptyStore,
    save() {
      const ok = writeStore(deps.storeFile, store.current) === true;
      if (!ok) warn(`写 ${TEAM_FILE} 失败。`);
      return ok;
    },
    /** Teardown. No id means everything this module owns. */
    dispose(sessionId) {
      const id = oneLine(sessionId);
      if (id === "") {
        bound.clear();
        off.clear();
        memoryCache.clear();
        return;
      }
      bound.delete(id);
      off.delete(id);
      /*
       * Cache keys are session × team (see `memKey`), so the unbind cannot
       * name one — drop every team's cached memory for this session. The
       * disk files stay; a rebind reads them back through `readMemory`.
       */
      for (const key of [...memoryCache.keys()]) {
        if (key.startsWith(`${id}::`)) memoryCache.delete(key);
      }
    },
    /**
     * Forget every session's team memory — the panel's 「清空团队记忆」.
     *
     * Cache first (a cleared disk under a live cache would resurrect the
     * rounds on the next read), then every `.json` in the memory directory.
     * @returns {Promise<number>} how many files were removed.
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
          /* one stubborn file must not stop the rest */
        }
      }
      return removed;
    },
    /** Exposed for the selftest, so the recursion guard is drivable offline. */
    isDelegated,
    /**
     * The v3 run registry, for the selftest and for diagnostics.
     *
     * Read-only by contract: a caller that changed a status here would be
     * writing past `settle`, which is the one place terminal state is decided.
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
      /** Provider requests this run took; 1 on a healthy turn. */
      attempts: run.requests.length,
      /** Extra requests that carried the discussion on (ceiling or coverage). */
      continuations: run.continuations,
      /** The reply's scale class and the token ceiling it produced. */
      scale: run.scale,
      maxTokens: run.maxTokens,
      /** Characters of team memory injected this run. */
      memChars: typeof run.memChars === "number" ? run.memChars : 0,
      /** Progress phase and first-token latency (C). */
      phase: run.phase,
      firstTokenMs: run.firstTokenMs,
      /** Identity of the last request; the array below has every one. */
      requestId: run.requestId,
      requests: run.requests.map((entry) => ({ ...entry })),
      silent: run.silent.slice(),
      diagnostics: run.diagnostics.slice(),
    })),
  };
}

/**
 * The task in a claimed inbox batch, or `null` when there is not one.
 *
 * "A user message" is not the same as "`role === "user"`": every message in an
 * Agent's inbox has `role: "user"` — a sub-agent's relayed answer, a
 * `subagent-settled` notice, a model-selection context block, a compaction
 * checkpoint. They differ in `source.kind`, and only `"user"` / `"user-rpc"` are
 * a person typing. `user-rpc` is the same thing from a client that sent an RPC
 * id and a time zone; it is a real user message and must not be dropped.
 *
 * Two values are also treated as "no task":
 *
 *   - **an empty text** — an image-only or attachment-only message has nothing
 *     for a team prompt to be built from, and inventing one would answer a
 *     question nobody asked;
 *   - **a leading `/`** — commands are handled by `dsh-commands` and never reach
 *     an inbox (`command/run` / `command/done` are direct log appends, and the
 *     result is a UI notice), so this is unreachable in practice. It stays
 *     because the cost of being wrong here is a discussion about the literal
 *     text `/waifu-team 素晴三人`, and the cost of the guard is one comparison.
 *
 * The **last** qualifying message wins: a turn claims `next-step` in full before
 * the one `next-turn` message, and a later message supersedes an earlier one.
 *
 * @param {readonly object[]} messages - the `agent/pre-step` payload's `messages`.
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
 * The stable id of the same message {@link userTaskIn} selected.
 *
 * `userTaskIn` deliberately returns text, not a row, because the discussion only
 * needs the words. Idempotency needs the identity, so this walks the same rule
 * once more: the **last** `source.kind` of `user` / `user-rpc`, and only that
 * one. Anything else in an inbox (a relay, a settlement notice, a checkpoint)
 * is not a person typing and must never mint a run key.
 *
 * @param {readonly object[]} messages
 * @returns {string} `""` when there is no qualifying message
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

