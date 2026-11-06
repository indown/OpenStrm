/**
 * strm 管理：按同步任务浏览本地 strm 输出目录、体检、校验、修正、重建。路由只调这里。
 *
 *   - 一切按 (task, rel) 寻址：rel 是相对任务 targetPath 的 POSIX 路径，"" 是根。
 *     词法上先过 resolveInDataDir，父目录存在时再按 realpath 比一次，防止顺着符号链接跑出去。
 *   - 几个任务共用 / 嵌套同一个输出目录是允许的：落在本任务根之内的其它任务根整棵跳过（skippedRoots），
 *     同根兄弟任务的文件按内容前缀排除（inspect.isForeignStrm），删除拒绝碰别的任务的根。
 *   - 写操作（删除 / 重写 / 重建）在任务同步中一律 409，同一任务同时只跑一个管理操作；
 *     读、扫描、校验不拦。生活事件按文件写同一公式，不算冲突。
 *   - 碰 115 的两步（导出目录、查目录内容）可注入，测试换成桩。
 */
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Observable, Subject, throttle } from "rxjs";
import type {
  AppSettings,
  StrmDeleteResult,
  StrmEntry,
  StrmEntryKind,
  StrmFileInfo,
  StrmIssue,
  StrmIssueType,
  StrmListResult,
  StrmParseReason,
  StrmRegenerateMode,
  StrmRegenerateResult,
  StrmRewriteResult,
  StrmScanResult,
  StrmSearchHit,
  StrmSearchResult,
  StrmVerifyEvent,
  StrmVerifyProgress,
  StrmVerifyResult,
  TaskDefinition,
} from "@openstrm/shared";
import { listTasks } from "../../db/repositories/tasks.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { mapLimit } from "../../lib/async.js";
import { isAbortError } from "../../lib/errors.js";
import { forEachLimit, unrefTimer } from "../../lib/rx.js";
import { isDirectoryEntry, pathExists, readTextCapped, removeEmptyParents, walkTree } from "../../lib/fs.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { moduleLogger } from "../../lib/logger.js";
import { resolveInDataDir } from "../../paths.js";
import { writeStrm } from "../download/rate-limited.js";
import { scheduleEmbyRefresh } from "../media-server.js";
import { isTaskRunning } from "../task/registry.js";
import { RemoteDirNotFoundError, type DriveProvider } from "../drive/types.js";
import { episodeKey, inspectStrm, isForeignStrm, showDirOf } from "./inspect.js";
import { extOf, extSet, stripStrmExt, toStrmPath } from "./naming.js";
import { hasReleaseNoise } from "../organize/parse-name.js";
import { cachedProbesByPath, mediaBrief } from "../media/probe.js";
import { normalizePath } from "../drive/types.js";
import type { StrmMediaResult } from "@openstrm/shared";

const log = moduleLogger("strm-manage");

export const STRM_LIMITS = {
  /** strm 只有几百字节；超过这个数不当 strm 读 */
  MAX_STRM_BYTES: 64 * 1024,
  /** 一次遍历最多看这么多条目，超过就标 truncated */
  WALK_ENTRIES: 200_000,
  SEARCH_DEFAULT: 200,
  SEARCH_MAX: 500,
  /** 体检每类问题最多列这么多条，总数在 counts 里 */
  ISSUE_LIST: 200,
  REWRITE_SAMPLES: 50,
  /** 校验一次最多看的 strm 数：只影响本地读，网盘那边的成本看目录数 */
  VERIFY_FILES: 20_000,
  /** 逐个目录问网盘的上限（每个目录 1 次解析 + 至少 1 次列目录）；超过就改成拉一次整棵子树比对 */
  VERIFY_DIRS: 60,
  DELETE_MAX: 500,
  /** 一次要媒体信息的 strm 数：列表一页顶多几百条 */
  MEDIA_MAX: 500,
} as const;

/* ------------------------------- 依赖注入 ------------------------------- */

/** 网盘那几步走 DriveProvider（测试用 setDriveProviderFactory 换假网盘）；这里只剩任务表 */
interface Deps {
  isTaskRunning: typeof isTaskRunning;
}

const realDeps: Deps = { isTaskRunning };
let deps: Deps = { ...realDeps };

/** 仅供测试：换掉会碰任务表的一步；传 null 恢复 */
export function setStrmManageDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------- 小工具 ------------------------------- */

const errMsg = (err: unknown): string => (err instanceof Error && err.message ? err.message : String(err));
const joinRel = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
/** rel 是否在 dir 之内（含相等）；dir 为 "" 就是根，什么都在里面 */
const isUnder = (rel: string, dir: string): boolean => dir === "" || rel === dir || rel.startsWith(`${dir}/`);
const errno = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;

const REASON_LABEL: Record<StrmParseReason, string> = {
  empty: "文件是空的",
  "no-ext": "内容里没有文件扩展名",
  "name-mismatch": "内容里的文件名和本地文件名对不上",
  "prefix-mismatch": "前缀和任务现在的 strmPrefix 对不上",
};

function kindOf(name: string, isDir: boolean, downloadExts: Set<string>): StrmEntryKind {
  if (isDir) return "dir";
  const ext = extOf(name);
  if (ext === ".strm") return "strm";
  if (ext === ".part") return "part";
  if (downloadExts.has(ext)) return "download";
  return "other";
}

