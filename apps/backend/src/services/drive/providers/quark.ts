/**
 * 夸克网盘的 Provider。同步 / 浏览 / 直链走 quark/client.ts，分享走 quark/share.ts；快照变更源在 services/life/sources/quark.ts。
 * 夸克没有整树导出：子树靠逐层列目录，同一层的目录并发列（在飞上限 4，真正的节流是账号限流器）。
 * 名字里带 / 的条目按路径根本找不回来，跳过并告警。
 * 监控不用每轮整棵列：dirFingerprints 按路径批量取目录指纹（updated_at + include_items），快照源只列变了的目录。
 */
import type { AccountQuark } from "@openstrm/shared";
import { mapLimit } from "../../../lib/async.js";
import { PermanentError } from "../../../lib/errors.js";
import { moduleLogger } from "../../../lib/logger.js";
import {
  forgetQuarkPaths,
  QuarkError,
  quarkDelete,
  quarkDownloadLink,
  quarkListDir,
  quarkMkdir,
  quarkMove,
  quarkPathList,
  quarkRename,
  quarkResolvePath,
  rememberQuarkDir,
  type QuarkEntry,
  type QuarkTaskHandle,
} from "../../quark/client.js";
import {
  QUARK_SHARE_PAGE_SIZE,
  QuarkShareError,
  quarkShareList,
  quarkShareSave,
  quarkShareToken,
  quarkWaitTask,
  type QuarkShareFile,
  quarkShareIncUpdate,
  forgetQuarkShareToken,
  peekQuarkShareToken,
} from "../../quark/share.js";
import { QuarkSnapshotSource } from "../../life/sources/quark.js";
import { listWholeShareDir, resolveSharePath } from "../share-walk.js";
import { syncViewFromPaths } from "../subtree.js";
import {
  RemoteDirNotFoundError,
  ShareGoneError,
  type AccountIssue,
  type DirFingerprint,
  type DriveEntry,
  type DriveLink,
  type DriveNode,
  type DriveProvider,
  type DriveWriteOps,
  type ReadOptions,
  type ReceiveItem,
  type ReceiveResult,
  type ShareEntry,
  type ShareInfo,
  type ShareListPage,
  type ShareProvider,
  type ShareRef,
  type ShareSession,
  type SubtreeEntry,
  type ShareUpdates,
  type WriteNode,
} from "../types.js";

const log = moduleLogger("quark");

function toEntry(e: QuarkEntry): DriveEntry {
  return { id: e.fid, name: e.name, isDir: e.isDir, size: e.size, token: e.fid, modifiedAt: e.modifiedAt || undefined, ...(e.isDir ? { items: e.items } : {}) };
}

/** 后台监控发的请求走 life 通道，不占界面和同步用的 normal 并发（每秒请求数是账号共用的，不变） */
const channelOf = (opts?: { background?: boolean }) => (opts?.background ? "life" : "normal") as "life" | "normal";

function toShareEntry(f: QuarkShareFile): ShareEntry {
  return { id: f.fid, name: f.name, isDir: f.isDir, size: f.isDir ? undefined : f.size, token: f.token, modifiedAt: f.modifiedAt || undefined };
}

/* ------------------------------- 分享 ------------------------------- */

/**
 * 查询串只读到 #（往后是网页里的片段 #/list/share）、空白、引号或者第一个非 ASCII 字符为止：
 * 链接外面包着的「」【】这类中文标点不能粘进提取码
 */
