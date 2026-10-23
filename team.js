/**
 * dsh-waifu-agents — team definitions, the selection pipeline, and storage.
 *
 * Leaf module on purpose: it imports nothing from `index.js` and nothing
 * outside `node:` builtins, so it can be unit-tested offline and so `index.js`
 * can import it without a cycle. Anything it needs from the host (the persona
 * matcher, the logger) arrives as an argument.
 *
 * Two things live here, and they are two different kinds of thing:
 *
 *   1. **Storage.** `teams.json` beside `overrides.json`. It holds `selection`
 *      (what the user picked) and NEVER the resolved member list as an input —
 *      the resolved list is derived on every read. A team whose definition is a
 *      group follows the group: edit a persona's `group:` in the panel and the
 *      next run picks the change up. That is the whole reason groups are usable
 *      as an execution unit without a second store.
 *
 *   2. **The selection pipeline.** collect → dedupe → filter → sort → size.
 *      Its output deliberately separates "what will run" from "what the
 *      definition named but cannot run" — a silently shrinking team is the
 *      failure this project keeps rejecting.
 *
 * The v2 text layer is gone: there is no member prompt, no receipt protocol and
 * no transcript renderer here any more, because no member is ever started on her
 * own. A team is one simulated call, and the prompt for it lives in
 * `team-simulate.js`; this module only answers *who is in the room*.
 */

import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------- constants */

/** The file this plugin owns for team definitions, beside `overrides.json`. */
export const TEAM_FILE = "teams.json";
/**
 * The append-only run ledger, beside `teams.json`.
 *
 * One JSON object per line: what each team run cost, how long it took, and how
 * it ended. JSONL rather than one JSON array on purpose — a killed process can
 * only ever leave a half-written **last** line, and the earlier lines stay
 * readable, which is not true of rewriting an array.
 */
export const RUN_LOG_FILE = "runs.jsonl";
/** Bumped only when a reader older than the writer would misread the file. */
export const TEAM_VERSION = 1;
/** Teams are cheap; a cap keeps a corrupt file from filling the panel. */
export const TEAM_LIMIT = 100;
/** Longest team name the panel accepts. */
export const NAME_LIMIT = 60;
/** What to do when an explicit `maxTeamSize` is exceeded. */
export const CAP_POLICIES = ["refuse", "truncate"];
/** @deprecated The two presentation modes merged into one: members converse freely on the shared bus. Kept only to read legacy teams.json. */
/**
 * The UI's pseudo-group for "no group at all". It is not a name a persona can
 * have (`group:` is free text, but the picker maps empty to this sentinel), so
 * dispatching to it would pull every untagged persona in at once.
 */