function downloadExtsOf(settings: AppSettings = readAppSettings()): Set<string> {
  return extSet(settings.downloadExtensions);
}

/* ------------------------------- 寻址与归属 ------------------------------- */

export interface ManagedPath {
  root: string;
  realRoot: string;
  full: string;
  rel: string;
}

/** 每一段原样保留：目录名前后带空格是合法的（网盘里常见），trim 掉就找不到了。智能体工具也用它，别自己另写一套 */
export function normalizeRel(input: string): string {
  if (input.includes("\0")) throw new HttpError(400, "路径越出了任务目录");
  const parts = input.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.some((s) => s === "..")) throw new HttpError(400, "路径越出了任务目录");
  return parts.join("/");
}

function taskRoot(task: TaskDefinition): string {
  const root = resolveInDataDir(task.targetPath);
  if (!root) throw new HttpError(400, `任务的本地目录越出了数据目录：${task.targetPath}`);
  return root;
}

/**
 * 归一化 rel（去首尾 /、空段、拒绝 ..）并定位到磁盘路径。父目录存在时再按 realpath 比一次：
 * 根本身可以是指向 NAS 的链接，所以和根的 realpath 比，而不是和 DATA_DIR 比。
 */
export async function resolveManagedPath(
  task: TaskDefinition,
  relInput: string,
  opts: { mustExist?: boolean } = {},
): Promise<ManagedPath> {
  const rel = normalizeRel(relInput);
  const root = taskRoot(task);
  const full = rel ? path.join(root, ...rel.split("/")) : root;
  if (full !== root && !full.startsWith(root + path.sep)) throw new HttpError(400, "路径越出了任务目录");

  let realRoot = root;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    /* 根还不存在：只能做词法检查 */
  }
  if (rel) {
    let realParent: string | null = null;
    try {
      realParent = await fsp.realpath(path.dirname(full));
    } catch {
      /* 父目录不存在：词法检查已经过了，让后面的 mustExist / 具体操作去报 */
    }
    if (realParent !== null && realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
      throw new HttpError(400, "路径越出了任务目录（经过了符号链接）");
    }
  }
  if (opts.mustExist && !(await pathExists(full))) {
    throw new HttpError(404, rel ? `不存在：${rel}` : "任务的本地目录还不存在");
  }
  return { root, realRoot, full, rel };
}

interface ForeignRoot {
  rel: string;
  taskId: string;
}

function foreignRootsOf(task: TaskDefinition, tasks: TaskDefinition[]): ForeignRoot[] {
  const root = taskRoot(task);
  const out: ForeignRoot[] = [];
  for (const t of tasks) {
    if (t.id === task.id) continue;
    const other = resolveInDataDir(t.targetPath);
    if (!other || other === root || !other.startsWith(root + path.sep)) continue;
    out.push({ rel: path.relative(root, other).split(path.sep).join("/"), taskId: t.id });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 其它任务的根落在本任务根之内的相对路径（本任务根 == DATA_DIR 时就是全部其它任务） */
export function nestedForeignRoots(task: TaskDefinition, tasks: TaskDefinition[]): string[] {
  return foreignRootsOf(task, tasks).map((r) => r.rel);
}

/** 和本任务共用同一个输出目录的其它任务 */
export function sameRootSiblings(task: TaskDefinition, tasks: TaskDefinition[]): TaskDefinition[] {
  const root = taskRoot(task);
  return tasks.filter((t) => t.id !== task.id && resolveInDataDir(t.targetPath) === root);
}

/** 把相对任务根的外部根换算成相对 baseRel（遍历起点）的路径，不在 baseRel 之下的丢掉 */
function foreignUnder(foreign: string[], baseRel: string): string[] {
  if (!baseRel) return foreign;
  return foreign.filter((r) => r.startsWith(`${baseRel}/`)).map((r) => r.slice(baseRel.length + 1));
}

const skipDirOf = (foreign: string[]) => (rel: string) => foreign.includes(rel);

/** rel 等于、包含或落在某个外部根之内 */
function foreignRootHit(rel: string, roots: ForeignRoot[]): ForeignRoot | undefined {
  return roots.find((r) => isUnder(rel, r.rel) || isUnder(r.rel, rel));
}

/* ------------------------------- 互斥 ------------------------------- */

const busy = new Set<string>();

async function guarded<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  if (deps.isTaskRunning(taskId)) throw new HttpError(409, "任务正在运行，请先取消或等待完成");
  if (busy.has(taskId)) throw new HttpError(409, "该任务有 strm 管理操作正在进行");
  busy.add(taskId);
  try {
    return await fn();
  } finally {
    busy.delete(taskId);
  }
}

/**
 * 一组路径下有多少东西（智能体删除 / 重建前的确认框里说清是多大一片）：只数不改，数到上限就停。
 * 目录按符号链接不跟进；不存在的单数
 */
export async function countUnder(
  task: TaskDefinition,
  rels: string[],
  cap: number = STRM_LIMITS.WALK_ENTRIES,
): Promise<{ dirs: number; topFiles: number; files: number; strm: number; missing: number; truncated: boolean }> {
  /** dirs / topFiles 是点名的路径里目录、文件各几个；files / strm 是连目录里面一起数的总数 */
  const out = { dirs: 0, topFiles: 0, files: 0, strm: 0, missing: 0, truncated: false };
  let seen = 0;
  for (const rel of rels) {
    const mp = await resolveManagedPath(task, rel);
    let st: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      st = await fsp.lstat(mp.full);
    } catch {
      out.missing++;
      continue;
    }
    if (!st.isDirectory()) {
      out.topFiles++;
      out.files++;
      if (extOf(mp.full) === ".strm") out.strm++;
      continue;
    }
    out.dirs++;
    for await (const e of walkTree(mp.full)) {
      if (++seen > cap) {
        out.truncated = true;
        return out;
      }
      if (e.isDir) continue;
      out.files++;
      if (extOf(e.name) === ".strm") out.strm++;
    }
  }
  return out;
}

