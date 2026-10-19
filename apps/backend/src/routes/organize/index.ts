/**
 * 整理与规范化命名。预览 / 执行 / 撤销都是后台作业，接口立刻返回，页面轮询 GET /runs/:id 看进度。
 *
 * 对智能体令牌开放的档位和整理工具一致：看是 read，预览和改清单是 run，执行 / 撤销 / 放弃是 write；
 * 执行带删除项的清单另要 danger。改清单时选删掉 / 覆盖不要：只是写进清单，真删在执行，界面执行有确认框、钉着 planVersion；
 * 作废待确认的清单（取消它、或者在它的范围上重新预览）要 write，令牌还得明说 fresh。删整理记录、识别记忆、模板试算只认会话。
 *
 * 执行待确认的清单时带上 planVersion（详情里给的）：打开之后清单被改过（比如智能体改的）就回 409，让人重新看一眼；令牌必须带
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { OrganizeTemplatePreview } from "@openstrm/shared";
import { forgetMatch, getRun, listItems as listRunItemRows, listMatches } from "../../db/repositories/organize.js";
import { HttpError } from "../../lib/http-error.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { parse } from "../../lib/validate.js";
import { requireAgentScope } from "../../services/agent/access.js";
import {
  applyRun,
  cancelRun,
  createRun,
  deleteRun,
  getRunDetail,
  getRunSummary,
  listAttention,
  listRunItems,
  listRuns,
  lookupCandidate,
  lookupTitles,
  patchItems,
  patchUnit,
  patchUnits,
  planFingerprint,
  probeUnits,
  decorateItemsWithProbes,
  readyRunsWithin,
  repreviewRun,
  revertRun,
  searchCandidates,
  skipItems,
} from "../../services/organize/run.js";
import { purgeTmdbCache } from "../../services/organize/identify.js";
import { parseRules } from "../../services/organize/rules.js";
import { DEFAULT_TEMPLATES, resolveOrganizeSettings } from "../../services/organize/settings.js";
import { idTagFor, renderTemplate, validateTemplate } from "../../services/organize/template.js";
import { idParamsSchema } from "../../schemas/entities.js";

const createSchema = z.object({
  taskId: z.string().trim().min(1, "taskId is required"),
  subPath: z.string().optional(),
  paths: z.array(z.string()).max(5000).optional(),
  /** 令牌用：范围里已有待确认的清单也重新预览（会作废它们） */
  fresh: z.boolean().optional(),
  /** 刷新 TMDB 信息：这次预览的详情和季集跳过缓存重新拉 */
  refreshTmdb: z.boolean().optional(),
  /** 命名来源：tmdb（默认）按识别 + 模板；local 按本地 strm 的目录结构 */
  naming: z.enum(["tmdb", "local"]).optional(),
});

/** 令牌一次最多点这么多个目录（和 organize_preview 一样）：手动范围要逐个去网盘确认存在 */
const TOKEN_PATHS_MAX = 50;

const isToken = (request: FastifyRequest) => request.principal?.kind === "token";

/**
 * 令牌在一个范围上预览：范围里已有待确认的清单（可能是人改了一半的），预览做完就会把它们作废。
 * 不明说 fresh 就拦下、把它们列出来；明说了也要改网盘档
 */
function guardSupersede(request: FastifyRequest, taskId: string, scope: { subPath?: string; paths?: string[] }, fresh: boolean | undefined): void {
  if (!isToken(request)) return;
  const existing = readyRunsWithin(taskId, scope);
  if (existing.length === 0) return;
  if (!fresh) {
    throw new HttpError(409, `这个范围里已经有 ${existing.length} 份待确认的清单，重新预览会作废它们；确实要重新预览就带上 fresh: true`, {
      code: "READY_PLANS_EXIST",
      runs: existing.map((r) => r.id),
    });
  }
  requireAgentScope(request, "write");
}

