/**
 * 整理与规范化命名：把网盘里的原始命名整理成媒体服务器认得的
 * `作品 (年份) [tmdbid=…]/Season 01/作品 - S01E01.ext`。整理作用在网盘上，本地 strm 由整理器镜像。
 * 设计见 .claude/plans/organize.md。
 */

export type OrganizeMediaType = "movie" | "tv";

/** 识别置信度：high 才允许自动执行；none 是没匹配上，预览里单列「待处理」 */
export type OrganizeConfidence = "high" | "medium" | "low" | "none";

/** 一次整理（run）的状态 */
export type OrganizeRunStatus =
  | "planning"
  | "ready"
  | "applying"
  | "done"
  | "failed"
  | "cancelled"
  | "reverting"
  | "reverted";

/** manual 手动预览；review 自动触发但只生成待确认清单；auto 自动触发且把握大的直接执行 */
export type OrganizeRunMode = "manual" | "review" | "auto";

/**
 * 命名来源：tmdb 按 TMDB 识别 + 模板；local 按本地 strm 的目录结构——用别的工具在本地改好了 strm 的名字和目录，
 * 让网盘跟着改成同样的相对结构，不识别、不套模板（只有手动模式，永远不删网盘文件）
 */
export type OrganizeNaming = "tmdb" | "local";

/**
 * 谁发起的：手动、智能体、转存、追更、云下载、网盘监控、复制到 OpenList。
 * manual 和 agent 是人（或替人办事的 agent）挑的目录，范围照手动的规则来；其余是自动触发给的新增路径
 */
export type OrganizeTrigger = "manual" | "agent" | "share" | "follow" | "offline" | "monitor" | "copy";

/** 计划项的动作；delete 只有用户在冲突上选了删除 / 覆盖才会有 */
export type OrganizeAction = "keep" | "rename" | "move" | "mkdir" | "rmdir" | "skip" | "conflict" | "delete";

/**
 * 冲突（目标已存在 / 两个源要去同一个位置）用户选的处理：
 *   rename     改名保留：给这一份加个区分后缀（画质 / 来源 / 压制组，认不出就 (2)），两份并排放着
 *   custom     自己填目标文件名（只改名字，目录还是整理后的位置）
 *   duplicate  挪进任务根下的重复文件目录，原来的目录层级留着，之后自己在网盘里处理
 *   delete     删掉正在整理的这一份（源文件），目标那份不动
 *   replace    覆盖：先删掉目标位置那份，再把这一份挪过去
 * 不选就是默认的「留在原处」——文件不动，还算冲突；也可以直接把这个文件取消勾选。
 * 删除走网盘的删除接口（115 / 夸克进回收站，OpenList 看存储后端），删掉的项撤销退不回来
 */
export type OrganizeConflictChoice = "rename" | "custom" | "duplicate" | "delete" | "replace";

export interface OrganizeConflictResolution {
  how: OrganizeConflictChoice;
  /** how 是 custom 时用户填的目标文件名（不带目录；没带扩展名就沿用原来的） */
  name?: string;
}

export type OrganizeItemStatus = "pending" | "done" | "failed" | "skipped" | "reverted";

/**
 * 失败的类别，决定下一步该做什么：
 *   transient 网络 / 超时 / 网盘 5xx / 未知 → 执行中自动重试一次，仍失败留给「重试」
 *   blocked   风控 / 登录失效 → 整轮停，修好账号后「重试」
 *   stale     预览之后网盘变了（源文件不在了、目录没了、目标位置被占）→ 「重新预览」或「放弃」，默认不重试
 *   rejected  网盘明确不接受这个名字 / 目标（同名、非法字符、过长）→ 「放弃」，改模板 / 识别词后重新预览
 *   mirror    网盘那步成功、本地 strm 没跟上 → 「重试」只补本地，不碰网盘
 * 空串 = 没失败（或旧数据里没分类的失败，按 transient 对待）
 */
export type OrganizeErrorKind = "" | "transient" | "blocked" | "stale" | "rejected" | "mirror";

