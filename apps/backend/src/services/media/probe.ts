/**
 * 网盘视频的探测：直链 + Range 读文件头 → mediainfo.js → 落库缓存。整理的模板变量 {resolution} {videoCodec} {audio} {hdr}
 * 在文件名没有对应标签时回退到这里的结果（文件名有的以文件名为准，发布组的写法更贴近用户习惯）。
 * 标签口径和 parse-name.ts 的词表一致：2160p / 1080p、HEVC / H.264 / AV1、DDP / AC3 / DTS-HD / TrueHD、DV / HDR10+ / HDR10 / HLG。
 */
import type { MediaBrief, MediaProbeTags } from "@openstrm/shared";
import type { MediaInfoResult } from "mediainfo.js";
import { getMediaProbes, getMediaProbesByPaths, putMediaProbe, type MediaProbeRow } from "../../db/repositories/media-probes.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import type { DriveProvider } from "../drive/types.js";
import { analyzeSource, openRangeSource, PROBE_LIMITS, ProbeBudgetError, type AnalyzeOutcome, type ProbeSource, type RangeLink } from "./mediainfo.js";

export interface MediaProbeVideo {
  codec: string;
  profile?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  bitDepth?: number;
  /** DV / HDR10+ / HDR10 / HLG / HDR */
  hdr?: string;
  bitrateKbps?: number;
}

export interface MediaProbeAudio {
  codec: string;
  /** MediaInfo 的商业名（Dolby Digital Plus with Dolby Atmos 之类） */
  commercial?: string;
  channels?: number;
  language?: string;
  title?: string;
  isDefault?: boolean;
  atmos?: boolean;
}

export interface MediaProbeText {
  codec: string;
  language?: string;
  title?: string;
  forced?: boolean;
}

export interface MediaProbe {
  container?: string;
  durationMs?: number;
  video?: MediaProbeVideo;
  audio: MediaProbeAudio[];
  subtitles: MediaProbeText[];
  /** 为了这个结果读了多少字节 */
  bytesRead: number;
  /** 读到预算上限就停了：轨道表和首帧都在前面，标签照样齐，只是时长 / 靠后的字幕首条可能缺 */
  truncated?: boolean;
  /** 原盘 ISO 从镜像中点取样：从这个字节偏移起读的（0 / 没有 = 从头读） */
  sampleOffset?: number;
}

const SECTOR = 2048;

/**
 * 原盘 ISO：mediainfo.js 把它当裸 BDAV 流、只看镜像最前面那段 m2ts（多半是片头 / 菜单，只有视频），正片的音轨拿不到。
 * 正片占了镜像的绝大部分，从中点起喂它就落在正片里；TS 的节目表每几十毫秒重复一次，从哪儿起都同步得上。按扇区对齐。
 * 拿不到的只有音轨语言（在播放列表里，裸流没有），标签用不到；不解析 UDF、不挑播放列表
 */
export function probeView(source: ProbeSource, path: string): { source: ProbeSource; sampleOffset: number } {
  if (!/\.iso$/i.test(path) || source.size < 4 * SECTOR) return { source, sampleOffset: 0 };
  const base = Math.floor(source.size / 2 / SECTOR) * SECTOR;
  return { source: { size: source.size - base, read: (offset, length, signal) => source.read(base + offset, length, signal) }, sampleOffset: base };
}

