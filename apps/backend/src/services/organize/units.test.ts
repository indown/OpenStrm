/**
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/units.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRules } from "./rules.js";
import { buildUnits, type ScopeEntry } from "./units.js";

const videoExts = new Set([".mkv", ".mp4"]);
const files = (paths: string[]): ScopeEntry[] => paths.map((p, i) => ({ path: p, isDir: false, id: `n${i}` }));
const opts = { scopePath: "", taskRootName: "tv", videoExts, rules: [] as ReturnType<typeof parseRules>["rules"] };

test("一部剧一个目录：季目录归上一级，字幕 / nfo 跟着走", () => {
  const units = buildUnits(
    files([
      "怒呛人生/Season 1/BEEF.S01E01.1080p.WEB-DL.mkv",
      "怒呛人生/Season 1/BEEF.S01E01.1080p.WEB-DL.chs.srt",
      "怒呛人生/Season 1/BEEF.S01E02.1080p.WEB-DL.mkv",
      "怒呛人生/tvshow.nfo",
      "怒呛人生/poster.jpg",
    ]),
    opts,
  );
  assert.equal(units.length, 1);
  const u = units[0];
  assert.equal(u.rootPath, "怒呛人生");
  assert.equal(u.parsed.title, "怒呛人生");
  assert.equal(u.kindHint, "tv");
  assert.equal(u.files.length, 5);
  const ep1 = u.files.find((f) => f.name === "BEEF.S01E01.1080p.WEB-DL.mkv")!;
  assert.equal(ep1.seasonFromDir, 1);
  assert.equal(ep1.parsed.episode, 1);
  const sub = u.files.find((f) => f.kind === "subtitle")!;
  assert.equal(sub.parsed.subtitleLang, "zh-CN");
});

test("电影目录：一个视频没有集标记就是电影；同名多版本也是电影", () => {
  const units = buildUnits(
    files([
      "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv",
      "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX/Dune.Part.Two.2024.1080p.WEB-DL.mkv",
      "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX/sample.mkv",
    ]),
    { ...opts, taskRootName: "movie" },
  );
  assert.equal(units.length, 1);
  assert.equal(units[0].kindHint, "movie");
  assert.equal(units[0].parsed.title, "Dune Part Two");
  assert.equal(units[0].parsed.year, "2024");
  assert.equal(units[0].multiVersion, 2, "sample 不算正片：两个版本，不是三个");
  const sample = units[0].files.find((f) => f.name === "sample.mkv")!;
  assert.equal(sample.parsed.isExtra, true, "sample 留在单元里当花絮，整理时和花絮一个去向");
  // 目录里只有 sample：成不了单元
  assert.equal(buildUnits(files(["Some.Movie.2020.1080p/sample.mkv"]), { ...opts, taskRootName: "movie" }).length, 0);
});

test("扁平的电影堆：按标题拆成多个单元；字幕按同名前缀跟着视频", () => {
  const units = buildUnits(
    files([
      "dump/Avatar.2009.1080p.BluRay.mkv",
      "dump/Avatar.2009.1080p.BluRay.chs.srt",
      "dump/Inception.2010.1080p.BluRay.mkv",
      "dump/readme.txt",
    ]),
    opts,
  );
  assert.equal(units.length, 2);
  const avatar = units.find((u) => u.parsed.title === "Avatar")!;
  assert.equal(avatar.rootPath, "dump");
  assert.equal(avatar.files.length, 2);
  assert.equal(avatar.kindHint, "movie");
  assert.ok(units.every((u) => !u.files.some((f) => f.name === "readme.txt")), "跟不上视频的杂项不进单元");
});

test("任务根直接放集（字幕组风格）：范围名当标题，绝对集数", () => {
  const units = buildUnits(
    files(["[Nekomoe kissaten][Sousou no Frieren][01][1080p][JPSC].mp4", "[Nekomoe kissaten][Sousou no Frieren][02][1080p][JPSC].mp4"]),
    { ...opts, taskRootName: "inbox" },
  );
  assert.equal(units.length, 1);
  assert.equal(units[0].rootPath, "");
  assert.equal(units[0].parsed.title, "Sousou no Frieren", "任务根叫 inbox，解析不出作品，退回文件标题");
  assert.equal(units[0].kindHint, "tv");
  assert.equal(units[0].files[0].parsed.absolute, 1);
});

test("花絮目录里的文件归上一级并标记；库类型先验给没有标记的单元定类型", () => {
  const units = buildUnits(files(["Show (2020)/Featurettes/making.mkv", "Show (2020)/S01E01.mkv"]), opts);
  assert.equal(units.length, 1);
  const extra = units[0].files.find((f) => f.name === "making.mkv")!;
  assert.equal(extra.inExtrasDir, true);
  const movies = buildUnits(files(["Some Title/Some.Title.mkv", "Some Title/Some.Title.CD2.mkv"]), { ...opts, libraryType: "movie" });
  assert.equal(movies[0].kindHint, "movie");
});

test("识别词：直指 tmdbid 挂在单元上，屏蔽词先于解析", () => {
  const { rules } = parseRules(["某某剧 第二部 => {[tmdbid=95396;type=tv;s=2]}", "高清剧集"]);
  const units = buildUnits(files(["【高清剧集】某某剧 第二部/01.mkv", "【高清剧集】某某剧 第二部/02.mkv"]), { ...opts, rules });
  assert.equal(units.length, 1);
  assert.deepEqual(units[0].direct, { tmdbId: 95396, mediaType: "tv", season: 2 });
  assert.equal(units[0].kindHint, "tv");
});

test("季目录里标题后面直接跟集数（我和僵尸有个约会01 … 33）：补零和不补零的都当集数，一个单元", () => {
  const units = buildUnits(
    files([
      "我和僵尸有个约会/184445.jpg",
      "我和僵尸有个约会/season1/我和僵尸有个约会01.mp4",
      "我和僵尸有个约会/season1/我和僵尸有个约会09.mp4",
      "我和僵尸有个约会/season1/我和僵尸有个约会10.mp4",
      "我和僵尸有个约会/season1/我和僵尸有个约会33.mp4",
      "我和僵尸有个约会/season1/我和僵尸有个约会33.chs.srt",
      "我和僵尸有个约会/season2/我和僵尸有个约会2.EP01.mp4",
    ]),
    opts,
  );
  assert.equal(units.length, 1);
  const u = units[0];
  assert.equal(u.parsed.title, "我和僵尸有个约会");
  assert.equal(u.kindHint, "tv");
  const f = (name: string) => u.files.find((x) => x.name === name)!;
  const eps = ["我和僵尸有个约会01.mp4", "我和僵尸有个约会09.mp4", "我和僵尸有个约会10.mp4", "我和僵尸有个约会33.mp4"].map((n) => [f(n).seasonFromDir, f(n).parsed.absolute]);
  assert.deepEqual(eps, [[1, 1], [1, 9], [1, 10], [1, 33]]);
  assert.equal(f("我和僵尸有个约会10.mp4").parsed.title, "我和僵尸有个约会", "尾巴数字从标题里拿掉");
  assert.equal(f("我和僵尸有个约会33.chs.srt").parsed.absolute, 33, "字幕也一样认");
  assert.deepEqual([f("我和僵尸有个约会2.EP01.mp4").seasonFromDir, f("我和僵尸有个约会2.EP01.mp4").parsed.absolute], [2, 1]);
});

test("平铺目录：补零的集数带出不补零的同名兄弟；剧集库里同名兄弟也算；电影系列（叶问1 … 叶问4）照旧按标题拆", () => {
  const flat = buildUnits(files(["某剧/某剧01.mp4", "某剧/某剧09.mp4", "某剧/某剧10.mp4", "某剧/某剧12.mp4"]), opts);
  assert.equal(flat.length, 1);
  assert.equal(flat[0].kindHint, "tv");
  assert.deepEqual(flat[0].files.map((x) => x.parsed.absolute), [1, 9, 10, 12]);
  const tvLib = buildUnits(files(["某剧/某剧1.mp4", "某剧/某剧2.mp4"]), { ...opts, libraryType: "tv" });
  assert.equal(tvLib.length, 1);
  assert.deepEqual(tvLib[0].files.map((x) => x.parsed.absolute), [1, 2]);
  const movies = buildUnits(files(["叶问系列/叶问1.mkv", "叶问系列/叶问2.mkv", "叶问系列/叶问3.mkv", "叶问系列/叶问4.mkv"]), opts);
  assert.deepEqual(movies.map((x) => x.parsed.title).sort(), ["叶问1", "叶问2", "叶问3", "叶问4"]);
  assert.ok(movies.every((x) => x.kindHint === "movie"));
});

test("文件名整个就是数字（遮天/129 4K.mp4）：在剧目录里当集数，一部剧一个单元；电影的数字片名不动", () => {
  const units = buildUnits(files(["遮天/129 4K.mp4", "遮天/130 4K.mp4", "遮天/131 4K.mp4", "遮天/131 4K.srt"]), opts);
  assert.equal(units.length, 1, "三集是同一部剧，不是三部电影");
  assert.equal(units[0].parsed.title, "遮天", "片名从目录名来");
  assert.equal(units[0].kindHint, "tv");
  assert.deepEqual(units[0].files.map((x) => x.parsed.absolute), [129, 130, 131, 131], "字幕也一样认");
  assert.equal(units[0].files[0].parsed.tags.resolution, "4K", "画质标签留着");
  const scoped = buildUnits(files(["遮天/129 4K.mp4"]), { ...opts, scopePath: "遮天" });
  assert.deepEqual([scoped[0].parsed.title, scoped[0].files[0].parsed.absolute], ["遮天", 129], "范围直接选剧目录也一样");
  const season = buildUnits(files(["某剧/Season 2/129 4K.mp4"]), opts);
  assert.deepEqual([season[0].files[0].seasonFromDir, season[0].files[0].parsed.absolute], [2, 129]);
  const movie = buildUnits(files(["1917 (2019)/1917 4K.mkv"]), opts);
  assert.deepEqual([movie[0].parsed.title, movie[0].kindHint, movie[0].files[0].parsed.absolute], ["1917", "movie", undefined], "目录名就是这个数字：电影");
  const atRoot = buildUnits(files(["129 4K.mp4", "130 4K.mp4"]), opts);
  assert.deepEqual(atRoot.map((u) => u.kindHint), ["movie", "movie"], "任务根的名字不是作品名，散在根上的照旧按电影认");
  const movieLib = buildUnits(files(["某目录/129 4K.mp4"]), { ...opts, libraryType: "movie" });
  assert.equal(movieLib[0].files[0].parsed.title, "129", "电影库不拿数字当集数");
  const y = buildUnits(files(["某剧/1917 2019 1080p.mkv"]), opts);
  assert.equal(y[0].files[0].parsed.title, "1917", "四位数 / 名字里带年份的不当集数");
});

test("目录名只是个版本词（导演剪辑版）：不拿它当片名，按文件名认", () => {
  const units = buildUnits(files(["凡人修仙传/导演剪辑版/虚天战纪 导演剪辑版（下）.mp4"]), opts);
  assert.equal(units.length, 1);
  assert.equal(units[0].parsed.title, "虚天战纪", "不是《导演剪辑版》那部电影");
  assert.equal(units[0].files[0].parsed.edition, "导演剪辑版");
});

test("文件名夹着零宽空格：集数照样认出来，不会当成同一部电影的多个版本；网盘上的名字不动", () => {
  const zw = (ep: string) => `回家的诱惑/回家的诱惑.2011.S01E\u200B${ep}\u200B.mp4`;
  const units = buildUnits(files([zw("36"), zw("37")]), opts);
  assert.equal(units.length, 1);
  assert.equal(units[0].kindHint, "tv");
  assert.equal(units[0].multiVersion, undefined);
  assert.equal(units[0].parsed.year, "2011");
  assert.deepEqual(units[0].files.map((x) => [x.parsed.season, x.parsed.episode]), [[1, 36], [1, 37]]);
  assert.equal(units[0].files[0].path, zw("36"));
});

test("范围直接选在季目录上：单元根还是上一级的剧目录，季号从范围目录名来；任务根本身是季目录也认季号；普通范围不往上走", () => {
  const season2 = buildUnits(files(["我和僵尸有个约会/season2/我和僵尸有个约会2.EP01.mp4", "我和僵尸有个约会/season2/我和僵尸有个约会2.EP02.mp4"]), { ...opts, scopePath: "我和僵尸有个约会/season2" });
  assert.equal(season2.length, 1);
  assert.equal(season2[0].rootPath, "我和僵尸有个约会");
  assert.equal(season2[0].parsed.title, "我和僵尸有个约会", "标题按剧目录认，不用文件里的「我和僵尸有个约会2」");
  assert.equal(season2[0].kindHint, "tv");
  assert.deepEqual(season2[0].files.map((x) => [x.seasonFromDir, x.parsed.absolute]), [[2, 1], [2, 2]]);
  const glued = buildUnits(files(["我和僵尸有个约会/season1/我和僵尸有个约会10.mp4"]), { ...opts, scopePath: "我和僵尸有个约会/season1" });
  assert.deepEqual([glued[0].files[0].seasonFromDir, glued[0].files[0].parsed.absolute], [1, 10], "季目录里不补零的尾巴数字照样当集数");
  const specials = buildUnits(files(["某剧 (2020)/Specials/某剧 SP01.mkv"]), { ...opts, scopePath: "某剧 (2020)/Specials" });
  assert.deepEqual([specials[0].rootPath, specials[0].files[0].seasonFromDir], ["某剧 (2020)", 0]);
  const taskRoot = buildUnits(files(["某剧.E01.mkv", "某剧.E02.mkv"]), { ...opts, taskRootName: "Season 2" });
  assert.deepEqual(taskRoot[0].files.map((x) => x.seasonFromDir), [2, 2], "任务直接建在季目录上");
  const plain = buildUnits(files(["inbox/某剧.E01.mkv"]), { ...opts, scopePath: "inbox" });
  assert.equal(plain[0].rootPath, "inbox", "普通的范围目录还是不往上走");
});

test("艺术图目录（extrafanart / extrathumbs / .actors）归上一级；ownsDir：任务根、范围根名字对不上、拆出来的单元都不算", () => {
  const art = buildUnits(files(["某剧 (2020)/Season 1/某剧.S01E01.mkv", "某剧 (2020)/extrafanart/fanart1.jpg", "某剧 (2020)/.actors/某演员.jpg"]), opts);
  assert.equal(art.length, 1);
  assert.equal(art[0].files.find((x) => x.name === "fanart1.jpg")!.artDir, "extrafanart");
  assert.equal(art[0].files.find((x) => x.name === "某演员.jpg")!.artDir, ".actors");
  assert.equal(art[0].ownsDir, true);
  assert.equal(buildUnits(files(["inbox/BEEF.S01E01.mkv", "inbox/random.jpg"]), { ...opts, scopePath: "inbox" })[0].ownsDir, false, "范围根叫 inbox，不是这部作品的目录");
  assert.equal(buildUnits(files(["我和僵尸有个约会/我和僵尸有个约会01.mp4", "我和僵尸有个约会/184445.jpg"]), { ...opts, scopePath: "我和僵尸有个约会" })[0].ownsDir, true, "范围根的名字就是这部剧");
  assert.equal(buildUnits(files(["BEEF.S01E01.mkv"]), opts)[0].ownsDir, false, "任务根");
  assert.ok(buildUnits(files(["dump/Avatar.2009.1080p.mkv", "dump/Inception.2010.1080p.mkv"]), opts).every((u) => !u.ownsDir), "从大目录里拆出来的");
});

test("多个范围：每个范围照单一范围的规则来——两个季目录范围并回同一部剧，收件箱范围里的散文件按标题拆", () => {
  const units = buildUnits(
    files([
      "我和僵尸有个约会/season1/我和僵尸有个约会01.mp4",
      "我和僵尸有个约会/season1/我和僵尸有个约会02.mp4",
      "我和僵尸有个约会/season2/我和僵尸有个约会2.EP01.mp4",
      "inbox/Avatar.2009.1080p.mkv",
      "inbox/Inception.2010.1080p.mkv",
    ]),
    { ...opts, scopes: ["我和僵尸有个约会/season1", "我和僵尸有个约会/season2", "inbox"] },
  );
  const show = units.filter((u) => u.rootPath === "我和僵尸有个约会");
  assert.equal(show.length, 1, "两个季目录范围的单元根都越到剧目录，并成一部剧");
  assert.deepEqual(show[0].files.map((f) => f.seasonFromDir).sort(), [1, 1, 2]);
  const inbox = units.filter((u) => u.rootPath === "inbox");
  assert.deepEqual(inbox.map((u) => u.parsed.title).sort(), ["Avatar", "Inception"], "范围根的名字（inbox）不当标题，按文件标题拆");
});

test("范围直接选在「某剧 第二季」上、文件名带片名：标题用文件的，文件没写季就用目录名里的季；tv / inbox 这种范围照旧", () => {
  const names = ["我和僵尸有个约会 第二季/我和僵尸有个约会.EP01.mkv", "我和僵尸有个约会 第二季/我和僵尸有个约会.EP02.mkv"];
  const [scoped] = buildUnits(files(names), { ...opts, scopePath: "我和僵尸有个约会 第二季" });
  assert.equal(scoped.parsed.title, "我和僵尸有个约会");
  assert.equal(scoped.parsed.season, 2, "目录名里的季");
  const [auto] = buildUnits(files(names), { ...opts, scopes: [""] });
  assert.equal(auto.parsed.season, 2, "自动整理按新增路径走时本来就认得，两边一致");
  const [inbox] = buildUnits(files(["inbox/我和僵尸有个约会.EP01.mkv", "inbox/我和僵尸有个约会.EP02.mkv"]), { ...opts, scopePath: "inbox" });
  assert.equal(inbox.parsed.season, undefined, "范围目录名里没有季");
});
