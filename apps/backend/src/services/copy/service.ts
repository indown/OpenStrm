/**
 * 「复制到 OpenList」：新落到网盘上的文件，让 OpenList 复制到另一个存储（如挂载的本地磁盘）。
 *
 *   - 谁都能往这里丢活儿：云下载、转存、追更、网盘监控，调 enqueueCopy 就行。
 *     它同步返回、不碰网络、绝不往调用方抛——复制是锦上添花，不能把转存本身搞失败。
 *   - 队列落在 settings 表的 `copy.queue` 键里（见 ./queue.ts），进程重启不丢。
 *   - 一个后台循环推进两个阶段：
 *       waiting  产物在 OpenList 里可见了没有（列目录必须带 refresh，不然看的是缓存）→ 提交 /fs/copy；
 *       copying  盯着复制任务，全部结束后对成败。
 *     两个阶段各有各的计数器：waits（产物还没出现，等 10 轮）和 misses（任务列表里找不到，3 轮），
 *     换阶段时把对方清零，免得一个计数器两个含义。
 *   - 源目录在 OpenList 里找不到时先从挂载根往下逐级刷新再看（OpenList 靠父目录的缓存找子目录，
 *     网盘上刚建 / 刚改名的目录直接刷新会报找不到）；挂载根本身都没有才第一轮就失败，不白等 10 轮。
 *   - 任务开着「把握大的直接执行」的自动整理时，登记的先压着等整理在网盘上改完名再复制（holdUntil），
 *     整理办完提前放行；整理挪走的文件由整理那边改写队列里的路径（rewriteCopyPaths）。
 *   - 没待办时循环自己停掉，不白打接口。
 *
 * 路径换算在 ./paths.ts：网盘绝对路径 + 这个账号的挂载根 = OpenList 里的路径。
 */
import { randomUUID } from "node:crypto";
import type { AppSettings, CopyAfterCopy, TaskDefinition } from "@openstrm/shared";
import { ARCHIVE_DIR, underArchive } from "../strm/staging.js";
import { KEY } from "../../db/keys.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { isAbortError, messageOf, networkErrorText } from "../../lib/errors.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { createPollingLoop } from "../../lib/polling.js";
import {
  copyStateSucceeded,
  openlistCopy,
  openlistCopyTasks,
  openlistListDir,
  openlistMkdir,
  OpenlistError,
  type OpenlistTaskInfo,
} from "../openlist/client.js";
import { notify, type NotifyEvent } from "../notify.js";
import { scheduleEmbyRefresh } from "../media-server.js";
import { events } from "../events.js";
import fsp from "node:fs/promises";
import path from "node:path";
import { removeEmptyParents } from "../../lib/fs.js";
import { matchTask } from "../life/handlers.js";
import { mirrorDelete } from "../strm/mirror.js";
import { accountIssueOf, driveErrorFacts } from "../drive/errors.js";
import { providerForAccount } from "../drive/registry.js";
import type { DriveEntry, DriveNode, DriveProvider } from "../drive/types.js";
import { listTasks } from "../../db/repositories/tasks.js";
import {
  baseName,
  dstDirFor,
  joinPath,
  normDir,
  normTargetDir,
  parentDir,
  relativeTo,
  resolveCopyConfig,
  toOpenlistPath,
  type CopyConfig,
  type CopyOptions,
} from "./paths.js";
import {
  awaitingAfterRetry,
  commitCopies,
  findDuplicate,
  hasCopyWork,
  listCopies,
  mirrorLive,
  queuedNow,
  sameTarget,
  saveCopies,
  stillQueued,
  tickRecords,
  type CopyRecord,
  type CopyStatus,
  type CopyTrigger,
} from "./queue.js";

const log = moduleLogger("copy");

export type { CopyRecord, CopyStatus, CopyTrigger } from "./queue.js";
export { listCopies } from "./queue.js";

const POLL_MS = 30_000;
const MAX_ATTEMPTS = 3;
/** 网盘报完成到产物在 OpenList 里可见有延迟，多等几轮（约 5 分钟）再放弃 */
const MAX_WAITS = 10;
const MAX_MISSES = 3;
/** 刚登记的先晾一会儿：监控是一个文件一条事件，晾这一下同目录的兄弟文件就能并进同一批 */
const SETTLE_MS = 10_000;
/**
 * 任务开着「把握大的直接执行」时最多等自动整理多久。整理办完会提前放行，这只是兜底：
 * 监控的整理要攒 30 秒，一季几十集识别 + 在网盘上挪也要一两分钟
 */
const ORGANIZE_HOLD_MS = 10 * 60_000;
/** 排了这么久还没复制完就不再跟踪 */
const PENDING_MAX_AGE_MS = 7 * 24 * 3600_000;
/**
 * 复制后的去向（删 / 归档）碰上临时错误（网络断、超时、网盘 5xx）隔多久再做：三次都不成才按「没按设置处理」收场。
 * 真机撞到过 115 接口连着一两分钟不回话，当场重试多半还是卡，所以隔开一点
 */
const AFTER_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

export const COPY_TRIGGER_LABEL: Record<CopyTrigger, string> = {
  offline: "云下载",
  share: "转存",
  follow: "追更",
  monitor: "网盘监控",
  manual: "手动",
};

/* ------------------------------- 依赖注入 ------------------------------- */

/** OpenList 目标目录里的一条：核对复制全不全时比名字，文件再比大小（不知道大小的不比） */
export interface OpenlistTargetEntry {
  name: string;
  isDir?: boolean;
  size?: number;
}

interface Deps {
  openlist: {
    /** 刷新目录缓存并返回其中的条目名 */
    listNames: (cfg: CopyConfig, dir: string) => Promise<string[]>;
    /**
     * 同上，但每条带类型和大小：事后处理源文件（copy/after.ts）核对目标里那份全不全时，文件还要比大小。
     * 测试桩可以不给，那就只比名字（listOpenlistEntries 会按 listNames 补）
     */
    listEntries?: (cfg: CopyConfig, dir: string) => Promise<OpenlistTargetEntry[]>;
    /** 建目标目录（OpenList 的 /fs/copy 不会自己建） */
    mkdir: (cfg: CopyConfig, dir: string) => Promise<void>;
    /** 提交复制；返回的任务和 names 一一对应 */
    copy: (cfg: CopyConfig, srcDir: string, dstDir: string, names: string[]) => Promise<OpenlistTaskInfo[]>;
    /** 复制任务的进行中 + 已结束列表 */
    copyTasks: (cfg: CopyConfig) => Promise<{ undone: OpenlistTaskInfo[]; done: OpenlistTaskInfo[] }>;
  };
  notify: (event: NotifyEvent) => Promise<unknown>;
  settings: () => AppSettings;
  listTasks: () => TaskDefinition[];
  now: () => number;
  /** 复制完的后续动作，抽出来是为了测试能断言它们被调过（自动整理走 files.landed 事件，测试订阅它） */
  embyRefresh: () => void;
  /** 删源：按网盘路径找到节点再删，找不到 / id 对不上就不删 */
  removeSource: (account: string, path: string, nodeId?: string) => Promise<"removed" | "missing" | "changed" | "unsupported">;
  /**
   * 归档：挪进任务目录下的「归档」，原来的层级留着。rootPath 是登记时冻结的任务目录。
   * retry：晚点再做的那一次，源不见了要看看是不是上次其实已经挪过去了
   */
  archiveSource: (account: string, path: string, nodeId: string | undefined, rootPath: string | undefined, opts?: { retry?: boolean }) => Promise<ArchiveResult>;
  /** 网盘上这个目录里有哪些条目名：删源前核对目录复制全了没有 */
  listDriveChildren: (account: string, path: string) => Promise<string[]>;
  /** 网盘上这个路径现在是哪个节点：要删源又没带节点 id 的（追更、115 转存），提交时钉住 */
  resolveNodeId: (account: string, path: string) => Promise<string | null>;
  /** 删源之后把本地对应的 strm / 下载文件（目录就整个目录）也删掉；本地没有返回 false */
  removeLocalMirror: (account: string, path: string, isDir: boolean | undefined) => Promise<boolean>;
}

const realDeps: Deps = {
  openlist: {
    listNames: async (cfg, dir) => (await openlistListDir(cfg.account, dir, { refresh: true })).map((e) => e.name),
    listEntries: async (cfg, dir) => (await openlistListDir(cfg.account, dir, { refresh: true })).map((e) => ({ name: e.name, isDir: e.is_dir, size: e.size })),
    mkdir: (cfg, dir) => openlistMkdir(cfg.account, dir),
    copy: (cfg, srcDir, dstDir, names) => openlistCopy(cfg.account, srcDir, dstDir, names),
    copyTasks: (cfg) => openlistCopyTasks(cfg.account),
  },
  notify,
  settings: readAppSettings,
  listTasks,
  now: () => Date.now(),
  embyRefresh: scheduleEmbyRefresh,
  removeSource: removeSourceReal,
  archiveSource: archiveSourceReal,
  listDriveChildren: listDriveChildrenReal,
  resolveNodeId: async (account, path) => (await lookupFresh(account, path))?.id ?? null,
  removeLocalMirror: removeLocalMirrorReal,
};

let deps: Deps = { ...realDeps };

/** 仅供测试：换掉会碰网络的几步；传 null 恢复 */
export function setCopyServiceDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 登记 ------------------------------- */

export interface CopySource {
  /** 网盘绝对路径 */
  path: string;
  isDir?: boolean;
  /** 网盘节点 id，删源时核对用 */
  nodeId?: string;
}

