/**
 * 快照式变更源：给没有事件流的网盘用（夸克）。
 *
 * 每轮拿到该账号每个同步任务 originPath 的整棵树，和上一轮存在 drive_snapshots 里的对比，
 * 以网盘 id 为身份认出新增 / 删除 / 改名 / 移动。目录级的变化只报最上层那一条：新目录由处理器展开生成，
 * 移动 / 删除的目录本地整体搬 / 删，子项跟着走。事件按删除、搬动、新增的顺序交出去：同名替换（旧 id 没了、
 * 新 id 顶上）要先删旧的再建新的，目录搬进新建的目录要先搬再展开，反过来都会把刚生成的东西删掉或撞上非空目录。
 *
 * 整棵树不是每轮都整棵列（见 fingerprint-walk.ts）：网盘能按路径批量取目录指纹的（夸克 path_list），每轮先比指纹、
 * 只列变了的目录，没列的沿用快照；首轮、旧格式的快照、每隔 12 小时整棵列一次兜底，顺带自检增量有没有漏。
 * 没有指纹接口的（测试里的假网盘）每轮整棵列。
 *
 * 新快照要等这一轮的事件全部处理完才写库（PullResult.commit）：中途被中止或某条解析失败，下轮拿旧快照重新对比，
 * 重复出的事件处理器都能幂等地再来一遍。一个目录都没列的一轮不写。某个根列不了（目录改名 / 风控）只跳过它并记进 warnings，别的根照常。
 *
 * 安全阀：一轮里要删的超过快照的三成先不删，只告警；下一轮还是同样的结果才执行（真机上整个目录被删掉就是这样，
 * 只压不放会永远收敛不了）。列目录失败是抛错而不是回空，所以列到 0 条就是真的空了，照常对比。
 * 快照里留着、这一轮却没看到的（压下的删除、处理失败放回去的），所在目录挂 recheck，下一轮一定重列再比。
 * 首轮：latest / last 只存快照不发事件，all 把现有文件全部当新增。
 */
import type { LifePullMode } from "@openstrm/shared";
import { readDriveSnapshot, writeDriveSnapshot } from "../../../db/repositories/life.js";
import { isAbortError } from "../../../lib/errors.js";
import { moduleLogger } from "../../../lib/logger.js";
import {
  normalizePath,
  resolvedChange,
  type ChangeCursor,
  type ChangeEvent,
  type ChangeKind,
  type ChangeSource,
  type DriveProvider,
  type PrepareResult,
  type ProbeResult,
  type PullOptions,
  type PullResult,
} from "../../drive/types.js";
import { fullScan, hasFingerprints, incrementalWalk, markDiverged, type SnapEntry, type SnapMeta, type WalkResult } from "./fingerprint-walk.js";

const log = moduleLogger("life");

export type { SnapEntry, SnapMeta } from "./fingerprint-walk.js";

/** 增量之外每隔这么久整棵列一次兜底（它是安全网，不靠它发现变化） */
const FULL_SCAN_MS = 12 * 3600_000;

export interface SnapshotChange {
  kind: ChangeKind;
  /** 相对根 */
  path: string;
  oldPath: string | null;
  isDir: boolean;
  id: string;
  size?: number;
  /** remove 专用：这个路径现在被另一个 id 占着（同名替换），不算「消失」，删除阀门不管它 */
  replaced?: boolean;
}

const depthOf = (p: string): number => p.split("/").length;
const parentOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};
const isUnder = (p: string, dir: string): boolean => p.startsWith(`${dir}/`);
const atOrUnder = (p: string, dir: string): boolean => p === dir || isUnder(p, dir);
const coveredBy = (p: string, dirs: string[]): boolean => dirs.some((d) => isUnder(p, d));

/**
 * 搬动之间的先后：
 *   - b 的目标压在 a 的旧位置上（a 搬走才能腾出来）→ a 先；
 *   - a 是目录、b 的旧位置在 a 的旧位置下面（b 用的是搬前的路径）→ b 先；
 *   - a 是目录、b 的目标在 a 的新位置下面（目标目录得先到位）→ a 先。
 * 拓扑排序；成环的（互换、进出同一个搬动的目录）挑一个退化成「删旧位置 + 在新位置重新生成」来解环，
 * 优先挑文件（目录退化意味着整棵重新生成），处理器都是幂等的。
 */
