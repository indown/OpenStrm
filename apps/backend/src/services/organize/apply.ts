/**
 * 执行：按顺序补本地镜像 → mkdir → 改名 → 移动 → 本地镜像 → 逐条记账 → 删空目录 → 收尾；放弃失败项让 run 收口。
 */
import type { OrganizeItem, OrganizeRun, OrganizeSkipResult, OrganizeUnit, TaskDefinition } from "@openstrm/shared";
import { bumpAttempts, getRun, listItems, listRunsByStatus, listUnits, recallMatch, rememberMatch, repathMatches, updateItem, updateItems, updateRun } from "../../db/repositories/organize.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { getTask } from "../../db/repositories/tasks.js";
import { isAbortError } from "../../lib/errors.js";
import { HttpError } from "../../lib/http-error.js";
import { providerForTask } from "../drive/registry.js";
import { isTaskRunning } from "../task/registry.js";
import { normalizePath, splitPath, type DriveProvider, type WriteNode } from "../drive/types.js";
import { learnFollowOrganized, rewriteFollowSubPaths } from "../follow/service.js";
import { scheduleEmbyRefresh } from "../media-server.js";
import { rewriteOfflineSubPaths } from "../offline/service.js";
import { rewriteCopyPaths } from "../copy/queue.js";
import { describeFileFailure } from "../download/failure.js";
import { classifyFailure, FAILURE_LABEL, messageOf, OrganizeFailure, retryableItem, revertWorkItem, StaleError } from "./failures.js";
import { mirrorDelete, mirrorRelocate, mirrorRmdir } from "../strm/mirror.js";
import { copyLayout, log, deps, type Job, jobs, beginOp, assertNoOps, jobLog, setProgress, baseOf, dirOf, absOf, relOf, computeStats, startJob, planStates, WORK_ACTIONS, activeItemFilter, intermediateOf, releaseHeldCopies, applicability, failureGroups, dirMappings, movedFiles, accountTasks } from "./run-state.js";
import { type DirEntryRef, type ListCtx, type ExecCtx, listCtx, noteRenamed, noteRemoved, noteMoved, dirIdOf, namesIn, nodeOf, occupied, clashError, withRetry } from "./exec-ctx.js";
import { organizedVideos } from "./hints.js";
import { parseRules } from "./rules.js";
import { resolveOrganizeSettings } from "./settings.js";

