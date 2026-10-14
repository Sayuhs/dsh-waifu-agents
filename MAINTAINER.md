# dsh-waifu-agents — 维护者文档

面向改这个插件的人。用户怎么用看 [README.md](README.md)。

## 面板是怎么跟 Host 说话的

`POST /waifu-agents/api`，插件 Host 半注册的路由。**不能**用 `ctx.remote.commands.execute`：设置面板的 owner props 是字面量空对象（`settings.plugins.tab`），拿不到 session id，而那个调用需要它。HTTP 路由两样都不需要。

## 会话级人设覆盖是怎么实现的

人设那一行的 `prefix` 不再是正文，而是一个占位符 `{{waifu_persona}}`；插件在 `apply` 时用 `ctx.systemPrompt.variable('waifu_persona', …)` 注册一个**每轮求值**的 provider。这是唯一可行的路：

- `@deepseek-ai/dsh-persona` 的 `prefix` 是渲染期模板（`README.md:49`），而变量插值发生在装配瀑布**之后**（`dsh-system-prompt/lib/index.js:113-115`），所以 `complete: true` 那条「瀑布之后把 section 还原」的规则伤不到它；反过来，走 `system-prompt/assemble` 瀑布改 section 是白改。
- provider 是**同步**调用的，所以全局默认走缓存，缓存由 `settings/document-updated`（`dsh-settings/lib/index.js:435`）和几个写点刷新。
- 取值阶梯：**本会话覆盖 → 会话挂载（读会话头的 `agentPreset`）→ 全局默认 → 上一次可用的文本**。会话挂载排在默认之前，是为了不让平台自己的新任务页选择器变成摆设。
- **写默认人设必须走 settings 服务，不是 `configEditor.edit()`。** 平台自己的 `Settings → Agent Presets` 走的是 `ctx.remote.settings.update("agent-preset-registry", {selectedDefault})`（`ui-agent-preset`），而 `settings.update()` 最后会调 `describe()` —— **`describe()` 是唯一会 emit `settings/document-updated` 的地方**。`ui-agent-preset` 只挂了一个监听：
  ```js
  ctx.remote.$on("settings/document-updated", (ns) => {
    if (ns !== "agent-preset-registry") return;
    refresh();   // 每一个 seat：新任务页 chip、它自己的设置行……
  })
  ```
  裸调 `configEditor.edit()` 会把同样的字节写进同样的 patch 文件，但**一个事件都不发**，于是平台继续用它内存里的旧快照：面板显示新默认、新任务却起在旧默认上，而同一个字段在 Agent Presets 页面改就是好的。这就是「在插件页面更新默认人设后，新对话没有同步；在 Agent 预设里改就正常」。`writeDefault()` 优先走服务，只在 profile 没有 settings 服务（或这行配置项不是按 entry id 寻址的）时才退回编辑器。
- **失败时返回的那个 `defaultId` 不许丢掉。** 写被拒（`ok:false`）时宿主仍然把从活跃 registry 读回来的权威 id 一起返回，客户端从 `failure.payload` 就能拿到。面板必须在**重新 `list` 之后**再落这个值——否则一次读得不够新的 `list` 会把边框留在用户刚刚移开的那一行上。
- **写默认人设的口径：写入不算数，读回来才算数。** `configEditor.edit()` 会把 patch 文件落盘，但 Loader 还要重新激活那一行，这段窗口里重读仍然可能拿到**旧的** id。把写入值直接塞进缓存（乐观更新）会让面板和平台各说各话：刚被移走默认的那一行还挂着高亮边框（要等下次进面板才自愈），下一个新任务也起在 profile 默认上。所以 `setDefault` / `repointDefault` / `purge` 全都走 `verifyDefault(wanted, …)`：50ms × 12 次轮询，直到**活跃的** registry 值跟上写入口径。`refreshDefault({ force: true })` 就是给校验器穿透那个 2 秒缓存窗口用的——否则校验器读到的只是它自己的乐观值。
- **「可校验」是三态，别压成布尔。** `readDefaultId()` 回传的 `field`：字符串 = `selectedDefault` 有值；`null` = 这个面能表达「明确没设」；`undefined` = 这个 profile 根本没有 settings 面。只有第一种能确认一次 CLEAR——roster 那一类的面会把「没指定」解析成 profile 默认，它分不出「清掉了」和「本来就没人设」，所以清空路径只能拿 `previous` 做对比。`checkable === false` 时请求**成功但无法确认**，面板要照实说，不能装作读回来过了。
- **provider 绝不抛异常**，也绝不返回渲染器会噎住的文本：那里抛等于会话起不来，比多用一个来回的人设严重得多。

