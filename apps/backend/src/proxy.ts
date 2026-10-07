/**
 * Emby 代理进程入口。
 *
 * 独立于 API 进程运行：管理端崩了、strm 生成任务把事件循环占满，都不该影响播放。
 *
 * 只读 DB，迁移由 API 进程负责。
 */
import Fastify from "fastify";
import { sqlite } from "./db/client.js";
import { logger } from "./lib/logger.js";
import { readAppSettings } from "./db/repositories/settings.js";
import { trustProxyOption } from "./lib/trust-proxy.js";
import proxyPlugin from "./routes/proxy/index.js";

const PROXY_PORT = Number(process.env.PROXY_PORT) || 8091;
const HOST = process.env.BACKEND_HOST || "0.0.0.0";

const app = Fastify({
  loggerInstance: logger,
  forceCloseConnections: true,
  /**
   * 和 API 进程同一个 TRUST_PROXY：放在反代后面时 request.ip 才是客户端地址——
   * 路由规则里的「来源：内网 / 外网」靠它，回源给 Emby 的 X-Real-IP 也靠它。
   */
  trustProxy: trustProxyOption(process.env.TRUST_PROXY),
  /**
   * Fastify 默认把 requestTimeout 设成 0，连 Node 自带的 300s 也一并关掉了，
   * 直接对外暴露时没有慢速请求防护。这里把 Node 的默认值补回来。
   *
   * 不设 connectionTimeout：它是 socket 空闲超时，对升级后的 websocket 同样生效，
   * Emby 的长连会被掐断。
   */
  requestTimeout: 300_000,
  /**
   * 代理上每张海报、每条字幕都是一个请求，Fastify 默认的 incoming/completed 两行
   * 几小时就把 10 MB × 3 的日志轮转塞满，真正要看的 302 诊断反而被冲掉。
   * 拦截路由自己会记 302 / 改写 / 回源的结果，这里只补记出错的。
   */
  disableRequestLogging: true,
});

app.addHook("onResponse", (request, reply, done) => {
  const status = reply.statusCode;
  if (status >= 400) {
    const detail = { method: request.method, url: request.url, status, ms: Math.round(reply.elapsedTime) };
    // 4xx 多半是 Emby 对缺图之类的正常回答，排查时开 debug 再看
    if (status >= 500) request.log.warn(detail, "代理请求失败");
    else request.log.debug(detail, "代理请求 4xx");
  }
  done();
});

/**
 * 等 API 进程把迁移跑完。
 *
 * 只有首次启动会真的等；DB 已存在时第一次读就成功。
 * 等不到也照常启动——降级成纯反代，至少 Emby 还能用。
 */
async function waitForDb(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      readAppSettings();
      return true;
    } catch {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

// 代理层任何未捕获的异常都不该带走整个进程——播放中断的代价比一次错误请求大得多
process.on("unhandledRejection", (err) => {
  app.log.error({ err }, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
  app.log.error({ err }, "uncaughtException");
});

const dbReady = await waitForDb();
if (!dbReady) {
  // 代理侧的配置读取都走 readSettingsSafe，库不可用时退化成
  // "转发到默认 Emby 地址"的纯反代，而不是每个请求 500
  app.log.warn("等待数据库超时，降级为纯反代启动");
}

await app.register(proxyPlugin);

try {
  await app.listen({ port: PROXY_PORT, host: HOST });
  app.log.info(`Emby 代理已启动 http://${HOST}:${PROXY_PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
  await Promise.race([app.close(), timeout]);

  try {
    sqlite.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export default app;
