/**
 * 「复制到 OpenList」：转存、追更、云下载、网盘监控落下的新文件，由 OpenList 复制到另一个存储（比如本地磁盘）。
 *   copy_list   看队列，和设置配没配好
 *   copy_add    手动把任务目录里已经有的目录 / 文件交给复制（事后补：转存时没勾、看片卡顿想放到本地）
 *   copy_retry  失败 / 跳过的重新排队
 *   copy_after  复制好的，事后把网盘上的源文件归档 / 删除（复制时去向选的是不动、或者当时没处理成）
 * 自动登记是各个来源自己做的（share_save / offline_add 的 copy 参数、任务上的开关）。
 * 归在「搜资源、收藏、转存与云下载」这一组：界面上复制队列就在云下载页，理由见 agent-access.md「复制到 OpenList 接进智能体」。
 *
 * 条目名可能来自别人的分享：只放在数据字段里，不拼进 next / hint / note。
 */
import { z } from "zod";
import type { AgentToken, AppSettings, CopyAfterCopy, TaskDefinition } from "@openstrm/shared";
import { AFTER_COPY_LABEL, afterCopyOf } from "../../../lib/after-copy.js";
import { readAppSettings } from "../../../db/repositories/settings.js";
import { listTasks } from "../../../db/repositories/tasks.js";
import { messageOf } from "../../../lib/errors.js";
import { copyBlockerFor, joinPath, normConfigDir, normTargetDir, resolveCopyConfig } from "../../copy/paths.js";
import {
  COPY_TRIGGER_LABEL,
  canAfterCopy,
  canRetryCopy,
  getCopyWatcherStatus,
  listCopies,
  retryCopies,
  type CopyOutcome,
  type CopyRecord,
  type CopyStatus,
} from "../../copy/service.js";
import { listFollowups } from "../../offline/service.js";
import { enqueueManualCopy, MANUAL_PATHS_MAX, type ManualCopyItem, type ManualCopyResult } from "../../copy/manual.js";
import { AFTER_MAX, settleAfterCopy, type AfterCopyItem, type AfterCopyItemOutcome, type AfterCopyResult } from "../../copy/after.js";
import { HttpError } from "../../../lib/http-error.js";
import { hasScope, hasToolset } from "../access.js";
import { LOCAL_READ, ToolError, defineTool } from "../define.js";
import { fmtTime, openInUi, page } from "../format.js";
import { JOB_RETENTION_MS, startJob, viewJob, waitForJob } from "../jobs.js";
import { resolveTask, taskBrief } from "../resolve.js";

/** 界面上的复制队列：云下载页的「复制到 OpenList」那一块 */
const COPY_UI = "/offline#copy-queue";

/** 和界面的队列面板同一套叫法 */
const STATUS_TEXT: Record<CopyStatus, string> = { pending: "复制中", done: "已复制", skipped: "已跳过", failed: "失败" };

/* ------------------------------- 设置 ------------------------------- */

/**
 * 设置配没配好：只看设置和账号表，不联网。problem 和设置页说的是同一套话；
 * 挂载根是按网盘账号各填各的，哪个账号能复制看 mounts
 */
export function copyConfigState(settings: AppSettings = readAppSettings()): { configured: boolean; problem?: string; mounts: Record<string, string> } {
  const mounts: Record<string, string> = {};
  for (const [name, path] of Object.entries(settings.openlistCopy?.mounts ?? {})) {
    const norm = normConfigDir(path);
    if (norm) mounts[name] = norm;
  }
  let problem: string | undefined;
  try {
    resolveCopyConfig(settings);
  } catch (err) {
    problem = messageOf(err);
  }
  if (!problem && Object.keys(mounts).length === 0) problem = "还没给任何网盘账号填「在 OpenList 里的挂载根」";
  return { configured: !problem, ...(problem ? { problem } : {}), mounts };
}

/**
 * 这个网盘账号现在复制得了吗（dstDir = 这次指定的或任务上的目标目录，都没有看设置页的默认值）。null = 复制得了。
 * 和转存框、任务列表同一套判断（copyBlockerFor），云下载不给任务时也能用
 */
