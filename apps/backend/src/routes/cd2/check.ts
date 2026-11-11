/**
 * CloudDrive2 的「检查连接」：账户弹框按还没保存的草稿验（带 url），设置页「网盘挂载」「复制」两节按选中的账号验（只带 account，映射在页面上逐行查）。
 * 怎么验、各段说什么在 services/cd2/check.ts。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Cd2CheckResult } from "@openstrm/shared";
import { parse } from "../../lib/validate.js";
import { checkCd2 } from "../../services/cd2/check.js";

const bodySchema = z.object({
  account: z.string().trim().max(200).optional(),
  url: z.string().trim().max(300).optional(),
  apiToken: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  mounts: z.record(z.string(), z.string()).optional(),
});

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/cd2/check", { preHandler: [fastify.authenticate] }, async (request): Promise<Cd2CheckResult> => checkCd2(parse(bodySchema, request.body ?? {})));
}
