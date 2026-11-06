/**
 * 文件名标签 vs 实测的冲突判定、作品单元的媒体信息汇总。
 *   pnpm test:file src/services/organize/media-info.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediaBrief, MediaProbeTags } from "@openstrm/shared";
import { codecFamily, mediaConflicts, resolutionBucket, unitMedia } from "./media-info.js";
import { parseMediaName } from "./parse-name.js";
import type { UnitFile } from "./units.js";

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

test("编码家族和分辨率档的归一", () => {
  assert.deepEqual(["x265", "H.265", "HEVC", "x264", "AVC", "H.264", "AV1", "10bit", "Hi10P", undefined, "MPEG-2"].map(codecFamily), ["HEVC", "HEVC", "HEVC", "H.264", "H.264", "H.264", "AV1", null, null, null, "MPEG-2"]);
  assert.deepEqual(["4K", "2160p", "8K", "1080i", "1080p", "720p", "UHD", undefined].map(resolutionBucket), ["2160p", "2160p", "4320p", "1080p", "1080p", "720p", null, null]);
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
