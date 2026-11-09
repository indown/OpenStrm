/**
 * 「复制到 OpenList」的队列：记录形状、落库、去重、裁剪。
 *
 * 和云下载回执一样落在 settings 表的一个键里（`copy.queue`），进程重启不丢。
 * 不碰网络，纯读写 + 计算，好测。
 *
 * **写法上有一条硬要求**：推进队列的循环里夹着好几秒的网络等待，这期间监控 / 转存 / 追更
 * 随时会往同一个键里加记录，界面也可能重试或删掉某一条。所以绝不能「开头读一份、结尾整份写回」，
 * 那样会把期间别人写的东西整片抹掉。循环里的改动一律走 commitCopies（重读、按 id 合并、再写）。
 */
import { randomUUID } from "node:crypto";
import type { CopyAfterCopy } from "@openstrm/shared";
import { afterCopyOf } from "../../lib/after-copy.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { copyEngineLabel, copyEngineOf } from "./paths.js";
import { KEY } from "../../db/keys.js";

/** 谁把这条活儿丢进来的，给界面和通知看 */
export type CopyTrigger = "offline" | "share" | "follow" | "monitor" | "manual";
export type CopyStatus = "pending" | "done" | "skipped" | "failed";
/** pending 的两个阶段：waiting=等产物在 OpenList 里可见；copying=已提交，盯复制任务 */
export type CopyStage = "waiting" | "copying";

export interface CopyRecord {
  /** 队列内唯一，重试 / 删除按它来 */
  id: string;
  /** 网盘账号名（115 / 夸克 / 以后的），用来查挂载根，删源时也用它取 Provider */
  account: string;
  /** 源条目所在目录的网盘绝对路径 */
  srcDir: string;
  /** 源条目名（文件或目录） */
  name: string;
  /** 已知是目录就记上；不知道不填 */
  isDir?: boolean;
  /** 已知的网盘节点 id：删源时核对，整理把文件挪走之后不会删错 */
  nodeId?: string;
  /** 目标目录（OpenList 绝对路径）= dstBase + 源路径相对 rootPath 的那段层级 */
  dstDir: string;
  /** 目标的根（设置里的默认目标目录，或任务 / 这一次指定的）；整理挪了目录之后靠它重算 dstDir */
  dstBase: string;
  /** 源路径相对哪个根算层级（通常是任务的 originPath）；没有就是平铺 */
  rootPath?: string;
  /** 触发时的同步任务；没有就是空串 */
  taskId: string;
  trigger: CopyTrigger;
  /** 复制成功后源文件的去向（不动 / 删除 / 归档）。登记时按任务设置冻结，之后改设置不影响在途的 */
  afterCopy: CopyAfterCopy;
  /** 升级时从老的云下载回执接管过来的：只有 OpenList 任务 id，没有网盘路径 */
  adopted?: boolean;
  addedAt: number;
  status: CopyStatus;
  stage: CopyStage;
  detail: string;
  doneAt?: number;
  /** 提交 /fs/copy 的尝试次数：只有接口报错才加 */
  attempts: number;
  /** waiting 阶段：产物连续几轮没出现在 OpenList 的源目录里 */
  waits: number;
  /** copying 阶段：OpenList 的任务列表里连续几轮找不到这次复制 */
  misses: number;
  /** OpenList 建出来的复制任务 id */
  copyTaskId?: string;
  /** 提交时间（ms）：把 done 列表里的陈年同名任务滤掉 */
  submittedAt?: number;
  /** 用户点过「重试」：目标里已经有同名的时候不再当「复制过了」悄悄跳过 */
  retried?: boolean;
  /**
   * 等自动整理先办完（ms）：任务开着「把握大的直接执行」时，整理马上会在网盘上改名 / 挪目录，
   * 先复制的话要么复制成整理前的样子，要么复制到一半源文件被挪走。整理办完会提前放行（releaseCopyHolds），
   * 这个时间只是兜底
   */
  holdUntil?: number;
  /** 本来要删源、提交时核对不了网盘节点而关掉了：办完时把原因写进说明 */
  sourceKept?: string;
  /**
   * 复制成功了，去向（删 / 归档）碰上临时错误（网络断、超时、网盘 5xx）没做成：到 nextAt（ms）再做一次。
   * attempts 是已经晚点再做的次数（第一次失败后是 1）；why 是上一次的原因，通知里用。
   * 做成了、或者次数用完按「没按设置处理」收场（sourceKept）就清掉。记录照旧是 done
   */
  afterRetry?: { attempts: number; nextAt: number; why: string };
  /**
   * 这条用不着了（记成 skipped）：整理把目录里的文件挪走、已按文件另排；或者同一个目标后来由另一条复制好了。
   * 和「目标里已有同名」的跳过不一样，重试只会再失败一次
   */
  superseded?: boolean;
}

