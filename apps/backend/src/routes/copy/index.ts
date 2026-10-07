import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getTask } from "../../db/repositories/tasks.js";
import { HttpError } from "../../lib/http-error.js";
import { canAfterCopy, canRetryCopy, dropCopy, getCopyWatcherStatus, listCopies, retryCopy, type CopyRecord } from "../../services/copy/service.js";
import { enqueueManualCopy, MANUAL_PATHS_MAX } from "../../services/copy/manual.js";
import { AFTER_MAX, settleAfterCopy } from "../../services/copy/after.js";
import { hasScope } from "../../services/agent/access.js";
import { driveErrorToHttp } from "../../services/drive/errors.js";
import { abandonedSignal } from "../../lib/abandoned-signal.js";
import { parse } from "../../lib/validate.js";

const idParams = z.object({ id: z.string().min(1) });
const addBody = z.object({
  taskId: z.string().min(1),
  /** 相对任务网盘目录 */
  paths: z.array(z.string().min(1).max(1000)).min(1).max(MANUAL_PATHS_MAX),
  dstDir: z.string().max(1000).optional(),
  afterCopy: z.enum(["keep", "delete", "archive"]).optional(),
});
/** 事后处理源文件：按记录 id，或者按任务 + 相对路径（二选一，服务层会查） */
const afterBody = z.object({
  afterCopy: z.enum(["archive", "delete"]),
  ids: z.array(z.string().min(1).max(100)).max(AFTER_MAX).optional(),
  taskId: z.string().min(1).optional(),
  paths: z.array(z.string().min(1).max(1000)).max(AFTER_MAX).optional(),
  dstDir: z.string().max(1000).optional(),
});

/** 列表里的先后：能重试的 → 还在跑的 → 其余 */
const rank = (c: CopyRecord) => (canRetryCopy(c) ? 0 : c.status === "pending" ? 1 : 2);
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });

/**
 * 「复制到 OpenList」的队列：看进度、手动发起、失败了重排、不想跟了就删掉，复制好的还能事后把源文件归档 / 删除。
 * 自动登记是各个来源（云下载 / 转存 / 追更 / 监控）自己做的；POST 是事后补的手动发起（见 services/copy/manual.ts），
 * POST /after 是复制好之后再处理网盘上的源文件（见 services/copy/after.ts）。
 * 看、发起、重试、事后处理对智能体令牌开放（和 copy_list / copy_add / copy_retry / copy_after 同一组、同一档；要删源得有「删除」档）；
 * 「不跟了」只认会话，智能体用不着
 */
export default async function (fastify: FastifyInstance) {
  fastify.get("/api/copy", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "transfer" } }, async (request) => {
    const { limit = 50 } = parse(listQuery, request.query, "query");
    const items = listCopies();
    return {
      // 要人动手的排在前面：能重试的、再是还在跑的，各自新的在前。界面只拿前面一截，老的失败不能被一季几十集的成功挤出去
      items: [...items]
        .sort((a, b) => rank(a) - rank(b) || b.addedAt - a.addedAt)
        .slice(0, limit)
        .map((c) => ({ ...c, canRetry: canRetryCopy(c), canAfterCopy: canAfterCopy(c) })),
      total: items.length,
      // 队列已经读出来了，别让状态再读一遍
      watcher: getCopyWatcherStatus(items),
    };
  });

  fastify.post("/api/copy", { preHandler: [fastify.authenticate], config: { agentScope: "write", agentToolset: "transfer" } }, async (request, reply) => {
    const body = parse(addBody, request.body);
    const task = getTask(body.taskId);
    if (!task) throw new HttpError(404, `任务不存在：${body.taskId}`);
    // 复制完删源是删东西：会话不受限，令牌得有「删除」档——没明说、按任务设置落到删除的也一样，由服务层按最终的去向把关
    const p = request.principal;
    const allowDelete = p?.kind !== "token" || hasScope(p.token, "danger");
    try {
      // 到网盘核对、和目标比对可能要一会（115 整目录导出）：浏览器不等了就掐掉，别在它走了之后还登记
      return await enqueueManualCopy({ task, paths: body.paths, dstDir: body.dstDir, afterCopy: body.afterCopy, allowDelete, signal: abandonedSignal(reply) });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw driveErrorToHttp(err, "发起复制失败");
    }
  });

  fastify.post("/api/copy/after", { preHandler: [fastify.authenticate], config: { agentScope: "write", agentToolset: "transfer" } }, async (request, reply) => {
    const body = parse(afterBody, request.body);
    const task = body.taskId ? getTask(body.taskId) : undefined;
    if (body.taskId && !task) throw new HttpError(404, `任务不存在：${body.taskId}`);
    const p = request.principal;
    const allowDelete = p?.kind !== "token" || hasScope(p.token, "danger");
    try {
      // 核对要到网盘和 OpenList 各看一眼、归档是网盘上的一次移动：浏览器不等了就掐掉，办完的那几条已经落库
      return await settleAfterCopy({ afterCopy: body.afterCopy, ids: body.ids, task: task ?? undefined, paths: body.paths, dstDir: body.dstDir, allowDelete, signal: abandonedSignal(reply) });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw driveErrorToHttp(err, "处理源文件失败");
    }
  });

  fastify.post("/api/copy/:id/retry", { preHandler: [fastify.authenticate], config: { agentScope: "write", agentToolset: "transfer" } }, async (request) => {
    const { id } = parse(idParams, request.params, "params");
    return retryCopy(id);
  });

  fastify.delete("/api/copy/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParams, request.params, "params");
    dropCopy(id);
    return { success: true };
  });
}