细节：

- 覆盖记录按 session id 存在 `<人设目录>/overrides.json`（原子写、上限 500 条；改名前的 `dsh-persona-waifu`（0.3.x / 0.4.x）放在 `<home>/persona-waifu.overrides.json` 的那份会在 apply 时被 `foldLegacyOverrides` 合并进来并删除，只有只读目录才退回 `<home>/dsh-waifu-agents.overrides.json`）。**不写任何会话事件**：提示词变化由 loop 自己记 `system/message`；命令的可见记录就是 `command/run` + `command/done` 这对既有事件（它们不在 `SURFACE_EVENT_TYPES` 里，永不进模型请求）。
- `/waifu-change` 是**宿主**命令，选择器由客户端 `commandUi.decorate` 挂上去。装饰只对**裸调用**生效——这正是「不带参数弹选择器、带参数直接切」的实现方式；客户端 contribution **收不到参数**（`input-trigger/lib/client.js:988` 要求裸 token），所以命令必须在宿主侧。
- 会话压根没挂人设时（profile 默认是 `cordis`），占位符不在它的提示词里：`/waifu-change` 用命令处理器拿到的 `agent.ctx` 给**那一个** agent 补一条更近作用域的 section。后果要记住：那等于**把这个会话的提示词整个换成这个人设**，`cordis` 原本那套段位会被挤掉。
- 这一层是**插件侧的装配覆盖**，不是平台给终端用户的提示词编辑口子（`dsh-system-prompt/README.zh.md:174`）。DSH 升级后可能失效；失效时的行为是「留一条警告，按平台原本挂载的人设把请求发出去」——不阻断、不静默。
- 排序拖拽用原生 HTML5 DnD（运行时不提供任何 sortable 原语；`ui-workspace` 也是手搓的）。落盘走 `waifuOrder`：**只改 front matter 里的 `order:` 那一行**，正文一个字节都不碰。
- **`order` 注册时整体加 `PERSONA_ORDER_BASE`（10000）。** registry 的排序是**单一全局键**（`(a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id)`，`dsh-agent-preset-registry`），四个内置模式占 1..4，而面板的拖拽只写 1..n——两家人落在同一个区间里，新任务页就会读出 `后藤一里 / standard / 大肥鱼 / ptc / …`。偏移**只在注册时**加，文件里留的仍是局部序号。改这个常量等于改「人设能排到多低」，别往小改。
- **换人的提示词读两头都写一遍，是刻意的。** `dsh-agent-loop` 的 `SystemPromptProjection.project()` 有两条路：`startsSeries`（或 `inHistory === false`）时**原地重写节点 0 并清空后面所有 system 节点**；反之在历史中间时，文本一变是 `surfaceOp: {op:'append'}` **追加一个新节点**——也就是说旧人设的正文还留在上下文里。只在开头说一次，模型很容易漂回上一位（这是「换人没生效」最常见的真身，日志里表现为命令回了「已切换」而下一轮的口吻没变）。`withSwitchNotice()` 因此前缀点名作废、后缀做最后确认。
- **重复切到同一个人不能回「已切换」。** 提示词一个字没变时，`project()` 返回空更新，不会有新的 system 节点，模型也不会被重新锚定——那句「已切换」是假话。`waifu-change` 用 `already === matched.id` 判出来，改回「本来就是 X · 没有改动」。
- **光改系统提示词仍然不够，真正落地靠「运行时快照」这条旁路。** 双写之后模型照样能拧回来：它拿**自己前几轮以旧身份说过的话**当锚，越问越犟。实测（`session-b6fb8a2b`）：同一会话连切三次，三次请求的 system 节点都已经是新人设（`contextBreakdown.breakdown.systemTokens` 与唯一的 `system: true` 节点可证，且 `cacheReadTokens: 0`——内容确实换过），模型仍然三轮都自称第一位。病灶是位置：`project()` 在历史中间走 `append`，旧人设正文与**旧回答**都留着，而离提问最近的锚是它自己的输出。解法是再开一条**用户角色**的通道：注册 `ctx.systemPrompt.context({ name: 'waifu-agents:identity', order: 900, text })`（`IDENTITY_CONTEXT_NAME` / `IDENTITY_CONTEXT_ORDER`），为**每个 agent 每轮**生成一句「本轮身份 · 运行时确认」，交给平台自己的 `RuntimeContextProjection` 投影成一条 USER 消息、紧跟用户提问成为请求的最后一条。那句快照天生带「本条作废更早的快照」的语义，`preStep`（`agent-loop.js:902-924`）每轮都发，**只在身份变过时**才有内容（`identityNoticeOf()` 对 `source !== 'override'` 和空会话回 `""`）。
  - 两条硬约束：① 这段文本同样会被 `interpolate()` 处理，**不能**出现 `{{…}}`，否则整条渲染失败；② `template.json` 里 `persona` 那一行的 `includeRuntimeContext` **必须是 `true`**。设成 `false` 时 `@deepseek-ai/dsh-persona` 会调 `ctx.systemPrompt.suppressRuntimeContext()`，那是**调用作用域级**的整片清空——它会连这条身份快照一起抹掉，外部表现恰好是「怎么切都不动」，而 system 提示词那一侧看起来完全正常（这就是这个 bug 藏了这么久的原因）。
  - 想关这条通道用插件配置的 `identityReminder: false`（**不要**去改 `includeRuntimeContext`，那会连带关掉平台自己的运行时上下文）。

