import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const accounts = sqliteTable("accounts", {
  name: text("name").primaryKey(),
  accountType: text("account_type").notNull(),
  data: text("data").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    accountName: text("account_name").notNull(),
    data: text("data").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    accountIdx: index("tasks_account_name_idx").on(t.accountName),
  }),
);

export const taskHistory = sqliteTable(
  "task_history",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    // 毫秒（Date.now()）。其它表的时间戳都是秒（unixepoch），这张表是历史遗留
    startTime: integer("start_time").notNull(),
    endTime: integer("end_time"),
    status: text("status").notNull(),
    logs: text("logs").notNull().default("[]"),
    summary: text("summary").notNull().default("{}"),
    taskInfo: text("task_info").notNull().default("{}"),
  },
  (t) => ({
    taskIdIdx: index("task_history_task_id_idx").on(t.taskId),
    startTimeIdx: index("task_history_start_time_idx").on(t.startTime),
  }),
);

export const mediaLibrary = sqliteTable(
  "media_library",
  {
    id: text("id").primaryKey(),
    shareUrl: text("share_url").notNull(),
    shareCode: text("share_code").notNull(),
    receiveCode: text("receive_code").notNull().default(""),
    sharePath: text("share_path").notNull().default(""),
    shareRootCid: text("share_root_cid").notNull().default(""),
    rawName: text("raw_name").notNull().default(""),
    title: text("title").notNull().default(""),
    fileCount: integer("file_count").notNull().default(0),
    coverUrl: text("cover_url").notNull().default(""),
    tags: text("tags").notNull().default("[]"),
    notes: text("notes").notNull().default(""),
    mediaType: text("media_type").notNull().default("unknown"),
    tmdbId: integer("tmdb_id"),
    year: text("year").notNull().default(""),
    overview: text("overview").notNull().default(""),
    scrapeStatus: text("scrape_status").notNull().default("done"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
    /** 分享自己的标题（「老K」）：来源列表、搜索结果里说「来自哪个分享」 */
    shareTitle: text("share_title").notNull().default(""),
    /** 抄目录树建索引：pending 排队 / indexing 在抄 / done 抄完 / failed 停了（原因在 index_error） */
    indexStatus: text("index_status").notNull().default("pending"),
    indexError: text("index_error").notNull().default(""),
    /** 第几轮抄：刷新时加一，抄完删掉轮次更小的节点 */
    indexGen: integer("index_gen").notNull().default(0),
    indexedAt: integer("indexed_at"),
    indexStartedAt: integer("index_started_at"),
    /** 暂停到什么时候再续（网络、风控、疑似失效） */
    indexRetryAt: integer("index_retry_at"),
    dirsTotal: integer("dirs_total").notNull().default(0),
    dirsListed: integer("dirs_listed").notNull().default(0),
    nodeCount: integer("node_count").notNull().default(0),
    videoCount: integer("video_count").notNull().default(0),
    totalSize: integer("total_size").notNull().default(0),
    /** 超过单个来源的上限没抄完 */
    truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    shareCodeIdx: index("media_library_share_code_idx").on(t.shareCode),
    shareCodePathUniq: uniqueIndex("media_library_share_code_path_uniq").on(t.shareCode, t.sharePath),
    updatedAtIdx: index("media_library_updated_at_idx").on(t.updatedAt),
    scrapeStatusIdx: index("media_library_scrape_status_idx").on(t.scrapeStatus),
  }),
);

/**
 * 影库索引：来源（media_library 一行）下抄来的目录树，一行一个目录或文件。
 * 目录的 search_text 是归一化后的「路径各段 | 名字 | 直接文件名」，搜索按它 LIKE（见 services/library/search-text.ts）
 */
