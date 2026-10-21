/**
 * 按本地 strm 的目录结构整理网盘（整理 run 的 naming = "local"）。
 *
 * 用别的媒体整理工具在本地给 strm 改了名、挪了目录之后，strm 的内容仍指着网盘上原来的文件：
 *   本地 Movies/2024/片名/片名.strm → 内容 /前缀/video/Movies/原名.mkv
 * 这里按内容找到源文件、按本地相对路径定目标（保留源文件自己的扩展名），生成和 planUnit 同样形状的计划项，
 * 后面的冲突检测 / 建删目录 / 执行 / 撤销 / 本地镜像全部沿用。不识别、不套模板、永远不删网盘文件。
 *
 * 映射规则（纯函数，改动先过 local-naming.test.ts）：
 *   - 内容去掉任务前缀（原样或 encodeURI 过的）、原样和按段解码各试一次，必须落在 originPath 之下；对不上的是别的任务 / 手改过的，不猜
 *   - 一个源文件只能有一个 strm 指着：多个就跳过并把它们列出来
 *   - 源和目标一样 → keep；源不在这次范围里 / 已不在网盘上 → 只计数，不成项
 *   - 同目录下和视频同名前缀的字幕 / nfo / 图片跟着视频走（新 stem + 原后缀）；目标被占就留在原处，不算冲突
 *   - 单元 = 本地的作品目录：strm 的父目录，父目录是季目录（Season 01 / S1 / 第 2 季 / Specials）就上一级
 */
import path from "node:path";
import type { OrganizeConflictResolution, TaskDefinition } from "@openstrm/shared";
import { readTextCapped, walkTree } from "../../lib/fs.js";
import { resolveInDataDir } from "../../paths.js";
import { showDirOf } from "../strm/inspect.js";
import { nestedForeignRoots } from "../strm/manage.js";
import { decodeSegments, safeDecode, stripStrmExt } from "../strm/naming.js";
import { isStagingDir } from "../strm/staging.js";
import { parseMediaName } from "./parse-name.js";
import { withExt, EXCLUDED_REASON, actionFor, renameVariants, type UnitPlan } from "./plan.js";
import { fileKindOf, type ScopeEntry, type Unit, type UnitFile } from "./units.js";

/** 本地结构的单元 key 前缀：run-state 里按它认出「没有 TMDB 匹配也算排上了」的单元 */
export const LOCAL_UNIT_PREFIX = "local:";
export const isLocalUnitKey = (key: string): boolean => key.startsWith(LOCAL_UNIT_PREFIX);

const EXT_RE = /^\.[a-z0-9]{1,10}$/i;
const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const joinDir = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i) : "";
};
const stemOf = (name: string): string => {
  const ext = extOf(name);
  return ext ? name.slice(0, -ext.length) : name;
};
const under = (p: string, dir: string): boolean => dir === "" || p === dir || p.startsWith(`${dir}/`);

/* ------------------------------- 内容 → 网盘路径 ------------------------------- */

export type StrmContentProblem = "empty" | "no-ext" | "foreign";

/**
 * 一个 strm 的内容指着任务 originPath 下的哪个文件（相对 originPath）。
 * 回两个候选：原样的和按段解码的（任务改过编码设置、或名字里本来就带 % 时只有一个对得上），由调用方看网盘上哪个在
 */
export function remoteOfStrmContent(task: TaskDefinition, content: string): { candidates: string[] } | { problem: StrmContentProblem } {
  const trimmed = content.trim();
  if (!trimmed) return { problem: "empty" };
  const ext = path.posix.extname(safeDecode(baseOf(trimmed)));
  if (!EXT_RE.test(ext) || ext.toLowerCase() === ".strm") return { problem: "no-ext" };
  const prefix = task.strmPrefix ?? "";
  let rest: string | null = null;
  for (const p of new Set([prefix, encodeURI(prefix)])) {
    const head = `${p}/`;
    if (trimmed.startsWith(head)) {
      rest = trimmed.slice(head.length);
      break;
    }
  }
  if (rest === null) return { problem: "foreign" };
  const origin = task.originPath.replace(/^\/+|\/+$/g, "");
  const candidates = [...new Set([rest, decodeSegments(rest)])]
    .filter((p) => p.startsWith(`${origin}/`))
    .map((p) => p.slice(origin.length + 1))
    .filter(Boolean);
  return candidates.length > 0 ? { candidates } : { problem: "foreign" };
}

