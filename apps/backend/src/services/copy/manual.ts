/**
 * 手动发起「复制到 OpenList」：把任务网盘目录里已经有的目录 / 文件交给复制队列。
 * 界面的「新建复制」（云下载页、strm 管理页）、智能体的 copy_add、REST 的 POST /api/copy 都走这里。
 *
 * 转存 / 追更 / 云下载 / 监控是在文件落进来那一刻登记的；这里是事后补：转存时没勾复制、后来才开了复制、看片卡顿想把某部片放到本地磁盘。
 *
 * 和自动登记的几处不同：
 *   - 先到网盘核对每条路径在不在（顺手拿节点 id，复制完删源 / 归档要按它核对）；
 *   - **补齐**：源是目录、OpenList 目标里已经有同名目录时，整目录登记会被「目标里已有」跳过、什么都不复制，
 *     所以改成和目标逐层比对，只把缺的文件 / 子目录登记进去（只比名字，和队列一致）；
 *   - 任务正在整理时拒：整理会改名挪目录，这时登记的复制不是复制成整理前的样子，就是复制到一半源被挪走。
 * 两个阶段：先只看不改（网盘、OpenList 都可能等一会，哪一步不成整个请求都不登记），再一口气登记（中间没有 await）。
 * 复制成功后源文件的去向默认跟任务设置，调用方可以按次指定；落到「删除」的要调用方明确允许（令牌得有「删除」档）。
 */
import type { CopyAfterCopy, TaskDefinition } from "@openstrm/shared";
import { listRunsByStatus } from "../../db/repositories/organize.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { messageOf } from "../../lib/errors.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { providerForTask } from "../drive/registry.js";
import { subtreeEntries } from "../drive/walk.js";
import type { DriveProvider, SubtreeEntry } from "../drive/types.js";
import { autoOrganizeBusy } from "../organize/auto.js";
import { isStagingDir } from "../strm/staging.js";
import { normalizeRel } from "../strm/manage.js";
import { baseName, copyBlockerFor, copyDstProblem, copyOptionsFor, dstDirFor, joinPath, normConfigDir, normDir, normTargetDir, parentDir, resolveCopyConfig, type CopyConfig } from "./paths.js";
import { enqueueCopy, findCoveringRecord, isMissingDir, listOpenlistEntries, lookupFresh, withAfterCopy, type CopyOutcome, type CopySource, type OpenlistTargetEntry } from "./service.js";

const log = moduleLogger("copy-manual");

/** 一次最多交多少条路径 */
export const MANUAL_PATHS_MAX = 50;
/** 补齐时源子树最多这么多文件、最多列这么多个目标目录，超了让人缩小范围 */
export const FILL_FILES_MAX = 5000;
export const FILL_DIRS_MAX = 200;

/**
 * 一条路径的结果：
 *   queued    整条登记了
 *   filled    目标里已经有同名目录，只补了缺的（queued 是补了几条）
 *   complete  目标里已经有同名目录，里面一样都不缺，没登记
 *   exists    目标里已经有同名文件，没登记
 *   duplicate 已经在队列里，或刚复制过
 *   covered   队列里有一条还没提交的整目录复制会把它一起带过去，没单独登记
 *   missing   网盘上没有这条路径
 */
export type ManualItemOutcome = "queued" | "filled" | "complete" | "exists" | "duplicate" | "covered" | "missing";

export interface ManualCopyItem {
  /** 相对任务网盘目录 */
  path: string;
  outcome: ManualItemOutcome;
  /** 这条路径登记了几条记录 */
  queued: number;
  isDir?: boolean;
}

export interface ManualCopyResult extends CopyOutcome {
  items: ManualCopyItem[];
}

export interface ManualCopyInput {
  task: TaskDefinition;
  /** 相对任务网盘目录的路径，至少一段 */
  paths: string[];
  /** 这次复制到哪（OpenList 完整路径）；不给用任务上 / 设置页的目标目录 */
  dstDir?: string;
  /** 复制成功后源文件的去向；不给按任务设置（任务没开复制的按「不动」） */
  afterCopy?: CopyAfterCopy;
  /** 最终的去向是「删除」时调用方允不允许：会话可以，令牌要有「删除」档 */
  allowDelete: boolean;
  signal?: AbortSignal;
}

