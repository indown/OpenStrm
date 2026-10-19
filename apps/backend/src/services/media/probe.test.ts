/**
 * mediainfo.js 结果 → 我们的模型 / 模板标签 / 一行摘要的映射。
 *   pnpm test:file src/services/media/probe.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediaInfoResult } from "mediainfo.js";
import { mainAudio, probeFromResult, probeKey, probeSummary, probeTags, resolutionLabel } from "./probe.js";

const result = (tracks: Array<Record<string, unknown>>): MediaInfoResult => ({ media: { "@ref": "", track: tracks } }) as unknown as MediaInfoResult;
const video = (extra: Record<string, unknown>) => ({ "@type": "Video", ...extra });
const audio = (extra: Record<string, unknown>) => ({ "@type": "Audio", ...extra });

test("4K HEVC 杜比视界 + DDP Atmos：编码 / 分辨率 / HDR / 主音轨都认出来，摘要一行", () => {
  const p = probeFromResult(
    result([
      { "@type": "General", Format: "Matroska", Duration: "5400.5" },
      video({ Format: "HEVC", Format_Profile: "Main 10", Width: "3840", Height: "2160", FrameRate: "23.976", BitDepth: "10", BitRate: "25000000", HDR_Format: "Dolby Vision, Version 1.0, dvhe.08.06, BL+RPU, HDR10 compatible", HDR_Format_Compatibility: "HDR10" }),
      audio({ Format: "AAC", Channels: "2", Language: "zh", Title: "国语" }),
      audio({ Format: "E-AC-3", Format_Commercial_IfAny: "Dolby Digital Plus with Dolby Atmos", Format_AdditionalFeatures: "JOC", Channels: "6", Language: "en", Default: "Yes" }),
      { "@type": "Text", Format: "UTF-8", Language: "zh", Forced: "No" },
      { "@type": "Text", Format: "PGS", Language: "en" },
    ]),
    1234,
  )!;
  assert.equal(p.container, "Matroska");
  assert.equal(p.durationMs, 5400500);
  assert.deepEqual(p.video, { codec: "HEVC", profile: "Main 10", width: 3840, height: 2160, frameRate: 23.976, bitDepth: 10, hdr: "DV", bitrateKbps: 25000 });
  assert.equal(p.audio.length, 2);
  assert.equal(mainAudio(p)?.codec, "DDP", "标了默认的那条是主音轨，不是第一条");
  assert.equal(mainAudio(p)?.atmos, true);
  assert.deepEqual(p.subtitles.map((s) => s.language), ["zh", "en"]);
  assert.equal(p.bytesRead, 1234);
  assert.deepEqual(probeTags(p), { resolution: "2160p", videoCodec: "HEVC", audio: "DDP", hdr: "DV" });
  assert.equal(probeSummary(p), "HEVC · 2160p 10bit · DV · DDP Atmos 5.1 en · 2 条音轨 · 字幕 zh/en");
});

test("编码 / HDR / 音频的词表：和文件名里的写法一致", () => {
  const codec = (format: string, codecId?: string) => probeFromResult(result([video({ Format: format, CodecID: codecId })]), 0)!.video!.codec;
  assert.equal(codec("AVC"), "H.264");
  assert.equal(codec("", "V_MPEG4/ISO/AVC"), "H.264");
  assert.equal(codec("", "hvc1"), "HEVC");
  assert.equal(codec("AV1"), "AV1");
  assert.equal(codec("VP9"), "VP9");
  assert.equal(codec("MPEG-4 Visual", "XVID"), "XviD");
  assert.equal(codec("MPEG Video"), "MPEG-2");
  assert.equal(codec("ProRes"), "ProRes", "不认识的照原样");

  const hdr = (extra: Record<string, unknown>) => probeFromResult(result([video({ Format: "HEVC", ...extra })]), 0)!.video!.hdr;
  assert.equal(hdr({ HDR_Format: "SMPTE ST 2094 App 4", HDR_Format_Compatibility: "HDR10+ Profile B, HDR10 compatible" }), "HDR10+");
  assert.equal(hdr({ HDR_Format: "SMPTE ST 2086", HDR_Format_Compatibility: "HDR10" }), "HDR10");
  assert.equal(hdr({ transfer_characteristics: "HLG" }), "HLG");
  assert.equal(hdr({ transfer_characteristics: "PQ" }), "HDR");
  assert.equal(hdr({ transfer_characteristics: "BT.709" }), undefined);

  const aud = (extra: Record<string, unknown>) => probeFromResult(result([video({ Format: "AVC" }), audio(extra)]), 0)!.audio[0].codec;
  assert.equal(aud({ Format: "AC-3" }), "AC3");
  assert.equal(aud({ Format: "E-AC-3" }), "DDP");
  assert.equal(aud({ Format: "MLP FBA", Format_Commercial_IfAny: "Dolby TrueHD with Dolby Atmos" }), "TrueHD");
  assert.equal(aud({ Format: "DTS" }), "DTS");
  assert.equal(aud({ Format: "DTS", Format_Commercial_IfAny: "DTS-HD Master Audio", Format_AdditionalFeatures: "XLL" }), "DTS-HD");
  assert.equal(aud({ Format: "DTS", Format_Commercial_IfAny: "DTS:X", Format_AdditionalFeatures: "XLL X" }), "DTS-X");
  assert.equal(aud({ Format: "FLAC" }), "FLAC");
  assert.equal(aud({ Format: "MPEG Audio" }), "MP3");
  assert.equal(aud({ Format: "Opus" }), "Opus");
});

test("没有视频轨就是 null；没有音轨的标签里没有 audio；高度拿不到按宽度", () => {
  assert.equal(probeFromResult(result([{ "@type": "General", Format: "Matroska" }, audio({ Format: "FLAC" })]), 10), null);
  const p = probeFromResult(result([video({ Format: "AVC", Width: "1920" })]), 0)!;
  assert.deepEqual(probeTags(p), { resolution: "1080p", videoCodec: "H.264" });
  assert.equal(probeSummary(p), "H.264 · 1080p");
});

test("分辨率标签按高度，宽屏 / 竖版按宽度兜底", () => {
  assert.equal(resolutionLabel(3840, 2160), "2160p");
  assert.equal(resolutionLabel(3840, 1600), "2160p", "2.4:1 的 4K 高度只有 1600");
  assert.equal(resolutionLabel(1920, 1080), "1080p");
  assert.equal(resolutionLabel(1920, 800), "1080p");
  assert.equal(resolutionLabel(1280, 720), "720p");
  assert.equal(resolutionLabel(1280, 536), "720p");
  assert.equal(resolutionLabel(720, 576), "576p");
  assert.equal(resolutionLabel(720, 480), "480p");
  assert.equal(resolutionLabel(640, 360), "360p");
  assert.equal(resolutionLabel(1080, 1920), "1080p", "竖版");
  assert.equal(resolutionLabel(undefined, undefined), undefined);
});

test("缓存键：有文件 id 按 id（改名挪动后还认），没有按绝对路径", () => {
  assert.equal(probeKey({ path: "/tv/a.mkv", id: "f123" }), "id:f123");
  assert.equal(probeKey({ path: "/tv/a.mkv" }), "path:/tv/a.mkv");
});
