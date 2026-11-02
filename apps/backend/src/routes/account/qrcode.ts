import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "../../lib/validate.js";
import { QRCODE_APPS, pollQrcodeLogin, startQrcodeLogin } from "../../services/cloud-115/qrcode.js";

/**
 * 115 扫码登录，账户弹框里「扫码登录」用：先生成二维码，再轮询状态，确认那一次带回 cookie。
 *
 * 直接 import cloud-115 的模块而不走 drive Provider：登录不是网盘操作，没有 Provider 可走，夸克也没有扫码这回事。
 * 和其它账号接口一样只认登录会话、不声明 agentScope：账号凭据永远不对令牌开放。
 */
const startSchema = z.object({ app: z.enum(QRCODE_APPS) });
const uidSchema = z.object({ uid: z.string().min(1) });

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/account/115/qrcode", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { app } = parse(startSchema, request.body);
    return reply.code(201).send(await startQrcodeLogin(app));
  });

  // cookie 只在确认那一次响应里给，界面拿到就填进表单；再问同一个 uid 就是 404
  fastify.get("/api/account/115/qrcode/:uid", { preHandler: [fastify.authenticate] }, async (request) => {
    const { uid } = parse(uidSchema, request.params, "params");
    return pollQrcodeLogin(uid);
  });
}
