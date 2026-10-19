/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/plan.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrganizeMatch } from "@openstrm/shared";
import { EXCLUDED_REASON, finalizeItems, planUnit, resolveEpisode, type ScopeRoot } from "./plan.js";
import { parseRules } from "./rules.js";
import { resolveOrganizeSettings } from "./settings.js";
import { buildUnits, type ScopeEntry } from "./units.js";

const settings = resolveOrganizeSettings({});
const videoExts = new Set([".mkv", ".mp4"]);
const entries = (paths: string[]): ScopeEntry[] => paths.map((p, i) => ({ path: p, isDir: false, id: `n${i}` }));

const beef: OrganizeMatch = {
  mediaType: "tv", tmdbId: 153312, title: "怒呛人生", originalTitle: "BEEF", enTitle: "BEEF", year: "2023", posterUrl: "",
  confidence: "high", reason: "test", seasons: [{ season: 1, episodeCount: 10 }, { season: 2, episodeCount: 8 }],
};
const dune: OrganizeMatch = {
  mediaType: "movie", tmdbId: 693134, title: "沙丘：第二部", originalTitle: "Dune: Part Two", year: "2024", posterUrl: "", confidence: "high", reason: "test",
};

function plan(paths: string[], match: OrganizeMatch, extra: Partial<Parameters<typeof planUnit>[0]> = {}, ctxSettings = settings) {
  const es = entries(paths);
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match, seasonOverride: null, episodeOffset: 0, selected: true, ...extra }, { settings: ctxSettings });
  return { unit, plan: p, items: finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true }) };
}

test("剧集：季目录 + 改名 + 字幕跟随 + 作品级 nfo/图片 + mkdir/rmdir", () => {
  const { plan: p, items } = plan(
    [
      "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv",
      "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt",
      "inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv",
      "inbox/BEEF.S01.1080p/tvshow.nfo",
      "inbox/BEEF.S01.1080p/poster.jpg",
    ],
    beef,
  );
  assert.equal(p.dstRoot, "怒呛人生 (2023) [tmdbid=153312]");
  const byName = (n: string) => items.find((i) => i.srcPath.endsWith(n))!;
  assert.equal(byName("S01E01.1080p.WEB-DL.mkv").dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.equal(byName("S01E01.1080p.WEB-DL.mkv").action, "move");
  assert.equal(byName("chs.srt").dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.zh-CN.srt");
  assert.equal(byName("tvshow.nfo").dstPath, "怒呛人生 (2023) [tmdbid=153312]/tvshow.nfo");
  assert.equal(byName("poster.jpg").dstPath, "怒呛人生 (2023) [tmdbid=153312]/poster.jpg");
  const mkdirs = items.filter((i) => i.action === "mkdir").map((i) => i.dstPath);
  assert.deepEqual(mkdirs, ["怒呛人生 (2023) [tmdbid=153312]", "怒呛人生 (2023) [tmdbid=153312]/Season 01"]);
  const rmdirs = items.filter((i) => i.action === "rmdir").map((i) => i.srcPath);
  assert.deepEqual(rmdirs, ["inbox/BEEF.S01.1080p", "inbox"], "腾空的源目录从深到浅");
});

test("清单里带目录项（夸克 / OpenList 的 walkSubtree）：子目录腾空删掉后上级也算空", () => {
  const es: ScopeEntry[] = [
    { path: "inbox", isDir: true, id: "d0" },
    { path: "inbox/BEEF.S01.1080p", isDir: true, id: "d1" },
    { path: "inbox/BEEF.S01.1080p/S01", isDir: true, id: "d2" },
    { path: "inbox/BEEF.S01.1080p/S01/BEEF.S01E01.1080p.WEB-DL.mkv", isDir: false, id: "n1" },
    { path: "inbox/BEEF.S01.1080p/S01/BEEF.S01E02.1080p.WEB-DL.mkv", isDir: false, id: "n2" },
  ];
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true });
  const rmdirs = items.filter((i) => i.action === "rmdir");
  assert.deepEqual(rmdirs.map((i) => i.srcPath), ["inbox/BEEF.S01.1080p/S01", "inbox/BEEF.S01.1080p", "inbox"], "从深到浅逐层清");
  assert.deepEqual(rmdirs.map((i) => i.nodeId), ["d2", "d1", "d0"], "目录项自带的 id 跟着走");
});

