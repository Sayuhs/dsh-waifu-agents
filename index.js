/**
 * dsh-waifu-agents — Host 半边。
 *
 * 扫描一个人设目录，把其中每个 `*.md` 都注册成 agent 预设（"wife"）。
 * 所有预设共用一份能力列表（`template.json`）；只有 `@deepseek-ai/dsh-persona`
 * 那一行的 `prefix` 会被替换成文件里的 markdown 正文，因此人设文本放在
 * 纯文本文件里，而工具集只有一处来源。
 *
 * 身份是 **id**（即文件名），绝不是显示名：`rename` 会移动文件并以新 id
 * 重新注册。`order` 由 Host（`nextOrder`）分配，除非文件本身已带有一个。
 * id 允许是中文（`ID_OK`），所以一个 wife 可以直接叫 `后藤一里`，而不必
 * 永远背着一个音译别名。
 *
 * 操作有两条可达路径：`/persona <json>` 命令（需要会话），以及携带同样
 * JSON 请求体的 `POST /waifu-agents/api`（只需要回环对端）。设置面板走的是
 * 路由：那个插槽的 owner props 是空的，所以它永远收不到会话 id。
 *   list        列出目录、每个文件，以及本插件拥有哪些 id
 *   get         读取一个 wife，含回答风格
 *   create      新建文件 + 注册；`id` 可留空（从 `name` 推导），`order` 可留空
 *   update      编辑名字 / 简介 / 回答风格（改 id 走 `rename`）
 *   rename      把一个 wife 移到新 id（文件名 *就是* 预设 id）
 *   remove      先注销，再把文件归档为 `<id>.md.off`
 *   import      收下整份 markdown 文件（含 front matter）并存起来
 *   export      返回一个文件的原样文本
 *   exportAll   返回所有文件的原样文本
 *   exportArchive  把选中的文件（默认全部）打包成一个 base64 `.zip`
 *   refresh     重新扫描目录并收编新增的文件
 *   setDir      通过 configEditor 服务把 `config.dir` 写回去
 *   setMode     在纯聊天与完整工具集之间切换人设
 *   updateCheck 哪个版本在运行、哪个已安装、注册表里是哪个
 *   updateApply 通过 pluginManager 服务安装最新已发布版本
 *
 * id 是不可见的。它只需要在磁盘上唯一，所以它是显示名的 slug，而当显示名
 * 变化时 `update` 会移动文件：这样文件名、`name` 字段与行标题就是同一样
 * 东西，任何界面都不必让用户输入 id。文件名装不下的名字（空格、标点、
 * `/`）则通过 slug 化保住这一点。
 *
 * `updateApply` 让已发布的修复不必开 shell 就能到达：面板发它，
 * `latestVersion` 询问注册表，安装走的正是 Plugins 页面所用的那个服务。
 * 三层方案，按顺序尝试：
 *
 * 1. TARBALL（已安装包的更新）：新版本的 tarball URL 是管理器的 HMR 预检
 *    唯一无法按名字匹配的 spec 形态——包名要到 pnpm 跑完才知道——所以安装
 *    借助已安装副本到达 pnpm，HMR 重组会把运行中的插件原地替换。成功路径
 *    上无需移除、无需重启。这一路还会把 profile 保存的依赖从版本范围改写成
 *    精确 URL；下一次更新的 URL 又不同，因此这条路不会被以"已安装"为由
 *    二次拒绝。
 * 2. NAME（全新安装，以及两步法的后半）：朴素的 `name@version` spec 让
 *    全新安装保存的依赖保持为干净的范围。
 * 3. TWO-STEP（tarball 一路因 `already-installed` 被拒时的后备）：先移除
 *    运行中的 bundle，再从同一个 fiber 安装新版本——已 resolve 的 promise
 *    永远不会打断等待它的那个 fiber。fiber 能否挺过对自己的移除，要靠真机
 *    使用来验证；每个失败都会被捕获并上报，最后的手段是 Plugins 页面上的
 *    手动"先移除再安装"。
 *
 * 人设目录与 `teams.json` 位于包外，所以任何一层——成功、半途还是失败——
 * 都不会碰用户数据。
 *
 * 无需任何配置：`resolveDir` 先取行配置里的目录，再取 `<home>/personas`，
 * 然后在还没有这个目录的机器上——用本包自带的 `personas/` 播种该路径，
 * 这样用户编辑的 wife 绝不是升级时会覆盖的那份；只有到那时才退回包内目录。
 * `<home>` 是 `$DSH_HOME`，否则是系统主目录加 `.dsh`：那些变量是 shell
 * 层面的事实，插件所在的 Host 进程不必导出它们。
 *
 * Host 半边现在住在哪里（2026-10 拆分；每次搬动都是逐字搬，只改了闭包边界）：
 *   - index.js        本文件：纯人设层（有导出、有测试）、目录内核、会话
 *                     身份、记忆写入路径，以及调用下面各模块的接线
 *   - panel-ops.js    注册引擎（`scan`/`registerOne`）、面板 op 表、团队预设
 *                     同步——即过去「团队即预设」一节的内容，外加面板 API
 *   - memory-ops.js   人设长记忆（身份快照、团队记忆视图）+ 面板的
 *                     memory / team / purge op 实现（2026-10-28 P3 拆出）
 *   - team-mode.js    团队模式的面板目录（teamState / teamSet /
 *                     teamMemoryClear）（2026-10-28 P3 拆出）
 *   - commands.js     三个 `/waifu-*` 命令
 *   - http-route.js   面板的回环 POST 路由
 *   - self-update.js  版本检查、tarball 安装、进度推送
 *   - package-meta.js PACKAGE_DIR / PACKAGE_NAME / RUNNING_VERSION
 *   - text.js         `oneLine`（与 `team.js` 里的不是同一个函数）
 *   - tool-filter.js  运行时工具闸门（chat/team 封禁）
 *   - team-*.js       团队运行时、其决策层、快照与记忆
 *
 * 这里用到的公共契约：
 *   - `ctx.agentPresets.register` / `.list`  (service `agentPresets`)
 *   - `ctx.commands.register`                (service `commands`)
 *   - `ctx.get('configEditor')`              (service `configEditor`, 可选)
 *   - `ctx.webServer.register`                (service `webServer`, 惰性注入)
 *   - `node:fs` 负责文件本身                  (与随包的 bundle 示例相同)
 * 除了 `@deepseek-ai/schemastery`（`Config` 导出需要它，清单里也声明为依赖）
 * 之外，不导入任何 `node:` 内建模块之外的东西。
 * 有意不声明 peer dependency：插件管理器会拒绝声明的 DSH peer 范围不满足的
 * 安装，而这里也用不到。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { installTeamRuntime } from "./team-runtime.js";
import { createToolFilter } from "./tool-filter.js";
import { buildZip } from "./zip.js";
import { PACKAGE_DIR, PACKAGE_NAME, RUNNING_VERSION } from "./package-meta.js";
import { refreshAssets } from "./seed-assets.js";
import { installSelfUpdate } from "./self-update.js";
import { installCommands } from "./commands.js";
import { installHttpRoute } from "./http-route.js";
import { installMemoryOps } from "./memory-ops.js";
import { installPanelOps } from "./panel-ops.js";
import { installTeamMode } from "./team-mode.js";
import { oneLine } from "./text.js";
import {
  TEAM_FILE,
  RUN_LOG_FILE,
  TEAM_LIMIT,
  NAME_LIMIT,
  CAP_POLICIES,
  adoptTeam,
  expandSelection,
  saveTarget,
  storeProblem,
  defaultRenameFollow,
  defaultNamesTeam,
} from "./team.js";
import {
  DEFAULT_MAX_ENTRIES,
  ENTRY_MAX_CHARS,
  MAX_MAX_ENTRIES,
  MIN_MAX_ENTRIES,
  appendEntry,
  clearStore,
  clampEntryText,
  clampMaxEntries,
  effectiveEnabled,
  listStoredIds,
  migratePersona,
  personaConfigOf,
  readConfig,
  readStore,
  recallEntries,
  recentEntries,
  renderMemoryBlock,
  screenEntry,
  trimToLimit,
  updateConfig,
  writeStore,
} from "./persona-memory.js";

/**
 * 版本比较，重新导出以免包的公共接口面因更新机制搬到 `self-update.js` 而
 * 改变。
 */
export { isNewer } from "./self-update.js";

/** Cordis 插件名。 */
export const name = "waifu-agents";
/**
 * 本插件贡献到的所有注册表。`configEditor`（目录与默认人设）和
 * `pluginManager`（自更新）都是可选的，通过 `ctx.get` / `ctx.inject` 访问：
 * 缺少它们的 profile 也必须照常拿到自己的人设。
 */
export const inject = ["agentPresets", "commands", "systemPrompt"];

/** 行配置 schema。声明它正是让该行获得配置控件的原因。 */
export const Config = z.object({
  dir: z.string(),
  template: z.string(),
  registry: z.string(),
  /** 关闭后会话中途的切换提示不再出现；见 `withSwitchNotice`。 */
  switchNotice: z.boolean(),
  /**
   * 关闭后每回合的身份快照不再注入；见 `identityNoticeOf`。
   *
   * 默认开启，因为它是唯一能真正重新锚定会话中途切换的通道：人设本身是
   * 系统提示词，而已经以上一位 wife 的身份回答过两次的模型会为自己的回答
   * 辩护，而不是重读提示词开头。测量记录见 `identityNoticeOf`。
   */
  identityReminder: z.boolean(),
  /**
   * 开启后 `/waifu-change` 也会把会话自己的预设标签一并移过去；见
   * `rememberSessionPreset`。
   *
   * 对话上方的 chip 渲染的是 `projectionValues.agentPreset`，而对一个已经
   * 开始回合的会话，平台拒绝移动它（`agent-preset/locked`）——因为"真正"
   * 移动意味着重新挂载整棵预设树，工具也包括在内。于是切换运行中的会话
   * 曾让标签仍写着会话出生时的那个 wife，看上去就是"切了但标签没变"。
   * 这个开关只追加选中事件本身，它只移动标签、别的不动；无论开关与否，
   * 人设本身都由覆盖提供。关闭时标签不动。
   */
  syncSessionChip: z.boolean(),
});

/**
 * 共享骨架：人设目录里的一个保留名，永远不会是一个 wife。它是使用
 * `template:` 的人设被浇注进去的框架，`[[body]]` 标记她自己的文本放哪里，
 * `[[name]]` 代表显示名。
 */
const SKELETON_FILE = "_common.md";

/** 目录中不是 wife 的名字。 */
const SKIP = new Set(["README.md", "_template.json", SKELETON_FILE]);

/**
 * 我们的占位符刻意不用 `{{…}}`。
 *
 * `{{…}}` 属于提示词渲染器：渲染系统提示词时它会解析那种语法，遇到任何
 * 不认识的名字都会 THROW——`dsh-system-prompt` 恰好只注册了
 * provider/model/cwd。这一行注册时带 `complete: true`，所以渲染出的前缀就是
 * 整个系统提示词：一个多出来的 `{{char}}` 不会只让一段话降级，而是让提示词
 * 整个失败、会话起不来。
 */
const PROMPT_VARIABLES = new Set(["provider", "model", "cwd"]);

/**
 * 每个人设行都指向它（而不是字面文本）的提示词变量。
 *
 * 它刻意不在 `PROMPT_VARIABLES` 里：那个集合校验的是 *人设* 允许写什么。
 * 这个名字由插件自己写入，由 `apply` 里注册的 provider 解析。
 */
export const PERSONA_PLACEHOLDER = "{{waifu_persona}}";

/**
 * 每会话覆盖存放的位置。
 *
 * 只要人设目录可写就放在该目录内，于是本插件在磁盘上恰好只拥有一条路径，
 * 卸载是否干净看一眼即可。`OVERRIDE_FILE` 只是只读（包内）目录时的后备。
 * `LEGACY_OVERRIDE_FILE` 是同一个后备在包改名前（`dsh-persona-waifu`）的
 * 名字：从 0.3.x/0.4.x 升级来的安装把会话覆盖留在了那里，`foldLegacyOverrides`
 * 会在首次 apply 时把它们折进当前目录。永远不要写旧名。
 */
const OVERRIDE_FILE = "dsh-waifu-agents.overrides.json";
const LEGACY_OVERRIDE_FILE = "persona-waifu.overrides.json";
const OVERRIDE_FILE_IN_DIR = "overrides.json";

/**
 * 插件记录人设以哪种能力形态运行的位置。
 *
 * 刻意放在 `teams.json` 旁边：人设目录（或其只读后备）是本插件唯一拥有的
 * 地方，所以"这份安装的状态是什么"保持在同一个目录里，而不是第二个藏起来
 * 的位置。
 */
const MODE_FILE = "mode.json";

/** 有上限，免得长期使用的安装无限积累死掉的会话 id。 */
const OVERRIDE_LIMIT = 500;

/** agent-preset 注册表存放 `selectedDefault` 的设置命名空间。 */
const REGISTRY_NS = "agent-preset-registry";
const PROMPT_VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * 本插件的预设落在注册表唯一全局排序键里的位置。
 *
 * 注册表用它持有的每一条声明按
 * `(a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id)`
 * 排序（`dsh-agent-preset-registry/lib/index.js`），而随包预设已占用 1..4。
 * 人设文件的 `order:` 是 *本目录之内* 的位置——面板拖拽排序只写 1..n——
 * 所以把这个数直接交给注册表会让两族挤进同一段，新建任务列表读起来成了
 * 后藤一里 / standard / 大肥鱼 / ptc / 托尔 …：内建与自定义人设交错。偏移只在
 * 注册时施加，于是文件保留面板编辑的局部顺序，而花名册读作内建在前、
 * 自定义在后。
 *
 * 用 10000 而不是 10：`order` 是没有文档化范围的光秃排序键，一段宽到任何
 * 合理手写数字都够不到的区间，才能保证人设不会意外排到内建之上。
 */
export const PERSONA_ORDER_BASE = 10000;

/**
 * 团队预设排序进入的区段——整个人设区段之上。
 *
 * 团队由人设组成，所以在新建会话页它应排在它们之后而不是交错；而手写的
 * 人设 `order:` 得超过 10000 才够到这个区段，{@link PERSONA_ORDER_BASE} 的
 * 存在正是为了让这种事不可信。
 */
export const TEAM_ORDER_BASE = 20000;

/**
 * 每个团队预设的 id 的开头。
 *
 * 团队不是文件，所以人设目录里的任何东西都不会意外与它撞名——而
 * `teamNameForPreset` 就是运行时区分"出生即在团队上的会话"与"后来切到
 * 团队上的会话"的办法。
 */
export const TEAM_PRESET_PREFIX = "团队-";

/**
 * 合法的预设 id；文件名即预设 id。
 *
 * Unicode 字母与数字，所以 wife 可以直接叫 `后藤一里`，不必永远背着音译
 * 别名。注册表对 `id` 没有任何格式要求——实际代码只拒绝空 id 与重复 id——
 * 所以这个模式是我们自己的，它真正的职责是保持为一个合法的 *文件名*。
 * 字母与数字已经排除了 `/ \ : * ? " < > |`、空格和点，而拒绝开头 `-` 则
 * 保证 id 永远不会长得像选项。
 */
export const ID_OK = /^[\p{L}\p{N}][\p{L}\p{N}-]*$/u;

/*
 * 同一运行时进程内，本插件每一次存活的 `apply()` 共享的注册簿记。
 *
 * 它存在的原因：host 会在重载路径上重新运行 `apply()`（强制更新入口会在
 * 自己的 fiber 上重新 apply 插件），而过去的每次调用都会在自己的闭包里新铸
 * 一份 `owned` map。两次 apply 于是各自跑各自的 `void scan()` 并互相竞争——
 * 每方都把对方的注册看成未知占用者，试图注册同样的 id，输的一方在全新
 * 首次安装时就报「存在同名
 * Id」，只能靠重启（只 apply 一次）解决。把状态
 * 键在全局注册表上，即使本文件被求值两次也能协作：先注册某 id 的一方对
 * 之后每次扫描都可见为 `owned`，而下面的扫描互斥彻底消灭了读/注册交错的
 * 窗口。
 *
 * 存在这里的 `dispose` 闭包可能属于另一个（存活或垂死的）实例的 fiber——
 * 调用它们仍然是正确的：注册表的注销与上下文无关，重复调用在注册表一侧
 * 也有幂等保护。
 */
const REG_STATE_KEY = Symbol.for("dsh-waifu-agents/registration-state");
const REG_STATE = (globalThis[REG_STATE_KEY] ??= {
  /** preset id -> { dispose, rev }: 谁注册的它，注册成了什么文本。 */
  owned: new Map(),
  /** id -> 持有计数：当前正在进行中的注册，按定义是我们的。 */
  registering: new Map(),
  /** 串行化链：扫描一次只跑一个，跨所有实例。 */
  scans: Promise.resolve(),
  /**
   * 团队预设 id -> { dispose, name, description, applied }：与 `owned` 同职，
   * 面向本插件预设中不是人设文件的那一半。
   *
   * `applied` 是写入该行的那个 apply() 的令牌。簿记共享之后，这是区分
   * 「这条注册是我的」与「孪生实例注册的它」的唯一办法——`dispose` 做不到，
   * 因为持有 map 的调用者未必是注册它的调用者。
   */
  teamOwned: new Map(),
  /**
   * 团队预设 id -> 团队名。注册表的团队半边：运行中的会话自身的预设 id 是
   * `anchorOf` 唯一读得到的东西，所以没有这张 map 就无从知道某个会话出生
   * 在团队上。
   *
   * 值是纯字符串，跨实例共享是安全的——它不带句柄、不带生命周期。
   */
  teamPresets: new Map(),
  /** 团队同步的串行化链，跨所有实例。 */
  teamSyncs: Promise.resolve(),
  /**
   * Apply 计数器：本进程里哪个实例生于何时。
   *
   * 每次 `apply()` 加一，扫描从不加——扫描是同一个所有者再次发问，若让它
   * 推高计数，最安静的实例反而会显得最新。它唯一的职责是 `scanOnce` 里的
   * 接管规则：更晚实例写的行绝不被更早实例触碰，这正是阻止两个存活实例
   * 在每次刷新时把一个 id 来回易手的东西。
   */
  epoch: 0,
});