export const libraryNodes = sqliteTable(
  "library_nodes",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => mediaLibrary.id, { onDelete: "cascade" }),
    /** 分享里的 id；整个分享的来源，根是 "0" */
    nodeId: text("node_id").notNull(),
    parentId: text("parent_id").notNull().default(""),
    name: text("name").notNull(),
    /** 分享内完整路径，不带前导 / */
    path: text("path").notNull(),
    isDir: integer("is_dir", { mode: "boolean" }).notNull(),
    /** 相对来源根：来源根自己是 0 */
    depth: integer("depth").notNull(),
    /** 文件是字节；目录抄完回填子树合计，没抄完是 null */
    size: integer("size"),
    /** 夸克转存要的 share_fid_token */
    token: text("token"),
    /** 哪一轮抄到的 */
    gen: integer("gen").notNull(),
    /** 目录：哪一轮列过下一层；小于来源的当前轮就是还要列 */
    listedGen: integer("listed_gen").notNull().default(0),
    /** 目录：直接放着的视频文件数 */
    videoCount: integer("video_count").notNull().default(0),
    /** 目录：子树里的视频文件数（抄完回填，没抄完是 0）；剧目录的视频在季目录里，结果里要报这个 */
    videoTotal: integer("video_total").notNull().default(0),
    /** 分享还在，这个目录却打不开了（上传者删了 / 挪了）：搜索不给，重抄上一级时清掉 */
    missing: integer("missing", { mode: "boolean" }).notNull().default(false),
    searchText: text("search_text").notNull().default(""),
    /** 作品单元的根目录：识别出来的正式名 / 原名 / 英文名 / 别名（归一化，| 连着），搜索时和 search_text 一起算 */
    aka: text("aka").notNull().default(""),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sourceId, t.nodeId] }),
    parentIdx: index("library_nodes_parent_idx").on(t.sourceId, t.parentId),
    crawlIdx: index("library_nodes_crawl_idx").on(t.sourceId, t.isDir, t.listedGen),
  }),
);

/** 影库里的分享死活，按分享码：同一个分享收了几次（整包、子目录）一起算 */
export const libraryShares = sqliteTable("library_shares", {
  shareCode: text("share_code").primaryKey(),
  kind: text("kind").notNull(),
  /** unknown 没查过 / ok / suspect 疑似失效（等复查）/ expired 已失效 / locked 提取码不对 */
  status: text("status").notNull().default("unknown"),
  reason: text("reason").notNull().default(""),
  failStreak: integer("fail_streak").notNull().default(0),
  checkedAt: integer("checked_at"),
  lastOkAt: integer("last_ok_at"),
  expiredAt: integer("expired_at"),
  nextCheckAt: integer("next_check_at"),
});

/**
 * 影库的作品单元：从抄来的目录树里切出来的一部电影 / 一部剧（整理的 buildUnits），和它在 TMDB 上认出来的是哪一部。
 * 同一个 tmdbId 的几个单元在界面上合成一张作品卡（几个版本 / 几季）。重建单元时按单元键保留识别结果。
 */
