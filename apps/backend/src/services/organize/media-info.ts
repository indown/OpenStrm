/**
 * 文件名标签和实测结果的对照、作品单元的媒体信息汇总（界面画旗标用）。
 * 文件名是上传者写的，实测是读文件头 / Emby 分析出来的：对不上的地方（假 4K、x265 写成 x264）提示出来，
 * 命名模板仍按文件名优先（见 .claude/plans/media-flags.md 的「不做」）。
 */
import type { MediaBrief, MediaConflict, MediaValueCount, OrganizeUnitMedia } from "@openstrm/shared";
import type { ParsedTags } from "./parse-name.js";
import type { Unit, UnitFile } from "./units.js";

/** 编码家族：x265 / H.265 / HEVC 是一家，x264 / AVC / H.264 是一家；10bit / Hi10P 是位深词不是编码，回 null */
export function codecFamily(codec: string | undefined): string | null {
  const c = (codec ?? "").toLowerCase().replace(/[\s.-]/g, "");
  if (!c) return null;
  if (c === "x265" || c === "h265" || c === "hevc") return "HEVC";
  if (c === "x264" || c === "h264" || c === "avc") return "H.264";
  if (c === "av1") return "AV1";
  if (c === "xvid" || c === "divx" || c === "mpeg4visual") return "XviD";
  if (c === "vp9") return "VP9";
  if (c === "10bit" || c === "8bit" || c === "hi10p") return null;
  return codec ?? null;
}

/** 分辨率档：4K 归到 2160p、8K 归到 4320p，1080i 和 1080p 同一档。UHD 在发布组命名里常指片源（1080p.UHD.BluRay），不比 */
export function resolutionBucket(value: string | undefined): string | null {
  const v = (value ?? "").toLowerCase();
  if (!v || v === "uhd") return null;
  if (v === "4k" || v === "2160p") return "2160p";
  if (v === "8k" || v === "4320p") return "4320p";
  if (v === "1080i" || v === "1080p") return "1080p";
  return v;
}

const HDR_WORDS = new Set(["hdr", "hdr10", "hdr10+", "dv", "hlg"]);

/**
 * 文件名标签 vs 实测，只比两边都有的：
 *   - 分辨率按档，编码按家族；
 *   - HDR 只在三种情况算：文件名有 HDR 类标签而实测是 SDR、文件名写 DV 而实测不是 DV、文件名写 SDR 而实测有 HDR。
 *     HDR / HDR10 / HDR10+ / DV 互相不算（DV 片几乎都带 HDR10 兼容层，文件名写 HDR 没错）；
 *   - 音频不比：多音轨时文件名写哪条都对
 */
export function mediaConflicts(tags: ParsedTags, media: MediaBrief | undefined): MediaConflict[] {
  if (!media) return [];
  const out: MediaConflict[] = [];
  const namedRes = resolutionBucket(tags.resolution);
  const probedRes = resolutionBucket(media.resolution);
  if (tags.resolution && media.resolution && namedRes && probedRes && namedRes !== probedRes) out.push({ kind: "resolution", named: tags.resolution, probed: media.resolution });
  const namedCodec = codecFamily(tags.videoCodec);
  const probedCodec = codecFamily(media.videoCodec);
  if (tags.videoCodec && media.videoCodec && namedCodec && probedCodec && namedCodec !== probedCodec) out.push({ kind: "videoCodec", named: tags.videoCodec, probed: media.videoCodec });
  const namedHdr = (tags.hdr ?? "").toLowerCase();
  if (tags.hdr && namedHdr === "sdr") {
    if (media.hdr) out.push({ kind: "hdr", named: tags.hdr, probed: media.hdr });
  } else if (tags.hdr && HDR_WORDS.has(namedHdr)) {
    if (!media.hdr) out.push({ kind: "hdr", named: tags.hdr, probed: "SDR" });
    else if (namedHdr === "dv" && media.hdr !== "DV") out.push({ kind: "hdr", named: tags.hdr, probed: media.hdr });
  }
  return out;
}

const tally = (values: Array<string | null | undefined>): MediaValueCount[] => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
};

/** 模板口径的有效值：文件名优先、实测兜底（和 plan.ts 的 fileVars 一致） */
const effective = (f: UnitFile, key: "resolution" | "videoCodec" | "hdr" | "audio"): string | undefined => f.parsed.tags[key] || f.probe?.[key];

/** 作品单元的汇总：分辨率按档、编码按家族归一（x265 和 HEVC 不算两种）；没有视频就没有 */
export function unitMedia(unit: Pick<Unit, "files">): OrganizeUnitMedia | undefined {
  const videos = unit.files.filter((f) => f.kind === "video");
  if (videos.length === 0) return undefined;
  return {
    videos: videos.length,
    probed: videos.filter((f) => f.media).length,
    resolution: tally(videos.map((f) => resolutionBucket(effective(f, "resolution")))),
    videoCodec: tally(videos.map((f) => codecFamily(effective(f, "videoCodec")))),
    bitDepth: tally(videos.map((f) => (f.media?.bitDepth && f.media.bitDepth > 8 ? `${f.media.bitDepth}bit` : undefined))),
    hdr: tally(videos.map((f) => effective(f, "hdr"))),
    audio: tally(videos.map((f) => effective(f, "audio"))),
    conflicts: videos.filter((f) => mediaConflicts(f.parsed.tags, f.media).length > 0).length,
  };
}
