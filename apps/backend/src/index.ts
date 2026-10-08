
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import { initDb } from "./db/migrate.js";
import { sqlite } from "./db/client.js";
import { readAppSettings } from "./db/repositories/settings.js";
import { logger } from "./lib/logger.js";
import { registerErrorHandling } from "./plugins/error-handler.js";
import staticSitePlugin from "./plugins/static-site.js";

// Prevent unhandled rejections from crashing the process
process.on("unhandledRejection", (err) => {
  logger.error({ err }, "unhandledRejection");
});

// Apply DB migrations and seed from JSON on first run (before any plugin reads config)
await initDb();

// Core plugins
import { authPlugin } from "./plugins/auth.js";
import { cronPlugin } from "./plugins/cron.js";
import { registerNotifySink } from "./services/notify.js";
import { startAutoOrganize } from "./services/organize/auto.js";
import { telegramNotify } from "./services/telegram/notify.js";
import { startPolling, stopPolling } from "./services/telegram/polling.js";
import { cancelAllRunningTasks } from "./services/task/registry.js";
import { reconcileInterruptedExecutions } from "./services/task-history.js";
import { startHousekeeping } from "./services/housekeeping.js";
import { startUpdateChecks } from "./services/update/service.js";

// Auth routes
import authLoginRoute from "./routes/auth/login.js";
import authLogoutRoute from "./routes/auth/logout.js";
import authPasswordRoute from "./routes/auth/password.js";

// CRUD routes
import accountRoute from "./routes/account/index.js";
import settingsRoute from "./routes/settings/index.js";
import taskRoute from "./routes/task/index.js";
import taskHistoryRoute from "./routes/task-history/index.js";

// Task execution routes
import taskStartRoute from "./routes/task/start.js";
import taskCancelRoute from "./routes/task/cancel.js";
import taskLogRoute from "./routes/task/log.js";
import taskCronRoute from "./routes/task/cron.js";

// Cloud storage routes
import cloudFilesRoute from "./routes/cloud/files.js";
import shareRoute from "./routes/share/index.js";
import cloudOfflineRoute from "./routes/cloud/offline.js";
import { migrateLegacyCopyMount, startOfflineWatcher, stopOfflineWatcher } from "./services/offline/service.js";

// 复制到 OpenList
import copyRoute from "./routes/copy/index.js";
import { adoptLegacyCopyFollowups, startCopyWatcher, stopCopyWatcher } from "./services/copy/service.js";

// 资源搜索（PanSou）
import resourceRoute from "./routes/resource/index.js";

// 分享追更
import followRoute from "./routes/follow/index.js";
import { startFollowWatcher, stopFollowWatcher } from "./services/follow/service.js";

// Emby 入库通知
import { startEmbyNewWatcher, stopEmbyNewWatcher } from "./services/emby/library-new.js";

// Library routes
import libraryRoute from "./routes/library/index.js";
import libraryTmdbRoute from "./routes/library/tmdb.js";
import libraryHdhiveRoute from "./routes/library/hdhive.js";
import librarySaveToTaskRoute from "./routes/library/save-to-task.js";
import { startLibraryHealth, stopLibraryHealth } from "./services/library/health.js";
import { startIndexer, stopIndexer } from "./services/library/indexer.js";
import { startLibraryIdentify, stopLibraryIdentify } from "./services/library/identify.js";

// Directory routes
import directoryLocalRoute from "./routes/directory/local.js";
import directoryRemoteRoute from "./routes/directory/remote.js";
import driveArchiveRoute from "./routes/drive/archive.js";
import strmRoute from "./routes/strm/index.js";


// 115 life-event monitor (incremental cloud-drive change detection)
import lifeMonitorRoute from "./routes/life/index.js";
import organizeRoute from "./routes/organize/index.js";
import { cancelAllRuns, collapseStaleReadyRuns, reconcileInterruptedRuns } from "./services/organize/run.js";
import { startLifeMonitor, stopLifeMonitor } from "./services/life/monitor.js";
import { flushEmbyRefresh } from "./services/media-server.js";

// 智能体接入：令牌管理 + MCP 端点
import agentRoute from "./routes/agent/index.js";
import mcpRoute from "./routes/mcp/index.js";
import { trustProxyOption } from "./lib/trust-proxy.js";
import { corsDelegator } from "./plugins/cors.js";
import { publicHostPlugin } from "./plugins/public-host.js";
import { securityHeadersPlugin } from "./plugins/security-headers.js";
import oauthMetadataRoute from "./routes/oauth/metadata.js";
import oauthRegisterRoute from "./routes/oauth/register.js";
import oauthAuthorizeRoute from "./routes/oauth/authorize.js";
import oauthTokenRoute from "./routes/oauth/token.js";

