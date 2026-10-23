/**
 * The frozen half of a run: what the team *was*, written down as hashes.
 *
 * ## The problem this solves
 *
 * The ledger already says a run happened and what it cost. It could not answer
 * "what exactly ran", because everything that decides the answer lives outside
 * the ledger and keeps moving: a persona `.md` gets edited, a team's roster is
 * re-ordered, the shared rules get reworded, the task is a message that scrolls
 * away. A row saying `team: "monster"`, `size: 3` describes a shape, and two
 * different discussions can share that shape.
 *
 * ## Why hashes instead of text
 *
 * Copying the prompt (or the three persona bodies) into `runs.jsonl` would make
 * the ledger a second copy of the cast's words — the one thing §5.5 forbids, and
 * it would grow without bound. A short hash plus a length is enough to answer
 * the only question that matters later: **is the text on disk still the text
 * that produced this run?** If yes, the run is reproducible from the directory
 * as it stands; if not, the row honestly says "not reproducible" instead of
 * quietly implying it is.
 *
 * So the direction stays one-way. The ledger never carries a body; a *person*
 * who wants the bodies asks for them, and the export (below) reads them from the
 * directory at that moment and labels every one that has since changed.
 *
 * ## Why the persona mode is recorded
 *
 * `personaOf` is body-only when the host supports it and the assembled text
 * otherwise (see `team-runtime.js`). Those are different strings, so a hash
 * taken in one mode is meaningless in the other. `personaSource` says which
 * string was hashed — and `"mixed"` when a host answered body-only for one
 * member and fell back to assembled for another, which is a real shape (a
 * persona whose body the host cannot isolate) and would otherwise be described
 * as something it is not.
 *
 * @module
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Bumped when the snapshot's own shape changes, never when content changes. */
export const CONFIG_VERSION = 1;

/**
 * How much of the digest is kept.
 *
 * Twelve hex characters is 48 bits: enough that two revisions of one persona
 * file will not collide, short enough that a row stays readable. This is a
 * change detector, not a signature — nothing here resists a deliberate forgery.
 */
export const HASH_CHARS = 12;

/**
 * A stable short digest of one string.
 *
 * Trailing whitespace is kept as-is on purpose: the prompt is built from the
 * bytes on disk, so normalising them here would make two different prompts
 * hash the same.
 *
 * @param {unknown} text
 * @returns {string} 12 lowercase hex characters
 */
export function shortHash(text) {
  const body = typeof text === "string" ? text : String(text ?? "");
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, HASH_CHARS);
}

/** Length of a value as a string, or 0 for "nothing there". */
function charsOf(value) {
  if (typeof value !== "string") return 0;
  return value.length;
}