export const UNGROUPED = "__none__";
/** Collapse whitespace and trim — the same reading `index.js` uses. */
export function oneLine(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

/** A blank value, in any of the shapes JSON can carry it. */
function blank(value) {
  return value === undefined || value === null || oneLine(value) === "";
}

/**
 * The sort key the roster uses, so a team and the picker agree on order.
 *
 * `order` is the persona's own front-matter number; a persona without one sorts
 * last rather than first, which is what the picker does (`choosableRows`). The
 * name is the tie-break, and `localeCompare` is called with an explicit locale
 * so a Chinese name and a Latin one do not swap places between two runs.
 */
export function orderKey(row) {
  return typeof row?.order === "number" && Number.isFinite(row.order)
    ? row.order
    : Number.MAX_SAFE_INTEGER;
}

export function compareRows(a, b) {
  const byOrder = orderKey(a) - orderKey(b);
  if (byOrder !== 0) return byOrder;
  return String(a?.name ?? a?.id ?? "").localeCompare(
    String(b?.name ?? b?.id ?? ""),
    "zh-Hans-CN",
  );
}

/** The empty store, and the shape every reader may rely on. */
export function emptyStore() {
  return {
    version: TEAM_VERSION,
    maxTeamSize: null,
    groupCapPolicy: "refuse",
    teams: [],
  };
}

/**
 * Read a store, tolerating anything.
 *
 * A missing file, a truncated file, or a file someone edited by hand all mean
 * the same thing to a reader: keep everything that parses, drop the rest, and
 * never fail a boot over it. The panel is where a user finds out — the same
 * choice `readOverrides()` makes one directory over.
 */
export function adoptStore(parsed) {
  const out = emptyStore();
  if (parsed === null || typeof parsed !== "object") return out;
  const cap = Number(parsed.maxTeamSize);
  if (Number.isSafeInteger(cap) && cap >= 2) out.maxTeamSize = cap;
  if (CAP_POLICIES.includes(parsed.groupCapPolicy)) {
    out.groupCapPolicy = parsed.groupCapPolicy;
  }
  const rows = Array.isArray(parsed.teams) ? parsed.teams : [];
  const seen = new Set();
  for (const raw of rows) {
    if (out.teams.length >= TEAM_LIMIT) break;
    if (raw === null || typeof raw !== "object") continue;
    const name = oneLine(raw.name).slice(0, NAME_LIMIT);
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.teams.push(adoptTeam(name, raw));
  }
  return out;
}

/** One team, with every field a reader may rely on present. */

/**
 * Normalize the retention field: a non-negative integer of days, `0` meaning
 * "keep forever", anything else the shipped default of 7.
 * @param {unknown} value
 */
function memoryTtlDaysOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 7;
  return Math.floor(n);
}

/**
 * Normalize the per-team size override: `null` when the team should follow
 * the store-wide cap, a safe integer ≥ 2 when it caps itself.
 *
 * Unlike the global `maxTeamSize` this never refuses a save: the field is an
 * OVERRIDE, and a malformed one (1, 0, "3 people", 2.5) reads as "no opinion
 * of its own" — the global setting answers instead. A capacity of 1 still
 * has no meaning here (`|team| < 2` already is single mode), so it is
 * normalized away rather than stored to say one thing and do another.
 * @param {unknown} value
 * @returns {number|null}
 */
function maxMembersOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 2) return null;
  return n;
}

export function adoptTeam(name, raw) {
  /*
   * `thinking` used to be a per-team scene option ("stage" / "ventriloquist").
   * It is gone: there is exactly one way a team talks — members speak for
   * themselves on the shared bus. Old files still carry the field, so it is
   * accepted on read and simply not carried forward; the next save drops it.
   */
  return {
    name,
    selection: adoptSelection(raw?.selection),
    // personaId -> role sentence. A missing role is not an error: the member
    // still gets the task, it just has no speciality line in its prompt.
    roles: adoptMap(raw?.roles),
    // personaId -> glob. The declared lane for that member's writes.
    writeScope: adoptMap(raw?.writeScope),
    // `cards` is the only surviving scene option: one card per run.
    scenes: { cards: "perRun" },
    // Team-level standing background (set once when the team is created). It is
    // injected into every member's prompt on every run, so a fact like "托尔和
    // 康娜彼此不知道是什么关系" is stated once rather than repeated per task.
    background: oneLine(raw?.background) || "",
    // Whether this team carries memory across rounds (see `team-memory.js`).
    // Absent means ON — memory is the default experience; `false` opts a team
    // back out to the old stateless-per-round shape and its constant cost.
    memory: raw?.memory !== false,
    // How many idle days one session's memory survives (0 = keep forever).
    // The panel edits it like the paging number: any non-negative integer.
    // Absent or malformed falls back to the shipped default of 7 — the same
    // default `memoryTtlMsFromDays` applies when the field is missing.
    memoryTtlDays: memoryTtlDaysOf(raw?.memoryTtlDays),
    // Per-team size cap overriding the store-wide `maxTeamSize` (null = follow
    // the global setting). A chat duo stays at 2 while a story team runs 5.
    maxMembers: maxMembersOf(raw?.maxMembers),
    // Audit only. Execution never reads this — see the module doc.
    lastResolved: Array.isArray(raw?.lastResolved)
      ? raw.lastResolved.map(oneLine).filter((id) => id !== "")
      : [],
    lastResolvedAt: oneLine(raw?.lastResolvedAt) || null,
  };
}

