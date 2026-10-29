/**
 * 自更新：检查注册表、安装最新的 tarball、跟进平台的进度 feed。
 *
 * 从 `index.js` 搬出；代码原样未动。它需要宿主给的恰好是两样东西——
 * cordis 上下文（用于 `pluginManager`、两个安装事件与 logger）和这一行
 * 配置的注册表 URL——所以边界是一个构造参数，而不是闭包捕获。
 *
 * 注册表以 THUNK 形式传入，而非值：`config` 是该行自己的 schema 对象，
 * 且面板可以在本插件运行期间把这行指到另一个注册表，所以调用时才读取，
 * 下一次 `updateCheck` 才不会说谎。
 *
 * ## 为什么安装是「启动」而非「等待」
 *
 * pnpm 一被拉起 `updateApply` 就返回，其余交给面板轮询
 * `updateProgress`。把 HTTP 响应挂住整个安装过程，正是让「到底装完了
 * 没有」无法回答的原因——下面启动处的那段长注释随代码一起搬到了
 * 这里。
 *
 * ## 为什么 feed 需要 request id
 *
 * 平台从 manager 自己的上下文发布 `plugin-manager/install-state` 与
 * `plugin-manager/install-log`，且只针对携带 `requestId` 的任务。没有它，
 * 一次安装会在完全的沉默中跑完。调用方没给时 `updateApply` 会生成一个。
 */
import { randomUUID } from "node:crypto";

import { PACKAGE_NAME, RUNNING_VERSION, readOwnVersion } from "./package-meta.js";
import { oneLine } from "./text.js";

/** 自更新查询最新版本的默认去处，除非该行配置另有指定。 */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/** 有上限，卡死的注册表不能把一个面板请求永远挂住。 */
export const LOOKUP_TIMEOUT_MS = 8000;

/**
 * `candidate` 是否比 `current` 更新的一个发布版本？
 *
 * 三个数字段，预发布排在它自己的正式版之前（`1.0.0-rc.1` < `1.0.0`）。
 * 任何解析不了的一律答 `false`：一个怪异的版本号字符串绝不能变成
 * 一次更新提示。
 * @param {unknown} candidate
 * @param {unknown} current
 * @returns {boolean}
 */
export function isNewer(candidate, current) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(
      String(value ?? "").trim(),
    );
    if (match === null) return null;
    return {
      nums: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] ?? "",
    };
  };
  const a = parse(candidate);
  const b = parse(current);
  if (a === null || b === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a.nums[index] !== b.nums[index]) return a.nums[index] > b.nums[index];
  }
  if (a.pre === b.pre) return false;
  if (a.pre === "") return true;
  if (b.pre === "") return false;
  return a.pre > b.pre;
}

/**
 * 注册表为本包发布的最新版本。
 *
 * 只读 `dist-tags.latest`，且走精简元数据文档，一个小 GET 就能答上。
 * `AbortSignal.timeout` 防止黑洞连接把面板挂住：这里是点击处理器调用
 * 路径。
 * @param {string} [registry] 注册表基 URL；行配置可以覆盖它
 * @returns {Promise<{ version: string, registry: string }>}
 */
async function latestVersion(registry) {
  const base = String(registry ?? "").trim() || DEFAULT_REGISTRY;
  if (typeof fetch !== "function")
    throw new Error(`这个 Node 没有 fetch，只能手动装：${PACKAGE_NAME}@latest`);
  const url = new URL(PACKAGE_NAME, base.endsWith("/") ? base : `${base}/`)
    .href;
  const response = await fetch(url, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`${base} 对 ${PACKAGE_NAME} 返回 HTTP ${response.status}`);
  const meta = await response.json();
  const latest = meta?.["dist-tags"]?.latest;
  if (typeof latest !== "string" || latest === "")
    throw new Error(`${base} 没有给出 dist-tags.latest`);
  return { version: latest, registry: base };
}