const http = (status: number, message: string, code: string, extra: Record<string, unknown> = {}) => new HttpError(status, message, { code, ...extra });

/** 第一阶段看完的一条路径：怎么登记、登记什么 */
interface PathPlan {
  rel: string;
  outcome: ManualItemOutcome;
  isDir?: boolean;
  sources: CopySource[];
}

export async function enqueueManualCopy(input: ManualCopyInput): Promise<ManualCopyResult> {
  const { task, signal } = input;
  const settings = readAppSettings();
  const blocked = copyBlockerFor(settings)(task);
  if (blocked) throw http(400, `没法复制到 OpenList：${blocked}`, "COPY_NOT_READY");
  const dst = normConfigDir(input.dstDir);
  if (input.dstDir !== undefined && input.dstDir.trim() !== "" && !dst) throw http(400, "dstDir 不是一个有效的路径", "VALIDATION");
  if (dst) {
    const why = copyDstProblem(dst, task, settings);
    if (why) throw http(400, why, "COPY_DST_INVALID");
  }
  const rels = uniquePaths(input.paths);
  assertNotOrganizing(task);
  const opts = copyOptionsFor(task, true, settings, dst);
  const afterCopy = input.afterCopy ?? opts.afterCopy;
  // 复制完删源是删东西：没明说、按任务设置落到删除的也一样要调用方允许
  if (afterCopy === "delete" && !input.allowDelete) throw http(403, "复制完删掉网盘上的源文件要有「删除」权限", "INSUFFICIENT_SCOPE", { required: "danger" });
  const cfg = resolveCopyConfig(settings);
  const base = normTargetDir(opts.dstDir) || cfg.dstDir;

  // 第一阶段：只看不改。到网盘核对每条路径、和目标比对；这里的任何一步不成，整个请求都不登记
  const provider = providerForTask(task);
  const origin = normDir(task.originPath);
  const targets = new TargetListing(cfg);
  const plans: PathPlan[] = [];
  for (const rel of rels) {
    signal?.throwIfAborted();
    const abs = joinPath(origin, rel);
    // 按父目录绕开缓存找：115 按路径找文件看的是缓存 5 分钟的目录清单，刚落进来的文件在里面还没有
    const node = await lookupFresh(task.account, abs);
    if (!node) {
      plans.push({ rel, outcome: "missing", sources: [] });
      continue;
    }
    const { dstDir } = dstDirFor(base, origin, abs);
    // 队列里已经有一条还没提交的整目录复制包着它、落点一样：那条会把它一起带过去，单独登记只会让整目录到时按「目标里已有」跳过
    if (findCoveringRecord({ account: task.account, srcDir: parentDir(abs), name: baseName(abs), dstDir, afterCopy })) {
      plans.push({ rel, outcome: "covered", isDir: node.isDir, sources: [] });
      continue;
    }
    const names = await targets.names(dstDir);
    if (!names?.includes(baseName(abs))) {
      // 目标里还没有：整条登记
      plans.push({ rel, outcome: "queued", isDir: node.isDir, sources: [{ path: abs, isDir: node.isDir, nodeId: node.id }] });
    } else if (!node.isDir) {
      plans.push({ rel, outcome: "exists", isDir: false, sources: [] });
    } else {
      // 大小对不上的（没复制完的残留）这里不管：目标里有这个名字就补不进去，由事后处理源文件那边（after.ts）当「不全」拦住
      const { missing: sources } = await planFill(provider, abs, node.id, joinPath(dstDir, baseName(abs)), targets, signal);
      plans.push({ rel, outcome: sources.length > 0 ? "filled" : "complete", isDir: true, sources });
    }
  }

  // 第二阶段：登记。上面等网络的时候整理可能开始了，再看一眼；从这里到登记完没有 await
  assertNotOrganizing(task);
  const items: ManualCopyItem[] = plans.map((p) => ({ path: p.rel, outcome: p.outcome, queued: 0, ...(p.isDir === undefined ? {} : { isDir: p.isDir }) }));
  const sources = plans.flatMap((p) => p.sources);
  let queued = 0;
  let pending: Exclude<CopyAfterCopy, "keep"> | undefined;
  let reason: string | undefined;
  if (sources.length > 0) {
    const r = enqueueCopy({ account: task.account, sources, rootPath: origin, taskId: task.id, dstDir: opts.dstDir, afterCopy, trigger: "manual" });
    // 设置在这一步被改坏了（挂载根被删之类）和「都排着了」要分开说：前者整个请求都成不了
    if (r.queued === 0 && !r.duplicates && !r.covered) throw http(400, r.skipped ?? "没排上", "COPY_NOT_READY");
    queued = r.queued;
    pending = r.pendingAfterCopy;
    if (r.queued === 0) reason = r.skipped ?? undefined;
    // 每条路径排上了几条：按源路径归到它下面；一条都没排上的就是已经排着了
    const queuedPaths = (r.perSource ?? []).filter((s) => s.outcome === "queued").map((s) => s.path);
    plans.forEach((p, i) => {
      if (p.sources.length === 0) return;
      const abs = joinPath(origin, p.rel);
      const n = queuedPaths.filter((q) => q === abs || q.startsWith(`${abs}/`)).length;
      items[i].queued = n;
      if (n === 0) items[i].outcome = "duplicate";
    });
  }
  const summary = items.map((i) => `${i.path}=${i.outcome}${i.queued ? `(${i.queued})` : ""}`).join("，");
  log.info(`手动复制（${task.account}，任务 ${task.originPath}）：${summary}`);
  // 去向和 enqueueCopyFor 同一个口径：这次新排的按这次的；新排的不动、或没再排的，按已经排着的那条（可能是别的来源登记的）
  const reported: CopyAfterCopy = (queued > 0 && afterCopy !== "keep" ? afterCopy : undefined) ?? pending ?? "keep";
  const stuck = queued === 0 ? (reason ?? explainNothing(items)) : undefined;
  return { queued, dstDir: base, ...withAfterCopy(reported), items, ...(stuck ? { reason: stuck } : {}) };
}