export const libraryUnits = sqliteTable(
  "library_units",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => mediaLibrary.id, { onDelete: "cascade" }),
    /** 根目录节点 id；一个目录里按标题拆出来的几部再带上标题（`<nodeId>|<标题>|<年份>`） */
    unitKey: text("unit_key").notNull(),
    /** 单元根目录的节点 id（整个分享的根是 "0"） */
    nodeId: text("node_id").notNull(),
    path: text("path").notNull(),
    /** 根目录名；拆出来的是文件里的标题 */
    rawName: text("raw_name").notNull(),
    /** 根目录就是这部作品自己的：转存整个目录；不是（分类目录里散放的文件）转存 fileIds */
    ownsDir: integer("owns_dir", { mode: "boolean" }).notNull(),
    /** 单元里的文件节点 id（JSON 数组，视频在前） */
    fileIds: text("file_ids").notNull().default("[]"),
    parsedTitle: text("parsed_title").notNull().default(""),
    /** 搜索候选（JSON 数组）：目录名的、文件名的 */
    parsedTitles: text("parsed_titles").notNull().default("[]"),
    parsedYear: text("parsed_year").notNull().default(""),
    /** movie / tv / unknown：按结构猜的 */
    kindHint: text("kind_hint").notNull().default("unknown"),
    /** 季号（JSON 数组）；剧才有 */
    seasons: text("seasons").notNull().default("[]"),
    videoCount: integer("video_count").notNull().default(0),
    size: integer("size").notNull().default(0),
    /** 最大的那个视频的文件名 */
    sampleFile: text("sample_file").notNull().default(""),
    /** pending 待认 / done 认过（没认出是 confidence none）/ manual 手动指定 / ignored 不是影视 */
    status: text("status").notNull().default("pending"),
    tmdbId: integer("tmdb_id"),
    mediaType: text("media_type"),
    title: text("title").notNull().default(""),
    originalTitle: text("original_title").notNull().default(""),
    enTitle: text("en_title").notNull().default(""),
    year: text("year").notNull().default(""),
    posterUrl: text("poster_url").notNull().default(""),
    /** high / medium / low / none */
    confidence: text("confidence").notNull().default("none"),
    reason: text("reason").notNull().default(""),
    /** 备选（JSON 数组，OrganizeCandidate） */
    candidates: text("candidates").notNull().default("[]"),
    /**
     * 认出来的作品在 TMDB 上的类型编号、国家 / 地区代码（JSON 数组）、原语言：收藏夹按「科幻」「韩国」筛。
     * null = 还没从 TMDB 详情补（认出来的时候顺手存；以前认的由识别工人闲下来时补，不重认）
     */
    genres: text("genres"),
    countries: text("countries"),
    originalLanguage: text("original_language"),
    /** 认出来的名字（归一化、| 连着）：写到根节点的 aka */
    aka: text("aka").notNull().default(""),
    identifiedAt: integer("identified_at"),
    /** TMDB 一时出错：多久以后再认 */
    retryAt: integer("retry_at"),
    error: text("error").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sourceId, t.unitKey] }),
    tmdbIdx: index("library_units_tmdb_idx").on(t.mediaType, t.tmdbId),
    statusIdx: index("library_units_status_idx").on(t.status, t.retryAt),
    nodeIdx: index("library_units_node_idx").on(t.sourceId, t.nodeId),
  }),
);

/**
 * 从收藏夹转存过的作品单元：存进了哪个任务、什么时候（「已经有了」的一个来源，另一个是本地 strm 目录里认得出 tmdbId 的）。
 * 单元键重切时不变，来源删掉时跟着删
 */
export const librarySaves = sqliteTable(
  "library_saves",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => mediaLibrary.id, { onDelete: "cascade" }),
    unitKey: text("unit_key").notNull(),
    taskId: text("task_id").notNull(),
    /** 存进任务目录下的哪个子目录 */
    subPath: text("sub_path").notNull().default(""),
    savedAt: integer("saved_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sourceId, t.unitKey, t.taskId] }),
  }),
);

/**
 * 115 文件/目录 id → 绝对网盘路径 的缓存。
 * 生活事件只带 parent_id，必须靠这张表把 cid 还原成路径，
 * 同时也是 move / rename 事件定位「旧路径」的唯一依据。
 * id 一律用 text 存：115 的 file_id 超过 JS 安全整数范围。
 */
export const pathCache = sqliteTable(
  "path_cache",
  {
    fileId: text("file_id").primaryKey(),
    parentId: text("parent_id").notNull().default("0"),
    name: text("name").notNull().default(""),
    path: text("path").notNull(),
    isDir: integer("is_dir").notNull().default(1),
    accountName: text("account_name").notNull().default(""),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pathIdx: index("path_cache_path_idx").on(t.path),
    parentIdx: index("path_cache_parent_id_idx").on(t.parentId),
  }),
);