/** run 走到哪个方向：开始撤销之后只能继续撤销，不能再执行 */
export type OrganizeRunStage = "apply" | "revert";

/** 文件在整理里的类别 */
export type OrganizeFileKind = "video" | "subtitle" | "nfo" | "image" | "extra" | "dir" | "other";

/** id 标签的写法：Emby `[tmdbid=1]`、Jellyfin `[tmdbid-1]`、Plex `{tmdb-1}`、不写 */
export type OrganizeIdTagStyle = "emby" | "jellyfin" | "plex" | "none";

/** 冒号处理：smart（`: ` → ` - `，其余 → `-`）、delete、dash（`-`）、spaceDash（` -`） */
export type OrganizeColonStyle = "smart" | "delete" | "dash" | "spaceDash";

/** 花絮（trailer / featurette / sample / extras 目录里的）怎么办：跟着正片挪进作品目录下的 extras/（默认），或留在原处 */
export type OrganizeExtrasMode = "keep" | "move";

/** 任务级自动整理：off 不自动；review 只生成待确认的 run 并通知；auto 高置信度且无冲突的直接执行 */
export type OrganizeAutoMode = "off" | "review" | "auto";

/** 二级分类规则：全部条件同时满足才命中，按顺序第一条命中的生效；都不中用兜底 */
export interface OrganizeCategoryRule {
  name: string;
  /** TMDB genre id 列表，任一命中即可 */
  genreIds?: number[];
  /** 剧集 origin_country / 电影 production_countries，任一命中即可（ISO 3166-1） */
  countries?: string[];
  /** original_language，任一命中即可（ISO 639-1） */
  languages?: string[];
}

export interface OrganizeCategorySettings {
  enabled?: boolean;
  movie?: OrganizeCategoryRule[];
  tv?: OrganizeCategoryRule[];
}

export interface OrganizeSettings {
  templates?: { movie?: string; tv?: string };
  idTag?: OrganizeIdTagStyle;
  colon?: OrganizeColonStyle;
  /** 拉季详情把集标题写进文件名；每部剧多几次 TMDB 请求 */
  episodeTitle?: boolean;
  categories?: OrganizeCategorySettings;
  /** 自定义识别词，每行一条：屏蔽词 / A => B / 前 <> 后 >> EP+1（集数偏移）/ 直指 tmdbid */
  rules?: string[];
  /** 执行后删掉本次腾空的源目录 */
  cleanupEmptyDirs?: boolean;
  extras?: OrganizeExtrasMode;
  /** 没在任务上单独设置时的默认自动整理策略 */
  auto?: OrganizeAutoMode;
  /** 预览时自动探测编码：missing 是文件名里缺模板要用的标签的视频才探（每个文件读几 MB 文件头，大库第一次会慢）；默认 off */
  probe?: "off" | "missing";
  /** 特别篇（第 0 季）的季目录名：season00 是模板渲染出来的 Season 00（默认），specials 把它换成 Specials（Plex / Kodi 的惯例，Emby / Jellyfin 两种都认） */
  specials?: "season00" | "specials";
  /** 花絮挪进作品目录下的哪个子目录；默认 extras（Emby / Jellyfin），Plex 只认 Other 这几个固定名字 */
  extrasDir?: string;
}

/** 探测出来的、模板能用的标签（services/media/probe.ts）：文件名里没有对应标签时回退用 */
export interface MediaProbeTags {
  resolution?: string;
  videoCodec?: string;
  audio?: string;
  hdr?: string;
}

/** 探测编码的结果（POST /api/organize/runs/:id/probe） */
export interface OrganizeProbeResult {
  /** 读到了的视频数（含直接用缓存的） */
  probed: number;
  /** 其中直接用缓存、没碰网盘的 */
  cached: number;
  failed: number;
  /** 按探测结果重新规划后，清单真的变了的单元数 */
  units: number;
  /** 每个文件读到了什么（path 是网盘绝对路径）；summary 和 error 二选一 */
  files: Array<{ path: string; unitKey: string; summary?: string; error?: string }>;
}

