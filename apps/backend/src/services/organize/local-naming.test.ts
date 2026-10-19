/**
 * 按本地 strm 结构整理的映射规则：内容 → 网盘路径、分单元、附属文件跟随、规划项。纯函数，不碰 fs。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskDefinition } from "@openstrm/shared";
import { mapLocalStrm, planLocalUnit, remoteOfStrmContent, type LocalStrm } from "./local-naming.js";
import type { ScopeEntry } from "./units.js";

const task: TaskDefinition = { id: "t", account: "acc", accountType: "quark", originPath: "tv", targetPath: "x/tv", strmPrefix: "/mnt" };
const videoExts = new Set([".mkv", ".mp4"]);
const file = (p: string): ScopeEntry => ({ path: p, isDir: false, id: `id:${p}` });
const strm = (localRel: string, candidates: string[]): LocalStrm => ({ localRel, candidates });

test("内容 → 网盘路径：去前缀、落在 originPath 之下；编码过的给解码候选；对不上的说清楚", () => {
  assert.deepEqual(remoteOfStrmContent(task, "/mnt/tv/inbox/A.S01E01.mkv\n"), { candidates: ["inbox/A.S01E01.mkv"] });
  assert.deepEqual(remoteOfStrmContent({ ...task, enablePathEncoding: true }, "/mnt/tv/a%20b/c%20d.mkv"), { candidates: ["a%20b/c%20d.mkv", "a b/c d.mkv"] });
  assert.deepEqual(remoteOfStrmContent(task, "/other/tv/x.mkv"), { problem: "foreign" });
  assert.deepEqual(remoteOfStrmContent(task, "/mnt/movie/x.mkv"), { problem: "foreign" });
  assert.deepEqual(remoteOfStrmContent(task, "   "), { problem: "empty" });
  assert.deepEqual(remoteOfStrmContent(task, "/mnt/tv/x"), { problem: "no-ext" });
  assert.deepEqual(remoteOfStrmContent(task, "/mnt/tv/x.strm"), { problem: "no-ext" });
  // 前缀是 http 地址（302 模式）也一样
  assert.deepEqual(remoteOfStrmContent({ ...task, strmPrefix: "http://nas:4000/p" }, "http://nas:4000/p/tv/a.mkv"), { candidates: ["a.mkv"] });
});

test("映射：按本地相对路径定目标、季目录归到剧目录、附属文件跟着视频；多个 strm 指同一个文件跳过；范围外 / 不在网盘的只计数", () => {
  const entries = [
    file("inbox/A.S01E01.mkv"),
    file("inbox/A.S01E01.chs.srt"),
    file("inbox/A.S01E01-thumb.jpg"),
    file("inbox/A.S01E01.nfo"),
    file("inbox/tvshow.nfo"),
    file("inbox/B.mkv"),
    file("inbox/C.mkv"),
    file("inbox/D.mkv"),
    { path: "inbox", isDir: true },
  ];
  const index = {
    strms: [
      strm("Show (2020)/Season 01/Show - S01E01.strm", ["inbox/A.S01E01.mkv"]),
      strm("Movies/B (2001)/B (2001).strm", ["inbox/B.mkv"]),
      strm("Movies/B copy/B copy.strm", ["inbox/B.mkv"]),
      strm("inbox/D.strm", ["inbox/D.mkv"]),
      strm("Movies/E/E.strm", ["inbox/E.mkv"]),
      strm("Movies/F/F.strm", ["elsewhere/F.mkv"]),
      { localRel: "junk/x.strm", candidates: [], problem: "foreign" as const },
    ],
    truncated: false,
  };
  const { units, summary } = mapLocalStrm(entries, index, { videoExts, inScope: (rel) => rel.startsWith("inbox/") });
  // matched 按文件数：B 被两个 strm 指着只算一个
  assert.deepEqual(summary, { strms: 7, foreign: 1, outside: 1, missing: 1, matched: 3, moving: 1, unchanged: 1, duplicates: 1, truncated: false });

  const show = units.find((u) => u.key === "local:Show (2020)")!;
  assert.ok(show, JSON.stringify(units.map((u) => u.key)));
  assert.equal(show.dstRoot, "Show (2020)");
  assert.equal(show.rootPath, "inbox");
  assert.equal(show.rawName, "Show (2020)");
  assert.deepEqual(
    show.files.map((f) => [f.file.path, f.dst, f.role, f.follows ?? null]),
    [
      ["inbox/A.S01E01.mkv", "Show (2020)/Season 01/Show - S01E01.mkv", "video", null],
      ["inbox/A.S01E01.chs.srt", "Show (2020)/Season 01/Show - S01E01.chs.srt", "sidecar", "inbox/A.S01E01.mkv"],
      ["inbox/A.S01E01-thumb.jpg", "Show (2020)/Season 01/Show - S01E01-thumb.jpg", "sidecar", "inbox/A.S01E01.mkv"],
      ["inbox/A.S01E01.nfo", "Show (2020)/Season 01/Show - S01E01.nfo", "sidecar", "inbox/A.S01E01.mkv"],
    ],
  );
  // 被两个 strm 指着的：留在源目录的单元里，标跳过并列出两个 strm
  const dup = units.find((u) => u.files.some((f) => f.file.path === "inbox/B.mkv"))!;
  assert.equal(dup.key, "local:inbox");
  assert.match(dup.files[0].skip ?? "", /Movies\/B \(2001\)\/B \(2001\)\.strm.*Movies\/B copy\/B copy\.strm/);
  assert.equal(dup.notes.length, 1);
  // 已经一样的：keep；没 strm 指着的 C 不出现
  const same = dup.files.find((f) => f.file.path === "inbox/D.mkv")!;
  assert.equal(same.dst, "inbox/D.mkv");
  assert.ok(!units.some((u) => u.files.some((f) => f.file.path === "inbox/C.mkv")));
  // 没动的视频不带附属：tvshow.nfo 谁都不跟
  assert.ok(!units.some((u) => u.files.some((f) => f.file.path === "inbox/tvshow.nfo")));
});

test("映射：本地放在暂存区的不往那里挪；附属文件只跟 stem 最长的那个视频", () => {
  const entries = [file("inbox/A.mkv"), file("inbox/A.chs.srt"), file("inbox/A.2.mkv"), file("inbox/A.2.chs.srt"), file("inbox/G.mkv")];
  const index = {
    strms: [strm("Movies/A/A.strm", ["inbox/A.mkv"]), strm("Movies/A2/A2.strm", ["inbox/A.2.mkv"]), strm("归档/G/G.strm", ["inbox/G.mkv"])],
    truncated: true,
  };
  const { units, summary } = mapLocalStrm(entries, index, { videoExts, inScope: () => true });
  assert.equal(summary.truncated, true);
  const a = units.find((u) => u.key === "local:Movies/A")!;
  assert.deepEqual(a.files.map((f) => f.file.path), ["inbox/A.mkv", "inbox/A.chs.srt"]);
  const a2 = units.find((u) => u.key === "local:Movies/A2")!;
  assert.deepEqual(a2.files.map((f) => f.file.path), ["inbox/A.2.mkv", "inbox/A.2.chs.srt"]);
  const g = units.find((u) => u.files.some((f) => f.file.path === "inbox/G.mkv"))!;
  assert.match(g.files[0].skip ?? "", /暂存区/);
});

test("规划：没勾选全 skip；单独取消勾选的文件 skip、字幕跟着它留下；冲突办法带进项里", () => {
  const entries = [file("inbox/A.mkv"), file("inbox/A.chs.srt"), file("inbox/D.mkv")];
  const index = { strms: [strm("Movies/A (2020)/A (2020).strm", ["inbox/A.mkv"]), strm("inbox/D.strm", ["inbox/D.mkv"])], truncated: false };
  const { units } = mapLocalStrm(entries, index, { videoExts, inScope: () => true });
  const a = units.find((u) => u.key === "local:Movies/A (2020)")!;
  assert.ok(planLocalUnit(a, { selected: false }).items.every((i) => i.action === "skip" && i.reason === "未勾选"));

  const plan = planLocalUnit(a, { selected: true });
  assert.equal(plan.dstRoot, "Movies/A (2020)");
  assert.deepEqual(
    plan.items.map((i) => [i.srcPath, i.action, i.dstPath, i.follows ?? null, i.soft ?? false]),
    [
      ["inbox/A.mkv", "move", "Movies/A (2020)/A (2020).mkv", null, false],
      ["inbox/A.chs.srt", "move", "Movies/A (2020)/A (2020).chs.srt", ["inbox/A.mkv"], true],
    ],
  );
  const excluded = planLocalUnit(a, { selected: true, excluded: new Set(["inbox/A.mkv"]) });
  assert.equal(excluded.items[0].action, "skip");
  assert.equal(excluded.items[1].action, "move", "字幕还是 move，finalizeItems 看到视频没挪再让它留下");

  const resolved = planLocalUnit(a, { selected: true, resolutions: new Map([["inbox/A.mkv", { how: "rename" }]]) });
  assert.equal(resolved.items[0].resolve, "rename");
  assert.ok((resolved.items[0].variants?.length ?? 0) > 0);
  const custom = planLocalUnit(a, { selected: true, resolutions: new Map([["inbox/A.mkv", { how: "custom", name: "A v2" }]]) });
  assert.equal(custom.items[0].customName, "A v2.mkv");

  const d = units.find((u) => u.key === "local:inbox")!;
  assert.deepEqual(planLocalUnit(d, { selected: true }).items.map((i) => i.action), ["keep"]);
});

test("规划：按文件改名——视频按填的名字（补扩展名），跟着它的附属文件按新主名跟；已经和本地一样的改了名就是原地改名", () => {
  const entries = [file("inbox/A.mkv"), file("inbox/A.chs.srt"), file("inbox/A-thumb.jpg"), file("inbox/D.mkv")];
  const index = { strms: [strm("Movies/A (2020)/A (2020).strm", ["inbox/A.mkv"]), strm("inbox/D.strm", ["inbox/D.mkv"])], truncated: false };
  const { units } = mapLocalStrm(entries, index, { videoExts, inScope: () => true });
  const a = units.find((u) => u.key === "local:Movies/A (2020)")!;
  const plan = planLocalUnit(a, { selected: true, renames: new Map([["inbox/A.mkv", "A 导演剪辑版"]]) });
  assert.deepEqual(
    plan.items.map((i) => [i.srcPath, i.action, i.dstPath]),
    [
      ["inbox/A.mkv", "move", "Movies/A (2020)/A 导演剪辑版.mkv"],
      ["inbox/A.chs.srt", "move", "Movies/A (2020)/A 导演剪辑版.chs.srt"],
      ["inbox/A-thumb.jpg", "move", "Movies/A (2020)/A 导演剪辑版-thumb.jpg"],
    ],
  );
  const d = units.find((u) => u.key === "local:inbox")!;
  const renamed = planLocalUnit(d, { selected: true, renames: new Map([["inbox/D.mkv", "D v2.mkv"]]) });
  assert.deepEqual(renamed.items.map((i) => [i.action, i.dstPath]), [["rename", "inbox/D v2.mkv"]]);
});