test("范围目录本身：默认不删；范围就是发布目录（scopeRemovable）时腾空了也删", () => {
  const paths = ["inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv", "inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"];
  const es = entries(paths);
  const [unit] = buildUnits(es, { scopePath: "inbox/BEEF.S01.1080p", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  const keep = finalizeItems([p], { entries: es, scopePath: "inbox/BEEF.S01.1080p", items: p.items, cleanupEmptyDirs: true });
  assert.deepEqual(keep.filter((i) => i.action === "rmdir").map((i) => i.srcPath), [], "没说可删就留着范围目录");
  const drop = finalizeItems([p], { entries: es, scopePath: "inbox/BEEF.S01.1080p", scopeRemovable: true, items: p.items, cleanupEmptyDirs: true });
  assert.deepEqual(drop.filter((i) => i.action === "rmdir").map((i) => i.srcPath), ["inbox/BEEF.S01.1080p"], "范围目录腾空了就删，但不碰上级 inbox");
  const still = finalizeItems([p], { entries: [...es, { path: "inbox/BEEF.S01.1080p/readme.txt", isDir: false, id: "x" }], scopePath: "inbox/BEEF.S01.1080p", scopeRemovable: true, items: p.items, cleanupEmptyDirs: true });
  assert.deepEqual(still.filter((i) => i.action === "rmdir"), [], "还剩东西就不删");
});

test("电影：多版本靠画质区分；已经规范的文件是 keep", () => {
  const { items } = plan(["m/Dune.Part.Two.2024.2160p.WEB-DL.mkv", "m/Dune.Part.Two.2024.1080p.WEB-DL.mkv"], dune);
  const dsts = items.filter((i) => i.kind === "video").map((i) => i.dstPath).sort();
  assert.deepEqual(dsts, [
    "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 1080p.mkv",
    "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv",
  ]);
  const done = plan(["沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv"], dune);
  assert.equal(done.items.filter((i) => i.kind === "video")[0].action, "keep");
  assert.equal(done.items.filter((i) => i.action === "mkdir").length, 0);
});

test("同一单元两个视频算出同一个目标名：后者冲突", () => {
  const { items } = plan(["m/Dune.Part.Two.2024.1080p.WEB-DL.x264.mkv", "m/Dune.Part.Two.2024.1080p.WEB-DL.x265.mkv"], dune);
  const actions = items.filter((i) => i.kind === "video").map((i) => i.action).sort();
  assert.deepEqual(actions, ["conflict", "move"]);
});

test("绝对集数按每季集数折算；季覆盖和集偏移", () => {
  const es = entries(["Show/[Sub] BEEF - 13 [1080p].mkv"]);
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const f = unit.files[0];
  assert.deepEqual(resolveEpisode(f, unit, beef, null, 0), { season: 2, episode: 3, episodeEnd: undefined, absolute: 13, note: "第 13 集超过 S01 的 10 集，按绝对集数折算成 S02E03" });
  assert.deepEqual(resolveEpisode(f, unit, beef, 3, 0), { season: 3, episode: 3, episodeEnd: undefined, absolute: 13, note: "第 13 集超过 S01 的 10 集，按绝对集数折算成 S02E03" });
  const es2 = entries(["Show/BEEF - 13 [1080p].mkv"]);
  const [u2] = buildUnits(es2, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  assert.deepEqual(resolveEpisode(u2.files[0], u2, { ...beef, seasons: undefined }, 1, -12), { season: 1, episode: 1, episodeEnd: undefined, absolute: 13, note: undefined });
});

test("识别词直指带季：命中目录名的 s 管整个单元（人改的季优先、特别篇除外）；命中文件名的 s / e 只管那个文件；直指的不是认出来的作品就不算", () => {
  const { rules } = parseRules(["某某剧 第二部 => {[tmdbid=153312;type=tv;s=2]}", "BEEF 特别篇 => {[tmdbid=153312;s=0;e=3]}"]);
  const es = entries(["某某剧 第二部/01.mkv", "某某剧 第二部/02.mkv", "某某剧 第二部/BEEF.S01E05.mkv", "某某剧 第二部/BEEF 特别篇.mkv", "某某剧 第二部/BEEF.SP01.mkv"]);
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules });
  assert.equal(unit.dirDirect?.season, 2, "命中的是目录名");
  const se = (name: string, match = beef, seasonOverride: number | null = null, offset = 0) => {
    const r = resolveEpisode(unit.files.find((f) => f.name === name)!, unit, match, seasonOverride, offset);
    return r && `S${r.season}E${r.episode}`;
  };
  assert.equal(se("01.mkv"), "S2E1", "目录名直指的季");
  assert.equal(se("BEEF.S01E05.mkv"), "S2E5", "文件名里写着 S01 也按直指的季");
  assert.equal(se("BEEF.SP01.mkv"), "S0E1", "特别篇还是特别篇");
  assert.equal(se("01.mkv", beef, 3), "S3E1", "人在预览里改的季优先");
  assert.equal(se("BEEF 特别篇.mkv"), "S0E3", "命中文件名的 s / e 只管这个文件");
  assert.equal(se("BEEF 特别篇.mkv", beef, 3, 5), "S0E3", "钉死的季 / 集不吃季覆盖和集偏移");
  const other = { ...beef, tmdbId: 999 };
  assert.equal(se("01.mkv", other), "S1E1", "直指的不是认出来的作品：不算");
  assert.equal(se("BEEF 特别篇.mkv", other), null, "钉的集数也不算，名字里又看不出集数");
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  assert.equal(p.items.find((i) => i.srcPath.endsWith("/01.mkv"))!.dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 02/怒呛人生 - S02E01.mkv");
});

test("没识别 / 没勾选：全部 skip；花絮默认跟着进 extras/，设置成留在原处才不动", () => {
  const none = plan(["x/a.mkv"], dune, { match: null });
  assert.ok(none.items.every((i) => i.action === "skip"));
  const unselected = plan(["x/a.mkv"], dune, { selected: false });
  assert.equal(unselected.items[0].reason, "未勾选");
  assert.equal(resolveOrganizeSettings({}).extras, "move", "没设过：跟着走");
  assert.equal(resolveOrganizeSettings({ organize: { extras: "keep" } }).extras, "keep", "设过的照设的来");
  const moved = plan(["x/Dune.2024.mkv", "x/Featurettes/making.mkv"], dune);
  const extra = moved.items.find((i) => i.srcPath.endsWith("making.mkv"))!;
  assert.equal(extra.dstPath, "沙丘：第二部 (2024) [tmdbid=693134]/extras/making.mkv");
  assert.equal(extra.reason, "按花絮处理", "预览里看得出它是按花絮走的");
  const keep = plan(["x/Dune.2024.mkv", "x/Featurettes/making.mkv"], dune, {}, { ...settings, extras: "keep" });
  assert.deepEqual([keep.items.find((i) => i.srcPath.endsWith("making.mkv"))!.action, keep.items.find((i) => i.srcPath.endsWith("making.mkv"))!.reason], ["keep", "花絮不动"]);
});

const DUNE_DIR = "沙丘：第二部 (2024) [tmdbid=693134]";
const REL = "inbox/Dune.Part.Two.2024.2160p.WEB-DL";

test("正片走了，留下的跟着走：花絮 / sample 进 extras/，认不出类型的原名进作品目录，源目录腾空删掉", () => {
  const { items } = plan(
    [
      `${REL}/Dune.Part.Two.2024.2160p.WEB-DL.mkv`,
      `${REL}/Dune.Part.Two.2024.Trailer.mkv`,
      `${REL}/Dune.Part.Two.2024.Trailer.chs.srt`,
      `${REL}/Featurettes/making.mkv`,
      `${REL}/sample.mkv`,
      `${REL}/更多资源请访问.txt`,
      `${REL}/广告.url`,
      `${REL}/ost.flac`,
      `${REL}/广告图.png`,
    ],
    dune,
  );
  const dst = (n: string) => items.find((i) => i.srcPath.endsWith(n))!.dstPath;
  assert.equal(dst("2160p.WEB-DL.mkv"), `${DUNE_DIR}/沙丘：第二部 (2024) - 2160p.mkv`);
  assert.equal(dst("Trailer.mkv"), `${DUNE_DIR}/extras/Dune.Part.Two.2024.Trailer.mkv`, "按名字认出的花絮");
  assert.equal(dst("Trailer.chs.srt"), `${DUNE_DIR}/extras/Dune.Part.Two.2024.Trailer.chs.srt`, "花絮的字幕原名跟着，不去找正片当主人");
  assert.equal(dst("Featurettes/making.mkv"), `${DUNE_DIR}/extras/making.mkv`, "花絮目录里的平铺进 extras/");
  assert.equal(dst("sample.mkv"), `${DUNE_DIR}/extras/sample.mkv`, "sample 当花絮，预览里看得见");
  for (const n of ["更多资源请访问.txt", "广告.url", "ost.flac", "广告图.png"]) assert.equal(dst(n), `${DUNE_DIR}/${n}`, `${n} 原名进作品目录`);
  assert.equal(items.filter((i) => i.action === "conflict" || i.action === "skip" || i.action === "keep").length, 0, "没有留下的");
  assert.deepEqual(items.filter((i) => i.action === "rmdir").map((i) => i.srcPath), [`${REL}/Featurettes`, REL, "inbox"], "源目录腾空，从深到浅删掉");
});

test("花絮撞名：留在原处，不算冲突，不卡正片", () => {
  const { items } = plan([`${REL}/Dune.Part.Two.2024.2160p.WEB-DL.mkv`, `${REL}/Featurettes/01.mkv`, `${REL}/Trailers/01.mkv`], dune);
  const of = (n: string) => items.find((i) => i.srcPath.endsWith(n))!;
  assert.equal(of("2160p.WEB-DL.mkv").action, "move");
  assert.equal(of("Featurettes/01.mkv").dstPath, `${DUNE_DIR}/extras/01.mkv`);
  assert.deepEqual([of("Trailers/01.mkv").action, of("Trailers/01.mkv").reason], ["skip", "和 01.mkv 要去同一个位置，留在原处"]);
  assert.equal(items.filter((i) => i.action === "conflict").length, 0, "自动整理有冲突就整轮不执行：花絮不能卡住正片");
});

test("正片没挪，花絮和认不出类型的都不跟；任务根 / 收件箱里散着的认不出类型的不动", () => {
  const main = `${REL}/Dune.Part.Two.2024.2160p.WEB-DL.mkv`;
  const stay = plan([main, `${REL}/Featurettes/making.mkv`, `${REL}/readme.txt`], dune, { excluded: new Set([main]) });
  for (const n of ["making.mkv", "readme.txt"]) {
    const it = stay.items.find((i) => i.srcPath.endsWith(n))!;
    assert.deepEqual([it.action, it.reason], ["skip", "对应的视频没挪，跟着留在原处"], n);
  }
  assert.equal(stay.items.filter((i) => i.action === "rmdir" || i.action === "mkdir").length, 0);
  // 任务根：目录不是这部作品自己的，txt 不知道归谁
  const loose = plan(["Dune.Part.Two.2024.2160p.WEB-DL.mkv", "Dune.Part.Two.2024.2160p.WEB-DL.txt"], dune);
  const txt = loose.items.find((i) => i.srcPath.endsWith(".txt"))!;
  assert.deepEqual([txt.action, txt.reason], ["keep", "不认识的文件类型，不动"]);
});

test("整理过的库再跑：已经在作品目录里的花絮 / 杂项不重新摆", () => {
  const movie = plan(
    [
      `${DUNE_DIR}/沙丘：第二部 (2024) - 2160p.mkv`,
      `${DUNE_DIR}/extras/making.mkv`,
      `${DUNE_DIR}/Featurettes/interview.mkv`,
      `${DUNE_DIR}/沙丘：第二部 (2024)-trailer.mkv`,
      `${DUNE_DIR}/sample.mkv`,
      `${DUNE_DIR}/readme.txt`,
    ],
    dune,
  );
  assert.deepEqual(movie.items.map((i) => i.action), Array(6).fill("keep"), "媒体服务器本来就认的放法（-trailer 后缀、Featurettes/）也不动");
  const tv = plan(
    [
      "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv",
      "怒呛人生 (2023) [tmdbid=153312]/Season 01/ost.flac",
      "怒呛人生 (2023) [tmdbid=153312]/Season 01/Extras/making.mkv",
    ],
    beef,
  );
  assert.deepEqual(tv.items.map((i) => i.action), ["keep", "keep", "keep"], "季目录里的杂项、花絮不往剧根目录拽");
});

test("集标题里带 making 这种词的正片不是花絮：和别的集一样挪，字幕跟着；花絮不管挪不挪都不进 extras/", () => {
  const paths = [
    "inbox/BEEF.S01.1080p/BEEF.S01E03.No.New.Tricks.1080p.WEB-DL.mkv",
    "inbox/BEEF.S01.1080p/BEEF.S01E04.Whos.Making.Dinner.1080p.WEB-DL.mkv",
    "inbox/BEEF.S01.1080p/BEEF.S01E04.Whos.Making.Dinner.1080p.WEB-DL.chs.srt",
  ];
  for (const s of [{ ...settings, extras: "keep" as const }, { ...settings, extras: "move" as const }]) {
    const { items } = plan(paths, beef, {}, s);
    const byName = (n: string) => items.find((i) => i.srcPath.endsWith(n))!;
    assert.equal(byName("Dinner.1080p.WEB-DL.mkv").action, "move");
    assert.equal(byName("Dinner.1080p.WEB-DL.mkv").dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E04.mkv");
    assert.equal(byName("chs.srt").dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E04.zh-CN.srt");
    assert.ok(items.every((i) => i.reason !== "花絮不动" && !i.dstPath.includes("/extras/")));
  }
});

test("跨单元冲突：目标已存在（且不是正在挪走的源）", () => {
  const es = [...entries(["inbox/Dune.2024.1080p.mkv"]), { path: "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 1080p.mkv", isDir: false }];
  const units = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const inbox = units.find((u) => u.rootPath === "inbox")!;
  const p = planUnit({ unit: inbox, match: dune, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true });
  const v = items.find((i) => i.srcPath === "inbox/Dune.2024.1080p.mkv")!;
  assert.equal(v.action, "conflict");
  assert.equal(v.reason, "目标已存在");
});

test("冲突选「改名保留」：加画质后缀并排放着，字幕跟着新名字走", () => {
  const es = [
    ...entries(["inbox/BEEF.S01E01.2160p.WEB-DL.mkv", "inbox/BEEF.S01E01.2160p.WEB-DL.chs.srt"]),
    { path: "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv", isDir: false, id: "old" },
  ];
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const resolutions = new Map([["inbox/BEEF.S01E01.2160p.WEB-DL.mkv", { how: "rename" as const }]]);
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true, resolutions }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true });
  const v = items.find((i) => i.kind === "video")!;
  assert.equal(v.action, "move");
  assert.equal(v.dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01 - 2160p.mkv");
  assert.match(v.reason, /改名保留/);
  assert.equal(items.find((i) => i.kind === "subtitle")!.dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01 - 2160p.zh-CN.srt");
});

test("冲突选「自己改名」：目录不变、名字按填的来；没写扩展名就补上", () => {
  const es = [...entries(["inbox/BEEF.S01E01.2160p.WEB-DL.mkv"]), { path: "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv", isDir: false, id: "old" }];
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const resolutions = new Map([["inbox/BEEF.S01E01.2160p.WEB-DL.mkv", { how: "custom" as const, name: "怒呛人生 - S01E01 - 4K版" }]]);
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true, resolutions }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true });
  const v = items.find((i) => i.kind === "video")!;
  assert.equal(v.action, "move");
  assert.equal(v.dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01 - 4K版.mkv");
  assert.equal(v.resolved, true);
});

test("「自己改名」只在真撞上时用：没冲突的文件记着也按模板的名字走，办法标成没用上", () => {
  const es = entries(["inbox/BEEF.S01E01.2160p.WEB-DL.mkv", "inbox/BEEF.S01E01.2160p.WEB-DL.chs.srt"]);
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const resolutions = new Map([["inbox/BEEF.S01E01.2160p.WEB-DL.mkv", { how: "custom" as const, name: "随便起的名字" }]]);
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true, resolutions }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true });
  const v = items.find((i) => i.kind === "video")!;
  assert.equal(v.dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.equal(v.resolved, undefined);
  assert.equal(items.find((i) => i.kind === "subtitle")!.dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.zh-CN.srt");
});

