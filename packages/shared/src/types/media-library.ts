import type { OrganizeCandidate } from "./organize.js";

export type ScrapeStatus = "pending" | "done" | "failed";
export type MediaType = "movie" | "tv" | "collection" | "unknown";

/** 抄目录树建索引：pending 排队 / indexing 在抄 / done 抄完 / failed 停了 */
export type LibraryIndexStatus = "pending" | "indexing" | "done" | "failed";

/** 分享死活：unknown 没查过 / ok / suspect 疑似失效（等复查）/ expired 已失效 / locked 提取码不对 */
export type LibraryShareStatus = "unknown" | "ok" | "suspect" | "expired" | "locked";

export interface LibraryShareHealth {
  status: LibraryShareStatus;
  /** 最近一次失败时网盘说的原话（截短） */
  reason: string;
  /** unix 秒；没查过是 null */
  checkedAt: number | null;
  expiredAt: number | null;
}

/** 影库里的一个来源：收藏的一个分享，或者其中一个目录 */
export interface MediaLibraryEntry {
  id: string;
  shareUrl: string;
  shareCode: string;
  receiveCode: string;
  sharePath: string;
  shareRootCid: string;
  rawName: string;
  title: string;
  fileCount: number;
  coverUrl: string;
  tags: string[];
  notes: string;
  mediaType: MediaType;
  tmdbId: number | null;
  year: string;
  overview: string;
  scrapeStatus: ScrapeStatus;
  createdAt: number;
  updatedAt: number;
  /** 分享自己的标题（「老K」）；老数据抄过一次才有 */
  shareTitle: string;
  indexStatus: LibraryIndexStatus;
  indexError: string;
  /** 最近一次抄完的时间（unix 秒）；没抄完过是 null */
  indexedAt: number | null;
  /** 本轮已经发现的目录数 / 已经列过下一层的目录数 */
  dirsTotal: number;
  dirsListed: number;
  /** 最近一次抄完时的统计：节点（目录 + 文件）、视频文件、总大小（字节） */
  nodeCount: number;
  videoCount: number;
  totalSize: number;
  /** 超过单个来源的上限，没抄完 */
  truncated: boolean;
  /** 所在分享的死活；列表接口带，别处可能没有 */
  health?: LibraryShareHealth;
  /** 切出来的作品单元：几个、认出几个、还有几个等着认；整个来源就一部作品时带它的海报和名字 */
  works?: { total: number; identified: number; pending: number; poster: string; title: string };
}

/** 搜索结果里目录下的一个文件（给人 / 智能体判断对不对：英文原名、年份、集数都在这） */
export interface LibraryHitFile {
  name: string;
  size: number | null;
}

/** 面包屑的一段：id 是分享里的目录 id，打开分享弹框时直接定位 */
export interface LibraryCrumb {
  id: string;
  name: string;
}

/** 影库搜索的一条：一个目录 */
export interface LibraryHit {
  sourceId: string;
  /** 这个目录在分享里的 id（share_inspect 的 dirId；share_save 的 itemIds） */
  nodeId: string;
  /** 上一级目录的 id（share_save 的 dirId）；分享根下的是 "0" */
  parentId: string;
  name: string;
  /** 分享内完整路径，不带前导 / */
  path: string;
  /** 从分享根到它自己（含自己），打开弹框用 */
  crumbs: LibraryCrumb[];
  shareKind: "115" | "quark";
  shareCode: string;
  /** 带提取码的链接 */
  shareUrl: string;
  shareTitle: string;
  /** 夸克转存要的 share_fid_token（115 没有） */
  token?: string;
  /** 子树合计大小；没抄完是 null */
  size: number | null;
  /** 视频文件数：子树合计（剧目录的视频在季目录里）；没抄完的只算直接放着的 */
  videoCount: number;
  /** 视频样例：直接放着的取前几个（三个以内按大小、正片在前，多了按名字）；没有的从第一个有视频的子目录（季目录）里按名字取 */
  files: LibraryHitFile[];
  /** 直接放着的视频一个都没有时，下一层的目录名（按名字前几个）：季目录、版本目录，一看就知道里面是什么 */
  subdirs: string[];
  /** 下一层一共几个目录（subdirs 只给前几个）；有直接视频的不数，是 0 */
  subdirCount: number;
  /** 从名字认出的画质 / 片源 / 音轨 / 字幕 / 季集 / 体积标签；自己名字里没有的取下一层目录名的 */
  tags: string[];
  /** 名字里就有全部关键词 / 靠里面的文件名 / 只靠路径（上级目录）命中 */
  matched: "name" | "files" | "path";
  /** 收进这一条的子目录命中数 */
  childHits: number;
  /** 从名字提的片名（去掉发布信息和年份）：失效了拿它找替代 */
  keyword: string;
  health: LibraryShareHealth;
  /** 来源最近一次抄完的时间；还没抄完是 null */
  indexedAt: number | null;
  /** 这个目录是（或者在）一部认出来的作品：海报、正式名、年份 */
  work?: LibraryWorkRef;
}

/** 单元识别的把握：high 标题年份都对上（或手动指定）/ medium / low 待确认 / none 没认出 */
export type LibraryConfidence = "high" | "medium" | "low" | "none";
/** pending 待认 / done 认过（没认出是 confidence none）/ manual 手动指定 / ignored 不是影视 */
export type LibraryUnitStatus = "pending" | "done" | "manual" | "ignored";

