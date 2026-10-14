/**
 * 追更 + 整理连起来跑：追更转存来的文件整理过（改过季 / 换过匹配）之后，新集交给整理时沿用上次的结果。
 * 假网盘（test/fake-drive.ts）+ TMDB 桩；剧是《我和僵尸有个约会》，TMDB 上两季（33 / 43 集），分享里的文件名不写季。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/follow/organize.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, OrganizeRun, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { __test_resetOrganize, listItems, listRuns, listUnits } from "../../db/repositories/organize.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { getShareFollow } from "../../db/repositories/share-follows.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import { FakeDrive, type FakeTree } from "../../test/fake-drive.js";
import type { TmdbDetails, TmdbEpisode, TmdbSearchResult } from "../tmdb.js";
import type { TmdbApi } from "../organize/identify.js";
import { __test_flushAutoOrganize, __test_resetAutoOrganize, startAutoOrganize } from "../organize/auto.js";
import { afterRevert } from "../organize/revert.js";
import { applyRun, createRun, getRunDetail, patchUnit, repreviewRun, revertRun, setOrganizeDeps, waitForRun } from "../organize/run.js";
import { __test_resetFollows, checkFollow, createFollow, setFollowServiceDeps, updateFollow } from "./service.js";

const account: AccountInfo = { accountType: "quark", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "quark", originPath: "tv", targetPath: "follow-organize/tv", strmPrefix: "/mnt", organize: { mode: "auto" } };
const SHOW = "我和僵尸有个约会";
const WORK = "我和僵尸有个约会 (1998) [tmdbid=19389]";
const HOUR = 3600_000;

let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };
let drive: FakeDrive;
let now = 1_800_000_000_000;

class StubTmdb implements TmdbApi {
  async search(query: string): Promise<TmdbSearchResult[]> {
    if (query === SHOW) return [{ id: 19389, mediaType: "tv", title: SHOW, year: "1998", posterUrl: "", overview: "" }];
    if (query.toLowerCase() === "beef") return [{ id: 153312, mediaType: "tv", title: "BEEF", year: "2023", posterUrl: "", overview: "" }];
    return [];
  }
  async details(kind: "movie" | "tv", id: number): Promise<TmdbDetails | null> {
    const base = { id, mediaType: kind, enTitle: "", posterUrl: "", imdbId: "", genreIds: [], countries: [], originalLanguage: "", aliases: [] };
    if (id === 19389) return { ...base, title: SHOW, originalTitle: SHOW, year: "1998", seasons: [{ season: 1, episodeCount: 33 }, { season: 2, episodeCount: 43 }] };
    if (id === 153312) return { ...base, title: "怒呛人生", originalTitle: "BEEF", year: "2023", seasons: [{ season: 1, episodeCount: 10 }] };
    return null;
  }
  async season(): Promise<TmdbEpisode[]> {
    return [];
  }
}

async function untilStatus(id: string, statuses: OrganizeRun["status"][]): Promise<OrganizeRun> {
  for (let i = 0; i < 300; i++) {
    await waitForRun(id);
    const r = getRunDetail(id).run;
    if (statuses.includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`run ${id} 停在 ${getRunDetail(id).run.status}`);
}

/** 手动整理一次（整理页）：可以改季 / 集偏移 / 换匹配，然后执行 */
async function organize(scope: string, patch: Parameters<typeof patchUnit>[2] = {}): Promise<OrganizeRun> {
  const run = await createRun({ taskId: "t1", subPath: scope });
  await untilStatus(run.id, ["ready"]);
  const unit = getRunDetail(run.id).units[0];
  if (Object.keys(patch).length > 0) await patchUnit(run.id, unit.key, patch);
  await applyRun(run.id);
  return untilStatus(run.id, ["done"]);
}

/** 分享里来了新文件：追更检查、交给整理，等这次整理停下来（直接执行完，或者留着等人确认） */
async function deliver(share: FakeTree, followId: string, files: string[], settled: OrganizeRun["status"][] = ["done"]): Promise<OrganizeRun> {
  for (const f of files) share.addFile(f);
  now += HOUR;
  const r = await checkFollow(followId);
  assert.equal(r.follow.status, "idle", r.follow.lastError);
  await __test_flushAutoOrganize();
  const run = listRuns({ taskId: "t1" })[0];
  assert.equal(run.trigger, "follow");
  return untilStatus(run.id, settled);
}

const unitOf = (runId: string) => getRunDetail(runId).units[0];
const dstOf = (runId: string, name: string) => listItems(runId).find((i) => i.srcPath.endsWith(name))?.dstPath;