/* ------------------------------- 浏览 ------------------------------- */

async function statEntry(full: string, entry: Dirent, downloadExts: Set<string>, parent: string): Promise<StrmEntry> {
  const isDir = await isDirectoryEntry(parent, entry);
  let size = 0;
  let mtime = 0;
  try {
    const st = await fsp.stat(full);
    size = isDir ? 0 : st.size;
    mtime = Math.round(st.mtimeMs);
  } catch {
    /* 坏链接之类：列出来但没有大小时间 */
  }
  const e: StrmEntry = { name: entry.name, isDir, kind: kindOf(entry.name, isDir, downloadExts), size, mtime };
  if (entry.isSymbolicLink()) e.isSymlink = true;
  return e;
}

function sortEntries<T extends { name: string; isDir: boolean }>(entries: T[]): T[] {
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

export async function listDir(task: TaskDefinition, rel: string): Promise<StrmListResult> {
  const mp = await resolveManagedPath(task, rel);
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(mp.full, { withFileTypes: true });
  } catch (err) {
    const code = errno(err);
    if (code === "ENOENT" && !mp.rel) return { path: "", exists: false, entries: [] };
    if (code === "ENOENT") throw new HttpError(404, `目录不存在：${mp.rel}`);
    if (code === "ENOTDIR") throw new HttpError(400, `不是目录：${mp.rel}`);
    throw err;
  }
  const downloadExts = downloadExtsOf();
  const listed = await mapLimit(entries, 16, (e) => statEntry(path.join(mp.full, e.name), e, downloadExts, mp.full));
  return { path: mp.rel, exists: true, entries: sortEntries(listed) };
}

export async function readStrm(task: TaskDefinition, rel: string): Promise<StrmFileInfo> {
  const mp = await resolveManagedPath(task, rel, { mustExist: true });
  if (extOf(mp.rel) !== ".strm") throw new HttpError(400, "只能查看 .strm 文件");
  let content: string | null;
  try {
    content = await readTextCapped(mp.full, STRM_LIMITS.MAX_STRM_BYTES);
  } catch (err) {
    if (errno(err) === "EISDIR") throw new HttpError(400, `是目录，不是文件：${mp.rel}`);
    throw err;
  }
  if (content === null) throw new HttpError(400, "文件过大，不像是 strm");
  const i = inspectStrm(task, mp.rel, content);
  const info: StrmFileInfo = {
    path: mp.rel,
    content,
    expectedContent: i.expectedContent,
    expectedRemotePath: i.expectedRemote,
    actualRemotePath: i.actualRemote,
    matches: i.matches,
  };
  if (i.reason) info.reason = i.reason;
  const remote = remoteAbsOf(i);
  if (remote) {
    const probe = cachedProbesByPath(task.account, [remote]).get(remote);
    if (probe) info.media = mediaBrief(probe);
  }
  return info;
}

/** strm 指向的网盘绝对路径：解析得出的优先，解析不出用应有的；都没有就 null */
function remoteAbsOf(i: Pick<ReturnType<typeof inspectStrm>, "actualRemote" | "expectedRemote">): string | null {
  const r = i.actualRemote || i.expectedRemote;
  return r ? normalizePath(`/${r}`) : null;
}

/**
 * 一批 strm 指向的网盘文件的实测媒体信息（整理页探测过、或 Emby 播放后回填过的才有）：读每个 strm 的内容定位网盘路径，
 * 按账号 + 路径查探测缓存。读不到的、不是 strm 的、没缓存的都不在结果里；不碰网盘
 */
export async function mediaOf(task: TaskDefinition, rels: string[]): Promise<StrmMediaResult> {
  const wanted = [...new Set(rels)].filter((r) => extOf(r) === ".strm");
  const remoteOf = new Map<string, string>();
  await mapLimit(wanted, 16, async (rel) => {
    try {
      const mp = await resolveManagedPath(task, rel);
      const content = await readTextCapped(mp.full, STRM_LIMITS.MAX_STRM_BYTES);
      if (content === null) return;
      const remote = remoteAbsOf(inspectStrm(task, mp.rel, content));
      if (remote) remoteOf.set(mp.rel, remote);
    } catch {
      /* 不存在、是目录、越界：这一条就是没有 */
    }
  });
  const probes = cachedProbesByPath(task.account, [...remoteOf.values()]);
  const media: StrmMediaResult["media"] = {};
  for (const [rel, remote] of remoteOf) {
    const probe = probes.get(remote);
    if (probe) media[rel] = mediaBrief(probe);
  }
  return { media };
}

