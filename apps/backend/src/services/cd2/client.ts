/**
 * CloudDrive2（CD2）的最小客户端：换令牌、看系统信息、列目录 / 强制刷新目录，复制引擎用的几个接口，
 * 以及 CD2 账号当网盘用（drive/providers/cd2.ts）要的找文件、改名、移动、删除、取下载地址、读令牌权限。
 *
 *   - CD2 只有 gRPC（默认 19798，明文 HTTP/2，和它的网页同端口），proto 在 https://www.clouddrive2.com/api/clouddrive.proto
 *     （对着 1.1.2 写的）；报文用 lib/protobuf.ts 手拼，传输用 lib/grpc.ts。
 *   - 鉴权是 metadata `authorization: Bearer <token>`。token 两种来源：CD2 设置页生成的 API 令牌直接用；
 *     没有令牌就 GetToken(用户名, 口令) 换 JWT，按 expiration 提前一小时在内存里缓存，UNAUTHENTICATED 时清掉重登一次。
 *   - GetSubFiles 是 server-streaming：forceRefresh=true 绕过 CD2 的目录缓存重新问网盘并写回缓存，
 *     社区的「CD2 目录自动刷新」工具用的就是它；我们只把流读完、数一下条目，不解文件详情。
 *   - 2026-11-10 对 lab 里的真 CD2 探测过的：找不到路径是 gRPC NOT_FOUND（`find by path: "…" not found under "…"`）；
 *     FindFileByPath 按「父目录 + 名字」传；下载地址不用另带 authorization、支持 Range、目录不给下载（INVALID_ARGUMENT）；
 *     GetApiTokenInfo 只有带「令牌管理」权限的令牌才给（普通令牌回 PERMISSION_DENIED）；
 *     改名撞名是 gRPC ALREADY_EXISTS（`rename error: "x" already exists in "…"`），源不存在是 NOT_FOUND——失败多半走状态码，
 *     不是 FileOperationResult.success=false（两种这里都当错误抛）；MoveFile 带 Skip 时撞名的原地不动、别的照挪、不报错，
 *     而且 resultFilePaths 是空的（挪成了的也不在里面）；CD2 自己改名 / 移动 / 删除之后，它的目录缓存当场就是新的；
 *     CreateFolder 对已存在的目录回成功、父目录不在会连父目录一起建；MoveFile 的源或目标目录不在是 NOT_FOUND；
 *     DeleteFile 对非空目录也照删（连里面的一起）。以上在本地文件夹存储和 115（开放平台）上表现一样。
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
  /** 最后修改时间（毫秒）；CD2 没给就没有 */
  modifiedAt?: number;
}

/** int64 走 varint：负数会解成一个巨大的无符号数，超出安全整数的一律当没给 */
const safeNumber = (v: bigint | undefined): number | undefined => (v !== undefined && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : undefined);

/** CloudDriveFile → 条目：name=2、size=4、fileType=5、writeTime=7（Timestamp{seconds=1}）、isDirectory=30。没有名字的不算 */
function parseFile(bytes: Uint8Array): Cd2Entry | null {
  const f = decodeMessage(bytes);
  const name = readString(f, 2);
  if (!name) return null;
  // isDirectory=30；老版本只有 fileType=5（0 = Directory，proto3 的 0 不发，所以没有这个字段就是目录）
  const isDir = readBool(f, 30) ?? (readUint(f, 5) ?? 0n) === 0n;
  const size = safeNumber(readUint(f, 4));
  const written = readMessages(f, 7)[0];
  const seconds = written ? (safeNumber(readUint(decodeMessage(written), 1)) ?? 0) : 0;
  return { name, isDir, ...(size !== undefined ? { size } : {}), ...(seconds > 0 ? { modifiedAt: seconds * 1000 } : {}) };
}