/** 认出来的是 TMDB 上哪一部 */
export interface LibraryWorkRef {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  year: string;
  posterUrl: string;
  confidence: LibraryConfidence;
}

/** 作品单元：从抄来的目录树里切出来的一部电影 / 一部剧，和它认成了什么 */
export interface LibraryUnit {
  sourceId: string;
  unitKey: string;
  /** 单元根目录的节点 id（打开分享详情定位到这里；ownsDir 时转存它） */
  nodeId: string;
  /** 根目录的上一级（转存时的 dirId） */
  parentId: string;
  path: string;
  crumbs: LibraryCrumb[];
  rawName: string;
  /** 根目录就是这部作品自己的：转存整个目录；否则转存 fileIds */
  ownsDir: boolean;
  fileIds: string[];
  /** 转存交这些：自己的目录就是这个目录；散放在分类目录里的是那几个文件。parentId 给夸克在转存那次会话里换新 token */
  saveItems: Array<{ id: string; name: string; isDir: boolean; parentId: string; token?: string }>;
  parsedTitle: string;
  parsedYear: string;
  kindHint: "movie" | "tv" | "unknown";
  seasons: number[];
  videoCount: number;
  size: number;
  sampleFile: string;
  /** 从目录名 / 样例文件名认出的画质标签 */
  tags: string[];
  status: LibraryUnitStatus;
  /** 认出来的；没认出 / 待认 / 忽略是 null */
  work: (LibraryWorkRef & { originalTitle: string; enTitle: string; reason: string }) | null;
  /** 识别时的备选：换匹配时先列这些 */
  candidates: OrganizeCandidate[];
  shareKind: "115" | "quark";
  shareCode: string;
  shareUrl: string;
  shareTitle: string;
  /** 夸克转存要的 share_fid_token（根目录的）；转存时后端会重新拿 */
  token?: string;
  health: LibraryShareHealth;
  identifiedAt: number | null;
  error: string;
}

/** 海报墙上的一张卡：同一个 tmdbId 的单元合在一起；没认出的单元自己一张 */
export interface LibraryWork {
  /** `movie:123` / `tv:456`；没认出的是 `unit:<sourceId>:<unitKey>` */
  key: string;
  tmdbId: number | null;
  mediaType: "movie" | "tv" | null;
  title: string;
  year: string;
  posterUrl: string;
  /** 几个单元里最有把握的那个 */
  confidence: LibraryConfidence;
  /** 几个单元（版本 / 季） */
  versions: number;
  /** 来自几个分享 */
  shares: number;
  videoCount: number;
  /** 单元里最大的那个 */
  size: number;
  seasons: number[];
  /** 最近一个单元入库的时间 */
  addedAt: number;
  /** 已经有了：本地 strm 目录里认得出是这一部，或者从收藏夹转存过（没标的不等于没有：没整理过的目录认不出） */
  owned?: boolean;
  /** TMDB 类型编号、国家 / 地区代码（认出来以后从详情补的，还没补上时没有） */
  genres?: number[];
  countries?: string[];
  /** 各版本标题里认出的标签并起来（4K / 杜比视界 / 中字 …），海报角标用；没有就不带 */
  tags?: string[];
}

export type LibraryWorksView = "all" | "movie" | "tv" | "low" | "none";
export type LibraryWorksSort = "recent" | "year" | "title";

export interface LibraryWorksResult {
  works: LibraryWork[];
  total: number;
  counts: { all: number; movie: number; tv: number; low: number; none: number; pending: number };
  /** 配了 TMDB 才识别 */
  tmdbConfigured: boolean;
  /** 本地已有的还在扫（第一次要扫一遍各任务的本地目录）：这次的 owned 只算了从收藏夹存过的，过几秒再拉一次 */
  ownedPending?: boolean;
}

/** 收藏夹里的一部作品「已经有了」 */
export interface LibraryOwned {
  /** local：本地 strm 目录里认出来的；saved：从收藏夹转存过 */
  via: "local" | "saved";
  taskId: string;
  /** 任务：「账号 · 网盘路径」 */
  taskLabel: string;
  /** local：作品目录，相对任务的本地 strm 目录；saved：存进去的那个目录（分享里的名字） */
  path: string;
  /** 剧有哪几季：local 看季目录，saved 看存的那个单元 */
  seasons: number[];
  /** saved：什么时候存的（秒） */
  savedAt?: number;
}

/** 一部剧的几季一季一个目录、分开放在同一个目录下：能一起转存（作品弹框「一起转存」、智能体 library_work 的 seriesSave） */
export interface LibrarySeriesGroup {
  /** 装着这几季的目录（在分享根上的是分享标题） */
  folder: string;
  seasons: number[];
  /** `<sourceId>:<unitKey>`，按季排好 */
  units: string[];
}

export interface LibraryWorkDetail {
  work: LibraryWork;
  units: LibraryUnit[];
  owned: LibraryOwned[];
  seriesGroups: LibrarySeriesGroup[];
}

export interface LibrarySearchResult {
  hits: LibraryHit[];
  /** 有效（非失效）的命中总数，可以翻页 */
  total: number;
  /** 已失效分享里的命中数；要明细时 expiredHits 才有 */
  expired: number;
  expiredHits?: LibraryHit[];
  /** 还在抄的来源数：大于 0 时结果可能不全 */
  indexing: number;
}