const listQuerySchema = z.object({
  taskId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const unitPatchSchema = z.object({
  key: z.string().min(1),
  match: z.object({ mediaType: z.enum(["movie", "tv"]), tmdbId: z.number().int().positive() }).optional(),
  seasonOverride: z.number().int().min(0).max(99).nullable().optional(),
  episodeOffset: z.number().int().min(-2000).max(2000).optional(),
  selected: z.boolean().optional(),
  remember: z.boolean().optional(),
  /** 刷新 TMDB 信息：按现在的匹配跳过缓存重新拉详情和季集 */
  refresh: z.boolean().optional(),
  /** 改标题 / 年份（只影响命名）：null 或空串回到 TMDB 的 */
  title: z.string().trim().max(200).refine((t) => !t.includes("/"), { message: "标题不能带 /" }).nullable().optional(),
  year: z.string().trim().refine((y) => y === "" || /^\d{4}$/.test(y), { message: "年份是四位数字" }).nullable().optional(),
});

const previewNameSchema = z.object({
  templates: z.object({ movie: z.string().optional(), tv: z.string().optional() }).optional(),
  idTag: z.enum(["emby", "jellyfin", "plex", "none"]).optional(),
  colon: z.enum(["smart", "delete", "dash", "spaceDash"]).optional(),
  episodeTitle: z.boolean().optional(),
  rules: z.array(z.string()).optional(),
});

const forgetSchema = z.object({ accountName: z.string().min(1), srcPath: z.string().min(1) });

/** 批量勾选单元：全选、全不选、只选把握大的 */
const unitsPatchSchema = z
  .object({ keys: z.array(z.string().min(1)).min(1).max(5000), selected: z.boolean().optional(), remember: z.boolean().optional() })
  .refine((b) => b.selected !== undefined || b.remember !== undefined, { message: "selected 或 remember 至少给一个" });

/**
 * 按文件改：勾选 / 取消勾选，或者给冲突项选个办法（resolve 为 null 是撤回选择）。ids 是当前清单里的项。
 * custom 要带 name（目标文件名，不能带目录）
 */
const conflictResolveSchema = z
  .object({
    how: z.enum(["rename", "custom", "duplicate", "delete", "replace"]),
    name: z.string().trim().min(1).max(200).refine((n) => !n.includes("/"), { message: "目标文件名不能带目录" }).optional(),
  })
  .refine((r) => r.how !== "custom" || !!r.name, { message: "自己改名要填目标文件名" });
/** 钉季 / 集：至少给一个；null 撤掉 */
const pinSchema = z
  .object({ season: z.number().int().min(0).max(99).optional(), episode: z.number().int().min(0).max(9999).optional() })
  .refine((p) => p.season !== undefined || p.episode !== undefined, { message: "季或集至少给一个" });

const itemsPatchSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(5000),
    selected: z.boolean().optional(),
    resolve: conflictResolveSchema.nullable().optional(),
    pin: pinSchema.nullable().optional(),
    name: z.string().trim().max(200).refine((n) => !n.includes("/"), { message: "目标文件名不能带目录" }).nullable().optional(),
  })
  .refine((b) => b.selected !== undefined || b.resolve !== undefined || b.pin !== undefined || b.name !== undefined, { message: "selected、resolve、pin、name 至少给一个" });

/** 换匹配弹框的 TMDB 搜索：可以限定类型和年份 */
const tmdbSearchSchema = z.object({
  query: z.string().trim().min(1, "query is required").max(200),
  type: z.enum(["movie", "tv"]).optional(),
  year: z.string().regex(/^\d{4}$/, "年份是四位数字").optional(),
});
const tmdbParamsSchema = z.object({ type: z.enum(["movie", "tv"]), id: z.coerce.number().int().positive() });

/** 按需拉项：一个单元的（unit 空串是建目录 / 删空目录），或者失败面板的一组 */
const itemsQuerySchema = z
  .object({
    unit: z.string().optional(),
    group: z.enum(["transient", "blocked", "stale", "rejected", "mirror", "lost", "pending"]).optional(),
  })
  .refine((q) => q.unit !== undefined || q.group !== undefined, { message: "unit 或 group 至少给一个" });

/**
 * 执行：不带 ids 做全部（ready）或默认重试集；带 ids 只重试点名的项（stale / rejected 的要这样才会重试）。
 * planVersion 是页面打开时详情里给的：待执行的清单对不上就不执行
 */
const applySchema = z.object({ ids: z.array(z.string().min(1)).max(5000).optional(), planVersion: z.string().max(40).optional() });
/**
 * 探测编码：key 是这个单元的全部视频（默认连上次失败的一起重试）；keys 是这些单元里文件名缺模板标签的视频；
 * missing 是清单里勾选的全部单元中缺标签的视频；retryFailed 明确说要不要重试失败过的
 */
const probeSchema = z
  .object({
    key: z.string().min(1).optional(),
    keys: z.array(z.string().min(1)).min(1).max(2000).optional(),
    missing: z.boolean().optional(),
    retryFailed: z.boolean().optional(),
  })
  .refine((b) => !!b.key || !!b.keys || b.missing === true, { message: "key、keys 或 missing 至少给一个" });

