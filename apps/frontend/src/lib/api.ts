/**
 * 后端接口的类型化客户端。页面只调这里的函数，不再手写路径和响应类型。
 *
 * 响应就是 payload 本身（后端已去掉 `{code,data}` 壳）；失败一律抛 axios 错误，
 * 错误体固定为 `{ message, ...extra }`，用 apiErrorMessage() 取文案。
 */
import axiosInstance from "./axios";
import { streamSse } from "./sse";
import type {
  AccountInfo,
  AgentCall,
  AgentInfo,
  AgentOAuthState,
  AgentSelfCheckItem,
  OAuthClientCreated,
  AgentScope,
  AgentToken,
  AgentTokenCreated,
  AgentToolset,
  AppSettings,
  LifeMonitorSettings,
  MediaLibraryEntry,
  LibrarySearchResult,
  LibraryShareHealth,
  LibraryUnit,
  LibraryWorkDetail,
  LibraryWorksResult,
  LibraryWorksSort,
  LibraryWorksView,
  OrganizeAttention,
  UpdateStatus,
  OrganizeCandidate,
  OrganizeConflictResolution,
  OrganizeFailureGroupKey,
  OrganizeItem,
  OrganizeMatchMemory,
  OrganizeRun,
  OrganizeRunDetail,
  OrganizeRunSummary,
  OrganizeSkipResult,
  OrganizeTemplatePreview,
  OrganizeUnit,
  OrganizeUnitPatch,
  ResourceCheckResult,
  ResourceSearchResult,
  ResourceStatus,
  ShareFollowRun,
  ShareFollowSummary,
  StrmAllPostersResult,
  StrmDeleteResult,
  CopyAfterCopy,
  StrmFileInfo,
  StrmListResult,
  StrmPosterResult,
  StrmRegenerateMode,
  StrmRegenerateResult,
  StrmRewriteResult,
  StrmScanResult,
  StrmSearchResult,
  StrmVerifyEvent,
  StrmVerifyResult,
  TaskDefinition,
  TaskExecutionHistory,
  TaskExecutionSummary,
  TelegramNotifySettings,
} from "@openstrm/shared";

/* ------------------------------- 类型 ------------------------------- */

export type TaskStatus = "pending" | "processing";
/** GET /api/task 的行：任务定义 + 运行状态 + 上次执行 + 下次定时。strmType 是表单存的附加字段 */
export type TaskRow = TaskDefinition & {
  status: TaskStatus;
  strmType?: string;
  /** 最近一次执行（不带日志）；从没跑过是 null */
  lastRun: TaskExecutionSummary | null;
  /** 定时任务的下次触发时间（ISO）；没有定时是 null */
  nextRunAt: string | null;
  /** 要复制到 OpenList 的话卡在哪（比如这个账号没填挂载根）；null = 能复制。后端按真干活时的同一套条件算 */
  copyBlocked?: string | null;
};
/** 表单提交的任务字段；必填项由后端 schema 把关，这里只描述形状 */
export type TaskInput = Partial<Omit<TaskDefinition, "id">> & { strmType?: string };

export type StartTaskResult = {
  message: string;
  taskId?: string;
  /** 这次要处理的文件数；无事可做时没有 */
  total?: number;
  extraFilesCount?: number;
  willDeleteExtraFiles?: boolean;
  /** 比如"远端为空，已跳过清理"这类不算失败但该让人知道的事 */
  warning?: string;
};

export type DriveKind = "115" | "quark" | "openlist";

/** 分享里的一项（后端已归一化，各家网盘同一个形状） */
export interface ShareEntry {
  id: string;
  name: string;
  isDir: boolean;
  size?: number;
  hash?: string;
  /** 夸克转存要的 share_fid_token，原样带回给 receive */
  token?: string;
}
export interface ShareInfo {
  kind: DriveKind;
  /** 打开这个分享用的账号 */
  account: string;
  title: string;
  fileCount?: number;
}
/** 翻页游标不透明：有 next 就还有下一页 */
export type ShareListPage = { kind: DriveKind; account: string; entries: ShareEntry[]; next?: string; total?: number };
/**
 * parentId：条目所在的目录。夸克的 token 跟着分享会话走、会过期（影库里记下的、弹框开了很久的），
 * 带上它后端就在转存那次会话里把那一层重新列一遍换新的
 */
export type ShareReceiveItem = Pick<ShareEntry, "id" | "name" | "isDir" | "token"> & { parentId?: string };
export type ShareReceiveResult = Record<string, unknown> & {
  mode?: "sync" | "async";
  taskId?: string;
  message?: string;
  generatedCount?: number;
  skippedCount?: number;
  /** 名字没法落成本地路径而没生成 strm 的条目（网盘上已经转存了） */
  invalidNames?: string[];
  strmGenerated?: boolean;
  /** 带 follow 参数时：建成的订阅，或没建成的原因（转存本身已成功） */
  follow?: ShareFollowSummary;
  followError?: string;
};

/** 115 网盘文件列表条目（原始字段名） */
export interface Drive115Item {
  cid: number;
  n: string;
  fc: number;
  [k: string]: unknown;
}

export interface DirectoryNode {
  name: string;
  id: string | number;
  isDir: boolean;
  hasChildren?: boolean;
  /** 文件的大小（字节）；只有带文件列的时候有 */
  size?: number;
}