export interface CopyRequest {
  /** 网盘账号名（115 / 夸克 / 以后的都一样） */
  account: string;
  /** 网盘绝对路径；只有路径时直接给字符串 */
  sources: Array<string | CopySource>;
  /** 这些路径相对哪个根算目录结构（通常是 task.originPath）；不给就平铺到目标目录 */
  rootPath?: string;
  taskId?: string;
  /** 这一次复制到哪（OpenList 完整路径）；不给用设置里的 dstDir */
  dstDir?: string;
  trigger: CopyTrigger;
  /** 复制成功后源文件的去向（任务级设置，登记时冻结）；不给就是不动 */
  afterCopy?: CopyAfterCopy;
  /**
   * 调用方刚为这些路径排了一次会直接执行的自动整理：先压着，等整理在网盘上改完名、挪完目录再复制，
   * 不然要么复制成整理前的样子，要么复制到一半源文件被挪走。整理办完会放行（releaseCopyHolds）
   */
  holdForOrganize?: boolean;
}

export interface CopyEnqueueResult {
  /** 真排上队的条数 */
  queued: number;
  /** 一条都没排上的原因（配置没配好 / 没填挂载根 / 都重复了）；排上了就是 null */
  skipped: string | null;
  /** 复制到哪个目标根（这一次指定的，或设置里的默认目标目录）；没走到定目标那一步就不带 */
  dstDir?: string;
  /** 已经排着、或刚复制过而没再登记的条数 */
  duplicates?: number;
  /** 没再登记的那些里，排着的复制完要删源 / 归档的（可能是这次补上的）：调用方回显去向时要算上 */
  pendingAfterCopy?: Exclude<CopyAfterCopy, "keep">;
  /** 网盘监控登记时，被还没提交的整目录复制包着、交给它一起带过去而没再登记的条数 */
  covered?: number;
  /** 这次新排上的记录 id */
  ids?: string[];
  /** 每条来源的下场（路径原样）：调用方要按路径回话时用 */
  perSource?: Array<{ path: string; outcome: "queued" | "duplicate" | "covered" }>;
}

/**
 * 一次转存 / 追更的新增交没交给复制队列，回给调用方看：智能体的结果里要如实说排没排上、复制完删不删源。
 * 没开复制（任务没开、这次也没要）的，调用方拿到的是 undefined
 */
export interface CopyOutcome {
  /** 真排上队的条数；0 时 reason 说为什么 */
  queued: number;
  /** 复制到哪个目标根（OpenList 路径），条目按任务目录的层级摆在它下面；没走到定目标那一步是 null */
  dstDir: string | null;
  /** 复制成功后源文件的去向 */
  afterCopy: CopyAfterCopy;
  /** 等于 afterCopy === "delete"：智能体的结果里一直有这个字段，留着 */
  deleteSource: boolean;
  /** 一条都没排上的原因：设置没配好、没填挂载根、都重复了 */
  reason?: string;
}

/**
 * 登记待复制。同步返回、不碰网络、绝不抛：配置没配好、这个账号没配挂载根，都只记一条日志——
 * 调用方是转存 / 追更 / 监控，它们本身已经成功了，不能因为复制没配好就失败。
 * **返回值别忽略**：云下载那边要据此决定回执算不算兑现，不然会把「其实没排上」记成办完了。
 */
export function enqueueCopy(req: CopyRequest): CopyEnqueueResult {
  try {
    const sources = req.sources
      .map((s) => (typeof s === "string" ? { path: s } : s))
      .filter((s) => s.path && s.path.trim());
    if (sources.length === 0) return { queued: 0, skipped: null };

    let cfg: CopyConfig;
    try {
      cfg = resolveCopyConfig(deps.settings());
    } catch (err) {
      const why = `「复制到 OpenList」没配置好：${messageOf(err)}`;
      log.debug(`${req.account} 有 ${sources.length} 个新文件要复制，但${why}`);
      return { queued: 0, skipped: why };
    }
    if (!cfg.mounts[req.account]) {
      const why = `账号 ${req.account} 没填「在 OpenList 里的挂载根」`;
      log.debug(`${why}，这次的 ${sources.length} 个新文件不复制`);
      return { queued: 0, skipped: why };
    }

    const base = normTargetDir(req.dstDir) || cfg.dstDir;
    if (!base) {
      const why = "没有可用的目标目录：设置页的默认目标目录和任务上的都是空的";
      log.debug(`${req.account}：${why}`);
      return { queued: 0, skipped: why };
    }
    const now = deps.now();
    const rows = listCopies();
    const fresh: CopyRecord[] = [];
    /** 按「账号 + 所在目录 + 名字」索引：找重复不用每条都扫一遍整个队列（补齐一次能登记几千条） */
    const byName = new Map<string, CopyRecord[]>();
    const keyOf = (c: Pick<CopyRecord, "account" | "srcDir" | "name">) => JSON.stringify([c.account, c.srcDir, c.name]);
    const remember = (c: CopyRecord) => byName.set(keyOf(c), [...(byName.get(keyOf(c)) ?? []), c]);
    for (const c of rows) remember(c);
    const perSource: NonNullable<CopyEnqueueResult["perSource"]> = [];
    /** 被这次补上删源的、已经排着的记录 */
    const upgraded: CopyRecord[] = [];
    /** 被这次的整条目并进去的监控记录 */
    const merged: CopyRecord[] = [];
    let duplicates = 0;
    let covered = 0;
    let pendingAfterCopy: Exclude<CopyAfterCopy, "keep"> | undefined;
    for (const s of sources) {
      // 不 trim：网盘上真有「Season 1 」这种带尾空格的名字，削掉就找不到了
      const srcPath = s.path;
      const { dstDir, flattened } = dstDirFor(base, req.rootPath, srcPath);
      const rec: CopyRecord = {
        id: randomUUID(),
        account: req.account,
        srcDir: parentDir(srcPath),
        name: baseName(srcPath),
        isDir: s.isDir,
        nodeId: s.nodeId,
        dstDir,
        dstBase: base,
        rootPath: req.rootPath,
        taskId: req.taskId ?? "",
        trigger: req.trigger,
        afterCopy: req.afterCopy ?? "keep",
        addedAt: now,
        status: "pending",
        stage: "waiting",
        detail: flattened
          ? "等着复制到 OpenList（路径不在任务目录下，平铺复制）"
          : req.holdForOrganize
            ? "等自动整理先在网盘上改完名再复制"
            : "等着复制到 OpenList",
        attempts: 0,
        waits: 0,
        misses: 0,
        ...(req.holdForOrganize ? { holdUntil: now + ORGANIZE_HOLD_MS } : {}),
      };
      if (!rec.name) continue;
      // 网盘监控是一个文件一条：被一条还没提交的整条目复制包着、落点一样的，那一条会把它一起带过去，不再单独登记。
      // 单独登记的话它先按文件复制完，轮到整条目时目标里已经有了只能跳过，任务的「复制后删源」就落空了
      if (rec.trigger === "monitor" && [...rows, ...fresh].some((w) => coversRecord(w, rec))) {
        covered++;
        perSource.push({ path: srcPath, outcome: "covered" });
        continue;
      }
      const dup = findDuplicate(byName.get(keyOf(rec)) ?? [], rec, now);
      if (!dup) {
        fresh.push(rec);
        remember(rec);
        perSource.push({ path: srcPath, outcome: "queued" });
        continue;
      }
      duplicates++;
      perSource.push({ path: srcPath, outcome: "duplicate" });
      if (upgradeAfterCopy(dup, rec)) upgraded.push(dup);
      if (dup.status === "pending" && dup.afterCopy !== "keep") pendingAfterCopy = dup.afterCopy;
    }
    // 反过来：整条目来登记时，它里面还没提交、落点一样的监控记录并进来（标成用不着了），由这一条整个带过去
    for (const w of fresh) {
      for (const o of rows) {
        if (o.trigger !== "monitor" || !queuedNow(o) || !coversRecord(w, o)) continue;
        mergeInto(o, w, now);
        mirrorLive(o.id, (live) => mergeInto(live, w, now), stillQueued);
        merged.push(o);
      }
    }
    const counts = { dstDir: base, duplicates, covered, perSource, ...(pendingAfterCopy ? { pendingAfterCopy } : {}) };
    const nothing = covered > 0 && duplicates === 0 ? "整目录的复制会把它们一起带过去" : "这些条目已经在队列里或刚复制过";
    if (fresh.length === 0 && upgraded.length === 0) return { queued: 0, skipped: nothing, ...counts };
    saveCopies([...fresh, ...rows]);
    if (upgraded.length > 0) log.info(`${upgraded.length} 个已经排着的复制补上了复制后的去向（来自${COPY_TRIGGER_LABEL[req.trigger]}）`);
    if (merged.length > 0) log.info(`${merged.length} 个网盘监控按文件登记的复制并进了整目录的复制（来自${COPY_TRIGGER_LABEL[req.trigger]}）`);
    if (fresh.length === 0) return { queued: 0, skipped: nothing, ...counts };
    log.info(`登记 ${fresh.length} 个待复制（${req.account} → ${base}，来自${COPY_TRIGGER_LABEL[req.trigger]}）`);
    startCopyWatcher();
    return { queued: fresh.length, skipped: null, ...counts, ids: fresh.map((c) => c.id) };
  } catch (err) {
    // 登记失败不能影响调用方：转存 / 追更本身已经成功了
    log.warn({ err }, `登记复制待办失败（${req.account}，来自${COPY_TRIGGER_LABEL[req.trigger]}），这次不复制`);
    return { queued: 0, skipped: messageOf(err) };
  }
}

