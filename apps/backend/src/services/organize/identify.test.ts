/**
 * 识别的打分和置信度：TMDB 换成内存桩。
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/identify.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TmdbDetails, TmdbEpisode, TmdbSearchResult } from "../tmdb.js";
import { identifyUnit, type TmdbApi } from "./identify.js";
import { normalizeTitle } from "./parse-name.js";
import { buildUnits, type ScopeEntry } from "./units.js";

const videoExts = new Set([".mkv"]);
const unitOf = (paths: string[], taskRootName = "root") =>
  buildUnits(paths.map((p, i): ScopeEntry => ({ path: p, isDir: false, id: `n${i}` })), { scopePath: "", taskRootName, videoExts, rules: [] })[0];

const hit = (id: number, mediaType: "movie" | "tv", title: string, year: string, originalTitle?: string, popularity?: number): TmdbSearchResult => ({
  id,
  mediaType,
  title,
  year,
  originalTitle,
  posterUrl: "",
  overview: "",
  ...(popularity !== undefined ? { popularity } : {}),
});

/** 直接给标题候选和年份的单元（影库那种：候选是切单元时补好的） */
const titlesUnit = (titles: string[], year?: string, kindHint: "movie" | "tv" | "unknown" = "movie") => ({
  ...unitOf(["x.mkv"]),
  kindHint,
  parsed: { title: titles[0], titles, ...(year ? { year } : {}), tags: {} },
});

class StubTmdb implements TmdbApi {
  readonly calls: string[] = [];
  constructor(
    private readonly results: Record<string, TmdbSearchResult[]>,
    private readonly detailsMap: Record<string, Partial<TmdbDetails>> = {},
  ) {}
  async search(query: string, kind: "movie" | "tv" | "multi", year?: string): Promise<TmdbSearchResult[]> {
    this.calls.push(`search ${kind} ${query}${year ? ` ${year}` : ""}`);
    return this.results[query.toLowerCase()] ?? [];
  }
  async details(kind: "movie" | "tv", id: number): Promise<TmdbDetails | null> {
    this.calls.push(`details ${kind} ${id}`);
    const d = this.detailsMap[`${kind}:${id}`];
    if (!d) return null;
    return { id, mediaType: kind, title: "", originalTitle: "", enTitle: "", year: "", posterUrl: "", imdbId: "", genreIds: [], countries: [], originalLanguage: "", aliases: [], ...d };
  }
  async season(): Promise<TmdbEpisode[]> {
    this.calls.push("season");
    return [{ episode: 1, name: "飞鸟不鸣" }];
  }
}

test("标题归一化：大小写、标点、全角、开头的 the", () => {
  assert.equal(normalizeTitle("The Lord of the Rings"), "lordoftherings");
  assert.equal(normalizeTitle("沙丘：第二部"), normalizeTitle("沙丘:第二部"));
  assert.equal(normalizeTitle("Dune: Part Two"), "duneparttwo");
});

test("标题和年份都对上是 high；标题对上年份缺是 medium；只是最像是 low", async () => {
  const tmdb = new StubTmdb(
    { beef: [hit(153312, "tv", "BEEF", "2023"), hit(1, "tv", "Beef Wars", "2010")] },
    { "tv:153312": { title: "怒呛人生", originalTitle: "BEEF", year: "2023", seasons: [{ season: 1, episodeCount: 10 }] } },
  );
  const high = await identifyUnit({ unit: unitOf(["BEEF.2023.S01E01.mkv"]), evidence: {}, episodeTitles: false }, tmdb);
  assert.equal(high.match?.confidence, "high");
  assert.equal(high.match?.title, "怒呛人生");
  assert.equal(high.match?.candidates?.length, 2);
  const medium = await identifyUnit({ unit: unitOf(["BEEF.S01E01.mkv"]), evidence: {}, episodeTitles: false }, tmdb);
  assert.equal(medium.match?.confidence, "medium");
  const low = await identifyUnit({ unit: unitOf(["Beef Wars 2 S01E01.mkv"]), evidence: {}, episodeTitles: false }, new StubTmdb({ "beef wars 2": [hit(1, "tv", "Beef Wars", "2010")] }, { "tv:1": { title: "Beef Wars" } }));
  assert.equal(low.match?.confidence, "low");
});