## op 一览

命令 `/persona <json>` 与 HTTP 路由共用同一个 `run()`：

```
list  get  refresh  create  update  rename  remove
hidden  restore  batch  search  skeleton  setSkeleton
import  export  exportAll  template  setDir  setDefault
roster  waifuState  waifuApply  waifuClear  waifuOrder
updateCheck  updateApply  updateProgress  purge
```

`updateApply` 与 `updateProgress` 是一对，别把它们当成一次调用的两半：

- `updateApply` **启动**安装就返回（`{ok, started, requestId, version, previous}`），不等到装完。装到一半的进度由平台自己的事件喂给 Host，见下节。
- `updateProgress` 是**轮询**口，回传 `{phase, attempt, elapsedMs, log, logTruncated, pnpmExit, seenFeed, done, result, error}`；`idle: true` = 这个 id 不是我们启动的那个。已结算的任务**继续应答**它的结果，直到下一次启动把它顶掉——否则最后一次轮询会撞进「idle」并把结果丢掉。

## 必须记住的契约

- **改名不是一次全局字符串替换。** 这个包在 `dsh-persona-waifu` 名下已经发过版，所以**三处旧拼写是故意留下的**，不要顺手清掉：① `LEGACY_OVERRIDE_FILE = "persona-waifu.overrides.json"` —— 0.3.x / 0.4.x 的会话覆盖就写在 `<home>` 下的这个名字里，`foldLegacyOverrides` 靠它把老用户的覆盖搬过来；② `SELF_IDS` 里的 `persona-waifu` / `include:persona-waifu` —— 改名前的 profile 里那一行 patch 是旧 id，而目录设置和默认人设就挂在那一行上，两种拼写都得能对上；③ `template.json` 里的 `@deepseek-ai/dsh-persona` 是**上游包的包名**，跟本包没关系，永远别动。反过来，路由（`/waifu-agents/api`）和面板偏好键（`localStorage` 里的 `dsh-waifu-agents.*`）是客户端与宿主**成对**改的，改了老 profile 的面板页大小/排序会回默认值——可接受，那是纯外观状态。
- **`_common.md` 是保留名**（`SKIP`/`RESERVED`）：不注册，`create`/`rename` 也占不到它。
- **`{{…}}` 白名单**：只放行 `provider` / `model` / `cwd`。`@deepseek-ai/dsh-persona` 把这一行注册成 `complete: true`，渲染后的 prefix 就是整份系统提示词，未知变量会让它整体渲染失败。校验在 `assemble()` 里，所有写路径都过。
- **`rev` 乐观锁**：`get` 回传 sha256 前 16 位，`update` / `setSkeleton` 可带回；不一致就拒绝写入。
- **原子写**：`writeAtomic()` = 临时文件 + `rename`，覆盖前留 `<name>.bak`。
- **缓存**：`(mtimeMs, size)` 键；`chars` 是「去掉 front matter 并 trim 之后的 JS 字符串长度」，和字节数没有稳定换算。
- **`list` 不带绝对路径**：它给 `id / idOk / name / order / description / group / template / chars / charsFull / problems / owned / mtimeMs / size`。
- **`roster` 多带一个 `defaultResolves`（三态）**：`null` = 没有任何面报出默认值，**不知道**；否则 = `presets.some(r => r.id === defaultId)`。`null` 不能压成 `false`：那会冤枉一个单纯什么都没设的 profile。客户端的 `defaultResolves` state 同样是三态，设置页只在 `=== false` 时报警。
  ⚠️ **这条旗标曾经把后果写反过，别照着旧注释改回去。** 旧文案（注释和 `defaultUnresolved` 都是）说「默认指不到人 → 新会话悄悄落到列表第一项」，依据是 composer 的 `fallback = presets.find(p => p.isDefault)?.id ?? presets[0]?.id`（`ui-agent-preset.js:1263`）。那是**渲染层**的兜底，永远轮不到它跑：服务层先解析，`retain(id)` 直接抛
  ```js
  // registry.js:494 —— 默认就是 selectedDefault ?? config.default
  get defaultId() { return this.config.selectedDefault.get() ?? this.config.default; }
  // registry.js:643（resolve / readDocument 同样）
  throw new RemoteError("agent-preset/not-found", `Unknown agent preset: ${wanted}`, { agentPreset: wanted, available: [...] });
  ```
  所以真实后果是**每一个新会话都被拒绝**（用户看到的那条 `新建会话失败：agent-preset/not-found: Unknown agent preset: 照桥心美`），不是静默回落到第一行。写这条断言时别用「回落」这个词——它会把一个 `P0` 级故障描述成显示问题。