async function execute(job: Job, runId: string, only: Set<string> | null): Promise<void> {
  const run = getRun(runId)!;
  const task = getTask(run.taskId);
  if (!task) throw new Error("任务已不存在");
  const provider = providerForTask(task, "write");
  const write = provider.write!;
  const settings = readAppSettings();
  const signal = job.abort.signal;
  const ctx: ExecCtx = { ...listCtx(provider, signal), job, task, settings, tasks: accountTasks(provider.account.name) };
  const active = activeItemFilter(runId);
  // 不给 ids：没做的 + 上次临时失败的（风控 / 网络抖动）再来，stale / rejected 的不碰；给了 ids：只做点名的这些
  const wanted = (it: OrganizeItem) => active(it) && (only ? only.has(it.id) && retryableItem(it, true) : retryableItem(it));
  const all = listItems(runId).filter(wanted);
  const redoMirror = all.filter((it) => it.status === "done");
  const pending = all.filter((it) => it.status !== "done");
  // 上次失败 / 跳过的先归零；attempts 记「这一项被执行了几轮」（界面「已试 N 轮」），执行中的自动重试不算一轮
  updateItems(pending.filter((it) => it.status !== "pending").map((it) => it.id), { status: "pending", error: "", errorKind: "" });
  bumpAttempts(all.map((it) => it.id));
  jobLog(job, `开始执行：${pending.length} 项${redoMirror.length > 0 ? `，补做本地镜像 ${redoMirror.length} 项` : ""}`);
  const now = () => Math.floor(Date.now() / 1000);
  const total = pending.length + redoMirror.length;
  let done = 0;
  let fatal: string | null = null;
  const fail = (it: OrganizeItem, err: unknown) => {
    const kind = classifyFailure(provider, err);
    const msg = messageOf(err);
    updateItem(it.id, { status: "failed", error: msg, errorKind: kind });
    jobLog(job, `失败 ${it.action} ${it.srcPath}：${msg}（${FAILURE_LABEL[kind]}）`);
    if (kind === "blocked") fatal = `网盘拒绝了请求（${msg}），整理已停下，稍后再继续`;
  };
  /** 网盘上动完之后同步本地；失败不影响网盘那边已经完成的事实，记成 mirror 类失败（监控见到就不跳过这条事件，让它把本地补回来；「重试」只补本地） */
  const mirror = async (oldPath: string, newPath: string, isDir: boolean, oldPathAlt?: string): Promise<string> => {
    try {
      await mirrorRelocate({ oldPath, newPath, isDir, oldPathAlt }, { tasks: ctx.tasks, settings });
      return "";
    } catch (err) {
      const msg = `本地镜像失败：${describeFileFailure(err, { relPath: relOf(task, newPath), kind: "strm", context: "mirror" })}`;
      jobLog(job, `${msg}（${newPath}）`);
      return msg;
    }
  };
  const finishItem = async (it: OrganizeItem, nodeId: string, isDir: boolean) => {
    // 跨目录且改了名的项在源目录里有过一个中间名字：本地文件可能已经被监控按它改过名
    const error = await mirror(it.srcPath, it.dstPath, isDir, intermediateOf(it));
    updateItem(it.id, { status: "done", nodeId, finishedAt: now(), curPath: "", error, errorKind: error ? "mirror" : "" });
    done++;
  };

  // 0. 上次网盘成功、本地没跟上的：只补本地，不碰网盘（网盘被风控时也能先把本地补上）
  for (const it of redoMirror) {
    if (signal.aborted) break;
    setProgress(job, "apply", done, total, `补本地镜像 ${it.dstPath}`);
    const error = await mirror(it.srcPath, it.dstPath, it.kind === "dir", intermediateOf(it));
    updateItem(it.id, { error, errorKind: error ? "mirror" : "" });
    if (!error) done++;
  }

  // 1. mkdir（按深度）。目录已经在（上次执行建过、别人建的）就直接复用
  for (const it of pending.filter((i) => i.action === "mkdir")) {
    if (fatal || signal.aborted) break;
    setProgress(job, "apply", done, total, `建目录 ${it.dstPath}`);
    try {
      await withRetry(ctx, async () => {
        const existing = await ctx.provider.resolvePath(it.dstPath, signal);
        if (existing?.isDir) {
          ctx.dirIds.set(it.dstPath, existing.id);
          updateItem(it.id, { status: "done", nodeId: existing.id, finishedAt: now(), error: "", errorKind: "" });
          done++;
          return;
        }
        const parent = normalizePath(splitPath(it.dstPath).slice(0, -1).join("/"));
        const pid = await dirIdOf(ctx, parent);
        const node = await write.mkdir({ id: pid, path: parent }, baseOf(it.dstPath), signal);
        ctx.dirIds.set(it.dstPath, node.id);
        ctx.listings.delete(parent);
        // 刚建的目录肯定是空的：撞名检查不用再列一遍（115 刚建的目录列出来也可能滞后）
        ctx.listings.set(it.dstPath, new Map());
        updateItem(it.id, { status: "done", nodeId: node.id, finishedAt: now(), error: "", errorKind: "" });
        done++;
      });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      fail(it, err);
    }
  }

  // 1b. 删除：只有冲突上明确选了「删掉这一份」/「覆盖」的项（人在整理页选的，或者智能体改清单时选的；执行都要人点头或者删除档）。
  //     放在改名 / 移动之前，覆盖才腾得出位置。
  //     动手前按目录清单核对名字和 id：预览之后位置上换了别的文件就不删（stale）。删掉的撤销退不回来
  const deletes = pending.filter((i) => i.action === "delete");
  for (const it of deletes) {
    if (fatal || signal.aborted) break;
    setProgress(job, "apply", done, total, `删除 ${it.srcPath}`);
    try {
      await withRetry(ctx, async () => {
        const dir = dirOf(it.srcPath);
        const name = baseOf(it.srcPath);
        const hit = (await namesIn(ctx, dir)).get(name);
        if (!hit) {
          // 已经不在了（上次执行删过、或者别人删了）：当做完，别再报错
          updateItem(it.id, { status: "done", finishedAt: now(), error: "网盘上已经没有这个文件", errorKind: "" });
          done++;
          return;
        }
        if (it.nodeId && hit.id !== it.nodeId) throw new StaleError(`预览之后 ${it.srcPath} 换成了另一个文件，没有删`);
        await write.remove({ id: hit.id, path: it.srcPath, isDir: hit.isDir }, signal);
        noteRemoved(ctx, dir, name);
        jobLog(job, `删除 ${it.srcPath}`);
        let error = "";
        try {
          await mirrorDelete(it.srcPath, { tasks: ctx.tasks, settings });
        } catch (err) {
          error = `本地文件没删掉：${messageOf(err)}`;
          jobLog(job, `${error}（${it.srcPath}）`);
        }
        updateItem(it.id, { status: "done", nodeId: hit.id, finishedAt: now(), error, errorKind: error ? "mirror" : "" });
        done++;
      });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      fail(it, err);
    }
  }

  // 2. 改名 / 移动：先原地改名（同目录内一批），再按目标目录分组移动。
  //    移动项改完名还没挪走时把当前路径记进 cur_path：中途断了续跑 / 撤销都靠它
  const files = pending.filter((i) => i.action === "rename" || i.action === "move");
  const current = new Map<string, string>(files.map((i) => [i.id, i.curPath || i.srcPath]));
  const nodeIds = new Map<string, string>();
  const isDirNode = new Map<string, boolean>();
  const failed = new Set<string>();

  // 2a. 解析 id
  for (const it of files) {
    if (fatal || signal.aborted) break;
    try {
      const n = await withRetry(ctx, () => nodeOf(ctx, current.get(it.id)!, it.nodeId));
      nodeIds.set(it.id, n.id);
      isDirNode.set(it.id, n.isDir);
      if (!it.nodeId) updateItem(it.id, { nodeId: n.id });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      failed.add(it.id);
      fail(it, err);
    }
  }

  // 2b. 改名（已经改过名、只差挪走的跳过）
  const renames = files.filter((it) => !failed.has(it.id) && baseOf(current.get(it.id)!) !== baseOf(it.dstPath));
  const renameBatches = new Map<string, OrganizeItem[]>();
  for (const it of renames) {
    const list = renameBatches.get(it.unitKey) ?? [];
    list.push(it);
    renameBatches.set(it.unitKey, list);
  }
  /** 本轮自己的项现在的节点：占着名字的是它们就不算别人 */
  const ourNodes = () => new Set([...nodeIds.values()]);
  for (const wholeBatch of renameBatches.values()) {
    if (fatal || signal.aborted) break;
    setProgress(job, "apply", done, total, `改名 ${baseOf(wholeBatch[0].srcPath)} 等 ${wholeBatch.length} 项`);
    const settle = async (it: OrganizeItem, newId: string) => {
      const prev = current.get(it.id)!;
      const next = `${dirOf(prev)}/${baseOf(it.dstPath)}`;
      current.set(it.id, next);
      nodeIds.set(it.id, newId);
      noteRenamed(ctx, dirOf(next), baseOf(prev), baseOf(next), { id: newId, isDir: isDirNode.get(it.id) ?? false });
      if (it.action === "rename") await finishItem(it, newId, isDirNode.get(it.id) ?? false);
      else updateItem(it.id, { curPath: next, nodeId: newId });
    };
    // 源目录里现在有没有和新名字撞的（预览之后别人放进来的）。新名字已经在自己的节点上（上次改了没记账）就只记账；
    // 被本轮别的项占着（连环改名：E02→E01、E03→E02）就等那一项先改；别人的就是撞名
    const ready: OrganizeItem[] = [];
    const waitFor = new Map<string, string>();
    const ours = ourNodes();
    for (const it of wholeBatch) {
      try {
        const names = await withRetry(ctx, () => namesIn(ctx, dirOf(current.get(it.id)!)));
        const hit = names.get(baseOf(it.dstPath));
        if (hit && hit.id === nodeIds.get(it.id)) {
          await settle(it, hit.id);
          continue;
        }
        if (hit && ours.has(hit.id)) {
          const owner = wholeBatch.find((o) => nodeIds.get(o.id) === hit.id);
          if (!owner) throw clashError("源目录里", baseOf(it.dstPath));
          waitFor.set(it.id, owner.id);
        } else if (hit) throw clashError("源目录里", baseOf(it.dstPath));
        ready.push(it);
      } catch (err) {
        if (isAbortError(err) || signal.aborted) throw err;
        failed.add(it.id);
        fail(it, err);
      }
    }
    // 按依赖排序：占着我目标名的那一项先改；转圈互占的（A↔B 互换）改不了
    const batch: OrganizeItem[] = [];
    const left = new Set(ready.map((it) => it.id));
    while (left.size > 0) {
      const round = ready.filter((it) => left.has(it.id) && (!waitFor.has(it.id) || !left.has(waitFor.get(it.id)!)));
      if (round.length === 0) {
        for (const it of ready.filter((i) => left.has(i.id))) {
          failed.add(it.id);
          fail(it, new OrganizeFailure("rejected", new Error(`和本轮别的文件互相占着名字，改不动 ${baseOf(it.dstPath)}`)));
        }
        break;
      }
      for (const it of round) {
        left.delete(it.id);
        // 给我腾名字的那一项没改成（撞了别人的）：名字还被它占着，改过去要么被拒、要么 115 悄悄变成 xxx(1)，不能碰
        const owner = waitFor.get(it.id);
        if (owner && failed.has(owner)) {
          failed.add(it.id);
          fail(it, new OrganizeFailure("rejected", new Error(`占着 ${baseOf(it.dstPath)} 的那一项没改成，这一项改不了`)));
          continue;
        }
        batch.push(it);
      }
    }
    if (batch.length === 0) continue;
    const nodes = batch.map((it) => ({ node: { id: nodeIds.get(it.id)!, path: current.get(it.id)!, isDir: isDirNode.get(it.id) ?? false } satisfies WriteNode, newName: baseOf(it.dstPath) }));
    const oneByOne = async () => {
      for (const [i, it] of batch.entries()) {
        if (fatal || signal.aborted) break;
        try {
          // 前面的项改到一半失败了名字就还占着：动手前再看一眼本轮的目录缓存（改成的都记在里面），占着就是撞名
          const owner = waitFor.get(it.id);
          if (owner && failed.has(owner)) throw new OrganizeFailure("rejected", new Error(`占着 ${baseOf(it.dstPath)} 的那一项没改成，这一项改不了`));
          if (occupied(await namesIn(ctx, dirOf(current.get(it.id)!)), nodes[i].newName, nodes[i].node.id)) throw clashError("源目录里", nodes[i].newName);
          const r = await withRetry(ctx, () => write.rename(nodes[i].node, nodes[i].newName, signal));
          await settle(it, r.id);
        } catch (err) {
          if (isAbortError(err) || signal.aborted) throw err;
          failed.add(it.id);
          fail(it, err);
        }
      }
    };
    // 连环改名一定要按顺序一个个来（批量接口不保证顺序）
    if (!write.renameMany || nodes.length === 1 || waitFor.size > 0) {
      await oneByOne();
      continue;
    }
    try {
      const ids = await withRetry(ctx, () => write.renameMany!(nodes, signal));
      for (const [i, it] of batch.entries()) await settle(it, ids[i]?.id ?? nodeIds.get(it.id)!);
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      if (classifyFailure(provider, err) === "blocked") {
        for (const it of batch) {
          failed.add(it.id);
          fail(it, err);
        }
      } else {
        // 一批里有一个改不了会把整批拖失败：逐个再试一遍，把失败定位到那一项
        jobLog(job, `批量改名失败（${messageOf(err)}），改为逐个改名`);
        await oneByOne();
      }
    }
  }

  // 2c. 移动：按目标目录分组
  const moves = files.filter((it) => !failed.has(it.id) && it.action === "move");
  const moveBatches = new Map<string, OrganizeItem[]>();
  for (const it of moves) {
    const to = dirOf(it.dstPath);
    const list = moveBatches.get(to) ?? [];
    list.push(it);
    moveBatches.set(to, list);
  }
  // 目标目录里现在有没有同名的（预览之后别人放进来的）：有就不挪，115 会悄悄改成 xxx(1)。
  // 名字在自己的节点上（上次挪过去没记账）只记账；被本轮别的项占着（它要挪走）就等所有批次跑完再来一遍
  let deferred = new Map<string, OrganizeItem[]>();
  const runMoveBatches = async (batches: Map<string, OrganizeItem[]>, allowDefer: boolean) => {
    for (const [to, wholeBatch] of batches) {
      if (fatal || signal.aborted) break;
      setProgress(job, "apply", done, total, `移动 ${wholeBatch.length} 项到 ${to}`);
      const nodeOfItem = (it: OrganizeItem): WriteNode => ({ id: nodeIds.get(it.id)!, path: current.get(it.id)!, isDir: isDirNode.get(it.id) ?? false });
      const settleMoved = async (it: OrganizeItem, newId: string) => {
        const from = current.get(it.id)!;
        noteMoved(ctx, dirOf(from), to, baseOf(from), { id: newId, isDir: isDirNode.get(it.id) ?? false });
        await finishItem(it, newId, isDirNode.get(it.id) ?? false);
      };
      let toId: string;
      let names: Map<string, DirEntryRef>;
      try {
        toId = await withRetry(ctx, () => dirIdOf(ctx, to));
        names = await withRetry(ctx, () => namesIn(ctx, to));
      } catch (err) {
        if (isAbortError(err) || signal.aborted) throw err;
        for (const it of wholeBatch) fail(it, err);
        continue;
      }
      const ours = ourNodes();
      const batch: OrganizeItem[] = [];
      for (const it of wholeBatch) {
        const name = baseOf(it.dstPath);
        const hit = names.get(name);
        if (hit && hit.id === nodeIds.get(it.id)) {
          await settleMoved(it, hit.id);
          continue;
        }
        if (hit && ours.has(hit.id) && allowDefer) {
          const list = deferred.get(to) ?? [];
          list.push(it);
          deferred.set(to, list);
          continue;
        }
        if (hit) {
          fail(it, clashError("目标目录里", name));
          continue;
        }
        batch.push(it);
      }
      if (batch.length === 0) continue;
      try {
        const ids = await withRetry(ctx, () => write.move(batch.map(nodeOfItem), { id: toId, path: to }, signal));
        for (const [i, it] of batch.entries()) await settleMoved(it, ids[i]?.id ?? nodeIds.get(it.id)!);
      } catch (err) {
        if (isAbortError(err) || signal.aborted) throw err;
        if (batch.length === 1 || classifyFailure(provider, err) === "blocked") {
          for (const it of batch) fail(it, err);
          continue;
        }
        // 一批里有一个挪不动会把整批拖失败：逐个再试一遍，把失败定位到那一项
        jobLog(job, `批量移动到 ${to} 失败（${messageOf(err)}），改为逐个移动`);
        for (const it of batch) {
          if (fatal || signal.aborted) break;
          try {
            const [moved] = await withRetry(ctx, () => write.move([nodeOfItem(it)], { id: toId, path: to }, signal));
            await settleMoved(it, moved?.id ?? nodeIds.get(it.id)!);
          } catch (err2) {
            if (isAbortError(err2) || signal.aborted) throw err2;
            fail(it, err2);
          }
        }
      }
    }
  };
  // 三个以上串成链（X 要去的名字被 Y 占着，Y 要去的又被 Z 占着）按目标目录的批次顺序一遍未必解得开：有进展就再来一遍，
  // 一遍下来一个都没挪成就是转圈互占，最后一遍不再等、按撞名记
  let pendingMoves = moveBatches;
  const sizeOf = (m: Map<string, OrganizeItem[]>) => [...m.values()].reduce((n, l) => n + l.length, 0);
  while (pendingMoves.size > 0 && !fatal && !signal.aborted) {
    const before = sizeOf(pendingMoves);
    deferred = new Map();
    await runMoveBatches(pendingMoves, true);
    const left = sizeOf(deferred);
    if (left === 0) break;
    if (left === before) {
      const stuck = deferred;
      deferred = new Map();
      await runMoveBatches(stuck, false);
      break;
    }
    pendingMoves = deferred;
  }

  // 3. 删空目录（从深到浅）。目录已经不在了算 stale（不用再试）；不是空的记成临时（下次重试再看一眼）
  for (const it of pending.filter((i) => i.action === "rmdir")) {
    if (fatal || signal.aborted) break;
    setProgress(job, "apply", done, total, `清理空目录 ${it.srcPath}`);
    try {
      await withRetry(ctx, async () => {
        const node = it.nodeId ? { id: it.nodeId, isDir: true } : await ctx.provider.resolvePath(it.srcPath, signal);
        if (!node) {
          updateItem(it.id, { status: "skipped", error: "目录已不存在", errorKind: "stale" });
          return;
        }
        const removed = await write.rmdirIfEmpty({ id: node.id, path: it.srcPath, isDir: true }, signal);
        if (removed) {
          updateItem(it.id, { status: "done", nodeId: node.id, finishedAt: now(), error: "", errorKind: "" });
          done++;
          await mirrorRmdir(it.srcPath, { tasks: ctx.tasks, settings });
        } else updateItem(it.id, { status: "skipped", error: provider.kind === "115" ? "目录不是空的（115 的目录信息有几分钟缓存，刚挪走的可能还显示在里面）" : "目录不是空的", errorKind: "transient" });
      });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      fail(it, err);
    }
  }

  // 4. 收尾
  finishApply(job, runId, { fatal, aborted: signal.aborted });
}