export function copyProblemFor(account: string, dstDir: string | undefined, settings: AppSettings): string | null {
  return copyBlockerFor(settings)({ account, copyToOpenlist: { dstDir } });
}

/**
 * 任务开着复制时要「这次不复制」：兑现不了。网盘监控会把新落进任务目录的文件照样交给复制，
 * 所以界面上转存框、云下载框的勾选框在这种任务上都是锁住的
 */
export function copyAlwaysOn(): ToolError {
  return new ToolError(
    "COPY_ALWAYS_ON",
    "这个任务开着「复制到 OpenList」，这次没法不复制：网盘监控也会把新落进任务目录的文件交给复制，界面上的勾选框同样是锁住的",
    "要不复制，得请用户先在任务设置里关掉「复制到 OpenList」；不然就别传 copy: false。",
  );
}

/** 明说要复制却复制不了：动手前就报，别转存 / 下载完了才发现 */
export function copyNotReady(why: string): ToolError {
  return new ToolError(
    "COPY_NOT_READY",
    `没法复制到 OpenList：${why}`,
    "只能由用户到设置页的「复制到 OpenList」里配好；或者这次不复制（copy 不传或传 false）。",
  );
}

/* ------------------------------- 给别的工具用的回显 ------------------------------- */

/**
 * 复制成功后源文件会怎样，给模型复述用；不动的是空串。
 * 说明里要提「本地 strm 跟着删」：删了 / 挪了之后那个 strm 指着的路径空了
 */
export function afterCopyNote(afterCopy: CopyAfterCopy): string {
  if (afterCopy === "delete") return "复制成功后会删掉网盘上的源文件（进回收站）和本地对应的 strm";
  if (afterCopy === "archive") return "复制成功后会把网盘上的源文件挪进任务目录下的「归档」目录（原来的层级留着，本地对应的 strm 删掉；想恢复挪回去就行）";
  return "";
}

/** 结果里去向的两个字段：afterCopy 是准的，deleteSource 是老字段（等于 afterCopy 是 delete） */
const afterCopyFields = (afterCopy: CopyAfterCopy) => ({ afterCopy, afterCopyText: AFTER_COPY_LABEL[afterCopy], deleteSource: afterCopy === "delete" });

/**
 * 转存 / 追更结果里的 copy：排没排上、复制到哪、复制完源文件的去向，外加一句给模型复述的话。
 * reason 只会是设置上的问题或「都重复了」，不含分享里的文件名。
 * 令牌没开这一组（追更检查是另一组的工具）就不叫它去调 copy_list
 */
export function copyOutcomeView(o: CopyOutcome, token: Pick<AgentToken, "toolsets">): Record<string, unknown> {
  const progress = hasToolset(token, "transfer") ? "用 copy_list 看进度" : "进度在 OpenStrm 云下载页的「复制到 OpenList」里看";
  const after = afterCopyNote(o.afterCopy);
  if (o.queued === 0) {
    const reason = o.reason ?? "没有可排的条目";
    // 带着目标根的只可能是「都已经排着或刚复制过」：那些排着的去向照实说（可能是别的来源登记的，也可能刚补上）；
    // 没带的是设置上的问题（极少数是登记时出错），原因都在 reason 里
    if (o.dstDir) {
      return {
        queued: 0,
        dstDir: o.dstDir,
        ...afterCopyFields(o.afterCopy),
        reason,
        note: after
          ? `这些条目已经在复制队列里或刚复制过，这次没再排；排着的那些${after}。${progress}。`
          : `这些条目已经在复制队列里或刚复制过，这次没再排。${progress}。`,
      };
    }
    return {
      queued: 0,
      ...afterCopyFields("keep"),
      reason,
      note: "这次没有复制到 OpenList，原因见 reason；设置上的问题只能由用户到设置页的「复制到 OpenList」里处理。",
    };
  }
  const where = `已排进复制队列，复制到 ${o.dstDir} 下（按任务目录的层级摆）`;
  return {
    queued: o.queued,
    dstDir: o.dstDir,
    ...afterCopyFields(o.afterCopy),
    note: after ? `${where}；任务设了「复制后${AFTER_COPY_LABEL[o.afterCopy]}」，${after}。${progress}。` : `${where}。${progress}。`,
  };
}

