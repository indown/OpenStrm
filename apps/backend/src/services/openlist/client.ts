/**
 * OpenList（AList 分支）的最小客户端：登录换 token、列目录、跨存储复制、盯复制任务。
 *
 *   - 鉴权：`Authorization: <token>`，没有 Bearer 前缀。token 由 /api/auth/login 换来，
 *     按 47 小时（官方默认 48h 留 1h 余量）缓存在 accounts 表里，和同步任务共用一份。
 *   - 响应统一是 { code, message, data }，HTTP 200 + code!==200 也是失败；
 *     code 401（或 HTTP 401）当作 token 失效，清缓存重登一次再试。
 *   - /api/fs/list 带 refresh:true 会绕过 OpenList 的目录缓存直接问上游，
 *     115 刚下完的文件必须这么刷一下才看得见。
 *   - /api/fs/copy 对目录是「父任务展开子任务」：响应里那个任务结束只代表列目录完成，
 *     真正的逐文件复制在 /api/task/copy/undone 里，调用方要一并盯（见 offline/service.ts）。
 */
import axios, { isAxiosError } from "axios";
import type { AccountOpenlist } from "@openstrm/shared";
import { updateAccount } from "../../db/repositories/accounts.js";
import { DEFAULT_TIMEOUT_MS } from "../../lib/http.js";
import { isAbortError, PermanentError } from "../../lib/errors.js";
import { moduleLogger } from "../../lib/logger.js";

const log = moduleLogger("openlist");

/** token 的本地有效期：官方 JWT 默认 48h，提前 1h 换新 */
const TOKEN_TTL_S = 47 * 3600;

export class OpenlistError extends Error {
  constructor(
    message: string,
    /** OpenList 响应体里的 code 或 HTTP 状态码 */
    public readonly code?: number,
    /** true = 连不上 / HTTP 层失败（值得重试）；false = OpenList 明确答复了失败 */
    public readonly transport = false,
  ) {
    super(message);
    this.name = "OpenlistError";
  }
}

/** OpenList 明确说没有这个路径（不是连不上）：object not found 等 */
export const isOpenlistMissing = (err: unknown): boolean =>
  err instanceof OpenlistError && !err.transport && /not found|不存在|no such/i.test(err.message);

/** OpenList 说这个路径不在任何存储下（failed get storage: storage not found）：多半是挂载根填错了 */
export const isOpenlistStorageMissing = (err: unknown): boolean =>
  err instanceof OpenlistError && !err.transport && /storage not found/i.test(err.message);

interface Envelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

/**
 * 拿一个可用的 token：缓存在 accounts 表里的还没过期就直接用，否则重新登录并写回。
 * updateAccount 是事务里的读改写，和界面保存账号互不覆盖。
 */
export async function openlistLogin(account: AccountOpenlist): Promise<string> {
  if (account.token && !(account.expiresAt && Date.now() / 1000 > account.expiresAt)) return account.token;
  let res: { data: Envelope<{ token?: string }> };
  try {
    res = await axios.post(
      `${account.url}/api/auth/login`,
      { username: account.account, password: account.password },
      { timeout: DEFAULT_TIMEOUT_MS },
    );
  } catch (err) {
    throw new OpenlistError(`OpenList 登录失败：${httpErrText(err)}`);
  }
  if (res.data.code !== 200) throw new OpenlistError(`OpenList 登录失败：${res.data.message ?? res.data.code}`, res.data.code);
  const token = res.data.data?.token;
  if (!token) throw new OpenlistError("OpenList 登录失败：没有拿到 token");
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  account.token = token;
  account.expiresAt = expiresAt;
  updateAccount(account.name, { token, expiresAt });
  return token;
}

function forgetToken(account: AccountOpenlist): void {
  account.token = undefined;
  account.expiresAt = undefined;
  updateAccount(account.name, { token: "", expiresAt: 0 });
}

function httpErrText(err: unknown): string {
  if (isAxiosError(err)) return err.response ? `HTTP ${err.response.status}` : err.message;
  return err instanceof Error ? err.message : String(err);
}

/** 走一次 OpenList 接口；token 失效（code/HTTP 401）就重登一次再试 */
async function request<T>(
  account: AccountOpenlist,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = await openlistLogin(account);
    let res: { data: Envelope<T> };
    try {
      res = await axios.request({
        url: `${account.url}${path}`,
        method,
        data: body,
        headers: { Authorization: token },
        timeout: DEFAULT_TIMEOUT_MS,
        signal,
      });
    } catch (err) {
      // 调用方自己掐的（任务取消）：原样抛出去，重试和日志那边靠 isAbortError 认它
      if (isAbortError(err)) throw err;
      if (isAxiosError(err) && err.response?.status === 401 && attempt === 0) {
        forgetToken(account);
        continue;
      }
      throw new OpenlistError(`OpenList ${path} 失败：${httpErrText(err)}`, isAxiosError(err) ? err.response?.status : undefined, true);
    }
    if (res.data.code === 200) return res.data.data as T;
    if (res.data.code === 401 && attempt === 0) {
      log.info(`OpenList token 失效，重新登录（账号 ${account.name}）`);
      forgetToken(account);
      continue;
    }
    throw new OpenlistError(`OpenList ${path} 失败：${res.data.message ?? res.data.code}`, res.data.code);
  }
}

