/**
 * 媒体旗标：探测结果 / 文件名标签 / 搜索标题标签统一成一排小旗（components/media-flags.tsx 画）。
 * 分家上色：画面（分辨率 / 编码 / 位深）、HDR、声音、字幕、片源；别的（季集 / 体积 / 完结）不上色。
 * 显示口径：2160p 写成 4K，HEVC / H.265 / x265 归成 HEVC，EAC3 / DD+ 归成 DDP。
 * 这里只有纯函数，方便单测；方案见 .claude/plans/media-flags.md
 */
import type { MediaBrief, MediaConflict, MediaValueCount, OrganizeUnitMedia } from "@openstrm/shared";

export type FlagFamily = "video" | "hdr" | "audio" | "subs" | "source" | "plain" | "warn";

export interface MediaFlag {
  label: string;
  family: FlagFamily;
  /** 悬停全文 */
  title?: string;
  /** 正在按它筛（搜索页） */
  active?: boolean;
}

export const displayResolution = (v: string): string => (/^2160p$/i.test(v) ? "4K" : /^4320p$/i.test(v) ? "8K" : v);

/** 视频编码写法归一（显示用）；认不出的原样 */
export function displayCodec(v: string): string {
  const c = v.toLowerCase().replace(/[\s.-]/g, "");
  if (c === "x265" || c === "h265" || c === "hevc") return "HEVC";
  if (c === "x264" || c === "h264" || c === "avc") return "H.264";
  return v;
}

/** 音频编码写法归一（显示用） */
export function displayAudioCodec(v: string): string {
  const c = v.toLowerCase().replace(/[\s.-]/g, "");
  if (c === "eac3" || c === "dd+" || c === "ddp") return "DDP";
  return v;
}

const LANG_LABEL: Record<string, string> = { zh: "中", chi: "中", zho: "中", en: "英", eng: "英", ja: "日", jpn: "日", ko: "韩", kor: "韩", fr: "法", fra: "法", fre: "法", de: "德", ger: "德", deu: "德", es: "西", spa: "西", it: "意", ita: "意", ru: "俄", rus: "俄", pt: "葡", por: "葡", th: "泰", tha: "泰", vi: "越", vie: "越", ar: "阿", ara: "阿", hi: "印地", hin: "印地" };

/** 语言代码 → 一个字（zh-Hans-CN 也按 zh）；认不出的原样 */
export const langLabel = (code: string): string => LANG_LABEL[code.toLowerCase().split(/[-_]/)[0]] ?? code;

/** 字幕语言一枚旗：zh-Hans / zh-Hant 都是「中」，按显示名再去一次重；超过三种折成 +N */
export const subtitleLabel = (langs: readonly string[]): string => {
  const labels = [...new Set(langs.map(langLabel))];
  return labels.length <= 3 ? labels.join(" / ") : `${labels.slice(0, 3).join(" / ")} +${labels.length - 3}`;
};

const HDR_TITLE: Record<string, string> = { DV: "Dolby Vision（多半带 HDR10 兼容层）", "HDR10+": "HDR10+", HDR10: "HDR10", HLG: "HLG", HDR: "HDR（PQ 曲线，没有静态元数据）" };

/** 把 `DDP 5.1 Atmos` / `DTS-HD MA TrueHD 7.1 Atmos` 这种音频标签拆成旗标：Atmos 单独一枚 */
export function audioFlags(audio: string): MediaFlag[] {
  const words = audio.split(/\s+/).filter(Boolean);
  const atmos = words.some((w) => /^atmos$/i.test(w));
  const rest = words
    .filter((w) => !/^atmos$/i.test(w))
    .map(displayAudioCodec)
    .join(" ");
  const out: MediaFlag[] = [];
  if (rest) out.push({ label: rest, family: "audio" });
  if (atmos) out.push({ label: "Atmos", family: "audio" });
  return out;
}

export const conflictLabel = (c: MediaConflict): string => `文件名写 ${c.named} · 实测 ${c.probed}`;

