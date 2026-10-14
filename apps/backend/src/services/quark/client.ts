/**
 * 夸克网盘（Cookie 模式）的最小客户端：列目录、按路径找 fid、取下载直链。
 *
 * 接口和约定都照 OpenList 的 drivers/quark_uc：
 *   - base https://drive.quark.cn/1/clouddrive，每个请求带 ?pr=ucpro&fr=pc，
 *     头 Cookie / Referer / 固定的桌面端 UA（不用设置里的全局 UA：直链和取链时的 UA 绑定，固定下来才确定）。
 *   - 响应壳 { status, code, message, data, metadata }；status >= 400 或 code !== 0 即失败，message 给人看。
 *   - 服务端会在 Set-Cookie 里轮换 __puus：必须合并回账号 cookie 并落库，否则 cookie 很快失效。
 *   - 没有「路径 → id」接口，也没有 115 那种整树导出：路径从根 "0" 逐段列目录对名字，目录内容按 100 条翻页。
 *   - /file/download 给的直链取文件时必须带同一份 Cookie、Referer、UA，所以不能 302 给播放器；
 *     全量任务里随片下载字幕 / nfo 是我们自己取，带上这几个头即可。
 *
 * 只抛 QuarkError（接口明确说失败）和 PermanentError（路径不存在这类换多少次都一样的）；HTTP 语义由路由翻译。
 */
import axios, { type AxiosRequestConfig } from "axios";
import { LRUCache } from "lru-cache";
import type { AccountQuark } from "@openstrm/shared";
import { updateAccountWith } from "../../db/repositories/accounts.js";
import { scheduleForAccount, type ThrottleChannel } from "../throttle.js";
import { PermanentError, isAbortError } from "../../lib/errors.js";
import { DEFAULT_TIMEOUT_MS } from "../../lib/http.js";
import { moduleLogger } from "../../lib/logger.js";

const log = moduleLogger("quark");

export const QUARK_API = "https://drive.quark.cn/1/clouddrive";
export const QUARK_REFERER = "https://pan.quark.cn";
export const QUARK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";
const PAGE_SIZE = 100;
/** 服务端会轮换的 cookie 键：__puus 每次都可能换，__pus 只在转码播放时出现，顺手一起收 */
const ROTATED_COOKIES = ["__puus", "__pus"];

let apiBase = QUARK_API;
/** 仅供测试：把接口指到本地假服务；传 null 恢复 */
export function setQuarkApiBase(base: string | null): void {
  apiBase = base ?? QUARK_API;
}

export class QuarkError extends Error {
  constructor(
    message: string,
    /** 响应壳里的 status（没有就是 HTTP 状态码） */
    readonly status?: number,
    /** 响应壳里的 code，夸克自己的错误码 */
    readonly code?: number,
  ) {
    super(message);
    this.name = "QuarkError";
  }
}

export interface QuarkEntry {
  fid: string;
  name: string;
  isDir: boolean;
  size: number;
  /** 夸克的分类：1 = 视频 */
  category: number;
  /** 毫秒。目录的这个时间在直接子项新增 / 移入 / 改名时刷新（删除、移出不刷新，孙辈不冒泡） */
  modifiedAt: number;
  /** 目录的直接子项数（include_items，空目录不带这个字段就是 0）；文件是 0 */
  items: number;
}

/** 下载直链和取它时必须带的头 */
export interface QuarkLink {
  url: string;
  headers: Record<string, string>;
}

interface Envelope<T> {
  status?: number;
  code?: number;
  message?: string;
  data?: T;
  metadata?: Record<string, unknown>;
}

/* ------------------------------- cookie ------------------------------- */

/** 把 name=value 写进 cookie 串：已有的键替换，没有就追加，其它键原样保留 */
export function mergeCookie(cookie: string, name: string, value: string): string {
  const pairs = cookie
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  let found = false;
  const out = pairs.map((pair) => {
    const eq = pair.indexOf("=");
    const key = (eq === -1 ? pair : pair.slice(0, eq)).trim();
    if (key !== name) return pair;
    found = true;
    return `${name}=${value}`;
  });
  if (!found) out.push(`${name}=${value}`);
  return out.join("; ");
}