export async function search(task: TaskDefinition, q: string, limit: number = STRM_LIMITS.SEARCH_DEFAULT): Promise<StrmSearchResult> {
  const mp = await resolveManagedPath(task, "");
  const needle = q.trim().toLowerCase();
  if (!needle) return { hits: [], truncated: false };
  const cap = Math.max(1, Math.min(limit, STRM_LIMITS.SEARCH_MAX));
  const foreign = nestedForeignRoots(task, listTasks());
  const downloadExts = downloadExtsOf();
  const hits: StrmSearchHit[] = [];
  let truncated = false;
  let seen = 0;
  for await (const e of walkTree(mp.full, { skipDir: skipDirOf(foreign) })) {
    if (++seen > STRM_LIMITS.WALK_ENTRIES) {
      truncated = true;
      break;
    }
    if (!e.name.toLowerCase().includes(needle)) continue;
    if (hits.length >= cap) {
      truncated = true;
      break;
    }
    let size = 0;
    let mtime = 0;
    try {
      const st = await fsp.stat(e.full);
      size = e.isDir ? 0 : st.size;
      mtime = Math.round(st.mtimeMs);
    } catch {
      /* 坏链接 */
    }
    hits.push({ path: e.rel, name: e.name, isDir: e.isDir, kind: kindOf(e.name, e.isDir, downloadExts), size, mtime });
  }
  return { hits, truncated };
}

/* ------------------------------- 体检 ------------------------------- */

const ISSUE_TYPES: StrmIssueType[] = ["nested-same-name", "empty-dir", "stale-content", "unparsable", "duplicate-episode", "leftover-part", "nonstandard-name"];

export async function scan(task: TaskDefinition, rel: string): Promise<StrmScanResult> {
  const mp = await resolveManagedPath(task, rel);
  const tasks = listTasks();
  // 相对任务根的路径：落在扫描范围内的其它任务的根
  const foreign = nestedForeignRoots(task, tasks).filter((r) => isUnder(r, mp.rel) && r !== mp.rel);
  const siblings = sameRootSiblings(task, tasks);
  const counts = Object.fromEntries(ISSUE_TYPES.map((t) => [t, 0])) as Record<StrmIssueType, number>;
  const issues: StrmIssue[] = [];
  const add = (type: StrmIssueType, p: string, detail?: string, related?: string[]) => {
    if (counts[type]++ >= STRM_LIMITS.ISSUE_LIST) return;
    const issue: StrmIssue = { type, path: p };
    if (detail) issue.detail = detail;
    if (related?.length) issue.related = related;
    issues.push(issue);
  };
  const episodes = new Map<string, string[]>();
  let files = 0;
  let strm = 0;
  let dirs = 0;
  let visited = 0;
  let truncated = false;

  // 返回子树里的文件数：父目录靠它判断谁是"最上层的空目录"
  async function visit(dirRel: string, dirFull: string, insideNested: boolean): Promise<number> {
    if (truncated) return 0;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dirFull, { withFileTypes: true });
    } catch {
      return 0;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const dirName = path.posix.basename(dirRel);
    const strmEntries: Dirent[] = [];
    const subdirs: Dirent[] = [];
    let subtreeFiles = 0;
    for (const e of entries) {
      if (++visited > STRM_LIMITS.WALK_ENTRIES) {
        truncated = true;
        break;
      }
      const eRel = joinRel(dirRel, e.name);
      if (e.isDirectory()) {
        if (foreign.includes(eRel)) continue;
        dirs++;
        subdirs.push(e);
        continue;
      }
      files++;
      subtreeFiles++;
      const ext = extOf(e.name);
      if (ext === ".strm") {
        strm++;
        strmEntries.push(e);
      } else if (ext === ".part") {
        add("leftover-part", eRel);
      }
    }

    await mapLimit(strmEntries, 16, async (e) => {
      const eRel = joinRel(dirRel, e.name);
      let content: string | null;
      try {
        content = await readTextCapped(path.join(dirFull, e.name), STRM_LIMITS.MAX_STRM_BYTES);
      } catch {
        content = null;
      }
      if (content === null) {
        add("unparsable", eRel, "读不了或文件过大");
        return;
      }
      if (siblings.length > 0 && isForeignStrm(content, task, siblings)) return;
      const ins = inspectStrm(task, eRel, content);
      if (ins.reason && ins.reason !== "prefix-mismatch") {
        add("unparsable", eRel, REASON_LABEL[ins.reason]);
      } else if (!ins.matches) {
        add("stale-content", eRel, ins.reason ? REASON_LABEL[ins.reason] : "内容和任务现在的 originPath / 编码设置对不上");
      }
      if (hasReleaseNoise(stripStrmExt(e.name))) add("nonstandard-name", eRel, "文件名带发布组 / 画质 / 编码这类噪音，媒体库靠猜容易识别错；「整理」页可以规范成标准命名");
      const key = episodeKey(e.name);
      if (key) {
        const k = `${showDirOf(eRel)}\0S${key.season}E${key.episode}`;
        const list = episodes.get(k);
        if (list) list.push(eRel);
        else episodes.set(k, [eRel]);
      }
    });

    const emptyChildren: string[] = [];
    for (const d of subdirs) {
      if (truncated) break;
      const dRel = joinRel(dirRel, d.name);
      const nested = !insideNested && d.name === dirName;
      if (nested) add("nested-same-name", dRel, "目录里套了一个同名目录，多半是重复生成的一层");
      const n = await visit(dRel, path.join(dirFull, d.name), insideNested || nested);
      subtreeFiles += n;
      if (n === 0 && !truncated) emptyChildren.push(dRel);
    }
    // 自己也是空的就让上一层来报，只报最上层那一个
    if (subtreeFiles > 0 || dirRel === mp.rel) for (const c of emptyChildren) add("empty-dir", c);
    return subtreeFiles;
  }

  await visit(mp.rel, mp.full, false);

  for (const [, paths] of episodes) {
    if (paths.length < 2) continue;
    paths.sort();
    add("duplicate-episode", paths[0], `疑似同一集有 ${paths.length} 个 strm`, paths.slice(1));
  }

  return { files, strm, dirs, truncated, skippedRoots: foreign, counts, issues };
}

