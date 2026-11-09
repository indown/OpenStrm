/**
 * 最小的 gRPC 客户端：node:http2 明文（或 TLS）连接，发一个报文、收回所有报文。
 * unary 和 server-streaming 都能用——前者收到的就是一个报文。给 CloudDrive2 用，不引 @grpc/grpc-js。
 *
 * 线上格式：POST /<包.服务>/<方法>，content-type application/grpc、te trailers；
 * 每个报文前 5 字节帧头（1 字节压缩标志 0 + 4 字节大端长度）；结果在 trailer 的 grpc-status / grpc-message 里
 * （服务端直接拒绝时放在首部，没有正文）。
 */
import http2 from "node:http2";
import { DEFAULT_TIMEOUT_MS } from "./http.js";

export class GrpcError extends Error {
  constructor(
    message: string,
    /** gRPC 状态码；连不上 / 超时这种没有状态码 */
    public readonly code: number | undefined,
    /** true = 连不上 / 超时 / HTTP 层失败（值得重试）；false = 服务端明确答复了失败 */
    public readonly transport = false,
  ) {
    super(message);
    this.name = "GrpcError";
  }
}

export const GRPC_STATUS = {
  OK: 0,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

export interface GrpcCallOptions {
  /** 整个值，如 `Bearer xxx` */
  authorization?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 连接层的错误给人话：http2 的原话是「The pending stream has been canceled (caused by: connect ECONNREFUSED …)」这种 */
function connectErrorText(origin: string, err: Error): string {
  const text = `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ""}`;
  if (/ECONNREFUSED/.test(text)) return `连不上 ${origin}：连接被拒绝，地址或端口不对，或者服务没起来`;
  if (/ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH/.test(text)) return `连不上 ${origin}：网络不通（${text.match(/E[A-Z]+/)?.[0]}）`;
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return `连不上 ${origin}：域名解析不了`;
  return `连不上 ${origin}：${err.message}`;
}

function frame(body: Uint8Array): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out[0] = 0;
  out.writeUInt32BE(body.length, 1);
  out.set(body, 5);
  return out;
}

/**
 * 调一次 `service/method`，返回收到的报文（server-streaming 是多条，unary 是一条）。
 * grpc-status 非 0 抛 GrpcError(code)；连不上 / 超时 / 非 200 抛 transport 类 GrpcError；调用方取消抛 AbortError
 */
export function grpcCall(baseUrl: string, service: string, method: string, body: Uint8Array, opts: GrpcCallOptions = {}): Promise<Uint8Array[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const origin = new URL(baseUrl).origin;
  return new Promise((resolve, reject) => {
    const messages: Uint8Array[] = [];
    let buffer = Buffer.alloc(0);
    let status: number | undefined;
    let statusMessage = "";
    let settled = false;
    const session = http2.connect(origin);
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      session.close();
      if (err) reject(err);
      else resolve(messages);
    };
    const onAbort = (): void => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      const err = new Error("gRPC 调用已取消");
      err.name = "AbortError";
      finish(err);
    };
    const timer = setTimeout(() => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      finish(new GrpcError(`gRPC ${method} 超时（${Math.round(timeoutMs / 1000)} 秒没回应）`, undefined, true));
    }, timeoutMs);
    timer.unref?.();
    session.on("error", (err: Error) => finish(new GrpcError(connectErrorText(origin, err), undefined, true)));
    const req = session.request({
      ":method": "POST",
      ":path": `/${service}/${method}`,
      "content-type": "application/grpc",
      te: "trailers",
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
    });
    const readStatus = (headers: http2.IncomingHttpHeaders): void => {
      if (headers["grpc-status"] === undefined) return;
      status = Number(headers["grpc-status"]);
      const raw = headers["grpc-message"];
      try {
        statusMessage = decodeURIComponent(String(raw ?? ""));
      } catch {
        statusMessage = String(raw ?? "");
      }
    };
    req.on("response", (headers) => {
      const http = headers[":status"];
      if (http !== undefined && http !== 200) finish(new GrpcError(`gRPC ${method} 失败：HTTP ${http}`, undefined, true));
      readStatus(headers);
    });
    req.on("trailers", readStatus);
    req.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const len = buffer.readUInt32BE(1);
        if (buffer.length < 5 + len) break;
        messages.push(Uint8Array.from(buffer.subarray(5, 5 + len)));
        buffer = buffer.subarray(5 + len);
      }
    });
    req.on("error", (err: Error) => finish(new GrpcError(connectErrorText(origin, err), undefined, true)));
    req.on("end", () => {
      if (status === undefined) finish(new GrpcError(`gRPC ${method} 没有返回状态`, undefined, true));
      else if (status !== GRPC_STATUS.OK) finish(new GrpcError(`gRPC ${method} 失败：${statusMessage || `status ${status}`}`, status));
      else finish();
    });
    // 服务端 RST_STREAM(NO_ERROR) 或 GOAWAY 把流关掉时只有 close、没有 end / error：不接住会一直等到超时
    req.on("close", () => {
      if (settled) return;
      if (status === GRPC_STATUS.OK) finish();
      else if (status !== undefined) finish(new GrpcError(`gRPC ${method} 失败：${statusMessage || `status ${status}`}`, status));
      else finish(new GrpcError(`gRPC ${method} 的连接被对方关掉了，没有返回结果`, undefined, true));
    });
    session.on("close", () => finish(new GrpcError(`gRPC ${method} 的连接被对方关掉了，没有返回结果`, undefined, true)));
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    req.end(frame(body));
  });
}