function orderMoves(moves: SnapshotChange[]): { ordered: SnapshotChange[]; degraded: SnapshotChange[] } {
  const n = moves.length;
  const before = new Set<string>();
  const key = (a: number, b: number) => `${a}>${b}`;
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      const A = moves[a]!;
      const B = moves[b]!;
      if (atOrUnder(B.path, A.oldPath!)) before.add(key(a, b));
      if (A.isDir && isUnder(B.oldPath!, A.oldPath!)) before.add(key(b, a));
      if (A.isDir && isUnder(B.path, A.path)) before.add(key(a, b));
    }
  }
  const indeg = new Array<number>(n).fill(0);
  for (const k of before) indeg[Number(k.split(">")[1])]!++;
  const ordered: SnapshotChange[] = [];
  const degraded: SnapshotChange[] = [];
  const done = new Array<boolean>(n).fill(false);
  const release = (i: number) => {
    done[i] = true;
    for (let b = 0; b < n; b++) if (before.has(key(i, b))) indeg[b]!--;
  };
  for (;;) {
    const next = moves.findIndex((_, i) => !done[i] && indeg[i] === 0);
    if (next >= 0) {
      ordered.push(moves[next]!);
      release(next);
      continue;
    }
    // 成环：挑一个退化，先挑文件
    const stuck = moves.findIndex((m, i) => !done[i] && !m.isDir);
    const victim = stuck >= 0 ? stuck : moves.findIndex((_, i) => !done[i]);
    if (victim < 0) break;
    degraded.push(moves[victim]!);
    release(victim);
  }
  return { ordered, degraded };
}

/**
 * 两份快照的差，按删除、搬动、新增、内容变化的顺序交出去；只报最上层的目录变化；
 * 文件内容变了（大小 / 时间）按新增再报一次，处理器会重下附件。
 * removed 只数真正消失的条目（路径没被别的 id 占着），给删除阀门用。
 */
export function diffSnapshot(prev: SnapEntry[], curr: SnapEntry[]): { changes: SnapshotChange[]; removed: number } {
  const prevById = new Map(prev.map((e) => [e.id, e]));
  const currById = new Map(curr.map((e) => [e.id, e]));
  const currPaths = new Set(curr.map((e) => e.path));
  const byDepth = (a: SnapEntry, b: SnapEntry) => depthOf(a.path) - depthOf(b.path) || a.path.localeCompare(b.path);
  const created: SnapshotChange[] = [];
  const moves: SnapshotChange[] = [];
  const changed: SnapshotChange[] = [];
  const removed: SnapshotChange[] = [];
  const newDirs: string[] = [];
  const movedDirs: Array<{ from: string; to: string }> = [];
  const removedDirs: string[] = [];

  for (const e of [...curr].sort(byDepth)) {
    const old = prevById.get(e.id);
    if (!old) {
      if (coveredBy(e.path, newDirs)) continue;
      created.push({ kind: "create", path: e.path, oldPath: null, isDir: e.isDir, id: e.id, size: e.size });
      if (e.isDir) newDirs.push(e.path);
      continue;
    }
    if (old.path !== e.path) {
      // 整个目录搬了、而且它在目录里的相对位置没变：跟着目录走，不单报
      if (movedDirs.some((m) => isUnder(old.path, m.from) && e.path === `${m.to}${old.path.slice(m.from.length)}`)) continue;
      moves.push({
        kind: parentOf(old.path) === parentOf(e.path) ? "rename" : "move",
        path: e.path,
        oldPath: old.path,
        isDir: e.isDir,
        id: e.id,
        size: e.size,
      });
      if (e.isDir) movedDirs.push({ from: old.path, to: e.path });
      continue;
    }
    if (!e.isDir && ((old.size ?? 0) !== (e.size ?? 0) || (old.modifiedAt ?? 0) !== (e.modifiedAt ?? 0))) {
      changed.push({ kind: "create", path: e.path, oldPath: null, isDir: false, id: e.id, size: e.size });
    }
  }

  let removedCount = 0;
  for (const e of [...prev].sort(byDepth)) {
    if (currById.has(e.id)) continue;
    const replaced = currPaths.has(e.path);
    if (!replaced) removedCount++;
    if (coveredBy(e.path, removedDirs)) continue;
    removed.push({ kind: "remove", path: e.path, oldPath: null, isDir: e.isDir, id: e.id, ...(replaced ? { replaced: true } : {}) });
    if (e.isDir) removedDirs.push(e.path);
  }

  const { ordered, degraded } = orderMoves(moves);
  for (const m of degraded) {
    removed.push({ kind: "remove", path: m.oldPath!, oldPath: null, isDir: m.isDir, id: m.id, replaced: currPaths.has(m.oldPath!) });
    created.push({ kind: "create", path: m.path, oldPath: null, isDir: m.isDir, id: m.id, size: m.size });
  }
  return { changes: [...removed, ...ordered, ...created, ...changed], removed: removedCount };
}

