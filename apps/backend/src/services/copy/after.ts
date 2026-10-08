/**
 * 事后处理已经复制到 OpenList 的条目的源文件：归档（挪进任务目录下的「归档」，可逆）或删除。
 * 复制时去向选的是「不动」、或者当时没按设置处理成（归档里有同名、接口超时三次都没成）的，事后从这里补：
 * 界面队列面板的「归档源文件」、智能体的 copy_after、REST 的 POST /api/copy/after 都走这里。
 *
 * 两种指定方式：
 *   - ids：队列里的记录（copy_list / GET /api/copy 里 canAfterCopy 为 true 的）；
 *   - task + paths：相对任务网盘目录的路径（和 copy_add 同一口径）。办完的记录只留两天，更早复制的只能这么指。
 *     队列里有同一条的（排着的、复制好的）就接着用那条；没有就新记一条「目标里已经有这一份」的记录，结果落在它上面。
 *
 * 动手前先核对，比复制完自动处理那道门还严一层：源还在原处（知道节点 id 的要对得上）、目标里这一份齐了——
 * 目录逐层比名字、文件比大小，少了或大小对不上的不动（outcome = incomplete），让人先用 copy_add 补齐。
 * 还在复制中的记录不动源，改成「复制完再按这个去向处理」（scheduled）。
 * 两个阶段：先只看不改（任何一条核对不了，整个请求都不动），再逐条处理、随手写回（中途取消的，办完的那几条已经落库）。
 * 删除要调用方明确允许（令牌得有「删除」档），和手动发起复制一样。
 */
import { randomUUID } from "node:crypto";
import type { CopyAfterCopy, TaskDefinition } from "@openstrm/shared";
import { AFTER_COPY_LABEL } from "../../lib/after-copy.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { getTask } from "../../db/repositories/tasks.js";
import { messageOf } from "../../lib/errors.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { providerForAccount } from "../drive/registry.js";
import type { DriveEntry, DriveProvider } from "../drive/types.js";
import { assertNotOrganizing, planFill, sizeMismatch, TargetListing, uniquePaths } from "./manual.js";
import { baseName, copyDstProblem, dstDirFor, joinPath, normConfigDir, normDir, normTargetDir, parentDir, relativeTo, resolveCopyConfig, type CopyConfig } from "./paths.js";
import { commitCopies, listCopies, sameTarget, type CopyRecord } from "./queue.js";
import { afterCopyBlocker, applyAfterCopy, canAfterCopy, resetArchiveDirCache, startCopyWatcher, upgradeAfterCopy, type AfterCopyOutcome } from "./service.js";

const log = moduleLogger("copy-after");

/** 一次最多处理多少条（按 id 和按路径合计） */
export const AFTER_MAX = 50;

/**
 * 一条的结果：
 *   archived    挪进归档了（to 是归档里的目录）
 *   deleted     删了（进回收站）
 *   retrying    碰上临时错误（网络断、超时、网盘 5xx），复制队列的循环稍后自动再做
 *   kept        没动：原因在 detail（归档里已有同名、源不在原处、源路径上换了别的文件、网盘不支持……）
 *   incomplete  目标里没有这一份、少了几项或大小对不上：没动，先补齐
 *   missing     网盘上没有这条路径
 *   scheduled   还在复制，去向补上了，复制完会按它处理
 *   pending     还在复制，记录上已经有去向（先登记的算）或者补不上；复制完按记录上的来
 *   invalid     这条处理不了：原因在 detail（记录不存在、没复制成、接管的、正在自动重试、已经处理过……）
 */
export type AfterCopyItemOutcome = "archived" | "deleted" | "retrying" | "kept" | "incomplete" | "missing" | "scheduled" | "pending" | "invalid";

export interface AfterCopyItem {
  /** 相对任务网盘目录的路径；按 id 指的也换算出来（算不出来就是网盘绝对路径） */
  path: string;
  /** 复制记录 id（有的话；按路径新记的也有） */
  id?: string;
  name: string;
  outcome: AfterCopyItemOutcome;
  isDir?: boolean;
  /** 原因 / 说明 */
  detail?: string;
  /** 归档到了哪（网盘上归档里的目录） */
  to?: string;
}