- **悬空的默认是自愈的，不是只报告。** `reconcileDefault()` 在三个地方跑：`status()`（op `list`，也就是**打开面板就修**）、`remove()`（退掉的人设正好是默认那位）、以及启动时 `scan()` 之后的 `.then()`。判定是「`selectedDefault` 有值，但 `agentPresets.list()` 里没有这个 id」；动作只有**清掉**（`moveDefaultOff`），**绝不替用户改指到另一个妻子**——清空会回落到 profile 的 `default`，替用户选人则是另一件更响的事。两个必须保留的细节：
  - **名册为空时不动**（`rows.length === 0` → 「名册还是空的，先不动」）。别的插件在**它自己的** `apply` 里注册 preset，本行完全可能先被激活；此时读名册会把自己还没注册的 id 判成悬空。这正是启动那一跳要 `.then()` 挂在 `scan()` **之后**的原因——先让本插件自己的人设进名册。空名册守卫是同一件事的兜底。
  - **`moveDefaultOff` 是两步，和 `setDefault` 一样**：`writeDefault`/`verifyDefault` 走 `settings` 服务并**重读确认**，然后 `resettleUnstarted` 把还挂在那个死 id 上、没开口的会话挪走。只清字段的话，屏上那个空会话的 header 还钉着死 id，chip 照样是坏的，建会话照样失败。
  - 修复失败**必须出声**：`status()` 回传 `defaultHeal: { ok: false, from, reason }`，面板用 `defaultHealFailed` 显示（此时新会话仍然起不来，是唯一不能静默的一条）。成功回传 `{ ok: true, from, nowDefault, moved }`。`remove()` 回传 `defaultFollowed: 'cleared' | 'unchanged' | 'failed'`。