/* ------------------------------- 删除 ------------------------------- */

export async function deletePaths(task: TaskDefinition, rels: string[]): Promise<StrmDeleteResult> {
  if (rels.length > STRM_LIMITS.DELETE_MAX) throw new HttpError(400, `一次最多删除 ${STRM_LIMITS.DELETE_MAX} 项`);
  return guarded(task.id, async () => {
    const roots = foreignRootsOf(task, listTasks());
    const result: StrmDeleteResult = { deleted: 0, failed: [] };
    for (const r of rels) {
      try {
        const mp = await resolveManagedPath(task, r);
        if (!mp.rel) throw new HttpError(400, "不能删除任务目录本身");
        const hit = foreignRootHit(mp.rel, roots);
        if (hit) throw new HttpError(400, `${mp.rel} 属于任务 ${hit.taskId} 的输出目录，请在那个任务下操作`);
        try {
          await fsp.lstat(mp.full);
        } catch {
          throw new HttpError(404, "不存在");
        }
        // 不跟随符号链接：删链接只删链接本身。删完不清父目录——用户正在浏览的目录不该凭空消失
        await fsp.rm(mp.full, { recursive: true, force: true });
        result.deleted++;
      } catch (err) {
        result.failed.push({ path: r, message: errMsg(err) });
      }
    }
    log.info(`删除 ${result.deleted} 项（失败 ${result.failed.length}）← 任务 ${task.id}`);
    if (result.deleted > 0) scheduleEmbyRefresh();
    return result;
  });
}

/* ------------------------------- 修正内容 ------------------------------- */

/** rel 是 strm 文件就只有它；是目录就整棵（外部根跳过）；根不存在给空 */
async function collectStrm(
  mp: ManagedPath,
  foreign: string[],
  max: number,
  signal?: AbortSignal,
): Promise<{ rels: string[]; truncated: boolean }> {
  let st;
  try {
    st = await fsp.lstat(mp.full);
  } catch {
    if (!mp.rel) return { rels: [], truncated: false };
    throw new HttpError(404, `不存在：${mp.rel}`);
  }
  if (!st.isDirectory()) {
    if (extOf(mp.rel) !== ".strm") throw new HttpError(400, "只能处理 .strm 文件或目录");
    return { rels: [mp.rel], truncated: false };
  }
  const rels: string[] = [];
  let seen = 0;
  for await (const e of walkTree(mp.full, { skipDir: skipDirOf(foreignUnder(foreign, mp.rel)) })) {
    // 冷盘 / 网络盘上这一趟能走几分钟，取消了就别走完
    signal?.throwIfAborted();
    if (++seen > STRM_LIMITS.WALK_ENTRIES) return { rels, truncated: true };
    if (e.isDir || extOf(e.name) !== ".strm") continue;
    rels.push(joinRel(mp.rel, e.rel));
    if (rels.length > max) return { rels, truncated: true };
  }
  return { rels, truncated: false };
}

export async function rewrite(task: TaskDefinition, rel: string, opts: { dryRun: boolean }): Promise<StrmRewriteResult> {
  const run = async (): Promise<StrmRewriteResult> => {
    const mp = await resolveManagedPath(task, rel);
    const tasks = listTasks();
    const foreign = nestedForeignRoots(task, tasks);
    const siblings = sameRootSiblings(task, tasks);
    const { rels, truncated } = await collectStrm(mp, foreign, STRM_LIMITS.WALK_ENTRIES);
    if (truncated) throw new HttpError(400, "范围太大，请选一个更小的目录分批处理");

    const result: StrmRewriteResult = {
      dryRun: opts.dryRun,
      checked: 0,
      changed: 0,
      foreign: 0,
      skippedRoots: foreign.filter((r) => isUnder(r, mp.rel) && r !== mp.rel),
      unparsable: [],
      samples: [],
    };
    await mapLimit(rels, 16, async (r) => {
      const full = path.join(mp.root, ...r.split("/"));
      let content: string | null;
      try {
        content = await readTextCapped(full, STRM_LIMITS.MAX_STRM_BYTES);
      } catch {
        content = null;
      }
      if (content === null) {
        result.unparsable.push({ path: r, reason: "empty" });
        return;
      }
      result.checked++;
      if (siblings.length > 0 && isForeignStrm(content, task, siblings)) {
        result.foreign++;
        return;
      }
      const ins = inspectStrm(task, r, content);
      if (!ins.rewritable) {
        result.unparsable.push({ path: r, reason: ins.reason ?? "empty" });
        return;
      }
      if (ins.matches) return;
      result.changed++;
      if (result.samples.length < STRM_LIMITS.REWRITE_SAMPLES) result.samples.push({ path: r, from: content, to: ins.expectedContent });
      // 不走 writeStrm：它按无扩展名的 savePath 再 toStrmPath，a.b.strm 会被切成 a.strm
      if (!opts.dryRun) await fsp.writeFile(full, ins.expectedContent, "utf8");
    });
    result.unparsable.sort((a, b) => a.path.localeCompare(b.path));
    result.samples.sort((a, b) => a.path.localeCompare(b.path));
    if (!opts.dryRun) log.info(`修正 strm 内容 ${result.changed}/${result.checked} ← 任务 ${task.id} ${mp.rel || "/"}`);
    return result;
  };
  return opts.dryRun ? run() : guarded(task.id, run);
}