/**
 * Freeze one discussion's configuration.
 *
 * Everything here is derived from inputs the caller already has at the moment
 * the request is built, so it costs one hash per persona plus a few for the
 * rules and the prompt — microseconds against a model call.
 *
 * @param {object} input
 * @param {{name?: string, background?: string, roles?: Record<string, string>}} input.team
 * @param {ReadonlyArray<{id: string, name?: string}>} input.members in speaking order
 * @param {(id: string) => string} input.personaOf the exact text poured into the prompt
 * @param {"body" | "assembled"} [input.personaSource] which variant was used, when
 *   the caller knows it globally
 * @param {(id: string) => ("body" | "assembled")} [input.sourceOf] per-member
 *   variant, for a host that can only isolate some bodies
 * @param {ReadonlyArray<string>} [input.rules] the shared rule block, as lines
 * @param {string} [input.task]
 * @param {{provider?: string, model?: string, maxTokens?: number, maxRounds?: number, scale?: string}} [input.model]
 *   `maxRounds` is read only for rows written before the round count was removed;
 *   new rows pass nothing and get `null`, which is a true "no such parameter"
 *   rather than a number nobody honours.
 * @param {{text?: string, shape?: string}} [input.prompt]
 * @returns {object} a JSON-safe object: scalars, hashes, no bodies
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
   * `mixed` matters: it says the member hashes below are not all describing the
   * same kind of string, so a reader must not expect them to line up with either
   * of the pure modes.
   */
  const oneSource = sources.size === 1 ? [...sources][0] : "mixed";

  return {
    version: CONFIG_VERSION,
    /*
     * Which string the member hashes describe. A reader comparing a run from a
     * host with `personaBodyOf` against one without must not expect the hashes
     * to line up, and this is the field that says so.
     */
    personaSource: oneSource,
    team: {
      name: text(team?.name),
      backgroundChars: background.length,
      backgroundHash: shortHash(background),
      /** Whether this team carries memory across rounds (a scalar, not a body). */
      memory: team?.memory !== false,
      /** Retention in idle days (0 = keep forever); adoptTeam already normalized it. */
      memoryTtlDays:
        Number.isFinite(Number(team?.memoryTtlDays)) && Number(team?.memoryTtlDays) >= 0
          ? Math.floor(Number(team?.memoryTtlDays))
          : 7,
      /** Per-team size cap (null = follows the store-wide maxTeamSize). */
      maxMembers:
        Number.isSafeInteger(team?.maxMembers) && team.maxMembers >= 2 ? team.maxMembers : null,
      /*
       * Roles are per-member labels written on the team, not on the persona, so
       * they can change without a single persona file moving. An ordered array
       * rather than an object keeps the JSON key order meaningful and matches
       * `members` one-to-one.
       */
      roles: rows.map((row) => ({ id: text(row?.id), role: text(roles[row?.id]) })),
    },
    /*
     * Speaking order matters and is therefore recorded, not implied: `members`
     * is the order the prompt lists them in, which is the order the model is
     * nudged to let them speak.
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
 * Compare a frozen configuration against the directory as it is now.
 *
 * Pure: it only asks `personaOf` for the current text, so a caller can run it
 * without touching a disk of its own. This is the honest half of "snapshot" —
 * a hash that is never re-checked is decoration.
 *
 * @param {object} input
 * @param {object} input.config a snapshot from {@link snapshotOf}
 * @param {(id: string) => string} input.personaOf the *current* text for one id
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
     * `null` is not `""`. A persona file that was deleted returns `null` from
     * the host; an empty one returns `""` and hashes like any other text. Folding
     * both into "changed" would hide a deletion behind a content edit, and the
     * two have different repairs.
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

/** Make an id safe to use as a file name without losing which id it was. */
function fileNameFor(row) {
  const id = typeof row?.id === "string" && row.id !== "" ? row.id : "member";
  const safe = id.replace(/[^\p{L}\p{N}._-]/gu, "_");
  const order = Number.isInteger(row?.order) ? String(row.order).padStart(2, "0") : "??";
  return `${order}-${safe}`;
}

/**
 * Write one frozen configuration, plus the bodies it describes, to a directory.
 *
 * ## Why an explicit export instead of writing bodies into the ledger
 *
 * Two different questions, two different lifetimes. The ledger answers "what
 * happened" forever and must stay a summary; an export answers "show me the
 * exact text" once, for one run, and is allowed to be large. Keeping them apart
 * is what lets the ledger keep its no-bodies rule without giving up
 * reproducibility.
 *
 * ## Drift is labelled, never overwritten
 *
 * If a member's text has changed since the run, its current text is written as
 * `<order>-<id>.drifted.md` and listed in `verify.json`. Writing it under the
 * plain name would produce a directory that *looks* like a faithful copy of a
 * run it no longer matches — the failure mode a snapshot exists to prevent.
 *
 * @param {object} input
 * @param {object} input.config a snapshot from {@link snapshotOf}
 * @param {(id: string) => string} input.personaOf current text per id
 * @param {string} input.outDir directory to write into (created if needed)
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
