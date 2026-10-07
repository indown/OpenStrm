/**
 * 跨路由共用的实体 schema。`satisfies z.ZodType<…>` 把它们钉在 @openstrm/shared 的类型上：
 * schema 产出的形状对不上类型，这里就编译不过。
 */
import { z } from "zod";
import { validateCronExpression } from "cron";
import type { AppSettings, LifeMonitorSettings, TaskDefinition } from "@openstrm/shared";
import { normalizeStrmPrefix } from "../services/strm/naming.js";
import { validateTemplate } from "../services/organize/template.js";
import { parseRules } from "../services/organize/rules.js";
import { isOpenlistRootInput, OPENLIST_ROOT_TARGET } from "../services/copy/paths.js";
import { THROTTLE_LIMITS } from "../db/defaults.js";

/** 115 的 id 超过 JS 安全整数，前端有的地方传字符串、有的传数字 */
export const cidSchema = z.union([z.string(), z.number()]);

/** 限流的一个值：上下限和设置页表单的一致（db/defaults.ts 的 THROTTLE_LIMITS） */
const throttleNumber = ({ min, max }: { min: number; max: number }, label: string) =>
  z.number().min(min, `${label}填 ${min}–${max}`).max(max, `${label}填 ${min}–${max}`);

/** 地址后面要拼 /api/…：带用户名密码（user:pass@）、? 参数、# 的都拼不对，也不该把凭据写在地址里 */
function isPlainBaseUrl(v: string): boolean {
  return !/[?#\s]/.test(v) && !/^https?:\/\/[^/]*@/i.test(v) && URL.canParse(v);
}

/** PanSou 地址：设置和「检查连接」共用一条规则；空串是清掉 */
export const pansouBaseUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^https?:\/\/[^\s/]+/i.test(v), "PanSou 地址要以 http:// 或 https:// 开头")
  .refine((v) => v === "" || !/^https?:\/\//i.test(v) || isPlainBaseUrl(v), "PanSou 地址只填到主机、端口（或路径）为止：别带用户名密码、? 参数和 #");

/** `/:id` 路由参数 */
export const idParamsSchema = z.object({ id: z.string().min(1) });

/**
 * 空串表示不定时（前端清空字段时就发空串）；其余必须能被 cron 解析。
 * 不在这里拦住的话，坏表达式会被存进库，之后每次启动排程都在 new CronJob 上炸。
 */
export const cronExpressionSchema = z
  .string()
  .refine((v) => v === "" || validateCronExpression(v).valid, { message: "invalid cron expression" });

/** 复制到 OpenList 的目标目录（任务上的、设置页的默认值）：空的是没填；填成 OpenList 根 / 的不收，根上复制不进去 */
const copyTargetDirSchema = z.string().refine((v) => !isOpenlistRootInput(v), OPENLIST_ROOT_TARGET);

export const taskInputSchema = z.looseObject({
  account: z.string().min(1),
  originPath: z.string(),
  targetPath: z.string().min(1),
  accountType: z.string().optional(),
  // 尾斜杠在入口统一去掉：三条写入链路都是 `${prefix}/${path}` 直接拼，带着它写出来的就是 `http://h/d//tv/…`
  strmPrefix: z.string().transform(normalizeStrmPrefix).optional(),
  removeExtraFiles: z.boolean().optional(),
  enablePathEncoding: z.boolean().optional(),
  enable302: z.boolean().optional(),
  cronExpression: cronExpressionSchema.optional(),
  organize: z
    .object({
      mode: z.enum(["off", "review", "auto"]).optional(),
      libraryType: z.enum(["movie", "tv", "mixed"]).optional(),
    })
    .optional(),
  copyToOpenlist: z
    .object({
      enabled: z.boolean().optional(),
      dstDir: copyTargetDirSchema.optional(),
      afterCopy: z.enum(["keep", "delete", "archive"]).optional(),
      // 旧字段：老请求还可能带，仓库层读写时归一成 afterCopy
      deleteSource: z.boolean().optional(),
    })
    .optional(),
}) satisfies z.ZodType<Omit<TaskDefinition, "id">>;

export const taskPatchSchema = taskInputSchema.partial().extend({ id: z.string().min(1) });

/** 转存接口顺手建追更订阅时的选项；间隔的上下限在 services/follow/service.ts 里夹 */
export const followOptionSchema = z.object({ intervalMinutes: z.number().int().optional() });

export const shareFollowCreateSchema = z.object({
  shareUrl: z.string().optional(),
  shareCode: z.string().optional(),
  receiveCode: z.string().optional(),
  watchCid: cidSchema.optional(),
  watchPath: z.string().optional(),
  scope: z.array(z.string()).optional(),
  taskId: z.string().min(1, "taskId is required"),
  subPath: z.string().optional(),
  intervalMinutes: z.number().int().optional(),
  name: z.string().optional(),
  libraryId: z.string().optional(),
});

export const shareFollowPatchSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().optional(),
  taskId: z.string().min(1).optional(),
  subPath: z.string().optional(),
  receiveCode: z.string().optional(),
});