/*
 * 插件被进程内替换时（host 不重启就重新 apply），旧构建留下的 REG_STATE 已经
 * 在 `globalThis` 上了。那个对象没有团队半边，而上面字面量处的 `??=` 填不了
 * 它——只有 KEY 缺失时它才生效。没有这三行，原地升级后的第一次团队同步就会
 * 写到 `undefined`。
 */
REG_STATE.teamOwned ??= new Map();
REG_STATE.teamPresets ??= new Map();
REG_STATE.teamSyncs ??= Promise.resolve();
/*
 * 实例序号，同样有对象字面量的告诫：这个字段出现之前的构建留下的 REG_STATE
 * 没有 `epoch`，而字面量的默认值不会写进已存在的对象。从 0 起步意味着下一
 * 个 `apply()` 是实例 1——升级后的构建永远比账上已写行的代码 NEWER，这正是
 * 接管所需要的方向。
 */
REG_STATE.epoch ??= 0;

/**
 * `SKIP` 是一组文件名，而 Windows 比较文件名不区分大小写，所以
 * `readme.md` 与 `README.md` 是同一个文件。
 */
const RESERVED = new Set([...SKIP].map((entry) => entry.toLowerCase()));

/**
 * 这个 id 会不会落在扫描器刻意忽略的名字上？这样的文件会被写出来却永远
 * 得不到注册，所以提前拒绝。
 * @param {string} id
 */
function reserved(id) {
  return RESERVED.has(`${id}.md`.toLowerCase());
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * 把本包自带的 `personas/` 复制进 `target`，让首次运行留给用户一份可写的
 * 副本，而不是 `node_modules` 里的活目录——那会被下一次插件升级覆盖。
 *
 * 先暂存再改名不是装饰。`resolveDir` 把"目录存在"读作"用户数据住在这里"，
 * 一个出现了却只装了一半的目录会在下次启动时被收编，没复制成功的东西从此
 * 从花名册里消失。暂存名既不以 `.md` 结尾也不叫 `personas`，任何扫描都不可能
 * 收编它；若其间有谁建了目标，`rename` 会失败而不是合并，调用方则退回包内
 * 目录。
 *
 * 永不覆盖、永不抛错：在这件事行不通的机器上，也必须以随包 wives 收场。
 *
 * @param {string} target 要创建的绝对目录
 * @param {string} from 本包自带的 `personas/`
 * @returns {boolean} 仅当整个目录都落地时为 true
 */
function seedInto(target, from) {
  let entries;
  try {
    if (!fs.statSync(from).isDirectory()) return false;
    entries = fs
      .readdirSync(from)
      .filter((entry) => fs.statSync(path.join(from, entry)).isFile());
  } catch {
    return false;
  }
  if (entries.length === 0) return false;

  const stage = `${target}.seed-${process.pid}`;
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    for (const entry of entries)
      fs.copyFileSync(path.join(from, entry), path.join(stage, entry));
    fs.renameSync(stage, target);
    return true;
  } catch {
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch {
      /* 留下一个零散的暂存目录好过启动失败 */
    }
    return false;
  }
}

/**
 * 决定服务哪个目录，不需要任何配置。
 *
 * 1. 行设置了 `config.dir` 时用它。
 * 2. `<home>/personas` 存在时用它。
 * 3. 同一条路径，当设置了 `seed` 时 *由本包自带的 `personas/` 创建*，让从没
 *    见过本插件的机器最终得到可写的 wives，而不是 `node_modules` 里的那份。
 * 4. 本包自带的 `personas/`。
 *
 * `<home>` 是 `DSH_PROFILE_DIR` 的祖父目录，否则 `DSH_HOME`，否则系统主目录
 * 加 `.dsh`——`homeFromEnv` 总是给出三者之一。
 *
 * 只有第 3 步会写，而且绝不碰已经存在的目录。
 *
 * @param {{ dir?: string, packageDir?: string, env?: Record<string, string | undefined>, seed?: boolean }} [options]
 * @returns {{ dir: string, source: 'config' | 'DSH_PROFILE_DIR' | 'DSH_HOME' | 'default' | 'seeded' | 'package' }}
 */
/**
 * DSH 主目录，来自本进程能看到的任何来源：
 * `DSH_PROFILE_DIR` 是 `<home>/profiles/<name>`，`DSH_HOME` 是主目录本身，
 * 系统主目录加 `.dsh` 是最后手段。
 *
 * 这两个变量是 Harness 的 *shell* 层面事实——注入到 shell 执行中，不一定
 * 注入到插件所在的 Host 进程。过去在这里答 `null`，正是把每台这样的机器
 * 送去打包只读目录的原因，所以这里总是给出一条路径。
 * @param {Record<string, string | undefined>} env
 * @returns {{ home: string, source: 'DSH_PROFILE_DIR' | 'DSH_HOME' | 'default' }}
 */
function homeFromEnv(env) {
  const profileDir = env.DSH_PROFILE_DIR;
  if (profileDir) {
    return {
      home: path.dirname(path.dirname(path.resolve(profileDir))),
      source: "DSH_PROFILE_DIR",
    };
  }
  const home = env.DSH_HOME;
  if (home) return { home: path.resolve(home), source: "DSH_HOME" };
  return {
    home: path.join(env.USERPROFILE || env.HOME || os.homedir(), ".dsh"),
    source: "default",
  };
}

export function resolveDir(options = {}) {
  const {
    dir,
    packageDir = PACKAGE_DIR,
    env = process.env,
    seed = false,
  } = options;
  if (dir) return { dir: path.resolve(dir), source: "config" };
  const { home, source } = homeFromEnv(env);
  const candidate = path.join(home, "personas");
  if (fs.existsSync(candidate)) return { dir: candidate, source };
  if (seed && seedInto(candidate, path.join(packageDir, "personas"))) {
    return { dir: candidate, source: "seeded" };
  }
  return { dir: path.join(packageDir, "personas"), source: "package" };
}

/**
 * 扁平的 `key: value` front matter——与现存人设文件使用的同一子集。
 * 只有文件最开头的块是元数据；再靠后的都是回答风格，`---` 和冒号也算。
 * @param {string} input - 文件文本
 * @returns {{ meta: Record<string, string | number>, body: string }}
 */
export function parseFrontMatter(input) {
  const raw = String(input)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
  const match = FRONT_MATTER.exec(raw);
  if (!match) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    if (!key) continue;
    let value = line.slice(at + 1).trim();
    if (
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = key === "order" ? Number(value) : value;
  }
  return { meta, body: raw.slice(match[0].length).trim() };
}

/**
 * 按 `parseFrontMatter` 能读的格式把元数据加正文写回去。
 *
 * `group` 与 `template` 像其他字段一样被携带而不是丢弃：面板保存会重写整份
 * front matter，这个函数不认识的任何字段，都会成为面板下次编辑时悄悄删掉
 * 的字段。
 */
export function renderPersona({
  name: displayName,
  order,
  description,
  group,
  template,
  body,
}) {
  const lines = ["---"];
  if (oneLine(displayName)) lines.push(`name: ${oneLine(displayName)}`);
  if (Number.isFinite(order)) lines.push(`order: ${order}`);
  if (oneLine(description)) lines.push(`description: ${oneLine(description)}`);
  if (oneLine(group)) lines.push(`group: ${oneLine(group)}`);
  if (oneLine(template)) lines.push(`template: ${oneLine(template)}`);
  lines.push("---", "", String(body ?? "").trim(), "");
  return lines.join("\n");
}