/* ------------------------------- 本地索引 ------------------------------- */

export interface LocalStrm {
  /** 相对任务 targetPath，带 .strm */
  localRel: string;
  /** 内容指向的网盘文件的候选（相对 originPath）；解析不出为空数组 */
  candidates: string[];
  problem?: StrmContentProblem;
}

export interface LocalStrmIndex {
  strms: LocalStrm[];
  /** 超过上限，后面的没读 */
  truncated: boolean;
}

/** 本地任务目录下全部 strm 的内容索引。跳过暂存区（归档 / 重复文件）和嵌在里面的别的任务的根目录 */
export async function indexLocalStrm(task: TaskDefinition, tasks: TaskDefinition[], opts: { limit: number; signal?: AbortSignal; concurrency?: number }): Promise<LocalStrmIndex> {
  const root = resolveInDataDir(task.targetPath);
  if (!root) throw new Error(`任务的本地目录越出了数据目录：${task.targetPath}`);
  const foreign = nestedForeignRoots(task, tasks);
  const skipDir = (rel: string) => isStagingDir(rel) || foreign.some((f) => under(rel, f));
  const paths: Array<{ rel: string; full: string }> = [];
  let truncated = false;
  for await (const e of walkTree(root, { skipDir })) {
    opts.signal?.throwIfAborted();
    if (e.isDir || !e.name.toLowerCase().endsWith(".strm")) continue;
    if (paths.length >= opts.limit) {
      truncated = true;
      break;
    }
    paths.push({ rel: e.rel, full: e.full });
  }
  const strms: LocalStrm[] = new Array(paths.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= paths.length) return;
      opts.signal?.throwIfAborted();
      const content = await readTextCapped(paths[i].full, 4096);
      const r = content === null ? { problem: "foreign" as const } : remoteOfStrmContent(task, content);
      strms[i] = "candidates" in r ? { localRel: paths[i].rel, candidates: r.candidates } : { localRel: paths[i].rel, candidates: [], problem: r.problem };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 16, paths.length)) }, worker));
  return { strms, truncated };
}

/* ------------------------------- 映射成单元 ------------------------------- */

export interface LocalUnitFile {
  file: UnitFile;
  /** 目标（相对 originPath）；和 file.path 一样就是不动 */
  dst: string;
  role: "video" | "sidecar";
  /** 附属文件跟着哪个视频（相对 originPath） */
  follows?: string;
  /** 跳过的原因（多个 strm 指着它、目标在暂存区）；有就不挪 */
  skip?: string;
}

export interface LocalUnit {
  key: string;
  /** 本地的作品目录（相对 originPath，也就是整理后的目标目录）；"" 是任务根 */
  dstRoot: string;
  /** 这些源文件共同所在的网盘目录；不在同一棵下就取共同的祖先（可能是 ""） */
  rootPath: string;
  rawName: string;
  files: LocalUnitFile[];
  notes: string[];
}

export interface LocalMappingSummary {
  /** 本地 strm 总数 */
  strms: number;
  /** 内容解析不出、或指着别的任务 / 别的前缀的 */
  foreign: number;
  /** 指着这次范围之外的 */
  outside: number;
  /** 指着范围里、但网盘上已经没有的 */
  missing: number;
  /** 对上了范围里的文件 */
  matched: number;
  /** 其中要改名 / 挪动的 */
  moving: number;
  /** 其中已经和本地一样的 */
  unchanged: number;
  /** 一个文件被多个 strm 指着（跳过） */
  duplicates: number;
  truncated: boolean;
}

export interface LocalMapping {
  units: LocalUnit[];
  summary: LocalMappingSummary;
}

const SIDECAR_KINDS = new Set(["subtitle", "nfo", "image"]);

function toUnitFile(entry: ScopeEntry, videoExts: Set<string>): UnitFile {
  const name = baseOf(entry.path);
  const ext = extOf(name).toLowerCase();
  const stem = stemOf(name);
  return { path: entry.path, name, stem, ext, kind: fileKindOf(name, videoExts), parsed: parseMediaName(stem), id: entry.id, size: entry.size, inExtrasDir: false };
}

/** 一组路径共同的祖先目录（相对 originPath；没有共同的就是 ""） */
function commonDir(dirs: string[]): string {
  if (dirs.length === 0) return "";
  let segs = dirs[0].split("/").filter(Boolean);
  for (const d of dirs.slice(1)) {
    const other = d.split("/").filter(Boolean);
    let n = 0;
    while (n < segs.length && n < other.length && segs[n] === other[n]) n++;
    segs = segs.slice(0, n);
    if (segs.length === 0) break;
  }
  return segs.join("/");
}

