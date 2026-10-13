/**
 * dsh-waifu-agents — Client half.
 *
 * One tab inside Settings → Plugins, with two panes:
 *   • 人设   the roster: search (names AND bodies), groups, in-place editing,
 *            hide/restore, batch actions
 *   • 设置   left-labelled / right-controlled rows: directory, the shared
 *            skeleton, hidden files, paging, version, diagnostics
 *
 * Transport: `POST /waifu-agents/api`, the route this package's Host half
 * registers. The panel CANNOT use `ctx.remote.commands.execute`:
 * `SettingsPluginsTabOwnerProps` is intentionally EMPTY — the slot's owner
 * props are a literal `{}` — so no session id ever reaches this component, and
 * that call needs one. An HTTP route needs neither an agent nor a session.
 *
 * Controls, and why they come from two places:
 *   • `@deepseek-ai/dsh-client-ui-primitives` for Button / Tag / MarkdownText.
 *     Those three have verified prop shapes in this runtime, and MarkdownText
 *     is the only markdown renderer reachable here at all: a client half can
 *     only `require` from the frozen platform module table, so shipping our own
 *     renderer is structurally impossible.
 *   • native elements for the switch, the disclosure header, the segmented
 *     control and the inputs, styled with the theme's own `--dsw-*` tokens.
 *     Their primitive prop shapes are not documented in this runtime, and
 *     guessing at them risks a blank panel; the token stylesheet is the single
 *     source of truth for colour, so these still follow the app theme.
 */
