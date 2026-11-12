/**
 * strm 管理页条目的纯函数：行的键、任务根去重、作品目录名、印章。
 *
 *   pnpm --filter @openstrm/frontend test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { distinctRoots, episodeStamp, extStamp, refKey, refOfKey, rootKey, seasonStamp, splitWorkName, workRootOf } from "./strm-entries";

test("refKey：任务和路径各算各的，路径里带分隔符样子的字符也不会撞；refOfKey 能原样拆回来", () => {
  assert.notEqual(refKey("a", "b/c"), refKey("a/b", "c"));
  assert.notEqual(refKey("t1", "Show"), refKey("t2", "Show"));
  assert.equal(refKey("t1", 'x","y'), refKey("t1", 'x","y'));
  assert.notEqual(refKey("t1", 'x","y'), refKey('t1","x', "y"));
  assert.deepEqual(refOfKey(refKey("t1", 'Show "A"/Season 1')), { taskId: "t1", path: 'Show "A"/Season 1' });
  assert.deepEqual(refOfKey(refKey("t1", "")), { taskId: "t1", path: "" });
});

test("rootKey / distinctRoots：写法不同的同一个本地目录算一个，只留第一个任务；数据目录根是空串", () => {
  assert.equal(rootKey("/media//tv/"), "media/tv");
  assert.equal(rootKey("./media/tv"), "media/tv");
  assert.equal(rootKey(""), "");
  assert.equal(rootKey("/"), "");
  const tasks = [
    { id: "a", targetPath: "tv" },
    { id: "b", targetPath: "/tv/" },
    { id: "c", targetPath: "movie" },
    { id: "d", targetPath: "tv/sub" },
  ];
  assert.deepEqual(
    distinctRoots(tasks).map((t) => t.id),
    ["a", "c", "d"],
    "嵌在里面的是另一个目录，照留",
  );
});

test("workRootOf：路径里最靠后的带 id 标签的段；三种标签写法都认；不在作品里是 null", () => {
  assert.equal(workRootOf("辐射 (2024) [tmdbid=106379]/Season 02"), "辐射 (2024) [tmdbid=106379]");
  assert.equal(workRootOf("电影/Up (2009) {tmdb-14160}"), "电影/Up (2009) {tmdb-14160}");
  assert.equal(workRootOf("a [tmdbid-1]/b [tmdbid=2]/extras"), "a [tmdbid-1]/b [tmdbid=2]");
  assert.equal(workRootOf("电影/没整理过的"), null);
  assert.equal(workRootOf(""), null);
});

test("splitWorkName：去掉 id 标签，末尾括号里的年份单拿出来；拆不出名字的原样用", () => {
  assert.deepEqual(splitWorkName("辐射 (2024) [tmdbid=106379]"), { title: "辐射", year: "2024" });
  assert.deepEqual(splitWorkName("Up (2009) {tmdb-14160}"), { title: "Up", year: "2009" });
  assert.deepEqual(splitWorkName("Show [tmdbid=1] (2020)"), { title: "Show", year: "2020" });
  assert.deepEqual(splitWorkName("片名（2020）[imdbid=tt1234567]"), { title: "片名", year: "2020" });
  assert.deepEqual(splitWorkName("2024 (2021)"), { title: "2024", year: "2021" }, "片名本身是数字的，年份取括号里那个");
  assert.deepEqual(splitWorkName("Season 01"), { title: "Season 01" });
  assert.deepEqual(splitWorkName("(2024)"), { title: "(2024)" }, "只剩年份的不拆");
  assert.deepEqual(splitWorkName("[tmdbid=5]"), { title: "[tmdbid=5]" }, "只有标签的原样用");
  assert.deepEqual(splitWorkName("1917 (2019) - 导演剪辑版"), { title: "1917 (2019) - 导演剪辑版" }, "年份不在末尾的不动");
});

test("seasonStamp：季目录写成 S01 这种；特别篇和第 0 季是 SP；片名不算", () => {
  assert.equal(seasonStamp("Season 1"), "S01");
  assert.equal(seasonStamp("Season.02"), "S02");
  assert.equal(seasonStamp("season_12"), "S12");
  assert.equal(seasonStamp("Series 3"), "S03");
  assert.equal(seasonStamp("S01"), "S01");
  assert.equal(seasonStamp("Season 1（001-085）"), "S01", "后面带集数范围的也是季目录");
  assert.equal(seasonStamp("第二季"), "S02");
  assert.equal(seasonStamp("第 2 季"), "S02");
  assert.equal(seasonStamp("第十二季"), "S12");
  assert.equal(seasonStamp("第二十季"), "S20");
  assert.equal(seasonStamp("第一部"), "S01");
  assert.equal(seasonStamp("Specials"), "SP");
  assert.equal(seasonStamp("SP"), "SP");
  assert.equal(seasonStamp("番外篇"), "SP");
  assert.equal(seasonStamp("Season 00"), "SP");
  assert.equal(seasonStamp("S4 League"), null, "光一个 S 加数字开头的片名不是季目录");
  assert.equal(seasonStamp("S01E02"), null);
  assert.equal(seasonStamp("Season 2024"), null, "四位数不是季号");
  assert.equal(seasonStamp("Seasonal Fruits"), null);
  assert.equal(seasonStamp("extras"), null);
  assert.equal(seasonStamp("辐射 (2024) [tmdbid=106379]"), null);
});

test("episodeStamp：SxxEyy 拆成季和集，连着两集写成范围；只写集号的也认；编码 / 声道里的数字不算", () => {
  assert.deepEqual(episodeStamp("辐射 - S02E05.strm"), { season: "S02", episode: "E05" });
  assert.deepEqual(episodeStamp("Silo.S03E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.strm"), { season: "S03", episode: "E01" });
  assert.deepEqual(episodeStamp("Show - S01E01-E02.strm"), { season: "S01", episode: "E01-02" });
  assert.deepEqual(episodeStamp("show.s1e3.strm"), { season: "S01", episode: "E03" });
  assert.deepEqual(episodeStamp("海贼王 - S01E1024.strm"), { season: "S01", episode: "E1024" });
  assert.deepEqual(episodeStamp("Title EP05.strm"), { episode: "E05" });
  assert.deepEqual(episodeStamp("Title.E7.1080p.strm"), { episode: "E07" });
  assert.deepEqual(episodeStamp("第12集.strm"), { episode: "E12" });
  assert.equal(episodeStamp("雷霆特攻队 (2025) - 2160p.strm"), null);
  assert.equal(episodeStamp("Movie.2019.2160p.WEB-DL.DDP5.1.H.264.strm"), null);
  assert.equal(episodeStamp("tvshow.nfo"), null);
});

test("extStamp：扩展名大写、不带点；太长、没有、点开头的都回 null", () => {
  assert.equal(extStamp("tvshow.nfo"), "NFO");
  assert.equal(extStamp("ep1.zh-CN.ass"), "ASS");
  assert.equal(extStamp("x.part"), "PART");
  assert.equal(extStamp("poster.JPG"), "JPG");
  assert.equal(extStamp("README"), null);
  assert.equal(extStamp(".hidden"), null);
  assert.equal(extStamp("archive.torrent"), null, "超过四个字符印不下");
  assert.equal(extStamp("name."), null);
});
