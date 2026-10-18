/**
 * dsh-waifu-agents — Client half.
 *
 * One section inside Settings (ordered right after "Agent 预设"), with three panes:
 *   • personas   the roster: search (names AND bodies), groups, in-place editing,
 *            hide/restore, batch actions
 *   • team       the team builder: members (persona or group), background, cap
 *   • settings   left-labelled / right-controlled rows: directory, the shared
 *            skeleton, hidden files, paging, version
 *
 * Transport: `POST /waifu-agents/api`, the route this package's Host half
 * registers. The panel CANNOT use `ctx.remote.commands.execute`:
 * `SettingsSectionOwnerProps` only supplies `close` — no session id ever reaches
 * this component, and that call needs one. An HTTP route needs neither an agent
 * nor a session.
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
    // The platform's settings shell renders `settings.section` entries as a flat
    // nav list; there is no nested "under Agent 预设" slot. We place ourselves
    // immediately after the Agent Preset entry (order 20) so the visual order is
    // as close as the shell allows. The old `settings.plugins.tab` registration
    // is removed — the user wants the page out of "内置插件".
    const SECTION_SLOT = 'settings.section';
    const SECTION_ID = 'waifu-teams';
    const SECTION_ORDER = 25;
    /*
     * The nav entry's name. It is a product name, not a sentence, so it reads
     * the same in every locale; the dictionary still carries it (as
     * `sectionLabel`, the key the label thunk reads) so the locale plumbing the
     * shell already subscribes to stays the one source of the text.
     */
    const SECTION_LABEL = 'waifu agents';
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
    /*
     * The last number the user typed, kept separately from "is paging on".
     * Paging off removes `PAGE_SIZE_KEY` (so a fresh browser starts off), but
     * the toggle has to remember 5 across an off/on cycle instead of snapping
     * back to the default — that was the bug: `onChange(20)`.
     */
    const PAGE_SIZE_LAST_KEY = 'dsh-waifu-agents.pageSizeLast';
    const DEFAULT_PAGE_SIZE = 10;
    /*
     * Legacy only — nothing reads or writes it any more. Reorder mode is
     * session-scoped (see `reorderMode` in `PanelBody`); the constant survives so
     * the mount effect can delete whatever an older build left behind.
     */
    const REORDER_KEY = 'dsh-waifu-agents.reorder';

    const DICT = {
      zh: {
        sectionLabel: 'waifu agents',
        tabWives: '人设',
        tabTeam: '团队',
        tabSettings: '设置',
        search: '搜索名字、简述或正文…',
        add: '新增',
        import: '导入 md',
        exportAll: '导出全部',
        exportOne: '导出这一条',
        exportedPack: '已导出 {count} 个，都在同一个压缩包里：{name}',
        exportSkipped: '{n} 个没导出（文件已经不在了）',
        exportNothing: '没有可导出的文件。',
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
        close: '关闭',
        hide: '隐藏',
        hideAskTitle: '隐藏这个人设？',
        hideAskBody: '她会从名册里消失，文件归档成 <id>.md.off —— **正文一个字都不会删**。想让她回来：设置 → 已隐藏 → 取消隐藏。',
        hideAskAck: '我知道这只是归档，正文会保留',
        hideDone: '已隐藏 {name}',
        hideBatchDone: '已批量隐藏 {names}',
        hideBatchPartial: '已批量隐藏 {names} · 还有 {count} 个没成功：{error}',
        hideBatchAllFailed: '一个都没隐藏成功：{error}',
        hideBatchAskTitle: '隐藏选中的 {count} 个人设？',
        unhideAskTitle: '取消隐藏这个人设？',
        unhideAskBody: '归档的 <id>.md.off 会改回 <id>.md 并重新注册。原来的 id 若已经被新的人设占了，会落到 <id>-2，不会覆盖谁。',
        unhideAskAck: '我知道她会重新出现在名册里',
        unhideDone: '已恢复 {name}',
        unhideBatchDone: '已恢复 {ok}/{total}',
        unhideAllAskTitle: '把隐藏的 {count} 个全部取消隐藏？',
        unhideAllAskBody: '她们会重新回到名册并重新注册。如果某个 id 已经被新的人设占了，会自动改成 <id>-2 这样的名字，不会覆盖谁。',
        unhideAllAskAck: '我知道会一次性把她们全部放回来',
        teamRemoveTitle: '删除这个团队？',
        teamRemoveBody: '团队配置会从 teams.json 里删掉；成员的人设文件不受影响，还在名册里。已经绑定这支队伍的会话会退回单人模式。',
        teamRemoveAck: '我知道删掉之后要重新配一遍',
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
        skeletonSaved: '已保存骨架',
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
        notRegisteredRetry: '没注册上，点「刷新」重试',
        activationFailed: '激活失败',
        loading: '读取中…',
        empty: '这个目录里还没有人设。',
        noMatch: '没有匹配的。',
        bodyHits: '正文命中',
        hitSkeleton: '骨架',
        hitBody: '正文',
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
        defaultSet: '已修改默认人设为「{name}」',
        defaultCleared: '已取消默认——新会话回落到 profile 默认',
        defaultViaEditor: '警告：这次没走 settings 服务，退回配置编辑器写的。磁盘上是对的，但平台收不到通知，新任务页可能不跟——看日志里那条 warn。',
        defaultUnresolved: '这个默认指不到任何可用的人设——新建会话会直接失败（agent-preset/not-found），不是悄悄回落。插件会把它清掉，让新会话回落到 profile 默认。',
        defaultHealed: '默认「{from}」已经不在名册里了——留着它新建会话会被 agent-preset/not-found 直接挡掉。已自动清掉，新会话现在用「{to}」。',
        defaultHealedNobody: '默认「{from}」已经不在名册里了——留着它新建会话会被 agent-preset/not-found 直接挡掉。已自动清掉，新会话回落到 profile 默认。',
        defaultHealedMoved: ' 还没开口的会话也一起换过去了。',
        defaultHealFailed: '默认「{from}」已经不在名册里了，新建会话会被 agent-preset/not-found 直接挡掉——但这次没能自动清掉：{reason}。去「设置 → Agent Presets」重新选一个。',
        pickPlaceholder: '搜人设名…',
        pickEmpty: '这个人设目录里还没有可用的人设。',
        pickNoResults: '没有匹配的人设。',
        pickNoSession: '这个会话还没准备好，等它开出来再试。',
        pickBadgeDefault: '全局默认',
        pickUngrouped: '未分组',
        pickSection: '人设',
        pickSwitchFailed: '切换失败',
        /* The `/waifu-team` popup. Keyed separately from the persona popup:
           they answer different questions and a shared "empty" line would say
           the wrong thing when the roster is full but no team exists yet. */
        pickTeamPlaceholder: '搜团队名…',
        pickTeamEmpty: '还没有团队。先到设置 → 团队 里建一个。',
        pickTeamNoResults: '没有匹配的团队。',
        pickTeamSection: '团队',
        dragToReorder: '拖这里调整顺序（会写进文件的 order）',
        liveSessions: '个正在开着的会话下一轮就会跟着变',
        skeletonLive: '改这里会立刻影响**所有已经开着**的人设会话：它们的正文下一轮就会按这份骨架重新组装（不再遵守「只对新会话生效」）。',
        reordered: '顺序已保存',
        reorderTitle: '拖拽排序',
        reorderHint: '打开后整行都能拖：拖到另一行上就保存顺序。开着的时候行内的按钮和展开会锁住，避免误触；关掉就恢复正常。这个开关**不会被记住**——每次打开面板都是关的。',
        purge: '彻底清理',
        purgeHint: '把本插件留在文件系统里的东西一次清掉：会话覆盖记录、全局默认人设指向。打开右边开关会连人设目录一起删。',
        purgeWithDir: '连人设目录一起删',
        purgeAskTitle: '彻底清理本插件的数据',
        purgeAskBody: '会删除：会话覆盖记录、全局默认人设指向。安装日志、pnpm 索引、pnpm-workspace.yaml 里的放行记录属于平台，这里不动它们，清理完会列给你。',
        purgeAskAck: '我知道这会清掉本插件的数据',
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
        teamTitle: '团队',
        teamHint: '写进 teams.json，所有会话共用。',
        teamLoading: '读取中…',
        teamUnreadable: '读不出来——这不是「一个队都没有」，是这次没读到。',
        teamEmpty: '还没有存过团队。',
        teamNew: '新建团队',
        teamEdit: '编辑',
        teamRemove: '删除',
        teamSave: '保存',
        teamCancel: '取消',
        teamName: '名字',
        teamNameRequired: '团队得有一个名字。',
        teamBackground: '背景',
        teamBackgroundHint: '每次讨论都带着。写她们彼此的关系、已知的事、不能越过的设定——成员看不到主对话，只信这一栏。',
        teamSelection: '成员',
        teamSelectionHint: '人设和组都行。组是每次运行时重新解析的，谁在组里就是谁。',
        teamNoSelection: '一个人都没加，这样的队等于空队。',
        teamAddPersona: '加人设',
        teamAddGroup: '加组',
        /* `teamThinking*` used to name the stage/narrated switch. The control is
           gone, so the strings are gone: a key left behind is a key a future
           reader will wire up again. */
        teamUnitPerson: '人',
        teamUnresolved: '解析失败',
        teamUnitGroup: '组',
        teamGone: '已经不存在了',
        teamClipped: '超出上限被截断',
        teamSolo: '只解析到一个人，按单人模式跑',
        teamGroups: '这个目录里现在有的组',
        teamPreviewFailed: '这个名字现在解析不出来',
        teamCap: '人数上限',
        teamCapHint: '留空 = 不设限；小于 2 不是团队',
        teamCapPolicy: '超限怎么办',
        teamCapRefuse: '超出就不跑',
        teamCapTruncate: '超出取前几个',
        teamReload: '重新读文件',
        teamReloaded: '已重新读文件并重新注册',
        teamBindNote: '上线/下线是会话级的，面板改不了它——用 /waifu-team。',
        teamPresetNote: '每个团队也是一个预设，会出现在新建会话时的模式列表里；选了它，这个会话一出生就在团队模式。',
        /* The team row's default switch. Same field as the persona rows
           (`selectedDefault`), so the tooltip has to say 「二选一」 out loud —
           otherwise turning this on looks like a second, coexisting default. */
        teamDefaultTitle: '新会话默认用这一队（人设那边的默认会一起取消——平台只有一格）',
        teamDefaultSet: '已修改默认团队为「{name}」',
        teamNoPreset: '还没注册成预设，设不了默认——点「重新读文件」重试',
        teamListTitle: '已存的团队',
        teamPickHint: '点一下勾选，再点一下取消。存的是人设 id，改名也不断。',
        teamPickEmpty: '这个目录里还没有能加的人设。',
        teamStale: '不在目录里了',
        teamStaleHint: '这些已经选不上，但还占着队伍名额。删掉或者改回目录里有的名字。',
        teamUnitGone: '已失效',
        teamCapPolicyHint: '上限 3 却点到 5 个人时：「超出就不跑」= 这一轮整队不跑；「超出取前几个」= 只留名单里靠前的 3 个，其余跳过并点名。',
        teamEditingNew: '新建团队',
        teamEditingOne: '编辑团队',
      },
      en: {
        sectionLabel: 'waifu agents',
        tabWives: 'Wives',
        tabTeam: 'Teams',
        tabSettings: 'Settings',
        search: 'Search name, summary or body…',
        add: 'New',
        import: 'Import md',
        exportAll: 'Export all',
        exportOne: 'Export this file',
        exportedPack: 'Exported {count} personas as one archive: {name}',
        exportSkipped: '{n} skipped (the file is gone)',
        exportNothing: 'Nothing to export.',
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
        close: 'Close',
        hide: 'Hide',
        hideAskTitle: 'Hide this persona?',
        hideAskBody: 'She leaves the roster and the file becomes <id>.md.off — **not one word of the text is deleted**. To bring her back: Settings → Hidden → Unhide.',
        hideAskAck: 'I understand this only archives her, the text stays',
        hideDone: 'Hidden {name}',
        hideBatchDone: 'Hidden {names}',
        hideBatchPartial: 'Hidden {names} · {count} more failed: {error}',
        hideBatchAllFailed: 'Not one of them was hidden: {error}',
        hideBatchAskTitle: 'Hide the {count} selected personas?',
        unhideAskTitle: 'Unhide this persona?',
        unhideAskBody: 'The archived <id>.md.off turns back into <id>.md and is registered again. If that id is now taken by a newer persona it lands on <id>-2 instead of overwriting her.',
        unhideAskAck: 'I understand she shows up in the roster again',
        unhideDone: 'Restored {name}',
        unhideBatchDone: 'Restored {ok}/{total}',
        unhideAllAskTitle: 'Unhide all {count} hidden personas?',
        unhideAllAskBody: 'They come back into the roster and get registered again. If one id is now taken by a newer persona it lands on <id>-2 instead of overwriting her.',
        unhideAllAskAck: 'I understand this brings all of them back at once',
        teamRemoveTitle: 'Delete this team?',
        teamRemoveBody: 'The team entry is removed from teams.json; the member persona files are untouched and stay in the roster. Sessions bound to this team fall back to single-persona mode.',
        teamRemoveAck: 'I understand I would have to set it up again',
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
        skeletonSaved: 'Skeleton saved',
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
        notRegisteredRetry: 'registration did not land — press Refresh',
        activationFailed: 'activation failed',
        loading: 'Loading…',
        empty: 'No wife in this directory yet.',
        noMatch: 'Nothing matches.',
        bodyHits: 'Body matches',
        hitSkeleton: 'skeleton',
        hitBody: 'body',
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
        defaultSet: 'Default persona is now "{name}"',
        defaultCleared: 'Default cleared — new sessions fall back to the profile default',
        defaultViaEditor: 'Warning: this went through the config editor instead of the settings service. The disk is right, but the platform was not told, so the new-task screen may not follow — see the warning in the log.',
        defaultUnresolved: 'This default points at no usable persona, so a new session fails outright with agent-preset/not-found — it does NOT fall back to the first row. The plugin clears it, and new sessions go back to the profile default.',
        defaultHealed: 'The default "{from}" is no longer in the roster, so new sessions would be refused with agent-preset/not-found. It has been cleared; new sessions now use "{to}".',
        defaultHealedNobody: 'The default "{from}" is no longer in the roster, so new sessions would be refused with agent-preset/not-found. It has been cleared, and new sessions fall back to the profile default.',
        defaultHealedMoved: ' The sessions that had not opened a turn were moved with it.',
        defaultHealFailed: 'The default "{from}" is no longer in the roster, so new sessions are refused with agent-preset/not-found — and clearing it did not work: {reason}. Pick another one under Settings → Agent Presets.',
        pickPlaceholder: 'Search personas…',
        pickEmpty: 'No usable persona in this directory yet.',
        pickNoResults: 'No persona matches.',
        pickNoSession: 'This session is not ready yet — try again once it is open.',
        pickBadgeDefault: 'default',
        pickUngrouped: 'Ungrouped',
        pickSection: 'personas',
        pickSwitchFailed: 'Switch failed',
        pickTeamPlaceholder: 'Search teams…',
        pickTeamEmpty: 'No teams yet — create one under Settings → Teams.',
        pickTeamNoResults: 'No team matches.',
        pickTeamSection: 'teams',
        dragToReorder: 'Drag to reorder (writes order: into the file)',
        liveSessions: 'live sessions pick this up next turn',
        skeletonLive: 'Editing this immediately affects **every open** persona session: their text is re-assembled from this skeleton on their next turn (the "new sessions only" rule no longer holds).',
        reordered: 'Order saved',
        reorderTitle: 'Drag to reorder',
        reorderHint: 'On, a whole row can be dragged: drop it on another to save the order. While it is on, that row\'s buttons and expanding are locked so a stray click cannot fight the drag; off restores them. This switch is **not remembered** — it starts off every time the panel opens.',
        purge: 'Purge',
        purgeHint: 'Remove everything this plugin left on disk in one go: the session override store and the global-default pointer. The switch on the right also deletes the persona directory.',
        purgeWithDir: 'Also delete the persona directory',
        purgeAskTitle: 'Purge this plugin\'s data',
        purgeAskBody: 'Deletes the session override store and the global-default pointer. The install logs, the pnpm store index and the release-age allow-list entry belong to the platform and are listed afterwards instead of touched.',
        purgeAskAck: 'I know this removes the plugin\'s data',
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
        teamTitle: 'teams',
        teamHint: 'stored in teams.json, shared by every session.',
        teamLoading: 'reading…',
        teamUnreadable: 'unreadable — this is not “you have no teams”, it is “this read failed”.',
        teamEmpty: 'no team has been saved yet.',
        teamNew: 'new team',
        teamEdit: 'edit',
        teamRemove: 'delete',
        teamSave: 'save',
        teamCancel: 'cancel',
        teamName: 'name',
        teamNameRequired: 'a team needs a name.',
        teamBackground: 'background',
        teamBackgroundHint: 'Carried into every discussion. Their relation to each other, what is already known, what must not be broken — members never see the main conversation, so this is the only thing they trust.',
        teamSelection: 'members',
        teamSelectionHint: 'personas or groups. A group re-resolves on every run — whoever carries the tag, that is who runs.',
        teamNoSelection: 'not one member added; a team like this resolves to nothing.',
        teamAddPersona: 'add persona',
        teamAddGroup: 'add group',
        teamUnitPerson: 'members',
        teamUnresolved: 'unresolved',
        teamUnitGroup: 'group',
        teamGone: 'no longer exists',
        teamClipped: 'clipped by the cap',
        teamSolo: 'only one resolved — runs in single mode',
        teamGroups: 'groups this directory has right now',
        teamPreviewFailed: 'this name does not resolve right now',
        teamCap: 'size cap',
        teamCapHint: 'blank = no cap; under 2 is not a team',
        teamCapPolicy: 'when over the cap',
        teamCapRefuse: 'skip the run',
        teamCapTruncate: 'keep the first few',
        teamReload: 're-read the file',
        teamReloaded: 're-read and re-registered',
        teamBindNote: 'going on/off duty is per-session; this panel cannot set it — use /waifu-team.',
        teamPresetNote: 'every team is also a preset, so it shows up in the mode list when a session is created — pick it there and the session is born in team mode.',
        teamDefaultTitle: 'make this team the default for new sessions (this clears the persona default — the platform has one slot)',
        teamDefaultSet: 'Default team is now "{name}"',
        teamNoPreset: 'not registered as a preset yet, so it cannot be the default — hit "re-read the file"',
        teamListTitle: 'saved teams',
        teamPickHint: 'click to tick, click again to clear. The id is stored, so a rename does not break it.',
        teamPickEmpty: 'this directory has no persona to add yet.',
        teamStale: 'gone from the directory',
        teamStaleHint: 'these can no longer be picked but still hold a slot. Drop them, or rename them back to something the directory has.',
        teamUnitGone: 'unresolvable',
        teamCapPolicyHint: 'cap 3 but 5 were named: "skip the run" drops the whole team this turn; "keep the first few" takes the first 3 in listed order, skips the rest and names them.',
        teamEditingNew: 'new team',
        teamEditingOne: 'editing team',
      },
    };

    /*
     * i18n key resolution · BEGIN
     *
     * One key, resolved once. This is a factory rather than a one-line guard at
     * each call site because of the middle case, which is not hypothetical.
     *
     * `ctx.locale.bind(ns)` hands back THE KEY ITSELF when nothing matches: the
     * host's own `translate` ends in `lookup(...) ?? lookup('common', ...) ?? key`
     * (verified in `dsh-client-locale/lib/client.js`). So a guard that only asks
     * "did we get a non-empty string?" accepts `'tabTeam'` as a translation and
     * the Chinese table underneath is never reached — the panel prints the KEY
     * where it means "team", and every label degrades together with it. Comparing
     * the answer against the key is the only thing that separates "the host
     * translated this" from "the host shrugged"; the two are otherwise byte-for-
     * byte identical.
     *
     * Order, and why: the host's dictionary first, so a real translation wins in
     * whatever language the app is actually set to; the Chinese table second, so
     * a host that answers with keys still gets words; the key itself last, so a
     * missing string looks obviously wrong instead of silently blank.
     */
    const makeResolveKey = (chinese, read) => (key) => {
      let found;
      try {
        found = read(key);
      } catch (error) {
        found = undefined;
      }
      if (typeof found === 'string' && found.length > 0 && found !== key) return found;
      const local = chinese[key];
      return typeof local === 'string' ? local : key;
    };
    /* i18n key resolution · END */

    const resolveKey = makeResolveKey(DICT.zh, (key) => translate(key));

    /*
     * The settings nav row's text. The dictionary is the source; SECTION_LABEL
     * is the floor for a runtime whose locale service answers with the key
     * itself, which is what `bind` does for any key it cannot find.
     */
    const navLabel = () => {
      const text = resolveKey('sectionLabel');
      return typeof text === 'string' && text !== '' && text !== 'sectionLabel' ? text : SECTION_LABEL;
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
       * rebuilds the node. That is exactly the reported "after switching default
       * personas several times, the chosen border style leaves residue and
       * vanishes again on re-entry".
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
      /* A field that just refused a save. Border only: repainting the surface
         would make it look disabled rather than wrong. */
      inputBad: {
        borderColor: 'var(--dsw-alias-state-error-primary)',
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
      /*
       * The team tab's picker chips. `pickChip` has to declare `background`
       * and `color` up front — same rule as `item`/`switch` above. Without the
       * resting `background`, switching a chip off again would leave React
       * clearing a longhand and the browser repainting it transparent, i.e. a
       * chip that still looks picked.
       */
      pickChip: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 9px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderColor: 'var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
      },
      pickChipOn: {
        background: 'var(--dsw-alias-brand-primary)',
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
      },
      /*
       * The team editor's candidate list.
       *
       * A `pickChip` grid was the wrong shape for this and it showed: eleven
       * personas as pills read as a tag cloud, and the two grids (personas / groups)
       * looked like two unrelated widgets. What the editor is asking is "tick
       * the ones you want", so it draws as rows with a checkbox, the same way
       * every other multi-select on a settings page does.
       *
       * `pickBox` declares `borderColor` in the resting state for the same
       * reason as `pickChip`: a longhand left to React to clear repaints as
       * transparent, and an unticked box that still looks ticked is worse than
       * no box at all.
       */
      pickList: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        maxHeight: '260px',
        overflowY: 'auto',
      },
      pickRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid transparent',
        borderColor: 'transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: '20px',
        cursor: 'pointer',
        textAlign: 'left',
      },
      pickRowOn: {
        background: 'var(--dsw-alias-bg-layer-2)',
        borderColor: 'var(--dsw-alias-brand-primary)',
      },
      pickBox: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        width: '16px',
        height: '16px',
        borderRadius: '4px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderColor: 'var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'transparent',
        fontSize: '11px',
        lineHeight: '1',
      },
      pickBoxOn: {
        background: 'var(--dsw-alias-brand-primary)',
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
      },
      pickRowMeta: {
        marginLeft: 'auto',
        flex: '0 0 auto',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      /*
       * A full-width row for the two blocks inside the team editor that cannot
       * be 「left title / right control」: the member grid needs the whole line.
       * Same padding and same rule colour as `settingRow`, so the column still
       * reads as one settings list.
       */
      sectionRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '10px 2px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      sectionHead: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      teamLine: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'baseline', fontSize: '11px', lineHeight: 1.5 },
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
      downloadBlob(filename, new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    }

    /**
     * Hand bytes the browser already has as base64 to the browser as a download.
     *
     * The archive comes back base64 over the same JSON route (one request, one
     * body); turning it back into a Blob here is what makes it ONE download —
     * one save dialog, one folder, instead of one per persona.
     */
    function downloadBase64(filename, base64, mime) {
      const binary = window.atob(String(base64 ?? ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      downloadBlob(filename, new Blob([bytes], { type: mime }));
    }

    function downloadBlob(filename, blob) {
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
      /*
       * The roster tab is ONE person, not a group of them. The shell's own
       * settings nav sits next to this panel and already reads as "users", and
       * a tab that repeats the glyph beside it stops saying "these are the
       * people you can edit" and starts looking like a copy of the section
       * you are already standing in.
       */
      person: 'IconUserOutlineRegular',
      roster: 'IconAgentPresetOutlineRegular',
      browse: 'IconBrowseOutlineRegular',
      deliver: 'IconDeliverDocRegular',
    };

    function Icon({ name, size = 15 }) {
      const component = primitives === null ? undefined : primitives[ICONS[name]];
      if (typeof component !== 'function') return null;
      return h(component, { size });
    }

    /**
     * An eye, drawn here because the icon set has no preview glyph.
     *
     * Every row action is a 16px pictogram and the neighbours are a download
     * arrow and an archive box; the only document-shaped glyphs left in the set
     * are more documents, which is exactly what preview must not look like —
     * "look at it" and "save it to disk" would become the same picture. So this
     * one is drawn to the set's own measurements (16-unit box, 1.3 stroke) and
     * inherits `currentColor`, so it sits in the row without announcing itself
     * as hand-made.
     */
    function EyeIcon({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          'aria-hidden': true,
        },
        h('path', {
          d: 'M1.5 8C3.1 4.9 5.4 3.4 8 3.4C10.6 3.4 12.9 4.9 14.5 8C12.9 11.1 10.6 12.6 8 12.6C5.4 12.6 3.1 11.1 1.5 8Z',
        }),
        h('circle', { cx: 8, cy: 8, r: 2.15 }),
      );
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
     * The panel's one notice slot, drawn with the platform's own toast.
     *
     * It used to be a green (or red) line of text inside the persona list. That
     * had two problems. It scrolled away with the roster, and it lived inside
     * ONE tab — so a refusal raised by the team editor, which replaces the list
     * while it is open, was rendered nowhere at all and the save looked like it
     * did nothing. A toast is portalled to `document.body` by the platform, so
     * it is visible from every tab and every dialog.
     *
     * `key` is a per-show sequence rather than the text: the platform restarts
     * the hold/fade cycle when the component remounts, and saving the same file
     * twice must look like two confirmations, not one that never went away.
     */
    function ToastNotice({ toast, onDone }) {
      if (toast === null || toast === undefined) return null;
      if (primitives === null || typeof primitives.Toast !== 'function') return null;
      return h(primitives.Toast, {
        key: toast.key,
        text: toast.text,
        /* Success brings its own circled check; a failure has to be told apart
           from a confirmation at a glance, so it gets the warning glyph. */
        tone: toast.kind === 'ok' ? 'success' : undefined,
        icon:
          toast.kind === 'ok'
            ? undefined
            : typeof primitives.IconWarningOutlineRegular === 'function'
              ? h(primitives.IconWarningOutlineRegular, null)
              : undefined,
        // A refusal that names what broke needs longer to read than "已保存".
        holdMs: toast.kind === 'ok' ? 1800 : 6000,
        onDone,
      });
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
     * and freezes reads as "stuck", so each phase creeps toward its own
     * ceiling as the clock runs — and nothing reaches 100 while the job is
     * still going, so a full bar means "really done" and nothing else.
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
     * point — "finished updating but no way to tell" is precisely what a window that
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
            // "close" after the result is in. Dismissing early is still allowed,
            // and the roster strip keeps the outcome reachable (see above).
            done !== true ? h(Btn, { variant: 'toolbar', disabled: true }, t('updateWaiting')) : null,
            failed === true ? h(Btn, { variant: 'outline', onClick: onRetry }, t('updateRetry')) : null,
            h('div', { style: L.push }),
            h(Btn, { variant: done === true ? 'primary' : 'outline', onClick: onClose }, t('updateClose')),
          ),
        ),
      );
    }

    /**
     * Read a persona without opening the editor.
     *
     * The same text the model would receive, rendered — which is why it is a
     * window of its own rather than a mode inside the textarea: the editor holds
     * a draft with unsaved keystrokes in it, and a preview that reads from the
     * draft can never be what the model sees. This one is fetched from the Host
     * (`get` again), so it shows the file as it is on disk with the skeleton
     * poured in — and `openPreview` waits for the autosave the click itself
     * triggered, so "on disk" means "including what you just typed".
     */
    function PreviewWindow({ open, title, text, loading, error, t, onClose }) {
      if (open !== true) return null;
      const content =
        loading === true
          ? h('span', { style: L.hint }, t('loading'))
          : typeof error === 'string' && error !== ''
            ? h('span', { style: L.error }, error)
            : h(
                'div',
                { style: { ...L.textarea, overflow: 'auto', maxHeight: '62vh', minHeight: '160px' } },
                h(Markdown, { text: text ?? '' }),
              );
      /*
       * The platform's own dialog, like the confirmations next to it — the same
       * mask, the same close button, the same Escape handling. A hand-rolled
       * overlay next to a platform dialog is two dialogs wearing one panel.
       */
      if (primitives !== null && typeof primitives.Modal === 'function') {
        return h(primitives.Modal, { open: true, onClose, title, closeLabel: t('close'), children: content });
      }
      return h(
        'div',
        { style: L.overlay, onClick: onClose },
        h(
          'div',
          {
            style: { ...L.dialog, maxWidth: '560px', width: '100%' },
            // The backdrop closes it; a click that landed on the window itself
            // — reading, selecting text — must not.
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { style: L.bar },
            h('span', { style: L.rowTitle }, title),
            h('div', { style: L.push }),
            h(Btn, {
              variant: 'toolbar',
              size: 'sm',
              icon: h(Icon, { name: 'close', size: 16 }),
              title: t('close'),
              'aria-label': t('close'),
              style: { padding: '0 6px' },
              onClick: onClose,
            }),
          ),
          content,
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

    /**
     * Left description, a rule, then the controls — the settings-page shape.
     *
     * `align: 'top'` exists for controls taller than one line: a textarea pinned
     * to the vertical centre of a two-line description puts its first row next
     * to the hint's second, and the label stops reading as the label. Only the
     * row's own cross-axis alignment changes, so every other row is untouched.
     */
    function SettingRow({ title, hint, children, align }) {
      const top = align === 'top';
      return h(
        'div',
        { style: top ? { ...L.settingRow, alignItems: 'flex-start' } : L.settingRow },
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
              /*
               * The box only ever edits. Preview used to be a tab here, which
               * made the editor two things at once: a place to type and a
               * place to look. Reading is now a row action, so this area has
               * exactly one mode and no state to remember.
               */
              h('textarea', {
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
      onPreview,
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
          /*
           * No group tag on the row. Every row is rendered inside the group
           * header that already spells the group out, so the chip only ever
           * repeated the line above it — the same word twice, one of them
           * dressed as if it were a second, independent attribute.
           */
          problems.length > 0 ? h('span', { style: L.error }, t('problems')) : null,
          /*
           * Two sentences, because there are two facts here and only one of them
           * is knowable from the panel. `foreign` means the last scan actually
           * saw another owner holding this id; without it the honest statement is
           * 「没注册上」. The single line this replaces blamed another owner for
           * what was usually this plugin's own re-registration still in flight —
           * a false accusation drawn on a row that was working fine.
           */
          problems.length === 0 && item.owned !== true && (broken === null || broken === undefined)
            ? h(
                'span',
                { style: L.error },
                `${t('notRegistered')} · ${item.foreign === true ? t('takenByOther') : t('notRegisteredRetry')}`,
              )
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
            icon: h(EyeIcon, null),
            title: t('preview'),
            'aria-label': t('preview'),
            /*
             * Not disabled while `busy`. Reading does not fight the writer, and
             * the click that opened this also triggered the autosave (blur
             * fires first) — disabling here would swallow exactly that click.
             * `openPreview` waits for the write instead.
             */
            disabled: locked,
            style: { padding: '0 6px' },
            onClick: onPreview,
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
            h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'unarchive' }), disabled: busy, onClick: () => onUnhide(file) }, t('unhide')),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------ team mode */

    /**
     * What a stored team resolves to *right now*.
     *
     * The selection is what was written down; this is what it currently points
     * at. `teams.json` holds names, and the roster is a live query over the
     * directory, so a persona deleted yesterday is still in the file and still
     * listed — this line is the only place that says it is gone. An unresolvable
     * name is reported as unresolvable rather than as an empty team, and the
     * groups that *do* exist are offered straight away, because the usual cause
     * is a rename.
     */
    function TeamPreview({ preview, t }) {
      if (preview === null || preview === undefined || preview.ok !== true) {
        return h(
          'div',
          { style: L.teamLine },
          h('span', { style: L.error }, `${t('teamPreviewFailed')}：${preview?.error ?? ''}`),
          (preview?.hint ?? []).length === 0
            ? null
            : h('span', { style: L.hint }, `${t('teamGroups')}：${(preview.hint ?? []).join('、')}`),
        );
      }
      const notes = [];
      if (preview.single === true) notes.push(t('teamSolo'));
      if ((preview.removed ?? []).length > 0) notes.push(`${t('teamGone')}：${preview.removed.join('、')}`);
      if ((preview.truncated ?? []).length > 0) notes.push(`${t('teamClipped')}：${preview.truncated.join('、')}`);
      for (const notice of preview.notices ?? []) notes.push(notice);
      if (notes.length === 0) return null;
      return h(
        'div',
        { style: L.teamLine },
        ...notes.map((text, index) => h('span', { key: `n${index}`, style: L.hint }, text)),
      );
    }

    /**
     * The editor for one team.
     *
     * Deliberately local: nothing here reaches `teams.json` until save. A
     * half-typed name must never be written, or a typo becomes a team that every
     * session can pick and nothing can resolve.
     */
    /**
     * The team editor.
     *
     * `problem` is the field that stopped the last save (`'name'` or
     * `'selection'`), or `null`. It is drawn NEXT TO the field it is about,
     * because a refusal that only appears as a toast in the top corner leaves
     * the user staring at a form that looks complete — the save did nothing and
     * nothing on the form says why.
     */
    function TeamDraftCard({ draft, t, busy, rows, groups, onPatch, onSave, onCancel, problem }) {
      const has = (kind, ref) => draft.selection.some((one) => one.kind === kind && one.ref === ref);
      const toggle = (kind, ref) =>
        onPatch({
          selection: has(kind, ref)
            ? draft.selection.filter((one) => !(one.kind === kind && one.ref === ref))
            : [...draft.selection, { kind, ref }],
        });
      /*
       * Picking appends the persona's **id**, never its display name. `ref`
       * accepts either (`expandSelection` falls back to a name lookup), but a
       * stored name breaks the moment somebody renames the file, while an id
       * survives it — and the id is what the drift report compares.
       *
       * The candidates draw as ROWS with a checkbox, not as chips. A grid of
       * eleven persona pills read as a tag cloud and, worse, looked like a
       * different widget from the group grid next to it; what the editor is
       * asking is "tick the ones you want". The ticked row also carries its
       * position, because "take the first few past the limit" keeps the EARLIEST entries — an order
       * the user can only act on if it is on screen.
       */
      const candidate = ({ kind, ref, label, meta }) => {
        const on = has(kind, ref);
        const at = draft.selection.findIndex((one) => one.kind === kind && one.ref === ref);
        return h(
          'button',
          {
            key: `${kind}:${ref}`,
            type: 'button',
            role: 'option',
            'aria-selected': on === true,
            style: on ? { ...L.pickRow, ...L.pickRowOn } : L.pickRow,
            onClick: () => toggle(kind, ref),
          },
          h('span', { style: on ? { ...L.pickBox, ...L.pickBoxOn } : L.pickBox }, on ? String(at + 1) : ''),
          h('span', { style: L.grow }, label),
          meta === null || meta === '' ? null : h('span', { style: L.pickRowMeta }, meta),
        );
      };
      const block = (title, list, hint = null) => {
        if (list.length === 0) return null;
        const on = list.filter((one) => has(one.kind, one.ref)).length;
        return h(
          'div',
          { style: L.sectionRow },
          h(
            'div',
            { style: L.sectionHead },
            h('span', { style: L.rowTitle }, title),
            h('span', { style: L.meta }, `${on} / ${list.length}`),
            hint === null ? null : h('span', { style: L.hint }, hint),
          ),
          h(
            'div',
            { style: L.pickList, role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': title },
            ...list.map(candidate),
          ),
        );
      };
      /*
       * A stored entry the directory no longer carries — a renamed persona, a
       * group tag nobody has. It cannot appear in either candidate list, so a
       * picker-only editor would hide it while it keeps counting towards the
       * team. Shown separately and removable, because "it is gone" is the one
       * fact about this row the user cannot get anywhere else.
       */
      const stale = draft.selection.filter(
        (one) =>
          !(
            (one.kind === 'persona' && rows.some((row) => row.id === one.ref)) ||
            (one.kind === 'group' && groups.includes(one.ref))
          ),
      );
      /*
       * The header counts PEOPLE, not picked rows: one group entry can carry
       * three wives, so `selection.length` printed 「1 人」 for a trio — the
       * exact number the user then corrected by hand. Resolved the same way
       * the Host expands: `group:` equality for group entries, the id for
       * persona entries (the picker only ever stores ids). A stale entry
       * resolves to nothing here, which is consistent with the grey block
       * below that says it is gone.
       */
      const picked = new Set();
      for (const one of draft.selection) {
        if (one.kind === 'group') {
          for (const row of rows) {
            if (one.ref !== '' && groupOf(row) === one.ref) picked.add(row.id);
          }
        } else if (rows.some((row) => row.id === one.ref)) {
          picked.add(one.ref);
        }
      }
      const named = String(draft.name ?? '') !== '';
      return h(
        'div',
        { style: L.card },
        h(
          'div',
          { style: L.bar },
          h('span', { style: L.groupLabel }, named ? t('teamEditingOne') : t('teamEditingNew')),
          named ? h('span', { style: L.meta }, draft.name) : null,
        ),
        h(
          SettingRow,
          /* No example in the hint and no placeholder either: the name is the
             one thing the user already knows, and a sample string invites
             typing it. */
          { title: t('teamName') },
          h('input', {
            type: 'text',
            style: { ...L.input, minWidth: '200px', ...(problem === 'name' ? L.inputBad : null) },
            value: draft.name ?? '',
            disabled: busy,
            'aria-invalid': problem === 'name',
            onChange: (event) => onPatch({ name: event.target.value }),
          }),
          /* `flexBasis: 100%` puts the refusal on its own line under the field:
             the row is right-aligned, so an inline span would read as another
             hint about the row rather than as "this field is the problem". */
          problem === 'name'
            ? h('span', { style: { ...L.error, flexBasis: '100%', textAlign: 'right' } }, t('teamNameRequired'))
            : null,
        ),
        /* The team's standing background, written once and carried into every
           discussion. It is a textarea, not an input, because the useful value
           here is a sentence or two about the members' relation to each other —
           the exact thing the user has to state when the personas themselves
           never mention it (Thor and Kanna share a roof; neither will say what
           they are to each other). Members only ever read their own session, so
           this field is the one place that fact can live. */
        h(
          SettingRow,
          { title: t('teamBackground'), hint: t('teamBackgroundHint'), align: 'top' },
          h('textarea', {
            style: { ...L.input, minWidth: '260px', minHeight: '64px', resize: 'vertical', lineHeight: '1.5' },
            value: draft.background ?? '',
            disabled: busy,
            rows: 3,
            onChange: (event) => onPatch({ background: event.target.value }),
          }),
        ),
        h(
          'div',
          { style: L.sectionRow },
          h(
            'div',
            { style: L.sectionHead },
            h('span', { style: L.rowTitle }, t('teamSelection')),
            h('span', { style: L.meta }, `${picked.size} ${t('teamUnitPerson')}`),
            h('span', { style: L.hint }, t('teamSelectionHint')),
          ),
          draft.selection.length === 0
            ? h('span', { style: problem === 'selection' ? L.error : L.hint }, t('teamNoSelection'))
            : null,
        ),
        block(
          t('teamAddPersona'),
          rows.map((row) => ({
            kind: 'persona',
            ref: row.id,
            label: row.name || row.id,
            meta: row.group === '' || row.group === null || row.group === undefined ? null : row.group,
          })),
          t('teamPickHint'),
        ),
        block(
          t('teamAddGroup'),
          groups.map((ref) => ({ kind: 'group', ref, label: ref, meta: t('teamUnitGroup') })),
        ),
        rows.length === 0 && groups.length === 0
          ? h('div', { style: L.sectionRow }, h('span', { style: L.hint }, t('teamPickEmpty')))
          : null,
        stale.length === 0
          ? null
          : h(
              'div',
              { style: L.sectionRow },
              h(
                'div',
                { style: L.sectionHead },
                h('span', { style: L.rowTitle }, t('teamStale')),
                h('span', { style: L.hint }, t('teamStaleHint')),
              ),
              h(
                'div',
                { style: L.pickList },
                ...stale.map((one) =>
                  h(
                    'div',
                    { key: `stale:${one.kind}:${one.ref}`, style: L.pickRow },
                    h('span', { style: L.grow }, `${one.ref}`),
                    h('span', { style: L.pickRowMeta }, t('teamUnitGone')),
                    h(
                      Btn,
                      { variant: 'toolbar', disabled: busy, onClick: () => toggle(one.kind, one.ref) },
                      t('teamRemove'),
                    ),
                  ),
                ),
              ),
            ),
        h(
          'div',
          { style: { ...L.bar, justifyContent: 'flex-end', paddingTop: '2px' } },
          h(Btn, { variant: 'primary', disabled: busy, onClick: onSave }, t('teamSave')),
          h(Btn, { variant: 'toolbar', disabled: busy, onClick: onCancel }, t('teamCancel')),
        ),
      );
    }

    /**
     * The team directory, and only that.
     *
     * There is no "go live" button here, and that is a boundary rather than an
     * omission: the settings slot hands this panel no session id, so it cannot
     * know which session a binding would apply to. Binding is therefore owned by
     * `/waifu-team` — the panel writes the file, the command writes one session,
     * and the note at the bottom says so instead of leaving the user to guess
     * why there is no switch.
     *
     * The editor REPLACES the list while it is open. Drawn the old way — editor
     * on top, list still underneath — the tab showed one team twice, once being
     * edited and once as saved, and nothing on screen said which was which.
     */
    function TeamSection({ team, t, busy, draft, onOpen, onPatch, onSaveDraft, onCancelDraft, onRemove, onDefault, defaultId, fieldProblem }) {
      if (team === null) {
        return h('div', { style: L.card }, h('span', { style: L.hint }, t('teamLoading')));
      }
      if (team.ok !== true) {
        return h(
          'div',
          { style: L.card },
          h('span', { style: L.error }, `${t('teamUnreadable')}${team.error ? `：${team.error}` : ''}`),
        );
      }
      const problem =
        team.problem === null || team.problem === undefined ? null : h('span', { style: L.error }, team.problem);
      if (draft !== null) {
        return h(
          'div',
          { style: L.list },
          problem,
          h(TeamDraftCard, {
            draft,
            t,
            busy,
            rows: team.rows,
            groups: team.groups,
            onPatch,
            onSave: onSaveDraft,
            onCancel: onCancelDraft,
            problem: fieldProblem,
          }),
        );
      }
      if (team.teams.length === 0) {
        return h('div', { style: L.list }, problem, h('div', { style: L.card }, h('span', { style: L.hint }, t('teamEmpty'))));
      }
      return h(
        'div',
        { style: L.list },
        problem,
        h(
          'div',
          { style: L.sectionHead },
          h('span', { style: L.rowTitle }, t('teamListTitle')),
          h('span', { style: L.meta }, `${team.teams.length}`),
        ),
        ...team.teams.map((entry) => {
          /*
           * The same switch the persona rows carry, reading the same platform
           * field: `selectedDefault` holds ONE preset id, and a team is an
           * agent preset too (`presetId`). So this is not a second default —
           * turning it on is what turns the persona default off, which is why
           * the row is marked exactly like the persona row that owns it
           * (`L.itemDefault`) and why the tooltip says so.
           */
          const isDefault = defaultId !== null && defaultId !== undefined && entry.presetId === defaultId;
          /*
           * Three states, not two. `presetId` missing altogether means the Host
           * predates this switch (`teamState` not reporting it), so nothing is
           * drawn — an older host must not be shown a disabled control claiming
           * 「还没注册」 about a team that is registered fine. `''` is the real
           * "not registered" case and keeps the switch, disabled, next to the
           * reason.
           */
          const known = typeof entry.presetId === 'string';
          const noPreset = known && entry.presetId === '';
          return h(
            'div',
            {
              key: entry.name,
              style: { ...L.item, ...(isDefault ? L.itemDefault : null) },
              'data-pw-team': entry.name,
              ...(isDefault ? { 'data-pw-team-default': 'true' } : null),
            },
            h(
              'div',
              { style: L.head },
              h('span', { style: L.name }, entry.name),
              /*
               * Resolved headcount, not selection entries: a team picked as one
               * group of three is 「3 人」, and a drifted group reports the
               * failure instead of a wrong number — the full error renders
               * right below in TeamPreview.
               */
              h(
                'span',
                { style: L.meta },
                entry.preview?.ok === true
                  ? `${entry.preview.members.length} ${t('teamUnitPerson')}`
                  : t('teamUnresolved'),
              ),
              // No preset, no switch: a default has to name something the
              // registry holds, and this team is not registered yet (the sync
              // is in flight, or it failed). Saying which is `teamNoPreset`.
              noPreset ? h('span', { style: L.hint }, t('teamNoPreset')) : null,
              h('span', { style: L.push }),
              known
                ? h(SwitchBox, {
                  checked: isDefault,
                  disabled: busy || noPreset,
                  title: t('teamDefaultTitle'),
                  onChange: (next) => onDefault(entry, next),
                })
                : null,
              h(
                Btn,
                { variant: 'toolbar', icon: h(Icon, { name: 'settings' }), disabled: busy, onClick: () => onOpen(entry) },
                t('teamEdit'),
              ),
              h(
                Btn,
                { variant: 'toolbar', disabled: busy, onClick: () => onRemove(entry.name) },
                t('teamRemove'),
              ),
            ),
            h(TeamPreview, { preview: entry.preview, t }),
          );
        }),
      );
    }

    /**
     * The Team tab — a peer of personas and settings, not a block inside settings.
     *
     * It was a section at the bottom of the settings list, which read as an
     * afterthought: the settings page is 「one row, one switch」 all the way
     * down, and a directory with its own editor does not belong at the end of
     * that list. What DOES belong is the page's row language, so the three
     * things that really are settings — where the file is, what the cap is,
     * what happens past the cap — are drawn as ordinary `SettingRow`s, and the
     * directory itself sits between them as content.
     */
    function TeamTab({ team, t, busy, draft, onOpen, onPatch, onSaveDraft, onCancelDraft, onRemove, onReload, onBatch, onDefault, defaultId, fieldProblem }) {
      const [batch, setBatch] = React.useState(null);
      const loaded = team !== null && team.ok === true;
      const cap = batch === null ? String((loaded ? team.batch.maxTeamSize : null) ?? '') : batch.cap;
      const policy = batch === null ? (loaded ? team.batch.groupCapPolicy : 'refuse') : batch.policy;
      return h(
        'div',
        { style: L.list },
        h(
          SettingRow,
          { title: t('teamTitle'), hint: t('teamHint') },
          loaded ? h('span', { style: L.meta }, `${team.teams.length}`) : null,
          h(Btn, { variant: 'toolbar', icon: h(Icon, { name: 'refresh' }), disabled: busy, onClick: onReload }, t('teamReload')),
          h(Btn, { variant: 'primary', icon: h(Icon, { name: 'plus' }), disabled: busy, onClick: () => onOpen(null) }, t('teamNew')),
        ),
        h(TeamSection, {
          team,
          t,
          busy,
          draft,
          onOpen,
          onPatch,
          onSaveDraft,
          onCancelDraft,
          onRemove,
          onDefault,
          defaultId,
          fieldProblem,
        }),
        h(
          SettingRow,
          { title: t('teamCap'), hint: t('teamCapHint') },
          h('input', {
            type: 'number',
            min: 2,
            style: { ...L.input, width: '72px' },
            value: cap,
            disabled: busy || loaded === false,
            onChange: (event) => setBatch({ cap: event.target.value, policy: policy }),
          }),
          h(
            Btn,
            { variant: 'toolbar', disabled: busy, onClick: () => onBatch(cap === '' ? null : Number(cap), policy, setBatch) },
            t('teamSave'),
          ),
        ),
        h(
          SettingRow,
          { title: t('teamCapPolicy'), hint: t('teamCapPolicyHint') },
          h(Segmented, {
            value: policy,
            options: [
              { value: 'refuse', label: t('teamCapRefuse') },
              { value: 'truncate', label: t('teamCapTruncate') },
            ],
            onChange: (value) => setBatch({ cap, policy: value }),
          }),
        ),
        h('span', { style: L.hint }, t('teamBindNote')),
        h('span', { style: L.hint }, t('teamPresetNote')),
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

    /**
     * The one-line report for a default the Host had to repair.
     *
     * A default that names a preset nothing registers is not cosmetic: the
     * registry refuses EVERY new session with `agent-preset/not-found`
     * (`registry.js:643`), so this has to be said even though the user did not ask
     * — and it has to distinguish "fixed" from "not fixed", because only the second
     * one leaves new sessions still refusing to open.
     * @param {{ ok: boolean, from?: string, nowDefault?: string | null, moved?: string[], reason?: string } | null | undefined} heal
     * @param {(key: string) => string} t
     */
    function healNote(heal, t) {
      if (heal === null || heal === undefined) return null;
      const from = heal.from ?? '';
      if (heal.ok !== true)
        return t('defaultHealFailed')
          .replace('{from}', from)
          .replace('{reason}', heal.reason ?? '');
      const to = typeof heal.nowDefault === 'string' ? heal.nowDefault : '';
      const base =
        to === ''
          ? t('defaultHealedNobody').replace('{from}', from)
          : t('defaultHealed').replace('{from}', from).replace('{to}', to);
      return (heal.moved ?? []).length > 0 ? base + t('defaultHealedMoved') : base;
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
      /* A team's name when the default names one, else `null` — see `shared`. */
      defaultTeamName,
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
          /*
           * The field holds a PRESET id, and a team's id is `团队-<名字>`
           * (`teamPresetIdFor`). Printing that raw is technically right and
           * reads like a persona slug — so when the id is one of the teams on
           * the team tab, the row says who it is instead.
           */
          h(
            'span',
            { style: L.meta },
            defaultTeamName === null || defaultTeamName === undefined
              ? (data?.defaultId ?? '—')
              : `${t('teamTitle')}：${defaultTeamName}`,
          ),
          h(Btn, { variant: 'toolbar', disabled: busy || data?.defaultId == null, onClick: onClearDefault }, t('clearDefault')),
        ),
        /*
         * A default that resolves to no live row is the failure the platform never
         * reports: the service throws `agent-preset/not-found` at session creation
         * (`registry.js:643`) — the composer's "fall to first item" fallback is never
         * reached — so every new task is refused with nothing on screen to explain
         * it. The Host clears it on open; these two lines are the report.
         */
        defaultResolves === false
          ? h('div', { style: L.card }, h('span', { style: L.error }, t('defaultUnresolved')))
          : null,
        data?.defaultHeal != null
          ? h(
              'div',
              { style: L.card },
              h(
                'span',
                { style: data.defaultHeal.ok === true ? L.ok : L.error },
                healNote(data.defaultHeal, t),
              ),
            )
          : null,
        h(
          SettingRow,
          { title: t('paging'), hint: t('pagingHint') },
          h(SwitchBox, {
            checked: pageSize > 0,
            /*
             * Flip on with the number the user last typed, not a hard-coded 20.
             * `readLastPageSize` falls back to `DEFAULT_PAGE_SIZE` (10) only
             * when nothing was ever entered.
             */
            onChange: (next) => onPageSize(next === true ? readLastPageSize() : 0),
          }),
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
      );
    }

    /**
     * What to call a row inside a sentence.
     *
     * Every "已隐藏 X" / "已恢复 X" used to spend its second half on plumbing the
     * user never asked about — `rin.md.off`, or the id, or worse `undefined` when
     * a file has no usable front matter. The name when there is one, the id when
     * there is not, and never an empty string inside quotes.
     */
    function rowName(row, fallback = '') {
      const named = String(row?.name ?? '').trim();
      if (named !== '') return named;
      const id = String(row?.id ?? '').trim();
      if (id !== '') return id;
      return String(fallback ?? '');
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

    /**
     * Pack **whole groups** into pages, up to `size` rows each.
     *
     * Paging used to slice the flat, sorted row list, so a group could be cut
     * in half: 3 people under `素晴` landed as two on page 1 and one on page 2.
     * That reads as two different groups on screen. A group is a unit here —
     * when it does not fit in the remaining room, it starts on the next page
     * whole. A single group larger than `size` still gets its own page and
     * overflows it; splitting it is the thing we are deliberately avoiding.
     *
     * @param {Array<{key: string, label: string, rows: object[]}>} groups
     * @param {number} size positive row budget per page
     * @returns {Array<Array<{key: string, label: string, rows: object[]}>>}
     */
    function paginateGroups(groups, size) {
      const pages = [];
      let page = [];
      let count = 0;
      for (const group of groups) {
        if (count > 0 && count + group.rows.length > size) {
          pages.push(page);
          page = [];
          count = 0;
        }
        page.push(group);
        count += group.rows.length;
      }
      if (page.length > 0) pages.push(page);
      return pages.length > 0 ? pages : [[]];
    }

    /** Which page holds row `id`, or -1 when it is not in any of them. */
    function pageOfRow(pages, id) {
      return pages.findIndex((groups) => groups.some((group) => group.rows.some((row) => row.id === id)));
    }

    function readStoredPageSize() {
      try {
        const value = Number(window.localStorage.getItem(PAGE_SIZE_KEY));
        return Number.isFinite(value) && value > 0 ? value : 0;
      } catch (error) {
        return 0;
      }
    }

    /**
     * The size to use when the user flips paging **on**.
     *
     * Reads the dedicated "last value" key first, then the enabled key (so an
     * older install that only stored `PAGE_SIZE_KEY` still keeps its number),
     * then `DEFAULT_PAGE_SIZE`. 20 was the old hard-coded fallback and is too
     * tall for the roster; 10 is the default now.
     */
    function readLastPageSize() {
      try {
        const last = Number(window.localStorage.getItem(PAGE_SIZE_LAST_KEY));
        if (Number.isFinite(last) && last > 0) return last;
        const current = Number(window.localStorage.getItem(PAGE_SIZE_KEY));
        if (Number.isFinite(current) && current > 0) return current;
      } catch (error) {
        // Storage refused: the session still gets the default below.
      }
      return DEFAULT_PAGE_SIZE;
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
        onPreviewOne,
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
      } = props;
      const files = data === null ? [] : data.files;
      const visible = filterAndSort(files, query);
      /*
       * Group **before** paging, not after. Slicing the flat list first is what
       * split `素晴` across two pages; a page is now a set of whole groups.
       */
      const allGroups = groupRows(visible);
      let groups;
      let pageCount;
      let current;
      if (pageSize > 0) {
        const pages = paginateGroups(allGroups, pageSize);
        pageCount = pages.length;
        current = Math.min(Math.max(1, page), pageCount);
        groups = pages[current - 1] ?? [];
      } else {
        pageCount = 1;
        current = 1;
        groups = allGroups;
      }
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
                      onPreview: () => onPreviewOne(item),
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
      /**
       * The panel's single notice slot.
       *
       * The shape is unchanged (`{ kind, text }`) so the fifty-odd `setNote`
       * call sites did not have to move; what changed is where it is drawn.
       * It used to be an inline line inside the persona list — which scrolled
       * away, and which the team tab never rendered at all, so a refused team
       * save produced no visible feedback anywhere. `ToastNotice` draws the same
       * value with the platform's toast, portalled above the whole panel.
       */
      const [toast, setToast] = React.useState(null);
      const toastSeq = React.useRef(0);
      const setNote = React.useCallback((next) => {
        if (next === null || next === undefined) {
          setToast(null);
          return;
        }
        const text = String(next.text ?? '');
        if (text === '') return;
        toastSeq.current += 1;
        setToast({ key: toastSeq.current, text, kind: next.kind === 'ok' ? 'ok' : 'error' });
      }, []);
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
      /**
       * The row being read, or null.
       *
       * A separate slot from `dialog`: those are gates that ask before doing
       * something, this one only shows text, and it must survive the roster
       * refreshing underneath it.
       */
      const [peek, setPeek] = React.useState(null);
      /** The purge row's second checkbox: whether the persona directory goes too. */
      const [purgeDir, setPurgeDir] = React.useState(false);
      const [batches, setBatches] = React.useState([]);
      const [batchMode, setBatchMode] = React.useState(false);
      const [groupCollapsed, setGroupCollapsed] = React.useState({});
      const [hidden, setHidden] = React.useState([]);
      const [hiddenOpen, setHiddenOpen] = React.useState(false);
      /** The team directory (`teamState`), or null before the first read. */
      const [team, setTeam] = React.useState(null);
      /** The team being edited, or null when the editor is closed. */
      const [teamDraft, setTeamDraft] = React.useState(null);
      /**
       * Which field the last refused save pointed at (`'name'` / `'selection'`).
       *
       * Cleared as soon as the draft changes: the hint is about the value the
       * save was refused for, and leaving it up while the user is fixing that
       * value reads as "still wrong". Re-checked on the next attempt.
       */
      const [teamProblem, setTeamProblem] = React.useState(null);
      const [teamBusy, setTeamBusy] = React.useState(false);
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
      /*
       * Reorder mode is **not** remembered. It used to be: the switch wrote
       * `localStorage`, so whoever turned it on once found it on every time the
       * panel opened afterwards — from their side that is indistinguishable from
       * "drag sorting is on by default", and the mode is dangerous (it locks the
       * row and writes `order` into every file you drop on). It starts off every
       * time, which is the only thing "off by default" can mean for a mode like
       * this.
       */
      const [reorderMode, setReorderMode] = React.useState(false);

      const rootRef = React.useRef(null);
      const draftRef = React.useRef(null);
      const skeletonRef = React.useRef(null);
      const openRef = React.useRef(null);
      const idAlias = React.useRef(new Map());
      const fileInput = React.useRef(null);
      /**
       * The autosave currently in flight, if any.
       *
       * Clicking the eye blurs the textarea first, and blur is what starts the
       * save — so without this the preview races the write it just triggered
       * and shows the file one keystroke behind. Preview is a read of the disk,
       * and a read has to wait for the write in front of it.
       */
      const savingRef = React.useRef(null);

      const t = React.useCallback((key) => resolveKey(key), []);

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
          // reported as "cannot point at anyone".
          setDefaultResolves(typeof payload.defaultResolves === 'boolean' ? payload.defaultResolves : null);
        } catch (failure) {
          // A roster we cannot read is not a broken panel: the rows keep the
          // `owned` flag they already carry.
          setDefaultResolves(null);
        }
      }, []);

      /**
       * The team directory, as the Settings panel sees it.
       *
       * Directory only — see `TeamSection`. A read that fails leaves `team` at
       * `null`, and the section renders its "cannot read" line rather than an empty
       * list: an empty list would read as "you have no teams", which is a different
       * claim from "cannot read".
       */
      const loadTeam = React.useCallback(async () => {
        try {
          setTeam(await post({ op: 'teamState' }));
        } catch (failure) {
          setTeam({ ok: false, error: String(failure?.message ?? failure) });
        }
      }, []);

      /** One write at a time; the reply carries the fresh state back. */
      const mutateTeam = React.useCallback(
        async (request, done) => {
          setTeamBusy(true);
          try {
            const payload = await post({ op: 'teamSet', ...request });
            if (payload.state !== undefined) setTeam(payload.state);
            /*
             * …and the persona roster, because a team write can move the
             * default: renaming a team follows it to the new preset id, deleting
             * one clears it (see `teamSet`). The persona rows draw their switch
             * from `data.defaultId`, so without this read the tab the user came
             * from keeps showing a default that is no longer one.
             */
            void load();
            setNote({ kind: 'ok', text: typeof done === 'function' ? done(payload) : t('saved') });
            return true;
          } catch (failure) {
            setNote({ kind: 'error', text: String(failure?.message ?? failure) });
            return false;
          } finally {
            setTeamBusy(false);
          }
        },
        [t, setNote, load],
      );

      /**
       * Open the team editor.
       *
       * `null` means **new**, not **close**. Closing is `onCancelTeam`, and one
       * function doing both would make "new" and "cancel" the same click with a
       * different argument — which is how a "new team" button ends up looking
       * like it did nothing at all.
       */
      const openTeamDraft = React.useCallback((entry) => {
        setTeamProblem(null);
        if (entry === null || entry === undefined) {
          /* `original: ''` — "there was no team before this one". The host uses
             it to tell a rename from a create. */
          setTeamDraft({ original: '', name: '', background: '', selection: [] });
          return;
        }
        setTeamDraft({
          /*
           * The name the editor opened with, carried unchanged.
           *
           * The host keys a save on the NAME, so without this a rename looked
           * exactly like a create: it found no team under the new name, pushed
           * a second entry, and left the old one behind under the old name.
           */
          original: entry.name,
          name: entry.name,
          /* Carried through the editor untouched unless the user edits it: an
             entry opened for a rename must not silently lose its background. */
          background: entry.background ?? '',
          selection: entry.selection.map((one) => ({ kind: one.kind, ref: one.ref })),
        });
      }, []);

      const patchTeamDraft = React.useCallback((changes) => {
        setTeamProblem(null);
        setTeamDraft((prev) => (prev === null ? null : { ...prev, ...changes }));
      }, []);

      /**
       * Validate on the panel, not only on the host.
       *
       * The host does refuse both cases, but its answer arrives as a notice —
       * and a notice alone leaves a form that LOOKS complete still sitting
       * there, which reads as "the button is broken" rather than "a field is
       * missing". So the same two rules are checked here first: the refusal
       * lands next to the field it is about, and nothing is sent.
       */
      const saveTeamDraft = React.useCallback(async () => {
        const draft = teamDraft;
        if (draft === null) return;
        const name = String(draft.name ?? '').trim();
        if (name === '') {
          setTeamProblem('name');
          setNote({ kind: 'error', text: t('teamNameRequired') });
          return;
        }
        if (draft.selection.length === 0) {
          setTeamProblem('selection');
          setNote({ kind: 'error', text: t('teamNoSelection') });
          return;
        }
        setTeamProblem(null);
        const ok = await mutateTeam({
          action: 'save',
          name,
          original: typeof draft.original === 'string' ? draft.original : '',
          team: { selection: draft.selection, background: draft.background ?? '' },
        });
        if (ok) setTeamDraft(null);
      }, [teamDraft, mutateTeam, setNote, t]);

      const removeTeam = React.useCallback(
        async (name) => {
          await mutateTeam({ action: 'remove', name });
        },
        [mutateTeam],
      );

      const batchTeam = React.useCallback(
        async (maxTeamSize, groupCapPolicy, resync) => {
          const ok = await mutateTeam({ action: 'batch', maxTeamSize, groupCapPolicy });
          if (ok && typeof resync === 'function') resync(null);
        },
        [mutateTeam],
      );

      /**
       * The team tab's 「重新读文件」.
       *
       * It used to be a plain `teamState` read, which made the label a lie: the
       * file on disk was never re-read, and a team that had failed to register
       * as a preset stayed unregistered forever — now visible, because a team
       * can only be the new-session default while its preset exists. `reload`
       * re-reads `teams.json`, re-runs the preset sync, and answers with the
       * fresh state, which is the only thing that can repair that row.
       */
      const reloadTeams = React.useCallback(async () => {
        await mutateTeam({ action: 'reload' }, () => t('teamReloaded'));
      }, [mutateTeam, t]);

      React.useEffect(() => {
        /*
         * Retire a stored reorder flag left by an older build. Without this, an
         * install that had the mode on keeps a `'1'` in localStorage forever —
         * harmless today (nothing reads it), but it is exactly the kind of
         * leftover that quietly turns the old behaviour back on if the key ever
         * grows a reader again.
         */
        try {
          window.localStorage.removeItem(REORDER_KEY);
        } catch (error) {
          // No storage, nothing to retire.
        }
        void load();
        void loadRoster();
        void loadHidden();
        void loadTeam();
        post({ op: 'updateCheck' })
          .then((payload) => setUpdate(payload))
          .catch((failure) => setUpdate({ error: String(failure?.message ?? failure) }));
      }, [load, loadRoster, loadHidden, loadTeam]);

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

      /**
       * What a draft would write to the file, as one comparable string.
       *
       * Blur saves unconditionally, so opening a row and clicking away used to
       * fire an `update` for text nobody touched. With notices moved to toasts
       * that also meant a "已保存" banner for every row someone merely looked at.
       * Comparing the outgoing fields against the last saved ones makes "nothing
       * changed" a no-op: no request, no file write, no banner.
       */
      const draftKeyOf = (d) =>
        JSON.stringify([d.name ?? '', d.description ?? '', d.group ?? '', d.template ?? '', d.body ?? '']);

      async function save(next) {
        const current = draftRef.current;
        if (current === null || current.loading === true || next === null || next === undefined) return;
        const isNew = current.mode === 'new';
        if (isNew && !String(next.name ?? '').trim() && !String(next.body ?? '').trim()) return;
        const written = draftKeyOf(next);
        if (current.savedKey === written) return;
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
          if (draftRef.current !== null) {
            patchDraft({
              /*
               * A create that succeeded is no longer "new": the file exists and
               * this draft is now its editor. Leaving `mode: 'new'` meant the
               * next blur issued a second `create` for the same row — the same
               * "one action, two files" failure the team rename had.
               */
              mode: 'edit',
              id: payload.id ?? current.id,
              rev: payload.rev ?? current.rev,
              loading: false,
              savedKey: written,
            });
          }
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
        const saving = save({ ...current });
        savingRef.current = saving;
        // `save` swallows its own errors, so this always settles. Only clear the
        // slot if nobody newer took it.
        void saving.finally(() => {
          if (savingRef.current === saving) savingRef.current = null;
        });
      }, []);

      function closeRow() {
        commit();
        showRow(null);
        putDraft(null);
        setDialog(null);
      }

      /**
       * Show one persona as the model receives her.
       *
       * Reads through the Host instead of the open draft: the draft carries
       * half-typed text that has not been saved, and a preview of unsaved
       * keystrokes would be a preview of nothing the model can see. The `id`
       * check on the way back is the same one `openRow` makes — click two eyes
       * quickly and only the last one may win.
       */
      async function openPreview(item) {
        const id = item.id;
        setPeek({ id, name: item.name ?? id, loading: true, text: '', error: '' });
        try {
          // The blur that opened this window already kicked off a save; reading
          // first would answer with the previous version of the file.
          if (savingRef.current !== null) await savingRef.current;
          const payload = await post({ op: 'get', id, assembled: true });
          setPeek((prev) =>
            prev === null || prev.id !== id
              ? prev
              : { ...prev, loading: false, text: payload.assembled ?? payload.body ?? '' },
          );
        } catch (failure) {
          setPeek((prev) =>
            prev === null || prev.id !== id
              ? prev
              : { ...prev, loading: false, error: String(failure?.message ?? failure) },
          );
        }
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
          rev: null,
          // Until `get` answers, the editor is read-only: saving an empty body
          // in that window used to be rejected by the Host as "response mode cannot be empty"
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
            /* What is on disk now, so a blur without edits writes nothing. */
            savedKey: draftKeyOf(payload),
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
          rev: null,
          loading: false,
          /* Nothing written yet: any non-empty draft differs from this. */
          savedKey: draftKeyOf({}),
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
          /*
           * 「已保存骨架」on its own is the whole answer for the usual save.
           * The two counters that used to be glued on unconditionally (`重新注册
           * 0`) only earn their place when they are not zero: how many personas
           * were re-registered, and how many open sessions will pick the new
           * skeleton up next turn.
           */
          const reregistered = (payload.reloaded ?? []).length;
          const live = payload.liveSessions ?? 0;
          const parts = [t('skeletonSaved')];
          if (reregistered > 0) parts.push(`${t('reloaded')} ${reregistered}`);
          if (live > 0) parts.push(`${live} ${t('liveSessions')}`);
          setNote({ kind: 'ok', text: parts.join(' · ') });
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
       * A batch export is ONE request and ONE download.
       *
       * It used to be a loop: pull a file, hand it to the browser, wait 250 ms,
       * repeat. Twelve personas therefore produced twelve save dialogs and no
       * promise that they landed in the same folder — and a slow one could even
       * be dropped by the browser's "multiple downloads" gate. The Host packs
       * them into a single `.zip` now, so there is exactly one dialog and one
       * destination, and the save location is whatever the user picks for that
       * one file.
       *
       * `ids` is what the caller had selected; an empty list falls back to the
       * whole roster, which is what 「导出全部」 means.
       */
      async function exportPack(ids) {
        const files = data === null ? [] : data.files;
        const wanted = Array.isArray(ids) ? ids : files.map((file) => file.id);
        if (wanted.length === 0) {
          setNote({ kind: 'error', text: t('exportNothing') });
          return;
        }
        setBusy(true);
        setNote(null);
        try {
          const payload = await post({ op: 'exportArchive', ids: wanted });
          downloadBase64(payload.filename ?? 'waifu-personas.zip', payload.base64, 'application/zip');
          const skipped = (payload.missing ?? []).length;
          const head = t('exportedPack')
            .replace('{count}', String(payload.count ?? wanted.length))
            .replace('{name}', String(payload.filename ?? ''));
          setNote({
            kind: 'ok',
            text: skipped === 0 ? head : `${head} · ${t('exportSkipped').replace('{n}', String(skipped))}`,
          });
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      /** 「导出全部」: every visible persona, in one archive. */
      async function exportAll() {
        await exportPack(null);
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
          setNote({ kind: 'ok', text: t('hideDone').replace('{name}', rowName(item)) });
          await load();
          await loadHidden();
          await loadRoster();
        } catch (failure) {
          setNote({ kind: 'error', text: String(failure?.message ?? failure) });
        } finally {
          setBusy(false);
        }
      }

      /** `file` is the hidden row; the archive name is what the Host needs. */
      async function unhide(file) {
        setBusy(true);
        setNote(null);
        try {
          const payload = await post({ op: 'restore', archived: file.archived });
          /*
           * `payload.id` is the id she actually landed on — a newer persona may
           * have taken the old one, and then saying 「已恢复 rin」while the roster
           * shows `rin-2` would read as a failed restore.
           */
          const landed = String(payload?.id ?? '').trim() || rowName(file);
          setNote({ kind: 'ok', text: t('unhideDone').replace('{name}', landed) });
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
          setNote({
            kind: failed === 0 ? 'ok' : 'error',
            text: t('unhideBatchDone')
              .replace('{ok}', String(results.length - failed))
              .replace('{total}', String(results.length)),
          });
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
       * Turn one persona, or one team, into the preset a new session opens on.
       *
       * There is exactly ONE field behind this switch (`selectedDefault`), and
       * a team is an agent preset too — so the two switches in this panel are
       * two views of the same value, never two independent settings. That is
       * the whole reason this function is shared: writing it from the team tab
       * is what unchecks the persona row, and the two refreshes below are what
       * draw the other tab before the user gets back to it.
       *
       * @param {{id?: string, name?: string, isTeam?: boolean}} item the row
       *   that owns the switch — `id` is a persona id or a team PRESET id
       * @param {boolean} next `false` clears the field
       */
      async function setDefault(item, next) {
        const wanted = next === true;
        const id = String(item?.id ?? '');
        /*
         * A team whose preset registration failed has no id to write. The
         * switch is disabled in that case, but a disabled control is not a
         * guarantee (and a stale payload can still carry the old row), so the
         * refusal is said here rather than posted and reported as「id 不合法」.
         */
        if (wanted && id === '') {
          setNote({ kind: 'error', text: t('teamNoPreset') });
          return;
        }
        setBusy(true);
        setNote(null);
        try {
          // `next === false` clears the selection: the registry then falls back
          // to the profile's own default, which is exactly what the settings row
          // shows. Same field as Settings → Agent Presets, so the semantics have
          // to match.
          const answer = await post({ op: 'setDefault', id: wanted ? id : '' });
          await load();
          await loadRoster();
          /*
           * The team tab draws from its own payload, so it has to be reread as
           * well — otherwise setting a persona as the default leaves the team
           * switch on, and the user is told two different things by two tabs of
           * the same panel.
           */
          await loadTeam();
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
           * saying nothing is what turns that into "set a default, but the new session is not her".
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
            /*
             * …and the same value on the team payload. `teamState` refreshes the
             * default itself, but that refresh sits behind a 2-second cache, so
             * a read issued right after the write can answer with the id the
             * user just moved OFF. Landing the Host's verified anchor on both
             * objects is what makes the two tabs agree at this instant instead
             * of one of them healing on the next read.
             */
            setTeam((prev) =>
              prev === null || prev.ok !== true ? prev : { ...prev, defaultId: answer.defaultId },
            );
          }
          /*
           * What the user is told, in the order that matters. A degraded write
           * first, because it is the failure that looks fine from here and is
           * not. Then "nothing here can confirm it". Then a plain statement of
           * what just changed — which name the new-task screen opens on. It used
           * to open with 「也把…换过去了」, a sentence about a side effect that
           * never said which default had been written; the name is the thing the
           * user came to this switch for, so it leads.
           */
          if (answer !== null && answer.via === 'configEditor') {
            setNote({ kind: 'error', text: t('defaultViaEditor') });
          } else if (answer !== null && answer.checkable === false) {
            setNote({ kind: 'error', text: t('defaultUnchecked') });
          } else if (wanted) {
            /*
             * Only the row knows the name — the Host answers in ids. A file with
             * broken front matter has no `name`, and `String(undefined)` would
             * print 「已修改默认人设为「undefined」」, which is worse than the id.
             *
             * A team says 「默认团队」 rather than 「默认人设」: same field, but
             * calling a three-person team a persona is the kind of sentence that
             * makes the user doubt which of the two tabs is authoritative.
             */
            const named = String(item?.name ?? '').trim() || id;
            const key = item?.isTeam === true ? 'teamDefaultSet' : 'defaultSet';
            setNote({ kind: 'ok', text: t(key).replace('{name}', named) });
          } else {
            setNote({ kind: 'ok', text: t('defaultCleared') });
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
            await loadTeam();
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
            // Same two-tab rule as the success path above.
            setTeam((prev) =>
              prev === null || prev.ok !== true ? prev : { ...prev, defaultId: reported.defaultId },
            );
          }
        } finally {
          setBusy(false);
        }
      }

      /**
       * The team tab's switch, routed into the one above.
       *
       * `isTeam` only changes the wording of the toast — the write, the field
       * and the verification are identical, because the platform has one
       * `selectedDefault` and a team is an agent preset like any other. Wrapping
       * it (rather than posting a second op) is what keeps the two tabs from
       * drifting into two implementations of one switch.
       */
      function setTeamDefault(entry, next) {
        return setDefault({ id: entry?.presetId ?? '', name: entry?.name ?? '', isTeam: true }, next === true);
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
       * "updating…" until pnpm returns, with no way to tell a slow install from
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
          /*
           * Name them. "2/2" answered the wrong question: the user just picked
           * two rows out of a list and deserves to see which two are gone, in the
           * same words the single hide uses. A partial failure names the ones
           * that DID go and then counts the rest — never "已批量隐藏" over a batch
           * where some of them are still sitting there.
           */
          const ids = Array.isArray(request?.ids) ? request.ids : [];
          const rows = data === null ? [] : data.files;
          const nameOf = (id) => rowName(rows.find((file) => file.id === id), id);
          const okNames = results.filter((row) => row.ok === true).map((row) => nameOf(row.key));
          const reason = String(failed[0]?.error ?? '');
          const text =
            failed.length === 0
              ? t('hideBatchDone').replace('{names}', ids.map(nameOf).join('，'))
              : okNames.length === 0
                ? t('hideBatchAllFailed').replace('{error}', reason)
                : t('hideBatchPartial')
                    .replace('{names}', okNames.join('，'))
                    .replace('{count}', String(failed.length))
                    .replace('{error}', reason);
          setNote({ kind: failed.length === 0 ? 'ok' : 'error', text });
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

      /** 「导出选中」: the same one-archive path, narrowed to the ticked rows. */
      async function exportSelected() {
        const ids = (data === null ? [] : data.files)
          .filter((file) => batches.includes(file.id))
          .map((file) => file.id);
        if (ids.length === 0) return;
        await exportPack(ids);
      }

      /*
       * A roster whose default sits inside a collapsed group hides the one row
       * the user came to check. Open that group and scroll her into view, once
       * per default: re-running on every `load()` would fight the scrollbar.
       *
       * Paging is the same promise one layer up, and for a while it broke it:
       * the default could be on a page that was not on screen, the scroll then
       * found nothing, and the panel quietly opened on page 1. So the page is
       * chosen first — hers — and the scroll runs against the page that is
       * actually rendered.
       *
       * The guard is keyed on the default AND the page size, because turning
       * paging on starts from page 1 (that is what the switch does) and would
       * otherwise sit on page 1 with the default three pages away.
       */
      const revealRef = React.useRef('');
      React.useEffect(() => {
        const target = data === null ? undefined : data.files.find((file) => file.id === data.defaultId);
        if (target === undefined) return undefined;
        const field = typeof target.group === 'string' ? target.group.trim() : '';
        const key = field === '' ? UNGROUPED : field;
        setGroupCollapsed((prev) => (prev[key] === true ? { ...prev, [key]: false } : prev));
        const revealKey = `${data.defaultId}::${pageSize}`;
        if (revealRef.current === revealKey) return undefined;
        revealRef.current = revealKey;
        if (pageSize > 0) {
          const pages = paginateGroups(groupRows(filterAndSort(data.files, query)), pageSize);
          const index = pageOfRow(pages, data.defaultId);
          if (index >= 0) setPage(index + 1);
        }
        const timer = window.setTimeout(() => {
          const node = rootRef.current === null ? null : rootRef.current.querySelector('[data-pw-default="true"]');
          if (node !== null && typeof node.scrollIntoView === 'function') {
            node.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }, 60);
        return () => window.clearTimeout(timer);
      }, [data, pageSize, query]);

      /**
       * The reorder switch. It sets state and nothing else — the name says so,
       * because the whole bug was that this function also wrote storage and the
       * mode outlived the visit.
       */
      const applyReorder = (value) => {
        const next = value === true;
        setReorderMode(next);
        if (next !== true) {
          setDragId(null);
          setDropId(null);
        }
      };

      const setPageSizeStored = (value) => {
        const next = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
        setPageSize(next);
        setPage(1);
        try {
          if (next === 0) {
            /*
             * Off removes the "enabled" key — a fresh browser starts with
             * paging off — but **keeps** the last size, so flipping back on
             * restores what was typed instead of the default.
             */
            window.localStorage.removeItem(PAGE_SIZE_KEY);
          } else {
            window.localStorage.setItem(PAGE_SIZE_KEY, String(next));
            window.localStorage.setItem(PAGE_SIZE_LAST_KEY, String(next));
          }
        } catch (error) {
          // A browser that refuses storage still gets the setting this session.
        }
      };

      /*
       * The team the current default names, if it names one at all.
       *
       * `selectedDefault` holds a preset id, and a team's is `团队-<名字>`. The
       * settings row would otherwise print that slug where the user expects a
       * name; both payloads are already in hand, so the mapping costs nothing.
       * `null` means "not a team" (a persona, or nothing set) — the row then
       * keeps printing the raw id, exactly as before.
       */
      const defaultTeamName =
        data === null || data.defaultId === null || data.defaultId === undefined || team === null || team.ok !== true
          ? null
          : (team.teams.find((row) => row.presetId === data.defaultId)?.name ?? null);

      const shared = {
        data,
        t,
        defaultTeamName,
        busy,
        hidden,
        hiddenOpen,
        onToggleHidden: () => {
          setHiddenOpen((prev) => !prev);
          void loadHidden();
        },
        onUnhide: (file) => setDialog({ kind: 'unhide', file }),
        onUnhideAll: () => setDialog({ kind: 'unhideAll' }),
        pageSize,
        onPageSize: setPageSizeStored,
        reorderMode,
        onReorderMode: applyReorder,
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

      /*
       * The team tab's props, kept OUT of `shared` on purpose. The team tab is a
       * peer of settings rather than a section of it, and `SettingsTab` no longer
       * accepts a single team prop — passing them in one bag is how the two got
       * entangled last time.
       */
      const teamProps = {
        team,
        t,
        /*
         * `teamBusy` used to be set by every write and read by nobody, so a
         * second click during a save went through — the buttons were disabled
         * on the GLOBAL busy flag, which a team write never raises. Both are
         * folded in here so the tab locks while its own write is in flight.
         */
        busy: teamBusy === true || busy === true,
        draft: teamDraft,
        /* Which field the last refused save pointed at, drawn next to it. */
        fieldProblem: teamProblem,
        onOpen: openTeamDraft,
        onPatch: patchTeamDraft,
        onSaveDraft: saveTeamDraft,
        onCancelDraft: () => setTeamDraft(null),
        onRemove: (name) => setDialog({ kind: 'teamRemove', name }),
        onReload: reloadTeams,
        onBatch: batchTeam,
        /*
         * The default switch, and the value it reads.
         *
         * Same platform field as the persona rows (`selectedDefault`), shipped
         * by `teamState` because the team tab is what draws it; `null` while
         * the directory is unreadable or not loaded yet, which draws every
         * switch off rather than guessing. Turning one on is what turns the
         * persona default off — one field, two tabs.
         */
        onDefault: setTeamDefault,
        defaultId:
          team !== null && team.ok === true && typeof team.defaultId === 'string'
            ? team.defaultId
            : null,
      };

      const body =
        tab === 'team'
          ? h(TeamTab, teamProps)
          : tab === 'settings'
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
              onPreviewOne: openPreview,
              onHideOne: (item) => setDialog({ kind: 'hide', item }),
              onSetDefault: setDefault,
              onToggleBatch: () => {
                setBatchMode((prev) => !prev);
                setBatches([]);
              },
              onSelect: (id) => setBatches((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id])),
              onSelectAll: () => setBatches(filterAndSort(data === null ? [] : data.files, query).map((item) => item.id)),
              onClearSelection: () => setBatches([]),
              onBatchHide: () => setDialog({ kind: 'hideBatch', ids: batches }),
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
              h(Icon, { name: 'person' }),
              t('tabWives'),
            ),
            /*
             * Order is personas · team · settings and the reading is deliberate: the
             * roster is what you come to edit, teams are built out of it, and
             * settings are where you go when something is wrong. The team tab
             * sits next to the roster because a team is a roster arrangement,
             * not a preference.
             */
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                'aria-selected': tab === 'team',
                style: { ...L.tabBtn, ...(tab === 'team' ? L.tabActive : null) },
                onClick: () => setTab('team'),
              },
              h(Icon, { name: 'roster' }),
              t('tabTeam'),
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
              t('tabSettings'),
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
          /*
           * Every destructive door asks the same way. Single hide has asked since
           * the acknowledgement dialog existed; the batch door, "unhide all" and
           * deleting a team used to act on the first click, which is how a stray
           * click during batch mode archived a whole selection with no undo in
           * sight. Same component, same tick box, same wording as the update gate
           * — one gesture to learn, not four.
           */
          open: dialog !== null && dialog.kind === 'hideBatch',
          title: t('hideBatchAskTitle').replace('{count}', String((dialog?.ids ?? []).length)),
          description: t('hideAskBody'),
          acknowledgeLabel: t('hideAskAck'),
          confirmLabel: `${t('hideSelected')} · ${(dialog?.ids ?? []).length}`,
          cancelLabel: t('cancel'),
          onCancel: () => setDialog(null),
          onConfirm: async () => {
            const ids = dialog?.ids ?? [];
            setDialog(null);
            await batchAction({ action: 'hide', ids });
          },
        }),
        h(Confirm, {
          /*
           * Restoring is not destructive, but it is a file rename plus a fresh
           * registration, and the one place where an old id can silently land on
           * `-2`. A single click used to do it; the row is two lines of text in a
           * collapsed section, so a misclick there is easy and the effect is
           * invisible until the roster is reopened.
           */
          open: dialog !== null && dialog.kind === 'unhide',
          title: t('unhideAskTitle'),
          description: `${rowName(dialog?.file)} · ${t('unhideAskBody')}`,
          acknowledgeLabel: t('unhideAskAck'),
          confirmLabel: t('unhide'),
          cancelLabel: t('cancel'),
          onCancel: () => setDialog(null),
          onConfirm: async () => {
            const target = dialog?.file;
            setDialog(null);
            if (target !== undefined && target !== null) await unhide(target);
          },
        }),
        h(Confirm, {
          open: dialog !== null && dialog.kind === 'unhideAll',
          title: t('unhideAllAskTitle').replace('{count}', String(hidden.length)),
          description: t('unhideAllAskBody'),
          acknowledgeLabel: t('unhideAllAskAck'),
          confirmLabel: `${t('unhideAll')} · ${hidden.length}`,
          cancelLabel: t('cancel'),
          onCancel: () => setDialog(null),
          onConfirm: async () => {
            setDialog(null);
            await unhideAll();
          },
        }),
        h(Confirm, {
          open: dialog !== null && dialog.kind === 'teamRemove',
          title: t('teamRemoveTitle'),
          description: `${String(dialog?.name ?? '')} · ${t('teamRemoveBody')}`,
          acknowledgeLabel: t('teamRemoveAck'),
          confirmLabel: t('teamRemove'),
          cancelLabel: t('cancel'),
          onCancel: () => setDialog(null),
          onConfirm: async () => {
            const name = dialog?.name;
            setDialog(null);
            if (typeof name === 'string' && name !== '') await removeTeam(name);
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
             * vanishes on the click is exactly how "finished updating but no way to
             * tell" happens.
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
        h(PreviewWindow, {
          open: peek !== null,
          t,
          title: `${String(peek?.name ?? '')} · ${t('preview')}`,
          text: peek?.text ?? '',
          loading: peek?.loading === true,
          error: peek?.error ?? '',
          onClose: () => setPeek(null),
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
        h(ToastNotice, { toast, onDone: () => setToast(null) }),
        h('input', { ref: fileInput, type: 'file', accept: '.md,text/markdown', style: L.hidden, onChange: pickFile }),
      );
    }

    function Panel(props) {
      return h(PanelBoundary, null, h(PanelBody, props));
    }

    let translate = () => undefined;

    /*
     * The nav glyph problem, and why it is solved here.
     *
     * The settings shell picks a nav icon from the section id alone:
     * `account` → user, `models` → data, `agent-presets` → agent preset,
     * `plugins` → personalization, `archived-sessions` → archive, and every id
     * it does not know — ours included — falls through to the settings gear.
     * A section cannot pass an icon: `settings.section` registers `id`, `order`
     * and `label` and nothing else, and the nav row is built from those three.
     *
     * So the row is repainted instead of re-declared: the button is matched by
     * its own label text, its gear is hidden, and the persona glyph is drawn in
     * the same slot at the shell's own Medium stroke weight (1.3). Nothing React
     * owns is removed or replaced, only an attribute is added to the button and
     * a stylesheet is injected; if the nav's shape ever changes the rule simply
     * matches nothing and the gear stays, which is the failure mode worth
     * having.
     *
     * The glyph is deliberately the TWO-person one, which is no longer what the
     * 人设 tab draws: the nav row is the entry to the whole plugin (personas,
     * teams, settings), while the tab is one person — the individual files you
     * edit. When both were the users glyph, the tab read as a second copy of
     * the row you had just clicked to get here.
     */
    const NAV_ATTR = 'data-waifu-agents-nav';
    const NAV_STYLE_ID = 'dsh-waifu-agents-nav-glyph';
    const NAV_GLYPH =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.3">' +
      '<path d="M6 8.25C7.51878 8.25 8.75 7.01878 8.75 5.5C8.75 3.98122 7.51878 2.75 6 2.75C4.48122 2.75 3.25 3.98122 3.25 5.5C3.25 7.01878 4.48122 8.25 6 8.25Z"/>' +
      '<path d="M1 14.5C1 11.5 3.5 10.25 6 10.25C8.5 10.25 11 11.5 11 14.5"/>' +
      '<path d="M10.5 2.9C11.65 3.35 12.45 4.35 12.45 5.5C12.45 6.65 11.65 7.65 10.5 8.1"/>' +
      '<path d="M12.4 10.6C13.9 11.3 15 12.6 15 14.5"/>' +
      '</svg>';

    /**
     * Mark the nav row carrying `label`, so the stylesheet can redraw its glyph.
     *
     * @param label - the exact label text the row shows.
     */
    function markNavRow(label) {
      for (const button of document.querySelectorAll('button')) {
        if (button.getAttribute(NAV_ATTR) !== null) continue;
        // A nav row is an icon plus a label; anything else is not ours.
        if (button.querySelector(':scope > svg') === null) continue;
        if ((button.textContent ?? '').trim() !== label) continue;
        button.setAttribute(NAV_ATTR, '');
      }
    }

    /**
     * Keep our nav row's glyph in step with the panel's persona icon.
     *
     * The row only exists while the settings modal is open, so the work is a
     * debounced sweep over a MutationObserver rather than a timer: the modal is
     * portalled into `document.body` and re-renders whenever the nav rows do.
     *
     * @param label - the row's label text.
     * @returns a disposer.
     */
    function watchNavGlyph(label) {
      const noop = () => undefined;
      if (typeof document === 'undefined' || typeof document.body === 'undefined' || document.body === null) return noop;
      if (typeof MutationObserver !== 'function') return noop;
      const style = document.createElement('style');
      style.id = NAV_STYLE_ID;
      const mask = `url("data:image/svg+xml,${encodeURIComponent(NAV_GLYPH)}")`;
      style.textContent = [
        `button[${NAV_ATTR}] > svg { display: none; }`,
        `button[${NAV_ATTR}]::before {`,
        `  content: '';`,
        `  flex: none;`,
        `  width: 16px;`,
        `  height: 16px;`,
        `  background: currentColor;`,
        `  -webkit-mask: ${mask} center / 16px 16px no-repeat;`,
        `  mask: ${mask} center / 16px 16px no-repeat;`,
        `}`,
      ].join('\n');
      let timer = 0;
      const sweep = () => {
        try {
          markNavRow(label);
        } catch (error) {
          /* nav chrome only: a miss leaves the gear in place */
        }
      };
      const observer = new MutationObserver(() => {
        if (timer !== 0) return;
        timer = setTimeout(() => {
          timer = 0;
          sweep();
        }, 200);
      });
      try {
        observer.observe(document.body, { childList: true, subtree: true });
        document.head.appendChild(style);
        sweep();
      } catch (error) {
        return noop;
      }
      return () => {
        observer.disconnect();
        if (timer !== 0) clearTimeout(timer);
        try {
          style.remove();
        } catch (error) {
          /* already gone */
        }
      };
    }

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
        /*
         * Settings page entry. The shell renders `settings.section` as a flat
         * nav list, so we cannot literally nest under "Agent 预设"; we order
         * ourselves right after it (Agent preset uses order 20) so we appear
         * immediately below it. If the shell does not declare this slot, the
         * panel simply does not appear — guarded so it cannot take the rest down.
         */
        try {
          ctx.slots.inject(SECTION_SLOT, () =>
            ctx.slots.register(
              {
                name: SECTION_SLOT,
                id: SECTION_ID,
                order: SECTION_ORDER,
                locale: NS,
                label: () => navLabel(),
              },
              Panel,
            ),
          );
        } catch (error) {
          ctx.logger?.warn?.(`dsh-waifu-agents: 设置页入口注册失败：${error?.message ?? error}`);
        }
        try {
          ctx.effect(() => watchNavGlyph(navLabel()), 'waifu-agents: nav glyph');
        } catch (error) {
          ctx.logger?.warn?.(`dsh-waifu-agents: 导航图标改写失败：${error?.message ?? error}`);
        }

        /** The dictionary, with the Chinese fallback the panel already uses. */
        const tr = (key) => resolveKey(key);

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

        /** The same question for teams: what can be picked, and what is on now. */
        const teamPickerState = async (sessionId) =>
          await post({ op: 'teamPick', sessionId: typeof sessionId === 'string' ? sessionId : '' });

        ctx.inject(['commandUi', 'sessions'], (scope) => {
          const commandUi = scope.get('commandUi');
          const sessions = scope.sessions;
          if (commandUi === undefined || commandUi === null) return;
          /*
           * The popup never feeds the picked value back into the command, so a
           * pick has to run the Host command itself. That is also what puts the
           * switch in the session log, where the transcript shows it.
           */
          const runOnSession = async (session, line) => {
            const live = sessions?.binding?.(session?.sessionId)?.session;
            if (live === undefined) throw new Error(tr('pickNoSession'));
            const result = await live.command(line);
            if (result?.ok !== true) {
              throw new Error(`${tr('pickSwitchFailed')}：${result?.error?.message ?? 'unknown'}`);
            }
          };
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
                  onSelect: async (option, session) =>
                    await runOnSession(session, `/waifu-change ${option.id}`),
                },
              }),
            'waifu-agents: /waifu-change picker',
          );

          /*
           * `/waifu-team` gets the same popup, for the same reason `/waifu-change`
           * does: a team is picked by name, and a name that has to match
           * character for character is a name nobody can use. The team file
           * lives in the Host, so the options come from `teamPick`.
           *
           * The picker lists teams only. "Leave team mode" is not a team, so it
           * lives in the command (`/waifu-team off`) rather than as a pseudo-row
           * here — a "single mode" row made the team list look like it offered a
           * team that was not one.
           */
          scope.effect(
            () =>
              commandUi.decorate({
                name: 'waifu-team',
                available: () => true,
                ui: {
                  kind: 'popupSelect',
                  searchMode: 'fuzzy-label',
                  searchLabels: () => ({
                    placeholder: tr('pickTeamPlaceholder'),
                    empty: tr('pickTeamEmpty'),
                    noResults: tr('pickTeamNoResults'),
                  }),
                  options: async (session) => {
                    const state = await teamPickerState(session?.sessionId);
                    if (state.ok !== true) throw new Error(state.error ?? tr('pickTeamEmpty'));
                    return (state.rows ?? []).map((row) => ({
                      id: row.id,
                      label: row.label,
                      detail: row.detail,
                      ...(row.active === true ? { active: true } : null),
                      group: { name: 'teams', label: tr('pickTeamSection') },
                    }));
                  },
                  onSelect: async (option, session) =>
                    await runOnSession(session, `/waifu-team ${option.id}`),
                },
              }),
            'waifu-agents: /waifu-team picker',
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
