/**
 * 海报墙视图的增量维护：每做一步变更，把增量维护出来的视图和丢掉重建的视图逐项比对。
 * 批量变动（重切、删单元、分享进出失效、删来源、换链接、全部重认）要让视图作废；只改 retryAt / 查分享时间这类不该动它。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/db/repositories/library-works-view.itest.ts
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { seedLibrarySource, unseedLibrarySource } from "../../test/library-seed.js";
import * as units from "./library-units.js";
import { updateShare } from "./library-shares.js";
import { getAll, remove, update } from "./media-library.js";
import { __test_viewBuilt, invalidateWorksView, worksView, type WorksView } from "./library-works-view.js";
import { listWorks } from "../../services/library/works.js";

const now = 1_800_000_000;

function built(unitKey: string, over: Partial<units.BuiltUnit> = {}): units.BuiltUnit {
  return {
    unitKey,
    nodeId: `n-${unitKey}`,
    path: `dir/${unitKey}`,
    rawName: unitKey,
    ownsDir: true,
    fileIds: [],
    parsedTitle: unitKey,
    parsedTitles: [unitKey],
    parsedYear: "2010",
    kindHint: "movie",
    seasons: [],
    videoCount: 1,
    size: 100,
    sampleFile: "a.mkv",
    ...over,
  };
}

function identified(tmdbId: number | null, mediaType: "movie" | "tv" | null = "movie", over: Partial<units.Identified> = {}): units.Identified {
  return {
    status: "done",
    tmdbId,
    mediaType,
    title: tmdbId == null ? "" : `作品 ${tmdbId}`,
    originalTitle: tmdbId == null ? "" : `Original ${tmdbId}`,
    enTitle: tmdbId == null ? "" : `English ${tmdbId}`,
    year: "2010",
    posterUrl: tmdbId == null ? "" : `https://img/${tmdbId}.jpg`,
    confidence: tmdbId == null ? "none" : "high",
    reason: "",
    candidates: [],
    aka: "",
    ...over,
  };
}

const byKey = <T>(entries: Iterable<[string, T]>) => [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

function snapshot(v: WorksView) {
  return {
    groups: byKey(v.groups.entries()),
    unidentified: byKey(v.unidentified.entries()).map(([k, u]) => [k, u.status, u.tmdbId, u.rawName]),
    counts: { ...v.counts },
    summaries: byKey(v.summaries.entries()),
  };
}

/** 增量维护的和重建的一样 */
function assertFresh(label: string) {
  const incremental = snapshot(worksView());
  invalidateWorksView();
  const rebuilt = snapshot(worksView());
  assert.deepEqual(incremental, rebuilt, label);
}

beforeEach(() => {
  for (const e of getAll()) unseedLibrarySource(e.id, e.shareCode);
  invalidateWorksView();
});

function seedTwoSources() {
  seedLibrarySource({ id: "A", shareCode: "ca", shareUrl: "https://115.com/s/ca", shareTitle: "包 A", files: { "a/x.mkv": 1 } });
  seedLibrarySource({ id: "B", shareCode: "cb", shareUrl: "https://115.com/s/cb", shareTitle: "包 B", files: { "b/y.mkv": 1 } });
  units.replaceUnits("A", [built("u1"), built("u2"), built("u3", { kindHint: "tv", seasons: [1, 2] })], now);
  units.replaceUnits("B", [built("u4"), built("u5")], now);
}