- **`remove()` 现在是第二个会改默认的写路径**（第一个是 `rename()` 的 `repointDefault`）。退掉的正好是默认那位时，不清默认就留下一个悬空 id，等于「删人设 = 下次新会话失败」。爆炸半径同样压住：退的不是默认那位时**一个字节都不写**（断言 `defaultFollowed === 'unchanged'`）。
- **非法 id 不进选择器**：`choosableRows()` 只收 `problems` 为空且 `idOk` 为真的行。
- **条件样式必须把键写进基础样式，不能让 React 去"移除"。** 这一条看着像代码风格，其实是面板高亮的生死线。React 丢弃一个不再收到的样式属性时写的是 `style[name] = ''`；对普通属性这没问题（开关的 `transform` 就是这么被清掉的，实测正常），但对**简写里的属性不行**：清掉 `borderColor` 之后，`border: 1px solid …` 会把颜色重新应用一遍，而"颜色被清掉"的边框会回落到 `currentColor`。本主题下 `currentColor`（`--dsw-alias-label-primary`）和品牌色（`--dsw-alias-brand-primary` = `neutral-bluish-50`）是同一个近白，于是**一个已经不是默认的行看起来仍然选中**，只有重挂载才会好。这正是用户报的「多次切换默认人设后，选中过的 border 样式存在残留，再次进入就消失了」——而且只发生在**点过的**那些行上（点过才有机会被设过品牌色），没点过的行用的是显式的 `border-l1`。所以 `L.item` 里同时写明 `border` 和 `borderColor`/`borderStyle`，`L.switch` 写明 `borderColor`，`L.thumb` 写明 `transform: 'translateX(0)'`。自测里有一条按**键集合**遍历所有 `条件变体/基础` 配对的断言，加新的条件样式时它会替你拦住。
- **会话顶部那个 chip 不是我们的，是 `projectionValues.agentPreset`。** 它由**唯一一种事件**推进：`agent-preset/selected`（`registry.js` 的 `apply` 只认这个），而写它的只有平台的 `select()`。`select()` 对**已开过轮**的会话会抛 `agent-preset/locked` —— 因为"真的换"意味着重挂载整套 preset、连工具一起换。所以 `/waifu-change` 追加**事件本身**：只动标签，不动正在跑的树；人设本来就有 override 在供，标签和模型听到的因此终于一致。两条硬约束：① 只能写**已注册**的 preset id（值会被持久化，恢复会话时按它挂载，写一个没人提供的 id 会让下次恢复失败）；② 插件配置的 `syncSessionChip: false` 可以整条关掉（关的理由是这条通道同时决定恢复时挂载谁）。`/waifu-reset` 对应地把标签挪回"会话挂载的那一位，没有就回落到全局默认"。
- **宿主侧拿"还活着的 agent"只有这两个口子，已对着实现核实。** `@deepseek-ai/dsh-agent` 的服务名是 `agents`（`super(ctx, "agents")`），公开方法 `list()`（"All live agents, in registration order"，返回全新数组）、`get(id)`、`roots()`、`enter()`、`announce()`。`agent` 对象带 `.id` / `.ctx` / `.session`，而且 **`agent.id` 就是 session id**（`agent-preset-registry` 的 `select` 错误载荷里 `sessionId: agent.id`，`dsh-agent-loop` 也是 `agents.get(sessionId)`）。`agentPresets.select` 的远程绑定写着 `scope: { context: 'agent', wire: 'agentId' }` + 第一个参数 `lookup: 'agent'`——平台自己就是把 agentId 解析成 agent 再调 `select(agent, preset)`，所以本地直接调同一个方法形状是对的，**不需要绕 remote**。`sessionProjections` 的服务名是 `sessionProjections`，`stateOf(session, key)` 返回该投影当前值、未注册的 key 返回 `undefined`——这是读"chip 现在显示谁"的唯一正确方式（读 `session.header.agentPreset` 会错，见上条）。
  用 `_tools/asar-ls.mjs` 复核（Git Bash 下记得 `MSYS_NO_PATHCONV=1`，否则 asar 内部路径会被改写成 Windows 路径）：
  ```bash
  node _tools/asar-ls.mjs "D:/software/DSH/resources/app.asar" list "dsh-agent/"
  MSYS_NO_PATHCONV=1 node _tools/asar-ls.mjs "D:/software/DSH/resources/app.asar" \
    cat "/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js" > .ref/dsh-agent.js
  ```
