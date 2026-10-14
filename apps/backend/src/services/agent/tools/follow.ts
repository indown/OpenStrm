/**
 * 追更工具集：列订阅、立即检查、改（间隔 / 暂停 / 恢复 / 改名 / 不再沿用整理结果）、删。
 * 订阅由 share_save(follow: true) 建；这里是之后的管理，和界面上的「追更」页一样。
 *
 * 引用订阅可以用 id 或名字（名字重复时报错并列出候选）。分享链接里的提取码不回给模型：用不着，也不该到处传。
 */
import { z } from "zod";
import type { ShareFollowOrganized, ShareFollowRun, ShareFollowStatus, ShareFollowSummary } from "@openstrm/shared";
import { getShareFollow } from "../../../db/repositories/share-follows.js";
import { getTask } from "../../../db/repositories/tasks.js";
import { FOLLOW, checkFollow, deleteFollow, listFollows, updateFollow } from "../../follow/service.js";
import { effectiveAutoMode } from "../../organize/auto.js";
import { LOCAL_READ, ToolError, confirmFirst, defineTool } from "../define.js";
import { fmtTime, openInUi, shareLinkWithoutPassword } from "../format.js";
import { JOB_RETENTION_MS, jobSnapshot, startJob, viewJob, waitWithProgress } from "../jobs.js";
import { resolveTask, taskBrief } from "../resolve.js";
import { MAX_WAIT_SECONDS } from "./core.js";
import { organizeHandoff } from "./transfer.js";
import { copyOutcomeView } from "./copy.js";

const STATUS_TEXT: Record<ShareFollowStatus, string> = {
  idle: "正常",
  checking: "检查中",
  error: "出错",
  expired: "分享已失效，已停",
  stale: "很久没更新，已自动暂停",
};

const runView = (r: ShareFollowRun) => ({
  at: fmtTime(r.at),
  added: r.added.length,
  ...(r.added.length ? { addedSample: r.added.slice(0, 5) } : {}),
  ...(r.skipped.length ? { skipped: r.skipped.slice(0, 5) } : {}),
  ...(r.generated ? { strmGenerated: r.generated } : {}),
  ...(r.error ? { error: r.error } : {}),
});

/** 整理沿用：新文件交给整理时照着认的作品、季、集偏移 */
const organizedView = (o: ShareFollowOrganized) => ({
  ...(o.dir ? { shareDir: o.dir } : {}),
  work: `${o.title}${o.year ? ` (${o.year})` : ""}`,
  tmdbId: o.tmdbId,
  ...(o.season !== null ? { season: o.season } : o.seasonFallback !== null ? { seasonIfMissing: o.seasonFallback } : {}),
  ...(o.episodeOffset ? { episodeOffset: o.episodeOffset } : {}),
});

function followView(f: ShareFollowSummary, detail = false) {
  const task = getTask(f.taskId);
  return {
    id: f.id,
    name: f.name,
    task: task ? taskBrief(task).label : `（已删除的任务 ${f.taskId}）`,
    ...(f.subPath ? { subPath: f.subPath } : {}),
    ...(f.watchPath ? { watchPath: f.watchPath } : {}),
    enabled: f.enabled,
    status: f.status,
    statusText: STATUS_TEXT[f.status],
    intervalMinutes: f.intervalMinutes,
    lastChecked: fmtTime(f.lastCheckedAt),
    ...(f.enabled ? { nextCheck: fmtTime(f.nextCheckAt) } : {}),
    lastUpdate: fmtTime(f.lastChangeAt),
    ...(f.lastError ? { lastError: f.lastError } : {}),
    ...(f.errorStreak ? { errorStreak: f.errorStreak } : {}),
    known: f.knownCount,
    ...(detail ? { link: shareLinkWithoutPassword(f.shareUrl) } : {}),
    ...(f.recent.length ? { recent: f.recent.slice(0, detail ? 5 : 2).map(runView) } : {}),
    ...(f.organized.length ? { organized: f.organized.map(organizedView) } : {}),
  };
}

/** 订阅：id 精确匹配，其次名字完全相同，再其次名字包含；多个就报错列候选 */
function resolveFollow(ref: string): ShareFollowSummary {
  const q = ref.trim();
  if (!q) throw new ToolError("VALIDATION", "follow 不能为空", "用 follow_list 看有哪些订阅。");
  const all = listFollows().follows;
  const byId = all.find((f) => f.id === q);
  if (byId) return byId;
  const lower = q.toLowerCase();
  for (const match of [(f: ShareFollowSummary) => f.name.toLowerCase() === lower, (f: ShareFollowSummary) => f.name.toLowerCase().includes(lower)]) {
    const hits = all.filter(match);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new ToolError("AMBIGUOUS_FOLLOW", `「${q}」能对上 ${hits.length} 个订阅`, "用候选里的 id 再调一次。", {
        candidates: hits.slice(0, 10).map((f) => ({ id: f.id, name: f.name })),
      });
    }
  }
  throw new ToolError("FOLLOW_NOT_FOUND", `没有找到追更订阅「${q}」`, "用 follow_list 看有哪些订阅，传 id 最稳。");
}