const QUEUE_KEY = KEY.copyQueue;
/**
 * 失败的留 7 天、办完的留 2 天，**只对办完 / 失败的**限 500 条。
 * 分开留是因为监控是一个文件一条记录：一季 40 集成功之后，如果和失败共用一个窗口 + 一个上限，
 * 唯一还能动手的那些失败记录会被挤掉。上限也不能套在 pending 上——一次大批量入队
 * 会把还在跑的（甚至已经提交给 OpenList 的）挤出去，那些复制就再没人跟了。
 */
const KEEP_FAILED_MS = 7 * 24 * 3600_000;
const KEEP_SETTLED_MS = 2 * 24 * 3600_000;
/** 办完 / 跳过的上限；失败的单独算，不然一批成功就把能动手的那些冲没了 */
const MAX_SETTLED_RECORDS = 500;
const MAX_FAILED_RECORDS = 200;
/** 刚办完的同一条不重复排：监控重来一轮（pullMode=all）会把同一批文件再报一遍 */
export const RECENT_DONE_MS = 24 * 3600_000;

/**
 * 推进循环正在跑的这一轮手里的记录（按 id）。循环中间夹着网络等待，这期间别处对同一条的改动
 * （界面 / 智能体的重试、整条目登记补上的删源、整理改写路径）要同时改到这些对象上：
 * 这一轮收尾是按 id 把它手里的对象写回去的，只改库里那份会被盖掉。由 service.ts 的推进循环在一轮开始时登记、结束时清空
 */
export const tickRecords = new Map<string, CopyRecord>();

/**
 * 改库里的一条记录时，推进循环这一轮手里的同一条也照样改一遍——所有改动方（重试、补删源、去掉、并进整目录、整理改写路径）都走这里。
 * when：这一轮手里的那个对象满足才改（比如「还在排队、没提交」：已经提交出去的按提交时的样子走完）；不给就总改
 */
export function mirrorLive(id: string, fn: (live: CopyRecord) => void, when: (live: CopyRecord) => boolean = () => true): void {
  const live = tickRecords.get(id);
  if (live && when(live)) fn(live);
}

/** 这一轮手里的那个对象还在排队、没提交（推进循环在调 /fs/copy 之前就会把要提交的记成 copying） */
export const stillQueued = (live: CopyRecord): boolean => live.status === "pending" && live.stage === "waiting";

/**
 * 库里的这条眼下还没提交：库里排着，推进循环这一轮手里的同一条（有的话）也还排着。
 * 提交请求在路上的那一下库里还写着「排队」，手里的已经记成「复制中」了，要按手里的算
 */
export function queuedNow(c: CopyRecord): boolean {
  const live = tickRecords.get(c.id);
  return stillQueued(c) && (!live || stillQueued(live));
}

export function listCopies(): CopyRecord[] {
  const rows = readKv<StoredRecord[]>(QUEUE_KEY);
  return Array.isArray(rows) ? rows.map(normalizeRecord) : [];
}

/** 库里的一条：老记录只有 deleteSource */
type StoredRecord = Omit<CopyRecord, "afterCopy"> & { afterCopy?: CopyAfterCopy; deleteSource?: boolean };

/** 老记录的 deleteSource 收成 afterCopy（认不得的值当不动），别的代码只认 afterCopy */
function normalizeRecord(c: StoredRecord): CopyRecord {
  const afterCopy = afterCopyOf(c);
  if (c.afterCopy === afterCopy && c.deleteSource === undefined) return c as CopyRecord;
  const { deleteSource: _legacy, ...rest } = c;
  return { ...rest, afterCopy };
}

/** 整份写回。只给「这一份就是全部」的调用方（登记、接管、重置）用，循环里别用 */
export function saveCopies(rows: CopyRecord[], now = Date.now()): void {
  const pending: CopyRecord[] = [];
  const failed: CopyRecord[] = [];
  const settled: CopyRecord[] = [];
  for (const c of rows) {
    if (c.status === "pending") pending.push(c);
    else if (c.status === "failed") {
      if (now - (c.doneAt ?? c.addedAt) < KEEP_FAILED_MS) failed.push(c);
    } else if (now - (c.doneAt ?? c.addedAt) < KEEP_SETTLED_MS) settled.push(c);
  }
  const newest = (a: CopyRecord, b: CopyRecord) => b.addedAt - a.addedAt;
  failed.sort(newest);
  settled.sort(newest);
  writeKv(
    QUEUE_KEY,
    [...pending, ...failed.slice(0, MAX_FAILED_RECORDS), ...settled.slice(0, MAX_SETTLED_RECORDS)].sort(newest),
  );
}

