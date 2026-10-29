/**
 * 清理归档：看任务目录下的「归档」（暂存区）里有什么，把不要了的从网盘上删掉。
 * 归档只进不出的话（复制后归档、copy_after、drive_archive 三条路都往里挪），腾空间就只能到网盘里手动删。
 * 界面 strm 管理页的「清理归档」、智能体的 drive_archive_clean、REST 的 GET /api/drive/archive 和 POST /api/drive/archive/clean 都走这里。
 *
 * 规矩：
 *   - 只列归档目录的一层：里面原来的层级就是作品 / 目录名，一层正好是人认得的粒度；要删更深的用 paths 指；
 *   - paths 相对归档目录（写成「归档/xxx」也认：drive_browse 给的是相对任务目录的路径，归档里不会再套一层「归档」，剥掉没有歧义）；
 *     all 是归档目录现在这一层的全部条目；两个都给、都不给都拒；
 *   - 删除走 Provider 的 remove：115 / 夸克进回收站，OpenList 看存储后端。不可逆，所以界面要红字确认、智能体要「删除」档；
 *   - 不删「归档」目录本身（空壳留着，下次归档直接用）；不看复制队列（记录只是历史）；不拒整理中（整理不碰暂存区）；
 *   - 本地没有对应的 strm（暂存区不镜像），不用动本地。
 * 两个阶段同 archive.ts：先只看不改（网盘读不到，整个请求都不动），再逐条删；碰上网络问题就停手，后面的不试、照实说。
 */
import type { TaskDefinition } from "@openstrm/shared";
import { messageOf, networkErrorText } from "../../lib/errors.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { providerForAccount } from "../drive/registry.js";
import type { DriveEntry } from "../drive/types.js";
import { normalizeRel } from "../strm/manage.js";
import { ARCHIVE_DIR } from "../strm/staging.js";
import { Lookups } from "./after.js";
import { MANUAL_PATHS_MAX } from "./manual.js";
import { baseName, joinPath, normDir } from "./paths.js";
import { resetArchiveDirCache, transientAfterCopyError } from "./service.js";

const log = moduleLogger("copy-archive-clean");

/** 一次最多删多少条（和归档、手动复制同一上限） */
export const CLEAN_MAX = MANUAL_PATHS_MAX;

export interface ArchiveListItem {
  /** 相对归档目录（一层就是名字本身） */
  path: string;
  name: string;
  isDir: boolean;
  size?: number;
  /** 网盘报的修改时间（毫秒）；115 没有 */
  modifiedAt?: number;
}

export interface ArchiveListing {
  /** 归档目录（网盘绝对路径） */
  archiveDir: string;
  /** 网盘上有没有这个目录；没有就当空的 */
  exists: boolean;
  items: ArchiveListItem[];
}

/**
 * 一条的结果：
 *   deleted  从网盘上删掉了
 *   missing  归档里没有这条路径（可能已经删掉或挪走了）
 *   failed   删的时候出错，原因在 detail
 *   skipped  前面一条碰上网络问题，这条没试
 */
export type CleanItemOutcome = "deleted" | "missing" | "failed" | "skipped";

export interface CleanItem {
  /** 相对归档目录 */
  path: string;
  name: string;
  isDir?: boolean;
  size?: number;
  outcome: CleanItemOutcome;
  detail?: string;
}

export interface CleanRequest {
  task: TaskDefinition;
  /** 相对归档目录的路径；和 all 二选一 */
  paths?: string[];
  /** 归档目录现在这一层的全部条目 */
  all?: boolean;
  signal?: AbortSignal;
  /** 每删完一条叫一声（done / total），给智能体推进度 */
  onProgress?: (done: number, total: number) => void;
}

export interface CleanSummary {
  /** 删掉了几条 */
  done: number;
  archiveDir: string;
  items: CleanItem[];
}

const http = (status: number, message: string, code: string, extra: Record<string, unknown> = {}) => new HttpError(status, message, { code, ...extra });

const archiveDirOf = (task: TaskDefinition): string => joinPath(normDir(task.originPath), ARCHIVE_DIR);

/** 归档目录一层的网盘条目（带节点 id，删的时候要用）：目录在前，再按名字；目录不存在回 null */
async function listArchiveEntries(task: TaskDefinition, signal?: AbortSignal): Promise<DriveEntry[] | null> {
  const provider = providerForAccount(task.account);
  const node = await provider.resolvePath(archiveDirOf(task), signal);
  if (!node || !node.isDir) return null;
  // 绕开网盘客户端自己的目录缓存：刚归档 / 刚删过的要看现在的样子
  const entries = await provider.listDir(node.id, signal, { fresh: true });
  return [...entries].sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, "zh-Hans-CN")));
}

/** 目录不给大小：夸克的目录列表里 size 是 0，不是真的大小 */
const toListItem = (e: DriveEntry): ArchiveListItem => ({
  path: e.name,
  name: e.name,
  isDir: e.isDir,
  ...(!e.isDir && e.size != null ? { size: e.size } : {}),
  ...(e.modifiedAt ? { modifiedAt: e.modifiedAt } : {}),
});

