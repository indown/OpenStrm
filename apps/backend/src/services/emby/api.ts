/**
 * Emby 元数据查询，给 302 代理层用。
 *
 * 代理要判断"这个条目该不该 302"，唯一可靠的依据是条目在 Emby 里的 Path——
 * 也就是 strm 文件的内容。所以每次拦截都要回 Emby 问一次条目信息。
 *
 * 配置读取沿用 services/media-server.ts 的范式：每次现读，改了地址不用重启。
 */
import { readSettingsSafe } from "../settings-safe.js";

export type EmbyMediaSource = {
  Id?: string;
  Path?: string;
  Container?: string;
  IsRemote?: boolean;
  IsInfiniteStream?: boolean;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  DirectStreamUrl?: string;
  TranscodingUrl?: string;
  [key: string]: unknown;
};

export type EmbyItemLookup = {
  path: string;
  itemName: string;
  mediaSource: EmbyMediaSource | null;
};

const LOOKUP_TIMEOUT_MS = 10_000;
/** PlaybackInfo 可能触发 ffprobe 隔着网盘读文件头，慢的要几十秒 */
const PLAYBACK_INFO_TIMEOUT_MS = 90_000;

/** Emby 上游地址。默认值和 catch-all 保持一致（docker 网关上的 Emby） */
export function embyUpstream(): string {
  const url = readSettingsSafe().emby?.url || "http://172.17.0.1:8096";
  return url.replace(/\/+$/, "");
}

export function configuredApiKey(): string {
  return readSettingsSafe().emby?.apiKey || "";
}

type IncomingHeaders = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : "";
}

/** Emby 的认证头把令牌裹在 `MediaBrowser Client="..", Token="xxx"` 里 */
function tokenFromAuthHeader(value: string | string[] | undefined): string {
  const raw = firstValue(value);
  if (!raw) return "";
  return /Token="?([^",\s]+)"?/i.exec(raw)?.[1] ?? "";
}

/**
 * 客户端自己带的 Emby 令牌，取不到返回空串。
 *
 * query 和请求头都要看：Emby 生成的 DirectStreamUrl 把令牌放在 query，
 * 而客户端自己发起的请求普遍放在头里。只看 query 会把一大批带了凭据的
 * 客户端误判成匿名。
 */
export function clientApiKey(
  query: Record<string, unknown> | undefined,
  headers: IncomingHeaders | undefined,
): string {
  const q = query ?? {};
  const fromQuery = q["X-Emby-Token"] ?? q["api_key"] ?? q["ApiKey"];
  if (typeof fromQuery === "string" && fromQuery) return fromQuery;

  const h = headers ?? {};
  for (const name of ["x-emby-token", "x-mediabrowser-token"]) {
    const raw = firstValue(h[name]);
    if (raw) return raw;
  }
  for (const name of ["authorization", "x-emby-authorization"]) {
    const token = tokenFromAuthHeader(h[name]);
    if (token) return token;
  }
  return "";
}

/**
 * Emby ≥4.9 的 MediaSourceId 是 `mediasource_447039` 这种格式，
 * 前缀后面那串才是能直接查的 id。
 */
export function normalizeMediaSourceId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id.startsWith("mediasource_") ? id.slice("mediasource_".length) : id;
}