/**
 * 整条目 outer 会不会把 inner 一起带过去：outer 还没提交（整目录复制会带上里面届时的一切）、同账号、inner 在它下面，
 * 而且按 outer 的层级摆出来的目标目录和 inner 自己的一样（弹框里另选了目的地的不算，那是两份复制）；
 * inner 复制完要删源 / 归档的，outer 得是同一种去向，不然那个意图就丢了
 */
function coversRecord(outer: CopyRecord, inner: CoverCandidate): boolean {
  if (!queuedNow(outer) || outer.adopted || outer.srcDir === "") return false;
  if (inner.adopted || inner.srcDir === "" || outer.account !== inner.account || !isInside(fullPathOf(inner), fullPathOf(outer))) return false;
  if (inner.afterCopy !== "keep" && inner.afterCopy !== outer.afterCopy) return false;
  return dstDirFor(outer.dstBase, outer.rootPath, fullPathOf(inner)).dstDir === inner.dstDir;
}

/** 会不会被整条目带过去，只看这几样 */
type CoverCandidate = Pick<CopyRecord, "account" | "srcDir" | "name" | "dstDir" | "afterCopy"> & { adopted?: boolean };

/** 队列里有没有一条还没提交的整条目复制会把这条一起带过去：手动发起时用来告诉用户「不用单独登记」 */
export function findCoveringRecord(inner: CoverCandidate): CopyRecord | undefined {
  return listCopies().find((w) => coversRecord(w, inner));
}

/** 监控记录并进整条目：标成用不着了（不给重试），说明里写进了谁 */
function mergeInto(c: CopyRecord, whole: CopyRecord, now: number): void {
  c.status = "skipped";
  c.superseded = true;
  c.doneAt = now;
  c.detail = `并进了「${whole.name}」的整目录复制，由它一起带过去`;
}

/**
 * 同一个文件已经排着一条复制完不动源的（网盘监控是一个文件一条事件，一律不动），这次整条目的登记（转存 / 追更 / 云下载）
 * 却带着任务的「复制后删除 / 归档」：补到那一条上，不然谁先登记决定源文件的去向，删源 / 归档就这么悄悄丢了。
 * 只补认得出节点的（那一条或这次带着节点 id）：已经提交了的不会再钉节点，动源文件的时候要能核对是不是原来那一份。
 * 已经排着的是删除、这次是归档（或反过来）：算先登记的，不改。
 * 正在跑的那一轮手里的同一条也一起改，免得它收尾写回时盖掉。补上了返回 true
 */
export function upgradeAfterCopy(dup: CopyRecord, rec: Pick<CopyRecord, "afterCopy" | "nodeId" | "holdUntil">): boolean {
  if (rec.afterCopy === "keep" || dup.afterCopy !== "keep" || dup.status !== "pending" || dup.adopted) return false;
  const nodeId = dup.nodeId ?? rec.nodeId;
  if (!nodeId) return false;
  const apply = (c: CopyRecord) => {
    c.afterCopy = rec.afterCopy;
    c.nodeId = nodeId;
    c.sourceKept = undefined;
    // 整条目那边在等自动整理：还没提交的跟着等，别在整理改名之前就复制走、删掉
    if (c.stage === "waiting" && rec.holdUntil && (c.holdUntil ?? 0) < rec.holdUntil) c.holdUntil = rec.holdUntil;
  };
  apply(dup);
  mirrorLive(dup.id, apply, (live) => live !== dup);
  return true;
}

/**
 * 按 copyOptionsFor 的结论登记：没开就什么都不做（undefined）；开着却卡住（设置没配好）的交给 onBlocked 记一笔，
 * 并照实回给调用方，不然用户只看到「开着复制，什么都没发生」。目标目录、删源都按结论来，调用方不用再传。
 * onQueued 拿到这次新排上的记录 id（回给调用方的结果里不带它们）
 */
export function enqueueCopyFor(
  opts: CopyOptions,
  req: Omit<CopyRequest, "dstDir" | "afterCopy">,
  onBlocked?: (why: string) => void,
  onQueued?: (ids: string[]) => void,
): CopyOutcome | undefined {
  if (opts.blocked) {
    onBlocked?.(opts.blocked);
    return { queued: 0, dstDir: null, ...withAfterCopy("keep"), reason: opts.blocked };
  }
  if (!opts.enabled) return undefined;
  const r = enqueueCopy({ ...req, dstDir: opts.dstDir, afterCopy: opts.afterCopy });
  if (r.ids?.length) onQueued?.(r.ids);
  // 去向：这次新排的按这次的结论；新排的不动、或没再排的，按已经排着的那条（可能是别的来源登记的，也可能刚补上）
  const afterCopy: CopyAfterCopy = (r.queued > 0 && opts.afterCopy !== "keep" ? opts.afterCopy : undefined) ?? r.pendingAfterCopy ?? "keep";
  return { queued: r.queued, dstDir: r.dstDir ?? null, ...withAfterCopy(afterCopy), ...(r.skipped ? { reason: r.skipped } : {}) };
}

/** OpenList 里某个目录的一层条目名（刷新缓存）。手动复制补齐时比对目标用；走 deps，测试能换成桩 */
export const listOpenlistNames = (cfg: CopyConfig, dir: string): Promise<string[]> => deps.openlist.listNames(cfg, dir);

/** 同上，带类型和大小；桩只给了 listNames 的就只有名字 */
export const listOpenlistEntries = async (cfg: CopyConfig, dir: string): Promise<OpenlistTargetEntry[]> =>
  deps.openlist.listEntries ? deps.openlist.listEntries(cfg, dir) : (await deps.openlist.listNames(cfg, dir)).map((name) => ({ name }));

/** 结果里去向的两个字段：afterCopy 是准的，deleteSource 是给一直读它的调用方留的 */
export const withAfterCopy = (afterCopy: CopyAfterCopy): Pick<CopyOutcome, "afterCopy" | "deleteSource"> => ({ afterCopy, deleteSource: afterCopy === "delete" });

/* ------------------------------- 推进 ------------------------------- */

/**
 * 落定一条记录。成败都攒进 settledThisTick，一轮结束合成一条通知——
 * 队列是一个文件一条记录，一季四十集逐条发的话 Telegram 那边限流会把后面的直接丢掉。
 * 失败**一定要有通知**：四个触发点都是无人看着的后台活儿，只写进队列的话，
 * 除非用户恰好打开云下载页，否则永远不知道复制没成。
 */
function finish(c: CopyRecord, status: Exclude<CopyStatus, "pending">, detail: string, opts: { notify?: boolean } = {}): void {
  c.status = status;
  c.detail = detail;
  c.doneAt = deps.now();
  if (opts.notify !== false && (status === "failed" || status === "done")) settledThisTick.push(c);
}

/** 这一轮落定的记录，收尾时合成通知 */
let settledThisTick: CopyRecord[] = [];
/** 这一轮里晚点再做的去向收场时没成的：早先的通知说过「稍后自动再试」，收场也得说一声 */
let keptThisTick: CopyRecord[] = [];

/** 去向的叫法：删除 / 归档 */
const afterLabel = (c: CopyRecord): string => (c.afterCopy === "delete" ? "删除" : "归档");

/** 一轮结束：成的一条、败的一条，各自带上条目名（多了就说「等 N 个」）；晚点再做的去向收场没成的另起一条 */
function flushNotifications(): void {
  const settled = settledThisTick;
  const keptLate = keptThisTick;
  settledThisTick = [];
  keptThisTick = [];
  if (keptLate.length > 0) {
    const source = [...new Set(keptLate.map((c) => COPY_TRIGGER_LABEL[c.trigger]))].join(" / ");
    void deps.notify({ type: "copy-kept", source, kept: keptLate.map((c) => `${c.name}：${c.sourceKept ?? "没处理"}`) }).catch(() => {});
  }
  if (settled.length === 0) return;
  for (const status of ["done", "failed"] as const) {
    const rows = settled.filter((c) => c.status === status);
    if (rows.length === 0) continue;
    const names = rows.map((c) => c.name);
    const source = [...new Set(rows.map((c) => COPY_TRIGGER_LABEL[c.trigger]))].join(" / ");
    if (status === "done") {
      // 一季的文件多半在同一个目录；落在好几个目录时只写第一个再说一共几个，别让人以为全在第一个里
      const dirs = [...new Set(rows.map((c) => c.dstDir))];
      const target = dirs.length > 1 ? `${dirs[0]} 等 ${dirs.length} 个目录` : dirs[0];
      // 复制成了、源文件却没按设置删 / 归档的（目标里没看全、归档里已有同名……）：通知里也说一声，别只留在队列的说明里
      const kept = rows.filter((c) => c.sourceKept).map((c) => `${c.name}：${c.sourceKept}`);
      // 删 / 归档碰上临时错误、稍后自动再做的：也说一声，免得看到「已复制」就以为源文件已经处理了
      const retrying = rows.filter((c) => c.afterRetry).map((c) => `${c.name}：${afterLabel(c)}没成（${c.afterRetry!.why}）`);
      void deps
        .notify({ type: "copy-done", names, target, source, ...(kept.length ? { kept } : {}), ...(retrying.length ? { retrying } : {}) })
        .catch(() => {});
    } else {
      void deps.notify({ type: "copy-failed", names, detail: rows[0].detail, source }).catch(() => {});
    }
  }
}

/** OpenList 明确说「找不到」（不是连不上）：是挂载根填错了还是缓存没跟上，由 listSource 往上追着分 */
export function isMissingDir(err: unknown): boolean {
  return err instanceof OpenlistError && !err.transport && /not found|不存在|no such|object not found/i.test(err.message);
}

/**
 * 跑一轮。导出为函数是为了测试能直接触发，不用等 30 秒。
 *
 * 还没提交的按「OpenList 源目录 + 目标目录」分组，一组只列一次目录、只提交一次复制；
 * 已经提交的共用一次任务列表。
 */