test("冲突选「挪进重复文件目录」：原来的目录层级留着，字幕跟着；源目录腾空了照样删", () => {
  const es = [
    ...entries(["inbox/BEEF.S01E01.2160p.WEB-DL.mkv", "inbox/BEEF.S01E01.2160p.WEB-DL.chs.srt"]),
    { path: "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv", isDir: false, id: "old" },
  ];
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const resolutions = new Map([["inbox/BEEF.S01E01.2160p.WEB-DL.mkv", { how: "duplicate" as const }]]);
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true, resolutions }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true });
  const v = items.find((i) => i.kind === "video")!;
  assert.equal(v.action, "move");
  assert.equal(v.dstPath, "重复文件/inbox/BEEF.S01E01.2160p.WEB-DL.mkv");
  assert.equal(items.find((i) => i.kind === "subtitle")!.dstPath, "重复文件/inbox/BEEF.S01E01.2160p.WEB-DL.chs.srt");
  assert.deepEqual(items.filter((i) => i.action === "mkdir").map((i) => i.dstPath), ["重复文件", "重复文件/inbox"]);
  assert.deepEqual(items.filter((i) => i.action === "rmdir").map((i) => i.srcPath), ["inbox"]);
});

test("冲突选「删掉这一份」：这一份和跟着它的字幕都标删除，源目录腾空了删掉", () => {
  const es = [
    ...entries(["inbox/BEEF.S01E01.2160p.WEB-DL.mkv", "inbox/BEEF.S01E01.2160p.WEB-DL.chs.srt"]),
    { path: "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv", isDir: false, id: "old" },
  ];
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const resolutions = new Map([["inbox/BEEF.S01E01.2160p.WEB-DL.mkv", { how: "delete" as const }]]);
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true, resolutions }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true });
  assert.deepEqual(items.filter((i) => i.action === "delete").map((i) => i.srcPath), ["inbox/BEEF.S01E01.2160p.WEB-DL.mkv", "inbox/BEEF.S01E01.2160p.WEB-DL.chs.srt"]);
  assert.equal(items.find((i) => i.kind === "video")!.dstPath, "inbox/BEEF.S01E01.2160p.WEB-DL.mkv", "删除项的目标就是它自己");
  assert.deepEqual(items.filter((i) => i.action === "rmdir").map((i) => i.srcPath), ["inbox"]);
  assert.deepEqual(items.filter((i) => i.action === "mkdir"), [], "不用建目标目录");
});

