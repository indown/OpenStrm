/**
 * 撤销：按流水账逆序退回（连环改名先解依赖），收尾把追更 / 云下载 / 复制里记的路径改回去。
 */
import type { OrganizeItem, OrganizeRun, OrganizeUnit, TaskDefinition } from "@openstrm/shared";
import { bumpAttempts, getRun, listItems, listLeftoverDirs, listRunsByStatus, listUnits, repathMatches, updateItem, updateRun } from "../../db/repositories/organize.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { getTask } from "../../db/repositories/tasks.js";
import { isAbortError } from "../../lib/errors.js";
import { HttpError } from "../../lib/http-error.js";
import { providerForTask } from "../drive/registry.js";
import { normalizePath, splitPath, type DriveProvider, type WriteNode } from "../drive/types.js";
import { revertFollowOrganized, rewriteFollowSubPaths } from "../follow/service.js";
import { scheduleEmbyRefresh } from "../media-server.js";
import { rewriteOfflineSubPaths } from "../offline/service.js";
import { rewriteCopyPaths } from "../copy/queue.js";
import { describeFileFailure } from "../download/failure.js";
import { classifyFailure, FAILURE_LABEL, messageOf, OrganizeFailure, revertWorkItem } from "./failures.js";
import { mirrorRelocate, mirrorRmdir } from "../strm/mirror.js";
import { copyLayout, deps, type Job, jobs, assertNoOps, jobLog, setProgress, baseOf, dirOf, absOf, relOf, computeStats, startJob, planStates, intermediateOf, revertability, dirMappings, movedFiles, accountTasks } from "./run-state.js";
import { type DirEntryRef, type ExecCtx, noteRenamed, noteMoved, namesIn, occupied, clashError, withRetry, listCtx } from "./exec-ctx.js";

/**
 * 撤销时文件项的先后：A 的原名现在被本轮还没退回的 B 占着（同一个原目录里，B 现在的名字就是 A 的原名）就等 B 先退。
 * 连环改名（集偏移）正着做是 E03→E04 先改，倒回来得 E01←E02 先退，不然 E02←E03 退回时会撞上自己人；
 * 跨目录挪回时 B 是先顶着现在的名字挪回来（中间名）再改回原名，规则一样。A 挪回来的中间名撞上还在原目录里的 B 也等 B。
 * 转圈互占的（A↔B 互换）退不了，单列出来记 rejected。目录项位置不动（删空目录要在文件退回之后）
 */
function orderRevert(items: OrganizeItem[]): { ordered: OrganizeItem[]; stuck: OrganizeItem[] } {
  const isFile = (it: OrganizeItem) => (it.action === "rename" || it.action === "move") && it.status !== "reverted";
  const files = items.filter(isFile);
  if (files.length < 2) return { ordered: items, stuck: [] };
  const home = (it: OrganizeItem) => dirOf(it.srcPath);
  const nowName = (it: OrganizeItem) => baseOf(it.curPath || it.dstPath);
  const inHome = (it: OrganizeItem) => it.curPath !== "" || dirOf(it.dstPath) === home(it);
  // 原目录 + 现在的名字 → 项：查「谁占着我的原名」不用每项扫一遍全表（一次整理可以有几千项）
  const holders = new Map<string, OrganizeItem[]>();
  for (const it of files) {
    const key = `${home(it)}/${nowName(it)}`;
    holders.set(key, [...(holders.get(key) ?? []), it]);
  }
  const left = new Set(files.map((it) => it.id));
  const heldBy = (dir: string, name: string, a: OrganizeItem, extra?: (b: OrganizeItem) => boolean) => (holders.get(`${dir}/${name}`) ?? []).some((b) => b.id !== a.id && left.has(b.id) && (!extra || extra(b)));
  const waits = (a: OrganizeItem) => heldBy(home(a), baseOf(a.srcPath), a) || (!inHome(a) && heldBy(home(a), nowName(a), a, inHome));
  const ordered: OrganizeItem[] = [];
  while (left.size > 0) {
    const round = files.filter((a) => left.has(a.id) && !waits(a));
    if (round.length === 0) break;
    for (const it of round) {
      ordered.push(it);
      left.delete(it.id);
    }
  }
  let i = 0;
  return { ordered: items.filter((it) => !isFile(it) || !left.has(it.id)).map((it) => (isFile(it) ? ordered[i++] : it)), stuck: files.filter((it) => left.has(it.id)) };
}

