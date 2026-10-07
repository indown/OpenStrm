/**
 * PlaybackInfo 改写。
 *
 * Emby 认为 strm 指向的是"远端"资源，默认把 SupportsDirectPlay/DirectStream 判成 false
 * 并给出 TranscodingUrl，客户端于是去要转码流——转码流不走 302，全部字节又回到 Node 身上。
 * 所以命中挂载点的媒体源要标成可直连、关掉转码，并把 DirectStreamUrl 指回本代理。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EmbyMediaSource } from "../../services/emby/api.js";
import { clientApiKey } from "../../services/emby/api.js";
import { currentMountPaths, safeDecode, stripMountPath } from "../../services/resolve/direct-link.js";
import { clientContext, decideRoute } from "../../services/resolve/route-rules.js";
import { readSettingsSafe } from "../../services/settings-safe.js";
import { fetchUpstream, relayResponse, toEmby } from "./upstream.js";

/**
 * 这个媒体源是不是我们生成的 strm——落在某个挂载前缀下面。
 * 前缀必须和 302 那条路（resolveEmbyPath）用同一份：手填的 mediaMountPath ∪ 开了 302 的任务，
 * 只看前者的话，按 v2 的方式只在任务上开 302 的用户，PlaybackInfo 不会被改写，客户端走转码。
 */
function isOurs(source: EmbyMediaSource, mountPaths: string[]): boolean {
  if (!source.Path) return false;
  return stripMountPath(safeDecode(source.Path), mountPaths) !== null;
}

/** strm 里写的是 OpenList 那种 http(s) 地址，而不是本地挂载路径 */
function isHttpSource(source: EmbyMediaSource): boolean {
  return /^https?:\/\//i.test(source.Path ?? "");
}

/**
 * 把 DirectStreamUrl 指向本代理的 stream 路径。
 *
 * 路径里必须用**条目 id**，不能用 MediaSource.Id——Emby 4.9 的 MediaSource.Id 长
 * `mediasource_11` 这样，而 Emby 自己给的 DirectStreamUrl 是 `/videos/11/stream`。
 *
 * 也**不能**带 `/emby` 前缀。Emby 自己就不带，客户端会拿它去拼自己的 base；
 * base 本身带路径时（`https://host/emby`）加了前缀就拼成 `/emby/emby/Videos/...`，
 * 两层前缀匹配不上任何拦截路由，请求落进通配透传——表现是能播但全程中转。
 * 不带前缀则两种部署都命中：PREFIXES 里那个空串就是为根路径部署准备的。
 * 查询串沿用上游的，但要去掉 TranscodeReasons 并补上 Static=true，
 * 否则客户端会以为这是个转码流。
 */
function rewriteDirectStreamUrl(
  source: EmbyMediaSource,
  itemId: string,
  requestQuery: Record<string, unknown>,
  requestHeaders: Record<string, string | string[] | undefined>,
): void {
  const container = source.Container || "mp4";
  const original = typeof source.DirectStreamUrl === "string" ? source.DirectStreamUrl : "";
  const queryIndex = original.indexOf("?");

  const params = new URLSearchParams(queryIndex >= 0 ? original.slice(queryIndex + 1) : "");
  params.delete("TranscodeReasons");

  // 上游没给 DirectStreamUrl 时（部分条目就是没有），从请求本身补齐必要参数。
  // 令牌要连请求头一起找：客户端多半放在头里，只翻 query 会补不上，
  // 客户端拿着没有 api_key 的地址回来就会被 302 那边的凭据闸门挡下。
  if (!params.has("api_key")) {
    const key = clientApiKey(requestQuery, requestHeaders);
    if (key) params.set("api_key", key);
  }
  if (!params.has("MediaSourceId") && source.Id) params.set("MediaSourceId", source.Id);
  params.set("Static", "true");

  source.DirectStreamUrl = `/Videos/${itemId}/stream.${container}?${params.toString()}`;
}