const SHARE_URL = /https?:\/\/pan\.quark\.cn\/s\/([a-z0-9]+)(\?[^\s"'<>#\u0080-\uffff]*)?/i;
/** 链接后面另写的提取码（提取码 / 访问码 / 密码 / 口令，「解压密码」不算）：和 drive/registry.ts 的同名正则一样 */
const PASSCODE_IN_TEXT = /(?:提取码|访问码|(?<!解压)密码|口令)\s*[:：]?\s*([a-z0-9]{4,8})/i;

/** 只认 pan.quark.cn/s/<pwd_id>；提取码可以在 ?pwd= 里，也可以在链接后面的「提取码：xxxx」里 */
export function parseQuarkShareLink(text: string): ShareRef | null {
  const m = SHARE_URL.exec(text);
  if (!m) return null;
  const code = m[1];
  let password = "";
  if (m[2]) {
    const q = new URLSearchParams(m[2].slice(1));
    // 提取码只有字母数字：句末粘着的英文标点（「?pwd=ab12).」）不算
    password = /^[a-z0-9]*/i.exec((q.get("pwd") ?? q.get("passcode") ?? "").trim())?.[0] ?? "";
  }
  if (!password) password = PASSCODE_IN_TEXT.exec(text)?.[1] ?? "";
  return { kind: "quark", code, password, url: `https://pan.quark.cn/s/${code}${password ? `?pwd=${password}` : ""}` };
}

function shareError(err: unknown): unknown {
  return err instanceof QuarkShareError ? new ShareGoneError(err.message, err.code) : err;
}

class QuarkShare implements ShareProvider {
  constructor(private readonly account: AccountQuark) {}

  /** 夸克服务端知道「相对上次转存有没有新增」：追更先问它，没有就不用整棵列 */
  readonly updates: ShareUpdates = {
    check: async (s: ShareSession, signal?: AbortSignal) => {
      try {
        return await this.withStoken(s, (stoken) => quarkShareIncUpdate(this.account, s.ref.code, stoken, signal), signal);
      } catch (err) {
        throw shareError(err);
      }
    },
  };

  parseLink(text: string): ShareRef | null {
    return parseQuarkShareLink(text);
  }

  async open(ref: ShareRef, signal?: AbortSignal): Promise<ShareSession> {
    try {
      const { stoken } = await quarkShareToken(this.account, ref.code, ref.password, signal);
      return { ref, token: stoken };
    } catch (err) {
      throw shareError(err);
    }
  }

  async info(s: ShareSession, signal?: AbortSignal): Promise<ShareInfo> {
    try {
      const { title } = await quarkShareToken(this.account, s.ref.code, s.ref.password, signal);
      const first = await this.withStoken(s, (stoken) => quarkShareList(this.account, s.ref.code, stoken, "0", 1, signal), signal);
      return { title: title || s.ref.code, fileCount: first.total };
    } catch (err) {
      throw shareError(err);
    }
  }

  private stoken(s: ShareSession): string {
    if (!s.token) throw new PermanentError("夸克分享会话没有 stoken，请先 open");
    return s.token;
  }

  /**
   * 拿会话里的 stoken 调接口；stoken 失效（41008，分享者刷新过分享或缓存的那份过期了）就丢掉缓存、重新换一个再试一次，
   * 新的写回会话，后面的调用直接用
   */
  private async withStoken<T>(s: ShareSession, fn: (stoken: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await fn(this.stoken(s));
    } catch (err) {
      const code = err instanceof QuarkError || err instanceof QuarkShareError ? err.code : undefined;
      if (code !== 41008) throw err;
      forgetQuarkShareToken(this.account, s.ref.code, s.ref.password);
      const { stoken } = await quarkShareToken(this.account, s.ref.code, s.ref.password, signal);
      s.token = stoken;
      return await fn(stoken);
    }
  }

  async list(s: ShareSession, dirId: string, cursor?: string, opts?: { signal?: AbortSignal }): Promise<ShareListPage> {
    const page = Math.max(1, Number(cursor ?? 1) || 1);
    let r: { list: QuarkShareFile[]; total: number | undefined };
    try {
      r = await this.withStoken(s, (stoken) => quarkShareList(this.account, s.ref.code, stoken, dirId || "0", page, opts?.signal), opts?.signal);
    } catch (err) {
      throw shareError(err);
    }
    // 页是满的就再翻（_total 少算会把尾巴丢掉，追更会漏集）；有 _total 且它说还有也翻
    const more = r.list.length === QUARK_SHARE_PAGE_SIZE || (r.total !== undefined && r.list.length > 0 && page * QUARK_SHARE_PAGE_SIZE < r.total);
    // 根目录第一页顺带给标题：open 时换 stoken 已经拿到并缓存了，看分享的人就不用再调一次 info（夸克的 info 和这一页是同一个请求）
    const title = (dirId || "0") === "0" && page === 1 ? this.cachedTitle(s) : undefined;
    return { entries: r.list.map(toShareEntry), next: more ? String(page + 1) : undefined, total: r.total, ...(title ? { title } : {}) };
  }

  /** open 时缓存下来的分享标题；缓存没了就不给（不为它再发请求） */
  private cachedTitle(s: ShareSession): string | undefined {
    return peekQuarkShareToken(this.account, s.ref.code, s.ref.password)?.title || undefined;
  }

  resolvePath(s: ShareSession, path: string, signal?: AbortSignal): Promise<ShareEntry | null> {
    return resolveSharePath(this, s, path, signal);
  }

  async receive(s: ShareSession, items: ReceiveItem[], toDirId: string, signal?: AbortSignal): Promise<ReceiveResult> {
    // 转存要每个条目的 share_fid_token，而且得是这次会话（stoken）列出来的——token 跟着 stoken 变，stoken 缓存半小时：
    //   - 给了所在目录的（影库里记下的、弹框开了很久的）：在这次会话里把那一层重新列一遍，用新的
    //   - 没带 token 也没给目录的（只存了 id 的老数据）：按分享根重新列一遍补
    const withToken: Array<{ id: string; token: string }> = [];
    const dirs = new Set<string>();
    for (const i of items) {
      if (i.parentId) dirs.add(i.parentId);
      else if (!i.token) dirs.add("0");
    }
    const tokens = new Map<string, string>();
    for (const dir of dirs) {
      for (const e of await listWholeShareDir(this, s, dir, signal)) if (e.token) tokens.set(e.id, e.token);
    }
    for (const i of items) {
      const token = tokens.get(i.id) || i.token;
      if (!token) throw new PermanentError(`夸克转存缺少条目 ${i.id} 的 share_fid_token（它不在分享根目录下，请重新从分享列表里选择）`);
      withToken.push({ id: i.id, token });
    }
    try {
      const { taskId } = await this.withStoken(
        s,
        (stoken) => quarkShareSave(this.account, { pwdId: s.ref.code, stoken, items: withToken, toPdirFid: toDirId }, signal),
        signal,
      );
      const done = await quarkWaitTask(this.account, taskId, { signal });
      return { topIds: done.topIds };
    } catch (err) {
      throw shareError(err);
    }
  }
}

/* ------------------------------- 网盘 ------------------------------- */

export class QuarkProvider implements DriveProvider {
  readonly kind = "quark" as const;
  readonly capabilities = { share: true, changes: true, write: true };
  readonly rootId = "0";
  readonly share: ShareProvider;
  readonly changes: QuarkSnapshotSource;
  readonly write: DriveWriteOps;

  constructor(readonly account: AccountQuark) {
    this.share = new QuarkShare(account);
    this.changes = new QuarkSnapshotSource(this);
    this.write = new QuarkWrite(account);
  }

  async resolvePath(path: string, signal?: AbortSignal): Promise<DriveNode | null> {
    try {
      const { fid, entry } = await quarkResolvePath(this.account, path, signal);
      return { id: fid, isDir: entry ? entry.isDir : true };
    } catch (err) {
      // 找不到、中间段是文件：都是「没有这个路径」
      if (err instanceof PermanentError) return null;
      throw err;
    }
  }

  /** 夸克没有自己的目录缓存，fresh 不用管 */
  async listDir(id: string, signal?: AbortSignal, opts?: { fresh?: boolean; background?: boolean }): Promise<DriveEntry[]> {
    return (await quarkListDir(this.account, id, signal, { channel: channelOf(opts) })).map(toEntry);
  }

  private async walk(rootFid: string, signal?: AbortSignal, background?: boolean): Promise<SubtreeEntry[]> {
    const out: SubtreeEntry[] = [];
    let frontier: Array<{ fid: string; rel: string[] }> = [{ fid: rootFid, rel: [] }];
    const channel = channelOf({ background });
    while (frontier.length > 0) {
      const listed = await mapLimit(frontier, 4, (dir) => quarkListDir(this.account, dir.fid, signal, { channel }));
      const next: typeof frontier = [];
      frontier.forEach((dir, i) => {
        for (const item of listed[i]) {
          if (item.name.includes("/")) {
            log.warn({ account: this.account.name, dir: dir.rel.join("/"), name: item.name }, "夸克条目名字里带 /，按路径找不回来，跳过");
            continue;
          }
          const segs = [...dir.rel, item.name];
          out.push({
            path: segs.join("/"),
            id: item.fid,
            isDir: item.isDir,
            size: item.size,
            modifiedAt: item.modifiedAt || undefined,
            ...(item.isDir ? { items: item.items } : {}),
          });
          if (item.isDir) next.push({ fid: item.fid, rel: segs });
        }
      });
      frontier = next;
    }
    return out;
  }

  private async rootFid(path: string, id: string | undefined, signal?: AbortSignal): Promise<string> {
    if (id) return id;
    const node = await this.resolvePath(path, signal);
    if (!node || !node.isDir) throw new RemoteDirNotFoundError(path);
    return node.id;
  }

  async listSubtree(path: string, opts?: { id?: string; signal?: AbortSignal }): Promise<string[]> {
    const entries = await this.walk(await this.rootFid(path, opts?.id, opts?.signal), opts?.signal);
    return syncViewFromPaths(entries.map((e) => e.path.split("/")));
  }

  async walkSubtree(path: string, opts?: { id?: string } & ReadOptions): Promise<SubtreeEntry[]> {
    return this.walk(await this.rootFid(path, opts?.id, opts?.signal), opts?.signal, opts?.background);
  }

  /** path_list 按路径批量取目录指纹（50 个一批）；文件、不存在的、服务端回的路径和传的对不上的都不回 */
  async dirFingerprints(paths: string[], opts?: ReadOptions): Promise<Map<string, DirFingerprint>> {
    const hits = await quarkPathList(this.account, paths, { signal: opts?.signal, channel: channelOf(opts) });
    const out = new Map<string, DirFingerprint>();
    for (const p of paths) {
      const e = hits.get(p);
      if (e?.isDir) out.set(p, { id: e.fid, modifiedAt: e.modifiedAt, items: e.items });
    }
    return out;
  }

  async downloadLink(path: string, opts?: { token?: string; signal?: AbortSignal }): Promise<DriveLink> {
    let fid = opts?.token;
    if (!fid) {
      const { fid: id, entry } = await quarkResolvePath(this.account, path, opts?.signal);
      if (!entry || entry.isDir) throw new PermanentError(`Not a file: ${path}`);
      fid = id;
    }
    return quarkDownloadLink(this.account, fid, opts?.signal);
  }

  classifyError(err: unknown): AccountIssue | null {
    if (err instanceof ShareGoneError || err instanceof QuarkShareError) return "gone";
    if (err instanceof QuarkError) {
      if (err.code === 31001 || err.code === 31004 || err.status === 401) return "auth";
      if (err.status === 403 || err.status === 429) return "blocked";
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/require login|st invalid/i.test(msg)) return "auth";
    return null;
  }
}

/* ------------------------------- 写操作 ------------------------------- */

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const joinPan = (dir: string, name: string): string => (dir === "/" || dir === "" ? `/${name}` : `${dir}/${name}`);

/** 夸克没有批量改名，逐个来（账号限流器管节奏）；移动 / 删除是异步任务，没完成就轮询 */
class QuarkWrite implements DriveWriteOps {
  constructor(private readonly account: AccountQuark) {}

  private async settle(handle: QuarkTaskHandle, signal?: AbortSignal): Promise<void> {
    if (handle.finish || !handle.taskId) return;
    await quarkWaitTask(this.account, handle.taskId, { signal });
  }

  async mkdir(parent: { id: string; path: string }, name: string, signal?: AbortSignal): Promise<DriveNode> {
    const fid = await quarkMkdir(this.account, parent.id, name, signal);
    rememberQuarkDir(this.account, joinPan(parent.path, name), { fid, name, isDir: true, size: 0, category: 0, modifiedAt: Date.now(), items: 0 });
    return { id: fid, isDir: true };
  }

  async rename(node: WriteNode, newName: string, signal?: AbortSignal): Promise<{ id: string }> {
    await quarkRename(this.account, node.id, newName, signal);
    if (node.isDir) forgetQuarkPaths(this.account, [node.path]);
    return { id: node.id };
  }

  async move(nodes: WriteNode[], to: { id: string; path: string }, signal?: AbortSignal): Promise<Array<{ id: string }>> {
    if (nodes.length === 0) return [];
    // 一次别塞太多：接口没写上限，按 50 个一批
    for (let i = 0; i < nodes.length; i += 50) {
      const batch = nodes.slice(i, i + 50);
      await this.settle(await quarkMove(this.account, batch.map((n) => n.id), to.id, signal), signal);
      forgetQuarkPaths(this.account, batch.filter((n) => n.isDir).map((n) => n.path));
    }
    return nodes.map((n) => ({ id: n.id }));
  }

  async rmdirIfEmpty(node: WriteNode, signal?: AbortSignal): Promise<boolean> {
    const entries = await quarkListDir(this.account, node.id, signal);
    if (entries.length > 0) return false;
    await this.settle(await quarkDelete(this.account, [node.id], signal), signal);
    forgetQuarkPaths(this.account, [node.path]);
    return true;
  }

  /** 夸克的删除是进回收站 */
  async remove(node: WriteNode, signal?: AbortSignal): Promise<void> {
    await this.settle(await quarkDelete(this.account, [node.id], signal), signal);
    forgetQuarkPaths(this.account, [node.path]);
  }
}

/** 给日志用：节点名 */
export { baseName as quarkBaseName };