export type LibraryAddResponse = { mode: "single" | "subdir"; entry: MediaLibraryEntry; absorbed?: number };
/** 批量添加前的预览：贴进来的一段话里认出的一个分享（url 里带着提取码，拿去 create 就行）；已经收着的带着它在影库里的名字 */
export type LibraryShareLink = { kind: "115" | "quark"; code: string; url: string; hasPassword: boolean; inLibrary: boolean; title?: string };
export type LibrarySearchQuery = { q: string; limit?: number; offset?: number; expired?: boolean; sourceId?: string };
export type LibraryPatch = Partial<Pick<MediaLibraryEntry, "title" | "coverUrl" | "notes" | "tags" | "receiveCode">>;
export type LibraryCreateInput = {
  shareUrl: string;
  title?: string;
  coverUrl?: string;
  tags?: string[];
  notes?: string;
  cid?: string | number;
  fileCount?: number;
  rawName?: string;
  sharePath?: string;
};
/** 设置里值是对象的顶层键（emby / telegram / lifeMonitor …），可以按组读-改-写 */
export type SettingsGroupKey = {
  [K in keyof AppSettings]-?: NonNullable<AppSettings[K]> extends readonly unknown[]
    ? never
    : NonNullable<AppSettings[K]> extends object
      ? K
      : never;
}[keyof AppSettings];
export type SaveToTaskChoice = {
  taskId: string;
  subPath: string;
  mode: "sync" | "async";
  /** 勾了「转存后追更」就带上；后端转存成功后顺手建订阅 */
  follow?: { intervalMinutes: number };
  /** 勾了「转存后整理」：后端转存成功后建一次整理（任务设了自动执行就直接执行，否则待确认） */
  organize?: boolean;
  /** 勾了「转存后复制到 OpenList」：后端转存成功后把这些条目交给复制队列 */
  copy?: boolean;
};

export interface TmdbSearchResult {
  id: number;
  mediaType: string;
  /** 按设置的语言本地化的标题（zh-CN 下是译名） */
  title: string;
  /** 原名 */
  originalTitle?: string;
  year: string;
  posterUrl: string;
  overview: string;
}

export interface HdhiveTmdbItem {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  year: string;
  posterUrl: string;
  overview: string;
}
export interface HdhiveResourceItem {
  slug: string;
  title: string | null;
  pan_type: string | null;
  share_size: string | null;
  video_resolution: string[];
  source: string[];
  subtitle_language: string[];
  subtitle_type: string[];
  unlock_points: number | null;
  is_unlocked: boolean;
  user: Record<string, unknown> | null;
  remark?: string | null;
}
export interface HdhiveUnlockResult {
  url: string;
  access_code: string;
  full_url: string;
  already_owned: boolean;
}
export type HdhiveSearchResult = {
  tmdb: HdhiveTmdbItem | null;
  alternatives: HdhiveTmdbItem[];
  resources: HdhiveResourceItem[];
  total: number;
};

export type LifeEventMode = "create" | "move" | "rename" | "remove";
export type LifeMonitorStats = { rounds: number; events: number; handled: number; skipped: number; failed: number };
/** 一个被监控账号的运行态；起不来的账号 running=false，原因在 lastError */
export type LifeAccountStatus = {
  name: string;
  running: boolean;
  cursor: { time: number; id: string };
  /** 变更来源：115 是 proapi / webapi（生活事件流），夸克是 snapshot（定时对比目录） */
  source: string;
  startedAt: number | null;
  lastPollAt: number | null;
  lastError: string | null;
  stats: LifeMonitorStats;
};
export type LifeMonitorStatus = {
  /** 至少一个账号在跑 */
  running: boolean;
  accounts: LifeAccountStatus[];
  interval: number;
  eventModes: LifeEventMode[];
  startedAt: number | null;
  lastPollAt: number | null;
  /** 各账号合计 */
  stats: LifeMonitorStats;
  db: { lifeEvents: number; pathCache: number; snapshots: number };
  embyRefresh: { configured: boolean; pendingCount: number; pendingSince: number | null };
  logs: string[];
};
export type LifeProbeResult = {
  ok: boolean;
  message: string;
  accounts: Array<{ account: string; ok: boolean; message: string }>;
};
export type LifeEventRow = {
  id: string;
  accountName: string;
  type: number;
  typeName: string;
  /** 统一的动作：create / move / rename / remove / folder；旧数据为空 */
  kind: string;
  /** 网盘绝对路径；旧数据为空，界面退回显示 fileName */
  path: string;
  oldPath: string;
  fileName: string;
  fileCategory: number;
  updateTime: number;
  status: string;
  detail: string;
};

/* ------------------------------- 复制到 OpenList ------------------------------- */

export type CopyStatus = "pending" | "done" | "skipped" | "failed";
export type CopyStage = "waiting" | "copying";
export type CopyTrigger = "offline" | "share" | "follow" | "monitor" | "manual";

/** 复制队列里的一条；和后端 services/copy/queue.ts 的 CopyRecord 对齐 */
export interface CopyItem {
  id: string;
  account: string;
  srcDir: string;
  name: string;
  isDir?: boolean;
  dstDir: string;
  taskId: string;
  trigger: CopyTrigger;
  /** 复制成功后源文件的去向（登记时按任务设置冻结） */
  afterCopy: CopyAfterCopy;
  addedAt: number;
  status: CopyStatus;
  stage: CopyStage;
  detail: string;
  doneAt?: number;
  attempts: number;
  waits: number;
  misses: number;
  /** 升级时从老的云下载回执接管来的：没有网盘路径，重试不了 */
  adopted?: boolean;
  /** 等自动整理先办完（ms）：没到点、也没被整理放行之前不提交 */
  holdUntil?: number;
  /** 后端算好的「能不能重试」：失败的、目标里已有同名而跳过的才行（接管来的、用不着了的、已复制的不行） */
  canRetry: boolean;
  /** 后端算好的「源文件还在网盘原处、能事后归档 / 删除」：复制好了、去向是不动（或当时没处理成）、知道属于哪个任务 */
  canAfterCopy: boolean;
}

/** POST /api/copy：手动把任务网盘目录里已有的目录 / 文件交给复制 */
export interface CopyAddInput {
  taskId: string;
  /** 相对任务网盘目录 */
  paths: string[];
  /** 不给用任务上 / 设置页的目标目录；给了只能是它们或它们下面的目录 */
  dstDir?: string;
  /** 不给按任务设置 */
  afterCopy?: CopyAfterCopy;
}
/** 每条路径的结果：整条登记 / 只补了缺的 / 目标里已经齐了 / 目标里已有同名文件 / 已经排着 / 整目录复制会带过去 / 网盘上没有 */
export type CopyAddOutcome = "queued" | "filled" | "complete" | "exists" | "duplicate" | "covered" | "missing";
export interface CopyAddResult {
  queued: number;
  dstDir: string | null;
  afterCopy: CopyAfterCopy;
  deleteSource: boolean;
  reason?: string;
  items: Array<{ path: string; outcome: CopyAddOutcome; queued: number; isDir?: boolean }>;
}

