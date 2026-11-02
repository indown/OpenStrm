/**
 * 115 cookie 的形状和登录端。
 *
 * `UID=<用户id>_<登录端>_<时间戳>`，中段标识这份 cookie 是从哪个端登录的（p115client const.py 的 APP_TO_SSOENT）：
 * A1 网页 / 桌面浏览器，D1 iOS，F1 安卓，I1 电视，R1 微信小程序，R2 支付宝小程序。
 * 网页端的 cookie 能列目录（webapi），但打不了 proapi.115.com/android/2.0 的导出目录树和取直链，
 * 回「请重新登录」errno 99，症状是「添加任务能看到目录，运行任务报请重新登录」。
 * 保存账号时就按中段拦下来，别等跑任务才报错。
 */

/** 网页 / 桌面浏览器登录的 cookie */
export const WEB_SSOENT = "A1";

/**
 * UID 中段；没有 UID、或形状不对（比如用户只贴了一半）回 null，交给调用方照旧放过。
 * 分隔符不只认分号：从开发者工具的 cookie 表格里复制出来的是换行 / 制表符分开的，也得认出来
 */
export function cookieSsoent(cookie: string): string | null {
  const m = /(?:^|[;\s])UID=([^;\s]*)/.exec(cookie);
  if (!m) return null;
  const parts = m[1].split("_");
  if (parts.length < 3) return null;
  const ssoent = parts[1];
  return /^[A-Z][0-9]$/.test(ssoent) ? ssoent : null;
}

export function isWebCookie(cookie: string): boolean {
  return cookieSsoent(cookie) === WEB_SSOENT;
}

/** 扫码登录接口回的 cookie 字段拼成请求头用的一串；UID / CID / SEID 缺一个就算没拿到 */
export function cookieFromParts(parts: Record<string, unknown> | null | undefined): string | null {
  if (!parts || typeof parts !== "object") return null;
  const pick = (k: string) => (typeof parts[k] === "string" && (parts[k] as string).length > 0 ? (parts[k] as string) : null);
  const uid = pick("UID");
  const cid = pick("CID");
  const seid = pick("SEID");
  if (!uid || !cid || !seid) return null;
  const kid = pick("KID");
  return [`UID=${uid}`, `CID=${cid}`, `SEID=${seid}`, ...(kid ? [`KID=${kid}`] : [])].join("; ");
}