test("冲突选「覆盖」：先删掉目标那份（排在前面），这一份照常挪过去", () => {
  const es = [...entries(["inbox/BEEF.S01E01.2160p.WEB-DL.mkv"]), { path: "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv", isDir: false, id: "old" }];
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const resolutions = new Map([["inbox/BEEF.S01E01.2160p.WEB-DL.mkv", { how: "replace" as const }]]);
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true, resolutions }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true });
  const del = items.find((i) => i.action === "delete")!;
  const v = items.find((i) => i.action === "move")!;
  assert.equal(del.srcPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.equal(del.nodeId, "old");
  assert.ok(items.indexOf(del) < items.indexOf(v), "删除排在移动前面");
  assert.equal(v.dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
});

test("同一单元两个版本撞同一个名字：选「改名保留」的那份加后缀走，选「覆盖」的没东西可覆盖、照旧留在原处", () => {
  const paths = ["inbox/BEEF.S01E01.1080p.WEB-DL.mkv", "inbox/BEEF.S01E01.2160p.WEB-DL.mkv"];
  const dst = "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv";
  const run = (how: "rename" | "replace") => {
    const es = entries(paths);
    const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
    const resolutions = new Map([["inbox/BEEF.S01E01.2160p.WEB-DL.mkv", { how }]]);
    const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true, resolutions }, { settings });
    return finalizeItems([p], { entries: es, scopePath: "", items: p.items, cleanupEmptyDirs: true });
  };
  const renamed = run("rename");
  assert.equal(renamed.find((i) => i.srcPath.includes("1080p"))!.dstPath, dst, "先排上的那份照常");
  assert.equal(renamed.find((i) => i.srcPath.includes("2160p"))!.dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01 - 2160p.mkv");
  const replaced = run("replace");
  assert.equal(replaced.find((i) => i.srcPath.includes("2160p"))!.action, "conflict", "占位的是本轮另一项，不是网盘上的文件");
  assert.equal(replaced.filter((i) => i.action === "delete").length, 0);
});