/**
 * 执行的收尾：统计、日志和状态、追更 / 云下载目录改写 + 识别记忆 + Emby 刷新、通知。
 * 取消也走这里（取消多半发生在网盘请求中途，异常从 execute 里抛出来，由 startJob 接住后调它）：
 * 做完的项照样记进统计、收尾照常，只是不发通知
 */
function finishApply(job: Job, runId: string, outcome: { fatal: string | null; aborted: boolean }): void {
  const run = getRun(runId);
  const task = run ? getTask(run.taskId) : null;
  if (!run || !task) return;
  const units = listUnits(runId);
  const items = listItems(runId);
  const stats = computeStats(units, items, "apply");
  const finishedAt = Math.floor(Date.now() / 1000);
  // 收尾这句先进日志再落库，不然页面上的日志里没有它
  if (outcome.fatal) {
    jobLog(job, outcome.fatal);
    updateRun(runId, { status: "failed", error: outcome.fatal, stats, log: job.logs, finishedAt });
  } else if (outcome.aborted) {
    jobLog(job, `已取消：${stats.done} 项完成${stats.pending > 0 ? `，${stats.pending} 项还没做` : ""}${stats.failed > 0 ? `，${stats.failed} 项失败` : ""}`);
    updateRun(runId, { status: "cancelled", error: "已取消", stats, log: job.logs, finishedAt });
  } else {
    jobLog(job, `执行完成：${stats.done} 项完成，${stats.failed} 项失败${stats.failedByKind.mirror > 0 ? `，${stats.failedByKind.mirror} 项本地未同步` : ""}`);
    updateRun(runId, { status: "done", stats, log: job.logs, finishedAt });
  }
  const moved = items.filter((it) => it.status === "done" && (it.action === "rename" || it.action === "move")).length;
  if (moved > 0) {
    afterApply(task, providerForTask(task, "write"), units, items);
    scheduleEmbyRefresh();
  }
  // 路径已经改写好了，等这次整理的复制可以走了（没挪成的照原路径复制）
  releaseHeldCopies(run);
  // 执行过就不能再改单元了，预览留在内存里的单元结构可以放掉
  if (moved > 0 || !outcome.fatal) planStates.delete(runId);
  if (!outcome.aborted) {
    void deps.notify({ type: "organize-done", task, runId, units: stats.units, done: stats.done, failed: stats.failed, failedByKind: stats.failedByKind, notReverted: 0 });
  }
}

