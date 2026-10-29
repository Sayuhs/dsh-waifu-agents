/**
 * 人设长记忆：身份快照 + 团队记忆视图 + 面板的 memory / team op 实现。
 *
 * 从 `index.js` 的两段搬来（2026-10-28 P3 拆分）：
 *   - "persona long-term memory"（写路径的存储半：身份快照、记忆归档、团队记忆视图）
 *   - "persona long-term memory ops"（面板 op：memoryState…memoryClear、teamPick、purge）
 *
 * 边界与原来完全一致，只有三处机械改写：
 *   - `teamRuntime` -> `teamRuntimeOf()`、`cachedDefault` -> `defaultCache()`：
 *     这两个是 apply() 里的 `let`，按值快照会拿到安装那一刻的旧值，所以走 thunk；
 *   - `overrides = {};` -> `resetOverrides()`：purge 清覆盖表要走回 index.js 的绑定。
 *
 * `run` 分发器没有搬：它是整个 op 表的汇合点，留在 index.js 才能直接引用
 * panel-ops 解构出来的名字（那些绑定在 memory-ops 安装之后才初始化）。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @param {object} ctx 插件自身的上下文
 * @param {object} deps 模块常量、闭包句柄与活绑定 thunk 的全集
 * @returns {object} 分发器与写入路径按名字调用的全部实现
 */
