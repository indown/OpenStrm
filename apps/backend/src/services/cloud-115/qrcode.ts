/**
 * 115 扫码登录：拿二维码 → 轮询扫码状态 → 扫码确认后换 cookie。
 *
 * 为什么要有它：115 的 cookie 和登录端绑定（见 cookie.ts），用户从浏览器抠出来的网页版 cookie 跑不了任务。
 * 让用户在账户页选一个端、拿手机 App 扫一下，拿到的 cookie 天然就是 App 端的。
 *
 * 接口对照 p115client（login_qrcode_token / login_qrcode_scan_status / login_qrcode_scan_result / login_qrcode）
 * 和 115driver（QRCodeStart / QRCodeStatus / QRCodeLoginWithApp）：
 *   1. GET  qrcodeapi.115.com/api/1.0/{app}/1.0/token/          → data { uid, time, sign, qrcode }
 *   2. GET  qrcodeapi.115.com/api/1.0/{app}/1.0/qrcode?uid=      → PNG
 *   3. GET  qrcodeapi.115.com/get/status/?uid=&time=&sign=&_=    → data.status：0 等扫 / 1 已扫 / 2 已确认 / -1 过期 / -2 取消
 *   4. POST passportapi.115.com/app/1.0/{app}/1.0/login/qrcode/  表单 app + account(uid) → data.cookie { UID, CID, SEID, KID }
 *
 * 二维码图由这里取回、内联成 data URL：前端不用二维码库，浏览器也不用直连 115。
 * 会话放内存：这时还没有账号，没什么可持久的；十分钟没扫完就作废。cookie 只在 confirmed 那一次交出去，交完会话即删。
 * 不经 scheduleForAccount：限流器按账号名分桶，登录时还没有账号。
 */
import axios, { type AxiosRequestConfig } from "axios";
import type { Qrcode115App, Qrcode115Start, Qrcode115Status } from "@openstrm/shared";
import { isTimeoutError, networkErrorText } from "../../lib/errors.js";
import { DEFAULT_TIMEOUT_MS } from "../../lib/http.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { defaultUA } from "./client.js";
import { cookieFromParts } from "./cookie.js";

const log = moduleLogger("cloud-115-qrcode");

/** 界面上能选的端，顺序就是下拉的顺序；网页和桌面端不给（见 shared 的 Qrcode115App） */
export const QRCODE_APPS = ["alipaymini", "wechatmini", "tv", "android", "ios"] as const satisfies readonly Qrcode115App[];

const QRCODE_API = "https://qrcodeapi.115.com";
const PASSPORT_API = "https://passportapi.115.com";
let qrcodeBase = QRCODE_API;
let passportBase = PASSPORT_API;
/** 仅供测试和冒烟：两个主机都指到本地假服务；传 null 恢复 */
export function setQrcodeApiBase(base: string | null): void {
  qrcodeBase = base ?? QRCODE_API;
  passportBase = base ?? PASSPORT_API;
}

/** 二维码本身 115 那边几分钟就过期；会话留久一点，让界面能把「已过期」显示出来而不是直接 404 */
export const QRCODE_SESSION_TTL_MS = 10 * 60_000;
/**
 * 换到 cookie 之后会话再留两分钟：交出去的那一次响应可能没送到（前端超时、连接断了），
 * 下一次问还能拿到同一份，不用让用户再扫一次（115 那边二维码已经用掉了）。到点才删。
 */
export const QRCODE_CONFIRMED_KEEP_MS = 2 * 60_000;
/** 同时最多留几个会话：狂点刷新 / 开好几个标签页也只占这么多，老的先淘汰（前端早就不要它们了） */
export const QRCODE_MAX_SESSIONS = 4;

/**
 * 查状态是长轮询：没变化时 115 把请求挂着不回（真机 2026-11-02：第二次查就挂了 30 秒以上）。
 * 挂到超时不算错，算「还没变化」，回上一次的状态让界面接着问。超时给得比默认长一点，
 * 但要比前端那头那次请求的超时短（lib/api.ts 给了 60 秒），不然前端先放弃。
 */
const STATUS_TIMEOUT_MS = 40_000;
let statusTimeoutMs = STATUS_TIMEOUT_MS;
/** 仅供测试：把长轮询的超时调短 */
export function setQrcodeStatusTimeoutMs(ms: number | null): void {
  statusTimeoutMs = ms ?? STATUS_TIMEOUT_MS;
}

