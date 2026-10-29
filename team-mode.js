/**
 * 团队模式，面板看到的"目录"半：teamState / teamSet / teamMemoryClear。
 *
 * 从 `index.js` 的 "team mode" 段搬来（2026-10-28 P3 拆分）。teams.json 里写
 * 了哪些队、某个会话在哪一队——后者是会话的属性，面板只碰前者；这个边界
 * 在原段注释里有完整论证，随代码一起搬了过来。
 *
 * 两处机械改写与一处惰性引用：
 *   - `teamRuntime` -> `teamRuntimeOf()`、`cachedDefault` -> `defaultCache()`：
 *     apply() 里的 `let`，按值快照会过期；
 *   - `choosableRows` 住在 `memory-ops.js`，而它的安装在本模块之后，所以
 *     deps 里是 `(...args) => choosableRows(...args)` 的惰性转发。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @param {object} ctx 插件自身的上下文
 * @param {object} deps 模块常量、闭包句柄与活绑定 thunk
 * @returns {object} teamState / teamSet / teamMemoryClear
 */
export function installTeamMode(ctx, deps) {
  const {
    CAP_POLICIES,
    NAME_LIMIT,
    TEAM_LIMIT,
    adoptTeam,
    defaultNamesTeam,
    defaultRenameFollow,
    expandSelection,
    oneLine,
    saveTarget,
    storeProblem,
    listFiles,
    moveDefaultOff,
    refreshDefault,
    repointDefault,
    syncTeamPresets,
    teamPresetIdByName,
  } = deps;

  /* ------------------------------------------------------------- team mode */

  /**
   * Team mode, as the panel sees it — the **directory** half only.
   *
   * The feature has two halves that must never be conflated (design doc §6): the
   * teams written in `teams.json`, and which of them one session is on. The
   * settings panel can only ever see the first one, and that is a property of
   * the platform rather than a choice: `SettingsPluginsTabOwnerProps` is an
   * empty type, so no session id ever reaches the panel (see the header note in
   * `client.js`). A panel that offered "bind this session" would be guessing at
   * a session it cannot name. So it edits the file, and `/waifu-team` — which
   * runs *inside* a session and therefore knows which one — does the binding.
   *
   * What this op adds over reading the file is that every stored team is
   * resolved live against the persona directory: the panel shows what the name
   * points at *today*, including a member a deleted persona quietly took with
   * it, instead of echoing back the selection that was typed months ago.
   */
  async function teamState() {
    if (teamRuntimeOf() === null) {
      return { ok: false, error: "团队运行时还没装上，这个会话看不到团队。" };
    }
    await refreshDefault();
    const store = teamRuntimeOf().store();
    const teams = [];
    for (const entry of store.teams) {
      const preview = teamRuntimeOf().preview(entry.name);
      teams.push({
        name: entry.name,
        /*
         * The preset id this team is registered under, or `""` when it is not
         * one (the sync is still in flight, or it failed — see
         * `runTeamPresetSync`).
         *
         * The panel needs it for one reason: `selectedDefault` holds a PRESET
         * id, and a team's id is derived from its name, so without this field
         * the team tab cannot tell whether the switch it is drawing is the one
         * that is actually on. It is also what the switch writes — the same
         * field the persona rows write, because the platform only has one.
         */
        presetId: teamPresetIdByName(entry.name),
        selection: entry.selection,
        roles: entry.roles,
        writeScope: entry.writeScope,
        // Shipped back so the editor can show what the team already carries: a
        // field the panel writes but never reads would be wiped the first time
        // somebody opens an entry to rename it.
        background: entry.background,
        // No `thinking` row. There is one way a team talks; shipping the old
        // field back to the client would invite it to render a dead control.
        lastResolved: entry.lastResolved,
        lastResolvedAt: entry.lastResolvedAt,
        preview:
          preview.ok !== true
            ? {
                ok: false,
                error: preview.error ?? "解析失败。",
                hint: preview.hint ?? [],
                notices: preview.notices ?? [],
                members: [],
              }
            : {
                ok: true,
                single: preview.single === true,
                members: (preview.members ?? []).map((row) => ({ id: row.id, name: row.name })),
                removed: preview.removed ?? [],
                truncated: (preview.truncated ?? []).map((row) => row.name),
                notices: preview.notices ?? [],
                drift: preview.drift ?? { added: [], removed: [], comparable: false },
                capacity: preview.capacity ?? { max: null, policy: "refuse" },
              },
      });
    }
    return {
      ok: true,
      teams,
      /*
       * Which preset the new-session default names right now — the same value
       * `status()` reports, shipped here too so the team tab draws its switch
       * from the payload it already has. `refreshDefault()` above is what makes
       * this a read of the live registry rather than of our own last write.
       */
      defaultId: defaultCache().id,
      defaultSource: defaultCache().source,
      groups: teamRuntimeOf().groups(),
      batch: { maxTeamSize: store.maxTeamSize, groupCapPolicy: store.groupCapPolicy },
      // `thinkingModes` used to be advertised here so the panel could offer
      // "stage / ventriloquist". There is one way a team talks now, so the
      // option is gone rather than hidden — a client that still asks for it
      // must not silently render a control that does nothing.
      policies: CAP_POLICIES,
      problem: storeProblem(store),
      // The member picker needs the tag as well as the name: picking a group is
      // picking whoever carries that tag, and a row that hides it makes the
      // resulting "3 人" look arbitrary.
      rows: choosableRows().map((row) => {
        const full = listFiles().find((item) => item.id === row.id);
        return { id: row.id, name: row.name, group: oneLine(full?.group) };
      }),
    };
  }

  /**
   * Write the directory. Never the binding.
   *
   * There is deliberately no `bind` action here (see `teamState`): the panel
   * cannot name a session, so a bind op would be reachable only by a caller
   * that already has one — and that caller is the `/waifu-team` command, which
   * goes through `teamRuntimeOf().bind()` directly. An HTTP action nothing can
   * legitimately call is a surface that will eventually be called wrongly.
   *
   * Every write is rolled back in memory when the file write fails, so the
   * panel can never end up showing a team the file does not have.
   */
  async function teamSet(request) {
    if (teamRuntimeOf() === null) {
      return { ok: false, error: "团队运行时还没装上，这个会话看不到团队。" };
    }
    const action = oneLine(request.action);

    if (action === "save") {
      const name = oneLine(request.name).slice(0, NAME_LIMIT);
      if (name === "") return { ok: false, error: "团队得有一个名字。" };
      /*
       * `original` is the name the editor was opened with (see `saveTarget`).
       * Without it a rename is indistinguishable from a create, and the panel's
       * "edit this team" ended up adding a second team under the new name while
       * leaving the old one in place.
       */
      const original = oneLine(request.original).slice(0, NAME_LIMIT);
      const store = teamRuntimeOf().store();
      const target = saveTarget(store.teams, name, original);
      if (target.error !== null) return { ok: false, error: target.error };
      const at = target.at;
      if (at < 0 && store.teams.length >= TEAM_LIMIT) {
        return { ok: false, error: `最多存 ${TEAM_LIMIT} 个团队，先删掉几个。` };
      }
      const before = at < 0 ? null : store.teams[at];
      /*
       * Merge over the stored entry instead of replacing it. The panel's editor
       * only sends `selection` and `background`, so a plain replace would drop
       * `roles` / `writeScope` / `lastResolved` on every rename — a rename must
       * not cost the team its role sentences.
       */
      const entry = adoptTeam(name, before === null ? (request.team ?? {}) : { ...before, ...(request.team ?? {}) });
      /*
       * A team is two voices or it is not a team.
       *
       * This used to accept one entry and let the runtime fall back to single
       * mode, which read as "the team is running" while one persona answered
       * alone. The rule is now enforced where the user can still fix it: the
       * selection is expanded against the LIVE directory, so a group that
       * happens to hold one member is caught here too, not just an obviously
       * short list.
       */
      const expanded = expandSelection({
        selection: entry.selection,
        roster: listFiles(),
        strict: false,
      });
      if (expanded.unknownGroups.length > 0) {
        return {
          ok: false,
          error: `组「${expanded.unknownGroups.join("、")}」找不到任何成员，检查一下名字或先给成员打上这个组标签。`,
        };
      }
      if (expanded.members.length < 2) {
        const dropped = expanded.removed.map((row) => row.name).join("、");
        return {
          ok: false,
          error:
            `团队至少要两个人，现在只解析到 ${expanded.members.length} 个。` +
            (dropped === "" ? "" : `（${dropped} 选不进来：不在目录里或组装不出来。）`),
        };
      }
      if (at < 0) store.teams.push(entry);
      else store.teams[at] = entry;
      if (teamRuntimeOf().save() !== true) {
        if (at < 0) store.teams.pop();
        else store.teams[at] = before;
        return { ok: false, error: `写 ${TEAM_FILE} 失败，改动没有生效。` };
      }
      /*
       * Sessions bound to the old name have to follow it, or a rename silently
       * takes every live session off the team — they would keep resolving a
       * name that no longer exists and report "团队不在文件里了" instead.
       */
      if (target.renamed === true) teamRuntimeOf().rename(original, name);
      /*
       * The preset ids are read from the live map on both sides of the sync:
       * the old one only exists until it is rewritten below, the new one only
       * after. A team preset id is derived from the team name, so a rename
       * changes it — and a default that named the old id is left pointing at
       * nothing, which refuses EVERY new session with
       * `agent-preset/not-found` rather than degrading to a stale label.
       */
      const oldPreset = target.renamed === true ? teamPresetIdByName(original) : "";
      await syncTeamPresets();
      const newPreset = target.renamed === true ? teamPresetIdByName(name) : "";
      /*
       * `defaultCache()` is read fresh here: the registry is the authority, and a
       * 2-second-old cache is exactly the window a rename lands in. The decision
       * itself is `team.js`'s (`defaultRenameFollow`), so it can be tested
       * without a host — the id comparison is the part that is easy to get
       * wrong, and a boolean computed inline was not coverable at all.
       */
      const held = (await refreshDefault({ force: true })).id;
      const follow = defaultRenameFollow({ defaultId: held, from: oldPreset, to: newPreset });
      const defaultFollowed = follow === null ? "unchanged" : await repointDefault(follow.from, follow.to);
      /*
       * A repoint that did not land leaves the field naming an id nothing
       * registers, and the consequence is out of proportion to its cause: every
       * new session is refused. The panel has no room to say this (the toast is
       * 「已保存」), so the log does — same rule as the `configEditor` degrade in
       * `writeDefault`.
       */
      if (defaultFollowed === "failed")
        ctx.logger?.warn?.(
          `dsh-waifu-agents: 团队「${name}」改名后默认没跟上（${oldPreset} → ${newPreset}），` +
            "新会话可能起不来（agent-preset/not-found）。去「设置 → Agent Presets」重选一次默认。",
        );
      return { ok: true, action, created: before === null, renamed: target.renamed, defaultFollowed, state: await teamState() };
    }

    if (action === "remove") {
      const name = oneLine(request.name);
      const store = teamRuntimeOf().store();
      const at = store.teams.findIndex((item) => item.name === name);
      if (at < 0) return { ok: false, error: `没有叫「${name}」的团队。` };
      const gone = store.teams.splice(at, 1)[0];
      if (teamRuntimeOf().save() !== true) {
        store.teams.splice(at, 0, gone);
        return { ok: false, error: `写 ${TEAM_FILE} 失败，没删掉。` };
      }
      /*
       * Deleting a team has to unbind the sessions that were on it, or the
       * deletion is only half done: a binding left behind resolves to an error
       * on every assembly, so the session sits in team mode forever with
       * nothing to run. The only other way out is switching persona, and the
       * user has no reason to know they need it.
       */
      /*
       * Two things have to be dropped, not one. `forget` clears the bindings;
       * unregistering the preset is what stops sessions that were BORN on this
       * team from being a team session any more — their own preset id still
       * names it, and without this they would keep resolving against a team
       * that no longer exists.
       */
      const unbound = teamRuntimeOf().forget(name);
      const gonePreset = teamPresetIdByName(name);
      await syncTeamPresets();
      /*
       * …and the third thing: the global default, when it names this team's
       * preset. Deleting a team whose preset IS the default would leave the
       * field naming an id nothing registers — every new session refused, with
       * no row left to click to get out. `moveDefaultOff` skips (with a reason)
       * when the default was somebody else, and it re-seats the blank sessions
       * that were still following this id.
       */
      const held = (await refreshDefault({ force: true })).id;
      const defaultCleared = defaultNamesTeam({ defaultId: held, presetId: gonePreset })
        ? await moveDefaultOff(gonePreset)
        : null;
      // Same rule as the rename above: a clear that did not land leaves a
      // default naming an id nothing registers, and nothing on screen can say so.
      if (defaultCleared !== null && defaultCleared.ok !== true && defaultCleared.skipped !== true)
        ctx.logger?.warn?.(
          `dsh-waifu-agents: 删掉团队「${name}」时全局默认没清掉（${defaultCleared.reason ?? ""}），` +
            "新会话可能起不来（agent-preset/not-found）。去「设置 → Agent Presets」重选一次默认。",
        );
      return { ok: true, action, unbound, defaultCleared: defaultCleared === null ? null : defaultCleared.ok, state: await teamState() };
    }

    if (action === "batch") {
      const store = teamRuntimeOf().store();
      const before = { maxTeamSize: store.maxTeamSize, groupCapPolicy: store.groupCapPolicy };
      /*
       * `batch` is a partial update, so an omitted field means "leave it", not
       * "clear it" — the panel sends only what the user touched. Clearing the
       * cap has its own spelling: an explicit `null` (or an empty string, which
       * is what an emptied number input posts).
       */
      if (request.maxTeamSize === null || request.maxTeamSize === "") {
        store.maxTeamSize = null;
      } else if (request.maxTeamSize !== undefined) {
        const cap = Number(request.maxTeamSize);
        if (!Number.isSafeInteger(cap) || cap < 2) {
          return {
            ok: false,
            error: "上限要么留空（不设限），要么是不小于 2 的整数。一个人的队不该走团队模式。",
          };
        }
        store.maxTeamSize = cap;
      }
      if (request.groupCapPolicy !== undefined) {
        const policy = oneLine(request.groupCapPolicy);
        if (!CAP_POLICIES.includes(policy)) {
          store.maxTeamSize = before.maxTeamSize;
          return { ok: false, error: `上限策略只能是 ${CAP_POLICIES.join(" / ")}。` };
        }
        store.groupCapPolicy = policy;
      }
      if (teamRuntimeOf().save() !== true) {
        store.maxTeamSize = before.maxTeamSize;
        store.groupCapPolicy = before.groupCapPolicy;
        return { ok: false, error: `写 ${TEAM_FILE} 失败，改动没有生效。` };
      }
      return { ok: true, action, state: await teamState() };
    }

    if (action === "reload") {
      teamRuntimeOf().reload();
      await syncTeamPresets();
      return { ok: true, action, state: await teamState() };
    }

    return { ok: false, error: `不认识的团队操作：${action || "（空）"}。` };
  }

  /**
   * Wipe every session's team memory (the panel's 「清空团队记忆」).
   *
   * Deliberately all-of-it, not per-session: the panel does not know session
   * ids, and memory without its session is unreadable clutter anyway. The
   * personas, teams.json and the ledger are untouched — this clears plot
   * recall, nothing else.
   */
  async function teamMemoryClear() {
    if (teamRuntimeOf() === null || typeof teamRuntimeOf().clearMemory !== "function") {
      return { ok: false, error: "团队运行时未就绪。" };
    }
    const removed = await teamRuntimeOf().clearMemory();
    return { ok: true, removed };
  }



  const teamRuntimeOf = deps.teamRuntime;
  const defaultCache = deps.cachedDefault;
  const choosableRows = deps.choosableRows;

  return {
          teamMemoryClear,
      teamSet,
      teamState
  };
}