/** 从响应的 Set-Cookie 里取某个键的值（只看分号前的键值对，Path / HttpOnly 之类的属性忽略）；没有返回 null */
export function cookieFromSetCookie(headers: string[] | string | undefined, name: string): string | null {
  if (!headers) return null;
  for (const header of Array.isArray(headers) ? headers : [headers]) {
    const first = header.split(";")[0] ?? "";
    const eq = first.indexOf("=");
    if (eq === -1) continue;
    if (first.slice(0, eq).trim() === name) return first.slice(eq + 1).trim();
  }
  return null;
}

/**
 * 把响应里轮换过的 cookie 合并回账号。改的是传进来的那个对象：全量任务一次 listAccounts() 之后
 * 整轮复用同一个对象，后面的请求才拿得到新值；同时写库，下一次任务从库里读到的也是新的。
 * 并发请求各自带回不同的值时后写胜出——它们都是同一会话的刷新，旧值短时间内仍有效，不值得为此串行化。
 */
/**
 * @param sent 发这个请求时用的 cookie：轮换出来的 __puus 属于它那个会话，持有者在这期间换过 cookie 的话这份轮换就作废
 */
function rememberRotatedCookies(account: AccountQuark, setCookie: string[] | string | undefined, sent: string): void {
  if (account.cookie !== sent) return;
  const before = sent;
  let merged = before;
  for (const name of ROTATED_COOKIES) {
    const value = cookieFromSetCookie(setCookie, name);
    if (value) merged = mergeCookie(merged, name, value);
  }
  if (merged === before) return;
  // 只在库里还是发请求时那份 cookie 时才写回：用户刚在账户页换了新的，旧会话轮换出来的 __puus 不能盖上去，
  // 这个持有者改用库里的新 cookie
  const row = updateAccountWith(account.name, (current) => {
    const stored = "cookie" in current ? (current.cookie ?? "") : "";
    return stored === before ? { cookie: merged } : null;
  });
  const stored = row && "cookie" in row ? (row.cookie ?? "") : "";
  if (stored && stored !== merged) {
    account.cookie = stored;
    log.debug(`夸克账号 ${account.name} 的 cookie 已被别处更新，改用新的`);
    return;
  }
  account.cookie = merged;
  log.debug(`夸克账号 ${account.name} 的 cookie 已轮换并写回`);
}

/* ------------------------------- 名字 ------------------------------- */

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** 列目录返回的 file_name 是 HTML 转义过的（OpenList 也做了一次 html.UnescapeString） */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/* ------------------------------- 请求 ------------------------------- */

interface RequestOptions {
  params?: Record<string, string | number>;
  data?: unknown;
  signal?: AbortSignal;
  /** 限流通道，默认 normal；网盘监控的后台轮询走 life */
  channel?: ThrottleChannel;
}

/**
 * 走一次夸克接口。和 request115 一样排进账号限流器（共享的每秒配额按账号名分，夸克自动享有同样的限流）。
 * HTTP 状态一律放行，由响应壳判断成败：4xx 的壳里 message 才是给人看的原因。
 */