test("二级分类开着时多一层目录，且作品根随之变化", () => {
  const cat = resolveOrganizeSettings({ organize: { categories: { enabled: true } } });
  const { plan: p } = plan(["m/Dune.Part.Two.2024.2160p.mkv"], { ...dune, genreIds: [878], originalLanguage: "en" }, {}, cat);
  assert.equal(p.dstRoot, "外语电影/沙丘：第二部 (2024) [tmdbid=693134]");
  const { plan: p2 } = plan(["m/Dune.Part.Two.2024.2160p.mkv"], { ...dune, genreIds: [16], originalLanguage: "ja" }, {}, cat);
  assert.equal(p2.dstRoot, "动画电影/沙丘：第二部 (2024) [tmdbid=693134]");
});

test("认成剧集、文件名只有标题末尾的数字：去掉数字正好是剧名的当集数，对不上的照旧跳过", () => {
  const show: OrganizeMatch = { ...beef, tmdbId: 84656, title: "回家的诱惑", originalTitle: "回家的诱惑", enTitle: "", year: "2011", seasons: [{ season: 1, episodeCount: 80 }] };
  const v = plan(["回家的诱惑/回家的诱惑69.mp4"], show).items.find((i) => i.kind === "video")!;
  assert.equal(v.dstPath, "回家的诱惑 (2011) [tmdbid=84656]/Season 01/回家的诱惑 - S01E69.mp4");
  const other = plan(["回家的诱惑/流浪地球2.mp4"], show).items.find((i) => i.kind === "video")!;
  assert.equal(other.action, "skip");
  assert.equal(other.reason, "看不出是第几集");
});

test("「同一部电影的多个版本」只在没认成剧集时提示", () => {
  const paths = ["m/Dune.Part.Two.2024.2160p.WEB-DL.mkv", "m/Dune.Part.Two.2024.1080p.WEB-DL.mkv"];
  const note = "2 个视频没有集数标记，按同一部电影的多个版本处理";
  assert.deepEqual(plan(paths, dune).plan.notes, [note]);
  assert.deepEqual(plan(paths, dune, { match: null }).plan.notes, [note]);
  assert.deepEqual(plan(paths, beef).plan.notes, [], "TMDB 认成剧集：这句话不对，不说");
});

const blackMirror: OrganizeMatch = {
  mediaType: "tv", tmdbId: 42009, title: "黑镜", originalTitle: "Black Mirror", year: "2011", posterUrl: "", confidence: "high", reason: "test", seasons: [{ season: 7, episodeCount: 6 }],
};

test("剧目录的整套刮削文件（本机 黑镜 (2011) 的文件名）：作品级进作品根、季目录里的 season.nfo 进新季目录、分集 nfo / thumb 跟着视频，一个不落、旧目录删掉", () => {
  const names = [
    "backdrop.jpg", "background.jpg", "banner.jpg", "characterart.png", "clearart.png", "clearlogo.png", "logo.png", "poster.jpg",
    "season02-banner.jpg", "season02-poster.jpg", "season02-thumb.jpg", "season07-poster.jpg", "thumb.jpg", "tvshow.nfo", "Season 7/season.nfo",
    ...[1, 2, 3].flatMap((n) => [`Season 7/黑镜 - S07E0${n} - 第 ${n} 集.mkv`, `Season 7/黑镜 - S07E0${n} - 第 ${n} 集.nfo`, `Season 7/黑镜 - S07E0${n} - 第 ${n} 集-thumb.jpg`]),
  ];
  const { items } = plan(names.map((n) => `黑镜 (2011)/${n}`), blackMirror);
  const root = "黑镜 (2011) [tmdbid=42009]";
  const dst = (n: string) => items.find((i) => i.srcPath === `黑镜 (2011)/${n}`)!.dstPath;
  for (const n of ["background.jpg", "characterart.png", "season02-thumb.jpg", "poster.jpg", "clearlogo.png", "tvshow.nfo", "season07-poster.jpg"]) assert.equal(dst(n), `${root}/${n}`, n);
  assert.equal(dst("Season 7/season.nfo"), `${root}/Season 07/season.nfo`, "季 nfo 进新季目录，不是剧根");
  assert.equal(dst("Season 7/黑镜 - S07E01 - 第 1 集.nfo"), `${root}/Season 07/黑镜 - S07E01.nfo`);
  assert.equal(dst("Season 7/黑镜 - S07E01 - 第 1 集-thumb.jpg"), `${root}/Season 07/黑镜 - S07E01-thumb.jpg`);
  assert.deepEqual(items.filter((i) => i.action === "skip" || i.action === "conflict").map((i) => i.srcPath), [], "一个都不落下");
  assert.deepEqual(items.filter((i) => i.action === "rmdir").map((i) => i.srcPath), ["黑镜 (2011)/Season 7", "黑镜 (2011)"]);
});