const followArg = z.string().min(1).max(300).describe("订阅的 id（follow_list 给的），或它的名字");

const LIST_DEFAULT = 20;
const LIST_MAX = 50;

export const followListTool = defineTool({
  name: "follow_list",
  title: "追更订阅",
  description: `列出追更订阅：盯住一个网盘分享里的目录，定时把新增的文件转存到某个同步任务并生成 strm。每条带状态（正常 / 出错 / 分享失效 / 很久没更新自动暂停）、检查间隔、上次检查和上次有更新的时间、最近几次有动静的检查；整理过的带 organized：分享里各目录的新文件交给整理时照着认的作品、季（season 强制，seasonIfMissing 只给没写季的文件）、集偏移。可按名字或任务过滤、只看出了问题的；默认 ${LIST_DEFAULT} 条，最多 ${LIST_MAX} 条。给了 follow 就只看这一条的详情。`,
  scope: "read",
  toolset: "follow",
  annotations: LOCAL_READ,
  input: z.object({
    follow: z.string().max(300).optional().describe("只看这一条：订阅的 id 或名字"),
    query: z.string().max(200).optional().describe("按名字过滤（包含即可）"),
    task: z.string().max(500).optional().describe("只看转存到这个任务的：任务 id，或网盘路径 / 本地路径 / 它们的最后一段"),
    problems: z.boolean().optional().describe("只看出了问题的（出错、分享失效、自动暂停），默认 false"),
    limit: z.number().int().min(1).max(LIST_MAX).optional().describe(`最多几条，1 到 ${LIST_MAX}，默认 ${LIST_DEFAULT}`),
  }),
  async run(args) {
    if (args.follow?.trim()) return { follow: followView(resolveFollow(args.follow), true), ...openInUi("/follow") };
    const { follows, watcher } = listFollows();
    const task = args.task?.trim() ? resolveTask(args.task) : undefined;
    const q = args.query?.trim().toLowerCase() ?? "";
    const rows = follows.filter(
      (f) =>
        (!q || f.name.toLowerCase().includes(q)) &&
        (!task || f.taskId === task.id) &&
        (!args.problems || f.status === "error" || f.status === "expired" || f.status === "stale"),
    );
    const limit = args.limit ?? LIST_DEFAULT;
    return {
      follows: rows.slice(0, limit).map((f) => followView(f)),
      total: rows.length,
      ...(rows.length > limit ? { truncated: `只列了前 ${limit} 条，用 query / task 缩小范围。` } : {}),
      watcher: { running: watcher.running, ...(watcher.lastError ? { lastError: watcher.lastError } : {}) },
      ...openInUi("/follow"),
    };
  },
});

/** 立即检查等多久：做完就直接给结果，做不完转成作业 */
const CHECK_INLINE_WAIT_MS = 40_000;

export const followCheckTool = defineTool({
  name: "follow_check",
  title: "追更立即检查",
  description: `立刻检查一条追更订阅：列分享目录，有新增就照订阅转存到任务目录并生成 strm（和定时检查做的一样）。**有新增时会往网盘里转存，调用前先告诉用户，得到同意再调用。** 暂停着的订阅不检查：要先用 follow_update 恢复。任务开了自动整理的，新增会交给整理，结果里带整理清单的 runId。任务开了「复制到 OpenList」的，新增会排进复制队列（结果里的 copy）；其中设了「复制后删除 / 归档」的（tasks_list 里 copyToOpenlist.afterCopy），复制成功后会删掉网盘上的源文件、或把它挪进任务目录下的「归档」，要事先告诉用户。${CHECK_INLINE_WAIT_MS / 1000} 秒内做完就直接返回结果，做不完返回 jobId，用 job_status 等（结果保留 ${JOB_RETENTION_MS / 60000} 分钟）。这条订阅正在检查时直接返回当前状态。`,
  scope: "write",
  toolset: "follow",
  annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  input: z.object({ follow: followArg }),
  async run(args, ctx) {
    const f = resolveFollow(args.follow);
    if (f.status === "checking") return { state: "checking", message: "这条订阅正在检查，稍后用 follow_list 看结果。", follow: followView(f) };
    // 暂停就是用户不想让它转存了：检查会照样把新增转存进网盘，得先恢复（follow_update，同样要先征得同意）
    if (!f.enabled) throw new ToolError("FOLLOW_PAUSED", "这条订阅暂停着，检查会把新增转存进网盘", "要检查先用 follow_update 恢复它（先征得用户同意）。");
    const job = startJob("follow_check", `检查追更「${f.name}」`, async (report) => {
      report({ message: "列分享目录" });
      const since = Date.now();
      const r = await checkFollow(f.id);
      const added = r.run?.added.length ?? 0;
      const task = getTask(r.follow.taskId);
      const mode = task && added > 0 ? effectiveAutoMode(task) : "off";
      const organize = task && mode !== "off" ? await organizeHandoff(task, since, mode, ctx.token) : undefined;
      return {
        follow: followView(r.follow),
        ...(r.run ? { run: runView(r.run) } : { message: "没有新增。" }),
        ...(organize ? { organize } : {}),
        ...(r.copy ? { copy: copyOutcomeView(r.copy, ctx.token) } : {}),
      };
    });
    await waitWithProgress(job.settled, CHECK_INLINE_WAIT_MS, ctx, () => jobSnapshot(job));
    const view = viewJob(job);
    if (view.status === "running") {
      return { state: "running", jobId: job.id, message: "还在检查（分享目录大、或者有新增在转存）", next: `用 job_status(jobId: "${job.id}", waitSeconds: ${MAX_WAIT_SECONDS}) 等结果` };
    }
    if (view.status === "failed") {
      const { error, code, hint, ...extra } = view.failure ?? { error: "检查失败", code: "CHECK_FAILED" };
      throw new ToolError(code, error, hint, { ...extra, jobId: job.id });
    }
    return { state: "done", jobId: job.id, ...(view.result as object) };
  },
});