window.__ModuleLoader__.load({
  id: 'dsh-waifu-agents',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      primitives = null;
    }

    const NS = 'waifu-agents';
    const SLOT = 'settings.plugins.tab';
    const ROUTE = '/waifu-agents/api';
    /*
     * How often the progress window asks the Host what the install is doing.
     *
     * 400ms is a compromise with a reason on both sides: the platform's own
     * phases are coarse (one `installing` per registry, one `applying`), so a
     * faster poll would mostly re-read the same answer, while a slower one
     * would let a phase change sit unnoticed on screen long enough to look like
     * a stall. The request is a small local JSON POST.
     */
    const UPDATE_POLL_MS = 400;
    /** Pseudo ids for the not-yet-saved row and the shared skeleton row. */
    const NEW = '__new__';
    const SKELETON = '__skeleton__';
    const SKELETON_FILE = '_common.md';
    const PAGE_SIZE_KEY = 'dsh-waifu-agents.pageSize';
    const REORDER_KEY = 'dsh-waifu-agents.reorder';

    const DICT = {
      zh: {
        tabWives: '人设',
        tabSettings: '设置',
        search: '搜索名字、简述或正文…',
        add: '新增',
        import: '导入 md',
        exportAll: '导出全部',
        exportOne: '导出这一条',
        template: '下载出厂人设',
        refresh: '刷新',
        batch: '批量',
        exitBatch: '退出批量',
        selected: '已选',
        hideSelected: '隐藏选中',
        exportSelected: '导出选中',
        clearSelection: '取消选择',
        selectAll: '全选',
        clearDefault: '关掉（谁都不指定）',
        apply: '应用',
        cancel: '取消',
        hide: '隐藏',
        hideAskTitle: '隐藏这个人设？',
        hideAskBody: '她会从名册里消失，文件归档成 <id>.md.off —— **正文一个字都不会删**。想让她回来：设置 → 已隐藏 → 取消隐藏。',
        hideAskAck: '我知道这只是归档，正文会保留',
        updateAskTitle: '安装新版本',
        updateAskBody: '会调用 pnpm 把这个插件装成新版本，装完**必须重启 DSH** 才生效。当前会话不受影响。',
        updateAskAck: '我知道这会安装新版本，并且需要重启 DSH',
        updateAskFailed: '上次更新失败',
        /*
         * The progress window. Its wording follows the platform's own phase
         * vocabulary (`installStarting` / `installApplying` in
         * `ui-plugin-manager`) so that both windows say the same things about
         * the same installation.
         */
        updateProgressTitle: '正在更新',
        updatePreparing: '正在准备安装…',
        updateInstallingPlain: '正在下载并安装…',
        updateInstallingFrom: '正在从 {registry} 安装（第 {index}/{total} 个源）…',
        updateApplying: '正在应用配置，请稍候…',
        updateCancelling: '正在停止安装…',
        updateWaiting: '安装进行中，别关掉这个窗口',
        updateElapsed: '已用 {s} 秒',
        updateQuiet: '已经 {s} 秒没等到平台的进度回报，但 pnpm 还在跑',
        updateLogTitle: 'pnpm 输出',
        updateLogShow: '展开输出',
        updateLogHide: '收起输出',
        updateLogTail: '（只留最后一段）',
        updateExitCode: 'pnpm 退出码 {code}',
        updateDoneTitle: '更新完成',
        updateDoneRestart: 'v{v} 已经装到磁盘上了，**重启 DSH** 之后才会真正生效。这个会话不受影响。',
        updateDoneApplied: 'v{v} 已经装好，而且当场生效了。',
        updateDoneCurrent: 'v{v} 就是当前版本，没有要装的东西。',
        updateDoneNoChange: 'v{v} 已经在磁盘上了，这次没有改动。',
        updateFailedTitle: '更新失败',
        updateRetry: '重试',
        updateClose: '关闭',
        updateStripRunning: '正在更新到 v{v}…（已用 {s} 秒）',
        updateStripDone: '已更新到 v{v} · 重启 DSH 后生效',
        updateStripFailed: '上次更新失败',
        expand: '展开',
        collapse: '收起',
        unhide: '取消隐藏',
        hidden: '已隐藏',
        hiddenCount: '已隐藏 {n} 个',
        hiddenNone: '没有已隐藏的人设。',
        unhideAll: '全部取消隐藏',
        archived: '归档',
        group: '分组',
        ungrouped: '未分组',
        skeleton: '公共骨架',
        skeletonEdit: '编辑骨架',
        skeletonSave: '保存骨架',
        skeletonCreate: '创建骨架',
        skeletonMissing: '还没有骨架。新建人设会只写她自己的部分，公共条款放进骨架。',
        skeletonSlots: '[[body]] 数量',
        skeletonStarter: '现在起，你是「[[name]]」。\n\n[[body]]\n\n【硬性边界】\n- 表演层可以自由发挥；代码、路径、行号、命令参数必须一字不差。\n',
        useSkeleton: '套用公共骨架',
        edit: '编辑',
        preview: '预览',
        name: '名字',
        description: '简述',
        bodyPlaceholder: '只写她独有的部分；公共条款在骨架里',
        autosave: '改动会在离开输入框时自动保存',
        nameDrivesFile: '文件名会跟着「名字」走',
        saving: '保存中…',
        saved: '已保存',
        reload: '重新载入',
        conflict: '磁盘上的文件被改过（外部编辑器或另一个窗口）。这次没有写入——重新载入看一遍，再把改动合并过去。',
        problems: '这一篇现在没法注册',
        notRegistered: '未注册',
        takenByOther: '这个 id 被别的所有者占用了',
        activationFailed: '激活失败',
        loading: '读取中…',
        empty: '这个目录里还没有人设。',
        noMatch: '没有匹配的。',
        bodyHits: '正文命中',
        hitSkeleton: '骨架',
        hitBody: '正文',
        settings: '设置',
        dirLabel: '人设目录',
        dirSave: '保存',
        dirHint: '填路径后保存：插件会自己重启一次并重新扫描。留空表示自动。',
        dirLocked: '这个环境没有 configEditor 服务，改不了目录。',
        dirSource: '目录来源',
        hiddenRow: '已隐藏',
        hiddenRowValue: '点开看，逐条取消隐藏',
        paging: '分页',
        pagingHint: '人设多了再打开；关闭时一次列全部。',
        perPage: '每页',
        versionTitle: '插件版本',
        defaultTitle: '新会话默认用谁',
        defaultHint: '关掉就是谁都不指定，新会话回落到 profile 的默认。与「设置 → Agent Presets」是同一个开关。',
        defaultUnchecked: '写进去了，但这个 profile 读不回来确认（既没有 settings，名册里也没有 isDefault）。这一行没报错，可也没人能担保平台认它。',
        defaultReseated: '也把当前这个还没开口的会话换过去了——新任务页顶上现在就是她。',
        defaultViaEditor: '警告：这次没走 settings 服务，退回配置编辑器写的。磁盘上是对的，但平台收不到通知，新任务页可能不跟——看日志里那条 warn。',
        defaultUnresolved: '这个默认指不到任何可用的人设——新会话会悄悄落到列表第一项。重新点一次开关，或者换一个。',
        diagnostics: '诊断',
        defaultReadFrom: '默认值读自',
        srcRemoteExportList: '会话预置清单',
        srcCompositionInventory: '组合清单',
        srcRegistryList: '注册表列表',
        srcNone: '没读到',
        pickPlaceholder: '搜人设名…',
        pickEmpty: '这个人设目录里还没有可用的人设。',
        pickNoResults: '没有匹配的人设。',
        pickNoSession: '这个会话还没准备好，等它开出来再试。',
        pickBadgeDefault: '全局默认',
        pickUngrouped: '未分组',
        pickSection: '人设',
        pickSwitchFailed: '切换失败',
        dragToReorder: '拖这里调整顺序（会写进文件的 order）',
        liveSessions: '个正在开着的会话下一轮就会跟着变',
        skeletonLive: '改这里会立刻影响**所有已经开着**的人设会话：它们的正文下一轮就会按这份骨架重新组装（不再遵守「只对新会话生效」）。',
        reordered: '顺序已保存',
        reorderTitle: '拖拽排序',
        reorderHint: '打开后整行都能拖：拖到另一行上就保存顺序。开着的时候行内的按钮和展开会锁住，避免误触；关掉就恢复正常。',
        purge: '彻底清理',
        purgeHint: '把本插件留在文件系统里的东西一次清掉：会话覆盖记录、全局默认人设指向。打开右边开关会连人设目录一起删。',
        purgeWithDir: '连人设目录一起删',
        purgeAskTitle: '彻底清理本插件的数据',
        purgeAskBody: '会删除：会话覆盖记录、全局默认人设指向。安装日志、pnpm 索引、pnpm-workspace.yaml 里的放行记录属于平台，这里不动它们，清理完会列给你。',
        purgeAskAck: '我知道这会清掉本插件的数据',
        readOnly: '只读',
        updateBanner: '有新版本 {latest}（当前 {installed}）',
        updateGo: '查看',
        checkUpdate: '检查更新',
        recheck: '重新检查更新',
        upToDate: '已是最新版本',
        canUpdateTo: '可更新到',
        nowVersion: '当前',
        doUpdate: '更新',
        manualInstall: '需在插件页手动安装',
        updating: '正在更新（会调用 pnpm，请稍等）…',
        updated: '已更新到',
        installed: '已装好',
        restartNeeded: '重启 DSH 后生效',
        updateFailed: '更新失败',
        updateUnreadable: '查不到最新版本',
        updateNoManager: '这个环境没有 pluginManager 服务，装不了；请在插件页手动安装',
        importFailed: '导入失败',
        refreshed: '已重新扫描',
        reloaded: '重新注册',
        added: '新增',
        sourceConfig: '行配置指定',
        sourceProfile: '用户目录（已存在）',
        sourceSeeded: '首次播种到用户目录',
        sourcePackage: '插件自带的出厂目录',
        sourceHome: '从 DSH_HOME 推出来',
        sourceDefault: '系统用户目录下的 .dsh',
      },
      en: {
        tabWives: 'Wives',
        tabSettings: 'Settings',
        search: 'Search name, summary or body…',
        add: 'New',
        import: 'Import md',
        exportAll: 'Export all',
        exportOne: 'Export this file',
        template: 'Download shipped persona',
        refresh: 'Refresh',
        batch: 'Batch',
        exitBatch: 'Exit batch',
        selected: 'Selected',
        hideSelected: 'Hide selected',
        exportSelected: 'Export selected',
        clearSelection: 'Clear',
        selectAll: 'Select all',
        clearDefault: 'Turn off (name nobody)',
        apply: 'Apply',
        cancel: 'Cancel',
        hide: 'Hide',
        hideAskTitle: 'Hide this persona?',
        hideAskBody: 'She leaves the roster and the file becomes <id>.md.off — **not one word of the text is deleted**. To bring her back: Settings → Hidden → Unhide.',
        hideAskAck: 'I understand this only archives her, the text stays',
        updateAskTitle: 'Install the new version',
        updateAskBody: 'This runs pnpm to install the new version of this plugin; you **must restart DSH** afterwards. The current session is untouched.',
        updateAskAck: 'I understand this installs a new version and needs a restart',
        updateAskFailed: 'The last update failed',
        updateProgressTitle: 'Updating',
        updatePreparing: 'Preparing the installation…',
        updateInstallingPlain: 'Downloading and installing…',
        updateInstallingFrom: 'Installing from {registry} (source {index} of {total})…',
        updateApplying: 'Applying the configuration, please wait…',
        updateCancelling: 'Stopping the installation…',
        updateWaiting: 'Installing — leave this window open',
        updateElapsed: '{s}s elapsed',
        updateQuiet: 'no progress report from the platform for {s}s, but pnpm is still running',
        updateLogTitle: 'pnpm output',
        updateLogShow: 'Show output',
        updateLogHide: 'Hide output',
        updateLogTail: '(tail only)',
        updateExitCode: 'pnpm exited with {code}',
        updateDoneTitle: 'Update finished',
        updateDoneRestart: 'v{v} is on disk; **restart DSH** to actually run it. This session is untouched.',
        updateDoneApplied: 'v{v} is installed and took effect right away.',
        updateDoneCurrent: 'v{v} is already the running version; nothing to install.',
        updateDoneNoChange: 'v{v} was already on disk; nothing changed.',
        updateFailedTitle: 'Update failed',
        updateRetry: 'Retry',
        updateClose: 'Close',
        updateStripRunning: 'Updating to v{v}… ({s}s elapsed)',
        updateStripDone: 'Updated to v{v} · restart DSH to apply',
        updateStripFailed: 'The last update failed',
        expand: 'Expand',
        collapse: 'Collapse',
        unhide: 'Unhide',
        hidden: 'Hidden',
        hiddenCount: '{n} hidden',
        hiddenNone: 'Nothing is hidden.',
        unhideAll: 'Unhide all',
        archived: 'Archive',
        group: 'Group',
        ungrouped: 'Ungrouped',
        skeleton: 'Shared skeleton',
        skeletonEdit: 'Edit skeleton',
        skeletonSave: 'Save skeleton',
        skeletonCreate: 'Create skeleton',
        skeletonMissing: 'No skeleton yet. A new persona then writes only her own part; the shared clauses live here.',
        skeletonSlots: '[[body]] count',
        skeletonStarter: 'From now on you are "[[name]]".\n\n[[body]]\n\n[Hard boundary]\n- Performance is free; code, paths, line numbers and command arguments must be exact.\n',
        useSkeleton: 'Use the shared skeleton',
        edit: 'Edit',
        preview: 'Preview',
        name: 'Name',
        description: 'Summary',
        bodyPlaceholder: 'Only her own part; the shared clauses live in the skeleton',
        autosave: 'Edits are written when the field loses focus',
        nameDrivesFile: 'The file name follows this name',
        saving: 'Saving…',
        saved: 'Saved',
        reload: 'Load again',
        conflict: 'The file changed on disk (an outside editor or another window). This save did NOT happen — load it again and merge.',
        problems: 'She cannot be registered right now',
        notRegistered: 'not registered',
        takenByOther: 'another owner holds this id',
        activationFailed: 'activation failed',
        loading: 'Loading…',
        empty: 'No wife in this directory yet.',
        noMatch: 'Nothing matches.',
        bodyHits: 'Body matches',
        hitSkeleton: 'skeleton',
        hitBody: 'body',
        settings: 'Settings',
        dirLabel: 'Persona directory',
        dirSave: 'Save',
        dirHint: 'Save a path and the plugin restarts itself to rescan. Empty means auto.',
        dirLocked: 'This environment has no configEditor service, so the directory cannot be changed.',
        dirSource: 'Directory source',
        hiddenRow: 'Hidden',
        hiddenRowValue: 'open to bring one back',
        paging: 'Paging',
        pagingHint: 'Turn it on once the roster grows; off lists everything at once.',
        perPage: 'Per page',
        versionTitle: 'Plugin version',
        defaultTitle: 'Default for new sessions',
        defaultHint: 'Off means no preset is named and new sessions fall back to the profile default. The same switch as Settings → Agent Presets.',
        defaultUnchecked: 'The write went through, but this profile cannot read the field back to confirm it (no `settings`, and the roster carries no `isDefault`). Nothing errored — and nothing can vouch that the platform agrees.',
        defaultReseated: 'The session already open on the new-task screen was moved too — its chip names her now.',
        defaultViaEditor: 'Warning: this went through the config editor instead of the settings service. The disk is right, but the platform was not told, so the new-task screen may not follow — see the warning in the log.',
        defaultUnresolved: 'This default points at no usable persona, so a new session silently falls back to the first row. Toggle it again, or pick another.',
        diagnostics: 'Diagnostics',
        defaultReadFrom: 'default read from',
        srcRemoteExportList: 'session preset list',
        srcCompositionInventory: 'composition inventory',
        srcRegistryList: 'registry list',
        srcNone: 'nothing answered',
        pickPlaceholder: 'Search personas…',
        pickEmpty: 'No usable persona in this directory yet.',
        pickNoResults: 'No persona matches.',
        pickNoSession: 'This session is not ready yet — try again once it is open.',
        pickBadgeDefault: 'default',
        pickUngrouped: 'Ungrouped',
        pickSection: 'personas',
        pickSwitchFailed: 'Switch failed',
        dragToReorder: 'Drag to reorder (writes order: into the file)',
        liveSessions: 'live sessions pick this up next turn',
        skeletonLive: 'Editing this immediately affects **every open** persona session: their text is re-assembled from this skeleton on their next turn (the "new sessions only" rule no longer holds).',
        reordered: 'Order saved',
        reorderTitle: 'Drag to reorder',
        reorderHint: 'On, a whole row can be dragged: drop it on another to save the order. While it is on, that row\'s buttons and expanding are locked so a stray click cannot fight the drag; off restores them.',
        purge: 'Purge',
        purgeHint: 'Remove everything this plugin left on disk in one go: the session override store and the global-default pointer. The switch on the right also deletes the persona directory.',
        purgeWithDir: 'Also delete the persona directory',
        purgeAskTitle: 'Purge this plugin\'s data',
        purgeAskBody: 'Deletes the session override store and the global-default pointer. The install logs, the pnpm store index and the release-age allow-list entry belong to the platform and are listed afterwards instead of touched.',
        purgeAskAck: 'I know this removes the plugin\'s data',
        readOnly: 'read-only',
        updateBanner: 'Version {latest} is out (running {installed})',
        updateGo: 'Details',
        checkUpdate: 'Check for updates',
        recheck: 'Check again',
        upToDate: 'Up to date',
        canUpdateTo: 'Update to',
        nowVersion: 'running',
        doUpdate: 'Update',
        manualInstall: 'Install from the Plugins page',
        updating: 'Installing (pnpm runs, please wait)…',
        updated: 'Updated to',
        installed: 'installed',
        restartNeeded: 'restart DSH to apply',
        updateFailed: 'Update failed',
        updateUnreadable: 'Could not read the latest version',
        updateNoManager: 'This environment has no pluginManager service; install from the Plugins page',
        importFailed: 'Import failed',
        refreshed: 'Rescanned',
        reloaded: 're-registered',
        added: 'added',
        sourceConfig: 'from the row config',
        sourceProfile: 'user directory (already there)',
        sourceSeeded: 'seeded into the user directory',
        sourcePackage: 'shipped with the plugin',
        sourceHome: 'derived from DSH_HOME',
        sourceDefault: 'the .dsh directory under the system home',
      },
    };

    /** Layout only. Colour, radius and depth come from the theme's own tokens. */
    const L = {
      root: { display: 'flex', flexDirection: 'column', gap: '12px' },
      bar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      push: { marginLeft: 'auto' },
      list: { display: 'flex', flexDirection: 'column', gap: '6px' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '10px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      /*
       * Every property a conditional variant below can set has to be declared
       * here too, holding its resting value. `borderColor`, `borderStyle`,
       * `opacity`, `cursor` and `userSelect` are not decoration — they are the
       * reason the highlight used to stop following the user.
       *
       * React drops a style it no longer receives by writing `style[name] = ''`.
       * For a plain property that works (`transform` on the switch thumb is
       * removed correctly). For `borderColor` it does not: the colour lives in
       * the `border` shorthand right above, so clearing the longhand leaves the
       * shorthand re-applying it, and a border whose colour was cleared falls
       * back to `currentColor`. In this theme `currentColor` (label-primary) is
       * the same near-white as `--dsw-alias-brand-primary`, so a row that WAS
       * the default and no longer is still LOOKS selected — until a remount
       * rebuilds the node. That is exactly the reported 「多次切换默认人设后，
       * 选中过的 border 样式存在残留，再次进入就消失了」.
       *
       * Declaring the resting value means React always SETS the property, so the
       * removal path is never taken. Keep this list in step with `itemDefault`,
       * `dragging`, `dropTarget` and `reorderRow`.
       */
      item: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderColor: 'var(--dsw-alias-border-l1)',
        borderStyle: 'solid',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-base)',
        opacity: 1,
        cursor: 'auto',
        userSelect: 'auto',
      },
      itemDefault: { borderColor: 'var(--dsw-alias-brand-primary)' },
      head: { display: 'flex', alignItems: 'center', gap: '8px' },
      name: { fontWeight: 600, fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      meta: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' },
      grow: { flex: 1, minWidth: 0 },
      field: { display: 'flex', alignItems: 'center', gap: '8px' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', minWidth: '52px' },
      input: {
        fontSize: '13px',
        padding: '5px 8px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
      },
      textarea: {
        width: '100%',
        minHeight: '200px',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: 1.6,
        padding: '8px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
        boxSizing: 'border-box',
      },
      search: { minWidth: '180px' },
      hidden: { display: 'none' },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-base)',
      },
      rowMain: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 },
      settingRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 2px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      rowTitle: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      caret: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '24px',
        height: '24px',
        minWidth: '24px',
        padding: 0,
        border: 'none',
        borderRadius: '6px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        flex: 'none',
      },
      // Same rule as `item`: `switchOn` sets `borderColor` and the disabled
      // variant sets `opacity`, so both have to exist here holding their resting
      // value — otherwise a switched-off switch keeps a brand-coloured ring and a
      // switch that was disabled while busy never comes back to full opacity.
      switch: {
        width: '36px',
        height: '20px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderColor: 'var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        position: 'relative',
        cursor: 'pointer',
        padding: 0,
        flex: 'none',
        opacity: 1,
      },
      switchOn: { background: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' },
      thumb: {
        width: '16px',
        height: '16px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-switch-thumb, var(--dsw-alias-bg-base))',
        position: 'absolute',
        top: '1px',
        left: '1px',
        transition: 'transform 120ms ease',
        transform: 'translateX(0)',
      },
      thumbOn: { transform: 'translateX(16px)' },
      seg: { display: 'inline-flex', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', overflow: 'hidden' },
      segItem: {
        fontSize: '13px',
        padding: '5px 12px',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      segActive: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
      groupHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 4px',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
        textAlign: 'left',
      },
      groupWrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '6px 8px 8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      groupLabel: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      groupCount: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      tabs: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      tabBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '7px 16px',
        border: 'none',
        borderRadius: '8px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '14px',
        lineHeight: '20px',
        fontWeight: 500,
        cursor: 'pointer',
      },
      tabActive: {
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
      },
      divider: {
        width: '1px',
        alignSelf: 'stretch',
        minHeight: '20px',
        margin: '0 6px',
        background: 'var(--dsw-alias-border-l2)',
        flex: 'none',
      },
      skeletonRow: { borderColor: 'var(--dsw-alias-brand-primary)' },
      handle: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '18px',
        height: '22px',
        flex: 'none',
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: 'grab',
      },
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--dsw-alias-bg-mask-1)',
      },
      dialog: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        maxWidth: '420px',
        padding: '16px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-panel, 12px)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      dragging: { opacity: 0.45 },
      reorderRow: { cursor: 'grab', userSelect: 'none' },
      dropTarget: { borderColor: 'var(--dsw-alias-state-business-primary)', borderStyle: 'dashed' },
      /*
       * The progress window's pieces. Same rule as `item` way above:
       * `progressFill` declares every property its finished / failed variants
       * can touch — `background` — so React always SETS the colour instead of
       * dropping a longhand that the shorthand underneath would put back. The
       * width is inline (it changes every poll) and is therefore never dropped.
       */
      progressTrack: {
        height: '6px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderColor: 'var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        overflow: 'hidden',
      },
      progressFill: {
        height: '100%',
        width: '0%',
        background: 'var(--dsw-alias-brand-primary)',
        borderRadius: '999px',
        transition: 'width 240ms ease, background 200ms ease',
      },
      progressFillDone: { background: 'var(--dsw-alias-state-success-primary)' },
      progressFillFailed: { background: 'var(--dsw-alias-state-error-primary)' },
      logBox: {
        maxHeight: '160px',
        overflow: 'auto',
        margin: 0,
        padding: '8px',
        fontSize: '11px',
        lineHeight: 1.5,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
      },
      textBtn: {
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        cursor: 'pointer',
        textAlign: 'left',
      },
    };

    /** One POST to the Host route; resolves the payload or throws its `error`. */
    async function post(request) {
      let response;
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
      } catch (error) {
        throw new Error(`连不上 ${ROUTE}：${error?.message ?? error}`);
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (payload === null || typeof payload !== 'object') {
        throw new Error(`${ROUTE} 返回了非 JSON（HTTP ${response.status}）`);
      }
      if (payload.ok === false) {
        const failure = new Error(payload.error ?? `HTTP ${response.status}`);
        failure.payload = payload;
        throw failure;
      }
      return payload;
    }

    /** Hand a string to the browser as a download. */
    function download(filename, content) {
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    /** The same move the Host performs, so the panel previews an identical list. */
    function reorderIds(ids, movedId, beforeId) {
      const from = ids.indexOf(movedId);
      const to = ids.indexOf(beforeId);
      if (from < 0 || to < 0 || from === to) return null;
      const next = ids.slice();
      next.splice(from, 1);
      next.splice(next.indexOf(beforeId), 0, movedId);
      return next;
    }

    const orderOf = (item) => (typeof item.order === 'number' ? item.order : Number.MAX_SAFE_INTEGER);
    const groupOf = (item) => {
      const value = typeof item.group === 'string' ? item.group.trim() : '';
      return value === '' ? '' : value;
    };

    /** Button / Tag / MarkdownText when the package is there, native when it is not. */
    const Btn = (props) => {
      if (primitives === null) {
        const { icon, variant: _variant, size: _size, children, ...rest } = props;
        return h('button', { type: 'button', ...rest }, icon ?? null, children ?? null);
      }
      return h(primitives.Button, { variant: props.variant ?? 'ghost', ...props });
    };
    const TagBox = (props) =>
      primitives === null
        ? h('span', { style: L.meta }, props.children)
        : h(primitives.Tag, { tone: props.tone ?? 'outline', children: props.children });
    const Markdown = (props) =>
      primitives === null
        ? h('pre', { style: { ...L.textarea, whiteSpace: 'pre-wrap', margin: 0 } }, props.text)
        : h(primitives.MarkdownText, { text: props.text, variant: props.variant ?? 'body' });

    /**
     * Glyphs from the platform's own icon set.
     *
     * Every name here was read out of the runtime's export table rather than
     * guessed, and the bridge degrades to nothing when a name is missing: a
     * wrong glyph must never take the whole panel down with an invalid element
     * type, which is exactly what a bare `primitives.IconX` would do.
     */
    const ICONS = {
      chevronRight: 'IconChevronRightOutlineRegular',
      chevronLeft: 'IconChevronLeftOutlineRegular',
      chevronDown: 'IconChevronDownOutlineRegular',
      download: 'IconDownloadOutlineRegular',
      archive: 'IconArchiveOutlineRegular',
      archived: 'IconArchiveCheckOutlineRegular',
      unarchive: 'IconUnarchiveOutlineRegular',
      plus: 'IconPlusOutlineRegular',
      refresh: 'IconRefreshOutlineRegular',
      checklist: 'IconChecklistOutlineRegular',
      check: 'IconCheckOutlineRegular',
      close: 'IconCloseOutlineRegular',
      folder: 'IconFolderOpenRegular',
      grip: 'IconChevronsUpDownOutlineRegular',
      search: 'IconSearchOutlineRegular',
      settings: 'IconSettingsOutlineRegular',
      users: 'IconUsersOutlineRegular',
      browse: 'IconBrowseOutlineRegular',
      deliver: 'IconDeliverDocRegular',
    };

    function Icon({ name, size = 15 }) {
      const component = primitives === null ? undefined : primitives[ICONS[name]];
      if (typeof component !== 'function') return null;
      return h(component, { size });
    }

    /** Where the default row's preset id came from, in words. */
    function sourceLabel(source, t) {
      const key = {
        remoteExportList: 'srcRemoteExportList',
        compositionInventory: 'srcCompositionInventory',
        list: 'srcRegistryList',
      }[source];
      if (key !== undefined) return t(key);
      return source === null || source === undefined ? t('srcNone') : String(source);
    }

    function SwitchBox({ checked, disabled, title, onChange }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked === true,
          title,
          disabled,
          style: { ...L.switch, ...(checked === true ? L.switchOn : null), ...(disabled === true ? { opacity: 0.5 } : null) },
          onClick: (event) => {
            event.stopPropagation();
            if (disabled !== true) onChange(checked !== true);
          },
        },
        h('span', { style: { ...L.thumb, ...(checked === true ? L.thumbOn : null) } }),
      );
    }

    function Segmented({ value, options, onChange }) {
      return h(
        'span',
        { style: L.seg },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              style: { ...L.segItem, ...(option.value === value ? L.segActive : null) },
              onClick: () => onChange(option.value),
            },
            option.label,
          ),
        ),
      );
    }

    /**
     * A confirmation dialog, built on the platform's own.
     *
     * `RiskConfirmation` is preferred because it is the shipped gate for exactly
     * this kind of action (the permission page uses it for dangerous presets):
     * its primary button stays disabled until the acknowledgement box is ticked.
     */
    function Confirm({ open, title, description, acknowledgeLabel, confirmLabel, cancelLabel, onCancel, onConfirm }) {
      const [acknowledged, setAcknowledged] = React.useState(false);
      const [busyLocal, setBusyLocal] = React.useState(false);
      // A dialog that reopens must not remember the previous tick.
      React.useEffect(() => {
        if (open !== true) {
          setAcknowledged(false);
          setBusyLocal(false);
        }
      }, [open]);
      const run = async () => {
        setBusyLocal(true);
        try {
          await onConfirm();
        } finally {
          setBusyLocal(false);
        }
      };
      if (open !== true) return null;
      if (primitives !== null && typeof primitives.RiskConfirmation === 'function') {
        return h(primitives.RiskConfirmation, {
          open: true,
          title,
          description,
          acknowledgeLabel,
          confirmLabel,
          cancelLabel,
          closeLabel: cancelLabel,
          acknowledged,
          disabled: busyLocal,
          onAcknowledgedChange: setAcknowledged,
          onCancel,
          onConfirm: run,
        });
      }
      if (primitives !== null && typeof primitives.Modal === 'function') {
        return h(primitives.Modal, {
          open: true,
          onClose: onCancel,
          title,
          closeLabel: cancelLabel,
          description,
          footer: h(
            'div',
            { style: L.bar },
            h(Btn, { variant: 'outline', onClick: onCancel }, cancelLabel),
            h(Btn, { variant: 'primary', disabled: busyLocal, onClick: run }, confirmLabel),
          ),
        });
      }
      return h(
        'div',
        { style: L.overlay },
        h(
          'div',
          { style: L.dialog },
          h('span', { style: L.rowTitle }, title),
          h('span', { style: L.hint }, description),
          h(
            'div',
            { style: L.bar },
            h(Btn, { variant: 'outline', onClick: onCancel }, cancelLabel),
            h(Btn, { variant: 'primary', disabled: busyLocal, onClick: run }, confirmLabel),
          ),
        ),
      );
    }

    /**
     * A v4 UUID, minted by the PANEL rather than the Host.
     *
     * The id has to be known BEFORE the launch request goes out: the platform
     * publishes an installation's progress keyed on it, so a chunk that arrives
     * while the launch response is still in flight must already have somewhere
     * to land. Minting on the Host side would lose exactly those first chunks —
     * and with them the earliest phase, which is the one a person watches for.
     */
    function newRequestId() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
          return crypto.randomUUID();
        }
      } catch {
        /* a webview outside a secure context throws on the access itself */
      }
      try {
        // The same construction the platform's own client uses, for a webview
        // that ships `getRandomValues` but not `randomUUID`.
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
          const bytes = crypto.getRandomValues(new Uint8Array(16));
          const hex = Array.from(bytes, (byte, index) =>
            (index === 6 ? (byte & 15) | 64 : index === 8 ? (byte & 63) | 128 : byte).toString(16).padStart(2, '0'),
          ).join('');
          return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
      } catch {
        /* fall through to the last resort */
      }
      return `waifu-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
    }

    /**
     * How full the bar is, estimated from the phase.
     *
     * The platform reports PHASES, not bytes, so there is no true figure to
     * show. The shape matters more than the value: a bar that jumps to a number
     * and freezes reads as 「卡住了」, so each phase creeps toward its own
     * ceiling as the clock runs — and nothing reaches 100 while the job is
     * still going, so a full bar means 「真的完了」 and nothing else.
     */
    function progressPercent(job) {
      if (job === null || job === undefined) return 0;
      if (job.done === true) return 100;
      const elapsed = Number(job.elapsedMs ?? 0);
      const phase = String(job.phase ?? 'starting');
      let floor = 3;
      let ceiling = 10;
      if (phase === 'installing') {
        // One band per registry tried, so a fallback to a second source is
        // visible as progress instead of as a bar going backwards.
        const index = Math.max(1, Number(job.attempt?.index ?? 1) || 1);
        const total = Math.max(1, Number(job.attempt?.total ?? 1) || 1);
        const span = 62 / total;
        floor = 12 + span * (index - 1);
        ceiling = floor + span;
      } else if (phase === 'applying') {
        floor = 78;
        ceiling = 96;
      } else if (phase === 'cancelling') {
        floor = 60;
        ceiling = 70;
      }
      // Fast at first, asymptotic near the ceiling — honest about a stretch
      // whose length nobody knows.
      const creep = Math.min(1, elapsed / 6000);
      return Math.max(2, Math.min(99, Math.round(floor + (ceiling - floor) * creep)));
    }

    /**
     * The line above the bar, in the platform's own phase vocabulary.
     *
     * Same words the built-in Plugins page uses for the same install
     * (`installStarting` / `installApplying`), because a person watching two
     * windows describe one installation should not have to translate.
     */
    function progressHeadline(job, t) {
      if (job === null || job === undefined) return '';
      if (job.done === true) {
        return typeof job.error === 'string' && job.error !== '' ? t('updateFailedTitle') : t('updateDoneTitle');
      }
      const phase = String(job.phase ?? 'starting');
      if (phase === 'installing') {
        const attempt = job.attempt;
        const total = Number(attempt?.total ?? 1) || 1;
        if (attempt !== null && attempt !== undefined && total > 1) {
          return t('updateInstallingFrom')
            .replace('{registry}', String(attempt.registry ?? ''))
            .replace('{index}', String(attempt.index ?? 1))
            .replace('{total}', String(total));
        }
        return t('updateInstallingPlain');
      }
      if (phase === 'applying') return t('updateApplying');
      if (phase === 'cancelling') return t('updateCancelling');
      return t('updatePreparing');
    }

    /** How long it has been going, and whether the platform is still talking. */
    function progressNote(job, t) {
      if (job === null || job === undefined || job.done === true) return '';
      const seconds = Math.max(0, Math.round(Number(job.elapsedMs ?? 0) / 1000));
      const clock = t('updateElapsed').replace('{s}', String(seconds));
      /*
       * The feed never spoke, and enough time has passed that it should have.
       * Saying so beats a bar that looks stuck for reasons nobody on this side
       * can see — and the install is still running either way.
       */
      if (job.seenFeed !== true && seconds >= 8) {
        return `${clock} · ${t('updateQuiet').replace('{s}', String(seconds))}`;
      }
      return clock;
    }

    /** What a settled job amounts to, in one sentence. */
    function progressOutcome(job, t) {
      const result = job?.result ?? null;
      if (result === null) return '';
      const version = String(result.version ?? '');
      if (result.application === 'current') return t('updateDoneCurrent').replace('{v}', version);
      if (result.changed !== true) return t('updateDoneNoChange').replace('{v}', version);
      if (result.application === 'restart-required' || result.application === null || result.application === undefined) {
        return t('updateDoneRestart').replace('{v}', version);
      }
      return t('updateDoneApplied').replace('{v}', version);
    }

    /**
     * The roster strip's one line for a job.
     *
     * It exists so that dismissing the progress window loses nothing: this is
     * the same state, in the place the person is already looking when they come
     * back to the panel.
     */
    function updateStripText(job, t) {
      if (job?.done !== true) {
        const seconds = Math.max(0, Math.round(Number(job?.elapsedMs ?? 0) / 1000));
        return t('updateStripRunning')
          .replace('{v}', String(job?.version ?? ''))
          .replace('{s}', String(seconds));
      }
      if (typeof job?.error === 'string' && job.error !== '') return t('updateStripFailed');
      return t('updateStripDone').replace('{v}', String(job?.result?.version ?? job?.version ?? ''));
    }

    /**
     * The window that stays open while pnpm works — and then until the person
     * reading it says so.
     *
     * Deliberately NOT `Confirm`. That one is a gate: its primary button stays
     * disabled until the acknowledgement is ticked, and it has nothing to draw
     * after the click. This one is a report, and it opens WITH the click that
     * starts the install. Nothing closes it on its own, which is the entire
     * point — 「更新完了也不知道更新完没有」 is precisely what a window that
     * vanishes on click produces.
     *
     * Closing it mid-install is allowed and costs nothing: the roster carries a
     * strip that reads the same job state, so a result that arrives after the
     * window was dismissed still finds the person, with a button to bring the
     * window back.
     */
    function ProgressWindow({ open, t, job, onClose, onRetry }) {
      const [logOpen, setLogOpen] = React.useState(false);
      // A window reopened for a new install must not remember the last fold.
      React.useEffect(() => {
        if (open !== true) setLogOpen(false);
      }, [open]);
      if (open !== true || job === null || job === undefined) return null;
      const done = job.done === true;
      const failed = typeof job.error === 'string' && job.error !== '';
      const log = String(job.log ?? '');
      const exit =
        job.pnpmExit === null || job.pnpmExit === undefined
          ? ''
          : t('updateExitCode').replace('{code}', String(job.pnpmExit));
      /*
       * Every key here is written on every render — `background` comes from the
       * base object and the width is always explicit — so React never takes its
       * 「drop the property」 path, which is the failure mode `item` documents.
       */
      const fill = {
        ...L.progressFill,
        width: `${progressPercent(job)}%`,
        ...(failed ? L.progressFillFailed : done ? L.progressFillDone : {}),
      };
      const note = progressNote(job, t);
      return h(
        'div',
        { style: L.overlay },
        h(
          'div',
          { style: { ...L.dialog, maxWidth: '480px', width: '100%' } },
          h('span', { style: L.rowTitle }, t('updateProgressTitle')),
          h('div', { style: L.progressTrack }, h('div', { style: fill })),
          h('span', { style: failed ? L.error : L.name }, failed ? String(job.error) : done ? progressOutcome(job, t) : progressHeadline(job, t)),
          note === '' ? null : h('span', { style: L.meta }, note),
          exit === '' ? null : h('span', { style: L.meta }, exit),
          log === ''
            ? null
            : h(
                'div',
                { style: L.bar },
                h(
                  'button',
                  { type: 'button', style: L.textBtn, onClick: () => setLogOpen((prev) => prev !== true) },
                  logOpen ? t('updateLogHide') : t('updateLogShow'),
                ),
                h(
                  'span',
                  { style: L.meta },
                  `${t('updateLogTitle')}${job.logTruncated === true ? ` ${t('updateLogTail')}` : ''}`,
                ),
              ),
          log === '' || logOpen !== true ? null : h('pre', { style: L.logBox }, log),
          h(
            'div',
            { style: L.bar },
            // While it runs there is deliberately no way to pretend otherwise:
            // the window says what it is doing and offers exactly one exit —
            // 「关闭」 after the result is in. Dismissing early is still allowed,
            // and the roster strip keeps the outcome reachable (see above).
            done !== true ? h(Btn, { variant: 'toolbar', disabled: true }, t('updateWaiting')) : null,
            failed === true ? h(Btn, { variant: 'outline', onClick: onRetry }, t('updateRetry')) : null,
            h('div', { style: L.push }),
            h(Btn, { variant: done === true ? 'primary' : 'outline', onClick: onClose }, t('updateClose')),
          ),
        ),
      );
    }

    /** A real React error boundary: try/catch around hooks breaks the renderer. */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        // eslint-disable-next-line no-console
        console.error('dsh-waifu-agents panel crashed', error);
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { style: { padding: '16px', ...L.error } },
            `dsh-waifu-agents 面板渲染失败：${this.state.error?.message ?? this.state.error}`,
          );
        }
        return this.props.children;
      }
    }

    /** Left description, a rule, then the controls — the settings-page shape. */
    function SettingRow({ title, hint, children }) {
      return h(
        'div',
        { style: L.settingRow },
        h('div', { style: L.rowMain }, h('span', { style: L.rowTitle }, title), hint ? h('span', { style: L.hint }, hint) : null),
        h('div', { style: L.divider }),
        h('div', { style: { ...L.bar, justifyContent: 'flex-end' } }, children),
      );
    }

    function Editor({ draft, t, busy, onPatch, onCommit }) {
      const loading = draft.loading === true;
      const field = (label, ...controls) => h('div', { style: L.field }, h('span', { style: L.label }, label), ...controls);
      const text = draft.body ?? '';
      return h(
        'div',
        { style: L.card },
        loading
          ? h('span', { style: L.hint }, t('loading'))
          : h(
              React.Fragment,
              null,
              field(
                t('name'),
                h('input', {
                  style: { ...L.input, ...L.grow },
                  value: draft.name ?? '',
                  disabled: busy,
                  onChange: (event) => onPatch({ name: event.target.value }),
                  onBlur: onCommit,
                }),
              ),
              field(
                t('description'),
                h('input', {
                  style: { ...L.input, ...L.grow },
                  value: draft.description ?? '',
                  disabled: busy,
                  onChange: (event) => onPatch({ description: event.target.value }),
                  onBlur: onCommit,
                }),
              ),
              field(
                t('group'),
                h('input', {
                  style: { ...L.input, ...L.grow },
                  value: draft.group ?? '',
                  disabled: busy,
                  onChange: (event) => onPatch({ group: event.target.value }),
                  onBlur: onCommit,
                }),
              ),
              field(
                t('skeleton'),
                h(SwitchBox, {
                  checked: (draft.template ?? '') === SKELETON_FILE,
                  disabled: busy,
                  title: t('useSkeleton'),
                  onChange: (next) => {
                    onPatch({ template: next ? SKELETON_FILE : '' });
                    onCommit();
                  },
                }),
              ),
              h(
                'div',
                { style: L.bar },
                h(Segmented, {
                  value: draft.preview === true ? 'preview' : 'edit',
                  options: [
                    { value: 'edit', label: t('edit') },
                    { value: 'preview', label: t('preview') },
                  ],
                  onChange: (next) => onPatch({ preview: next === 'preview' }),
                }),
              ),
              draft.preview === true
                ? h('div', { style: { ...L.textarea, overflow: 'auto' } }, h(Markdown, { text }))
                : h('textarea', {
                    style: L.textarea,
                    value: text,
                    disabled: busy,
                    placeholder: t('bodyPlaceholder'),
                    onChange: (event) => onPatch({ body: event.target.value }),
                    onBlur: onCommit,
                  }),
              (draft.problems ?? []).length > 0
                ? h(
                    'div',
                    null,
                    h('span', { style: L.error }, t('problems')),
                    ...(draft.problems ?? []).map((line, index) => h('div', { key: index, style: L.error }, line)),
                  )
                : null,
              h('span', { style: L.hint }, `${t('autosave')} · ${t('nameDrivesFile')}`),
            ),
      );
    }

    function SkeletonEditor({ draft, t, busy, onPatch, onSave, onCancel }) {
      const loading = draft.loading === true;
      return h(
        'div',
        { style: L.card },
        loading
          ? h('span', { style: L.hint }, t('loading'))
          : h(
              React.Fragment,
              null,
              h('span', { style: L.hint }, h(Markdown, { text: t('skeletonLive'), variant: 'body' })),
              h(
                'div',
                { style: L.bar },
                h('span', { style: L.meta }, `${t('skeletonSlots')}: ${draft.slots ?? 0}`),
                h('span', { style: L.meta }, `[[name]] × ${draft.nameSlots ?? 0}`),
              ),
              h('textarea', {
                style: { ...L.textarea, minHeight: '280px' },
                value: draft.text ?? '',
                disabled: busy,
                onChange: (event) => onPatch({ text: event.target.value }),
              }),
              (draft.problems ?? []).length > 0
                ? h(
                    'div',
                    null,
                    ...(draft.problems ?? []).map((line, index) => h('div', { key: index, style: L.error }, line)),
                  )
                : null,
              h(
                'div',
                { style: L.bar },
                h(Btn, { variant: 'primary', disabled: busy, onClick: onSave }, t('skeletonSave')),
                h(Btn, { disabled: busy, onClick: onCancel }, t('cancel')),
              ),
            ),
      );
    }

    const UNGROUPED = '\u0000ungrouped';

    function WifeRow({
      item,
      t,
      open,
      busy,
      isDefault,
      broken,
      selected,
      batchMode,
      dragging,
      dropTarget,
      reorder,
      onToggle,
      onSelect,
      onExport,
      onHide,
      onDefault,
      onDragStart,
      onDragOver,
      onDrop,
      onDragEnd,
    }) {
      const problems = item.problems ?? [];
      // Sorting mode owns the whole row: a caret click or a default switch while a
      // drag is being set up is how a reorder turns into an accidental edit, which
      // is exactly the surprise the off-by-default switch exists to prevent.
      const locked = reorder === true;
      return h(
        'div',
        {
          style: {
            ...L.item,
            ...(isDefault === true ? L.itemDefault : null),
            ...(locked ? L.reorderRow : null),
            ...(dragging === item.id ? L.dragging : null),
            ...(dropTarget === item.id ? L.dropTarget : null),
          },
          'data-pw-row': item.id,
          ...(isDefault === true ? { 'data-pw-default': 'true' } : null),
          // Native HTML5 DnD, the same way ui-workspace does it: no primitive
          // exists for this, and a drag is not what the row's other gestures use.
          draggable: batchMode !== true && reorder === true,
          onDragStart: (event) => {
            if (event.dataTransfer !== null && event.dataTransfer !== undefined) {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', item.id);
            }
            onDragStart(item.id);
          },
          onDragOver: (event) => {
            event.preventDefault();
            if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move';
            onDragOver(item.id);
          },
          onDrop: (event) => {
            event.preventDefault();
            onDrop(item.id);
          },
          onDragEnd,
        },
        h(
          'div',
          { style: L.head },
          batchMode === true
            ? h('input', { type: 'checkbox', checked: selected === true, onChange: onSelect, onClick: (event) => event.stopPropagation() })
            : null,
          reorder === true
            ? h('span', { style: L.handle, title: t('dragToReorder'), 'aria-hidden': true }, h(Icon, { name: 'grip', size: 15 }))
            : null,
          h(
            'button',
            {
              type: 'button',
              style: L.caret,
              disabled: busy || locked,
              title: open ? t('collapse') : t('expand'),
              'aria-label': open ? t('collapse') : t('expand'),
              'aria-expanded': open === true,
              onClick: locked ? undefined : onToggle,
            },
            h(Icon, { name: open ? 'chevronDown' : 'chevronRight' }),
          ),
          h('span', { style: L.name }, item.name),
          typeof item.group === 'string' && item.group.trim() !== '' ? h(TagBox, null, item.group) : null,
          problems.length > 0 ? h('span', { style: L.error }, t('problems')) : null,
          problems.length === 0 && item.owned !== true && (broken === null || broken === undefined)
            ? h('span', { style: L.error }, `${t('notRegistered')} · ${t('takenByOther')}`)
            : null,
          broken !== null && broken !== undefined ? h('span', { style: L.error }, `${t('activationFailed')}: ${broken}`) : null,
          h('span', { style: L.push }),
          h(SwitchBox, {
            checked: isDefault === true,
            disabled: busy || locked,
            title: t('defaultTitle'),
            // Off clears the selection instead of refusing: the registry falls
            // back to the profile's own default, and the roster reports it.
            onChange: (next) => onDefault(next),
          }),
          h(Btn, {
            variant: 'toolbar',
            size: 'sm',
            icon: h(Icon, { name: 'download', size: 16 }),
            title: t('exportOne'),
            'aria-label': t('exportOne'),
            disabled: busy || locked,
            style: { padding: '0 6px' },
            onClick: onExport,
          }),
          h(Btn, {
            variant: 'toolbar',
            size: 'sm',
            icon: h(Icon, { name: 'archive', size: 16 }),
            title: t('hide'),
            'aria-label': t('hide'),
            disabled: busy || locked,
            style: { padding: '0 6px' },
            onClick: onHide,
          }),
        ),
        problems.length > 0 ? h('div', { style: L.error }, ...problems.map((line, index) => h('div', { key: index }, line))) : null,
      );
    }

    function HiddenList({ files, t, busy, onUnhide, onUnhideAll }) {
      if (files.length === 0) return h('span', { style: L.hint }, t('hiddenNone'));
      return h(
        'div',
        { style: L.list },
        h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'unarchive' }), disabled: busy, onClick: onUnhideAll }, t('unhideAll')),
        ...files.map((file) =>
          h(
            'div',
            { key: file.archived, style: L.row },
            h(
              'div',
              { style: L.rowMain },
              h('span', { style: L.rowTitle }, `${file.id}.md`),
              h('span', { style: L.hint }, `${t('archived')}: ${file.archived}${file.seq > 1 ? ` (#${file.seq})` : ''}`),
            ),
            h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'unarchive' }), disabled: busy, onClick: () => onUnhide(file.archived) }, t('unhide')),
          ),
        ),
      );
    }

    function SourceLabel({ source, t }) {
      const key = {
        config: 'sourceConfig',
        DSH_PROFILE_DIR: 'sourceProfile',
        seeded: 'sourceSeeded',
        package: 'sourcePackage',
        DSH_HOME: 'sourceHome',
        default: 'sourceDefault',
      }[source];
      return h('span', { style: L.meta }, key === undefined ? String(source ?? '—') : t(key));
    }

    function SettingsTab({
      data,
      t,
      dirDraft,
      onDirDraft,
      onSaveDir,
      hidden,
      hiddenOpen,
      onToggleHidden,
      onUnhide,
      onUnhideAll,
      pageSize,
      onPageSize,
      purgeDir,
      onPurgeDir,
      onAskPurge,
      update,
      installing,
      job,
      onAskUpdate,
      onUpdate,
      onCheck,
      onEditSkeleton,
      onClearDefault,
      defaultResolves,
      busy,
      openId,
      skeletonDraft,
      onPatchSkeleton,
      onSaveSkeleton,
      onOpenSkeleton,
    }) {
      const configurable = data?.configurable === true;
      const running = update?.installed ?? update?.running ?? '—';
      const versionAction = () => {
        /*
         * While an install is in flight this row has nothing to offer but the
         * state: `startUpdate` owns the launch, the progress window owns the
         * report, and the roster strip keeps the outcome visible. Re-triggering
         * from here would only race those.
         */
        if (installing === true || (job !== null && job !== undefined && job.done !== true))
          return h(Btn, { variant: 'toolbar', disabled: true }, t('updateWaiting'));
        if (update === null) return h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'refresh' }), disabled: true }, t('checkUpdate'));
        if (update.restartPending === true) return h(Btn, { variant: 'toolbar', disabled: true }, t('restartNeeded'));
        if (update.updateAvailable === true && update.canInstall === false) return h(Btn, { variant: 'toolbar', disabled: true }, t('manualInstall'));
        if (update.updateAvailable === true) {
          return h(
            Btn,
            { variant: 'primary', icon: h(Icon, { name: 'download' }), onClick: onAskUpdate },
            `${t('canUpdateTo')} v${update.latest}`,
          );
        }
        return h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'refresh' }), onClick: onCheck }, t('recheck'));
      };
      return h(
        'div',
        { style: L.list },
        h(
          SettingRow,
          { title: t('dirLabel'), hint: configurable === true ? t('dirHint') : t('dirLocked') },
          h('input', {
            style: { ...L.input, minWidth: '220px' },
            value: dirDraft,
            disabled: configurable === false || busy,
            onChange: (event) => onDirDraft(event.target.value),
            placeholder: data?.dir ?? '',
          }),
          h(
            Btn,
            { variant: 'primary', disabled: configurable === false || busy === true || dirDraft === (data?.dir ?? ''), onClick: onSaveDir },
            t('dirSave'),
          ),
        ),
        h(SettingRow, { title: t('dirSource'), hint: data?.dir ?? '' }, h(SourceLabel, { source: data?.dirSource, t })),
        h(
          SettingRow,
          {
            title: t('skeleton'),
            hint: data?.skeleton?.present === true ? (data.skeleton.file ?? '') : t('skeletonMissing'),
          },
          h(
            Btn,
            { variant: 'toolbar', icon: h(Icon, { name: 'deliver' }), disabled: busy, onClick: onEditSkeleton },
            data?.skeleton?.present === true ? t('skeletonEdit') : t('skeletonCreate'),
          ),
        ),
        openId === SKELETON
          ? h(SkeletonEditor, {
              draft: skeletonDraft ?? { text: '', slots: 0, nameSlots: 0, problems: [], rev: null, loading: true },
              t,
              busy,
              onPatch: onPatchSkeleton,
              onSave: onSaveSkeleton,
              onCancel: () => onOpenSkeleton(),
            })
          : null,
        h(
          SettingRow,
          { title: t('hiddenRow'), hint: t('hiddenRowValue') },
          h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'archive' }), disabled: busy, onClick: onToggleHidden }, `${t('hidden')} (${hidden.length})`),
        ),
        hiddenOpen === true ? h('div', { style: L.card }, h(HiddenList, { files: hidden, t, busy, onUnhide, onUnhideAll })) : null,
        h(
          SettingRow,
          { title: t('defaultTitle'), hint: t('defaultHint') },
          h('span', { style: L.meta }, data?.defaultId ?? '—'),
          h(Btn, { variant: 'toolbar', disabled: busy || data?.defaultId == null, onClick: onClearDefault }, t('clearDefault')),
        ),
        // A default that resolves to no live row is the one failure the platform
        // never reports: the registry quietly falls back to the profile default,
        // and the new-task chip stages the first row instead. The setting page is
        // the only place this can be said out loud, so say it here.
        defaultResolves === false
          ? h('div', { style: L.card }, h('span', { style: L.error }, t('defaultUnresolved')))
          : null,
        h(
          SettingRow,
          { title: t('paging'), hint: t('pagingHint') },
          h(SwitchBox, { checked: pageSize > 0, onChange: (next) => onPageSize(next === true ? 20 : 0) }),
          pageSize > 0
            ? h('input', {
                type: 'number',
                min: 1,
                style: { ...L.input, width: '72px' },
                value: pageSize,
                onChange: (event) => onPageSize(Number(event.target.value) || 0),
              })
            : null,
        ),
        h(
          SettingRow,
          { title: t('purge'), hint: t('purgeHint') },
          h(SwitchBox, {
            checked: purgeDir === true,
            disabled: busy,
            title: t('purgeWithDir'),
            onChange: (next) => onPurgeDir(next === true),
          }),
          h('span', { style: L.meta }, t('purgeWithDir')),
          h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'archive' }), disabled: busy, onClick: onAskPurge }, t('purge')),
        ),
        h(SettingRow, { title: t('versionTitle'), hint: update?.error ?? '' }, h('span', { style: L.meta }, `${t('nowVersion')} ${running}`), versionAction()),
        h(
          SettingRow,
          { title: t('diagnostics'), hint: data?.defaultError ?? '' },
          h(
            'span',
            { style: L.meta, title: String(data?.defaultSource ?? '') },
            `${t('defaultReadFrom')} ${sourceLabel(data?.defaultSource, t)}${data?.writable === false ? ` · ${t('readOnly')}` : ''}`,
          ),
        ),
      );
    }

    /** Local filtering only: a body never reaches the browser. */
    function filterAndSort(files, query) {
      const needle = String(query ?? '').trim().toLowerCase();
      const rows =
        needle === ''
          ? files.slice()
          : files.filter((item) =>
              [item.id, item.name ?? '', item.description ?? '', item.group ?? ''].join(' ').toLowerCase().includes(needle),
            );
      return rows.sort(
        (a, b) => orderOf(a) - orderOf(b) || String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)),
      );
    }

    function groupRows(rows) {
      const map = new Map();
      for (const row of rows) {
        const name = groupOf(row);
        const key = name === '' ? UNGROUPED : name;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
      }
      return [...map.entries()]
        .map(([key, list]) => ({ key, label: key === UNGROUPED ? '' : key, rows: list }))
        .sort((a, b) => (a.key === UNGROUPED ? 1 : b.key === UNGROUPED ? -1 : a.key.localeCompare(b.key)));
    }

    /** Off unless the user turned it on: an accidental drag must not write files. */
    function readStoredReorder() {
      try {
        return window.localStorage.getItem(REORDER_KEY) === '1';
      } catch (error) {
        return false;
      }
    }

    function readStoredPageSize() {
      try {
        const value = Number(window.localStorage.getItem(PAGE_SIZE_KEY));
        return Number.isFinite(value) && value > 0 ? value : 0;
      } catch (error) {
        return 0;
      }
    }

    function WivesTab(props) {
      const {
        data,
        t,
        query,
        onQuery,
        hits,
        searching,
        openId,
        draft,
        busy,
        batches,
        batchMode,
        groupCollapsed,
        onToggleGroup,
        onOpenRow,
        onNew,
        onRefresh,
        onExportOne,
        onExportAll,
        onHideOne,
        onSetDefault,
        onToggleBatch,
        onSelect,
        onSelectAll,
        onClearSelection,
        onBatchHide,
        onBatchExport,
        dragging,
        dropTarget,
        reorderMode,
        onReorderMode,
        onDragStart,
        onDragOver,
        onDrop,
        onDragEnd,
        onImportClick,
        onDownloadTemplate,
        onPatchDraft,
        onCommit,
        page,
        pageSize,
        onPage,
        brokenById,
        note,
      } = props;
      const files = data === null ? [] : data.files;
      const visible = filterAndSort(files, query);
      const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(visible.length / pageSize)) : 1;
      const current = Math.min(Math.max(1, page), pageCount);
      const pageRows = pageSize > 0 ? visible.slice((current - 1) * pageSize, current * pageSize) : visible;
      const groups = groupRows(pageRows);
      const selectedCount = batches.length;
      return h(
        'div',
        { style: L.list },
        h(
          'div',
          { style: L.bar },
          h('input', {
            style: { ...L.input, ...L.search },
            value: query,
            placeholder: t('search'),
            onChange: (event) => onQuery(event.target.value),
          }),
          searching === true ? h('span', { style: L.hint }, t('loading')) : null,
          h('span', { style: L.push }),
          h(Btn, { variant: 'primary', icon: h(Icon, { name: 'plus' }), disabled: busy, onClick: onNew }, t('add')),
          h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'browse' }), disabled: busy, onClick: onImportClick }, t('import')),
          h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'download' }), disabled: busy || files.length === 0, onClick: onExportAll }, t('exportAll')),
          h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'deliver' }), disabled: busy, onClick: onDownloadTemplate }, t('template')),
          h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'refresh' }), disabled: busy, onClick: onRefresh }, t('refresh')),
          h(Btn, { variant: batchMode === true ? 'primary' : 'toolbar', icon: h(Icon, { name: 'checklist' }), disabled: busy, onClick: onToggleBatch }, batchMode === true ? t('exitBatch') : t('batch')),
          h(
            Btn,
            {
              variant: reorderMode === true ? 'primary' : 'toolbar',
              icon: h(Icon, { name: 'grip' }),
              disabled: busy,
              title: t('reorderHint'),
              onClick: () => onReorderMode(reorderMode !== true),
            },
            t('reorderTitle'),
          ),
        ),
        batchMode === true
          ? h(
              'div',
              { style: L.card },
              h('span', { style: L.meta }, `${t('selected')} ${selectedCount}`),
              h(
                'div',
                { style: L.bar },
                h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'check' }), disabled: busy, onClick: onSelectAll }, t('selectAll')),
                h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'archive' }), disabled: busy || selectedCount === 0, onClick: onBatchHide }, t('hideSelected')),
                h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'download' }), disabled: busy || selectedCount === 0, onClick: onBatchExport }, t('exportSelected')),
                h(Btn, { variant: 'toolbar', disabled: busy, onClick: onClearSelection }, t('clearSelection')),
              ),
            )
          : null,
        note !== null && note !== undefined ? h('div', { style: note.kind === 'ok' ? L.ok : L.error }, note.text) : null,
        (hits ?? []).length > 0
          ? h(
              'div',
              { style: L.list },
              h('span', { style: L.meta }, `${t('bodyHits')} (${hits.length})`),
              ...hits.map((hit, index) =>
                h(
                  'div',
                  { key: `${hit.id}-${index}`, style: L.row, onClick: () => onOpenRow({ id: hit.id, name: hit.name }) },
                  h('div', { style: L.rowMain }, h('span', { style: L.rowTitle }, hit.name), h('span', { style: L.hint }, hit.snippet)),
                  h(TagBox, null, hit.source === 'skeleton' ? t('hitSkeleton') : t('hitBody')),
                ),
              ),
            )
          : null,
        data === null ? h('span', { style: L.hint }, t('loading')) : null,
        data !== null && files.length === 0 ? h('span', { style: L.hint }, t('empty')) : null,
        data !== null && files.length > 0 && visible.length === 0 ? h('span', { style: L.hint }, t('noMatch')) : null,
        ...groups.map((group) =>
          h(
            'div',
            { key: group.key, style: L.groupWrap },
            h(
              'button',
              {
                type: 'button',
                style: L.groupHead,
                'aria-expanded': groupCollapsed[group.key] !== true,
                onClick: () => onToggleGroup(group.key),
              },
              h(Icon, { name: groupCollapsed[group.key] === true ? 'chevronRight' : 'chevronDown' }),
              h(Icon, { name: 'folder', size: 14 }),
              h('span', { style: L.groupLabel }, group.label === '' ? t('ungrouped') : group.label),
              h('span', { style: L.groupCount }, String(group.rows.length)),
            ),
            groupCollapsed[group.key] === true
              ? null
              : group.rows.map((item) =>
                  h(
                    React.Fragment,
                    { key: item.id },
                    h(WifeRow, {
                      item,
                      t,
                      open: openId === item.id,
                      busy,
                      isDefault: data !== null && data.defaultId === item.id,
                      broken: brokenById === undefined ? null : (brokenById[item.id] ?? null),
                      selected: batches.includes(item.id),
                      batchMode,
                      onToggle: () => onOpenRow(item),
                      onSelect: () => onSelect(item.id),
                      onExport: () => onExportOne(item.id),
                      onHide: () => onHideOne(item),
                      onDefault: (next) => onSetDefault(item, next),
                      dragging,
                      dropTarget,
                      reorder: reorderMode === true,
                      onDragStart,
                      onDragOver,
                      onDrop,
                      onDragEnd,
                    }),
                    openId === item.id && draft !== null && draft.id === item.id
                      ? h(Editor, { draft, t, busy, onPatch: onPatchDraft, onCommit })
                      : null,
                  ),
                ),
            ),
          ),
        openId === NEW && draft !== null
          ? h(
              'div',
              { style: L.list },
              h('div', { style: { ...L.item, ...L.skeletonRow } }, h('span', { style: L.name }, t('add'))),
              h(Editor, { draft, t, busy, onPatch: onPatchDraft, onCommit }),
            )
          : null,
        pageCount > 1
          ? h(
              'div',
              { style: L.bar },
              h(Btn, { variant: 'toolbar', size: 'sm', icon: h(Icon, { name: 'chevronLeft' }), disabled: current <= 1, onClick: () => onPage(current - 1) }),
              h('span', { style: L.meta }, `${current} / ${pageCount}`),
              h(Btn, { variant: 'toolbar', size: 'sm', icon: h(Icon, { name: 'chevronRight' }), disabled: current >= pageCount, onClick: () => onPage(current + 1) }),
            )
          : null,
      );
    }

    function PanelBody() {
      const [phase, setPhase] = React.useState('loading');
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const [tab, setTab] = React.useState('wives');
      const [query, setQuery] = React.useState('');
      const [hits, setHits] = React.useState([]);
      const [searching, setSearching] = React.useState(false);
      const [openId, setOpenId] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [skeletonDraft, setSkeletonDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      /** The one open confirmation: { kind: 'hide', item } or { kind: 'update' }. */
      const [dialog, setDialog] = React.useState(null);
      /** The purge row's second checkbox: whether the persona directory goes too. */
      const [purgeDir, setPurgeDir] = React.useState(false);
      const [batches, setBatches] = React.useState([]);
      const [batchMode, setBatchMode] = React.useState(false);
      const [groupCollapsed, setGroupCollapsed] = React.useState({});
      const [hidden, setHidden] = React.useState([]);
      const [hiddenOpen, setHiddenOpen] = React.useState(false);
      const [dirDraft, setDirDraft] = React.useState('');
      const [update, setUpdate] = React.useState(null);
      /**
       * The install this panel is watching, as `updateProgress` last reported
       * it. `null` = nothing started during this visit.
       *
       * Kept OUTSIDE the dialog on purpose, so that dismissing the progress
       * window costs nothing: the roster renders a strip from this same object,
       * and the poll below keeps running until the job settles.
       */
      const [job, setJob] = React.useState(null);
      const [installing, setInstalling] = React.useState(false);
      const [pageSize, setPageSize] = React.useState(readStoredPageSize);
      const [page, setPage] = React.useState(1);
      const [brokenById, setBrokenById] = React.useState({});
      /*
       * Whether the persisted default names a preset the registry actually holds.
       * `null` = the roster has not answered yet. The new-task chip stages
       * `presets.find(p => p.isDefault)?.id ?? presets[0].id`, so a default that
       * resolves to nothing comes up on the FIRST row with no error anywhere —
       * this flag is the only place that can be said out loud.
       */
      const [defaultResolves, setDefaultResolves] = React.useState(null);
      const [dragId, setDragId] = React.useState(null);
      const [dropId, setDropId] = React.useState(null);
      const [reorderMode, setReorderMode] = React.useState(readStoredReorder);

      const rootRef = React.useRef(null);
      const draftRef = React.useRef(null);
      const skeletonRef = React.useRef(null);
      const openRef = React.useRef(null);
      const idAlias = React.useRef(new Map());
      const fileInput = React.useRef(null);

      const t = React.useCallback((key) => {
        let found;
        try {
          found = translate(key);
        } catch (caught) {
          found = undefined;
        }
        if (typeof found === 'string' && found.length > 0) return found;
        const local = DICT.zh[key];
        return typeof local === 'string' ? local : key;
      }, []);

      const putDraft = React.useCallback((value) => {
        draftRef.current = value;
        setDraft(value);
      }, []);

      const patchDraft = React.useCallback((changes) => {
        if (draftRef.current === null) return;
        draftRef.current = { ...draftRef.current, ...changes };
        setDraft(draftRef.current);
      }, []);

      const putSkeletonDraft = React.useCallback((value) => {
        skeletonRef.current = value;
        setSkeletonDraft(value);
      }, []);

      const patchSkeletonDraft = React.useCallback((changes) => {
        if (skeletonRef.current === null) return;
        skeletonRef.current = { ...skeletonRef.current, ...changes };
        setSkeletonDraft(skeletonRef.current);
      }, []);

      const load = React.useCallback(async () => {
        try {
          const payload = await post({ op: 'list' });
          setData(payload);
          setPhase('ready');
          setError(null);
          setDirDraft((prev) => (prev === '' ? (payload.dir ?? '') : prev));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          setPhase('error');
        }
      }, []);

      const loadHidden = React.useCallback(async () => {
        try {
          const payload = await post({ op: 'hidden' });
          setHidden(payload.files ?? []);
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        }
      }, []);

      const loadRoster = React.useCallback(async () => {
        try {
          const payload = await post({ op: 'roster' });
          const map = {};
          for (const row of payload.presets ?? []) map[row.id] = typeof row.broken === 'string' ? row.broken : null;
          setBrokenById(map);
          // Tri-state on purpose: `undefined` from an older host must not be
          // reported as 「指不到人」.
          setDefaultResolves(typeof payload.defaultResolves === 'boolean' ? payload.defaultResolves : null);
        } catch (failure) {
          // A roster we cannot read is not a broken panel: the rows keep the
          // `owned` flag they already carry.
          setDefaultResolves(null);
        }
      }, []);

      React.useEffect(() => {
        void load();
        void loadRoster();
        void loadHidden();
        post({ op: 'updateCheck' })
          .then((payload) => setUpdate(payload))
          .catch((failure) => setUpdate({ error: String(failure?.message ?? failure) }));
      }, [load, loadRoster, loadHidden]);

      /*
       * The poll behind the progress window.
       *
       * Keyed on the id and the done flag ALONE: every other field changes on
       * every poll, and depending on them would tear the interval down and
       * rebuild it several times a second. It also keeps running while the
       * window is dismissed — the roster strip draws the same state, so nobody
       * has to sit watching a bar to find out how it ended.
       */
      React.useEffect(() => {
        const requestId = job?.requestId ?? '';
        if (job === null || job.done === true || requestId === '') return undefined;
        let alive = true;
        const poll = () => {
          post({ op: 'updateProgress', requestId })
            .then((payload) => {
              if (!alive || payload.idle === true) return;
              setJob((prev) => (prev === null || prev === undefined ? prev : { ...prev, ...payload }));
            })
            .catch(() => {
              // A poll that cannot reach the Host says nothing about the
              // install; the next one tries again.
            });
        };
        const timer = window.setInterval(poll, UPDATE_POLL_MS);
        poll();
        return () => {
          alive = false;
          window.clearInterval(timer);
        };
      }, [job?.requestId, job?.done]);

      /*
       * When a job settles, re-read the faces drawn from the pre-install
       * answer: the version banner and the version row would otherwise keep
       * advertising the update that just landed. `settledRef` holds the last id
       * this ran for, so a re-render cannot repeat it.
       */
      const settledRef = React.useRef(null);
      React.useEffect(() => {
        if (job === null || job.done !== true) return;
        const key = `${job.requestId}:${job.error === null || job.error === undefined ? 'ok' : 'bad'}`;
        if (settledRef.current === key) return;
        settledRef.current = key;
        post({ op: 'updateCheck' })
          .then((payload) => setUpdate(payload))
          .catch(() => {});
        void load();
      }, [job?.done, job?.requestId, job?.error, load]);

      // Body search runs on the Host and returns snippets only, so a directory
      // of long personas costs the browser nothing to search.
      React.useEffect(() => {
        const needle = query.trim();
        if (needle.length < 2) {
          setHits([]);
          setSearching(false);
          return undefined;
        }
        setSearching(true);
        const timer = window.setTimeout(() => {
          post({ op: 'search', query: needle })
            .then((payload) => setHits(payload.hits ?? []))
            .catch(() => setHits([]))
            .finally(() => setSearching(false));
        }, 300);
        return () => window.clearTimeout(timer);
      }, [query]);

      const showRow = React.useCallback((id) => {
        openRef.current = id;
        setOpenId(id);
      }, []);

      async function save(next) {
        const current = draftRef.current;
        if (current === null || current.loading === true || next === null || next === undefined) return;
        const isNew = current.mode === 'new';
        if (isNew && !String(next.name ?? '').trim() && !String(next.body ?? '').trim()) return;
        setBusy(true);
        setNote(null);
        try {
          const payload = isNew
            ? await post({
                op: 'create',
                name: next.name,
                description: next.description,
                group: next.group,
                template: next.template,
                body: next.body ?? '',
              })
            : await post({
                op: 'update',
                id: idAlias.current.get(current.id) ?? current.id,
                name: next.name,
                description: next.description,
                group: next.group,
                template: next.template,
                body: next.body ?? '',
                rev: current.rev,
              });
          setNote({ kind: 'ok', text: `${t('saved')}${payload.id ? ` · ${payload.id}.md` : ''}` });
          if (isNew === false && typeof payload.id === 'string') idAlias.current.set(current.id, payload.id);
          if (typeof payload.id === 'string' && openRef.current === current.id) showRow(payload.id);
          if (draftRef.current !== null) patchDraft({ id: payload.id ?? current.id, rev: payload.rev ?? current.rev, loading: false });
          await load();
          await loadRoster();
        } catch (failure) {
          const payload = failure?.payload;
          if (payload !== undefined && payload.conflict === true) {
            setNote({ kind: 'error', text: `${t('conflict')}（${payload.rev ?? ''}）` });
          } else {
            setNote({ kind: 'error', text: String(failure?.message ?? failure) });
          }
        } finally {
          setBusy(false);
        }
      }

      /** Blur, row switch and unmount all funnel through here. */
      const commit = React.useCallback(() => {
        const current = draftRef.current;
        if (current === null || current.loading === true) return;
        void save({ ...current });
      }, []);

      function closeRow() {
        commit();
        showRow(null);
        putDraft(null);
        setDialog(null);
      }

      async function openRow(item) {
        if (openRef.current === item.id) {
          closeRow();
          return;
        }
        commit();
        setDialog(null);
        setNote(null);
        showRow(item.id);
        putDraft({
          mode: 'edit',
          id: item.id,
          name: item.name ?? '',
          description: item.description ?? '',
          group: item.group ?? '',
          template: item.template ?? '',
          body: null,
          chars: typeof item.chars === 'number' ? item.chars : 0,
          charsFull: typeof item.charsFull === 'number' ? item.charsFull : 0,
          problems: [],
          preview: false,
          rev: null,
          // Until `get` answers, the editor is read-only: saving an empty body
          // in that window used to be rejected by the Host as 「回答方式不能为空」
          // — an error the user never caused.
          loading: true,
        });
        try {
          const payload = await post({ op: 'get', id: item.id });
          if (draftRef.current === null || draftRef.current.id !== item.id) return;
          patchDraft({
            name: payload.name ?? '',
            description: payload.description ?? '',
            group: payload.group ?? '',
            template: payload.template ?? '',
            body: payload.body ?? '',
            chars: payload.chars ?? 0,
            charsFull: payload.charsFull ?? 0,
            problems: payload.problems ?? [],
            rev: payload.rev,
            loading: false,
          });
        } catch (failure) {
          patchDraft({ loading: false, problems: [String(failure?.message ?? failure)] });
        }
      }

      function startNew() {
        if (openRef.current === NEW) {
          closeRow();
          return;
        }
        commit();
        setDialog(null);
        setNote(null);
        showRow(NEW);
        putDraft({
          mode: 'new',
          id: NEW,
          name: '',
          description: '',
          group: '',
          template: data !== null && data.skeleton.present === true ? SKELETON_FILE : '',
          body: '',
          chars: 0,
          charsFull: 0,
          problems: [],
          preview: false,
          rev: null,
          loading: false,
        });
      }

      async function openSkeleton() {
        if (openRef.current === SKELETON) {
          closeRow();
          return;
        }
        commit();
        showRow(SKELETON);
        setNote(null);
        putSkeletonDraft({ text: '', slots: 0, nameSlots: 0, problems: [], rev: null, loading: true });
        try {
          const payload = await post({ op: 'skeleton' });
          if (skeletonRef.current === null) return;
          const text = payload.present === true ? payload.text : t('skeletonStarter');
          putSkeletonDraft({
            text,
            slots: payload.present === true ? payload.slots : text.split('[[body]]').length - 1,
            nameSlots: text.split('[[name]]').length - 1,
            problems: payload.problems ?? [],
            rev: payload.rev,
            loading: false,
          });
        } catch (failure) {
          putSkeletonDraft({ text: '', slots: 0, nameSlots: 0, problems: [String(failure?.message ?? failure)], rev: null, loading: false });
        }
      }

      async function saveSkeleton() {
        const current = skeletonRef.current;
        if (current === null || current.loading === true) return;
        setBusy(true);
        setNote(null);
        try {
          const payload = await post({ op: 'setSkeleton', text: current.text ?? '', rev: current.rev });
          setNote({
            kind: 'ok',
            text: `${t('saved')} · ${t('reloaded')} ${(payload.reloaded ?? []).length}${
              (payload.liveSessions ?? 0) > 0 ? ` · ${payload.liveSessions} ${t('liveSessions')}` : ''
            }`,
          });
          patchSkeletonDraft({ rev: payload.rev, slots: payload.slots, problems: [], loading: false });
          await load();
          await loadRoster();
        } catch (failure) {
          const payload = failure?.payload;
          if (payload !== undefined && payload.conflict === true) {
            setNote({ kind: 'error', text: `${t('conflict')}（${payload.rev ?? ''}）` });
          } else {
            setNote({ kind: 'error', text: String(failure?.message ?? failure) });
          }
        } finally {
          setBusy(false);
        }
      }

      async function refresh() {
        setBusy(true);
        setNote(null);
        try {
          const payload = await post({ op: 'refresh' });
          const problems = payload.problems ?? [];
          setNote({
            kind: problems.length === 0 ? 'ok' : 'error',
            text: `${t('refreshed')} · ${t('added')} ${(payload.added ?? []).length} · ${t('reloaded')} ${(payload.reloaded ?? []).length}${
              problems.length > 0 ? ` · ${problems.join(' / ')}` : ''
            }`,
          });
          setData(payload);
          await loadRoster();
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      async function exportOne(id) {
        setBusy(true);
        setNote(null);
        try {
          const payload = await post({ op: 'export', id });
          download(payload.filename ?? `${id}.md`, payload.content ?? '');
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      /**
       * One request per file, on purpose: `exportAll` would put every persona in
       * a single response, and the panel is what has to stay small.
       */
      async function exportAll() {
        const files = data === null ? [] : data.files;
        setBusy(true);
        setNote(null);
        try {
          for (const file of files) {
            const payload = await post({ op: 'export', id: file.id });
            download(payload.filename ?? `${file.id}.md`, payload.content ?? '');
            await new Promise((resolve) => window.setTimeout(resolve, 250));
          }
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      async function downloadTemplate() {
        setBusy(true);
        try {
          const payload = await post({ op: 'template' });
          download(payload.filename ?? 'persona.md', payload.content ?? '');
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      /** The dialog asks; this runs only after the acknowledgement is ticked. */
      async function hideOne(item) {
        setBusy(true);
        setNote(null);
        try {
          await post({ op: 'remove', id: item.id });
          if (openRef.current === item.id) closeRow();
          setNote({ kind: 'ok', text: `${t('hidden')} · ${item.id}.md.off` });
          await load();
          await loadHidden();
          await loadRoster();
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      async function unhide(archived) {
        setBusy(true);
        setNote(null);
        try {
          const payload = await post({ op: 'restore', archived });
          setNote({ kind: 'ok', text: `${t('unhide')} · ${payload.id}.md` });
          await load();
          await loadHidden();
          await loadRoster();
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      async function unhideAll() {
        setBusy(true);
        try {
          const payload = await post({ op: 'batch', action: 'restore', archived: hidden.map((file) => file.archived) });
          const results = payload.results ?? [];
          const failed = results.filter((row) => row.ok !== true).length;
          setNote({ kind: failed === 0 ? 'ok' : 'error', text: `${t('unhide')} ${results.length - failed}/${results.length}` });
          await load();
          await loadHidden();
          await loadRoster();
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      async function setDefault(item, next) {
        setBusy(true);
        setNote(null);
        try {
          // `next === false` clears the selection: the registry then falls back
          // to the profile's own default, which is exactly what the settings row
          // shows. Same field as Settings → Agent Presets, so the semantics have
          // to match.
          const answer = await post({ op: 'setDefault', id: next === true ? item.id : '' });
          await load();
          await loadRoster();
          /*
           * The write reports the anchor it committed — and the Host only reports
           * it after reading the value BACK from the live registry, so this is a
           * read, not an intention. Landing it LAST, after the reread, is what
           * keeps a `list` that happened to answer with the previous id from
           * leaving the row the user just moved off wearing the active border.
           *
           * `checkable === false` means this profile exposes no face that can
           * confirm the field (no `settings`, no `isDefault`). The write went
           * through, but nothing here can promise the platform honours it, and
           * saying nothing is what turns that into 「设了默认，新会话却不是她」.
           */
          if (answer !== null && answer.defaultId !== undefined) {
            setData((prev) =>
              prev === null
                ? prev
                : {
                    ...prev,
                    defaultId: answer.defaultId,
                    defaultSource: answer.defaultSource ?? prev.defaultSource,
                  },
            );
          }
          /*
           * What the user is told, in the order that matters. A degraded write
           * first, because it is the failure that looks fine from here and is
           * not. Then "nothing here can confirm it". Then the good news — and
           * that one used to be missing entirely: writing the field never moved
           * the session already sitting on the new-task screen, so the chip went
           * on naming the previous wife while this panel said otherwise.
           */
          if (answer !== null && answer.via === 'configEditor') {
            setNote({ kind: 'error', text: t('defaultViaEditor') });
          } else if (answer !== null && answer.checkable === false) {
            setNote({ kind: 'error', text: t('defaultUnchecked') });
          } else if (
            answer !== null &&
            Array.isArray(answer.resettled) &&
            answer.resettled.length > 0
          ) {
            setNote({ kind: 'ok', text: t('defaultReseated') });
          }
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
          /*
           * A refused write still changed what the screen should say. The border
           * is drawn from `data.defaultId`, and the row the user just clicked must
           * not keep it: the write was rejected precisely BECAUSE the registry
           * never moved, so the honest picture is the one on disk — which is what
           * this reread brings back. Without it the switch looks like it worked
           * until the panel is left and entered again.
           */
          try {
            await load();
            await loadRoster();
          } catch {
            // The note above already carries the real failure.
          }
          /*
           * …and the refusal already named that picture. A failed `setDefault`
           * carries `defaultId`, read back from the live registry by the Host, so
           * landing it AFTER the reread is what stops a `list` that answered from
           * a not-yet-settled snapshot from leaving the border on the row the
           * default was just moved off. Throwing that field away and trusting the
           * fresh `list` was the last way the residue outlived the click.
           */
          const reported = failure?.payload;
          if (
            reported !== null &&
            reported !== undefined &&
            reported.defaultId !== undefined
          ) {
            setData((prev) =>
              prev === null
                ? prev
                : {
                    ...prev,
                    defaultId: reported.defaultId,
                    defaultSource: reported.defaultSource ?? prev.defaultSource,
                  },
            );
          }
        } finally {
          setBusy(false);
        }
      }

      /**
       * Everything this plugin owns, removed in one request.
       *
       * The host answers with what it deleted and what it deliberately left
       * alone; a partial success is reported as an error that still lists the
       * steps that did run, because a half-purge the user cannot see is worse
       * than a loud one.
       */
      async function purgeNow() {
        const withDir = purgeDir === true;
        setBusy(true);
        setNote(null);
        try {
          const payload = await post({ op: 'purge', dir: withDir });
          const steps = [...(payload.done ?? []), ...(payload.failed ?? []).map((line) => `${t('problems')}：${line}`)];
          setNote({
            kind: payload.ok === false ? 'error' : 'ok',
            text: `${t('purge')}：${steps.length === 0 ? '—' : steps.join('；')}`,
          });
          await load();
          await loadRoster();
          await loadHidden();
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      async function saveDir() {
        setBusy(true);
        setNote(null);
        try {
          const payload = await post({ op: 'setDir', dir: dirDraft });
          setNote({ kind: 'ok', text: payload.note ?? t('saved') });
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      /**
       * Start an install and stop waiting for it.
       *
       * The request that starts it answers immediately (see `updateApply` on the
       * Host half), and everything after that is read from `updateProgress`
       * polls — which is what lets the window draw a bar instead of freezing on
       * 「正在更新…」 until pnpm returns, with no way to tell a slow install from
       * a dead one.
       */
      async function startUpdate() {
        const version = String(update?.latest ?? '');
        const requestId = newRequestId();
        /*
         * The job is in state BEFORE the request goes out, carrying the id the
         * platform will key its progress on. A chunk the Host broadcasts while
         * the launch response is still in flight therefore has something to
         * land in, instead of being dropped on the floor.
         */
        setJob({
          requestId,
          version,
          previous: update?.installed ?? update?.running ?? null,
          phase: 'starting',
          attempt: null,
          elapsedMs: 0,
          log: '',
          logTruncated: false,
          pnpmExit: null,
          seenFeed: false,
          done: false,
          result: null,
          error: null,
        });
        setInstalling(true);
        try {
          const payload = await post({
            op: 'updateApply',
            version: version === '' ? undefined : version,
            requestId,
          });
          if (payload.started !== true) {
            /*
             * Nothing to install — the version on disk already is the target.
             * The Host answers in the shape a SETTLED job has, so the same
             * window draws it: no second code path, and the person still gets a
             * window that tells them why nothing happened.
             */
            setJob((prev) => ({
              ...(prev ?? {}),
              requestId: '',
              version: String(payload.version ?? version),
              phase: 'done',
              elapsedMs: 0,
              seenFeed: true,
              done: true,
              result: payload.result ?? null,
              error: null,
            }));
          }
        } catch (failure) {
          // A launch that never started is still a job that ended, and the
          // window has to say so rather than spin forever.
          setJob((prev) =>
            prev === null ? prev : { ...prev, done: true, error: String(failure?.message ?? failure) },
          );
        } finally {
          setInstalling(false);
        }
      }

      async function checkUpdate() {
        setBusy(true);
        try {
          setUpdate(await post({ op: 'updateCheck' }));
        } catch (failure) {
          setUpdate({ error: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      function pickFile(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setBusy(true);
        const reader = new FileReader();
        reader.onload = () => {
          post({ op: 'import', content: String(reader.result ?? '') })
            .then(async (payload) => {
              setNote({ kind: 'ok', text: `${t('saved')} · ${payload.id}.md` });
              await load();
              await loadRoster();
            })
            .catch((failure) => setNote({ kind: 'error', text: `${t('importFailed')}：${failure?.message ?? failure}` }))
            .finally(() => setBusy(false));
        };
        reader.onerror = () => {
          setNote({ kind: 'error', text: t('importFailed') });
          setBusy(false);
        };
        reader.readAsText(file, 'utf8');
      }

      async function batchAction(request) {
        setBusy(true);
        setNote(null);
        try {
          const payload = await post({ op: 'batch', ...request });
          const results = payload.results ?? [];
          const failed = results.filter((row) => row.ok !== true);
          setNote({
            kind: failed.length === 0 ? 'ok' : 'error',
            text: `${results.length - failed.length}/${results.length}${failed.length > 0 ? ` · ${failed[0].error ?? ''}` : ''}`,
          });
          setBatches([]);
          await load();
          await loadHidden();
          await loadRoster();
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      /**
       * Persist one drop.
       *
       * The sequence sent is the one on screen: only the rows the user could see
       * get an explicit `order`, and the Host writes exactly those files.
       */
      async function applyOrder(movedId, targetId) {
        setDragId(null);
        setDropId(null);
        if (movedId === null || targetId === null || movedId === targetId) return;
        const ids = filterAndSort(data === null ? [] : data.files, query).map((row) => row.id);
        const next = reorderIds(ids, movedId, targetId);
        if (next === null) return;
        setBusy(true);
        setNote(null);
        try {
          const payload = await post({ op: 'waifuOrder', ids: next });
          setNote(
            payload.ok === false
              ? { kind: 'error', text: payload.error }
              : { kind: 'ok', text: `${t('reordered')} · ${(payload.changed ?? []).length}` },
          );
          if (payload.ok !== false) {
            await load();
            await loadRoster();
          }
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      /** One request per file, for the same reason `exportAll` does. */
      async function exportSelected() {
        const files = (data === null ? [] : data.files).filter((file) => batches.includes(file.id));
        if (files.length === 0) return;
        setBusy(true);
        setNote(null);
        try {
          for (const file of files) {
            const payload = await post({ op: 'export', id: file.id });
            download(payload.filename ?? `${file.id}.md`, payload.content ?? '');
            await new Promise((resolve) => window.setTimeout(resolve, 250));
          }
          setNote({ kind: 'ok', text: `${t('exportSelected')} ${files.length}` });
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      // A roster whose default sits inside a collapsed group hides the one row
      // the user came to check. Open that group and scroll her into view, once
      // per default: re-running on every `load()` would fight the scrollbar.
      const revealRef = React.useRef('');
      React.useEffect(() => {
        const target = data === null ? undefined : data.files.find((file) => file.id === data.defaultId);
        if (target === undefined) return undefined;
        const field = typeof target.group === 'string' ? target.group.trim() : '';
        const key = field === '' ? UNGROUPED : field;
        setGroupCollapsed((prev) => (prev[key] === true ? { ...prev, [key]: false } : prev));
        if (revealRef.current === data.defaultId) return undefined;
        revealRef.current = data.defaultId;
        const timer = window.setTimeout(() => {
          const node = rootRef.current === null ? null : rootRef.current.querySelector('[data-pw-default="true"]');
          if (node !== null && typeof node.scrollIntoView === 'function') {
            node.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }, 60);
        return () => window.clearTimeout(timer);
      }, [data]);

      const setReorderStored = (value) => {
        const next = value === true;
        setReorderMode(next);
        if (next !== true) {
          setDragId(null);
          setDropId(null);
        }
        try {
          if (next) window.localStorage.setItem(REORDER_KEY, '1');
          else window.localStorage.removeItem(REORDER_KEY);
        } catch (error) {
          // A browser that refuses storage still gets the mode this session.
        }
      };

      const setPageSizeStored = (value) => {
        const next = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
        setPageSize(next);
        setPage(1);
        try {
          if (next === 0) window.localStorage.removeItem(PAGE_SIZE_KEY);
          else window.localStorage.setItem(PAGE_SIZE_KEY, String(next));
        } catch (error) {
          // A browser that refuses storage still gets the setting this session.
        }
      };

      const shared = {
        data,
        t,
        busy,
        note,
        hidden,
        hiddenOpen,
        onToggleHidden: () => {
          setHiddenOpen((prev) => !prev);
          void loadHidden();
        },
        onUnhide: unhide,
        onUnhideAll: unhideAll,
        pageSize,
        onPageSize: setPageSizeStored,
        reorderMode,
        onReorderMode: setReorderStored,
        update,
        installing,
        job,
        onUpdate: startUpdate,
        onAskUpdate: () => setDialog({ kind: 'update' }),
        onAskPurge: () => setDialog({ kind: 'purge' }),
        purgeDir,
        onPurgeDir: (next) => setPurgeDir(next === true),
        onCheck: checkUpdate,
        onClearDefault: () => setDefault({ id: data?.defaultId }, false),
        defaultResolves,
        dirDraft,
        onDirDraft: setDirDraft,
        onSaveDir: saveDir,
        onEditSkeleton: () => {
          void openSkeleton();
        },
        openId,
        skeletonDraft,
        onPatchSkeleton: patchSkeletonDraft,
        onSaveSkeleton: saveSkeleton,
        onOpenSkeleton: openSkeleton,
      };

      const body =
        tab === 'settings'
          ? h(SettingsTab, shared)
          : h(WivesTab, {
              ...shared,
              query,
              onQuery: setQuery,
              hits,
              searching,
              openId,
              draft,
              batches,
              batchMode,
              groupCollapsed,
              onToggleGroup: (key) => setGroupCollapsed((prev) => ({ ...prev, [key]: prev[key] !== true })),
              onOpenRow: openRow,
              onNew: startNew,
              onRefresh: refresh,
              onExportOne: exportOne,
              onExportAll: exportAll,
              onHideOne: (item) => setDialog({ kind: 'hide', item }),
              onSetDefault: setDefault,
              onToggleBatch: () => {
                setBatchMode((prev) => !prev);
                setBatches([]);
              },
              onSelect: (id) => setBatches((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id])),
              onSelectAll: () => setBatches(filterAndSort(data === null ? [] : data.files, query).map((item) => item.id)),
              onClearSelection: () => setBatches([]),
              onBatchHide: () => batchAction({ action: 'hide', ids: batches }),
              onBatchExport: exportSelected,
              dragging: dragId,
              dropTarget: dropId,
              onDragStart: (id) => setDragId(id),
              onDragOver: (id) => setDropId((prev) => (prev === id ? prev : id)),
              onDrop: (id) => applyOrder(dragId, id),
              onDragEnd: () => {
                setDragId(null);
                setDropId(null);
              },
              onImportClick: () => fileInput.current?.click(),
              onDownloadTemplate: downloadTemplate,
              onPatchDraft: patchDraft,
              onCommit: commit,
              onOpenSkeleton: openSkeleton,
              skeletonDraft,
              onPatchSkeleton: patchSkeletonDraft,
              onSaveSkeleton: saveSkeleton,
              page,
              pageSize,
              onPage: setPage,
              brokenById,
            });

      return h(
        'div',
        { style: L.root, ref: rootRef },
        h(
          'div',
          { style: L.bar },
          h(
            'div',
            { style: L.tabs, role: 'tablist' },
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                'aria-selected': tab === 'wives',
                style: { ...L.tabBtn, ...(tab === 'wives' ? L.tabActive : null) },
                onClick: () => setTab('wives'),
              },
              h(Icon, { name: 'users' }),
              t('tabWives'),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                'aria-selected': tab === 'settings',
                style: { ...L.tabBtn, ...(tab === 'settings' ? L.tabActive : null) },
                onClick: () => setTab('settings'),
              },
              h(Icon, { name: 'settings' }),
              t('settings'),
            ),
          ),
          update !== null && update.updateAvailable === true
            ? h(
                'span',
                { style: { ...L.bar, ...L.push } },
                h(
                  TagBox,
                  null,
                  t('updateBanner')
                    .replace('{latest}', update.latest ?? '')
                    .replace('{installed}', update.installed ?? update.running ?? ''),
                ),
                h(Btn, { variant: 'toolbar', onClick: () => setDialog({ kind: 'update' }) }, t('updateGo')),
              )
            : null,
          /*
           * The install strip. This is what makes dismissing the progress
           * window harmless: the same job state lands somewhere the person
           * already looks, with a way back to the full window.
           */
          job !== null && job !== undefined
            ? h(
                'span',
                { style: { ...L.bar, ...L.push } },
                h(
                  TagBox,
                  null,
                  h(
                    'span',
                    { style: job.error === null || job.error === undefined ? L.meta : L.error },
                    updateStripText(job, t),
                  ),
                ),
                h(Btn, { variant: 'toolbar', onClick: () => setDialog({ kind: 'update' }) }, t('updateGo')),
              )
            : null,
        ),
        phase === 'error' ? h('div', { style: L.error }, error) : null,
        body,
        h(Confirm, {
          open: dialog !== null && dialog.kind === 'hide',
          title: t('hideAskTitle'),
          description: `${String(dialog?.item?.name ?? '')} · ${t('hideAskBody')}`,
          acknowledgeLabel: t('hideAskAck'),
          confirmLabel: t('hide'),
          cancelLabel: t('cancel'),
          onCancel: () => setDialog(null),
          onConfirm: async () => {
            const target = dialog?.item;
            setDialog(null);
            if (target !== undefined && target !== null) await hideOne(target);
          },
        }),
        h(Confirm, {
          // Only while nothing has started. The moment the install begins, the
          // window below replaces this one IN PLACE — and it stays there.
          open: dialog !== null && dialog.kind === 'update' && job === null,
          title: t('updateAskTitle'),
          description: `${t('nowVersion')} ${update?.installed ?? update?.running ?? '—'} → v${update?.latest ?? ''}. ${t('updateAskBody')}${
            update?.error === undefined || update.error === null || update.error === '' ? '' : `\n${t('updateAskFailed')}：${update.error}`
          }`,
          acknowledgeLabel: t('updateAskAck'),
          confirmLabel: `${t('doUpdate')} v${update?.latest ?? ''}`,
          cancelLabel: t('cancel'),
          onCancel: () => setDialog(null),
          onConfirm: async () => {
            /*
             * Deliberately NOT `setDialog(null)`. The progress window takes
             * over in the same slot and does not close itself — a window that
             * vanishes on the click is exactly how 「更新完了也不知道更新完没
             * 有」 happens.
             */
            await startUpdate();
          },
        }),
        h(ProgressWindow, {
          open: dialog !== null && dialog.kind === 'update' && job !== null,
          t,
          job,
          // Closing loses nothing: the strip above the roster reads the same
          // state, and a result that arrives later still lands there.
          onClose: () => setDialog(null),
          onRetry: () => {
            void startUpdate();
          },
        }),
        h(Confirm, {
          open: dialog !== null && dialog.kind === 'purge',
          title: t('purgeAskTitle'),
          description: `${t('purgeAskBody')}${purgeDir === true ? `\n${t('purgeWithDir')}` : ''}`,
          acknowledgeLabel: t('purgeAskAck'),
          confirmLabel: t('purge'),
          cancelLabel: t('cancel'),
          onCancel: () => setDialog(null),
          onConfirm: async () => {
            setDialog(null);
            await purgeNow();
          },
        }),
        h('input', { ref: fileInput, type: 'file', accept: '.md,text/markdown', style: L.hidden, onChange: pickFile }),
      );
    }

    function Panel(props) {
      return h(PanelBoundary, null, h(PanelBody, props));
    }

    let translate = () => undefined;

    return {
      // `slots` and `locale` only: the panel talks to the Host over the HTTP
      // route, so no `remote` / `commands` dependency is declared — and the
      // settings slot would never supply a session id for them anyway.
      inject: ['slots', 'locale'],
      apply(ctx) {
        for (const [locale, dict] of Object.entries(DICT)) {
          try {
            ctx.locale.register(NS, locale, dict);
          } catch (error) {
            ctx.logger?.warn?.(`dsh-waifu-agents: locale ${locale} 注册失败：${error?.message ?? error}`);
          }
        }
        try {
          translate = ctx.locale.bind(NS);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-waifu-agents: locale bind 失败：${error?.message ?? error}`);
        }
        // `locale: NS` lets the slot framework bind our dictionary, and `label`
        // is a FIXED plugin identity — it must not follow the UI language.
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, id: NS, order: 20, locale: NS, label: () => 'waifu-agents' }, Panel),
        );

        /** The dictionary, with the Chinese fallback the panel already uses. */
        const tr = (key) => {
          let found;
          try {
            found = translate(key);
          } catch (error) {
            found = undefined;
          }
          if (typeof found === 'string' && found.length > 0) return found;
          const local = DICT.zh[key];
          return typeof local === 'string' ? local : key;
        };

        /**
         * One roster row as the picker wants it.
         *
         * `active` is what marks the persona this session is actually talking
         * as; the platform's own popup draws the check mark from it.
         */
        const pickerRow = (row, state) => ({
          id: row.id,
          label: row.name ?? row.id,
          ...(typeof row.description === 'string' && row.description !== '' ? { detail: row.description } : null),
          ...(row.isDefault === true ? { badge: tr('pickBadgeDefault') } : null),
          ...(state !== null && state.active === row.id ? { active: true } : null),
          group: {
            name: typeof row.group === 'string' && row.group !== '' ? row.group : '__none__',
            label: typeof row.group === 'string' && row.group !== '' ? row.group : tr('pickUngrouped'),
          },
        });

        /** Ask the Host for the roster plus this session's current answer. */
        const pickerState = async (sessionId) =>
          await post({ op: 'waifuState', sessionId: typeof sessionId === 'string' ? sessionId : '' });

        ctx.inject(['commandUi', 'sessions'], (scope) => {
          const commandUi = scope.get('commandUi');
          const sessions = scope.sessions;
          if (commandUi === undefined || commandUi === null) return;
          scope.effect(
            () =>
              commandUi.decorate({
                name: 'waifu-change',
                available: () => true,
                ui: {
                  // The literal is a producer convention: dispatch is
                  // `kind === 'action' ? action : popup`.
                  kind: 'popupSelect',
                  searchMode: 'fuzzy-label',
                  searchLabels: () => ({
                    placeholder: tr('pickPlaceholder'),
                    empty: tr('pickEmpty'),
                    noResults: tr('pickNoResults'),
                  }),
                  options: async (session) => {
                    const state = await pickerState(session?.sessionId);
                    if (state.ok !== true) throw new Error(state.error ?? tr('pickEmpty'));
                    return (state.rows ?? []).map((row) => pickerRow(row, state));
                  },
                  // The popup never feeds the picked value back into the command,
                  // so this runs the Host command itself: that is also what puts
                  // the switch in the session log, where the transcript shows it.
                  onSelect: async (option, session) => {
                    const live = sessions?.binding?.(session?.sessionId)?.session;
                    if (live === undefined) throw new Error(tr('pickNoSession'));
                    const result = await live.command(`/waifu-change ${option.id}`);
                    if (result?.ok !== true) {
                      throw new Error(`${tr('pickSwitchFailed')}：${result?.error?.message ?? 'unknown'}`);
                    }
                  },
                },
              }),
            'waifu-agents: /waifu-change picker',
          );
        });

        ctx.inject(['inputTriggers'], (scope) => {
          const inputTriggers = scope.get('inputTriggers');
          if (inputTriggers === undefined || inputTriggers === null) return;
          scope.effect(
            () =>
              inputTriggers.registerSource({
                trigger: '@',
                name: 'persona',
                order: 20,
                showGroupTitle: true,
                async candidates(session, request) {
                  const state = await pickerState(session?.sessionId);
                  if (state.ok !== true) return [];
                  const needle = String(request?.query ?? '').trim().toLowerCase();
                  return (state.rows ?? [])
                    .filter(
                      (row) =>
                        needle === '' ||
                        String(row.name ?? '').toLowerCase().includes(needle) ||
                        String(row.id ?? '').toLowerCase().startsWith(needle),
                    )
                    .map((row) => ({
                      // `value` is the field the trigger hands back to onPick;
                      // it is never rendered.
                      value: row.id,
                      label: row.name ?? row.id,
                      description: row.isDefault === true ? tr('pickBadgeDefault') : (row.description ?? ''),
                      section: tr('pickSection'),
                    }));
                },
                // Insert the command instead of running it: a candidate pick can
                // only insert text or claim a command, and the composer is where
                // the user still gets to see — and send — what was chosen.
                onPick({ candidate }) {
                  const id = String(candidate?.value ?? '').trim();
                  if (id === '') return undefined;
                  return { text: `/waifu-change ${id}` };
                },
              }),
            'waifu-agents: @ persona source',
          );
        });
      },
    };
  },
});