/* ------------------------------- 重新生成 ------------------------------- */

export async function regenerate(
  task: TaskDefinition,
  provider: DriveProvider,
  rel: string,
  opts: { mode: StrmRegenerateMode },
): Promise<StrmRegenerateResult> {
  const mp = await resolveManagedPath(task, rel);
  if (!mp.rel) throw new HttpError(400, "任务根目录请直接运行同步任务");
  return guarded(task.id, async () => {
    const tasks = listTasks();
    const foreign = foreignUnder(nestedForeignRoots(task, tasks), mp.rel);
    const siblings = sameRootSiblings(task, tasks);
    const strmExts = extSet(readAppSettings().strmExtensions);
    const remoteDir = `${task.originPath}/${mp.rel}`;

    // 先读网盘再动本地：读失败（超时、封控、cookie 失效）时本地一个字节都不该少
    let files: string[];
    try {
      files = await provider.listSubtree(remoteDir);
    } catch (err) {
      if (err instanceof RemoteDirNotFoundError) throw new HttpError(404, err.message);
      if (err instanceof HttpError) throw err;
      throw upstreamError(errMsg(err));
    }
    const wanted = files.filter((f) => strmExts.has(extOf(f)));
    const keep = new Set(wanted.map((f) => toStrmPath(f)));
    let generated = 0;
    let skipped = 0;
    let removed = 0;

    await fsp.mkdir(mp.full, { recursive: true });
    for (const f of wanted) {
      // savePath 是网盘文件名（带原扩展名），writeStrm 自己换成 .strm
      const savePath = path.join(mp.full, ...f.split("/"));
      if (opts.mode === "fill" && (await pathExists(toStrmPath(savePath)))) {
        skipped++;
        continue;
      }
      await writeStrm(`${remoteDir}/${f}`, savePath, {
        displayPath: `${remoteDir}/${f}`,
        strmPrefix: task.strmPrefix,
        enablePathEncoding: task.enablePathEncoding,
      });
      generated++;
    }

    if (opts.mode === "rebuild") {
      // 本地有、网盘没有的 strm 删掉；附件不动，别的任务的不动
      const extra: string[] = [];
      for await (const e of walkTree(mp.full, { skipDir: skipDirOf(foreign) })) {
        if (e.isDir || extOf(e.name) !== ".strm" || keep.has(e.rel)) continue;
        if (siblings.length > 0) {
          let content: string | null = null;
          try {
            content = await readTextCapped(e.full, STRM_LIMITS.MAX_STRM_BYTES);
          } catch {
            /* 读不了就当自己的 */
          }
          if (content !== null && isForeignStrm(content, task, siblings)) continue;
        }
        extra.push(e.full);
      }
      for (const full of extra) {
        await fsp.rm(full, { force: true });
        removed++;
        await removeEmptyParents(path.dirname(full), mp.full);
      }
    }

    log.info(`重新生成 ${mp.rel}（${opts.mode}）：网盘 ${wanted.length} 个，生成 ${generated}，跳过 ${skipped}，删除 ${removed} ← 任务 ${task.id}`);
    if (generated + removed > 0) scheduleEmbyRefresh();
    return { mode: opts.mode, remoteFiles: wanted.length, generated, skipped, removed };
  });
}

/* ------------------------------- 校验 ------------------------------- */

const collapseSlashes = (p: string): string => p.replace(/\/{2,}/g, "/");
/** 比对用的归一：每段去首尾空格（网盘上真有 `Season 1 ` 这种名字，逐目录那条路也是 trim 过再比的） */
const trimSegs = (p: string): string => p.split("/").map((s) => s.trim()).join("/");
const dirOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf("/"), 0));
/** 和 collectFilesAndTopEmptyDirs 认文件的口径一致：末段带扩展名的是文件，否则是空目录 */
const looksLikeFile = (p: string): boolean => /\.[a-z0-9]+$/i.test(p.slice(p.lastIndexOf("/") + 1));

/** 一组路径最深的公共上级；空数组给 "" */
function commonDir(dirs: string[]): string {
  let segs: string[] | null = null;
  for (const d of dirs) {
    const s = d.split("/");
    if (segs === null) {
      segs = s;
      continue;
    }
    let i = 0;
    while (i < segs.length && i < s.length && segs[i] === s[i]) i++;
    segs = segs.slice(0, i);
  }
  return (segs ?? []).join("/");
}

type VerifyItem = { path: string; remotePath: string; name: string };