/** POST /api/copy/after：复制好的，事后把网盘上的源文件归档 / 删除 */
export interface CopyAfterInput {
  afterCopy: "archive" | "delete";
  /** 复制记录 id；和 taskId + paths 二选一 */
  ids?: string[];
  taskId?: string;
  /** 相对任务网盘目录 */
  paths?: string[];
  dstDir?: string;
}
/** 每条的下场：归档了 / 删了 / 临时错误稍后再试 / 没动（原因在 detail）/ 目标里不全 / 网盘上没有 / 还在复制、复制完会处理 / 还在复制 / 这条处理不了 */
export type CopyAfterOutcome = "archived" | "deleted" | "retrying" | "kept" | "incomplete" | "missing" | "scheduled" | "pending" | "invalid";
export interface CopyAfterResult {
  afterCopy: "archive" | "delete";
  /** 处理成了几条 */
  done: number;
  items: Array<{ path: string; id?: string; name: string; outcome: CopyAfterOutcome; isDir?: boolean; detail?: string; to?: string }>;
}

export interface CopyQueue {
  /** 能重试的在前、再是还在跑的，各自新的在前 */
  items: CopyItem[];
  /** 队列里一共多少条（items 只是前 limit 条） */
  total: number;
  watcher: { running: boolean; pending: number; lastTickAt: number | null; lastError: string | null };
}

/* ------------------------------- 115 云下载 ------------------------------- */

export type OfflineTaskState = "pending" | "downloading" | "done" | "failed" | "unknown";
export interface OfflineTask {
  infoHash: string;
  name: string;
  url: string;
  size: number;
  /** 0-100 */
  percent: number;
  status: number;
  state: OfflineTaskState;
  /** 115 给的中文说明 */
  statusText: string;
  /** unix 秒 */
  addTime: number;
  lastUpdate: number;
  leftTime: number;
  peers: number;
  rateDownload: number;
  dirId: string;
  resultId: string;
  resultName: string;
  isDir: boolean;
  move: number;
  pickCode: string;
}
export type OfflineFollowupStatus = "pending" | "done" | "failed";
/** 下载完成后的回执：生成 strm（缺省），或让 OpenList 复制走 */
export interface OfflineFollowup {
  /** 老记录没有这个字段，当 "strm" 看 */
  kind?: "strm" | "openlist-copy";
  infoHash: string;
  account: string;
  taskId: string;
  subPath: string;
  name: string;
  addedAt: number;
  status: OfflineFollowupStatus;
  detail: string;
  doneAt?: number;
  attempts: number;
  misses: number;
  copyWaits?: number;
  copyTaskId?: string;
  copySubmittedAt?: number;
  /** openlist-copy：复制目标目录 */
  copyDstDir?: string;
}
export interface OfflineWatcherStatus {
  running: boolean;
  pending: number;
  lastTickAt: number | null;
  lastError: string | null;
}
export interface OfflineListPage {
  account: string;
  page: number;
  pageCount: number;
  pageSize: number;
  count: number;
  quota: number | null;
  total: number | null;
  tasks: OfflineTask[];
  followups: OfflineFollowup[];
  watcher: OfflineWatcherStatus;
}
export interface OfflineAddResult {
  url: string;
  ok: boolean;
  infoHash?: string;
  name?: string;
  message?: string;
}
export interface OfflineAddResponse {
  account: string;
  dirId: string | null;
  dirPath: string | null;
  added: number;
  failed: number;
  invalid: string[];
  results: OfflineAddResult[];
  followup: boolean;
  /** 其中有没有「下完生成 strm」的回执（只复制的那种不生成 strm） */
  strmFollowup: boolean;
}
export interface OfflineAddInput {
  account?: string;
  /** 每行一条 */
  urls: string;
  dirId?: string;
  taskId?: string;
  subPath?: string;
  generateStrm?: boolean;
  /** 下完之后把产物交给复制队列；下到哪个目录都行，前提是这个账号配了挂载根 */
  copyToOpenlist?: boolean;
  /** 这次复制到哪（OpenList 完整路径）；不给用设置页的 dstDir */
  copyDstDir?: string;
}
export interface OfflineDownPath {
  id: string;
  name: string;
  selected: boolean;
}

/* ------------------------------- 分享追更 ------------------------------- */

export interface FollowWatcherStatus {
  running: boolean;
  lastTickAt: number | null;
  lastError: string | null;
  /** 正在检查的订阅 id */
  checking: string[];
}
export type FollowListResponse = { follows: ShareFollowSummary[]; watcher: FollowWatcherStatus };
export type FollowCheckResult = { follow: ShareFollowSummary; run: ShareFollowRun | null };
export type FollowCreateInput = {
  shareUrl?: string;
  shareCode?: string;
  receiveCode?: string;
  watchCid?: string | number;
  watchPath?: string;
  scope?: string[];
  taskId: string;
  subPath?: string;
  intervalMinutes?: number;
  name?: string;
  libraryId?: string;
};
export type FollowPatch = Partial<{
  name: string;
  enabled: boolean;
  intervalMinutes: number;
  taskId: string;
  subPath: string;
  receiveCode: string;
}>;

export type TelegramNotifyPrefs = Required<TelegramNotifySettings>;
export type TelegramPermissions = { allowTaskStart: boolean; allowOfflineAdd: boolean; allowShareReceive: boolean; allowOAuthApproval: boolean };
export interface TelegramBotStatus {
  configured: boolean;
  /** 掩码后的 token，原样提交等于不改 */
  botToken: string;
  chatId: string;
  allowedUsers: number[];
  permissions: TelegramPermissions;
  notify: TelegramNotifyPrefs;
  notifyDefaults: TelegramNotifyPrefs;
  polling: boolean;
  commands: { command: string; description: string }[];
  bot: { id: number; first_name: string; username?: string } | null;
  botError: string | null;
}

