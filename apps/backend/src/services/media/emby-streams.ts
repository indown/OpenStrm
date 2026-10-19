/**
 * Emby 已经分析过的媒体流 → 探测缓存。Emby 扫过一个 strm（指向本机挂载的网盘）就有 MediaStreams，
 * 和我们读文件头得到的是同一份信息，白送的；回填进 media_probes，整理时就不用再读网盘。
 * 只认路径（strm 内容换算回网盘路径），查缓存时有 id 的文件会退到按路径找（probe.ts 的 keysOf）。
 */
import type { TaskDefinition } from "@openstrm/shared";
import { listTasks } from "../../db/repositories/tasks.js";
import { getMediaProbes, putMediaProbe } from "../../db/repositories/media-probes.js";
import { normalizePath } from "../drive/types.js";
import { remoteOfStrmContent } from "../organize/local-naming.js";
import { audioCodecOf, hdrOf, probeKey, videoCodecOf, type MediaProbe } from "./probe.js";

/** Emby /Items 带 MediaSources 时每个媒体源的样子（只取用得着的） */
export interface EmbyStreamSource {
  /** strm 的内容（本机挂载路径或 http 地址），不是 strm 文件自己的路径 */
  path: string;
  size?: number;
  container?: string;
  streams: Array<Record<string, unknown>>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Emby 的 VideoRangeType（DOVI / HDR10 / HDR10Plus / HLG …）换成我们的标签 */
function hdrOfEmby(rangeType: string | undefined, range: string | undefined): string | undefined {
  const t = (rangeType ?? "").toLowerCase();
  if (t.includes("dovi") || t.includes("dolby")) return "DV";
  if (t.includes("hdr10plus") || t.includes("hdr10+")) return "HDR10+";
  if (t.includes("hdr10")) return "HDR10";
  if (t.includes("hlg")) return "HLG";
  if (t && t !== "sdr") return hdrOf(rangeType, undefined, undefined) ?? "HDR";
  return (range ?? "").toLowerCase() === "hdr" ? "HDR" : undefined;
}

/** 一个媒体源的流 → 探测结果；没有视频流就是 null */
export function probeFromEmbyStreams(source: EmbyStreamSource): MediaProbe | null {
  const video = source.streams.find((st) => st.Type === "Video");
  if (!video) return null;
  const audio = source.streams.filter((st) => st.Type === "Audio");
  const text = source.streams.filter((st) => st.Type === "Subtitle");
  const vBitrate = num(video.BitRate);
  return {
    container: source.container,
    video: {
      codec: videoCodecOf(str(video.Codec), undefined),
      profile: str(video.Profile),
      width: num(video.Width),
      height: num(video.Height),
      frameRate: num(video.RealFrameRate) ?? num(video.AverageFrameRate),
      bitDepth: num(video.BitDepth),
      hdr: hdrOfEmby(str(video.VideoRangeType), str(video.VideoRange)),
      bitrateKbps: vBitrate !== undefined ? Math.round(vBitrate / 1000) : undefined,
    },
    audio: audio.map((a) => {
      const profile = str(a.Profile);
      const display = str(a.DisplayTitle) ?? "";
      const aBitrate = num(a.BitRate);
      return {
        codec: audioCodecOf(str(a.Codec), profile, undefined),
        commercial: profile,
        channels: num(a.Channels),
        language: str(a.Language),
        title: str(a.Title),
        isDefault: a.IsDefault === true,
        atmos: /atmos/i.test(`${profile ?? ""} ${display}`) || undefined,
        bitrateKbps: aBitrate !== undefined ? Math.round(aBitrate / 1000) : undefined,
      };
    }),
    subtitles: text.map((t) => ({ codec: str(t.Codec) ?? "", language: str(t.Language), title: str(t.Title), forced: t.IsForced === true || undefined })),
    bytesRead: 0,
  };
}

/** strm 内容是哪个任务的哪个网盘文件：按任务的 strmPrefix / originPath 换算，第一个对上的算 */
export function driveFileOf(content: string, tasks: TaskDefinition[]): { accountName: string; path: string } | null {
  for (const task of tasks) {
    const r = remoteOfStrmContent(task, content);
    if ("problem" in r || r.candidates.length === 0) continue;
    return { accountName: task.account, path: normalizePath(`/${task.originPath}/${r.candidates[0]}`) };
  }
  return null;
}

export interface EmbyBackfillResult {
  /** 写进缓存的 */
  filled: number;
  /** 已经有读文件头得到的结果，不覆盖 */
  kept: number;
  /** 对不上任何任务、或 Emby 没分析过 */
  skipped: number;
}

/**
 * 把一批 Emby 条目的媒体流回填进探测缓存。已经有「读文件头」的结果（bytesRead > 0）不覆盖；
 * Emby 回填的会被下一次 Emby 回填更新（它分析得更细了）
 */
export function backfillProbesFromEmby(sources: EmbyStreamSource[], tasks: TaskDefinition[] = listTasks()): EmbyBackfillResult {
  const out: EmbyBackfillResult = { filled: 0, kept: 0, skipped: 0 };
  const now = Math.floor(Date.now() / 1000);
  for (const source of sources) {
    const probe = probeFromEmbyStreams(source);
    const target = probe ? driveFileOf(source.path, tasks) : null;
    if (!probe || !target) {
      out.skipped++;
      continue;
    }
    const key = probeKey({ path: target.path });
    const existing = getMediaProbes(target.accountName, [key]).get(key);
    if (existing?.status === "ok" && existing.data && existing.data.bytesRead > 0) {
      out.kept++;
      continue;
    }
    putMediaProbe({ accountName: target.accountName, key, path: target.path, size: source.size ?? 0, status: "ok", data: probe, error: "", probedAt: now });
    out.filled++;
  }
  return out;
}
