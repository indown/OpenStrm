import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addOfflineTasks,
  clearOfflineTasks,
  getOfflineDownPaths,
  listOfflineTasks,
  removeOfflineTasks,
  restartOfflineTask,
} from "../../services/offline/service.js";
import type { OfflineClearFlag } from "../../services/cloud-115/offline.js";
import { requireAgentScope } from "../../services/agent/access.js";
import { parse } from "../../lib/validate.js";
import { cidSchema } from "../../schemas/entities.js";

const accountQuerySchema = z.object({ account: z.string().optional() });
const listQuerySchema = accountQuerySchema.extend({ page: z.coerce.number().int().min(1).default(1) });

const addSchema = z.object({
  account: z.string().optional(),
  urls: z.union([z.string(), z.array(z.string())]),
  dirId: cidSchema.optional(),
  taskId: z.string().optional(),
  subPath: z.string().optional(),
  generateStrm: z.boolean().optional(),
  copyToOpenlist: z.boolean().optional(),
  copyDstDir: z.string().optional(),
});

const removeSchema = z.object({
  account: z.string().optional(),
  infoHashes: z.array(z.string().min(1)).min(1, "infoHashes is required"),
  deleteFiles: z.boolean().optional(),
});

/** 0 已完成 / 1 全部 / 2 已失败 / 3 进行中 / 4 已完成+删源文件 / 5 全部+删源文件 */
const clearSchema = z.object({ account: z.string().optional(), flag: z.number().int().min(0).max(5) });

const restartSchema = z.object({ account: z.string().optional(), infoHash: z.string().min(1) });

/**
 * 115 云下载（离线下载）。所有接口都可带 account 指定 115 账号，不带取第一个；
 * 加任务给了 taskId 时账号跟任务走。
 */
export default async function (fastify: FastifyInstance) {
  fastify.get("/api/115/offline", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "transfer" } }, async (request) => {
    const { account, page } = parse(listQuerySchema, request.query, "query");
    return listOfflineTasks(account, page);
  });

  fastify.post("/api/115/offline", { preHandler: [fastify.authenticate], config: { agentScope: "write", agentToolset: "transfer" } }, async (request) => {
    const body = parse(addSchema, request.body);
    return addOfflineTasks(body);
  });

  // 批量删除用 POST 而不是带 body 的 DELETE：一批 hash 放 query 里太长，也省得和代理/反代争论 DELETE 能不能带 body
  fastify.post("/api/115/offline/delete", { preHandler: [fastify.authenticate], config: { agentScope: "write", agentToolset: "transfer" } }, async (request) => {
    const { account, infoHashes, deleteFiles } = parse(removeSchema, request.body);
    // 连下载到网盘里的文件一起删是删东西：会话不受限，令牌得有「删除」档（同 /api/copy 的删源）
    if (deleteFiles === true) requireAgentScope(request, "danger");
    const r = await removeOfflineTasks(account, infoHashes, deleteFiles === true);
    return { success: true, ...r };
  });

  fastify.post("/api/115/offline/clear", { preHandler: [fastify.authenticate] }, async (request) => {
    const { account, flag } = parse(clearSchema, request.body);
    await clearOfflineTasks(account, flag as OfflineClearFlag);
    return { success: true };
  });

  fastify.post("/api/115/offline/restart", { preHandler: [fastify.authenticate] }, async (request) => {
    const { account, infoHash } = parse(restartSchema, request.body);
    await restartOfflineTask(account, infoHash);
    return { success: true };
  });

  /** 115 记着的默认下载目录，加任务对话框里没选目录时显示它 */
  fastify.get("/api/115/offline/downpath", { preHandler: [fastify.authenticate] }, async (request) => {
    const { account } = parse(accountQuerySchema, request.query, "query");
    return { dirs: await getOfflineDownPaths(account) };
  });
}
