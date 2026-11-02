/**
 * 面板的 HTTP 路由。
 *
 * 从 `index.js` 拆出；代码未改。这条路由只有一个依赖 —— op 分发器 `run` ——
 * 这正是它能干净拆开的原因：回环检查、读请求体、JSON 进、JSON 出，其余都由
 * 分发器自己的错误形态带过去。
 *
 * ## 为什么非要一条 HTTP 路由
 *
 * 设置面板用不了命令通道。`settings.plugins.tab` 声明的
 * `SettingsPluginsTabOwnerProps` 拿到的是空的 owner props，所以组件永远收不到
 * 会话 id —— 而 `ctx.remote.commands.execute` 必须要一个。HTTP 路由既不需要
 * agent 也不需要会话，所以面板把同一份 JSON 投给同一个 `run` 入口。
 *
 * ## 为什么用 `ctx.inject` 而不是 `ctx.get`
 *
 * `ctx.get('webServer')` 在这里会静默失败：`get` 默认 `strict = true`，所以
 * 只有提供方 fiber 处于 ACTIVE 时它才应答 —— 而 webserver fiber 要等异步的
 * `listen` 落定后才到 ACTIVE。一次过早的 `get` 会看到 `undefined`，没有任何
 * 重试，路由也就永远进不了表。`ctx.inject` 会在 `webServer` 真正存在后才
 * 启动这个独立 fiber。它有意待在预设注册之外：万一 webserver 缺席，丢的是
 * 面板，而不是人设。
 */
/**
 * 面板路由。是 `prefix`，所以子路径也能匹配。
 *
 * 提到模块级是为了让重试的告警文案和错误识别都能引用同一个字符串 —— 用户
 * 在日志里看到的路径，必须和代码里查找的那条一字不差。
 */
const ROUTE_PATH = "/waifu-agents/api";

/**
 * 注册被占用时的重试间隔（毫秒）。
 *
 * ## 为什么要重试
 *
 * `webServer.register` 对重复 path **直接抛错**，从不 upsert。热重载时新实例
 * 的 `apply` 常常早于旧实例的 `dispose`，于是新实例第一次注册必然撞上旧的那
 * 条路由；而 cordis 不会重试一个抛过错的 fiber —— 结果就是新实例**一直没有**
 * 面板路由，直到下一次重载。用户看到的是「面板整个消失，以为插件坏了」。
 *
 * 旧实例真正让出路由通常在几十毫秒内（同一次重载的收尾），所以短间隔的三次
 * 试探足以覆盖正常重载；试探失败不重试到底，是因为「旧实例什么时候死」不是
 * 我们能观测的事 —— 无限重试只会把一个已知失败变成后台噪声。
 *
 * 间隔总长 **600 ms**，和告警文案是一对：用户从「面板空白」到「看见一句人话」
 * 最多等这么久，所以文案里不能写「立刻恢复」——那句话说的是恢复怎么最快，但
 * 读的人会拿它比对刚才那一段空白。宁可把预算压短、把话写实。
 */
const RETRY_DELAYS_MS = [120, 200, 280];

/**
 * 这条错误是不是「path 已经被占了」。
 *
 * 只在文案上认，因为宿主没有给出错误码。宽松到 `duplicate` / `already` 两个
 * 词：认错（把别的错误当占用）的代价是多试三次仍然失败、最后仍会告警；认漏
 * 的代价是**当场放弃**，那正是这次要修的那个观感问题。所以宁可认宽。
 */
function looksOccupied(error) {
  const text = String(error?.message ?? error ?? "");
  return /duplicate|already|exists/i.test(text);
}

/**
 * 一次注册尝试的结果，只分三态：拿到 disposer、注册了但没有 disposer、
 * 或者抛了。
 *
 * 「注册了但没有 disposer」不能当失败：路由已经进表、面板已经能用，缺的只是
 * 我们没法主动注销它 —— 当失败去重试反而会撞上自己刚注册的那条。
 */
function adoptRegistration(outcome, onDisposer, onFailure) {
  if (typeof outcome === "function") {
    onDisposer(outcome);
    return;
  }
  if (outcome !== null && typeof outcome === "object" && typeof outcome.then === "function") {
    /* 万一宿主将来改成异步注册：接住 reject，别让它变成未处理的 Promise。 */
    outcome.then(
      (fn) => onDisposer(typeof fn === "function" ? fn : null),
      (error) => onFailure(error),
    );
    return;
  }
  onDisposer(null);
}

/**
 * @param {object} ctx 插件自己的上下文
 * @param {{ run: (request: object) => Promise<object> }} deps op 分发器
 * @returns void
 */
