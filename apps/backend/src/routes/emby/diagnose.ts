import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "../../lib/validate.js";
import { diagnosePlayback } from "../../services/emby/diagnose.js";

const bodySchema = z.object({
  /** 指定条目 id；留空就挑最近入库、还没探测过的 strm 条目 */
  itemId: z.string().trim().max(64).optional(),
});

/** 起播诊断：设置页 Emby 一节的按钮。会让 Emby 真探测一次、向网盘真要一次直链，所以是 POST */
export default async function (fastify: FastifyInstance) {
  fastify.post("/api/emby/playback-diagnose", { preHandler: [fastify.authenticate] }, async (request) => {
    const { itemId } = parse(bodySchema, request.body ?? {});
    return diagnosePlayback({ itemId: itemId || undefined, userAgent: request.headers["user-agent"] });
  });
}
