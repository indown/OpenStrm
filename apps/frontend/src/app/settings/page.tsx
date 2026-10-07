"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { TagInput } from "@/components/ui/tag-input";
import { SecretInput } from "@/components/ui/secret-input";
import { Button } from "@/components/ui/button";
import { SwitchRow } from "@/components/switch-row";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "sonner";
import { Loader2, PlugZap, Settings as SettingsIcon } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { FormSkeleton } from "@/components/loading";
import { api } from "@/lib/api";
import { downloadBackupWithToast } from "@/lib/backup";
import { useModKey } from "@/hooks/use-mod-key";
import { apiErrorMessage } from "@/lib/axios";
import { FEATURES } from "@/lib/features";
import type { AppSettings, OpenlistCopySettings, OrganizeSettings, ResourceStatus, UpdateSettings } from "@openstrm/shared";
import { OpenlistCopySection } from "./components/OpenlistCopySection";
import { OrganizeSection } from "./components/OrganizeSection";
import { UpdateSection } from "./components/UpdateSection";
import { AgentSection } from "./components/AgentSection";
import { PathMappingsEditor, RouteRulesEditor } from "./components/EmbyProxyRules";
import { SectionNav, type Section } from "./components/SectionNav";

/** 右侧导航的顺序就是页面顺序；id 对应各 section 上的锚点 */
const SECTIONS: Section[] = [
  { id: "update", title: "更新" },
  { id: "basic", title: "基础设置" },
  { id: "throttle", title: "网盘限流" },
  { id: "emby", title: "Emby" },
  { id: "tmdb", title: "TMDB" },
  { id: "pansou", title: "资源搜索" },
  { id: "library", title: "收藏夹" },
  ...(FEATURES.hdhiveSearch ? [{ id: "hdhive", title: "HDHive" }] : []),
  { id: "openlist-copy", title: "复制到 OpenList" },
  { id: "organize", title: "整理与命名" },
  { id: "agent", title: "智能体接入" },
];

/** 扩展名落一个标签时规范化：去空白、补点号、转小写。空的丢掉 */
function normalizeExtension(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  return v.startsWith(".") ? v : `.${v}`;
}

/** 屏蔽词落一个标签：去空白，太长的截到 30 个字（后端同样的上限）。空的丢掉 */
function normalizeBlockWord(raw: string): string | null {
  const v = raw.trim().slice(0, 30);
  return v || null;
}

/** 屏蔽词不分大小写去重（后端也这么存）：「TC」「tc」只留先填的那个 */
function dedupeWords(list: string[]): string[] {
  return list.filter((w, i) => list.findIndex((x) => x.toLowerCase() === w.toLowerCase()) === i);
}

const httpUrl = (hint: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === "" || /^https?:\/\/\S+$/i.test(v), hint);

/** 公网地址只收 https 的源（不带路径）：OAuth 的地址都从它拼，和后端的校验一致 */
const httpsOrigin = (hint: string) =>
  z
    .string()
    .trim()
    .refine((v) => {
      if (v === "") return true;
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
    }, hint);

/** 两个地址是不是同一个源（大小写、默认端口、结尾的 / 不计较）：公网地址填的就是当前页面的地址 → 一个域名共用 */
function sameOrigin(value: string, origin: string): boolean {
  try {
    return new URL(value.trim()).origin === origin;
  } catch {
    return false;
  }
}

/** 只在局域网里解析得到的主机名后缀：从这样的地址打开的，外面的网页客户端连不上 */
const LAN_SUFFIXES = [".local", ".lan", ".home", ".internal", ".localdomain", ".home.arpa"];

