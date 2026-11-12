/**
 * strm 管理页的接口形状：按同步任务浏览本地 strm 输出目录、体检、校验、修正、重建。
 * 所有 path 都是 POSIX 风格、相对任务 targetPath 的路径，"" 表示任务根目录。
 */

import type { MediaBrief } from "./organize.js";

export type StrmEntryKind = "dir" | "strm" | "download" | "part" | "other";

export interface StrmEntry {
  name: string;
  isDir: boolean;
  kind: StrmEntryKind;
  /** 字节；目录为 0 */
  size: number;
  /** 毫秒时间戳 */
  mtime: number;
  /** 符号链接（目录不会被递归进入，删除只删链接本身） */
  isSymlink?: boolean;
}

export interface StrmListResult {
  path: string;
  /** 任务根目录还不存在（任务没跑过）时为 false，entries 为空；子目录不存在则是 404 */
  exists: boolean;
  entries: StrmEntry[];
}

export type StrmSearchHit = StrmEntry & { path: string };

export interface StrmSearchResult {
  hits: StrmSearchHit[];
  /** 命中数超过上限，只返回了前面一部分 */
  truncated: boolean;
}

/**
 * strm 内容解析不出 / 不该重写的原因：
 * empty 空文件；no-ext 内容最后一段没有扩展名；name-mismatch 内容里的文件名和本地文件名对不上（手改过或指错了文件）；
 * prefix-mismatch 前缀和任务现在的 strmPrefix 对不上（仍可按任务配置重写）
 */
export type StrmParseReason = "empty" | "no-ext" | "name-mismatch" | "prefix-mismatch";

export interface StrmFileInfo {
  path: string;
  content: string;
  /** 按任务当前 strmPrefix / originPath / enablePathEncoding 应有的内容 */
  expectedContent: string;
  /** 应有内容对应的网盘路径（不带前缀、未编码） */
  expectedRemotePath: string;
  /** 从现有内容解析出的网盘路径；解析不出为 null */
  actualRemotePath: string | null;
  matches: boolean;
  reason?: StrmParseReason;
  /** 这个网盘文件的实测媒体信息（整理页探测过或 Emby 回填过才有） */
  media?: MediaBrief;
}

/** POST /api/strm/media：一批 strm 的实测媒体信息，键是相对任务 targetPath 的路径；没有的不在里面 */
export interface StrmMediaResult {
  media: Record<string, MediaBrief>;
}

export type StrmIssueType =
  | "nested-same-name"
  | "empty-dir"
  | "stale-content"
  | "unparsable"
  | "duplicate-episode"
  | "leftover-part"
  | "nonstandard-name";

export interface StrmIssue {
  type: StrmIssueType;
  path: string;
  detail?: string;
  /** 同一问题涉及的其它路径（重复剧集的其余几份） */
  related?: string[];
}

export interface StrmScanResult {
  files: number;
  strm: number;
  dirs: number;
  /** 条目数超过上限，只扫描了一部分 */
  truncated: boolean;
  /** 落在扫描范围内、但属于其它任务的输出目录，整棵跳过 */
  skippedRoots: string[];
  /** 每类问题的总数；issues 里每类最多列出一部分 */
  counts: Record<StrmIssueType, number>;
  issues: StrmIssue[];
}

export interface StrmRewriteResult {
  dryRun: boolean;
  checked: number;
  changed: number;
  /** 同一目录里属于其它任务的 strm，跳过不动 */
  foreign: number;
  skippedRoots: string[];
  unparsable: Array<{ path: string; reason: StrmParseReason }>;
  /** 前几条 from → to 样例 */
  samples: Array<{ path: string; from: string; to: string }>;
}

export type StrmRegenerateMode = "fill" | "rebuild";