export type AfterCopyAction = Exclude<CopyAfterCopy, "keep">;

export interface AfterCopyInput {
  afterCopy: AfterCopyAction;
  /** 复制记录 id；和 task + paths 二选一 */
  ids?: string[];
  task?: TaskDefinition;
  /** 相对任务网盘目录的路径 */
  paths?: string[];
  /** 当初复制到了哪（OpenList 完整路径）；不给按任务上 / 设置页的目标目录。只对 task + paths 有意义 */
  dstDir?: string;
  /** 去向是「删除」时调用方允不允许：会话可以，令牌要有「删除」档 */
  allowDelete: boolean;
  signal?: AbortSignal;
  /** 每处理完一条叫一声（done / total），给智能体推进度 */
  onProgress?: (done: number, total: number) => void;
}

export interface AfterCopyResult {
  afterCopy: AfterCopyAction;
  /** 处理成了几条（archived / deleted） */
  done: number;
  items: AfterCopyItem[];
}

const http = (status: number, message: string, code: string, extra: Record<string, unknown> = {}) => new HttpError(status, message, { code, ...extra });

/** 第一阶段看完的一条：已经有结论的直接带 item；要动手的带 act */
type Plan =
  | { item: AfterCopyItem; act?: undefined }
  | { item: AfterCopyItem; act: { kind: "apply"; record: CopyRecord; isNew: boolean; entry: DriveEntry } }
  | { item: AfterCopyItem; act: { kind: "schedule"; record: CopyRecord; nodeId: string } };

