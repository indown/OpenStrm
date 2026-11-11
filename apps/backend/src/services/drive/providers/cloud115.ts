/**
 * 115 的 Provider：只是现有 cloud-115/{client,share}.ts 的适配层，那两个文件原样保留。
 * 分享能力已经接上；变更监控（生活事件）在 services/life/sources/cloud115.ts。
 */
import axios from "axios";
import type { Account115 } from "@openstrm/shared";
import { readAppSettings } from "../../../db/repositories/settings.js";
import { PermanentError } from "../../../lib/errors.js";
import { Cloud115ApiError, Cloud115Error, exportDirParse, fsBatchRename, fsDeleteMany, fsDirGetId, fsMkdir, fsMove, getDownloadUrlWeb, getIdToPath, listDirEntries, type DriveEntry as RawEntry } from "../../cloud-115/client.js";
import { dropSubtree, repathSubtree } from "../../../db/repositories/life.js";
import {
  getShareData,
  getShareDirList,
  getShareDownloadUrl,
  receiveToMyDrive,
  ShareApiError,
  shareExtractPayload,
  type ShareAttr,
} from "../../cloud-115/share.js";
import { forgetPathsUnder, rememberPath, rememberPaths } from "../../cloud-115/path-resolver.js";
import { Cloud115ChangeSource } from "../../life/sources/cloud115.js";
import { buildTree, collectFilesAndTopEmptyDirs, findExportedDir } from "../../task/tree.js";
import { classifyAccountIssue } from "../errors.js";
import { resolveSharePath } from "../share-walk.js";
import {
  RemoteDirNotFoundError,
  ShareGoneError,
  splitPath,
  type AccountIssue,
  type DriveEntry,
  type DriveLink,
  type DriveNode,
  type DriveProvider,
  type DriveWriteOps,
  type ReceiveItem,
  type ReceiveResult,
  type ShareEntry,
  type ShareInfo,
  type ShareListPage,
  type ShareProvider,
  type ShareRef,
  type ShareSession,
  type WriteNode,
} from "../types.js";

const VERIFY_NOTE = "115 的目录信息有几分钟缓存：刚转存进去或刚删掉的文件，几分钟内校验结果可能还是旧的";
const SHARE_HOSTS = /(^|\.)(115\.com|115cdn\.com|anxia\.com)$/i;
const SHARE_PAGE = 1000;

function userAgent(): string | undefined {
  const ua = readAppSettings()["user-agent"];
  return typeof ua === "string" && ua ? ua : undefined;
}

/** files 接口的原始字段：目录只有 cid，文件有 fid（cid 是父目录）、sha 是 sha1、pc 是 pick_code */
function toDriveEntry(raw: RawEntry): DriveEntry {
  const r = raw as RawEntry & { s?: number; pc?: string };
  const isDir = r.fid === undefined || r.fid === null || !r.sha;
  return {
    id: String(isDir ? r.cid : r.fid),
    name: r.n,
    isDir,
    size: r.s != null ? Number(r.s) : undefined,
    hash: r.sha ?? undefined,
    token: r.pc || undefined,
  };
}

function toShareEntry(it: ShareAttr): ShareEntry {
  return { id: String(it.id), name: it.name, isDir: it.is_dir, size: it.size, hash: it.sha1 };
}

/** 分享接口说「不行」：cookie 失效那种是账号问题，其余都是分享没了 */
function shareError(err: unknown): unknown {
  if (err instanceof ShareApiError) {
    if (classifyAccountIssue(err.message)) return err;
    return new ShareGoneError(err.message, err.errno);
  }
  return err;
}

/** 115 的分享：自家域名的 URL，或者裸分享码 / `码-提取码` 这类短写法；别家的 URL 一律不认 */
export function parse115ShareLink(text: string): ShareRef | null {
  const raw = text.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      return null;
    }
    if (!SHARE_HOSTS.test(host)) return null;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /\.[a-z]{2,}\//i.test(raw) || /\s/.test(raw)) {
    return null;
  }
  try {
    const { share_code, receive_code } = shareExtractPayload(raw);
    if (!share_code) return null;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://115.com/s/${share_code}${receive_code ? `?password=${receive_code}` : ""}`;
    return { kind: "115", code: share_code, password: receive_code, url };
  } catch {
    return null;
  }
}