/**
 * 网盘变更事件，主键就是事件 id，重复拉取时幂等覆盖。
 * 115 的生活事件原样记在 type / file_id / parent_id / pick_code 里；kind / path / old_path 是各家统一的形状（0010 加的），
 * 夸克的快照对比事件只有这三列有意义。
 */
export const lifeEvents = sqliteTable(
  "life_events",
  {
    id: text("id").primaryKey(),
    accountName: text("account_name").notNull().default(""),
    type: integer("type").notNull(),
    kind: text("kind").notNull().default(""),
    path: text("path").notNull().default(""),
    oldPath: text("old_path").notNull().default(""),
    fileId: text("file_id").notNull(),
    parentId: text("parent_id").notNull().default("0"),
    fileName: text("file_name").notNull().default(""),
    fileCategory: integer("file_category").notNull().default(0),
    fileSize: integer("file_size").notNull().default(0),
    sha1: text("sha1").notNull().default(""),
    pickCode: text("pick_code").notNull().default(""),
    updateTime: integer("update_time").notNull().default(0),
    createTime: integer("create_time").notNull().default(0),
    status: text("status").notNull().default("pending"),
    detail: text("detail").notNull().default(""),
    handledAt: integer("handled_at"),
  },
  // 只按 update_time 查（listRecent / 留存清理）。file_id 和 type 上的索引没有任何查询用到，
  // 这张表又是写得最多的一张，白白放大写入量，0008 迁移里删掉了。
  // 同步期间记下、等着补的事件（status = deferred）每轮都要按账号查一遍：部分索引只收这几行，不拖累写入
  (t) => ({
    updateTimeIdx: index("life_events_update_time_idx").on(t.updateTime),
    deferredIdx: index("life_events_deferred_idx").on(t.accountName).where(sql`${t.status} = 'deferred'`),
  }),
);

export type PathCacheRow = typeof pathCache.$inferSelect;
export type LifeEventRow = typeof lifeEvents.$inferSelect;

/**
 * 没有事件流的网盘（夸克）的监控快照：每个账号的每个任务根目录一份，entries 是整棵子树的 JSON。
 * 下一轮扫描和它对比得出新增 / 删除 / 改名 / 移动。
 * meta 是根目录自己的指纹和上次整棵对比的时间（JSON，旧行是 {}）：目录的指纹在 entries 里各自带着。
 */
export const driveSnapshots = sqliteTable(
  "drive_snapshots",
  {
    accountName: text("account_name").notNull(),
    rootPath: text("root_path").notNull(),
    entries: text("entries").notNull().default("[]"),
    scannedAt: integer("scanned_at").notNull().default(0),
    meta: text("meta").notNull().default("{}"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.accountName, t.rootPath] }),
  }),
);

/**
 * 分享追更订阅：一条 = 分享里的某个目录 → 某个同步任务的子目录。
 * 快照 known 是 JSON：一部剧几百条，放行里比再开一张表省事，列表接口不带它。
 * 时间戳里 last_checked_at / last_change_at / next_check_at 是毫秒（直接和 Date.now() 比），
 * created_at / updated_at 和其它表一样是秒。
 */
export const shareFollows = sqliteTable(
  "share_follows",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().default(""),
    libraryId: text("library_id"),
    shareUrl: text("share_url").notNull().default(""),
    shareCode: text("share_code").notNull(),
    receiveCode: text("receive_code").notNull().default(""),
    watchCid: text("watch_cid").notNull().default("0"),
    watchPath: text("watch_path").notNull().default(""),
    scope: text("scope").notNull().default('[""]'),
    taskId: text("task_id").notNull(),
    subPath: text("sub_path").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    intervalMinutes: integer("interval_minutes").notNull().default(360),
    status: text("status").notNull().default("idle"),
    lastError: text("last_error").notNull().default(""),
    errorStreak: integer("error_streak").notNull().default(0),
    lastCheckedAt: integer("last_checked_at"),
    lastChangeAt: integer("last_change_at"),
    nextCheckAt: integer("next_check_at").notNull().default(0),
    known: text("known").notNull().default("[]"),
    recent: text("recent").notNull().default("[]"),
    /** 整理结果（JSON，ShareFollowOrganized[]）：新文件交给整理时照着用 */
    organized: text("organized").notNull().default("[]"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    // 同一个分享目录只允许一条订阅：两条盯同一处会各转存一份
    shareWatchUniq: uniqueIndex("share_follows_share_watch_uniq").on(t.shareCode, t.watchCid),
    dueIdx: index("share_follows_due_idx").on(t.enabled, t.nextCheckAt),
    taskIdx: index("share_follows_task_id_idx").on(t.taskId),
  }),
);

