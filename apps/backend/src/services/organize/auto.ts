/**
 * 自动整理的入口：转存 / 追更 / 云下载 / 网盘监控 / 复制完成发 files.landed 事件（services/events.ts），
 * 这里订阅它，按任务的 organize.mode（off / review / auto）决定要不要建一个 auto 模式的 run。
 *
 *   - 监控的新增事件一条一条来（一部剧转存进来是几十条），按任务攒 30 秒再建 run；其它入口立刻建。
 *   - 任务已有一次整理在进行中（409）就过一分钟再试，路径合并进去。
 *   - 任何失败只记日志：自动整理是锦上添花，不能把转存 / 追更本身搞失败。
 */
import type { OrganizeHint, OrganizeRun, OrganizeTrigger, TaskDefinition } from "@openstrm/shared";
import { readAppSettings } from "../../db/repositories/settings.js";
import { getTask } from "../../db/repositories/tasks.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { events, type FilesLandedEvent } from "../events.js";
import { isStagingDir } from "../strm/staging.js";
import { createRun } from "./run.js";
import { taskAutoMode } from "./settings.js";
import { releaseCopyHolds } from "../copy/queue.js";
import { listRunsByStatus } from "../../db/repositories/organize.js";

const log = moduleLogger("organize-auto");

const DEBOUNCE_MS = 30_000;
const RETRY_MS = 60_000;

interface Pending {
  paths: Set<string>;
  trigger: OrganizeTrigger;
  /** 合并进来的请求里只要有一个要 review，整个 run 就 review */
  mode: "review" | "auto";
  /** 新文件带的识别提示，按文件路径合并 */
  hints: Map<string, OrganizeHint>;
  timer: NodeJS.Timeout;
  /** 等着看建出来的是哪一条的（智能体转存完要把 runId 带回去）：建成回 run，建不成回 null */
  waiters: Array<(run: OrganizeRun | null) => void>;
}

const pending = new Map<string, Pending>();

/** 每个任务最近一次自动建出来的 run 和时间（毫秒）：攒着的已经发出去了，智能体再来问时从这里拿 */
const lastCreated = new Map<string, { run: OrganizeRun; at: number }>();

interface Deps {
  createRun: typeof createRun;
  debounceMs: number;
  retryMs: number;
}

const realDeps: Deps = { createRun, debounceMs: DEBOUNCE_MS, retryMs: RETRY_MS };
let deps: Deps = { ...realDeps };

/** 仅供测试 */
export function setAutoOrganizeDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/** 这次会按哪种方式自动整理：强制给了就按它，不给按任务的设置；没配 TMDB 一律 off（识别不了） */
export function effectiveAutoMode(task: TaskDefinition, forced?: "review" | "auto", settings = readAppSettings()): "off" | "review" | "auto" {
  const mode = forced ?? taskAutoMode(task, settings);
  if (mode === "off" || !settings.tmdb?.apiKey?.trim()) return "off";
  return mode;
}

let subscribed = false;

/** 订阅 files.landed。index.ts 启动时调；要看自动整理的测试在 before 里调。幂等 */
export function startAutoOrganize(): void {
  if (subscribed) return;
  subscribed = true;
  events.on("files.landed", onFilesLanded);
}

function onFilesLanded(input: FilesLandedEvent): void {
  // 重复文件目录、归档目录是暂存区，扫它只会空跑一轮
  const paths = input.paths.map((p) => p.replace(/^\/+|\/+$/g, "")).filter((p) => p && !isStagingDir(p));
  if (paths.length === 0) return;
  const settings = readAppSettings();
  const mode = effectiveAutoMode(input.task, input.mode, settings);
  if (mode === "off") {
    if ((input.mode ?? taskAutoMode(input.task, settings)) !== "off") log.debug({ taskId: input.task.id }, "任务开了自动整理但没配 TMDB，跳过");
    return;
  }
  schedule(input.task.id, paths, input.trigger, mode, input.debounce ? deps.debounceMs : 0, [], input.hints ?? []);
}

