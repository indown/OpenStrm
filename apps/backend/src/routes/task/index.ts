import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deleteTask, insertTask, listTasks, updateTask } from "../../db/repositories/tasks.js";
import { isTaskRunning, listRunningTaskIds } from "../../services/task/registry.js";
import { getLatestExecutions } from "../../services/task-history.js";
import { copyBlockFor } from "../../services/copy/paths.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { taskInputSchema, taskPatchSchema } from "../../schemas/entities.js";

const idQuerySchema = z.object({ id: z.string().min(1, "Task ID required") });

/**
 * 任务定义的增删改查。
 *
 * 302 的挂载路径不再写进 settings.mediaMountPath：代理侧直接从「开了 302 的任务」
 * 现算（services/resolve/direct-link.ts），删任务、关 302 时它自然消失，
 * 不会像以前那样只增不减。
 */
export default async function (fastify: FastifyInstance) {
  // 定时任务跟着任务定义走。以前只在启动时同步一次，改了 cron 表达式要重启才生效
  const resyncCron = () => fastify.cron.syncFromConfig();

  /** 任务定义 + 运行态 + 上次执行 + 下次定时：列表页一次拿齐，不用每行再查历史 */
  fastify.get("/api/task", { preHandler: [fastify.authenticate], config: { agentScope: "read" } }, async () => {
    const running = new Set(listRunningTaskIds());
    const latest = getLatestExecutions();
    const nextRuns = new Map(fastify.cron.listJobs().map((j) => [j.taskId, j.nextRun]));
    // 要复制的话卡在哪（null = 能复制）：开着复制却没配齐时列表上要看得出来，转存弹框的勾选框也按它；
    // copyBlockedAt 是去设置页哪儿改（「网盘挂载」里那一家的面板、「复制」一节，null = 不在设置页），徽标按它跳
    const copyBlock = copyBlockFor();
    return listTasks().map((task) => {
      const block = copyBlock(task);
      return {
        ...task,
        status: running.has(task.id) ? "processing" : "pending",
        lastRun: latest.get(task.id) ?? null,
        nextRunAt: nextRuns.get(task.id) ?? null,
        copyBlocked: block?.reason ?? null,
        copyBlockedAt: block?.spot ?? null,
      };
    });
  });

  fastify.post("/api/task", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const task = insertTask({ ...parse(taskInputSchema, request.body), id: randomUUID() });
    resyncCron();
    return reply.code(201).send(task);
  });

  fastify.put("/api/task", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id, ...patch } = parse(taskPatchSchema, request.body);
    const updated = updateTask(id, patch);
    if (!updated) throw new HttpError(404, "Task not found");
    resyncCron();
    return updated;
  });

  fastify.delete("/api/task", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idQuerySchema, request.query, "query");
    // 删了定义任务还在跑：进度流、执行记录都成了没主的；先取消再删
    if (isTaskRunning(id)) throw new HttpError(409, "任务正在运行，先取消再删除");
    if (!deleteTask(id)) throw new HttpError(404, "Task not found");
    resyncCron();
    return { success: true };
  });
}