/** tasks_list 里开了复制的任务带的：复制到哪、删不删源、开着却复制不了的原因。没开的不带 */
export function taskCopyView(
  task: TaskDefinition,
  blockerOf: (t: TaskDefinition) => string | null,
  settings: AppSettings,
): Record<string, unknown> | undefined {
  const cfg = task.copyToOpenlist;
  if (!cfg?.enabled) return undefined;
  const blocked = blockerOf(task);
  return {
    dstDir: normTargetDir(cfg.dstDir) || normTargetDir(settings.openlistCopy?.dstDir) || null,
    ...afterCopyFields(afterCopyOf(cfg)),
    ...(blocked ? { blocked } : {}),
  };
}

/** overview 里的一行：设置配没配好、队列里在跑的 / 失败的、云下载下完才复制的。只看设置和队列，不联网 */
export function copyOverview(settings: AppSettings = readAppSettings()): Record<string, unknown> {
  const rows = listCopies();
  return {
    configured: copyConfigState(settings).configured,
    pending: rows.filter((c) => c.status === "pending").length,
    failed: rows.filter((c) => c.status === "failed").length,
    afterDownload: listFollowups().filter((f) => f.status === "pending" && ((f.kind ?? "strm") === "openlist-copy" || Boolean(f.copyDstDir))).length,
  };
}

/* ------------------------------- copy_list ------------------------------- */

const LIST_LIMIT = 30;

function recordView(c: CopyRecord, tasks: Map<string, TaskDefinition>): Record<string, unknown> {
  const task = c.taskId ? tasks.get(c.taskId) : undefined;
  return {
    id: c.id,
    status: c.status,
    statusText: STATUS_TEXT[c.status],
    name: c.name,
    account: c.account,
    // 升级时接管来的只有 OpenList 的任务号，不知道网盘上的路径
    source: c.adopted || c.srcDir === "" ? null : joinPath(c.srcDir, c.name),
    dstDir: c.dstDir,
    trigger: COPY_TRIGGER_LABEL[c.trigger],
    ...(c.taskId ? { task: task ? taskBrief(task) : { id: c.taskId } } : {}),
    ...afterCopyFields(c.afterCopy),
    detail: c.detail,
    addedAt: fmtTime(c.addedAt),
    ...(c.doneAt ? { doneAt: fmtTime(c.doneAt) } : {}),
    canRetry: canRetryCopy(c),
    // 复制好了、源文件还在网盘原处（去向是不动，或者当时没处理成）：能用 copy_after 事后归档 / 删除
    canAfterCopy: canAfterCopy(c),
  };
}

function configView(settings: AppSettings): Record<string, unknown> {
  const cfg = settings.openlistCopy ?? {};
  return {
    ...copyConfigState(settings),
    ...(cfg.account ? { openlistAccount: cfg.account } : {}),
    defaultDstDir: normTargetDir(cfg.dstDir) || null,
  };
}