const account115Schema = z.looseObject({
  accountType: z.literal("115"),
  name: z.string().min(1),
  cookie: z.string({ error: "cookie is required for 115 accounts" }).min(1, "cookie is required for 115 accounts"),
});

const accountOpenlistSchema = z.looseObject({
  accountType: z.literal("openlist"),
  name: z.string().min(1),
  account: z.string({ error: "account, password, and url are required for openlist accounts" }).min(1),
  password: z.string({ error: "account, password, and url are required for openlist accounts" }).min(1),
  url: z.string({ error: "account, password, and url are required for openlist accounts" }).min(1),
});

const accountQuarkSchema = z.looseObject({
  accountType: z.literal("quark"),
  name: z.string().min(1),
  cookie: z.string({ error: "cookie is required for quark accounts" }).min(1, "cookie is required for quark accounts"),
});

export const accountInputSchema = z.discriminatedUnion("accountType", [
  account115Schema,
  accountOpenlistSchema,
  accountQuarkSchema,
]);

/** 改账号：name 定位，其余字段可选；凭据是否齐全由路由按 accountType 再查 */
export const accountPatchSchema = z.looseObject({
  name: z.string().min(1),
  accountType: z.enum(["115", "openlist", "quark"]).optional(),
});

export const lifeMonitorSchema = z.looseObject({
  enabled: z.boolean().optional(),
  accounts: z.array(z.string()).optional(),
  pullMode: z.enum(["latest", "all", "last"]).optional(),
  intervalSeconds: z.number().int().positive().optional(),
  eventModes: z.array(z.enum(["create", "move", "rename", "remove"])).optional(),
  mediaServerRefreshDelay: z.number().int().min(0).optional(),
  mediaServerRefreshMaxWait: z.number().int().min(0).optional(),
}) satisfies z.ZodType<LifeMonitorSettings>;

const categoryRuleSchema = z.object({
  name: z.string().trim().min(1),
  genreIds: z.array(z.number().int()).optional(),
  countries: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
});

/** 整理设置：模板和识别词在入口就校验，坏模板存进去每次预览都会炸 */
export const organizeSettingsSchema = z
  .looseObject({
    templates: z
      .object({
        movie: z.string().refine((v) => !v.trim() || validateTemplate(v).length === 0, { error: (iss) => `电影模板：${validateTemplate(String(iss.input)).join("；")}` }).optional(),
        tv: z.string().refine((v) => !v.trim() || validateTemplate(v).length === 0, { error: (iss) => `剧集模板：${validateTemplate(String(iss.input)).join("；")}` }).optional(),
      })
      .optional(),
    idTag: z.enum(["emby", "jellyfin", "plex", "none"]).optional(),
    colon: z.enum(["smart", "delete", "dash", "spaceDash"]).optional(),
    episodeTitle: z.boolean().optional(),
    categories: z.looseObject({ enabled: z.boolean().optional(), movie: z.array(categoryRuleSchema).optional(), tv: z.array(categoryRuleSchema).optional() }).optional(),
    rules: z
      .array(z.string())
      .refine((lines) => parseRules(lines).errors.length === 0, { error: (iss) => `识别词：${parseRules(iss.input as string[]).errors.join("；")}` })
      .optional(),
    cleanupEmptyDirs: z.boolean().optional(),
    extras: z.enum(["keep", "move"]).optional(),
    auto: z.enum(["off", "review", "auto"]).optional(),
  });

/** PUT /api/settings 的 body：只校验认识的键的类型，多出来的顶层键原样存 */
/** https 的源（可以带端口，不能带路径、查询串、账号密码；域名结尾不能带点） */
function isHttpsOrigin(v: string): boolean {
  try {
    const u = new URL(v);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (u.pathname === "/" || u.pathname === "") &&
      !u.search &&
      !u.hash &&
      !u.hostname.endsWith(".")
    );
  } catch {
    return false;
  }
}

