import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AccountInfo } from "@openstrm/shared";
import {
  deleteAccount,
  getAccount,
  insertAccount,
  listAccounts,
  updateAccount,
} from "../../db/repositories/accounts.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { accountInputSchema, accountPatchSchema } from "../../schemas/entities.js";
import { isMasked, maskAccount, unmaskAccountPatch } from "../../lib/secrets.js";
import { credentialProblem, missingCredentials } from "../../services/drive/credentials.js";

const nameQuerySchema = z.object({ name: z.string().min(1, "Missing name") });

/**
 * 存进去会跑不了的凭据保存时就拦下（比如 115 的网页版 cookie），别等用户跑任务才看到「请重新登录」。
 * 只看这次新给的：掩码沿用的是库里那份，以前存进去的不在这里追究。规则按网盘分在 services/drive/credentials.ts
 */
function rejectBadCredentials(accountType: unknown, incoming: unknown): void {
  if (typeof incoming !== "string" || isMasked(incoming)) return;
  const problem = credentialProblem(accountType, incoming);
  if (problem) throw new HttpError(400, problem.message, { code: problem.code });
}

export default async function (fastify: FastifyInstance) {
  // cookie / 密码 / 令牌只给末 4 位；编辑表单原样提交掩码值等于不改（见 lib/secrets.ts）
  fastify.get("/api/account", { preHandler: [fastify.authenticate] }, async () => listAccounts().map(maskAccount));

  fastify.post("/api/account", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = parse(accountInputSchema, request.body) as AccountInfo;
    if (getAccount(body.name)) throw new HttpError(409, "Account name already exists");
    // 新建没有原值可回填：掩码值会变成缺失，被下面的必填校验拒绝
    const account = unmaskAccountPatch(body, null);
    const missing = missingCredentials(account);
    if (missing) throw new HttpError(400, missing);
    rejectBadCredentials(account.accountType, "cookie" in body ? body.cookie : undefined);
    insertAccount(account);
    return reply.code(201).send(maskAccount(account));
  });

  fastify.put("/api/account", { preHandler: [fastify.authenticate] }, async (request) => {
    const parsed = parse(accountPatchSchema, request.body);
    const current = getAccount(parsed.name);
    const body = unmaskAccountPatch(parsed, current);
    const missing = missingCredentials(body);
    if (missing) throw new HttpError(400, missing);
    // 没带 accountType 的按库里的类型算：编辑表单只换 cookie 时就是这样
    rejectBadCredentials(body.accountType ?? current?.accountType, parsed.cookie);
    const updated = updateAccount(parsed.name, body);
    if (!updated) throw new HttpError(404, "Account not found");
    return maskAccount(updated);
  });

  fastify.delete("/api/account", { preHandler: [fastify.authenticate] }, async (request) => {
    const { name } = parse(nameQuerySchema, request.query, "query");
    if (!deleteAccount(name)) throw new HttpError(404, "Account not found");
    return { message: "Account deleted" };
  });
}