/* ------------------------------- fs ------------------------------- */

export interface OpenlistFsEntry {
  name: string;
  is_dir: boolean;
  size?: number;
  /** ISO 时间 */
  modified?: string;
}

/** 列一个目录；refresh:true 绕过 OpenList 的缓存直接问上游存储 */
export async function openlistListDir(
  account: AccountOpenlist,
  path: string,
  { refresh = false, signal }: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<OpenlistFsEntry[]> {
  const data = await request<{ content: OpenlistFsEntry[] | null } | null>(
    account,
    "POST",
    "/api/fs/list",
    { path, page: 1, per_page: 0, refresh },
    signal,
  );
  return data?.content ?? [];
}

/** 文件的直链（OpenList 的 raw_url）。OpenList 明确说没有这个文件时是 PermanentError，别拿同一路径重试 */
export async function openlistRawUrl(account: AccountOpenlist, path: string, signal?: AbortSignal): Promise<string> {
  let data: { raw_url?: string } | null;
  try {
    data = await request<{ raw_url?: string } | null>(account, "POST", "/api/fs/get", { path }, signal);
  } catch (err) {
    // OpenList 已经明确答复了（多半是 object not found），两秒后再问答案也一样；连不上的照常重试
    if (err instanceof OpenlistError && !err.transport) throw new PermanentError(`Failed to get file info: ${err.message}`, { cause: err });
    throw err;
  }
  if (!data?.raw_url) throw new PermanentError(`No raw_url found for file: ${path}`);
  return data.raw_url;
}

/* ------------------------------- 复制任务 ------------------------------- */

export interface OpenlistTaskInfo {
  id: string;
  name: string;
  /** tache.State：老版本是数字（2=成功），也见过字符串，都留原样让 copyStateSucceeded 判 */
  state: unknown;
  /** 0-100 */
  progress: number;
  error: string;
  /** 结束时间（ms）；没结束或解析不了是 null */
  endedAt: number | null;
}

export function copyStateSucceeded(state: unknown): boolean {
  return state === 2 || state === "succeeded";
}

interface RawTask {
  id?: string;
  name?: string;
  state?: unknown;
  progress?: number;
  error?: string;
  end_time?: string | null;
}

function normalizeTask(raw: RawTask): OpenlistTaskInfo {
  let endedAt: number | null = null;
  if (raw.end_time) {
    const t = Date.parse(raw.end_time);
    // Go 的零值时间是 0001-01-01，解析出来是负数
    if (Number.isFinite(t) && t > 0) endedAt = t;
  }
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    state: raw.state,
    progress: typeof raw.progress === "number" ? raw.progress : 0,
    error: String(raw.error ?? ""),
    endedAt,
  };
}

/**
 * 提交复制。返回 OpenList 建出来的任务（同存储的立即完成会一个任务都没有）。
 * overwrite 固定 false：重复提交同一个磁力时宁可让复制失败，也别悄悄覆盖已有文件。
 */
export async function openlistCopy(
  account: AccountOpenlist,
  srcDir: string,
  dstDir: string,
  names: string[],
): Promise<OpenlistTaskInfo[]> {
  const data = await request<{ tasks?: RawTask[] } | null>(account, "POST", "/api/fs/copy", {
    src_dir: srcDir,
    dst_dir: dstDir,
    names,
    overwrite: false,
  });
  return (data?.tasks ?? []).map(normalizeTask);
}

/** 复制任务的进行中 + 已结束两张列表，一把抓回来给回执循环对号 */
export async function openlistCopyTasks(
  account: AccountOpenlist,
): Promise<{ undone: OpenlistTaskInfo[]; done: OpenlistTaskInfo[] }> {
  const [undone, done] = await Promise.all([
    request<RawTask[] | null>(account, "GET", "/api/task/copy/undone"),
    request<RawTask[] | null>(account, "GET", "/api/task/copy/done"),
  ]);
  return { undone: (undone ?? []).map(normalizeTask), done: (done ?? []).map(normalizeTask) };
}

/* ------------------------------- 写操作（整理用） ------------------------------- */

export async function openlistMkdir(account: AccountOpenlist, path: string, signal?: AbortSignal): Promise<void> {
  await request(account, "POST", "/api/fs/mkdir", { path }, signal);
}

export async function openlistRename(account: AccountOpenlist, path: string, name: string, signal?: AbortSignal): Promise<void> {
  await request(account, "POST", "/api/fs/rename", { path, name }, signal);
}

export async function openlistMove(account: AccountOpenlist, srcDir: string, dstDir: string, names: string[], signal?: AbortSignal): Promise<void> {
  if (names.length === 0) return;
  await request(account, "POST", "/api/fs/move", { src_dir: srcDir, dst_dir: dstDir, names }, signal);
}

export async function openlistRemove(account: AccountOpenlist, dir: string, names: string[], signal?: AbortSignal): Promise<void> {
  if (names.length === 0) return;
  await request(account, "POST", "/api/fs/remove", { dir, names }, signal);
}
