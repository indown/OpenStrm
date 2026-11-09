/**
 * CloudDrive2（CD2）的最小客户端：换令牌、看系统信息、列目录 / 强制刷新目录。
 *
 *   - CD2 只有 gRPC（默认 19798，明文 HTTP/2，和它的网页同端口），proto 在 https://www.clouddrive2.com/api/clouddrive.proto
 *     （对着 1.1.2 写的）；报文用 lib/protobuf.ts 手拼，传输用 lib/grpc.ts。
 *   - 鉴权是 metadata `authorization: Bearer <token>`。token 两种来源：CD2 设置页生成的 API 令牌直接用；
 *     没有令牌就 GetToken(用户名, 口令) 换 JWT，按 expiration 提前一小时在内存里缓存，UNAUTHENTICATED 时清掉重登一次。
 *   - GetSubFiles 是 server-streaming：forceRefresh=true 绕过 CD2 的目录缓存重新问网盘并写回缓存，
 *     社区的「CD2 目录自动刷新」工具用的就是它；我们只把流读完、数一下条目，不解文件详情。
 */
import { createHash } from "node:crypto";
import { GRPC_STATUS, GrpcError, grpcCall } from "../../lib/grpc.js";
import { isAbortError } from "../../lib/errors.js";
import { moduleLogger } from "../../lib/logger.js";
import { concatBytes, decodeMessage, encodeBool, encodeString, encodeUint, readBool, readMessages, readString, readUint } from "../../lib/protobuf.js";

const log = moduleLogger("cd2");

const SERVICE = "clouddrive.CloudDriveFileSrv";
/** JWT 没给过期时间时在内存里留多久（秒） */
const TOKEN_FALLBACK_TTL_S = 3600;
/** 提前多久换新（秒） */
const TOKEN_MARGIN_S = 3600;
/** 列目录的超时：forceRefresh 要 CD2 重新问网盘，几千条的目录在 115 限流下不止 30 秒 */
const LIST_TIMEOUT_MS = 5 * 60_000;

export interface Cd2Connection {
  /** 如 http://192.168.1.10:19798；没写协议按 http:// */
  url: string;
  /** CD2 设置页生成的 API 令牌，有它就不用用户名口令 */
  apiToken?: string;
  username?: string;
  password?: string;
}

export class Cd2Error extends Error {
  constructor(
    message: string,
    /** gRPC 状态码；连不上 / 超时没有 */
    public readonly code?: number,
    /** true = 连不上 / 超时（值得重试）；false = CD2 明确答复了失败 */
    public readonly transport = false,
  ) {
    super(message);
    this.name = "Cd2Error";
  }
}

/** CD2 明确说没有这个路径（不是连不上） */
export const isCd2Missing = (err: unknown): boolean =>
  err instanceof Cd2Error && !err.transport && (err.code === GRPC_STATUS.NOT_FOUND || /not found|不存在|no such|does not exist/i.test(err.message));

export function normalizeCd2Url(url: string): string {
  const t = url.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
}

/* ------------------------------- 令牌 ------------------------------- */

const tokens = new Map<string, { token: string; expiresAt: number }>();
/** 缓存键带口令的哈希：换了口令不能再命中旧令牌；哈希而不是原文，键里不留口令 */
const tokenKey = (conn: Cd2Connection): string =>
  `${normalizeCd2Url(conn.url)}|${conn.username ?? ""}|${createHash("sha256").update(conn.password ?? "").digest("hex").slice(0, 16)}`;

function wrap(err: unknown, method: string): never {
  if (isAbortError(err)) throw err;
  if (err instanceof GrpcError) throw new Cd2Error(`CD2 ${method} 失败：${err.message.replace(/^gRPC \S+ (失败：)?/, "")}`, err.code, err.transport);
  throw new Cd2Error(`CD2 ${method} 失败：${err instanceof Error ? err.message : String(err)}`, undefined, true);
}