// System routes
import clearDirectoryRoute from "./routes/system/clear-directory.js";
import healthRoute from "./routes/system/health.js";
import updateRoute from "./routes/update/index.js";
import backupRoute from "./routes/system/backup.js";

const app = Fastify({
  loggerInstance: logger,
  forceCloseConnections: true,
  trustProxy: trustProxyOption(process.env.TRUST_PROXY),
});
registerErrorHandling(app);
// 通知渠道：领域模块只往 services/notify.ts 的端口发事件，Telegram 是登记在端口上的渠道。
// 要在任何可能发通知的东西起来之前登记，不然那几条就悄悄丢了
registerNotifySink(telegramNotify);
// 自动整理听 files.landed 事件（转存 / 追更 / 云下载 / 监控 / 复制完成都发）：同样要在它们起来之前订上
startAutoOrganize();

// 上个进程退出时还在跑的任务已经没了，历史里不能永远挂着 running
const interrupted = reconcileInterruptedExecutions();
if (interrupted > 0) app.log.warn(`[history] ${interrupted} 条执行记录因进程重启被标为失败`);
const interruptedRuns = reconcileInterruptedRuns();
if (interruptedRuns > 0) app.log.warn(`[organize] ${interruptedRuns} 次整理因进程重启被标为失败，可以重新执行`);
// 同一个任务、同一个范围的待执行预览只留最新的一条：旧的按旧网盘状态算，待处理列表里也分不清谁是谁
const collapsedRuns = collapseStaleReadyRuns();
if (collapsedRuns > 0) app.log.info(`[organize] ${collapsedRuns} 次待执行的预览被同范围更新的取代，已作废`);
// 只增不减的几张表：启动清一次，之后每天一次
startHousekeeping();
// 检查更新：开了才查（默认关），启动后等一会儿再问，之后每天一次
startUpdateChecks();

// Global plugins
// 跨域按路径给：智能体用的几个路径对谁都开，/api 不对外站开（管理界面是同源的），见 plugins/cors.ts
await app.register(cors, { delegator: corsDelegator });
await app.register(compress);
// 防点击劫持、nosniff 这些通用的安全头：管理界面多数人直接放在公网上（FRAME_ANCESTORS 放开嵌入，见插件说明）
await app.register(securityHeadersPlugin, { frameAncestors: process.env.FRAME_ANCESTORS });
// 从公网地址那个域名进来的：没打开「这个域名也用来打开管理界面」时，只放行智能体用的几个路径
await app.register(publicHostPlugin);

// Core plugins (order matters)
await app.register(authPlugin);
await app.register(cronPlugin);

// Auth routes
await app.register(authLoginRoute);
await app.register(authLogoutRoute);
await app.register(authPasswordRoute);

// CRUD routes
await app.register(accountRoute);
await app.register(settingsRoute);
await app.register(taskRoute);
await app.register(taskHistoryRoute);

// Task execution routes
await app.register(taskStartRoute);
await app.register(taskCancelRoute);
await app.register(taskLogRoute);
await app.register(taskCronRoute);

// Cloud storage routes
await app.register(cloudFilesRoute);
await app.register(shareRoute);
await app.register(cloudOfflineRoute);
await app.register(copyRoute);
await app.register(followRoute);
await app.register(resourceRoute);

// Library routes
await app.register(libraryRoute);
await app.register(libraryTmdbRoute);
await app.register(libraryHdhiveRoute);
await app.register(librarySaveToTaskRoute);

// Directory routes
await app.register(directoryLocalRoute);
await app.register(directoryRemoteRoute);
await app.register(driveArchiveRoute);
await app.register(strmRoute);

// Alist-compatible route

// 115 life-event monitor
await app.register(lifeMonitorRoute);

// 整理与规范化命名
await app.register(organizeRoute);

// 智能体接入：令牌管理、/mcp，以及网页客户端走的 OAuth（元数据、注册、授权页、令牌）
await app.register(agentRoute);
await app.register(mcpRoute);
await app.register(oauthMetadataRoute);
await app.register(oauthRegisterRoute);
await app.register(oauthAuthorizeRoute);
await app.register(oauthTokenRoute);

// System routes
await app.register(clearDirectoryRoute);
await app.register(healthRoute);
await app.register(updateRoute);
await app.register(backupRoute);