/** 任务级整理设置 */
export interface TaskOrganizeSettings {
  mode?: OrganizeAutoMode;
  /** 这个任务的库是电影 / 剧集 / 混合：识别时当作先验，混合按识别结果分流 */
  libraryType?: "movie" | "tv" | "mixed";
  /** 这个任务自己的命名模板（留空的沿用全局设置）：电影库、动画库各用各的写法 */
  templates?: { movie?: string; tv?: string };
  /** 这个任务的 id 标签写法 / 文件名里写不写集标题（不给就沿用全局） */
  idTag?: OrganizeSettings["idTag"];
  episodeTitle?: boolean;
}

/* ------------------------------- 识别结果 ------------------------------- */

export interface OrganizeCandidate {
  tmdbId: number;
  mediaType: OrganizeMediaType;
  title: string;
  year: string;
  posterUrl: string;
  overview?: string;
  score: number;
}

export interface OrganizeSeasonInfo {
  season: number;
  episodeCount: number;
  name?: string;
}

/** 一个作品单元的识别结果 */
export interface OrganizeMatch {
  mediaType: OrganizeMediaType;
  tmdbId: number;
  title: string;
  originalTitle: string;
  enTitle?: string;
  year: string;
  posterUrl: string;
  imdbId?: string;
  confidence: OrganizeConfidence;
  /** 一句话：为什么这么认（nfo / 影库 / 记忆 / 识别词 / 标题年份都对上 …） */
  reason: string;
  /** 用来算二级分类 */
  genreIds?: number[];
  countries?: string[];
  originalLanguage?: string;
  seasons?: OrganizeSeasonInfo[];
  /** 电影所属的系列（TMDB 的 collection）：模板变量 {collection} */
  collection?: { id: number; name: string };
  /** 剧集最近播出的一集（TMDB 的 last_episode_to_air）：算缺集时它之后的不算缺；null 是还没播过；老缓存没有这个键 */
  lastAired?: { season: number; episode: number } | null;
  /** 备选（预览里「换匹配」时先给这些） */
  candidates?: OrganizeCandidate[];
}

/* ------------------------------- run / unit / item ------------------------------- */

export interface OrganizeRunStats {
  units: number;
  items: number;
  /** 需要动的项（rename / move / mkdir / rmdir） */
  planned: number;
  /** planned 里建目录 / 删空目录 / 删文件各几项（其余是改名 / 移动的文件） */
  plannedMkdir: number;
  plannedRmdir: number;
  /** 用户在冲突上选了删除 / 覆盖的项：执行后退不回来，执行确认里单说 */
  plannedDelete: number;
  keep: number;
  conflicts: number;
  skipped: number;
  done: number;
  failed: number;
  /** 已退回的项（累计，建目录 / 删目录也算，和 done 同一个口径） */
  reverted: number;
  /** 勾选了、会动网盘、还没做的项：执行中途停下（取消 / 风控 / 重启）时就是「没做完」的 */
  pending: number;
  /** 置信度分布 */
  confidence: Record<OrganizeConfidence, number>;
  /**
   * 还等着处理的失败按类别计数：failed 的项按各自类别；done 但本地镜像失败的算 mirror；
   * 撤销时在网盘那步失败的 done 项按类别（撤销阶段）
   */
  failedByKind: Record<Exclude<OrganizeErrorKind, "">, number>;
  /** 撤销阶段：还没退回的改名 / 移动项（仍在整理后位置的 done + 已经找不到的 failed） */
  notReverted: number;
  /** 收尾时改写了几条追更 / 云下载回执的目录 */
  rewrittenPaths?: number;
}

export interface OrganizeProgress {
  phase: "walk" | "identify" | "plan" | "apply" | "revert" | "idle";
  done: number;
  total: number;
  message: string;
}

/**
 * 交给整理的新文件附带的识别提示：追更按上次整理同一个目录的结果给（见 ShareFollowOrganized）。
 * 一个单元里的视频全被同一条提示覆盖、片名也对得上时，照它认作品、套季和集偏移
 */