/** 一轮里要删的超过快照的这个比例先不删，下一轮还这样才删 */
const REMOVE_RATIO_LIMIT = 0.3;
const REMOVE_RATIO_MIN_ENTRIES = 10;
/** 哪些根上一轮压下过大比例删除（`账号\0根`）；进程重启就忘，最多再多等一轮 */
const suppressedRoots = new Set<string>();

/**
 * 处理失败的变更从新快照里剔掉，让下轮重新对比时再发一次：
 * 新增 → 新快照里不记它（目录连子树）；删除 → 把旧条目放回去；搬动 → 新位置不记、旧位置放回去。
 */
function revertChange(entries: SnapEntry[], prev: SnapEntry[], c: SnapshotChange): SnapEntry[] {
  const drop = (list: SnapEntry[], path: string, isDir: boolean) => list.filter((e) => !(e.path === path || (isDir && isUnder(e.path, path))));
  const restore = (list: SnapEntry[], path: string, isDir: boolean) => {
    const ids = new Set(list.map((e) => e.id));
    return [...list, ...prev.filter((e) => (e.path === path || (isDir && isUnder(e.path, path))) && !ids.has(e.id))];
  };
  switch (c.kind) {
    case "create":
    case "folder":
      return drop(entries, c.path, c.isDir);
    case "remove":
      return restore(entries, c.path, c.isDir);
    case "move":
    case "rename":
      return restore(drop(entries, c.path, c.isDir), c.oldPath ?? c.path, c.isDir);
  }
}

/** 仅供测试 */
export function __test_resetQuarkSnapshotSource(): void {
  suppressedRoots.clear();
}

export class QuarkSnapshotSource implements ChangeSource {
  readonly label = "snapshot";

  constructor(private readonly provider: DriveProvider) {}

  /** 能比目录指纹的（夸克）没变化的一轮只有几个请求，60 秒一轮；只能整棵列的 5 分钟 */
  get minIntervalSeconds(): number {
    return this.provider.dirFingerprints ? 60 : 300;
  }

