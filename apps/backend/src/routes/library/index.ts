import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getById, healthOf, listByShareCode, listWithHealth } from "../../db/repositories/media-library.js";
import { getShare } from "../../db/repositories/library-shares.js";
import { getUnit } from "../../db/repositories/library-units.js";
import { worksView } from "../../db/repositories/library-works-view.js";
import { ignoreUnit, matchUnit, reidentifySource, reidentifyUnit } from "../../services/library/identify.js";
import { listWorks, unitView, workDetail } from "../../services/library/works.js";
import { localOwned, ownedWorkKeys } from "../../services/library/owned.js";
import { findShareLinks } from "../../services/drive/registry.js";
import { checkShare, checkShares } from "../../services/library/health.js";
import { enqueueIndex } from "../../services/library/indexer.js";
import { searchLibrary } from "../../services/library/search.js";
import { relinkEntry, removeEntry, removeExpiredEntries, updateEntry } from "../../services/library/entries.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { cidSchema, idParamsSchema } from "../../schemas/entities.js";
import { addToLibrary, coveringOf } from "../../services/library/add.js";

const createSchema = z.looseObject({
  shareUrl: z.string().trim().min(1, "shareUrl is required"),
  title: z.string().optional(),
  coverUrl: z.string().optional(),
  tags: z.array(z.unknown()).optional(),
  notes: z.string().optional(),
  cid: cidSchema.optional(),
  fileCount: z.union([z.number(), z.string()]).optional(),
  rawName: z.string().optional(),
  sharePath: z.string().optional(),
});

const linksSchema = z.object({ text: z.string().max(200_000) });

const patchSchema = z.object({
  title: z.string().optional(),
  coverUrl: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.unknown()).optional(),
  receiveCode: z.string().optional(),
});

const searchSchema = z.object({
  q: z.string().trim().max(200, "关键词最多 200 个字").default(""),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  /** 要失效分享里的明细 */
  expired: z.enum(["0", "1"]).optional(),
  sourceId: z.string().max(100).optional(),
});

const checkSchema = z.object({
  codes: z.array(z.string().trim().min(1).max(100)).min(1, "至少给一个分享码").max(10, "一次最多查 10 个"),
});

const worksSchema = z.object({
  view: z.enum(["all", "movie", "tv", "low", "none"]).default("all"),
  sort: z.enum(["recent", "year", "title"]).default("recent"),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  keyword: z.string().trim().max(100).optional(),
  year: z.string().trim().max(20).optional(),
});

const workDetailSchema = z.object({
  key: z.string().trim().min(1).max(600),
});

/** 作品单元：换匹配 / 不是影视 / 重新认 */
const unitActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("match"),
    sourceId: z.string().min(1).max(100),
    unitKey: z.string().min(1).max(500),
    mediaType: z.enum(["movie", "tv"]),
    tmdbId: z.number().int().positive(),
  }),
  z.object({ action: z.enum(["ignore", "reidentify"]), sourceId: z.string().min(1).max(100), unitKey: z.string().min(1).max(500) }),
]);