/** 拿一个可用的 Bearer 令牌：API 令牌直接用；否则用缓存着的 JWT，没有或快过期就重新换 */
export async function cd2Token(conn: Cd2Connection, signal?: AbortSignal): Promise<string> {
  if (conn.apiToken?.trim()) return conn.apiToken.trim();
  const username = conn.username?.trim();
  if (!username || !conn.password) throw new Cd2Error("CD2 没有填 API 令牌，也没有填用户名和口令");
  const key = tokenKey(conn);
  const cached = tokens.get(key);
  const now = Math.floor(Date.now() / 1000);
  if (cached && now < cached.expiresAt) return cached.token;
  let replies: Uint8Array[];
  try {
    replies = await grpcCall(normalizeCd2Url(conn.url), SERVICE, "GetToken", concatBytes(encodeString(1, username), encodeString(2, conn.password)), { signal });
  } catch (err) {
    wrap(err, "GetToken");
  }
  const m = decodeMessage(replies[0] ?? new Uint8Array(0));
  if (readBool(m, 1) !== true || !readString(m, 3)) throw new Cd2Error(`CD2 登录失败：${readString(m, 2) || "没有拿到令牌"}`, GRPC_STATUS.UNAUTHENTICATED);
  const token = readString(m, 3)!;
  // expiration 是 google.protobuf.Timestamp{seconds=1}
  const exp = readMessages(m, 4)[0];
  const expSeconds = exp ? Number(readUint(decodeMessage(exp), 1) ?? 0n) : 0;
  const expiresAt = expSeconds > now ? Math.max(now + 60, expSeconds - TOKEN_MARGIN_S) : now + TOKEN_FALLBACK_TTL_S;
  tokens.set(key, { token, expiresAt });
  return token;
}

export function forgetCd2Token(conn: Cd2Connection): void {
  tokens.delete(tokenKey(conn));
}

/** 仅供测试 */
export function __test_resetCd2Tokens(): void {
  tokens.clear();
}

/** 带鉴权调一次；JWT 失效（UNAUTHENTICATED）就重登一次再试，API 令牌失效直接报 */
async function call(conn: Cd2Connection, method: string, body: Uint8Array, signal?: AbortSignal, timeoutMs?: number): Promise<Uint8Array[]> {
  for (let attempt = 0; ; attempt++) {
    const token = await cd2Token(conn, signal);
    try {
      return await grpcCall(normalizeCd2Url(conn.url), SERVICE, method, body, { authorization: `Bearer ${token}`, signal, timeoutMs });
    } catch (err) {
      if (err instanceof GrpcError && err.code === GRPC_STATUS.UNAUTHENTICATED && attempt === 0 && !conn.apiToken?.trim()) {
        log.info(`CD2 令牌失效，重新登录（${normalizeCd2Url(conn.url)}）`);
        forgetCd2Token(conn);
        continue;
      }
      wrap(err, method);
    }
  }
}

/* ------------------------------- 接口 ------------------------------- */

export interface Cd2SystemInfo {
  loggedIn: boolean;
  userName: string;
  systemReady: boolean;
  message?: string;
}

/** GetSystemInfo 不要鉴权：验地址通不通、CD2 自己登没登录 */
export async function cd2SystemInfo(conn: Cd2Connection, signal?: AbortSignal): Promise<Cd2SystemInfo> {
  let replies: Uint8Array[];
  try {
    replies = await grpcCall(normalizeCd2Url(conn.url), SERVICE, "GetSystemInfo", new Uint8Array(0), { signal });
  } catch (err) {
    wrap(err, "GetSystemInfo");
  }
  const m = decodeMessage(replies[0] ?? new Uint8Array(0));
  return { loggedIn: readBool(m, 1) === true, userName: readString(m, 2) ?? "", systemReady: readBool(m, 3) === true, message: readString(m, 4) };
}

/** 列目录，返回条目数；forceRefresh 让 CD2 绕过自己的目录缓存重新问网盘 */
async function listSubFiles(conn: Cd2Connection, path: string, forceRefresh: boolean, signal?: AbortSignal): Promise<number> {
  const replies = await call(conn, "GetSubFiles", concatBytes(encodeString(1, path), encodeBool(2, forceRefresh)), signal, LIST_TIMEOUT_MS);
  let count = 0;
  for (const r of replies) count += readMessages(decodeMessage(r), 1).length;
  return count;
}

/** 让 CD2 刷新这个目录的缓存（列一遍并写回），返回条目数 */
export const cd2RefreshDir = (conn: Cd2Connection, path: string, signal?: AbortSignal): Promise<number> => listSubFiles(conn, path, true, signal);

/** 按 CD2 现有的缓存列目录，返回条目数（检查配置用） */
export const cd2ListDir = (conn: Cd2Connection, path: string, signal?: AbortSignal): Promise<number> => listSubFiles(conn, path, false, signal);

/* ------------------------------- 复制引擎用的接口 ------------------------------- */

export interface Cd2Entry {
  name: string;
  isDir: boolean;
  size?: number;
}

