/**
 * 网盘 Provider：同步任务、目录浏览、直链、分享转存、追更、变更监控都只认这组接口，
 * 具体网盘（115 / 夸克 / OpenList）各自实现一份放在 providers/ 下，registry 按账号类型分派。
 * 加一种网盘 = 写一个 Provider + 在 registry 登记；功能代码里不该再出现 `accountType === "..."`。
 *
 * 约定：
 *   - id 一律是字符串（115 的 id 超过 JS 安全整数）；根目录 id 见 provider.rootId。
 *   - 路径用 `/` 分段、不带尾斜杠；有没有前导 `/` 都认。
 *   - 找不到就返回 null 或抛 RemoteDirNotFoundError，绝不返回 "0" 之类的假 id（115 getid 对不存在的路径回 0）。
 *   - 账号级问题（cookie 失效、被风控、分享没了）由 classifyError 归类，功能代码不再用正则认各家的中文。
 */
import type { AccountInfo, LifePullMode, TaskDefinition } from "@openstrm/shared";
import { PermanentError } from "../../lib/errors.js";

export type DriveKind = AccountInfo["accountType"];

/** 目录里的一项 */
export interface DriveEntry {
  id: string;
  name: string;
  isDir: boolean;
  size?: number;
  /** 内容哈希（115 sha1）；夸克没有 */
  hash?: string;
  /** 取直链时能省一次查询的凭据：115 pick_code，夸克 fid */
  token?: string;
  /** 毫秒 */
  modifiedAt?: number;
  /** 目录的直接子项数（夸克 include_items）；别家不填 */
  items?: number;
}

export interface DriveNode {
  id: string;
  isDir: boolean;
}

export interface DriveLink {
  url: string;
  /** 取文件时必须一起带的头（夸克直链和 cookie / UA 绑定） */
  headers?: Record<string, string>;
}

/** walkSubtree 给的一项：相对根的路径 + 元数据，快照对比用 */
export interface SubtreeEntry {
  path: string;
  id: string;
  isDir: boolean;
  size?: number;
  modifiedAt?: number;
  /** 目录的直接子项数（夸克 include_items）；别家不填 */
  items?: number;
}

/**
 * 目录的指纹：夸克上直接子项新增 / 移入 / 改名会刷新目录的 updated_at（modifiedAt），删除 / 移出不刷新但子项数会变。
 * 两样合起来和上次一样，就说明这个目录的直接子项没变（刷新后约 5.5 秒内的改名会被节流吞掉，快照源另有兜底）
 */
export interface DirFingerprint {
  id: string;
  modifiedAt: number;
  items: number;
}

/** 读操作的附加选项。background：网盘监控这类后台轮询发的请求，走账号的 life 通道，不占界面和同步用的 normal 并发 */
export interface ReadOptions {
  signal?: AbortSignal;
  background?: boolean;
}

export type AccountIssue = "auth" | "blocked" | "gone";

export interface DriveCapabilities {
  share: boolean;
  changes: boolean;
  /** 能改名 / 移动 / 建目录：整理功能只对有这项能力的网盘开放 */
  write: boolean;
}

/** 写操作的对象：id + 当前绝对路径（带前导 /）。路径给各家维护自己的缓存用（115 的 path_cache、夸克的路径缓存） */
export interface WriteNode {
  id: string;
  path: string;
  isDir: boolean;
}

/**
 * 网盘写操作（整理用）。约定：
 *   - 改名 / 移动 / 建目录 / 删空目录；删文件只在用户对某个冲突明确选了删除 / 覆盖时才会调 remove，整理自己永远不删。
 *   - 返回改动后的 id：115 / 夸克的 id 不变，OpenList 的 id 就是路径，改名 / 移动后会变。
 *   - 各家自己更新缓存（115 的 path_cache 让监控之后还能认出旧路径）。
 */
export interface DriveWriteOps {
  mkdir(parent: { id: string; path: string }, name: string, signal?: AbortSignal): Promise<DriveNode>;
  rename(node: WriteNode, newName: string, signal?: AbortSignal): Promise<{ id: string }>;
  /** 批量改名（115 一次一批）；没实现就逐个 rename */
  renameMany?(items: Array<{ node: WriteNode; newName: string }>, signal?: AbortSignal): Promise<Array<{ id: string }>>;
  /** 挪到另一个目录，名字不变；返回挪动后的 id，顺序同入参 */
  move(nodes: WriteNode[], to: { id: string; path: string }, signal?: AbortSignal): Promise<Array<{ id: string }>>;
  /** 目录空了才删；非空返回 false */
  rmdirIfEmpty(node: WriteNode, signal?: AbortSignal): Promise<boolean>;
  /**
   * 删掉一个文件：只有用户在整理的冲突上选了「删掉这一份」/「覆盖」才调。
   * 115 / 夸克进回收站，OpenList 看存储后端（本地存储是直接删）
   */
  remove(node: WriteNode, signal?: AbortSignal): Promise<void>;
}