export async function settleAfterCopy(input: AfterCopyInput): Promise<AfterCopyResult> {
  const { afterCopy, signal } = input;
  const label = AFTER_COPY_LABEL[afterCopy];
  if (afterCopy === "delete" && !input.allowDelete) throw http(403, "事后删掉网盘上的源文件要有「删除」权限", "INSUFFICIENT_SCOPE", { required: "danger" });
  const ids = [...new Set((input.ids ?? []).map((s) => s.trim()).filter(Boolean))];
  const rawPaths = input.paths ?? [];
  if (ids.length === 0 && rawPaths.length === 0) throw http(400, "要给 ids（复制记录）或 task + paths（相对任务目录的路径）", "VALIDATION");
  if (ids.length > 0 && rawPaths.length > 0) throw http(400, "ids 和 task + paths 二选一，别一起给", "VALIDATION");
  if (rawPaths.length > 0 && !input.task) throw http(400, "按路径指定要给 task", "VALIDATION");
  if (ids.length > AFTER_MAX || rawPaths.length > AFTER_MAX) throw http(400, `一次最多 ${AFTER_MAX} 条`, "VALIDATION");

  const settings = readAppSettings();
  let cfg: CopyConfig;
  try {
    cfg = resolveCopyConfig(settings);
  } catch (err) {
    throw http(400, `没法核对 OpenList 里的那一份：${messageOf(err)}`, "COPY_NOT_READY");
  }
  const targets = new TargetListing(cfg);
  const lookups = new Lookups();
  const rows = listCopies();
  const plans: Plan[] = [];
  /** 这次碰到的任务：动手前再看一眼有没有在整理 */
  const tasks = new Map<string, TaskDefinition>();
  const guard = (task: TaskDefinition) => {
    if (tasks.has(task.id)) return;
    assertNotOrganizing(task);
    tasks.set(task.id, task);
  };

  // 第一阶段：只看不改
  for (const id of ids) {
    signal?.throwIfAborted();
    const c = rows.find((r) => r.id === id);
    if (!c) {
      plans.push({ item: { path: "", id, name: "", outcome: "invalid", detail: "复制记录不存在" } });
      continue;
    }
    const task = c.taskId ? getTask(c.taskId) : null;
    const abs = joinPath(c.srcDir, c.name);
    const rel = task ? relativeTo(normDir(task.originPath), abs) : null;
    const base: AfterCopyItem = { path: rel || abs, id: c.id, name: c.name, outcome: "invalid", ...(c.isDir === undefined ? {} : { isDir: c.isDir }) };
    if (c.status === "pending") {
      plans.push(await planPending(c, base, lookups));
      continue;
    }
    const why = afterCopyBlocker(c);
    if (why) {
      plans.push({ item: { ...base, detail: why } });
      continue;
    }
    if (!task) {
      plans.push({ item: { ...base, detail: "这条记录的任务已经不在了" } });
      continue;
    }
    if (!rel) {
      plans.push({ item: { ...base, detail: "源路径不在任务的网盘目录下" } });
      continue;
    }
    guard(task);
    plans.push(await planApply(c, false, base, abs, c.dstDir, targets, lookups, signal));
  }

  if (rawPaths.length > 0 && input.task) {
    const task = input.task;
    const dst = normConfigDir(input.dstDir);
    if (input.dstDir !== undefined && input.dstDir.trim() !== "" && !dst) throw http(400, "dstDir 不是一个有效的路径", "VALIDATION");
    if (dst) {
      const why = copyDstProblem(dst, task, settings);
      if (why) throw http(400, why, "COPY_DST_INVALID");
    }
    const base = normTargetDir(dst) || normTargetDir(task.copyToOpenlist?.dstDir) || cfg.dstDir;
    if (!base) throw http(400, "任务上和设置页都没填复制的目标目录，不知道复制到了哪", "COPY_NOT_READY");
    const rels = uniquePaths(rawPaths);
    guard(task);
    const origin = normDir(task.originPath);
    for (const rel of rels) {
      signal?.throwIfAborted();
      const abs = joinPath(origin, rel);
      const name = baseName(abs);
      const { dstDir } = dstDirFor(base, origin, abs);
      const item: AfterCopyItem = { path: rel, name, outcome: "invalid" };
      const same = rows.filter((r) => !r.adopted && sameTarget(r, { account: task.account, srcDir: parentDir(abs), name, dstDir }));
      const pending = same.find((r) => r.status === "pending");
      if (pending) {
        plans.push(await planPending(pending, { ...item, id: pending.id }, lookups));
        continue;
      }
      // 复制好的那条接着用（去向正在自动重试的让它自己来）；已经处理过、源却又在原处的（人挪回来了）按新的一次算
      const done = same.filter((r) => r.status === "done").sort((a, b) => (b.doneAt ?? b.addedAt) - (a.doneAt ?? a.addedAt))[0];
      if (done?.afterRetry) {
        plans.push({ item: { ...item, id: done.id, detail: afterCopyBlocker(done) ?? "正在自动重试" } });
        continue;
      }
      const reuse = done && canAfterCopy(done) ? done : undefined;
      const record: CopyRecord = reuse ?? {
        id: randomUUID(),
        account: task.account,
        srcDir: parentDir(abs),
        name,
        dstDir,
        dstBase: base,
        rootPath: origin,
        taskId: task.id,
        trigger: "manual",
        afterCopy,
        addedAt: 0,
        status: "done",
        stage: "copying",
        detail: "",
        attempts: 0,
        waits: 0,
        misses: 0,
      };
      // 新记的那条要真处理了才落库：没动的（网盘上没有、目标里不全）结果里不带它的 id
      plans.push(await planApply(record, !reuse, reuse ? { ...item, id: reuse.id } : item, abs, dstDir, targets, lookups, signal));
    }
  }

  // 第二阶段：动手。上面等网络的时候整理可能开始了，再看一眼
  for (const task of tasks.values()) assertNotOrganizing(task);
  resetArchiveDirCache();
  const items: AfterCopyItem[] = [];
  let done = 0;
  let retrying = false;
  const total = plans.filter((p) => p.act).length;
  let progressed = 0;
  for (const p of plans) {
    signal?.throwIfAborted();
    if (!p.act) {
      items.push(p.item);
      continue;
    }
    if (p.act.kind === "schedule") {
      items.push(schedule(p.act.record, p.act.nodeId, p.item, afterCopy));
    } else {
      const { record: c, isNew, entry } = p.act;
      const now = Date.now();
      c.afterCopy = afterCopy;
      c.sourceKept = undefined;
      c.isDir = entry.isDir;
      c.nodeId = String(entry.id);
      c.doneAt = now;
      if (isNew) {
        c.addedAt = now;
        c.detail = "目标里已经有这一份，事后处理源文件";
      } else {
        c.detail = `复制完成（事后${label}）`;
      }
      const r = await applyAfterCopy(c, cfg, { retry: false, verified: true });
      // 新记的加进去；接着用的按 id 写回（这期间被界面去掉了的不复活）
      if (isNew) commitCopies([], now, [c]);
      else commitCopies([c], now);
      if (r.kind === "retry") retrying = true;
      if (r.kind === "archived" || r.kind === "removed") done++;
      items.push(outcomeItem({ ...p.item, id: c.id }, r, afterCopy));
    }
    input.onProgress?.(++progressed, total);
  }
  // 临时错误等着晚点再做：循环要转到它做完（没别的活时循环是停着的）
  if (retrying) startCopyWatcher();
  const summary = items.map((i) => `${i.path || i.id}=${i.outcome}`).join("，");
  log.info(`事后${label}源文件（${[...tasks.values()].map((t) => `${t.account} ${t.originPath}`).join("、") || "按记录"}）：${summary}`);
  return { afterCopy, done, items };
}

