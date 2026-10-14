/**
 * 分享追更：盯住一个网盘分享（115 / 夸克）里的目录，周期性地把新增的文件转存到某个同步任务的目录并生成 strm。
 */

export type ShareFollowStatus = "idle" | "checking" | "error" | "expired" | "stale";

/**
 * 快照里的一条：路径相对被盯的目录（watchCid），目录不带尾部斜杠。
 * 身份靠 sha1（115 有）或分享内的 id（夸克没有 sha1，fid 在同一个分享里稳定）认改名和搬家。
 */
export interface ShareFollowEntry {
  path: string;
  isDir: boolean;
  sha1?: string;
  size?: number;
  id?: string;
}

/** 一次有动静的检查：新增了什么、跳过了什么（被替换 / 改名 / 范围目录不见了）、出了什么错 */
export interface ShareFollowRun {
  /** ms */
  at: number;
  /** 这次转存成功的相对路径 */
  added: string[];
  /** "路径：原因" */
  skipped: string[];
  /** 生成的 strm 数 */
  generated: number;
  error?: string;
}

/**
 * 追更转存来的文件整理过之后记下的结果。分享里这个目录以后来的新文件交给整理时照着用（作品、季、集偏移），
 * 不用再认一遍，改过的季也不会丢；之后在整理页又动了这批文件（换匹配、改季）就跟着改，撤销那次整理就退回去。只记剧集
 */
export interface ShareFollowOrganized {
  /** 分享里的目录（相对被盯目录，"" 是被盯目录本身）：只管直接放在这一层的文件 */
  dir: string;
  mediaType: "tv";
  tmdbId: number;
  title: string;
  year: string;
  /** 整理时人定的季：新文件照样强制用 */
  season: number | null;
  /** 没人定季时，这批文件最后落到的季（都一样才记）：新文件自己什么季都没给时才用 */
  seasonFallback: number | null;
  /** 整理时的集偏移：新文件照样加 */
  episodeOffset: number;
  /** 作品目录（相对任务 originPath） */
  workDir: string;
  /** 这批视频现在所在的目录（相对任务 originPath）：之后整理页挪走这里的视频，就是在改这条记录 */
  filesDir: string;
  /** 这批文件原名里的片名（归一过）：新文件写了片名、又对不上的不沿用（同一个目录里混着别的剧） */
  titles: string[];
  /** 最后一次真改了它的整理；撤销那次整理就退回 prev（上一版，往前最多留几层），没有 prev 就删 */
  runId: string;
  prev: ShareFollowOrganized | null;
  /** ms */
  at: number;
}

export interface ShareFollow {
  id: string;
  name: string;
  /** 从影库条目建的订阅记一下来源，界面借它的封面；条目删了也不影响订阅 */
  libraryId: string | null;
  shareUrl: string;
  shareCode: string;
  receiveCode: string;
  /** 被盯的分享目录 id，"0" 是分享根目录 */
  watchCid: string;
  /** 展示用：被盯目录在分享里的路径 */
  watchPath: string;
  /**
   * 追更范围，相对 watchCid：`[""]` 表示整个被盯目录（勾了文件时），
   * 否则是勾选的目录名列表（只追这些目录里面的新增）
   */
  scope: string[];
  taskId: string;
  /** 相对 task.originPath 的子目录，已 normalize；空串表示就在 originPath 下 */
  subPath: string;
  enabled: boolean;
  intervalMinutes: number;
  status: ShareFollowStatus;
  lastError: string;
  /** 连续失败次数：退避和"分享失效"判定都看它 */
  errorStreak: number;
  /** ms */
  lastCheckedAt: number | null;
  /** 最近一次真的转存了东西的时间（ms）；判 60 天没更新用 */
  lastChangeAt: number | null;
  /** ms；循环挑到期的看它 */
  nextCheckAt: number;
  known: ShareFollowEntry[];
  /** 最近 20 次有动静的检查，新的在前 */
  recent: ShareFollowRun[];
  /** 整理结果：分享里各目录的新文件交给整理时照着用（见 ShareFollowOrganized） */
  organized: ShareFollowOrganized[];
  /** unix 秒 */
  createdAt: number;
  updatedAt: number;
}

/** 列表接口给的是这个：不带快照本身，只给条数 */
export type ShareFollowSummary = Omit<ShareFollow, "known"> & { knownCount: number };