export async function tickCopies(): Promise<void> {
  const rows = listCopies();
  const pending = rows.filter((c) => c.status === "pending");
  // 已经复制好、去向到点该再做一次的
  const now = deps.now();
  const due = rows.filter((c) => awaitingAfterRetry(c) && c.afterRetry!.nextAt <= now);
  if (pending.length === 0 && due.length === 0) return;
  // 这一轮手里的记录登记出去（见 queue.ts 的 tickRecords）：中途别处的改动要同时改到它们身上
  tickRecords.clear();
  ensuredDirs.clear();
  for (const c of [...pending, ...due]) tickRecords.set(c.id, c);
  try {
    await tickPending(pending, due);
  } finally {
    tickRecords.clear();
    ensuredDirs.clear();
  }
}

async function tickPending(pending: CopyRecord[], due: CopyRecord[] = []): Promise<void> {
  /**
   * 这一轮碰过的记录。循环里夹着网络等待，期间别人也在写这个键，所以只把碰过的按 id 合并回去。
   * 集合只增不清：中途 persist 过的记录后面还可能再改（分组是一组一组办的），清掉就会丢掉后面那次改动。
   */
  const touched = new Set<CopyRecord>();
  const persist = () => commitCopies([...touched], deps.now());

  let cfg: CopyConfig;
  try {
    cfg = resolveCopyConfig(deps.settings());
  } catch (err) {
    // 配置被删了：正在跑的这些没法再推进，说清楚原因。一条条发通知会刷屏，合成一条
    for (const c of pending) {
      finish(c, "failed", messageOf(err));
      touched.add(c);
    }
    // 等着晚点再做去向的也做不了了（要先到 OpenList 核对复制全了没有）：收场
    for (const c of due) {
      settleAfterRetry(c, `复制到 OpenList 的设置没了（${messageOf(err)}），${afterLabel(c)}不了`);
      touched.add(c);
    }
    persist();
    flushNotifications();
    return;
  }

  const now = deps.now();
  for (const c of pending) {
    if (now - c.addedAt > PENDING_MAX_AGE_MS) {
      finish(c, "failed", "等了 7 天还没复制完，不再跟踪");
      touched.add(c);
    }
  }

  const waiting = pending.filter(
    (c) => c.status === "pending" && c.stage === "waiting" && now - c.addedAt >= SETTLE_MS && (c.holdUntil ?? 0) <= now,
  );
  const copying = pending.filter((c) => c.status === "pending" && c.stage === "copying");
  await submitReady(cfg, waiting, pending, touched, persist);
  await pollSubmitted(cfg, copying, touched, persist);
  await retryAfterCopies(cfg, due, touched, persist);
  supersedeEarlierFailures(touched, deps.now());
  persist();
  flushNotifications();
}

/**
 * 这一轮复制好的：同一个目标以前失败的那几条标成「用不着了」。不然它们一直挂在失败里、还能点重试，
 * 重试会因为目标里已经有了而再失败一次，还叫人去删复制好的那一份
 */
function supersedeEarlierFailures(touched: Set<CopyRecord>, now: number): void {
  const done = [...touched].filter((c) => c.status === "done");
  if (done.length === 0) return;
  for (const stored of listCopies()) {
    const f = tickRecords.get(stored.id) ?? stored;
    if (f.status !== "failed" || !done.some((d) => d.id !== f.id && sameTarget(d, f))) continue;
    f.status = "skipped";
    f.superseded = true;
    f.detail = `同一个文件后来又复制了一次，已经复制好了（这条当时：${f.detail}）`;
    f.doneAt = now;
    touched.add(f);
  }
}

/** 网盘绝对路径（所在目录 + 名字）：比较两条记录谁套着谁 */
const fullPathOf = (c: Pick<CopyRecord, "srcDir" | "name">): string => joinPath(c.srcDir, c.name);
const isInside = (path: string, dir: string): boolean => path.startsWith(`${dir === "/" ? "" : dir}/`);

/**
 * 两条记录套在一起（一条是目录，另一条在它里面）时谁先谁后，免得两个 OpenList 任务同时写同一个文件：
 * 夸克监控只报最上层的新目录，转存 / 追更却是按文件登记的，第一次存进一个新建的子目录时两边就会套上。
 *   - 目录等它里面的先复制完：那些是按文件登记的（可能要删源），办完之后目标里已经有这个目录，目录本身就按「已存在」跳过；
 *   - 里面的等外面已经提交的目录复制完：OpenList 已经在复制整个目录了，办完再看目标里有没有。
 * 返回压着的原因；没套上返回 null
 */
function overlapHold(c: CopyRecord, pending: CopyRecord[]): string | null {
  const me = fullPathOf(c);
  const others = pending.filter((o) => o.id !== c.id && o.status === "pending" && o.account === c.account && !o.adopted && o.srcDir !== "");
  const inner = others.filter((o) => isInside(fullPathOf(o), me));
  if (inner.length > 0) return `等目录里的 ${inner.length} 个条目先复制完`;
  const outer = others.find((o) => o.stage === "copying" && isInside(me, fullPathOf(o)));
  if (outer) return `等上层目录「${outer.name}」先复制完`;
  return null;
}

const targetKey = (c: CopyRecord): string => JSON.stringify([c.dstDir, c.name]);

/**
 * 两个来源要复制成同一个目标文件：两个网盘账号里有同一集、或者同一账号两个任务目录都有它，目标目录又是同一个。
 * 提交前的「目标里已有同名」只看得见复制完的，两边前后脚提交就是两个 OpenList 任务写同一个文件。
 * 所以一个目标只让一个来源提交（这一轮先分进组的、或者已经在复制的那个），另一个等它办完，再按「目标里已有」跳过。
 * 返回压着的原因；没撞上返回 null
 */
function sameTargetHold(c: CopyRecord, pending: CopyRecord[], claimed: Map<string, CopyRecord>): string | null {
  const other =
    claimed.get(targetKey(c)) ??
    pending.find((o) => o.id !== c.id && o.status === "pending" && o.stage === "copying" && o.dstDir === c.dstDir && o.name === c.name);
  if (!other) return null;
  return `等另一份同名的先复制完（账号 ${other.account} 的 ${joinPath(other.srcDir, other.name)}）`;
}

/**
 * 列 OpenList 里的源目录（带 refresh，不然看的是缓存）。
 *
 * OpenList 找子目录靠的是**父目录的缓存**：网盘上刚建 / 刚改名的目录（转存或追更新建的子目录、
 * 整理建的作品目录、在网盘 App 里改的名）还不在父目录的缓存里，直接刷新它会报 object not found。
 * 所以找不到时从挂载根往下逐级刷新一遍再试一次（真机撞到过：发布目录在 115 上改了名，
 * 下一集的复制第一轮就报「检查挂载根」）。挂载根本身都列不出来才是挂载根填错了；
 * 挂载根在、源目录刷新完还是没有，说明它在网盘上已经不在原处了（被挪走 / 改名），按「还没出现」等着。
 */
async function listSource(cfg: CopyConfig, account: string, srcDir: string): Promise<{ names: string[] } | { missing: "mount" | "dir" }> {
  try {
    return { names: await deps.openlist.listNames(cfg, srcDir) };
  } catch (err) {
    if (!isMissingDir(err)) throw err;
  }
  const mount = cfg.mounts[account] ?? "/";
  const chain = [mount];
  const rest = relativeTo(mount, srcDir);
  if (rest) {
    const segs = rest.split("/").filter(Boolean);
    for (let i = 1; i < segs.length; i++) chain.push(joinPath(mount, segs.slice(0, i).join("/")));
  }
  for (const dir of chain) {
    try {
      await deps.openlist.listNames(cfg, dir);
    } catch (err) {
      if (!isMissingDir(err)) throw err;
      return { missing: dir === mount ? "mount" : "dir" };
    }
  }
  try {
    return { names: await deps.openlist.listNames(cfg, srcDir) };
  } catch (err) {
    if (!isMissingDir(err)) throw err;
    return { missing: srcDir === mount ? "mount" : "dir" };
  }
}

