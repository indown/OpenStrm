export interface Account115 {
  accountType: "115";
  name: string;
  cookie: string;
}

export interface AccountOpenlist {
  accountType: "openlist";
  name: string;
  account: string;
  password: string;
  url: string;
  /** 登录换来的令牌和过期时间（unix 秒），由同步任务写回 */
  token?: string;
  expiresAt?: number;
}

/** 夸克网盘，Cookie 模式（同 OpenList 的 Quark 驱动）；服务端轮换的 __puus 会由客户端写回这里 */
export interface AccountQuark {
  accountType: "quark";
  name: string;
  cookie: string;
}

export type AccountInfo = Account115 | AccountOpenlist | AccountQuark;

/* ------------------------------- 115 扫码登录 ------------------------------- */

/**
 * 扫码时选的登录端。115 每个端同时只能有一个会话，再登一次就把前一个顶下线，
 * 所以默认给用户不常用的小程序端；网页（A1）不提供，那种 cookie 跑不了任务；桌面端 115 已停用。
 */
export type Qrcode115App = "alipaymini" | "wechatmini" | "tv" | "android" | "ios";

/** 生成的二维码：image 是 data URL，直接塞进 img；expiresAt 是服务端会话的到期时间（毫秒） */
export interface Qrcode115Start {
  uid: string;
  image: string;
  expiresAt: number;
}

/** 扫码状态；confirmed 那一次带 cookie，而且只给这一次 */
export type Qrcode115Status =
  | { status: "waiting" | "scanned" | "expired" | "cancelled" }
  | { status: "confirmed"; cookie: string; userName?: string };
