/**
 * 302 直链重定向——整个代理层存在的理由。
 *
 * 命中的请求不再由 Node 转发媒体字节，而是回一个 115 直链让客户端自己去取。
 * 任何一步出问题都回源 Emby：宁可走中转，也不能让播放直接失败。
 */
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { LRUCache } from "lru-cache";
import type { EmbyItemLookup } from "../../services/emby/api.js";
import { clientApiKey, getItemMediaSource, getSyncJobItemPath } from "../../services/emby/api.js";
import { readSettingsSafe } from "../../services/settings-safe.js";
import { configRevision } from "../../services/config-revision.js";
import { clearPathCache, resolveEmbyPath, warmPanPath, type ResolveOptions } from "../../services/resolve/direct-link.js";
import { clientContext, decideRoute, rulesNeedPath, type RouteContext } from "../../services/resolve/route-rules.js";
import { PRIORITY_BACKGROUND } from "../../services/throttle.js";
import { toEmby } from "./upstream.js";

/**
 * 直链缓存。
 *
 * 没有它的话，客户端每拖一次进度条都要重新走「查 Emby → 查 115 目录 → 换直链」，
 * 起播和 seek 都会明显卡顿。115 的直链和 UA 绑定，所以 UA 必须进 key。
 */
const linkCache = new LRUCache<string, string>({ max: 2000, ttl: 15 * 60 * 1000 });

/**
 * 条目查询结果也缓存一份：路由规则要看路径时，裁决在换链之前，
 * 不缓存的话 Infuse 每个分片的每一跳都要去问一次 Emby。
 */
const lookupCache = new LRUCache<string, EmbyItemLookup>({ max: 2000, ttl: 15 * 60 * 1000 });

/**
 * 最近被 Emby 认过的客户端令牌。
 *
 * 两份缓存都是按条目记的、不分令牌：谁拿着条目 id 来都能用。令牌的裁决本来由每次查条目顺带做
 * （带客户端的令牌问 Emby，不认就 401 回源），PlaybackInfo 之后预热把条目路径先放进缓存，这一步就被跳过了——
 * 任何能访问代理端口的人报个条目 id、随便编个令牌就能拿到 115 直链。所以令牌没被 Emby 认过之前不用任何缓存。
 * 认过的记 15 分钟，和缓存一样长
 */
const trustedTokens = new LRUCache<string, true>({ max: 2000, ttl: 15 * 60 * 1000 });

/** Emby 刚用这个令牌成功回答了请求（PlaybackInfo 透传成功）：之后 15 分钟它可以用缓存 */
export function trustToken(token: string): void {
  if (token) trustedTokens.set(token, true);
}

/** 换了 115 账号或改了挂载配置之后，旧直链就不该再用了 */
export function clearLinkCache(): void {
  linkCache.clear();
  lookupCache.clear();
  trustedTokens.clear();
  clearPathCache();
}

/**
 * 直链解析实现。抽成可替换的，离线测试才能在不碰 115 接口的情况下
 * 验证 302、回源和缓存这几条分支。
 */
let resolveLink = resolveEmbyPath;
export function setLinkResolver(fn: typeof resolveEmbyPath): void {
  resolveLink = fn;
}

/** 只预热找路径那一段的实现，同样可替换 */
let warmPath = warmPanPath;
export function setPathWarmer(fn: typeof warmPanPath): void {
  warmPath = fn;
}

/** PlaybackInfo 之后正在预解析的直链（key 和 linkCache 一样）：302 来得比解析快时等它，别再解析一遍 */
const inflight = new Map<string, Promise<void>>();

/** 仅供测试：等正在跑的预解析全部结束 */
export async function __test_prewarmSettled(): Promise<void> {
  await Promise.allSettled([...inflight.values()]);
}

/** 只有这些动作才 302；live / master / hls 之类交给 Emby 自己处理 */
const REDIRECTABLE = new Set(["stream", "original", "universal"]);

/** `/emby` 前缀是标准反代路径，裸路径是客户端直连时用的 */
const PREFIXES = ["", "/emby"];

/** 客户端对大小写并不统一，nginx 用的是 ~* 匹配，这里把两种都注册上 */
function caseVariants(segment: string): string[] {
  const lower = segment.toLowerCase();
  const capitalized = lower.charAt(0).toUpperCase() + lower.slice(1);
  return lower === capitalized ? [lower] : [lower, capitalized];
}