export function adoptSelection(input) {
  const out = [];
  if (!Array.isArray(input)) return out;
  for (const raw of input) {
    const kind = raw?.kind === "group" ? "group" : raw?.kind === "persona" ? "persona" : null;
    if (kind === null) continue;
    const ref = oneLine(raw?.ref);
    if (ref === "" || blank(ref)) continue;
    out.push({ kind, ref });
  }
  return out;
}

/** A `{ key: text }` map with blank entries dropped. */
function adoptMap(input) {
  const out = {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    const id = oneLine(key);
    const text = oneLine(value);
    if (id === "" || text === "") continue;
    out[id] = text;
  }
  return out;
}

export function readStore(file) {
  try {
    return adoptStore(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return emptyStore();
  }
}

/**
 * Write the store so the file on disk is never half of either version.
 *
 * Same staging-and-rename as `writeAtomic` in `index.js`, and for the same
 * reason: a reader that catches a partially written `teams.json` would have to
 * guess whether the user has one team or none.
 */
export function writeStore(file, store) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stage = `${file}.stage-${process.pid}`;
    const payload = {
      version: TEAM_VERSION,
      maxTeamSize: store.maxTeamSize ?? null,
      groupCapPolicy: store.groupCapPolicy,
      teams: store.teams,
    };
    fs.writeFileSync(stage, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(stage, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why this store cannot be used, or `null` when it can.
 *
 * The only refusal in P1 is `maxTeamSize < 2`, and it refuses on purpose rather
 * than clamping. A capacity of 1 does not mean "delegate one member" — `|team|
 * < 2` already means single mode — so the number expresses "never run as a
 * team", which has a direct expression (leave team mode off). Clamping to 2
 * would make the file say one thing and the plugin do another, which is the
 * class of bug this whole feature is built to avoid.
 */
export function storeProblem(store) {
  const cap = store?.maxTeamSize;
  if (cap === null || cap === undefined) return null;
  if (!Number.isSafeInteger(cap) || cap < 2) {
    return `maxTeamSize 只能是 ≥ 2 的整数（现在是 ${JSON.stringify(cap)}）。写成 1 表达的是「永远别开团队模式」，那件事请直接不开团队模式，别用容量配置兼职。`;
  }
  return null;
}

export function findTeam(store, name) {
  const wanted = oneLine(name);
  if (wanted === "") return null;
  return store.teams.find((team) => team.name === wanted) ?? null;
}

/**
 * Which stored team a `save` writes into, and whether that save is a rename.
 *
 * A team has no id — its name IS its identity in the file — so "save this
 * editor" is ambiguous on its own: the new name may match nothing (a rename) or
 * nothing at all (a create). Keying on the name alone made every rename look
 * like a create, which left the old entry behind and added a second team that
 * duplicated it under the new name.
 *
 * `original` is the name the editor was opened with, and closes the gap:
 *
 * - `original` empty, or equal to `name` → ordinary create-or-replace by name;
 * - `original` different → rename in place; it is an error if the old entry is
 *   gone (deleted elsewhere) or if the new name is already taken (that would
 *   silently overwrite a DIFFERENT team).
 *
 * @param {Array} teams - the store's teams, in file order.
 * @param {string} name - the name being written.
 * @param {string} original - the name the editor opened with.
 * @returns {{at: number, renamed: boolean, error: string|null}} `at` is the
 *   index to write (-1 = append), never the position of a conflicting team.
 */
export function saveTarget(teams, name, original) {
  const list = Array.isArray(teams) ? teams : [];
  const wanted = oneLine(name);
  const was = oneLine(original);
  if (was !== "" && was !== wanted) {
    const src = list.findIndex((team) => team.name === was);
    if (src < 0) {
      return { at: -1, renamed: false, error: `没有叫「${was}」的团队了，可能刚在别处被删掉。` };
    }
    if (list.some((team) => team.name === wanted)) {
      return { at: -1, renamed: false, error: `已经有一个叫「${wanted}」的团队了，换个名字。` };
    }
    return { at: src, renamed: true, error: null };
  }
  return { at: list.findIndex((team) => team.name === wanted), renamed: false, error: null };
}

/**
 * Where the global default has to move when a team is renamed.
 *
 * A team's preset id is DERIVED from its name (`团队-<name>`), so a rename
 * unregisters the old preset and registers a new one under a different id. The
 * default is stored as an id, which leaves a default that named the old one
 * pointing at nothing — and a dangling default is not a cosmetic problem: the
 * registry refuses EVERY new session with `agent-preset/not-found` rather than
 * falling back to the first row.
 *
 * Returns `null` when there is nothing to move, which is the common case (the
 * default names a persona, or another team) and what makes the caller safe to
 * run unconditionally.
 *
 * @param {{defaultId?: string|null, from?: string, to?: string}} input
 * @returns {{from: string, to: string} | null}
 */
export function defaultRenameFollow({ defaultId, from, to }) {
  const held = oneLine(defaultId);
  const before = oneLine(from);
  const after = oneLine(to);
  if (held === "" || before === "" || after === "") return null;
  if (before === after) return null;
  if (held !== before) return null;
  return { from: before, to: after };
}

/**
 * Whether the default names this team — the delete half of the same question.
 *
 * Same reason as {@link defaultRenameFollow}: deleting a team whose preset is
 * the default would leave the field naming an id nothing registers, so new
 * sessions fail with nothing left on screen to click. Both sides are compared
 * as ids because that is what the field holds; the name is not enough, since a
 * persona file may legally carry the same string.
 *
 * @param {{defaultId?: string|null, presetId?: string}} input
 */
export function defaultNamesTeam({ defaultId, presetId }) {
  const held = oneLine(defaultId);
  const preset = oneLine(presetId);
  return held !== "" && preset !== "" && held === preset;
}

/** Every group name the current directory can be dispatched by. */
export function availableGroups(roster) {
  const names = new Set();
  for (const row of roster ?? []) {
    const group = oneLine(row?.group);
    if (group !== "" && group !== UNGROUPED) names.add(group);
  }
  return [...names].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

/* ----------------------------------------------------- selection pipeline */

/**
 * Expand one selection into member rows.
 *
 * The pipeline is the specification, in this order: collect (members ∪ groups)
 * → dedupe by persona id → filter out what cannot mount → sort → size. Dedupe
 * before filter so a persona reachable by two paths is reported once.
 *
 * `strict` is the difference between the two callers, and it is not cosmetic:
 *   - `strict: true` — the user or the model just typed this. An unresolvable
 *     name is a typo, so it fails the whole call with the candidate list. This
 *     is design doc §7.4's "group not found → error", extended to named personas.
 *   - `strict: false` — this came out of a stored definition that may have
 *     drifted (a persona was archived, renamed, or its `group:` edited). The
 *     member is dropped and *named* in `removed`, never silently.
 *
 * @param {object} input
 * @param {{kind: string, ref: string}[]} input.selection
 * @param {object[]} input.roster rows in `listFiles()` shape
 * @param {boolean} [input.strict]
 * @returns {{ok: boolean, error?: string, hint?: string, members: object[],
 *   removed: object[], unknownGroups: string[], unknownRefs: string[]}}
 */
export function expandSelection({ selection, roster, strict = false }) {
  const rows = Array.isArray(roster) ? roster : [];
  const byId = new Map();
  const byName = new Map();
  for (const row of rows) {
    const id = oneLine(row?.id);
    if (id === "") continue;
    byId.set(id, row);
    const name = oneLine(row?.name);
    if (name !== "" && !byName.has(name)) byName.set(name, row);
  }

  const picked = [];
  const source = new Map();
  const unknownGroups = [];
  const unknownRefs = [];

  for (const entry of adoptSelection(selection)) {
    if (entry.kind === "group") {
      if (entry.ref === UNGROUPED) {
        unknownGroups.push(entry.ref);
        continue;
      }
      const hit = rows.filter((row) => oneLine(row?.group) === entry.ref);
      if (hit.length === 0) {
        unknownGroups.push(entry.ref);
        continue;
      }
      for (const row of hit) {
        const id = oneLine(row.id);
        if (!source.has(id)) source.set(id, `group:${entry.ref}`);
        picked.push(row);
      }
      continue;
    }
    const row = byId.get(entry.ref) ?? byName.get(entry.ref);
    if (row === undefined) {
      unknownRefs.push(entry.ref);
      continue;
    }
    const id = oneLine(row.id);
    if (!source.has(id)) source.set(id, `persona:${entry.ref}`);
    picked.push(row);
  }

  if (strict && (unknownGroups.length > 0 || unknownRefs.length > 0)) {
    const parts = [];
    if (unknownGroups.length > 0) parts.push(`组「${unknownGroups.join("、")}」找不到任何成员`);
    if (unknownRefs.length > 0) parts.push(`人设「${unknownRefs.join("、")}」不在目录里`);
    return {
      ok: false,
      error: `${parts.join("；")}。`,
      hint: unknownGroups.length > 0 ? availableGroups(rows) : [],
      members: [],
      removed: [],
      unknownGroups,
      unknownRefs,
    };
  }

  const seen = new Set();
  const members = [];
  const removed = [];
  for (const row of picked) {
    const id = oneLine(row.id);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    const name = oneLine(row.name) || id;
    if (row.idOk !== true) {
      removed.push({ id, name, reason: "名字里带了文件名放不下的字符", from: source.get(id) });
      continue;
    }
    const problems = Array.isArray(row.problems) ? row.problems : [];
    if (problems.length > 0) {
      removed.push({
        id,
        name,
        reason: `现在组装不出来（${problems.join("；")}）`,
        from: source.get(id),
      });
      continue;
    }
    members.push({
      id,
      name,
      group: oneLine(row.group) || null,
      order: typeof row.order === "number" ? row.order : null,
      description: oneLine(row.description) || null,
      from: source.get(id) ?? null,
    });
  }
  members.sort(compareRows);
  return {
    ok: true,
    members,
    removed,
    unknownGroups,
    unknownRefs,
  };
}

/**
 * Resolve a stored team for one session.
 *
 * Returns the split the callers need: `members` are the rows that will run,
 * `removed` are the ones the definition named and the directory cannot serve,
 * `drift` is what changed since the last dispatch, and `notices` are the
 * sentences the user is owed. `single` is the fallback decision — `|team| < 2`
 * — and it is computed here, once, so that the tool registration, the prompt
 * section, and the report cannot disagree about it (gate S3 ≡ H4).
 */
export function resolveTeam({ team, roster, coordinator, store }) {
  const selection = Array.isArray(team?.selection) ? team.selection : [];
  const expanded = expandSelection({ selection, roster, strict: false });
  const notices = [];

  /*
   * A group the directory has never heard of is a typo, and a typo must not be
   * absorbed (gate S4): falling back to single mode would let the user believe a
   * team ran. A persona that has since been deleted is ordinary drift and is
   * only announced (design doc §7.8) — the two are asymmetric on purpose, because
   * a group name is a *namespace* reference that cannot be interpreted at all,
   * while a persona ref points at something that demonstrably existed.
   */
  if (expanded.unknownGroups.length > 0) {
    return {
      ok: false,
      error: `团队「${team?.name ?? "临时小队"}」里的组「${expanded.unknownGroups.join("、")}」找不到任何成员。检查一下名字，或者先在设置里给成员打上这个组标签。`,
      hint: availableGroups(Array.isArray(roster) ? roster : []),
      notices,
      members: [],
      removed: [],
      drift: { added: [], removed: [], comparable: false },
    };
  }

  for (const ref of expanded.unknownRefs) {
    notices.push(`人设「${ref}」不在目录里了，这次没算上她。`);
  }
  for (const gone of expanded.removed) {
    notices.push(`${gone.name} 被剔除了：${gone.reason}。`);
  }

  const before = Array.isArray(team?.lastResolved) ? team.lastResolved : [];
  const now = expanded.members.map((row) => row.id);
  const drift = before.length === 0
    ? { added: [], removed: [], comparable: false }
    : {
        added: now.filter((id) => !before.includes(id)),
        removed: before.filter((id) => !now.includes(id)),
        comparable: true,
      };
  if (drift.added.length > 0 || drift.removed.length > 0) {
    /*
     * Ids are what the audit snapshot stores (a rename must not corrupt the
     * record), but a notice is read by a person, so it says names. An id the
     * roster no longer holds falls back to itself — that is exactly the
     * "removed" case, and the raw id is the most honest thing left to show.
     */
    const nameOf = new Map((Array.isArray(roster) ? roster : []).map((row) => [oneLine(row?.id), oneLine(row?.name)]));
    const label = (id) => nameOf.get(id) || id;
    const parts = [];
    if (drift.added.length > 0) parts.push(`新增 ${drift.added.map(label).join("、")}`);
    if (drift.removed.length > 0) parts.push(`少了 ${drift.removed.map(label).join("、")}`);
    notices.push(`团队「${team.name}」的成员自上次运行后变了（${parts.join("，")}）。`);
  }

  /*
   * The cap is per team first, global second: a team that states its own
   * `maxMembers` overrides `store.maxTeamSize`, and one that does not (the
   * normalized `null`) follows the store. `adoptTeam` guarantees the shape,
   * but resolveTeam also runs on definitions rebuilt from older files, so the
   * guard here repeats the invariant instead of trusting it.
   */
  const cap =
    Number.isSafeInteger(team?.maxMembers) && team.maxMembers >= 2
      ? team.maxMembers
      : store?.maxTeamSize ?? null;
  const policy = CAP_POLICIES.includes(store?.groupCapPolicy) ? store.groupCapPolicy : "refuse";
  let members = expanded.members;
  let truncated = [];
  if (cap !== null && members.length > cap) {
    if (policy === "refuse") {
      return {
        ok: false,
        error: `这次解析出 ${members.length} 名成员，超过了上限 ${cap}${Number.isSafeInteger(team?.maxMembers) && team.maxMembers >= 2 ? "（这一队自己设的）" : ""}。收窄一下选择，或者把上限调掉（这一队编辑器里的「本队人数上限」留空就是跟随全局；teams.json 里的 maxTeamSize 设成 null 就是全局不设限）。完整名单：${members
          .map((row) => row.name)
          .join("、")}。`,
        notices,
        members,
        removed: expanded.removed,
        drift,
      };
    }
    // `truncate` keeps the first `cap` in order and says who was skipped: a
    // report that omits them would be indistinguishable from a team that small.
    const skipped = members.slice(cap);
    members = members.slice(0, cap);
    truncated = skipped;
    notices.push(
      `按 order 只取了前 ${cap} 名，这几位这次没上：${skipped.map((row) => row.name).join("、")}。`,
    );
  }

  const coordinatorId = oneLine(coordinator?.id);
  const inTeam = coordinatorId !== "" && members.some((row) => row.id === coordinatorId);
  // Size is |team|, full stop. v3 used to also report who would get a child run
  // (everyone except the coordinator); nobody is started on their own any more,
  // so the only question left is how many voices the room has.
  const single = members.length < 2;

  return {
    ok: true,
    single,
    members,
    removed: expanded.removed,
    truncated,
    notices,
    drift,
    // Whether the session's own persona is one of the speakers. Display only:
    // in v3 she speaks like everybody else, she does not lead the room.
    coordinator: {
      id: coordinatorId || null,
      name: oneLine(coordinator?.name) || null,
      inTeam,
    },
    capacity: { max: cap, policy },
    team: { name: team?.name ?? null, selection },
  };
}

/* --------------------------------------------------------------- routing */
