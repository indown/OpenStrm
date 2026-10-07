/**
 * 回源 Emby 的共用逻辑。
 *
 * 拦截路由和 catch-all 都从这里取转发配置，保证两条路径的请求头一致——
 * 否则会出现"直连能播、被拦截的路径播不了"这种极难查的问题。
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { embyUpstream } from "../../services/emby/api.js";

type Headers = Record<string, string | string[] | undefined>;

function firstForwarded(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  return raw.split(",")[0]?.trim() || undefined;
}

/**
 * 逐跳头。undici 见到这些会直接抛异常（"invalid keep-alive header" 等），
 * 不剥的话拦截路由和 catch-all 都会 500。
 * RFC 7230 6.1 本来就要求代理不转发这些。
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "http2-settings",
]);

/** 去掉逐跳头，以及 Connection 里点名的那些 */
export function stripHopByHop(headers: Headers): Headers {
  const connection = headers.connection;
  const named = (Array.isArray(connection) ? connection.join(",") : (connection ?? ""))
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.includes(lower)) delete headers[key];
  }
  return headers;
}

/**
 * 补齐转发头。
 *
 * reply-from 不发 X-Forwarded-For，而且会把 Host 强制改成上游的。
 * 不补的话 Emby 会把所有客户端都记成容器 IP，外部地址也会拼错。
 */
export function applyForwardedHeaders(request: FastifyRequest, headers: Headers): Headers {
  const incoming = request.headers;
  const priorChain = incoming["x-forwarded-for"];
  const prior = Array.isArray(priorChain) ? priorChain.join(", ") : priorChain;

  // 转发链上追加的是真实对端。设了 TRUST_PROXY 时 request.ip 已经是从链上取出来的客户端地址，再追加一遍就重了
  const peer = request.socket?.remoteAddress || request.ip;
  headers["x-forwarded-for"] = prior ? `${prior}, ${peer}` : peer;
  /**
   * X-Real-IP 给 Emby 认人用：没设 TRUST_PROXY 时就是真实对端，设了才按信任的跳数从转发链上取。
   * 不能无条件采信客户端自报的转发链：任何人发一个 X-Forwarded-For 就能让 Emby 的记录、
   * 封禁、地域判断全部认错人。
   */
  headers["x-real-ip"] = request.ip;
  headers["x-forwarded-proto"] =
    firstForwarded(incoming["x-forwarded-proto"]) ?? request.protocol;

  // reply-from 已经把 host 改成上游的了，改回客户端原本请求的 host
  if (incoming.host) headers.host = incoming.host;

  return stripHopByHop(headers);
}

/**
 * 每次现读上游地址，设置里改了 Emby 地址不用重启。
 * getUpstream 是 per-reply 选项，reply-from 的 URL 缓存以 upstream 为 key 的一部分，不会读到旧值。
 */
export function replyFromOptions(request: FastifyRequest) {
  return {
    getUpstream: () => embyUpstream(),
    rewriteRequestHeaders: (_req: unknown, headers: Headers) =>
      applyForwardedHeaders(request, headers),
  };
}

/** 原样回源。拦截逻辑任何一步失败都走这里，行为等同于没有拦截。 */
export function toEmby(request: FastifyRequest, reply: FastifyReply) {
  return reply.from(undefined, replyFromOptions(request));
}

const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * 需要读改响应体的拦截路由用它回源。
 *
 * 超时必须一直盖到调用方读完 body：fetch 一收到响应头就 resolve，
 * 这时 body 还是个没读的流，提前 clearTimeout 的话上游读一半卡住就永远挂着。
 * 所以把 done() 交给调用方，在读完之后调。
 */
export async function fetchUpstream(
  request: FastifyRequest,
): Promise<{ res: Response; done: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const done = () => clearTimeout(timer);

  try {
    const headers = applyForwardedHeaders(request, {
      ...(request.headers as Headers),
    });
    delete headers["content-length"];
    delete headers["accept-encoding"]; // 让上游别压缩，省一次解压

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const res = await fetch(`${embyUpstream()}${request.url}`, {
      method: request.method,
      headers: headers as Record<string, string>,
      // body 原样转发。JSON.stringify(request.body) 会把 text/plain 的 "hello"
      // 变成带引号的 7 字节，content-type 却还标着 text/plain。
      body: hasBody ? ((request.body as BodyInit) ?? undefined) : undefined,
      signal: controller.signal,
      // @ts-expect-error undici 需要它才能发流式 body
      duplex: "half",
    });
    return { res, done };
  } catch (err) {
    done();
    throw err;
  }
}

/** 上游响应里除了逐跳头之外都要带回去 */
const SKIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "trailer",
  "upgrade",
]);

/**
 * 把上游响应转发给客户端，保留响应头。
 *
 * 只回 content-type 的话会丢掉 CORS、缓存校验、鉴权提示这些——
 * 浏览器跨源时直接拦掉响应，401 也不会触发客户端重登。
 */
export function relayResponse(
  reply: FastifyReply,
  upstream: Response,
  payload: string | ArrayBuffer,
  overrides: Record<string, string> = {},
) {
  upstream.headers.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) reply.header(key, value);
  });
  for (const [key, value] of Object.entries(overrides)) reply.header(key, value);
  return reply.code(upstream.status).send(
    typeof payload === "string" ? payload : Buffer.from(payload),
  );
}