class Cloud115Share implements ShareProvider {
  constructor(private readonly account: Account115) {}

  parseLink(text: string): ShareRef | null {
    return parse115ShareLink(text);
  }

  async open(ref: ShareRef): Promise<ShareSession> {
    return { ref };
  }

  async info(s: ShareSession): Promise<ShareInfo> {
    let data: Record<string, unknown>;
    try {
      data = await getShareData(this.account, s.ref.code, s.ref.password, { userAgent: userAgent() });
    } catch (err) {
      throw shareError(err);
    }
    const info = ((data.shareinfo ?? data.share_info ?? data) as Record<string, unknown>) ?? {};
    const title = String(info.share_title ?? info.share_name ?? info.name ?? info.title ?? s.ref.code).trim();
    const count = Number(info.file_size ?? info.file_count ?? 0) || undefined;
    return { title, fileCount: count };
  }

  async list(s: ShareSession, dirId: string, cursor?: string, opts?: { limit?: number }): Promise<ShareListPage> {
    const offset = Number(cursor ?? 0) || 0;
    const limit = Math.max(1, Math.min(opts?.limit ?? SHARE_PAGE, SHARE_PAGE));
    let page: { list: ShareAttr[]; count: number; title?: string };
    try {
      page = await getShareDirList(this.account, s.ref.code, s.ref.password, dirId || "0", {
        limit,
        offset,
        userAgent: userAgent(),
      });
    } catch (err) {
      throw shareError(err);
    }
    const entries = page.list.map(toShareEntry);
    const end = offset + page.list.length;
    return {
      entries,
      next: page.list.length > 0 && end < page.count ? String(end) : undefined,
      total: page.count,
      ...(page.title ? { title: page.title } : {}),
    };
  }

  resolvePath(s: ShareSession, path: string, signal?: AbortSignal): Promise<ShareEntry | null> {
    return resolveSharePath(this, s, path, signal);
  }

  async receive(s: ShareSession, items: ReceiveItem[], toDirId: string): Promise<ReceiveResult> {
    try {
      await receiveToMyDrive(this.account, s.ref.code, s.ref.password, items.map((i) => i.id), toDirId, { userAgent: userAgent() });
    } catch (err) {
      throw shareError(err);
    }
    return {};
  }

  async downloadUrl(s: ShareSession, fileId: string): Promise<string> {
    try {
      return await getShareDownloadUrl(this.account, s.ref.code, s.ref.password, fileId, { userAgent: userAgent() });
    } catch (err) {
      throw shareError(err);
    }
  }
}