/** 阶段一：确认产物在 OpenList 里可见，然后成批提交复制 */
async function submitReady(cfg: CopyConfig, items: CopyRecord[], pending: CopyRecord[], touched: Set<CopyRecord>, persist: () => void): Promise<void> {
  if (items.length === 0) return;
  const groups = new Map<string, { account: string; srcDir: string; dstDir: string; items: CopyRecord[] }>();
  /** 这一轮已经分进组的目标文件：同一个目标只让一个来源提交 */
  const claimed = new Map<string, CopyRecord>();
  /** 分组那一刻的源路径 */
  const origin = new Map<string, string>();
  /**
   * 还归这一轮管吗：每过一道网络等待都核对一次。等待期间整理可能改了它的路径（rewriteCopyPaths 会改到这一轮手里的对象）、
   * 标成了「用不着了」、界面把它去掉了……这些这一轮都不碰：不记等待、不记失败、不提交，下一轮按新样子来。
   * 不然会拿新名字配旧目录去列、去提交，白白记一次等待或失败
   */
  const here = (c: CopyRecord, g: { dstDir: string }) =>
    c.status === "pending" && c.stage === "waiting" && fullPathOf(c) === origin.get(c.id) && c.dstDir === g.dstDir;
  for (const c of items) {
    touched.add(c);
    origin.set(c.id, fullPathOf(c));
    const srcDir = toOpenlistPath(cfg.mounts, c.account, c.srcDir);
    if (!srcDir) {
      finish(c, "failed", `账号 ${c.account} 没填「在 OpenList 里的挂载根」，不知道 ${c.srcDir} 在 OpenList 的哪里`);
      continue;
    }
    const held = overlapHold(c, pending) ?? sameTargetHold(c, pending, claimed);
    if (held) {
      c.detail = held;
      continue;
    }
    claimed.set(targetKey(c), c);
    const key = JSON.stringify([srcDir, c.dstDir]);
    const g = groups.get(key) ?? { account: c.account, srcDir, dstDir: c.dstDir, items: [] };
    g.items.push(c);
    groups.set(key, g);
  }

  for (const g of groups.values()) {
    let names: string[];
    try {
      const listed = await listSource(cfg, g.account, g.srcDir);
      g.items = g.items.filter((c) => here(c, g));
      if ("missing" in listed) {
        const mount = cfg.mounts[g.account];
        if (listed.missing === "mount") {
          // 挂载根填错了：等多少轮也不会出现
          for (const c of g.items) finish(c, "failed", `OpenList 里没有挂载根 ${mount}，检查一下账号 ${c.account} 的挂载根填对没有`);
        } else {
          for (const c of g.items) {
            c.waits += 1;
            if (c.waits >= MAX_WAITS) finish(c, "failed", `刷新后 OpenList 里始终找不到 ${g.srcDir}：网盘上这个目录可能被挪走或改名了`);
            else c.detail = `OpenList 里还看不到 ${g.srcDir}（${c.waits}/${MAX_WAITS}）`;
          }
        }
        persist();
        continue;
      }
      names = listed.names;
    } catch (err) {
      const msg = messageOf(err);
      for (const c of g.items.filter((x) => here(x, g))) {
        c.attempts += 1;
        if (c.attempts >= MAX_ATTEMPTS) finish(c, "failed", `读 OpenList 的 ${g.srcDir} 失败：${msg}`);
        else c.detail = `读 OpenList 的 ${g.srcDir} 失败，稍后重试（${c.attempts}/${MAX_ATTEMPTS}）：${msg}`;
      }
      log.warn({ err }, `列 OpenList 目录失败：${g.srcDir}`);
      persist();
      continue;
    }

    const ready: CopyRecord[] = [];
    for (const c of g.items) {
      if (!here(c, g)) continue;
      if (names.includes(c.name)) {
        ready.push(c);
        continue;
      }
      c.waits += 1;
      if (c.waits >= MAX_WAITS) finish(c, "failed", `刷新后 OpenList 的 ${g.srcDir} 里始终没有出现「${c.name}」`);
      else c.detail = `等「${c.name}」出现在 OpenList（${c.waits}/${MAX_WAITS}）`;
    }
    if (ready.length === 0) {
      persist();
      continue;
    }

    // 目标目录里已经有同名的就不再复制一遍：overwrite 一直是 false，重复提交只会堆任务
    let existing: string[] = [];
    try {
      existing = await deps.openlist.listNames(cfg, g.dstDir);
    } catch {
      // 目标目录还不存在（下面会建）或一时读不到，都照常往下走
    }
    const todo = ready.filter((c) => {
      if (!here(c, g)) return false;
      if (!existing.includes(c.name)) return true;
      // 用户明确点了重试：多半是上次复制到一半留了个残缺的文件在那儿。
      // overwrite 一直是 false，覆盖不了，所以如实报失败让人去删，而不是悄悄「跳过」了事
      if (c.retried) {
        finish(c, "failed", `${g.dstDir} 里已经有「${c.name}」了，可能是上次没复制完的残留；先把它删掉再重试`);
      } else {
        finish(c, "skipped", `${g.dstDir} 里已经有「${c.name}」了，跳过`);
      }
      return false;
    });
    // 复制完要删源 / 归档却不知道网盘节点 id 的（追更、115 转存、整理拆出来的）：现在钉住，动源文件之前按它核对。
    // 这一刻 OpenList 刚看见它，路径上就是要复制的这一份
    const pinned: CopyRecord[] = [];
    for (const c of todo) {
      if (!here(c, g)) continue;
      if (c.afterCopy === "keep" || c.nodeId || c.adopted) {
        pinned.push(c);
        continue;
      }
      try {
        const id = await deps.resolveNodeId(c.account, joinPath(c.srcDir, c.name));
        if (!here(c, g)) continue;
        if (id) c.nodeId = id;
        else {
          c.afterCopy = "keep";
          c.sourceKept = "提交时网盘上没找到这个路径的节点，核对不了";
        }
        pinned.push(c);
      } catch (err) {
        if (!here(c, g)) continue;
        c.attempts += 1;
        const msg = messageOf(err);
        if (c.attempts >= MAX_ATTEMPTS) finish(c, "failed", `核对网盘上的源文件失败：${msg}`);
        else c.detail = `核对网盘上的源文件失败，稍后重试（${c.attempts}/${MAX_ATTEMPTS}）：${msg}`;
      }
    }
    if (pinned.length === 0) {
      persist();
      continue;
    }

    const settled: CopyRecord[] = [];
    try {
      // /fs/copy 不会自己建目标目录，先建一次（已存在时 OpenList 自己会说，吞掉）
      await deps.openlist.mkdir(cfg, g.dstDir).catch(() => {});
      // 建目录那一下也在等网络：期间被改了的这一轮不提交
      pinned.splice(0, pinned.length, ...pinned.filter((c) => here(c, g)));
      if (pinned.length === 0) {
        persist();
        continue;
      }
      // 先记成「复制中」再去提交：提交请求还在路上时整理来改路径，看到的已经是「提交了」，不会把这一条改得和提交的不一样
      for (const c of pinned) c.stage = "copying";
      const names = pinned.map((c) => c.name);
      const tasks = await deps.openlist.copy(cfg, g.srcDir, g.dstDir, names);
      const submittedAt = deps.now();
      /**
       * 只有「返回的任务数和提交的条目数一样」时才敢按下标认领——OpenList 只给需要排队的条目建任务，
       * 少回一个就会让后面每一条都认错别人的任务（成功的显示失败、还在跑的显示已复制，开了删源更危险）。
       * 对不上就按名字认；名字也认不出来的不当「立即完成」，留在盯任务阶段靠名字继续找。
       */
      const positional = tasks.length === names.length;
      pinned.forEach((c, i) => {
        const task = positional ? tasks[i] : (tasks.find((t) => t.name.includes(c.name)) ?? null);
        c.submittedAt = submittedAt;
        c.waits = 0;
        c.misses = 0;
        if (tasks.length === 0) {
          // 同存储或极小文件会立即完成、一个任务都没有；OpenList 既然收下了就当办成了
          finish(c, "done", "复制完成");
          settled.push(c);
          return;
        }
        c.stage = "copying";
        c.copyTaskId = task?.id;
        c.detail = task?.id ? "已提交 OpenList 复制" : "已提交 OpenList 复制（没认出任务号，按名字盯）";
      });
      log.info(`已提交 OpenList 复制 ${pinned.length} 项：${g.srcDir} → ${g.dstDir}`);
    } catch (err) {
      const msg = messageOf(err);
      for (const c of pinned) {
        // 没提交成：退回排队
        c.stage = "waiting";
        c.attempts += 1;
        if (c.attempts >= MAX_ATTEMPTS) finish(c, "failed", `提交 OpenList 复制失败：${msg}`);
        else c.detail = `提交 OpenList 复制失败，稍后重试（${c.attempts}/${MAX_ATTEMPTS}）：${msg}`;
      }
      log.warn({ err }, `提交 OpenList 复制失败：${g.srcDir} → ${g.dstDir}`);
    }
    // 后续动作放在 try 外面：它报错只该写进 detail，不能被上面那个「提交失败」的 catch 接住
    for (const c of settled) await afterCopied(c, cfg);
    persist();
  }
}

/**
 * 一条复制在 OpenList 任务名里的特征：源路径的最后两段，比只用条目名不容易串味。
 * 升级接管过来的记录没有网盘路径，按名字认的风险更大，所以它们只认任务 id（返回空串）。
 */
function taskKey(c: CopyRecord): string {
  if (c.adopted || c.srcDir === "") return "";
  const segs = joinPath(c.srcDir, c.name).split("/").filter(Boolean);
  return segs.slice(-2).join("/");
}

/**
 * 阶段二：盯复制进度。OpenList 复制目录是「父任务展开逐文件子任务」，父任务很快就结束，
 * 所以不能只看提交时拿到的那个任务 id：undone 里凡是任务名带着这条特征的都算这次复制的一部分，
 * 全部离开 undone 后再到 done 里对成败（按 endedAt 滤掉陈年同名任务）。
 */