function queryValue(query: unknown, ...keys: string[]): string | undefined {
  const q = (query ?? {}) as Record<string, unknown>;
  for (const key of keys) {
    const value = q[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** `stream.mkv` / `stream/真实文件名.mkv` 都归一成 `stream` */
function actionOf(rest: string): string {
  return (rest.split("/")[0] ?? "").split(".")[0].toLowerCase();
}

/**
 * Location 头只能放 ASCII，非 ASCII 会让 setHeader 抛 ERR_INVALID_CHAR。
 *
 * 但**不能**用 encodeURI 兜底：它会把 `%` 转成 `%25`。115 返回的直链本来就是
 * 转义过的（中文文件名、签名里的 `+` 和 `=`），再过一遍 encodeURI 就成了
 * `%25E4%25B8%25AD`，CDN 直接 403。
 * 所以纯 ASCII 原样返回，只有混进非 ASCII 时才逐字符转义。
 */
// eslint-disable-next-line no-control-regex -- 正是要匹配 ASCII 之外的字符
const NON_ASCII = /[^\x00-\x7F]/, NON_ASCII_ALL = /[^\x00-\x7F]/g;

function safeLocation(url: string): string {
  if (!NON_ASCII.test(url)) return url;
  return url.replace(NON_ASCII_ALL, (c) => encodeURIComponent(c));
}

/**
 * 302 响应带 Server-Timing：排查起播慢时 curl -I 一眼能看到时间花在查 Emby、找路径还是取链上；
 * 缓存命中只有 total 和 cache;desc=hit。单位毫秒，整数
 */
function serverTiming(parts: Record<string, number | string | undefined>): string {
  return Object.entries(parts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => (typeof v === "number" ? `${k};dur=${v}` : `${k};desc=${v}`))
    .join(", ");
}

const ms = (from: number): number => Math.round(performance.now() - from);

/** linkCache / lookupCache 的 key；两处（302 和预解析）必须一个算法，不然预热的白热 */
function cacheKeys(kind: "item" | "sync", itemId: string, mediaSourceId: string | undefined, userAgent: string | undefined) {
  const idKey = `${configRevision()}:${kind}:${itemId}:${mediaSourceId ?? ""}`;
  // 115 的直链和 UA 绑定，所以 UA 必须进 key
  return { idKey, cacheKey: `${idKey}:${userAgent ?? ""}` };
}

/** 预解析的网盘请求排在普通请求后面：它是投机的，别的条目真正的 302 解析不该等它 */
const PREWARM_OPTS: ResolveOptions = { priority: PRIORITY_BACKGROUND };

/**
 * PlaybackInfo 之后顺手把直链解析掉：客户端紧接着（几百毫秒内）就会按 DirectStreamUrl 来要流，
 * 等它来时缓存已经热了，冷解析那 2～4 秒不再算在首播头上。
 * 条目路径直接用 PlaybackInfo 响应里的，302 时不用再问一次 Emby；
 * 同一个 key 并发只跑一次；失败只记 debug——真正的 302 会自己再试一遍。
 * 返回这一次的 Promise（不会 reject）：多版本条目的下一个版本挂在它后面挨个来。
 */
export function prewarmLink(opts: {
  itemId: string;
  mediaSourceId?: string;
  item: EmbyItemLookup;
  userAgent?: string;
  log: FastifyBaseLogger;
  /** 等它结束再开始：同一条目的几个版本挨个解析，目录 id / 目录列表的缓存能接着用，客户端多半要的第一个版本也不用和别的抢 */
  after?: Promise<unknown>;
}): Promise<void> {
  const { idKey, cacheKey } = cacheKeys("item", opts.itemId, opts.mediaSourceId, opts.userAgent);
  lookupCache.set(idKey, opts.item);
  const after = (opts.after ?? Promise.resolve()).then(() => {}, () => {});
  // Infuse 们第二跳换 UA 取流：按这个 UA 换的链是白换的，只做找路径那一段（pickcode 不分 UA）
  if (needsSecondHop(opts.userAgent)) {
    return after.then(() => warmPath(opts.item.path, PREWARM_OPTS)).catch((err) => opts.log.debug({ err, itemId: opts.itemId }, "预热路径失败"));
  }
  if (linkCache.has(cacheKey)) return after;
  const running = inflight.get(cacheKey);
  if (running) return running;
  const job = (async () => {
    await after;
    const resolved = await resolveLink(opts.item.path, opts.userAgent, PREWARM_OPTS);
    if (!resolved.ok) {
      opts.log.debug({ itemId: opts.itemId, path: opts.item.path, reason: resolved.reason }, "预解析没换到直链，交给 302 自己再试");
      return;
    }
    linkCache.set(cacheKey, safeLocation(resolved.url));
    opts.log.info(
      { itemId: opts.itemId, account: resolved.accountName, ua: opts.userAgent, pathMs: resolved.timings.pathMs, pathVia: resolved.timings.pathVia, linkMs: resolved.timings.linkMs },
      "PlaybackInfo 后已预解析直链",
    );
  })()
    .catch((err) => opts.log.debug({ err, itemId: opts.itemId }, "预解析失败，交给 302 自己再试"))
    .finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, job);
  return job;
}

/**
 * 需要"两跳"的客户端。
 *
 * 115 直链和换链时用的 User-Agent 严格绑定（实测：用 A 换的链接拿 B 去取，CDN 直接 403）。
 * 我们按到达代理的那个 UA 换链，前提是拿着直链去 CDN 的是同一个 UA。
 * Infuse 不是：起播前用 API 客户端的身份（另一个 UA）请求流地址、把 302 的结果交给播放内核
 * （UA 是 Infuse-Direct/x）去取，拿着按前者绑定的直链反复 403、反复重试
 * （日志里就是一串"缓存命中"），把那个文件打到 115 临时限流。
 *
 * 处理办法是先 302 回代理自己同一路径（带 _hop=2）：探测者拿到的跳转结果是代理自己，
 * 真正去取流的那个 UA 跟随这一跳时才换链，链接自然和它绑定。真机验证（Infuse 8.5.2）
 * 两跳的 UA 都是 Infuse-Direct，拖动正常。v1 里给 Infuse 转到 Alist /d/ 再跳一次的
 * clientSelfAlistRule 是同一个原理。
 */
const SECOND_HOP_CLIENTS = [/infuse/i];
const HOP_PARAM = "_hop";

function needsSecondHop(userAgent: string | undefined): boolean {
  return !!userAgent && SECOND_HOP_CLIENTS.some((re) => re.test(userAgent));
}

function isSecondHop(query: unknown): boolean {
  return queryValue(query, HOP_PARAM) === "2";
}

/**
 * 第二跳的地址：同一路径，标上 _hop=2。令牌只在请求头里的话补进 query——
 * 换 UA 的客户端多半连自定义头一起丢，第二跳没有凭据就会被闸门挡成回源。
 * 相对地址即可：客户端按它请求代理用的 host 解析，反代后面也不用知道公网地址。
 */
function secondHopLocation(request: FastifyRequest, apiKey: string): string {
  const url = new URL(request.url, "http://openstrm.local");
  url.searchParams.set(HOP_PARAM, "2");
  if (!queryValue(request.query, "X-Emby-Token", "api_key", "ApiKey")) url.searchParams.set("api_key", apiKey);
  return `${url.pathname}${url.search}`;
}

/** 查路径的方式：普通条目走 /Items，同步任务项走 /Sync/JobItems */
type PathLookup = (
  id: string,
  opts: { mediaSourceId?: string; apiKey?: string },
) => Promise<EmbyItemLookup | null>;

async function redirectWithLookup(
  request: FastifyRequest,
  reply: FastifyReply,
  itemId: string,
  lookup: PathLookup,
  /** 缓存 key 里区分 id 的名字空间：同步任务项的 id 和条目 id 是两套数字，不分开会串 */
  kind: "item" | "sync",
) {
  const mediaSourceId = queryValue(request.query, "MediaSourceId", "mediaSourceId");
  const userAgent = request.headers["user-agent"];
  const settings = readSettingsSafe();
  const started = performance.now();

  /**
   * 没有客户端凭据就不往下走，而且必须在查缓存之前拦——否则匿名请求能白拿
   * 别人解析好的缓存直链。
   *
   * 不带凭据时不能回落到配置里的管理员 key：那等于任何能访问代理端口的人
   * 报一个条目 id 就拿到 115 直链，完全绕过 Emby 的登录。透传交给 Emby 自己
   * 裁决——upstream 原样转发请求头，靠头认证的客户端照样能播，只是不走 302。
   */
  const apiKey = clientApiKey(request.query as Record<string, unknown>, request.headers);
  if (!apiKey && !settings.emby?.allowAnonymousRedirect) {
    // info 而不是 debug：正常部署里匿名请求不该出现，而这条不打出来的话，
    // 「媒体库能刷出来、播放却不走直连」在默认日志级别下完全无从查起
    request.log.info({ itemId }, "请求未携带 Emby 凭据，不解析直链，透传回源");
    return toEmby(request, reply);
  }

  /**
   * key 里带配置版本：改了账号、挂载点或规则之后旧条目自然失效。
   * 代理是独立进程，收不到 API 进程的失效通知，只能这样跨进程对齐。
   */
  const { idKey, cacheKey } = cacheKeys(kind, itemId, mediaSourceId, userAgent);

  /**
   * 令牌先过 Emby 的眼：没被认过的令牌先带着它查一次条目，Emby 不认就 401 回源，认了才轮到下面的缓存。
   * 不带令牌而配置允许匿名 302 的，是管理员放行的，照旧
   */
  let item: EmbyItemLookup | null | undefined;
  let timing: Record<string, number | string> = {};
  if (apiKey && !trustedTokens.has(apiKey)) {
    const lookupStart = performance.now();
    try {
      item = await lookup(itemId, { mediaSourceId, apiKey });
    } catch (err) {
      request.log.warn({ err, itemId }, "带着客户端令牌查询条目失败（Emby 不认这个令牌，或查询出错），回源");
      return toEmby(request, reply);
    }
    trustedTokens.set(apiKey, true);
    if (item) lookupCache.set(idKey, item);
    timing.lookup = ms(lookupStart);
  }

  /**
   * 路由规则在换链之前裁决：命中「交给 Emby」的请求连 Infuse 的第二跳都不该走。
   * 只看客户端 / 来源的规则现在就能定；看路径的要先查条目（结果缓存，别让 Infuse 每个分片都问一次 Emby）。
   */
  const rules = settings.emby?.routeRules ?? [];
  if (rules.length > 0) {
    const ctx: RouteContext = {
      ...clientContext(request.query as Record<string, unknown>, request.headers),
      userAgent,
      ip: request.ip,
    };
    if (rulesNeedPath(rules)) {
      if (item === undefined) {
        const lookupStart = performance.now();
        try {
          item = lookupCache.get(idKey);
          if (item) timing.lookup = "cache";
          else {
            item = await lookup(itemId, { mediaSourceId, apiKey });
            if (item) lookupCache.set(idKey, item);
            timing.lookup = ms(lookupStart);
          }
        } catch (err) {
          request.log.error({ err, itemId }, "查询条目失败，回源");
          return toEmby(request, reply);
        }
      }
      ctx.path = item?.path;
    }
    if (decideRoute(rules, ctx) === "relay") {
      // debug 而不是 info：relay 的客户端每个分片都会来一次，排查时开 debug 看
      request.log.debug({ itemId, ua: userAgent }, "路由规则命中，交给 Emby 处理");
      return toEmby(request, reply);
    }
  }

  // 不记日志：Infuse 播放时每个分片都重新请求一次流地址，每次都是两跳，
  // 记下来就是每秒两行。换链那一次（info，带 ua）和缓存命中（debug）足够定位问题
  if (needsSecondHop(userAgent) && !isSecondHop(request.query)) {
    return reply.redirect(secondHopLocation(request, apiKey), 302);
  }

  const cached = linkCache.get(cacheKey);
  if (cached) {
    // 每次拖进度条都命中一次，info 太吵；首次解析那条仍是 info
    request.log.debug({ itemId, ua: userAgent, totalMs: ms(started) }, "302 缓存命中");
    reply.header("server-timing", serverTiming({ cache: "hit", total: ms(started) }));
    return reply.redirect(cached, 302);
  }

  // PlaybackInfo 之后的预解析可能还在跑（客户端紧接着就来要流）：等它，别再解析一遍
  const warming = inflight.get(cacheKey);
  if (warming) {
    await warming;
    const warmed = linkCache.get(cacheKey);
    if (warmed) {
      request.log.debug({ itemId, ua: userAgent, totalMs: ms(started) }, "302 等到了预解析的直链");
      reply.header("server-timing", serverTiming({ cache: "prewarm", total: ms(started) }));
      return reply.redirect(warmed, 302);
    }
  }

  // 解析和响应分开：redirect 一旦写了 location 头再抛错，
  // catch 里的回源会带着这个坏头去发流，兜底也跟着崩。
  let target: string;
  try {
    // 认令牌 / 裁决路由时已经查过的就不再查；PlaybackInfo 之后预热进缓存的也不用再问 Emby
    if (item === undefined) {
      const lookupStart = performance.now();
      item = lookupCache.get(idKey);
      if (item) timing.lookup = "cache";
      else {
        item = await lookup(itemId, { mediaSourceId, apiKey });
        if (item) lookupCache.set(idKey, item);
        timing.lookup = ms(lookupStart);
      }
    }
    if (!item?.path) {
      request.log.info({ itemId }, "Emby 未返回路径，回源");
      return toEmby(request, reply);
    }

    // 直播流没有固定直链，也不该被 302
    if (item.mediaSource?.IsInfiniteStream) {
      return toEmby(request, reply);
    }

    const resolved = await resolveLink(item.path, userAgent);
    if (!resolved.ok) {
      // not-mounted 是正常情况：本地文件本来就该回源，不值得记 warn
      const detail = { itemId, path: item.path, reason: resolved.reason };
      if (resolved.reason === "not-mounted") {
        request.log.debug(detail, "路径不在挂载点下，回源");
      } else {
        request.log.warn(detail, "未取到直链，回源");
      }
      return toEmby(request, reply);
    }

    target = safeLocation(resolved.url);
    linkCache.set(cacheKey, target);
    timing = { ...timing, path: resolved.timings.pathMs, link: resolved.timings.linkMs, total: ms(started) };
    // 带上 UA：直链和它绑定，排查"能起播不能拖动"之类的问题时要看两跳的 UA 是否一致；
    // 分段耗时（查 Emby / 找路径 / 取链 / 总计，毫秒）：起播慢时先看这一行
    request.log.info(
      { itemId, account: resolved.accountName, ua: userAgent, lookupMs: typeof timing.lookup === "number" ? timing.lookup : 0, lookupCached: timing.lookup === "cache", pathMs: timing.path, pathVia: resolved.timings.pathVia, linkMs: timing.link, totalMs: timing.total },
      "302 到 115 直链",
    );
  } catch (err) {
    request.log.error({ err, itemId }, "302 解析失败，回源");
    return toEmby(request, reply);
  }

  reply.header("server-timing", serverTiming(timing));
  return reply.redirect(target, 302);
}

async function handleRedirect(request: FastifyRequest, reply: FastifyReply) {
  const params = request.params as Record<string, string>;
  const itemId = params.id;
  const rest = params["*"] ?? "";

  // HEAD 是客户端在探测，让 Emby 自己答，别为了一次探测去换直链
  if (request.method === "HEAD") return toEmby(request, reply);
  if (!REDIRECTABLE.has(actionOf(rest))) return toEmby(request, reply);
  if (!itemId) return toEmby(request, reply);

  return redirectWithLookup(request, reply, itemId, (id, opts) => getItemMediaSource(id, opts), "item");
}

/**
 * 客户端"下载到设备"（SyncService）走的路径。
 * 不 302 的话，整个离线下载的字节都从 Node 过。
 */
async function handleSyncDownload(request: FastifyRequest, reply: FastifyReply) {
  const params = request.params as Record<string, string>;
  const jobItemId = params.id;
  if (request.method === "HEAD") return toEmby(request, reply);
  if (!jobItemId) return toEmby(request, reply);

  return redirectWithLookup(request, reply, jobItemId, (id, opts) => getSyncJobItemPath(id, { apiKey: opts.apiKey }), "sync");
}

export default async function redirectRoutes(fastify: FastifyInstance) {
  const routes: string[] = [];

  for (const prefix of PREFIXES) {
    // Videos/Audio 下面的动作很多（Subtitles、live、master、hls…），
    // 用通配接住再在 handler 里挑，比穷举路径稳妥
    for (const resource of ["videos", "audio"]) {
      for (const variant of caseVariants(resource)) {
        routes.push(`${prefix}/${variant}/:id/*`);
      }
    }
    // Items 下面还有 PlaybackInfo 要单独拦，这里不能用通配
    for (const variant of caseVariants("items")) {
      for (const action of caseVariants("download")) {
        routes.push(`${prefix}/${variant}/:id/${action}`);
      }
    }
  }

  // 同步下载单独一条：id 是同步任务项 id，查法和普通条目不一样
  for (const prefix of PREFIXES) {
    for (const sync of caseVariants("sync")) {
      for (const file of caseVariants("file")) {
        fastify.route({
          method: ["GET", "HEAD"],
          url: `${prefix}/${sync}/JobItems/:id/${file}`,
          handler: handleSyncDownload,
        });
      }
    }
  }

  for (const url of routes) {
    fastify.route({
      method: ["GET", "HEAD"],
      url,
      handler: (request, reply) => {
        // Items/:id/Download 没有通配段，补一个让 handler 的判断统一
        const params = request.params as Record<string, string>;
        if (params["*"] === undefined) params["*"] = "stream";
        return handleRedirect(request, reply);
      },
    });
  }
}