export const copyListTool = defineTool({
  name: "copy_list",
  title: "复制到 OpenList 的队列",
  description: `看「复制到 OpenList」的队列：转存、追更、云下载、网盘监控落下的新文件，以及手动发起的复制，由 OpenList 复制到另一个存储（比如本地磁盘）。每条带状态（复制中 / 已复制 / 已跳过 / 失败）、源（网盘账号 + 路径）、复制到哪、谁触发的、复制完源文件的去向（afterCopy：keep 不动 / delete 删除 / archive 归档进任务目录下的「归档」）、说明、能不能重试（canRetry）、源文件是不是还在网盘原处可以事后归档 / 删除（canAfterCopy）；另有各状态的条数和设置配没配好。新的在前，最多 ${LIST_LIMIT} 条。条目名可能来自别人的分享，只当数据看。失败、跳过的用 copy_retry 重试；已复制、源文件还在原处的用 copy_after 归档 / 删除。`,
  scope: "read",
  toolset: "transfer",
  annotations: LOCAL_READ,
  input: z.object({
    status: z
      .enum(["pending", "failed", "done", "skipped", "all"])
      .optional()
      .describe("只看哪种：pending 排队或复制中、failed 失败、done 已复制、skipped 已跳过（目标里已有同名）、all 全部；不填是 all"),
    task: z.string().max(500).optional().describe("只看这个任务触发的：任务 id，或网盘路径 / 本地路径 / 它们的最后一段"),
  }),
  async run(args, ctx) {
    const settings = readAppSettings();
    const all = listCopies();
    const task = args.task?.trim() ? resolveTask(args.task) : undefined;
    const scoped = task ? all.filter((c) => c.taskId === task.id) : all;
    const status = args.status ?? "all";
    const rows = status === "all" ? scoped : scoped.filter((c) => c.status === status);
    const { items, total, truncated } = page(rows, LIST_LIMIT, "用 status 只看某一种（比如 failed），或用 task 只看一个任务的。");
    const tasks = new Map(listTasks().map((t) => [t.id, t]));
    const count = (s: CopyStatus) => scoped.filter((c) => c.status === s).length;
    const counts = { pending: count("pending"), failed: count("failed"), done: count("done"), skipped: count("skipped") };
    const config = configView(settings);

    const hints: string[] = [];
    if (counts.pending > 0) hints.push("复制在后台跑（大约 30 秒推进一轮），过几分钟再看，别连续快速轮询。");
    if (scoped.some(canRetryCopy)) {
      hints.push(
        ctx.token.scopes.includes("write")
          ? "失败的先看 detail 找原因，canRetry 为 true 的可以用 copy_retry 重新排队（先告诉用户）；跳过的是目标里已经有同名的，要用户先删掉目标里那份再重试。"
          : "失败的请用户在 OpenStrm 云下载页的「复制到 OpenList」里重试（这个令牌没有「改网盘」权限）。",
      );
    }
    if (config.configured === false) hints.push("设置没配好，只能由用户到设置页的「复制到 OpenList」里配。");
    if (ctx.token.scopes.includes("write") && items.some(canAfterCopy)) {
      hints.push("canAfterCopy 为 true 的已复制记录，网盘上的源文件还在原处：用户想收起来的话可以用 copy_after 归档（可逆）或删除（要「删除」档），先告诉用户。");
    }
    const watcher = getCopyWatcherStatus(all);
    return {
      config,
      ...(task ? { task: taskBrief(task) } : {}),
      counts,
      items: items.map((c) => recordView(c, tasks)),
      total,
      ...(truncated ? { truncated } : {}),
      // 循环上一轮读 OpenList 失败（重启中、连不上）：还有在跑的才值得一提
      ...(watcher.lastError && counts.pending > 0 ? { watcherError: watcher.lastError } : {}),
      ...(hints.length ? { next: hints.join("") } : {}),
      ...openInUi(COPY_UI),
    };
  },
});

/* ------------------------------- copy_add ------------------------------- */

/** 每条路径的结果给模型看的说法 */
const ITEM_OUTCOME_TEXT: Record<ManualCopyItem["outcome"], string> = {
  queued: "已排进队列",
  filled: "目标里已经有这个目录，只补了缺的",
  complete: "目标里已经齐了，没再排",
  exists: "目标里已经有同名文件，没再排",
  duplicate: "已经在队列里或刚复制过",
  covered: "队列里有一条整目录的复制会把它一起带过去，没单独排",
  missing: "网盘上没有这条路径",
};

/** copy_add 的结果：按这次的 items 说话（不能套 copyOutcomeView：那边把「一条没排、带目标根」一律当成「都排着了」） */
function manualCopyView(task: TaskDefinition, r: ManualCopyResult, token: Pick<AgentToken, "toolsets">): Record<string, unknown> {
  const progress = hasToolset(token, "transfer") ? "用 copy_list 看进度" : "进度在 OpenStrm 云下载页的「复制到 OpenList」里看";
  const after = afterCopyNote(r.afterCopy);
  let note: string;
  if (r.queued > 0) note = `已排进复制队列，复制到 ${r.dstDir} 下（按任务目录的层级摆）${after ? `；${after}` : ""}。${progress}。`;
  else if (r.items.some((i) => i.outcome === "duplicate")) note = `这些条目已经在复制队列里或刚复制过，这次没再排${after ? `；排着的那些${after}` : ""}。${progress}。`;
  else note = `这次没有排上：${r.reason ?? "没有要复制的条目"}。逐条见 items。`;
  return {
    task: taskBrief(task),
    queued: r.queued,
    dstDir: r.dstDir,
    ...afterCopyFields(r.afterCopy),
    ...(r.reason ? { reason: r.reason } : {}),
    note,
    items: r.items.map((i) => ({ ...i, outcomeText: ITEM_OUTCOME_TEXT[i.outcome] })),
    ...(r.queued > 0 ? { next: "复制在后台跑（大约 30 秒推进一轮），过几分钟用 copy_list(status: \"pending\") 看进度，别连续快速轮询。" } : {}),
    ...openInUi(COPY_UI),
  };
}