/**
 * 按流水账逆序退回（文件项之间再按 orderRevert 排先后）。状态只描述文件在哪：网盘那步失败的项保持 done（文件还在整理后的位置 / 中间位置），
 * 只记原因，下次撤销自然包含；文件已经不在整理后的位置 / 被别的文件占了的记成 failed + stale（不再归整理管，可以放弃）。
 * move 项先挪回再改名，挪回之后把中间位置记进 cur_path，改名失败下次只改名
 */
async function revert(job: Job, runId: string): Promise<void> {
  const run = getRun(runId)!;
  const task = getTask(run.taskId);
  if (!task) throw new Error("任务已不存在");
  const provider = providerForTask(task, "write");
  const write = provider.write!;
  const settings = readAppSettings();
  const signal = job.abort.signal;
  const ctx: ExecCtx = { ...listCtx(provider, signal), job, task, settings, tasks: accountTasks(provider.account.name) };
  const { ordered: items, stuck } = orderRevert(listItems(runId).filter((it) => revertWorkItem(it, true)).reverse());
  const now = () => Math.floor(Date.now() / 1000);
  let n = 0;
  let fatal: string | null = null;
  bumpAttempts([...items, ...stuck].map((it) => it.id));
  jobLog(job, `开始撤销：${items.length + stuck.length} 项`);
  // 冲突上选了删除 / 覆盖的项已经进了网盘回收站，这里退不回来，只说一声
  const deleted = listItems(runId).filter((it) => it.action === "delete" && it.status === "done").length;
  if (deleted > 0) jobLog(job, `其中 ${deleted} 项是删掉的文件，退不回来（在网盘回收站里找）`);

  const failRevert = (it: OrganizeItem, err: unknown) => {
    const kind = classifyFailure(provider, err);
    const msg = messageOf(err);
    // 撤销侧的结果都是新账：放弃过本地镜像的项这次在网盘上没退回，要重新当失败项提醒
    updateItem(it.id, { error: msg, errorKind: kind, givenUp: false });
    jobLog(job, `撤销失败 ${it.dstPath}：${msg}（${FAILURE_LABEL[kind]}）`);
    if (kind === "blocked") fatal = `网盘拒绝了请求（${msg}），撤销已停下`;
  };
  for (const it of stuck) failRevert(it, new OrganizeFailure("rejected", new Error(`和本轮别的文件互相占着名字，退不回 ${baseOf(it.srcPath)}`)));
  const lost = (it: OrganizeItem, msg: string) => {
    updateItem(it.id, { status: "failed", error: msg, errorKind: "stale", curPath: "", finishedAt: now(), givenUp: false });
    jobLog(job, `${msg}：${it.dstPath}`);
  };
  /** 撤销侧的本地镜像：文件可能还在 `源目录/新名字`（先挪回再改名的窗口里监控动了本地） */
  const mirrorBack = async (it: OrganizeItem, alt?: string): Promise<string> => {
    try {
      await mirrorRelocate({ oldPath: it.dstPath, newPath: it.srcPath, isDir: false, oldPathAlt: alt ?? intermediateOf(it) }, { tasks: ctx.tasks, settings });
      return "";
    } catch (err) {
      const msg = `本地镜像失败：${describeFileFailure(err, { relPath: relOf(task, it.srcPath), kind: "strm", context: "mirror" })}`;
      jobLog(job, `${msg}（${it.srcPath}）`);
      return msg;
    }
  };
  const ensureDir = async (abs: string): Promise<string> => {
    const hit = ctx.dirIds.get(abs);
    if (hit) return hit;
    const node = await ctx.provider.resolvePath(abs, signal);
    if (node?.isDir) {
      ctx.dirIds.set(abs, node.id);
      return node.id;
    }
    const parent = normalizePath(splitPath(abs).slice(0, -1).join("/"));
    const pid = await ensureDir(parent);
    const made = await write.mkdir({ id: pid, path: parent }, baseOf(abs), signal);
    ctx.dirIds.set(abs, made.id);
    return made.id;
  };
  const renameBack = async (it: OrganizeItem, at: string): Promise<boolean> => {
    if (!at) return false;
    const node = await withRetry(ctx, () => ctx.provider.resolvePath(at, signal));
    if (!node) return false;
    // 原名已经被别的文件占了：网盘要么拒绝要么自己加 (1)，都不是退回
    const names = await withRetry(ctx, () => namesIn(ctx, dirOf(at)));
    if (occupied(names, baseOf(it.srcPath), node.id)) throw clashError("原位置", baseOf(it.srcPath));
    await withRetry(ctx, () => write.rename({ id: node.id, path: at, isDir: node.isDir }, baseOf(it.srcPath), signal));
    noteRenamed(ctx, dirOf(at), baseOf(at), baseOf(it.srcPath), node);
    return true;
  };

  for (const it of items) {
    if (fatal || signal.aborted) break;
    setProgress(job, "revert", n, items.length, `退回 ${it.dstPath}`);
    try {
      if (it.status === "reverted") {
        // 已经退回了、只是本地没跟上：补本地
        const error = await mirrorBack(it);
        updateItem(it.id, { error, errorKind: error ? "mirror" : "" });
        if (!error) n++;
        continue;
      }
      if (it.curPath && it.status !== "done") {
        // 执行时只改了名还没挪走的（pending / failed 带 curPath）：改回去就行，本地没动过
        if (!(await renameBack(it, it.curPath))) {
          lost(it, "文件已不在改名后的位置");
          continue;
        }
        updateItem(it.id, { status: "reverted", finishedAt: now(), curPath: "", error: "", errorKind: "" });
        n++;
        continue;
      }
      if (it.action === "rename" || it.action === "move") {
        if (it.curPath) {
          // 上次撤销挪回来了、还没改回原名
          if (!(await renameBack(it, it.curPath))) {
            lost(it, "文件已不在挪回的位置");
            continue;
          }
          const error = await mirrorBack(it, it.curPath);
          updateItem(it.id, { status: "reverted", finishedAt: now(), curPath: "", error, errorKind: error ? "mirror" : "", givenUp: false });
          n++;
          continue;
        }
        // 整理后的目录列一次（本轮缓存、绕过网盘客户端的缓存），比每个文件 resolvePath 一次省；目录本身没了文件当然也没了
        let node: DirEntryRef | undefined;
        try {
          node = (await withRetry(ctx, () => namesIn(ctx, dirOf(it.dstPath)))).get(baseOf(it.dstPath));
        } catch (err) {
          if (!(err instanceof OrganizeFailure && err.kind === "stale")) throw err;
        }
        if (!node) {
          lost(it, "文件已不在整理后的位置");
          continue;
        }
        if (it.nodeId && node.id !== it.nodeId && provider.kind !== "openlist") {
          lost(it, "整理后的位置上已经是另一个文件");
          continue;
        }
        let cur: WriteNode = { id: node.id, path: it.dstPath, isDir: node.isDir };
        const needRename = baseOf(it.dstPath) !== baseOf(it.srcPath);
        const crossDir = dirOf(it.dstPath) !== dirOf(it.srcPath);
        const home = dirOf(it.srcPath);
        const toId = crossDir ? await withRetry(ctx, () => ensureDir(home)) : "";
        // 原位置又有了同名文件（现在的名字或原名）：网盘要么拒绝要么自己加 (1)，都不是退回，先看一眼
        const names = await withRetry(ctx, () => namesIn(ctx, home));
        const clash = (crossDir ? [baseOf(it.dstPath), baseOf(it.srcPath)] : [baseOf(it.srcPath)]).find((n) => occupied(names, n, node.id));
        if (clash) throw clashError("原位置", clash);
        if (crossDir) {
          const [moved] = await withRetry(ctx, () => write.move([cur], { id: toId, path: home }, signal));
          cur = { id: moved.id, path: `${home}/${baseOf(it.dstPath)}`, isDir: cur.isDir };
          noteMoved(ctx, dirOf(it.dstPath), home, baseOf(it.dstPath), { id: moved.id, isDir: cur.isDir });
          // 挪回来了、还没改回原名：记住中间位置，改名失败下次只改名
          if (needRename) updateItem(it.id, { curPath: cur.path, nodeId: moved.id });
        }
        if (needRename) {
          await withRetry(ctx, () => write.rename(cur, baseOf(it.srcPath), signal));
          noteRenamed(ctx, home, baseOf(it.dstPath), baseOf(it.srcPath), { id: cur.id, isDir: cur.isDir });
        }
        const error = await mirrorBack(it);
        updateItem(it.id, { status: "reverted", finishedAt: now(), curPath: "", error, errorKind: error ? "mirror" : "", givenUp: false });
        n++;
      } else if (it.action === "mkdir") {
        // 建过的目录（done，或上一轮因为不空留下的 skipped）：空了就删
        const node = await withRetry(ctx, () => ctx.provider.resolvePath(it.dstPath, signal));
        if (node?.isDir && (await withRetry(ctx, () => write.rmdirIfEmpty({ id: node.id, path: it.dstPath, isDir: true }, signal)))) {
          await mirrorRmdir(it.dstPath, { tasks: ctx.tasks, settings });
          updateItem(it.id, { status: "reverted", finishedAt: now(), error: "", errorKind: "" });
          n++;
        } else updateItem(it.id, { status: "skipped", error: node ? "目录不是空的，留着" : "目录已不存在", errorKind: "" });
      } else if (it.action === "rmdir") {
        // 目录会在挪回文件时按需重建，这里不用做什么
        updateItem(it.id, { status: "reverted", finishedAt: now(), error: "", errorKind: "" });
      }
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      failRevert(it, err);
    }
  }

  if (!fatal && !signal.aborted) await sweepLeftoverDirs(job, ctx, run, runId);

  // n 是这一轮做成的，只用来决定刷不刷 Emby
  finishRevert(job, runId, { fatal, aborted: signal.aborted, refresh: n > 0 });
}