/* ------------------------------- 客户端 ------------------------------- */

const data = <T>(p: Promise<{ data: T }>): Promise<T> => p.then((r) => r.data);

export const api = {
  auth: {
    login: (username: string, password: string) =>
      data(
        axiosInstance.post<{ message: string; token: string; user: { username: string }; mustChangePassword: boolean }>(
          "/api/auth/login",
          { username, password },
        ),
      ),
    changePassword: (currentPassword: string, newPassword: string, opts: { revokeAgentTokens?: boolean } = {}) =>
      data(axiosInstance.post<{ message: string; revokedAgentTokens?: number }>("/api/auth/password", { currentPassword, newPassword, ...opts })),
    logout: () => data(axiosInstance.post<{ message: string }>("/api/auth/logout")),
  },

  settings: {
    get: () => data(axiosInstance.get<AppSettings>("/api/settings")),
    /** 按顶层键合并：只发本页拥有的键 */
    patch: (patch: Partial<AppSettings>) => data(axiosInstance.put<{ message: string }>("/api/settings", patch)),
    /**
     * 读-改-写一个顶层分组。PUT 是按顶层键整体替换，只改组内一个字段（比如 telegram.allowTaskStart）
     * 得先把库里的其它字段带上，不然 botToken / allowedUsers 会一起被抹掉。掩码的密钥原样回传等于不改。
     */
    patchGroup: async <K extends SettingsGroupKey>(key: K, partial: Partial<NonNullable<AppSettings[K]>>, opts: { currentPassword?: string } = {}) => {
      const current = (await data(axiosInstance.get<AppSettings>("/api/settings")))[key];
      return data(
        // telegramOAuthApprovalOff：开着「在 Telegram 里批准网页客户端」时换了能批的人，后端把它关掉了，给的是提示语
        axiosInstance.put<{ message: string; telegramOAuthApprovalOff?: string }>("/api/settings", {
          [key]: { ...(current ?? {}), ...partial },
          // 当前密码：打开「在 Telegram 里批准网页客户端」要它，后端核对完就丢，不进设置
          ...(opts.currentPassword ? { currentPassword: opts.currentPassword } : {}),
        }),
      );
    },
  },

  tasks: {
    list: () => data(axiosInstance.get<TaskRow[]>("/api/task")),
    create: (input: TaskInput) => data(axiosInstance.post<TaskDefinition>("/api/task", input)),
    update: (id: string, patch: Partial<TaskInput>) =>
      data(axiosInstance.put<TaskDefinition>("/api/task", { id, ...patch })),
    remove: (id: string) => data(axiosInstance.delete<{ success: true }>(`/api/task?id=${encodeURIComponent(id)}`)),
    /** 115 目录导出可能要等很久，超时放宽到 3 分钟 */
    start: (id: string) => data(axiosInstance.post<StartTaskResult>("/api/startTask", { id }, { timeout: 180_000 })),
    cancel: (id: string) => data(axiosInstance.post<{ message: string; taskId: string }>("/api/cancelTask", { taskId: id })),
    /** 试算 cron 接下来几次什么时候跑。表达式不合法回 400，由调用方当"还没打完"处理 */
    cronPreview: (expression: string) =>
      data(axiosInstance.post<{ next: string[] }>("/api/task/cron/preview", { expression })),
  },

  accounts: {
    list: () => data(axiosInstance.get<AccountInfo[]>("/api/account")),
    create: (input: Record<string, unknown>) => data(axiosInstance.post<AccountInfo>("/api/account", input)),
    update: (input: Record<string, unknown> & { name: string }) => data(axiosInstance.put<AccountInfo>("/api/account", input)),
    remove: (name: string) => data(axiosInstance.delete<{ message: string }>(`/api/account?name=${encodeURIComponent(name)}`)),
  },

  history: {
    /** 列表不带 logs；要看某次执行的日志用 get */
    list: (taskId?: string) =>
      data(axiosInstance.get<TaskExecutionSummary[]>(taskId ? `/api/taskHistory?taskId=${encodeURIComponent(taskId)}` : "/api/taskHistory")),
    get: (executionId: string) =>
      data(axiosInstance.get<TaskExecutionHistory>(`/api/taskHistory/${encodeURIComponent(executionId)}`)),
    remove: (executionId: string) =>
      data(axiosInstance.delete<{ success: true }>(`/api/taskHistory?executionId=${encodeURIComponent(executionId)}`)),
    clear: () => data(axiosInstance.delete<{ success: true; message: string }>("/api/taskHistory?action=cleanup")),
  },

  library: {
    list: () => data(axiosInstance.get<MediaLibraryEntry[]>("/api/library")),
    create: (input: LibraryCreateInput) => data(axiosInstance.post<LibraryAddResponse>("/api/library", input)),
    /** 一段话里认出的分享（批量添加先列给人看，加还是一个一个 create） */
    links: (text: string) => data(axiosInstance.post<{ links: LibraryShareLink[] }>("/api/library/links", { text })),
    update: (id: string, patch: LibraryPatch) => data(axiosInstance.put<MediaLibraryEntry>(`/api/library/${id}`, patch)),
    remove: (id: string) => data(axiosInstance.delete<{ success: true }>(`/api/library/${id}`)),
    /** 清理全部已失效的分享（只删影库记录和索引） */
    removeExpired: () => data(axiosInstance.delete<{ shares: number; sources: number }>("/api/library/expired")),
    /** 重新抄目录树 */
    refresh: (id: string) => data(axiosInstance.post<MediaLibraryEntry>(`/api/library/${id}/refresh`, {})),
    /** 换链接：内容和原来差很多时 409（code RELINK_MISMATCH），确认后带 confirm 再来 */
    relink: (id: string, shareUrl: string, confirm = false) =>
      data(axiosInstance.post<MediaLibraryEntry>(`/api/library/${id}/relink`, { shareUrl, ...(confirm ? { confirm: true } : {}) }, { timeout: 60_000 })),
    search: (query: LibrarySearchQuery, signal?: AbortSignal) =>
      data(
        axiosInstance.get<LibrarySearchResult>("/api/library/search", {
          params: { q: query.q, limit: query.limit, offset: query.offset, ...(query.expired ? { expired: "1" } : {}), ...(query.sourceId ? { sourceId: query.sourceId } : {}) },
          signal,
        }),
      ),
    /** 查一下这些分享还在不在（超过 6 小时没查过的才真去问网盘） */
    checkShares: (codes: string[]) =>
      data(axiosInstance.post<{ health: Record<string, LibraryShareHealth> }>("/api/library/shares/check", { codes }, { timeout: 60_000 })),
    /** 海报墙：同一个 tmdbId 的单元合成一张卡 */
    works: (query: { view?: LibraryWorksView; sort?: LibraryWorksSort; offset?: number; limit?: number }) =>
      data(axiosInstance.get<LibraryWorksResult>("/api/library/works", { params: query })),
    workDetail: (key: string) => data(axiosInstance.get<LibraryWorkDetail>("/api/library/works/detail", { params: { key } })),
    /** 作品单元：换匹配 / 不是影视 / 重新认 */
    unitAction: (
      body:
        | { action: "match"; sourceId: string; unitKey: string; mediaType: "movie" | "tv"; tmdbId: number }
        | { action: "ignore" | "reidentify"; sourceId: string; unitKey: string },
    ) => data(axiosInstance.post<{ unit: LibraryUnit | null }>("/api/library/units", body, { timeout: 60_000 })),
    /** 一个来源里自动认的都重新认（手动指定的、忽略的不动） */
    reidentify: (id: string) => data(axiosInstance.post<{ count: number }>(`/api/library/${id}/reidentify`, {})),
    saveToTask: (id: string, choice: SaveToTaskChoice) =>
      data(axiosInstance.post<ShareReceiveResult>(`/api/library/${id}/save-to-task`, choice, { timeout: 180_000 })),
  },

  follow: {
    list: () => data(axiosInstance.get<FollowListResponse>("/api/follow")),
    create: (input: FollowCreateInput) =>
      data(axiosInstance.post<ShareFollowSummary>("/api/follow", input, { timeout: 180_000 })),
    update: (id: string, patch: FollowPatch) =>
      data(axiosInstance.put<ShareFollowSummary>(`/api/follow/${encodeURIComponent(id)}`, patch)),
    remove: (id: string) => data(axiosInstance.delete<{ success: true }>(`/api/follow/${encodeURIComponent(id)}`)),
    /** 立即检查：要递归列分享目录，有新增还要转存，可能要等几十秒 */
    check: (id: string) =>
      data(axiosInstance.post<FollowCheckResult>(`/api/follow/${encodeURIComponent(id)}/check`, undefined, { timeout: 180_000 })),
  },

  share: {
    /** 账号由链接决定：先认出是 115 还是夸克的分享，再挑同类账号 */
    info: (url: string) => data(axiosInstance.post<ShareInfo>("/api/share", { action: "info", url })),
    list: (url: string, dirId = "0", cursor?: string, limit?: number) =>
      data(axiosInstance.post<ShareListPage>("/api/share", { action: "list", url, dirId, cursor, limit })),
    /** 转存到任务目录（带 taskId）或网盘目录（带 toDirId / toPath）；同步生成 + 建追更订阅都可能要等一会，超时放宽 */
    receive: (body: {
      url: string;
      items: ShareReceiveItem[];
      taskId?: string;
      subPath?: string;
      mode?: "sync" | "async";
      toDirId?: string;
      toPath?: string;
      /** 追更盯的目录（当前浏览的这一层）及其展示路径 / 订阅名 */
      watchDirId?: string;
      follow?: { intervalMinutes: number };
      watchPath?: string;
      name?: string;
      organize?: boolean;
      copy?: boolean;
    }) => data(axiosInstance.post<ShareReceiveResult>("/api/share", { action: "receive", ...body }, { timeout: 180_000 })),
  },

  /** 整理与规范化命名：预览 / 执行 / 撤销都是后台作业，接口立刻返回，轮询 get 看进度 */
  /** 检查更新：GET 只读缓存（不联网），POST 才真去问 GitHub（用户自己按的，有节流） */
  agent: {
    info: () => data(axiosInstance.get<AgentInfo>("/api/agent/info")),
    tokens: () => data(axiosInstance.get<AgentToken[]>("/api/agent/tokens")),
    /** toolsets 给 null 是「眼下的全部」，后端存成明确的列表；签令牌要输当前密码 */
    createToken: (input: { name: string; scopes: AgentScope[]; toolsets: AgentToolset[] | null; expiresInDays: number | null; currentPassword: string }) =>
      data(axiosInstance.post<AgentTokenCreated>("/api/agent/tokens", input)),
    updateToken: (id: string, patch: { name?: string; scopes?: AgentScope[]; toolsets?: AgentToolset[] | null }) =>
      data(axiosInstance.patch<AgentToken>(`/api/agent/tokens/${encodeURIComponent(id)}`, patch)),
    revokeToken: (id: string) => data(axiosInstance.delete<{ success: boolean }>(`/api/agent/tokens/${encodeURIComponent(id)}`)),
    revokeAll: () => data(axiosInstance.delete<{ deleted: number }>("/api/agent/tokens")),
    calls: (tokenId?: string, limit = 20) =>
      data(axiosInstance.get<{ calls: AgentCall[] }>("/api/agent/calls", { params: { tokenId: tokenId || undefined, limit } })),
    /** 网页客户端（OAuth）：待批准、已连接的、预注册的 */
    oauth: () => data(axiosInstance.get<AgentOAuthState>("/api/agent/oauth")),
    /** 批准：pairingCode 是授权页上显示的配对码（对不上不批），currentPassword 是管理界面的登录密码 */
    approveOAuth: (id: string, input: { pairingCode: string; scopes: AgentScope[]; toolsets: AgentToolset[] | null; currentPassword: string }) =>
      data(axiosInstance.post<{ success: boolean }>(`/api/agent/oauth/requests/${encodeURIComponent(id)}/approve`, input)),
    denyOAuth: (id: string) => data(axiosInstance.post<{ success: boolean }>(`/api/agent/oauth/requests/${encodeURIComponent(id)}/deny`)),
    denyAllOAuth: () => data(axiosInstance.post<{ denied: number }>("/api/agent/oauth/requests/deny-all")),
    revokeGrant: (id: string) => data(axiosInstance.delete<{ success: boolean }>(`/api/agent/oauth/grants/${encodeURIComponent(id)}`)),
    /** 改已连接客户端的档位、工具组（至少给一样）；toolsets 给 null 是全部。提档（多给了哪一档）要带当前密码。改完立即生效 */
    updateGrant: (id: string, patch: { scopes?: AgentScope[]; toolsets?: AgentToolset[] | null; currentPassword?: string }) =>
      data(
        axiosInstance.patch<{ success: boolean; scopes: AgentScope[]; toolsets: AgentToolset[] }>(`/api/agent/oauth/grants/${encodeURIComponent(id)}`, patch),
      ),
    revokeAllGrants: () => data(axiosInstance.delete<{ deleted: number }>("/api/agent/oauth/grants")),
    createOAuthClient: (input: { name: string; redirectUris: string[] }) => data(axiosInstance.post<OAuthClientCreated>("/api/agent/oauth/clients", input)),
    deleteOAuthClient: (id: string) => data(axiosInstance.delete<{ success: boolean }>(`/api/agent/oauth/clients/${encodeURIComponent(id)}`)),
    /** 连接自检：后端从自己那边请求公网地址，最多等十几秒 */
    selfCheck: () => data(axiosInstance.post<{ items: AgentSelfCheckItem[] }>("/api/agent/selfcheck", undefined, { timeout: 60_000 })),
  },
  update: {
    get: () => data(axiosInstance.get<UpdateStatus>("/api/update")),
    check: () => data(axiosInstance.post<UpdateStatus>("/api/update/check", undefined, { timeout: 20_000 })),
  },
  organize: {
    createRun: (input: { taskId: string; subPath?: string; paths?: string[] }) =>
      data(axiosInstance.post<OrganizeRun>("/api/organize/runs", input)),
    listRuns: (taskId?: string, limit = 30, offset = 0) =>
      data(axiosInstance.get<{ runs: OrganizeRun[] }>("/api/organize/runs", { params: { taskId: taskId || undefined, limit, offset: offset || undefined } })),
    /** 要人管的 run（跨任务）：待执行、进行中、有失败或做了一半、撤销没退回完的、自动触发的预览失败 */
    attention: () => data(axiosInstance.get<{ runs: OrganizeAttention[] }>("/api/organize/attention")),
    /** 详情：run + 单元 + 按单元的计数；项不带，展开时用 items 拉 */
    getRun: (id: string) => data(axiosInstance.get<OrganizeRunDetail>(`/api/organize/runs/${encodeURIComponent(id)}`)),
    /** 进行中轮询用：run（含进度 / 日志）+ 失败分组 + 按钮开关，不带单元和项 */
    summary: (id: string) => data(axiosInstance.get<OrganizeRunSummary>(`/api/organize/runs/${encodeURIComponent(id)}/summary`)),
    /** 按需拉项：一个单元的（unit 空串是建目录 / 删空目录），或者失败面板的一组 */
    items: (id: string, q: { unit: string } | { group: OrganizeFailureGroupKey }) =>
      data(axiosInstance.get<{ items: OrganizeItem[] }>(`/api/organize/runs/${encodeURIComponent(id)}/items`, { params: q })),
    patchUnit: (id: string, key: string, patch: OrganizeUnitPatch) =>
      data(axiosInstance.put<OrganizeUnit>(`/api/organize/runs/${encodeURIComponent(id)}/unit`, { key, ...patch }, { timeout: 60_000 })),
    /** 批量勾选单元（全选 / 全不选 / 只选把握大的）：一次重规划 */
    patchUnits: (id: string, keys: string[], patch: { selected?: boolean; remember?: boolean }) =>
      data(axiosInstance.put<{ changed: number }>(`/api/organize/runs/${encodeURIComponent(id)}/units`, { keys, ...patch }, { timeout: 120_000 })),
    /**
     * 按文件改：勾选 / 取消勾选（取消的跳过，跟着它的字幕 / nfo 一起留下），或给冲突项选办法
     * （resolve 为 null 是回到「留在原处」）；ids 用最新清单里的
     */
    patchItems: (id: string, ids: string[], patch: { selected?: boolean; resolve?: OrganizeConflictResolution | null }) =>
      data(axiosInstance.put<{ changed: number }>(`/api/organize/runs/${encodeURIComponent(id)}/items`, { ids, ...patch }, { timeout: 60_000 })),
    /** 换匹配弹框：按关键词搜（可限类型、年份） */
    tmdbSearch: (q: { query: string; type?: "movie" | "tv"; year?: string }) =>
      data(axiosInstance.post<{ results: OrganizeCandidate[] }>("/api/organize/tmdb/search", q)),
    /** 换匹配弹框：按 TMDB 编号查 */
    tmdbLookup: (type: "movie" | "tv", id: number) => data(axiosInstance.get<OrganizeCandidate>(`/api/organize/tmdb/${type}/${id}`)),
    /** 不带 ids：ready 的执行全部，其它状态重试失败 / 没做的（默认只重试临时失败）；带 ids 只重试点名的项 */
    /** planVersion：执行待确认的清单时带上详情里给的，打开之后清单被改过就回 409 PLAN_CHANGED */
    apply: (id: string, ids?: string[], planVersion?: string) =>
      data(axiosInstance.post<OrganizeRun>(`/api/organize/runs/${encodeURIComponent(id)}/apply`, { ...(ids ? { ids } : {}), ...(planVersion ? { planVersion } : {}) })),
    /** 放弃失败项：标成「已放弃」让 run 收口；原地改了名还没挪走的先在网盘上改回原名，所以给长一点的超时 */
    skip: (id: string, ids: string[]) => data(axiosInstance.post<OrganizeSkipResult>(`/api/organize/runs/${encodeURIComponent(id)}/skip`, { ids }, { timeout: 120_000 })),
    /** 按原范围、原触发来源重新预览：返回新建的 run */
    repreview: (id: string) => data(axiosInstance.post<OrganizeRun>(`/api/organize/runs/${encodeURIComponent(id)}/repreview`)),
    cancel: (id: string) => data(axiosInstance.post<OrganizeRun>(`/api/organize/runs/${encodeURIComponent(id)}/cancel`)),
    revert: (id: string) => data(axiosInstance.post<OrganizeRun>(`/api/organize/runs/${encodeURIComponent(id)}/revert`)),
    remove: (id: string) => data(axiosInstance.delete<{ success: true }>(`/api/organize/runs/${encodeURIComponent(id)}`)),
    previewName: (body: { templates?: { movie?: string; tv?: string }; idTag?: string; colon?: string; episodeTitle?: boolean; rules?: string[] }) =>
      data(axiosInstance.post<OrganizeTemplatePreview>("/api/organize/preview-name", body)),
    matches: (account?: string) => data(axiosInstance.get<{ matches: OrganizeMatchMemory[] }>("/api/organize/matches", { params: { account } })),
    forgetMatch: (accountName: string, srcPath: string) =>
      data(axiosInstance.delete<{ success: boolean }>("/api/organize/matches", { data: { accountName, srcPath } })),
  },

  drive115: {
    /** 网盘目录内容（原始字段：cid / n / fc）；account 不传取第一个 115 账号 */
    list: (cid: number | string, account?: string) =>
      data(axiosInstance.post<Drive115Item[]>("/api/115/files", { cid, account })),
  },

  offline: {
    list: (account?: string, page = 1) =>
      data(axiosInstance.get<OfflineListPage>("/api/115/offline", { params: { account, page } })),
    /** 提交给 115 之前要解析目录，可能慢一点 */
    add: (input: OfflineAddInput) => data(axiosInstance.post<OfflineAddResponse>("/api/115/offline", input, { timeout: 60_000 })),
    remove: (body: { account?: string; infoHashes: string[]; deleteFiles?: boolean }) =>
      data(axiosInstance.post<{ success: true; removed: number }>("/api/115/offline/delete", body)),
    /** flag：0 已完成 / 1 全部 / 2 已失败 / 3 进行中 / 4 已完成+删源文件 / 5 全部+删源文件 */
    clear: (body: { account?: string; flag: number }) =>
      data(axiosInstance.post<{ success: true }>("/api/115/offline/clear", body)),
    restart: (body: { account?: string; infoHash: string }) =>
      data(axiosInstance.post<{ success: true }>("/api/115/offline/restart", body)),
    downPaths: (account?: string) =>
      data(axiosInstance.get<{ dirs: OfflineDownPath[] }>("/api/115/offline/downpath", { params: { account } })),
  },

  /** 复制到 OpenList 的队列：登记是各个来源自己做的，这里只看进度、重试、不跟了 */
  copy: {
    list: (limit = 20) => data(axiosInstance.get<CopyQueue>("/api/copy", { params: { limit } })),
    /** 手动发起：要到网盘核对路径、和目标比对，115 整目录导出要几分钟（和 strm 校验一样给足） */
    add: (input: CopyAddInput) => data(axiosInstance.post<CopyAddResult>("/api/copy", input, { timeout: 330_000 })),
    retry: (id: string) => data(axiosInstance.post<CopyItem>(`/api/copy/${encodeURIComponent(id)}/retry`)),
    /** 事后归档 / 删除源文件：要到网盘和 OpenList 核对再挪，和发起复制一样等得久一点 */
    after: (input: CopyAfterInput) => data(axiosInstance.post<CopyAfterResult>("/api/copy/after", input, { timeout: 330_000 })),
    remove: (id: string) => data(axiosInstance.delete<{ success: true }>(`/api/copy/${encodeURIComponent(id)}`)),
  },

  /** strm 管理：路径都是相对任务 targetPath 的 POSIX 路径，"" 是任务根目录 */
  strm: {
    list: (taskId: string, path = "") =>
      data(axiosInstance.get<StrmListResult>("/api/strm/list", { params: { taskId, path } })),
    file: (taskId: string, path: string) =>
      data(axiosInstance.get<StrmFileInfo>("/api/strm/file", { params: { taskId, path } })),
    /** 整个目录递归找名字，大库要一会 */
    search: (taskId: string, q: string) =>
      data(axiosInstance.get<StrmSearchResult>("/api/strm/search", { params: { taskId, q }, timeout: 60_000 })),
    remove: (taskId: string, paths: string[]) =>
      data(axiosInstance.post<StrmDeleteResult>("/api/strm/delete", { taskId, paths }, { timeout: 120_000 })),
    /** 扫描一个目录（"" 是整个任务），大目录要一两分钟 */
    scan: (taskId: string, path = "") =>
      data(axiosInstance.post<StrmScanResult>("/api/strm/scan", { taskId, path }, { timeout: 120_000 })),
    /** 到网盘确认单个文件还在不在；整目录用下面的 verifyStream，别把请求干挂着 */
    verify: (taskId: string, path = "") =>
      data(axiosInstance.post<StrmVerifyResult>("/api/strm/verify", { taskId, path }, { timeout: 330_000 })),
    /**
     * 校验整个目录：走事件流，进度一路推，最后一条是结果。
     * signal 一掐连接就断，后端那一轮校验跟着停（不再接着打网盘）。
     */
    verifyStream: (taskId: string, path: string, opts: { signal?: AbortSignal; onEvent: (event: StrmVerifyEvent) => void }) =>
      streamSse<StrmVerifyEvent>("/api/strm/verify/stream", { body: { taskId, path }, ...opts }),
    /** 读 115 目录再生成，最长五分钟；根目录 400、任务同步中 409、115 目录没了 404 */
    regenerate: (taskId: string, path: string, mode: StrmRegenerateMode) =>
      data(axiosInstance.post<StrmRegenerateResult>("/api/strm/regenerate", { taskId, path, mode }, { timeout: 330_000 })),
    rewrite: (taskId: string, path: string, dryRun: boolean) =>
      data(axiosInstance.post<StrmRewriteResult>("/api/strm/rewrite", { taskId, path, dryRun }, { timeout: 120_000 })),
    /** 背景海报：一批目录各拿一张，拿不到的不在结果里；known 是有线索的目录。offline 只用离线的几级、不去 TMDB 现查 */
    posters: (taskId: string, paths: string[], opts: { offline?: boolean } = {}) =>
      data(axiosInstance.post<StrmPosterResult>("/api/strm/posters", { taskId, paths, ...opts })),
    /** 任务页背景：所有任务的本地目录里抽一批作品海报，新的在前。头一回要把整个库走一遍，给宽一点 */
    allPosters: () => data(axiosInstance.get<StrmAllPostersResult>("/api/strm/posters/all", { timeout: 60_000 })),
    /** 本地图片。<img> 带不了 Authorization 头，所以取 blob 再用 object URL 显示 */
    image: (taskId: string, path: string) =>
      data(axiosInstance.get<Blob>("/api/strm/image", { params: { taskId, path }, responseType: "blob" })),
  },

  directory: {
    local: (basePath = "") => data(axiosInstance.post<DirectoryNode[]>("/api/directory/local/list", { basePath })),
    remote: (account: string, path = "", withFiles = false) =>
      data(axiosInstance.post<DirectoryNode[]>("/api/directory/remote/list", { account, path, ...(withFiles ? { withFiles: true } : {}) })),
  },

  tmdb: {
    search: (query: string, language?: string, signal?: AbortSignal) =>
      data(axiosInstance.post<TmdbSearchResult[]>("/api/library/tmdb/search", { query, language }, { signal })),
  },

  /** 资源搜索（PanSou）：一次搜索分几问——first 出第一屏，more 隔几秒再问把插件补完的拿回来 */
  resource: {
    /** titleEn：选了 TMDB 候选时带的外文原名，后端交给 PanSou 认它的插件 */
    search: (keyword: string, phase: "first" | "more", opts: { refresh?: boolean; signal?: AbortSignal; titleEn?: string } = {}) =>
      data(
        axiosInstance.post<ResourceSearchResult>(
          "/api/resource/search",
          { keyword, phase, ...(opts.refresh ? { refresh: true } : {}), ...(opts.titleEn ? { titleEn: opts.titleEn } : {}) },
          // PanSou 冷查询要 5～8 秒，频道多时更久：后端给它 25 秒
          { timeout: 35_000, signal: opts.signal },
        ),
      ),
    /** 最多 10 条；后端只认 115 / 夸克的分享 */
    check: (urls: string[], signal?: AbortSignal) =>
      data(axiosInstance.post<ResourceCheckResult>("/api/resource/check", { urls }, { timeout: 20_000, signal })),
    /** 设置页的「检查连接」：用表单里还没保存的值，密码是掩码就用库里的 */
    status: (input: { baseUrl?: string; username?: string; password?: string }) =>
      data(axiosInstance.post<ResourceStatus>("/api/resource/status", input, { timeout: 20_000 })),
  },

  hdhive: {
    search: (body: { query?: string; tmdbId?: number; mediaType?: "movie" | "tv" }) =>
      data(axiosInstance.post<HdhiveSearchResult>("/api/library/hdhive/search", body)),
    unlock: (slug: string) => data(axiosInstance.post<HdhiveUnlockResult>("/api/library/hdhive/unlock", { slug })),
  },

  life: {
    status: () => data(axiosInstance.get<LifeMonitorStatus>("/api/life/monitor")),
    events: (limit = 30) => data(axiosInstance.get<{ events: LifeEventRow[] }>(`/api/life/events?limit=${limit}`)),
    start: (config?: LifeMonitorSettings) =>
      data(
        axiosInstance.post<{ success: boolean; message: string; partial: boolean; status: LifeMonitorStatus }>(
          "/api/life/monitor",
          { config },
        ),
      ),
    stop: () => data(axiosInstance.delete<{ success: boolean; message: string }>("/api/life/monitor")),
    probe: (limit = 5, account?: string) =>
      data(axiosInstance.post<LifeProbeResult>("/api/life/probe", { limit, account })),
  },

  telegram: {
    status: () => data(axiosInstance.get<TelegramBotStatus>("/api/telegram/bot")),
    /** oauthApprovalOff：换了机器人 / chat id，后端把「在 Telegram 里批准网页客户端」关掉了，给的是提示语 */
    configure: (input: { botToken: string; chatId?: string }) =>
      data(axiosInstance.post<{ success: boolean; message: string; oauthApprovalOff?: string }>("/api/telegram/bot", input)),
    remove: () => data(axiosInstance.delete<{ success: boolean; message: string }>("/api/telegram/bot")),
    test: () => data(axiosInstance.post<{ success: boolean }>("/api/telegram/test")),
    polling: {
      start: () => data(axiosInstance.post<{ success: boolean; message: string }>("/api/telegram/polling")),
      stop: () => data(axiosInstance.delete<{ success: boolean; message: string }>("/api/telegram/polling")),
      restart: () => data(axiosInstance.put<{ success: boolean; message: string }>("/api/telegram/polling")),
    },
    users: {
      add: (userId: string | number) =>
        data(axiosInstance.post<{ success: boolean; message: string; oauthApprovalOff?: string }>("/api/telegram/users", { userId })),
      remove: (userId: number) =>
        data(axiosInstance.delete<{ success: boolean; message: string }>(`/api/telegram/users?userId=${userId}`)),
    },
  },

  system: {
    clearDirectory: (targetPath: string) =>
      data(axiosInstance.post<{ message: string; clearedPath: string }>("/api/clearDirectory", { targetPath })),
    /** 一致性快照，返回文件内容和后端给的文件名 */
    backup: async (): Promise<{ blob: Blob; filename: string }> => {
      const res = await axiosInstance.get<Blob>("/api/system/backup", { responseType: "blob" });
      const disposition = String(res.headers["content-disposition"] ?? "");
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "openstrm.db";
      return { blob: res.data, filename };
    },
  },
};