function schedule(
  taskId: string,
  paths: string[],
  trigger: OrganizeTrigger,
  mode: "review" | "auto",
  delayMs: number,
  waiters: Pending["waiters"] = [],
  hints: readonly OrganizeHint[] = [],
): void {
  const existing = pending.get(taskId);
  if (existing) {
    for (const p of paths) existing.paths.add(p);
    for (const h of hints) existing.hints.set(h.path, h);
    if (mode === "review") existing.mode = "review";
    existing.waiters.push(...waiters);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => fire(taskId), Math.max(delayMs, 0));
    existing.timer.unref?.();
    return;
  }
  const entry: Pending = { paths: new Set(paths), trigger, mode, hints: new Map(hints.map((h) => [h.path, h])), timer: setTimeout(() => fire(taskId), delayMs), waiters };
  entry.timer.unref?.();
  pending.set(taskId, entry);
}

async function fire(taskId: string): Promise<void> {
  const entry = pending.get(taskId);
  if (!entry) return;
  pending.delete(taskId);
  const task = getTask(taskId);
  if (!task) return;
  const paths = [...entry.paths];
  const hints = [...entry.hints.values()];
  try {
    const run = await deps.createRun({ taskId, paths, mode: entry.mode, trigger: entry.trigger, ...(hints.length ? { hints } : {}) });
    log.info({ taskId, runId: run.id, paths: paths.length, trigger: entry.trigger, mode: entry.mode }, "自动整理已建 run");
    lastCreated.set(taskId, { run, at: Date.now() });
    for (const w of entry.waiters) w(run);
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      log.debug({ taskId }, "任务有整理在进行中，一分钟后再试");
      schedule(taskId, paths, entry.trigger, entry.mode, deps.retryMs, entry.waiters, hints);
      return;
    }
    log.warn({ err, taskId }, "自动整理建 run 失败");
    for (const w of entry.waiters) w(null);
    // 整理起不来（识别词有语法错误之类）：为等它而压着的复制不用干等兜底时间
    releaseCopyHolds(taskId, Date.now());
  }
}

/**
 * 这个任务眼下有没有会直接在网盘上改名挪文件的自动整理：攒着还没建出来的，或者建出来了、正在预览 / 执行的
 * 「把握大的直接执行」那种。智能体补登记复制时看它：有就先压着，等整理改完名再复制
 */
export function autoOrganizeBusy(taskId: string): boolean {
  if (pending.get(taskId)?.mode === "auto") return true;
  return listRunsByStatus(["planning", "applying"]).some((r) => r.taskId === taskId && r.mode === "auto");
}

/**
 * 智能体转存完想把整理清单带回去：这个任务有攒着的自动整理，就等它建出来（建成回 run，建不成回 null；
 * 任务上有整理在进行、一分钟后才重试的，会等很久，调用方自己限时）；since（毫秒）之后已经建过，直接回那一条；都没有是 undefined
 */
export function autoOrganizeFor(taskId: string, since: number): Promise<OrganizeRun | null> | undefined {
  const entry = pending.get(taskId);
  if (entry) return new Promise((resolve) => entry.waiters.push(resolve));
  const last = lastCreated.get(taskId);
  return last && last.at >= since ? Promise.resolve(last.run) : undefined;
}

/**
 * 仅供测试：立刻把攒着的都发出去。按开始时的那一批来：遇到 409 的会重新排进 pending，
 * 边遍历边往 Map 里加会一直转下去
 */
export async function __test_flushAutoOrganize(): Promise<void> {
  for (const taskId of [...pending.keys()]) {
    const entry = pending.get(taskId);
    if (!entry) continue;
    clearTimeout(entry.timer);
    await fire(taskId);
  }
}

export function __test_resetAutoOrganize(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  lastCreated.clear();
}