/** 接受数字、数字字符串和空值；返回有限数字或 undefined。 */
function normalizeOrder(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 一个文件原样文本的简短稳定令牌。 */
export function revision(text) {
  return createHash("sha256")
    .update(String(text ?? ""), "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * 把一个人设浇注进共享骨架。
 *
 * 返回 `{ ok, text, problems, bodyOffset }`。`problems` 绝不会扔在地上：无法
 * 拼装的正文在被写入之前就拒绝，因为一个注册不了的文件会躺在目录里、在
 * 花名册里不可见——这是谁都没法诊断的失败模式。
 *
 * @param {string} name 显示名，替换 `[[name]]`
 * @param {string} body 存储状态的人设文本
 * @param {string | null} skeleton 骨架文本，或她不要骨架时的 null
 */
export function assemble(name, body, skeleton) {
  const problems = [];
  let text = String(body ?? "");
  let bodyOffset = 0;
  if (skeleton !== null && skeleton !== undefined) {
    const frame = String(skeleton);
    const slots = frame.split("[[body]]").length - 1;
    if (slots === 0) problems.push("骨架里没有 [[body]]，人设正文没有地方可放");
    else if (slots > 1)
      problems.push(`骨架里有 ${slots} 个 [[body]]，只能有一个`);
    if (problems.length === 0) {
      const head = frame.slice(0, frame.indexOf("[[body]]"));
      bodyOffset = head.replace(/\[\[name\]\]/g, name).length;
      text = frame.split("[[body]]").join(text);
    } else {
      text = `${frame}\n\n${text}`;
    }
  }
  text = text.replace(/\[\[name\]\]/g, name);
  if (problems.length === 0) {
    for (const match of text.matchAll(/\[\[([a-z0-9_]*)\]\]/g)) {
      if (match[1] !== "name" && match[1] !== "body") {
        problems.push(
          `不认识的占位符 [[${match[1]}]]：只支持 [[name]] 与 [[body]]`,
        );
      }
    }
    for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const variable = match[1].trim();
      if (
        !PROMPT_VARIABLE_NAME.test(variable) ||
        !PROMPT_VARIABLES.has(variable)
      ) {
        problems.push(
          `正文里的 {{${match[1]}}} 会让整份系统提示词渲染失败（会话起不来）：只支持 ` +
            [...PROMPT_VARIABLES].map((item) => `{{${item}}}`).join(" / "),
        );
      }
    }
  }
  return { ok: problems.length === 0, text, problems, bodyOffset };
}

/** 只支持一个骨架名；别的都是打错字，不是特性。 */
export function templateProblem(meta) {
  const value = oneLine(meta?.template);
  if (!value) return null;
  return value === SKELETON_FILE
    ? null
    : `template: ${value} —— 目前只支持 ${SKELETON_FILE}`;
}

/** 人设要求的骨架，或她不要骨架时的 null。 */
function skeletonFor(meta, skeleton) {
  return oneLine(meta?.template) === SKELETON_FILE ? skeleton : null;
}

/**
 * 预设可注册成的两种能力形态。
 *
 * `chat` 只是一段对话，别无其他；`tools` 是 `template.json` 里的完整列表。
 * 团队模式永远是 `chat`，不管该行写什么——见 `templateRowsFor`。
 */
export const MODES = ["chat", "tools"];

/**
 * 把存储或请求的模式规整成合法值。
 *
 * 一切认不出的值都退回 `tools`，即这个开关出现之前每份安装一直在跑的形态：
 * 加开关绝不能悄悄剥夺从没碰过它的人的工具。因此缺失的 `mode.json` 也是
 * `tools`。
 * @param {unknown} value
 * @returns {"chat" | "tools"}
 */
export function normalizeMode(value) {
  return value === "chat" ? "chat" : "tools";
}

/**
 * 一个会话此刻实际生效的模式：会话级覆盖优先，否则跟随全局。
 *
 * 这是 `/waifu-mode here` 的全部魔法，也是它和全局开关的分界线。会话级
 * 覆盖走的是**运行时闸门**（`tool-filter.js`），不是注册期裁剪——所以它
 * 不改 `registrationRev`、不重新注册任何人设、不影响别的会话。代价是它
 * 只封工具，不省掉 preset 里那些能力行；收益是它能做到全局开关永远做不到
 * 的事：同一个 profile 里，这场聊天、那场干活。
 *
 * 空字符串是「没有覆盖」，`normalizeMode` 又只认 `chat`，所以这里不能直接
 * 把空串喂进去——那会把「跟随全局」悄悄读成「工具模式」。
 * @param {{ session?: unknown, global?: unknown }} input
 * @returns {"chat" | "tools"}
 */
export function resolveMode({ session, global }) {
  const own = oneLine(session);
  return normalizeMode(own === "" ? global : own);
}

/**
 * `/waifu-mode` 的参数怎么读。
 *
 * 导出是为了能在没有宿主的自测里把每一种拼法钉死——这条命令会改全局文件，
 * 猜错一个拼法就是改错所有人的工具集。四个动作：
 *
 *   （空）/ status     → 只看，不动
 *   chat / work        → 改全局（`work` 是 `tools` 的别名，因为面板上写的是
 *                        「工作模式」，而内部值从第一天起就是 `tools`）
 *   here chat / work   → 只改这个会话
 *   here inherit       → 撤掉这个会话的覆盖，重新跟随全局
 *
 * 中文别名（聊天 / 工作）照收：用户嘴上说的是面板上的词，没理由让他记两套。
 * @param {unknown} raw
 * @returns {{ kind: "show" }
 *   | { kind: "global" | "session", mode: "chat" | "tools" | null }
 *   | { kind: "error", text: string }}
 */
export function parseModeCommand(raw) {
  const words = oneLine(String(raw ?? "")).split(/\s+/).filter((w) => w !== "");
  const word = (i) => oneLine(words[i]).toLowerCase();
  const modeOf = (w) => {
    if (w === "chat" || w === "聊天") return "chat";
    if (w === "work" || w === "tools" || w === "工作") return "tools";
    return null;
  };
  const usage =
    "用法：/waifu-mode 看现在是什么；/waifu-mode chat | work 改全局；/waifu-mode here chat | work | inherit 只改这个会话。";

  if (words.length === 0) return { kind: "show" };
  if (words.length === 1) {
    const only = word(0);
    if (only === "status" || only === "current") return { kind: "show" };
    const mode = modeOf(only);
    if (mode !== null) return { kind: "global", mode };
    return { kind: "error", text: `不认识的模式：「${words[0]}」。\n${usage}` };
  }
  if (words.length === 2 && word(0) === "here") {
    const only = word(1);
    if (only === "inherit" || only === "follow" || only === "跟随") {
      return { kind: "session", mode: null };
    }
    const mode = modeOf(only);
    if (mode !== null) return { kind: "session", mode };
    return { kind: "error", text: `不认识的模式：「${words[1]}」。\n${usage}` };
  }
  return { kind: "error", text: `参数太多，我只认得这几种。\n${usage}` };
}

/**
 * 一个会话究竟能不能看到任何工具，以及为什么。
 *
 * 导出它是因为它是条规则而非接线细节：`tool-filter.js` 负责会话如何被封
 * （restrict + guard），这里回答何时封。四种情况都真实存在，其中三种必须
 * 不封：
 *
 *   team            → 封。讨论按定义就是聊天；运行时自建请求、从不发送
 *                     `tools`，团队会话仍可能带工具的唯一地方就是该会话里的
 *                     普通回合。现在不会再有了。
 *                     注意这一档不看 `mode`：团队是形态，不是模式。工作模式
 *                     下的团队预设同样零工具——否则"团队不带工具"就成了
 *                     一句随开关变化的话。
 *   tools mode      → 开。这是开关出现之前每份安装的运行形态；闸门绝不能
 *                     从没拨过它的人手里夺走能力。
 *   聊天 + 本插件的会话 → 封。
 *   聊天 + 别人的会话   → 开。`mode.json` 是整个 profile 生效的，把每个 agent
 *                     都封掉会剥掉无关会话（bili-duty 定时任务、qq-bridge
 *                     agent）的工具，读起来像一次故障。
 *
 * @param {{ teamMode?: boolean, mode?: unknown, ours?: boolean }} input
 * @returns {"" | "team" | "chat"} 原因；会话保持开放时为 ""
 */
export function shouldSealTools({ teamMode, mode, ours }) {
  if (teamMode === true) return "team";
  if (normalizeMode(mode) !== "chat") return "";
  return ours === true ? "chat" : "";
}

/**
 * 纯聊天预设可挂载的能力行。
 *
 * 是白名单，不是黑名单：host 每发布一个新工具，`template.json` 就多一行，
 * 黑名单会悄悄把每个新工具交给已被切到纯聊天的人设。活下来的是一场对话的
 * 最低需求——人设本身、时钟，以及历史变长后的压缩。没有文件系统、shell、
 * 网络、子代理、计划或 todo 行。
 *
 * 组行整体保留（`compaction` 是个 `cordis:group`）：拆开拼它的子行会造出
 * host 从未校验过的形状。
 */
const CHAT_CAPABILITY_IDS = new Set(["persona", "time-context", "compaction"]);

/**
 * 把能力列表过滤到纯聊天集合。
 * @param {unknown} rows `template.json` 形态的能力行
 * @returns {unknown[]}
 */
export function chatRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter(
    (row) =>
      row !== null &&
      typeof row === "object" &&
      CHAT_CAPABILITY_IDS.has(row.id),
  );
}

/**
 * 一次注册实际挂载了什么，让后续扫描能区分"已注册"与"注册过，但她的文本
 * 自那以后变了"。
 *
 * 模式是指纹的一部分：拨动聊天开关会在不碰任何文件的情况下改变挂载的
 * 能力列表，忽略模式的 rev 会让 `scan()` 跳过每个人设，把旧工具集原样留在
 * 那里直到重启。
 * @param {{ text: string } | null} skeleton
 * @param {unknown} body
 * @param {unknown} [mode]
 */
export function registrationRev(skeleton, body, mode = "tools") {
  const frame =
    skeleton === null || skeleton === undefined ? "" : skeleton.text;
  return revision(
    `${normalizeMode(mode)}\u0000${frame}\u0000${String(body ?? "")}`,
  );
}

/**
 * 把一个输入参数解析成人设 id。
 *
 * 规则刻意朴素：剥掉一个可选的 `@` 与两侧空白，然后精确 id，然后精确显示
 * 名，然后是唯一的前缀。歧义作为候选返回而不是瞎猜——命令绝不能自作主张
 * 决定你在和谁说话。
 * @param {unknown} query 原始参数
 * @param {{ id: string, name?: string }[]} rows 花名册
 * @returns {{ ok: true, id: string } | { ok: false, error: string, candidates?: string[] }}
 */
export function matchPersona(query, rows) {
  const raw = oneLine(String(query ?? "").replace(/^@/, ""));
  const needle = raw.toLowerCase();
  if (needle === "") return { ok: false, error: "没有给出人设名。" };
  const byId = rows.find((row) => row.id.toLowerCase() === needle);
  if (byId !== undefined) return { ok: true, id: byId.id };
  const byName = rows.find((row) => oneLine(row.name).toLowerCase() === needle);
  if (byName !== undefined) return { ok: true, id: byName.id };
  const prefixed = rows.filter(
    (row) =>
      row.id.toLowerCase().startsWith(needle) ||
      oneLine(row.name).toLowerCase().startsWith(needle),
  );
  if (prefixed.length === 1) return { ok: true, id: prefixed[0].id };
  const names = (source) => source.map((row) => oneLine(row.name) || row.id);
  if (prefixed.length === 0) {
    return {
      ok: false,
      error: `没有叫「${raw}」的人设。`,
      candidates: names(rows),
    };
  }
  return {
    ok: false,
    error: `「${raw}」能对上 ${prefixed.length} 个，多打几个字：`,
    candidates: names(prefixed),
  };
}

/**
 * 一个会话的文本从哪些 id 里选，按具体程度排序。
 *
 * 挂载的人设刻意排在全局默认之前：会话头记录的是用户在新建任务页挑的
 * 预设，让默认获胜会把平台自己的每会话选择器变成摆设。`defaultId` 是挂载
 * 已不存在时的那一档。
 * @param {{ overrideId?: unknown, mountedId?: unknown, defaultId?: unknown }} source
 * @returns {string[]} 去重，空值剔除
 */
export function orderPersonaIds(source) {
  const seen = new Set();
  const out = [];
  for (const value of [
    source?.overrideId,
    source?.mountedId,
    source?.defaultId,
  ]) {
    const id = oneLine(value);
    if (id !== "" && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * 一个会话到底该不该有人设。
 *
 * 平台会求值 **每一条** 注册的提示词变量，无论模板是否引用它
 * （`@deepseek-ai/dsh-system-prompt:315-316` 在渲染任何一节之前会遍历每个
 * provider）。所以没有这道闸门，建立在普通 assistant 预设上的会话也会在
 * **每一步** 读骨架、浇人设、替换占位符并记录自己"提供了"什么——造出一串
 * 永远没人渲染的字符串。
 *
 * 这就是"非人设预设分文不付"这一承诺在源头兑现的样子，而不是仅仅因为模板
 * 碰巧没有那个占位符才成立。
 *
 * 会话合法要求人设的两种方式：显式的 `/waifu-change` 覆盖，或者本插件拥有
 * 的预设（`hasRow` 报告它，也涵盖"某个人设文件带着这个预设的 id"）。全局
 * 默认刻意不算——它是 `sessionPersona` *内部* 的后备，若让它在这里打开闸门，
 * 恰好会重新引入这道闸门要消除的成本。
 *
 * 空锚定保持开放：预设从未被投影的会话不等于"明确是普通预设"，默认那一档
 * 对它仍然必须生效。
 *
 * @param {object} [source]
 * @param {string|null} [source.overrideId] 本会话的 `/waifu-change` 选择
 * @param {string} [source.mountedId] 会话创建时的预设
 * @param {boolean} [source.hasRow] 该预设是否带有人设行
 * @returns {boolean}
 */
export function personaExpected({ overrideId, mountedId, hasRow } = {}) {
  if (oneLine(overrideId) !== "") return true;
  const mounted = oneLine(mountedId);
  if (mounted === "") return true;
  return hasRow === true;
}

/**
 * 一个完成的团队回合 → 每个认识的发言者各得一条。
 *
 * 纯函数并导出，让测试驱动写入路径用的同一个函数。之前的位置（`apply`
 * 内部）正是审计套件最后重新实现这条规则、然后测量自己那份拷贝的原因。
 *
 * `assistant/message` 携带的是渲染后的回复，不是协议：运行时推送
 * `renderSegment(event)`，而 `renderSegment` 输出剥掉 `〔名字〕` 标记的
 * `名字：台词`（`team-simulate.js`；`selftest-v3.mjs` 断言"原始标记不可
 * 见"）。只认标记的拆分器在每份真实团队回复里都找不到发言者，于是团队
 * 模式从未写过一条记忆——注入侧在读一个永远填不满的池子。两种形式都接受：
 * 协议文本先被规范化，因此死在渲染器之前的 run 也能拆分。
 *
 * 一个回合里一个人设的台词合并成一条记忆（见 {@link appendSaid}）：说两次
 * 话的成员是一次事件而不是两次，否则 20 个槽位每五个回合就滚没了。
 *
 * 目录里没人认领的名字直接跳过，而不是靠猜来存：把一句台词记到错误角色
 * 头上是面板无法撤销的那一种错误，因为等发现时，这份记忆已经在其他会话里
 * 被回忆了。
 *
 * @param {string} text 用户看到的回复
 * @param {ReadonlyArray<{ id: string, name?: string }>} roster 人设目录
 * @param {{ team?: string, session?: string }} where 要记录的出处
 * @returns {{ id: string, text: string, source: object }[]}
 */
export function splitBySpeaker(text, roster, where) {
  const byName = new Map();
  for (const row of Array.isArray(roster) ? roster : []) {
    const name = oneLine(row?.name);
    if (name !== "") byName.set(name, row.id);
  }
  /* 最长的名字优先：「托尔」必须赢过一个真的叫「托」的人设。 */
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const flat = String(text ?? "")
    .replace(/〔\/([^〕]{1,40})〕/g, "\n")
    .replace(/〔([^〕]{1,40})〕/g, "\n$1：");
  const said = new Map();
  let open = "";
  for (const rawLine of flat.split(/\n+/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const speaker = names.find(
      (one) => line.startsWith(`${one}：`) || line.startsWith(`${one}:`),
    );
    if (speaker !== undefined) {
      open = byName.get(speaker) ?? "";
      appendSaid(said, open, line.slice(speaker.length + 1).trim());
      continue;
    }
    /*
     * 有人说话，但目录里没有人叫这个名字——是中途被移出团队的成员，或一个
     * `〔旁白〕` 标记。关闭当前发言者并丢掉这一行：把台词继承给最后发言的
     * 人，是面板无法撤销的那一种错误，而这正是朴素的"先规范化再追加"在此处
     * 会做的事。
     */
    if (/^[^\s：:]{1,40}[：:]/.test(line)) {
      open = "";
      continue;
    }
    /*
     * 没人开头的一行是叙述，不是台词。它跟随已在发言的人（续段），没有人的
     * 时候就丢掉——另一条路是凭空捏造一个所有者。
     */
    if (open !== "") appendSaid(said, open, line);
  }
  const out = [];
  for (const [id, body] of said) {
    if (body === "") continue;
    out.push({
      id,
      text: pickSentence(body),
      source: {
        kind: "team",
        team: oneLine(where?.team),
        session: oneLine(where?.session),
      },
    });
  }
  return out;
}

/** 一个回合里一个人设的台词，合并后：一个回合一条记忆，不是五条。 */
function appendSaid(bucket, id, line) {
  if (id === "" || line === "") return;
  const previous = bucket.get(id);
  bucket.set(id, previous === undefined ? line : `${previous}\n${line}`);
}

/**
 * 一个回合里哪句话值得记住。
 *
 * 取前 60 个字符这条显而易见的规则，会系统性地留下
 * "哈哈哈，我才是最厉害的！"，丢掉三行之后的那句承诺。最长句不是语义
 * 判断，但至少偏向承载事件的那一句，而且零成本。
 * @param {string} text
 * @returns {string}
 */
export function pickSentence(text) {
  const body = String(text ?? "");
  const parts = body
    .split(/[。！？!?\n]+/)
    .map((one) => one.trim())
    .filter((one) => one !== "");
  if (parts.length === 0) return body.trim();
  let best = parts[0];
  for (const part of parts) if (part.length > best.length) best = part;
  return best;
}

/**
 * 这个 id 在谁手里——以上次扫描能证明的为准——一个词、一张真值表，由
 * Host、面板与测试共用。
 *
 * 四种答案的存在，是因为其中三种过去被压成了一句吓人的话：
 *
 *  - `ours`    本实例注册的它（或处于重新注册的两半之间——`registering`
 *              算作 ours，这正是让我们自己的反复不看起来像冲突的原因）；
 *  - `ghost`   有占用者，且组合指纹表明占用者是本插件的上一个实例。可行动：
 *              重启 DSH；
 *  - `foreign` 被我们认领不了的东西占用。这是关于 **所有权** 的陈述，与
 *              人设能不能用无关：id 能解析，会话能启动；未被证明的是它背后
 *              的文本是这个文件的；
 *  - `unknown` 扫描跑过了而上述都不成立——没有注册落地，也没看到占用者。
 *              旧代码把它画成「未注册」，与硬失败同一种红色，比证据支持的
 *              说法更多。
 *
 * 优先级是刻意的：ours 压倒一切（一行不能既是我们的又被别人占用），已被
 * 证明的 ghost 高于未被证明的占用者，因为它附带补救办法，"什么都没看到"
 * 是兜底。纯函数并导出，让面板的措辞与测试读同一张表，而不是各自从标志位
 * 重新推导。
 *
 * @param {object} [flags]
 * @param {boolean} [flags.owned] 由本插件注册（含交换进行中）
 * @param {boolean} [flags.ghost] 占用者被指纹识别为上一个实例
 * @param {boolean} [flags.foreign] 看到了不属于我们的占用者
 * @returns {"ours" | "ghost" | "foreign" | "unknown"}
 */
export function registrationState({ owned, foreign, ghost } = {}) {
  if (owned === true) return "ours";
  if (ghost === true) return "ghost";
  if (foreign === true) return "foreign";
  return "unknown";
}

/**
 * `readDocument()` 背后的组合文本，无论 Host 交回来的是什么形状。
 *
 * 该服务 resolve 出的是一个包装对象——`{ agentPreset, content, name?,
 * description? }`（见 `dsh-agent-preset-registry` 的 `readDocument`，其
 * `content` 是声明插件列表的 `dump()`）。ghost 检查的第一版假定原始字符串，
 * 于是 `String(object)` 塌缩成 `"[object Object]"`：指纹永远匹配不上，
 * `ghost` 不可达，每个被识别出的残留都落进一条怪罪无关声明的警告。
 *
 * 已经是结构的 `content` 会被序列化而不是字符串强转——这个检查是子串搜索，
 * 键与值都必须活下来。其他任何形状刻意返回 ""：读不出的文档必须让检查
 * 失败，绝不能让它通过。
 *
 * @param {unknown} doc `readDocument()` resolve 出的任何东西
 * @returns {string} 组合文本；形状不可读时为 ""
 */
export function documentText(doc) {
  if (typeof doc === "string") return doc;
  if (doc === null || typeof doc !== "object") return "";
  const content = doc.content;
  if (typeof content === "string") return content;
  if (content === null || typeof content !== "object") return "";
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

/**
 * 把一个 id 直接移到另一个 id 前面。
 *
 * @param {string[]} ids 当前序列
 * @param {string} movedId 被拖动的那一行
 * @param {string} beforeId 它被放到其前面的那一行
 * @returns {string[] | null} 新序列；移动是空操作时为 null
 */
export function reorderIds(ids, movedId, beforeId) {
  const from = ids.indexOf(movedId);
  const to = ids.indexOf(beforeId);
  if (from < 0 || to < 0 || from === to) return null;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(next.indexOf(beforeId), 0, movedId);
  return next;
}

/**
 * 一份预设定义：身份来自 front matter，能力来自模板，只替换人设行的
 * `prefix`。
 *
 * 前缀是占位符，不是文本：该行只挂载一次，其文本在每次组装时读取，这是
 * 会话在首个回合之后还能换人设的唯一途径。`assemble()` 仍在注册时运行，
 * 让不可用的正文在这里被拒绝，而不是拖到渲染时。
 *
 * 这里出去的 `order` 是移进本插件自己区段的局部 order——见
 * {@link PERSONA_ORDER_BASE}。没有自己 `order:` 的 wife 保持无排名
 * （`undefined`），在注册表中排最后、排在每条有排名的行之后，与从前一致。
 * @param {string} id - 预设 id（去掉 `.md` 的文件名）
 * @param {Record<string, unknown>} meta - 解析出的 front matter
 * @param {string} body - 存储状态的人设文本
 * @param {unknown[]} templateRows - 能力列表
 * @param {{ text: string } | null} [skeleton] - 共享骨架（若有）
 */
export function buildDefinition(id, meta, body, templateRows, skeleton = null, orderBase = PERSONA_ORDER_BASE) {
  const name = oneLine(meta.name) || id;
  const localOrder = normalizeOrder(meta.order);
  const poured = assemble(name, body, skeleton === null ? null : skeleton.text);
  return {
    id,
    name,
    description: oneLine(meta.description) || undefined,
    order: localOrder === undefined ? undefined : orderBase + localOrder,
    // `poured` 仍然要算：渲染器会拒绝的正文必须在面板保存它时就被拒绝，
    // 而不是等会话挂载它之后。
    plugins: templateRows.map((row) =>
      row && row.name === "@deepseek-ai/dsh-persona"
        ? {
            ...row,
            config: { ...(row.config ?? {}), prefix: PERSONA_PLACEHOLDER },
          }
        : row,
    ),
  };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dir?: string, template?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const resolved = resolveDir({ dir: config.dir, seed: true });
  const dir = resolved.dir;
  const dirSource = resolved.source;

  /** 打包目录会被下一次升级整体替换，所以它是只读的。 */
  const writable = dirSource !== "package";

  /**
   * 插件资产随版本走：只要这个目录是我们播种的，就把骨架和说明刷成包里这一版。
   *
   * 与「播种只做一次」的旧行为相反。骨架本身就是提示词的一部分——包里规则改
   * 了而用户目录停在上一版，同一份插件就会在不同机器上跑出两套行为，报上来的
   * 问题也就无从复现。人设 `*.md`、`persona-memory/`、`teams.json`、`mode.json`
   * 都不在刷新名单里，一个字节都不会被碰到（见 `seed-assets.js`）。
   *
   * 写失败不拦启动：一个只读或权限不全的目录不该让整块插件不加载，所以只记一
   * 条警告，扫描照常。
   */
  if (writable) {
    const refreshed = refreshAssets({
      dir,
      packageDir: PACKAGE_DIR,
      version: RUNNING_VERSION ?? "",
    });
    if (refreshed.ok !== true) {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 插件资产没能刷到当前版本：${refreshed.error ?? "未知原因"}`,
      );
    } else if (refreshed.written.length > 0) {
      const backup =
        refreshed.backedUp.length > 0
          ? `（原文件另存为 ${refreshed.backedUp.join("、")}）`
          : "";
      ctx.logger?.info?.(
        `dsh-waifu-agents: 已把 ${refreshed.written.join("、")} 更新到 ${RUNNING_VERSION ?? "当前版本"}${backup}`,
      );
    }
  }

  function readOnly() {
    return {
      ok: false,
      error: `当前人设目录在插件包内（${dir}），升级插件会整包替换它，所以这里不能写。请先在面板点「改目录」换成包外的目录，再回来编辑。`,
    };
  }
  const templatePath = path.resolve(
    config.template ?? path.join(PACKAGE_DIR, "template.json"),
  );

  /**
   * 团队模式的运行时，等依赖就绪后在更下面安装。
   *
   * 用 `let` 而非 `const`，因为它需要的几块——花名册读取器、人设解析器、
   * 活跃 agent 查找——定义在同一个函数的更后面，且每块都要等 `apply` 返回
   * 之后才可达。`null` 是诚实的初值：意思是"还没装上"，两处调用点都把它当
   * "团队模式不贡献任何东西"处理。
   */
  let teamRuntime = null;

  /**
   * 运行时工具闸门——让"聊天/团队会话一个工具都没有"成真而不止是意愿的
   * 那个东西。
   *
   * `chatRows()` 决定预设挂载哪些能力行，而那是只能在注册时、只对它自己
   * 的行做的决定：profile 层已经在全局层放了三十多个工具，预设只能追加、
   * 永远不能移除。所以能力列表是粗的那一半，真正兜住的是这一半——在
   * agent 自己的作用域上 `ctx.tools.restrict({ allow: [] })`，外加背后的
   * 一道执行守卫。见 `tool-filter.js`。
   *
   * `apply()` 还在接线时为 `null`：这个决定需要花名册、覆盖存储和影子表，
   * 全都定义在更下面。
   */
  let toolFilter = null;

  /**
   * configEditor 查找时这一行可能被叫到的 patch id。
   *
   * `persona-waifu` 这对是同一行改名前的拼写：在包变成 `dsh-waifu-agents`
   * 之前创建的 profile 仍带着那个 id，目录 / 默认人设设置就住在它上面。
   * 两种拼写都匹配，这些设置才能跨改名继续可用。
   */
  const SELF_IDS = [
    "waifu-agents",
    "include:waifu-agents",
    "persona-waifu",
    "include:persona-waifu",
  ];

  /**
   * preset id -> { dispose, rev, applied, epoch }：注销器、注册了什么、谁
   * 注册的它。
   *
   * 在本插件每一次存活的 apply() 之间共享（模块顶部的 `REG_STATE`）——每次
   * 调用各用一张 map，正是同一插件两次 apply 在全新安装上互相竞争、彼此把
   * 对方注册看成未知占用者的原因。共享一张 map 意味着这些行对每个实例都
   * 可见，扫描就不会把孪生的工作读成陌生人的。
   *
   * 可见不等于可继承：更晚的 apply 不会收养更早实例的行，而是接管它——
   * 注销旧注册，装上自己的（`scanOnce`，按 `instEpoch` 排序）。收养曾是
   * R5 的 bug：收养的实例持有这样一行，其注销器闭包在另一个实例的 fiber
   * 上，那个 fiber 一死注册跟着走，幸存者高高兴兴跳过它已不再拥有的 id。
   */
  const owned = REG_STATE.owned;

  /**
   * 哪个 apply() 写了账本行，它生于何时。
   *
   * 这行只说「这个 id 已注册，这是拆掉它的办法」。它不说「那个注销器之后
   * 仍然可调用」：函数闭包在注册实例的 fiber 上，fiber 一死它也死。两个
   * apply 共用账本时，更晚的那个过去会把更早的行当成自己的收下——同 id、
   * 同文本——然后继承一个先死的注销器。
   *
   *   `instToken` 回答「这行是不是 *我* 写的」。
   *   `instEpoch` 回答「写它的人生在我之前还是之后」。
   *
   * 两个都要。只有身份不构成接管规则：两个都存活的实例会各自看到异己令牌、
   * 各自拿走这一行，每次扫描都如此，永远——一场每次刷新都让注销器换手的
   * 乒乓。只有排序也不构成规则：没有令牌，实例分不清自己的过期行（文本变了
   * →重建）和更新实例的行（别碰）。合在一起给出一趟单向旅程：只有更早实例
   * 的行可以拿走，于是最后 apply 的实例拥有这个 id，而由于在普通重载形态里
   * 它也活得最久，注销器也归它。
   *
   * 在这里分配，每次 `apply()` 一次——绝不在 `scanOnce`。扫描是同一个实例
   * 再次发问；若让它推高计数，两个存活实例交替刷新就会轮流显得最新，乒乓
   * 又会从正门回来。
   */
  const instToken = {};
  const instEpoch = (REG_STATE.epoch = (REG_STATE.epoch ?? 0) + 1);

  /**
   * 属于我们但此刻暂时未注册的 id。
   *
   * 重新注册分两半——`unregister` 注销旧预设，然后 `register` 装上新文本
   * ——两者都要 await。落进这个空档的花名册读取，会为一个本插件仍然拥有的
   * wife 看到 `owned.has(id) === false`，面板把它画成
   * 「未注册 · 这个 id 被别的所有者占用了」。那句话是我们自己的簿记造出的
   * 诬告，而用户编辑一行然后点同一行的默认开关之后看到的正是它：失焦自动
   * 保存正在换手中，开关的重载却在要花名册。
   *
   * 用计数而不用 Set：`update` 与 `scan` 可能在同一个 id 上交叠，先完成的一
   * 方不能放掉另一方还握着的持有。与 `owned` 一样经由 `REG_STATE` 共享，理由
   * 相同：换手中的孪生 apply 必须在这里可见，否则另一个实例的扫描会把空档
   * 读成冲突。
   */
  const registering = REG_STATE.registering;

  /**
   * 截至上一次扫描，确实被其他所有者握着的 id。
   *
   * 这是「这个 id 被别的所有者占用了」为真的唯一证据，面板开口之前先读它。
   * 没有它，这一行只能猜——而猜错恰恰错在要紧的时刻。
   */
  const foreign = new Set();

  /**
   * 本插件的上一个实例仍然握着的 id（热重载幽灵）。
   *
   * `foreign` 意思是"被占用，占用者不明"；`ghosts` 把它收窄成"被占用，且
   * 占用者可证明就是我们"——面板对这两者的措辞不同，因为补救不同：生人
   * 意味着改文件名，幽灵意味着重启 DSH（过期注册活在上一个实例内部，没有
   * API 能碰到它）。
   */
  const ghosts = new Set();

  /**
   * 是否已经有一次扫描带着可读花名册完成？
   *
   * 在此之前 `owned` 为空，是因为还没有任何东西注册——不是因为某行失败。
   * 面板读 `owned` 来决定要不要画「未注册」，落在启动窗口里的读取会把每一
   * 行都画成未注册："还在启动"最吓人的一种呈现。改目录会重启本插件，所以
   * 面板开着的时候也可能撞上那个窗口。
   */
  let scannedOnce = false;

  const holdRegistration = (id) => {
    const key = oneLine(id);
    if (key === "") return;
    registering.set(key, (registering.get(key) ?? 0) + 1);
  };

  const releaseRegistration = (id) => {
    const key = oneLine(id);
    const count = registering.get(key);
    if (count === undefined) return;
    if (count <= 1) registering.delete(key);
    else registering.set(key, count - 1);
  };

  const fileFor = (id) => path.join(dir, `${id}.md`);

  /**
   * 一份解析好的文件，以路径为键，用 `(mtimeMs, size)` 校验。
   *
   * `chars` 是剥掉 front matter 并修剪文本之后的正文长度，所以不能从字节
   * 大小推出来（一个 CJK 字符三个字节）——缓存必须保存解析结果而不是字节。
   * `size` 只判断那份解析是否仍然有效，这与 harness 对 client bundle 的判断
   * 相同：mtimeMs/ctimeMs/size，从不做内容哈希。
   */
  const fileCache = new Map();
  let skeletonCache = null;

  function readPersona(full) {
    const stat = fs.statSync(full);
    const hit = fileCache.get(full);
    if (
      hit !== undefined &&
      hit.mtimeMs === stat.mtimeMs &&
      hit.size === stat.size
    )
      return hit;
    const raw = fs.readFileSync(full, "utf8");
    const { meta, body } = parseFrontMatter(raw);
    const entry = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      rev: revision(raw),
      meta,
      body,
      chars: body.length,
    };
    fileCache.set(full, entry);
    return entry;
  }

  /** 共享骨架；这个目录没有时为 null。 */
  function readSkeleton() {
    const full = path.join(dir, SKELETON_FILE);
    if (!fs.existsSync(full)) return null;
    const stat = fs.statSync(full);
    if (
      skeletonCache !== null &&
      skeletonCache.file === full &&
      skeletonCache.mtimeMs === stat.mtimeMs &&
      skeletonCache.size === stat.size
    ) {
      return skeletonCache;
    }
    const text = fs.readFileSync(full, "utf8");
    skeletonCache = {
      file: full,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      text,
      chars: text.length,
      rev: revision(text),
    };
    return skeletonCache;
  }

  /**
   * 写一个人设文件，让磁盘上的东西永远不是两个版本各自的一半：先暂存在
   * 目标旁边，再 `rename` 盖上去。本仓库播种目录用的就是这套（`seedInto`），
   * 理由相同——`rename` 是原子的，写到一半的文件不是。不保留 `.bak`：
   * 乐观锁（readPersona 在每次保存前对在盘文件取指纹）已经拒绝覆盖被外部
   * 改过的文件，而暂存改名不会留下任何需要恢复的半写状态。
   */
  function writeAtomic(full, text) {
    const stage = `${full}.stage-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(stage, text, "utf8");
      fs.renameSync(stage, full);
    } catch (error) {
      try {
        fs.rmSync(stage, { force: true });
      } catch {
        // 尽力而为
      }
      throw error;
    }
    fileCache.delete(full);
    skeletonCache = null;
  }

  /* ------------------------------------------- 会话人设覆盖 */

  /**
   * 本插件拥有的唯一路径。人设目录可写时就在该目录内，"插件留下了什么"
   * 恰好只有一个答案；只有只读后备时才放在 profile 主目录旁边。
   */
  const overrideFile = writable
    ? path.join(dir, OVERRIDE_FILE_IN_DIR)
    : path.join(homeFromEnv(process.env).home, OVERRIDE_FILE);
  const legacyOverrideFile = path.join(
    homeFromEnv(process.env).home,
    LEGACY_OVERRIDE_FILE,
  );

  /**
   * 人设长期记忆：每个人设一个 JSON，开关用一个 `_config.json`。放在
   * `teams.json` 和 `team-memory/` 旁边的理由与团队记忆相同——备份或清理
   * 不必知道第二个位置。
   */
  const personaMemoryDir = path.join(
    path.dirname(overrideFile),
    "persona-memory",
  );

  /* ------------------------------------------------------------ chat / tools */

  /** `mode.json`，在覆盖存储旁边——见 `MODE_FILE`。 */
  const modeFile = path.join(path.dirname(overrideFile), MODE_FILE);

  /**
   * 本进程运行所处的模式。
   *
   * apply 时读取一次，只有 `setMode` 会写它，而后者同时重新注册每个人设：
   * 能力列表在注册时就烤进去了，只改这个变量的开关会在面板里显得已生效，
   * 却直到下次重启都不改变模型看到的任何东西。
   */
  let currentMode = readStoredMode();

  function readStoredMode() {
    try {
      const parsed = JSON.parse(fs.readFileSync(modeFile, "utf8"));
      return normalizeMode(parsed?.mode);
    } catch {
      // 没有文件，或一次写到一半留下的读不出的文件：开关之前的
      // 行为（完整工具）是唯一安全的解读。
      return "tools";
    }
  }

  function writeStoredMode(mode) {
    fs.mkdirSync(path.dirname(modeFile), { recursive: true });
    writeAtomic(modeFile, `${JSON.stringify({ mode }, null, 2)}\n`);
  }

  /**
   * 一个预设拿到的能力行。
   *
   * 团队按定义是聊天，不是靠设置：每个成员都在运行时自建的请求里一次作答，
   * 发给它们 shell 或文件系统，描述的是讨论用不上的能力。这也是全局开关
   * 永远到不了团队预设的原因。
   * @param {"persona" | "team"} kind
   */
  function templateRowsFor(kind) {
    const rows = readTemplate();
    return kind === "team" || currentMode === "chat" ? chatRows(rows) : rows;
  }

  /** session id -> { personaId, at }；加载一次，原子重写。 */
  let overrides = null;

  function readOverrides() {
    if (overrides !== null) return overrides;
    const rows = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
      const stored =
        parsed !== null && typeof parsed === "object" ? parsed.overrides : null;
      if (stored !== null && typeof stored === "object") {
        for (const [sessionId, value] of Object.entries(stored)) {
          const personaId = oneLine(value?.personaId);
          if (sessionId !== "" && personaId !== "")
            rows[sessionId] = {
              personaId,
              at: Number(value?.at) || 0,
              // 本会话在没有任何覆盖时运行的预设，在第一次落下覆盖时捕获。
              // 此字段存在之前写入的记录里为空——那些退回读取 header。
              resting: oneLine(value?.resting),
            };
        }
      }
    } catch {
      // 文件缺失或读不出意味着"没有覆盖"——绝不让启动失败。
    }
    overrides = rows;
    return overrides;
  }

  /**
   * session id -> `"chat" | "tools"`。空表＝每个会话都跟随全局。
   *
   * 单独一张表而不是塞进 `overrides[sid]`：`setOverride(null)` 会连记录一起
   * `delete`，`/waifu-reset` 走的正是那条路。模式覆盖如果长在同一个对象上，
   * 一次「回到原来的人设」会顺手把「这个会话只聊天」也撤掉——那是两件事，
   * 用户没有要求后一件。
   *
   * 声明放在 `writeOverrides` 之前：那个函数在首次扫描期间就可能被调到，
   * `let` 的暂时性死区不会因为调用点在后面就网开一面。
   */
  let sessionModes = null;

  function writeOverrides() {
    const ordered = Object.entries(readOverrides()).sort(
      (a, b) => (b[1].at ?? 0) - (a[1].at ?? 0),
    );
    overrides = Object.fromEntries(ordered.slice(0, OVERRIDE_LIMIT));
    /*
     * `modes` 必须跟着一起写。这个文件是整份重写的，只序列化 `overrides`
     * 就会把每一条 `/waifu-mode here` 抹掉——而且是静默抹掉：切个人设，
     * 另一个会话的模式覆盖就没了。两条记录性质不同（一个是"这个会话是谁"，
     * 一个是"这个会话能不能用工具"），所以分两张表，但共用这一次原子写。
     */
    const keptModes = Object.fromEntries(
      Object.entries(readSessionModes()).slice(0, OVERRIDE_LIMIT),
    );
    sessionModes = keptModes;
    try {
      fs.mkdirSync(path.dirname(overrideFile), { recursive: true });
      const stage = `${overrideFile}.stage-${process.pid}`;
      fs.writeFileSync(
        stage,
        JSON.stringify({ version: 1, overrides, modes: keptModes }, null, 2),
        "utf8",
      );
      fs.renameSync(stage, overrideFile);
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 覆盖记录写不进去：${error?.message ?? error}`,
      );
    }
  }

  /**
   * 单独一张表而不是塞进 `overrides[sid]`：`setOverride(null)` 会连记录一起
   * `delete`，`/waifu-reset` 走的正是那条路。模式覆盖如果长在同一个对象上，
   * 一次「回到原来的人设」会顺手把「这个会话只聊天」也撤掉——那是两件事，
   * 用户没有要求后一件。
   */
  function readSessionModes() {
    if (sessionModes !== null) return sessionModes;
    const rows = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
      const stored =
        parsed !== null && typeof parsed === "object" ? parsed.modes : null;
      if (stored !== null && typeof stored === "object") {
        for (const [sessionId, value] of Object.entries(stored)) {
          const mode = oneLine(value);
          if (sessionId !== "" && MODES.includes(mode)) rows[sessionId] = mode;
        }
      }
    } catch {
      // 同 readOverrides：读不出就是「没有覆盖」，绝不让启动失败。
    }
    sessionModes = rows;
    return sessionModes;
  }

  /** 会话级覆盖；没有时为 `""`（跟随全局）。 */
  function sessionModeOf(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return "";
    const hit = readSessionModes()[sessionId];
    return hit === undefined ? "" : hit;
  }

  /**
   * 钉住或撤销一个会话的模式。
   *
   * 显式给 `here chat` 时会记下来，即使当时全局也是 `chat`——覆盖的语义是
   * 「钉住」，不是「和全局不一样才记」。否则用户说完 `here chat` 之后切一下
   * 全局，这个会话会跟着变，而他刚说过它要聊天。
   * @param {string} sessionId
   * @param {"chat" | "tools" | null} mode `null` 表示撤回、重新跟随全局
   * @returns {boolean} 记录是否已写入
   */
  function setSessionMode(sessionId, mode) {
    if (typeof sessionId !== "string" || sessionId === "") return false;
    const rows = readSessionModes();
    if (mode === null) delete rows[sessionId];
    else rows[sessionId] = normalizeMode(mode);
    sessionModes = rows;
    writeOverrides();
    /*
     * 立刻对活着的 agent 复查。`reconcileAll` 是幂等的，只在「该封却没封 /
     * 不该封却封着」时动手，所以这里不需要判断自己刚改的是哪一场。
     */
    toolFilter?.reconcileAll?.();
    return true;
  }

  function overrideOf(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return null;
    const hit = readOverrides()[sessionId];
    return hit === undefined ? null : hit.personaId;
  }

  /**
   * 本会话在没有任何覆盖时运行的预设，没有记录时为 `""`。
   *
   * `/waifu-reset` 读它，那是唯一必须知道会话来自哪里的调用者。为什么不能
   * 在重置时才从会话上读，见 {@link setOverride}。
   * @param {string} sessionId
   * @returns {string} 记录下的 id，或 `""`
   */
  function restingOf(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return "";
    const hit = readOverrides()[sessionId];
    return hit === undefined ? "" : oneLine(hit.resting);
  }

  /**
   * 把一个会话指向一个人设；给 `null` 则清除。
   *
   * `ownPreset` 是这个会话在完全无覆盖时会以什么身份运行，在本写入之前
   * 读取。只为第一次覆盖记录它，因为那是答案仍属于会话自己的最后时刻：
   * 之后的每次切换都发生在本插件已经把会话的 chip（
   * {@link rememberSessionPreset}）挪到上一个覆盖之后，那时读 chip 只会读回
   * 插件上一次自己的答案——这正是本字段要消灭的"/waifu-reset 回到上次切到
   * 的那张脸"bug。在新建任务屏上重新选过的会话最能说明问题：它的 header
   * 仍写着出生时的预设，chip 却写着重新挑的那个，而 `/waifu-reset` 欠的是
   * 重新挑的那个。
   * @param {string} sessionId
   * @param {string | null} personaId 覆盖；`null` 表示清除
   * @param {string} [ownPreset] 会话自己的预设，在本写入之前读取
   * @returns {boolean} 记录是否已写入
   */
  function setOverride(sessionId, personaId, ownPreset) {
    if (typeof sessionId !== "string" || sessionId === "") return false;
    const rows = readOverrides();
    if (personaId === null || oneLine(personaId) === "") delete rows[sessionId];
    else {
      const previous = rows[sessionId];
      const resting =
        oneLine(previous?.resting) ||
        (previous === undefined ? oneLine(ownPreset) : "");
      rows[sessionId] = {
        personaId: oneLine(personaId),
        at: Date.now(),
        ...(resting === "" ? {} : { resting }),
      };
    }
    writeOverrides();
    return true;
  }

  /**
   * 收编旧 0.3.x 时代放在 profile 主目录旁的覆盖文件，然后删掉它。
   *
   * 只读新路径会悄悄丢掉升级前做出的每一个每会话选择，而留下旧文件恰恰是
   * 评判卸载干净与否时最扎眼的残留。在 `apply` 时运行一次；只读目录没有可
   * 折入的新路径，直接跳过。
   * @returns {boolean} 是否找到并删除了旧文件
   */
  function foldLegacyOverrides() {
    if (!writable || legacyOverrideFile === overrideFile) return false;
    let parsed;
    try {
      if (!fs.existsSync(legacyOverrideFile)) return false;
      parsed = JSON.parse(fs.readFileSync(legacyOverrideFile, "utf8"));
    } catch {
      return false;
    }
    const stored =
      parsed !== null && typeof parsed === "object" ? parsed.overrides : null;
    if (stored !== null && typeof stored === "object") {
      const rows = readOverrides();
      for (const [sessionId, value] of Object.entries(stored)) {
        const personaId = oneLine(value?.personaId);
        if (
          sessionId === "" ||
          personaId === "" ||
          rows[sessionId] !== undefined
        )
          continue;
        rows[sessionId] = { personaId, at: Number(value?.at) || 0 };
      }
      writeOverrides();
    }
    try {
      fs.rmSync(legacyOverrideFile, { force: true });
      ctx.logger?.info?.(
        `dsh-waifu-agents: 会话覆盖已收进 ${overrideFile}，旧的 ${legacyOverrideFile} 已删除。`,
      );
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 旧覆盖文件删不掉：${error?.message ?? error}`,
      );
    }
    return true;
  }
  foldLegacyOverrides();

  /**
   * 一个人设按磁盘当前内容的组装文本。
   * @returns {{ ok: boolean, text: string, name: string, problems: string[] } | null}
   */
  function personaText(id, withSkeleton = true) {
    const full = fileFor(id);
    let parsed;
    try {
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
      parsed = readPersona(full);
    } catch {
      return null;
    }
    const name = oneLine(parsed.meta.name) || id;
    const skeleton = readSkeleton();
    const poured = assemble(
      name,
      parsed.body,
      withSkeleton && skeletonFor(parsed.meta, skeleton) !== null ? skeleton.text : null,
    );
    if (poured.ok) return { ok: true, text: poured.text, name, problems: [] };
    return {
      ok: false,
      text: String(parsed.body ?? ""),
      name,
      problems: poured.problems,
    };
  }

  /**
   * 可以安全交给渲染器的文本，或 null。
   *
   * 仍带着非法 `{{…}}` 的人设会在插值时掀翻整份系统提示词——这是本插件
   * 绝不能造成的那一种失败。不可用的候选被跳过，绝不上送。
   */
  function safeText(id, withSkeleton = true) {
    const candidate = personaText(id, withSkeleton);
    if (candidate === null) return null;
    if (candidate.ok) return candidate;
    const check = assemble(candidate.name, candidate.text, null);
    if (!check.ok) return null;
    return { ok: true, text: check.text, name: candidate.name, problems: [] };
  }

  /**
   * 只要正文，供团队模式。
   *
   * 讨论没有工具，把单人骨架浇进每个成员毫无收益，却让每个人头多付 1543
   * 字符。骨架里可迁移的部分改由 `TEAM_COMMON_RULES` 输出一次。这是同一份
   * 文本减去框架——不是缩短的人设：她自己的话原样保留，只去掉共享的外壳。
   */
  function personaBody(id) {
    return safeText(id, false);
  }

  /** 每个会话最近实际拿到的文本——最后一档，永不为空。 */
  const lastGood = new Map();

  /**
   * 会话已经收到过的显示名，最早的在前。
   *
   * 它存在是因为系统提示词不是请求里最强的身份信号。在真实对话上测过：
   * 切换后循环会原地重写提示词（旧 system 节点被清空，只有新人设对模型可见），
   * 新文本也正确送达——模型却仍以它最初自我介绍的那个人设作答。它自己更早
   * 的回合压过系统提示词。点名撤销那个身份会与那些回合矛盾；"其他一切身份
   * 一律作废"从不说哪些话作废，实测无效。
   */
  const servedNames = new Map();
  /** 足够点名模型可能仍携带的每一个身份。 */
  const SERVED_NAMES_LIMIT = 4;

  /**
   * 每个会话上一次组装时收到的人设。
   *
   * 切换提示与身份快照都要回答的问题是"这一轮说的人设和上一轮相同吗？"——
   * 答案无法来自人设的 SOURCE。`source === 'override'` 曾是"这个会话被移动
   * 过"的判据，它在回程上为假：`/waifu-reset`（或对会话所挂人设的修改）经由
   * `mounted` 这一档解析，而对话里还满是上一刻送到的人设。
   *
   * 在 `session-a367789b` 上测过：从照桥心美 `/waifu-reset` 回挂载的达克妮斯
   * 正确重写了 system 节点（`system/message` 带着达克妮斯、前面没有提示），
   * 运行时快照却悄悄丢掉了身份段而不是点名新人设，模型照桥心美地答了下去
   * ——「user (Somnivalis) asks 你是谁 … Komi would react with shock」——
   * 它自己更早的回合就是锚，与 {@link identityNoticeOf} 记录的完全一致。
   * 变了就是变了，落在哪一档都一样。
   */
  const servedIds = new Map();

  /**
   * 每个会话最近一次人设变更：`{ id, previousId, previousName }`。
   *
   * 是备忘，不是计数器：只要送达的仍是那个人设，人设文本和身份快照都会
   * 回读它，所以重复渲染一次组装不能把它消耗掉或触发两次。循环只在快照
   * 文本变化时才提交，因此停在原处的备忘不会产生重复消息。
   */
  const lastSwitch = new Map();

  /** 缓存的全局默认：provider 是同步的，而这次读取不是。 */
  let cachedDefault = { id: null, field: undefined, source: null, error: null, at: 0 };

  /**
   * 重读下一个会话实际会用哪个 wife。
   *
   * 下面的 2 秒窗口存在的原因是 `configEditor.edit()` 在 Loader 重新激活该行
   * 之前就结清了 patch 文件，写完立刻发起的重读仍可能答出上一个 id。把那个
   * 空档藏进缓存，只有对刚由本进程做出、且已经确认过的写入才是诚实的
   * ——这正是每个写入方都走 {@link verifyDefault}、活读一致后才落到这里
   * 的原因。`force` 就是那个校验器穿透窗口的方式，而不是被喂回它自己的
   * 乐观。
   *
   * @param {{ force?: boolean }} [options] `force` 绕过写入后的窗口
   */
  async function refreshDefault(options = {}) {
    if (
      options.force !== true &&
      cachedDefault.source === "settings" &&
      Date.now() - cachedDefault.at < 2000
    ) {
      return cachedDefault;
    }
    try {
      const found = await readDefaultId();
      cachedDefault = {
        id: found.id,
        field: found.field,
        source: found.source,
        error: found.error,
        at: Date.now(),
      };
    } catch (error) {
      cachedDefault = {
        id: null,
        field: undefined,
        source: null,
        error: String(error?.message ?? error),
        at: Date.now(),
      };
    }
    return cachedDefault;
  }

  /** 每 50ms 一次、足以熬过 Loader 重新激活一行的尝试次数。 */
  const DEFAULT_VERIFY_TRIES = 12;
  const DEFAULT_VERIFY_WAIT_MS = 50;

  /**
   * 等刚写下的 `selectedDefault` 变成注册表真正持有的东西。
   *
   * 写入不是真相，重读才是。只报写入正是面板与平台各执一词的原因：花名册
   * 和面板读取端会说出一个注册表没有的 id，用户刚把默认移走的那行继续挂着
   * 激活边框（要到下次进入才愈合），下一个新任务落在 profile 默认上而不是
   * 用户刚选的 wife。短轮询，不瞎猜。
   *
   * `field` 是 settings 面所报的显式 `selectedDefault`——刻意未设时为
   * `null`——在连 `settings` 面都没有的 profile 上是 `undefined`。只有第一种
   * 形式能确认一次清除；花名册面会把"未指定"解析成 profile 默认，分不清
   * 两者，所以改用 `previous` 来核对它们。
   *
   * @param {string | null} wanted 写入提交的值；`null` = 不指定任何人
   * @param {{ previous?: string | null, checkable?: boolean }} [context] 写入
   *   之前读取说了什么，以及是否有哪个面能确认这个字段
   * @returns {Promise<{ id: string | null, verified: boolean, checkable: boolean, attempts: number }>}
   */
  async function verifyDefault(wanted, context = {}) {
    const previous = context.previous ?? null;
    let checkable = context.checkable === true;
    let seen = previous;
    for (let attempt = 1; attempt <= DEFAULT_VERIFY_TRIES; attempt += 1) {
      const found = await refreshDefault({ force: true });
      seen = found.id;
      if (found.field !== undefined) {
        checkable = true;
        if (found.field === wanted)
          return { id: found.id, verified: true, checkable, attempts: attempt };
      } else if (seen !== null) {
        // 带着 `isDefault` 的花名册面解析出了某个 id。对非 null 的
        // `wanted` 这是一次真核对；对清除来说那只是透出来的 profile 默认，
        // 所以清除路径仍由 `field` 把门。
        if (wanted === null) {
          if (seen !== previous)
            return { id: seen, verified: true, checkable, attempts: attempt };
        } else {
          checkable = true;
          if (seen === wanted)
            return { id: seen, verified: true, checkable, attempts: attempt };
        }
      }
      if (attempt < DEFAULT_VERIFY_TRIES)
        await new Promise((resolve) => setTimeout(resolve, DEFAULT_VERIFY_WAIT_MS));
    }
    return { id: seen, verified: false, checkable, attempts: DEFAULT_VERIFY_TRIES };
  }
  /** 一个会话现在解析到哪个人设，经由哪一档。 */
  function sessionPersona(sessionId, mountedId) {
    const overrideId = overrideOf(sessionId);
    const rungs = orderPersonaIds({
      overrideId,
      mountedId,
      defaultId: cachedDefault.id,
    });
    for (const id of rungs) {
      const found = safeText(id);
      if (found === null) continue;
      const source =
        id === overrideId
          ? "override"
          : id === oneLine(mountedId)
            ? "mounted"
            : "default";
      return { id, source, text: found.text, name: found.name, rungs };
    }
    return { id: null, source: "none", text: null, name: null, rungs };
  }

  /**
   * 绑定到本会话实时状态的闸门。
   *
   * 决定本身放在导出的 {@link personaExpected} 里，作为规则接受测试；这里
   * 只提供它需要的三件事实。
   */
  function expectsPersona(sessionId, mountedId) {
    return personaExpected({
      overrideId: overrideOf(sessionId),
      mountedId,
      hasRow: hasPersonaRow(mountedId),
    });
  }

  /**
   * 记录这次组装送达了什么，并在人设变更时记住它。
   *
   * 由人设变量 provider 调用，组装器在渲染 `systemPrompt.context()` 贡献
   * 之前解析它（`.ref/system-prompt.js`：`variables[name] = provider(context)`
   * 在 :315，context 文本在 :348），而 `assemble()` 每步跑一次。这个顺序让
   * {@link identityNoticeOf} 能在同一次组装内回读备忘，于是提示词与快照
   * 描述的永远是同一个回合。
   *
   * 会话第一次出现时记录"没有要重新锚定的东西"而不是变更：从未切换过的
   * 会话只有一个声音，它的请求必须与没有这个特性时逐字节相同。
   *
   * @param {string} sessionId
   * @param {{ id: string, name: string }} found 即将送达的人设
   * @param {string} [previousName] 上一个送达的名字（若有）
   * @returns {boolean} 本回合是否是变更
   */
  function noteServed(sessionId, found, previousName) {
    if (sessionId === "") return false;
    const seen = servedIds.get(sessionId);
    const changed = seen !== undefined && seen.id !== found.id;
    if (changed)
      lastSwitch.set(sessionId, {
        id: found.id,
        previousId: seen.id,
        previousName: oneLine(previousName) || seen.name,
      });
    else if (seen === undefined) lastSwitch.set(sessionId, null);
    servedIds.set(sessionId, { id: found.id, name: found.name });
    return changed;
  }

  /**
   * 本会话当前正处于其中的人设变更，或 null。
   *
   * 以正在送达的人设为键，所以同一人设之后的每次组装（同样的回答、同样的
   * 文本、没有新快照）都消不掉这份备忘，直到被下一次变更替换。
   * @param {string} sessionId
   * @param {{ id: string }} found 即将送达的人设
   * @returns {{ id: string, previousId: string, previousName: string } | null}
   */
  function switchOf(sessionId, found) {
    const memo = lastSwitch.get(sessionId);
    if (memo === undefined || memo === null) return null;
    return memo.id === found.id ? memo : null;
  }

  /**
   * 这个会话需不需要把身份说出口——现在，或自上次变更以来？
   *
   * 只要送达的人设不是会话出生时的那个就为真：从旁路选定（一次覆盖
   * ——`/waifu-change`、选择器、面板的一次写入）或最近一次变更的目标
   * （`/waifu-reset` 也算）。送达那个人设期间它一直为真，已上线的行为对覆盖
   * 本来就是这么做的；保持这样也让送达文本回合之间完全一致，循环只在变更
   * 时重写一次提示词，而不是每步都重写。
   * @param {string} sessionId
   * @param {{ id: string, source: string }} found 即将送达的人设
   * @returns {boolean}
   */
  function reAnchored(sessionId, found) {
    return found.source === "override" || switchOf(sessionId, found) !== null;
  }

  /**
   * 切换提示：顶掉另一个人设的人设前面放一份，后面再放一份。
   *
   * 人设文本就是系统提示词，但在对话中途换掉它是弱信号：历史里已经满是上一
   * 位的声音，模型继续以她作答是报告最多的"切换没生效"。在送达的文本里把
   * 它说出来，就是重新锚定那个回合的办法。
   *
   * "顶掉另一个"是关于会话的事实，与人设来自哪一档无关——这条注释的第一句
   * 曾承诺「mounted 的情形不需要那句话，因为那里文本从未在运行中的对话底下
   * 变过」，而 {@link servedIds} 的日志显示 `mounted`
   * 一档带着身后整整另一个人设
   * 在对话中途到达。只要送达的人设变了就发这句话，mounted 与否皆然；见
   * {@link noteServed}。
   *
   * 刻意说两遍。`@deepseek-ai/dsh-persona` 把这段文本挂成唯一的
   * `complete: true` 一节，所以送达的字符串就是整份提示词——而能力不足的
   * 路由会让循环原地重写第一个 system 节点，即位置 0，处在一个已经装着上一
   * 位 wife 回合的对话之前（在 `dsh-agent-loop` 的
   * `SystemPromptProjection.project` 上测过：替换在头节点上携带
   * `surfaceOp: {op:'replace'}`）。模型只在最顶上见一次的指令正是它会飘走的
   * 指令；尾注放在设定结束、对话开始的地方。
   *
   * `previous` 列出本会话此前被送达过的人设，逐一点名的原因见
   * {@link servedNames}。
   * @param {string} text 组装好的人设
   * @param {string} name 她的显示名
   * @param {string[]} [previous] 本会话更早送达过的身份
   * @returns {string} 要送达的文本
   */
  function withSwitchNotice(text, name, previous = []) {
    if (config.switchNotice === false) return text;
    const names = (Array.isArray(previous) ? previous : []).filter(
      (value) => typeof value === "string" && value !== "" && value !== name,
    );
    const quoted = names.map((value) => `「${value}」`).join("、");
    const revoke =
      names.length === 0
        ? ""
        : `你此前在这个对话里是以${quoted}的身份回答的——那些话从现在起全部作废：你不是${names.join("，也不是")}。`;
    const trailer =
      names.length === 0
        ? `\n\n【本轮身份 · 最后确认】上面整段就是「${name}」的全部设定。从这一轮第一句话起，用她的口气说话、用她的口气思考，不要再退回中立助手腔。`
        : `\n\n【本轮身份 · 最后确认】上面整段就是「${name}」的全部设定。${quoted}都不是你了：别用她们的名字、口气、自称或口头禅，也别再提你「之前」是谁——照上面这一份重来。从这一轮第一句话起，连思考链都用「${name}」的口气走。`;
    return `【人设已切换】你现在是「${name}」。${revoke}下面整段就是她的全部设定；本对话里更早出现的其它身份、语气与自称一律作废，从这一轮起只按这一份来。\n\n${text}${trailer}`;
  }

  /**
   * 本会话此刻实际锚定的人设。
   *
   * 会话 header 只保存会话出生时的预设，此后永不再动。活的答案住在
   * `agentPreset` 会话投影里，每个 `agent-preset/selected` 事件都会推进它
   * ——注册表自己就是这么说的（`dsh-agent-preset-registry/lib/index.js:42`：
   * "Reconstruction reads the `agentPreset` Session projection, never the
   * header"）。读 header 正是从 UI 重新指向的会话继续以插件全局默认作答的
   * 原因：标题栏标签显示新选的名字，提示词里却还是旧的，于是之后的每次选择
   * 看起来都像没生效。
   *
   * 只在投影服务不可达时才退回 header；这里的 provider 是同步的，所以它也
   * 必须保持同步。
   * @param {unknown} agent 活跃 agent
   * @returns {string} 锚定预设 id；没有时为 `""`
   */
  function anchorOf(agent) {
    const session = agent?.session;
    if (session === undefined || session === null) return "";
    try {
      const projections = ctx.get("sessionProjections", false);
      const projected = oneLine(projections?.stateOf?.(session, "agentPreset"));
      if (projected !== "") return projected;
    } catch {
      // 没有投影服务（或这个键没有）：header 是剩下的唯一可读物，
      // 在这条路径上"没有锚定"好过抛错。
    }
    return oneLine(session.header?.agentPreset);
  }

  /**
   * 取一个服务，用 cordis 上下文提供的两种方式查找。
   *
   * `ctx.name` 是声明式取法，也是该信的那种：本插件 `inject` 列表里的名字
   * 保证在场，而裸的 `ctx.get(name)` 只在提供方 fiber 活跃期间有答案
   * ——插件管理器查找文档记载的正是同一个陷阱。两种取法在这里都不允许
   * 抛错，因为每个调用者都有定义好的"不可用"答案。
   *
   * @param {string} name
   * @returns {object | undefined}
   */
  function serviceOf(name) {
    try {
      const declared = ctx[name];
      if (declared !== undefined && declared !== null) return declared;
    } catch {
      /* 严格的上下文拒绝属性读取；`get` 仍可能作答 */
    }
    try {
      return ctx.get(name) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 本进程当前在驱动的每一个 Agent；服务不在、无法询问时为 `undefined`。
   *
   * `undefined` 与 `[]` 刻意分开：空列表意思是"没有人活着"，服务缺失意思是
   * "这个构建不让我看"——移动会话的调用者需要区分这两者，才知道什么都不做
   * 是决定还是失败。
   *
   * @returns {object[] | undefined}
   */
  function liveAgents() {
    const registry = serviceOf("agents");
    return typeof registry?.list === "function" ? registry.list() : undefined;
  }

  /** 会话 id 对应的活跃 agent，前提是本进程还有一个。 */
  function liveAgentFor(sessionId) {
    if (sessionId === "") return undefined;
    const live = liveAgents();
    if (live === undefined) return undefined;
    return live.find((agent) => oneLine(agent?.session?.id) === sessionId);
  }

  /**
   * 会话的 chip 此刻显示的是什么。
   *
   * 看投影，不看 header：`agentPresetProjectionDefinition.init` 只读一次
   * `header.agentPreset`，之后的每次移动都是叠上去的 `agent-preset/selected`
   * 事件，所以会话一旦被重新选过两者就不一致——这正是本函数的主题。header
   * 只是投影服务不可达的构建的后备。
   *
   * @param {object} session
   * @returns {string} 该 id；什么都没指名时为 ""
   */
  function shownPresetOf(session) {
    try {
      const projections = serviceOf("sessionProjections");
      if (projections !== undefined && typeof projections.stateOf === "function") {
        const value = projections.stateOf(session, "agentPreset");
        if (typeof value === "string" && value !== "") return value;
      }
    } catch {
      /* 落回 header */
    }
    return oneLine(session?.header?.agentPreset);
  }

  /**
   * 把会话自己的预设标签挪到它此刻正在扮演的 wife 上。
   *
   * 对话上方的 chip 不是我们的：`ui-agent-preset` 渲染
   * `session.projectionValues.agentPreset`（`presetOf`），而那个投影恰好由
   * 一种事件类型推进——
   *
   *     apply: (state, event) =>
   *       event.type === "agent-preset/selected" ? event.data.agentPreset : state
   *
   * ——由平台自己的 `select()` 写入。这正是切换过的会话一直显示出生时那个
   * wife 的原因，也是"这个能不能动态调"没有明显答案的原因。
   *
   * `select()` 本身在这里不可用：对已经开了回合的会话它抛
   * `agent-preset/locked`，因为指名新预设意味着重建那棵预设的整棵插件树
   * ——工具也在内。这里只追加事件本身，它移动标签而不动运行中的树。人设
   * 本来就由覆盖送达，标签说的话与模型被告知的终于一致。
   *
   * 两道护栏，都承重：
   *   - 只能指名已注册的预设。这个值会被持久化，恢复的会话挂载其投影指名的
   *     东西——没人服务的 id 会把下一次恢复变成失败的恢复。
   *   - `syncSessionChip: false` 把整件事关掉，因为在这里指名 wife，也正是
   *     恢复的会话以她身份回来的原因。
   *
   * @param {unknown} agent 拥有该会话的活跃 agent
   * @param {string} id 要指名的人设 id
   * @returns {boolean} 标签是否被移动
   */
  function rememberSessionPreset(agent, id) {
    if (config.syncSessionChip === false) return false;
    const session = agent?.session;
    if (session === undefined || session === null) return false;
    if (!owned.has(id)) return false;
    try {
      session.append("agent-preset/selected", { agentPreset: id });
      return true;
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 会话标签没跟上（${id}）：${error?.message ?? error}`,
      );
      return false;
    }
  }

  /**
   * 把标签放回这个会话在无覆盖时解析到的东西：它自己运行所用的预设，否则
   * 是全局默认。
   *
   * `/waifu-reset` 过去会让 chip 继续写着刚被放下的那个 wife，那是同一个
   * 谎言的另一个方向。
   *
   * "会话自己的预设"有三个答案，会话在新建任务屏被重新挑过之后三者就彼此
   * 不一致：
   *
   *   - 覆盖记录记住的东西（`ownPreset`，见 `setOverride`）——唯一正确的
   *     那个，因为插件自己的 chip 同步已在此之后把投影挪到了覆盖上；
   *   - header，写着会话出生时的预设；
   *   - 插件的全局默认，以上两者都不可用时。
   *
   * @param {unknown} agent 拥有该会话的活跃 agent
   * @param {string} [ownPreset] 记住的自有预设，最优答案在前
   * @returns {boolean} 标签是否被移动
   */
  function restoreSessionPreset(agent, ownPreset) {
    if (config.syncSessionChip === false) return false;
    const session = agent?.session;
    if (session === undefined || session === null) return false;
    const remembered = oneLine(ownPreset);
    const mounted = oneLine(session.header?.agentPreset);
    // 记住的或挂载的 id 都是会话本来就有过的东西，因此构造上就安全。
    // 默认只有在我们的人设之中时才可用。
    const resting =
      remembered !== "" ? remembered : mounted !== "" ? mounted : oneLine(cachedDefault.id);
    if (resting === "") return false;
    if (remembered === "" && mounted === "" && !owned.has(resting)) return false;
    try {
      session.append("agent-preset/selected", { agentPreset: resting });
      return true;
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 会话标签没复原：${error?.message ?? error}`,
      );
      return false;
    }
  }

  /**
   * 把还没开始的会话挪到刚被设为默认的那个人设上。
   *
   * 写 `selectedDefault` 只决定更晚创建的会话会被盖上什么章。已经存在的会话
   * ——包括停在新建任务屏上的那个空白会话，用户实际盯着的就是它的 chip
   * ——保有其 header 在创建时被盖上的 `agentPreset`，因为
   * `agentPresetProjectionDefinition.init` 只读一次 header，之后只有
   * `agent-preset/selected` 事件能移动它。
   *
   * 这是 `Settings → Agent Presets` 所做事情的后半，也是一次设置写入无法
   * 复现的那一半。它的 `save()` 运行
   *
   *     await write()            // settings.update(ns, { selectedDefault })
   *     await this.load()        // re-read the roster
   *     await sync(selected.id)  // syncBlankSession → seat.apply() → select()
   *
   * 所以官方页面移动默认并把空白会话重新安置到其上，而插件过去只做前者。
   * chip 于是继续写着空白会话出生时的那个 wife："在插件里改了默认，新会话却
   * 没跟上"，而注册表其实已经是对的——这正是同一时刻 Agent-Presets 页面
   * 显示着正确徽章的原因。
   *
   * `select()` 是搬运者，不是手搓的 append。对还没开回合的会话，它先重新
   * 绑定预设树、再追加事件，这才是 chip 与组合保持一致的原因；只追加会把
   * 新标签压在旧树上。它还免费带来我们想要的护栏：已经开了回合的会话会被
   * `agent-preset/locked` 拒绝，于是拒绝本身就是过滤器，代替在这里瞎猜的
   * 空白判据。
   *
   * 影响半径限定在仍跟随上一个默认的会话。被用户有意指向别处的会话
   * ——比如新建任务屏已经先停在 `minimal` 上的——绝不能被全局默认的改动
   * 顺带拖走。
   *
   * @param {{ to: string, from: string | null }} options 写入之后与写入之前
   *   各自解析出的默认
   * @returns {Promise<{ moved: string[], refused: number, reason: string | null }>}
   */
  async function resettleUnstarted({ to, from }) {
    const done = { moved: [], refused: 0, reason: null };
    if (oneLine(to) === "" || from === null || from === "") {
      done.reason = "没有可比的旧默认";
      return done;
    }
    if (oneLine(to) === oneLine(from)) {
      done.reason = "默认没变";
      return done;
    }
    const presets = serviceOf("agentPresets");
    if (presets === undefined || typeof presets.select !== "function") {
      done.reason = "这个环境拿不到 agentPresets.select";
      return done;
    }
    const live = liveAgents();
    if (live === undefined) {
      done.reason = "这个环境拿不到 agents 服务";
      return done;
    }
    for (const agent of live) {
      const session = agent?.session;
      if (session === undefined || session === null) continue;
      if (shownPresetOf(session) !== from) continue;
      try {
        await presets.select(agent, to);
        done.moved.push(oneLine(session.id));
      } catch {
        // 已经开了回合的会话会得到 `agent-preset/locked`——平台的拒绝是正确
        // 答案，不是值得上报的失败。
        done.refused += 1;
      }
    }
    return done;
  }

  /**
   * **送达的提示词里没有团队块，删掉它就是修复。**
   *
   * 过去每次组装都会调用 `teamRuntime.stage(agent)` 并追加返回的任何文本。
   * 在 v3 里那段文本永远是 `""`——讨论自建请求、不在根 agent 上安装任何
   * 东西——所以这个调用买不到任何东西，却让每一步都付一次完整的团队解析：
   * 读团队存储、扫人设目录、解析每个成员。
   *
   * 平台在每一步都解析 **每一条** 注册的提示词变量，无论模板是否引用
   * （`@deepseek-ai/dsh-system-prompt:315-316`）。于是一切会话、每一步、
   * 永远都在为这串要么为空、要么被追加到团队回合根本不会读的提示词后面的
   * 字符串付账。
   *
   * 漂移通知没有丢失，因为它们从来就不是对的通道：`/waifu-team` 在绑定时
   * 上报它们，`stateOf` 把它们报给面板。悄悄降级的团队经由用户刚敲下的东西
   * 保持可见——那本来就是他们会去看的地方。
   */

  /**
   * 每个人设行都指向的提示词变量；每次组装调用一次。
   *
   * ## 两个提前返回本身就是成本模型
   *
   * 平台在 **每一步** 都解析 **每一条** 注册的提示词变量，无论正在组装的
   * 模板是否引用它（`@deepseek-ai/dsh-system-prompt:315-316`）。所以"没人
   * 要它"省的是 token 不是工时：这个函数做什么，就是在每次组装里为本进程的
   * 每个会话做。碰到一个文件之前必须先放走两个答案：
   *
   *   1. **出生在团队预设上的会话。** 它的预设指名一个团队而不是文件，团队
   *      回合自建请求——讨论从不读根提示词。这过去会落到 `default` 一档，把
   *      **全局默认** 人设浇进团队会话，那不只是浪费：它把一段不相干的单人
   *      提示词塞进了每个不属于团队的回合。
   *   2. **从没要求过人设的会话**——不带 `/waifu-change` 的普通平台预设
   *      （见 `personaExpected`）。这条路径至多花一次 `existsSync`。
   *
   * 它绝不能抛错，也绝不能返回渲染器咽不下去的文本：这里抛错意味着会话根本
   * 起不来，比多送一个回合旧人设糟得多。
   */
  function resolvePersonaText(context) {
    const agent = context?.agent;
    const raw = agent?.session?.id;
    const sessionId = typeof raw === "string" ? raw : "";
    const mountedId = anchorOf(agent);
    const onTeamPreset = teamNameForPreset(mountedId) !== null;
    /*
     * *真的在跑* 团队讨论的会话拿不到人设正文：讨论自建请求，从不读根提示词。
     * 判据是 `isTeamSession`（只查 off/bound，不碰磁盘），**不是**
     * `teamNameForPreset(mountedId) !== null`：后者对 *出生* 在团队预设上的
     * 会话在离开团队模式之后仍然为真，这正是一个会话可能读起来像赤裸的
     * 无人设模型的途径。
     *
     * 出生在团队预设上、但已不在其上的会话（例如团队缩到一名成员，或用户
     * 移出了它）落到下面的正常档位——那里 `sessionPersona` 会跳过团队预设
     * id（它的人设文件不存在），落在默认人设上。
     */
    if (onTeamPreset) {
      if (teamRuntime?.isTeamSession?.(agent) === true) return "";
      // 已经不在团队上：跳过 `expectsPersona` 闸门（对团队预设它答 false
      // ——没有人设行，没有覆盖），直接送达默认那一档。
    } else if (!expectsPersona(sessionId, mountedId)) {
      return "";
    }
    try {
      const found = sessionPersona(sessionId, mountedId);
      if (found.text !== null) {
        const before = sessionId === "" ? [] : (servedNames.get(sessionId) ?? []);
        // 在这里记录，而不是由调用者记录：这个 provider 是唯一知道一个回合
        // 实际送达了什么的地方，而且它先跑（见 `noteServed`）。决定提示与否
        // 的是这一轮的人设是否不同于上一轮——这是关于会话的事实，与哪一档
        // 送达了它无关。
        noteServed(sessionId, found, before[before.length - 1]);
        const served = reAnchored(sessionId, found)
          ? withSwitchNotice(found.text, found.name, before)
          : found.text;
        if (sessionId !== "") {
          lastGood.set(sessionId, served);
          servedNames.set(
            sessionId,
            [...before.filter((value) => value !== found.name), found.name].slice(
              -SERVED_NAMES_LIMIT,
            ),
          );
        }
        return served;
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 解析人设失败：${error?.message ?? error}`,
      );
    }
    /*
     * 只有本插件拥有的、文件暂时读不出的会话才会走到这里——团队那一档已
     * 经在上面的提前返回里离开了。送上一份最近的好文本，好过什么都不送，
     * 也好过送别人。
     */
    const previous = sessionId === "" ? undefined : lastGood.get(sessionId);
    if (previous !== undefined) return previous;
    ctx.logger?.warn?.(
      `dsh-waifu-agents: 会话 ${sessionId || "(未知)"} 没有人设可用，这一段提示词会留空。`,
    );
    return "";
  }

  /** 在 apply 时注册一次：它比每个预设、每个会话都活得久。 */
  ctx.systemPrompt.variable("waifu_persona", resolvePersonaText);

  /** 只归我们；`contexts` 拒绝同一作用域内的重名。 */
  const IDENTITY_CONTEXT_NAME = "waifu-agents:identity";
  /** 排最后，身份因此是模型读到的快照的最后一行。 */
  const IDENTITY_CONTEXT_ORDER = 900;

  /**
   * 每回合的身份快照——唯一真正能重新锚定一次切换的通道。
   *
   * 人设是系统提示词，而对话中途换系统提示词被证明是太弱的信号。在这个
   * profile 上测过（`commandcode` / `deepseek-v4-flash`，`session-b6fb8a2b`）：
   *
   *   - 连做三次 `/waifu-change`，会话表面最终只剩一个 system 节点，带着最新的
   *     wife（2084 字符，`contextBreakdown` 里唯一 `system: true` 的节点，
   *     `surfaceOp: {op:'replace'}`，`cacheReadTokens: 0`——所以请求真的带上
   *     它了）；
   *   - 而模型三次都以第一位 wife 作答，推理时说「the system prompt of this
   *     session says I'm 宫内光华」，尽管请求里不是这样。它自己更早的两条
   *     回答才是锚，提示词不是。
   *
   * 所以身份要在模型逃不开的地方再说一遍。`systemPrompt.context()` 贡献不是
   * 提示词的一节：循环把它作为 USER 角色的快照投影进会话表面，追加在用户
   * 消息之后（`dsh-agent-loop` 的 `preStep` → `RuntimeContextProjection`），
   * 外面包着平台自己的头部——「Current runtime context. This snapshot
   * supersedes earlier runtime-context snapshots.」而且只有当它的文本变化时
   * 才重新发出，这正是 wife 变化的时刻。
   *
   * 两个值得记住的推论：
   *   - 快照文本过去要过 `interpolate()`，那把它变成一条要记住的规矩：这里
   *     绝不能出现任何 `{{…}}` 组。下面的注册现在传 `interpolate: false`，
   *     于是这不再是规矩，而成为代码的性质——名字碰巧长得像占位符的人设
   *     再也弄不坏一个回合。
   *   - `@deepseek-ai/dsh-persona` 在 `template.json` 里带着
   *     `includeRuntimeContext: false`，而那个抑制器会丢掉 agent 作用域里的
   *     每一个 context——包括这一个。模板行必须先停止抑制，这一切才送得到。
   *
   * 没人切换过的会话为空，刻意的：没动过的会话只有一个声音，不需要提醒，
   * 保持沉默让它的提示词与本特性出现之前逐字节相同。
   *
     * 条件是这一轮的人设是否不同于上一轮的，绝不看它是否由覆盖那一档解析
     * 而来。第二种读法是最先上线的，`/waifu-reset` 正是
   * 它的反例：回到挂载人设经由 `mounted` 一档解析，于是提醒恰好在模型有一个
   * 竞争声音需要丢掉的那个回合哑掉了。测量见 {@link servedIds}。
   *
   * @param {unknown} agent 活跃 agent
   * @returns {string} 快照文本；无话可说时为 `''`
   */
  function identityNoticeOf(agent) {
    const raw = agent?.session?.id;
    const sessionId = typeof raw === "string" ? raw : "";
    if (sessionId === "") return "";
    /*
     * 从来没有人设的会话没有要重新锚定的身份，什么都不说就是对它的全部承诺。
     * 在查找之前判，让普通预设不必为浇一份默认人设又把结果扔掉而付费
     * （见 `personaExpected`）。
     */
    const mountedId = anchorOf(agent);
    if (!expectsPersona(sessionId, mountedId)) return "";
    try {
      const found = sessionPersona(sessionId, mountedId);
      if (found.id === null) return "";
      // "人设变了吗"——问的是会话，不是它来自哪一档。这里的旧判据是
      // `found.source !== "override"`，它在回到挂载人设的路上为真，恰好在
      // 最需要提醒的那次重置上哑掉（见 `servedIds`）。
      const moved = switchOf(sessionId, found);
      if (moved === null && found.source !== "override") return "";
      const was = moved === null ? "" : moved.previousName;
      const from = was !== "" && was !== found.name ? `（上一轮还是「${was}」）` : "";
      return `【本轮身份 · 运行时确认】这个会话现在的人设是「${found.name}」${from}。上面更早出现的其它人设、以及你自己之前以别人身份说过的话，从现在起全部作废：按「${found.name}」说话、按她的口气思考。不要向用户解释这次变化，也不要提你「之前」是谁。`;
    } catch (error) {
      // 绝不抛错：它跑在 `assemble()` 里面，那里抛错会让整个请求失败。
      // 多送一个回合旧身份是小得多的损失。
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 组装身份快照失败：${error?.message ?? error}`,
      );
      return "";
    }
  }

  ctx.systemPrompt.context({
    name: IDENTITY_CONTEXT_NAME,
    order: IDENTITY_CONTEXT_ORDER,
    /* 人设的 NAME 是文件数据。理由与下面的记忆块相同。 */
    interpolate: false,
    text: (context) =>
      config.identityReminder === false ? "" : identityNoticeOf(context?.agent),
  });

  /* ------------------------------------------------- 人设长期记忆 */

  /*
   * 人设长记忆的存储半（身份快照、记忆归档、团队记忆视图）已搬进
   * `memory-ops.js`，与面板的 memory op 实现合住一个模块（它们共享
   * refreshMemorySnapshot / personaMemoryForTeam 这条读写链）。它在本文件
   * 后部的 "persona long-term memory ops" 原位置安装，晚于旧位置的原因见
   * 那里的接线注释。
   */
  /* ------------------------------------------- 写入路径：一个完成的回合 */

  /**
   * 记忆写入者的回合状态。
   *
   * 插件过去完全没有"这个回合结束了"的信号，这正是人设永远记不住自己说过
   * 什么的原因。host 的会话事件流带着它：每步一条 `assistant/message`（落盘
   * 文本、`interrupted` 标志），以及带 `reason.kind` 的 `turn/end`。只有
   * `completed` 会变成记忆——`aborted`、`interrupted`、`blocked`、
   * `max-tokens` 与 `error` 都意味着模型产出的文本不是用户收到的，此刻存下
   * 的半个回答会作为事实被注入之后的每个回合。
   */
  const turnBuffers = new Map();
  const writtenTurns = new Set();
  const writtenOrder = [];

  ctx.on("session/event", (session, event) => {
    try {
      observeTurn(session, event);
    } catch (error) {
      // 会抛错的监听器会把 host 的事件循环一起拖下水。
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 观察会话事件失败：${error?.message ?? error}`,
      );
    }
  });

  function observeTurn(session, event) {
    const type = oneLine(event?.type);
    const sessionId = oneLine(session?.id);
    if (type === "" || sessionId === "") return;
    const data = event?.data ?? {};
    const turn = Number.isFinite(data.turn) ? data.turn : -1;
    if (turn < 0) return;
    const key = `${sessionId}\u0000${turn}`;
    if (type === "turn/start") {
      turnBuffers.set(key, { text: "", interrupted: false });
      /*
       * 在本回合的请求被构建之前重申闸门。
       *
       * `turn/start` 在组装提示词与工具列表的那一步之前被追加（
       * `dsh-agent-loop` 的 `turn()` 先追加它，再循环 `preStep`），而这个
       * 监听器同步跑在那次追加里——所以自上次调和之后变化过的绑定仍然来得及。
       * 调和是幂等的，状态已匹配时什么也不做（不发 `tools/change`），这正是
       * 每个回合的常态。
       */
      toolFilter?.reconcileFor(sessionId);
      return;
    }
    if (type === "assistant/message") {
      const buffer = turnBuffers.get(key) ?? { text: "", interrupted: false };
      if (data.interrupted === true) buffer.interrupted = true;
      const text = textOfMessage(data.message);
      if (text !== "")
        buffer.text = buffer.text === "" ? text : `${buffer.text}\n${text}`;
      turnBuffers.set(key, buffer);
      return;
    }
    if (type !== "turn/end") return;
    const buffer = turnBuffers.get(key);
    turnBuffers.delete(key);
    /* `reason.kind` 就是全部裁决。缺了 reason 不代表"大概
       没事"：未知的结局恰恰是绝不能写下去的那种情况。 */
    if (oneLine(data.reason?.kind) !== "completed") return;
    if (buffer === undefined || buffer.interrupted === true) return;
    if (buffer.text.trim() === "") return;
    if (writtenTurns.has(key)) return;
    rememberTurnKey(key);
    void rememberTurn(sessionId, buffer.text, session).catch((error) => {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 写入长期记忆失败：${error?.message ?? error}`,
      );
    });
  }

  /** 已写回合的有界备忘，重复事件因此是空操作。 */
  function rememberTurnKey(key) {
    writtenTurns.add(key);
    writtenOrder.push(key);
    while (writtenOrder.length > 200) writtenTurns.delete(writtenOrder.shift());
  }

  /** 用户实际看到的文本，仅此而已。 */
  function textOfMessage(message) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const parts = [];
    for (const block of blocks) {
      // `reasoning` 与工具块不是她说的话。只有文本算数。
      if (block?.type !== "text") continue;
      const text = typeof block.text === "string" ? block.text : "";
      if (text !== "") parts.push(text);
    }
    return parts.join("\n").trim();
  }

  /**
   * 把一个完成的回合写进真正说了它的人名下。
   *
   * 团队房间：按发言者拆分回复——转写携带的渲染形式 `名字：台词`，或某个
   * run 死在渲染之前的 `〔名字〕` 协议——每个成员得到她自己的台词，没人继承
   * 别人的。单人声音：整份回复属于正在送达的人设，且仅当这个人设可被证明。
   */
  async function rememberTurn(sessionId, text, session) {
    const snapshot = memorySnapOf() ?? (await refreshMemorySnapshot());
    const roster = listFiles();
    const teamState = teamRuntime?.stateOf?.(sessionId);
    const teamMode = oneLine(teamState?.mode) === "team";
    /*
     * 工作模式的回合不写角色记忆，除非面板上明确打开了「工作模式也记」。
     *
     * 干活时的回复里，被 `pickSentence` 选中的「最长的一句」几乎总是代码、
     * 命令或一句总结——那不是她的经历。真机里已经因此存进过整行 SQL
     * （`feed_area`（区域，含 `shed_id`…）和工具调用协议残片；这两样都会在
     * 之后命中查询词时被当作「她记得的事」注入回去。
     *
     * 团队不在这条规则里：团队本来就是聊天（零工具），走的是上面那一支。
     */
    if (!teamMode && snapshot.config?.captureToolTurns !== true) {
      const modeNow = resolveMode({ session: sessionModeOf(sessionId), global: currentMode });
      if (modeNow !== "chat") return;
    }
    const plan = teamMode
      ? splitBySpeaker(text, roster, {
          team: oneLine(teamState?.team),
          session: sessionId,
        })
      : soloPlan(sessionId, text, session, roster);
    for (const item of plan) {
      // 被关掉的人设既不读也不积累。把全局开关关掉必须同时停住写入，
      // 否则"关"还会继续养大用户要求冻结的文件。
      if (!effectiveEnabled(snapshot.config, item.id)) continue;
      const store =
        snapshot.stores.get(item.id) ??
        (await readStore(personaMemoryDir, item.id));
      const limit = personaConfigOf(snapshot.config, item.id).maxEntries;
      const screen = screenEntry(store.entries, item.text);
      if (screen.ok !== true) continue;
      const next = appendEntry(
        store,
        { text: screen.text ?? item.text, source: item.source },
        limit,
      );
      await writeStore(personaMemoryDir, next.store);
      snapshot.stores.set(item.id, next.store);
    }
  }

  /**
   * 写入者的单人声音那一半。
   *
   * 与注入路径共用同一道闸门，刻意的。无法证明的归属直接跳过而不是猜：把
   * 一句台词记到错误的主名下，是面板无法撤销的那一种错误，因为等到有人
   * 发现时，那个人设已经在她服务的每个会话里回忆它了。
   *
   * `hasPersonaRow` 是闸门的另一半，它不是冗余。`expectsPersona` 对锚从未被
   * 投影的会话答 `true`——空锚是"未知"，不是"普通预设"——而默认那一档
   * 能说出一个不属于任何人设文件的 id。没有这道检查，跑平台预设的会话最终
   * 会得到 `persona-memory/code.json`：一份没有人要的记忆，在面板里列成一
   * 行来历用户既看不见也删不掉的记录。
   */
  function soloPlan(sessionId, text, session, roster) {
    const mountedId = shownPresetOf(session);
    if (!expectsPersona(sessionId, mountedId)) return [];
    const id = currentPersonaIdOf(sessionId, session);
    if (id === "" || !hasPersonaRow(id)) return [];
    const sentence = pickSentence(text);
    /*
     * 一句以「名字：」开头的台词，不是单人回合该记的东西。
     *
     * 它意味着这一轮的回复其实是**团队**的分段文本，而 `stateOf` 没认出来
     * （10-29 那次团队没退队的现场）：把 `托尔：（…）` 记到达克妮斯名下，
     * 是一份面板上无法追溯、却会被她每个会话召回的假记忆。团队路径里
     * 「认不出是谁说的宁可跳过」那条规则只在 team 分支生效，这里补上对应
     * 的一半 —— 归属证明不了，就不记。
     */
    if (speakerPrefixOf(sentence, roster) !== null) return [];
    return [
      {
        id,
        text: sentence,
        source: { kind: "solo", session: sessionId },
      },
    ];
  }

  /**
   * 这一行开头是不是名册里某位在说话。
   *
   * 只认 `名字：` / `名字:` 两种写法，且要求名字**就是**一个已注册人设：
   * 单人口吻里出现一个不认识的「某某：」更可能是台词本身，不能凭这个丢。
   * @param {string} text
   * @param {ReadonlyArray<{name?: string}>} roster
   * @returns {string | null}
   */
  function speakerPrefixOf(text, roster) {
    const line = oneLine(text);
    if (line === "") return null;
    for (const row of Array.isArray(roster) ? roster : []) {
      const name = oneLine(row?.name);
      if (name === "") continue;
      if (line.startsWith(`${name}：`) || line.startsWith(`${name}:`)) return name;
    }
    return null;
  }

  // 注册表经由设置文档写 `selectedDefault`，所以这是让同步缓存保持诚实的
  // 唯一信号。
  ctx.on("settings/document-updated", (namespace) => {
    if (namespace === REGISTRY_NS) void refreshDefault();
  });
  void refreshDefault();

  /**
   * 给组合里完全没有携带人设行的会话（比如 profile 默认 `cordis`）准备的
   * 影子：占位符不在那份提示词里，所以给那一个 agent 单独挂一段更近的。注销
   * 器搭在 agent 作用域上，`/waifu-reset` 在没有可跟随的东西时提前移除它。
   */
  const shadows = new Map();

  function ensureShadow(agent) {
    const sessionId = oneLine(agent?.session?.id);
    const agentCtx = agent?.ctx;
    if (
      sessionId === "" ||
      agentCtx === undefined ||
      agentCtx === null ||
      typeof agentCtx.effect !== "function"
    ) {
      return {
        ok: false,
        error:
          '拿不到这个会话的 agent 作用域，没法给"本来没人设"的会话单独挂一个人设。',
      };
    }
    if (shadows.has(sessionId)) return { ok: true };
    try {
      const dispose = agentCtx.effect(
        () =>
          agentCtx.systemPrompt.section({
            name: "deployment:persona-prefix",
            order: agentCtx.systemPrompt.getSectionOrder(
              "DEPLOYMENT_PERSONA_PREFIX",
            ),
            text: () => resolvePersonaText({ agent }),
            complete: true,
          }),
        "waifu-agents: session persona shadow",
      );
      shadows.set(sessionId, dispose);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `挂不上会话人设：${error?.message ?? error}` };
    }
  }

  function dropShadow(sessionId) {
    const dispose = shadows.get(sessionId);
    if (dispose === undefined) return;
    shadows.delete(sessionId);
    try {
      dispose();
    } catch {
      // agent 的作用域可能已经不在了；它的 effect 随之而去。
    }
  }

  /**
   * 这个会话的组合里有没有带着我们的人设行之一？
   *
   * `owned` 覆盖本插件注册的每个预设；盘上的文件覆盖人设文件带着却从未被
   * 注册的预设 id。这件事 **绝不能** 做的是解析文件并组装文本——它被
   * `personaExpected` 调用，而后者坐在无条件的每步变量路径上，被问到的唯一
   * 问题只是有没有这么一行。
   */
  function hasPersonaRow(mountedId) {
    const id = oneLine(mountedId);
    if (id === "") return false;
    return owned.has(id) || fs.existsSync(fileFor(id));
  }

  function readTemplate() {
    const rows = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(
        `${templatePath}: expected a non-empty array of plugin rows`,
      );
    }
    return rows;
  }

  function listFiles() {
    if (!fs.existsSync(dir)) return [];
    const seen = new Set();
    const out = [];
    const skeleton = readSkeleton();
    for (const entry of fs.readdirSync(dir).sort()) {
      if (!entry.endsWith(".md") || SKIP.has(entry)) continue;
      const full = path.join(dir, entry);
      if (!fs.statSync(full).isFile()) continue;
      seen.add(full);
      const id = path.basename(entry, ".md");
      const parsed = readPersona(full);
      const name = oneLine(parsed.meta.name) || id;
      const poured = assemble(
        name,
        parsed.body,
        skeletonFor(parsed.meta, skeleton) === null ? null : skeleton.text,
      );
      /*
       * `registering` 算作 owned：预设仍是本插件的，只是正处于重新注册的两半
       * 之间（见声明处）。把它报成无主，等于把我们自己的反复变成冲突警告。
       * 第一次扫描尘埃落定之前没有任何裁决，所以答案是"是，我们的"而不是
       * "不是"——见 `scannedOnce`。
       */
      const mine = scannedOnce !== true || owned.has(id) || registering.has(id);
      /* 是否真的观察到过冲突：只有 `scan` 能知道。 */
      const isForeign = foreign.has(id);
      /* 占用者是否可证明是本插件的上一个实例。 */
      const isGhost = ghosts.has(id);
      out.push({
        id,
        idOk: ID_OK.test(id),
        name,
        order: normalizeOrder(parsed.meta.order) ?? null,
        description: oneLine(parsed.meta.description) || null,
        group: oneLine(parsed.meta.group) || null,
        template: oneLine(parsed.meta.template) || null,
        chars: parsed.chars,
        charsFull: poured.text.length,
        problems: poured.problems,
        owned: mine,
        foreign: isForeign,
        ghost: isGhost,
        /*
         * 同样三个标志位，由共享真值表归并成一个词。随它们一起发布而不是
         * 取而代之：面板从 `state` 取徽章的措辞，而 `foreign`/`ghost` 保持
         * 可读，给任何想要原始证据的东西（以及旧面板）。
         */
        state: registrationState({ owned: mine, foreign: isForeign, ghost: isGhost }),
        mtimeMs: parsed.mtimeMs,
        size: parsed.size,
      });
    }
    for (const key of [...fileCache.keys()])
      if (!seen.has(key)) fileCache.delete(key);
    return out;
  }

  /**
   * 团队模式，接到本插件自己的接缝上。
   *
   * `team-runtime.js` 拥有一切团队形状的东西；它无从知道的是这份安装把文件
   * 放在哪里、一个会话此刻是谁、以及本插件怎么读自己的目录。那四个答案就是
   * 耦合的全部——其余一切都以普通数据穿过，于是 `team.js` 保持为叶子，
   * 运行时不需要 host 也能测试。
   */
  teamRuntime = installTeamRuntime(ctx, {
    storeFile: path.join(path.dirname(overrideFile), TEAM_FILE),
    /*
     * 账本放在 `teams.json` 旁边——用户已经为本插件拥有的同一个目录，备份或
     * 清理不必知道第二个位置。
     */
    runLogFile: path.join(path.dirname(overrideFile), RUN_LOG_FILE),
    /*
     * 团队记忆也住在它们旁边：每会话一个 JSON 文件，归本插件所有，由面板的
     * 清除 op 抹掉。假值会彻底关闭记忆——留给没有主目录的 host。
     */
    memoryDir: path.join(path.dirname(overrideFile), "team-memory"),
    roster: listFiles,
    personaTextOf: safeText,
    /*
     * 团队模式只要正文。运行时在这个钩子存在时优先于 `personaTextOf` 使用
     * 它，所以不提供它的 host 仍然能跑（只是付旧的每人骨架成本）。
     */
    personaBodyOf: personaBody,
    /*
     * 房间的长期记忆，由调用者按成员解析。
     *
     * 运行时拥有块放在哪里（任务之前，与剧情记忆同在一条 user 消息里）；
     * 这一边拥有谁记得什么，因为开关、作用域和文件全都住在这里。假值答案
     * 只意味着"没人有相关的东西"，必须根本不产出块。
     */
    personaMemoryOf: (input) => personaMemoryForTeam(input),
    coordinatorOf: (agent) => {
      const sessionId = oneLine(agent?.session?.id);
      if (sessionId === "") return null;
      const found = sessionPersona(sessionId, anchorOf(agent));
      if (found.id === null) return null;
      return { id: found.id, name: found.name ?? found.id };
    },
    /*
     * 这个会话出生在哪个团队——创建它时用的团队预设（若有）。这是配对的
     * 默认那一半：预设决定会话以什么开始，`/waifu-team` 是其上的覆盖，形状
     * 与全局默认人设和 `/waifu-change` 已经有的完全相同。
     */
    teamForPreset: (agent) => teamNameForPreset(anchorOf(agent)),
    /*
     * 「会话标签此刻停在哪」和「这个 id 是不是我们注册的人设」——团队绑定
     * 靠这两个答案察觉用户绕过了本插件：宿主自己的预设选择器不经过我们任何
     * 代码，`bound` 不会自己动，只有标签会。少了它们，在团队会话里换人之后
     * 回答你的仍是原来那一队，还会把那一轮写进团队剧情记忆。
     */
    chipOf: (agent) => anchorOf(agent),
    isPersonaPreset: (id) => owned.has(oneLine(id)),
    /*
     * chip 的移动。`team-runtime` 拥有绑定，但预设 chip 是平台的——所以它以
     * 回调的形式穿过去，与 `liveAgentFor` 同一条边界。尽力而为：没被注册成
     * 预设的团队（同步没跑完，或注册失败）只是让 chip 留在原处。
     */
    /*
     * 把会话标签挪到团队预设上；挪不动就**如实返回 false**，由命令说出口。
     *
     * 挪不动只有两个原因：`teamPresets` 里没有这支队（注册那一轮还没跑完，
     * 或者上一次注册被注册表拒了），或者平台拒绝了这次 `append`。前者可以
     * 现场补一次同步再试——2026-10-29 那场正是这样：`/waifu-team` 绑上了、
     * 托尔和康娜也真的在回答，标签却停在「达克妮斯」，而命令一个字都没提。
     * 于是 `/waifu-current` 报「本会话人设：达克妮斯」，用户合理地以为自己
     * 被换了人。
     */
    moveChipToTeam: async (agent, teamName) => {
      const attempt = () => {
        const id = teamPresetIdByName(teamName);
        return id !== "" && rememberTeamPreset(agent, id);
      };
      if (attempt()) return true;
      try {
        await syncTeamPresets();
      } catch {
        /* 同步自己会记录失败原因；这里只关心还能不能再试一次。 */
      }
      return attempt();
    },
    serviceOf,
    liveAgentFor,
    logger: ctx.logger,
  });
  ctx.on("dispose", () => teamRuntime?.dispose());

  /* ---------------------------------------------------- 运行时工具闸门 */

  /**
   * 把闸门接到本插件自己的事实上，别无其他。
   *
   * 规则是上面的 `shouldSealTools`（已导出，无 host 也可测试）。这里剩下的是
   * 它对每个 agent 需要的三个答案：这个会话此刻是否在团队上、全局开关说
   * 什么、以及服务它的是不是本插件。
   *
   * 其余一切——怎么封、怎么解、对每回合复查的幂等、host 没有 `ctx.tools`
   * 时怎么办——都住在 `tool-filter.js`，于是可以离线演练。
   */
  toolFilter = createToolFilter({
    decide: (agent) => {
      const sessionId = oneLine(agent?.session?.id);
      if (sessionId === "") return { seal: false, why: "这个 agent 没有会话 id" };
      const teamMode =
        oneLine(teamRuntime?.stateOf?.(sessionId)?.mode) === "team";
      /*
       * "在服务"意味着三件事之一，最后一档刻意不是 `currentPersonaIdOf`：
       * 它会退回全局默认人设，于是对 profile 里的每个会话都答"是她"
       * ——包括从没见过人设的那些。
       *
       *   shadows.has(...)      我们把人设挂在了自有预设不带人设行的会话上
       *   overrideOf(...) !== "" 会话被手动指到了一个人设
       *   hasPersonaRow(anchor) 它运行的预设就是我们的人设行之一
       */
      const ours =
        teamMode ||
        shadows.has(sessionId) ||
        oneLine(overrideOf(sessionId)) !== "" ||
        hasPersonaRow(anchorOf(agent));
      /*
       * 模式按会话解析，不直接读全局开关：`/waifu-mode here chat` 钉住的
       * 那一场要能不跟着全局走，否则这个命令就没有存在的理由。`resolveMode`
       * 里空串＝跟随全局，别在这里手写 `||`——那样「没有覆盖」和「显式
       * tools」会被合并成同一个值。
       */
      const why = shouldSealTools({
        teamMode,
        mode: resolveMode({ session: sessionModeOf(sessionId), global: currentMode }),
        ours,
      });
      return { seal: why !== "", why: why === "" ? "这个会话不封" : why };
    },
    listAgents: liveAgents,
    logger: ctx.logger,
  });

  /*
   * 先封已经在跑的，再跟上其余的。
   *
   * `agent/created` 是 host 文档化的每 agent 注册接缝（
   * `dsh-agent-preset/skills/.../practices.md: register per-agent behaviour on
   * agent.ctx, obtained in an agent/created listener`），`restrict`/`guard`
   * 建出的 effect 归那个 agent 的 fiber 所有——于是被 host 注销的 agent 带着
   * 自己的闸门走。`forget` 只丢本文件的账。
   */
  for (const agent of liveAgents() ?? []) toolFilter.reconcile(agent);
  ctx.on("agent/created", ({ agent }) => {
    toolFilter?.reconcile(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    toolFilter?.forget(agent);
  });
  ctx.on("dispose", () => toolFilter?.dispose());

  /* ------------------------------------------------- 团队即真预设 */

  /*
   * 注册引擎、面板 op 表和团队预设同步住在 `panel-ops.js`。留在这里的是
   * deps 袋——这块区域与 apply() 其余部分一直共享的东西的诚实清单——外加
   * 把 op 函数按自己的名字交还的解构，于是下面的分发器和启动链读起来不变。
   *
   * 五个 thunk 存在的原因是那些绑定在这里是 `let`：值拷贝会在 `apply` 重新
   * 赋值的那一刻过期。
   */
  const {
    batch,
    create,
    exportAll,
    exportArchive,
    exportOne,
    exportTemplate,
    findRegistryEntry,
    hiddenList,
    importMd,
    moveDefaultOff,
    readDefaultId,
    readOne,
    reconcileDefault,
    rememberTeamPreset,
    remove,
    rename,
    repointDefault,
    restore,
    scan,
    search,
    setDefault,
    setDir,
    setMode,
    setSkeleton,
    skeletonOp,
    status,
    syncTeamPresets,
    teamNameForPreset,
    teamPresetIdByName,
    update,
    writeDefault,
  } = installPanelOps(ctx, {
    ID_OK,
    MODES,
    PROMPT_VARIABLES,
    PROMPT_VARIABLE_NAME,
    REG_STATE,
    RESERVED,
    SKELETON_FILE,
    TEAM_ORDER_BASE,
    assemble,
    buildDefinition,
    buildZip,
    documentText,
    migratePersona,
    normalizeMode,
    normalizeOrder,
    oneLine,
    parseFrontMatter,
    registrationRev,
    renderPersona,
    reserved,
    revision,
    skeletonFor,
    templateProblem,
    PERSONA_PLACEHOLDER,
    SELF_IDS,
    MODE_FILE,
    PACKAGE_DIR,
    REGISTRY_NS,
    TEAM_PRESET_PREFIX,
    anchorOf,
    config,
    dir,
    dirSource,
    fileFor,
    foreign,
    ghosts,
    holdRegistration,
    instEpoch,
    instToken,
    listFiles,
    owned,
    personaMemoryDir,
    readOnly,
    readPersona,
    readSkeleton,
    refreshDefault,
    refreshMemorySnapshot: (...args) => refreshMemorySnapshot(...args),
    registering,
    releaseRegistration,
    resettleUnstarted,
    serviceOf,
    templatePath,
    templateRowsFor,
    verifyDefault,
    writable,
    writeAtomic,
    writeStoredMode,
    teamRuntimeOf: () => teamRuntime,
    toolFilterOf: () => toolFilter,
    currentModeOf: () => currentMode,
    setCurrentMode: (mode) => {
      currentMode = mode;
    },
    markScanned: () => {
      scannedOnce = true;
    },
    defaultCache: () => cachedDefault,
  });

  /* ------------------------------------------------ 自更新（版本陷阱） */

  /*
   * 检查、tarball 安装和进度推送现在都住在 `self-update.js`。留在这里的是它
   * 无法拥有的唯一一件事：这一行询问的是哪个注册表。它以 thunk 的形式交接，
   * 因为 `config` 是行自己的 schema 对象，插件运行期间面板可能把行指向别处。
   */
  const updater = installSelfUpdate(ctx, {
    registryOf: () => config.registry,
  });


  /**
   * 活跃花名册。这是看清一个 wife 是否真的挂载了的唯一办法：`register()`
   * 把激活失败作为 `broken` 记在记录上而不是移除它，所以"文件存在"永远证明
   * 不了"预设能用"。
   */
  async function roster() {
    try {
      // 与 `status()` 同理：从缓存作答的读取端可能把错误的行标成默认，
      // 而这正是画激活边框的那个面。
      await refreshDefault();
      const presets = await ctx.agentPresets.list();
      return {
        ok: true,
        count: presets.length,
        defaultId: cachedDefault.id,
        defaultSource: cachedDefault.source,
        defaultError: cachedDefault.error,
        // 持久化的默认指名的是这个注册表真的持有的预设吗？
        //
        // 这里过去写成「悄悄落到列表第一项」，引用的是 composer 自己的
        // `fallback = presets.find(p => p.isDefault)?.id ??
        // presets[0]?.id ?? ""`（`ui-agent-preset.js:1263`）。那是渲染器的
        // 后备，而且永远走不到：服务先解析默认，`retain()` 抛出
        // `agent-preset/not-found: Unknown agent preset: <id>`（`registry.js:643`）。
        // 所以悬空的默认不会降级到第一行——它直接挡死每一个新会话，面板根本
        // 不在局中，也没有行可点。标志保留；它的含义是「新会话会直接失败」，
        // 而且 `reconcileDefault()` 现在会清掉它，而不只是上报。
        //
        // 没有任何面指名默认时为 `null`：那意味着「不知道」，不是
        // 「指不到人」。在那里报 `false` 会冤枉一个只是什么都没设的 profile
        // ——何况 `readDefaultId` 本来就经由花名册面解析注册表自己的
        // `selectedDefault ?? config.default` 后备，真正的默认通常不会是
        // `null`。
        defaultResolves:
          cachedDefault.id === null
            ? null
            : presets.some((row) => row.id === cachedDefault.id),
        presets: presets.map((row) => ({
          id: row.id,
          name: row.name ?? null,
          order: row.order ?? null,
          isDefault: row.id === cachedDefault.id,
          broken: typeof row.broken === "string" ? row.broken : null,
        })),
      };
    } catch (error) {
      return { ok: false, error: `读不到人设名册：${error?.message ?? error}` };
    }
  }

  /**
   * 选择器需要的东西：花名册、全局默认，以及本会话当前的答案。`active`
   * 标出会话实际解析到的那一行。
   */
  async function waifuState(request) {
    const sessionId = oneLine(request.sessionId);
    const mountedId = oneLine(request.mountedId);
    await refreshDefault();
    const orderOf = (item) =>
      typeof item.order === "number" ? item.order : Number.MAX_SAFE_INTEGER;
    const rows = listFiles()
      .filter((item) => item.problems.length === 0 && item.idOk === true)
      .map((item) => ({
        id: item.id,
        name: item.name,
        group: item.group,
        order: item.order,
        description: item.description,
        isDefault: cachedDefault.id === item.id,
      }))
      // 排序属于这个数组。把 `.sort` 接在 `.map` 里面排的是一个行对象自己的
      // 键——对象没有 `.sort`，于是这个 op 的每次调用都抛错，选择器什么也
      // 列不出来。
      .sort(
        (a, b) =>
          orderOf(a) - orderOf(b) ||
          String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)),
      );
    const found =
      sessionId === ""
        ? { id: null, source: "none" }
        : sessionPersona(sessionId, mountedId);
    return {
      ok: true,
      override: overrideOf(sessionId),
      mounted: mountedId === "" ? null : mountedId,
      defaultId: cachedDefault.id,
      defaultError: cachedDefault.error,
      active: found.id,
      source: found.source,
      rows,
    };
  }

  /* ------------------------------------------------------------- 团队模式 */

  /*
   * 团队模式的面板目录（teamState / teamSet / teamMemoryClear）已搬进
   * `team-mode.js`。这里只保留接线：闭包句柄按值递进去；`choosableRows`
   * 住在 memory-ops，其安装在本调用之后，所以走惰性 thunk（调用发生在
   * apply() 完成之后，绑定那时早已就位）。
   */
  const {
    teamState,
    teamSet,
    teamMemoryClear,
  } = installTeamMode(ctx, {
    oneLine,
    CAP_POLICIES,
    NAME_LIMIT,
    TEAM_LIMIT,
    adoptTeam,
    defaultNamesTeam,
    defaultRenameFollow,
    expandSelection,
    saveTarget,
    storeProblem,
    refreshDefault,
    listFiles,
    moveDefaultOff,
    repointDefault,
    syncTeamPresets,
    teamPresetIdByName,
    choosableRows: (...args) => choosableRows(...args),
    teamRuntime: () => teamRuntime,
    cachedDefault: () => cachedDefault,
  });
  /* --------------------------------------------- 人设长期记忆 ops */

  /*
   * 人设长记忆与 memory / team / purge 这些 op 的实现在 `memory-ops.js`。
   * 安装点放在 panel-ops 的解构与 updater 之后：它们依赖 roster、
   * setDefault、writeDefault 这些晚于旧安装位置初始化的绑定。返回值供
   * 两处使用：写入路径（refreshMemorySnapshot）与下面的 `run` 分发器。
   */
  const {
    refreshMemorySnapshot,
    personaMemoryForTeam,
    currentPersonaIdOf,
    memorySnapOf,
    choosableRows,
    teamPick,
    memoryState,
    memorySet,
    memoryEntries,
    memoryEdit,
    memoryRemove,
    memoryClear,
    purge,
    waifuApply,
    waifuClear,
    waifuOrder,
  } = installMemoryOps(ctx, {
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
    safeText,
    scan,
    servedIds,
    sessionPersona,
    setDefault,
    setOverride,
    shownPresetOf,
    teamMemoryClear,
    teamSet,
    teamState,
    verifyDefault,
    waifuState,
    writeAtomic,
    writeDefault,
    readOnly,
    writable,
    refreshDefault,
    teamRuntime: () => teamRuntime,
    cachedDefault: () => cachedDefault,
    resetOverrides: () => {
      overrides = {};
    },
  });
  async function run(request) {
    const op = String(request.op ?? "list");
    if (op === "list") return status();
    if (op === "get") return readOne(request);
    if (op === "refresh") {
      const result = await scan();
      /*
       * 重读目录的同一个按钮也重读记忆：磁盘上的东西在面板外被改过时，这是
       * 用户唯一的杠杆，否则快照只会被我们自己的写入刷新。
       */
      await refreshMemorySnapshot();
      // `status()` 又是 async 的了（它为 `defaultId` 读花名册），所以展开需要
      // 一个 await——裸展开会展开一个 Promise。
      return { ...(await status()), ...result };
    }
    if (op === "create") return create(request);
    if (op === "update") return update(request);
    if (op === "rename") return rename(request);
    if (op === "remove") return remove(request);
    if (op === "hidden") return hiddenList();
    if (op === "restore") return restore(request);
    if (op === "batch") return batch(request);
    if (op === "search") return search(request);
    if (op === "skeleton") return skeletonOp();
    if (op === "setSkeleton") return setSkeleton(request);
    if (op === "import") return importMd(request);
    if (op === "export") return exportOne(request);
    if (op === "exportAll") return exportAll();
    if (op === "exportArchive") return exportArchive(request);
    if (op === "template") return exportTemplate();
    if (op === "setDir") return setDir(request);
    if (op === "setMode") return setMode(request);
    if (op === "setDefault") return setDefault(request);
    if (op === "roster") return roster();
    if (op === "waifuState") return waifuState(request);
    if (op === "waifuApply") return waifuApply(request);
    if (op === "waifuClear") return waifuClear(request);
    if (op === "waifuOrder") return waifuOrder(request);
    if (op === "teamState") return teamState();
    if (op === "teamSet") return teamSet(request);
    if (op === "teamPick") return teamPick(request);
    if (op === "teamMemoryClear") return teamMemoryClear();
    if (op === "memoryState") return memoryState();
    if (op === "memorySet") return memorySet(request);
    if (op === "memoryEntries") return memoryEntries(request);
    if (op === "memoryEdit") return memoryEdit(request);
    if (op === "memoryRemove") return memoryRemove(request);
    if (op === "memoryClear") return memoryClear(request);
    if (op === "updateCheck") return updater.updateCheck();
    if (op === "updateApply") return updater.updateApply(request);
    if (op === "updateProgress") return updater.updateProgress(request);
    if (op === "purge") return purge(request);
    return {
      ok: false,
      error: `未知的 op：${op}（可用：list / get / refresh / create / update / rename / remove / hidden / restore / batch / search / skeleton / setSkeleton / import / export / exportAll / template / setDir / setMode / setDefault / roster / waifuState / waifuApply / waifuClear / waifuOrder / teamState / teamSet / teamPick / teamMemoryClear / updateCheck / updateApply / updateProgress / purge）`,
    };
  }

  // 一个操作一份实现；面板经由生成出的 `ctx.remote.commands` 面到达它，
  // agent 工具之后也可以调用 `run`。
  ctx.commands.register({
    name: "persona",
    description:
      "dsh-waifu-agents：list / get / refresh / create / update / rename / remove / hidden / restore / batch / search / skeleton / setSkeleton / import / export / exportAll / template / setDir / setMode / setDefault / roster / updateCheck / updateApply / updateProgress。",
    input: { hint: '{"op":"list"}' },
    handler: async ({ rawInput }) => {
      let request;
      try {
        request = JSON.parse(String(rawInput ?? "").trim() || "{}");
      } catch (error) {
        return {
          kind: "error",
          text: `参数不是合法 JSON：${error.message ?? error}`,
        };
      }
      try {
        const payload = await run(request);
        const text = JSON.stringify(payload);
        return payload && payload.ok === false
          ? { kind: "error", text }
          : { kind: "success", text };
      } catch (error) {
        return {
          kind: "error",
          text: `${String(request.op ?? "list")} 失败：${error?.message ?? error}`,
        };
      }
    },
  });

  /* ------------------------------------------- 会话人设命令 */

  /*
   * 三个 `/waifu-*` 命令住在 `commands.js`。留在这里的是唯一搬不动的：
   * 它们需要的那袋句柄。每一项都是指向上方闭包的函数引用，而
   * `teamRuntimeOf` 之所以是 thunk，是因为团队运行时在本函数里建得比这次
   * 调用晚——捕获的值会永远是 `null`。
   */
  installCommands(ctx, {
    anchorOf,
    applySessionMode: (sessionId, mode) => setSessionMode(sessionId, mode),
    /* `/waifu-reset global` 的唯一用途就是读到这个「现在是谁」。 */
    cachedDefault: () => cachedDefault,
    choosableRows,
    dropShadow,
    ensureShadow,
    hasPersonaRow,
    matchPersona,
    /*
     * `/waifu-mode` 的三件套。`parseModeCommand` 以函数形式穿过这道边界，
     * 而不是让 `commands.js` 反过来 `import` 本文件：那会绕成一个环，而
     * 这条边界存在的理由就是「命令侧只拿它需要的那几样」。
     */
    modeInfoOf: (sessionId) => {
      const teamState = teamRuntime?.stateOf?.(sessionId) ?? null;
      /*
       * 「这个会话在团队上」有两个来源：`mode === "team"`（agent 在场、当场
       * 解析出成员），和 `team != null`（有绑定，但这一刻没有可用的 agent
       * ——回合刚结束、会话还没重新组装，`stateOf` 会返回 `unknown`）。
       *
       * 只认前一种，`/waifu-current` 就会在一场明明由托尔和康娜回答的会话
       * 里报「聊天模式（全局）」。用户看到的正是「团队没生效」。
       */
      const teamMode =
        oneLine(teamState?.mode) === "team" || teamState?.team != null;
      const session = sessionModeOf(sessionId);
      const effective = resolveMode({ session, global: currentMode });
      return {
        global: currentMode,
        session,
        effective,
        teamMode,
        sealed:
          shouldSealTools({ teamMode, mode: effective, ours: true }) !== "",
      };
    },
    parseModeCommand,
    setGlobalMode: (mode) => run({ op: "setMode", mode }),
    overrideOf,
    refreshDefault,
    rememberSessionPreset,
    restoreSessionPreset,
    restingOf,
    safeText,
    sessionPersona,
    setOverride,
    teamNameForPreset,
    teamRuntimeOf: () => teamRuntime,
  });


  /* ------------------------------------------------------- HTTP 路由 */

  /*
   * 面板路由只需要一样东西——op 分发器——所以它的全部安装就是这一行。
   * 回环守卫、请求体上限，以及这里是 HTTP 而不是 `ctx.remote.commands` 的
   * 原因，都住在 `http-route.js`。
   */
  installHttpRoute(ctx, { run });


  /*
   * 在第一次组装来问之前把记忆快照焐热。刻意与扫描并行：两者回答不同的
   * 问题，谁也不需要谁的答案，而这里一次读失败绝不能让任何人设付出注册的
   * 代价。
   */
  void refreshMemorySnapshot().catch((error) => {
    ctx.logger?.warn?.(
      `dsh-waifu-agents: 读取长期记忆失败：${error?.message ?? error}`,
    );
  });

  void scan()
    .then((result) => {
      ctx.logger?.info?.(
        `dsh-waifu-agents: ${result.added.length} registered, ${result.skipped.length} skipped from ${dir} (${dirSource})`,
      );
      if (result.problems.length > 0)
        ctx.logger?.warn?.(`dsh-waifu-agents: ${result.problems.join(" / ")}`);
    })
    .catch((error) => {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 首次扫描失败：${error?.message ?? error}`,
      );
    })
    /*
     * 然后是默认。`scan()` 只收编文件——从不看 `selectedDefault` 指名了什么
     * ——所以应用关闭期间被从盘上删掉的人设会让注册表指着一个谁也不持有的
     * 预设，之后每个新会话都被 `agent-preset/not-found`（`registry.js:643`）
     * 拒绝，屏幕上却什么解释都没有。
     *
     * 链在扫描之后而不是与它并跑，这样花名册已经带着本插件自己的行：否则
     * 一个指名我们人设的 `selectedDefault` 会显得悬空、被白白清掉。
     */
    .then(() => reconcileDefault())
    .catch((error) => {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 默认人设自检失败：${error?.message ?? error}`,
      );
    });
}