export const followUpdateTool = defineTool({
  name: "follow_update",
  title: "修改追更",
  description: `改一条追更订阅：暂停 / 恢复（enabled）、检查间隔（分钟，${FOLLOW.MIN_INTERVAL_MIN} 到 ${FOLLOW.MAX_INTERVAL_MIN}）、名字、不再沿用整理结果（clearOrganized：新文件交给整理时重新识别，沿用的作品 / 季认错了时用）。恢复一条出错、失效或自动暂停的订阅会清掉错误、尽快检查一次。**这会改订阅的设置，调用前先把要改什么告诉用户，得到同意再调用。**`,
  scope: "write",
  toolset: "follow",
  annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
  input: z.object({
    follow: followArg,
    enabled: z.boolean().optional().describe("false 暂停、true 恢复"),
    intervalMinutes: z.number().int().min(FOLLOW.MIN_INTERVAL_MIN).max(FOLLOW.MAX_INTERVAL_MIN).optional().describe(`检查间隔（分钟），${FOLLOW.MIN_INTERVAL_MIN} 到 ${FOLLOW.MAX_INTERVAL_MIN}`),
    name: z.string().min(1).max(200).optional().describe("新名字"),
    clearOrganized: z.literal(true).optional().describe("true：不再沿用整理结果，新文件交给整理时重新识别"),
  }),
  async run(args) {
    if (args.enabled === undefined && args.intervalMinutes === undefined && args.name === undefined && !args.clearOrganized) {
      throw new ToolError("VALIDATION", "enabled、intervalMinutes、name、clearOrganized 至少给一个");
    }
    const f = resolveFollow(args.follow);
    const updated = updateFollow(f.id, {
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      ...(args.intervalMinutes !== undefined ? { intervalMinutes: args.intervalMinutes } : {}),
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.clearOrganized ? { clearOrganized: true } : {}),
    });
    return { follow: followView(updated) };
  },
});

export const followDeleteTool = defineTool({
  name: "follow_delete",
  title: "删除追更",
  description:
    "删除一条追更订阅：之后分享里的新增不会再自动转存。已经转存进网盘的文件和生成的 strm 都不受影响。只是暂时不想追的话用 follow_update 暂停就行。**调用前先告诉用户要删哪一条，得到同意再调用。**",
  scope: "danger",
  toolset: "follow",
  annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
  input: z.object({ follow: followArg }),
  async run(args, ctx) {
    const f = resolveFollow(args.follow);
    // 确认框里不放订阅名：默认就是分享标题（别人起的）。说清是哪天建的、转存到哪个任务
    const task = getTask(f.taskId);
    confirmFirst(
      ctx,
      `删除一条追更订阅（${fmtTime(f.createdAt * 1000)} 建的，转存到「${task ? taskBrief(task).label : f.taskId}」${f.subPath ? "下的一个子目录" : ""}，已经追到 ${f.knownCount} 个条目）：之后分享里的新增不会再自动转存；已经转存的文件和 strm 不受影响。`,
    );
    // 等确认的这段时间里可能已经被删了
    if (!getShareFollow(f.id)) return { deleted: false, message: "这条订阅已经不在了。" };
    deleteFollow(f.id);
    return { deleted: true, follow: { id: f.id, name: f.name } };
  },
});
