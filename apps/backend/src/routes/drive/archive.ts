import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getTask } from "../../db/repositories/tasks.js";
import { abandonedSignal } from "../../lib/abandoned-signal.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { ARCHIVE_MAX, archiveToStaging } from "../../services/copy/archive.js";
import { CLEAN_MAX, cleanArchive, listArchive } from "../../services/copy/archive-clean.js";
import { driveErrorToHttp } from "../../services/drive/errors.js";

const body = z.object({
  taskId: z.string().min(1),
  /** 相对任务网盘目录 */
  paths: z.array(z.string().min(1).max(1000)).min(1).max(ARCHIVE_MAX),
});

const listQuery = z.object({ taskId: z.string().min(1) });

const cleanBody = z.object({
  taskId: z.string().min(1),
  /** 相对归档目录；和 all 二选一 */
  paths: z.array(z.string().min(1).max(1000)).max(CLEAN_MAX).optional(),
  /** 归档目录这一层的全部条目 */
  all: z.boolean().optional(),
});

/**
 * 归档到暂存区：把任务网盘目录里的目录 / 文件挪进任务目录下的「归档」（见 services/copy/archive.ts）。
 * 不管复制队列、不核对别处有没有副本；可逆（到网盘里挪回去）。对智能体令牌开放（和 drive_archive 同一组、同一档）。
 * 清理归档：看归档目录里有什么（读档）、把不要了的从网盘上删掉（删除档，和 drive_archive_clean 同一档；见 services/copy/archive-clean.ts）
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

  fastify.get("/api/drive/archive", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "transfer" } }, async (request) => {
    const q = parse(listQuery, request.query);
    const task = getTask(q.taskId);
    if (!task) throw new HttpError(404, `任务不存在：${q.taskId}`);
    try {
      return await listArchive(task);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw driveErrorToHttp(err, "列归档目录失败");
    }
  });

  fastify.post("/api/drive/archive/clean", { preHandler: [fastify.authenticate], config: { agentScope: "danger", agentToolset: "transfer" } }, async (request, reply) => {
    const b = parse(cleanBody, request.body);
    const task = getTask(b.taskId);
    if (!task) throw new HttpError(404, `任务不存在：${b.taskId}`);
    try {
      // 逐条删：浏览器不等了就掐掉，删掉的已经删掉了，再调一次会说哪些已经不在
      return await cleanArchive({ task, paths: b.paths, all: b.all, signal: abandonedSignal(reply) });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw driveErrorToHttp(err, "清理归档失败");
    }
  });
}