/**
 * 把改过的记录合并回库：重读一份、按 id 覆盖，别人期间新加的照旧留着、删掉的不复活。
 * added 是新拆出来的记录（整理把目录里的文件挪走了，按文件另起的），库里已经有一样的就不加。
 * 读—改—写之间没有 await，对别的 JS 代码是原子的。
 */
export function commitCopies(changed: CopyRecord[], now = Date.now(), added: CopyRecord[] = []): void {
  if (changed.length === 0 && added.length === 0) return;
  const byId = new Map(listCopies().map((r) => [r.id, r]));
  let touched = false;
  for (const c of changed) {
    if (!byId.has(c.id)) continue; // 期间被删掉了，不复活
    byId.set(c.id, c);
    touched = true;
  }
  for (const c of added) {
    if (byId.has(c.id) || isDuplicate([...byId.values()], c, now)) continue;
    byId.set(c.id, c);
    touched = true;
  }
  if (touched) saveCopies([...byId.values()], now);
}

/** 同一个来源、同一个目标 */
export function sameTarget(
  a: Pick<CopyRecord, "account" | "srcDir" | "name" | "dstDir">,
  b: Pick<CopyRecord, "account" | "srcDir" | "name" | "dstDir">,
): boolean {
  return a.account === b.account && a.srcDir === b.srcDir && a.name === b.name && a.dstDir === b.dstDir;
}

/**
 * 已经排着的一样的一条、或者刚复制完没多久的那条：有就不重复登记，没有返回 undefined。
 * 重试（retryCopy）走的是另一条路，不看这里。
 */
export function findDuplicate(rows: CopyRecord[], next: CopyRecord, now = Date.now()): CopyRecord | undefined {
  return rows.find(
    (r) => sameTarget(r, next) && (r.status === "pending" || ((r.status === "done" || r.status === "skipped") && now - (r.doneAt ?? 0) < RECENT_DONE_MS)),
  );
}

export const isDuplicate = (rows: CopyRecord[], next: CopyRecord, now = Date.now()): boolean => findDuplicate(rows, next, now) !== undefined;

export const hasPendingCopies = (): boolean => listCopies().some((c) => c.status === "pending");

/** 已经复制好、源文件的去向还等着晚点再做的 */
export const awaitingAfterRetry = (c: CopyRecord): boolean => c.status === "done" && c.afterRetry !== undefined;

/** 推进循环还有活：排着的，或者去向等着晚点再做的（循环要转到它们做完，重启后也要起） */
export const hasCopyWork = (): boolean => listCopies().some((c) => c.status === "pending" || awaitingAfterRetry(c));

/** 整理挪过 / 改过名的一个文件，任务相对路径 */
export interface CopyMove {
  from: string;
  to: string;
}

/**
 * 整理把任务下的东西改名 / 挪走之后，队列里**还没提交**的待办跟着改
 * （同 rewriteOfflineSubPaths / rewriteFollowSubPaths）。已经提交给 OpenList 的不动：
 * 源路径改了也追不回来，让它按 OpenList 的结果自然结束，用户可以重试。
 *
 * 路径都是**任务相对**的，记录里存的是网盘绝对路径，所以先脱掉 originPath、改完再拼回去；
 * 目标目录按 dstBase 重算，免得停在改名前的层级上。按精确程度依次看：
 *   1. fileMoves：这次真正挪过 / 改过名的文件。文件待办按它改到新位置（整理最常见的就是
 *      「一集挪进作品目录、顺手改名」，所在目录没腾空，目录级的映射里根本没有它）。
 *   2. 目录待办里有文件被挪走了：挪走的每个文件另起一条跟过去；目录本身被腾空删掉了（removed）
 *      就不再复制它，记成跳过并说明，没腾空就留着复制剩下的。
 *   3. mappings：腾空删掉的目录 → 里面的东西去了哪（目录级），兜住上面没点名的（比如季目录整个挪走）。
 * dryRun 只返回会受影响的相对路径。
 */