export interface DriveProvider {
  readonly kind: DriveKind;
  readonly account: AccountInfo;
  readonly capabilities: DriveCapabilities;
  /** 根目录 id：115 / 夸克是 "0"，OpenList 是 "/" */
  readonly rootId: string;
  resolvePath(path: string, signal?: AbortSignal): Promise<DriveNode | null>;
  /**
   * fresh：绕过网盘客户端自己的目录缓存（115 进程内缓存 5 分钟），整理动手前看目标目录有没有同名文件时用。
   * background：后台监控发的（夸克走 life 通道）；别家忽略
   */
  listDir(id: string, signal?: AbortSignal, opts?: { fresh?: boolean; background?: boolean }): Promise<DriveEntry[]>;
  /**
   * 子树里的文件 + 没有文件的顶层空目录，相对 path（同步任务对照、重生成、转存后建 strm 都用它）。
   * 目录不存在抛 RemoteDirNotFoundError。已知目录 id 时传 id 省一次解析。
   */
  listSubtree(path: string, opts?: { id?: string; signal?: AbortSignal }): Promise<string[]>;
  /** 子树里的每一个节点（目录也在）及其元数据；只有能做快照监控的网盘实现 */
  walkSubtree?(path: string, opts?: { id?: string } & ReadOptions): Promise<SubtreeEntry[]>;
  /**
   * 按绝对路径批量取目录的指纹（夸克 path_list，一次 50 个，这里内部分批）。只回找得到的目录，键是传进来的路径；
   * 文件、不存在的路径不回。只有能做指纹增量监控的网盘实现，没有它快照源每轮整棵列
   */
  dirFingerprints?(paths: string[], opts?: ReadOptions): Promise<Map<string, DirFingerprint>>;
  downloadLink(path: string, opts?: { token?: string; signal?: AbortSignal }): Promise<DriveLink>;
  classifyError(err: unknown): AccountIssue | null;
  /** 列过某个目录后把结果告诉网盘（115 借它维护 id → 路径缓存，变更监控靠它找移动前的旧路径）；别家不用实现 */
  rememberListing?(dirPath: string, entries: DriveEntry[]): void;
  /** 给界面看的提示：校验页那句「115 目录信息有几分钟缓存」 */
  readonly notes?: { verify?: string };
  readonly share?: ShareProvider;
  readonly changes?: ChangeSource;
  readonly write?: DriveWriteOps;
}

/* ------------------------------- 分享 ------------------------------- */

export interface ShareRef {
  kind: DriveKind;
  /** 115 share_code / 夸克 pwd_id */
  code: string;
  /** 提取码，没有就是空串 */
  password: string;
  /** 原始链接（没有就按 code 拼一个） */
  url: string;
}

export interface ShareEntry {
  id: string;
  name: string;
  isDir: boolean;
  size?: number;
  hash?: string;
  /** 转存凭据：夸克 share_fid_token；115 没有 */
  token?: string;
  modifiedAt?: number;
}

export interface ShareSession {
  ref: ShareRef;
  /** 夸克 stoken；115 没有 */
  token?: string;
}

export interface ShareInfo {
  title: string;
  fileCount?: number;
}

export interface ReceiveItem {
  id: string;
  token?: string;
  /**
   * 条目所在的目录。夸克的 share_fid_token 跟着会话（stoken）走，stoken 缓存半小时：影库里记下的、弹框开了很久的
   * token 已经不是这次会话的了。给了这个，夸克就在这次会话里把那一层重新列一遍换新的
   */
  parentId?: string;
}

export interface ReceiveResult {
  /** 转存进网盘后的顶层 id：夸克 save_as_top_fids；115 没有 */
  topIds?: string[];
}

/** 服务端「相对上次转存有没有新增」的信号：none = 明确没有；some = 有；unknown = 认不出（这个账号没转存过、接口不通） */
export type ShareUpdateSignal = "none" | "some" | "unknown";

/** 夸克才有：追更先问一句，明确没更新就不用整棵列目录（services/follow/service.ts 只信有限次） */
export interface ShareUpdates {
  check(session: ShareSession, signal?: AbortSignal): Promise<ShareUpdateSignal>;
}

export interface ShareListPage {
  entries: ShareEntry[];
  /** 没有就是列完了 */
  next?: string;
  total?: number;
  /** 分享的标题：顺路拿得到才给（夸克在 stoken 里，115 在同一个响应里），拿不到的调用方再调 info */
  title?: string;
}