export interface StrmRegenerateResult {
  mode: StrmRegenerateMode;
  /** 从 115 导出到的文件数（按 strm 扩展名过滤后） */
  remoteFiles: number;
  generated: number;
  skipped: number;
  /** rebuild 时删掉的本地多余 strm 数 */
  removed: number;
}

export interface StrmVerifyResult {
  checked: number;
  dirs: number;
  missing: Array<{ path: string; remotePath: string; reason: "dir-missing" | "file-missing" }>;
  unparsable: Array<{ path: string; reason: StrmParseReason }>;
  /** 某个网盘目录没查成功（网络等原因），这些文件既不算缺失也不算存在 */
  errors: Array<{ remoteDir: string; message: string }>;
  /** 给界面看的说明：115 目录缓存有延迟，刚转存 / 刚删的可能误报 */
  note: string;
}

/**
 * 校验的进度。校验一个大目录要读上万个 strm、再到网盘逐个目录确认，
 * 整个过程按 SSE 推给界面（POST /api/strm/verify/stream），不再让请求干挂着。
 */
export interface StrmVerifyProgress {
  /** collect = 收集本地 strm；read = 读 strm 解析出网盘路径；remote = 到网盘确认 */
  phase: "collect" | "read" | "remote";
  done: number;
  /** 0 = 还不知道总数（collect 阶段） */
  total: number;
  message: string;
}

/** 校验流上的一条事件；done 带最终结果，error 带没能完成的原因 */
export type StrmVerifyEvent =
  | { type: "progress"; progress: StrmVerifyProgress }
  | { type: "done"; result: StrmVerifyResult }
  | { type: "error"; message: string };

export interface StrmDeleteResult {
  deleted: number;
  failed: Array<{ path: string; message: string }>;
}

/**
 * 一个目录的海报。按四级回退拿：
 *   local 目录里现成的图片：刮削器写的 poster / folder / cover，或者跟 strm 同名的那张
 *         （默认 downloadExtensions 带 .jpg/.png，图片跟着片子从网盘下过来，名字就是片名）
 *   tmdb  目录名里的 id 标签或本地 nfo 给出 tmdbId，再查 TMDB 缓存
 *   run   这个任务整理过的记录里存着的识别结果
 */
export type StrmPosterSource = "local" | "tmdb" | "run";

export interface StrmPoster {
  source: StrmPosterSource;
  /** local 是相对任务根的图片路径（要走 /api/strm/image 取），其余是图片外链 */
  url: string;
  title?: string;
  year?: string;
  tmdbId?: number;
  /**
   * 目录里其实有本地图，但太大，换成了这张外链小图（任务页那面墙才会换）：本地那张的路径留作后备，
   * 浏览器连不上外链时退回去用它
   */
  fallback?: string;
}

export interface StrmPosterResult {
  /** 键是请求里给的目录路径；没拿到海报的目录不出现 */
  posters: Record<string, StrmPoster>;
  /** 有线索的目录（本地图 / id 标签 / nfo / 整理记录），不管最后拿没拿到图；strm 页拿它数「认出来几个」 */
  known: string[];
  /**
   * 还值得联网问一遍的目录：有 id 线索、离线的几级没问到答案。没配 TMDB key 时是空的（问了也没处问）；
   * 这一次联网问过的（有图，或者 TMDB 说没有）不再算。网格视图先发离线的一遍，再拿这份名单分批联网补
   */
  pending: string[];
  /** 这一次去 TMDB 现查时连不上（不是 TMDB 说没有）：这个目录列表里剩下的别再问了，每问一批都要白等一回超时 */
  unreachable?: true;
}

/** 全库抽出来的一张海报：带上它是哪个任务、哪个作品目录的（local 的图要拿 taskId 去取） */
export interface StrmPosterRef extends StrmPoster {
  taskId: string;
  /** 作品目录，相对任务根 */
  path: string;
}

export interface StrmAllPostersResult {
  /** 修改时间新的作品在前；同一张图只出现一次 */
  posters: StrmPosterRef[];
}