/** 列目录，每条带类型和大小。refresh 让 CD2 绕过自己的缓存重新问网盘（复制队列用）；浏览目录不要刷，走 CD2 的缓存 */
export async function cd2ListEntries(conn: Cd2Connection, path: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<Cd2Entry[]> {
  const replies = await call(conn, "GetSubFiles", concatBytes(encodeString(1, path), encodeBool(2, opts.refresh === true)), opts.signal, LIST_TIMEOUT_MS);
  const out: Cd2Entry[] = [];
  for (const r of replies) {
    for (const bytes of readMessages(decodeMessage(r), 1)) {
      const f = decodeMessage(bytes);
      const name = readString(f, 2);
      if (!name) continue;
      // isDirectory=30；老版本只有 fileType=5（0 = Directory，proto3 的 0 不发，所以没有这个字段就是目录）
      const isDir = readBool(f, 30) ?? (readUint(f, 5) ?? 0n) === 0n;
      const size = readUint(f, 4);
      out.push({ name, isDir, ...(size !== undefined ? { size: Number(size) } : {}) });
    }
  }
  return out;
}

/** FileOperationResult{success=1, errorMessage=2}：success=false 当失败抛出来 */
function assertOperation(m: ReturnType<typeof decodeMessage>, method: string): void {
  if (readBool(m, 1) === true) return;
  throw new Cd2Error(`CD2 ${method} 失败：${readString(m, 2) || "CD2 没说原因"}`);
}

/** CreateFolder 不递归：在 parentPath 下建一层。已经有同名目录时 CD2 报错，由 cd2EnsureDir 吞掉 */
export async function cd2CreateFolder(conn: Cd2Connection, parentPath: string, folderName: string, signal?: AbortSignal): Promise<void> {
  const replies = await call(conn, "CreateFolder", concatBytes(encodeString(1, parentPath), encodeString(2, folderName)), signal);
  const result = readMessages(decodeMessage(replies[0] ?? new Uint8Array(0)), 2)[0];
  if (result) assertOperation(decodeMessage(result), "CreateFolder");
}

/** 「已存在」才算；"does not exist" / "不存在" 是真失败（父目录或存储不在），不能吞 */
const isAlreadyExists = (err: unknown): boolean =>
  err instanceof Error && !/not exist|does not exist|不存在/i.test(err.message) && /already exist|exists|已存在|已经有/i.test(err.message);

/** 逐级建到 dir：存储根（第一段）不建，往下每一段「已存在」就跳过 */
export async function cd2EnsureDir(conn: Cd2Connection, dir: string, signal?: AbortSignal): Promise<void> {
  const segs = dir.split("/").filter(Boolean);
  for (let i = 1; i < segs.length; i++) {
    const parent = `/${segs.slice(0, i).join("/")}`;
    try {
      await cd2CreateFolder(conn, parent, segs[i], signal);
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }
}

/** 提交复制：源路径们复制进 destPath。conflictPolicy Skip（=2）：目标已有同名的不覆盖，和 OpenList 那边 overwrite:false 一个意思 */
export async function cd2CopyFiles(conn: Cd2Connection, sourcePaths: string[], destPath: string, signal?: AbortSignal): Promise<void> {
  const body = concatBytes(...sourcePaths.map((p) => encodeString(1, p)), encodeString(2, destPath), encodeUint(3, 2));
  const replies = await call(conn, "CopyFile", body, signal);
  assertOperation(decodeMessage(replies[0] ?? new Uint8Array(0)), "CopyFile");
}

export type Cd2CopyStatus = "pending" | "scanning" | "scanned" | "completed" | "failed";
const COPY_STATUS: Cd2CopyStatus[] = ["pending", "scanning", "scanned", "completed", "failed"];

export interface Cd2CopyTask {
  sourcePath: string;
  destPath: string;
  status: Cd2CopyStatus;
  totalFiles: number;
  uploadedFiles: number;
  failedFiles: number;
  errors: string[];
  /** ms；没结束是 null */
  endedAt: number | null;
}

/** GetCopyTasks：CD2 里所有复制任务（一条任务对应一个源条目） */
export async function cd2CopyTasks(conn: Cd2Connection, signal?: AbortSignal): Promise<Cd2CopyTask[]> {
  const replies = await call(conn, "GetCopyTasks", new Uint8Array(0), signal);
  const out: Cd2CopyTask[] = [];
  for (const r of replies) {
    for (const bytes of readMessages(decodeMessage(r), 1)) {
      const t = decodeMessage(bytes);
      const end = readMessages(t, 18)[0];
      const endSeconds = end ? Number(readUint(decodeMessage(end), 1) ?? 0n) : 0;
      out.push({
        sourcePath: readString(t, 3) ?? "",
        destPath: readString(t, 4) ?? "",
        status: COPY_STATUS[Number(readUint(t, 5) ?? 0n)] ?? "pending",
        totalFiles: Number(readUint(t, 7) ?? 0n),
        uploadedFiles: Number(readUint(t, 10) ?? 0n),
        failedFiles: Number(readUint(t, 9) ?? 0n),
        errors: readMessages(t, 15).map((e) => readString(decodeMessage(e), 2) ?? "").filter(Boolean),
        endedAt: endSeconds > 0 ? endSeconds * 1000 : null,
      });
    }
  }
  return out;
}