export interface ShareProvider {
  /** 只认自家的链接；认不出返回 null，registry 据此挑账号 */
  parseLink(text: string): ShareRef | null;
  /** 夸克换 stoken（按 pwd_id + 提取码缓存）；115 空操作 */
  open(ref: ShareRef, signal?: AbortSignal): Promise<ShareSession>;
  info(session: ShareSession, signal?: AbortSignal): Promise<ShareInfo>;
  /** 翻页游标不透明：115 是 offset，夸克是页码。limit 只是上限建议，各家按自己的页大小来 */
  list(session: ShareSession, dirId: string, cursor?: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<ShareListPage>;
  /** 按分享内路径逐级找（影库条目转存用）；空路径返回 null（就是根） */
  resolvePath(session: ShareSession, path: string, signal?: AbortSignal): Promise<ShareEntry | null>;
  /** 转存到我的网盘目录，阻塞到完成 */
  receive(session: ShareSession, items: ReceiveItem[], toDirId: string, signal?: AbortSignal): Promise<ReceiveResult>;
  /** 分享内文件的直链；只有 115 有 */
  downloadUrl?(session: ShareSession, fileId: string): Promise<string>;
  readonly updates?: ShareUpdates;
}

/* ------------------------------- 变更监控 ------------------------------- */

export type ChangeKind = "create" | "remove" | "move" | "rename" | "folder";

export interface ChangeEvent {
  /** 全局唯一：115 用事件 id，夸克合成 `q:<账号>:<扫描时间>:<kind>:<fid>` */
  id: string;
  kind: ChangeKind;
  /** 网盘绝对路径（新路径），带前导 / */
  path: string;
  /** move / rename 的旧路径；不知道就是 null，处理时退化成新增 */
  oldPath: string | null;
  isDir: boolean;
  nodeId: string;
  size?: number;
  hash?: string;
  /** 取直链用的凭据：115 pick_code，夸克 fid */
  token?: string;
  /** unix 秒 */
  at: number;
  /** 来源没法把它变成完整事件（115 的父目录解析不出来之类）：监控只记一笔 skipped，不处理 */
  problem?: string;
  /** 来源自己的事件类型码（115 的 behavior type），只用于展示 */
  rawType?: number;
}

export interface ChangeCursor {
  time: number;
  id: string;
}

export type ChangeLog = (level: "info" | "warn" | "error" | "debug", msg: string) => void;

export interface PrepareResult {
  ok: boolean;
  message: string;
  /** 值得告警的原因（cookie 失效 / 风控）；没有就不发通知 */
  reason?: string;
  /** 来源用网盘自己的规则认出的问题；不给就由通知那边从 reason 文案猜 */
  issue?: AccountIssue | null;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  events?: Array<{ id: string; kind: string; name: string; at: number }>;
}

export interface PullOptions {
  tasks: TaskDefinition[];
  signal: AbortSignal;
  log?: ChangeLog;
}

/**
 * pull 交出来的一条：id / at 先给监控做去重和推游标；resolve 在交给处理器前一刻才把它变成完整事件——
 * 115 在这里查旧路径、更新路径缓存，这样一轮中途被打断，没处理到的事件下轮重拉时缓存还是旧的
 */
export interface PendingChange {
  id: string;
  at: number;
  resolve(): Promise<ChangeEvent>;
  /** 这条处理完之后该存的游标；事件流来源（115）逐条给，快照来源不给（它的事件 id 不是游标） */
  cursor?: ChangeCursor;
}

/** 已经是完整事件的来源（夸克快照、测试桩）用它包一下 */
export function resolvedChange(ev: ChangeEvent): PendingChange {
  return { id: ev.id, at: ev.at, resolve: async () => ev };
}

export interface PullResult {
  changes: PendingChange[];
  cursor: ChangeCursor;
  /**
   * 这轮的事件全部处理完（没被中止）后由监控调用，带上处理失败的事件 id；
   * 快照式来源在这里才把新快照写库，失败的那些条目不记进去，下轮重新对比会再发一次
   */
  commit?(failedIds: string[]): void;
  /** 这轮有一部分没拉到（某个根列不了）的说明；监控记进 lastError 让人看见，但不按整轮失败退避 */
  warnings?: string[];
}

export interface ChangeSource {
  /** 状态页「接口」列：proapi / webapi / snapshot */
  readonly label: string;
  readonly minIntervalSeconds: number;
  /** 启动门禁：115 开生活事件开关并试拉一条；夸克列根目录验 cookie。被中止时原样抛出 */
  prepare(signal: AbortSignal, log?: ChangeLog): Promise<PrepareResult>;
  initialCursor(mode: LifePullMode, saved: ChangeCursor | null): ChangeCursor;
  pull(cursor: ChangeCursor, opts: PullOptions): Promise<PullResult>;
  /** 页面上「测试连接」：只看不处理 */
  probe?(limit: number, signal?: AbortSignal): Promise<ProbeResult>;
}

/* ------------------------------- 错误 ------------------------------- */

/** 网盘上没有这个目录 */
export class RemoteDirNotFoundError extends PermanentError {
  constructor(readonly dirPath: string) {
    super(`网盘上不存在目录：${dirPath}`);
    this.name = "RemoteDirNotFoundError";
  }
}

/** 分享已取消 / 过期、提取码不对：换多少次都一样，追更连续几次就判失效 */
export class ShareGoneError extends PermanentError {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "ShareGoneError";
  }
}

/** 路径工具：去掉首尾斜杠后按 / 分段，段两边空白去掉 */
export function splitPath(path: string): string[] {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 归一化成 `/a/b`（根是 `/`） */
export function normalizePath(path: string): string {
  const segs = splitPath(path);
  return segs.length === 0 ? "/" : `/${segs.join("/")}`;
}