export const settingsPatchSchema = z.looseObject({
  "user-agent": z.string().optional(),
  strmExtensions: z.array(z.string()).optional(),
  downloadExtensions: z.array(z.string()).optional(),
  mediaMountPath: z.array(z.string()).optional(),
  emby: z
    .looseObject({
      url: z.string().optional(),
      apiKey: z.string().optional(),
      allowAnonymousRedirect: z.boolean().optional(),
      pathMappings: z
        .array(
          z.object({
            from: z
              .string()
              .trim()
              .min(1, "路径映射：Emby 路径前缀不能为空")
              .max(500, "路径映射：Emby 路径前缀太长")
              .refine((v) => /^(\/|https?:\/\/)/i.test(v), "路径映射：Emby 路径前缀要以 / 或 http(s):// 开头"),
            account: z.string().trim().min(1, "路径映射：要选网盘账号").max(100),
            to: z.string().trim().max(500, "路径映射：网盘目录太长").optional(),
          }),
        )
        .max(100, "路径映射最多 100 条")
        // 同一个前缀两条：解析时只会认第一条，第二条形同虚设，不如在这里就说清楚
        .refine((list) => new Set(list.map((m) => m.from.replace(/\/+$/, ""))).size === list.length, "路径映射里有重复的 Emby 路径前缀")
        .optional(),
      routeRules: z
        .array(
          z.object({
            action: z.enum(["redirect", "relay"], "路由规则：处理方式只能是 redirect 或 relay"),
            note: z.string().trim().max(100, "路由规则：备注太长").optional(),
            userAgent: z.string().trim().max(200).optional(),
            client: z.string().trim().max(200).optional(),
            deviceName: z.string().trim().max(200).optional(),
            deviceId: z.string().trim().max(200).optional(),
            path: z.string().trim().max(500).optional(),
            remote: z.enum(["lan", "wan"]).optional(),
          }),
        )
        .max(100, "路由规则最多 100 条")
        .optional(),
    })
    .optional(),
  telegram: z
    .looseObject({
      botToken: z.string().optional(),
      chatId: z.string().optional(),
      webhookUrl: z.string().optional(),
      allowedUsers: z.array(z.number()).optional(),
      allowTaskStart: z.boolean().optional(),
      allowOfflineAdd: z.boolean().optional(),
      allowShareReceive: z.boolean().optional(),
      allowOAuthApproval: z.boolean().optional(),
      pollingEnabled: z.boolean().optional(),
      notify: z
        .looseObject({
          taskStart: z.boolean().optional(),
          taskDone: z.boolean().optional(),
          taskFailed: z.boolean().optional(),
          offline: z.boolean().optional(),
          accountAlert: z.boolean().optional(),
          follow: z.boolean().optional(),
          embyNew: z.boolean().optional(),
          organize: z.boolean().optional(),
          update: z.boolean().optional(),
          library: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  /** 影库：每天巡检收藏的分享还在不在 */
  library: z.looseObject({ patrol: z.boolean().optional() }).optional(),
  tmdb: z.looseObject({ apiKey: z.string().optional(), language: z.string().optional() }).optional(),
  hdhive: z.looseObject({ apiKey: z.string().optional(), baseUrl: z.string().optional() }).optional(),
  pansou: z
    .looseObject({
      baseUrl: pansouBaseUrlSchema.optional(),
      username: z.string().trim().max(200).optional(),
      password: z.string().max(500).optional(),
      checkLinks: z.boolean().optional(),
      // 屏蔽词：去空白、去空、去重（不分大小写）
      blockWords: z
        .array(z.string().trim().max(30, "屏蔽词每个最多 30 个字"))
        .max(50, "屏蔽词最多 50 个")
        .transform((list) => list.filter((w, i) => w && list.findIndex((x) => x.toLowerCase() === w.toLowerCase()) === i))
        .optional(),
    })
    .optional(),
  // 网盘限流。以前只要求正数：并发填 0.5 能存进去，那个账号的请求就全部永远排队
  throttle: z
    .looseObject({
      requestsPerSecond: throttleNumber(THROTTLE_LIMITS.requestsPerSecond, "每秒请求数").optional(),
      requestConcurrency: throttleNumber(THROTTLE_LIMITS.requestConcurrency, "接口并发数").int("接口并发数要填整数").optional(),
      downloadConcurrency: throttleNumber(THROTTLE_LIMITS.downloadConcurrency, "文件下载并发数").int("文件下载并发数要填整数").optional(),
    })
    .optional(),
  lifeMonitor: lifeMonitorSchema.optional(),
  openlistCopy: z
    .looseObject({
      account: z.string().optional(),
      dstDir: copyTargetDirSchema.optional(),
      /** 网盘账号名 → 它在 OpenList 里的挂载根 */
      mounts: z.record(z.string(), z.string()).optional(),
      /** 旧字段，升级时会尽量换算成 mounts */
      srcDir: z.string().optional(),
    })
    .optional(),
  organize: organizeSettingsSchema.optional(),
  update: z.looseObject({ enabled: z.boolean().optional(), includePrerelease: z.boolean().optional() }).optional(),
  agent: z
    .looseObject({
      enabled: z.boolean().optional(),
      uiBaseUrl: z
        .string()
        .trim()
        .max(500)
        .refine((v) => v === "" || /^https?:\/\/[^\s/]+/i.test(v), "管理界面地址要以 http:// 或 https:// 开头")
        .optional(),
      // 公网地址只收 https 的源：OAuth 的 issuer、资源地址都从它来，带了路径会和元数据的位置对不上
      publicBaseUrl: z
        .string()
        .trim()
        .max(300)
        .refine((v) => v === "" || isHttpsOrigin(v), "公网地址要是 https:// 开头的域名（不带路径），比如 https://nas.example.com")
        // 存规范写法（小写、去默认端口、国际化域名转 punycode）：元数据里的资源地址要和客户端连的地址一字不差
        .transform((v) => (v === "" ? "" : new URL(v).origin))
        .optional(),
      publicServesUi: z.boolean().optional(),
      allowPasswordApproval: z.boolean().optional(),
      oauthCimd: z.boolean().optional(),
    })
    .optional(),
}) satisfies z.ZodType<Partial<AppSettings>>;