export const copyAddTool = defineTool({
  name: "copy_add",
  title: "发起复制到 OpenList",
  description: `把任务网盘目录里已经有的目录 / 文件交给「复制到 OpenList」的队列（由 OpenList 复制到另一个存储，比如本地磁盘），给「转存时没勾复制、后来想放到本地」「看片卡顿想把某部片放到本地磁盘」这类情形用。**这会往目标存储里写东西，复制完还可能动网盘上的源文件：调用前把复制什么、复制到哪、复制完源文件怎么办告诉用户，得到同意再调用。** paths 相对任务的网盘目录（和 share_save 的 subPath、drive_browse 同一个口径），一次最多 ${MANUAL_PATHS_MAX} 条，不能是任务目录本身。路径怎么找：strm_search 按片名找本地 strm，结果里的网盘路径去掉任务目录就是（作品目录是第一段）；或者 drive_browse 看目录。目标里已经有同名目录的只补里面缺的（按名字比），已经有同名文件的跳过。afterCopy 是复制成功后源文件的去向：不给按任务设置（任务没开复制的就是不动）；keep 不动、archive 挪进任务目录下的「归档」（可逆）、delete 删掉（进回收站，不可逆，令牌要有「删除」档）。任务正在整理时会拒，整理完再来。结果里 items 逐条说排上没有；进度用 copy_list 看。`,
  scope: "write",
  toolset: "transfer",
  annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  input: z.object({
    task: z.string().min(1).max(500).describe("哪个任务：任务 id，或网盘路径 / 本地路径 / 它们的最后一段"),
    paths: z.array(z.string().min(1).max(1000)).min(1).max(MANUAL_PATHS_MAX).describe(`要复制的目录 / 文件，相对任务的网盘目录，用 / 分隔，1 到 ${MANUAL_PATHS_MAX} 条`),
    dstDir: z.string().max(1000).optional().describe("复制到哪（OpenList 完整路径）；不填用任务上或设置页的目标目录，填了也只能是它们或它们下面的目录"),
    afterCopy: z.enum(["keep", "delete", "archive"]).optional().describe("复制成功后源文件的去向：keep 不动 / archive 归档 / delete 删除（要「删除」档）；不填按任务设置"),
  }),
  async run(args, ctx) {
    const task = resolveTask(args.task);
    try {
      // 复制完删源要「删除」档：没明说、按任务设置落到删除的也一样，服务层按最终的去向把关
      const r = await enqueueManualCopy({ task, paths: args.paths, dstDir: args.dstDir, afterCopy: args.afterCopy, allowDelete: hasScope(ctx.token, "danger"), signal: ctx.signal });
      return manualCopyView(task, r, ctx.token);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      const code = typeof err.extra.code === "string" ? err.extra.code : undefined;
      if (code === "INSUFFICIENT_SCOPE") {
        // 删除是这次明说的，还是没说、按任务设置落到的：两种说法不一样，别把明说的说成任务设的
        const why = args.afterCopy === "delete" ? "afterCopy: \"delete\"（复制完删掉网盘上的源文件）要令牌有「删除」档" : "复制完删掉网盘上的源文件要令牌有「删除」档（这个任务设的就是复制后删除）";
        throw new ToolError(code, why, "让用户到设置页给这个令牌勾上「删除」档；或者传 afterCopy: \"archive\"（归档，可逆）/ \"keep\"。", { required: "danger" });
      }
      if (code === "COPY_NOT_READY") throw copyNotReady(err.message.replace(/^没法复制到 OpenList：/, ""));
      if (code === "TASK_ORGANIZING") throw new ToolError(code, err.message, "用 organize_status 等这次整理办完再调。", typeof err.extra.runId === "string" ? { runId: err.extra.runId } : {});
      if (code === "COPY_DST_INVALID") throw new ToolError(code, err.message, "不填 dstDir 就用任务上 / 设置页的目标目录；要指定就填它们下面的目录。");
      if (code === "TOO_LARGE") throw new ToolError(code, err.message, "少选几个目录，或者直接选要复制的季目录 / 文件。");
      if (code === "VALIDATION") throw new ToolError(code, err.message, "用 drive_browse 看这个任务的网盘目录，路径相对任务目录。");
      throw err;
    }
  },
});

