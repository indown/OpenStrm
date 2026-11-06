/**
 * 文件名标签和实测结果的对照、作品单元的媒体信息汇总（界面画旗标用）、模板要探哪些标签。
 * 文件名是上传者写的，实测是读文件头 / Emby 分析出来的：对不上的地方（假 4K、x265 写成 x264）提示出来，
 * 命名模板仍按文件名优先（见 .claude/plans/media-flags.md 的「不做」）。
 */
import type { MediaBrief, MediaConflict, MediaProbeTags, MediaValueCount, OrganizeUnitMedia } from "@openstrm/shared";
import type { ParsedTags } from "./parse-name.js";
import { templateVarNames } from "./template.js";
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

/** 音频编码家族：文件名里的 EAC3 / DD+ 和实测的 DDP 是一家，DD 是 AC3，DTS-HD MA / HRA 都归 DTS-HD（实测分不出 MA） */
const AUDIO_FAMILY: Record<string, string> = {
  eac3: "DDP", "dd+": "DDP", ddp: "DDP", dd: "AC3", ac3: "AC3", "dts-hd": "DTS-HD", dtshd: "DTS-HD", "dts-x": "DTS-X", dtsx: "DTS-X",
  truehd: "TrueHD", aac: "AAC", dts: "DTS", flac: "FLAC", opus: "Opus", mp3: "MP3", lpcm: "PCM", pcm: "PCM", alac: "ALAC", vorbis: "Vorbis",
};

/**
 * 音频标签的统一写法 `编码… 声道 Atmos`：文件名解析出来的按出现顺序（`TrueHD Atmos 7.1`、`DTS-HD MA 5.1`、`EAC3 5.1`），
 * 实测的是固定顺序（`TrueHD 7.1 Atmos`、`DTS-HD 5.1`、`DDP 5.1`），不归一的话同一种音频在汇总里会分成两条
 */
export function audioKey(audio: string | undefined): string | null {
  if (!audio) return null;
  const codecs: string[] = [];
  let channels = "";
  let atmos = false;
  for (const w of audio.split(/\s+/).filter(Boolean)) {
    const l = w.toLowerCase();
    if (l === "atmos") atmos = true;
    else if (/^\d\.\d$/.test(w) || /^\d+ch$/.test(l)) channels = w;
    else if (l === "ma" || l === "hra" || l === "hr") continue;
    else codecs.push(AUDIO_FAMILY[l] ?? w);
  }
  const key = [[...new Set(codecs)].join(" "), channels, atmos ? "Atmos" : ""].filter(Boolean).join(" ");
  return key || null;
}

/** HDR 标签：文件名写 SDR 是「没有 HDR」，汇总里不出现 */
const hdrKey = (hdr: string | undefined): string | null => (hdr && hdr.toLowerCase() !== "sdr" ? hdr : null);

const HDR_WORDS = new Set(["hdr", "hdr10", "hdr10+", "dv", "hlg"]);

/**
 * 文件名标签 vs 实测，只比两边都有的：
 *   - 分辨率按档，编码按家族；
 *   - HDR 只在三种情况算：文件名有 HDR 类标签而实测是 SDR、文件名写 DV 而实测明确不是 DV、文件名写 SDR 而实测有 HDR。
 *     HDR / HDR10 / HDR10+ / DV 互相不算（DV 片几乎都带 HDR10 兼容层，文件名写 HDR 没错）；
 *     实测只知道是 HDR（PQ 曲线、没拿到元数据，Emby 回填的常常只有这么多）分不出是不是 DV，不算；
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
    else if (namedHdr === "dv" && media.hdr !== "DV" && media.hdr !== "HDR") out.push({ kind: "hdr", named: tags.hdr, probed: media.hdr });
  }
  return out;
}

const PROBE_VARS: Array<keyof MediaProbeTags> = ["resolution", "videoCodec", "audio", "hdr"];

/** 模板里用到了哪些可以探测出来的标签：按解析器收变量名，`{audio:.}` 这种带后缀 / 兜底链的写法也算（按字面找 `{audio}` 会漏掉发布组写法里的音频） */
export function probeVarsOf(org: { templates: { movie: string; tv: string } }): Array<keyof MediaProbeTags> {
  const names = new Set([...templateVarNames(org.templates.movie), ...templateVarNames(org.templates.tv)]);
  return PROBE_VARS.filter((v) => names.has(v));
}

/** 文件名里缺模板要用的标签、探测结果里也没有 */
export const lacksProbeTags = (file: UnitFile, wanted: ReadonlyArray<keyof MediaProbeTags>): boolean => wanted.some((v) => !file.parsed.tags[v] && !file.probe?.[v]);

const tally = (values: Array<string | null | undefined>): MediaValueCount[] => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
};

/**
 * 模板口径的有效值（文件名优先、实测兜底，和 plan.ts 的 fileVars 一致）再归一。
 * 文件名标签归一后为空的（10bit 占了 videoCodec、UHD 占了 resolution）不算写了，退到实测；文件名写 SDR 是写了「没有 HDR」，不退
 */
const effectiveResolution = (f: UnitFile): string | null => resolutionBucket(f.parsed.tags.resolution) ?? resolutionBucket(f.probe?.resolution);
const effectiveCodec = (f: UnitFile): string | null => codecFamily(f.parsed.tags.videoCodec) ?? codecFamily(f.probe?.videoCodec);
const effectiveHdr = (f: UnitFile): string | null => (f.parsed.tags.hdr ? hdrKey(f.parsed.tags.hdr) : hdrKey(f.probe?.hdr));
const effectiveAudio = (f: UnitFile): string | null => audioKey(f.parsed.tags.audio) ?? audioKey(f.probe?.audio);

export interface UnitMediaOptions {
  /** 不算在内的视频：花絮 / 样片、取消勾选的（run-state.ts 的 mediaSkipOf） */
  skip?: (f: UnitFile) => boolean;
  /** 模板用到的可探测标签（probeVarsOf）：算 lacking 用；不给就当模板没用到 */
  wanted?: ReadonlyArray<keyof MediaProbeTags>;
}

/** 作品单元的汇总：分辨率按档、编码按家族、音频按统一写法归一（x265 和 HEVC、EAC3 和 DDP 不算两种）；没有正片就没有 */
export function unitMedia(unit: Pick<Unit, "files">, opts: UnitMediaOptions = {}): OrganizeUnitMedia | undefined {
  const videos = unit.files.filter((f) => f.kind === "video" && !opts.skip?.(f));
  if (videos.length === 0) return undefined;
  const wanted = opts.wanted ?? [];
  return {
    videos: videos.length,
    probed: videos.filter((f) => f.media).length,
    lacking: wanted.length === 0 ? 0 : videos.filter((f) => lacksProbeTags(f, wanted)).length,
    resolution: tally(videos.map(effectiveResolution)),
    videoCodec: tally(videos.map(effectiveCodec)),
    bitDepth: tally(videos.map((f) => (f.media?.bitDepth && f.media.bitDepth > 8 ? `${f.media.bitDepth}bit` : undefined))),
    hdr: tally(videos.map(effectiveHdr)),
    audio: tally(videos.map(effectiveAudio)),
    conflicts: videos.filter((f) => mediaConflicts(f.parsed.tags, f.media).length > 0).length,
  };
}