interface Session {
  app: Qrcode115App;
  uid: string;
  time: number;
  sign: string;
  createdAt: number;
  /** 进行中的查状态：两个标签页同时问，只往 115 发一次 */
  pending: Promise<Qrcode115Status> | null;
  /** 上一次问到的状态：长轮询挂到超时时就回它 */
  last: "waiting" | "scanned";
  /** 已经换到的 cookie：留到 confirmedAt + QRCODE_CONFIRMED_KEEP_MS */
  result?: Qrcode115Status & { status: "confirmed" };
  confirmedAt?: number;
}

const sessions = new Map<string, Session>();

/** 仅供测试 */
export function resetQrcodeSessions(): void {
  sessions.clear();
}

type Shell = { state?: unknown; code?: unknown; message?: unknown; error?: unknown; errno?: unknown; data?: unknown };

/** 115 壳子里给人看的那句话：message 或 error，哪个有字用哪个 */
function shellMessage(resp: Shell): string {
  const found = [resp.message, resp.error].find((v) => typeof v === "string" && v.trim());
  return typeof found === "string" ? found.trim() : "";
}

/** 115 的壳子说「不行」：message / error 里是给人看的文案，原样带出去 */
function shellError(resp: Shell, what: string): HttpError {
  const msg = shellMessage(resp);
  const code = typeof resp.code === "number" ? resp.code : typeof resp.errno === "number" ? resp.errno : undefined;
  // p115client 的提醒：换 cookie 回「IP登录异常」时会封到第二天零点，反复点只会更糟
  const hint = /IP登录异常/.test(msg) ? "（115 会封到第二天零点，别反复试）" : "";
  return upstreamError(msg ? `115：${msg}${hint}` : `115 ${what}接口没有返回数据`, code === undefined ? {} : { code });
}

/** 网络层 / 非 2xx 换成带原因的 upstreamError。日志只记接口名：查询串里有 sign，响应里有 cookie，都不记 */
function wrapError(err: unknown, what: string): HttpError {
  if (err instanceof HttpError) return err;
  const net = networkErrorText(err);
  if (net) return upstreamError(net, {}, err);
  if (axios.isAxiosError(err) && err.response) {
    return upstreamError(`115 ${what}接口返回 ${err.response.status}`, { upstreamStatus: err.response.status }, err);
  }
  return upstreamError(`115 ${what}接口出错：${err instanceof Error ? err.message : String(err)}`, {}, err);
}

async function raw<T>(config: AxiosRequestConfig): Promise<T> {
  const res = await axios({
    ...config,
    timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
    headers: { "User-Agent": defaultUA(), ...(config.headers ?? {}) },
  });
  return res.data as T;
}

async function http<T>(what: string, config: AxiosRequestConfig): Promise<T> {
  try {
    return await raw<T>(config);
  } catch (err) {
    throw wrapError(err, what);
  }
}

/** 壳子 `state` 为真才有 data；有时是 1 / 0，有时是 true / false */
function dataOf(resp: unknown, what: string): Record<string, unknown> {
  const r = (resp && typeof resp === "object" ? resp : {}) as Shell;
  if (!r.state) throw shellError(r, what);
  return (r.data && typeof r.data === "object" ? r.data : {}) as Record<string, unknown>;
}

/** 没扫完的按生成时间算，换到 cookie 的按确认时间算 */
function expired(s: Session, now: number): boolean {
  if (s.result && s.confirmedAt !== undefined) return now - s.confirmedAt > QRCODE_CONFIRMED_KEEP_MS;
  return now - s.createdAt > QRCODE_SESSION_TTL_MS;
}