/** 整理正在动这个任务的目录（跑着的 run，或攒着的自动整理）就拒：压着等整理的那套只放整理开始之前登记的，这里直说更清楚 */
export function assertNotOrganizing(task: TaskDefinition): void {
  const organizing = listRunsByStatus(["planning", "applying", "reverting"]).find((r) => r.taskId === task.id);
  if (organizing || autoOrganizeBusy(task.id)) {
    throw http(409, "这个任务正在整理，整理完再复制", "TASK_ORGANIZING", organizing ? { runId: organizing.id } : {});
  }
}

/** 一条都没排上时的原因：按最常见的那种说 */
function explainNothing(items: ManualCopyItem[]): string {
  if (items.every((i) => i.outcome === "missing")) return "网盘上没有这些路径";
  if (items.every((i) => i.outcome === "exists" || i.outcome === "complete")) return "目标里已经都有了";
  if (items.every((i) => i.outcome === "covered")) return "整目录的复制会把它们一起带过去";
  if (items.some((i) => i.outcome === "duplicate")) return "这些条目已经在队列里或刚复制过";
  return "没有要复制的条目";
}

/**
 * 归一路径：只收拢斜杠、去掉空段和 `.`，**不削每段的空格**（网盘上真有「Season 1 」这种名字，削了就找不到）；
 * 不许 `..` 和控制字符，不许任务目录本身（整目录复制会摆成 dst/tv，层级不对），不许暂存区（重复文件、归档），去重；
 * 父目录已经在里面的子路径去掉——整目录复制会把它带过去，单独登记只会让目录到时按「目标里已有」跳过。
 * 事后处理源文件（after.ts）按路径指定时也走这一套
 */
export function uniquePaths(paths: string[]): string[] {
  if (paths.length === 0) throw http(400, "paths 不能为空", "VALIDATION");
  if (paths.length > MANUAL_PATHS_MAX) throw http(400, `一次最多 ${MANUAL_PATHS_MAX} 条路径`, "VALIDATION");
  const out: string[] = [];
  for (const raw of paths) {
    let rel: string;
    try {
      rel = normalizeRel(raw);
    } catch {
      throw http(400, `路径里不能有「..」或控制字符：${raw}`, "VALIDATION");
    }
    if (!rel) throw http(400, "路径不能是任务目录本身：要整个任务都复制，把它下面的条目选上", "VALIDATION");
    if (isStagingDir(rel)) throw http(400, `「${rel.split("/")[0]}」是暂存区（整理挪进去的重复文件、复制后归档的），不复制`, "VALIDATION");
    if (!out.includes(rel)) out.push(rel);
  }
  return out.filter((p) => !out.some((o) => o !== p && p.startsWith(`${o}/`)));
}