/** 文件表那行：实测信息 + 冲突 */
export function flagsFromBrief(media: MediaBrief | undefined, conflicts: readonly MediaConflict[] = []): MediaFlag[] {
  if (!media) return [];
  const out: MediaFlag[] = [];
  if (media.resolution) out.push({ label: displayResolution(media.resolution), family: "video", title: media.width && media.height ? `${media.width}×${media.height}` : media.resolution });
  if (media.videoCodec) out.push({ label: displayCodec(media.videoCodec), family: "video" });
  if (media.bitDepth && media.bitDepth > 8) out.push({ label: `${media.bitDepth}bit`, family: "video" });
  if (media.hdr) out.push({ label: media.hdr, family: "hdr", title: HDR_TITLE[media.hdr] });
  if (media.audioCodec) out.push({ label: [displayAudioCodec(media.audioCodec), media.channels].filter(Boolean).join(" "), family: "audio" });
  if (media.atmos) out.push({ label: "Atmos", family: "audio" });
  if (media.audioLanguage) out.push({ label: langLabel(media.audioLanguage), family: "audio", title: `主音轨语言 ${media.audioLanguage}` });
  if (media.subtitleLanguages.length > 0) out.push({ label: subtitleLabel(media.subtitleLanguages), family: "subs", title: `字幕 ${media.subtitleLanguages.join(" / ")}` });
  for (const c of conflicts) out.push({ label: conflictLabel(c), family: "warn" });
  return out;
}