/* ------------------------------- 整理与规范化命名 ------------------------------- */

/**
 * 一次整理：范围、状态、统计、最近的日志行。items 是计划也是执行流水账（撤销按它逆序退回）。
 * 时间戳秒；id 字符串。
 */
export const organizeRuns = sqliteTable(
  "organize_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    accountName: text("account_name").notNull().default(""),
    scopePath: text("scope_path").notNull().default(""),
    scopePaths: text("scope_paths").notNull().default("[]"),
    /** 新增路径带的识别提示（JSON，OrganizeHint[]，追更给的）：重新预览也照用 */
    hints: text("hints").notNull().default("[]"),
    mode: text("mode").notNull().default("manual"),
    trigger: text("trigger").notNull().default("manual"),
    /** 命名来源：tmdb 按识别 + 模板；local 按本地 strm 的目录结构 */
    naming: text("naming").notNull().default("tmdb"),
    status: text("status").notNull().default("planning"),
    /** apply 执行 / revert 撤销：开始撤销之后只能继续撤销 */
    stage: text("stage").notNull().default("apply"),
    stats: text("stats").notNull().default("{}"),
    error: text("error").notNull().default(""),
    log: text("log").notNull().default("[]"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => ({
    taskIdx: index("organize_runs_task_idx").on(t.taskId, t.createdAt),
    statusIdx: index("organize_runs_status_idx").on(t.status),
  }),
);

/** 一个作品单元：识别结果 + 用户的修改；items 按 unit_key 挂在它下面 */
export const organizeUnits = sqliteTable(
  "organize_units",
  {
    runId: text("run_id").notNull(),
    key: text("key").notNull(),
    rootPath: text("root_path").notNull().default(""),
    rawName: text("raw_name").notNull().default(""),
    parsedTitle: text("parsed_title").notNull().default(""),
    parsedYear: text("parsed_year").notNull().default(""),
    match: text("match"),
    seasonOverride: integer("season_override"),
    episodeOffset: integer("episode_offset").notNull().default(0),
    dstRoot: text("dst_root").notNull().default(""),
    selected: integer("selected", { mode: "boolean" }).notNull().default(true),
    remember: integer("remember", { mode: "boolean" }).notNull().default(false),
    fileCount: integer("file_count").notNull().default(0),
    videoCount: integer("video_count").notNull().default(0),
    referencedBy: integer("referenced_by").notNull().default(0),
    notes: text("notes").notNull().default("[]"),
    /** 用户单独取消勾选的文件（网盘绝对路径的 JSON 数组）：规划时跳过，重规划不丢 */
    excluded: text("excluded").notNull().default("[]"),
    /** 用户给冲突项选的处理（JSON：网盘绝对路径 → rename / duplicate），重规划不丢 */
    resolutions: text("resolutions").notNull().default("{}"),
    /** 用户改的标题 / 年份（空串是用 TMDB 的） */
    titleOverride: text("title_override").notNull().default(""),
    yearOverride: text("year_override").notNull().default(""),
    /** 按文件钉的季 / 集（JSON：网盘绝对路径 → { season?, episode? }） */
    pins: text("pins").notNull().default("{}"),
    /** 按文件改的目标文件名（JSON：网盘绝对路径 → 文件名） */
    renames: text("renames").notNull().default("{}"),
    /** 按文件改判的类型（JSON：网盘绝对路径 → video / extra） */
    kinds: text("kinds").notNull().default("{}"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.key] }),
  }),
);