export async function quarkRequest<T>(
  account: AccountQuark,
  method: "GET" | "POST",
  path: string,
  { params, data, signal, channel = "normal" }: RequestOptions = {},
): Promise<Envelope<T>> {
  return scheduleForAccount(
    account.name,
    channel,
    async () => {
      // 记住发这个请求时的 cookie：响应里轮换出来的 __puus 只属于它，中途换了 cookie 的话这份轮换作废
      const sent = account.cookie;
      const config: AxiosRequestConfig = {
        url: `${apiBase}${path}`,
        method,
        params: { pr: "ucpro", fr: "pc", ...params },
        data,
        headers: {
          Cookie: sent,
          Referer: QUARK_REFERER,
          "User-Agent": QUARK_UA,
          Accept: "application/json, text/plain, */*",
        },
        timeout: DEFAULT_TIMEOUT_MS,
        signal,
        validateStatus: () => true,
      };
      const res = await axios.request<Envelope<T> | string>(config);
      rememberRotatedCookies(account, res.headers["set-cookie"], sent);
      const body = res.data;
      if (!body || typeof body !== "object") {
        throw new QuarkError(`夸克 ${path} 失败：HTTP ${res.status}`, res.status);
      }
      if (res.status >= 400 || (body.status ?? 0) >= 400 || (body.code ?? 0) !== 0) {
        const reason = body.message || `HTTP ${res.status}`;
        throw new QuarkError(`夸克 ${path} 失败：${reason}`, body.status ?? res.status, body.code);
      }
      return body;
    },
    signal,
  );
}

/* ------------------------------- fs ------------------------------- */

interface RawFile {
  fid?: string;
  file_name?: string;
  /** true 是文件；OpenList 按 !file 判目录，缺失时同样当目录 */
  file?: boolean;
  size?: number;
  category?: number;
  updated_at?: number;
  include_items?: number;
}

function toEntry(f: RawFile): QuarkEntry {
  return {
    fid: String(f.fid),
    name: unescapeHtml(String(f.file_name ?? "")),
    isDir: !f.file,
    size: Number(f.size ?? 0),
    category: Number(f.category ?? 0),
    modifiedAt: Number(f.updated_at ?? 0),
    items: Number(f.include_items ?? 0),
  };
}

/** 列一个目录的全部内容，按 100 条翻页；显式排序，翻页期间目录变化才不至于漏掉或重复条目 */
export async function quarkListDir(
  account: AccountQuark,
  fid: string,
  signal?: AbortSignal,
  opts: { channel?: ThrottleChannel } = {},
): Promise<QuarkEntry[]> {
  const entries: QuarkEntry[] = [];
  for (let page = 1; ; page++) {
    const body = await quarkRequest<{ list?: RawFile[] }>(account, "GET", "/file/sort", {
      params: {
        pdir_fid: fid,
        _page: page,
        _size: PAGE_SIZE,
        _fetch_total: 1,
        fetch_all_file: 1,
        fetch_risk_file_name: 1,
        _sort: "file_type:asc,file_name:asc",
      },
      signal,
      channel: opts.channel,
    });
    const list = body.data?.list ?? [];
    for (const f of list) {
      if (!f.fid) continue;
      entries.push(toEntry(f));
    }
    // 半页 / 空页就是最后一页；页是满的就再翻一页（_total 偶尔少算，只信它会把尾巴丢掉，同步会把对应的本地文件当多余删掉）。
    // 服务端要是一直回满页、超过 _total 一整页还没到头，说明它在胡说：抛错，别把截断的列表当完整的交出去
    const total = Number(body.metadata?._total);
    if (list.length < PAGE_SIZE) break;
    if (Number.isFinite(total) && entries.length >= total + PAGE_SIZE) {
      throw new Error(`夸克：目录 ${fid} 列到 ${entries.length} 条已超过 _total（${total}）一整页还没到头，服务端返回异常`);
    }
  }
  return entries;
}

/** path_list 一次最多带这么多路径：真机上 51 个就报 Bad Parameter: [fids size limit] */
export const PATH_LIST_MAX = 50;

/**
 * POST file/info/path_list {file_path:[...], namespace:"0"}：按绝对路径批量取条目，不存在的路径直接不回。
 * 真机验证过：只认目录，大小写和空格都要精确；文件路径拿不到（文件还是得列父目录）。
 * 回的是完整条目（updated_at、include_items 和列目录看到的一致）；超过 50 个路径这里分批发。
 */