const durationLabel = (ms: number): string => {
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${min} 分`;
};

/** 文件表那行的悬停全文：来源、宽高、帧率、码率、时长、容器、音轨数、字幕、截断 */
export function briefTitle(media: MediaBrief): string {
  const parts = [media.source === "emby" ? "Emby 分析回填" : "读文件头探测"];
  if (media.width && media.height) parts.push(`${media.width}×${media.height}`);
  if (media.frameRate) parts.push(`${Number(media.frameRate.toFixed(3))} fps`);
  if (media.bitrateKbps) parts.push(media.bitrateKbps >= 1000 ? `${(media.bitrateKbps / 1000).toFixed(1)} Mbps` : `${media.bitrateKbps} kbps`);
  if (media.durationMs) parts.push(durationLabel(media.durationMs));
  if (media.container) parts.push(media.container);
  if (media.audioCount > 1) parts.push(`${media.audioCount} 条音轨`);
  if (media.subtitleLanguages.length > 0) parts.push(`字幕 ${media.subtitleLanguages.join(" / ")}`);
  if (media.truncated) parts.push("只读了文件头的一部分，时长 / 靠后的字幕可能缺");
  return parts.join(" · ");
}

/** strm 详情面板的「媒体信息」块：一行一项，和 briefTitle 同一份数据 */
export function briefDetails(media: MediaBrief): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [{ label: "来源", value: media.source === "emby" ? "Emby 分析回填" : "读文件头探测" }];
  const picture = [
    media.width && media.height ? `${media.width}×${media.height}` : "",
    media.videoCodec ? displayCodec(media.videoCodec) : "",
    media.bitDepth && media.bitDepth > 8 ? `${media.bitDepth}bit` : "",
    media.hdr ?? "",
    media.frameRate ? `${Number(media.frameRate.toFixed(3))} fps` : "",
  ].filter(Boolean);
  if (picture.length > 0) out.push({ label: "画面", value: picture.join(" · ") });
  if (media.bitrateKbps) out.push({ label: "视频码率", value: media.bitrateKbps >= 1000 ? `${(media.bitrateKbps / 1000).toFixed(1)} Mbps` : `${media.bitrateKbps} kbps` });
  if (media.durationMs) out.push({ label: "时长", value: durationLabel(media.durationMs) });
  if (media.container) out.push({ label: "容器", value: media.container });
  if (media.audioCount > 0) {
    const main = [media.audioCodec ? displayAudioCodec(media.audioCodec) : "", media.channels ?? "", media.atmos ? "Atmos" : "", media.audioLanguage ?? ""].filter(Boolean).join(" ");
    out.push({ label: "音轨", value: `${media.audioCount} 条${main ? `，主音轨 ${main}` : ""}` });
  }
  if (media.subtitleLanguages.length > 0) out.push({ label: "字幕", value: media.subtitleLanguages.join(" / ") });
  if (media.truncated) out.push({ label: "备注", value: "只读了文件头的一部分，时长 / 靠后的字幕可能缺" });
  return out;
}

/** 海报角标：最多两枚，4K 一枚、HDR 一枚（杜比视界优先）；1080p 这种基线不画，画了满墙都是 */
export function posterMarks(tags: readonly string[] | undefined): MediaFlag[] {
  if (!tags || tags.length === 0) return [];
  const out: MediaFlag[] = [];
  if (tags.includes("4K")) out.push({ label: "4K", family: "video" });
  if (tags.includes("杜比视界")) out.push({ label: "DV", family: "hdr", title: "杜比视界" });
  else if (tags.includes("HDR")) out.push({ label: "HDR", family: "hdr" });
  return out;
}

/** 作品卡片那行：某项只有一种取值且全部视频都有就一枚，不然每种一枚带 ×N；音频只在一种取值且齐全时才拆出 Atmos */
export function flagsFromUnitMedia(media: OrganizeUnitMedia | undefined): MediaFlag[] {
  if (!media) return [];
  const full = (list: MediaValueCount[]) => list.length === 1 && list[0].count === media.videos;
  const spread = (list: MediaValueCount[], family: FlagFamily, label: (v: string) => string = (v) => v, title?: (v: string) => string | undefined): MediaFlag[] =>
    list.map((e) => ({ label: full(list) ? label(e.value) : `${label(e.value)} ×${e.count}`, family, ...(title?.(e.value) ? { title: title(e.value) } : {}) }));
  const audio = full(media.audio)
    ? audioFlags(media.audio[0].value)
    : media.audio.map((e) => ({ label: `${e.value.split(/\s+/).map(displayAudioCodec).join(" ")} ×${e.count}`, family: "audio" as const }));
  return [
    ...spread(media.resolution, "video", displayResolution),
    ...spread(media.videoCodec, "video", displayCodec),
    ...spread(media.bitDepth, "video"),
    ...spread(media.hdr, "hdr", (v) => v, (v) => HDR_TITLE[v]),
    ...audio,
    ...(media.conflicts > 0 ? [{ label: `${media.conflicts} 个文件名和实测对不上`, family: "warn" as const }] : []),
  ];
}

/** 作品卡片那行的悬停：多少个视频有实测信息 */
export function unitMediaTitle(media: OrganizeUnitMedia): string {
  if (media.probed === 0) return `${media.videos} 个视频都还没探测编码，标签按文件名`;
  if (media.probed === media.videos) return `${media.videos} 个视频都读过文件头或由 Emby 回填；文件名写了的标签以文件名为准`;
  return `${media.videos} 个视频里 ${media.probed} 个读过文件头或由 Emby 回填，其余按文件名`;
}

const RES_TAGS = new Set(["4K", "1080p", "720p"]);
const SOURCE_TAGS = new Set(["原盘", "REMUX", "WEB", "蓝光", "枪版"]);

/** 搜索结果 / 收藏夹的标题标签（services/pansou/tags.ts 认出来的词）分家；季集 / 完结 / 合集 / 体积不上色 */
export function flagsFromTags(tags: readonly string[], active: ReadonlySet<string> = new Set()): MediaFlag[] {
  return tags.map((t) => {
    const family: FlagFamily = RES_TAGS.has(t)
      ? "video"
      : t === "HDR" || t === "杜比视界"
        ? "hdr"
        : t === "全景声" || t === "国语" || t === "粤语"
          ? "audio"
          : t === "中字"
            ? "subs"
            : SOURCE_TAGS.has(t)
              ? "source"
              : "plain";
    return { label: t, family, ...(active.has(t) ? { active: true } : {}) };
  });
}

/** HDHive 资源条目：分辨率 / 片源 / 字幕语言 / 字幕类型四组数组 */
export function flagsFromHdhive(res: { video_resolution?: string[] | null; source?: string[] | null; subtitle_language?: string[] | null; subtitle_type?: string[] | null }): MediaFlag[] {
  return [
    ...(res.video_resolution ?? []).map((r) => ({ label: displayResolution(r), family: "video" as const })),
    ...(res.source ?? []).map((s) => ({ label: s, family: "source" as const })),
    ...(res.subtitle_language ?? []).map((l) => ({ label: `字幕 ${l}`, family: "subs" as const })),
    ...(res.subtitle_type ?? []).map((t) => ({ label: t, family: "subs" as const })),
  ];
}