  async prepare(signal: AbortSignal): Promise<PrepareResult> {
    try {
      await this.provider.listDir(this.provider.rootId, signal);
      return { ok: true, message: "已连接" };
    } catch (err) {
      if (signal.aborted || isAbortError(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `网盘不可用：${msg}，请检查 cookie`, reason: msg, issue: this.provider.classifyError(err) };
    }
  }

  /** 游标的 id 记冷启动模式，并且一直带着：某个根后来才第一次扫到（任务新加的、之前列不了的），照样按这个模式建快照 */
  initialCursor(mode: LifePullMode, saved: ChangeCursor | null): ChangeCursor {
    if (mode === "last" && saved) return { ...saved, id: "last" };
    return { time: mode === "all" ? 0 : Math.floor(Date.now() / 1000), id: mode };
  }

  async pull(cursor: ChangeCursor, opts: PullOptions): Promise<PullResult> {
    if (!this.provider.walkSubtree) throw new Error("这个网盘不支持快照监控");
    const account = this.provider.account.name;
    const scannedAt = Math.floor(Date.now() / 1000);
    const warnings: string[] = [];
    /**
     * 每个根这轮的结果：新快照（commit 时才写库）+ 发出去的变更，处理失败的要从新快照里剔掉。
     * observed 是这一轮实际看到的树（toStore 可能多留了压下的删除）；scanned：这一轮列过目录，没列过的快照原样不用写
     */
    const rounds: Array<{
      root: string;
      prev: SnapEntry[];
      toStore: SnapEntry[];
      observed: SnapEntry[];
      meta: SnapMeta;
      scanned: boolean;
      emitted: Map<string, SnapshotChange>;
    }> = [];
    const changes: ChangeEvent[] = [];
    const roots = [...new Set(opts.tasks.map((t) => normalizePath(t.originPath)))].filter((r) => r !== "/");

    for (const root of roots) {
      if (opts.signal.aborted) break;
      const prev = readDriveSnapshot<SnapEntry, SnapMeta>(account, root);
      let scan: WalkResult & { full: boolean };
      try {
        scan = await this.scan(root, prev, opts);
      } catch (err) {
        if (opts.signal.aborted || isAbortError(err)) throw err;
        // cookie 失效 / 风控是账号的事，所有根都一样：原样抛出去让监控告警、退避
        if (this.provider.classifyError(err)) throw err;
        // 这个根自己列不了（目录改名 / 服务端返回异常）：跳过它别拖累别的根，快照不动，下轮再试
        warnings.push(`${root} 列目录失败：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const entries = scan.entries;
      const scanned = scan.full || scan.listed > 0;
      const emitted = new Map<string, SnapshotChange>();
      const emit = (list: SnapshotChange[]) => {
        for (const c of list) {
          const ev = this.toEvent(account, root, c, scannedAt);
          emitted.set(ev.id, c);
          changes.push(ev);
        }
      };
      if (!prev) {
        if (cursor.id === "all") emit(diffSnapshot([], entries).changes);
        else opts.log?.("info", `${root} 首轮建立快照：${entries.length} 项记为现有`);
        rounds.push({ root, prev: [], toStore: entries, observed: entries, meta: scan.meta, scanned: true, emitted });
        continue;
      }
      const { changes: diff, removed } = diffSnapshot(prev.entries, entries);
      let list = diff;
      let toStore = entries;
      const key = `${account}\0${root}`;
      const massRemoval = prev.entries.length >= REMOVE_RATIO_MIN_ENTRIES && removed / prev.entries.length > REMOVE_RATIO_LIMIT;
      if (massRemoval && !suppressedRoots.has(key)) {
        // 第一次看到：真正消失的先不删，留在快照里下轮还是这样才执行；同名替换（路径被新 id 占着）不在此列，照常先删后建
        suppressedRoots.add(key);
        const msg = `${root} 这轮有 ${removed}/${prev.entries.length} 项消失，超过 ${REMOVE_RATIO_LIMIT * 100}%，先不删本地文件；下一轮还是这样才删`;
        opts.log?.("warn", msg);
        log.warn({ account, root }, msg);
        list = list.filter((c) => c.kind !== "remove" || c.replaced);
        const currIds = new Set(entries.map((e) => e.id));
        const currPaths = new Set(entries.map((e) => e.path));
        toStore = [...entries, ...prev.entries.filter((e) => !currIds.has(e.id) && !currPaths.has(e.path))];
      } else {
        if (massRemoval) opts.log?.("warn", `${root} 连续两轮都少了 ${removed}/${prev.entries.length} 项，按真删除处理`);
        suppressedRoots.delete(key);
      }
      emit(list);
      rounds.push({ root, prev: prev.entries, toStore, observed: entries, meta: scan.meta, scanned, emitted });
    }
    return {
      changes: changes.map(resolvedChange),
      cursor: { time: scannedAt, id: cursor.id },
      warnings: warnings.length > 0 ? warnings : undefined,
      commit: (failedIds) => {
        const failed = new Set(failedIds);
        for (const r of rounds) {
          let entries = r.toStore;
          for (const [id, c] of r.emitted) {
            if (!failed.has(id)) continue;
            // 这条没处理成：新快照里当它没发生过，下轮重新对比会再发一次
            entries = revertChange(entries, r.prev, c);
          }
          // 指纹全对上、一个目录都没列的一轮：快照原样，不写
          if (!r.scanned && entries === r.observed) continue;
          // 留在快照里、这轮却没看到的（压下的删除、放回去的失败变更）：所在目录挂 recheck，下一轮一定重列
          const marked = markDiverged(entries, r.observed, r.meta);
          writeDriveSnapshot(account, r.root, marked.entries, scannedAt, marked.meta);
        }
      },
    };
  }

  /**
   * 拿一个根这一轮的整棵树：有指纹接口、上一份是带指纹的快照、离上次整棵对比不到 12 小时，就按指纹增量；
   * 否则（首轮、旧格式、到点了、根自己按路径找不到或换了一个）整棵列。
   */
  private async scan(
    root: string,
    prev: { entries: SnapEntry[]; meta: SnapMeta | null } | null,
    opts: PullOptions,
  ): Promise<WalkResult & { full: boolean }> {
    const p = this.provider;
    const account = p.account.name;
    if (p.dirFingerprints && prev && hasFingerprints(prev) && Date.now() - prev.meta.fullAt < FULL_SCAN_MS) {
      const r = await incrementalWalk({ dirFingerprints: p.dirFingerprints.bind(p), listDir: p.listDir.bind(p) }, root, prev, {
        signal: opts.signal,
        onSkip: (dir, name) => log.warn({ account, root, dir, name }, "条目名字里带 /，按路径找不回来，跳过"),
      });
      if (r) {
        if (r.listed > 0) {
          const miss = r.missing.length > 0 ? `；按原路径没找到 ${r.missing.length} 个（${r.missing.slice(0, 3).join("、")}${r.missing.length > 3 ? " 等" : ""}）` : "";
          opts.log?.("debug", `${root} 比了 ${r.asked} 个目录的指纹，列了 ${r.listed} 个${miss}`);
        }
        return { ...r, full: false };
      }
      opts.log?.("debug", `${root} 根目录按原路径找不到了或者换了一个，整棵重新对比`);
    }
    const periodic = !!prev && hasFingerprints(prev);
    const r = await fullScan(p, root, prev, { signal: opts.signal });
    if (p.dirFingerprints && !r.meta.rootId) opts.log?.("debug", `${root} 按路径取不到根目录的指纹（名字里有接口认不出的字符？），只能每轮整棵列`);
    if (periodic) {
      opts.log?.("info", `${root} 整棵对比（每 12 小时一次）：${r.listed} 个目录`);
      if (r.misses.length > 0) {
        const where = r.misses.slice(0, 3).map((m) => m || "根目录").join("、");
        const msg = `${root} 整棵对比发现增量漏掉的变化：${r.misses.length} 个目录（${where}${r.misses.length > 3 ? " 等" : ""}），这一轮照常处理`;
        opts.log?.("warn", msg);
        log.warn({ account, root, misses: r.misses.slice(0, 20) }, msg);
      }
    }
    return { ...r, full: true };
  }

  private toEvent(account: string, root: string, c: SnapshotChange, at: number): ChangeEvent {
    const abs = (rel: string) => (root === "/" ? `/${rel}` : `${root}/${rel}`);
    return {
      id: `q:${account}:${at}:${c.kind}:${c.id}`,
      kind: c.kind,
      path: abs(c.path),
      oldPath: c.oldPath ? abs(c.oldPath) : null,
      isDir: c.isDir,
      nodeId: c.id,
      size: c.size,
      token: c.id,
      at,
    };
  }

  async probe(_limit: number, signal?: AbortSignal): Promise<ProbeResult> {
    try {
      const entries = await this.provider.listDir(this.provider.rootId, signal);
      const how = this.provider.dirFingerprints
        ? `每轮先比任务目录里各个目录的指纹、只列变了的（最短 ${this.minIntervalSeconds} 秒一轮），每 12 小时整棵对比一次`
        : `监控靠定时对比任务目录（最短 ${this.minIntervalSeconds} 秒一轮）`;
      return { ok: true, message: `cookie 有效，根目录 ${entries.length} 项；这个网盘没有事件流，${how}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