/** 列目录，每条带类型和大小。refresh 让 CD2 绕过自己的缓存重新问网盘（复制队列用）；浏览目录不要刷，走 CD2 的缓存 */
export async function cd2ListEntries(conn: Cd2Connection, path: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<Cd2Entry[]> {
  const replies = await call(conn, "GetSubFiles", concatBytes(encodeString(1, path), encodeBool(2, opts.refresh === true)), opts.signal, LIST_TIMEOUT_MS);
  const out: Cd2Entry[] = [];
  for (const r of replies) {
    for (const bytes of readMessages(decodeMessage(r), 1)) {
      const entry = parseFile(bytes);
      if (entry) out.push(entry);
    }
  }
  return out;
}

/** FileOperationResult{success=1, errorMessage=2}：success=false 当失败抛出来 */
function assertOperation(m: ReturnType<typeof decodeMessage>, method: string): void {
  if (readBool(m, 1) === true) return;
  throw new Cd2Error(`CD2 ${method} 失败：${readString(m, 2) || "CD2 没说原因"}`);
}

/**
 * CreateFolder：在 parentPath 下建一层。真机上（本地文件夹存储和 115 都试过）它其实是「已存在也回成功、父目录不在连父目录一起建」；
 * 这里不靠这一点：cd2EnsureDir 仍然逐级建，回「已存在」之类的错也吞得掉
 */
export async function cd2CreateFolder(conn: Cd2Connection, parentPath: string, folderName: string, signal?: AbortSignal): Promise<void> {
  const replies = await call(conn, "CreateFolder", concatBytes(encodeString(1, parentPath), encodeString(2, folderName)), signal);
  const result = readMessages(decodeMessage(replies[0] ?? new Uint8Array(0)), 2)[0];
  if (result) assertOperation(decodeMessage(result), "CreateFolder");
}

/** 「已存在」才算（gRPC ALREADY_EXISTS，或文案）；"does not exist" / "不存在" 是真失败（父目录或存储不在），不能吞 */
export const isCd2AlreadyExists = (err: unknown): boolean => {
  if (err instanceof Cd2Error && err.code === GRPC_STATUS.ALREADY_EXISTS) return true;
  return err instanceof Error && !/not exist|does not exist|不存在/i.test(err.message) && /already exist|exists|已存在|已经有/i.test(err.message);
};

/** 逐级建到 dir：存储根（第一段）不建，往下每一段「已存在」就跳过 */
export async function cd2EnsureDir(conn: Cd2Connection, dir: string, signal?: AbortSignal): Promise<void> {
  const segs = dir.split("/").filter(Boolean);
  for (let i = 1; i < segs.length; i++) {
    const parent = `/${segs.slice(0, i).join("/")}`;
    try {
      await cd2CreateFolder(conn, parent, segs[i], signal);
    } catch (err) {
      if (!isCd2AlreadyExists(err)) throw err;
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

/* ------------------------------- CD2 账号当网盘用的接口 ------------------------------- */

/**
 * FindFileByPath：按「父目录 + 名字」取一个条目，没有回 null。
 * CD2 明确说没有（NOT_FOUND 或文案）和回了个没名字的空报文都算没有
 */
export async function cd2FindFile(conn: Cd2Connection, parentPath: string, name: string, signal?: AbortSignal): Promise<Cd2Entry | null> {
  let replies: Uint8Array[];
  try {
    replies = await call(conn, "FindFileByPath", concatBytes(encodeString(1, parentPath), encodeString(2, name)), signal);
  } catch (err) {
    if (isCd2Missing(err)) return null;
    throw err;
  }
  return replies[0] ? parseFile(replies[0]) : null;
}

/** RenameFile：只改名字，不挪位置。目标名已经有了 CD2 回 ALREADY_EXISTS、源不在回 NOT_FOUND（也可能是 success=false），都当错误抛 */
export async function cd2Rename(conn: Cd2Connection, path: string, newName: string, signal?: AbortSignal): Promise<void> {
  const replies = await call(conn, "RenameFile", concatBytes(encodeString(1, path), encodeString(2, newName)), signal);
  assertOperation(decodeMessage(replies[0] ?? new Uint8Array(0)), "RenameFile");
}

/**
 * MoveFile：把这些路径挪进 destPath，名字不变。conflictPolicy Skip（=2）：目标里已有同名的不覆盖、也不自动改名——
 * 那一个原地不动，同一批里别的照挪，CD2 照样回成功。回包里的 resultFilePaths 真机上是空的（挪成了的也不在里面），
 * 所以这里不返回它：哪些没挪成由调用方去看源还在不在（drive/providers/cd2.ts）
 */
export async function cd2Move(conn: Cd2Connection, paths: string[], destPath: string, signal?: AbortSignal): Promise<void> {
  if (paths.length === 0) return;
  const body = concatBytes(...paths.map((p) => encodeString(1, p)), encodeString(2, destPath), encodeUint(3, 2));
  assertOperation(decodeMessage((await call(conn, "MoveFile", body, signal))[0] ?? new Uint8Array(0)), "MoveFile");
}

/** DeleteFile：网盘的普通删除，进不进回收站看那家网盘 */
export async function cd2Delete(conn: Cd2Connection, path: string, signal?: AbortSignal): Promise<void> {
  const replies = await call(conn, "DeleteFile", encodeString(1, path), signal);
  assertOperation(decodeMessage(replies[0] ?? new Uint8Array(0)), "DeleteFile");
}

export interface Cd2DownloadUrl {
  url: string;
  /** 多少秒后过期；没有就是不过期 */
  expiresIn?: number;
}

/**
 * GetDownloadUrlPath：这个文件经 CD2 自己下载的地址。CD2 回的是带占位符的路径
 * （`/static/{SCHEME}/{HOST}/{PREVIEW}/…`，后面带着访问用的查询参数），占位符换成 CD2 地址的协议、host:port 和 false，
 * 接在 CD2 地址后面。地址里带着凭据，别整条打进日志
 */
export async function cd2DownloadUrl(conn: Cd2Connection, path: string, signal?: AbortSignal): Promise<Cd2DownloadUrl> {
  const m = decodeMessage((await call(conn, "GetDownloadUrlPath", encodeString(1, path), signal))[0] ?? new Uint8Array(0));
  const urlPath = readString(m, 1);
  if (!urlPath) throw new Cd2Error(`CD2 GetDownloadUrlPath 失败：没有给下载地址（${path}）`);
  const expiresIn = safeNumber(readUint(m, 2));
  return { url: fillDownloadUrl(conn.url, urlPath), ...(expiresIn !== undefined ? { expiresIn } : {}) };
}

/** 把 CD2 回的带占位符的路径接到 CD2 地址后面：{SCHEME} / {HOST} / {PREVIEW} 换成协议、host:port、false */
export function fillDownloadUrl(cd2Url: string, urlPath: string): string {
  const base = new URL(normalizeCd2Url(cd2Url));
  const filled = urlPath
    .split("{SCHEME}")
    .join(base.protocol.replace(":", ""))
    .split("{HOST}")
    .join(base.host)
    .split("{PREVIEW}")
    .join("false");
  return `${base.origin}${filled.startsWith("/") ? "" : "/"}${filled}`;
}

/** API 令牌的权限里我们用得上的几项（括号里是 TokenPermissions 的字段号） */
export interface Cd2Permissions {
  /** allow_list(1)：GetSubFiles、FindFileByPath */
  list: boolean;
  /** allow_create_folder(4) */
  createFolder: boolean;
  /** allow_read(7)：下载文件 */
  read: boolean;
  /** allow_rename(8) */
  rename: boolean;
  /** allow_move(9) */
  move: boolean;
  /** allow_copy(10) */
  copy: boolean;
  /** allow_delete(11) */
  delete: boolean;
  /** allow_get_transfer_tasks(27)：GetCopyTasks */
  transferTasks: boolean;
}

export interface Cd2TokenInfo {
  /** 令牌限定的根目录；空串 = 没限 */
  rootDir: string;
  friendlyName: string;
  /** 多少秒后过期；没有 = 不过期 */
  expiresIn?: number;
  permissions: Cd2Permissions;
}

/**
 * GetApiTokenInfo：读这个连接用的 API 令牌自己的权限。用户名口令登录的没有令牌可查，回 null；
 * CD2 明确不给也回 null，调用方退回逐项探测——真 CD2 只有带「令牌管理」权限的令牌才给读（别的回 PERMISSION_DENIED：
 * token management permission required），所以平时多半是 null；老版本没有这个接口、不认这个令牌也算。连不上、令牌失效照常抛
 */
export async function cd2TokenInfo(conn: Cd2Connection, signal?: AbortSignal): Promise<Cd2TokenInfo | null> {
  const token = conn.apiToken?.trim();
  if (!token) return null;
  let replies: Uint8Array[];
  try {
    replies = await call(conn, "GetApiTokenInfo", encodeString(1, token), signal);
  } catch (err) {
    const refused: number[] = [GRPC_STATUS.PERMISSION_DENIED, GRPC_STATUS.UNIMPLEMENTED, GRPC_STATUS.NOT_FOUND];
    if (err instanceof Cd2Error && !err.transport && err.code !== undefined && refused.includes(err.code)) return null;
    throw err;
  }
  const m = decodeMessage(replies[0] ?? new Uint8Array(0));
  const p = decodeMessage(readMessages(m, 3)[0] ?? new Uint8Array(0));
  const has = (field: number): boolean => readBool(p, field) === true;
  const expiresIn = safeNumber(readUint(m, 4));
  return {
    rootDir: readString(m, 2) ?? "",
    friendlyName: readString(m, 5) ?? "",
    ...(expiresIn ? { expiresIn } : {}),
    permissions: { list: has(1), createFolder: has(4), read: has(7), rename: has(8), move: has(9), copy: has(10), delete: has(11), transferTasks: has(27) },
  };
}
