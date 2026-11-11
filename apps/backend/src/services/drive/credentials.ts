/**
 * 保存账号时对凭据的检查：齐不齐（missingCredentials）、形状对不对（credentialProblem）。
 * 按账号类型分叉放在 drive 这一层（和 providerFor 一样是网盘注册表的事），路由只调函数、不认具体的网盘。
 * 形状目前只有 115 有规则：网页版 cookie 能列目录但跑不了任务（见 cloud-115/cookie.ts）。
 */
import { isWebCookie } from "../cloud-115/cookie.js";

export interface CredentialProblem {
  message: string;
  code: string;
}

export const WEB_COOKIE_MESSAGE =
  "这是网页版登录的 cookie（UID 里的 A1），能看目录但跑不了同步任务。用「扫码登录」，或者填 115 App 端的 cookie";

const CD2_URL = /^(https?:\/\/)?[^\s/]+(:\d+)?\/?$/i;

/**
 * 这个账号还缺哪样凭据，齐了回 null。新建和改账号都问它：改的时候没传的字段沿用旧值，
 * 但请求里带了 accountType 就得配套（编辑表单每次都把整套字段交上来）。没带 accountType 的不查
 */
export function missingCredentials(input: object): string | null {
  const body = input as Record<string, unknown>;
  switch (body.accountType) {
    case "115":
      return body.cookie ? null : "cookie is required for 115 accounts";
    case "quark":
      return body.cookie ? null : "cookie is required for quark accounts";
    case "openlist":
      return body.account && body.password && body.url ? null : "account, password, and url are required for openlist accounts";
    case "cd2":
      if (typeof body.url !== "string" || !body.url.trim()) return "CloudDrive2 账号要填地址，比如 http://192.168.1.10:19798";
      if (!CD2_URL.test(body.url.trim())) return "CloudDrive2 的地址不像个地址，比如 http://192.168.1.10:19798";
      if (!body.apiToken && !(body.username && body.password)) return "CloudDrive2 账号要填 API 令牌，或者用户名加口令";
      return null;
    default:
      return null;
  }
}

/** 这份新给的 cookie 存进去会出什么问题；没问题回 null */
export function credentialProblem(accountType: unknown, cookie: unknown): CredentialProblem | null {
  if (accountType === "115" && typeof cookie === "string" && isWebCookie(cookie)) {
    return { message: WEB_COOKIE_MESSAGE, code: "WEB_COOKIE" };
  }
  return null;
}
