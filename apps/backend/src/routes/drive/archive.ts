import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getTask } from "../../db/repositories/tasks.js";
import { abandonedSignal } from "../../lib/abandoned-signal.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { ARCHIVE_MAX, archiveToStaging } from "../../services/copy/archive.js";
import { driveErrorToHttp } from "../../services/drive/errors.js";

const body = z.object({
  taskId: z.string().min(1),
  /** 相对任务网盘目录 */
  paths: z.array(z.string().min(1).max(1000)).min(1).max(ARCHIVE_MAX),
});

/**
 * 归档到暂存区：把任务网盘目录里的目录 / 文件挪进任务目录下的「归档」（见 services/copy/archive.ts）。
 * 不管复制队列、不核对别处有没有副本；可逆（到网盘里挪回去）。对智能体令牌开放（和 drive_archive 同一组、同一档）
 */
export default async function (fastify: FastifyInstance) {
  fastify.post("/api/drive/archive", { preHandler: [fastify.authenticate], config: { agentScope: "write", agentToolset: "transfer" } }, async (request, reply) => {
    const b = parse(body, request.body);
    const task = getTask(b.taskId);
    if (!task) throw new HttpError(404, `任务不存在：${b.taskId}`);
    try {
      // 逐条到网盘找节点、再挪：浏览器不等了就掐掉，挪完的那几条已经落库
      return await archiveToStaging({ task, paths: b.paths, signal: abandonedSignal(reply) });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw driveErrorToHttp(err, "归档失败");
    }
  });
}