test("季目录里的 poster.jpg / season.nfo 进各自的新季目录；extrafanart 整个进作品目录；不再互相撞名", () => {
  const show: OrganizeMatch = { ...beef, tmdbId: 1, title: "某剧", originalTitle: "某剧", enTitle: "", year: "2020", seasons: [{ season: 1, episodeCount: 10 }, { season: 2, episodeCount: 10 }] };
  const { items } = plan(
    ["某剧 (2020)/poster.jpg", "某剧 (2020)/tvshow.nfo", "某剧 (2020)/extrafanart/fanart1.jpg", "某剧 (2020)/Season 1/poster.jpg", "某剧 (2020)/Season 1/season.nfo", "某剧 (2020)/Season 1/某剧.S01E01.mkv", "某剧 (2020)/Season 2/poster.jpg", "某剧 (2020)/Season 2/season.nfo", "某剧 (2020)/Season 2/某剧.S02E01.mkv"],
    show,
  );
  const root = "某剧 (2020) [tmdbid=1]";
  const dst = (p: string) => items.find((i) => i.srcPath === `某剧 (2020)/${p}`)!.dstPath;
  assert.equal(dst("poster.jpg"), `${root}/poster.jpg`);
  assert.equal(dst("Season 1/poster.jpg"), `${root}/Season 01/poster.jpg`);
  assert.equal(dst("Season 2/poster.jpg"), `${root}/Season 02/poster.jpg`);
  assert.equal(dst("Season 2/season.nfo"), `${root}/Season 02/season.nfo`);
  assert.equal(dst("extrafanart/fanart1.jpg"), `${root}/extrafanart/fanart1.jpg`);
  assert.deepEqual(items.filter((i) => i.action === "conflict" || i.action === "skip"), []);
});

test("并进已有作品目录：作品级图片 / nfo 撞名留在原处、不算冲突，源目录也不当成腾空", () => {
  const es: ScopeEntry[] = [
    ...entries(["Black.Mirror.S07.2160p/Black.Mirror.S07E01.2160p.mkv", "Black.Mirror.S07.2160p/poster.jpg", "Black.Mirror.S07.2160p/tvshow.nfo"]),
    { path: "黑镜 (2011) [tmdbid=42009]/poster.jpg", isDir: false },
    { path: "黑镜 (2011) [tmdbid=42009]/tvshow.nfo", isDir: false },
  ];
  const [unit] = buildUnits(es.slice(0, 3), { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match: blackMirror, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: [], cleanupEmptyDirs: true });
  const poster = items.find((i) => i.srcPath === "Black.Mirror.S07.2160p/poster.jpg")!;
  assert.deepEqual([poster.action, poster.reason], ["skip", "目标位置已经有同名的，留在原处"]);
  assert.equal(items.find((i) => i.srcPath === "Black.Mirror.S07.2160p/tvshow.nfo")!.action, "skip");
  assert.equal(items.filter((i) => i.action === "conflict").length, 0, "不卡自动整理");
  assert.equal(items.find((i) => i.srcPath.endsWith("S07E01.2160p.mkv"))!.action, "move");
  assert.deepEqual(items.filter((i) => i.action === "rmdir"), [], "源目录里还剩这两个，不删");
});

test("视频撞名留在原处：它的字幕 / nfo / thumb 跟着留下；源目录不当成腾空", () => {
  const es: ScopeEntry[] = [
    ...entries(["new/BEEF.S01E01.1080p.mkv", "new/BEEF.S01E01.1080p.chs.srt", "new/BEEF.S01E01.1080p.nfo", "new/BEEF.S01E01.1080p-thumb.jpg"]),
    { path: "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv", isDir: false },
  ];
  const [unit] = buildUnits(es.slice(0, 4), { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: [], cleanupEmptyDirs: true });
  const by = (suffix: string) => items.find((i) => i.srcPath.endsWith(suffix))!;
  assert.deepEqual([by("1080p.mkv").action, by("1080p.mkv").reason], ["conflict", "目标已存在"]);
  for (const s of ["chs.srt", "1080p.nfo", "thumb.jpg"]) assert.deepEqual([by(s).action, by(s).reason], ["skip", "对应的视频没挪，跟着留在原处"], s);
  assert.deepEqual(items.filter((i) => i.action === "rmdir"), [], "原来会把 new 当成腾空");
});

test("冲突留在原处的文件占着的名字，不再当成会腾出来：连环改名里前一环卡住，后一环也不挪进它的名字", () => {
  const dir = "怒呛人生 (2023) [tmdbid=153312]/Season 01";
  const es = entries([`${dir}/怒呛人生 - S01E00.mkv`, `${dir}/怒呛人生 - S01E01.mkv`, `${dir}/怒呛人生 - S01E02.mkv`]);
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  // 集偏移 -1：E02 → E01 的名字、E01 → E00 的名字；E00 自己算出来是第 -1 集，留在原处
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: -1, selected: true }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: [], cleanupEmptyDirs: true });
  const e = (n: string) => items.find((i) => i.srcPath.endsWith(`S01E${n}.mkv`))!.action;
  assert.deepEqual([e("00"), e("01"), e("02")], ["skip", "conflict", "conflict"], "E01 被 E00 挡住留下，E02 就不能改成 E01 的名字");
});

test("跟某个视频同名的 nfo：那个视频没排上（和别的版本撞了同一个目标）就跟着留下，不当成认不出的文件挪走", () => {
  const { items } = plan(
    ["m/Dune.Part.Two.2024.1080p.WEB-DL.x264.mkv", "m/Dune.Part.Two.2024.1080p.WEB-DL.x264.nfo", "m/Dune.Part.Two.2024.1080p.WEB-DL.x265.mkv", "m/Dune.Part.Two.2024.1080p.WEB-DL.x265.nfo"],
    dune,
  );
  const by = (n: string) => items.find((i) => i.srcPath === `m/Dune.Part.Two.2024.1080p.WEB-DL.${n}`)!;
  assert.equal(by("x265.mkv").action, "conflict");
  assert.deepEqual([by("x265.nfo").action, by("x265.nfo").reason], ["skip", "对应的视频没挪，跟着留在原处"]);
  assert.equal(by("x264.nfo").dstPath, "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 1080p.nfo");
});