export function rewriteCopyPaths(
  taskId: string,
  originPath: string,
  mappings: Array<{ from: string; to: string }>,
  dryRun = false,
  layout?: (dstBase: string, rootPath: string | undefined, srcPath: string) => string,
  fileMoves: CopyMove[] = [],
  removed: ReadonlySet<string> = new Set(),
  now = Date.now(),
): string[] {
  const rows = listCopies();
  const root = originPath.replace(/^\/+|\/+$/g, "");
  const absOf = (rel: string) => (root === "" ? `/${rel}` : `/${root}/${rel}`);
  const hit: string[] = [];
  const changed: CopyRecord[] = [];
  const added: CopyRecord[] = [];
  /** 把一条记录挪到任务相对路径 rel 上：名字、所在目录、目标目录一起改 */
  const place = (c: CopyRecord, rel: string) => {
    const nextAbs = absOf(rel);
    const segs = nextAbs.split("/").filter(Boolean);
    c.name = segs.pop() ?? c.name;
    c.srcDir = segs.length ? `/${segs.join("/")}` : "/";
    if (layout) c.dstDir = layout(c.dstBase, c.rootPath, nextAbs);
  };
  /**
   * 推进循环这一轮手里还没提交的同一条也跟着改：不然这一轮收尾按 id 写回时，会把新路径盖回旧路径
   * （这一轮已经提交出去的照旧不动，和上面「已经提交给 OpenList 的不动」同一个规则）
   */
  const syncLive = (c: CopyRecord) =>
    mirrorLive(
      c.id,
      (live) => {
        const { name, srcDir, dstDir, status, superseded, doneAt, detail } = c;
        Object.assign(live, { name, srcDir, dstDir }, status !== "pending" ? { status, superseded, doneAt, detail } : {});
      },
      (live) => live !== c && stillQueued(live),
    );
  const sorted = [...mappings].sort((a, b) => b.from.length - a.from.length);
  for (const c of rows) {
    if (c.taskId !== taskId || !queuedNow(c)) continue;
    const abs = `${c.srcDir}/${c.name}`.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
    const rel = root === "" ? abs : abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null;
    if (rel === null) continue;
    if (dryRun) {
      hit.push(rel);
      continue;
    }
    const own = fileMoves.find((m) => m.from === rel);
    if (own) {
      hit.push(rel);
      place(c, own.to);
      changed.push(c);
      continue;
    }
    const inner = fileMoves.filter((m) => m.from.startsWith(`${rel}/`));
    if (inner.length > 0) {
      hit.push(rel);
      for (const m of inner) {
        const piece: CopyRecord = {
          ...c,
          id: randomUUID(),
          isDir: false,
          // 目录的 id 对不上里面的文件；删源前在提交时重新取
          nodeId: undefined,
          detail: `整理把它从「${c.name}」里挪了出来，单独复制`,
          attempts: 0,
          waits: 0,
          misses: 0,
        };
        place(piece, m.to);
        added.push(piece);
      }
      if (removed.has(rel)) {
        c.status = "skipped";
        c.superseded = true;
        c.doneAt = now;
        c.detail = `整理把「${c.name}」里的文件挪到了别处（目录已腾空删掉），已按文件分别排队复制`;
        changed.push(c);
      }
      continue;
    }
    const m = sorted.find((x) => rel === x.from || rel.startsWith(`${x.from}/`));
    if (!m) continue;
    hit.push(rel);
    place(c, rel === m.from ? m.to : `${m.to}${rel.slice(m.from.length)}`);
    changed.push(c);
  }
  for (const c of changed) syncLive(c);
  if (changed.length > 0 || added.length > 0) commitCopies(changed, now, added);
  return hit;
}

/**
 * 自动整理办完了（执行完、或者这次没有要动的、或者留着等人确认）：把这个任务里
 * 在整理开始之前登记、还压着没放的复制放行，不用干等兜底时间。
 * 整理开始之后才登记的不放——它们要等下一次整理。返回放了几条
 */
export function releaseCopyHolds(taskId: string, before: number, now = Date.now()): number {
  const changed = listCopies().filter(
    (c) => c.taskId === taskId && c.status === "pending" && c.stage === "waiting" && (c.holdUntil ?? 0) > now && c.addedAt <= before,
  );
  const who = copyEngineLabel(copyEngineOf(readAppSettings()));
  for (const c of changed) {
    c.holdUntil = undefined;
    c.detail = `自动整理办完了，等着 ${who} 复制`;
  }
  commitCopies(changed, now);
  return changed.length;
}

/**
 * 按 id 放行压着等整理的复制：登记时说要等的那次整理不会来了（比如转存完生成 strm 失败，这次没交给整理）。
 * 只动给的这几条：同一个任务里在等别的整理的不能跟着放。返回放了几条
 */
export function releaseCopyHoldsById(ids: readonly string[], now = Date.now()): number {
  if (ids.length === 0) return 0;
  const want = new Set(ids);
  const changed = listCopies().filter((c) => want.has(c.id) && queuedNow(c) && c.holdUntil !== undefined);
  const who = copyEngineLabel(copyEngineOf(readAppSettings()));
  for (const c of changed) {
    c.holdUntil = undefined;
    c.detail = `这次没交给整理，等着 ${who} 复制`;
  }
  commitCopies(changed, now);
  return changed.length;
}

/** 仅供测试 / 重置：清空队列 */
export function clearCopies(): void {
  writeKv(QUEUE_KEY, []);
}