/**
 * 撤销放宽之后可以先撤前面的整理：它建的目录当时装着后面这次放进去的文件，只能留着（skipped「目录不是空的，留着」），
 * 前面那次也就撤完了、没有再撤的机会。后面这次撤销把文件挪走以后，这些目录空了就顺手删掉，前面那次的记账跟着改成已退回；
 * 还有别的东西（用户自己放的）就接着留着
 */
async function sweepLeftoverDirs(job: Job, ctx: ExecCtx, run: OrganizeRun, runId: string): Promise<void> {
  const dirs = new Set<string>();
  for (const it of listItems(runId)) {
    if (it.status !== "reverted" || (it.action !== "rename" && it.action !== "move")) continue;
    for (let d = dirOf(it.dstPath); splitPath(d).length > 0; d = dirOf(d)) dirs.add(d);
  }
  const left = listLeftoverDirs(run.taskId, runId, [...dirs]).sort((a, b) => b.dstPath.length - a.dstPath.length);
  if (left.length === 0) return;
  const write = ctx.provider.write!;
  const signal = job.abort.signal;
  const touched = new Set<string>();
  for (const it of left) {
    try {
      const node = await withRetry(ctx, () => ctx.provider.resolvePath(it.dstPath, signal));
      if (!node?.isDir || !(await withRetry(ctx, () => write.rmdirIfEmpty({ id: node.id, path: it.dstPath, isDir: true }, signal)))) continue;
      await mirrorRmdir(it.dstPath, { tasks: ctx.tasks, settings: ctx.settings });
      updateItem(it.id, { status: "reverted", finishedAt: Math.floor(Date.now() / 1000), error: "", errorKind: "" });
      touched.add(it.runId);
      jobLog(job, `前面整理留下的空目录一起删了：${it.dstPath}`);
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      jobLog(job, `前面整理留下的目录没删掉 ${it.dstPath}：${messageOf(err)}`);
    }
  }
  for (const id of touched) updateRun(id, { stats: computeStats(listUnits(id), listItems(id), "revert") });
}