/** 地址里的主机名（小写、去结尾的点）；不是合法地址返回 null */
function hostOfUrl(value: string): string | null {
  try {
    return new URL(value.trim()).hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/** 地址里写明的端口（没写、写的默认端口都是空） */
function portOf(value: string): string {
  try {
    return new URL(value.trim()).port;
  } catch {
    return "";
  }
}

/** 当前页面能不能当公网地址用：https、写的是公网域名（不是 IP、localhost、单段主机名、.local 这类局域网名字） */
function publicOriginOfPage(): string | null {
  const { protocol, hostname, port } = window.location;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (protocol !== "https:" || host === "localhost" || /^[\d.]+$/.test(host) || host.startsWith("[")) return null;
  if (!host.includes(".") || host.endsWith(".localhost") || LAN_SUFFIXES.some((s) => host.endsWith(s))) return null;
  // 自己拼：location.origin 会留着域名结尾的点（nas.example.com.），填进去过不了校验
  return `https://${host}${port ? `:${port}` : ""}`;
}

/** 并发这类计数在表单里是字符串：以前 `parseInt(v) || 2` 会把打错的字悄悄改回默认值 */
const count = (min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max, `填 ${min}–${max} 之间的整数`);

/**
 * 每秒请求数：可以是小数（0.5 = 两秒一个）。上下限和后端 db/defaults.ts 的 THROTTLE_LIMITS 一个口径
 * （后端是准，这里只为了不等保存就提示）
 */
const RATE = { min: 0.1, max: 100 };
const isRate = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim()) && Number(v) >= RATE.min && Number(v) <= RATE.max;
const rate = z.string().trim().refine(isRate, `填 ${RATE.min}–${RATE.max} 之间的数，最多两位小数`);

/** 每秒几个请求换算成间隔，给个直观的数：2 →「每 500 毫秒一个」，0.5 →「每 2 秒一个」。填的值存不进去就不说 */
function paceText(raw: string): string | null {
  if (!isRate(raw)) return null;
  const ms = 1000 / Number(raw);
  return ms >= 1000 ? `每 ${Number((ms / 1000).toFixed(1))} 秒一个` : `每 ${Math.round(ms)} 毫秒一个`;
}

/** PanSou 地址比「是不是同一台」用：末尾的 /、误填的 /api 去掉（和后端 services/pansou/client.ts 的 apiBase 一个口径） */
const pansouServer = (url?: string) => (url ?? "").trim().replace(/\/+$/, "").replace(/\/api$/i, "");

/**
 * 表单的形状。只含本页拥有的键——后端按顶层键合并，Telegram / 网盘监控那些
 * 由别的页面写的设置不会被这里加载时的快照覆盖掉。
 *
 * organize 和 update 是两个子组件各自管的一整块，这里只当作一个值透传，不拆开校验。
 */
const schema = z.object({
  "user-agent": z.string(),
  strmExtensions: z.array(z.string()),
  downloadExtensions: z.array(z.string()),
  mediaMountPath: z.array(z.string()),
  emby: z.object({
    url: httpUrl("填 http:// 或 https:// 开头的地址"),
    apiKey: z.string(),
    allowAnonymousRedirect: z.boolean(),
    // 302 代理的两张规则表。行里的错误挂在整张表上（第几条、什么问题），FormMessage 显示在表下面；后端还会再校验一遍
    pathMappings: z.array(z.object({ from: z.string(), account: z.string(), to: z.string() })).superRefine((rows, ctx) => {
      const seen = new Set<string>();
      rows.forEach((row, i) => {
        const from = row.from.trim();
        if (!from || !row.account) ctx.addIssue({ code: "custom", message: `第 ${i + 1} 条路径映射：Emby 路径前缀和账号都要填` });
        else if (!/^(\/|https?:\/\/)/i.test(from)) ctx.addIssue({ code: "custom", message: `第 ${i + 1} 条路径映射：前缀要以 / 或 http(s):// 开头` });
        const key = from.replace(/\/+$/, "");
        if (key && seen.has(key)) ctx.addIssue({ code: "custom", message: `第 ${i + 1} 条路径映射：前缀和前面的重复了，解析时只会认第一条` });
        seen.add(key);
      });
    }),
    routeRules: z.array(
      z.object({
        action: z.enum(["redirect", "relay"]),
        note: z.string(),
        userAgent: z.string(),
        client: z.string(),
        deviceName: z.string(),
        deviceId: z.string(),
        path: z.string(),
        remote: z.enum(["", "lan", "wan"]),
      }),
    ),
  }),
  // 两个并发的上下限同样照着后端的 THROTTLE_LIMITS
  throttle: z.object({
    requestsPerSecond: rate,
    requestConcurrency: count(1, 50),
    downloadConcurrency: count(1, 50),
  }),
  tmdb: z.object({ apiKey: z.string(), language: z.string() }),
  pansou: z
    .object({
      // 后面要拼 /api/…：带用户名密码、? 参数、# 的拼不对（和后端 pansouBaseUrlSchema 一样拦）
      baseUrl: httpUrl("填 http:// 或 https:// 开头的地址，比如 http://pansou:8888").refine(
        (v) => v === "" || !/^https?:\/\//i.test(v) || (!/[?#]/.test(v) && !/^https?:\/\/[^/]*@/i.test(v)),
        "只填到主机、端口（或路径）为止：别带用户名密码、? 参数和 #",
      ),
      username: z.string(),
      password: z.string(),
      checkLinks: z.boolean(),
      blockWords: z.array(z.string()).max(50, "屏蔽词最多 50 个"),
    })
    // 没有地址的用户名、密码存不住：每次保存都会把这一整块发回去，后端认为地址换了（空的不算同一台），
    // 下一次保存别的设置时就把存着的密码悄悄清掉了。库里已经是这样的（旧版本存进去的）也在这里拦下、说清楚
    .refine((v) => v.baseUrl.trim() !== "" || (v.username.trim() === "" && v.password === ""), {
      message: "先填 PanSou 地址；不用资源搜索的话，把下面的用户名、密码也清空",
      path: ["baseUrl"],
    }),
  // 入口关着时这一节不显示，原样带回去就行：看不见的字段不能拦住保存（以前存进去的地址可能没带 http://）
  hdhive: z.object({
    apiKey: z.string(),
    baseUrl: FEATURES.hdhiveSearch ? httpUrl("填 http:// 或 https:// 开头的地址") : z.string(),
  }),
  library: z.object({ patrol: z.boolean() }),
  openlistCopy: z.custom<OpenlistCopySettings>(),
  organize: z.custom<OrganizeSettings>(),
  update: z.custom<UpdateSettings>(),
  agent: z.object({
    enabled: z.boolean(),
    uiBaseUrl: httpUrl("填 http:// 或 https:// 开头的地址，比如 http://nas:3000"),
    publicBaseUrl: httpsOrigin("填 https:// 开头的域名，不带路径，比如 https://nas.example.com"),
    publicServesUi: z.boolean(),
    allowPasswordApproval: z.boolean(),
    oauthCimd: z.boolean(),
  }),
});

type SettingsValues = z.infer<typeof schema>;

/** 服务端那份 → 表单那份 */
function fromSettings(s: AppSettings): SettingsValues {
  return {
    "user-agent": s["user-agent"] ?? "",
    strmExtensions: s.strmExtensions ?? [],
    downloadExtensions: s.downloadExtensions ?? [],
    mediaMountPath: s.mediaMountPath ?? [],
    emby: {
      url: s.emby?.url ?? "",
      apiKey: s.emby?.apiKey ?? "",
      allowAnonymousRedirect: s.emby?.allowAnonymousRedirect === true,
      pathMappings: (s.emby?.pathMappings ?? []).map((m) => ({ from: m.from ?? "", account: m.account ?? "", to: m.to ?? "" })),
      routeRules: (s.emby?.routeRules ?? []).map((r) => ({
        action: r.action === "redirect" ? ("redirect" as const) : ("relay" as const),
        note: r.note ?? "",
        userAgent: r.userAgent ?? "",
        client: r.client ?? "",
        deviceName: r.deviceName ?? "",
        deviceId: r.deviceId ?? "",
        path: r.path ?? "",
        remote: r.remote === "lan" || r.remote === "wan" ? r.remote : ("" as const),
      })),
    },
    // 后端回的总是补齐的三个值，这里不放兜底数字：以前这里写的默认值和后端真正在用的对不上
    throttle: {
      requestsPerSecond: String(s.throttle?.requestsPerSecond ?? ""),
      requestConcurrency: String(s.throttle?.requestConcurrency ?? ""),
      downloadConcurrency: String(s.throttle?.downloadConcurrency ?? ""),
    },
    tmdb: { apiKey: s.tmdb?.apiKey ?? "", language: s.tmdb?.language ?? "" },
    pansou: {
      baseUrl: s.pansou?.baseUrl ?? "",
      username: s.pansou?.username ?? "",
      password: s.pansou?.password ?? "",
      checkLinks: s.pansou?.checkLinks !== false,
      blockWords: s.pansou?.blockWords ?? [],
    },
    hdhive: { apiKey: s.hdhive?.apiKey ?? "", baseUrl: s.hdhive?.baseUrl ?? "" },
    library: { patrol: s.library?.patrol !== false },
    openlistCopy: s.openlistCopy ?? {},
    organize: s.organize ?? {},
    update: s.update ?? {},
    agent: {
      enabled: s.agent?.enabled === true,
      uiBaseUrl: s.agent?.uiBaseUrl ?? "",
      publicBaseUrl: s.agent?.publicBaseUrl ?? "",
      publicServesUi: s.agent?.publicServesUi === true,
      allowPasswordApproval: s.agent?.allowPasswordApproval === true,
      oauthCimd: s.agent?.oauthCimd === true,
    },
  };
}

/** 规则里没填的条件不带给后端：空串在后端也当没填，但存进去的东西干净些 */
function optional<K extends string>(key: K, value: string): Partial<Record<K, string>> {
  const trimmed = value.trim();
  return trimmed ? ({ [key]: trimmed } as Record<K, string>) : {};
}

/** 表单那份 → 提交那份 */
function toSettings(v: SettingsValues): AppSettings {
  return {
    "user-agent": v["user-agent"],
    strmExtensions: v.strmExtensions,
    downloadExtensions: v.downloadExtensions,
    mediaMountPath: v.mediaMountPath,
    emby: {
      url: v.emby.url,
      apiKey: v.emby.apiKey,
      allowAnonymousRedirect: v.emby.allowAnonymousRedirect,
      pathMappings: v.emby.pathMappings.map((m) => ({ from: m.from.trim(), account: m.account, ...optional("to", m.to) })),
      routeRules: v.emby.routeRules.map((r) => ({
        action: r.action,
        ...optional("note", r.note),
        ...optional("userAgent", r.userAgent),
        ...optional("client", r.client),
        ...optional("deviceName", r.deviceName),
        ...optional("deviceId", r.deviceId),
        ...optional("path", r.path),
        ...(r.remote ? { remote: r.remote } : {}),
      })),
    },
    throttle: {
      requestsPerSecond: Number(v.throttle.requestsPerSecond),
      requestConcurrency: Number(v.throttle.requestConcurrency),
      downloadConcurrency: Number(v.throttle.downloadConcurrency),
    },
    tmdb: v.tmdb,
    pansou: v.pansou,
    hdhive: v.hdhive,
    library: v.library,
    openlistCopy: v.openlistCopy,
    organize: v.organize,
    update: v.update,
    agent: v.agent,
  };
}

/**
 * 递归比叶子，数出几处和基准不一样。数组当一个叶子——扩展名列表改三个也是"一处改动"。
 * 不用 RHF 的 dirtyFields：那个把数组摊成一串布尔，数出来的是"改了几个元素"。
 */
function countChanges(base: unknown, next: unknown): number {
  if (base === next) return 0;
  const isPlain = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (isPlain(base) && isPlain(next)) {
    let n = 0;
    for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) n += countChanges(base[key], next[key]);
    return n;
  }
  return JSON.stringify(base) === JSON.stringify(next) ? 0 : 1;
}

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const modKey = useModKey();

  const form = useForm<SettingsValues>({
    resolver: zodResolver(schema),
    defaultValues: fromSettings({}),
  });
  const saving = form.formState.isSubmitting;
  const values = form.watch();
  // defaultValues 就是"上次从服务器读到的那份"，每次 reset 之后它跟着走
  const changes = countChanges(form.formState.defaultValues, values);

  // 当前页面的地址能不能直接当公网地址用（https、写的域名）：能就给「用当前地址」；pageHost 是现在打开管理界面用的主机名
  const [pageOrigin, setPageOrigin] = useState<string | null>(null);
  const [pageHost, setPageHost] = useState<string | null>(null);
  useEffect(() => {
    setPageOrigin(publicOriginOfPage());
    setPageHost(window.location.hostname.toLowerCase().replace(/\.$/, ""));
  }, []);
  /**
   * 「这个域名也用来打开管理界面」是对哪个域名开的：这次编辑里打开的记在这里，没有就看已保存的设置。
   * 公网地址换成别的域名时开关跟着关，不然新域名（比如给智能体单独开的子域名）下管理界面也打得开
   */
  const sharedHost = useRef<string | null>(null);
  // 公网地址下面的一句说明：两个开关为什么自己变了
  const [sharedNote, setSharedNote] = useState<"auto" | "unbound" | null>(null);
  const resetForm = useCallback(
    (values?: SettingsValues) => {
      form.reset(values);
      sharedHost.current = null;
      setSharedNote(null);
    },
    [form],
  );
  /**
   * 一个域名共用（多数人）：打开「这个域名也用来打开管理界面」，顺带打开授权页上的密码批准——
   * 这时登录页本来就在公网上，在客户端弹出的授权页上直接输密码批准是最顺的一步。两个开关之后仍然各自能关
   */
  const shareDomain = useCallback(() => {
    form.setValue("agent.publicServesUi", true, { shouldDirty: true });
    form.setValue("agent.allowPasswordApproval", true, { shouldDirty: true });
    sharedHost.current = pageOrigin ? hostOfUrl(pageOrigin) : null;
    setSharedNote("auto");
  }, [form, pageOrigin]);
  /** 公网地址填完（失焦）：开关开着、域名却换了，就关掉开关并说明；换成的是当前页面的地址就照旧共用 */
  const checkSharedHost = useCallback(() => {
    const value = form.getValues("agent.publicBaseUrl");
    const host = hostOfUrl(value);
    if (!host || !form.getValues("agent.publicServesUi")) return;
    const saved = form.formState.defaultValues?.agent;
    const bound = sharedHost.current ?? (saved?.publicServesUi && saved.publicBaseUrl ? hostOfUrl(saved.publicBaseUrl) : null);
    if (bound === null || host === bound || (pageOrigin && sameOrigin(value, pageOrigin))) {
      sharedHost.current = host;
      return;
    }
    form.setValue("agent.publicServesUi", false, { shouldDirty: true });
    sharedHost.current = null;
    setSharedNote("unbound");
  }, [form, pageOrigin]);

  useEffect(() => {
    api.settings
      .get()
      .then((s) => resetForm(fromSettings(s)))
      .catch((err) => toast.error(apiErrorMessage(err, "加载设置失败")))
      .finally(() => setLoading(false));
  }, [resetForm]);

  const onSave = useCallback(
    async (v: SettingsValues) => {
      try {
        await api.settings.patch(toSettings(v));
        // 重读一次而不是拿刚发出去的当基准：密钥存进去之后服务端只回掩码，
        // 拿本地那份明文当基准的话，输入框会把刚打的密钥当成"已保存的掩码"明文摆出来
        try {
          resetForm(fromSettings(await api.settings.get()));
        } catch {
          resetForm(v);
        }
        toast.success("保存成功");
      } catch (error: unknown) {
        if (error && typeof error === "object" && "response" in error) {
          const apiError = error as { response?: { status?: number; data?: { message?: string } } };
          if (apiError.response?.status === 400) {
            // 表单自己校验过的不会走到这；能到这的是只有服务端才判得了的（比如公网地址撞了管理界面的域名），原因要让人看见
            toast.error(`保存失败：${apiError.response.data?.message || "参数错误"}`);
          } else {
            toast.error("保存失败");
          }
        } else {
          toast.error("保存失败");
        }
      }
    },
    [resetForm],
  );

  // ⌘S / Ctrl+S 保存。浏览器那个"保存网页"对这里没意义，脏着就接管
  useEffect(() => {
    if (changes === 0 || saving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "s" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      void form.handleSubmit(onSave)();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changes, saving, form, onSave]);

  // 改了没存就关标签页 / 刷新时拦一下。站内跳转拦不住（App Router 没给钩子），保存条已经一直摆在那儿
  useEffect(() => {
    if (changes === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [changes]);

  // 带 #hash 进来时（侧栏的更新角标、分区导航的链接）得等这页真渲染出来才跳得动：
  // 加载期间这里是骨架屏，浏览器自己那次跳转找不到目标，于是停在顶部
  useEffect(() => {
    if (loading) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [loading]);

  /**
   * 资源搜索的「检查连接」：用表单里还没保存的值（密码是掩码就用库里的）。
   * 结果只对检查时那组值有效：地址、账号改了就不再显示，免得旧的「已连上」误导人
   */
  const [pansouCheck, setPansouCheck] = useState<{ checking: boolean; key: string; result: ResourceStatus | null }>({
    checking: false,
    key: "",
    result: null,
  });
  const pansouKey = JSON.stringify([values.pansou?.baseUrl, values.pansou?.username, values.pansou?.password]);
  const checkPansou = async () => {
    const v = form.getValues("pansou");
    const key = JSON.stringify([v.baseUrl, v.username, v.password]);
    setPansouCheck({ checking: true, key, result: null });
    try {
      const result = await api.resource.status({ baseUrl: v.baseUrl.trim(), username: v.username.trim(), password: v.password });
      setPansouCheck({ checking: false, key, result });
    } catch (err) {
      setPansouCheck({ checking: false, key, result: { configured: true, ok: false, message: apiErrorMessage(err, "检查失败") } });
    }
  };
  const pansouResult = pansouCheck.key === pansouKey ? pansouCheck.result : null;
  /** health 回来了（带着插件、频道数）但 ok 是 false：连上了，是登录那一步没过 */
  const pansouReached = pansouResult ? pansouResult.plugins !== undefined || pansouResult.channels !== undefined : false;

  const onBackup = async () => {
    setBackingUp(true);
    await downloadBackupWithToast();
    setBackingUp(false);
  };

  const description = "配置全局选项与 Emby 通知";
  /** 每秒请求数换算出来的间隔，跟着输入框里的值变 */
  const pace = paceText(values.throttle?.requestsPerSecond ?? "");
  /** 密钥字段拿它判断"还是库里那份掩码、没动过" */
  const saved = form.formState.defaultValues;
  /**
   * PanSou 的地址改了、密码还是存着的那份掩码：保存时后端会把存着的密码清掉（不发给没确认过的新地址），先说一声。
   * 地址末尾的 /、误填的 /api 不算改；地址清空了不在这里说，那样存不了，地址那一栏会说为什么
   */
  const pansouPasswordDropped =
    Boolean(saved?.pansou?.password) &&
    values.pansou?.password === saved?.pansou?.password &&
    Boolean(values.pansou?.baseUrl?.trim()) &&
    pansouServer(values.pansou?.baseUrl) !== pansouServer(saved?.pansou?.baseUrl);

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader icon={SettingsIcon} title="设置" description={description} />
        <div className="max-w-3xl">
          <FormSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader icon={SettingsIcon} title="设置" description={description} />
      <div className="flex gap-8">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSave)} className="min-w-0 max-w-3xl flex-1 space-y-6">
            <FormField
              control={form.control}
              name="update"
              render={({ field }) => <UpdateSection value={field.value ?? {}} onChange={field.onChange} />}
            />

            {/* 一列排：UA 是一整串，另外三个是长短不定的标签串，两两并排时一边一行、一边四行，左边空一大块 */}
            <section id="basic" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
              <h2 className="text-base font-medium">基础设置</h2>
              <FormField
                control={form.control}
                name="user-agent"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>User-Agent</FormLabel>
                    <FormControl>
                      <Input placeholder="Mozilla/5.0 ..." {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="strmExtensions"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Strm 文件扩展名</FormLabel>
                    <FormControl>
                      <TagInput
                        value={field.value}
                        onChange={field.onChange}
                        normalize={normalizeExtension}
                        placeholder="例如：.mkv，回车落一个"
                      />
                    </FormControl>
                    <FormDescription className="text-xs">这些扩展名的文件会生成 strm</FormDescription>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="downloadExtensions"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>下载文件扩展名</FormLabel>
                    <FormControl>
                      <TagInput
                        value={field.value}
                        onChange={field.onChange}
                        normalize={normalizeExtension}
                        placeholder="例如：.srt，回车落一个"
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      这些扩展名的文件会真的下到本地（字幕、nfo、海报）
                    </FormDescription>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="mediaMountPath"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>额外的媒体挂载路径</FormLabel>
                    <FormControl>
                      <TagInput
                        value={field.value}
                        onChange={field.onChange}
                        placeholder="/root/webdav/115，回车落一个"
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      开了 302 的任务会自动把它的 strmPrefix 当作挂载路径，不用填在这里；只填任务之外、也希望代理接管的前缀
                    </FormDescription>
                  </FormItem>
                )}
              />
            </section>

            <section id="throttle" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
              <h2 className="text-base font-medium">网盘限流</h2>
              <p className="text-sm text-muted-foreground">
                每个网盘账号各算各的，保存后立即生效，不用重启。被网盘风控过，就把每秒请求数调小。
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="throttle.requestsPerSecond"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>每秒请求数</FormLabel>
                      <FormControl>
                        <Input inputMode="decimal" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">
                        一个账号每秒最多发几个接口请求：列目录、取直链、转存、整理、监控都算。可以填小数
                        {pace ? `，现在是${pace}` : ""}。
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="throttle.requestConcurrency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>接口并发数</FormLabel>
                      <FormControl>
                        <Input inputMode="numeric" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">
                        一个账号同时在路上的接口请求数。监控和云下载各有自己的一份，不会被同步占满。
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="throttle.downloadConcurrency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>文件下载并发数</FormLabel>
                      <FormControl>
                        <Input inputMode="numeric" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">
                        一个账号同时下载几个文件（字幕、nfo、图片这类随片文件）。下载不占每秒请求数。
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <section id="emby" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
              <h2 className="text-base font-medium">Emby</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="emby.url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Emby URL</FormLabel>
                      <FormControl>
                        <Input placeholder="http://host.docker.internal:8096" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="emby.apiKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Emby API Key</FormLabel>
                      <FormControl>
                        <SecretInput
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          masked={saved?.emby?.apiKey}
                          placeholder="xxxxxxxxxxxxxxxx"
                        />
                      </FormControl>
                      <FormDescription className="text-xs">改动即替换，清空即删除</FormDescription>
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="emby.allowAnonymousRedirect"
                render={({ field }) => (
                  // 后果不进 ⓘ：开了之后谁都能拿到直链，这句必须一眼看见
                  <SwitchRow
                    label="允许未认证的请求换取直链"
                    description="默认关闭。开启后，任何能访问代理端口的人报一个条目 id 就能拿到你的媒体直链，无需登录 Emby。"
                    hint="不带 Emby 令牌的请求会改用上面那个 API Key 去解析直链。绝大多数播放器都会带令牌，只有确认播放器一个令牌都不发、且播放确实不走直连时才需要开启。"
                    checked={field.value === true}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
              <FormField
                control={form.control}
                name="emby.pathMappings"
                render={({ field }) => (
                  <FormItem>
                    <PathMappingsEditor value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="emby.routeRules"
                render={({ field }) => (
                  <FormItem>
                    <RouteRulesEditor value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </section>

            <section id="tmdb" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
              <h2 className="text-base font-medium">TMDB</h2>
              <p className="text-sm text-muted-foreground">
                「整理」按它识别影视，不配就整理不了；收藏夹靠它认出分享里的一部部作品（海报墙、正式名和英文名搜索）；「strm 管理」页的海报墙在目录里没有现成图片时，也从这里补海报。
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="tmdb.apiKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>TMDB API Key</FormLabel>
                      <FormControl>
                        <SecretInput
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          masked={saved?.tmdb?.apiKey}
                          placeholder="eyJhbGciOiJIUzI1NiJ9..."
                        />
                      </FormControl>
                      {/* 「v4 Bearer Token」以前在标签里，窄一点的两列布局里标签折行，这一格的输入框就比旁边低一截 */}
                      <FormDescription className="text-xs">
                        填 v4 的 API Read Access Token（Bearer），不是 v3 的 API Key。改动即替换，清空即删除
                      </FormDescription>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="tmdb.language"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>默认语言</FormLabel>
                      <FormControl>
                        <Input placeholder="zh-CN" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <section id="pansou" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
              <h2 className="text-base font-medium">资源搜索</h2>
              <p className="text-sm text-muted-foreground">
                接上自己部署的 PanSou 后，「资源搜索」页、顶栏的搜索框和智能体都能按片名搜网盘分享和磁力：115 / 夸克的分享直接转存，磁力交给 115 云下载。
              </p>
              <FormField
                control={form.control}
                name="pansou.baseUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>PanSou 地址</FormLabel>
                    <FormControl>
                      <Input placeholder="http://pansou" {...field} />
                    </FormControl>
                    <FormDescription className="text-xs">
                      和 OpenStrm 放在同一个 docker compose 里：带网页的镜像填 http://pansou，纯接口的填 http://pansou:8888。空着就是不用这个功能
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {/* 用户名、密码改了，地址那一栏的「先填 PanSou 地址」跟着重新判断：清空了它们就不再拦 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="pansou.username"
                  rules={{ deps: "pansou.baseUrl" }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>用户名</FormLabel>
                      <FormControl>
                        <Input placeholder="PanSou 开了登录才填" autoComplete="off" {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="pansou.password"
                  rules={{ deps: "pansou.baseUrl" }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>密码</FormLabel>
                      <FormControl>
                        <SecretInput
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          masked={saved?.pansou?.password}
                          placeholder="PanSou 开了登录才填"
                          autoComplete="new-password"
                        />
                      </FormControl>
                      {pansouPasswordDropped ? (
                        <p className="text-xs text-warning">地址改了：存着的密码不会发给新地址，保存时会清掉；PanSou 开了登录的话重新填一遍</p>
                      ) : (
                        <FormDescription className="text-xs">改动即替换，清空即删除</FormDescription>
                      )}
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="pansou.checkLinks"
                render={({ field }) => (
                  <SwitchRow
                    label="自动检测链接是否有效"
                    description="搜索结果里只查屏幕上看得见的 115 / 夸克分享，失效的变淡；智能体拿到的结果里直接去掉"
                    hint="检测由 PanSou 去问各家网盘，不经过你的网盘账号，不会把账号查出风控。结果会缓存一阵，同一条不会反复查。"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
              <FormField
                control={form.control}
                name="pansou.blockWords"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>屏蔽词</FormLabel>
                    <FormControl>
                      <TagInput
                        value={field.value}
                        onChange={(next) => field.onChange(dedupeWords(next))}
                        normalize={normalizeBlockWord}
                        placeholder="例如：预告，回车落一个"
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      标题里带这些词（不分大小写、全角半角）的结果不显示，网页、Telegram、智能体都生效；也对「4K」「枪版」这类标签算，比如填「枪版」连 HDTS、CAM 一起藏掉。常见的：预告、枪版、TC。「花絮」这种词慎用：附带花絮的整套资源也会被一起藏掉
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" size="sm" onClick={checkPansou} disabled={pansouCheck.checking}>
                  {pansouCheck.checking ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                  检查连接
                </Button>
                {pansouResult && (
                  <>
                    <StatusBadge
                      tone={!pansouResult.configured ? "neutral" : !pansouResult.ok ? (pansouReached ? "warning" : "danger") : pansouResult.message ? "warning" : "success"}
                    >
                      {!pansouResult.configured
                        ? "还没填地址"
                        : !pansouResult.ok
                          ? pansouReached
                            ? "连上了，登录没过"
                            : "连不上"
                          : `已连上：${pansouResult.plugins ?? 0} 个插件、${pansouResult.channels ?? 0} 个频道${pansouResult.authEnabled ? "，登录正常" : ""}`}
                    </StatusBadge>
                    {pansouResult.message && <span className="text-xs text-muted-foreground">{pansouResult.message}</span>}
                  </>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                还没有的话：README「资源搜索」一节有 docker compose 片段，带网页的 PanSou 镜像自带一批 TG 频道和插件，起来就能搜（纯接口的镜像要自己配，裸起几乎搜不到东西）；国内要搜 TG 频道得给它配代理（PROXY），只开插件也能用。网上的公共实例有限流、说关就关，不建议长期用。
              </p>
            </section>

            <section id="library" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
              <h2 className="text-base font-medium">收藏夹</h2>
              <p className="text-sm text-muted-foreground">
                收藏夹里的分享会把目录树抄下来建索引，首页搜索、⌘K 和智能体都能搜到里面的每一部。抄目录时让着同步和播放，大的分享要几分钟到几十分钟。
              </p>
              <FormField
                control={form.control}
                name="library.patrol"
                render={({ field }) => (
                  <SwitchRow
                    label="每天检查收藏的分享还在不在"
                    description="每个分享只问一次网盘；确认失效的在搜索里收起来，收藏夹页可以找替代、更新链接或清理"
                    hint="只有分享明确说取消、过期才直接判失效；说法含糊的隔几小时再查，连着三次打不开才算。关掉以后，只在你打开、转存时顺带发现。"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
            </section>

            {FEATURES.hdhiveSearch && (
              <section id="hdhive" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
                <h2 className="text-base font-medium">HDHive OpenAPI</h2>
                <p className="text-sm text-muted-foreground">
                  配置后，可在顶部搜索框搜索影视并查询 HDHive 的可用资源（基于 TMDB ID）。
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="hdhive.apiKey"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>HDHive API Key (X-API-Key)</FormLabel>
                        <FormControl>
                          <SecretInput
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                            masked={saved?.hdhive?.apiKey}
                            placeholder="个人 API Key 或应用 Secret"
                          />
                        </FormControl>
                        <FormDescription className="text-xs">改动即替换，清空即删除</FormDescription>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="hdhive.baseUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Base URL (可选)</FormLabel>
                        <FormControl>
                          <Input placeholder="https://hdhive.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </section>
            )}

            <FormField
              control={form.control}
              name="openlistCopy"
              render={({ field }) => <OpenlistCopySection value={field.value ?? {}} onChange={field.onChange} />}
            />

            <FormField
              control={form.control}
              name="organize"
              render={({ field }) => <OrganizeSection value={field.value ?? {}} onChange={field.onChange} />}
            />

            <AgentSection
              enabled={saved?.agent?.enabled === true}
              publicBaseUrl={saved?.agent?.publicBaseUrl?.replace(/\/+$/, "") ?? ""}
              sharedDomain={saved?.agent?.publicServesUi === true}
              passwordApproval={saved?.agent?.allowPasswordApproval === true}
              fields={
                <div className="space-y-4">
                  <FormField
                    control={form.control}
                    name="agent.enabled"
                    render={({ field }) => (
                      <SwitchRow
                        label="开启智能体接入"
                        description="关着时 MCP 地址不对外，令牌也调不了接口"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="agent.publicBaseUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>公网地址（可选）</FormLabel>
                        <InputGroup>
                          <FormControl>
                            <InputGroupInput
                              placeholder="https://nas.example.com"
                              {...field}
                              onChange={(e) => {
                                field.onChange(e);
                                // 填的就是当前页面的地址：这个域名本来就用来打开管理界面，自动按共用处理
                                if (pageOrigin && sameOrigin(e.target.value, pageOrigin) && !form.getValues("agent.publicServesUi")) shareDomain();
                              }}
                              onBlur={() => {
                                field.onBlur();
                                checkSharedHost();
                              }}
                            />
                          </FormControl>
                          {pageOrigin && (
                            <InputGroupButton
                              onClick={() => {
                                form.setValue("agent.publicBaseUrl", pageOrigin, { shouldDirty: true, shouldValidate: true });
                                shareDomain();
                              }}
                              title={`填成 ${pageOrigin}`}
                            >
                              用当前地址
                            </InputGroupButton>
                          )}
                        </InputGroup>
                        <FormDescription className="text-xs">
                          claude.ai、ChatGPT 这类网页客户端从它们的服务器连过来，要一个公网 https 地址并走 OAuth 授权。多数人就填平时从外网打开这个界面的地址
                          {pageOrigin ? "（点「用当前地址」）" : "，并打开下面的「这个域名也用来打开管理界面」"}；给智能体单独开子域名的配法见 README
                        </FormDescription>
                        {sharedNote === "auto" && (
                          <p className="text-xs text-muted-foreground">
                            填的就是你现在打开这个页面的地址：已顺带打开「这个域名也用来打开管理界面」和「授权页上允许用管理员密码批准」。
                          </p>
                        )}
                        {sharedNote === "unbound" && (
                          <p className="text-xs text-warning">
                            公网地址换了域名，已关掉「这个域名也用来打开管理界面」：新域名下只放行智能体用的几个路径。它也用来打开管理界面的话，再把开关打开。
                          </p>
                        )}
                        {portOf(values.agent.publicBaseUrl) && (
                          <p className="text-xs text-warning">
                            带端口（:{portOf(values.agent.publicBaseUrl)}）的地址 claude.ai 连不上：它的服务器只往 443 端口连。443 被封的可以用 Cloudflare Tunnel，见 README。
                          </p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="agent.publicServesUi"
                    render={({ field }) => {
                      const host = hostOfUrl(values.agent.publicBaseUrl);
                      return (
                        <SwitchRow
                          label="这个域名也用来打开管理界面"
                          description={
                            field.value ? (
                              `一个域名共用：${host ?? "这个域名"} 照常打开管理界面，智能体也从这里连。管理界面在公网上：密码要够长，放在反代 / Tunnel 后面要设 TRUST_PROXY；想再加一层可以套 Cloudflare Access（智能体的几个路径要放行，见 README）`
                            ) : host && host === pageHost ? (
                              <span className="text-destructive">
                                关着的话保存会被拒：你现在就是用 {host} 打开的管理界面，关掉后它会被挡在外面。要让这个域名只给智能体用，换局域网地址打开管理界面再关
                              </span>
                            ) : host ? (
                              <span className="text-warning">
                                关着：保存后 {host} 下只放行智能体用的几个路径，从外网用它打开管理界面会是 404。你平时就用这个地址打开管理界面的话，打开它
                              </span>
                            ) : (
                              "关着：这个域名下只放行智能体用的几个路径，管理界面在它下面打不开——给智能体单独开了子域名、管理界面不放公网时这么用"
                            )
                          }
                          checked={field.value}
                          onCheckedChange={(on) => {
                            field.onChange(on);
                            sharedHost.current = on ? host : null;
                            setSharedNote(null);
                            if (on) form.setValue("agent.allowPasswordApproval", true, { shouldDirty: true });
                          }}
                        />
                      );
                    }}
                  />
                  <FormField
                    control={form.control}
                    name="agent.allowPasswordApproval"
                    render={({ field }) => (
                      <SwitchRow
                        label="授权页上允许用管理员密码批准"
                        description="开着：在客户端里点连接、弹出授权页，直接在上面选档位、输密码批准（一个域名时推荐）。只对 claude.ai、ChatGPT、本机和局域网里的客户端有效，别的客户端照样用配对码，免得有人拿假冒的客户端骗你一键批了。关着：到这里的「待批准」输入授权页上的配对码批准（在 Telegram 页打开了「允许批准网页客户端的连接」的，也可以把配对码发给机器人）"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="agent.uiBaseUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>管理界面地址（可选）</FormLabel>
                        <FormControl>
                          <Input
                            placeholder={
                              values.agent.publicServesUi && values.agent.publicBaseUrl
                                ? `不填就用公网地址 ${values.agent.publicBaseUrl.replace(/\/+$/, "")}`
                                : "http://nas:3000"
                            }
                            {...field}
                          />
                        </FormControl>
                        <FormDescription className="text-xs">
                          工具结果里「在 OpenStrm 里打开」的链接用这个地址拼（比如 ChatGPT 做不了转存时，点链接就是预填好的转存框）。一个域名共用时不用填，默认用公网地址；填了就用填的（从外网打不开的话清空它）
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="agent.oauthCimd"
                    render={({ field }) => (
                      <SwitchRow
                        label="用 CIMD 认客户端"
                        description="默认关，客户端用动态注册。开了 claude.ai、ChatGPT 会改用 CIMD（授权页能显示它们经过核实的域名），但 OpenStrm 要能直接访问 claude.ai、chatgpt.com 去取客户端说明——国内网络一般不行，取不到就谁也连不上。开了之后点下面的「检查一遍」看取不取得到"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                </div>
              }
            />

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" disabled={backingUp} onClick={onBackup}>
                {backingUp ? "打包中..." : "下载备份"}
              </Button>
              <span className="text-xs text-muted-foreground">
                一致性快照（openstrm.db）；库是 WAL 模式，直接拷文件可能拷到一半
              </span>
            </div>

            {/* 改了才出现，跟着这一列贴在视口底部：这页有 3000px 高，保存不能只待在最下面 */}
            {changes > 0 && (
              <div className="sticky bottom-4 z-10 flex items-center gap-3 rounded-xl border bg-card/90 p-3 shadow-lg backdrop-blur-md">
                <span className="text-sm font-medium tabular-nums">{changes} 处未保存</span>
                <kbd className="hidden rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
                  {modKey === "⌘" ? "⌘S" : "Ctrl+S"}
                </kbd>
                <div className="ml-auto flex items-center gap-2">
                  <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => resetForm()}>
                    放弃更改
                  </Button>
                  <Button type="submit" size="sm" disabled={saving}>
                    {saving ? "保存中..." : "保存"}
                  </Button>
                </div>
              </div>
            )}
          </form>
        </Form>
        <SectionNav sections={SECTIONS} />
      </div>
    </div>
  );
}