export function installHttpRoute(ctx, deps) {
  const { run } = deps;

  /** 只有回环（loopback）对端可以驱动这条路由。 */
  function isLoopbackPeer(req) {
    const address = req.socket?.remoteAddress ?? "";
    return (
      address === "127.0.0.1" ||
      address === "::1" ||
      address === "::ffff:127.0.0.1"
    );
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
  }

  async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        throw new Error(
          "请求体过大（超过 16MB）：这一侧限制的是「面板 → 插件」的请求体，单个人设不该走到这里。",
        );
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    return JSON.parse(text === "" ? "{}" : text);
  }

  async function handleHttp(req, res) {
    try {
      if (!isLoopbackPeer(req)) {
        sendJson(res, 403, {
          ok: false,
          error: "这个路由只接受本机（loopback）请求。",
        });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "请用 POST 提交 JSON。" });
        return;
      }
      let request;
      try {
        request = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: `参数不是合法 JSON：${error?.message ?? error}`,
        });
        return;
      }
      sendJson(res, 200, await run(request));
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }

  /*
   * 设置面板用不了命令通道。`settings.plugins.tab` 声明的
   * `SettingsPluginsTabOwnerProps` 拿到的是空的 owner props，所以组件永远
   * 收不到会话 id —— 而 `ctx.remote.commands.execute` 必须要一个。HTTP 路由
   * 既不需要 agent 也不需要会话，所以面板把同一份 JSON 投给同一个 `run`
   * 入口。
   */
  /*
   * `ctx.get('webServer')` 在这里不够，而且会静默失败：`get` 默认
   * `strict = true`，所以只有提供方 fiber 处于 ACTIVE 时它才返回服务 —— 而
   * webserver fiber 要等异步的 `listen` 落定后才到 ACTIVE。一次过早的 `get`
   * 因此会看到 `undefined`，且永远没有重试，路由也就永远进不了表。
   * `ctx.inject` 只在 `webServer` 真正存在后才启动这个独立 fiber。它有意待
   * 在上面的预设注册之外：万一 webserver 缺席，丢的是面板，而不是人设。
   */
  ctx.inject(["webServer"], (ctx) => {
    /*
     * 一次注册的完整生命周期都在这个闭包里：重试计时器、拿到的 disposer、
     * 以及「已经注销了」这个事实。三者必须一起管，否则会留下「注销之后又把
     * 路由注册回来」的悬空计时器。
     */
    ctx.effect(
      () => {
        let disposed = false;
        /** 当前这次成功注册拿到的注销函数；没有就是 `null`。 */
        let release = null;
        /** 尚未触发的重试；`null` 表示没有在等。 */
        let timer = null;

        const warn = (message) => {
          try {
            ctx.logger?.warn?.(message);
          } catch {
            /* 日志服务缺席不该让面板路由这条线再抛一次 */
          }
        };

        const detach = () => {
          const fn = release;
          release = null;
          if (typeof fn !== "function") return;
          try {
            fn();
          } catch {
            /* 旧实例可能已经自行注销；重复注销不是本函数要处理的失败 */
          }
        };

        /** 放弃注册时的唯一出口：说人话，且只说一次。 */
        const giveUp = (error, permanent) => {
          if (permanent) {
            warn(
              `面板路由没注册上：另一个 waifu-agents 实例还占着 ${ROUTE_PATH}（热重载时常见）。` +
                "设置面板可能到下次重载前都打不开——完全退出 DSH 再启动就能恢复；人设、记忆、团队不受影响。",
            );
            return;
          }
          warn(
            `面板路由没注册上（${ROUTE_PATH}）：${String(error?.message ?? error)}。` +
              "设置面板可能打不开；人设、记忆、团队不受影响。",
          );
        };

        const attempt = (index) => {
          timer = null;
          if (disposed) return;
          let outcome;
          try {
            outcome = ctx.webServer.register({
              kind: "prefix",
              path: ROUTE_PATH,
              handler: (req, res) => handleHttp(req, res),
            });
          } catch (error) {
            const occupied = looksOccupied(error);
            if (occupied && index < RETRY_DELAYS_MS.length) {
              timer = setTimeout(() => attempt(index + 1), RETRY_DELAYS_MS[index]);
              /* 计时器不该把进程留着不退出：重试是背景行为，不是待办工作。 */
              timer?.unref?.();
              return;
            }
            giveUp(error, occupied);
            return;
          }
          adoptRegistration(
            outcome,
            (fn) => {
              /*
               * 先把 disposer 交给 `release`，再决定要不要立刻用掉：
               * `detach()` 自己会把它置空，所以「这里调一次、之后注销又调一次」
               * 也只会真正归还一次 —— 幂等性由 `detach` 的 `release = null`
               * 保证，而不是靠这个分支记得提前 return。
               *
               * 这条路径只在注册是异步的（`register` 返回 Promise）时才会走到：
               * resolve 与 dispose 撞在一起，`disposed` 已经是 true。
               */
              release = fn;
              if (disposed) {
                detach();
                return;
              }
              if (index > 0) {
                try {
                  ctx.logger?.debug?.(`waifu-agents: 面板路由在重试 ${index} 次后注册上了`);
                } catch {
                  /* 日志服务缺席不影响已经注册上的路由 */
                }
              }
            },
            (error) => {
              const occupied = looksOccupied(error);
              if (occupied && index < RETRY_DELAYS_MS.length) {
                timer = setTimeout(() => attempt(index + 1), RETRY_DELAYS_MS[index]);
                timer?.unref?.();
                return;
              }
              giveUp(error, occupied);
            },
          );
        };

        attempt(0);

        return () => {
          disposed = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          detach();
        };
      },
      "waifu-agents: http route",
    );
  });
}
