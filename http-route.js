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
 * @param {object} ctx 插件自己的上下文
 * @param {{ run: (request: object) => Promise<object> }} deps op 分发器
 * @returns void
 */
export function installHttpRoute(ctx, deps) {
  const { run } = deps;

  /** 面板路由。是 `prefix`，所以子路径也能匹配。 */
  const ROUTE_PATH = "/waifu-agents/api";

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
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: "prefix",
          path: ROUTE_PATH,
          handler: (req, res) => handleHttp(req, res),
        }),
      "waifu-agents: http route",
    );
  });
}