export interface OrganizeHint {
  /** 文件，相对任务 originPath */
  path: string;
  mediaType: OrganizeMediaType;
  tmdbId: number;
  /** 人定的季 / 集偏移：强制套用 */
  season: number | null;
  episodeOffset: number;
  /** 只补空的季：文件自己什么季都没给时才用 */
  seasonFallback: number | null;
  /** 片名（归一过）：文件名写了片名、又对不上就不沿用 */
  titles: string[];
  /** 从哪来，写进识别理由和单元说明：追更名 */
  label: string;
}

export interface OrganizeRun {
  id: string;
  taskId: string;
  accountName: string;
  /** 相对任务 originPath 的范围目录；"" 是整个任务 */
  scopePath: string;
  /** 自动触发时给的一组新增路径（相对任务 originPath）；手动整理为空 */
  scopePaths: string[];
  mode: OrganizeRunMode;
  trigger: OrganizeTrigger;
  naming: OrganizeNaming;
  status: OrganizeRunStatus;
  stage: OrganizeRunStage;
  stats: OrganizeRunStats;
  error: string;
  /** 最近的日志行 */
  log: string[];
  /** 秒 */
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** 只有进行中的 run 才有：从内存里带出来 */
  progress?: OrganizeProgress;
}

/** 按文件钉的季 / 集：钉了的那一项不再受季覆盖 / 集偏移影响（和识别词直指一个待遇） */
export interface OrganizeEpisodePin {
  season?: number;
  episode?: number;
}

export interface OrganizeUnit {
  runId: string;
  key: string;
  /** 单元根目录，相对任务 originPath；"" 是范围根 */
  rootPath: string;
  /** 目录名或从文件名综合出来的原始名字，给界面看 */
  rawName: string;
  /** 解析出来的标题 / 年份（用来搜索），识别失败时界面还能显示 */
  parsedTitle: string;
  parsedYear: string;
  match: OrganizeMatch | null;
  /** 用户改过的季 / 集偏移 */
  seasonOverride: number | null;
  episodeOffset: number;
  /** 整理后的作品根目录（相对任务 originPath）；没匹配上为空 */
  dstRoot: string;
  selected: boolean;
  /** 「记住」：把这次的识别结果写进 organize_matches，下次同目录直接用 */
  remember: boolean;
  fileCount: number;
  videoCount: number;
  /** 被追更 / 云下载回执引用的次数：执行后会自动改写 */
  referencedBy: number;
  /** 单元级的问题说明（比如「集数超过该季集数，按绝对集数折算」） */
  notes: string[];
  /** 用户单独取消勾选的文件（网盘绝对路径）：规划时跳过，跟着它们的字幕 / nfo 一起留下 */
  excluded: string[];
  /** 用户给冲突项选的处理，键是网盘绝对路径；没有这一项就是默认的「留在原处」 */
  resolutions: Record<string, OrganizeConflictResolution>;
  /** 用户改的标题 / 年份（空串是用 TMDB 的）：只影响命名，换匹配时清掉；勾了「记住」会一起记进识别记忆 */
  titleOverride: string;
  yearOverride: string;
  /** 按文件钉的季 / 集，键是网盘绝对路径（只有剧集单元里的视频能钉） */
  pins: Record<string, OrganizeEpisodePin>;
  /** 按文件改的目标文件名，键是网盘绝对路径：目录照旧是整理算出来的，没写扩展名就沿用原来的；跟着它的字幕 / nfo 按新名字跟 */
  renames: Record<string, string>;
  /** 按文件改判的类型（键是网盘绝对路径）：规则把正片当成花絮、或反过来时，人来定；没记的按规则 */
  kinds: Record<string, OrganizeKindOverride>;
  /** 缺的集：季号 → 集号（只算单元里出现过的季，按 TMDB 每季集数和已播到哪一集算；电影和没识别的是空对象） */
  missing: Record<string, number[]>;
}

/** 文件类型改判：video 当正片、extra 当花絮 */
export type OrganizeKindOverride = "video" | "extra";

