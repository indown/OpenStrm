/**
 *   pnpm --filter @openstrm/frontend test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediaBrief, OrganizeUnitMedia } from "@openstrm/shared";
import { audioFlags, briefDetails, briefTitle, displayResolution, flagsFromBrief, flagsFromHdhive, flagsFromTags, flagsFromUnitMedia, langLabel, posterMarks, subtitleLabel, unitMediaTitle } from "./media-flags";

const brief = (extra: Partial<MediaBrief> = {}): MediaBrief => ({ audioCount: 1, subtitleLanguages: [], source: "probe", ...extra });
const unit = (extra: Partial<OrganizeUnitMedia> = {}): OrganizeUnitMedia => ({ videos: 1, probed: 1, lacking: 0, resolution: [], videoCodec: [], bitDepth: [], hdr: [], audio: [], conflicts: 0, ...extra });

test("显示口径：2160p 写成 4K，语言代码一个字，字幕超过三种折成 +N", () => {
  assert.deepEqual(["2160p", "4320p", "1080p"].map(displayResolution), ["4K", "8K", "1080p"]);
  assert.deepEqual(["zh", "zh-Hans-CN", "eng", "xx"].map(langLabel), ["中", "中", "英", "xx"]);
  assert.equal(subtitleLabel(["zh", "en"]), "中 / 英");
  assert.equal(subtitleLabel(["zh-Hans-CN", "zh-Hant-TW", "en"]), "中 / 英", "简繁都是中，按显示名去重");
  assert.equal(subtitleLabel(["zh", "en", "ja", "ko", "fr"]), "中 / 英 / 日 +2");
});

test("音频标签拆旗：Atmos 单独一枚；写法已经是后端归一过的，这里不再改", () => {
  assert.deepEqual(audioFlags("DDP 5.1 Atmos"), [
    { label: "DDP 5.1", family: "audio" },
    { label: "Atmos", family: "audio" },
  ]);
  assert.deepEqual(audioFlags("DTS-HD TrueHD 7.1 Atmos"), [
    { label: "DTS-HD TrueHD 7.1", family: "audio" },
    { label: "Atmos", family: "audio" },
  ]);
  assert.deepEqual(audioFlags("Atmos"), [{ label: "Atmos", family: "audio" }]);
});

test("文件表：实测信息按画面 / HDR / 声音 / 字幕出旗，冲突是 warn；没有实测就没有旗", () => {
  const media = brief({ resolution: "2160p", width: 3840, height: 2160, videoCodec: "HEVC", bitDepth: 10, hdr: "DV", audioCodec: "TrueHD", channels: "7.1", atmos: true, audioLanguage: "en", audioCount: 4, subtitleLanguages: ["zh", "en"] });
  assert.deepEqual(
    flagsFromBrief(media, [{ kind: "resolution", named: "1080p", probed: "2160p" }]).map((f) => [f.label, f.family]),
    [
      ["4K", "video"],
      ["HEVC", "video"],
      ["10bit", "video"],
      ["DV", "hdr"],
      ["TrueHD 7.1", "audio"],
      ["Atmos", "audio"],
      ["英", "audio"],
      ["中 / 英", "subs"],
      ["文件名写 1080p · 实测 2160p", "warn"],
    ],
  );
  assert.equal(flagsFromBrief(media)[0].title, "3840×2160");
  assert.deepEqual(flagsFromBrief(undefined), []);
  // 8bit 不出旗，主音轨没有声道数也站得住
  assert.deepEqual(flagsFromBrief(brief({ videoCodec: "H.264", bitDepth: 8, audioCodec: "AAC" })).map((f) => f.label), ["H.264", "AAC"]);
});

test("悬停全文：和详情面板同一份数据，一行一项（画面里带编码 / 位深 / HDR，音轨里带主音轨）", () => {
  const media = brief({ width: 3840, height: 2160, videoCodec: "HEVC", bitDepth: 10, hdr: "DV", frameRate: 23.976, bitrateKbps: 78000, durationMs: 6720000, container: "Matroska", audioCodec: "TrueHD", channels: "7.1", atmos: true, audioLanguage: "en", audioCount: 4, subtitleLanguages: ["zh", "en"], truncated: true });
  assert.equal(
    briefTitle(media),
    ["来源：读文件头探测", "画面：3840×2160 · HEVC · 10bit · DV · 23.976 fps", "视频码率：78.0 Mbps", "时长：1 小时 52 分", "容器：Matroska", "音轨：4 条，主音轨 TrueHD 7.1 Atmos en", "字幕：zh / en", "备注：只读了文件头的一部分，时长 / 靠后的字幕可能缺"].join("\n"),
  );
  assert.equal(briefTitle(brief({ source: "emby", bitrateKbps: 640, durationMs: 42 * 60000 })), "来源：Emby 分析回填\n视频码率：640 kbps\n时长：42 分\n音轨：1 条");
});

test("作品卡片：只有一种取值且全部视频都有就一枚，不然每种带 ×N；音频只在齐全时拆 Atmos；冲突计数一枚 warn", () => {
  const same = unit({ videos: 10, probed: 10, resolution: [{ value: "2160p", count: 10 }], videoCodec: [{ value: "HEVC", count: 10 }], bitDepth: [{ value: "10bit", count: 10 }], hdr: [{ value: "DV", count: 10 }], audio: [{ value: "DDP 5.1 Atmos", count: 10 }] });
  assert.deepEqual(flagsFromUnitMedia(same).map((f) => f.label), ["4K", "HEVC", "10bit", "DV", "DDP 5.1", "Atmos"]);
  const mixed = unit({
    videos: 10,
    probed: 4,
    resolution: [
      { value: "2160p", count: 7 },
      { value: "1080p", count: 3 },
    ],
    videoCodec: [{ value: "HEVC", count: 7 }],
    bitDepth: [{ value: "10bit", count: 4 }],
    audio: [
      { value: "DDP 5.1 Atmos", count: 7 },
      { value: "AAC 2.0", count: 3 },
    ],
    conflicts: 2,
  });
  assert.deepEqual(flagsFromUnitMedia(mixed).map((f) => [f.label, f.family]), [
    ["4K ×7", "video"],
    ["1080p ×3", "video"],
    ["HEVC ×7", "video"],
    ["10bit ×4", "video"],
    ["DDP 5.1 Atmos ×7", "audio"],
    ["AAC 2.0 ×3", "audio"],
    ["2 个文件名和实测对不上", "warn"],
  ]);
  assert.deepEqual(flagsFromUnitMedia(undefined), []);
  assert.equal(unitMediaTitle(unit({ videos: 3, probed: 0 })), "3 个视频都还没探测编码，标签按文件名");
  assert.equal(unitMediaTitle(unit({ videos: 3, probed: 3 })), "3 个视频都读过文件头或由 Emby 回填；文件名写了的标签以文件名为准");
  assert.equal(unitMediaTitle(unit({ videos: 10, probed: 4 })), "10 个视频里 4 个读过文件头或由 Emby 回填，其余按文件名");
});

test("搜索 / 收藏夹的标题标签分家：分辨率画面、HDR 和杜比视界一家、全景声和国语声音、中字字幕、片源一家，季集体积不上色；正在筛的标 active", () => {
  const flags = flagsFromTags(["4K", "杜比视界", "HDR", "全景声", "国语", "中字", "REMUX", "第 1-3 季", "全 24 集", "1.6G"], new Set(["4K"]));
  assert.deepEqual(flags.map((f) => f.family), ["video", "hdr", "hdr", "audio", "audio", "subs", "source", "plain", "plain", "plain"]);
  assert.deepEqual(flags.map((f) => f.active ?? false), [true, false, false, false, false, false, false, false, false, false]);
  assert.deepEqual(flags.map((f) => f.label), ["4K", "杜比视界", "HDR", "全景声", "国语", "中字", "REMUX", "第 1-3 季", "全 24 集", "1.6G"]);
});

test("HDHive 条目：分辨率 / 片源 / 字幕语言 / 字幕类型四组，空的也站得住", () => {
  assert.deepEqual(flagsFromHdhive({ video_resolution: ["2160p", "1080p"], source: ["WEB-DL"], subtitle_language: ["中文"], subtitle_type: ["内封"] }).map((f) => [f.label, f.family]), [
    ["4K", "video"],
    ["1080p", "video"],
    ["WEB-DL", "source"],
    ["字幕 中文", "subs"],
    ["内封", "subs"],
  ]);
  assert.deepEqual(flagsFromHdhive({}), []);
});

test("strm 详情面板的媒体信息块：一行一项，没有的项不出现", () => {
  const media = brief({ width: 3840, height: 2160, videoCodec: "HEVC", bitDepth: 10, hdr: "DV", frameRate: 23.976, bitrateKbps: 24000, durationMs: 9980000, container: "Matroska", audioCodec: "DDP", channels: "5.1", atmos: true, audioLanguage: "en", audioCount: 3, subtitleLanguages: ["zh", "en"], truncated: true });
  assert.deepEqual(briefDetails(media), [
    { label: "来源", value: "读文件头探测" },
    { label: "画面", value: "3840×2160 · HEVC · 10bit · DV · 23.976 fps" },
    { label: "视频码率", value: "24.0 Mbps" },
    { label: "时长", value: "2 小时 46 分" },
    { label: "容器", value: "Matroska" },
    { label: "音轨", value: "3 条，主音轨 DDP 5.1 Atmos en" },
    { label: "字幕", value: "zh / en" },
    { label: "备注", value: "只读了文件头的一部分，时长 / 靠后的字幕可能缺" },
  ]);
  assert.deepEqual(briefDetails(brief({ source: "emby", audioCount: 0 })), [{ label: "来源", value: "Emby 分析回填" }]);
});

test("海报角标：4K 一枚、HDR 一枚（杜比视界优先），1080p 不画，最多两枚", () => {
  assert.deepEqual(posterMarks(["4K", "杜比视界", "HDR", "中字"]).map((m) => m.label), ["4K", "DV"]);
  assert.deepEqual(posterMarks(["1080p", "HDR"]).map((m) => m.label), ["HDR"]);
  assert.deepEqual(posterMarks(["1080p", "中字"]), []);
  assert.deepEqual(posterMarks(undefined), []);
});
