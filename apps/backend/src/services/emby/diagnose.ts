/**
 * 起播诊断：服务端替播放器把首播要走的两段路走一遍，量出每段用时。
 *
 * 第一段是 Emby 自己回答 PlaybackInfo——strm 条目第一次被问到时 Emby 才去探测媒体流
 * （ffprobe 隔着网盘读文件头，几秒到几十秒），这是首播最大的一块；第二段是我们换直链
 * （找路径 + 取链）。没指定条目就挑最近入库、还没探测过的 strm 条目：量到的才是冷启动。
 *
 * 诊断是真的做：Emby 会真探测一次（探完就落库，等于顺手预热了这条），网盘会真被问一次直链。
 *
 * 换直链在 API 进程里量：播放代理是另一个进程，缓存和限流队列各有一套，这里量到的相当于代理冷启动时的用时——
 * 所以量之前先忘掉这条路径的内存记录（第二次点也量冷路径，不会因为 API 进程记着了就报 0 ms）；
 * 同步 / 整理在跑时网盘请求都在排队，量出来的是排队时间，不量，让用户等它们跑完。
 */
import type { PlaybackDiagnosis } from "@openstrm/shared";
import { messageOf } from "../../lib/errors.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { readSettingsSafe } from "../settings-safe.js";
import { forgetPanPath, resolveEmbyPath } from "../resolve/direct-link.js";
import { listRunningTaskIds } from "../task/registry.js";
import { jobs as organizeJobs } from "../organize/run-state.js";
import { configuredApiKey, countMediaStreams, embyUpstream, fetchJson, requestPlaybackInfo, type EmbyMediaSource } from "./api.js";

/** Emby 回的条目，只认用得到的几个字段 */
export interface DiagnoseItem {
  Id?: unknown;
  Name?: unknown;
  Type?: unknown;
  Path?: unknown;
  MediaSources?: unknown;
}

interface Deps {
  /** 最近入库的条目（带 Path / MediaSources），挑诊断对象用 */
  listRecent: () => Promise<DiagnoseItem[]>;
  getItem: (id: string) => Promise<DiagnoseItem | null>;
  playbackInfo: (id: string) => Promise<EmbyMediaSource[]>;
  resolve: typeof resolveEmbyPath;
  /** 量之前忘掉这条路径的内存记录，量到的才是冷路径 */
  forget: typeof forgetPanPath;
  /** 同步 / 整理在跑：网盘请求都在排队，这时量不准 */
  busy: () => boolean;
}

/** 挑诊断对象时往前翻这么多条；库大了最近入库的几十条里总有 strm */
const RECENT_LIMIT = 50;
const FIELDS = "Path,MediaSources";

async function listRecentReal(): Promise<DiagnoseItem[]> {
  const url =
    `${embyUpstream()}/Items?Recursive=true&IncludeItemTypes=Movie,Episode&SortBy=DateCreated&SortOrder=Descending` +
    `&Limit=${RECENT_LIMIT}&Fields=${FIELDS}&api_key=${encodeURIComponent(configuredApiKey())}`;
  const body = (await fetchJson(url)) as { Items?: DiagnoseItem[] } | null;
  return Array.isArray(body?.Items) ? body.Items : [];
}

async function getItemReal(id: string): Promise<DiagnoseItem | null> {
  const url = `${embyUpstream()}/Items?Ids=${encodeURIComponent(id)}&Fields=${FIELDS}&Limit=1&api_key=${encodeURIComponent(configuredApiKey())}`;
  const body = (await fetchJson(url)) as { Items?: DiagnoseItem[] } | null;
  return body?.Items?.[0] ?? null;
}

const realDeps: Deps = {
  listRecent: listRecentReal,
  getItem: getItemReal,
  playbackInfo: requestPlaybackInfo,
  resolve: resolveEmbyPath,
  forget: forgetPanPath,
  busy: () => listRunningTaskIds().length > 0 || organizeJobs.size > 0,
};
let deps: Deps = { ...realDeps };

/** 仅供测试：换掉会碰 Emby / 网盘的部分；传 null 恢复 */
export function setDiagnoseDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

function isStrm(item: DiagnoseItem): boolean {
  return typeof item.Path === "string" && /\.strm$/i.test(item.Path);
}