/**
 * 目录多的时候走这条：整棵子树拉一次在内存里比对，而不是一个目录问一次。
 * 115 是一次导出目录树，成本和目录数无关；夸克 / OpenList 是一次递归遍历，也比「每个目录先解析再列」省。
 * 同步任务和「重新生成」用的就是同一个接口，所以大范围校验并不比跑一次同步重。
 *
 * 和逐目录的一点差别：子树清单里只有文件（和没有文件的顶层空目录），
 * 所以目录还在、里面一个文件都没有的，这里报的是 dir-missing 而不是 file-missing——strm 一样是死的，只是措辞粗一点。
 */
async function verifyBySubtree(
  provider: DriveProvider,
  dirs: Array<[string, VerifyItem[]]>,
  result: StrmVerifyResult,
  signal?: AbortSignal,
): Promise<void> {
  const root = commonDir(dirs.map(([dir]) => dir));
  let listed: string[];
  try {
    listed = await provider.listSubtree(root, { signal });
  } catch (err) {
    if (err instanceof RemoteDirNotFoundError) {
      // 共同上级都没了，底下的自然全没
      for (const [, items] of dirs) {
        for (const it of items) result.missing.push({ path: it.path, remotePath: it.remotePath, reason: "dir-missing" });
      }
      return;
    }
    // 自己掐的不算这个目录查失败：记成 errors 的话，取消掉的一轮会以「缺失 0」收场
    if (isAbortError(err)) throw err;
    const msg = errMsg(err);
    // 封控 / cookie 失效：和逐目录那条一样整体中止
    if (provider.classifyError(err)) throw upstreamError(msg);
    result.errors.push({ remoteDir: root, message: msg });
    return;
  }

  const files = new Set<string>();
  const seenDirs = new Set<string>([trimSegs(root)]);
  for (const rel of listed) {
    const full = trimSegs(collapseSlashes(`${root}/${rel}`));
    if (looksLikeFile(full)) files.add(full);
    else seenDirs.add(full);
    for (let d = dirOf(full); d !== "" && !seenDirs.has(d); d = dirOf(d)) seenDirs.add(d);
  }
  for (const [dir, items] of dirs) {
    const exists = seenDirs.has(trimSegs(dir));
    for (const it of items) {
      if (files.has(trimSegs(it.remotePath))) continue;
      result.missing.push({ path: it.path, remotePath: it.remotePath, reason: exists ? "file-missing" : "dir-missing" });
    }
  }
}

export interface VerifyOptions {
  /** 客户端断开 / 主动取消：不再派新的活，进行中的网盘请求也跟着掐 */
  signal?: AbortSignal;
  /** 每前进一步报一次；节流交给上面的 verify$ */
  onProgress?: (progress: StrmVerifyProgress) => void;
}

/**
 * 校验的流式版：进度和结果一路推出去，退订就中止。
 *
 * 一次最多两万个 strm、再到网盘逐个目录确认，以前是一个干挂着的 POST：
 * 界面只有一个转圈、中途不能取消，反代 / Cloudflare 的空闲超时一掐整轮白跑
 * （后端还什么都不知道，照样在打网盘）。现在按 SSE 推，连接上一直有数据，
 * 关掉弹框就退订、活儿立刻停。
 *
 * 进度按时间节流：读两万个 strm 会产生两万条，界面只要看得到在动。
 * 每个阶段的第一条立刻发（leading），不然弹框开头有 250ms 是空的。
 */
export function verify$(
  task: TaskDefinition,
  provider: DriveProvider,
  rel: string,
  progressMs = 250,
): Observable<StrmVerifyEvent> {
  return new Observable<StrmVerifyEvent>((subscriber) => {
    const abort = new AbortController();
    const progress$ = new Subject<StrmVerifyProgress>();
    const sub = progress$
      .pipe(throttle(() => unrefTimer(progressMs), { leading: true, trailing: true }))
      .subscribe((progress) => subscriber.next({ type: "progress", progress }));
    verify(task, provider, rel, { signal: abort.signal, onProgress: (p) => progress$.next(p) }).then(
      (result) => {
        subscriber.next({ type: "done", result });
        subscriber.complete();
      },
      (err: unknown) => subscriber.error(err),
    );
    return () => {
      abort.abort();
      sub.unsubscribe();
      progress$.complete();
    };
  });
}