test("名字认不出的图片 / nfo：作品自己的目录里原名跟进作品目录，不硬配给视频、不截名", () => {
  const { items } = plan(["某片/某片.mkv", "某片/390561_front.jpg", "某片/RARBG.nfo"], dune);
  const dst = (n: string) => items.find((i) => i.srcPath === `某片/${n}`)!.dstPath;
  assert.equal(dst("390561_front.jpg"), "沙丘：第二部 (2024) [tmdbid=693134]/390561_front.jpg", "原来是「沙丘：第二部 (2024)0561_front.jpg」");
  assert.equal(dst("RARBG.nfo"), "沙丘：第二部 (2024) [tmdbid=693134]/RARBG.nfo");
  assert.deepEqual(items.filter((i) => i.action === "rmdir").map((i) => i.srcPath), ["某片"]);
});

test("删空目录不越过范围的根：根里面的腾空了删，根本身只在 removable 时删；没有根就一个都不删", () => {
  const es = entries(["inbox/BEEF.S01.1080p/S01/BEEF.S01E01.1080p.WEB-DL.mkv", "inbox/BEEF.S01.1080p/S01/BEEF.S01E02.1080p.WEB-DL.mkv"]);
  const [unit] = buildUnits(es, { scopePath: "inbox/BEEF.S01.1080p", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true }, { settings });
  const rmdirs = (roots: ScopeRoot[]) => finalizeItems([p], { entries: es, scopeRoots: roots, items: [], cleanupEmptyDirs: true }).filter((i) => i.action === "rmdir").map((i) => i.srcPath);
  assert.deepEqual(rmdirs([{ path: "inbox/BEEF.S01.1080p", removable: false }]), ["inbox/BEEF.S01.1080p/S01"], "根不 removable：只删里面的");
  assert.deepEqual(rmdirs([{ path: "inbox/BEEF.S01.1080p", removable: true }]), ["inbox/BEEF.S01.1080p/S01", "inbox/BEEF.S01.1080p"], "根 removable：连根一起删，上级 inbox 不碰");
  assert.deepEqual(rmdirs([]), [], "没有根（新增路径是文件）：一个目录都不删");
});

test("字幕找主人：主人没排上（看不出集数）就跟着留下，不配给单元里唯一排上的那个视频；单元本来就一个视频时照旧跟它", () => {
  const { items } = plan(["怒呛人生/BEEF.S01E01.mkv", "怒呛人生/BEEF.Pilot.Unaired.mkv", "怒呛人生/BEEF.Pilot.Unaired.chs.srt"], beef);
  const sub = items.find((i) => i.srcPath.endsWith(".chs.srt"))!;
  assert.deepEqual([sub.action, sub.reason], ["skip", "对应的视频没挪，跟着留在原处"]);
  assert.equal(items.find((i) => i.srcPath.endsWith("S01E01.mkv"))!.action, "move");
  const single = plan(["某片/Dune.Part.Two.2024.2160p.mkv", "某片/chs.srt"], dune).items;
  assert.equal(single.find((i) => i.srcPath.endsWith("chs.srt"))!.action, "move", "名字对不上，但单元只有这一个视频");
});