/** 网盘上这个路径现在是哪一条（带大小、类型），按父目录绕开缓存列；同一次请求里每个父目录只列一次。归档到暂存区（archive.ts）也用 */
export class Lookups {
  private readonly dirs = new Map<string, Promise<DriveEntry[] | null>>();
  async entry(account: string, abs: string): Promise<DriveEntry | null> {
    const provider = providerForAccount(account);
    const parent = parentDir(abs);
    const key = JSON.stringify([account, parent]);
    let listing = this.dirs.get(key);
    if (!listing) {
      listing = (async () => {
        const dir = await provider.resolvePath(parent);
        if (!dir || !dir.isDir) return null;
        return provider.listDir(dir.id, undefined, { fresh: true });
      })();
      this.dirs.set(key, listing);
    }
    const name = baseName(abs);
    return (await listing)?.find((e) => e.name === name) ?? null;
  }
  provider(account: string): DriveProvider {
    return providerForAccount(account);
  }
}

/** 还在复制的：去向补得上就补（复制完按它处理），补不上说清楚 */
async function planPending(c: CopyRecord, item: AfterCopyItem, lookups: Lookups): Promise<Plan> {
  if (c.adopted || c.srcDir === "") return { item: { ...item, detail: "这条是升级前接管的，不知道源在哪" } };
  if (c.afterCopy !== "keep") {
    return { item: { ...item, outcome: "pending", detail: `还在复制，复制完会按记录上的去向（${AFTER_COPY_LABEL[c.afterCopy]}）处理；先登记的算，这次没改` } };
  }
  // 补去向要钉住节点：复制完动源文件之前得核对是不是原来那一份
  const nodeId = c.nodeId ?? (await lookups.entry(c.account, joinPath(c.srcDir, c.name)))?.id;
  if (!nodeId) return { item: { ...item, outcome: "pending", detail: "还在复制，网盘上没找到它的节点、去向补不上；复制完再来" } };
  return { item, act: { kind: "schedule", record: c, nodeId: String(nodeId) } };
}

