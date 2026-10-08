/**
 * 归档到暂存区：把任务网盘目录里的目录 / 文件挪进任务目录下的「归档」，原来的层级留着
 * （tv/某剧/S01/E01.mkv → tv/归档/某剧/S01/E01.mkv），本地对应的 strm 删掉。进了暂存区就不再同步、监控、整理
 * （见 strm/staging.ts）；想恢复，到网盘里把它从「归档」挪回去就行。
 * 界面 strm 管理页的「归档到暂存区」、智能体的 drive_archive、REST 的 POST /api/drive/archive 都走这里。
 *
 * 和复制好的事后归档（after.ts）的区别：这里不管复制队列，也不核对别处有没有副本——
 * 没复制过的、不打算复制的、用别的办法备份好了的，都能收。放在 copy/ 下是因为挪进归档这一步和复制后归档
 * 是同一个实现（service.ts 的 archiveSource），桩也共用。
 *
 * 规矩：
 *   - 路径相对任务网盘目录，和 copy_add 同一口径（uniquePaths）：不收任务目录本身、不收暂存区里的，父目录在就不单列子路径；
 *   - 正在复制到 OpenList 的不动（队列里排着的记录，源是它、在它下面、或它在那条的源目录下面）：挪走了 OpenList 那边的复制就断了，
 *     让人等复制完，或者用 copy_after 排成「复制完归档」；
 *   - 任务正在整理时整个请求拒；
 *   - 幂等：源不在原处、归档里却有同名的，当上次已经挪过了（响应丢了再调一次不会报错）；
 *   - 归档里已经有同名的不覆盖、不合并，源留着；
 *   - 挪成之后，队列里同一个源（或它下面的）复制好的记录标成「已归档」，面板的「归档源文件」按钮和 copy_after 不再给它。
 * 两个阶段：先只看不改（网盘读不到，整个请求都不动），再逐条挪、随手写回；挪的时候碰上网络问题就停手，后面的不试、照实说。
 */