/**
 * OpenList 目标目录的一层条目（名字、类型、大小），同一次请求里每个目录只列一次。
 * 只有 OpenList 明确说「没有这个目录」才记成 null（当它还没有）；连不上、超时这些不能猜——
 * 猜成「没有」会整目录登记，到时按「目标里已有」跳过，缺的永远补不上，所以直接报错、整个请求不登记
 */
export class TargetListing {
  private readonly cache = new Map<string, OpenlistTargetEntry[] | null>();
  private calls = 0;
  constructor(private readonly cfg: CopyConfig) {}
  async entries(dir: string): Promise<OpenlistTargetEntry[] | null> {
    const key = normDir(dir);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    if (++this.calls > FILL_DIRS_MAX) throw http(400, `目标里要比对的目录超过 ${FILL_DIRS_MAX} 个，请缩小范围（少选几个目录）`, "TOO_LARGE");
    let entries: OpenlistTargetEntry[] | null;
    try {
      entries = await listOpenlistEntries(this.cfg, key);
    } catch (err) {
      if (!isMissingDir(err)) throw upstreamError(`读 OpenList 的 ${key} 失败：${messageOf(err)}`, {}, err);
      entries = null;
    }
    this.cache.set(key, entries);
    return entries;
  }
  async names(dir: string): Promise<string[] | null> {
    const entries = await this.entries(dir);
    return entries ? entries.map((e) => e.name) : null;
  }
}

/** 两边都知道大小才比；对不上多半是没复制完的残留 */
export const sizeMismatch = (src: number | undefined, dst: number | undefined): boolean => src !== undefined && dst !== undefined && src !== dst;

/** planFill 的结论：目标里缺的（按文件 / 整个子目录），以及两边都在、文件大小却对不上的（相对 abs 的路径） */
export interface FillPlan {
  missing: CopySource[];
  mismatched: string[];
}

/**
 * 目标里已经有同名目录：和源子树逐层比对，目标里缺的文件按文件登记、缺的子目录整目录登记（只比名字）；
 * 两边都有的文件顺带比大小（两边都知道才比），对不上的单列——手动复制不管它（目标里有这个名字就补不进去），
 * 事后处理源文件（after.ts）靠它拦住「目标里是个没复制完的残留」。
 * 有 walkSubtree 的网盘（夸克 / OpenList）一次拿到整棵带 id 和大小；115 只有文件路径，目录从路径里推，节点 id 到提交时再钉、大小不比
 */
export async function planFill(provider: DriveProvider, abs: string, id: string, olDir: string, targets: TargetListing, signal: AbortSignal | undefined): Promise<FillPlan> {
  const entries = await subtreeEntries(provider, abs, { id, signal });
  const files = entries.filter((e) => !e.isDir).length;
  if (files > FILL_FILES_MAX) throw http(400, `「${baseName(abs)}」里有 ${files} 个文件，超过一次补齐的上限 ${FILL_FILES_MAX}，请缩小范围`, "TOO_LARGE");
  /** 目录（相对 abs，"" 是根）→ 直接子项 */
  const children = new Map<string, SubtreeEntry[]>();
  for (const e of entries) {
    const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
    const list = children.get(dir) ?? [];
    list.push(e);
    children.set(dir, list);
  }
  const missing: CopySource[] = [];
  const mismatched: string[] = [];
  const walk = async (relDir: string, dir: string): Promise<void> => {
    signal?.throwIfAborted();
    const here = new Map(((await targets.entries(dir)) ?? []).map((t) => [t.name, t]));
    for (const e of children.get(relDir) ?? []) {
      const name = baseName(e.path);
      const hit = here.get(name);
      if (!hit) {
        missing.push({ path: joinPath(abs, e.path), isDir: e.isDir, ...(e.id ? { nodeId: e.id } : {}) });
      } else if (e.isDir) {
        await walk(e.path, joinPath(dir, name));
      } else if (sizeMismatch(e.size, hit.size)) {
        mismatched.push(e.path);
      }
    }
  };
  await walk("", olDir);
  return { missing, mismatched };
}