export interface OrganizeItem {
  id: string;
  runId: string;
  unitKey: string;
  seq: number;
  kind: OrganizeFileKind;
  action: OrganizeAction;
  /** 网盘绝对路径，带前导 / */
  srcPath: string;
  dstPath: string;
  nodeId: string;
  /** 为什么是这个动作（冲突 / 跳过的原因） */
  reason: string;
  status: OrganizeItemStatus;
  error: string;
  /** error 的类别；和 status 一起看：failed + stale 是「文件已不在预期位置」，done + mirror 是「网盘成功、本地没跟上」 */
  errorKind: OrganizeErrorKind;
  /** 这一项被执行 / 撤销了几轮（执行中的自动重试不算一轮）：界面上「已试 N 轮」给用户判断该不该放弃 */
  attempts: number;
  /** 用户点了「放弃」：不再算失败、不再重试；errorKind 保留（镜像失败的项监控仍会顺手补本地） */
  givenUp: boolean;
  finishedAt: number | null;
  /**
   * 文件当前的中间位置，非空就表示文件在这里：执行时是「原地改了名、还没挪走」的 `源目录/新名字`，
   * 撤销时是「挪回来了、还没改回原名」的 `源目录/新名字`；做完清空
   */
  curPath: string;
  /** 网盘监控按「整理自己做的」跳过了几条事件 */
  hits: number;
  /** 这个文件探测出来的标签（只在预览的单元结构还在内存里时带） */
  probe?: MediaProbeTags;
}

/**
 * 失败面板的一组：按「下一步该做什么」分。执行阶段是 errorKind 各一组加「没做完」（pending）；
 * 撤销阶段是网盘那步失败的 done 项按 errorKind 分组、已找不到（lost）、已退回但镜像失败（mirror）。
 * held 是这组里不能放弃的项数（撤销时挪回来了还没改回原名的）
 */
export type OrganizeFailureGroupKey = Exclude<OrganizeErrorKind, ""> | "lost" | "pending";

export interface OrganizeFailureGroup {
  key: OrganizeFailureGroupKey;
  itemIds: string[];
  retry: boolean;
  skip: boolean;
  repreview: boolean;
  held: number;
  /** 这组里的删除项（冲突选了删掉 / 覆盖）：重试会在网盘上真删、撤销退不回来，界面重试前要先说清楚 */
  deletes: number;
}

/** GET /api/organize/runs/:id/summary 的形状：run 和按钮开关，不带单元和项；执行 / 撤销进行中页面每 2 秒拉它 */
export interface OrganizeRunSummary {
  run: OrganizeRun;
  /**
   * 待执行的清单的指纹（按内容算）：执行时带回来，打开之后清单被改过（比如智能体改的）就拒绝执行，
   * 让人重新看一眼。只有待执行的才有
   */
  planVersion?: string;
  /** 还等着处理的失败按下一步分组；后端算，前端只管文案和按钮 */
  groups: OrganizeFailureGroup[];
  /** 撤销这次 run 允不允许、为什么不允许；blockedBy 是挡着它的那次整理（后面的整理又动过这次挪好的文件） */
  revertable: { ok: boolean; reason?: string; blockedBy?: { id: string; createdAt: number } };
  /**
   * 待执行的预览是不是旧了（执行不拦，页面提示重新预览）：changed 是预览之后同任务又有整理 / 撤销落了盘（at 是那次结束的时间），
   * old 是预览超过一天（at 是预览的时间）
   */
  outdated?: { kind: "changed" | "old"; at: number; runId?: string };
  /** 能不能（再）执行：ready 的执行全部；其它状态是重试失败 / 没做的项，count 是默认会重试的项数，deletes 是其中的删除项 */
  applicable: { ok: boolean; reason?: string; count: number; deletes?: number };
  /** 待执行的预览还能不能改（换匹配 / 季集偏移 / 勾选）：单元结构只在内存里，进程重启过就只能直接执行或重新预览 */
  editable: boolean;
  /** 执行过没有（有项被执行 / 撤销过）：待执行的预览被取消或被新的预览取代时是 false，这种 run 只能重新预览 */
  executed: boolean;
}

