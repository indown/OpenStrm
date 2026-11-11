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

/**
 * CloudDrive2（CD2）：gRPC 地址 + API 令牌（推荐）或用户名口令。和 OpenList 账号一样能建同步任务、浏览目录、整理；
 * 设置页「CloudDrive2」一节选中的那个账号还负责目录缓存刷新和复制引擎
 */
export interface AccountCd2 {
  accountType: "cd2";
  name: string;
  /** 如 http://192.168.1.10:19798（和 CD2 网页同一个端口） */
  url: string;
  /** CD2 设置页生成的 API 令牌；开了两步验证的账号只能用它 */
  apiToken?: string;
  /** 没有令牌就用登录 CD2 的用户名和口令换 */
  username?: string;
  password?: string;
}

export type AccountInfo = Account115 | AccountOpenlist | AccountQuark | AccountCd2;

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
