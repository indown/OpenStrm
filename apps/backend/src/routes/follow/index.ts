import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ShareFollowSummary } from "@openstrm/shared";
import { getShareFollow } from "../../db/repositories/share-follows.js";
import { HttpError } from "../../lib/http-error.js";
import { checkFollow, createFollow, deleteFollow, listFollows, updateFollow } from "../../services/follow/service.js";
import { shareLinkWithoutPassword } from "../../services/agent/format.js";
import { parse } from "../../lib/validate.js";
import { idParamsSchema, shareFollowCreateSchema, shareFollowPatchSchema } from "../../schemas/entities.js";

/**
 * 分享追更订阅。转存接口（/api/115/share、/api/library/:id/save-to-task）带 follow 参数时会顺手建订阅，
 * 这里是之后的管理：列表、改、删、立即检查。
 *
 * 对智能体令牌开放的档位和追更工具一致：看是 read、改（名字 / 开关 / 间隔 / 不再沿用整理结果）和立即检查是 write（检查会把新增转存进网盘）、删是 danger。
 * 令牌不能建订阅、不能改订阅转存到哪（任务 / 子目录）和提取码：那等于一个新的转存入口，只有转存那一组（share_save）能做；
 * 列表里给令牌的不带提取码
 */
const isToken = (request: FastifyRequest) => request.principal?.kind === "token";

/** 给令牌看的订阅：提取码拿掉，分享链接去掉提取码 */
function forToken({ receiveCode: _receiveCode, ...f }: ShareFollowSummary): Omit<ShareFollowSummary, "receiveCode"> {
  return { ...f, shareUrl: shareLinkWithoutPassword(f.shareUrl) };
}

/** 令牌能改的字段：名字、开关、检查间隔、不再沿用整理结果 */
const TOKEN_PATCH_FIELDS = new Set(["name", "enabled", "intervalMinutes", "clearOrganized"]);

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/follow", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "follow" } }, async (request) => {
    const all = listFollows();
    return isToken(request) ? { ...all, follows: all.follows.map(forToken) } : all;
  });

  fastify.post("/api/follow", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = parse(shareFollowCreateSchema, request.body);
    return reply.code(201).send(await createFollow(body));
  });

  fastify.put("/api/follow/:id", { preHandler: [fastify.authenticate], config: { agentScope: "write", agentToolset: "follow" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const patch = parse(shareFollowPatchSchema, request.body);
    if (isToken(request)) {
      const denied = Object.keys(patch).filter((k) => !TOKEN_PATCH_FIELDS.has(k));
      if (denied.length) throw new HttpError(403, `令牌只能改订阅的名字、开关、检查间隔和不再沿用整理结果，${denied.join("、")} 要在管理界面上改`, { code: "FIELD_NOT_ALLOWED", fields: denied });
    }
    const updated = updateFollow(id, patch);
    return isToken(request) ? forToken(updated) : updated;
  });

  fastify.delete("/api/follow/:id", { preHandler: [fastify.authenticate], config: { agentScope: "danger", agentToolset: "follow" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    deleteFollow(id);
    return { success: true };
  });

  /** 立即检查一次：要递归列分享目录，有新增还要转存，可能要等几十秒。令牌不能检查暂停着的订阅（要先恢复） */
  fastify.post("/api/follow/:id/check", { preHandler: [fastify.authenticate], config: { agentScope: "write", agentToolset: "follow" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    if (isToken(request) && getShareFollow(id)?.enabled === false) {
      throw new HttpError(409, "这条订阅暂停着，要检查先恢复它", { code: "FOLLOW_PAUSED" });
    }
    const r = await checkFollow(id);
    return isToken(request) ? { ...r, follow: forToken(r.follow) } : r;
  });
}