test("单个单元的变动增量维护：认出、合成一部、认不出、补类型、换匹配、忽略、重认", () => {
  seedTwoSources();
  assert.equal(__test_viewBuilt(), false, "没人读之前不建");
  assert.equal(worksView().counts.pending, 5);
  assertFresh("刚建好");

  const g0 = worksView().generation;
  units.saveIdentified("A", "u1", identified(10), now);
  assert.notEqual(worksView().generation, g0, "变动后 generation 要变");
  assert.equal(worksView().groups.get("movie:10")?.versions, 1);
  assert.deepEqual(worksView().counts, { pending: 4, identified: 1, none: 0, ignored: 0 });
  assertFresh("认出一个");

  units.saveIdentified("B", "u4", identified(10), now);
  assert.equal(worksView().groups.get("movie:10")?.versions, 2, "两个来源的同一部合成一组");
  assert.equal(worksView().groups.get("movie:10")?.shares, 2);
  assertFresh("合成一部");

  units.saveIdentified("A", "u2", identified(null, null), now);
  assert.equal(worksView().unidentified.size, 1, "认不出的进「没认出」");
  assert.equal(worksView().counts.none, 1);
  assertFresh("认不出");

  units.saveDetails("A", "u1", { genres: [18, 10765], countries: ["US"], originalLanguage: "en" });
  assert.deepEqual(worksView().groups.get("movie:10")?.genres, [18, 10765], "补类型要重查这一组");
  assertFresh("补类型");

  units.saveIdentified("A", "u1", identified(11, "tv", { status: "manual" }), now);
  assert.equal(worksView().groups.get("movie:10")?.versions, 1, "换匹配：原来那部少一个版本");
  assert.equal(worksView().groups.get("tv:11")?.conf, 3, "手动指定算高把握");
  assertFresh("换匹配");

  units.ignoreUnit("A", "u2", now);
  assert.equal(worksView().unidentified.size, 0, "忽略的从「没认出」里出去");
  assert.deepEqual(worksView().counts, { pending: 2, identified: 2, none: 0, ignored: 1 });
  assertFresh("忽略");

  units.resetUnit("B", "u4");
  assert.equal(worksView().groups.has("movie:10"), false, "最后一个版本重认了，这一组没了");
  assert.equal(worksView().summaries.get("B")?.identified, 0);
  assertFresh("重认");

  // 只动 retryAt / error：视图不该变
  const g1 = worksView().generation;
  units.setUnitRetry("A", "u3", now + 600, "一时出错");
  assert.equal(worksView().generation, g1);
  assertFresh("重试时间");
});

test("批量变动让视图作废：重切、删单元、分享进出失效、全部重认、删来源、换链接", () => {
  seedTwoSources();
  units.saveIdentified("A", "u1", identified(10), now);
  units.saveIdentified("B", "u4", identified(20), now);
  assert.equal(worksView().groups.size, 2);

  units.replaceUnits("A", [built("u1"), built("u9")], now);
  assert.equal(__test_viewBuilt(), false, "重切后作废");
  assert.equal(worksView().groups.get("movie:10")?.versions, 1, "重切保留同键单元的识别结果");
  assert.equal(worksView().summaries.get("A")?.total, 2);
  assertFresh("重切");

  updateShare("cb", { status: "expired", expiredAt: now });
  assert.equal(__test_viewBuilt(), false, "分享失效后作废");
  assert.equal(worksView().groups.has("movie:20"), false, "失效分享里的不进海报墙");
  assertFresh("分享失效");
  updateShare("cb", { checkedAt: now + 1 });
  assert.equal(__test_viewBuilt(), true, "只是记了查的时间，不作废");
  updateShare("nope", { status: "expired", expiredAt: now });
  assert.equal(__test_viewBuilt(), true, "没这个分享：什么都没改，不作废");
  updateShare("cb", { status: "ok", expiredAt: null });
  assert.equal(__test_viewBuilt(), false, "分享恢复后作废");
  assert.equal(worksView().groups.has("movie:20"), true);

  units.resetAutoIdentified();
  assert.equal(__test_viewBuilt(), false, "全部重认后作废");
  assert.equal(worksView().groups.size, 0);
  assertFresh("全部重认");

  units.saveIdentified("A", "u1", identified(10), now);
  units.saveIdentified("A", "u9", identified(12, "movie", { status: "manual" }), now);
  worksView();
  assert.equal(units.resetDoneUnits("B"), 0, "来源里没有自动认过的：一个都不动");
  assert.equal(__test_viewBuilt(), true, "没动就不作废");
  assert.equal(units.resetDoneUnits("A"), 1, "整来源重认：自动认过的放回待认，手动指定的不动");
  assert.equal(__test_viewBuilt(), false, "整来源重认后作废");
  assert.deepEqual([...worksView().groups.keys()], ["movie:12"], "手动指定的还在墙上");
  assertFresh("整来源重认");
  units.resetUnit("A", "u9");

  units.saveIdentified("B", "u4", identified(20), now);
  units.deleteUnits("B");
  assert.equal(__test_viewBuilt(), false, "删单元后作废");
  assert.equal(worksView().summaries.has("B"), false);
  assertFresh("删单元");

  units.saveIdentified("A", "u1", identified(10), now);
  update("A", { title: "改个标题" });
  assert.equal(__test_viewBuilt(), true, "改标题不作废");
  update("A", { shareCode: "cz", shareUrl: "https://115.com/s/cz" });
  assert.equal(__test_viewBuilt(), false, "换了分享码作废");
  assertFresh("换链接");

  remove("A");
  assert.equal(__test_viewBuilt(), false, "删来源后作废");
  assert.equal(worksView().groups.size, 0, "来源删了单元级联删掉");
  assertFresh("删来源");
});