/**
 * 某个已发布版本的 tarball URL。
 *
 * 这是 manager 的 HMR 预检唯一无法用 `already-installed` 拒绝的 spec
 * 形状：预检会在 pnpm 运行前匹配它叫得出名字的 spec——注册表名、
 * 本地目录，或依赖当初保存时的确切 git/tarball spec——而一个新鲜的
 * tarball URL 要等 pnpm 抓取过之后才知道指向哪个包。因此用 N+1 版本
 * 自己的 tarball 安装，可以在已安装的 N 版本之上到达 pnpm，HMR 的
 * 重新组合就地替换运行中的插件（有文档记载的行为）。精简 packument
 * 权威地给出这个 URL（`dist.tarball`），所以先发一个小 GET 问注册表；
 * 不肯应答的注册表回落到 npm 的 tarball 路径约定，本插件能被指到的
 * 每个注册表都遵循它
 * （`<base>/<name>/-/<name>-<version>.tgz`）。构造从不抛出，所以这个
 * 辅助函数总是返回一个可用的 URL。
 * @param {string} [registry] 注册表基 URL；行配置可以覆盖它
 * @param {string} version 精确的已发布版本
 * @returns {Promise<string>}
 */
async function tarballUrlOf(registry, version) {
  const base = String(registry ?? "").trim() || DEFAULT_REGISTRY;
  const construct = () =>
    new URL(
      `${PACKAGE_NAME}/-/${PACKAGE_NAME}-${version}.tgz`,
      base.endsWith("/") ? base : `${base}/`,
    ).href;
  if (typeof fetch !== "function") return construct();
  try {
    const url = new URL(PACKAGE_NAME, base.endsWith("/") ? base : `${base}/`)
      .href;
    const response = await fetch(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return construct();
    const meta = await response.json();
    const tarball = meta?.versions?.[version]?.dist?.tarball;
    return typeof tarball === "string" && tarball !== "" ? tarball : construct();
  } catch {
    return construct();
  }
}

/**
 * 绑定到一个插件实例上的更新机构。
 * @param {object} ctx 插件自己的上下文
 * @param {{ registryOf?: () => (string | null | undefined) }} [options]
 *   `registryOf` 在调用时读取，因此改配置无需重新 apply 即可生效
 * @returns {{ updateCheck: () => Promise<object>,
 *   updateApply: (request: object) => Promise<object>,
 *   updateProgress: (request: object) => object }}
 */
export function installSelfUpdate(ctx, options = {}) {
  const registryOf = options.registryOf ?? (() => undefined);

  /**
   * plugin-manager 服务，如果这个 profile 有一个。
   *
   * 只用 `ctx.get` 是不够的，理由与 HTTP 路由需要 `ctx.inject` 相同：
   * 严格的 `get` 只在提供方 fiber 处于 ACTIVE 时应答，而本插件激活时
   * manager 可能还在启动。`ctx.inject` 会在服务真正存在的那一刻起一个
   * 独立 fiber。直接查询是根本没有 manager 的 profile 的退路——那种
   * 情况下 op 必须明说，而不是无声地什么都不做。
   * @returns {object | null}
   */
  let pluginManager = null;
  ctx.inject(["pluginManager"], (scoped) => {
    pluginManager = scoped.pluginManager ?? null;
    scoped.effect(
      () => () => {
        pluginManager = null;
      },
      "waifu-agents: pluginManager handle",
    );
  });

  function managerOf() {
    if (pluginManager !== null) return pluginManager;
    try {
      return ctx.get("pluginManager", false) ?? null;
    } catch {
      return null;
    }
  }

  /** 包管理器日志的末尾一段，有上限，供面板一行展示。 */
  function tail(value, limit = 2000) {
    const text = String(value ?? "").trim();
    return text.length <= limit ? text : `…${text.slice(-limit)}`;
  }

  /**
   * 本插件启动的那次安装，以及平台此后对它说过的话。刻意一次只允许
   * 一个：`installBundle` 拿的是 profile 级的锁，再启动一次只会在第一
   * 次后面排队，而面板却画着两条都不动的进度条。
   *
   * @type {{ requestId: string, version: string, previous: string | null,
   *   startedAt: number, phase: string, attempt: object | null, log: string,
   *   logTruncated: boolean, pnpmExit: number | null, seenFeed: boolean,
   *   warnedNoFeed: boolean, done: boolean, result: object | null,
   *   error: string | null } | null}
   */
  let activeInstall = null;

  /** 保留多少 pnpm 输出。面板画的是尾部，不是全记录。 */
  const INSTALL_LOG_LIMIT = 4000;

  /**
   * 把一次播报的阶段并入正在进行的安装。
   *
   * 平台从 manager 自己的上下文发出 `plugin-manager/install-state`，且
   * 仅当调用方传了 `requestId`：
   *
   *     const announce = (phase, attempt) => {
   *       if (requestId !== void 0) this.ownerContext.emit(...)
   *     }
   *
   * 这正是 `updateApply` 生成一个 id 的全部理由。没有它，安装会在完全
   * 的沉默中跑完，而这份沉默正是「装完了也不知道装完没有」，feed 就是
   * 为回答它而存在。
   *
   * 在 manager 源码里见过的阶段：`installing`（每问一个注册表一次，
   * 携带 `{registry, index, total}`）、`applying`（写配置与重载，播报
   * 一次）、`cancelling`（只有别人要求中止时——本插件从不这么做）。
   */
  function noteInstallState(progress) {
    const job = activeInstall;
    if (job === null || oneLine(progress?.requestId) !== job.requestId) return;
    const phase = oneLine(progress?.phase);
    if (phase !== "") job.phase = phase;
    const attempt = progress?.attempt;
    if (attempt !== undefined && attempt !== null) {
      job.attempt = {
        registry: oneLine(attempt.registry),
        index: Number(attempt.index ?? 0),
        total: Number(attempt.total ?? 0),
      };
    }
    job.seenFeed = true;
  }

  /**
   * 追加一段 pnpm 输出，只保留面板会画的尾部。
   *
   * 一个 chunk 携带 `{requestId, jobId, argv, cwd, stream, text, exitCode}`；
   * 命令的最后一段到达时 `text` 为空并带来退出码。累积绝不走
   * `tail(log + text)`——那个辅助函数会裁剪，而裁剪一份还在增长的日志
   * 会吃掉换行边界，把两行不相干的句子粘在一起。
   */
  function noteInstallLog(chunk) {
    const job = activeInstall;
    if (job === null || oneLine(chunk?.requestId) !== job.requestId) return;
    const text = String(chunk?.text ?? "");
    if (text !== "") {
      const joined = job.log + text;
      if (joined.length > INSTALL_LOG_LIMIT) {
        job.logTruncated = true;
        job.log = joined.slice(-INSTALL_LOG_LIMIT);
      } else {
        job.log = joined;
      }
    }
    if (chunk?.exitCode !== undefined && chunk?.exitCode !== null) {
      job.pnpmExit = Number(chunk.exitCode);
    }
    job.seenFeed = true;
  }

  /*
   * 平台自己的安装遥测，谁问就发布给谁——它自己的插件页通过
   * `ctx.remote.$on` 监听的正是同一对事件（`ui-plugin-manager`）。没有
   * 安装在跑时订阅毫无代价：除非 id 匹配本插件启动的那个任务，两个
   * 处理器都在第一行就返回，而本插件一次最多启动一个。
   */
  ctx.on("plugin-manager/install-state", noteInstallState);
  ctx.on("plugin-manager/install-log", noteInstallLog);

  /**
   * 运行中的版本、已安装的版本、已发布的版本。
   *
   * 三个都要，因为它们可以各不相同：`pnpm add` 换掉磁盘上的文件，而旧
   * 模块还在运行，「已安装」与「运行中」恰好从一次更新到落实它的重启
   * 之间互相说不拢。
   */
  async function updateCheck() {
    // 磁盘只读一次：读两次可能横跨一次进行中的安装，报出一个从未
    // 存在过的版本。
    const installed = readOwnVersion();
    let latest = null;
    let registry = null;
    let error = null;
    try {
      const found = await latestVersion(registryOf());
      latest = found.version;
      registry = found.registry;
    } catch (failure) {
      // 连不上的注册表不算 op 失败：面板仍要展示装的是哪个版本，
      // 而且离线是常态。
      error = String(failure?.message ?? failure);
    }
    return {
      ok: true,
      name: PACKAGE_NAME,
      running: RUNNING_VERSION,
      installed,
      latest,
      registry,
      // 以磁盘上的为准判断：新版本一装上，横幅就必须消失，哪怕旧的
      // 还在运行。
      updateAvailable:
        latest !== null && isNewer(latest, installed ?? RUNNING_VERSION),
      // 以运行中的为准判断：重启能改变的只有它。
      restartPending:
        installed !== null &&
        RUNNING_VERSION !== null &&
        installed !== RUNNING_VERSION,
      canInstall: managerOf() !== null,
      error,
    };
  }

  /**
   * 安装已发布的最新版本，走插件页用的同一个服务。
   *
   * 传入的是精确版本，绝不是范围。从哪个 spec 安装取决于磁盘上已有的
   * 东西（见下面选择处的注释）：更新走新版本的 tarball URL——HMR 预检
   * 无法拒绝的 spec 形状——全新安装则保留朴素的 `name@version`，它的
   * 安装会把 profile 声明的范围改写掉。
   *
   * `minimumReleaseAge`：按注册表名安装受 24h 新鲜度策略约束，必须先
   * 记入 workspace 的 `minimumReleaseAgeExclude`，否则 lockfile 检查会
   * 直接以 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 拒绝。tarball URL
   * 安装直接抓包文件，按理不会查发布时间——这是预期，但并未对照
   * manager 的 pnpm 调用验证过，所以失败若真来了，原样上报而不是
   * 预先打包票。
   *
   * 安装一 STARTED 就返回，不等它结束，并交回让平台为它发布进度的
   * `requestId`。面板随后轮询 `updateProgress`——为什么挂住这个响应是
   * 错误的形状，见下面启动处的注释。
   */
  async function updateApply(request) {
    const manager = managerOf();
    if (manager === null) {
      return {
        ok: false,
        error: `这个环境没有 pluginManager 服务，装不了；请在插件页手动安装 ${PACKAGE_NAME}@latest。`,
      };
    }
    /*
     * 一次一个。`installBundle` 反正会按 profile 级的锁串行，再调一次
     * 只是在队列里等——而面板已经被告知「started」，画出的却是一条永远
     * 不动的进度条。报出正在跑的那一个，比假装又启动一个有用得多。
     */
    if (activeInstall !== null && activeInstall.done !== true) {
      return {
        ok: false,
        error: "上一次更新还在进行，等它结束再试。",
        requestId: activeInstall.requestId,
        running: true,
      };
    }
    let version = String(request.version ?? "").trim();
    try {
      if (version === "")
        version = (await latestVersion(registryOf())).version;
    } catch (failure) {
      return {
        ok: false,
        error: `查不到最新版本：${failure?.message ?? failure}`,
      };
    }
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      return { ok: false, error: `版本号不合法：${version}` };
    }
    const before = readOwnVersion();
    if (before === version) {
      /*
       * 没有可装的，且以面板绘制已完成任务的同一形状回话——于是
       * 「已经是最新的」落进与真实安装相同的进度窗口，客户端不必再开
       * 第二条代码路径。
       */
      return {
        ok: true,
        started: false,
        requestId: "",
        version,
        previous: before,
        done: true,
        result: {
          ok: true,
          version,
          previous: before,
          application: "current",
          changed: false,
          installed: before,
          log: "",
        },
      };
    }
    /*
     * 从哪个 spec 安装，由磁盘上已有的东西决定。
     *
     * 对已安装包的更新走新版本的 tarball URL 安装：那是 HMR 预检唯一
     * 无法按名字匹配到的 spec 形状，于是它能越过已装的那份到达 pnpm，
     * 重新组合就地替换运行中的插件——无需卸载，不赌 fiber。它还会把
     * profile 保存的依赖从版本范围改写成精确 URL，这是刻意的：下一次
     * 更新的 URL 又不一样，任何未来的安装都不会再被当作已安装而拒绝。
     *
     * 全新安装（磁盘上没有可读的东西）保留注册表名：没有已安装的东西
     * 可供预检拒绝，保存下来的 spec 仍是一个普通依赖。若这个判断错了
     * ——磁盘上那份是读不出来，而不是不存在——名字 spec 会被以
     * `already-installed` 拒绝，然后由下面的两步接管。
     */
    let spec = `${PACKAGE_NAME}@${version}`;
    if (before !== null) spec = await tarballUrlOf(registryOf(), version);
    /*
     * id 在这里生成，或面板送来一个就收下。它存在的理由是平台只为
     * 携带 id 的安装发布进度（`noteInstallState`）。面板更愿意自己生成：
     * 在这个响应返回之前到达的 chunk 也能找到它所属的任务。退路则让
     * 直接调用方（脚本，或对这个路由 `curl`）一样好用。
     */
    const requestId = String(request.requestId ?? "").trim() || randomUUID();
    const job = {
      requestId,
      version,
      previous: before,
      startedAt: Date.now(),
      phase: "starting",
      attempt: null,
      log: "",
      logTruncated: false,
      pnpmExit: null,
      seenFeed: false,
      warnedNoFeed: false,
      done: false,
      result: null,
      error: null,
    };
    activeInstall = job;
    /*
     * 刻意不 await：pnpm 可能要跑一分钟，把这条 HTTP 响应挂住整个
     * 过程，正是让「到底装完了没有」无法回答的原因——面板只有一次
     * 阻塞调用，它返回之前无事可画。安装在原地继续跑，面板轮询
     * `updateProgress`，任务落定之后它仍会用最终结果应答。
     */
    void (async () => {
      try {
        const outcome = await manager.installBundle(spec, {
          enabled: true,
          requestId,
        });
        if (outcome?.application === "failed") {
          /*
           * tarball spec 本不该被以 `already-installed` 拒绝（它的包名要到
           * pnpm 跑过之后才可知），全新安装也没有已安装的东西可供拒绝。
           * 若还是落到这里，说明 manager 终究从 spec 里叫出了已安装包的
           * 名字，或者上面的磁盘判断错了——无论哪种，有文档记载的跨
           * 版本路径就是先卸载再安装，而等待卸载的那个 fiber 不会被决议
           * 本身打断，所以这条退路就在原地执行两步：先卸载，再从同一个
           * fiber 以朴素的注册表名安装新版本。宿主是否让 fiber 活过对
           * 自己的卸载，要靠真机使用去发现；它可能死掉的每种方式都在
           * 下面被捕获，并以手动路径作为最后手段上报。这里碰不到任何
           * 用户数据——人设与 teams.json 都在包外。
           */
          const code = String(outcome.error?.code ?? outcome.error?.message ?? "");
          if (code.includes("already-installed")) {
            ctx.logger?.warn?.(
              `dsh-waifu-agents: installBundle refused ${version} (already-installed); performing remove-then-install.`,
            );
            job.phase = "removing";
            try {
              await manager.removeBundle(PACKAGE_NAME);
            } catch (removeFailure) {
              job.done = true;
              job.error = `卸载旧版本失败（${removeFailure?.message ?? removeFailure}），已安装的版本没有变动。请到「插件」页手动卸载后重新安装 ${version}。`;
              return;
            }
            /*
             * 还在运行——fiber 活过了对自己的卸载。spec 不再指向已安装
             * 的包，预检会让新版本通过到 pnpm。
             */
            job.phase = "reinstalling";
            let retry = null;
            try {
              retry = await manager.installBundle(`${PACKAGE_NAME}@${version}`, {
                enabled: true,
                requestId,
              });
            } catch (installFailure) {
              job.done = true;
              job.error = `旧版本已卸载，但安装 ${version} 失败：${installFailure?.message ?? installFailure}。请到「插件」页重新安装——人设目录（personas）和团队配置（teams.json）不在包里，不受影响。`;
              return;
            }
            if (retry?.application === "failed") {
              job.done = true;
              job.error = `旧版本已卸载，但安装 ${version} 失败：${retry.error?.message ?? retry.error?.code ?? JSON.stringify(retry.error)}。请到「插件」页重新安装——人设目录（personas）和团队配置（teams.json）不在包里，不受影响。`;
              if (job.log === "") job.log = String(retry?.packageResult?.output ?? "");
              return;
            }
            job.done = true;
            job.result = {
              ok: true,
              version,
              previous: before,
              application: retry?.application ?? null,
              changed: retry?.changed === true,
              installed: readOwnVersion(),
              log: String(retry?.packageResult?.output ?? ""),
              twoStep: true,
            };
            return;
          }
          job.done = true;
          job.error = `安装失败：${outcome.error?.message ?? outcome.error?.code ?? JSON.stringify(outcome.error)}`;
          // manager 自己的记录才是这次失败里有用的那一半，而且只有流式
          // feed 从未出声时它才在这里。
          if (job.log === "") job.log = String(outcome?.packageResult?.output ?? "");
          return;
        }
        job.done = true;
        job.result = {
          ok: true,
          version,
          previous: before,
          // 没有 HMR 时这是 `restart-required`；有 HMR 时全新安装（包括
          // 上面的两步）可能真的当场生效。这里透传 manager 自己的说法，
          // 而不是这段代码兑现不了的承诺。
          application: outcome?.application ?? null,
          changed: outcome?.changed === true,
          installed: readOwnVersion(),
          log: String(outcome?.packageResult?.output ?? ""),
        };
      } catch (failure) {
        job.done = true;
        job.error = `调用 pluginManager 失败：${failure?.message ?? failure}`;
      }
    })();
    return { ok: true, started: true, requestId, version, previous: before };
  }

  /**
   * 面板等待期间画的东西。
   *
   * 刻意返回朴素数据：面板通过 HTTP 轮询它，而已结束的任务会一直用
   * 它的结果应答，直到下一次安装把它顶掉——于是落在最后一段输出之后
   * 的轮询看到的也是结果，而不是与结果赛跑后掉进「idle」。
   */
  function updateProgress(request) {
    const job = activeInstall;
    const wanted = String(request?.requestId ?? "").trim();
    if (job === null || (wanted !== "" && wanted !== job.requestId)) {
      return { ok: true, idle: true, requestId: wanted === "" ? null : wanted };
    }
    const elapsed = Date.now() - job.startedAt;
    /*
     * 若安装明显在跑而平台的 feed 一直不应答，警告一次。这是本插件
     * 唯一可能看不见进度的方式——事件在 manager 自己的上下文上发出，
     * 某个把它们作用到别处的构建会让进度条停在「准备中」，而 pnpm
     * 其实一直在干活。面板用文字说了同样的话；这一行是给看日志的人的。
     */
    if (
      job.done !== true &&
      job.seenFeed !== true &&
      job.warnedNoFeed !== true &&
      elapsed > 8000
    ) {
      job.warnedNoFeed = true;
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 更新已经跑了 ${Math.round(elapsed / 1000)} 秒，但一直没收到 plugin-manager 的进度事件；进度条只能显示「进行中」。`,
      );
    }
    return {
      ok: true,
      idle: false,
      requestId: job.requestId,
      version: job.version,
      previous: job.previous,
      phase: job.phase,
      attempt: job.attempt,
      elapsedMs: elapsed,
      // 流式记录优先；manager 返回的输出是给从未流式的一次运行（更旧
      // 的 manager，或这个构建不发布的 feed）准备的退路。
      log: job.log !== "" ? job.log : String(job.result?.log ?? ""),
      logTruncated: job.logTruncated,
      pnpmExit: job.pnpmExit,
      seenFeed: job.seenFeed,
      done: job.done,
      result: job.result,
      error: job.error,
    };
  }

  return { updateCheck, updateApply, updateProgress };
}