async function pollSubmitted(cfg: CopyConfig, items: CopyRecord[], touched: Set<CopyRecord>, persist: () => void): Promise<void> {
  if (items.length === 0) return;
  for (const c of items) touched.add(c);
  let tasks: { undone: OpenlistTaskInfo[]; done: OpenlistTaskInfo[] };
  try {
    tasks = await deps.openlist.copyTasks(cfg);
  } catch (err) {
    // 这一轮任务列表拿不到（OpenList 重启中、断网）：什么都不改，下轮再来
    loop.noteError(messageOf(err));
    log.warn({ err }, "读取 OpenList 复制任务列表失败，下轮再对");
    return;
  }

  // 别人明确认领的任务 id：按名字认的时候要避开，不然两条记录会互相抢结果
  const claimed = new Set(items.map((c) => c.copyTaskId).filter((id): id is string => Boolean(id)));
  for (const c of items) {
    // 等任务列表、做前一条的收尾时被界面去掉了（dropCopy 会把这一轮手里的标掉）：不再归这一轮管，删源、通知这些收尾都不做
    if (c.status !== "pending") continue;
    const key = taskKey(c);
    const mine = (rows: OpenlistTaskInfo[]) =>
      rows.filter((r) => (c.copyTaskId && r.id === c.copyTaskId) || (key !== "" && r.name.includes(key) && !claimed.has(r.id)));
    const active = mine(tasks.undone);
    if (active.length > 0) {
      c.misses = 0;
      const own = active.find((r) => r.id === c.copyTaskId) ?? active[0];
      c.detail = active.length > 1 ? `OpenList 复制中，还剩 ${active.length} 个任务` : `OpenList 复制中 ${Math.round(own.progress)}%`;
      continue;
    }
    // 提交之前就躺在 done 列表里的同名任务不算这次的；OpenList 和本机的钟可能有偏差，放宽 10 分钟
    const since = (c.submittedAt ?? c.addedAt) - 600_000;
    const settled = mine(tasks.done).filter((r) => r.id === c.copyTaskId || r.endedAt == null || r.endedAt >= since);
    if (settled.length === 0) {
      c.misses += 1;
      if (c.misses >= MAX_MISSES) finish(c, "failed", "OpenList 的任务列表里找不到这次复制（可能被手动清掉了）");
      else c.detail = `OpenList 任务列表里暂时没找到这次复制（${c.misses}/${MAX_MISSES}）`;
      continue;
    }
    const failed = settled.filter((r) => !copyStateSucceeded(r.state));
    if (failed.length > 0) {
      const suffix = failed.length > 1 ? `（共 ${failed.length} 个任务失败）` : "";
      finish(c, "failed", `OpenList 复制失败：${failed[0].error || "未知原因"}${suffix}`);
      continue;
    }
    finish(c, "done", "复制完成");
    log.info(`复制完成：${joinPath(c.srcDir, c.name)} → ${c.dstDir}`);
    await afterCopied(c, cfg);
  }
  persist();
}

/** 复制完了，但这一份在目标里到底全不全？删源之前必须先答上来 */
async function verifyCopied(c: CopyRecord, cfg: CopyConfig): Promise<{ ok: true } | { ok: false; why: string }> {
  const names = await deps.openlist.listNames(cfg, c.dstDir);
  if (!names.includes(c.name)) return { ok: false, why: "目标里没看到这一份" };
  if (!c.isDir) return { ok: true };
  /**
   * 目录只看「目标里有这个名字」是不够的：OpenList 一开始就把目录建出来了，
   * 里面可能一个文件都还没搬完。逐个对一层子项的名字，缺一个就不删。
   */
  const [src, dst] = await Promise.all([
    deps.listDriveChildren(c.account, joinPath(c.srcDir, c.name)),
    deps.openlist.listNames(cfg, joinPath(c.dstDir, c.name)),
  ]);
  const missing = src.filter((n) => !dst.includes(n));
  if (missing.length > 0) return { ok: false, why: `目标里少了 ${missing.length} 项（${missing.slice(0, 3).join("、")}…）` };
  return { ok: true };
}


/**
 * 网盘上这个路径现在是哪个节点。按父目录**绕开缓存**列一遍再按名字找：
 * 115 按路径找文件时用的是进程内缓存 5 分钟的目录清单，刚转存进来的文件在缓存里还没有
 * （真机撞到：转存弹框刚列过任务目录，提交复制时就钉不住节点，删源被关掉；删的时候也会说「源已不在原处」）。
 * 目录本身按路径解析（115 的 getid 不走那份缓存），整理那边挑同名也是这么绕的
 */
export async function lookupFresh(account: string, path: string): Promise<DriveNode | null> {
  const provider = providerForAccount(account);
  const name = baseName(path);
  const dir = await provider.resolvePath(parentDir(path));
  if (!dir || !dir.isDir || !name) return null;
  const hit = (await provider.listDir(dir.id, undefined, { fresh: true })).find((e) => e.name === name);
  return hit ? { id: hit.id, isDir: hit.isDir } : null;
}

/**
 * 删源之后同步本地：只认这个网盘账号的任务（别的账号同名 originPath 的任务不能被串到）。
 * 目录就把本地同名目录整个删掉，文件交给整理那边同一个 mirrorDelete（strm 按扩展名换算、下载的字幕等直接删）
 */
async function removeLocalMirrorReal(account: string, panPath: string, isDir: boolean | undefined): Promise<boolean> {
  const tasks = listTasks().filter((t) => t.account === account);
  const match = matchTask({ tasks }, panPath);
  if (!match || !match.relPath) return false;
  if (isDir !== false) {
    const local = path.join(match.saveDir, match.relPath);
    const stat = await fsp.stat(local).catch(() => null);
    if (stat?.isDirectory()) {
      await fsp.rm(local, { recursive: true, force: true });
      await removeEmptyParents(path.dirname(local), match.saveDir);
      return true;
    }
  }
  return mirrorDelete(panPath, { tasks, settings: readAppSettings() });
}

/** 网盘上这个目录的一层子项名（同样绕开缓存：刚复制完的目录要对的是现在的样子） */
async function listDriveChildrenReal(account: string, path: string): Promise<string[]> {
  const provider = providerForAccount(account);
  const node = await lookupFresh(account, path);
  if (!node || !node.isDir) return [];
  return (await provider.listDir(node.id, undefined, { fresh: true })).map((e) => e.name);
}

/**
 * 删源：整理可能已经把文件挪走了，路径还在但换了一个同名的，所以有 nodeId 就必须对得上才删。
 * 115 / 夸克删进回收站，OpenList 看存储后端。
 */
async function removeSourceReal(account: string, path: string, nodeId?: string): Promise<"removed" | "missing" | "changed" | "unsupported"> {
  const provider = providerForAccount(account);
  if (!provider.write) return "unsupported";
  const node = await lookupFresh(account, path);
  if (!node) return "missing";
  if (nodeId && String(node.id) !== String(nodeId)) return "changed";
  await provider.write.remove({ id: node.id, path, isDir: node.isDir });
  return "removed";
}

/**
 * 复制成功之后：通知 Emby 扫一遍、目标落在某个 OpenList 任务里就按它的策略自动整理、
 * 按需删源。每一步失败都只写进 detail，不把已经成功的复制翻成失败。
 */
async function afterCopied(c: CopyRecord, cfg: CopyConfig): Promise<void> {
  try {
    await afterCopiedInner(c, cfg);
  } catch (err) {
    // 复制本身已经成了，后续动作出岔子只写进说明，不把记录翻成失败
    c.detail += `；复制完的后续动作出错：${messageOf(err)}`;
    log.warn({ err }, `复制完的后续动作失败：${joinPath(c.srcDir, c.name)}`);
  }
}

async function afterCopiedInner(c: CopyRecord, cfg: CopyConfig): Promise<void> {
  deps.embyRefresh();

  // 目标目录落在哪个「用这个 OpenList 账号」的任务下：最长 originPath 胜，同 life/handlers 的规则
  const full = joinPath(c.dstDir, c.name);
  const hit = deps.listTasks()
    .filter((t) => t.account === cfg.account.name)
    .map((t) => ({ task: t, rel: relativeTo(t.originPath, full) }))
    .filter((x): x is { task: TaskDefinition; rel: string } => x.rel !== null)
    .sort((a, b) => b.task.originPath.length - a.task.originPath.length)[0];
  if (hit && hit.rel) events.emit("files.landed", { task: hit.task, paths: [hit.rel], trigger: "copy", debounce: true });

  if (c.afterCopy === "keep") {
    if (c.sourceKept) c.detail += `；${c.sourceKept}，源文件没动`;
    return;
  }
  await applyAfterCopy(c, cfg, { retry: false });
}

/**
 * 到点的去向重做一次：复制早就成了，只再删 / 归档。说明从「复制完成」重新拼；
 * 这一轮里等前面几条的时候被界面去掉了的（dropCopy 把这一轮手里的标成 skipped）不再归这一轮管
 */
async function retryAfterCopies(cfg: CopyConfig, due: CopyRecord[], touched: Set<CopyRecord>, persist: () => void): Promise<void> {
  for (const c of due) {
    if (!awaitingAfterRetry(c)) continue;
    touched.add(c);
    c.detail = "复制完成";
    await applyAfterCopy(c, cfg, { retry: true });
    persist();
  }
}

/** 晚点再做的去向收场没成：和第一次就没成一样记 sourceKept，另外发一条通知（早先的通知说过「稍后自动再试」） */
function settleAfterRetry(c: CopyRecord, why: string): void {
  c.afterRetry = undefined;
  c.sourceKept = why;
  c.detail = `复制完成；${why}`;
  keptThisTick.push(c);
}

/** 网络断、超时、网盘异步任务失败、5xx / 429：过一会儿多半就好了。账号失效、风控不算——那得人去修 */
function transientAfterCopyError(account: string, err: unknown): boolean {
  if (isAbortError(err)) return false;
  let provider: DriveProvider | undefined;
  try {
    provider = providerForAccount(account);
  } catch {
    provider = undefined;
  }
  if (accountIssueOf(provider, err)) return false;
  const facts = driveErrorFacts(err);
  if (facts.transport || facts.taskFailed) return true;
  return facts.status !== undefined && (facts.status >= 500 || facts.status === 429);
}

/** applyAfterCopy 的结论：挪进归档了 / 删了 / 碰上临时错误晚点再做 / 没动（原因在 why，同时记在 sourceKept） */
export type AfterCopyOutcome =
  | { kind: "archived"; to: string }
  | { kind: "removed" }
  | { kind: "retry"; why: string; nextAt: number }
  | { kind: "kept"; why: string };