test("搜索结果的标题是译名时按原名对：Dune Part Two 不会被同名花絮抢走", async () => {
  const tmdb = new StubTmdb(
    { "dune part two": [hit(1765119, "movie", "Dune: Part Two - An Ensemble for the Ages", "2024", "Dune: Part Two - An Ensemble for the Ages"), hit(693134, "movie", "沙丘：第二部", "2024", "Dune: Part Two")] },
    { "movie:693134": { title: "沙丘：第二部", originalTitle: "Dune: Part Two", year: "2024" }, "movie:1765119": { title: "Dune: Part Two - An Ensemble for the Ages", year: "2024" } },
  );
  const r = await identifyUnit({ unit: unitOf(["Dune.Part.Two.2024.2160p.WEB-DL.mkv"]), evidence: {}, episodeTitles: false }, tmdb);
  assert.equal(r.match?.tmdbId, 693134);
  assert.equal(r.match?.confidence, "high");
  assert.equal(r.match?.title, "沙丘：第二部");
});

test("标题和原名都对不上时看前几名的别名：第二名别名命中就选第二名", async () => {
  const tmdb = new StubTmdb(
    { beef: [hit(207503, "tv", "Celebrity Beef", "2022", "Celebrity Beef"), hit(153312, "tv", "怒呛人生", "2023", "怒呛人生")] },
    { "tv:207503": { title: "Celebrity Beef", year: "2022", aliases: [] }, "tv:153312": { title: "怒呛人生", originalTitle: "怒呛人生", year: "2023", aliases: ["BEEF"], seasons: [{ season: 1, episodeCount: 10 }] } },
  );
  const r = await identifyUnit({ unit: unitOf(["BEEF.S01E01.mkv"]), evidence: {}, episodeTitles: false }, tmdb);
  assert.equal(r.match?.tmdbId, 153312);
  assert.equal(r.match?.confidence, "medium");
  assert.equal(r.match?.reason, "别名对上，文件名里没有年份");
  const withYear = await identifyUnit({ unit: unitOf(["BEEF.2023.S01E01.mkv"]), evidence: {}, episodeTitles: false }, tmdb);
  assert.equal(withYear.match?.tmdbId, 153312);
  assert.equal(withYear.match?.confidence, "high");
});

test("证据优先：识别词直指 > 记忆 > 影库 / nfo，都不搜索", async () => {
  const tmdb = new StubTmdb({}, { "tv:7": { title: "直指" }, "movie:8": { title: "记忆" }, "tv:9": { title: "影库" } });
  const unit = unitOf(["Whatever.S01E01.mkv"]);
  const a = await identifyUnit({ unit: { ...unit, direct: { tmdbId: 7, mediaType: "tv" } }, evidence: {}, episodeTitles: false }, tmdb);
  assert.equal(a.match?.title, "直指");
  assert.equal(a.match?.reason, "识别词直接指定");
  const b = await identifyUnit({ unit, evidence: { memory: { accountName: "a", srcPath: "/x", mediaType: "movie", tmdbId: 8, title: "", year: "", season: null, episodeOffset: 0, titleOverride: "", yearOverride: "", updatedAt: 0 } }, episodeTitles: false }, tmdb);
  assert.equal(b.match?.title, "记忆");
  const c = await identifyUnit({ unit, evidence: { known: { tmdbId: 9, mediaType: "tv", source: "影库条目" } }, episodeTitles: false }, tmdb);
  assert.equal(c.match?.title, "影库");
  assert.ok(!tmdb.calls.some((x) => x.startsWith("search")), "有 id 证据就不搜索");
});

test("中英双名依次搜；别名对上也算；开了集标题就拉季", async () => {
  const tmdb = new StubTmdb(
    { 权力的游戏: [], "game of thrones": [hit(1399, "tv", "权力的游戏", "2011")] },
    { "tv:1399": { title: "权力的游戏", originalTitle: "Game of Thrones", year: "2011", aliases: ["冰与火之歌"], seasons: [{ season: 1, episodeCount: 10 }] } },
  );
  const r = await identifyUnit({ unit: unitOf(["权力的游戏.Game.of.Thrones.2011.S01E01.mkv"]), evidence: {}, episodeTitles: true }, tmdb);
  assert.equal(r.match?.tmdbId, 1399);
  assert.equal(r.match?.confidence, "high");
  assert.equal(r.episodeTitles.get("1:1"), "飞鸟不鸣");
  assert.ok(tmdb.calls.includes("search tv 权力的游戏 2011"));
  assert.ok(tmdb.calls.includes("search tv Game of Thrones 2011"));
});

