import type { AgentSettings } from "./agent.js";
import type { OrganizeSettings } from "./organize.js";

/** 冷启动时从哪里开始拉变更：latest 只看启动之后的，all 把现有文件全当新增补齐，last 从上次停的游标继续 */
export type LifePullMode = "latest" | "all" | "last";

/** 网盘变更里需要落到本地的动作类型 */
export type LifeEventMode = "create" | "move" | "rename" | "remove";

export type LifeMonitorSettings = {
  enabled?: boolean;
  /** 要监控的账号名（115 / 夸克）；为空时监控全部能监控的账号，每个账号各跑一条轮询 */
  accounts?: string[];
  /** latest=只处理启动之后的事件；all=全量补齐；last=从上次停止的游标继续 */
  pullMode?: LifePullMode;
  /** 两轮轮询之间的间隔秒数，默认 15；夸克是快照对比，最短 300 */
  intervalSeconds?: number;
  /** 允许的事件动作，默认全开 */
  eventModes?: LifeEventMode[];
  /** 本地文件变更后，安静多少秒才通知 Emby 刷新，默认 30 */
  mediaServerRefreshDelay?: number;
  /** 从第一次变更算起最多等多少秒，防止事件不断把刷新饿死，默认 300 */
  mediaServerRefreshMaxWait?: number;
};

/** 主动推送哪些事件；缺省值见后端 telegram/notify.ts 的 DEFAULT_NOTIFY（任务开始默认关，其它默认开） */
export type TelegramNotifySettings = {
  taskStart?: boolean;
  taskDone?: boolean;
  taskFailed?: boolean;
  offline?: boolean;
  /** 115 cookie 失效 / 被封控 */
  accountAlert?: boolean;
  /** 分享追更：转存了新文件、分享失效、长期没更新 */
  follow?: boolean;
  /** Emby 入库：新条目被收进媒体库（按剧聚合） */
  embyNew?: boolean;
  /** 整理：执行完成、有待确认的清单 */
  organize?: boolean;
  /** 有新版本；默认关（唯一一类和自己的媒体库无关的通知），同一个版本只推一次 */
  update?: boolean;
  /** 影库：每天巡检确认有分享失效了 */
  library?: boolean;
};

export type TelegramSettings = {
  botToken?: string;
  /** 通知发到哪个会话；也是唯一会响应命令的群 */
  chatId?: string;
  /** 老版本的字段，已不再使用（webhook 模式已移除） */
  webhookUrl?: string;
  allowedUsers?: number[];
  /**
   * 会产生副作用的动作各有一个开关，默认全关：
   * 按钮一按就会真的跑任务 / 往网盘里加东西，需要显式开启。
   */
  allowTaskStart?: boolean;
  allowOfflineAdd?: boolean;
  allowShareReceive?: boolean;
  /** 允许在 Telegram 里批准网页客户端（claude.ai、ChatGPT）的连接：把授权页上的配对码发给机器人 */
  allowOAuthApproval?: boolean;
  /** 轮询开关的落库副本：轮询状态只在内存里，进程重启后据此自动恢复 */
  pollingEnabled?: boolean;
  notify?: TelegramNotifySettings;
};

export type AppSettings = {
  "user-agent"?: string;
  strmExtensions?: string[];
  downloadExtensions?: string[];
  /** 网盘限流：每个网盘账号各算各的，保存后立即生效 */
  throttle?: ThrottleSettings;
  /** 手填的额外挂载前缀；开了 302 的任务的 strmPrefix 会自动算作挂载点，不用填在这里 */
  mediaMountPath?: string[];
  emby?: {
    url?: string;
    apiKey?: string;
    /**
     * 请求不带任何 Emby 凭据时，是否仍用配置里的管理员 key 去解析并 302。
     *
     * 默认关闭：开着等于任何能访问代理端口的人都能拿到媒体直链，无需登录 Emby。
     * 只有那种连请求头里都不带令牌的客户端才需要打开，代价是放弃这道校验。
     */
    allowAnonymousRedirect?: boolean;
    /**
     * 302 代理的路径映射：Emby 看到的路径前缀 → 哪个网盘账号的哪个目录。
     * 开了 302 的任务推得出来的不用填（strmPrefix + originPath 就是映射）；这里是给任务推不出来的：
     * 别的工具生成的 strm、挂载结构不是「一个前缀对一个目录」的。手填的优先于任务推出来的。
     */
    pathMappings?: ProxyPathMapping[];
    /** 302 代理的路由规则：按客户端 / 来源 / 路径决定走直链还是交给 Emby，从上到下第一条命中的生效 */
    routeRules?: ProxyRouteRule[];
  };
  telegram?: TelegramSettings;
  tmdb?: {
    apiKey?: string;
    language?: string;
  };
  hdhive?: {
    apiKey?: string;
    baseUrl?: string;
  };
  /** 网盘监控（增量监测网盘文件变动：115 生活事件流、夸克目录快照对比） */
  lifeMonitor?: LifeMonitorSettings;
  /** 云下载完成后，让 OpenList 把产物复制到另一个存储（如挂载的本地磁盘） */
  openlistCopy?: OpenlistCopySettings;
  /** 整理与规范化命名：模板、id 标签、识别词、分类、自动整理默认策略 */
  organize?: OrganizeSettings;
  /** 检查更新 */
  update?: UpdateSettings;
  /** 智能体接入：MCP 端点开关、生成跳转链接用的管理界面地址 */
  agent?: AgentSettings;
  /** 资源搜索：对接用户自己部署的 PanSou */
  pansou?: PansouSettings;
  /** 影库：收藏的分享抄目录树建索引 */
  library?: LibrarySettings;
} & Record<string, unknown>;