/**
 * 撤销的收尾：追更 / 云下载目录和识别记忆改回去、统计、日志和状态、Emby 刷新、通知。取消也走这里（见 finishApply）。
 * 「退回了几项」和执行时的「项完成」同一个口径：累计、建目录 / 删目录也算
 */
function finishRevert(job: Job, runId: string, outcome: { fatal: string | null; aborted: boolean; refresh: boolean }): void {
  const run = getRun(runId);
  const task = run ? getTask(run.taskId) : null;
  if (!run || !task) return;
  const units = listUnits(runId);
  const items = listItems(runId);
  afterRevert(task, providerForTask(task, "write"), units, items);
  const stats = computeStats(units, items, "revert");
  const left = stats.notReverted > 0 ? `，${stats.notReverted} 项没退回` : "";
  const status = outcome.fatal ? "failed" : outcome.aborted ? "cancelled" : "reverted";
  jobLog(job, outcome.fatal ?? (outcome.aborted ? `已取消：退回 ${stats.reverted} 项${left}` : `撤销完成：退回 ${stats.reverted} 项${left}`));
  updateRun(runId, { status, error: outcome.fatal ?? (outcome.aborted ? "已取消" : ""), stats, log: job.logs, finishedAt: Math.floor(Date.now() / 1000) });
  planStates.delete(runId);
  if (outcome.refresh) scheduleEmbyRefresh();
  if (!outcome.aborted) {
    void deps.notify({ type: "organize-done", task, runId, units: stats.units, done: stats.reverted, failed: stats.failed, reverted: true, failedByKind: stats.failedByKind, notReverted: stats.notReverted });
  }
}

