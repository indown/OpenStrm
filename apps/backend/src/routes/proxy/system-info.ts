/**
 * System/Info 端口改写 + web 播放器补丁。
 *
 * 两件事不做的话，302 在实际使用中会翻车：
 *
 * 1. System/Info 里带着 Emby 自己的端口（8096）。客户端拿到之后会直接连过去，
 *    绕开代理，302 自然就不生效了。要把端口换成代理的端口。
 *
 * 2. web 端播放器对 IsRemote 的媒体源会加 crossorigin="anonymous"，
 *    而 115 直链不带 CORS 头，浏览器直接拒绝播放。把那段判断改掉。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { embyUpstream } from "../../services/emby/api.js";
import { fetchUpstream, relayResponse, toEmby } from "./upstream.js";

/**
 * 只替换 URL 里紧跟主机的那个端口。
 *
 * 不能用 `String.replace(String(port), ...)`：那是纯子串匹配，
 * `http://emby8096.duckdns.org:8096` 会被改成 `emby8091.duckdns.org:8096`——
 * 主机名被改坏、端口反而没换。
 */
export function swapUrlPort(value: unknown, fromPort: number, toPort: number): unknown {
  if (typeof value !== "string" || !value) return value;
  /**
   * 锚定 `scheme://[user@]host` 之后紧跟的那个端口。
   * 不用 new URL()：它会把 http 的默认端口 80 规范化掉，
   * Emby 正好跑在 80 端口时就换不成了。
   */
  return value.replace(
    /^([a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(?:\[[^\]]*\]|[^/?#:]*)):(\d+)(?=$|[/?#])/i,
    (match, prefix: string, port: string) =>
      Number(port) === fromPort ? `${prefix}:${toPort}` : match,
  );
}

/** 把 body 里所有地址字段的上游端口换成代理端口 */
export function swapPorts(
  body: Record<string, unknown>,
  fromPort: number,
  toPort: number,
): Record<string, unknown> {
  if (!fromPort || !toPort || fromPort === toPort) return body;

  for (const key of ["WebSocketPortNumber", "HttpServerPortNumber", "HttpsPortNumber"]) {
    if (typeof body[key] === "number" && body[key] === fromPort) body[key] = toPort;
  }
  for (const key of ["LocalAddress", "WanAddress", "RemoteAddress"]) {
    body[key] = swapUrlPort(body[key], fromPort, toPort);
  }
  for (const key of ["LocalAddresses", "RemoteAddresses"]) {
    const list = body[key];
    if (Array.isArray(list)) body[key] = list.map((v) => swapUrlPort(v, fromPort, toPort));
  }
  return body;
}

function proxyPort(request: FastifyRequest): number {
  const address = request.server.server.address();
  if (address && typeof address === "object") return address.port;
  return Number(process.env.PROXY_PORT) || 8091;
}

/**
 * Emby 自己的端口。System/Info 里有端口字段就用它；Public 版没有这些字段，
 * 按配置的上游地址推——地址里不写端口的按协议默认。
 */
function upstreamPort(): number {
  try {
    const url = new URL(embyUpstream());
    return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  } catch {
    return 0;
  }
}

async function handleSystemInfo(request: FastifyRequest, reply: FastifyReply) {
  let upstream: Awaited<ReturnType<typeof fetchUpstream>> | undefined;
  try {
    upstream = await fetchUpstream(request);
    if (!upstream.res.ok) return toEmby(request, reply);

    const raw = await upstream.res.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return relayResponse(reply, upstream.res, raw);
    }

    const originPort = Number(body.WebSocketPortNumber ?? body.HttpServerPortNumber ?? 0) || upstreamPort();
    swapPorts(body, originPort, proxyPort(request));

    return relayResponse(reply, upstream.res, JSON.stringify(body), {
      "content-type": "application/json;charset=utf-8",
    });
  } catch (err) {
    request.log.error({ err }, "System/Info 改写失败，回源");
    return toEmby(request, reply);
  } finally {
    upstream?.done();
  }
}

/**
 * web 播放器里这段判断会给远端源加 crossorigin，把它整体替成 null。
 * Emby 每个版本的压缩产物变量名可能不同，所以用宽松一点的正则。
 */
const CROSSORIGIN_PATTERN =
  /(\w+)\.IsRemote\s*&&\s*"DirectPlay"\s*===\s*(\w+)\s*\?\s*null\s*:\s*"anonymous"/g;

async function handleBaseHtmlPlayer(request: FastifyRequest, reply: FastifyReply) {
  let upstream: Awaited<ReturnType<typeof fetchUpstream>> | undefined;
  try {
    upstream = await fetchUpstream(request);
    /**
     * 304 也要按"没拿到内容"处理并回源——否则浏览器会用它自己缓存的、
     * 没打过补丁的播放器。回源让上游自己去回答条件请求。
     */
    if (!upstream.res.ok) return toEmby(request, reply);

    const source = await upstream.res.text();
    const patched = source.replace(CROSSORIGIN_PATTERN, "null");
    if (patched === source) {
      request.log.warn("basehtmlplayer 未匹配到 crossorigin 判断，可能 Emby 版本变了");
    }

    return relayResponse(reply, upstream.res, patched);
  } catch (err) {
    request.log.error({ err }, "basehtmlplayer 改写失败，回源");
    return toEmby(request, reply);
  } finally {
    upstream?.done();
  }
}

export default async function systemInfoRoutes(fastify: FastifyInstance) {
  for (const prefix of ["", "/emby"]) {
    for (const variant of ["System", "system"]) {
      for (const info of ["Info", "info"]) {
        fastify.get(`${prefix}/${variant}/${info}`, handleSystemInfo);
        // 登录前客户端先问的是 Public 版：里面的 LocalAddress / WanAddress 同样带着 Emby 的端口，
        // 不换掉的话客户端连上之后就直接去找 Emby 了，代理形同虚设；顺带也不再把 Emby 的真实地址亮给没登录的人
        for (const pub of ["Public", "public"]) {
          fastify.get(`${prefix}/${variant}/${info}/${pub}`, handleSystemInfo);
        }
      }
    }
    fastify.get(
      `${prefix}/web/modules/htmlvideoplayer/basehtmlplayer.js`,
      handleBaseHtmlPlayer,
    );
  }
}