/* ------------------------------- copy_retry ------------------------------- */

const RETRY_MAX = 50;

/** copy_retry 结果里的一条 */
type RetryView = { id: string; ok: boolean; name?: string; alreadyQueued?: boolean; afterCopy?: CopyAfterCopy; deleteSource?: boolean; code?: string; error?: string };

export const copyRetryTool = defineTool({
  name: "copy_retry",
  title: "重试复制到 OpenList",
  description: `把「复制到 OpenList」队列里失败的、跳过的记录重新排队（id 来自 copy_list，一次最多 ${RETRY_MAX} 个）。**这会让 OpenList 往目标存储里复制文件；记录上 afterCopy 是 delete 的，复制成功后还会删掉网盘上的源文件和本地对应的 strm，archive 的会把源文件挪进任务目录下的「归档」。调用前先告诉用户，得到同意再调用。** 已复制的不用重试；跳过的是目标里已经有同名的，要用户先删掉目标里那份（多半是上次没复制完的残留）再重试，不然还是失败。已经在队列里的算成功，不会再排一次。`,
  scope: "write",
  toolset: "transfer",
  annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  input: z.object({
    ids: z.array(z.string().min(1).max(100)).min(1).max(RETRY_MAX).describe(`要重试的记录 id（copy_list 给的），1 到 ${RETRY_MAX} 个`),
  }),
  async run(args) {
    const ids = [...new Set(args.ids.map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0) throw new ToolError("VALIDATION", "ids 里没有有效的记录 id", "用 copy_list 拿 id。");
    // 一次读、一次写（和界面上的重试同一个口径：copy/service.ts 的 retryBlocker）
    const results = retryCopies(ids).map((r): RetryView =>
      r.ok
        ? { id: r.id, ok: true, name: r.record.name, ...(r.alreadyQueued ? { alreadyQueued: true } : afterCopyFields(r.record.afterCopy)) }
        : { id: r.id, ok: false, code: r.status === 404 ? "COPY_NOT_FOUND" : "NOT_RETRYABLE", error: r.error, ...(r.record ? { name: r.record.name } : {}) },
    );
    const failed = results.filter((r) => !r.ok);
    if (failed.length === results.length) {
      throw new ToolError(String(failed[0].code), String(failed[0].error), "用 copy_list 看这些记录现在的状态。", { results });
    }
    return {
      retried: results.filter((r) => r.ok && !r.alreadyQueued).length,
      results,
      ...(results.some((r) => r.afterCopy && r.afterCopy !== "keep")
        ? { note: [...new Set(results.map((r) => r.afterCopy).filter((a): a is CopyAfterCopy => !!a && a !== "keep"))].map((a) => `afterCopy 是 ${a} 的，${afterCopyNote(a)}`).join("；") + "。" }
        : {}),
      next: "复制在后台跑（大约 30 秒推进一轮），过几分钟用 copy_list(status: \"pending\") 看进度，别连续快速轮询。",
      ...openInUi(COPY_UI),
    };
  },
});

/* ------------------------------- copy_after ------------------------------- */

/** 核对加归档 / 删除都要打网盘接口，一条一两秒；超过这个时间就交给后台作业，用 job_status 等 */
const AFTER_INLINE_WAIT_MS = 40_000;

const AFTER_OUTCOME_TEXT: Record<AfterCopyItemOutcome, string> = {
  archived: "已归档",
  deleted: "已删除",
  retrying: "碰上临时错误，稍后自动再试",
  kept: "没动",
  incomplete: "目标里这一份不全，没动",
  missing: "网盘上没有这条路径",
  scheduled: "还在复制，复制完会处理",
  pending: "还在复制，按记录上的去向",
  invalid: "这条处理不了",
};

/** copy_after 的结果：逐条说下场，外加一句总结和下一步 */
function afterCopyView(r: AfterCopyResult, token: Pick<AgentToken, "toolsets">): Record<string, unknown> {
  const progress = hasToolset(token, "transfer") ? "用 copy_list 看" : "在 OpenStrm 云下载页的「复制到 OpenList」里看";
  const count = (o: AfterCopyItemOutcome) => r.items.filter((i) => i.outcome === o).length;
  const verb = r.afterCopy === "delete" ? "删了" : "归档了";
  const parts = [
    r.done > 0 ? `${verb} ${r.done} 条${r.afterCopy === "delete" ? "（进回收站）" : "（挪进任务目录下的「归档」，本地对应的 strm 已删）"}` : "",
    count("retrying") > 0 ? `${count("retrying")} 条碰上临时错误，复制队列稍后自动再试` : "",
    count("scheduled") > 0 ? `${count("scheduled")} 条还在复制，复制完会${AFTER_COPY_LABEL[r.afterCopy]}` : "",
    count("incomplete") > 0 ? `${count("incomplete")} 条目标里不全，没动` : "",
    count("kept") + count("missing") + count("pending") + count("invalid") > 0 ? `${count("kept") + count("missing") + count("pending") + count("invalid")} 条没动，原因见 items` : "",
  ].filter(Boolean);
  const next = [
    count("incomplete") > 0 ? "目标里不全的先用 copy_add 补齐（会只补缺的），复制完再来一次" : "",
    count("retrying") > 0 || count("scheduled") > 0 ? `稍后${progress}结果（大约 30 秒推进一轮，别连续快速轮询）` : "",
  ].filter(Boolean);
  return {
    ...afterCopyFields(r.afterCopy),
    done: r.done,
    items: r.items.map((i: AfterCopyItem) => ({ ...i, outcomeText: AFTER_OUTCOME_TEXT[i.outcome] })),
    note: parts.length ? `${parts.join("；")}。` : "没有处理任何一条，原因见 items。",
    ...(next.length ? { next: `${next.join("；")}。` } : {}),
    ...openInUi(COPY_UI),
  };
}

export const copyAfterTool = defineTool({
  name: "copy_after",
  title: "事后处理已复制的源文件",
  description: `已经复制到 OpenList 的目录 / 文件，事后把网盘上的源文件归档（挪进任务目录下的「归档」，原来的层级留着，可逆）或删除（进回收站，不可逆，令牌要有「删除」档）——给「复制时去向选的是不动，现在想把网盘上那份收起来」「复制完归档 / 删除当时没成」用。**这会动网盘上的源文件、并删掉本地对应的 strm：调用前把要处理哪些、归档还是删除告诉用户，得到同意再调用。** 指定方式二选一：ids（copy_list 里 canAfterCopy 为 true 的记录 id），或 task + paths（相对任务网盘目录的路径，和 copy_add 同一口径；复制记录只留两天，更早复制的用这种）。动手前逐条核对：源还在原处、目标里这一份齐了（目录逐层比名字、文件比大小），不全的不动（outcome 为 incomplete，先用 copy_add 补齐）。还在复制中的不动源，改成复制完再按这个去向处理（scheduled）。任务正在整理时会拒。一次最多 ${AFTER_MAX} 条；${AFTER_INLINE_WAIT_MS / 1000} 秒内做完直接返回结果，做不完返回 jobId，用 job_status 等（结果保留 ${JOB_RETENTION_MS / 60000} 分钟）。`,
  scope: "write",
  toolset: "transfer",
  annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  input: z.object({
    afterCopy: z.enum(["archive", "delete"]).describe("怎么处理源文件：archive 归档（可逆）/ delete 删除（进回收站，要「删除」档）"),
    ids: z.array(z.string().min(1).max(100)).max(AFTER_MAX).optional().describe(`要处理的复制记录 id（copy_list 给的，canAfterCopy 为 true 的），最多 ${AFTER_MAX} 个；和 task + paths 二选一`),
    task: z.string().min(1).max(500).optional().describe("按路径指定时：哪个任务（任务 id，或网盘路径 / 本地路径 / 它们的最后一段）"),
    paths: z.array(z.string().min(1).max(1000)).max(AFTER_MAX).optional().describe(`按路径指定时：已经复制好的目录 / 文件，相对任务的网盘目录，用 / 分隔，最多 ${AFTER_MAX} 条`),
    dstDir: z.string().max(1000).optional().describe("按路径指定时：当初复制到了哪（OpenList 完整路径），只在当初另选了目的地时填；不填按任务上 / 设置页的目标目录"),
  }),
  async run(args, ctx) {
    const ids = args.ids ?? [];
    const paths = args.paths ?? [];
    if (ids.length === 0 && paths.length === 0) throw new ToolError("VALIDATION", "要给 ids，或者 task + paths", "用 copy_list 拿记录 id；更早复制的用 task + paths 指路径。");
    if (ids.length > 0 && paths.length > 0) throw new ToolError("VALIDATION", "ids 和 task + paths 二选一，别一起给", "分两次调用。");
    if (paths.length > 0 && !args.task?.trim()) throw new ToolError("VALIDATION", "按路径指定要给 task", "用 tasks_list 看有哪些任务。");
    const task = paths.length > 0 ? resolveTask(args.task!) : undefined;
    const label = task ? `${AFTER_COPY_LABEL[args.afterCopy]} ${task.account} · ${task.originPath} 下 ${paths.length} 条的源文件` : `${AFTER_COPY_LABEL[args.afterCopy]} ${ids.length} 条复制记录的源文件`;
    const job = startJob("copy_after", label, async (report) => {
      try {
        // 不传请求的 signal：客户端断开只是不等了，核对和归档照做，办到哪算哪都已经落库
        return await settleAfterCopy({
          afterCopy: args.afterCopy,
          ids,
          task,
          paths,
          dstDir: args.dstDir,
          allowDelete: hasScope(ctx.token, "danger"),
          onProgress: (done, total) => report({ done, total, message: `处理中 ${done}/${total}` }),
        });
      } catch (err) {
        throw afterCopyError(err);
      }
    });
    await waitForJob(job, AFTER_INLINE_WAIT_MS, ctx.signal);
    const view = viewJob(job);
    if (view.status === "running") {
      return {
        state: "running",
        jobId: job.id,
        message: "还在逐条核对、处理源文件（网盘接口一条一两秒）",
        next: `用 job_status(jobId: "${job.id}", waitSeconds: 60) 等结果`,
      };
    }
    if (view.status === "failed") {
      const { error, code, hint, ...extra } = view.failure ?? { error: "处理源文件失败", code: "AFTER_COPY_FAILED" };
      throw new ToolError(code, error, hint, { ...extra, jobId: job.id });
    }
    return { state: "done", jobId: job.id, ...afterCopyView(view.result as AfterCopyResult, ctx.token) };
  },
});

/** 服务层的 HttpError 换成给模型看的说法（和 copy_add 同一套） */
function afterCopyError(err: unknown): unknown {
  if (!(err instanceof HttpError)) return err;
  const code = typeof err.extra.code === "string" ? err.extra.code : undefined;
  if (code === "INSUFFICIENT_SCOPE") {
    return new ToolError(code, "afterCopy: \"delete\"（删掉网盘上的源文件）要令牌有「删除」档", "让用户到设置页给这个令牌勾上「删除」档；或者传 afterCopy: \"archive\"（归档，可逆）。", { required: "danger" });
  }
  if (code === "COPY_NOT_READY") return copyNotReady(err.message.replace(/^没法复制到 OpenList：/, ""));
  if (code === "TASK_ORGANIZING") return new ToolError(code, err.message, "用 organize_status 等这次整理办完再调。", typeof err.extra.runId === "string" ? { runId: err.extra.runId } : {});
  if (code === "COPY_DST_INVALID") return new ToolError(code, err.message, "不填 dstDir 就按任务上 / 设置页的目标目录；要指定就填它们下面的目录。");
  if (code === "VALIDATION") return new ToolError(code, err.message, "用 copy_list 拿记录 id，或用 drive_browse 看任务的网盘目录（路径相对任务目录）。");
  return err;
}