/** 撤销的收尾：腾空过的源目录退回来了，追更 / 云下载回执的目录和识别记忆也改回去；追更这次记下的整理结果退回上一版 */
export function afterRevert(task: TaskDefinition, provider: DriveProvider, units: OrganizeUnit[], items: OrganizeItem[]): void {
  // 一个视频都没退回（撤销被取消、在网盘上失败）：文件还在整理后的位置，追更照旧沿用
  const runId = units[0]?.runId ?? items[0]?.runId;
  if (runId && items.some((it) => it.kind === "video" && it.status === "reverted")) revertFollowOrganized(task.id, runId);
  // 只认执行时真删了、撤销时退回了的源目录：删目录那条没成（目录没空、失败了）的，源目录一直在，没有落点从它挪走过
  const removedDirs = new Set(items.filter((it) => it.action === "rmdir" && it.status === "reverted").map((it) => relOf(task, it.srcPath)));
  // 只认这次新建、撤销时又删掉了的目标目录：原来就有（或者撤销后还留着东西）的目录，别的追更本来就可能指着它，不能拽回来——单元根那条也一样
  const created = new Set(items.filter((it) => it.action === "mkdir" && it.status === "reverted").map((it) => relOf(task, it.dstPath)));
  const back = dirMappings(task, units, items, removedDirs)
    .filter((m) => created.has(m.to))
    // 这条映射下一个文件都没退回（撤销被取消、在网盘上失败、已经找不到）：源目录还不在，追更 / 云下载继续指着作品目录
    .filter((m) => m.items.some((it) => it.status === "reverted"))
    .map((m) => ({ from: m.to, to: m.from, root: m.root }))
    .sort((a, b) => b.from.length - a.from.length);
  const fileMoves = movedFiles(task, items, "reverted");
  if (back.length === 0 && fileMoves.length === 0) return;
  if (back.length > 0) {
    rewriteFollowSubPaths(task.id, back);
    rewriteOfflineSubPaths(task.id, back);
  }
  rewriteCopyPaths(task.id, task.originPath, back, false, copyLayout, fileMoves);
  for (const m of back) if (m.root) repathMatches(provider.account.name, absOf(task, m.from), absOf(task, m.to));
}

export async function revertRun(runId: string): Promise<OrganizeRun> {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (jobs.has(runId)) throw new HttpError(409, "这次整理正在进行中");
  assertNoOps(runId);
  const ok = revertability(run);
  if (!ok.ok) throw new HttpError(409, ok.reason ?? "不能撤销");
  const busy = listRunsByStatus(["applying", "reverting", "planning"]).find((r) => r.taskId === run.taskId);
  if (busy) throw new HttpError(409, `任务已有一次整理在进行中（${busy.id}）`, { runId: busy.id });
  updateRun(runId, { status: "reverting", stage: "revert", error: "", finishedAt: null });
  startJob(
    runId,
    (job) => revert(job, runId),
    (job) => finishRevert(job, runId, { fatal: null, aborted: true, refresh: true }),
  );
  return getRun(runId)!;
}