export function installMemoryOps(ctx, deps) {
  const {
    DEFAULT_MAX_ENTRIES,
    ENTRY_MAX_CHARS,
    MAX_MAX_ENTRIES,
    MIN_MAX_ENTRIES,
    PACKAGE_NAME,
    clampEntryText,
    clampMaxEntries,
    clearStore,
    dir,
    effectiveEnabled,
    homeFromEnv,
    listStoredIds,
    matchPersona,
    oneLine,
    personaConfigOf,
    readConfig,
    readStore,
    recallEntries,
    recentEntries,
    renderMemoryBlock,
    trimToLimit,
    updateConfig,
    writeStore,
    anchorOf,
    expectsPersona,
    fileCache,
    fileFor,
    findRegistryEntry,
    legacyOverrideFile,
    liveAgentFor,
    listFiles,
    overrideFile,
    overrideOf,
    owned,
    personaMemoryDir,
    rememberSessionPreset,
    rename,
    resettleUnstarted,
    restoreSessionPreset,
    restingOf,
    roster,
    servedIds,
    sessionPersona,
    setDefault,
    setOverride,
    safeText,
    scan,
    shownPresetOf,
    teamMemoryClear,
    teamSet,
    teamState,
    verifyDefault,
    waifuState,
    refreshDefault,
    writeAtomic,
    writeDefault,
    readOnly,
    writable,
  } = deps;

  /* --------------------------------------------- 人设长期记忆 op */

  /**
   * 面板绘制记忆区块需要的一切——只读。
   *
   * `rows` 同时覆盖花名册以及磁盘上仍有记忆文件的任何 id。
   * 迁移失败的改名会在旧 id 下留下文件，若没有这第二个来源，
   * 那一行就不可见：无法查看、无法删除，还占着目录的额度。
   */
  async function memoryState() {
    const config = await readConfig(personaMemoryDir);
    const ids = new Set(listFiles().map((row) => row.id));
    for (const id of await listStoredIds(personaMemoryDir)) ids.add(id);
    const rows = [];
    for (const id of [...ids].sort((a, b) => a.localeCompare(b, "zh"))) {
      const own = personaConfigOf(config, id);
      const store = await readStore(personaMemoryDir, id);
      const last = store.entries[store.entries.length - 1];
      rows.push({
        id,
        enabled: own.enabled,
        effective: effectiveEnabled(config, id),
        maxEntries: own.maxEntries,
        count: store.entries.length,
        broken: store.broken === true,
        updatedAt: last === undefined ? null : last.at,
      });
    }
    return {
      ok: true,
      dir: personaMemoryDir,
      globalEnabled: config.enabled !== false,
      captureToolTurns: config.captureToolTurns === true,
      rows,
      limits: {
        defaultMaxEntries: DEFAULT_MAX_ENTRIES,
        minMaxEntries: MIN_MAX_ENTRIES,
        maxMaxEntries: MAX_MAX_ENTRIES,
        entryMaxChars: ENTRY_MAX_CHARS,
      },
    };
  }

  /**
   * 翻转一个开关，或调整一个深度。
   *
   * `global` 与单个人设的字段是刻意分开的：整体关掉功能绝不能改写任何
   * 人设自己的选择，因此重新打开时会还原每个人设原来的设置。调低
   * `maxEntries` 会立即裁剪文件——面板承诺上限立即生效，而幸存下来的
   * 记忆恰好就是下一轮还能召回的那些。
   */
  async function memorySet(request) {
    if (!writable) return readOnly();
    const patch = {};
    if (typeof request.enabled === "boolean") patch.enabled = request.enabled;
    /*
     * 「工作模式也记」是全局的一格，和人设自己的开关无关：它决定的是
     * **什么时候采**，不是**谁**的记忆。默认关——干活时的回复里能选中的
     * 往往是一段代码，不是她说的话。
     */
    if (typeof request.captureToolTurns === "boolean")
      patch.captureToolTurns = request.captureToolTurns;
    const persona = oneLine(request.persona);
    if (persona === "") {
      if (request.maxEntries !== undefined)
        return { ok: false, error: "改存储上限必须指定角色。" };
    } else {
      patch.persona = persona;
      if (typeof request.personaEnabled === "boolean")
        patch.personaEnabled = request.personaEnabled;
      if (request.maxEntries !== undefined) {
        const wanted = Number(request.maxEntries);
        if (!Number.isFinite(wanted))
          return { ok: false, error: "存储上限必须是数字。" };
        patch.maxEntries = wanted;
      }
    }
    const config = await updateConfig(personaMemoryDir, patch);
    let trimmed = null;
    if (persona !== "" && patch.maxEntries !== undefined) {
      const store = await readStore(personaMemoryDir, persona);
      const result = trimToLimit(store, clampMaxEntries(patch.maxEntries));
      if (result.dropped > 0) await writeStore(personaMemoryDir, result.store);
      trimmed = { dropped: result.dropped, overflow: result.overflow };
    }
    await refreshMemorySnapshot();
    return {
      ok: true,
      globalEnabled: config.enabled !== false,
      captureToolTurns: config.captureToolTurns === true,
      persona:
        persona === ""
          ? null
          : { id: persona, ...personaConfigOf(config, persona) },
      trimmed,
    };
  }

  /** 一个人设已存储的记忆，最新在后——面板的列表视图。 */
  async function memoryEntries(request) {
    const id = oneLine(request.id);
    if (id === "") return { ok: false, error: "缺少角色 id。" };
    const store = await readStore(personaMemoryDir, id);
    return {
      ok: true,
      id,
      broken: store.broken === true,
      entries: store.entries,
    };
  }

  /**
   * 编辑一条记忆：内容、类型或置顶。
   *
   * `episode` 变成 `stable` 靠的就是人工编辑。这一步没有任何自动判断
   * 能替代——「这是关于她的长久事实，还是某个故事里的一段插曲」需要
   * 人来定夺，而猜错的记忆会被注入之后每个故事的每一轮。
   */
  async function memoryEdit(request) {
    if (!writable) return readOnly();
    const id = oneLine(request.id);
    const entryId = oneLine(request.entryId);
    if (id === "" || entryId === "")
      return { ok: false, error: "缺少角色 id 或记忆 id。" };
    const store = await readStore(personaMemoryDir, id);
    if (store.broken === true)
      return { ok: false, error: "这个角色的记忆文件已损坏，请先清空再编辑。" };
    const index = store.entries.findIndex((one) => one.id === entryId);
    if (index < 0) return { ok: false, error: "找不到这条记忆。" };
    const next = { ...store.entries[index] };
    if (request.text !== undefined) {
      const text = clampEntryText(request.text);
      if (text === "") return { ok: false, error: "记忆内容不能为空。" };
      next.text = text;
    }
    if (request.kind !== undefined)
      next.kind = request.kind === "stable" ? "stable" : "episode";
    if (typeof request.pinned === "boolean") next.pinned = request.pinned;
    if (
      store.entries.some((one) => one.id !== entryId && one.text === next.text)
    )
      return { ok: false, error: "另一条记忆已经是这个内容。" };
    store.entries[index] = next;
    await writeStore(personaMemoryDir, store);
    await refreshMemorySnapshot();
    return { ok: true, entry: next };
  }

  /** 删除一条记忆。必须显式按 id 指定：没有「删最旧的」这种捷径。 */
  async function memoryRemove(request) {
    if (!writable) return readOnly();
    const id = oneLine(request.id);
    const entryId = oneLine(request.entryId);
    if (id === "" || entryId === "")
      return { ok: false, error: "缺少角色 id 或记忆 id。" };
    const store = await readStore(personaMemoryDir, id);
    if (store.broken === true)
      return { ok: false, error: "这个角色的记忆文件已损坏，请先清空。" };
    const before = store.entries.length;
    store.entries = store.entries.filter((one) => one.id !== entryId);
    if (store.entries.length === before)
      return { ok: false, error: "找不到这条记忆。" };
    await writeStore(personaMemoryDir, store);
    await refreshMemorySnapshot();
    return { ok: true, removed: before - store.entries.length };
  }

  /**
   * 清空一个人设的记忆。开关与深度保持不变：「清空」只针对内容，
   * 执行清空的用户并没有要求改动设置。
   */
  async function memoryClear(request) {
    if (!writable) return readOnly();
    const id = oneLine(request.id);
    if (id === "") return { ok: false, error: "缺少角色 id。" };
    const cleared = await clearStore(personaMemoryDir, id);
    await refreshMemorySnapshot();
    return { ok: true, id, cleared };
  }

  /**
   * `/waifu-team` 的选择器为单个会话提供的选项。
   *
   * 只读，而且是刻意的：它复用 `/waifu-change` 选择器的同一条缝
   * （`waifuState`），同一条规则也照搬——弹窗只展示能选什么，然后真正
   * 去执行宿主命令，于是切换会落进会话日志，而不是打开一个列表时的
   * 无声副作用。
   *
   * 「单人模式」一行已移除。它过去以「模式」选项的形式挂在团队列表
   * 下面，让团队选择器看起来提供了一个并不是团队的团队；更糟的是，
   * 经由这一行退出团队模式的会话之后可能一个人设都服务不了。团队
   * 选择器只列团队；离开团队靠 `/waifu-change`（切到单个人设）或
   * `/waifu-reset`（回到会话自己的人设）。
   */
  async function teamPick(request) {
    if (teamRuntimeOf() === null) {
      return { ok: false, error: "团队运行时还没装上，这个会话看不到团队。" };
    }
    const state = await teamState();
    if (state.ok !== true) return state;
    const sessionId = oneLine(request.sessionId);
    const now = sessionId === "" ? null : teamRuntimeOf().stateOf(sessionId).team ?? null;
    // `now` 是文件里记录的会话绑定，并不等于团队模式真的在跑：解析后
    // 只剩一名成员的团队会回落到单人模式。把它标成当前项，等于给一个
    // 并没有真正运行的团队画上对勾，所以标记跟随模式，而非绑定。
    const live = sessionId === "" ? null : teamRuntimeOf().stateOf(sessionId).mode === "team" ? now : null;
    const rows = state.teams.map((entry) => {
      const members = entry.preview?.ok === true ? (entry.preview.members ?? []) : [];
      const detail =
        entry.preview?.ok !== true
          ? "这一队现在解析不出成员。"
          : members.length === 0
            ? "这一队现在是空的。"
            : `${members.length} 人：${members.map((row) => row.name).join("、")}`;
      return {
        id: entry.name,
        label: entry.name,
        detail,
        ...(live === entry.name ? { active: true } : null),
        group: { name: "teams", label: "团队" },
      };
    });
    return {
      ok: true,
      rows,
      active: live,
      bound: now,
      problem: state.problem,
    };
  }

  /** 选择器可以给出的花名册：恰好就是此刻能挂载的全部。 */
  function choosableRows() {
    const orderOf = (item) =>
      typeof item.order === "number" ? item.order : Number.MAX_SAFE_INTEGER;
    return listFiles()
      .filter((item) => item.problems.length === 0 && item.idOk === true)
      .sort(
        (a, b) =>
          orderOf(a) - orderOf(b) ||
          String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)),
      )
      .map((item) => ({ id: item.id, name: item.name }));
  }

  /** 把一个会话指向一个人设。写入本身就是全部操作。 */
  async function waifuApply(request) {
    const sessionId = oneLine(request.sessionId);
    if (sessionId === "")
      return {
        ok: false,
        error: "这个操作要知道是哪个会话，但没拿到 session id。",
      };
    const rows = choosableRows();
    if (rows.length === 0)
      return { ok: false, error: "这个人设目录里没有可用的人设。" };
    const matched = matchPersona(
      oneLine(request.personaId) || oneLine(request.query),
      rows,
    );
    if (matched.ok !== true)
      return {
        ok: false,
        error: matched.error,
        candidates: matched.candidates ?? [],
      };
    const found = safeText(matched.id);
    if (found === null) {
      return {
        ok: false,
        error: `「${matched.id}」现在组装不出来（少了 [[body]]、或正文里混进了非法的 {{…}}），没有替换。`,
      };
    }
    // 两次读取都发生在写下覆盖之前：此刻 chip 上的名字还是会话自己的
    // 预设，而这也是它最后一次如此。
    const live = liveAgentFor(sessionId);
    setOverride(sessionId, matched.id, anchorOf(live));
    /*
     * 换人即退出团队：团队是「这一场由一队人演」，换成一个人之后这个前提
     * 就不成立了。少了这一步，面板换人之后团队仍绑在那个会话上，下一轮
     * 回答你的还是那一队；而这一轮会写进团队剧情记忆，再下一轮单人回答
     * 引用它，看起来就像「换了人还带着前一个人的记忆」。
     */
    teamRuntimeOf?.()?.unbind?.(sessionId);
    // 与命令路径同一手法：人设即覆盖，chip 即本次事件；少了这一步，
    // 标签会一直停留在会话出生时的人设上（见 `rememberSessionPreset`）。
    rememberSessionPreset(live, matched.id);
    return { ok: true, id: matched.id, name: found.name };
  }

  async function waifuClear(request) {
    const sessionId = oneLine(request.sessionId);
    if (sessionId === "")
      return {
        ok: false,
        error: "这个操作要知道是哪个会话，但没拿到 session id。",
      };
    const had = overrideOf(sessionId);
    // 在清空前读取：清空这个动作本身会丢掉存放它的记录。
    const resting = restingOf(sessionId);
    /* 与 `/waifu-reset` 同构：团队绑定也是一种覆盖，不清就等于没清。 */
    const team = teamRuntimeOf?.()?.unbind?.(sessionId) ?? {};
    /*
     * 没有东西可清时不要动标签。
     *
     * `restoreSessionPreset` 在 `resting` 为空时会回落到会话头，而会话头是
     * 出生时盖上的**全局默认**。对一个插件没碰过的会话（用户在宿主自己的
     * 选择器里换的人、或者只是打开面板点了清除），这一下会把用户手上那位
     * 换成默认那位——看起来像「她自己变了」。
     */
    if (had === null && team.bound === undefined && team.off !== true)
      return { ok: true, had: null, defaultId: defaultCache().id };
    setOverride(sessionId, null);
    /*
     * `team.chip` 是「进队之前那位单人」（`team-runtime.js` 的 `prevChip`），
     * 空值表示当时标签就指着团队预设（出生即在团队）——那时没有可恢复的人，
     * `restoreSessionPreset` 会回落到会话头，若头也是团队，标签就还指着团队。
     */
    restoreSessionPreset(
      liveAgentFor(sessionId),
      resting !== "" ? resting : oneLine(team.chip),
    );
    /*
     * 清完之后还有一支队在跑，说明标签仍停在团队预设上，而 `teamNameFor` 在
     * 没有绑定时会回落到「出生时带的团队预设」——不补这一下，团队就从标签上
     * 自己活过来，而面板刚显示过「已清除」。
     */
    if (teamRuntimeOf?.()?.stateOf?.(sessionId)?.team != null) {
      teamRuntimeOf?.()?.holdOff?.(sessionId);
    }
    await refreshDefault();
    return { ok: true, had, defaultId: defaultCache().id };
  }

  /**
   * 只改写一个文件的 `order` 行，其他一概不动。
   *
   * 走一遍完整的 `renderPersona` 还会裁剪正文，并丢掉面板不认识的
   * 字段；排序不是编辑，所以这里只挪动那一行，其余字节原样保留。
   * @param {string} full 绝对路径
   * @param {number} value 要写入的 order 值
   * @returns {boolean} 文件是否发生了变化
   */
  function setOrderLine(full, value) {
    let raw;
    try {
      raw = fs.readFileSync(full, "utf8");
    } catch {
      return false;
    }
    const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(withoutBom);
    if (match === null) return false;
    const meta = match[1]
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => line.trim() !== "" && !/^order\s*:/.test(line));
    if (meta.some((line) => /^order\s*:/.test(line))) return false;
    const current = /(^|\n)order\s*:\s*([^\n]*)/.exec(match[1]);
    if (current !== null && Number(current[2].trim()) === value) return false;
    const nextMeta = [...meta, `order: ${value}`].join("\n");
    const head = withoutBom.slice(0, match.index);
    const tail = withoutBom.slice(match.index + match[0].length);
    writeAtomic(full, `${head}---\n${nextMeta}\n---${tail}`);
    return true;
  }

  /**
   * 保存一次拖拽结果：给出的 id 按该顺序拿到 `order: 1..n`。
   *
   * 调用方没有提到的行保持原值，因此过滤或分页视图仍能对它展示过的
   * id 产生一个全序。
   */
  async function waifuOrder(request) {
    if (!writable) return readOnly();
    const ids = (Array.isArray(request.ids) ? request.ids : [])
      .map((id) => oneLine(id))
      .filter((id) => id !== "");
    if (ids.length === 0) return { ok: false, error: "没有给出顺序。" };
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id))
        return { ok: false, error: `这个 id 出现了两次：${id}` };
      seen.add(id);
    }
    const known = new Set(listFiles().map((item) => item.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0)
      return { ok: false, error: `这些人设不在目录里：${unknown.join(" / ")}` };
    const changed = [];
    let index = 0;
    for (const id of ids) {
      index += 1;
      if (setOrderLine(fileFor(id), index)) changed.push(id);
    }
    const reloaded = await scan();
    return { ok: true, order: ids, changed, reloaded: reloaded.reloaded ?? [] };
  }

  /**
   * 从 `minimumReleaseAgeExclude` 中移除本包的条目。
   *
   * 这份列表存放在 profile 的 `pnpm-workspace.yaml`——一个 pnpm 拥有的
   * 文件——但每一项提到 `dsh-waifu-agents` 的条目都是因本插件而存在的：
   * pnpm 写下它是为了让我们的安装通过 24h 新鲜度策略。删掉自己写的行
   * 并不比注销自己的预设更算「插手别人的文件」；提到其他包的条目，
   * 以及文件的其余每个字节，都原样通过。
   *
   * profile 名只有 `DSH_PROFILE_DIR` 传到本进程时才可见；没有它时扫描
   * 每个 profile，而这样做是安全的，恰恰因为过滤器只匹配我们的名字。
   * 从未装过本插件的 profile 没有匹配行，会原样保留——只有确实删掉了
   * 行的时候才发生写入。
   * @returns {{ cleaned: string[], failed: string[] }}
   */
  function cleanReleaseAgeExcludes() {
    const cleaned = [];
    const failed = [];
    const profileDir = process.env.DSH_PROFILE_DIR
      ? path.resolve(process.env.DSH_PROFILE_DIR)
      : null;
    let candidates;
    if (profileDir !== null) {
      candidates = [path.join(profileDir, "pnpm-workspace.yaml")];
    } else {
      const profiles = path.join(homeFromEnv(process.env).home, "profiles");
      try {
        candidates = fs
          .readdirSync(profiles, { withFileTypes: true })
          .filter((row) => row.isDirectory())
          .map((row) => path.join(profiles, row.name, "pnpm-workspace.yaml"));
      } catch {
        candidates = [];
      }
    }
    for (const full of candidates) {
      let raw;
      try {
        raw = fs.readFileSync(full, "utf8");
      } catch {
        continue; // 没有这个文件——该 profile 没有 pnpm 状态，无事可做
      }
      const lines = raw.split("\n");
      const keep = [];
      let changed = false;
      for (let at = 0; at < lines.length; ) {
        const line = lines[at];
        if (!/^minimumReleaseAgeExclude\s*:/.test(line)) {
          keep.push(line);
          at += 1;
          continue;
        }
        // 流式写法 `key: [a, b]`：过滤中括号内的条目，若其中没有本包的
        // 内容则保留键（此时整行原样复现）。
        const flow = /^minimumReleaseAgeExclude\s*:\s*\[(.*)\]\s*\r?$/.exec(line);
        if (flow !== null) {
          const items = flow[1]
            .split(",")
            .filter((item) => item.trim() !== "");
          const rest = items.filter((item) => !item.includes(PACKAGE_NAME));
          if (rest.length === items.length) {
            keep.push(line);
          } else {
            changed = true;
            if (rest.length > 0)
              keep.push(`minimumReleaseAgeExclude: [${rest.join(", ")}]`);
          }
          at += 1;
          continue;
        }
        // 块状写法：收集紧随其后的列表项。
        const items = [];
        let cursor = at + 1;
        while (cursor < lines.length && /^\s+-\s/.test(lines[cursor])) {
          items.push(lines[cursor]);
          cursor += 1;
        }
        const rest = items.filter((item) => !item.includes(PACKAGE_NAME));
        if (rest.length === items.length) {
          keep.push(line, ...items);
        } else {
          changed = true;
          if (rest.length > 0) keep.push(line, ...rest);
          // 一条不剩：键也一并去掉——空列表只是噪音
        }
        at = cursor;
      }
      if (!changed) continue;
      try {
        writeAtomic(full, keep.join("\n"));
        cleaned.push(full);
      } catch (error) {
        failed.push(`${full}：${error?.message ?? error}`);
      }
    }
    return { cleaned, failed };
  }

  /**
   * 撤销本插件在自身包之外留下的一切。
   *
   * 属于我们且会活过卸载的只有三样：按会话的覆盖记录存储、本面板写进
   * agent-preset 注册表配置的 `selectedDefault` 行，以及——仅在明确
   * 要求时——人设目录本身。新鲜度放行清单里提到本包的行也是我们的
   * （pnpm 为我们的安装而写），会被剥除。安装留下的其余一切属于
   * 平台（plugin-manager 的操作日志、pnpm 的内容库索引），所以这个
   * op 只点名它们，而不是假装清理。
   * @param {{ dir?: boolean }} request
   */
  async function purge(request) {
    const withDir = request?.dir === true;
    const done = [];
    const failed = [];
    for (const file of new Set([overrideFile, legacyOverrideFile])) {
      try {
        if (!fs.existsSync(file)) continue;
        fs.rmSync(file, { force: true });
        done.push(`删除覆盖记录 ${file}`);
      } catch (error) {
        failed.push(`覆盖记录：${error?.message ?? error}`);
      }
    }
    resetOverrides();
    try {
      const excludes = cleanReleaseAgeExcludes();
      for (const full of excludes.cleaned)
        done.push(`清掉放行记录 ${full} 里属于本包的条目`);
      for (const message of excludes.failed) failed.push(`放行记录：${message}`);
    } catch (error) {
      failed.push(`放行记录：${error?.message ?? error}`);
    }
    try {
      const configEditor = ctx.get("configEditor");
      const entry =
        configEditor === undefined || configEditor === null
          ? undefined
          : findRegistryEntry(configEditor);
      if (entry === undefined)
        failed.push("找不到 agent-preset-registry 这条配置项，全局默认没清。");
      else {
        let cleared = "";
        await refreshDefault({ force: true });
        const picked = oneLine(defaultCache().id);
        if (
          picked !== "" &&
          (owned.has(picked) || fs.existsSync(fileFor(picked)))
        ) {
          // 与 `setDefault` 同一条路径，理由相同：只有设置服务会发出
          // 让应用重读花名册的事件。
          const written = await writeDefault({
            configEditor,
            entry,
            id: null,
          });
          if (written.ok) cleared = picked;
          else failed.push(`全局默认没清：${written.error}`);
        }
        done.push(
          cleared === ""
            ? "全局默认本来就没指向本插件的人设"
            : `清掉全局默认 ${cleared}`,
        );
        if (cleared !== "") {
          // 与 `setDefault` 同一条规则：活注册表不再指向它，字段才算
          // 真正清掉。`purge` 是唯一一个全部承诺就是「我留下的东西都没了」
          // 的 op，所以在平台确认之前，绝不能提前报告某个步骤已完成。
          const settled = await verifyDefault(null, {
            previous: cleared,
            checkable: true,
          });
          if (!settled.verified && settled.checkable)
            failed.push(
              `全局默认：写进去了，但读回来还是「${settled.id ?? "（没指定）"}」，没清干净。`,
            );
          // 与 `setDefault` 相同的第二步，在这里更要紧：若一个还没开口
          // 的会话仍指向本该被这个 op 抹掉的老婆，就与 `purge` 的唯一
          // 承诺自相矛盾。
          const resettled = await resettleUnstarted({
            to: oneLine(defaultCache().id),
            from: cleared,
          });
          if (resettled.moved.length > 0)
            done.push(
              `把 ${resettled.moved.length} 个还没开口的会话撤出本插件的人设`,
            );
        }
      }
    } catch (error) {
      failed.push(`全局默认：${error?.message ?? error}`);
    }
    if (withDir) {
      if (!writable) failed.push("人设目录在插件包内，没有删。");
      else if (!fs.existsSync(dir)) done.push("人设目录本来就不在");
      else {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          fileCache.clear();
          done.push(`删除人设目录 ${dir}`);
        } catch (error) {
          failed.push(`人设目录：${error?.message ?? error}`);
        }
      }
    }
    await refreshDefault();
    return {
      ok: failed.length === 0,
      dir,
      done,
      failed,
      // 点名，而非清理：这些属于平台，插件无权删除别人拥有的文件。
      platform: [
        ".plugin-manager\\logs\\operation-*（安装日志，平台自己累积）",
        "pnpm 内容库索引：需要 pnpm store prune",
      ],
    };
  }

  /* --------------------------------------------- 人设长期记忆 */

  /**
   * 属于角色本人、而不属于会话的记忆。
   *
   * 三条边界塑造了下文的一切，每一条都是决策而非实现细节：
   *
   *   1. **它走 context 通道，绝不进人设正文。** 把记忆拼进
   *      `waifu_persona` 会让 system prompt 每轮都变，正是本文件已记录
   *      过的前缀缓存损失（`cacheReadTokens: 0`）。`systemPrompt.context()`
   *      被投影为排在 system prompt 之后的 USER 角色快照，前缀因此保持
   *      不动。
   *   2. **prompt 路径是同步的。** `context().text` 在组装单个请求期间
   *      解析。在那里读文件系统，好不过是每次组装多一个 await，坏则是
   *      悄悄丢掉一次贡献，所以这些存储活在一份快照里，在能改变它们的
   *      事件上刷新：我们自己的写入，以及 `op=refresh`。
   *   3. **没有可说的时候什么都不加。** 没有空标题、没有占位符：开关
   *      关闭或存储为空时，产出的 prompt 必须与没有这个功能的逐字节
   *      一致。
   */
  const MEMORY_CONTEXT_NAME = "waifu-agents:persona-memory";
  /*
   * 850，排在 900 的身份快照之前。身份快照那行存在的意义就是成为本轮
   * 「谁在说话」的最后一句话；排在它后面的记忆块会把收束句挤进上下文
   * 中间。
   */
  const MEMORY_CONTEXT_ORDER = 850;

  /** 形如 `{ config, stores: Map<id, store> }`，首次刷新前为 null。 */
  let memorySnap = null;

  /**
   * 重读本次安装可能服务的每一个存储。
   *
   * id 同时来自花名册与磁盘：若迁移没能执行，人设已被改名走的记忆文件
   * 仍然是她的，拒绝加载等于在第一次损失之上再添第二次无声损失。
   */
  async function refreshMemorySnapshot() {
    const snapshot = await readConfig(personaMemoryDir);
    const stores = new Map();
    const ids = new Set(listFiles().map((row) => row.id));
    for (const id of await listStoredIds(personaMemoryDir)) ids.add(id);
    for (const id of ids) {
      try {
        const store = await readStore(personaMemoryDir, id);
        if (store.entries.length > 0) stores.set(id, store);
      } catch {
        /* 一个读不出的文件不能搭上其他每个人设的记忆。 */
      }
    }
    memorySnap = { config: snapshot, stores };
    return memorySnap;
  }

  /**
   * 会话当前正以谁的声音被服务。
   *
   * 四级梯子，从最窄开始：
   *   1. 上一次组装实际服务的——唯一知道 `/waifu-change` 切换的来源，
   *      因为它记录的是 `sessionPersona` 的答案，而不是重新推导；
   *   2. 本会话的 `/waifu-change` 覆盖，它压过挂载预设的理由与在
   *      `sessionPersona` 内部一致（`orderPersonaIds`：override、mounted、
   *      default）；
   *   3. 活的 `agentPreset` **投影**——不是 `header.agentPreset`。header
   *      只保存会话出生时的预设，永不移动（`anchorOf` 记录了这一点；
   *      注册表的投影是 `init: header → apply on agent-preset/selected`）。
   *      在这里读 header，正是「被重新指向的会话把新声音的记忆写到了
   *      它过去那个人设头上」的成因——而事件监听器拿到的是 `session`
   *      而非 `agent`，这一级梯子正因此才存在：没有它，一个组装从未被
   *      我们观测到的会话就没了归属，它完成的回合会被丢弃；
   *   4. profile 默认，给没有锚点的会话。
   * @param {string} sessionId
   * @param {object} [session]
   */
  function currentPersonaIdOf(sessionId, session) {
    const served = servedIds.get(sessionId);
    const servedId = oneLine(served?.id);
    if (servedId !== "") return servedId;
    const overrideId = oneLine(overrideOf(sessionId));
    if (overrideId !== "") return overrideId;
    const projected = shownPresetOf(session);
    if (projected !== "") return projected;
    return oneLine(defaultCache().id);
  }

  /**
   * 用户最后输入的内容，作为召回查询。
   *
   * 宿主的 `Session` 没有 `history`：surface 通过 `surface.nodes`（序列号
   * 列表）与 `eventAt(seq)` 寻址，事件背后的消息由
   * `surface.deriveEventMessage()` 物化出来。本函数的旧版读的是
   * `session.history`——那是离线 fixture 恰好编出来的形状——在每一个
   * 真实回合都答 `""`。于是召回被悄悄变成「永远取最新三条」，不相关的
   * 记忆每轮都被注入，README 里 "没命中就一条都不注入" 的承诺在生产
   * 环境成了假话。
   *
   * 倒着走有两重意义：surface 里最新的 `user/message` 往往是我们自己的
   * runtime-context 快照（身份提醒与这块记忆也是 user 角色消息），这些
   * 由 `source.kind` 跳过，而答案正是上一轮的真实 prompt。
   *
   * 设计上就是尽力而为：读不出的查询不是错误——调用方退回按新旧排序。
   * 每个分支都有包裹，因为这段代码在组装期间运行，那里抛出异常会让
   * 整个请求失败。
   * @param {unknown} agent
   * @returns {string}
   */
  function lastUserText(agent) {
    const session = agent?.session;
    if (session === undefined || session === null) return "";
    try {
      const nodes = session.surface?.nodes;
      const list = Array.isArray(nodes) ? nodes : [];
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const event = session.eventAt?.(list[i]);
        if (event?.type !== "user/message") continue;
        /* 我们自己的快照也是 user 消息；它们不是 prompt。 */
        if (oneLine(event.data?.source?.kind) !== "user") continue;
        const message =
          session.surface?.deriveEventMessage?.(event) ?? event.data;
        const text = userTextOf(message);
        if (text !== "") return text;
      }
    } catch {
      /* 形状不匹配：退回旧形状，再不行退回按新旧排序 */
    }
    try {
      const history = session.history;
      if (Array.isArray(history)) {
        for (let i = history.length - 1; i >= 0; i -= 1) {
          const text = userTextOf(history[i]);
          if (text !== "") return text;
        }
      }
    } catch {
      /* 形状不匹配：退回按新旧排序 */
    }
    return "";
  }

  function userTextOf(entry) {
    const message = entry?.message ?? entry;
    const role = oneLine(message?.role);
    if (role !== "user") return "";
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const parts = [];
    for (const block of blocks) {
      if (block?.type !== "text") continue;
      const text = typeof block.text === "string" ? block.text : "";
      if (text !== "") parts.push(text);
    }
    return parts.join("\n").trim();
  }

  /**
   * 本次组装的单人记忆块，没有则为 ""。
   *
   * 团队会话被跳过：它们由 `personaMemoryForTeam` 服务，这里再注入会把
   * 每位成员的记忆放两遍——一遍作为单一声音，一遍按名字标记。
   * @param {unknown} agent
   * @returns {string}
   */
  function soloMemoryBlock(agent) {
    const snapshot = memorySnap;
    if (snapshot === null) return "";
    const sessionId = oneLine(agent?.session?.id);
    if (sessionId === "") return "";
    try {
      if (oneLine(teamRuntimeOf()?.stateOf?.(sessionId)?.mode) === "team") return "";
      const mountedId = anchorOf(agent);
      if (!expectsPersona(sessionId, mountedId)) return "";
      const found = sessionPersona(sessionId, mountedId);
      const id = oneLine(found?.id);
      if (id === "") return "";
      if (!effectiveEnabled(snapshot.config, id)) return "";
      const store = snapshot.stores.get(id);
      if (store === undefined || store.entries.length === 0) return "";
      const scope = { mode: "solo" };
      const query = lastUserText(agent);
      const picked =
        query === ""
          ? recentEntries(store.entries, { scope })
          : recallEntries(store.entries, query, { scope });
      if (picked.length === 0) return "";
      return renderMemoryBlock([{ name: found.name, entries: picked }], {
        heading: "【你记得的事】",
        tagNames: false,
        note:
          "（以上是你在以往相处中记下的事，只属于你自己。人设里写定的性格与设定优先于这些；" +
          "不确定某件事是否发生在当前场景里时，不要当作已经发生。）",
      });
    } catch (error) {
      // 组装期间绝不抛出。丢掉一轮记忆，比让本该承载它的请求失败便宜。
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 组装长期记忆失败：${error?.message ?? error}`,
      );
      return "";
    }
  }

  ctx.systemPrompt.context({
    name: MEMORY_CONTEXT_NAME,
    order: MEMORY_CONTEXT_ORDER,
    /*
     * 记忆是用户数据，绝不是模板。
     *
     * 少了这个开关，宿主会在组装请求的同时对文本跑 `interpolate()`，一个
     * 不认识的 `{{…}}` 分组会在那里抛出——在本插件拥有的每个 `try/catch`
     * 之外，于是本该承载记忆的那一轮就是失败的那一轮。对照宿主自己的
     * 函数实测过（`.workbuddy/review/probe-interpolate.mjs`）：`{{user}}`
     * ——这个世界里整个角色卡体系都在用的占位符——抛出
     * `unknown prompt variable`，`{{角色名}}` 抛出
     * `malformed prompt variable reference`。一行这样的文本，无论是面板
     * 里手打的，还是模型引用模板说出来的，都会毒害该人设之后的每一轮，
     * 直到被手工删除。
     */
    interpolate: false,
    text: (context) => soloMemoryBlock(context?.agent),
  });

  /**
   * 团队记忆块：每位有相关记忆的成员一个带名字标记的分区。
   *
   * 由团队运行时在拿到任务文本（真实查询，不是猜测）之后、构建请求
   * 之前调用。每位成员都按她自己的开关检查，且范围仅限本团队——甲队
   * 的 episode 不是乙队故事的证据。
   * @param {{members?: ReadonlyArray<object>, task?: string, team?: object}} input
   * @returns {Promise<string>}
   */
  async function personaMemoryForTeam(input) {
    const snapshot = memorySnap ?? (await refreshMemorySnapshot());
    const members = Array.isArray(input?.members) ? input.members : [];
    const task = typeof input?.task === "string" ? input.task : "";
    const team = oneLine(input?.team?.name);
    const scope = { mode: "team", team };
    const rows = [];
    for (const member of members) {
      const id = oneLine(member?.id);
      if (id === "") continue;
      if (!effectiveEnabled(snapshot.config, id)) continue;
      const store = snapshot.stores.get(id);
      if (store === undefined || store.entries.length === 0) continue;
      const picked =
        task === ""
          ? recentEntries(store.entries, { scope })
          : recallEntries(store.entries, task, { scope });
      if (picked.length === 0) continue;
      rows.push({ name: oneLine(member?.name) || id, entries: picked });
    }
    return renderMemoryBlock(rows);
  }



  const teamRuntimeOf = deps.teamRuntime;
  const defaultCache = deps.cachedDefault;
  const resetOverrides = deps.resetOverrides;

  return {
          choosableRows,
      cleanReleaseAgeExcludes,
      memoryClear,
      memoryEdit,
      memoryEntries,
      memoryRemove,
      memorySet,
      memoryState,
      purge,
      setOrderLine,
      teamPick,
      waifuApply,
      waifuClear,
      waifuOrder,
      MEMORY_CONTEXT_NAME,
      MEMORY_CONTEXT_ORDER,
      currentPersonaIdOf,
      lastUserText,
      memorySnap,
      personaMemoryForTeam,
      refreshMemorySnapshot,
      soloMemoryBlock,
      userTextOf,
      memorySnapOf: () => memorySnap
  };
}