export async function fetchJson(
  url: string,
  timeoutMs = LOOKUP_TIMEOUT_MS,
  init: { method?: "GET" | "POST"; body?: string } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.body === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json" },
      body: init.body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Emby ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 一组媒体源里一共几条媒体流；0 = Emby 还没探测过这个 strm（或探测失败） */
export function countMediaStreams(sources: unknown): number {
  if (!Array.isArray(sources)) return 0;
  return (sources as Array<{ MediaStreams?: unknown }>).reduce(
    (n, s) => n + (Array.isArray(s.MediaStreams) ? s.MediaStreams.length : 0),
    0,
  );
}

/**
 * 服务端替播放器问一次 PlaybackInfo。
 *
 * strm 条目只有被问到 PlaybackInfo 时 Emby 才去探测媒体流，扫库和 Refresh 都不探；
 * 探过一次就落库，之后再问不再探。只带 API Key、不带 UserId 和设备档案也行（真 Emby 验过），
 * 所以预热和起播诊断都走这里。回的是响应里的 MediaSources（Path 是 strm 的内容）。
 */
export async function requestPlaybackInfo(
  itemId: string,
  opts: { apiKey?: string; timeoutMs?: number } = {},
): Promise<EmbyMediaSource[]> {
  const apiKey = opts.apiKey || configuredApiKey();
  const url = `${embyUpstream()}/Items/${encodeURIComponent(itemId)}/PlaybackInfo?api_key=${encodeURIComponent(apiKey)}`;
  const body = (await fetchJson(url, opts.timeoutMs ?? PLAYBACK_INFO_TIMEOUT_MS, { method: "POST", body: "{}" })) as
    | { MediaSources?: EmbyMediaSource[] }
    | null;
  return Array.isArray(body?.MediaSources) ? body.MediaSources : [];
}

/**
 * 查同步任务项对应的文件路径（客户端"下载到设备"走的 SyncService 接口）。
 *
 * 这条不能用 /Items?Ids= 查：JobItem 的 id 是同步任务项的 id，不是条目 id，
 * 真正的路径在 OutputPath 上。
 */
export async function getSyncJobItemPath(
  jobItemId: string,
  opts: { apiKey?: string } = {},
): Promise<EmbyItemLookup | null> {
  const apiKey = opts.apiKey || configuredApiKey();
  const url = `${embyUpstream()}/Sync/JobItems?api_key=${encodeURIComponent(apiKey)}`;

  const body = (await fetchJson(url)) as { Items?: Array<Record<string, unknown>> } | null;
  const item = body?.Items?.find((o) => String(o.Id) === String(jobItemId));
  if (!item) return null;

  return {
    path: typeof item.OutputPath === "string" ? item.OutputPath : "",
    itemName: typeof item.ItemName === "string" ? item.ItemName : "",
    mediaSource: null,
  };
}

/**
 * 查条目的媒体源路径。
 *
 * 带了 mediaSourceId 就按它查（多版本影片时 itemId 指向的是主条目，
 * 真正要播的是某个特定版本），否则按 itemId 查。
 */
export async function getItemMediaSource(
  itemId: string,
  opts: { mediaSourceId?: string; apiKey?: string } = {},
): Promise<EmbyItemLookup | null> {
  const base = embyUpstream();
  const apiKey = opts.apiKey || configuredApiKey();
  const sourceId = normalizeMediaSourceId(opts.mediaSourceId);
  const queryId = sourceId || itemId;
  if (!queryId) return null;

  const url =
    `${base}/Items?Ids=${encodeURIComponent(queryId)}` +
    `&Fields=Path,MediaSources&Limit=1&api_key=${encodeURIComponent(apiKey)}`;

  const body = (await fetchJson(url)) as { Items?: Array<Record<string, unknown>> } | null;
  const item = body?.Items?.[0];
  if (!item) return null;

  const sources = item.MediaSources as EmbyMediaSource[] | undefined;
  if (!Array.isArray(sources) || sources.length === 0) {
    // 图片之类的条目没有 MediaSources，退回条目自己的 Path
    return {
      path: typeof item.Path === "string" ? item.Path : "",
      itemName: typeof item.Name === "string" ? item.Name : "",
      mediaSource: null,
    };
  }

  const picked =
    (opts.mediaSourceId && sources.find((s) => s.Id === opts.mediaSourceId)) ||
    (sourceId && sources.find((s) => s.Id === sourceId)) ||
    sources[0];

  return {
    // MediaSource.Path 偶尔为空，条目自己的 Path 是兜底
    path: picked.Path || (typeof item.Path === "string" ? item.Path : ""),
    itemName: typeof item.Name === "string" ? item.Name : "",
    mediaSource: picked,
  };
}