test("listWorks 在缓存上筛、排、切：排序复用比较器，给出去的是副本", () => {
  seedTwoSources();
  units.saveIdentified("A", "u1", identified(1, "tv", { title: "第2季", year: "2010" }), now);
  units.saveIdentified("A", "u2", identified(2, "tv", { title: "第10季", year: "" }), now);
  units.saveIdentified("A", "u3", identified(3, "movie", { title: "第1季", year: "1999" }), now);
  units.saveIdentified("B", "u4", identified(null, null), now);

  const q = { view: "all" as const, offset: 0, limit: 10 };
  assert.deepEqual(listWorks({ ...q, sort: "title" }).works.map((w) => w.title), ["第1季", "第2季", "第10季"], "名称按数字大小排");
  assert.deepEqual(listWorks({ ...q, sort: "year" }).works.map((w) => w.year), ["2010", "1999", ""], "年份新的在前，没年份的最后");
  assert.deepEqual(listWorks({ ...q, sort: "title", view: "tv" }).works.map((w) => w.title), ["第2季", "第10季"]);
  assert.equal(listWorks({ ...q, sort: "recent", view: "none" }).total, 1);
  assert.deepEqual(listWorks({ ...q, sort: "recent" }).counts, { all: 3, movie: 1, tv: 2, low: 0, none: 1, pending: 1 });

  const owned = listWorks({ ...q, sort: "title" }, new Set(["tv:1"]));
  assert.equal(owned.works.find((w) => w.key === "tv:1")?.owned, true);
  owned.works[0].title = "改坏它";
  assert.equal(listWorks({ ...q, sort: "title" }).works[0].title, "第1季", "改返回值不影响缓存");
  const seasonsBefore = [...owned.works[0].seasons];
  owned.works[0].seasons.push(99);
  assert.deepEqual(listWorks({ ...q, sort: "title" }).works[0].seasons, seasonsBefore, "改返回值里的数组也不影响缓存");
  assert.equal(listWorks({ ...q, sort: "title" }).works.find((w) => w.key === "tv:1")?.owned, undefined, "owned 只标在那次的副本上");

  units.saveIdentified("A", "u3", identified(3, "movie", { title: "第0季", year: "1999" }), now);
  assert.deepEqual(listWorks({ ...q, sort: "title" }).works.map((w) => w.title), ["第0季", "第2季", "第10季"], "单元变了排好的数组跟着重排");
});

test("作品的 tags 是各版本目录名 / 样本文件名里认出的标签并起来；「第 N 季」不算；增量维护和重建一致", () => {
  seedTwoSources();
  units.replaceUnits("A", [built("u1", { rawName: "沙丘2.Dune.Part.Two.2024.2160p.DV.DDP5.1", sampleFile: "x.mkv" })], now);
  units.replaceUnits("B", [built("u4", { rawName: "沙丘2", sampleFile: "沙丘2.1080p.第一季.中字.mkv" })], now);
  units.saveIdentified("A", "u1", identified(10), now);
  units.saveIdentified("B", "u4", identified(10), now);
  assert.deepEqual([...(worksView().groups.get("movie:10")?.tags ?? [])].sort(), ["1080p", "4K", "中字", "杜比视界"]);
  assert.deepEqual(listWorks({ view: "all", sort: "title", offset: 0, limit: 10 }).works.find((w) => w.key === "movie:10")?.tags?.slice().sort(), ["1080p", "4K", "中字", "杜比视界"]);
  assertFresh("tags 也要和重建一致");
});