/** fresh 是「范围里已有待确认的清单也重新预览」；refreshTmdb 是「这次预览跳过 TMDB 缓存」，两回事 */
const repreviewSchema = z.object({ fresh: z.boolean().optional(), refreshTmdb: z.boolean().optional() });
const skipSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(5000) });

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/organize/runs", { preHandler: [fastify.authenticate], config: { agentScope: "run", agentToolset: "organize" } }, async (request, reply) => {
    const body = parse(createSchema, request.body);
    if (isToken(request) && (body.paths?.length ?? 0) > TOKEN_PATHS_MAX) throw new HttpError(400, `一次最多整理 ${TOKEN_PATHS_MAX} 个目录`);
    guardSupersede(request, body.taskId, { subPath: body.subPath, paths: body.paths }, body.fresh);
    const trigger = isToken(request) ? "agent" : "manual";
    const run = await createRun({ taskId: body.taskId, subPath: body.subPath, paths: body.paths, mode: "manual", trigger, refreshTmdb: body.refreshTmdb, naming: body.naming });
    return reply.code(201).send(run);
  });

  fastify.get("/api/organize/runs", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "organize" } }, async (request) => {
    const q = parse(listQuerySchema, request.query, "query");
    return { runs: listRuns({ taskId: q.taskId || undefined, limit: q.limit, offset: q.offset }) };
  });

  /** 要人管的 run（跨任务）：待执行、进行中、有失败或做了一半、撤销有没退回的、自动触发的预览失败 */
  fastify.get("/api/organize/attention", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "organize" } }, async () => ({ runs: listAttention() }));

  fastify.get("/api/organize/runs/:id", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "organize" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    return getRunDetail(id);
  });

  /** 执行 / 撤销进行中页面轮询它：run（含进度 / 日志）+ 分组 + 按钮开关，不带单元和项 */
  fastify.get("/api/organize/runs/:id/summary", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "organize" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    return getRunSummary(id);
  });

  fastify.get("/api/organize/runs/:id/items", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "organize" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const q = parse(itemsQuerySchema, request.query, "query");
    return { items: decorateItemsWithProbes(id, listRunItems(id, q)) };
  });

  /** 预览里探测编码（mediainfo.js 读文件头）：填进标签、重新规划；返回每个文件读到了什么 */
  fastify.post("/api/organize/runs/:id/probe", { preHandler: [fastify.authenticate], config: { agentScope: "run", agentToolset: "organize" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(probeSchema, request.body ?? {});
    return probeUnits(id, { key: body.key, keys: body.keys, missing: body.missing }, { retryFailed: body.retryFailed });
  });

  /** 批量勾选单元：一次重规划 */
  fastify.put("/api/organize/runs/:id/units", { preHandler: [fastify.authenticate], config: { agentScope: "run", agentToolset: "organize" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(unitsPatchSchema, request.body);
    return patchUnits(id, body.keys, { selected: body.selected, remember: body.remember });
  });

  /** 按文件勾选（取消勾选的跳过，跟着它的字幕 / nfo 一起留下），或给冲突项选办法（改名保留 / 自己改名 / 挪进重复文件 / 删掉 / 覆盖） */
  fastify.put("/api/organize/runs/:id/items", { preHandler: [fastify.authenticate], config: { agentScope: "run", agentToolset: "organize" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(itemsPatchSchema, request.body);
    return patchItems(id, body.ids, { selected: body.selected, resolve: body.resolve, pin: body.pin, name: body.name });
  });

  /** 换匹配弹框：按关键词搜（可限类型、年份） */
  fastify.post("/api/organize/tmdb/search", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "organize" } }, async (request) => {
    const body = parse(tmdbSearchSchema, request.body);
    return { results: await searchCandidates(body) };
  });

  /** 换匹配弹框：按 TMDB 编号查 */
  fastify.get("/api/organize/tmdb/:type/:id", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "organize" } }, async (request) => {
    const p = parse(tmdbParamsSchema, request.params, "params");
    return lookupCandidate(p.type, p.id);
  });

  /** 改标题弹框：这部作品的译名、原名、英文名、别名 */
  fastify.get("/api/organize/tmdb/:type/:id/titles", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "organize" } }, async (request) => {
    const p = parse(tmdbParamsSchema, request.params, "params");
    return lookupTitles(p.type, p.id);
  });

  /** 设置页「清空 TMDB 缓存」：TMDB 上改了译名 / 海报，不等缓存过期就重新拉。只给人用，令牌不开放 */
  fastify.delete("/api/organize/tmdb/cache", { preHandler: [fastify.authenticate] }, async () => ({ cleared: purgeTmdbCache() }));

  /** 单元 key 里可能带 /，放 body 里 */
  fastify.put("/api/organize/runs/:id/unit", { preHandler: [fastify.authenticate], config: { agentScope: "run", agentToolset: "organize" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const { key, ...patch } = parse(unitPatchSchema, request.body);
    return patchUnit(id, key, patch);
  });

  fastify.post("/api/organize/runs/:id/apply", { preHandler: [fastify.authenticate], config: { agentScope: "write", agentToolset: "organize" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(applySchema, request.body ?? {});
    const run = getRun(id);
    if (run?.status === "ready") {
      if (isToken(request) && !body.planVersion) {
        throw new HttpError(400, "执行待确认的清单要带 planVersion（详情里给的）", { code: "PLAN_VERSION_REQUIRED" });
      }
      const current = planFingerprint(id);
      if (body.planVersion && body.planVersion !== current) {
        throw new HttpError(409, "清单在你打开之后被改过了（可能是智能体改的），先看一眼现在的清单再执行", { code: "PLAN_CHANGED", planVersion: current });
      }
    }
    // 清单里还有要删的文件（冲突选了删掉 / 覆盖）：令牌得有删除档
    if (request.principal?.kind === "token") {
      const wanted = body.ids ? new Set(body.ids) : null;
      const deletes = listRunItemRows(id).some((it) => it.action === "delete" && !it.givenUp && (it.status === "pending" || it.status === "failed") && (!wanted || wanted.has(it.id)));
      if (deletes) requireAgentScope(request, "danger");
    }
    return applyRun(id, body.ids);
  });

  /** 放弃失败项：标成「已放弃」让 run 收口；原地改了名还没挪走的先在网盘上改回原名 */
  fastify.post("/api/organize/runs/:id/skip", { preHandler: [fastify.authenticate], config: { agentScope: "write", agentToolset: "organize" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(skipSchema, request.body);
    return skipItems(id, body.ids);
  });

  /** 按原范围、原触发来源重新预览：新的手动预览，不自动执行 */
  fastify.post("/api/organize/runs/:id/repreview", { preHandler: [fastify.authenticate], config: { agentScope: "run", agentToolset: "organize" } }, async (request, reply) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(repreviewSchema, request.body ?? {});
    const old = getRun(id);
    if (old) guardSupersede(request, old.taskId, { subPath: old.scopePath, paths: old.scopePaths }, body.fresh);
    return reply.code(201).send(await repreviewRun(id, { refreshTmdb: body.refreshTmdb }));
  });

  fastify.post("/api/organize/runs/:id/cancel", { preHandler: [fastify.authenticate], config: { agentScope: "run", agentToolset: "organize" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    // 作废一份待确认的清单（可能是人改了一半的）要改网盘档；停下进行中的不用
    if (getRun(id)?.status === "ready") requireAgentScope(request, "write");
    return cancelRun(id);
  });

  fastify.post("/api/organize/runs/:id/revert", { preHandler: [fastify.authenticate], config: { agentScope: "write", agentToolset: "organize" } }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    return revertRun(id);
  });

  fastify.delete("/api/organize/runs/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    deleteRun(id);
    return { success: true };
  });

  /** 设置页实时试算：拿两个固定样例套模板 */
  fastify.post("/api/organize/preview-name", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(previewNameSchema, request.body);
    const current = resolveOrganizeSettings(readAppSettings());
    const movieTpl = body.templates?.movie?.trim() || current.templates.movie || DEFAULT_TEMPLATES.movie;
    const tvTpl = body.templates?.tv?.trim() || current.templates.tv || DEFAULT_TEMPLATES.tv;
    const idTag = body.idTag ?? current.idTag;
    const colon = body.colon ?? current.colon;
    const episodeTitle = body.episodeTitle ?? current.episodeTitle;
    const errors = [
      ...validateTemplate(movieTpl).map((e) => `电影模板：${e}`),
      ...validateTemplate(tvTpl).map((e) => `剧集模板：${e}`),
      ...(body.rules ? parseRules(body.rules).errors.map((e) => `识别词${e}`) : []),
    ];
    const movie = renderTemplate(
      movieTpl,
      { title: "沙丘：第二部", originalTitle: "Dune: Part Two", enTitle: "Dune: Part Two", year: "2024", tmdbId: 693134, imdbId: "tt15239678", idTag: idTagFor(idTag, 693134), resolution: "2160p", source: "WEB-DL", videoCodec: "H.265", audio: "DDP", hdr: "DV", group: "FLUX", ext: "mkv", category: "" },
      { colon },
    ).path;
    const tv = renderTemplate(
      tvTpl,
      { title: "怒呛人生", originalTitle: "BEEF", enTitle: "BEEF", year: "2023", tmdbId: 153312, idTag: idTagFor(idTag, 153312), season: 1, season00: "01", episode: "1", episode00: "01", episodeTitle: episodeTitle ? "飞鸟不鸣" : "", resolution: "1080p", source: "WEB-DL", ext: "mkv", category: "" },
      { colon },
    ).path;
    const out: OrganizeTemplatePreview = { movie, tv, errors };
    return out;
  });

  fastify.get("/api/organize/matches", { preHandler: [fastify.authenticate] }, async (request) => {
    const q = parse(z.object({ account: z.string().optional() }), request.query, "query");
    return { matches: listMatches(q.account || undefined) };
  });

  fastify.delete("/api/organize/matches", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = parse(forgetSchema, request.body);
    return { success: forgetMatch(body.accountName, body.srcPath) };
  });
}