- **改"新任务默认"是两步，不是一步。** 第一步写 `selectedDefault`（走 `settings` 服务，见下条），它只决定**之后新建**的会话。**已经存在**的会话——包括正摆在屏幕上、用户正在盯着的那个空会话——它的人设是 `agentPreset` 投影，`init: (header) => header.agentPreset ?? null` **只读一次 header**，之后只有 `agent-preset/selected` 事件能推动它。所以只写设置的结果是：注册表已经对了（Agent 预设页的「新任务默认」徽章当场正确），而新任务页顶上的 chip 还写着上一位——用户看到的正是「插件里改默认不生效，官方页面改就好」。官方 `ui-agent-preset` 的 `save()` 是三步：
  ```js
  await write()            // settings.update("agent-preset-registry", { selectedDefault })
  await this.load()        // 重读名册
  await sync(selected.id)  // → syncBlankSession → seat.apply() → agentPresets.select()
  ```
  所以第二步是**用平台自己的 `select()` 把还没开口的会话重新挂到新默认上**（`resettleUnstarted`）。必须用 `select()` 而不是自己 append：它对空会话会先 `recompose` 再 append，标签和实际挂载的树才不会分家；只 append 会把新标签贴到旧树上。顺带白拿一个守卫——已开口的会话被 `agent-preset/locked` 拒掉，所以"哪些算空会话"由平台裁决，不用我们猜。**爆炸半径压到"还在跟着旧默认的"会话**：用户特意在某个空会话上选过别的人设，不能被一次全局默认改动顺手带走。`purge()` 清默认时走同一条路（`from` = 被清掉的那位，`to` = 清完之后名册解析出的默认）。
- **写默认必须走 `settings` 服务，而且降级必须出声。** 平台只有**一条**唤醒通道：`settings.describe()` 里 emit `settings/document-updated`（`settings.js:435`，`write()` 结尾第 536 行调 `describe()`），而 `ui-agent-preset.js:1602` 只监听这一个事件做 `refresh()`——chip、Agent 预设页、所有 seat 全靠它。官方写的是 `ctx.remote.settings.update("agent-preset-registry", { selectedDefault })`，同一个 NS。`configEditor.edit()` 落的是**同样的字节**、发**零个事件**，于是「面板改了、平台不知道」。**这条路径是静默降级的陷阱**：`settings.update` 一抛错就退回 `configEditor.edit`，磁盘照写、行为退回原样——所以降级分支里必须有一条 `warn` 日志，面板也必须把 `via === "configEditor"` 说出来（`defaultViaEditor`）。诊断字段：`setDefault` 回传 `via` / `resettled` / `resettleSkipped`，三个一起就能定位"面板和新任务页对不上"是哪一半丢了。另外 `readDefaultId` 里，一个**空文档**的 settings 面也会把 `source` 记成 `"settings"`，而 `refreshDefault` 对 `settings` 来源缓存 2 秒——写测试时别给一个返回空数组的 `describe`，否则你会量到上一节的残留而不是自己那节。