test("搜不到：none", async () => {
  const r = await identifyUnit({ unit: unitOf(["Nothing.Here.S01E01.mkv"]), evidence: {}, episodeTitles: false }, new StubTmdb({}));
  assert.equal(r.match, null);
});

test("nfo 证据要和 TMDB 详情的标题对得上：对不上不采用、留提示，接着试下一条证据或去搜", async () => {
  const tmdb = new StubTmdb(
    { beef: [hit(153312, "tv", "BEEF", "2023")] },
    { "tv:40477": { title: "某部别的剧", originalTitle: "Something Else" }, "tv:153312": { title: "怒呛人生", originalTitle: "BEEF", year: "2023" }, "tv:9": { title: "影库" } },
  );
  const unit = unitOf(["BEEF.S01E01.mkv"]);
  const wrong = { tmdbId: 40477, mediaType: "tv" as const, source: "本地 tvshow.nfo 里的 tmdbid", titles: ["怒呛人生", "BEEF"] };
  const searched = await identifyUnit({ unit, evidence: { known: [wrong] }, episodeTitles: false }, tmdb);
  assert.equal(searched.match?.tmdbId, 153312, "弃用之后按搜索认");
  assert.equal(searched.match?.reason, "标题对上，文件名里没有年份");
  assert.deepEqual(searched.notes, ["本地 tvshow.nfo 里的 tmdbid（40477）在 TMDB 上是「某部别的剧」，和 nfo 里写的标题对不上，没采用"]);
  const next = await identifyUnit({ unit, evidence: { known: [null, wrong, { tmdbId: 9, mediaType: "tv", source: "影库条目" }] }, episodeTitles: false }, tmdb);
  assert.equal(next.match?.title, "影库", "第一条弃用后用下一条");
  const right = await identifyUnit({ unit, evidence: { known: { ...wrong, tmdbId: 153312 } }, episodeTitles: false }, tmdb);
  assert.deepEqual([right.match?.tmdbId, right.match?.confidence, right.match?.reason], [153312, "high", "本地 tvshow.nfo 里的 tmdbid"]);
  assert.deepEqual(right.notes, []);
  const missing = await identifyUnit({ unit, evidence: { known: [{ tmdbId: 123, mediaType: "tv", source: "目录名里的 tmdbid 标签" }] }, episodeTitles: false }, tmdb);
  assert.equal(missing.match?.tmdbId, 153312, "TMDB 上没有这个 id：去搜");
  assert.deepEqual(missing.notes, ["目录名里的 tmdbid 标签（123）在 TMDB 上找不到，没采用"]);
});

test("分集 nfo 里的剧 id 没写剧名：拿单元的标题核对", async () => {
  const tmdb = new StubTmdb({}, { "tv:42009": { title: "黑镜", originalTitle: "Black Mirror" } });
  const ep = { tmdbId: 42009, mediaType: "tv" as const, source: "本地 x.nfo 里的 tmdbid", titles: [], strict: true };
  const ok = await identifyUnit({ unit: unitOf(["黑镜 (2011)/Season 7/黑镜 - S07E01.mkv"]), evidence: { known: ep }, episodeTitles: false }, tmdb);
  assert.equal(ok.match?.tmdbId, 42009);
  const bad = await identifyUnit({ unit: unitOf(["某剧/Season 1/某剧 - S01E01.mkv"]), evidence: { known: ep }, episodeTitles: false }, tmdb);
  assert.equal(bad.match, null, "对不上：不采用，也搜不到");
  assert.deepEqual(bad.notes, ["本地 x.nfo 里的 tmdbid（42009）在 TMDB 上是「黑镜」，和目录名对不上，没采用"]);
});

test("主标题对上也算标题对上：「碟中谍5」对《碟中谍5：神秘国度》；同分时它对上的候选更具体（「碟中谍5」⊃「碟中谍」）就排在整个标题对上的前面", async () => {
  const tmdb = new StubTmdb(
    {
      碟中谍5: [hit(177677, "movie", "碟中谍5：神秘国度", "2015", "Mission: Impossible - Rogue Nation", 30)],
      // 第一部热门得多也不换：「碟中谍5」对上的更具体
      碟中谍: [hit(954, "movie", "碟中谍", "1996", "Mission: Impossible", 400), hit(177677, "movie", "碟中谍5：神秘国度", "2015", "Mission: Impossible - Rogue Nation", 30)],
    },
    { "movie:177677": { title: "碟中谍5：神秘国度", year: "2015" } },
  );
  const r = await identifyUnit({ unit: titlesUnit(["碟中谍5", "碟中谍"]), evidence: {}, episodeTitles: false, maxTitles: 5, strictStop: true }, tmdb);
  assert.equal(r.match?.tmdbId, 177677);
  assert.equal(r.match?.confidence, "medium", "标题对上、没有年份");
});

