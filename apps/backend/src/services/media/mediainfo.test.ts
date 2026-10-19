/**
 * mediainfo.js 引擎 + 直链 Range 读取：真 WASM 跑 ffmpeg 生成的小文件（机器上没 ffmpeg 就跳过那几条），
 * 预算 / 超时 / 不支持 Range 的直链用假来源和本地 http 服务验。
 *   pnpm test:file src/services/media/mediainfo.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { __test_resetMediaInfo, __test_setProbeLimits, analyzeSource, openRangeSource, PROBE_LIMITS, ProbeBudgetError, ProbeTimeoutError, type ProbeSource } from "./mediainfo.js";
import { probeFromResult, probeSummary, probeTags } from "./probe.js";

const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].find((p) => fs.existsSync(p));
let dir = "";
let mkv = Buffer.alloc(0);
let mp4 = Buffer.alloc(0);

/** 内存里的来源：记下每次读的位置和长度 */
function bufferSource(buf: Buffer): ProbeSource & { reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  return {
    size: buf.length,
    reads,
    async read(offset, length) {
      reads.push([offset, length]);
      return buf.subarray(offset, Math.min(buf.length, offset + length));
    },
  };
}

before(() => {
  if (!FFMPEG) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "openstrm-probe-"));
  const common = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-ac", "2", "-metadata:s:a:0", "language=eng", "-shortest"];
  execFileSync(FFMPEG, [...common, path.join(dir, "a.mkv")]);
  // mp4 不加 faststart：moov 在尾部，得读两次
  execFileSync(FFMPEG, [...common, path.join(dir, "a.mp4")]);
  mkv = fs.readFileSync(path.join(dir, "a.mkv"));
  mp4 = fs.readFileSync(path.join(dir, "a.mp4"));
});

