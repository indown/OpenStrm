/**
 * 文件名标签 vs 实测的冲突判定、作品单元的媒体信息汇总。
 *   pnpm test:file src/services/organize/media-info.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediaBrief, MediaProbeTags } from "@openstrm/shared";
import { audioKey, codecFamily, lacksProbeTags, mediaConflicts, probeVarsOf, resolutionBucket, unitMedia } from "./media-info.js";
import { parseMediaName } from "./parse-name.js";
import { asExtraFile, type UnitFile } from "./units.js";

const brief = (extra: Partial<MediaBrief> = {}): MediaBrief => ({ audioCount: 1, subtitleLanguages: [], source: "probe", ...extra });
const file = (name: string, media?: MediaBrief, extra: Partial<UnitFile> = {}): UnitFile => ({
  path: name,
  name,
  stem: name.replace(/\.[^.]+$/, ""),
  ext: name.slice(name.lastIndexOf(".")).toLowerCase(),
  kind: "video",
  parsed: parseMediaName(name),
  inExtrasDir: false,
  media,
  ...extra,
});
const tagsOf = (name: string) => parseMediaName(name).tags;

test("编码家族、分辨率档、音频写法的归一", () => {
  assert.deepEqual(["x265", "H.265", "HEVC", "x264", "AVC", "H.264", "AV1", "10bit", "Hi10P", undefined, "MPEG-2"].map(codecFamily), ["HEVC", "HEVC", "HEVC", "H.264", "H.264", "H.264", "AV1", null, null, null, "MPEG-2"]);
  assert.deepEqual(["4K", "2160p", "8K", "1080i", "1080p", "720p", "UHD", undefined].map(resolutionBucket), ["2160p", "2160p", "4320p", "1080p", "1080p", "720p", null, null]);
  // 文件名按出现顺序、实测按固定顺序，归一后是一种写法；EAC3 / DD+ 就是 DDP，DD 是 AC3，DTS-HD MA 和实测的 DTS-HD 一家
  assert.deepEqual(
    ["EAC3 5.1 Atmos", "DDP 5.1 Atmos", "DD+ 5.1", "TrueHD Atmos 7.1", "TrueHD 7.1 Atmos", "DTS-HD MA 5.1", "DTS-HD 5.1", "DD 5.1", "AC3 5.1", "Atmos", "AAC", "", undefined].map(audioKey),
    ["DDP 5.1 Atmos", "DDP 5.1 Atmos", "DDP 5.1", "TrueHD 7.1 Atmos", "TrueHD 7.1 Atmos", "DTS-HD 5.1", "DTS-HD 5.1", "AC3 5.1", "AC3 5.1", "Atmos", "AAC", null, null],
  );
  // 文件名里几条音轨一起写的：编码按顺序去重，声道和 Atmos 放后面
  assert.equal(audioKey("DTS-HD MA TrueHD 7.1 Atmos"), "DTS-HD TrueHD 7.1 Atmos");
});

test("花絮的口径：人改判的听人的，否则看花絮目录和名字；探测要哪些标签按模板变量", () => {
  const plain = parseMediaName("Movie.2024.1080p.mkv");
  const trailer = parseMediaName("Movie.2024.Trailer.1080p.mkv");
  assert.equal(asExtraFile({ inExtrasDir: false, parsed: plain }), false);
  assert.equal(asExtraFile({ inExtrasDir: true, parsed: plain }), true);
  assert.equal(asExtraFile({ inExtrasDir: false, parsed: trailer }), true);
  assert.equal(asExtraFile({ inExtrasDir: false, parsed: trailer }, "video"), false, "人说是正片就是正片");
  assert.equal(asExtraFile({ inExtrasDir: false, parsed: plain }, "extra"), true, "人说是花絮就是花絮");
  assert.deepEqual(probeVarsOf({ templates: { movie: "{title} ({year})[ - {resolution}].{ext}", tv: "{title}/S{season:2}E{episode:2}[.{audio:.}].{ext}" } }), ["resolution", "audio"]);
  assert.deepEqual(probeVarsOf({ templates: { movie: "{title}.{ext}", tv: "{title}.{ext}" } }), []);
  const f = { parsed: parseMediaName("Movie.2024.1080p.mkv"), probe: { audio: "AAC 2.0" } } as UnitFile;
  assert.equal(lacksProbeTags(f, ["resolution", "audio"]), false, "分辨率在文件名里、音频在探测结果里");
  assert.equal(lacksProbeTags(f, ["videoCodec"]), true);
});

test("冲突：分辨率按档、编码按家族、HDR 只在说有实测无 / 说 DV 实测不是 DV / 说 SDR 实测有 时算", () => {
  const scene = tagsOf("Dune.Part.Two.2024.2160p.WEB-DL.x265.DV.DDP5.1.Atmos-FLUX.mkv");
  assert.deepEqual(mediaConflicts(scene, brief({ resolution: "1080p", videoCodec: "H.264" })), [
    { kind: "resolution", named: "2160p", probed: "1080p" },
    { kind: "videoCodec", named: "x265", probed: "H.264" },
    { kind: "hdr", named: "DV", probed: "SDR" },
  ]);
  assert.deepEqual(mediaConflicts(scene, brief({ resolution: "2160p", videoCodec: "HEVC", hdr: "DV" })), []);
  assert.deepEqual(mediaConflicts(scene, brief({ resolution: "2160p", videoCodec: "HEVC", hdr: "HDR10" })), [{ kind: "hdr", named: "DV", probed: "HDR10" }]);
  // 实测只知道是 HDR（Emby 回填的常常只有 VideoRange）：分不出是不是 DV，不算冲突
  assert.deepEqual(mediaConflicts(scene, brief({ resolution: "2160p", videoCodec: "HEVC", hdr: "HDR" })), []);
  // 文件名只写 HDR：实测 DV 也算对（DV 几乎都带 HDR10 兼容层）；实测 SDR 才是冲突
  const hdr = tagsOf("Movie.2024.2160p.HDR.x265.mkv");
  assert.deepEqual(mediaConflicts(hdr, brief({ resolution: "2160p", videoCodec: "HEVC", hdr: "DV" })), []);
  assert.deepEqual(mediaConflicts(hdr, brief({ resolution: "2160p", videoCodec: "HEVC" })), [{ kind: "hdr", named: "HDR", probed: "SDR" }]);
  // 文件名写 SDR
  const sdr = tagsOf("Movie.2024.1080p.SDR.x264.mkv");
  assert.deepEqual(mediaConflicts(sdr, brief({ resolution: "1080p", videoCodec: "H.264", hdr: "HDR10" })), [{ kind: "hdr", named: "SDR", probed: "HDR10" }]);
  assert.deepEqual(mediaConflicts(sdr, brief({ resolution: "1080p", videoCodec: "H.264" })), []);
  // 4K 和 2160p 是同一档；1080p.UHD.BluRay 的 UHD 是片源不是分辨率
  assert.deepEqual(mediaConflicts(tagsOf("Movie.2024.4K.HEVC.mkv"), brief({ resolution: "2160p", videoCodec: "HEVC" })), []);
  assert.deepEqual(mediaConflicts(tagsOf("Movie.2024.1080p.UHD.BluRay.x264.mkv"), brief({ resolution: "1080p", videoCodec: "H.264" })), []);
  // 10bit 不是编码；音频不比；两边缺一边不比；没有实测就没有冲突
  assert.deepEqual(mediaConflicts(tagsOf("Movie.2024.1080p.10bit.mkv"), brief({ resolution: "1080p", videoCodec: "HEVC" })), []);
  assert.deepEqual(mediaConflicts(tagsOf("Movie.2024.1080p.DTS-HD.MA.mkv"), brief({ resolution: "1080p", audioCodec: "AAC" })), []);
  assert.deepEqual(mediaConflicts(tagsOf("Movie.2024.mkv"), brief({ resolution: "1080p", videoCodec: "H.264", hdr: "HDR10" })), []);
  assert.deepEqual(mediaConflicts(scene, undefined), []);
});

test("单元汇总：按模板口径（文件名优先、探测兜底）统计分布，位深只有实测值，冲突按文件计数；没视频就没有", () => {
  const probe: MediaProbeTags = { resolution: "2160p", videoCodec: "HEVC", audio: "DDP 5.1 Atmos", hdr: "DV" };
  const measured = brief({ resolution: "2160p", videoCodec: "HEVC", bitDepth: 10, hdr: "DV", audioCodec: "DDP", channels: "5.1", atmos: true });
  const files = [
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => file(`Show.S01E0${n}.2160p.WEB-DL.x265.DV.DDP5.1.Atmos.mkv`, n <= 2 ? measured : undefined, n <= 2 ? { probe } : {})),
    ...[8, 9].map((n) => file(`Show.S01E0${n}.1080p.WEB-DL.H.264.DDP5.1.mkv`)),
    // 文件名没写标签、只有探测结果：按探测的算
    file("Show.S01E10.mkv", measured, { probe }),
    // 文件名写 1080p、实测 2160p：分布按文件名，冲突计 1
    file("Show.S01E11.1080p.x264.mkv", measured, { probe }),
    file("Show.S01E01.chs.srt", undefined, { kind: "subtitle" }),
  ];
  assert.deepEqual(unitMedia({ files }), {
    videos: 11,
    probed: 4,
    lacking: 0,
    resolution: [
      { value: "2160p", count: 8 },
      { value: "1080p", count: 3 },
    ],
    videoCodec: [
      { value: "HEVC", count: 8 },
      { value: "H.264", count: 3 },
    ],
    bitDepth: [{ value: "10bit", count: 4 }],
    // E11 的文件名没写 HDR / 音频，这两项按探测的算，所以是 9 不是 8
    hdr: [{ value: "DV", count: 9 }],
    audio: [
      { value: "DDP 5.1 Atmos", count: 9 },
      { value: "DDP 5.1", count: 2 },
    ],
    conflicts: 1,
  });
  assert.equal(unitMedia({ files: [file("poster.jpg", undefined, { kind: "image" })] }), undefined);
});

test("单元汇总：文件名标签归一后为空的（10bit 占了编码、UHD 占了分辨率）退到实测；写 SDR 的不进 hdr；音频按统一写法合并", () => {
  const probe: MediaProbeTags = { resolution: "2160p", videoCodec: "HEVC", audio: "TrueHD 7.1 Atmos", hdr: "HDR10" };
  const measured = brief({ resolution: "2160p", videoCodec: "HEVC", hdr: "HDR10", audioCodec: "TrueHD", channels: "7.1", atmos: true });
  const files = [
    // 文件名的编码位写的是 10bit：编码按实测的 HEVC；分辨率文件名写了 1080p 就是 1080p（冲突另算）
    file("Show.S01E01.1080p.10bit.x265.FLAC.2.0.mkv", measured, { probe }),
    // UHD 是片源不是分辨率：分辨率按实测；音频 TrueHD Atmos 7.1 和实测的 TrueHD 7.1 Atmos 是同一种
    file("Movie.2024.UHD.BluRay.TrueHD.Atmos.7.1.mkv", measured, { probe }),
    // 写了 SDR：hdr 里不出现（也不退到实测），EAC3 归 DDP
    file("Movie.2024.1080p.SDR.x264.EAC3.5.1.mkv"),
    file("Movie.2024.1080p.DDP5.1.mkv"),
  ];
  const m = unitMedia({ files })!;
  assert.deepEqual(m.resolution, [
    { value: "1080p", count: 3 },
    { value: "2160p", count: 1 },
  ]);
  assert.deepEqual(m.videoCodec, [
    { value: "HEVC", count: 2 },
    { value: "H.264", count: 1 },
  ]);
  assert.deepEqual(m.hdr, [{ value: "HDR10", count: 2 }]);
  assert.deepEqual(m.audio, [
    { value: "DDP 5.1", count: 2 },
    { value: "FLAC 2.0", count: 1 },
    { value: "TrueHD 7.1 Atmos", count: 1 },
  ]);
  assert.equal(m.conflicts, 1, "S01E01 文件名写 1080p、实测 2160p");
});

test("单元汇总：skip 掉的文件（花絮 / 样片 / 取消勾选）不算；lacking 数模板要的标签文件名和实测都没有的", () => {
  const probe: MediaProbeTags = { resolution: "2160p", videoCodec: "HEVC", audio: "DDP 5.1" };
  const files = [
    file("Dune.Part.Two.2024.2160p.UHD.BluRay.DV.x265-FLUX.mkv"),
    file("Dune.Part.Two.2024.Trailer.1080p.x264.mkv"),
    file("Extras/Making.Of.1080p.x264.mkv", undefined, { inExtrasDir: true }),
    file("Show.S01E01.mkv", brief({ resolution: "2160p", videoCodec: "HEVC", audioCodec: "DDP", channels: "5.1" }), { probe }),
    file("Show.S01E02.mkv"),
  ];
  const skip = (f: UnitFile) => asExtraFile(f) || f.path === "Show.S01E02.mkv";
  const m = unitMedia({ files }, { skip, wanted: ["resolution", "videoCodec", "audio"] })!;
  assert.deepEqual([m.videos, m.probed, m.lacking], [2, 1, 1], "两部正片；S01E01 探过了；正片 Dune 文件名没写音频、也没探过");
  assert.deepEqual(m.resolution, [{ value: "2160p", count: 2 }]);
  assert.deepEqual(m.videoCodec, [{ value: "HEVC", count: 2 }]);
  assert.deepEqual(m.audio, [{ value: "DDP 5.1", count: 1 }]);
  assert.equal(unitMedia({ files }, { skip: () => true }), undefined, "全 skip 掉就没有汇总");
  // 没给 wanted（模板没用到可探测的标签）：lacking 是 0，头部那枚按钮没有可探的
  assert.equal(unitMedia({ files }, { skip })!.lacking, 0);
});