export function rewritePlaybackInfo(
  body: Record<string, unknown>,
  itemId: string,
  mountPaths: string[],
  requestQuery: Record<string, unknown> = {},
  requestHeaders: Record<string, string | string[] | undefined> = {},
  /** 路由规则说这个路径要交给 Emby：那一个媒体源原样不动，客户端按 Emby 的意思中转或转码 */
  relay: (path: string) => boolean = () => false,
): boolean {
  const sources = body.MediaSources;
  if (!Array.isArray(sources)) return false;

  let touched = false;
  for (const source of sources as EmbyMediaSource[]) {
    if (!isOurs(source, mountPaths)) continue;
    if (source.IsInfiniteStream) continue; // 直播流不做直连改写
    if (relay(source.Path ?? "")) continue;

    /**
     * strm 里是 http(s) 地址时不能标"可直接播放"：那意味着客户端自己去取 strm 里的 URL，
     * 根本不经过代理（Emby Web 还会撞 CORS）。只留 DirectStream，播放一律走本代理的 stream 路径——
     * 换到直链就 302，换不到再回给 Emby 按 URL 拉流。本地挂载路径的源照旧两个都开。
     */
    source.SupportsDirectPlay = !isHttpSource(source);
    source.SupportsDirectStream = true;
    /**
     * 转码必须关掉。留着的话限码率的客户端会判定超标、转而去要 TranscodingUrl，
     * 那条路不走 302，字节全程过 Node。
     */
    source.SupportsTranscoding = false;
    delete source.TranscodingUrl;

    rewriteDirectStreamUrl(source, itemId, requestQuery, requestHeaders);
    touched = true;
  }
  return touched;
}

async function handlePlaybackInfo(request: FastifyRequest, reply: FastifyReply) {
  const params = request.params as Record<string, string>;
  const itemId = params.id;

  let upstream: Awaited<ReturnType<typeof fetchUpstream>> | undefined;
  try {
    upstream = await fetchUpstream(request);

    if (!upstream.res.ok) {
      request.log.warn({ itemId, status: upstream.res.status }, "PlaybackInfo 回源异常，透传");
      return relayResponse(reply, upstream.res, await upstream.res.arrayBuffer());
    }

    const raw = await upstream.res.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // 不是 JSON 就原样透传，别把响应吞掉
      return relayResponse(reply, upstream.res, raw);
    }

    // 每个请求算一次，别在每个媒体源上都去读一遍库
    const query = (request.query ?? {}) as Record<string, unknown>;
    const rules = readSettingsSafe().emby?.routeRules ?? [];
    const ctx = { ...clientContext(query, request.headers), userAgent: request.headers["user-agent"], ip: request.ip };
    const touched = rewritePlaybackInfo(
      body,
      itemId,
      currentMountPaths(),
      query,
      request.headers,
      (path) => rules.length > 0 && decideRoute(rules, { ...ctx, path }) === "relay",
    );
    if (touched) request.log.info({ itemId }, "PlaybackInfo 已改写为直连");

    return relayResponse(reply, upstream.res, JSON.stringify(body), {
      "content-type": "application/json;charset=utf-8",
    });
  } catch (err) {
    request.log.error({ err, itemId }, "PlaybackInfo 改写失败，回源");
    return toEmby(request, reply);
  } finally {
    upstream?.done();
  }
}

export default async function playbackInfoRoutes(fastify: FastifyInstance) {
  /**
   * 这些路由不在 @fastify/http-proxy 的封装作用域里，拿不到它注册的透传解析器，
   * Fastify 默认的 JSON 解析器会先把空 body 判成 400、把表单 content-type 判成 415，
   * handler 根本轮不到——"失败一律回源"的保证也就失效了。
   * 这里自己装一个原样收下的解析器。
   */
  const keepRaw = (_req: unknown, body: Buffer, done: (e: Error | null, b: Buffer) => void) =>
    done(null, body);
  fastify.addContentTypeParser("*", { parseAs: "buffer" }, keepRaw as never);
  fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, keepRaw as never);

  for (const prefix of ["", "/emby"]) {
    for (const items of ["Items", "items"]) {
      for (const action of ["PlaybackInfo", "playbackinfo"]) {
        fastify.route({
          method: ["GET", "POST"],
          url: `${prefix}/${items}/:id/${action}`,
          handler: handlePlaybackInfo,
        });
      }
    }
  }
}