/**
 * 计划项 / 流水账。src_path / dst_path 是网盘绝对路径（带前导 /）：
 * 网盘监控用 (node_id, dst_path) 认出「这是整理自己做的改名 / 移动」，跳过不重复处理。
 */
export const organizeItems = sqliteTable(
  "organize_items",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    unitKey: text("unit_key").notNull().default(""),
    seq: integer("seq").notNull().default(0),
    kind: text("kind").notNull().default("other"),
    action: text("action").notNull().default("skip"),
    srcPath: text("src_path").notNull().default(""),
    dstPath: text("dst_path").notNull().default(""),
    nodeId: text("node_id").notNull().default(""),
    reason: text("reason").notNull().default(""),
    status: text("status").notNull().default("pending"),
    error: text("error").notNull().default(""),
    /** error 的类别（transient / blocked / stale / rejected / mirror），决定重试还是放弃 */
    errorKind: text("error_kind").notNull().default(""),
    /** 被执行 / 撤销了几轮（自动重试不算） */
    attempts: integer("attempts").notNull().default(0),
    /** 用户点了「放弃」 */
    givenUp: integer("given_up", { mode: "boolean" }).notNull().default(false),
    finishedAt: integer("finished_at"),
    /** 文件当前的中间位置：执行时是原地改了名还没挪走，撤销时是挪回来了还没改回原名；做完清空 */
    curPath: text("cur_path").notNull().default(""),
    /** 网盘监控已经按「整理自己做的」跳过了几条事件；一条 rename + 一条 move 最多两条，之后的就是别人动的 */
    hits: integer("hits").notNull().default(0),
  },
  (t) => ({
    runIdx: index("organize_items_run_idx").on(t.runId, t.seq),
    nodeIdx: index("organize_items_node_idx").on(t.nodeId),
  }),
);

/** 用户在预览里改过并勾了「记住」的识别结果：同账号同目录下次直接用 */
export const organizeMatches = sqliteTable(
  "organize_matches",
  {
    accountName: text("account_name").notNull(),
    srcPath: text("src_path").notNull(),
    mediaType: text("media_type").notNull().default("tv"),
    tmdbId: integer("tmdb_id").notNull(),
    title: text("title").notNull().default(""),
    year: text("year").notNull().default(""),
    season: integer("season"),
    episodeOffset: integer("episode_offset").notNull().default(0),
    /** 记住时单元上改的标题 / 年份（空串是没改） */
    titleOverride: text("title_override").notNull().default(""),
    yearOverride: text("year_override").notNull().default(""),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.accountName, t.srcPath] }),
  }),
);

/** TMDB 详情 / 搜索结果缓存：key 是 `kind:参数`，value 是 JSON */
export const tmdbCache = sqliteTable("tmdb_cache", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default("{}"),
  fetchedAt: integer("fetched_at").notNull().default(0),
});

/**
 * 智能体（MCP / REST）用的访问令牌。明文只在创建时给一次，这里只存 SHA-256：
 * 令牌是 256 位随机数，没有字典可撞，每个请求都要校验，犯不上跑 KDF。
 * 撤销就是删行；调用记录里留着令牌名，删了也查得到是谁干的。
 */
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** manual = 设置页手建；以后 OAuth 发的令牌也放这张表 */
    kind: text("kind").notNull().default("manual"),
    tokenHash: text("token_hash").notNull(),
    /** 明文的前几位，列表里认令牌用 */
    prefix: text("prefix").notNull(),
    scopes: text("scopes").notNull().default("[]"),
    /** 工具集的 JSON 数组。选「全部」存的是当时的全部组：以后版本加的组不会自动给老令牌，要用户自己勾 */
    toolsets: text("toolsets").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    expiresAt: integer("expires_at"),
    lastUsedAt: integer("last_used_at"),
    lastUsedIp: text("last_used_ip"),
  },
  (t) => ({
    hashUniq: uniqueIndex("api_tokens_hash_uniq").on(t.tokenHash),
  }),
);