export async function verify(
  task: TaskDefinition,
  provider: DriveProvider,
  rel: string,
  opts: VerifyOptions = {},
): Promise<StrmVerifyResult> {
  const { signal } = opts;
  const report = (phase: StrmVerifyProgress["phase"], done: number, total: number, message: string) =>
    opts.onProgress?.({ phase, done, total, message });
  /** 没人听进度就别逐条构造对象和拼字符串（阻塞版那条路就没人听） */
  const ticker = (phase: StrmVerifyProgress["phase"], what: string) =>
    opts.onProgress ? (done: number, total: number) => report(phase, done, total, `${what} ${done}/${total}`) : undefined;
  signal?.throwIfAborted();
  report("collect", 0, 0, "正在收集本地 strm…");
  const mp = await resolveManagedPath(task, rel);
  const tasks = listTasks();
  const foreign = nestedForeignRoots(task, tasks);
  const siblings = sameRootSiblings(task, tasks);
  const { rels, truncated } = await collectStrm(mp, foreign, STRM_LIMITS.VERIFY_FILES, signal);
  if (truncated || rels.length > STRM_LIMITS.VERIFY_FILES) {
    throw new HttpError(400, `范围太大（超过 ${STRM_LIMITS.VERIFY_FILES} 个 strm），请选一个更小的目录分批校验`);
  }

  const result: StrmVerifyResult = { checked: 0, dirs: 0, missing: [], unparsable: [], errors: [], note: provider.notes?.verify ?? "" };
  const groups = new Map<string, VerifyItem[]>();
  report("read", 0, rels.length, `读取 ${rels.length} 个 strm…`);
  await forEachLimit(rels, 16, async (r) => {
    const full = path.join(mp.root, ...r.split("/"));
    let content: string | null;
    try {
      content = await readTextCapped(full, STRM_LIMITS.MAX_STRM_BYTES);
    } catch {
      content = null;
    }
    if (content === null) {
      result.checked++;
      result.unparsable.push({ path: r, reason: "empty" });
      return;
    }
    if (siblings.length > 0 && isForeignStrm(content, task, siblings)) return;
    result.checked++;
    const ins = inspectStrm(task, r, content);
    if (ins.actualRemote === null) {
      result.unparsable.push({ path: r, reason: ins.reason ?? "empty" });
      return;
    }
    // 用播放器真正会请求的路径去问，不用"应有"的
    const remotePath = collapseSlashes(ins.actualRemote);
    const dir = path.posix.dirname(remotePath);
    const item = { path: r, remotePath, name: path.posix.basename(remotePath) };
    const list = groups.get(dir);
    if (list) list.push(item);
    else groups.set(dir, [item]);
  }, { signal, onDone: ticker("read", "读取") });
  signal?.throwIfAborted();
  result.dirs = groups.size;

  // 这次校验的范围对应的网盘目录；内容指向它之外的（任务改过 originPath 的老 strm）子树那条路盖不到
  const rangeRel = extOf(mp.rel) === ".strm" ? dirOf(mp.rel) : mp.rel;
  const rangeRoot = trimSegs(collapseSlashes(rangeRel ? `${task.originPath}/${rangeRel}` : task.originPath).replace(/\/+$/, ""));
  const all = [...groups];
  const inside: Array<[string, VerifyItem[]]> = [];
  const outside: Array<[string, VerifyItem[]]> = [];
  for (const g of all) (isUnder(trimSegs(g[0]), rangeRoot) ? inside : outside).push(g);
  // 目录多到逐个问不划算：范围内的那些改成拉一次子树比对，范围外的零星几个仍然逐个问。
  // rangeRoot 为空（任务原路径就是网盘根）时不走这条，免得把整个网盘导出来
  const byTree = rangeRoot !== "" && all.length > STRM_LIMITS.VERIFY_DIRS && inside.length > 0 ? inside : [];
  const oneByOne = byTree.length > 0 ? outside : all;
  if (oneByOne.length > STRM_LIMITS.VERIFY_DIRS) {
    throw new HttpError(
      400,
      `有 ${oneByOne.length} 个网盘目录不在任务目录 ${rangeRoot} 之下（一次最多查 ${STRM_LIMITS.VERIFY_DIRS} 个），` +
        "多半是任务改过原路径，先用「修正内容」把这些 strm 指回现在的路径再校验",
    );
  }
  if (byTree.length > 0) {
    // total 0 = 不确定态：拉整棵子树是一趟不给中间进度的活儿，别让进度条冻在 0% 上装样子
    report("remote", 0, 0, `读取网盘目录树（覆盖 ${byTree.length} 个目录）…`);
    await verifyBySubtree(provider, byTree, result, signal);
    signal?.throwIfAborted();
  }

  report("remote", 0, oneByOne.length, oneByOne.length > 0 ? `到网盘确认 ${oneByOne.length} 个目录…` : "到网盘确认…");
  await forEachLimit(oneByOne, 4, async ([dir, items]) => {
    try {
      const node = await provider.resolvePath(dir, signal);
      if (!node || !node.isDir) {
        for (const it of items) result.missing.push({ path: it.path, remotePath: it.remotePath, reason: "dir-missing" });
        return;
      }
      const names = new Set((await provider.listDir(node.id, signal)).map((e) => e.name.trim()));
      for (const it of items) {
        if (!names.has(it.name.trim())) result.missing.push({ path: it.path, remotePath: it.remotePath, reason: "file-missing" });
      }
    } catch (err) {
      // 自己掐的不算这个目录查失败，整体中止
      if (isAbortError(err)) throw err;
      const msg = errMsg(err);
      // 封控 / cookie 失效：再问下去只会越问越糟，整体中止
      if (provider.classifyError(err)) throw upstreamError(msg);
      result.errors.push({ remoteDir: dir, message: msg });
    }
  }, { signal, onDone: ticker("remote", "到网盘确认") });
  signal?.throwIfAborted();
  result.missing.sort((a, b) => a.path.localeCompare(b.path));
  result.unparsable.sort((a, b) => a.path.localeCompare(b.path));
  const how = byTree.length > 0 ? `子树 ${byTree.length} + 逐个 ${oneByOne.length}` : "逐个";
  log.info(`校验 ${result.checked} 个 strm / ${result.dirs} 个网盘目录（${how}）：缺失 ${result.missing.length} ← 任务 ${task.id} ${mp.rel || "/"}`);
  return result;
}
