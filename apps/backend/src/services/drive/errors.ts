/**
 * 网盘那边的错误 → HTTP 错误。路由里统一用它，别再各自 instanceof 一遍各家的错误类。
 * 上游状态码放 extra（见 lib/http-error.ts 关于不回 502 的说明）。
 */
import axios from "axios";
import { isAbortError, messageOf, networkErrorText, PermanentError } from "../../lib/errors.js";
import { GRPC_STATUS } from "../../lib/grpc.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { Cd2Error, isCd2Missing } from "../cd2/client.js";
import { Cloud115ApiError, Cloud115Error, ShareBusyError } from "../cloud-115/client.js";
import { ShareApiError } from "../cloud-115/share.js";
import { OpenlistError } from "../openlist/client.js";
import { QuarkError } from "../quark/client.js";
import { QuarkTaskError } from "../quark/share.js";
import { RemoteDirNotFoundError, ShareGoneError, type AccountIssue, type DriveProvider } from "./types.js";

/**
 * 各家错误里能拿到的事实，给失败分类器用：功能代码不再 instanceof 具体网盘的错误类。
 *   status     HTTP 状态 / 网盘自己的状态码（115 的 HTTP 状态、夸克壳里的 status、OpenList 的 code、axios 的响应状态）；
 *              CD2 说的是 gRPC 状态码，只有「没有这个路径」换成 404，别的不放进来（见下面 Cd2Error 那一支）
 *   transport  连不上 / HTTP 层失败（值得重试）
 *   taskFailed 网盘的异步任务失败或超时（夸克的转存 / 移动任务）
 *   authCode   网盘明确回了登录态失效的码（夸克 31001 / 31004 / 401，OpenList 401，CD2 UNAUTHENTICATED）
 */
export interface DriveErrorFacts {
  status?: number;
  transport: boolean;
  taskFailed: boolean;
  authCode: boolean;
  /**
   * 是网盘接口回来的错误（115 / 夸克 / OpenList 的错误类、axios 的响应）：它的文案可以拿来猜账号问题；我们自己拼的 Error / PermanentError 不算。
   * CD2 的也不算：它的文案里常带着路径（`object not found: /115/…`），登录失效 / 缺权限按 gRPC 码认就够了
   */
  api: boolean;
}

export function driveErrorFacts(err: unknown): DriveErrorFacts {
  // 包着网盘错误的 PermanentError（OpenList 取文件信息回 401 那种）看里面那个
  if (err instanceof PermanentError && err.cause !== undefined) return driveErrorFacts(err.cause);
  if (err instanceof OpenlistError) return { status: err.code, transport: err.transport, taskFailed: false, authCode: err.code === 401, api: true };
  if (err instanceof Cloud115Error) return { status: err.status, transport: false, taskFailed: false, authCode: false, api: true };
  if (err instanceof Cloud115ApiError) return { transport: false, taskFailed: false, authCode: err.errno === 990001, api: true };
  // 115 分享接口的业务错误：也是接口回来的，cookie 失效那种要能按码 / 文案认成账号问题
  if (err instanceof ShareApiError) return { transport: false, taskFailed: false, authCode: err.errno === 990001, api: true };
  if (err instanceof QuarkTaskError) return { transport: false, taskFailed: true, authCode: false, api: true };
  if (err instanceof QuarkError) return { status: err.status, transport: false, taskFailed: false, authCode: err.code === 31001 || err.code === 31004 || err.status === 401, api: true };
  if (err instanceof Cd2Error) {
    // gRPC 的小整数不能当 HTTP 状态放进 status（分类器按它看 429 / 5xx）。「没有这个路径」给 404：整理按它判过期、下载按它判文件没了；
    // 连不上、UNAVAILABLE、DEADLINE_EXCEEDED 过一会儿多半就好
    const retry = err.transport || err.code === GRPC_STATUS.UNAVAILABLE || err.code === GRPC_STATUS.DEADLINE_EXCEEDED;
    return { ...(isCd2Missing(err) ? { status: 404 } : {}), transport: retry, taskFailed: false, authCode: err.code === GRPC_STATUS.UNAUTHENTICATED, api: false };
  }
  if (axios.isAxiosError(err)) return { status: err.response?.status, transport: !err.response, taskFailed: false, authCode: false, api: !!err.response };
  return { transport: false, taskFailed: false, authCode: false, api: false };
}