/** 一个单元里各种项的个数：详情不带全部项，单元卡上的数字、筛选都靠它 */
export interface OrganizeUnitCounts {
  /** 这个单元一共几项 */
  total: number;
  /** 改名 / 移动 */
  changing: number;
  conflicts: number;
  /** 跳过里要看一眼的（看不出集数、找不到对应视频…）；单元没勾选、文件没勾选这种用户自己的选择不算 */
  skipped: number;
  keep: number;
  /** 等着处理的失败（执行阶段）/ 没退回的（撤销阶段），和失败面板同一个口径 */
  failed: number;
  done: number;
  reverted: number;
  /** 用户单独取消勾选的文件 */
  excluded: number;
}

/** GET /api/organize/runs/:id 的形状：summary + 单元 + 按单元的计数；项按需拉（GET /runs/:id/items?unit= / ?group=） */
export interface OrganizeRunDetail extends OrganizeRunSummary {
  units: OrganizeUnit[];
  counts: Record<string, OrganizeUnitCounts>;
  /** 建目录 / 删空目录的项数（不属于某个作品，页面单列） */
  dirCount: number;
  /** 这次预览的范围里被「不整理的目录」挡掉的目录（网盘绝对路径） */
  skippedDirs: string[];
}

/** 不整理的目录（设置里的清单 + 整理页「以后不整理这个目录」） */
export interface OrganizeSkip {
  accountName: string;
  /** 网盘绝对路径，带前导 / */
  path: string;
  note: string;
  /** 秒 */
  createdAt: number;
}

/**
 * 待处理列表（跨任务）里一条 run 为什么要人管：ready 待执行；busy 进行中；failures 执行阶段有失败或做了一半；
 * revert 撤销阶段有没退回的；preview-failed 自动触发的预览失败了（手动的预览失败用户当场就看到了）
 */
export type OrganizeAttentionReason = "ready" | "busy" | "failures" | "revert" | "preview-failed";

/** GET /api/organize/attention 的一条；run 不带日志 */
export interface OrganizeAttention {
  run: OrganizeRun;
  reason: OrganizeAttentionReason;
}

/** POST /api/organize/runs/:id/skip 的结果 */
export interface OrganizeSkipResult {
  /** 标成「已放弃」的项数 */
  skipped: number;
  /** 其中先在网盘上改回原名的项数 */
  renamedBack: number;
  /** 没能放弃的项和原因 */
  refused: Array<{ id: string; reason: string }>;
}

/** 用户在预览里改一个单元 */
export interface OrganizeUnitPatch {
  match?: { mediaType: OrganizeMediaType; tmdbId: number };
  seasonOverride?: number | null;
  episodeOffset?: number;
  selected?: boolean;
  remember?: boolean;
  /**
   * 刷新 TMDB 信息：按现在的匹配（或同时给的 match）跳过缓存重新拉详情和季集，再重新规划；
   * 拉回来和原来一样就什么都不改。还没识别出来的单元不能刷新（400 NO_MATCH）
   */
  refresh?: boolean;
  /** 改标题 / 年份（只影响命名）：null 或空串回到 TMDB 的；换匹配时自动清掉 */
  title?: string | null;
  year?: string | null;
}

/** 用户确认过的识别，按账号 + 目录记住 */
export interface OrganizeMatchMemory {
  accountName: string;
  /** 网盘绝对路径 */
  srcPath: string;
  mediaType: OrganizeMediaType;
  tmdbId: number;
  title: string;
  year: string;
  season: number | null;
  episodeOffset: number;
  /** 记住时单元上改的标题 / 年份（空串是没改）：下次同目录认出同一部作品时照用 */
  titleOverride: string;
  yearOverride: string;
  updatedAt: number;
}

/** 设置页模板试算 */
export interface OrganizeTemplatePreview {
  movie: string;
  tv: string;
  errors: string[];
  /** 两个样例的变量值（变量表的「本例」列）：id 标签已按写法拼好，分类按传来的 / 当前的分类规则算 */
  vars: { movie: Record<string, string>; tv: Record<string, string> };
}
