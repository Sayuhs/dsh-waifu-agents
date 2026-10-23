/**
 * Team memory: what lets one round know what the previous rounds said.
 *
 * ## The shape
 *
 * A session's memory is three boxes:
 *
 *  - `rounds`  — the recent discussion, **verbatim**, one entry per round.
 *  - `summary` — everything older, compressed into one bounded paragraph.
 *  - `backlog` — rounds evicted from `rounds` but not yet folded into
 *    `summary` (the fold needs an LLM call, and failing to make one must
 *    never lose the text).
 *
 * ## Why characters, not tokens
 *
 * Every limit here is in characters. A tokenizer does not run in this
 * plugin, and the Chinese≈0.63-token-per-char estimate is wrong by
 * hundreds of tokens at the 4k scale — a budget denominated in tokens
 * would be a fiction with decimal places. Characters are measurable, and
 * the defaults are chosen conservatively against that measure.
 *
 * ## Why eviction is whole-round
 *
 * A round's text is a sequence of 〔名字〕 segments. Cutting it at an
 * arbitrary character leaves a half-sentence in memory that the next
 * round will treat as the state of the scene; cutting at a round boundary
 * leaves a coherent (if older) picture. The window may therefore hold
 * fewer characters than the limit — that is the point.
 *
 * ## Why the fold is lazy
 *
 * Folding `backlog` into `summary` costs one LLM call. Doing it at
 * eviction time would be inside the run's `finally`, where a slow call
 * delays nothing visible but the error surface is ugly (the reply stream
 * is already closed). Doing it at the START of the next round keeps the
 * call inside a live fiber with real error handling — the cost is that
 * the round after an eviction waits a few extra seconds, which is
 * amortized: eviction only happens once the window fills.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Schema version of the on-disk file. */
export const MEMORY_VERSION = 1;

/** Characters of verbatim recent rounds kept for injection. */
export const MEMORY_WINDOW_CHARS = 4800;

/** Characters a folded summary may occupy. */
export const MEMORY_SUMMARY_CHARS = 800;

/** A memory untouched for this long is dead: expired on load. */
export const MEMORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Map a team's retention option to the TTL `readMemory` understands.
 *
 * `memoryTtlDays` is what the team record stores (a scalar the panel edits):
 * `0` means "keep forever", a positive number is the idle window in days,
 * anything else falls back to the shipped default week. `Infinity` — not a
 * huge number — is the "never expire" sentinel, because `Number.isFinite`
 * guards in `readMemory` would otherwise swallow it into the default.
 * @param {unknown} days the team record's `memoryTtlDays`
 * @returns {number} TTL in ms, or `Infinity` for keep-forever
 */
export function memoryTtlMsFromDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n < 0) return MEMORY_TTL_MS;
  return n === 0 ? Infinity : n * 24 * 60 * 60 * 1000;
}

/** Evicted batches kept while their fold keeps failing. Beyond this, the oldest is dropped for real. */
export const MEMORY_BACKLOG_MAX = 3;

/**
 * A safe file name for one session's memory.
 *
 * Session ids are host-shaped, not file-shaped. The name keeps the
 * characters that are safe everywhere, replaces the rest, caps the length,
 * and appends a short digest of the ORIGINAL id so two long ids that
 * sanitize to the same prefix still get two files.
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

/** A fresh, empty memory. */
export function emptyMemory() {
  return { v: MEMORY_VERSION, seq: 0, summary: "", rounds: [], backlog: [], updatedAt: 0 };
}

/**
 * Validate a loaded file into the current shape. Anything unreadable
 * becomes an empty memory — a corrupt memory must never break a turn.
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
 * What one round contributes, verbatim. The user's words ride along:
 * without them, "好的，就这么办" is memory of nothing.
 * @param {string} input the user's message that round
 * @param {string} output everything the room said, protocol markers included
 */
export function roundText(input, output) {
  const said = typeof input === "string" ? input.trim() : "";
  const spoken = typeof output === "string" ? output.trim() : "";
  return `【用户说】${said}\n${spoken}`;
}

/**
 * Add one round, then trim the window by dropping the OLDEST WHOLE rounds.
 * Mutates `memory` (the runtime keeps it as its cached source of truth) and
 * returns the evicted texts as one batch string — "" when nothing was
 * evicted.
 * @param {object} memory a live memory object
 * @param {{input: string, output: string}} round
 * @param {number} [windowChars]
 * @returns {string} the evicted text, "" when the window still fits
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
 * The text injected ahead of the current turn, or "" when there is nothing.
 *
 * The markers use 【】 on purpose: the segment protocol owns 〔〕, and the
 * two must never be mistakable for each other — the parser only ever reads
 * the OUTPUT, but a human pasting this back in should not be able to forge
 * a speaker either.
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
 * The user-side prompt for the fold call. Demands bare prose: a list or a
 * heading would ride inside `[梗概]` and read like script stage directions.
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

/** Clamp a fold result to the cap, and strip wrapping quotes some models add. */
export function clampSummary(text, cap = MEMORY_SUMMARY_CHARS) {
  let out = typeof text === "string" ? text.trim() : "";
  if (out.length >= 2 && ((out.startsWith("「") && out.endsWith("」")) || (out.startsWith("『") && out.endsWith("』")))) {
    out = out.slice(1, -1).trim();
  }
  return out.slice(0, cap);
}

/**
 * Fold an evicted batch into the summary. Mutates `memory`.
 * @param {object} memory
 * @param {string} text the model's fold output
 * @param {number} [cap]
 */
export function applySummary(memory, text, cap = MEMORY_SUMMARY_CHARS) {
  memory.summary = clampSummary(text, cap);
  memory.backlog = [];
}

/** Drop the oldest backlog batch when the fold has failed too many times. */
export function trimBacklog(memory, max = MEMORY_BACKLOG_MAX) {
  while (Array.isArray(memory.backlog) && memory.backlog.length > max) {
    memory.backlog.shift();
  }
}

/* ---------------------------------------------------------------- io */

/**
 * Read one session's memory, or a fresh one. Expired memory is deleted on
 * sight and answered as fresh: a memory past its TTL is not history, it is
 * clutter with old plot in it.
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
 * Persist one memory. Temp-file-then-rename: a crash mid-write leaves the
 * old file intact, never a truncated half of the conversation.
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

/** Delete one session's memory. Absent is fine. */
export async function removeMemory(dir, sessionId) {
  await fs.rm(path.join(dir, memoryFileName(sessionId)), { force: true }).catch(() => {});
}
