/**
 * CloudDrive2 的 Provider：id 就是 CD2 里的路径（`/云盘名/目录/文件`）。同步 / 浏览 / 下载地址 / 整理，没有分享和变更监控。
 * 列子树时 forceRefresh 绕过 CD2 的目录缓存（同步要看最新的）；浏览时走缓存。
 *
 * 路径只归一斜杠，不削每一段两边的空白：id 是从 CD2 列出来的名字拼的，网盘上真有带尾空格的目录名，削了就找不着了。
 */
import type { AccountCd2 } from "@openstrm/shared";
import { GRPC_STATUS } from "../../../lib/grpc.js";
import { Cd2Error, cd2CreateFolder, cd2Delete, cd2DownloadUrl, cd2FindFile, cd2ListEntries, cd2Move, cd2Rename, isCd2AlreadyExists, isCd2Missing, type Cd2Entry } from "../../cd2/client.js";
import { scheduleForAccount } from "../../throttle.js";
import { syncViewFromPaths } from "../subtree.js";
import {
  PartialMoveError,
  RemoteDirNotFoundError,
  type AccountIssue,
  type DriveEntry,
  type DriveLink,
  type DriveNode,
  type DriveProvider,
  type DriveWriteOps,
  type SubtreeEntry,
  type WriteNode,
} from "../types.js";

/** 补前导 /、去尾 /、连着的斜杠收成一个；空的是根 */
function norm(path: string): string {
  const t = path.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (!t) return "/";
  return t.startsWith("/") ? t : `/${t}`;
}

const join = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export class Cd2Provider implements DriveProvider {
  readonly kind = "cd2" as const;
  readonly capabilities = { share: false, changes: false, write: true };
  readonly rootId = "/";
  readonly pathIds = true;
  readonly write: DriveWriteOps;

  constructor(readonly account: AccountCd2) {
    this.write = new Cd2Write(account);
  }

  async resolvePath(path: string, signal?: AbortSignal): Promise<DriveNode | null> {
    const p = norm(path);
    if (p === "/") return { id: "/", isDir: true };
    const hit = await cd2FindFile(this.account, parentOf(p), nameOf(p), signal);
    return hit ? { id: p, isDir: hit.isDir } : null;
  }

  async listDir(id: string, signal?: AbortSignal, opts?: { fresh?: boolean }): Promise<DriveEntry[]> {
    const dir = norm(id);
    // fresh：让 CD2 绕过它自己的目录缓存重新问网盘
    const entries = await cd2ListEntries(this.account, dir, { refresh: !!opts?.fresh, signal });
    return entries.map((e) => ({ id: join(dir, e.name), name: e.name, isDir: e.isDir, size: e.size, modifiedAt: e.modifiedAt }));
  }

  private async walk(root: string, signal?: AbortSignal): Promise<SubtreeEntry[]> {
    const out: SubtreeEntry[] = [];
    const collect = async (cur: string, rel: string[]): Promise<void> => {
      let entries: Cd2Entry[];
      try {
        entries = await cd2ListEntries(this.account, cur, { refresh: true, signal });
      } catch (err) {
        if (rel.length === 0 && isCd2Missing(err)) throw new RemoteDirNotFoundError(root);
        throw err;
      }
      for (const e of entries) {
        const segs = [...rel, e.name];
        const p = join(cur, e.name);
        out.push({ path: segs.join("/"), id: p, isDir: e.isDir, size: e.size, modifiedAt: e.modifiedAt });
        if (e.isDir) await collect(p, segs);
      }
    };
    await collect(root, []);
    return out;
  }

  async listSubtree(path: string, opts?: { id?: string; signal?: AbortSignal }): Promise<string[]> {
    const entries = await this.walk(norm(opts?.id ?? path), opts?.signal);
    return syncViewFromPaths(entries.map((e) => e.path.split("/")));
  }

  async walkSubtree(path: string, opts?: { id?: string; signal?: AbortSignal }): Promise<SubtreeEntry[]> {
    return this.walk(norm(opts?.id ?? path), opts?.signal);
  }

  /** 经 CD2 自己下载的地址（不要云盘直链：那种常和 UA、请求头绑定）。地址里带着访问凭据，别整条打进日志 */
  async downloadLink(path: string, opts?: { token?: string; signal?: AbortSignal }): Promise<DriveLink> {
    const p = norm(path);
    const link = await scheduleForAccount(this.account.name, "normal", () => cd2DownloadUrl(this.account, p, opts?.signal), opts?.signal);
    return { url: link.url };
  }

  /** 令牌不对 / 过期（UNAUTHENTICATED）和令牌缺权限（PERMISSION_DENIED，原文带着缺哪一项）都得人去账户页或 CD2 里修 */
  classifyError(err: unknown): AccountIssue | null {
    if (!(err instanceof Cd2Error) || err.transport) return null;
    return err.code === GRPC_STATUS.UNAUTHENTICATED || err.code === GRPC_STATUS.PERMISSION_DENIED ? "auth" : null;
  }
}