/**
 * 收尾：追更记下整理结果、追更 / 云下载回执的目录改写、识别记忆（先把旧记忆挪到新路径，再写这次确认的，新的才不会被旧的盖掉）。
 * 追更按整理前的路径对快照，要在改写追更落点之前
 */
export function afterApply(task: TaskDefinition, provider: DriveProvider, units: OrganizeUnit[], items: OrganizeItem[]): void {
  const removedDirs = new Set(items.filter((it) => it.action === "rmdir" && it.status === "done").map((it) => relOf(task, it.srcPath)));
  const mappings = dirMappings(task, units, items, removedDirs);
  const runId = units[0]?.runId ?? items[0]?.runId;
  if (runId) learnFollowOrganized(task.id, runId, organizedVideos(task, units, items, parseRules(resolveOrganizeSettings(readAppSettings()).rules).rules));
  for (const m of mappings) if (m.root) repathMatches(provider.account.name, absOf(task, m.from), absOf(task, m.to));
  for (const u of units) {
    if (!u.match || !u.dstRoot || !u.remember) continue;
    const srcPath = absOf(task, u.dstRoot);
    // 记住的季 / 集偏移只补空、不在单元上（preview.ts 的 memoryFill）：这次没改的，同一部作品原来记着的留着
    const prev = recallMatch(provider.account.name, srcPath);
    const kept = prev && prev.tmdbId === u.match.tmdbId && prev.mediaType === u.match.mediaType ? prev : null;
    rememberMatch({
      accountName: provider.account.name,
      srcPath,
      mediaType: u.match.mediaType,
      tmdbId: u.match.tmdbId,
      title: u.match.title,
      year: u.match.year,
      season: u.seasonOverride ?? kept?.season ?? null,
      episodeOffset: u.episodeOffset || kept?.episodeOffset || 0,
    });
  }
  // 复制队列按文件跟：整理最常见的是「一集挪进作品目录、顺手改名」，所在目录没腾空，目录级映射里没有它
  const fileMoves = movedFiles(task, items, "done");
  if (mappings.length === 0 && fileMoves.length === 0) return;
  const rewritten =
    (mappings.length > 0 ? rewriteFollowSubPaths(task.id, mappings).length + rewriteOfflineSubPaths(task.id, mappings).length : 0) +
    rewriteCopyPaths(task.id, task.originPath, mappings, false, copyLayout, fileMoves, removedDirs).length;
  if (rewritten > 0) log.info({ taskId: task.id, rewritten }, "整理后改写了追更 / 云下载回执 / 复制队列里的路径");
}