/**
 * 按去向处理网盘上的源文件（删 / 归档）：先核对（目标里看得全、节点 id 对得上），过了才动。
 * 碰上临时错误不当最终结果：记下来隔一会儿再做（afterRetry），次数用完才按「没按设置处理」收场。
 * retry：这是晚点再做的那一次——上一次也可能其实做成了、只是没等到回话，源不见了要分情况认。
 * verified：调用方已经按更严的口径核对过目标里这一份齐了（copy/after.ts 逐层比名字、文件比大小），这里不再看一遍。
 * 说明、sourceKept、afterRetry 都写在记录上；返回值给要当场回话的调用方（事后处理源文件）用
 */
export async function applyAfterCopy(c: CopyRecord, cfg: CopyConfig, opts: { retry: boolean; verified?: boolean }): Promise<AfterCopyOutcome> {
  const { retry } = opts;
  const prior = c.afterRetry?.attempts ?? 0;
  c.afterRetry = undefined;
  /** 说明里的动词：删 / 归档 */
  const verb = c.afterCopy === "delete" ? "删" : "归档";
  /** 没按设置处理源文件：原因记在 sourceKept（收尾的通知里也说一声），说明里带上；晚点再做的那次没成另发一条通知 */
  const kept = (why: string, tail = `，源文件没${verb}`): AfterCopyOutcome => {
    c.sourceKept = why;
    c.detail += `；${why}${tail}`;
    if (retry) keptThisTick.push(c);
    return { kind: "kept", why };
  };
  if (c.adopted || c.srcDir === "") return kept("这条是升级前接管的，不知道源在哪", `，没${verb}`);
  const src = joinPath(c.srcDir, c.name);
  try {
    if (!opts.verified) {
      const verdict = await verifyCopied(c, cfg);
      if (!verdict.ok) return kept(verdict.why);
    }
    let outcome: string;
    let result: AfterCopyOutcome | undefined;
    if (c.afterCopy === "delete") {
      outcome = await deps.removeSource(c.account, src, c.nodeId);
      if (outcome === "removed") c.detail += "；网盘上那份已删";
      else if (outcome === "missing" && retry) {
        // 上一次删的时候没等到回话，其实已经删掉了（源在复制前核对过节点，这期间别人挪走的可能很小）；本地 strm 照删
        outcome = "removed";
        c.detail += "；网盘上已经没有这一份（多半上次已经删掉了）";
      }
      if (outcome === "removed") result = { kind: "removed" };
    } else if (c.afterCopy === "archive") {
      const r = await deps.archiveSource(c.account, src, c.nodeId, c.rootPath, { retry });
      outcome = r.kind;
      if (r.kind === "archived") {
        c.detail += r.earlier ? `；网盘上那份已归档到 ${r.to}（上次其实已经挪过去了）` : `；网盘上那份已归档到 ${r.to}`;
        result = { kind: "archived", to: r.to };
      } else if (r.kind === "exists") return kept("归档目录里已经有同名的", "，源文件没动");
      else if (r.kind === "staged") return kept("它本来就在归档目录里", "，没再动");
      else if (r.kind === "no-root") return kept("不知道任务目录在哪（平铺复制的），归档不了", "，源文件没动");
    } else {
      // 库里混进了认不得的去向（手改过、回退过版本）：当不动，不猜
      return kept(`不认识的去向「${String(c.afterCopy)}」`, "，源文件没动");
    }
    if (result) {
      // 本地的 strm 指着的路径已经空了，留着就是 Emby 里一个放不了的条目。
      // 不能指望网盘监控来收拾：115 删文件时 Provider 当场就把路径缓存清了，
      // 随后那条删除事件（不带父目录）就对不上任何任务，被当成根目录下的文件跳过（真机撞到）
      try {
        if (await deps.removeLocalMirror(c.account, src, c.isDir)) c.detail += "，本地 strm 也删了";
      } catch (err) {
        c.detail += `，本地 strm 没删掉：${messageOf(err)}`;
      }
      return result;
    }
    if (outcome === "missing") return kept("源文件已不在原处", `，没${verb}`);
    if (outcome === "changed") return kept("源路径上换成了别的文件", `，没${verb}`);
    if (outcome === "unsupported") return kept(`这个网盘不支持${c.afterCopy === "delete" ? "删除" : "移动"}`);
    return kept(`${verb}源文件没成（${outcome}）`, "");
  } catch (err) {
    // 原因只要一句人话：说明和通知里后面紧跟着「1 分钟后自动再试」，不能再叫人「稍后再试」
    const why = networkErrorText(err, { brief: true }) ?? messageOf(err);
    if (transientAfterCopyError(c.account, err) && prior < AFTER_RETRY_DELAYS_MS.length) {
      const delay = AFTER_RETRY_DELAYS_MS[prior];
      const nextAt = deps.now() + delay;
      c.afterRetry = { attempts: prior + 1, nextAt, why };
      c.detail += `；${verb}源文件没成（${why}），${Math.round(delay / 60_000)} 分钟后自动再试（${prior + 1}/${AFTER_RETRY_DELAYS_MS.length}）`;
      log.warn({ err }, `复制后${verb}源文件没成，${Math.round(delay / 60_000)} 分钟后再试：${src}`);
      return { kind: "retry", why, nextAt };
    }
    const result = kept(`${verb}源文件失败：${why}${prior > 0 ? `（自动重试 ${prior} 次都没成）` : ""}`, "");
    log.warn({ err }, `复制后${verb}源文件失败：${src}`);
    return result;
  }
}

/**
 * 归档的结果：挪到了哪（to 是归档里的目录），或者为什么没动（staged = 它本来就在归档目录里）。
 * earlier：重做时发现上一次其实已经挪过去了（只是没等到回话）
 */
export type ArchiveResult = { kind: "archived"; to: string; earlier?: boolean } | { kind: "missing" | "changed" | "exists" | "unsupported" | "no-root" | "staged" };

/**
 * 归档：把源挪进任务目录下的「归档」，原来的层级留着（tv/某剧/S01/E01.mkv → tv/归档/某剧/S01/E01.mkv）。
 * 和删源同一套核对：有 nodeId 就必须对得上。归档里已经有同名的不覆盖、不合并，源留着让人处理。
 * 归档目录是暂存区，全量同步 / 监控 / 整理都不进（见 organize/duplicates.ts）
 */
async function archiveSourceReal(
  account: string,
  path: string,
  nodeId: string | undefined,
  rootPath: string | undefined,
  opts: { retry?: boolean } = {},
): Promise<ArchiveResult> {
  const provider = providerForAccount(account);
  if (!provider.write) return { kind: "unsupported" };
  const root = normDir(rootPath);
  const rel = root ? relativeTo(root, parentDir(path)) : null;
  if (rel === null) return { kind: "no-root" };
  // 本来就在归档目录里的（把归档区选进来复制了）：不能把「归档」挪进「归档」
  if (underArchive(relativeTo(root, path) ?? "")) return { kind: "staged" };
  const node = await lookupFresh(account, path);
  if (!node) {
    // 晚点再做的那一次源不见了：上一次挪的时候没等到回话、其实已经挪过去了的，归档目录里会有它（知道节点 id 就得对得上）
    if (opts.retry) {
      const to = joinPath(joinPath(root, ARCHIVE_DIR), rel);
      const there = await lookupFresh(account, joinPath(to, baseName(path)));
      if (there && (!nodeId || String(there.id) === String(nodeId))) return { kind: "archived", to, earlier: true };
    }
    return { kind: "missing" };
  }
  if (nodeId && String(node.id) !== String(nodeId)) return { kind: "changed" };
  const parent = await ensureDriveDir(provider, root, [ARCHIVE_DIR, ...rel.split("/").filter(Boolean)]);
  // 归档里已有同名的不覆盖、不合并（每条都要看：同一轮里前一条可能刚挪进去一个同名的）
  const name = baseName(path);
  if ((await provider.listDir(parent.id, undefined, { fresh: true })).some((e) => e.name === name)) return { kind: "exists" };
  await provider.write.move([{ id: node.id, path, isDir: node.isDir }], parent);
  return { kind: "archived", to: parent.path };
}

/** 这一轮里已经确认 / 建过的归档目录链（账号 + 路径 → 节点）：一季几十集归档时同一条链不用每条都到网盘列一遍；每轮开始清空 */
const ensuredDirs = new Map<string, { id: string; path: string }>();

/** 不在循环里跑的归档（事后处理源文件，copy/after.ts）开始前也清一次：别用上一轮留下的目录链 */
export function resetArchiveDirCache(): void {
  ensuredDirs.clear();
}

/** 从 base 往下逐级确认 / 建出目录，返回最后一级；沿途撞上同名文件就抛 */
async function ensureDriveDir(provider: DriveProvider, base: string, segs: string[]): Promise<{ id: string; path: string }> {
  const keyOf = (p: string) => JSON.stringify([provider.account.name, p]);
  let cur: { id: string; path: string };
  const cachedRoot = ensuredDirs.get(keyOf(base));
  if (cachedRoot) cur = cachedRoot;
  else {
    const root = await provider.resolvePath(base);
    if (!root?.isDir) throw new Error(`任务目录 ${base} 在网盘上不存在`);
    cur = { id: root.id, path: base };
    ensuredDirs.set(keyOf(base), cur);
  }
  for (const seg of segs) {
    const next = joinPath(cur.path, seg);
    const known = ensuredDirs.get(keyOf(next));
    if (known) {
      cur = known;
      continue;
    }
    // 按父目录 id 列（绕开路径缓存）：刚建出来的目录按路径解析可能还找不到
    const hit: DriveEntry | undefined = (await provider.listDir(cur.id, undefined, { fresh: true })).find((e) => e.name === seg);
    if (hit && !hit.isDir) throw new Error(`${next} 不是目录，归档不了`);
    const node: { id: string } = hit ?? (await provider.write!.mkdir(cur, seg));
    cur = { id: node.id, path: next };
    ensuredDirs.set(keyOf(next), cur);
  }
  return cur;
}