/** 第二阶段给排着的那条补去向：库里重读，这一会儿它可能已经复制完、或者被去掉了 */
function schedule(c: CopyRecord, nodeId: string, item: AfterCopyItem, afterCopy: AfterCopyAction): AfterCopyItem {
  const fresh = listCopies().find((r) => r.id === c.id);
  if (!fresh) return { ...item, outcome: "invalid", detail: "这条记录刚被从队列里去掉了" };
  if (fresh.status !== "pending") return { ...item, outcome: "pending", detail: "刚复制完了，再调一次就能处理源文件" };
  if (!upgradeAfterCopy(fresh, { afterCopy, nodeId, holdUntil: undefined })) {
    return { ...item, outcome: "pending", detail: `还在复制，复制完会按记录上的去向（${AFTER_COPY_LABEL[fresh.afterCopy]}）处理` };
  }
  commitCopies([fresh]);
  return { ...item, outcome: "scheduled", detail: `还在复制，复制完会${AFTER_COPY_LABEL[afterCopy]}源文件` };
}

/**
 * 复制好的一条动手前的核对：源在不在原处（节点 id 对不对得上）、目标里这一份齐不齐。
 * 目标不齐的说清楚少了什么；整目录比对太大（超过 copy_add 同一上限）的只拦这一条，别的照常
 */
async function planApply(
  c: CopyRecord,
  isNew: boolean,
  item: AfterCopyItem,
  abs: string,
  dstDir: string,
  targets: TargetListing,
  lookups: Lookups,
  signal: AbortSignal | undefined,
): Promise<Plan> {
  const entry = await lookups.entry(c.account, abs);
  if (!entry) return { item: { ...item, outcome: "missing", detail: "网盘上没有这条路径（源文件已不在原处）" } };
  if (c.nodeId && String(entry.id) !== String(c.nodeId)) return { item: { ...item, isDir: entry.isDir, outcome: "kept", detail: "源路径上换成了别的文件，不是复制的那一份" } };
  const name = baseName(abs);
  const here = (await targets.entries(dstDir))?.find((e) => e.name === name);
  if (!here) return { item: { ...item, isDir: entry.isDir, outcome: "incomplete", detail: `目标 ${dstDir} 里没有这一份` } };
  if (!entry.isDir) {
    if (sizeMismatch(entry.size, here.size)) {
      return { item: { ...item, isDir: false, outcome: "incomplete", detail: `目标里那份大小对不上（网盘 ${entry.size}，目标 ${here.size}），可能是没复制完的残留` } };
    }
    return { item: { ...item, isDir: false }, act: { kind: "apply", record: c, isNew, entry } };
  }
  let plan;
  try {
    plan = await planFill(lookups.provider(c.account), abs, entry.id, joinPath(dstDir, name), targets, signal);
  } catch (err) {
    if (err instanceof HttpError && err.extra.code === "TOO_LARGE") return { item: { ...item, isDir: true, detail: err.message } };
    throw err;
  }
  if (plan.missing.length > 0 || plan.mismatched.length > 0) {
    const parts = [
      plan.missing.length > 0 ? `少了 ${plan.missing.length} 项（${plan.missing.slice(0, 3).map((m) => baseName(m.path)).join("、")}${plan.missing.length > 3 ? "…" : ""}）` : "",
      plan.mismatched.length > 0 ? `${plan.mismatched.length} 个文件大小对不上（${plan.mismatched.slice(0, 3).map(baseName).join("、")}${plan.mismatched.length > 3 ? "…" : ""}）` : "",
    ].filter(Boolean);
    return { item: { ...item, isDir: true, outcome: "incomplete", detail: `目标里的这个目录不全：${parts.join("；")}` } };
  }
  return { item: { ...item, isDir: true }, act: { kind: "apply", record: c, isNew, entry } };
}

/** applyAfterCopy 的结论换成这一条的结果 */
function outcomeItem(item: AfterCopyItem, r: AfterCopyOutcome, afterCopy: AfterCopyAction): AfterCopyItem {
  if (r.kind === "archived") return { ...item, outcome: "archived", to: r.to };
  if (r.kind === "removed") return { ...item, outcome: "deleted" };
  if (r.kind === "retry") return { ...item, outcome: "retrying", detail: `${AFTER_COPY_LABEL[afterCopy]}源文件没成（${r.why}），复制队列稍后自动再试` };
  return { ...item, outcome: "kept", detail: r.why };
}