/** CD2 的 id 就是路径：改名 / 移动之后返回新路径当 id */
class Cd2Write implements DriveWriteOps {
  constructor(private readonly account: AccountCd2) {}

  async mkdir(parent: { id: string; path: string }, name: string, signal?: AbortSignal): Promise<DriveNode> {
    const dir = norm(parent.path);
    try {
      await cd2CreateFolder(this.account, dir, name, signal);
    } catch (err) {
      // 已经有同名目录就当建好了（别人刚建的、同一轮里被要了两次）；占着名字的是个文件就不是建好了，照原样报
      if (!isCd2AlreadyExists(err)) throw err;
      const existing = await cd2FindFile(this.account, dir, name, signal);
      if (!existing?.isDir) throw err;
    }
    return { id: join(dir, name), isDir: true };
  }

  async rename(node: WriteNode, newName: string, signal?: AbortSignal): Promise<{ id: string }> {
    const p = norm(node.path);
    await cd2Rename(this.account, p, newName, signal);
    return { id: join(parentOf(p), newName) };
  }

  /**
   * 一次 MoveFile 挪完（路径都是绝对的，不用按源目录分组）。冲突策略是 Skip：目标里已有同名的 CD2 原地不动、也不报错，
   * 回包里也看不出哪些挪成了（resultFilePaths 是空的），所以挪完看源：还在原处的就是没挪成，当「目标已有同名」抛——
   * 同一批里别的已经挪过去了，就用 PartialMoveError 把它们带上。整理动手前本来就查过撞名，这里只兜竞态
   */
  async move(nodes: WriteNode[], to: { id: string; path: string }, signal?: AbortSignal): Promise<Array<{ id: string }>> {
    if (nodes.length === 0) return [];
    const dst = norm(to.path);
    const sources = nodes.map((n) => norm(n.path));
    const targets = sources.map((src) => join(dst, nameOf(src)));
    // 本来就在目标目录里的不用挪（挪了也分不清「没动」和「没挪成」）
    const toMove = sources.filter((src) => parentOf(src) !== dst);
    if (toMove.length === 0) return targets.map((id) => ({ id }));
    await cd2Move(this.account, toMove, dst, signal);
    const left = await this.stillThere(toMove, signal);
    if (left.size === 0) return targets.map((id) => ({ id }));
    const done = new Map<string, string>();
    nodes.forEach((n, i) => {
      if (!left.has(sources[i])) done.set(n.path, targets[i]);
    });
    const message = await this.whyNotMoved([...left], dst, signal);
    throw done.size > 0 ? new PartialMoveError(message, done) : new Cd2Error(message);
  }

  /**
   * 这些路径里还在原处的。按所在目录列一遍（不强制刷新：CD2 自己挪动之后它的目录缓存当场就是新的，
   * 强制刷新反而可能撞上网盘那头列表滞后）；所在目录都没了，里面的当然也不在了
   */
  private async stillThere(paths: string[], signal?: AbortSignal): Promise<Set<string>> {
    const byDir = new Map<string, string[]>();
    for (const p of paths) byDir.set(parentOf(p), [...(byDir.get(parentOf(p)) ?? []), p]);
    const left = new Set<string>();
    for (const [dir, inDir] of byDir) {
      let names: Set<string>;
      try {
        names = new Set((await cd2ListEntries(this.account, dir, { signal })).map((e) => e.name));
      } catch (err) {
        if (isCd2Missing(err)) continue;
        throw err;
      }
      for (const p of inDir) if (names.has(nameOf(p))) left.add(p);
    }
    return left;
  }

  /** 没挪成的那些为什么没成：目标里有同名的就是撞名（Skip 不覆盖）；看不出来的照实说 CD2 没给原因 */
  private async whyNotMoved(left: string[], dst: string, signal?: AbortSignal): Promise<string> {
    const names = left.map(nameOf);
    const shown = `${names.slice(0, 3).join("、")}${names.length > 3 ? ` 等 ${names.length} 个` : ""}`;
    let inDst: Set<string> | null = null;
    try {
      inDst = new Set((await cd2ListEntries(this.account, dst, { signal })).map((e) => e.name));
    } catch {
      // 目标目录列不出来就分不清原因，按没给原因说
    }
    if (inDst && names.every((n) => inDst.has(n))) return `CD2 MoveFile 没有挪过去：${dst} 里已存在同名的 ${shown}`;
    return `CD2 MoveFile 回了成功，但 ${shown} 还在原处、没有进 ${dst}，CD2 没说原因`;
  }

  async rmdirIfEmpty(node: WriteNode, signal?: AbortSignal): Promise<boolean> {
    const p = norm(node.path);
    const entries = await cd2ListEntries(this.account, p, { refresh: true, signal });
    if (entries.length > 0) return false;
    await cd2Delete(this.account, p, signal);
    return true;
  }

  /** CD2 的普通删除：进不进回收站看那家网盘（115 进回收站，本地文件夹是直接删） */
  async remove(node: WriteNode, signal?: AbortSignal): Promise<void> {
    await cd2Delete(this.account, norm(node.path), signal);
  }
}