// Telegram routes
import telegramBotRoute from "./routes/telegram/bot.js";
import telegramUsersRoute from "./routes/telegram/users.js";
import telegramPollingRoute from "./routes/telegram/polling.js";

await app.register(telegramBotRoute);
await app.register(telegramUsersRoute);
await app.register(telegramPollingRoute);

// 生产镜像里由这个进程托管管理界面（FRONTEND_DIR 指向前端的静态导出）；
// 开发时不设，next dev 自己在 3000 上跑
const frontendDir = process.env.FRONTEND_DIR;
if (frontendDir) {
  if (fs.existsSync(path.join(frontendDir, "index.html"))) {
    await app.register(staticSitePlugin, { root: path.resolve(frontendDir) });
  } else {
    app.log.warn(`FRONTEND_DIR=${frontendDir} 下没有 index.html，管理界面不可用`);
  }
}

// Emby 代理跑在独立进程里（src/proxy.ts）：
// 管理端崩溃或 strm 任务占满事件循环时，播放不受影响。
// 端口：开发默认 4000（next dev 占着 3000）；容器里 entrypoint 设成 3000，界面和 API 同一个口
const API_PORT = Number(process.env.BACKEND_PORT) || 4000;
const HOST = process.env.BACKEND_HOST || "0.0.0.0";

try {
  await app.listen({ port: API_PORT, host: HOST });
  app.log.info(`API server running on http://${HOST}:${API_PORT}`);
  // 影库：先装分享旁听（记分享死活），再接着抄没抄完的目录树，再认作品（抄完的来源补切单元）
  try {
    startLibraryHealth();
    startIndexer();
    startLibraryIdentify();
  } catch (err) {
    app.log.error({ err }, "收藏夹索引没能启动");
  }

  // 网盘监控：配置里开着就跟随服务一起起来
  const settings = readAppSettings();
  if (settings.lifeMonitor?.enabled) {
    startLifeMonitor()
      .then((r) => (r.ok && r.failed.length === 0 ? app.log.info(r.message) : app.log.warn(r.message)))
      .catch((err) => app.log.error({ err }, "life monitor start failed"));
  }
  // 云下载回执：上次关机前还有"下完生成 strm"没兑现的，接着盯
  startOfflineWatcher();
  // 复制到 OpenList：接管老版本在途的复制，再把队列里没办完的接着推
  try {
    adoptLegacyCopyFollowups();
  } catch (err) {
    app.log.warn({ err }, "接管旧的复制回执失败");
  }
  startCopyWatcher();
  // 老配置只有「源目录」没有挂载根：查一次 115 的默认下载目录换算过来。
  // 不 await：115 被风控时不能拖住启动，推不出来下次启动再试
  void migrateLegacyCopyMount().catch((err) => app.log.warn({ err }, "旧的「复制到 OpenList」配置换算失败"));
  // 分享追更：有开着的订阅就接着按周期检查
  startFollowWatcher();
  // Emby 入库通知：循环常驻，开关和配置每轮现查
  startEmbyNewWatcher();
  // Telegram 轮询同理：上次是开着的就自动恢复，别让每次重启都得有人去界面上再按一次
  if (settings.telegram?.pollingEnabled) {
    startPolling()
      .then((ok) => (ok ? app.log.info("Telegram 轮询已恢复") : app.log.warn("Telegram 轮询未能恢复：bot token 未配置")))
      .catch((err) => app.log.error({ err }, "telegram polling start failed"));
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown for tsx watch / SIGTERM
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  // 影库的后台工人先停：关库之后别再写
  try { stopIndexer(); stopLibraryIdentify(); stopLibraryHealth(); } catch { /* ignore */ }
  try { await stopLifeMonitor(); } catch { /* ignore */ }
  try { await stopOfflineWatcher(); } catch { /* ignore */ }
  try { await stopCopyWatcher(); } catch { /* ignore */ }
  try { await stopFollowWatcher(); } catch { /* ignore */ }
  try { await stopEmbyNewWatcher(); } catch { /* ignore */ }
  try { flushEmbyRefresh(); } catch { /* ignore */ }
  try { cancelAllRunningTasks(); } catch { /* ignore */ }
  try { cancelAllRuns(); } catch { /* ignore */ }

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
  const closeAll = app.close();

  await Promise.race([closeAll, timeout]);

  try { stopPolling(); } catch { /* ignore */ }
  try { sqlite.close(); } catch { /* ignore */ }

  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export default app;