/**
 * 把本地索引对到范围里的文件上，按本地作品目录分成单元。
 * inScope：路径在这次列过的范围里（指着范围外的只计数）；videoExts：哪些扩展名算视频（附属文件只认字幕 / nfo / 图片）
 */
export function mapLocalStrm(entries: ScopeEntry[], index: LocalStrmIndex, opts: { videoExts: Set<string>; inScope: (rel: string) => boolean }): LocalMapping {
  const summary: LocalMappingSummary = { strms: index.strms.length, foreign: 0, outside: 0, missing: 0, matched: 0, moving: 0, unchanged: 0, duplicates: 0, truncated: index.truncated };
  const byPath = new Map<string, ScopeEntry>();
  for (const e of entries) if (!e.isDir) byPath.set(e.path, e);

  // 源文件 → 指着它的 strm
  const byRemote = new Map<string, LocalStrm[]>();
  for (const s of index.strms) {
    if (s.problem || s.candidates.length === 0) {
      summary.foreign++;
      continue;
    }
    const remote = s.candidates.find((c) => byPath.has(c));
    if (remote === undefined) {
      if (s.candidates.some((c) => opts.inScope(c))) summary.missing++;
      else summary.outside++;
      continue;
    }
    byRemote.set(remote, [...(byRemote.get(remote) ?? []), s]);
  }

  interface Video {
    file: UnitFile;
    dst: string;
    skip?: string;
  }
  const videos: Video[] = [];
  for (const [remote, strms] of byRemote) {
    const entry = byPath.get(remote)!;
    const file = toUnitFile(entry, opts.videoExts);
    summary.matched++;
    if (strms.length > 1) {
      summary.duplicates++;
      videos.push({ file, dst: file.path, skip: `多个 strm 指向这个文件：${strms.map((s) => s.localRel).join("、")}` });
      continue;
    }
    const localRel = strms[0].localRel;
    const dst = `${stripStrmExt(localRel)}${extOf(file.name)}`;
    if (isStagingDir(dst)) {
      videos.push({ file, dst: file.path, skip: "本地放在暂存区（归档 / 重复文件）里，网盘上不往那里挪" });
      continue;
    }
    if (dst === file.path) summary.unchanged++;
    else summary.moving++;
    videos.push({ file, dst });
  }

  // 附属文件：同目录、同名前缀的字幕 / nfo / 图片跟着视频；一个附属只跟一个视频（stem 最长的那个），被 strm 指着的视频不算附属。
  // 不动的视频也带上它的附属（都是 keep）：预览里给视频改了名，附属才有得跟
  const byDir = new Map<string, ScopeEntry[]>();
  for (const e of byPath.values()) byDir.set(dirOf(e.path), [...(byDir.get(dirOf(e.path)) ?? []), e]);
  const claimed = new Set<string>(videos.map((v) => v.file.path));
  const sidecarsOf = new Map<Video, LocalUnitFile[]>();
  for (const v of [...videos].sort((a, b) => b.file.stem.length - a.file.stem.length)) {
    const list: LocalUnitFile[] = [];
    if (!v.skip) {
      const dstStem = `${dirOf(v.dst) ? `${dirOf(v.dst)}/` : ""}${stemOf(baseOf(v.dst))}`;
      for (const e of byDir.get(dirOf(v.file.path)) ?? []) {
        if (claimed.has(e.path)) continue;
        const name = baseOf(e.path);
        const stem = stemOf(name);
        if (!(stem === v.file.stem || stem.startsWith(`${v.file.stem}.`) || stem.startsWith(`${v.file.stem}-`))) continue;
        const file = toUnitFile(e, opts.videoExts);
        if (!SIDECAR_KINDS.has(file.kind)) continue;
        claimed.add(e.path);
        list.push({ file, dst: `${dstStem}${name.slice(v.file.stem.length)}`, role: "sidecar", follows: v.file.path });
      }
    }
    sidecarsOf.set(v, list);
  }

  // 按本地作品目录分单元
  const units = new Map<string, LocalUnit>();
  for (const v of videos) {
    const dir = showDirOf(v.dst);
    const key = `${LOCAL_UNIT_PREFIX}${dir}`;
    let u = units.get(key);
    if (!u) {
      u = { key, dstRoot: dir, rootPath: "", rawName: dir ? baseOf(dir) : "（任务根目录）", files: [], notes: [] };
      units.set(key, u);
    }
    u.files.push({ file: v.file, dst: v.dst, role: "video", skip: v.skip });
    for (const s of sidecarsOf.get(v) ?? []) u.files.push(s);
  }
  for (const u of units.values()) {
    u.rootPath = commonDir([...new Set(u.files.filter((f) => f.role === "video").map((f) => dirOf(f.file.path)))]);
    const dup = u.files.filter((f) => f.role === "video" && f.skip);
    if (dup.length > 0) u.notes.push(`${dup.length} 个文件被多个 strm 指着，没法确定该叫什么，这次不动`);
  }
  return { units: [...units.values()].sort((a, b) => a.key.localeCompare(b.key)), summary };
}