test("跨年上映：中文名、英文名都对上的那部压过年份更「准」、只对上英文名的同名冷门片（撞车 2004 ↔ 2005、爱我 2024 ↔ 2025）", async () => {
  const tmdb = new StubTmdb(
    {
      撞车: [hit(1640, "movie", "撞车", "2005", "Crash", 10.6)],
      // 同名同年的冷门片还不止一部，真正那部排第三
      crash: [hit(1353802, "movie", "Crash", "2004", "Crash", 1.2), hit(1319271, "movie", "Crash", "2004", "Crash", 0.5), hit(1640, "movie", "撞车", "2005", "Crash", 10.6)],
    },
    { "movie:1640": { title: "撞车", originalTitle: "Crash", year: "2005" } },
  );
  const r = await identifyUnit({ unit: titlesUnit(["撞车", "Crash"], "2004"), evidence: {}, episodeTitles: false, maxTitles: 5, strictStop: true }, tmdb);
  assert.equal(r.match?.tmdbId, 1640);
  assert.equal(r.match?.confidence, "medium", "年份差一年");
  // 热度只差两倍也认得出（靠两个名字，不靠热度）
  const love = new StubTmdb(
    { 爱我: [hit(881415, "movie", "爱我", "2025", "Love Me", 3.7)], "love me": [hit(881415, "movie", "爱我", "2025", "Love Me", 3.7), hit(763325, "movie", "Love Me", "2024", "Love Me", 1.8)] },
    { "movie:881415": { title: "爱我", originalTitle: "Love Me", year: "2025" } },
  );
  const r2 = await identifyUnit({ unit: titlesUnit(["爱我", "Love Me"], "2024"), evidence: {}, episodeTitles: false, maxTitles: 5, strictStop: true }, love);
  assert.equal(r2.match?.tmdbId, 881415);
});

test("跨年上映、只有一个名字：领先不到一分的里面热门得多（比前面的都热门 5 倍以上）的挑回来；标题对不上的不换", async () => {
  const tmdb = new StubTmdb(
    { 撞车: [hit(1353802, "movie", "撞车", "2004", "", 1.2), hit(1319271, "movie", "撞车", "2004", "", 0.5), hit(1640, "movie", "撞车", "2005", "Crash", 10.6)] },
    { "movie:1640": { title: "撞车", originalTitle: "Crash", year: "2005" } },
  );
  const r = await identifyUnit({ unit: titlesUnit(["撞车"], "2004"), evidence: {}, episodeTitles: false }, tmdb);
  assert.equal(r.match?.tmdbId, 1640);
  const off = new StubTmdb({ crash: [hit(1353802, "movie", "Crash", "2004", "Crash", 0.6), hit(9, "movie", "Crash Course", "2005", "Crash Course", 30)] }, { "movie:1353802": { title: "Crash", year: "2004" } });
  const r2 = await identifyUnit({ unit: titlesUnit(["Crash"], "2004"), evidence: {}, episodeTitles: false }, off);
  assert.equal(r2.match?.tmdbId, 1353802);
});