/** 智能体的每次工具调用（和令牌直接调 REST）：设置页「最近调用」、事后查是谁干的 */
export const agentAudit = sqliteTable(
  "agent_audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tokenId: text("token_id").notNull(),
    tokenName: text("token_name").notNull().default(""),
    /** 调用方的 IP：同一个令牌出现陌生 IP 就是泄露的信号 */
    ip: text("ip").notNull().default(""),
    tool: text("tool").notNull(),
    /** 参数摘要：截断过，提取码抹掉了 */
    args: text("args").notNull().default(""),
    ok: integer("ok", { mode: "boolean" }).notNull().default(true),
    error: text("error").notNull().default(""),
    durationMs: integer("duration_ms").notNull().default(0),
    at: integer("at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    tokenIdx: index("agent_audit_token_idx").on(t.tokenId, t.at),
    atIdx: index("agent_audit_at_idx").on(t.at),
  }),
);

/**
 * OAuth 客户端（网页客户端走授权流程时）：
 *   dcr    动态注册（RFC 7591）来的，client_id 是我们发的；
 *   cimd   client_id 本身是一个 https 地址，元数据从那里取来缓存在这里（设置里开了 CIMD 才有）；
 *   manual 设置页手建的预注册客户端，有 secret（只存哈希）。
 * 只存用得上的几样（名字、回调地址、scope），不存客户端交上来的整份元数据：注册谁都能发，存整份等于让人随便往库里塞东西
 */
export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    name: text("name").notNull().default(""),
    /** 登记的回调地址（JSON 数组） */
    redirectUris: text("redirect_uris").notNull().default("[]"),
    secretHash: text("secret_hash"),
    /** 注册时要的 scope：DCR 的注册回应里要原样带回 */
    scope: text("scope").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    /** CIMD 元数据上次取的时间（秒） */
    fetchedAt: integer("fetched_at"),
    /** CIMD 元数据缓存到什么时候（秒）：按对方的 Cache-Control，最长一天 */
    cacheUntil: integer("cache_until"),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => ({
    kindIdx: index("oauth_clients_kind_idx").on(t.kind),
  }),
);

/**
 * 授权请求：授权页发起，等人在管理界面（或 Telegram）里输入授权页上的配对码后批准。
 * 批准后授权页轮询时才生成授权码（只存哈希），一次性、10 分钟内有效。
 */