/** 归档目录一层有什么 */
export async function listArchive(task: TaskDefinition, signal?: AbortSignal): Promise<ArchiveListing> {
  const archiveDir = archiveDirOf(task);
  const entries = await listArchiveEntries(task, signal);
  return entries ? { archiveDir, exists: true, items: entries.map(toListItem) } : { archiveDir, exists: false, items: [] };
}

/**
 * 要删的路径归一：相对归档目录、去重、父目录在就不单列子路径。
 * 写成「归档/xxx」的剥掉前缀：归档目录下不会再有一层「归档」（归档不收暂存区里的东西），剥掉不会指错
 */
export function uniqueArchivePaths(paths: string[]): string[] {
  if (paths.length === 0) throw http(400, "要删哪些没说：给 paths（相对归档目录的路径），或 all: true 清空整个归档目录", "VALIDATION");
  if (paths.length > CLEAN_MAX) throw http(400, `一次最多 ${CLEAN_MAX} 条路径`, "VALIDATION");
  const out: string[] = [];
  for (const raw of paths) {
    let rel: string;
    try {
      rel = normalizeRel(raw);
    } catch {
      throw http(400, `路径里不能有「..」或控制字符：${raw}`, "VALIDATION");
    }
    if (rel === ARCHIVE_DIR) rel = "";
    else if (rel.startsWith(`${ARCHIVE_DIR}/`)) rel = rel.slice(ARCHIVE_DIR.length + 1);
    if (!rel) throw http(400, "路径不能是归档目录本身：要清空整个归档目录，传 all: true", "VALIDATION");
    if (!out.includes(rel)) out.push(rel);
  }
  return out.filter((p) => !out.some((o) => o !== p && p.startsWith(`${o}/`)));
}

/** 第一阶段看完的一条：没找到的只带 item；要删的带着网盘上现在的那个节点 */
interface Plan {
  item: CleanItem;
  abs: string;
  entry?: Pick<DriveEntry, "id" | "isDir" | "size">;
}

export async function cleanArchive(input: CleanRequest): Promise<CleanSummary> {
  const { task, signal } = input;
  if (input.all && input.paths && input.paths.length > 0) throw http(400, "paths 和 all 二选一：要清空整个归档目录就只传 all", "VALIDATION");
  const provider = providerForAccount(task.account);
  if (!provider.write) throw http(400, `「${task.account}」这种网盘不支持删除文件，清理不了`, "UNSUPPORTED");
  const archiveDir = archiveDirOf(task);

  // 第一阶段：只看不改
  const plans: Plan[] = [];
  if (input.all) {
    for (const e of (await listArchiveEntries(task, signal)) ?? []) {
      plans.push({ item: { path: e.name, name: e.name, isDir: e.isDir, ...(e.size != null ? { size: e.size } : {}), outcome: "missing" }, abs: joinPath(archiveDir, e.name), entry: e });
    }
  } else {
    const lookups = new Lookups();
    for (const rel of uniqueArchivePaths(input.paths ?? [])) {
      signal?.throwIfAborted();
      const abs = joinPath(archiveDir, rel);
      const entry = await lookups.entry(task.account, abs);
      const item: CleanItem = { path: rel, name: baseName(abs), outcome: "missing" };
      if (entry) plans.push({ item: { ...item, isDir: entry.isDir, ...(entry.size != null ? { size: entry.size } : {}) }, abs, entry });
      else plans.push({ item: { ...item, detail: "归档里没有这条路径（可能已经删掉或挪走了）" }, abs });
    }
  }

  // 第二阶段：动手
  const items: CleanItem[] = [];
  let done = 0;
  const total = plans.filter((p) => p.entry).length;
  let progressed = 0;
  /** 碰上网络问题就停手：后面每条都会一样地等超时，不如照实说、让人稍后再来 */
  let halted: string | null = null;
  for (const p of plans) {
    signal?.throwIfAborted();
    if (!p.entry) {
      items.push(p.item);
      continue;
    }
    if (halted) {
      items.push({ ...p.item, outcome: "skipped", detail: `前面一条碰上网络问题（${halted}），这条没试，稍后再来` });
      continue;
    }
    try {
      await provider.write.remove({ id: String(p.entry.id), path: p.abs, isDir: p.entry.isDir }, signal);
      items.push({ ...p.item, outcome: "deleted" });
      done++;
    } catch (err) {
      const net = networkErrorText(err, { brief: true });
      const why = net ?? messageOf(err);
      items.push({ ...p.item, outcome: "failed", detail: `删除没成：${why}` });
      log.warn({ err }, `清理归档没成：${p.abs}`);
      if (net || transientAfterCopyError(task.account, err)) halted = why;
    }
    input.onProgress?.(++progressed, total);
  }
  // 同一轮复制里刚确认 / 建过的归档目录链可能已经删掉了：让下一次归档重新到网盘确认
  if (done > 0) resetArchiveDirCache();
  log.info(`清理归档（${task.account} ${archiveDir}）：${items.length ? items.map((i) => `${i.path}=${i.outcome}`).join("，") : "归档里没有东西"}`);
  return { done, archiveDir, items };
}