test("主标题只拿第一个候选对：后面补的演员名 / 系列名对不上《李小龙：遗失的访谈》《蝙蝠侠：漫长的万圣节》", async () => {
  const tmdb = new StubTmdb(
    {
      李小龙: [hit(115955, "movie", "李小龙：遗失的访谈", "1971", "Bruce Lee: The Lost Interview", 1)],
      唐山大兄: [hit(12481, "movie", "唐山大兄", "1971", "唐山大兄", 6.2)],
    },
    { "movie:12481": { title: "唐山大兄", year: "1971" } },
  );
  const r = await identifyUnit({ unit: titlesUnit(["李小龙 唐山大兄", "李小龙", "唐山大兄"], "1971"), evidence: {}, episodeTitles: false, maxTitles: 5, strictStop: true }, tmdb);
  assert.equal(r.match?.tmdbId, 12481);
  assert.equal(r.match?.confidence, "high");
  const bat = new StubTmdb(
    { 蝙蝠侠: [hit(414906, "movie", "新蝙蝠侠", "2022", "The Batman", 43), hit(1010830, "movie", "蝙蝠侠：漫长的万圣节", "2022", "Batman: The Long Halloween Deluxe Edition", 5)] },
    {
      "movie:414906": { title: "新蝙蝠侠", originalTitle: "The Batman", year: "2022", aliases: ["Betmen", "Batman"] },
      "movie:1010830": { title: "蝙蝠侠：漫长的万圣节", originalTitle: "Batman: The Long Halloween Deluxe Edition", year: "2022" },
    },
  );
  const r2 = await identifyUnit({ unit: titlesUnit(["蝙蝠侠 新2022", "蝙蝠侠", "新2022", "The Betmen"], "2022"), evidence: {}, episodeTitles: false, maxTitles: 5, strictStop: true }, bat);
  assert.equal(r2.match?.tmdbId, 414906);
  assert.equal(r2.match?.reason, "别名和年份都对上");
});

test("只对上主标题的让给整个标题对上的（《龙之家族：幕后特辑》让给原名 House of the Dragon 的那部）；只有中文名时看别名", async () => {
  const both = new StubTmdb(
    {
      龙之家族: [hit(325709, "tv", "龙之家族：幕后特辑", "2024", "House of the Dragon: The House That Dragons Built", 13.7), hit(94997, "tv", "权力的游戏前传：龙族", "2022", "House of the Dragon", 127)],
      "house of the dragon": [hit(94997, "tv", "权力的游戏前传：龙族", "2022", "House of the Dragon", 127), hit(325709, "tv", "龙之家族：幕后特辑", "2024", "House of the Dragon: The House That Dragons Built", 13.7)],
    },
    { "tv:94997": { title: "权力的游戏前传：龙族", originalTitle: "House of the Dragon", year: "2022", aliases: ["龙之家族"] } },
  );
  const r = await identifyUnit({ unit: titlesUnit(["龙之家族", "House of the Dragon"], undefined, "tv"), evidence: {}, episodeTitles: false, maxTitles: 5, strictStop: true }, both);
  assert.equal(r.match?.tmdbId, 94997);
  const r2 = await identifyUnit({ unit: titlesUnit(["龙之家族"], undefined, "tv"), evidence: {}, episodeTitles: false, maxTitles: 5, strictStop: true }, both);
  assert.equal(r2.match?.tmdbId, 94997);
  assert.equal(r2.match?.reason, "别名对上，文件名里没有年份");
});

test("中文名对上主标题、英文名对上原名：两个名字都对上，压过只对上中文名的同名冷门条目（小丑2）", async () => {
  const tmdb = new StubTmdb(
    { 小丑2: [hit(1522023, "movie", "小丑2", "2024", "Joker 2", 0.3), hit(889737, "movie", "小丑2: 双重妄想", "2024", "Joker: Folie à Deux", 21)] },
    { "movie:889737": { title: "小丑2: 双重妄想", originalTitle: "Joker: Folie à Deux", year: "2024" } },
  );
  const r = await identifyUnit({ unit: titlesUnit(["小丑2", "Joker Folie à Deux"]), evidence: {}, episodeTitles: false, maxTitles: 5, strictStop: true }, tmdb);
  assert.equal(r.match?.tmdbId, 889737);
});

test("strictStop：标题一样但年份不对的不停，接着搜后面的候选（「2012 世界末日」→《2012》2009）", async () => {
  const tmdb = new StubTmdb(
    {
      "2012 世界末日": [hit(16266, "movie", "2012世界末日", "2008", "2012 Doomsday", 1)],
      "2012": [hit(14161, "movie", "2012", "2009", "2012", 40)],
    },
    { "movie:14161": { title: "2012", year: "2009" } },
  );
  const r = await identifyUnit({ unit: titlesUnit(["2012 世界末日", "2012"], "2009"), evidence: {}, episodeTitles: false, maxTitles: 5, strictStop: true }, tmdb);
  assert.equal(r.match?.tmdbId, 14161);
  assert.equal(r.match?.confidence, "high");
  assert.ok(tmdb.calls.some((c) => c.startsWith("search movie 2012 ")), "接着搜了第二个候选");
});