/* ------------------------------- 循环 ------------------------------- */

let lastTickAt: number | null = null;

const loop = createPollingLoop({
  name: "复制到 OpenList 的队列",
  log,
  intervalMs: POLL_MS,
  tick: async () => {
    lastTickAt = Date.now();
    await tickCopies();
  },
  // 排着的做完了，去向还等着晚点再做的也要等它们做完
  shouldContinue: hasCopyWork,
  doneMessage: "复制队列已清空，循环停止",
});

export interface CopyWatcherStatus {
  running: boolean;
  pending: number;
  lastTickAt: number | null;
  lastError: string | null;
}

/** rows：调用方已经读出来的队列，给了就不再读一遍 */
export function getCopyWatcherStatus(rows: CopyRecord[] = listCopies()): CopyWatcherStatus {
  return {
    running: loop.running,
    pending: rows.filter((c) => c.status === "pending").length,
    lastTickAt,
    lastError: loop.lastError,
  };
}

export function startCopyWatcher(): void {
  if (loop.running || !hasCopyWork()) return;
  log.info("复制队列循环启动");
  loop.start();
}

export async function stopCopyWatcher(): Promise<void> {
  await loop.stop();
}

/* ------------------------------- 路由用的动作 ------------------------------- */

/**
 * 为什么不能重试，能重试回 null。界面的按钮（GET /api/copy 带的 canRetry）、智能体的工具、retryCopies 同一个口径：
 *   - 已复制的再来一次，目标里已经有这个文件，只会把它变成「失败」还发一条失败通知；
 *   - 用不着了的（整理拆成了按文件的、同一个目标后来复制好了）重试只会再失败；
 *   - 升级时接管来的只有 OpenList 的任务号、没有网盘路径，无从下手。
 * 跳过的只剩「目标里已有同名」这一种能重试：多半是上次没复制完的残留，要人先删掉目标里那份
 */
export function retryBlocker(c: CopyRecord): string | null {
  if (c.status === "pending") return "这条还在队列里跑着，不用重试";
  if (c.status === "done") return "这条已经复制好了，不用重试";
  if (c.superseded) return "这条用不着了：整理把它拆成了按文件复制，或者同一个文件后来已经复制好了";
  if (c.adopted || c.srcDir === "") return "这条是升级前接管过来的，只有 OpenList 的任务号、没有网盘路径，重试无从下手；重新触发一次复制吧";
  return null;
}

export const canRetryCopy = (c: CopyRecord): boolean => retryBlocker(c) === null;

/**
 * 为什么不能事后处理这条的源文件（归档 / 删除），能就回 null。界面的按钮（GET /api/copy 带的 canAfterCopy）、
 * 智能体的 copy_list / copy_after、服务层 copy/after.ts 同一个口径：复制好了、源文件还在原处
 * （去向是不动，或者当时没按设置处理成——归档里有同名、接口超时三次都没成），而且知道它属于哪个任务。
 * 还在复制的另算：copy_after 会把它的去向补上，复制完再处理（见 after.ts），这里只说它还没好
 */
export function afterCopyBlocker(c: CopyRecord): string | null {
  if (c.status === "pending") return "这条还在复制，复制完才轮到源文件";
  if (c.status !== "done") return "这条没复制成，没有要处理的源文件";
  if (c.adopted || c.srcDir === "") return "这条是升级前接管的，不知道源在哪";
  if (!c.taskId || !c.rootPath) return "这条是平铺复制的，不属于任何任务，不知道任务目录在哪";
  if (c.afterRetry) return `源文件的${afterLabel(c)}正在自动重试，不用再发起`;
  if (c.afterCopy !== "keep" && !c.sourceKept) return `源文件已经按设置${afterLabel(c)}过了`;
  return null;
}

export const canAfterCopy = (c: CopyRecord): boolean => afterCopyBlocker(c) === null;

/** 一条的重试结果：ok 的是重新排上了（alreadyQueued = 本来就排着）；不行的带原因和该回的状态码 */
export type CopyRetryResult =
  | { id: string; ok: true; record: CopyRecord; alreadyQueued?: boolean }
  | { id: string; ok: false; status: 404 | 409; error: string; record?: CopyRecord };

/** 重新排队：计数清零，回到「等产物可见」那一步 */
function resetForRetry(c: CopyRecord, now: number): void {
  c.status = "pending";
  c.retried = true;
  c.stage = "waiting";
  c.detail = "重新排队，等着复制到 OpenList";
  c.attempts = 0;
  c.waits = 0;
  c.misses = 0;
  c.copyTaskId = undefined;
  c.submittedAt = undefined;
  c.doneAt = undefined;
  c.holdUntil = undefined;
  c.addedAt = now;
}

/**
 * 批量重试，读一次写一次。正在跑的那一轮手里要是也有这一条（它刚把这条记成失败、还没收尾），一起改掉，
 * 不然它收尾写回时会把重试盖掉
 */
export function retryCopies(ids: string[]): CopyRetryResult[] {
  const rows = listCopies();
  const byId = new Map(rows.map((c) => [c.id, c]));
  const now = deps.now();
  const results: CopyRetryResult[] = [];
  let changed = false;
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) {
      results.push({ id, ok: false, status: 404, error: `复制记录不存在：${id}` });
      continue;
    }
    if (c.status === "pending") {
      results.push({ id, ok: true, record: c, alreadyQueued: true });
      continue;
    }
    const why = retryBlocker(c);
    if (why) {
      results.push({ id, ok: false, status: 409, error: why, record: c });
      continue;
    }
    resetForRetry(c, now);
    mirrorLive(id, (live) => resetForRetry(live, now), (live) => live !== c);
    results.push({ id, ok: true, record: c });
    changed = true;
  }
  if (changed) {
    saveCopies(rows);
    startCopyWatcher();
  }
  return results;
}

/** 单条重试（界面上的按钮、REST）：不行就按原因回 404 / 409 */
export function retryCopy(id: string): CopyRecord {
  const [r] = retryCopies([id]);
  if (!r.ok) throw new HttpError(r.status, r.error);
  if (r.alreadyQueued) throw new HttpError(409, "这条还在队列里跑着，不用重试");
  return r.record;
}

/** 不跟了：从队列里去掉（已经提交给 OpenList 的复制不会被取消，只是这边不再盯） */
export function dropCopy(id: string): void {
  const rows = listCopies();
  const kept = rows.filter((c) => c.id !== id);
  if (kept.length === rows.length) throw new HttpError(404, `复制记录不存在：${id}`);
  saveCopies(kept);
  // 推进循环这一轮手里要是也有它：标掉，这一轮就不再提交它（收尾写回时它已经不在库里，也不会复活）
  mirrorLive(id, (live) => {
    live.status = "skipped";
    live.detail = "已从队列里去掉";
  });
}

/**
 * 升级：接管云下载里已经提交给 OpenList 的复制。
 *
 * 老版本把「下载完成后复制走」整条都记在云下载回执里（`offline.followups` 的 kind = "openlist-copy"）。
 * 现在复制归这个队列管，已经提交出去的那些得搬过来接着盯，不然它们会烂在回执里没人问。
 * 还在等 115 下载的不用搬：115 一报完成，云下载那边就会调 enqueueCopy 走新路。
 */
export function adoptLegacyCopyFollowups(): number {
  type Legacy = {
    kind?: string;
    status?: string;
    account?: string;
    name?: string;
    addedAt?: number;
    copyDstDir?: string;
    copyTaskId?: string;
    copySubmittedAt?: number;
    misses?: number;
  };
  const rows = readKv<Legacy[]>(KEY.offlineFollowups);
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const inFlight = rows.filter((f) => f.kind === "openlist-copy" && f.status === "pending" && f.copyTaskId != null);
  if (inFlight.length === 0) return 0;

  let cfg: CopyConfig;
  try {
    cfg = resolveCopyConfig(deps.settings());
  } catch {
    return 0; // 配置都没了，搬过来也跑不动
  }
  const now = deps.now();
  const adopted: CopyRecord[] = [];
  for (const f of inFlight) {
    if (!f.name || !f.account) continue;
    adopted.push({
      id: randomUUID(),
      account: f.account,
      // 老回执只知道 OpenList 里的源目录，网盘路径无从得知；copying 阶段用不到它
      srcDir: "",
      name: f.name,
      dstDir: normDir(f.copyDstDir) || cfg.dstDir,
      dstBase: normDir(f.copyDstDir) || cfg.dstDir,
      taskId: "",
      trigger: "offline",
      afterCopy: "keep",
      adopted: true,
      addedAt: f.addedAt ?? now,
      status: "pending",
      stage: "copying",
      detail: "升级后接着盯这次复制",
      attempts: 0,
      waits: 0,
      misses: f.misses ?? 0,
      copyTaskId: f.copyTaskId,
      submittedAt: f.copySubmittedAt,
    });
  }
  if (adopted.length === 0) return 0;
  saveCopies([...adopted, ...listCopies()]);
  const kept = rows.filter((f) => !inFlight.includes(f));
  writeKv(KEY.offlineFollowups, kept);
  log.info(`接管了 ${adopted.length} 条云下载在途的复制`);
  startCopyWatcher();
  return adopted.length;
}

/** 仅供测试：清空队列并停循环 */
export async function __test_resetCopy(): Promise<void> {
  await stopCopyWatcher();
  settledThisTick = [];
  saveCopies([]);
  lastTickAt = null;
  loop.noteError(null);
}