/** 给 PlanState.units 用的单元结构：引用数 / 删空目录的边界那些逻辑只看 key、rootPath 和文件路径 */
export function toSyntheticUnit(u: LocalUnit): Unit {
  return { key: u.key, rootPath: u.rootPath, rawName: u.rawName, parsed: parseMediaName(u.rawName), kindHint: "unknown", files: u.files.map((f) => f.file), ownsDir: false };
}

/* ------------------------------- 规划 ------------------------------- */

export interface LocalPlanInput {
  selected: boolean;
  /** 用户单独取消勾选的文件（相对 originPath） */
  excluded?: ReadonlySet<string>;
  /** 用户给冲突项选的处理（相对 originPath） */
  resolutions?: ReadonlyMap<string, OrganizeConflictResolution>;
  /** 按文件改的目标文件名（相对 originPath → 文件名）：目录照旧，没写扩展名就补上；跟着的字幕 / nfo 按新名字跟 */
  renames?: ReadonlyMap<string, string>;
}

/** 本地结构的单元 → 计划项（和 planUnit 同样的形状；冲突办法、附属文件跟随都交给 finalizeItems） */
export function planLocalUnit(unit: LocalUnit, input: LocalPlanInput): UnitPlan {
  const items: UnitPlan["items"] = [];
  const excluded = input.excluded ?? new Set<string>();
  /** 用户改过名的目标：视频按填的名字，跟着它的附属文件按视频的新主名重算 */
  const byPath = new Map(unit.files.map((f) => [f.file.path, f]));
  const dstOf = (f: LocalUnitFile): string => {
    const own = input.renames?.get(f.file.path)?.trim();
    if (own) return joinDir(dirOf(f.dst), withExt(own, f.file.ext));
    const owner = f.role === "sidecar" && f.follows ? byPath.get(f.follows) : undefined;
    const ownerName = owner ? input.renames?.get(owner.file.path)?.trim() : undefined;
    if (!owner || !ownerName) return f.dst;
    const stem = withExt(ownerName, owner.file.ext).replace(/\.[^./]+$/, "");
    return joinDir(dirOf(f.dst), `${stem}${f.file.name.slice(owner.file.stem.length)}`);
  };
  for (const f of unit.files) {
    const file = f.file;
    const base = { unitKey: unit.key, kind: file.kind, srcPath: file.path, nodeId: file.id ?? "" };
    const dst = dstOf(f);
    if (!input.selected) {
      items.push({ ...base, action: "skip", dstPath: file.path, reason: "未勾选" });
      continue;
    }
    if (f.skip) {
      items.push({ ...base, action: "skip", dstPath: file.path, reason: f.skip });
      continue;
    }
    if (excluded.has(file.path)) {
      items.push({ ...base, action: "skip", dstPath: file.path, reason: EXCLUDED_REASON });
      continue;
    }
    if (dst === file.path) {
      items.push({ ...base, action: "keep", dstPath: file.path, reason: "已经和本地一样" });
      continue;
    }
    const r = input.resolutions?.get(file.path);
    const resolve = r?.how;
    const customName = r?.how === "custom" && r.name?.trim() ? withExt(r.name.trim(), file.ext) : undefined;
    items.push({
      ...base,
      action: actionFor(file.path, dst),
      dstPath: dst,
      reason: "",
      resolve,
      variants: resolve === "rename" ? renameVariants(dst, file) : undefined,
      customName,
      ...(f.role === "sidecar" ? { follows: [f.follows!], soft: true } : {}),
    });
  }
  return { unitKey: unit.key, dstRoot: unit.dstRoot, items, notes: [...unit.notes], episodes: {} };
}
