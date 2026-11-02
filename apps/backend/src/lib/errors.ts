import axios from "axios";

/**
 * 换多少次都一样的失败：远端明确回答"没有这个对象"、凭据缺失、账号类型不支持之类。
 * 重试策略（取直链、下载）见到它就直接放弃，别再拿同一个请求白等几轮。
 */
export class PermanentError extends Error {
  /** cause：包着的网盘错误（比如 OpenList 取文件信息回的 401），分类器要看它的状态码 */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentError";
  }
}

/** 错误的文本：Error 取 message，其它转成字符串 */
export const messageOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : String(err));

/** 连不上的几种：DNS 查不到、被拒、被重置、网络不通。和超时一样是网络层的事，过一会儿多半就好 */
const CONNECT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"]);

/**
 * 网络层的失败换成给人看的话：axios 的原话是英文，「timeout of 30000ms exceeded」原样给用户看不懂。
 * 超时说几秒没回应，连不上说连不上；接口回了话的（有响应）、不是 axios 的错误回 null，调用方照旧用 messageOf。
 * 默认带「稍后再试」、原话放括号里留底（给要人自己重试的报错用）；brief 只要原因本身（系统自己会再试的地方，比如复制后的去向）
 */
/** 等到超时都没回话：不是连不上、不是回了错误码、不是被取消。axios 的超时码，或者只在文案里说了 timeout 的那种 */
export function isTimeoutError(err: unknown): boolean {
  if (!axios.isAxiosError(err) || err.response || axios.isCancel(err)) return false;
  const code = err.code ?? "";
  return code === "ECONNABORTED" || code === "ETIMEDOUT" || /timeout/i.test(err.message);
}

export function networkErrorText(err: unknown, opts: { brief?: boolean } = {}): string | null {
  if (!axios.isAxiosError(err) || err.response || axios.isCancel(err)) return null;
  const code = err.code ?? "";
  if (isTimeoutError(err)) {
    const ms = err.config?.timeout;
    const secs = typeof ms === "number" && ms > 0 ? ` ${Math.round(ms / 1000)} 秒` : "";
    return opts.brief ? `网盘接口${secs}没有回应` : `网盘接口${secs}没有回应，稍后再试（${err.message}）`;
  }
  if (CONNECT_CODES.has(code)) return opts.brief ? `连不上网盘接口（${code}）` : `连不上网盘接口（${code}），稍后再试`;
  return null;
}

/**
 * 是不是被 AbortSignal 中止的。取消任务后它会以三种样子落到调用方手里：
 * 排在限流器里的请求是 `signal.throwIfAborted()` 抛的 DOMException，timers/promises 的 sleep
 * 抛 Node 自己的 AbortError（都叫 AbortError），正在飞的请求则是 axios 翻译成的 CanceledError。
 * 这些都是调用方自己掐的：不值得重试，也不该按错误记日志。
 */
export function isAbortError(err: unknown): boolean {
  if (axios.isCancel(err)) return true;
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}
