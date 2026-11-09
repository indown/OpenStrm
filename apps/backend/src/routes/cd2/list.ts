/**
 * 列 CloudDrive2 里一个目录下的子目录：设置页和任务弹框给复制目标目录选路径用（CD2 当复制引擎时）。
 * 只给目录，形状和 /api/directory/remote/list 一样（DirectoryNode）。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readAppSettings } from "../../db/repositories/settings.js";
import { messageOf } from "../../lib/errors.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { cd2ListEntries, isCd2Missing } from "../../services/cd2/client.js";
import { cd2ConnectionOf } from "../../services/cd2/config.js";
import { joinPath, normDir } from "../../services/copy/paths.js";

const bodySchema = z.object({ path: z.string().trim().max(2000).optional() });

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/cd2/list", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(bodySchema, request.body ?? {});
    const conn = cd2ConnectionOf(readAppSettings().cd2);
    if (!conn) throw new HttpError(400, "设置页的 CloudDrive2 一节还没填地址和凭据，列不了它的目录");
    const path = normDir(body.path) || "/";
    try {
      const entries = await cd2ListEntries(conn, path);
      return entries.filter((e) => e.isDir).map((e) => ({ name: e.name, id: joinPath(path, e.name), isDir: true, hasChildren: true }));
    } catch (err) {
      if (isCd2Missing(err)) throw new HttpError(404, `目录不存在: ${path}`);
      throw upstreamError(`读 CloudDrive2 目录失败：${messageOf(err)}`, {}, err);
    }
  });
}