## 测试与 CI

```bash
pnpm test          # = node selftest.mjs，313 条断言，离线、不碰 profile、不联网
pnpm pack          # 先看产物清单
pnpm publish --no-git-checks 
```

CI 在 `.github/workflows/test.yml`：push 到 `main`、开 PR、或手动触发时跑 Node 20 / 22。

**客户端半边没有渲染测试**（运行时不给假 DOM 入口），但字典、接缝、模块表这三类会静默出错的东西是**静态钉住**的：中英键集必须一致、每个 `t()`/`tr()` 键必须存在、只能 import 冻结模块表里的七个种子词、图标名必须在桥表里、两种弹窗 kind 必须存在且旧的双击文案必须消失。**外加一条样式不变量**：把 `const L = {…}` 抠出来求值，按**键集合**检查每个 `条件变体` 设的键都存在于它的基础样式里——这条守的是默认高亮（见「必须记住的契约」），因为它的失效症状只在第二次切换之后才出现，代码评审看不出。

每次大改之后值得手动跑一遍的两件事：

1. **语法检查不等于没有悬空引用**。删掉一个 state 之后，`setXxx(null)` 这类调用仍是合法语法，只在运行时炸。扫一遍：`\b(confirmId|setConfirmId|armedUpdate|setArmedUpdate)\b` 应该全 0。
2. `node --check index.js && node --check client.js`。

## 装完之后请手点一遍