test("单独取消勾选的文件：跳过，跟着它的字幕留下；同一集两个版本撞名时勾掉先排上的那份，另一份就能走", () => {
  const es = entries(["inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv", "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt", "inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"]);
  const [unit] = buildUnits(es, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const p = planUnit({ unit, match: beef, seasonOverride: null, episodeOffset: 0, selected: true, excluded: new Set(["inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"]) }, { settings });
  const items = finalizeItems([p], { entries: es, scopePath: "", items: [], cleanupEmptyDirs: true });
  const by = (n: string) => items.find((i) => i.srcPath.endsWith(n))!;
  assert.deepEqual([by("S01E01.1080p.WEB-DL.mkv").action, by("S01E01.1080p.WEB-DL.mkv").reason], ["skip", EXCLUDED_REASON]);
  assert.equal(by("chs.srt").action, "skip", "字幕跟着它的视频留下");
  assert.equal(by("S01E02.1080p.WEB-DL.mkv").action, "move");
  assert.ok(!items.some((i) => i.action === "rmdir" && i.srcPath === "inbox/BEEF.S01.1080p"), "源目录还有东西，不删");

  const two = entries(["x/BEEF.S01E01.1080p.WEB-DL.mkv", "x/BEEF.S01E01.720p.HDTV.mkv"]);
  const [u2] = buildUnits(two, { scopePath: "", taskRootName: "root", videoExts, rules: [] });
  const clash = planUnit({ unit: u2, match: beef, seasonOverride: null, episodeOffset: 0, selected: true }, { settings }).items;
  assert.deepEqual(clash.map((i) => [i.srcPath, i.action]), [["x/BEEF.S01E01.1080p.WEB-DL.mkv", "move"], ["x/BEEF.S01E01.720p.HDTV.mkv", "conflict"]]);
  const resolved = planUnit({ unit: u2, match: beef, seasonOverride: null, episodeOffset: 0, selected: true, excluded: new Set(["x/BEEF.S01E01.1080p.WEB-DL.mkv"]) }, { settings }).items;
  assert.equal(resolved.find((i) => i.srcPath.endsWith("720p.HDTV.mkv"))!.action, "move");
});

test("改标题 / 年份：只换 {title} {year}，作品根跟着变，原名照旧；空白等于没改", () => {
  const paths = ["inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"];
  const { plan: p, items } = plan(paths, beef, { titleOverride: "怒呛人生：第一季", yearOverride: "2024" });
  assert.equal(p.dstRoot, "怒呛人生：第一季 (2024) [tmdbid=153312]");
  assert.equal(items.find((i) => i.srcPath.endsWith(".mkv"))!.dstPath, "怒呛人生：第一季 (2024) [tmdbid=153312]/Season 01/怒呛人生：第一季 - S01E01.mkv");
  assert.equal(plan(paths, beef, { titleOverride: "  ", yearOverride: "" }).plan.dstRoot, "怒呛人生 (2023) [tmdbid=153312]");
});

test("钉季 / 集：压过文件名、季覆盖和集偏移；只钉集的季照旧算、集不再偏移；看不出集数的文件钉了集就能排；字幕按名字跟着钉了的视频", () => {
  const paths = [
    "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv",
    "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt",
    "inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv",
    "inbox/BEEF.S01.1080p/BEEF.1080p.WEB-DL.mkv",
  ];
  assert.equal(plan(paths, beef).items.find((i) => i.srcPath.endsWith("/BEEF.1080p.WEB-DL.mkv"))!.reason, "看不出是第几集");
  const pins = new Map([
    ["inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv", { season: 2, episode: 5 }],
    ["inbox/BEEF.S01.1080p/BEEF.1080p.WEB-DL.mkv", { episode: 8 }],
  ]);
  const { items } = plan(paths, beef, { seasonOverride: 3, episodeOffset: 10, pins });
  const dst = (n: string) => items.find((i) => i.srcPath.endsWith(n))!.dstPath;
  assert.equal(dst("S01E01.1080p.WEB-DL.mkv"), "怒呛人生 (2023) [tmdbid=153312]/Season 02/怒呛人生 - S02E05.mkv", "钉了季集：季覆盖、偏移都不管");
  assert.equal(dst("chs.srt"), "怒呛人生 (2023) [tmdbid=153312]/Season 02/怒呛人生 - S02E05.zh-CN.srt");
  assert.equal(dst("S01E02.1080p.WEB-DL.mkv"), "怒呛人生 (2023) [tmdbid=153312]/Season 03/怒呛人生 - S03E12.mkv", "没钉的照旧季覆盖 + 偏移");
  assert.equal(dst("/BEEF.1080p.WEB-DL.mkv"), "怒呛人生 (2023) [tmdbid=153312]/Season 03/怒呛人生 - S03E08.mkv", "只钉了集：季按覆盖，集不偏移");
});

test("按文件改名：目录照旧、没写扩展名补上；字幕 / 同名 nfo / thumb 按新名字跟；没改的照旧", () => {
  const paths = [
    "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv",
    "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt",
    "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.nfo",
    "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL-thumb.jpg",
    "inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv",
  ];
  const renames = new Map([["inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv", "怒呛人生 第1集 导演剪辑版"]]);
  const { items } = plan(paths, beef, { renames });
  const dst = (n: string) => items.find((i) => i.srcPath.endsWith(n))!.dstPath;
  assert.equal(dst("S01E01.1080p.WEB-DL.mkv"), "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 第1集 导演剪辑版.mkv");
  assert.equal(dst("chs.srt"), "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 第1集 导演剪辑版.zh-CN.srt");
  assert.equal(dst("WEB-DL.nfo"), "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 第1集 导演剪辑版.nfo");
  assert.equal(dst("-thumb.jpg"), "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 第1集 导演剪辑版-thumb.jpg");
  assert.equal(dst("S01E02.1080p.WEB-DL.mkv"), "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv");
  // 已经规范的文件改个名：原地改名
  const done = plan(["怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"], beef, { renames: new Map([["怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv", "第一集.mkv"]]) }).items;
  assert.equal(done[0].action, "rename");
  assert.equal(done[0].dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/第一集.mkv");
});

test("电影系列：{collection} 只有电影有，模板写成 [{collection}/] 没系列时整段消失；作品根包进系列层", () => {
  const tpl = resolveOrganizeSettings({ organize: { templates: { movie: "[{collection}/]{title} ({year}) {idTag}/{title} ({year}).{ext}" } } });
  const inSeries = plan(["inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"], { ...dune, collection: { id: 726871, name: "沙丘（系列）" } }, {}, tpl);
  assert.equal(inSeries.plan.dstRoot, "沙丘（系列）/沙丘：第二部 (2024) [tmdbid=693134]");
  assert.equal(inSeries.items.find((i) => i.srcPath.endsWith(".mkv"))!.dstPath, "沙丘（系列）/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024).mkv");
  const alone = plan(["inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"], dune, {}, tpl);
  assert.equal(alone.plan.dstRoot, "沙丘：第二部 (2024) [tmdbid=693134]");
});

test("改判类型：被当成花絮的正片改判成正片就按集排；正片改判成花絮进 extras/，没改判的照旧", () => {
  // 放在花絮目录里的一集：规则按花絮算
  const paths = ["inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv", "inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv", "inbox/BEEF.S01.1080p/Featurettes/BEEF.S01E03.1080p.WEB-DL.mkv"];
  const byDefault = plan(paths, beef).items;
  assert.equal(byDefault.find((i) => i.srcPath.includes("Featurettes/"))!.dstPath, "怒呛人生 (2023) [tmdbid=153312]/extras/BEEF.S01E03.1080p.WEB-DL.mkv", "花絮目录里的按花絮");
  const kinds = new Map<string, "video" | "extra">([
    ["inbox/BEEF.S01.1080p/Featurettes/BEEF.S01E03.1080p.WEB-DL.mkv", "video"],
    ["inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv", "extra"],
  ]);
  const { items } = plan(paths, beef, { kinds });
  const dst = (n: string) => items.find((i) => i.srcPath.endsWith(n))!;
  assert.equal(dst("Featurettes/BEEF.S01E03.1080p.WEB-DL.mkv").dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E03.mkv", "改判成正片：按集命名");
  assert.equal(dst("S01E02.1080p.WEB-DL.mkv").dstPath, "怒呛人生 (2023) [tmdbid=153312]/extras/BEEF.S01E02.1080p.WEB-DL.mkv", "改判成花絮：进 extras/");
  assert.equal(dst("S01E02.1080p.WEB-DL.mkv").reason, "按花絮处理（人改判的）");
  assert.equal(dst("S01E01.1080p.WEB-DL.mkv").dstPath, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
});