export async function quarkPathList(
  account: AccountQuark,
  paths: string[],
  opts: { signal?: AbortSignal; channel?: ThrottleChannel } = {},
): Promise<Map<string, QuarkEntry>> {
  const out = new Map<string, QuarkEntry>();
  for (let i = 0; i < paths.length; i += PATH_LIST_MAX) {
    const body = await quarkRequest<Array<RawFile & { file_path?: string }>>(account, "POST", "/file/info/path_list", {
      data: { file_path: paths.slice(i, i + PATH_LIST_MAX), namespace: "0" },
      signal: opts.signal,
      channel: opts.channel,
    });
    for (const f of body.data ?? []) {
      if (f.fid && f.file_path) out.set(f.file_path, toEntry(f));
    }
  }
  return out;
}

const pathCache = new LRUCache<string, QuarkEntry>({ max: 5000, ttl: 10 * 60 * 1000 });

/** 仅供测试 */
export function clearQuarkCaches(): void {
  pathCache.clear();
}

function splitPath(path: string): string[] {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

function cacheKey(account: AccountQuark, segments: string[]): string {
  return `${account.name}\0${segments.join("/")}`;
}

/**
 * 路径 → fid。从最长的已缓存前缀往下逐段列目录对名字（只缓存目录：文件路径在任务里都是一次性的）。
 * 根（空路径 / "/"）返回 fid "0"、entry null。段找不到抛 PermanentError：取直链的重试见到它就直接放弃。
 */
export async function quarkResolvePath(
  account: AccountQuark,
  path: string,
  signal?: AbortSignal,
): Promise<{ fid: string; entry: QuarkEntry | null }> {
  const segments = splitPath(path);
  if (segments.length === 0) return { fid: "0", entry: null };

  let start = 0;
  let fid = "0";
  let entry: QuarkEntry | null = null;
  for (let len = segments.length; len > 0; len--) {
    const hit = pathCache.get(cacheKey(account, segments.slice(0, len)));
    if (hit) {
      start = len;
      fid = hit.fid;
      entry = hit;
      break;
    }
  }

  // 还有两段以上没解析：先按路径一次问。目录能直接拿到；目标是文件时至少把父目录拿到，只剩最后一段要列
  if (segments.length - start >= 2) {
    const full = `/${segments.join("/")}`;
    const parent = `/${segments.slice(0, -1).join("/")}`;
    let hits: Map<string, QuarkEntry>;
    try {
      hits = await quarkPathList(account, [full, parent], { signal });
    } catch (err) {
      // path_list 只是省请求的捷径：它打不通就退回逐段列目录，真有登录态问题那边照样会报
      if (isAbortError(err)) throw err;
      log.debug({ account: account.name, path, err }, "夸克 path_list 失败，退回逐段列目录");
      hits = new Map();
    }
    const hit = hits.get(full);
    if (hit) {
      if (hit.isDir) pathCache.set(cacheKey(account, segments), hit);
      return { fid: hit.fid, entry: hit };
    }
    const dir = hits.get(parent);
    if (dir?.isDir) {
      pathCache.set(cacheKey(account, segments.slice(0, -1)), dir);
      start = segments.length - 1;
      fid = dir.fid;
      entry = dir;
    }
  }

  for (let i = start; i < segments.length; i++) {
    const name = segments[i];
    const isLast = i === segments.length - 1;
    const sofar = segments.slice(0, i + 1).join("/");
    const matches = (await quarkListDir(account, fid, signal)).filter((e) => e.name.trim() === name);
    if (matches.length === 0) throw new PermanentError(`夸克：找不到 ${sofar}`);
    if (matches.length > 1) log.warn({ account: account.name, path: sofar }, "夸克目录里有同名条目，取第一个");
    // 中间段必须是目录；同名时优先目录
    entry = (isLast ? null : matches.find((e) => e.isDir)) ?? matches[0];
    if (!isLast && !entry.isDir) throw new PermanentError(`夸克：${sofar} 不是目录`);
    if (entry.isDir) pathCache.set(cacheKey(account, segments.slice(0, i + 1)), entry);
    fid = entry.fid;
  }
  return { fid, entry };
}

/** 取直链时必须一起带上的头：cookie 现读，好把刚轮换进来的 __puus 带上 */
export function quarkLinkHeaders(account: AccountQuark): Record<string, string> {
  return { Cookie: account.cookie, Referer: QUARK_REFERER, "User-Agent": QUARK_UA };
}

/** 文件的下载直链。夸克明确说没有直链时是 PermanentError，别拿同一个 fid 重试 */
export async function quarkDownloadLink(account: AccountQuark, fid: string, signal?: AbortSignal): Promise<QuarkLink> {
  const body = await quarkRequest<Array<{ download_url?: string }>>(account, "POST", "/file/download", {
    data: { fids: [fid] },
    signal,
  });
  const url = body.data?.[0]?.download_url;
  if (!url) throw new PermanentError(`夸克：没有拿到 ${fid} 的下载直链`);
  return { url, headers: quarkLinkHeaders(account) };
}

/* ------------------------------- 写操作（整理用） ------------------------------- */

/** 改名 / 移动 / 删除之后，这些路径（含子孙）的目录缓存都不可信了 */
export function forgetQuarkPaths(account: AccountQuark, paths: string[]): void {
  const prefix = `${account.name}\0`;
  const targets = paths.map((p) => splitPath(p).join("/")).filter(Boolean);
  if (targets.length === 0) return;
  for (const key of [...pathCache.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const p = key.slice(prefix.length);
    if (targets.some((t) => p === t || p.startsWith(`${t}/`))) pathCache.delete(key);
  }
}

/** 建好的目录直接进缓存，接下来往里挪文件不用再列一遍 */
export function rememberQuarkDir(account: AccountQuark, path: string, entry: QuarkEntry): void {
  const segments = splitPath(path);
  if (segments.length === 0) return;
  pathCache.set(cacheKey(account, segments), entry);
}

/** POST /file：在 pdirFid 下建目录，返回新目录的 fid */
export async function quarkMkdir(account: AccountQuark, pdirFid: string, name: string, signal?: AbortSignal): Promise<string> {
  const body = await quarkRequest<{ fid?: string }>(account, "POST", "/file", {
    data: { pdir_fid: pdirFid, file_name: name, dir_path: "", dir_init_lock: false },
    signal,
  });
  const fid = body.data?.fid;
  if (!fid) throw new Error(`夸克：建目录 ${name} 没有返回 fid`);
  return String(fid);
}

/** POST /file/rename */
export async function quarkRename(account: AccountQuark, fid: string, name: string, signal?: AbortSignal): Promise<void> {
  await quarkRequest(account, "POST", "/file/rename", { data: { fid, file_name: name }, signal });
}

/** 移动 / 删除是异步任务：finish 为 false 时要拿 task_id 去 /task 轮询（见 share.ts 的 quarkWaitTask） */
export interface QuarkTaskHandle {
  taskId?: string;
  finish: boolean;
}

/** POST /file/move：把一批 fid 挪到 toPdirFid 下（名字不变） */
export async function quarkMove(account: AccountQuark, fids: string[], toPdirFid: string, signal?: AbortSignal): Promise<QuarkTaskHandle> {
  if (fids.length === 0) return { finish: true };
  const body = await quarkRequest<{ task_id?: string; finish?: boolean }>(account, "POST", "/file/move", {
    data: { action_type: 1, exclude_fids: [], filelist: fids, to_pdir_fid: toPdirFid },
    signal,
  });
  return { taskId: body.data?.task_id ? String(body.data.task_id) : undefined, finish: body.data?.finish !== false };
}

/** POST /file/delete：进回收站。整理只用它删腾空的目录 */
export async function quarkDelete(account: AccountQuark, fids: string[], signal?: AbortSignal): Promise<QuarkTaskHandle> {
  if (fids.length === 0) return { finish: true };
  const body = await quarkRequest<{ task_id?: string; finish?: boolean }>(account, "POST", "/file/delete", {
    data: { action_type: 1, exclude_fids: [], filelist: fids },
    signal,
  });
  return { taskId: body.data?.task_id ? String(body.data.task_id) : undefined, finish: body.data?.finish !== false };
}