import type { TaskDefinition } from "@openstrm/shared";
import { messageOf, networkErrorText } from "../../lib/errors.js";
import { HttpError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { providerForAccount } from "../drive/registry.js";
import type { DriveEntry } from "../drive/types.js";
import { ARCHIVE_DIR } from "../strm/staging.js";
import { Lookups } from "./after.js";
import { assertNotOrganizing, MANUAL_PATHS_MAX, uniquePaths } from "./manual.js";
import { baseName, joinPath, normDir, parentDir } from "./paths.js";
import { commitCopies, listCopies, type CopyRecord } from "./queue.js";
import { archiveDriveSource, removeLocalMirrorOf, resetArchiveDirCache, transientAfterCopyError } from "./service.js";

const log = moduleLogger("copy-archive");

/** 一次最多收多少条（和手动复制同一上限） */
export const ARCHIVE_MAX = MANUAL_PATHS_MAX;

/**
 * 一条的结果：
 *   archived  挪进归档了（to 是归档里的目录）；上次已经挪过的也算
 *   kept      没动：原因在 detail（归档里已有同名、源路径上换了别的文件、网盘不支持移动）
 *   copying   正在复制到 OpenList，没动
 *   missing   网盘上没有这条路径（归档里也没有）
 *   failed    挪的时候出错，原因在 detail
 *   skipped   前面一条碰上网络问题，这条没试
 */
export type ArchiveItemOutcome = "archived" | "kept" | "copying" | "missing" | "failed" | "skipped";

export interface ArchiveItem {
  /** 相对任务网盘目录 */
  path: string;
  name: string;
  isDir?: boolean;
  outcome: ArchiveItemOutcome;
  detail?: string;
  /** 归档到了哪（网盘上归档里的目录） */
  to?: string;
}

export interface ArchiveRequest {
  task: TaskDefinition;
  /** 相对任务网盘目录的路径 */
  paths: string[];
  signal?: AbortSignal;
  /** 每挪完一条叫一声（done / total），给智能体推进度 */
  onProgress?: (done: number, total: number) => void;
}

export interface ArchiveSummary {
  /** 收进去了几条（含上次已经挪过的） */
  done: number;
  /** 归档目录（网盘绝对路径） */
  archiveDir: string;
  items: ArchiveItem[];
}

const http = (status: number, message: string, code: string, extra: Record<string, unknown> = {}) => new HttpError(status, message, { code, ...extra });

/**
 * 第一阶段看完的一条：已经有结论的只带 item；要动手的带着网盘上现在的那个节点；
 * earlier 是源不在原处、归档里却有同名的——上次已经挪过了，第二阶段只补本地 strm 和记录
 */
interface Plan {
  item: ArchiveItem;
  abs: string;
  entry?: DriveEntry;
  earlier?: { to: string };
}

export async function archiveToStaging(input: ArchiveRequest): Promise<ArchiveSummary> {
  const { task, signal } = input;
  const rels = uniquePaths(input.paths, "归档");
  assertNotOrganizing(task, "归档");
  const provider = providerForAccount(task.account);
  if (!provider.write) throw http(400, `「${task.account}」这种网盘不支持移动文件，归档不了`, "UNSUPPORTED");
  const origin = normDir(task.originPath);
  const archiveDir = joinPath(origin, ARCHIVE_DIR);
  const lookups = new Lookups();
  /** 正在复制到 OpenList 的源（网盘绝对路径）：挪走就断了 */
  const copying = listCopies()
    .filter((r) => r.status === "pending" && !r.adopted && r.srcDir !== "" && r.account === task.account)
    .map((r) => joinPath(r.srcDir, r.name));

  // 第一阶段：只看不改
  const plans: Plan[] = [];
  for (const rel of rels) {
    signal?.throwIfAborted();
    const abs = joinPath(origin, rel);
    const item: ArchiveItem = { path: rel, name: baseName(abs), outcome: "missing" };
    if (copying.some((src) => overlaps(src, abs))) {
      plans.push({ item: { ...item, outcome: "copying", detail: "正在复制到 OpenList，等复制完再归档；要复制完就归档的，用 copy_after 排上" }, abs });
      continue;
    }
    const entry = await lookups.entry(task.account, abs);
    if (entry) {
      plans.push({ item: { ...item, isDir: entry.isDir }, abs, entry });
      continue;
    }
    // 源不在原处：归档里有同名的，就是上次挪过了（响应丢了再调一次不该报错）；上次挪完之后的收尾可能也没做完，第二阶段补
    const there = await lookups.entry(task.account, joinPath(archiveDir, rel));
    if (there) {
      plans.push({ item: { ...item, isDir: there.isDir }, abs, earlier: { to: parentDir(joinPath(archiveDir, rel)) } });
    } else {
      plans.push({ item: { ...item, detail: "网盘上没有这条路径" }, abs });
    }
  }

  // 第二阶段：动手。上面等网络的时候整理可能开始了，再看一眼
  assertNotOrganizing(task, "归档");
  resetArchiveDirCache();
  const items: ArchiveItem[] = [];
  let done = 0;
  const total = plans.filter((p) => p.entry || p.earlier).length;
  let progressed = 0;
  /** 碰上网络问题就停手：后面每条都会一样地等超时，不如照实说、让人稍后再来 */
  let halted: string | null = null;
  for (const p of plans) {
    signal?.throwIfAborted();
    if (p.earlier) {
      // 网盘上不用再动，只补收尾（本地 strm、队列记录都是本地的事，不受网络问题影响）
      items.push(await settle(task, p, { kind: "archived", to: p.earlier.to, earlier: true }));
      done++;
      input.onProgress?.(++progressed, total);
      continue;
    }
    if (!p.entry) {
      items.push(p.item);
      continue;
    }
    if (halted) {
      items.push({ ...p.item, outcome: "skipped", detail: `前面一条碰上网络问题（${halted}），这条没试，稍后再来` });
      continue;
    }
    try {
      const r = await archiveDriveSource(task.account, p.abs, String(p.entry.id), origin);
      const item = await settle(task, p, r);
      if (item.outcome === "archived") done++;
      items.push(item);
    } catch (err) {
      const net = networkErrorText(err, { brief: true });
      const why = net ?? messageOf(err);
      items.push({ ...p.item, outcome: "failed", detail: `归档没成：${why}` });
      log.warn({ err }, `归档到暂存区没成：${p.abs}`);
      if (net || transientAfterCopyError(task.account, err)) halted = why;
    }
    input.onProgress?.(++progressed, total);
  }
  log.info(`归档到暂存区（${task.account} ${task.originPath}）：${items.map((i) => `${i.path}=${i.outcome}`).join("，")}`);
  return { done, archiveDir, items };
}

/** 两条网盘路径是同一条，或一条在另一条下面 */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** 挪进归档这一步的结论换成这一条的结果；挪成了顺手删本地 strm、把队列里同一个源的记录标成已归档 */
async function settle(task: TaskDefinition, p: Plan, r: Awaited<ReturnType<typeof archiveDriveSource>>): Promise<ArchiveItem> {
  const item = p.item;
  if (r.kind === "archived") {
    const notes: string[] = [];
    if (r.earlier) notes.push("已经在归档里（上次挪过了）");
    try {
      if (await removeLocalMirrorOf(task.account, p.abs, item.isDir)) notes.push("本地 strm 也删了");
    } catch (err) {
      notes.push(`本地 strm 没删掉：${messageOf(err)}`);
    }
    markCopyRecords(task, p.abs, r.to);
    return { ...item, outcome: "archived", to: r.to, ...(notes.length ? { detail: notes.join("，") } : {}) };
  }
  if (r.kind === "exists") return { ...item, outcome: "kept", detail: "归档目录里已经有同名的，没动；先把那一份处理掉再来" };
  if (r.kind === "missing") return { ...item, outcome: "missing", detail: "网盘上没有这条路径（刚才还在，这会儿不见了）" };
  if (r.kind === "changed") return { ...item, outcome: "kept", detail: "源路径上刚换成了别的文件，没动" };
  if (r.kind === "unsupported") return { ...item, outcome: "kept", detail: "这个网盘不支持移动" };
  // staged / no-root：uniquePaths 已经拦了暂存区、任务目录总是有的，走不到这里
  return { ...item, outcome: "kept", detail: `没动（${r.kind}）` };
}

/**
 * 队列里复制好、源文件还在原处的记录（去向是不动，或当时没处理成），源是刚挪走的这条或在它下面的：
 * 标成已归档，面板上的「归档源文件」按钮和 copy_after 就不再给它（它们再来也只会说「源不在原处」）
 */
function markCopyRecords(task: TaskDefinition, abs: string, to: string): void {
  const now = Date.now();
  const changed: CopyRecord[] = [];
  for (const r of listCopies()) {
    if (r.status !== "done" || r.adopted || r.srcDir === "" || r.account !== task.account || r.afterRetry) continue;
    if (r.afterCopy !== "keep" && !r.sourceKept) continue;
    const src = joinPath(r.srcDir, r.name);
    if (src !== abs && !src.startsWith(`${abs}/`)) continue;
    r.afterCopy = "archive";
    r.sourceKept = undefined;
    r.detail += src === abs ? `；网盘上那份已归档到 ${to}（归档到暂存区）` : `；网盘上那份已随上级目录归档到 ${to}（归档到暂存区）`;
    changed.push(r);
  }
  if (changed.length > 0) commitCopies(changed, now);
}