const relinkSchema = z.object({
  shareUrl: z.string().trim().min(1, "shareUrl is required"),
  /** 新链接的内容和原来差很多时，第一次会 409 要确认；确认了再带 true */
  confirm: z.boolean().optional(),
});

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/library", { preHandler: [fastify.authenticate] }, async () => {
    const summaries = worksView().summaries;
    return listWithHealth().map((e) => {
      const w = summaries.get(e.id);
      return w ? { ...e, works: w } : e;
    });
  });

  // 作品：海报墙（同一个 tmdbId 的单元合成一张卡）
  fastify.get("/api/library/works", { preHandler: [fastify.authenticate] }, async (request) => {
    const q = parse(worksSchema, request.query, "query");
    // 本地已有的要扫盘：还没扫好不等，先只标从收藏夹存过的，告诉界面过几秒再拉
    const local = await localOwned(0);
    return { ...listWorks(q, ownedWorkKeys(local)), ...(local ? {} : { ownedPending: true }) };
  });

  fastify.get("/api/library/works/detail", { preHandler: [fastify.authenticate] }, async (request) => {
    const q = parse(workDetailSchema, request.query, "query");
    const detail = workDetail(q.key, await localOwned(0));
    if (!detail) throw new HttpError(404, "这部作品在收藏夹里找不到了（分享重新抄过、或者清理掉了）：刷新一下");
    return detail;
  });

  fastify.post("/api/library/units", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(unitActionSchema, request.body);
    if (body.action === "match") {
      const u = await matchUnit(body.sourceId, body.unitKey, body.mediaType, body.tmdbId);
      return { unit: unitView(u) };
    }
    if (body.action === "ignore") ignoreUnit(body.sourceId, body.unitKey);
    else reidentifyUnit(body.sourceId, body.unitKey);
    const u = getUnit(body.sourceId, body.unitKey);
    return { unit: u ? unitView(u) : null };
  });

  /** 一个来源里自动认的都重新认（改了识别词以后用）；手动指定的、忽略的不动 */
  fastify.post("/api/library/:id/reidentify", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    if (!getById(id)) throw new HttpError(404, "Entry not found");
    return { count: reidentifySource(id) };
  });

  fastify.get("/api/library/search", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "transfer" } }, async (request) => {
    const q = parse(searchSchema, request.query, "query");
    return searchLibrary({ q: q.q, limit: q.limit, offset: q.offset, includeExpired: q.expired === "1", sourceId: q.sourceId });
  });

  // 搜索结果里的分享顺手查一下死活：超过 6 小时没查过的才真去问网盘，每个分享一次请求
  fastify.post("/api/library/shares/check", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "transfer" } }, async (request) => {
    const body = parse(checkSchema, request.body);
    return { health: await checkShares(body.codes) };
  });

  // 批量添加：先把贴进来的一段话认成一个个分享（认法和加的时候一样），界面上加之前给人看；加还是一个一个走下面的 POST
  fastify.post("/api/library/links", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(linksSchema, request.body);
    return {
      links: findShareLinks(body.text).map((ref) => {
        const covering = coveringOf(listByShareCode(ref.code), "");
        return {
          kind: ref.kind,
          code: ref.code,
          url: ref.url,
          hasPassword: ref.password !== "",
          inLibrary: covering !== undefined,
          // 已经收着的带上它在影库里的名字，一眼认得出是哪个
          ...(covering ? { title: covering.shareTitle || covering.title } : {}),
        };
      }),
    };
  });

  fastify.post("/api/library", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = parse(createSchema, request.body);
    return reply.code(201).send(await addToLibrary(body));
  });

  fastify.put("/api/library/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(patchSchema, request.body);
    const entry = await updateEntry(id, body);
    if (!entry) throw new HttpError(404, "Entry not found");
    return entry;
  });

  /**
   * 重新抄：分享里加了片、上一轮没抄完。
   * 分享已失效 / 提取码不对的是「再查一次」：真去问一次网盘（巡检不再查失效的，审核完又能打开的分享只能靠这个捞回来），
   * 好了由 health 通知工人接着抄停下的，抄完的不重抄；还是打不开就说原因
   */
  fastify.post("/api/library/:id/refresh", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const entry = getById(id);
    if (!entry) throw new HttpError(404, "Entry not found");
    const before = getShare(entry.shareCode);
    if (before?.status === "expired" || before?.status === "locked") {
      const health = await checkShare(entry.shareCode);
      if (health.status === "expired" || health.status === "locked") {
        // 查的时间没变：没问到网盘（网络、账号的问题不记在分享上）
        if (health.checkedAt === before.checkedAt) throw upstreamError("这次没查成：网盘没回话或者账号有问题，稍后再试");
        const locked = health.status === "locked";
        throw upstreamError(locked ? "提取码还是不对：用「改提取码」改好" : `分享还是打不开：${health.reason || "已失效"}`, {
          code: "SHARE_GONE",
          reason: locked ? "password" : "gone",
        });
      }
      return { ...getById(id)!, health };
    }
    enqueueIndex(id);
    return { ...getById(id)!, health: healthOf(getShare(entry.shareCode)) };
  });

  /** 换链接（上传者重发了新链接）：内容和原来差很多时 409 要确认，确认了带 confirm 再来 */
  fastify.post("/api/library/:id/relink", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(relinkSchema, request.body);
    const entry = await relinkEntry(id, body);
    if (!entry) throw new HttpError(404, "Entry not found");
    return entry;
  });

  /** 清理全部已失效的分享：只删收藏夹里的记录和索引，网盘和 strm 都不动 */
  fastify.delete("/api/library/expired", { preHandler: [fastify.authenticate] }, async () => removeExpiredEntries());

  fastify.delete("/api/library/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    if (!removeEntry(id)) throw new HttpError(404, "Entry not found");
    return { success: true };
  });
}