type AnyTrack = Record<string, unknown> & { "@type"?: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** 视频编码的统一写法：收 MediaInfo 的 Format / CodecID，也收 Emby 的短名（h264 / hevc / mpeg4 …） */
export function videoCodecOf(format: string | undefined, codecId: string | undefined): string {
  const f = (format ?? "").toLowerCase();
  const c = (codecId ?? "").toLowerCase();
  if (f === "avc" || f === "h264" || c.includes("avc") || c.includes("h264")) return "H.264";
  if (f === "hevc" || f === "h265" || c.includes("hvc") || c.includes("hev1") || c.includes("hevc")) return "HEVC";
  if (f === "av1" || c.includes("av01")) return "AV1";
  if (f === "vp9" || f === "vp09") return "VP9";
  if (f === "vp8") return "VP8";
  if (f === "mpeg-4 visual" || f === "mpeg4" || c.includes("xvid") || c.includes("divx")) return "XviD";
  if (f === "mpeg video" || f === "mpeg2video") return "MPEG-2";
  if (f === "vc-1" || f === "vc1") return "VC-1";
  return format ?? codecId ?? "";
}

export function hdrOf(hdrFormat: string | undefined, compat: string | undefined, transfer: string | undefined): string | undefined {
  const h = `${hdrFormat ?? ""} ${compat ?? ""}`;
  if (/dolby vision/i.test(h)) return "DV";
  if (/2094/.test(h) || /HDR10\+/i.test(h)) return "HDR10+";
  if (/2086/.test(h) || /HDR10/i.test(h)) return "HDR10";
  if (/HLG/i.test(h) || /HLG/i.test(transfer ?? "")) return "HLG";
  if (/PQ/i.test(transfer ?? "")) return "HDR";
  return undefined;
}

/** 音频编码的统一写法：收 MediaInfo 的 Format / 商业名，也收 Emby 的短名（eac3 / truehd / pcm_s16le …） */
export function audioCodecOf(format: string | undefined, commercial: string | undefined, features: string | undefined): string {
  const f = (format ?? "").toLowerCase();
  const c = (commercial ?? "").toLowerCase();
  if (f === "e-ac-3" || f === "eac3") return "DDP";
  if (f === "ac-3" || f === "ac3") return "AC3";
  if (f === "aac") return "AAC";
  if (f === "mlp fba" || f === "truehd" || c.includes("truehd")) return "TrueHD";
  if (f === "dts") {
    if (c.includes("dts:x") || c.includes("dts-x")) return "DTS-X";
    if (c.includes("dts-hd") || /XLL|HRA/i.test(features ?? "")) return "DTS-HD";
    return "DTS";
  }
  if (f === "flac") return "FLAC";
  if (f === "opus") return "Opus";
  if (f === "vorbis") return "Vorbis";
  if (f === "mpeg audio" || f === "mp3") return "MP3";
  if (f === "pcm" || f.startsWith("pcm_")) return "PCM";
  if (f === "alac") return "ALAC";
  return format ?? "";
}

/** 把 mediainfo.js 的结果收成我们自己的模型；没有视频轨就是 null（不是视频，或文件头没读到） */
export function probeFromResult(result: MediaInfoResult, bytesRead: number, truncated = false, sampleOffset = 0): MediaProbe | null {
  const tracks = (result.media?.track ?? []) as AnyTrack[];
  const general = tracks.find((t) => t["@type"] === "General");
  const video = tracks.find((t) => t["@type"] === "Video");
  if (!video) return null;
  const audio = tracks.filter((t) => t["@type"] === "Audio");
  const text = tracks.filter((t) => t["@type"] === "Text");
  const durationS = num(video.Duration) ?? num(general?.Duration);
  const vBitrate = num(video.BitRate);
  return {
    container: str(general?.Format),
    durationMs: durationS !== undefined ? Math.round(durationS * 1000) : undefined,
    video: {
      codec: videoCodecOf(str(video.Format), str(video.CodecID)),
      profile: str(video.Format_Profile),
      width: num(video.Width),
      height: num(video.Height),
      frameRate: num(video.FrameRate),
      bitDepth: num(video.BitDepth),
      hdr: hdrOf(str(video.HDR_Format), str(video.HDR_Format_Compatibility), str(video.transfer_characteristics)),
      bitrateKbps: vBitrate !== undefined ? Math.round(vBitrate / 1000) : undefined,
    },
    audio: audio.map((a) => {
      const commercial = str(a.Format_Commercial_IfAny);
      const features = str(a.Format_AdditionalFeatures);
      const aBitrate = num(a.BitRate);
      return {
        codec: audioCodecOf(str(a.Format), commercial, features),
        commercial,
        channels: num(a.Channels),
        language: str(a.Language),
        title: str(a.Title),
        isDefault: str(a.Default) === "Yes",
        atmos: /atmos/i.test(commercial ?? "") || /JOC/i.test(features ?? "") || undefined,
        bitrateKbps: aBitrate !== undefined ? Math.round(aBitrate / 1000) : undefined,
      };
    }),
    subtitles: text.map((t) => ({ codec: str(t.Format) ?? "", language: str(t.Language), title: str(t.Title), forced: str(t.Forced) === "Yes" || undefined })),
    bytesRead,
    ...(truncated ? { truncated: true } : {}),
    ...(sampleOffset > 0 ? { sampleOffset } : {}),
  };
}

/** 分辨率标签：按高度（竖版 / 裁过的画面按宽度兜底） */
export function resolutionLabel(width: number | undefined, height: number | undefined): string | undefined {
  const h = height ?? 0;
  const w = width ?? 0;
  if (!h && !w) return undefined;
  if (h >= 4000 || w >= 7000) return "4320p";
  if (h >= 2000 || w >= 3800) return "2160p";
  if (h >= 1000 || w >= 1900) return "1080p";
  if (h >= 700 || w >= 1260) return "720p";
  if (h >= 570 || w >= 1000) return "576p";
  if (h >= 470 || w >= 700) return "480p";
  return `${h || Math.round((w * 9) / 16)}p`;
}

/** 主音轨：标了默认的，否则第一条 */
export function mainAudio(p: MediaProbe): MediaProbeAudio | undefined {
  return p.audio.find((a) => a.isDefault) ?? p.audio[0];
}

const channelsLabel = (n: number | undefined): string => (n === undefined ? "" : n >= 8 ? "7.1" : n >= 6 ? "5.1" : n === 2 ? "2.0" : n === 1 ? "1.0" : `${n}ch`);

/** 模板用的四个标签；audio 和文件名解析出来的形状一致：编码 声道 Atmos（`DDP 5.1 Atmos`） */
export function probeTags(p: MediaProbe): MediaProbeTags {
  const a = mainAudio(p);
  const out: MediaProbeTags = {};
  const resolution = resolutionLabel(p.video?.width, p.video?.height);
  if (resolution) out.resolution = resolution;
  if (p.video?.codec) out.videoCodec = p.video.codec;
  if (a?.codec) out.audio = [a.codec, channelsLabel(a.channels), a.atmos ? "Atmos" : ""].filter(Boolean).join(" ");
  if (p.video?.hdr) out.hdr = p.video.hdr;
  return out;
}


/** ISO 639 的占位码：und 是没标语言、zxx 是没有语言内容（纯音乐）；Emby 照抄 ffprobe 的 tag，写出来没意义 */
const PLACEHOLDER_LANG = /^(und|zxx)$/i;
const langOf = (l: string | undefined): string | undefined => (l && !PLACEHOLDER_LANG.test(l) ? l : undefined);

/** 给界面的精简版：主音轨、字幕语言去重（占位码不算）、来源按 bytesRead 分（Emby 回填的是 0） */
export function mediaBrief(p: MediaProbe): MediaBrief {
  const a = mainAudio(p);
  const brief: MediaBrief = {
    audioCount: p.audio.length,
    subtitleLanguages: [...new Set(p.subtitles.map((s) => langOf(s.language)).filter((l): l is string => !!l))],
    source: p.bytesRead > 0 ? "probe" : "emby",
  };
  const resolution = resolutionLabel(p.video?.width, p.video?.height);
  if (resolution) brief.resolution = resolution;
  if (p.video?.width) brief.width = p.video.width;
  if (p.video?.height) brief.height = p.video.height;
  if (p.video?.codec) brief.videoCodec = p.video.codec;
  if (p.video?.bitDepth) brief.bitDepth = p.video.bitDepth;
  if (p.video?.frameRate) brief.frameRate = p.video.frameRate;
  if (p.video?.hdr) brief.hdr = p.video.hdr;
  if (p.video?.bitrateKbps) brief.bitrateKbps = p.video.bitrateKbps;
  if (a?.codec) brief.audioCodec = a.codec;
  const channels = a ? channelsLabel(a.channels) : "";
  if (channels) brief.channels = channels;
  if (a?.atmos) brief.atmos = true;
  const lang = langOf(a?.language);
  if (lang) brief.audioLanguage = lang;
  if (p.container) brief.container = p.container;
  if (p.durationMs) brief.durationMs = p.durationMs;
  if (p.truncated) brief.truncated = true;
  return brief;
}

/** 一行给人看的：HEVC · 2160p · DV · DDP Atmos 5.1 · 字幕 chi/eng */
export function probeSummary(p: MediaProbe): string {
  const parts: string[] = [];
  if (p.video) {
    parts.push(p.video.codec || "视频");
    const r = resolutionLabel(p.video.width, p.video.height);
    if (r) parts.push(p.video.bitDepth && p.video.bitDepth > 8 ? `${r} ${p.video.bitDepth}bit` : r);
    if (p.video.hdr) parts.push(p.video.hdr);
  }
  const a = mainAudio(p);
  if (a) parts.push([a.codec, a.atmos ? "Atmos" : "", channelsLabel(a.channels), a.language ?? ""].filter(Boolean).join(" "));
  if (p.audio.length > 1) parts.push(`${p.audio.length} 条音轨`);
  if (p.subtitles.length > 0) parts.push(`字幕 ${[...new Set(p.subtitles.map((s) => s.language ?? "?"))].slice(0, 4).join("/")}`);
  if (p.truncated) parts.push(`只读了${p.sampleOffset ? "中间" : "前"} ${Math.max(1, Math.round(p.bytesRead / 1048576))} MB`);
  return parts.join(" · ");
}

/* ------------------------------- 缓存 + 直链 ------------------------------- */

export interface ProbeTarget {
  /** 网盘绝对路径 */
  path: string;
  /** 网盘上的文件 id（115 / 夸克有，整棵列的 115 没有）：有就按它记缓存，挪动改名后还认 */
  id?: string;
  size?: number;
}

export interface ProbeOutcome {
  status: "ok" | "failed";
  probe: MediaProbe | null;
  error?: string;
  /** 直接用了缓存，没碰网盘 */
  cached: boolean;
}

export const probeKey = (t: Pick<ProbeTarget, "path" | "id">): string => (t.id ? `id:${t.id}` : `path:${t.path}`);

interface Deps {
  analyze: (source: ProbeSource, opts: { signal?: AbortSignal }) => Promise<AnalyzeOutcome>;
  open: (link: RangeLink, size: number | undefined, headers: Record<string, string>) => Promise<ProbeSource>;
}

const realDeps: Deps = { analyze: analyzeSource, open: openRangeSource };
let deps: Deps = { ...realDeps };

/** 仅供测试：换掉分析器 / 直链读取；传 null 恢复 */
export function setProbeDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

function describeError(err: unknown): string {
  if (err instanceof ProbeBudgetError) return err.message;
  const msg = err instanceof Error ? err.message : String(err);
  if (/maxContentLength/i.test(msg)) return "直链不支持 Range 读取";
  if (/timeout|ECONNABORTED/i.test(msg)) return "读文件头超时";
  return msg.slice(0, 200);
}

/** 一个文件可能命中的缓存键：有 id 先按 id，再退到路径（Emby 回填的只认路径） */
const keysOf = (t: ProbeTarget): string[] => (t.id ? [probeKey(t), `path:${t.path}`] : [probeKey(t)]);

/** 取缓存（大小对得上才算）；返回 null 表示没有可用的缓存 */
export function cachedProbe(accountName: string, target: ProbeTarget): MediaProbeRow | null {
  const rows = getMediaProbes(accountName, keysOf(target));
  for (const key of keysOf(target)) {
    const row = rows.get(key);
    if (!row) continue;
    if (target.size !== undefined && row.size > 0 && row.size !== target.size) continue;
    return row;
  }
  return null;
}

/**
 * 探测一个网盘文件：有可用缓存就直接回（失败的缓存只在 retryFailed 时重探）；没有就拿直链读文件头，结果落库。
 * 不抛：失败也是一个结果（status failed + error），调用方决定怎么说
 */
export async function probeDriveFile(provider: DriveProvider, accountName: string, target: ProbeTarget, opts: { signal?: AbortSignal; retryFailed?: boolean } = {}): Promise<ProbeOutcome> {
  const hit = cachedProbe(accountName, target);
  // 旧版预算到顶算失败（「读取量超过上限」），现在到顶给半截结果：这种失败缓存不算数，当没探过，不用人再点一次重试
  const staleBudgetFailure = hit?.status === "failed" && /读取量超过上限/.test(hit.error ?? "");
  if (hit && !staleBudgetFailure && (hit.status === "ok" || !opts.retryFailed)) return { status: hit.status, probe: hit.data, error: hit.error || undefined, cached: true };
  const key = probeKey(target);
  const now = Math.floor(Date.now() / 1000);
  try {
    const link = await provider.downloadLink(target.path, { token: provider.kind === "quark" ? target.id : undefined, signal: opts.signal });
    const ua = readAppSettings()["user-agent"];
    const source = await deps.open(link, target.size, typeof ua === "string" && ua ? { "User-Agent": ua } : {});
    const view = probeView(source, target.path);
    const { result, bytesRead, truncated } = await deps.analyze(view.source, { signal: opts.signal });
    const probe = probeFromResult(result, bytesRead, truncated, view.sampleOffset);
    if (!probe) {
      const where = view.sampleOffset ? "从镜像中点读了" : "读了前";
      const error = truncated
        ? `${where} ${Math.max(1, Math.round(bytesRead / 1048576))} MB 还没找到视频轨（上限 ${PROBE_LIMITS.MAX_READS} 次 / ${PROBE_LIMITS.MAX_BYTES >> 20} MB）`
        : view.sampleOffset
          ? "镜像中点读到的不是能识别的视频流"
          : "读到了文件头，但不是能识别的视频";
      putMediaProbe({ accountName, key, path: target.path, size: source.size, status: "failed", data: null, error, probedAt: now });
      return { status: "failed", probe: null, error, cached: false };
    }
    putMediaProbe({ accountName, key, path: target.path, size: source.size, status: "ok", data: probe, error: "", probedAt: now });
    return { status: "ok", probe, cached: false };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const error = describeError(err);
    putMediaProbe({ accountName, key, path: target.path, size: target.size ?? 0, status: "failed", data: null, error, probedAt: now });
    return { status: "failed", probe: null, error, cached: false };
  }
}

/** 一批文件的缓存结果（预览开始时填进单元；不碰网盘）：键是网盘绝对路径，大小对不上的不算 */
export function cachedProbes(accountName: string, targets: ProbeTarget[]): Map<string, MediaProbe> {
  const out = new Map<string, MediaProbe>();
  if (targets.length === 0) return out;
  const rows = getMediaProbes(accountName, targets.flatMap(keysOf));
  for (const t of targets) {
    for (const key of keysOf(t)) {
      const row = rows.get(key);
      if (!row || row.status !== "ok" || !row.data) continue;
      if (t.size !== undefined && row.size > 0 && row.size !== t.size) continue;
      out.set(t.path, row.data);
      break;
    }
  }
  return out;
}

const readHeader = (r: MediaProbeRow): boolean => (r.data?.bytesRead ?? 0) > 0;

/** 同一路径的两行哪个更可信：两行记的大小都有、又不一样，是先后两个文件（原来那个被换掉了），取新的；否则取读过文件头的，再取新的 */
function betterByPath(a: MediaProbeRow, b: MediaProbeRow): boolean {
  if (a.size > 0 && b.size > 0 && a.size !== b.size) return a.probedAt > b.probedAt;
  if (readHeader(a) !== readHeader(b)) return readHeader(a);
  return a.probedAt > b.probedAt;
}

/**
 * 按网盘绝对路径找缓存（strm 页用，手里只有路径没有 id）：同一路径可能有两行（按 id 记的 + Emby 回填的），按 betterByPath 取。
 * 按 id 记的行里 path 是探测当时的路径：整理执行 / 撤销挪过的文件跟着改（apply.ts / revert.ts 的 repathMediaProbes），
 * 别的途径挪的按新路径查不到，等 Emby 播放后按新路径回填
 */
export function cachedProbesByPath(accountName: string, paths: string[]): Map<string, MediaProbe> {
  const out = new Map<string, MediaProbe>();
  if (paths.length === 0) return out;
  const best = new Map<string, MediaProbeRow>();
  for (const row of getMediaProbesByPaths(accountName, [...new Set(paths)])) {
    if (row.status !== "ok" || !row.data) continue;
    const had = best.get(row.path);
    if (!had || betterByPath(row, had)) best.set(row.path, row);
  }
  for (const [path, row] of best) out.set(path, row.data!);
  return out;
}

/** 一批文件的缓存标签 */
export function cachedProbeTags(accountName: string, targets: ProbeTarget[]): Map<string, MediaProbeTags> {
  return new Map([...cachedProbes(accountName, targets)].map(([path, probe]) => [path, probeTags(probe)]));
}