before(() => {
  startAutoOrganize();
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  replaceAccounts([account]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"], downloadExtensions: [], tmdb: { apiKey: "x", language: "zh-CN" }, organize: {} });
  setOrganizeDeps({ tmdb: () => new StubTmdb(), notify: async () => true, retryDelayMs: 5 });
  setFollowServiceDeps({ notify: async () => {}, now: () => now, random: () => 0.5, gapMs: 0 });
});

beforeEach(async () => {
  __test_resetOrganize();
  __test_resetAutoOrganize();
  await __test_resetFollows();
  replaceTasks([task]);
  drive = new FakeDrive("quark", account, { share: true });
  drive.tree.addDir("/tv");
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  fs.rmSync(path.join(DATA_DIR, "follow-organize"), { recursive: true, force: true });
});

after(async () => {
  await __test_resetFollows();
  __test_resetOrganize();
  setOrganizeDeps(null);
  setFollowServiceDeps(null);
  setDriveProviderFactory(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(path.join(DATA_DIR, "follow-organize"), { recursive: true, force: true });
});

test("分享里是片名目录：整理时改成第 2 季，新一集落回重建的原名目录，沿用上次的整理直接执行到第 2 季、空壳删掉", async () => {
  const share = drive.share!.define("abc", { title: SHOW });
  share.addFile(`/${SHOW}/${SHOW}.EP01.mkv`);
  share.addFile(`/${SHOW}/${SHOW}.EP02.mkv`);
  drive.tree.addFile(`/tv/${SHOW}/${SHOW}.EP01.mkv`);
  drive.tree.addFile(`/tv/${SHOW}/${SHOW}.EP02.mkv`);
  const f = await createFollow({ shareCode: "abc", watchCid: "0", scope: [SHOW], taskId: "t1", name: SHOW });

  const first = await organize(SHOW, { seasonOverride: 2 });
  assert.ok(drive.tree.get(`/tv/${WORK}/Season 02/${SHOW} - S02E01.mkv`));
  const rec = getShareFollow(f.id)!.organized;
  assert.deepEqual(
    rec.map((o) => [o.dir, o.tmdbId, o.season, o.seasonFallback, o.episodeOffset, o.workDir, o.filesDir, o.titles, o.runId]),
    [[SHOW, 19389, 2, null, 0, WORK, `${WORK}/Season 02`, [SHOW], first.id]],
    "记下分享里这个目录整理成了什么",
  );

  const run = await deliver(share, f.id, [`/${SHOW}/${SHOW}.EP03.mkv`]);
  const unit = unitOf(run.id);
  assert.equal(unit.match?.reason, `沿用追更「${SHOW}」上次的整理`);
  assert.equal(unit.match?.confidence, "high");
  assert.equal(unit.seasonOverride, 2, "人定的季照样强制，界面上看得到");
  assert.ok(drive.tree.get(`/tv/${WORK}/Season 02/${SHOW} - S02E03.mkv`), "以前规划成 S01E03、停在待确认");
  assert.equal(drive.tree.get(`/tv/${SHOW}`), undefined, "重建的原名目录挪空删掉");
  assert.equal(getShareFollow(f.id)!.organized[0].runId, first.id, "值没变，不刷成这次的");
});

test("目录名带年份（以前把握大、直接执行成第 1 季）：一样沿用到第 2 季", async () => {
  const dir = `${SHOW} (1998)`;
  const share = drive.share!.define("abc", { title: SHOW });
  share.addFile(`/${dir}/${SHOW}.EP01.mkv`);
  drive.tree.addFile(`/tv/${dir}/${SHOW}.EP01.mkv`);
  const f = await createFollow({ shareCode: "abc", watchCid: "0", scope: [dir], taskId: "t1", name: SHOW });
  await organize(dir, { seasonOverride: 2 });
  const run = await deliver(share, f.id, [`/${dir}/${SHOW}.EP03.mkv`]);
  assert.equal(unitOf(run.id).match?.reason, `沿用追更「${SHOW}」上次的整理`);
  assert.ok(drive.tree.get(`/tv/${WORK}/Season 02/${SHOW} - S02E03.mkv`));
});

test("订阅的保存目录就是那个目录、没勾记住：订阅跟到作品目录，新一集落进作品目录，照样第 2 季（作品目录名里的 tmdbid 不再抢先）", async () => {
  const share = drive.share!.define("abc", { title: SHOW });
  share.addFile(`/${SHOW}.EP01.mkv`);
  drive.tree.addFile(`/tv/${SHOW}/${SHOW}.EP01.mkv`);
  const f = await createFollow({ shareCode: "abc", watchCid: "0", scope: [""], taskId: "t1", subPath: SHOW, name: SHOW });
  await organize(SHOW, { seasonOverride: 2 });
  assert.equal(getShareFollow(f.id)!.subPath, WORK);
  assert.equal(getShareFollow(f.id)!.organized[0].dir, "", "分享根目录");
  const run = await deliver(share, f.id, [`/${SHOW}.EP03.mkv`]);
  assert.equal(unitOf(run.id).match?.reason, `沿用追更「${SHOW}」上次的整理`);
  assert.ok(drive.tree.get(`/tv/${WORK}/Season 02/${SHOW} - S02E03.mkv`), "以前直接执行成 S01E03");
});

test("没人改季、季是从目录名「第二季」认出来的：订阅跟到作品目录后照样补上第 2 季；新文件自己写了季的不被压", async () => {
  const dir = `${SHOW} 第二季`;
  const share = drive.share!.define("abc", { title: SHOW });
  share.addFile(`/${SHOW}.EP01.mkv`);
  drive.tree.addFile(`/tv/${dir}/${SHOW}.EP01.mkv`);
  const f = await createFollow({ shareCode: "abc", watchCid: "0", scope: [""], taskId: "t1", subPath: dir, name: SHOW });
  await organize(dir);
  const rec = getShareFollow(f.id)!.organized[0];
  assert.deepEqual([rec.season, rec.seasonFallback], [null, 2], "没人定季：记落到的季，只补空");
  assert.equal(getShareFollow(f.id)!.subPath, WORK);

  const run = await deliver(share, f.id, [`/${SHOW}.EP03.mkv`]);
  assert.equal(unitOf(run.id).seasonOverride, null);
  assert.ok(drive.tree.get(`/tv/${WORK}/Season 02/${SHOW} - S02E03.mkv`), "作品目录名里没有季，靠补空季");
  assert.ok(unitOf(run.id).notes.includes(`沿用追更「${SHOW}」上次的整理：1 个没写季的文件放第 2 季`), unitOf(run.id).notes.join("；"));

  await deliver(share, f.id, [`/${SHOW}.S01E04.mkv`]);
  assert.ok(drive.tree.get(`/tv/${WORK}/Season 01/${SHOW} - S01E04.mkv`), "文件名写了 S01：补空季不压它");
});

test("整理页给作品目录改季、加集偏移：追更的记录跟着改，新集照新的来；撤销那次整理就退回去", async () => {
  const share = drive.share!.define("abc", { title: SHOW });
  share.addFile(`/${SHOW}/${SHOW}.EP01.mkv`);
  drive.tree.addFile(`/tv/${SHOW}/${SHOW}.EP01.mkv`);
  const f = await createFollow({ shareCode: "abc", watchCid: "0", scope: [SHOW], taskId: "t1", name: SHOW });

  // 第一次整理没人管，按第 1 季放了（以前常见：自动整理把握大、直接执行）
  const first = await organize(SHOW);
  assert.ok(drive.tree.get(`/tv/${WORK}/Season 01/${SHOW} - S01E01.mkv`));
  assert.deepEqual(getShareFollow(f.id)!.organized.map((o) => [o.season, o.seasonFallback, o.filesDir]), [[null, 1, `${WORK}/Season 01`]]);
  // 撤销收尾时一个视频都没退回（撤销被取消、在网盘上失败）：文件还在整理后的位置，记录不动
  afterRevert(task, drive, listUnits(first.id), listItems(first.id));
  assert.equal(getShareFollow(f.id)!.organized[0]?.runId, first.id);

  // 发现其实是第 2 季、而且集数要 +10：整理页对作品目录改
  const fix = await organize(WORK, { seasonOverride: 2, episodeOffset: 10 });
  assert.ok(drive.tree.get(`/tv/${WORK}/Season 02/${SHOW} - S02E11.mkv`));
  const rec = getShareFollow(f.id)!.organized[0];
  assert.deepEqual([rec.season, rec.seasonFallback, rec.episodeOffset, rec.filesDir, rec.runId, rec.prev?.runId], [2, null, 10, `${WORK}/Season 02`, fix.id, first.id]);

  const run = await deliver(share, f.id, [`/${SHOW}/${SHOW}.EP03.mkv`]);
  assert.ok(drive.tree.get(`/tv/${WORK}/Season 02/${SHOW} - S02E13.mkv`), dstOf(run.id, "EP03.mkv"));

  // 撤销改季那次：记录退回第一次整理的样子
  await revertRun(fix.id);
  await untilStatus(fix.id, ["reverted"]);
  const back = getShareFollow(f.id)!.organized[0];
  assert.deepEqual([back.season, back.seasonFallback, back.episodeOffset, back.runId], [null, 1, 0, first.id]);
});

test("同一个分享目录里来了别的剧（片名对不上）：不沿用，照常识别，说一句为什么；不再沿用之后照常识别", async () => {
  const share = drive.share!.define("abc", { title: SHOW });
  share.addFile(`/${SHOW}/${SHOW}.EP01.mkv`);
  drive.tree.addFile(`/tv/${SHOW}/${SHOW}.EP01.mkv`);
  const f = await createFollow({ shareCode: "abc", watchCid: "0", scope: [SHOW], taskId: "t1", name: SHOW });
  await organize(SHOW, { seasonOverride: 2 });

  const other = await deliver(share, f.id, [`/${SHOW}/BEEF.S01E01.mkv`], ["ready", "done"]);
  const unit = unitOf(other.id);
  assert.notEqual(unit.match?.reason, `沿用追更「${SHOW}」上次的整理`, "照常识别（目录名还是这部剧的名字，认成什么另说）");
  assert.equal(unit.seasonOverride, null, "上次定的季没被套上");
  assert.ok(unit.notes.includes(`「BEEF.S01E01.mkv」的片名和追更「${SHOW}」上次的整理对不上，没沿用`), unit.notes.join("；"));

  updateFollow(f.id, { clearOrganized: true });
  const plain = await deliver(share, f.id, [`/${SHOW}/${SHOW}.EP03.mkv`], ["ready", "done"]);
  assert.notEqual(unitOf(plain.id).match?.reason, `沿用追更「${SHOW}」上次的整理`, "不再沿用");
});

test("任务设成「生成待确认清单」：识别和季已经带好，等人确认；重新预览也带着", async () => {
  replaceTasks([{ ...task, organize: { mode: "review" } }]);
  const share = drive.share!.define("abc", { title: SHOW });
  share.addFile(`/${SHOW}/${SHOW}.EP01.mkv`);
  drive.tree.addFile(`/tv/${SHOW}/${SHOW}.EP01.mkv`);
  const f = await createFollow({ shareCode: "abc", watchCid: "0", scope: [SHOW], taskId: "t1", name: SHOW });
  await organize(SHOW, { seasonOverride: 2 });

  const run = await deliver(share, f.id, [`/${SHOW}/${SHOW}.EP03.mkv`], ["ready"]);
  assert.equal(unitOf(run.id).match?.reason, `沿用追更「${SHOW}」上次的整理`);
  assert.equal(dstOf(run.id, "EP03.mkv"), `/tv/${WORK}/Season 02/${SHOW} - S02E03.mkv`);
  const again = await repreviewRun(run.id);
  await untilStatus(again.id, ["ready"]);
  assert.equal(unitOf(again.id).match?.reason, `沿用追更「${SHOW}」上次的整理`);
  assert.equal(dstOf(again.id, "EP03.mkv"), `/tv/${WORK}/Season 02/${SHOW} - S02E03.mkv`);
});

test("一轮里好几组、前一组的整理在这一轮写快照之前就执行完了：照样记下整理结果", async () => {
  const dir = `${SHOW} (1998)`;
  const share = drive.share!.define("abc", { title: SHOW });
  share.addFile("/SP/old.mkv");
  drive.tree.addDir(`/tv/${dir}/SP`);
  const f = await createFollow({ shareCode: "abc", watchCid: "0", scope: [""], taskId: "t1", subPath: dir, name: SHOW });
  share.addFile(`/${SHOW}.EP01.mkv`);
  const late = share.addFile("/SP/new.mkv");
  // 第二组（SP 目录）的转存卡住，等第一组交给整理的那次执行完再放
  const fake = drive.share!;
  const receive = fake.receive.bind(fake);
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  fake.receive = async (session, items, toDirId) => {
    if (items.some((i) => i.id === late.id)) await gate;
    return receive(session, items, toDirId);
  };
  now += HOUR;
  const checking = checkFollow(f.id);
  let run: OrganizeRun | undefined;
  for (let i = 0; i < 300 && !run; i++) {
    await new Promise((res) => setTimeout(res, 10));
    run = listRuns({ taskId: "t1" })[0];
  }
  assert.ok(run, "第一组交给整理了");
  await untilStatus(run.id, ["done"]);
  assert.ok(drive.tree.get(`/tv/${WORK}/Season 01/${SHOW} - S01E01.mkv`));
  assert.ok(!getShareFollow(f.id)!.known.some((e) => e.path === `${SHOW}.EP01.mkv`), "这一轮还没写快照");
  assert.deepEqual(getShareFollow(f.id)!.organized.map((o) => [o.dir, o.tmdbId, o.seasonFallback]), [["", 19389, 1]], "照样认出是这条追更转存来的");
  release();
  const r = await checking;
  assert.equal(r.follow.status, "idle", r.follow.lastError);
});