export const oauthRequests = sqliteTable(
  "oauth_requests",
  {
    id: text("id").primaryKey(),
    /** 授权页轮询用的密钥（哈希）：光知道请求 id 拿不到授权码 */
    pollHash: text("poll_hash").notNull(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull().default(""),
    clientKind: text("client_kind").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    state: text("state"),
    codeChallenge: text("code_challenge").notNull(),
    /** 客户端要的 scope，原样（空格分隔） */
    requestedScope: text("requested_scope").notNull().default(""),
    /** 令牌要绑定的资源（RFC 8707）：本实例的 <公网地址>/mcp */
    resource: text("resource").notNull(),
    pairingCode: text("pairing_code").notNull(),
    /** pending → approved（批了，等授权页来取授权码）→ issued（授权码已发）→ used（换过令牌）；或 denied */
    status: text("status").notNull().default("pending"),
    grantedScopes: text("granted_scopes"),
    grantedToolsets: text("granted_toolsets"),
    /** 在哪批的：ui / telegram / password */
    approvedVia: text("approved_via"),
    codeHash: text("code_hash"),
    codeExpiresAt: integer("code_expires_at"),
    /** 授权码换令牌的时间：同一个授权码短时间内再来一次（回应丢了重试）要认得出 */
    usedAt: integer("used_at"),
    /** 用这个授权码换出来的授权：授权码被再用一次时整个撤掉 */
    grantId: text("grant_id"),
    ip: text("ip").notNull().default(""),
    /** 按来源计数用的键：IPv6 按 /64（lib/ip.ts） */
    ipKey: text("ip_key").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    expiresAt: integer("expires_at").notNull(),
    decidedAt: integer("decided_at"),
  },
  (t) => ({
    codeUniq: uniqueIndex("oauth_requests_code_uniq").on(t.codeHash),
    statusIdx: index("oauth_requests_status_idx").on(t.status, t.createdAt),
    ipKeyIdx: index("oauth_requests_ip_key_idx").on(t.ipKey, t.createdAt),
  }),
);

/**
 * 一次授权 = 设置页「已连接的客户端」的一行：当前的访问令牌、刷新令牌（都只存哈希，每次刷新都换），
 * 批给它的档位和工具集，令牌绑定的资源，怎么批的
 */
export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull().default(""),
    scopes: text("scopes").notNull().default("[]"),
    toolsets: text("toolsets").notNull(),
    /** 客户端要没要 offline_access：返回的 scope 里带不带它 */
    offline: integer("offline", { mode: "boolean" }).notNull().default(false),
    resource: text("resource").notNull(),
    accessHash: text("access_hash").notNull(),
    accessExpiresAt: integer("access_expires_at").notNull(),
    /** 刷新前的那个访问令牌：到它自己过期前照样认，刷新时正在路上的请求不会平白 401 */
    prevAccessHash: text("prev_access_hash"),
    prevAccessExpiresAt: integer("prev_access_expires_at"),
    refreshHash: text("refresh_hash").notNull(),
    refreshExpiresAt: integer("refresh_expires_at").notNull(),
    /** 在哪批的（ui / telegram / password）、什么时候、发起授权的地址：出了事能查 */
    approvedVia: text("approved_via"),
    approvedAt: integer("approved_at"),
    requestIp: text("request_ip"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    lastUsedAt: integer("last_used_at"),
    lastUsedIp: text("last_used_ip"),
  },
  (t) => ({
    accessUniq: uniqueIndex("oauth_grants_access_uniq").on(t.accessHash),
    prevAccessUniq: uniqueIndex("oauth_grants_prev_access_uniq").on(t.prevAccessHash),
    refreshUniq: uniqueIndex("oauth_grants_refresh_uniq").on(t.refreshHash),
    clientIdx: index("oauth_grants_client_idx").on(t.clientId),
  }),
);

/**
 * 换过的刷新令牌：宽限期（一分钟）内再出现是客户端并发刷新 / 重试，回同一对令牌；
 * 过了宽限期再出现就是被偷了拿去重放，整个授权作废（刷新令牌过期后就清掉）
 */
export const oauthUsedRefresh = sqliteTable(
  "oauth_used_refresh",
  {
    hash: text("hash").primaryKey(),
    grantId: text("grant_id").notNull(),
    usedAt: integer("used_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    usedAtIdx: index("oauth_used_refresh_used_at_idx").on(t.usedAt),
  }),
);

/** 网盘视频的探测结果（services/media/probe.ts，mediainfo.js 读文件头）：按账号 + 文件 id（没 id 的按绝对路径）记，大小变了才重探 */
export const mediaProbes = sqliteTable(
  "media_probes",
  {
    accountName: text("account_name").notNull(),
    key: text("key").notNull(),
    path: text("path").notNull().default(""),
    size: integer("size").notNull().default(0),
    /** ok / failed */
    status: text("status").notNull().default("ok"),
    data: text("data").notNull().default("{}"),
    error: text("error").notNull().default(""),
    probedAt: integer("probed_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => ({ pk: primaryKey({ columns: [t.accountName, t.key] }) }),
);