after(() => {
  __test_setProbeLimits(null);
  __test_resetMediaInfo();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("MKV：读文件头就拿到编码 / 分辨率 / 音轨，读的字节不超过文件大小", { skip: !FFMPEG && "没有 ffmpeg" }, async () => {
  const src = bufferSource(mkv);
  const { result, bytesRead, reads } = await analyzeSource(src);
  const p = probeFromResult(result, bytesRead)!;
  assert.ok(p, "有视频轨");
  assert.equal(p.container, "Matroska");
  assert.equal(p.video?.codec, "H.264");
  assert.deepEqual([p.video?.width, p.video?.height], [1280, 720]);
  assert.equal(p.audio[0]?.codec, "AAC");
  assert.equal(p.audio[0]?.language, "en");
  assert.deepEqual(probeTags(p), { resolution: "720p", videoCodec: "H.264", audio: "AAC" });
  assert.equal(probeSummary(p), "H.264 · 720p · AAC 2.0 en");
  assert.ok(reads >= 1 && bytesRead <= mkv.length, `${reads} 次 ${bytesRead} 字节`);
  assert.equal(src.reads.length, reads);
});

test("MP4 的 moov 在尾部：按块读会跳到文件尾多读几次；读取次数超预算就报错、不给半截结果", { skip: !FFMPEG && "没有 ffmpeg" }, async () => {
  __test_setProbeLimits({ CHUNK_BYTES: 64 * 1024, MAX_READS: 500, MAX_BYTES: 64 * 1024 * 1024 });
  __test_resetMediaInfo();
  try {
    const src = bufferSource(mp4);
    const { result, reads } = await analyzeSource(src);
    assert.ok(reads >= 2, `读了 ${reads} 次`);
    assert.ok(src.reads.some(([offset]) => offset > 0), "跳到了文件尾");
    assert.equal(probeFromResult(result, 0)?.video?.codec, "H.264");

    __test_setProbeLimits({ MAX_READS: 1 });
    await assert.rejects(analyzeSource(bufferSource(mp4)), (err: unknown) => err instanceof ProbeBudgetError && !(err instanceof ProbeTimeoutError) && /上限/.test(err.message));
  } finally {
    __test_setProbeLimits(null);
    __test_resetMediaInfo();
  }
});

test("超时：来源一直不回数据就报超时，实例丢掉重建，下一次照常能用", { skip: !FFMPEG && "没有 ffmpeg" }, async () => {
  __test_setProbeLimits({ TIMEOUT_MS: 200 });
  try {
    const stuck: ProbeSource = { size: 10 * 1024 * 1024, read: () => new Promise(() => undefined) };
    await assert.rejects(analyzeSource(stuck), (err: unknown) => err instanceof ProbeTimeoutError);
    __test_setProbeLimits(null);
    const { result } = await analyzeSource(bufferSource(mkv));
    assert.equal(probeFromResult(result, 0)?.video?.codec, "H.264");
  } finally {
    __test_setProbeLimits(null);
  }
});

test("取消：signal 中止后不再向来源要数据", async () => {
  const ac = new AbortController();
  ac.abort(new Error("stop"));
  const src = bufferSource(Buffer.alloc(1024));
  await assert.rejects(analyzeSource(src, { signal: ac.signal }), /stop/);
  assert.equal(src.reads.length, 0);
});

/** 本地 http：支持 Range 回 206 + Content-Range；ignoreRange 时整个回 200（像不理 Range 的直链） */
function serve(body: Buffer, small: Buffer) {
  const seen: Array<{ range?: string; ua?: string; token?: string }> = [];
  const state = { ignoreRange: false };
  const server = http.createServer((req, res) => {
    seen.push({ range: req.headers.range, ua: req.headers["user-agent"], token: req.headers["x-token"] as string | undefined });
    if (state.ignoreRange) {
      res.writeHead(200, { "content-length": small.length });
      res.end(small);
      return;
    }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    const end = Math.min(m ? Number(m[2]) : body.length - 1, body.length - 1);
    res.writeHead(206, { "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 });
    res.end(body.subarray(start, end + 1));
  });
  return { server, seen, state };
}

test("直链 Range 读取：大小从 Content-Range 拿、第一块留给 offset 0、自定义头带上；不理 Range 的直链小文件能用、往后读就报错", async () => {
  const body = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const small = Buffer.from("hello world, this is a tiny file");
  const { server, seen, state } = serve(body, small);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dl/a.mkv`;
  try {
    const src = await openRangeSource({ url, headers: { "x-token": "t1" } }, undefined, { "User-Agent": "ua-x" });
    assert.equal(src.size, body.length);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { range: `bytes=0-${PROBE_LIMITS.CHUNK_BYTES - 1}`, ua: "ua-x", token: "t1" }, "第一块按引擎的块大小要");
    const head = await src.read(0, 100);
    assert.equal(seen.length, 1, "第一块留着给 offset 0，不再请求");
    assert.deepEqual(Buffer.from(head), body.subarray(0, 100));
    const tail = await src.read(body.length - 10, 10);
    assert.equal(seen[1].range, `bytes=${body.length - 10}-${body.length - 1}`);
    assert.deepEqual(Buffer.from(tail), body.subarray(body.length - 10));

    const known = await openRangeSource({ url }, body.length);
    assert.equal(known.size, body.length);
    assert.equal(seen.length, 2, "大小已知不先读");

    state.ignoreRange = true;
    const whole = await openRangeSource({ url }, undefined);
    assert.equal(whole.size, small.length);
    assert.deepEqual(Buffer.from(await whole.read(0, 5)), small.subarray(0, 5));
    await assert.rejects(whole.read(5, 5), /不支持 Range/);
  } finally {
    server.close();
  }
});

test("端到端：直链 + Range + 引擎", { skip: !FFMPEG && "没有 ffmpeg" }, async () => {
  const { server } = serve(mkv, mkv);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dl/a.mkv`;
  try {
    const src = await openRangeSource({ url }, undefined);
    const { result, bytesRead } = await analyzeSource(src);
    const p = probeFromResult(result, bytesRead)!;
    assert.equal(p.video?.codec, "H.264");
    assert.equal(probeTags(p).resolution, "720p");
  } finally {
    server.close();
  }
});