function prune(now: number): void {
  for (const [uid, s] of sessions) {
    if (expired(s, now)) sessions.delete(uid);
  }
  // Map 按插入顺序迭代，最早生成的排最前
  while (sessions.size >= QRCODE_MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

const tail = (uid: string) => uid.slice(-4);

export async function startQrcodeLogin(app: Qrcode115App, now = Date.now()): Promise<Qrcode115Start> {
  prune(now);
  const token = dataOf(await http("二维码", { method: "get", url: `${qrcodeBase}/api/1.0/${app}/1.0/token/` }), "二维码");
  const uid = typeof token.uid === "string" || typeof token.uid === "number" ? String(token.uid) : "";
  const time = Number(token.time);
  const sign = typeof token.sign === "string" ? token.sign : "";
  if (!uid || !Number.isFinite(time) || !sign) throw upstreamError("115 二维码接口返回的数据不完整");
  const png = await http<ArrayBuffer | Buffer>("二维码图片", {
    method: "get",
    url: `${qrcodeBase}/api/1.0/${app}/1.0/qrcode`,
    params: { uid },
    responseType: "arraybuffer",
  });
  // node 的 axios 适配器回的是 Buffer，类型上还留着 ArrayBuffer 的可能
  const bytes = Buffer.isBuffer(png) ? png : Buffer.from(png as ArrayBuffer);
  const image = `data:image/png;base64,${bytes.toString("base64")}`;
  sessions.set(uid, { app, uid, time, sign, createdAt: now, pending: null, last: "waiting" });
  log.info({ app, uid: tail(uid) }, "115 扫码登录：二维码已生成");
  return { uid, image, expiresAt: now + QRCODE_SESSION_TTL_MS };
}

/** 查一次状态；确认了就顺手换 cookie。不认识的 uid（没生成过、过期清掉了、换完 cookie 也过了保留期）→ 404 */
export async function pollQrcodeLogin(uid: string, now = Date.now()): Promise<Qrcode115Status> {
  const s = sessions.get(uid);
  if (!s || expired(s, now)) {
    sessions.delete(uid);
    throw new HttpError(404, "二维码已失效，重新生成一个", { code: "QRCODE_GONE" });
  }
  if (s.result) return s.result;
  if (!s.pending) {
    s.pending = poll(s).finally(() => {
      s.pending = null;
    });
  }
  return s.pending;
}

function finish(s: Session, status: "expired" | "cancelled"): Qrcode115Status {
  sessions.delete(s.uid);
  log.info({ app: s.app, uid: tail(s.uid), status }, "115 扫码登录：二维码作废");
  return { status };
}

async function poll(s: Session): Promise<Qrcode115Status> {
  let resp: Shell;
  try {
    resp =
      (await raw<Shell | null>({
        method: "get",
        url: `${qrcodeBase}/get/status/`,
        params: { uid: s.uid, time: s.time, sign: s.sign, _: Date.now() },
        timeout: statusTimeoutMs,
      })) ?? {};
  } catch (err) {
    if (isTimeoutError(err)) {
      log.debug({ uid: tail(s.uid), last: s.last }, "115 扫码状态长轮询挂到超时，按没变化处理");
      return { status: s.last };
    }
    throw wrapError(err, "扫码状态");
  }
  // 过期 / 取消两种结局：p115client 按 data.status 的 -1 / -2 认；115 也可能用 state:0 加一句文案回，两种都认
  if (!resp.state) {
    const msg = shellMessage(resp);
    if (/过期|失效/.test(msg)) return finish(s, "expired");
    if (/取消/.test(msg)) return finish(s, "cancelled");
    throw shellError(resp, "扫码状态");
  }
  const data = (resp.data && typeof resp.data === "object" ? resp.data : {}) as Record<string, unknown>;
  const status = Number(data.status);
  switch (status) {
    case 0:
      return { status: "waiting" };
    case 1:
      s.last = "scanned";
      return { status: "scanned" };
    case -1:
      return finish(s, "expired");
    case -2:
      return finish(s, "cancelled");
    case 2:
      break;
    default:
      throw upstreamError(`115 扫码状态接口回了认不出的状态：${JSON.stringify(data).slice(0, 200)}`);
  }
  // 换 cookie 失败（网络、IP 异常）不删会话：下一次查状态 115 仍回 2，还能再换一次
  const form = new URLSearchParams({ app: s.app, account: s.uid });
  const result = dataOf(
    await http("换 cookie", {
      method: "post",
      url: `${passportBase}/app/1.0/${s.app}/1.0/login/qrcode/`,
      data: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    "换 cookie",
  );
  const cookie = cookieFromParts(result.cookie as Record<string, unknown> | undefined);
  if (!cookie) throw upstreamError("115 确认了扫码，但没有返回完整的 cookie（要有 UID / CID / SEID）");
  log.info({ app: s.app, uid: tail(s.uid) }, "115 扫码登录：已拿到 cookie");
  const userName = typeof result.user_name === "string" && result.user_name ? result.user_name : undefined;
  s.result = userName ? { status: "confirmed", cookie, userName } : { status: "confirmed", cookie };
  s.confirmedAt = Date.now();
  return s.result;
}
