/**
 * 网盘视频的探测：直链 + Range 读文件头 → mediainfo.js → 落库缓存。整理的模板变量 {resolution} {videoCodec} {audio} {hdr}
 * 在文件名没有对应标签时回退到这里的结果（文件名有的以文件名为准，发布组的写法更贴近用户习惯）。
 * 标签口径和 parse-name.ts 的词表一致：2160p / 1080p、HEVC / H.264 / AV1、DDP / AC3 / DTS-HD / TrueHD、DV / HDR10+ / HDR10 / HLG。
 */
import type { MediaProbeTags } from "@openstrm/shared";
import type { MediaInfoResult } from "mediainfo.js";
import { getMediaProbes, putMediaProbe, type MediaProbeRow } from "../../db/repositories/media-probes.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import type { DriveProvider } from "../drive/types.js";
import { analyzeSource, openRangeSource, ProbeBudgetError, type AnalyzeOutcome, type ProbeSource, type RangeLink } from "./mediainfo.js";

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
}

type AnyTrack = Record<string, unknown> & { "@type"?: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

function videoCodecOf(format: string | undefined, codecId: string | undefined): string {
  const f = (format ?? "").toLowerCase();
  const c = (codecId ?? "").toLowerCase();
  if (f === "avc" || c.includes("avc") || c.includes("h264")) return "H.264";
  if (f === "hevc" || c.includes("hvc") || c.includes("hev1") || c.includes("hevc")) return "HEVC";
  if (f === "av1" || c.includes("av01")) return "AV1";
  if (f === "vp9" || f === "vp09") return "VP9";
  if (f === "vp8") return "VP8";
  if (f === "mpeg-4 visual" || c.includes("xvid") || c.includes("divx")) return "XviD";
  if (f === "mpeg video") return "MPEG-2";
  if (f === "vc-1") return "VC-1";
  return format ?? codecId ?? "";
}

function hdrOf(hdrFormat: string | undefined, compat: string | undefined, transfer: string | undefined): string | undefined {
  const h = `${hdrFormat ?? ""} ${compat ?? ""}`;
  if (/dolby vision/i.test(h)) return "DV";
  if (/2094/.test(h) || /HDR10\+/i.test(h)) return "HDR10+";
  if (/2086/.test(h) || /HDR10/i.test(h)) return "HDR10";
  if (/HLG/i.test(h) || /HLG/i.test(transfer ?? "")) return "HLG";
  if (/PQ/i.test(transfer ?? "")) return "HDR";
  return undefined;
}

function audioCodecOf(format: string | undefined, commercial: string | undefined, features: string | undefined): string {
  const f = (format ?? "").toLowerCase();
  const c = (commercial ?? "").toLowerCase();
  if (f === "e-ac-3" || f === "eac3") return "DDP";
  if (f === "ac-3" || f === "ac3") return "AC3";
  if (f === "aac") return "AAC";
  if (f === "mlp fba" || c.includes("truehd")) return "TrueHD";
  if (f === "dts") {
    if (c.includes("dts:x") || c.includes("dts-x")) return "DTS-X";
    if (c.includes("dts-hd") || /XLL|HRA/i.test(features ?? "")) return "DTS-HD";
    return "DTS";
  }
  if (f === "flac") return "FLAC";
  if (f === "opus") return "Opus";
  if (f === "vorbis") return "Vorbis";
  if (f === "mpeg audio") return "MP3";
  if (f === "pcm") return "PCM";
  if (f === "alac") return "ALAC";
  return format ?? "";
}

/** 把 mediainfo.js 的结果收成我们自己的模型；没有视频轨就是 null（不是视频，或文件头没读到） */
export function probeFromResult(result: MediaInfoResult, bytesRead: number): MediaProbe | null {
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
  };
}

/** 分辨率标签：按高度（竖版 / 裁过的画面按宽度兜底） */
export function resolutionLabel(width: number | undefined, height: number | undefined): string | undefined {
  const h = height ?? 0;
  const w = width ?? 0;
  if (!h && !w) return undefined;
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

/** 模板用的四个标签 */
export function probeTags(p: MediaProbe): MediaProbeTags {
  const a = mainAudio(p);
  const out: MediaProbeTags = {};
  const resolution = resolutionLabel(p.video?.width, p.video?.height);
  if (resolution) out.resolution = resolution;
  if (p.video?.codec) out.videoCodec = p.video.codec;
  if (a?.codec) out.audio = a.codec;
  if (p.video?.hdr) out.hdr = p.video.hdr;
  return out;
}

const channelsLabel = (n: number | undefined): string => (n === undefined ? "" : n >= 8 ? "7.1" : n >= 6 ? "5.1" : n === 2 ? "2.0" : n === 1 ? "1.0" : `${n}ch`);

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

/** 取缓存（大小对得上才算）；返回 null 表示没有可用的缓存 */
export function cachedProbe(accountName: string, target: ProbeTarget): MediaProbeRow | null {
  const row = getMediaProbes(accountName, [probeKey(target)]).get(probeKey(target));
  if (!row) return null;
  if (target.size !== undefined && row.size > 0 && row.size !== target.size) return null;
  return row;
}

/**
 * 探测一个网盘文件：有可用缓存就直接回（失败的缓存只在 retryFailed 时重探）；没有就拿直链读文件头，结果落库。
 * 不抛：失败也是一个结果（status failed + error），调用方决定怎么说
 */
export async function probeDriveFile(provider: DriveProvider, accountName: string, target: ProbeTarget, opts: { signal?: AbortSignal; retryFailed?: boolean } = {}): Promise<ProbeOutcome> {
  const hit = cachedProbe(accountName, target);
  if (hit && (hit.status === "ok" || !opts.retryFailed)) return { status: hit.status, probe: hit.data, error: hit.error || undefined, cached: true };
  const key = probeKey(target);
  const now = Math.floor(Date.now() / 1000);
  try {
    const link = await provider.downloadLink(target.path, { token: provider.kind === "quark" ? target.id : undefined, signal: opts.signal });
    const ua = readAppSettings()["user-agent"];
    const source = await deps.open(link, target.size, typeof ua === "string" && ua ? { "User-Agent": ua } : {});
    const { result, bytesRead } = await deps.analyze(source, { signal: opts.signal });
    const probe = probeFromResult(result, bytesRead);
    if (!probe) {
      const error = "读到了文件头，但不是能识别的视频";
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

/** 一批文件的缓存标签（预览开始时填进单元；不碰网盘） */
export function cachedProbeTags(accountName: string, targets: ProbeTarget[]): Map<string, MediaProbeTags> {
  const out = new Map<string, MediaProbeTags>();
  if (targets.length === 0) return out;
  const rows = getMediaProbes(accountName, targets.map(probeKey));
  for (const t of targets) {
    const row = rows.get(probeKey(t));
    if (!row || row.status !== "ok" || !row.data) continue;
    if (t.size !== undefined && row.size > 0 && row.size !== t.size) continue;
    out.set(t.path, probeTags(row.data));
  }
  return out;
}
