/**
 * 保存账号时对凭据形状的检查。按账号类型分叉放在 drive 这一层（和 providerFor 一样是网盘注册表的事），
 * 路由只调一个函数、不认具体的网盘。目前只有 115 有规则：网页版 cookie 能列目录但跑不了任务（见 cloud-115/cookie.ts）。
 */
import { isWebCookie } from "../cloud-115/cookie.js";

export interface CredentialProblem {
  message: string;
  code: string;
}

export const WEB_COOKIE_MESSAGE =
  "这是网页版登录的 cookie（UID 里的 A1），能看目录但跑不了同步任务。用「扫码登录」，或者填 115 App 端的 cookie";

/** 这份新给的 cookie 存进去会出什么问题；没问题回 null */
export function credentialProblem(accountType: unknown, cookie: unknown): CredentialProblem | null {
  if (accountType === "115" && typeof cookie === "string" && isWebCookie(cookie)) {
    return { message: WEB_COOKIE_MESSAGE, code: "WEB_COOKIE" };
  }
  return null;
}