export async function applyRun(runId: string, ids?: string[]): Promise<OrganizeRun> {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (jobs.has(runId)) throw new HttpError(409, "这次整理正在进行中");
  // 待确认的清单整份执行（人点头的、planVersion 钉着的都是整份）：只挑几项执行会把别的项留成「没做完」，
  // 之后一个「重试」就连带执行了——比如令牌挑开删除项先执行别的，把删除留给不知情的人重试。ids 只给重试用
  if (run.status === "ready" && ids) throw new HttpError(400, "待确认的清单要整份执行；不想动的项先取消勾选", { code: "IDS_ON_READY" });
  assertNoOps(runId);
  const can = applicability(run, ids);
  if (!can.ok) throw new HttpError(409, can.reason ?? "不能执行");
  const busy = listRunsByStatus(["applying", "reverting", "planning"]).find((r) => r.taskId === run.taskId);
  if (busy) throw new HttpError(409, `任务已有一次整理在进行中（${busy.id}）`, { runId: busy.id });
  // 按本地结构的清单是照本地 strm 算的：同步正跑着会把改过名的 strm 当多余删掉，等它结束
  if (run.naming === "local" && isTaskRunning(run.taskId)) throw new HttpError(409, "任务正在同步，等它结束再执行按本地结构的整理", { code: "TASK_SYNCING" });
  updateRun(runId, { status: "applying", error: "", startedAt: run.startedAt ?? Math.floor(Date.now() / 1000), finishedAt: null });
  startJob(
    runId,
    (job) => execute(job, runId, ids ? new Set(ids) : null),
    (job) => finishApply(job, runId, { fatal: null, aborted: true }),
  );
  return getRun(runId)!;
}