/** 从文案猜账号问题：115 的登录超时 / 封控页那些固定说法。只给网盘接口回来的错误用，带路径的文案别拿来猜 */
export function classifyAccountIssue(message: string): "cookie" | "blocked" | null {
  if (/登录超时|请重新登录|990001|cookie|not login|未登录/i.test(message)) return "cookie";
  if (/封控|阻断|405|Method Not Allowed|doctypehtml/i.test(message)) return "blocked";
  return null;
}

/**
 * 账号问题（登录失效 / 风控 / 分享没了）的统一判断，两个失败分类器都走这里：
 *   1. provider.classifyError：各家按自己的码 / 文案认（115 只看接口回来的错误）
 *   2. 结构化的事实：登录码（夸克 31001 / 31004、OpenList 401、115 errno 990001）
 *   3. 都没认出来就按文案兜底——只对网盘接口回来的错误（facts.api）做
 * 文案兜底只看网盘接口回来的错误：我们自己抛的 PermanentError / 普通 Error 里带着用户的路径，目录名里的「405」「cookie」
 * 会把整轮同步按风控停掉（115 的 classifyError 也只看接口错误）；包着网盘错误的 PermanentError 看 cause
 */
export function accountIssueOf(provider: Pick<DriveProvider, "classifyError"> | undefined, err: unknown): AccountIssue | null {
  const inner = err instanceof PermanentError && err.cause !== undefined ? err.cause : err;
  if (inner instanceof RemoteDirNotFoundError) return null;
  const facts = driveErrorFacts(inner);
  const issue = provider?.classifyError(inner) ?? null;
  if (issue === "auth" || facts.authCode) return "auth";
  if (issue) return issue;
  // provider 没认出来（或者没给 provider）就按文案兜底，只看网盘接口回来的错误
  if (facts.api) {
    const text = classifyAccountIssue(messageOf(inner));
    if (text === "cookie") return "auth";
    if (text === "blocked") return "blocked";
  }
  return null;
}

/**
 * 分享打不开是因为提取码（错了、没带）还是分享本身没了：界面上前者是「提取码不对或缺」，后者才是「已失效」。
 * 资源搜索的有效性检测（PanSou 回的说明）也按它认
 */
export const SHARE_PASSWORD_PROBLEM = /提取码|访问码|密码|口令|passcode|password|\bpwd\b/i;

/** 包成 HttpError 时原始错误挂在 cause 上：要按错误类型再判断的调用方（智能体工具的账号提示）还拿得到 */
export function driveErrorToHttp(err: unknown, fallback: string): HttpError {
  if (err instanceof HttpError) return err;
  const cause = { cause: err };
  if (err instanceof RemoteDirNotFoundError) return new HttpError(404, err.message, {}, cause);
  // code 给界面认：资源搜索页据此标失效（别的 5xx 可能是账号问题，不能当失效）；提取码的问题另说，那种分享其实还在
  if (err instanceof ShareGoneError) {
    const reason = SHARE_PASSWORD_PROBLEM.test(err.message) ? "password" : "gone";
    return upstreamError(`分享不可用：${err.message}`, { code: "SHARE_GONE", reason, errno: err.code }, err);
  }
  // 分享接口一时回不了话（太频繁、繁忙）：分享多半还在，单给一个码，界面不能据此标失效
  if (err instanceof ShareBusyError) {
    return upstreamError(`分享暂时打不开：${err.message}`, { code: "SHARE_BUSY", ...(err.errno !== undefined ? { errno: err.errno } : {}) }, err);
  }
  if (err instanceof ShareApiError) return upstreamError(`分享不可用：${err.message}`, { errno: err.errno }, err);
  if (err instanceof Cloud115Error) return upstreamError(err.message, { upstreamStatus: err.status }, err);
  if (err instanceof QuarkError) return upstreamError(err.message, { upstreamStatus: err.status, code: err.code }, err);
  if (err instanceof OpenlistError) return upstreamError(err.message, { upstreamStatus: err.code }, err);
  if (err instanceof Cd2Error) return upstreamError(err.message, err.code === undefined ? {} : { grpcStatus: err.code }, err);
  if (isAbortError(err)) return new HttpError(499, "已取消", {}, cause);
  // 其余 PermanentError 是「网盘明确说没有」：文件不存在、目录不是目录
  if (err instanceof PermanentError) return new HttpError(404, err.message, {}, cause);
  // 超时、连不上：axios 的原话是英文，换成人话，前面带上是哪一步（「发起复制失败：网盘接口 30 秒没有回应…」）
  const net = networkErrorText(err);
  if (net) return upstreamError(`${fallback}：${net}`, {}, err);
  return upstreamError(err instanceof Error && err.message ? err.message : fallback, {}, err);
}