1. 打开标签页：两个分段能切换、没有「面板渲染失败」。
2. 搜索框打 ≥2 个字 → 出现「正文命中」，每条带「骨架 / 正文」标签。
3. 点开一行 → 正文框有内容、两个字数有值；改名字后点到别处 → 顶部「已保存」。
4. 默认开关：打开一个 → 该行高亮；折起她所在的组再刷新 → 组自动展开并滚到她；关掉 → 设置页显示回落后的默认。
5. 设置 → Agent Presets：那里的「设为新任务默认」和插件面板的开关是同一行状态（改一边，另一边跟着变）。
6. 开一个新任务（**别发消息**）→ 顶部 preset 下拉能选到人设，选完会话标题栏的只读标签跟着变；发一条消息后再打开下拉，应该已经锁住。
7. 点行里的名字 → **不应该**展开；点行首 ▸ → 展开。归档图标点一下 → **弹确认窗**，未勾选时确认键必须是灰的；勾选 → 确认 → 行消失、设置里「已隐藏」计数 +1；在设置里展开 → 取消隐藏 → 她回来。
8. 设置 → 公共骨架 → 就地展开编辑器 → 删掉 `[[body]]` 再保存 → **必须被拒**。
9. 正文里写 `{{char}}` → **必须被拒**。
10. 面板开着某行，用 VSCode 改同一文件保存，再在面板里改并失焦 → 应收到「磁盘上变过」。
11. 批量：勾几个 → 隐藏选中 / 导出选中；批量里**不该再有**顺序或分组按钮。
12. 分页：打开 → 出现翻页；刷新页面后设置还在。
13. 改目录 → 保存 → 插件自己重启（面板会断，属正常）。
14. **活测 live root**：会话里打 `/waifu-current` → 必须回话（同时验证宿主命令拿到的 agent 是 live root，那是整套设计的前提）。
15. **同一条会话里换人再问一句** → 口吻必须真的变了（这是整件事唯一的真证明）；再打 `/waifu-current` → **只有一行**，且指明当前是谁。**接着连切三次不同的名字** → 每一次口吻都要跟着走（「切了但一直是同一个」是这套设计的头号失效模式）。再切**同一个人** → 必须回「本来就是 X · 没有改动」，不能回「已切换」。顺手确认旁路通道：换人之后每一轮的请求**尾部**应多出一条**用户角色**的「本轮身份 · 运行时确认」，没换过的会话不该有这条（有它 = `includeRuntimeContext` 没被改坏）。
16. 打 `/waifu-change`（不带参数）→ 弹选择器，搜索能过滤、当前那位打勾；选一个 → 会话里出现一条「已切换」的记录。
17. 先在「人设」工具条打开「拖拽排序」（关着的时候行内控件正常、拖动无效）→ 整行拖到另一行上 → 顺序变了；**开着的时候行内的展开 / 开关 / 导出 / 归档必须点不动**；关掉 DSH 再打开顺序还在；打开那个 `.md` 确认**正文没被动过**。
18. `/waifu-reset` → 回落到这个会话原本挂载的那一篇。
19. **开一个新任务（别发消息）→ 看顶部 preset 下拉**：四个内置模式（standard / ptc / minimal / cordis）必须在**最上面四行**，自定义人设全在下面。这是 `PERSONA_ORDER_BASE` 唯一的验收点。
20. **默认开关连点**：把默认从 A 换到 B，再换到 C，**每换一次都留在面板里看**——高亮边框必须**当次**就落到新行上，不能还挂在旧行上等下次进来才自愈。然后开新任务，顶部下拉默认选中的必须是 C。
21. 把默认指向一个**正在被编辑、暂时组装不出来**的人设 → 设置页「新会话默认用谁」下面必须出现「这个默认指不到任何可用的人设」。
22. **改默认不该需要重启**：在插件面板把默认从 A 换成 B → **立刻**开一个新任务（别发消息）→ 顶部选择器默认选中的必须是 B。这是「写入有没有通知平台」唯一的验收点（`settings/document-updated`）；走 `configEditor.edit()` 的旧路径这里会显示 A。
23. **切完看会话顶上那个标签**：在同一个会话里 `/waifu-change` 到另一位 → 会话标题旁边的标签必须**跟着变**。它不动就是 `agent-preset/selected` 没追加成功；把它写成 `syncSessionChip: false` 时标签**应该**保持不动。
24. **改默认要连"当前这个空会话"一起换**：让新任务页停在屏幕上别动 → 在插件面板把默认从 A 换成 B → **不要新建会话**，回来看新任务页顶上的选择器，必须已经变成 B。这一条和第 22 条**不是同一件事**：第 22 条考的是"之后新建的会话拿谁"（`selectedDefault`），这条考的是"已经摆在屏幕上的那个空会话"（`projectionValues.agentPreset`）。只修了第 22 条的版本，这里会停在 A——而且 Agent 预设页的「新任务默认」徽章**已经是 B**，两处对不上就是它。
25. **删掉人设文件 / 退掉默认那位，然后重启** —— 这是「悬空默认」的现场复现，也是这一版修复的验收点：① 把默认指向 A，**关掉 DSH**，把 `~/.dsh/personas/A.md` 从磁盘删掉（不走面板），重开 DSH → 新任务必须能正常建起来，**不能**出现 `agent-preset/not-found`；② 日志里应有一条 `WARN dsh-waifu-agents: 默认人设「A」已经不在名册里了…已清掉这条默认`；③ 打开插件面板 → 「新会话默认用谁」那行下面出现一条「已自动清掉」的说明（`defaultHealed*`），刷新一次面板后它消失；④ 面板里把默认设成 B → 在**面板里**退掉 B（归档）→ 默认必须跟着清掉，`~/.dsh/personas` 里出现 `B.md.off`，且下一次新任务不再失败。只有清了字段、没把屏上那个空会话一起挪走的版本，会在 ① 那里照样失败。