/* ------------------------------- 放弃 ------------------------------- */

/**
 * 把失败项标成「已放弃」，让 run 收口。原则：放弃 = 用一步把文件放回干净位置，没有这一步的只能重试。
 *   - 执行失败、文件还在原处：直接放弃
 *   - 执行时原地改了名还没挪走：先在网盘上改回原名，成功才放弃
 *   - 网盘成功、本地没跟上：放弃就是不再补本地（状态照旧），可用全量同步 / 体检补齐
 *   - 撤销失败、文件还在整理后的位置：放弃撤销，文件留在那里
 *   - 撤销时挪回来了还没改回原名：不给放弃（改回原名就是失败的那一步），只能继续撤销
 *   - 放弃建目录项时，连带放弃要进这个目录的项（不然它们下次重试全变 stale）
 */
export async function skipItems(runId: string, ids: string[]): Promise<OrganizeSkipResult> {
  // 放弃要在网盘上改回原名（有 await）：这期间不许执行 / 撤销 / 删除，也不许再来一次放弃
  assertNoOps(runId);
  const end = beginOp(runId);
  try {
    return await giveUpItems(runId, ids);
  } finally {
    end();
  }
}

async function giveUpItems(runId: string, ids: string[]): Promise<OrganizeSkipResult> {
  const run = getRun(runId);
  if (!run) throw new HttpError(404, "整理记录不存在");
  if (jobs.has(runId)) throw new HttpError(409, "这次整理正在进行中");
  if (!["done", "failed", "cancelled", "reverted"].includes(run.status)) throw new HttpError(409, `当前状态（${run.status}）没有可以放弃的项；待执行的整理用勾选来排除`);
  const task = getTask(run.taskId);
  if (!task) throw new HttpError(404, "任务已不存在");
  const all = listItems(runId);
  const wanted = new Set(ids);
  // 放弃建目录项时连带要进这个目录的项：按祖先目录查，不用 n × m 比前缀
  const givenDirs = new Set(all.filter((it) => wanted.has(it.id) && it.action === "mkdir" && it.status === "failed").map((it) => it.dstPath));
  if (givenDirs.size > 0) {
    for (const child of all) {
      if (!(child.action === "rename" || child.action === "move") || !(child.status === "pending" || child.status === "failed")) continue;
      for (let dir = dirOf(child.dstPath); dir; dir = dirOf(dir)) {
        if (givenDirs.has(dir)) {
          wanted.add(child.id);
          break;
        }
      }
    }
  }
  const result: OrganizeSkipResult = { skipped: 0, renamedBack: 0, refused: [] };
  const now = () => Math.floor(Date.now() / 1000);
  let ctx: ListCtx | null = null;
  const give = (it: OrganizeItem, error: string, extra: Partial<Pick<OrganizeItem, "errorKind">> = {}) => {
    updateItem(it.id, { status: "skipped", error, curPath: "", finishedAt: now(), givenUp: true, ...extra });
    result.skipped++;
  };
  const refuse = (it: OrganizeItem, reason: string) => result.refused.push({ id: it.id, reason });
  for (const it of all) {
    if (!wanted.has(it.id) || it.givenUp) {
      if (wanted.has(it.id)) refuse(it, "已经放弃过了");
      continue;
    }
    const isFile = it.action === "rename" || it.action === "move";
    if (it.curPath && it.status !== "done") {
      // 执行时原地改了名还没挪走的（不管现在是哪个阶段）：先在网盘上改回原名，网盘上才是干净的
      ctx ??= listCtx(providerForTask(task, "write"), new AbortController().signal);
      try {
        const names = await namesIn(ctx, dirOf(it.curPath));
        const node = names.get(baseOf(it.curPath));
        if (!node) {
          give(it, `已放弃：文件已不在改名后的位置（${it.error}）`, { errorKind: "stale" });
          continue;
        }
        // 原名已经被别的文件占了就改不回去（网盘要么拒绝要么加 (1)），留给用户处理
        if (occupied(names, baseOf(it.srcPath), node.id)) throw clashError("原位置", baseOf(it.srcPath));
        await ctx.provider.write!.rename({ id: node.id, path: it.curPath, isDir: node.isDir }, baseOf(it.srcPath), ctx.signal);
        noteRenamed(ctx, dirOf(it.curPath), baseOf(it.curPath), baseOf(it.srcPath), node);
        result.renamedBack++;
        give(it, `已放弃：${it.error || "改回了原名"}`);
      } catch (err) {
        if (isAbortError(err)) throw err;
        const kind = classifyFailure(ctx.provider, err);
        updateItem(it.id, { error: `改回原名失败：${messageOf(err)}`, errorKind: kind });
        refuse(it, `改回原名失败：${messageOf(err)}`);
      }
      continue;
    }
    if (run.stage === "apply" && (it.status === "failed" || (it.status === "pending" && WORK_ACTIONS.has(it.action)))) {
      give(it, it.status === "failed" ? `已放弃：${it.error}` : "已放弃：没有执行");
      continue;
    }
    if (it.errorKind === "mirror" && (it.status === "done" || it.status === "reverted")) {
      // 网盘那步是对的，状态和类别都不变（监控见到自有事件仍会把本地补回来）；只是不再当失败项提醒
      updateItem(it.id, { error: `已放弃：本地未同步，可用全量同步或体检补齐（${it.error}）`, givenUp: true });
      result.skipped++;
      continue;
    }
    if (run.stage === "revert" && isFile) {
      if (it.status === "done" && it.errorKind) {
        if (it.curPath) {
          refuse(it, "已挪回但还没改回原名，只能继续撤销");
          continue;
        }
        // 文件留在整理后的位置：done 就是在那里，状态不变，只标放弃
        updateItem(it.id, { error: `已放弃撤销，文件留在整理后的位置（${it.error}）`, givenUp: true });
        result.skipped++;
        continue;
      }
      if (it.status === "failed") {
        give(it, `已放弃：${it.error}`);
        continue;
      }
    }
    refuse(it, "这一项没有需要放弃的失败");
  }
  // 放弃之后没剩下要人处理的（本地没跟上的除外，执行本来就不因它算失败）：中断的 run 收口成 done / reverted。
  // 不能只看默认重试集是不是空的：stale / rejected 的失败项不在默认重试集里，它们还在就不算收口
  const items = listItems(runId);
  const units = listUnits(runId);
  const stats = computeStats(units, items, run.stage);
  let status = run.status;
  if (run.stage === "apply" && (run.status === "failed" || run.status === "cancelled") && failureGroups(run, items, units).every((g) => g.key === "mirror")) status = "done";
  if (run.stage === "revert" && (run.status === "failed" || run.status === "cancelled") && !items.some((it) => revertWorkItem(it))) status = "reverted";
  updateRun(runId, { stats, status, ...(status !== run.status ? { error: "" } : {}) });
  return result;
}