interface ClientDeps {
  fsDirGetId: typeof fsDirGetId;
}
const realDeps: ClientDeps = { fsDirGetId };
let deps: ClientDeps = { ...realDeps };
/** 测试用：换掉打 115 的函数；传 null 恢复 */
export function setCloud115ProviderDeps(partial: Partial<ClientDeps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/** 115 批量接口一次带多少个：改名 / 移动接口没写上限，保守一点 */
const WRITE_BATCH = 50;

export class Cloud115Provider implements DriveProvider {
  readonly kind = "115" as const;
  readonly capabilities = { share: true, changes: true, write: true };
  readonly rootId = "0";
  readonly pathIds = false;
  readonly notes = { verify: VERIFY_NOTE };
  readonly share: ShareProvider;
  readonly changes: Cloud115ChangeSource;
  readonly write: DriveWriteOps;

  constructor(readonly account: Account115) {
    this.share = new Cloud115Share(account);
    this.changes = new Cloud115ChangeSource(account);
    this.write = new Cloud115Write(account, (signal) => this.ctx(signal));
  }

  /** 列过的目录写进路径缓存（内存 + path_cache 表）：变更监控靠它把事件里的 id 还原成路径、找移动前的旧路径 */
  rememberListing(dirPath: string, entries: DriveEntry[]): void {
    const dir = `/${splitPath(dirPath).join("/")}`;
    rememberPaths(
      entries.map((e) => ({
        fileId: e.id,
        parentId: "",
        name: e.name,
        path: dir === "/" ? `/${e.name}` : `${dir}/${e.name}`,
        isDir: e.isDir,
        accountName: this.account.name,
      })),
    );
  }

  private ctx(signal?: AbortSignal) {
    return { accountInfo: this.account, userAgent: userAgent(), signal };
  }

  /** getid 只认目录（不存在回 0）；回 0 时再看父目录里有没有同名文件 */
  async resolvePath(path: string, signal?: AbortSignal): Promise<DriveNode | null> {
    const segs = splitPath(path);
    if (segs.length === 0) return { id: "0", isDir: true };
    const dirId = await this.dirId(segs.join("/"), signal);
    if (dirId) return { id: dirId, isDir: true };
    const parentId = segs.length === 1 ? "0" : await this.dirId(segs.slice(0, -1).join("/"), signal);
    if (!parentId) return null;
    const name = segs[segs.length - 1];
    const hit = (await listDirEntries(parentId, this.ctx(signal))).find((e) => e.n === name);
    if (!hit) return null;
    const entry = toDriveEntry(hit);
    return { id: entry.id, isDir: entry.isDir };
  }

  /** 目录 id；不存在是 null。接口对坏路径可能直接报错，那也是「没有」 */
  /**
   * 115 对不存在的路径回 id 0，这才是「目录不存在」；cookie 失效、超时这些是原样抛出的错误，
   * 不能把它们也说成目录不存在——同步会误报「源目录已改名」，cookie 告警也发不出来
   */
  private async dirId(path: string, signal?: AbortSignal): Promise<string | null> {
    const res = (await deps.fsDirGetId(path, this.ctx(signal))) as { id?: number | string } | undefined;
    const id = res?.id == null ? "" : String(res.id);
    return id && id !== "0" ? id : null;
  }

  async listDir(id: string, signal?: AbortSignal, opts?: { fresh?: boolean }): Promise<DriveEntry[]> {
    return (await listDirEntries(id || "0", this.ctx(signal), undefined, { fresh: opts?.fresh })).map(toDriveEntry);
  }

  /**
   * 115 有整树导出：导出目录树文件再解析。导出的树从上一级开始（导出 tv/Show 得到 tv → Show → …），
   * 把顶层当成目录本身会多套一层 Show/Show/…，所以要用 findExportedDir 定位到目标目录再摊平。
   */
  async listSubtree(path: string, opts?: { id?: string; signal?: AbortSignal }): Promise<string[]> {
    let folderId = opts?.id && opts.id !== "0" ? opts.id : null;
    if (!folderId) folderId = await this.dirId(splitPath(path).join("/"), opts?.signal);
    if (!folderId) throw new RemoteDirNotFoundError(path);
    const raw = await exportDirParse({
      exportFileIds: folderId,
      targetPid: 0,
      layerLimit: 0,
      deleteAfter: true,
      timeoutMs: 300000,
      checkIntervalMs: 1000,
      accountInfo: this.account,
      // 导出要等、下载要等、解析还要等：取消的时候这三步都得停，别再替一个没人要的结果打 115
      signal: opts?.signal,
    });
    const tree = buildTree(raw);
    const dir = findExportedDir(tree, path);
    if (!dir) {
      const tops = tree.filter((n) => n.name).map((n) => n.name).join("、");
      throw new Error(`导出的目录树里找不到 ${path}（顶层：${tops || "空"}）`);
    }
    return collectFilesAndTopEmptyDirs(dir.children ?? []);
  }

  async downloadLink(path: string, opts?: { token?: string; signal?: AbortSignal }): Promise<DriveLink> {
    let pickcode: string | number | undefined = opts?.token;
    if (!pickcode) pickcode = await getIdToPath({ path, userAgent: userAgent(), accountInfo: this.account, signal: opts?.signal });
    if (!pickcode) throw new PermanentError(`No pickcode found for file: ${path}`);
    const url = await getDownloadUrlWeb(pickcode, this.ctx(opts?.signal));
    if (!url) throw new PermanentError(`No download url for file: ${path}`);
    return { url };
  }

  classifyError(err: unknown): AccountIssue | null {
    if (err instanceof ShareGoneError) return "gone";
    // 只按接口回来的文案猜（HTTP 非 2xx、业务错误、分享接口、直链的响应）：我们自己拼的错误（找不到路径、下载没数据）
    // message 里带用户的目录名，目录名里的「405」「cookie」会把整轮当成风控
    if (err instanceof Cloud115Error || err instanceof Cloud115ApiError || err instanceof ShareApiError || (axios.isAxiosError(err) && err.response)) {
      const issue = classifyAccountIssue(err.message);
      if (issue === "cookie") return "auth";
      if (issue === "blocked") return "blocked";
    }
    if (err instanceof ShareApiError) return "gone";
    return null;
  }
}

const joinPan = (dir: string, name: string): string => (dir === "/" || dir === "" ? `/${name}` : `${dir}/${name}`);
const parentOf = (p: string): string => `/${splitPath(p).slice(0, -1).join("/")}`;

/**
 * 115 的写操作。每一步都同步维护 path_cache（内存 + 表）：整理完之后生活事件流会把这些改名 / 移动再报一遍，
 * 监控靠缓存里的路径认出「这是整理自己做的」并跳过；目录挪走后其下所有缓存路径也要跟着改（repathSubtree）。
 */
class Cloud115Write implements DriveWriteOps {
  constructor(
    private readonly account: Account115,
    private readonly ctx: (signal?: AbortSignal) => { accountInfo: Account115; userAgent?: string; signal?: AbortSignal },
  ) {}

  private noteRelocated(node: WriteNode, newPath: string): void {
    const name = newPath.slice(newPath.lastIndexOf("/") + 1);
    if (node.isDir) {
      repathSubtree(node.path, newPath);
      forgetPathsUnder(this.account.name, node.path);
    }
    rememberPath({ fileId: node.id, parentId: "", name, path: newPath, isDir: node.isDir, accountName: this.account.name });
  }

  async mkdir(parent: { id: string; path: string }, name: string, signal?: AbortSignal): Promise<DriveNode> {
    const id = await fsMkdir(name, parent.id, this.ctx(signal));
    rememberPath({ fileId: id, parentId: parent.id, name, path: joinPan(parent.path, name), isDir: true, accountName: this.account.name });
    return { id, isDir: true };
  }

  async rename(node: WriteNode, newName: string, signal?: AbortSignal): Promise<{ id: string }> {
    const [r] = await this.renameMany([{ node, newName }], signal);
    return r;
  }

  async renameMany(items: Array<{ node: WriteNode; newName: string }>, signal?: AbortSignal): Promise<Array<{ id: string }>> {
    for (let i = 0; i < items.length; i += WRITE_BATCH) {
      const batch = items.slice(i, i + WRITE_BATCH);
      await fsBatchRename(batch.map(({ node, newName }) => [node.id, newName]), this.ctx(signal));
      for (const { node, newName } of batch) this.noteRelocated(node, joinPan(parentOf(node.path), newName));
    }
    return items.map(({ node }) => ({ id: node.id }));
  }

  async move(nodes: WriteNode[], to: { id: string; path: string }, signal?: AbortSignal): Promise<Array<{ id: string }>> {
    for (let i = 0; i < nodes.length; i += WRITE_BATCH) {
      const batch = nodes.slice(i, i + WRITE_BATCH);
      await fsMove(batch.map((n) => n.id), to.id, this.ctx(signal));
      for (const node of batch) this.noteRelocated(node, joinPan(to.path, node.path.slice(node.path.lastIndexOf("/") + 1)));
    }
    return nodes.map((n) => ({ id: n.id }));
  }

  async rmdirIfEmpty(node: WriteNode, signal?: AbortSignal): Promise<boolean> {
    const entries = await listDirEntries(node.id, this.ctx(signal));
    if (entries.length > 0) return false;
    await fsDeleteMany([node.id], this.ctx(signal));
    dropSubtree(node.path);
    forgetPathsUnder(this.account.name, node.path);
    return true;
  }

  /** 115 的删除是进回收站 */
  async remove(node: WriteNode, signal?: AbortSignal): Promise<void> {
    await fsDeleteMany([node.id], this.ctx(signal));
    dropSubtree(node.path);
    forgetPathsUnder(this.account.name, node.path);
  }
}