/** 302 代理的一条路径映射 */
export type ProxyPathMapping = {
  /** Emby 看到的路径前缀（strm 里写的路径开头）：本地挂载路径（/mnt/115/主号）或 http(s) 地址 */
  from: string;
  /** 这段路径下的文件在哪个网盘账号里（账号名；只有 115 能 302） */
  account: string;
  /** 前缀对应网盘上的哪个目录，不填是根目录 */
  to?: string;
};

/** 命中路由规则后怎么播：redirect = 302 到直链（没命中任何规则时的默认）；relay = 不动，交给 Emby 自己处理（中转或转码） */
export type ProxyRouteAction = "redirect" | "relay";

/**
 * 302 代理的一条路由规则。填了的条件都满足才算命中（与关系）；一个条件都不填 = 全部命中。
 * 规则从上到下看，第一条命中的决定怎么播；一条都没命中按 redirect。
 */
export type ProxyRouteRule = {
  action: ProxyRouteAction;
  /** 备注，只给人看 */
  note?: string;
  /** User-Agent 包含这段（不分大小写） */
  userAgent?: string;
  /** 客户端名（X-Emby-Client）包含这段，如 Emby Web、Infuse、Emby for Android TV */
  client?: string;
  /** 设备名（X-Emby-Device-Name）包含这段 */
  deviceName?: string;
  /** 设备 id（X-Emby-Device-Id）正好等于；设备 id 不跟着切换用户变 */
  deviceId?: string;
  /** Emby 看到的路径以这段开头（按目录边界） */
  path?: string;
  /** 来源：lan = 本机和内网地址，wan = 其它。放在反代后面要设 TRUST_PROXY 才认得出 */
  remote?: "lan" | "wan";
};

/**
 * 网盘限流。默认值和上下限只在后端有一份（db/defaults.ts），GET /api/settings 回的总是补齐的三个值。
 * 2.13 及以前这一组叫 download，字段是 linkMaxPerSecond / linkMaxConcurrent / downloadMaxConcurrent（迁移 0021 换的名）。
 */
export type ThrottleSettings = {
  /** 一个账号每秒最多发几个接口请求（列目录、取直链、转存、整理、监控都算），匀速发；可以是小数，0.5 = 两秒一个 */
  requestsPerSecond?: number;
  /** 一个账号同时在路上的接口请求数；监控、云下载各有自己的一份 */
  requestConcurrency?: number;
  /** 一个账号同时下载几个文件；下载不占每秒请求数 */
  downloadConcurrency?: number;
};

/** 影库 */
export type LibrarySettings = {
  /** 每天检查一遍收藏的分享还在不在（每个分享一次请求）；缺省是开 */
  patrol?: boolean;
};

/** 资源搜索：对接用户自己部署的 PanSou（网盘分享和磁力的搜索服务）。baseUrl 空着 = 功能关 */
export type PansouSettings = {
  /** 如 http://pansou:8888；带网页的版本填站点地址也行（网页和 /api 同源） */
  baseUrl?: string;
  /** PanSou 开了登录（AUTH_ENABLED）才填 */
  username?: string;
  password?: string;
  /** 自动检测看得见的分享链接是否还有效（经 PanSou 的检测接口）；不填当开 */
  checkLinks?: boolean;
  /** 屏蔽词：标题或标签里带任何一个（不分大小写）的结果不显示。网页、Telegram、智能体都生效 */
  blockWords?: string[];
};

/**
 * 检查更新：问一次 GitHub 的发布接口，比一下版本号。
 * enabled 默认关——装上不主动联网；它只管定时检查，设置页的「立即检查」是用户自己按的，什么时候都能用
 */
export type UpdateSettings = {
  enabled?: boolean;
  /** 连预发布（rc）一起看；不填时按当前版本自己判断：跑 rc 就跟 rc 比 */
  includePrerelease?: boolean;
};

/**
 * 「复制到 OpenList」：新落到网盘上的文件，让 OpenList 复制到另一个存储（如挂载的本地磁盘）。
 *
 * account + dstDir + 这个网盘账号的挂载根，三样齐了这个账号才复制得了。
 */
export type OpenlistCopySettings = {
  /** 用哪个 openlist 账号调 API（「账户」页里的账号名） */
  account?: string;
  /** 复制目标目录（另一个存储里的路径），如 /local/downloads */
  dstDir?: string;
  /**
   * 网盘账号名 → 它在 OpenList 里的挂载根，如 `{ "my115": "/115" }`。
   * 网盘上的绝对路径拼上挂载根就是 OpenList 里的路径，所以任意目录、任意网盘都复制得了。
   */
  mounts?: Record<string, string>;
  /**
   * 旧字段：115 默认下载目录在 OpenList 里的完整路径，如 /115/云下载。
   * 升级时会尽量反推成 mounts 里的挂载根；推不出来就留着，只给「下到 115 默认目录」那条老路兜底
   */
  srcDir?: string;
};