/** 媒体源的 Path 才是 strm 的内容；没有媒体源（图片之类）退回条目自己的 Path */
function sourcePath(sources: unknown, fallback: unknown): string {
  const first = Array.isArray(sources) ? (sources as EmbyMediaSource[]).find((s) => typeof s.Path === "string" && s.Path) : undefined;
  if (first) return first.Path as string;
  return typeof fallback === "string" ? fallback : "";
}

/** 最近入库的 strm 条目里优先挑还没探测过的，量到的才是真正的首播 */
export function pickColdStrm(items: DiagnoseItem[]): DiagnoseItem | null {
  const strms = items.filter(isStrm);
  return strms.find((it) => countMediaStreams(it.MediaSources) === 0) ?? strms[0] ?? null;
}

const ms = (from: number): number => Math.round(performance.now() - from);

export async function diagnosePlayback(opts: { itemId?: string; userAgent?: string } = {}): Promise<PlaybackDiagnosis> {
  // 地址也要查：embyUpstream() 没填地址时会退到 docker 网关的默认值，诊断就会对着一个不存在的 Emby 报「没回答」
  if (!readSettingsSafe().emby?.url || !configuredApiKey()) throw new HttpError(400, "先在设置里填好 Emby 地址和 API Key");
  if (deps.busy()) throw new HttpError(409, "同步 / 整理正在跑，网盘请求都在排队，这会儿量出来的是排队时间；等它们跑完再诊断");
  const started = performance.now();

  let raw: DiagnoseItem | null;
  let picked = false;
  try {
    if (opts.itemId) {
      raw = await deps.getItem(opts.itemId);
      if (!raw) throw new HttpError(404, `Emby 里没有条目 ${opts.itemId}`);
    } else {
      raw = pickColdStrm(await deps.listRecent());
      if (!raw) throw new HttpError(404, `最近入库的 ${RECENT_LIMIT} 个条目里没有 strm 条目，指定一个条目 id 再试`);
      picked = true;
    }
  } catch (err) {
    // Emby 连不上 / 不认 key：按上游错误的壳回去（500 + 原话），别让它以未处理异常的样子落到日志里
    if (err instanceof HttpError) throw err;
    throw upstreamError(`Emby 没回答：${messageOf(err)}`, {}, err);
  }
  const id = String(raw.Id ?? opts.itemId ?? "");
  const streamsBefore = countMediaStreams(raw.MediaSources);
  let path = sourcePath(raw.MediaSources, raw.Path);

  // 第一段：PlaybackInfo。没探测过的条目 Emby 会在这一步真的探一次
  const emby: PlaybackDiagnosis["emby"] = { ms: 0, streamsBefore, streamsAfter: streamsBefore, probed: false, error: null };
  const t0 = performance.now();
  try {
    const sources = await deps.playbackInfo(id);
    emby.streamsAfter = countMediaStreams(sources);
    path = sourcePath(sources, path);
  } catch (err) {
    emby.error = messageOf(err);
  }
  emby.ms = ms(t0);
  emby.probed = streamsBefore === 0 && emby.streamsAfter > 0;

  // 第二段：换直链，和 302 路由走的是同一个函数；先忘掉内存里的记录，量的是冷路径
  const link: PlaybackDiagnosis["link"] = { ok: false, reason: null, account: null, pathMs: 0, pathVia: null, linkMs: 0, ms: 0, error: null };
  const t1 = performance.now();
  try {
    deps.forget(path);
    const r = await deps.resolve(path, opts.userAgent);
    if (r.ok) {
      link.ok = true;
      link.account = r.accountName;
      link.pathMs = r.timings.pathMs;
      link.pathVia = r.timings.pathVia;
      link.linkMs = r.timings.linkMs;
    } else {
      link.reason = r.reason;
    }
  } catch (err) {
    link.reason = "error";
    link.error = messageOf(err);
  }
  link.ms = ms(t1);

  return {
    item: { id, name: typeof raw.Name === "string" ? raw.Name : "", type: typeof raw.Type === "string" ? raw.Type : "", path, picked },
    emby,
    link,
    totalMs: ms(started),
  };
}
