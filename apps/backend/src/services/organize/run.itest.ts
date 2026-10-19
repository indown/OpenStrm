/**
 * 整理的闭环：假网盘（test/fake-drive.ts）+ TMDB 桩，预览 → 改匹配 → 执行 → 本地镜像 → 撤销，
 * 以及冲突、单项失败、风控中止、自动模式、115 式（没有 walkSubtree）的懒解析 id。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/run.itest.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, OrganizeRun, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import {
  __test_resetOrganize,
  bumpOwnHit,
  deleteFinishedRunsBefore,
  findOwnOperation,
  insertRun,
  listItems,
  listRuns as listRunRows,
  listUnits,
  recallMatch,
  rememberMatch,
  replaceItems,
  updateItem,
  updateRun,
} from "../../db/repositories/organize.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { getShareFollow, insertShareFollow, replaceShareFollows } from "../../db/repositories/share-follows.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { HttpError } from "../../lib/http-error.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import { releaseTaskStart, reserveTaskStart } from "../task/registry.js";
import { startTask } from "../task/runner.js";
import { clearCopies, listCopies, saveCopies } from "../copy/queue.js";
import { FakeDrive, withoutWalk } from "../../test/fake-drive.js";
import type { MediaInfoResult } from "mediainfo.js";
import { __test_resetMediaProbes } from "../../db/repositories/media-probes.js";
import { setProbeDeps } from "../media/probe.js";
import type { TmdbDetails, TmdbEpisode, TmdbSearchResult } from "../tmdb.js";
import type { NotifyEvent } from "../notify.js";
import type { TmdbApi } from "./identify.js";
import {
  __test_dropPlanState,
  applyRun,
  cancelRun,
  createRun,
  deleteRun,
  getRunDetail,
  listAttention,
  lookupCandidate,
  getRunSummary,
  patchItems,
  patchPlan,
  patchUnit,
  patchUnits,
  planFingerprint,
  probeUnits,
  collapseStaleReadyRuns,
  reconcileInterruptedRuns,
  repreviewRun,
  revertRun,
  searchCandidates,
  setOrganizeDeps,
  skipItems,
  waitForRun,
} from "./run.js";

const account: AccountInfo = { accountType: "quark", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "quark", originPath: "tv", targetPath: "organize-itest/tv", strmPrefix: "/mnt" };
const LOCAL = path.join(DATA_DIR, "organize-itest", "tv");

let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };
let drive: FakeDrive;
let notified: NotifyEvent[] = [];

const hit = (id: number, mediaType: "movie" | "tv", title: string, year: string): TmdbSearchResult => ({ id, mediaType, title, year, posterUrl: "", overview: "" });
class StubTmdb implements TmdbApi {
  /** 刷新 TMDB 信息的测试：改 beefTitle 就等于 TMDB 上改了译名；failBeef 让查它的详情失败 */
  static beefTitle = "怒呛人生";
  static failBeef = false;
  /** 每次建客户端是不是要求跳过缓存（deps.tmdb 的 opts.fresh） */
  static freshCalls: boolean[] = [];
  constructor(fresh = false) {
    StubTmdb.freshCalls.push(fresh);
  }
  async search(query: string): Promise<TmdbSearchResult[]> {
    const q = query.toLowerCase();
    if (q === "beef" || q === "怒呛人生") return [hit(153312, "tv", "BEEF", "2023")];
    if (q === "dune part two" || q === "沙丘：第二部") return [hit(693134, "movie", "沙丘：第二部", "2024")];
    if (q === "回家的诱惑") return [hit(84656, "tv", "回家的诱惑", "2011")];
    if (q === "我和僵尸有个约会") return [hit(19389, "tv", "我和僵尸有个约会", "1998")];
    if (q === "up") return [hit(14160, "movie", "飞屋环游记", "2009")];
    if (q === "alien") return [hit(348, "movie", "异形", "1979")];
    if (q === "aliens") return [hit(679, "movie", "异形2", "1986")];
    return [];
  }
  async details(kind: "movie" | "tv", id: number): Promise<TmdbDetails | null> {
    const base = { id, mediaType: kind, enTitle: "", posterUrl: "", imdbId: "", genreIds: [], countries: [], originalLanguage: "", aliases: [] };
    if (id === 153312) {
      if (StubTmdb.failBeef) throw new Error("TMDB 挂了");
      return { ...base, title: StubTmdb.beefTitle, originalTitle: "BEEF", year: "2023", seasons: [{ season: 1, episodeCount: 10 }] };
    }
    if (id === 84656) return { ...base, title: "回家的诱惑", originalTitle: "回家的诱惑", year: "2011", seasons: [{ season: 1, episodeCount: 80 }] };
    if (id === 19389) return { ...base, title: "我和僵尸有个约会", originalTitle: "我和僵尸有个约会", year: "1998", seasons: [{ season: 1, episodeCount: 33 }, { season: 2, episodeCount: 43 }] };
    if (id === 693134) return { ...base, title: "沙丘：第二部", originalTitle: "Dune: Part Two", year: "2024" };
    if (id === 999) return { ...base, title: "另一部剧", originalTitle: "Other", year: "2020", seasons: [{ season: 1, episodeCount: 5 }, { season: 2, episodeCount: 5 }] };
    if (id === 14160) return { ...base, title: "飞屋环游记", originalTitle: "Up", enTitle: "Up", year: "2009" };
    if (id === 348) return { ...base, title: "异形", originalTitle: "Alien", year: "1979" };
    if (id === 679) return { ...base, title: "异形2", originalTitle: "Aliens", year: "1986" };
    return null;
  }
  async season(): Promise<TmdbEpisode[]> {
    return [];
  }
}

function writeLocalStrm(rel: string, remote: string): void {
  const full = path.join(LOCAL, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `/mnt/${remote}`);
}
const localExists = (rel: string) => fs.existsSync(path.join(LOCAL, ...rel.split("/")));
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const localRead = (rel: string) => fs.readFileSync(path.join(LOCAL, ...rel.split("/")), "utf8");

/** 常规布景：inbox 里一季剧 + 一部电影，本地 strm 已同步 */
function seed() {
  drive = new FakeDrive("quark", account);
  drive.tree.addDir("/tv/inbox/BEEF.S01.1080p");
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt");
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/tvshow.nfo");
  drive.tree.addFile("/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv");
  fs.rmSync(LOCAL, { recursive: true, force: true });
  writeLocalStrm("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm", "tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  writeLocalStrm("inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.strm", "tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  fs.writeFileSync(path.join(LOCAL, "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt"), "sub");
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
}

async function untilStatus(id: string, statuses: OrganizeRun["status"][], tries = 200): Promise<OrganizeRun> {
  for (let i = 0; i < tries; i++) {
    await waitForRun(id);
    const r = getRunDetail(id).run;
    if (statuses.includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  const last = getRunDetail(id).run;
  throw new Error(`run ${id} 没有到 ${statuses.join("/")}：${last.status}${last.error ? `（${last.error}）` : ""}\n${last.log.slice(-5).join("\n")}`);
}

before(() => {
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  replaceAccounts([account]);
  replaceTasks([task]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"], downloadExtensions: [".srt", ".nfo"], tmdb: { apiKey: "x", language: "zh-CN" }, organize: {} });
  setOrganizeDeps({
    tmdb: (_s, opts) => new StubTmdb(opts?.fresh === true),
    notify: async (ev) => {
      notified.push(ev);
      return true;
    },
    retryDelayMs: 5,
  });
});

beforeEach(() => {
  __test_resetOrganize();
  __test_resetMediaProbes();
  replaceShareFollows([]);
  replaceTasks([task]);
  replaceAppSettings({ ...readAppSettings(), organize: {} });
  notified = [];
  seed();
});

after(() => {
  setOrganizeDeps(null);
  setDriveProviderFactory(null);
  __test_resetOrganize();
  replaceShareFollows([]);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(path.join(DATA_DIR, "organize-itest"), { recursive: true, force: true });
});

test("预览：分单元、识别、规划出改名 / 移动 / 建目录 / 删空目录", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  assert.equal(run.status, "planning");
  const ready = await untilStatus(run.id, ["ready"]);
  const detail = { ...getRunDetail(run.id), items: listItems(run.id) };
  assert.equal(detail.units.length, 2);
  const beef = detail.units.find((u) => u.rootPath === "inbox/BEEF.S01.1080p")!;
  assert.equal(beef.match?.tmdbId, 153312);
  assert.equal(beef.match?.confidence, "medium", "文件名里没有年份");
  assert.equal(beef.dstRoot, "怒呛人生 (2023) [tmdbid=153312]");
  assert.equal(beef.selected, true);
  const dune = detail.units.find((u) => u.rootPath === "inbox")!;
  assert.equal(dune.match?.tmdbId, 693134);
  assert.equal(dune.match?.confidence, "high");
  const byAction = (a: string) => detail.items.filter((i) => i.action === a);
  assert.deepEqual(byAction("mkdir").map((i) => i.dstPath), [
    "/tv/怒呛人生 (2023) [tmdbid=153312]",
    "/tv/沙丘：第二部 (2024) [tmdbid=693134]",
    "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01",
  ]);
  assert.equal(byAction("move").length, 5, "两集 + 字幕 + nfo + 电影");
  assert.deepEqual(byAction("rmdir").map((i) => i.srcPath), ["/tv/inbox/BEEF.S01.1080p"], "inbox 是范围目录本身，不删");
  assert.equal(ready.stats.planned, 9);
  assert.equal(ready.stats.units, 2);
  assert.ok(detail.items.every((i) => i.nodeId || i.kind === "dir"), "夸克式的 walkSubtree 带 id");
});

test("执行：网盘改名移动、本地 strm 跟着挪并重写内容、字幕跟随、追更目录改写、监控能认出自有操作", async () => {
  insertShareFollow({
    id: "f1", name: "BEEF", libraryId: null, shareUrl: "", shareCode: "abc", receiveCode: "", watchCid: "0", watchPath: "", scope: [""],
    taskId: "t1", subPath: "inbox/BEEF.S01.1080p", enabled: true, intervalMinutes: 60, status: "idle", lastError: "", errorStreak: 0,
    lastCheckedAt: null, lastChangeAt: null, nextCheckAt: 0, known: [], recent: [], organized: [], createdAt: 1, updatedAt: 1,
  });
  writeKv(KEY.offlineFollowups, [
    { kind: "strm", infoHash: "h1", account: "acc", taskId: "t1", subPath: "inbox/BEEF.S01.1080p", name: "x", addedAt: Date.now(), status: "pending", detail: "", attempts: 0, misses: 0 },
    { kind: "strm", infoHash: "h2", account: "acc", taskId: "t1", subPath: "inbox/BEEF.S01.1080p/sub", name: "y", addedAt: Date.now(), status: "done", detail: "", attempts: 0, misses: 0 },
  ]);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await patchUnit(run.id, "inbox/BEEF.S01.1080p", { remember: true });
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  assert.equal(done.stats.done, 9);
  // 网盘
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.zh-CN.srt"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/tvshow.nfo"));
  assert.ok(drive.tree.get("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv"));
  assert.equal(drive.tree.get("/tv/inbox/BEEF.S01.1080p"), undefined, "腾空的源目录删掉");
  assert.ok(drive.tree.get("/tv/inbox"), "范围目录本身留着");
  // 本地镜像
  assert.ok(localExists("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"));
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.ok(localExists("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.zh-CN.srt"), "本地有的字幕跟着挪");
  assert.ok(localExists("沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.strm"), "本地没有的 strm 直接按新路径写");
  assert.ok(!localExists("inbox/BEEF.S01.1080p"), "本地空目录也清掉");
  // 记账与自有操作：115 会把「先改名再挪」报成两条事件，中间路径和最终路径都要认；执行、撤销各认两条，认满之后再动就是用户动的
  const items = listItems(run.id);
  const ep1 = items.find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  assert.equal(ep1.status, "done");
  assert.equal(ep1.curPath, "", "挪完 cur_path 清空");
  const at = ep1.finishedAt!;
  assert.ok(findOwnOperation(ep1.nodeId, ep1.dstPath, at), "最终路径");
  assert.ok(findOwnOperation(ep1.nodeId, "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv", at), "原地改名后的中间路径");
  assert.equal(findOwnOperation(ep1.nodeId, "/tv/other", at), null);
  assert.equal(findOwnOperation(ep1.nodeId, ep1.dstPath, at - 3600), null, "事件比操作早一小时：不是它");
  for (let i = 0; i < 4; i++) bumpOwnHit(ep1.id);
  assert.equal(findOwnOperation(ep1.nodeId, ep1.dstPath, at), null, "已经认满四条事件（执行、撤销各两条），之后同一路径再来就是用户动的");
  const mk = items.find((i) => i.action === "mkdir" && i.dstPath.endsWith("Season 01"))!;
  assert.ok(findOwnOperation(mk.nodeId, mk.dstPath, at), "建出来的目录：夸克快照会报成 create，也要认");
  // 追更落点改写 + 记忆；云下载回执只改还没兑现的
  assert.equal(getShareFollow("f1")!.subPath, "怒呛人生 (2023) [tmdbid=153312]");
  const followups = readKv<Array<{ infoHash: string; subPath: string }>>(KEY.offlineFollowups) ?? [];
  assert.equal(followups.find((f) => f.infoHash === "h1")!.subPath, "怒呛人生 (2023) [tmdbid=153312]");
  assert.equal(followups.find((f) => f.infoHash === "h2")!.subPath, "inbox/BEEF.S01.1080p/sub", "done 的回执不动");
  writeKv(KEY.offlineFollowups, []);
  assert.equal(recallMatch("acc", "/tv/怒呛人生 (2023) [tmdbid=153312]")?.tmdbId, 153312);
  assert.equal(notified.filter((e) => e.type === "organize-done").length, 1);
  // 再预览一遍：全部 keep，零变更
  const again = await createRun({ taskId: "t1" });
  const ready = await untilStatus(again.id, ["ready"]);
  assert.equal(ready.stats.planned, 0);
  assert.ok(listItems(again.id).filter((i) => i.kind !== "dir").every((i) => i.action === "keep"));
  const memoryUnit = getRunDetail(again.id).units.find((u) => u.rootPath === "怒呛人生 (2023) [tmdbid=153312]")!;
  assert.equal(memoryUnit.match?.reason, "上次确认过的识别结果");
  const tagUnit = getRunDetail(again.id).units.find((u) => u.rootPath === "沙丘：第二部 (2024) [tmdbid=693134]")!;
  assert.equal(tagUnit.match?.reason, "目录名里的 tmdbid 标签");
  assert.equal(tagUnit.match?.confidence, "high");
});

test("撤销：按流水账逆序退回，网盘和本地都恢复，追更落点改回去", async () => {
  insertShareFollow({
    id: "f2", name: "BEEF", libraryId: null, shareUrl: "", shareCode: "abd", receiveCode: "", watchCid: "0", watchPath: "", scope: [""],
    taskId: "t1", subPath: "inbox/BEEF.S01.1080p", enabled: true, intervalMinutes: 60, status: "idle", lastError: "", errorStreak: 0,
    lastCheckedAt: null, lastChangeAt: null, nextCheckAt: 0, known: [], recent: [], organized: [], createdAt: 1, updatedAt: 1,
  });
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  const applied = await untilStatus(run.id, ["done"]);
  assert.ok(applied.log.some((l) => l.includes(`执行完成：${applied.stats.done} 项完成，0 项失败`)), "收尾那句也落进了 run 的日志");
  // 同一次 run 的日志是一本账：执行接着预览往下写，不把预览那段冲掉
  const previewEnd = applied.log.findIndex((l) => l.includes("预览完成"));
  assert.ok(previewEnd >= 0 && previewEnd < applied.log.findIndex((l) => l.includes("执行完成")), "预览的日志还在，执行的接在后面");
  assert.equal(getRunDetail(run.id).revertable.ok, true);
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.status, "reverted");
  // 「项已退回」和执行时的「项完成」同一个口径：建目录 / 删目录退回了也算，日志和通知里的数一样
  const back = listItems(run.id).filter((i) => i.status === "reverted");
  assert.equal(back.length, applied.stats.done);
  assert.ok(back.some((i) => i.action === "mkdir") && back.some((i) => i.action === "rmdir"));
  assert.ok(reverted.log.some((l) => l.includes(`撤销完成：退回 ${back.length} 项`)), "撤销的收尾那句也落进日志");
  assert.ok(reverted.log.some((l) => l.includes("执行完成")), "执行那段也还在");
  const ev = notified.find((e) => e.type === "organize-done" && e.reverted === true);
  assert.ok(ev?.type === "organize-done");
  assert.equal(ev.done, back.length);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"));
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt"));
  assert.ok(drive.tree.get("/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"));
  assert.equal(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]"), undefined, "建出来的目录空了就删");
  assert.equal(localRead("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "/mnt/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  assert.ok(!localExists("怒呛人生 (2023) [tmdbid=153312]"));
  assert.equal(getShareFollow("f2")!.subPath, "inbox/BEEF.S01.1080p");
  assert.equal(getRunDetail(run.id).revertable.ok, false);
  // 撤销产生的事件也要认成自己的：新路径是原路径，或先挪回、还没改回原名的中间路径 `源目录/新名字`；`目标目录/旧名字` 撤销走不到，不认
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "reverted");
  assert.ok(findOwnOperation(ep2.nodeId, ep2.srcPath, ep2.finishedAt!));
  assert.ok(findOwnOperation(ep2.nodeId, "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv", ep2.finishedAt!));
  assert.equal(findOwnOperation(ep2.nodeId, "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/BEEF.S01E02.1080p.WEB-DL.mkv", ep2.finishedAt!), null);
});

test("范围就是发布目录：腾空后连范围目录一起删，撤销时按需重建", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  const planned = listItems(run.id);
  assert.deepEqual(planned.filter((i) => i.action === "rmdir").map((i) => i.srcPath), ["/tv/inbox/BEEF.S01.1080p"], "范围目录像发布目录，腾空了就删");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(drive.tree.get("/tv/inbox/BEEF.S01.1080p"), undefined, "网盘上的空壳删掉了");
  assert.ok(drive.tree.get("/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"), "范围外的不动");
  assert.ok(!localExists("inbox/BEEF.S01.1080p"));
  assert.ok(localExists("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"));
  // 删目录的事件路径靠不住（缓存里已经没了），按节点认；文件节点的删除不算自己的
  const rmdir = listItems(run.id).find((i) => i.action === "rmdir")!;
  assert.ok(rmdir.nodeId && findOwnOperation(rmdir.nodeId, "/BEEF.S01.1080p", rmdir.finishedAt!, "remove"), "腾空后删掉的源目录");
  const ep1 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  assert.equal(findOwnOperation(ep1.nodeId, ep1.dstPath, ep1.finishedAt!, "remove"), null, "用户删了挪过去的文件，不是自己的");
  await revertRun(run.id);
  await untilStatus(run.id, ["reverted"]);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "挪回去时把目录重建了");
  const mk = listItems(run.id).find((i) => i.action === "mkdir" && i.dstPath === "/tv/怒呛人生 (2023) [tmdbid=153312]")!;
  assert.equal(mk.status, "reverted");
  assert.ok(findOwnOperation(mk.nodeId, "/怒呛人生 (2023) [tmdbid=153312]", mk.finishedAt!, "remove"), "撤销时删掉的自建目录");
  // 快照式监控可能在撤销开始之后才看到执行时的那次删除：rmdir 项已经标成 reverted 也得认（重建的是新节点，旧节点只可能是我们删的）
  const rm2 = listItems(run.id).find((i) => i.action === "rmdir")!;
  assert.equal(rm2.status, "reverted");
  assert.ok(findOwnOperation(rm2.nodeId, "/BEEF.S01.1080p", rm2.finishedAt!, "remove"), "撤销后旧节点的删除事件还是自己的");
  assert.equal(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]"), undefined);
  assert.equal(localRead("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "/mnt/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
});

test("本地镜像只认同账号的任务：别的账号同名 originPath 的任务不会被串到", async () => {
  // 另一个账号也有 originPath 为 tv 的任务，且排在前面：按路径匹配会先撞上它
  const decoy: TaskDefinition = { id: "t0", account: "other", accountType: "115", originPath: "tv", targetPath: "organize-itest/other-tv", strmPrefix: "/mnt2" };
  replaceTasks([decoy, task]);
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.ok(!localExists("inbox/BEEF.S01.1080p"));
  assert.ok(!fs.existsSync(path.join(DATA_DIR, "organize-itest", "other-tv")), "别的账号的本地目录一个字节都不该动");
  await revertRun(run.id);
  await untilStatus(run.id, ["reverted"]);
  assert.equal(localRead("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "/mnt/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  assert.ok(!fs.existsSync(path.join(DATA_DIR, "organize-itest", "other-tv")));
});

test("散在任务根目录的文件：按标题各自成单元挪进作品目录，作品目录已存在就直接进去，根目录不删", async () => {
  // 根目录下：一部已经整理好的剧、一集散落的 BEEF（带字幕）、一个散落的沙丘 1080p（inbox 里还有它的 2160p）
  drive.tree.addDir("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  drive.tree.addFile("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  drive.tree.addFile("/tv/BEEF.S01E03.1080p.WEB-DL.mkv");
  drive.tree.addFile("/tv/BEEF.S01E03.1080p.WEB-DL.chs.srt");
  drive.tree.addFile("/tv/Dune.Part.Two.2024.1080p.WEB-DL.mkv");
  writeLocalStrm("BEEF.S01E03.1080p.WEB-DL.strm", "tv/BEEF.S01E03.1080p.WEB-DL.mkv");
  const run = await createRun({ taskId: "t1", subPath: "" });
  await untilStatus(run.id, ["ready"]);
  const detail = { ...getRunDetail(run.id), items: listItems(run.id) };
  const rootUnits = detail.units.filter((u) => u.rootPath === "");
  assert.deepEqual(rootUnits.map((u) => u.dstRoot).sort(), ["怒呛人生 (2023) [tmdbid=153312]", "沙丘：第二部 (2024) [tmdbid=693134]"], "根目录按标题拆成两个单元");
  const byDst = (suffix: string) => detail.items.find((i) => i.dstPath.endsWith(suffix))!;
  assert.equal(byDst("Season 01/怒呛人生 - S01E03.mkv").srcPath, "/tv/BEEF.S01E03.1080p.WEB-DL.mkv");
  assert.equal(byDst("Season 01/怒呛人生 - S01E03.zh-CN.srt").srcPath, "/tv/BEEF.S01E03.1080p.WEB-DL.chs.srt");
  assert.equal(byDst("沙丘：第二部 (2024) - 1080p.mkv").srcPath, "/tv/Dune.Part.Two.2024.1080p.WEB-DL.mkv");
  assert.equal(byDst("沙丘：第二部 (2024) - 2160p.mkv").srcPath, "/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv", "inbox 里的另一个版本进同一个作品目录");
  const mkdirs = detail.items.filter((i) => i.action === "mkdir").map((i) => i.dstPath);
  assert.ok(!mkdirs.some((d) => d.includes("怒呛人生")), "已存在的作品目录和季目录不再建");
  const existing = detail.units.find((u) => u.rootPath === "怒呛人生 (2023) [tmdbid=153312]")!;
  assert.equal(existing.match?.confidence, "high", "目录名里的 tmdbid 标签直接认");
  assert.equal(detail.items.filter((i) => i.unitKey === existing.key && i.action !== "keep").length, 0, "已经规范的文件一个都不动");
  assert.ok(!detail.items.some((i) => i.action === "rmdir" && i.srcPath === "/tv"), "任务根目录永远不删");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(drive.tree.get("/tv/BEEF.S01E03.1080p.WEB-DL.mkv"), undefined);
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E03.mkv"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"), "原来的文件还在");
  assert.ok(drive.tree.get("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 1080p.mkv"));
  assert.ok(drive.tree.get("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv"));
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E03.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E03.mkv");
  assert.ok(!localExists("BEEF.S01E03.1080p.WEB-DL.strm"));
});

test("中途取消：改了名还没挪走的项记着 cur_path，续跑接着挪，撤销也能改回去", async () => {
  // 改名一律成功，移动一到就中止：模拟第一次 apply 在 2b 和 2c 之间被掐断
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  drive.failWriteOn = (op) => (op === "move" ? new Error("blocked by 405") : null);
  await applyRun(run.id);
  const stopped = await untilStatus(run.id, ["failed"]);
  assert.match(stopped.error, /网盘拒绝/);
  const partial = listItems(run.id).filter((i) => i.curPath);
  assert.ok(partial.length >= 2, "改了名的移动项都记着当前路径");
  assert.ok(partial.every((i) => i.status === "failed" || i.status === "pending"), "移动那一步没成：失败或还没轮到，cur_path 都在");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv"), "网盘上文件已经是新名字、还在原目录");
  assert.ok(localExists("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "本地还没动");
  assert.equal(getRunDetail(run.id).revertable.ok, true, "改过名就能撤");
  // 这个窗口里监控拉到的改名事件（路径是中间名字）要认成整理自己的，不能当用户改名去动本地
  const inflight = partial.find((i) => i.status === "pending") ?? partial[0];
  const nowSec = Math.floor(Date.now() / 1000);
  assert.ok(findOwnOperation(inflight.nodeId, inflight.curPath, nowSec), "改了名还没挪走：按中间名字认");
  assert.ok(findOwnOperation(inflight.nodeId, inflight.dstPath, nowSec), "挪到目标还没记账：按目标认");
  assert.equal(findOwnOperation(inflight.nodeId, "/tv/other/x.mkv", nowSec), null);
  // 续跑：不会再改一次名，直接挪
  drive.failWriteOn = null;
  const renamesBefore = drive.calls.rename;
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  assert.equal(drive.calls.rename, renamesBefore, "续跑没有重复改名");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"));
  assert.ok(listItems(run.id).every((i) => !i.curPath));
  // 再来一遍中断后直接撤销：改了名的改回去
  seed();
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  drive.failWriteOn = (op) => (op === "move" ? new Error("blocked by 405") : null);
  await applyRun(run2.id);
  await untilStatus(run2.id, ["failed"]);
  drive.failWriteOn = null;
  await revertRun(run2.id);
  await untilStatus(run2.id, ["reverted"]);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "名字改回去了");
  assert.equal(drive.tree.get("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv"), undefined);
});

test("监控抢先把本地 strm 按中间名字改了：镜像接着按它搬，不在旧目录留副本", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  // 模拟监控在「原地改完名、还没挪走」的窗口里把本地文件改成了新名字（老版本没认出这是整理自己做的）
  fs.renameSync(path.join(LOCAL, "inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), path.join(LOCAL, "inbox/BEEF.S01.1080p/怒呛人生 - S01E01.strm"));
  fs.writeFileSync(path.join(LOCAL, "inbox/BEEF.S01.1080p/怒呛人生 - S01E01.strm"), "/mnt/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.ok(!localExists("inbox/BEEF.S01.1080p/怒呛人生 - S01E01.strm"), "改了名的那份被搬走了，不是另写一份");
  assert.ok(!localExists("inbox/BEEF.S01.1080p"), "源目录腾空后本地目录也没了");
});

test("失败的项再执行会重试；记忆按新路径写、不被旧记忆盖掉", async () => {
  rememberMatch({ accountName: "acc", srcPath: "/tv/inbox/BEEF.S01.1080p", mediaType: "tv", tmdbId: 999, title: "另一部剧", year: "2020", season: null, episodeOffset: 0 });
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const u = getRunDetail(run.id).units.find((x) => x.rootPath === "inbox/BEEF.S01.1080p")!;
  assert.equal(u.match?.tmdbId, 999, "旧记忆先生效");
  await patchUnit(run.id, u.key, { match: { mediaType: "tv", tmdbId: 153312 }, remember: true });
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  await applyRun(run.id);
  const first = await untilStatus(run.id, ["done"]);
  assert.equal(first.stats.failed, 1);
  drive.failWriteOn = null;
  await applyRun(run.id);
  const second = await untilStatus(run.id, ["done"]);
  assert.equal(second.stats.failed, 0, "失败的那项这次成功了");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv"));
  const memory = recallMatch("acc", "/tv/怒呛人生 (2023) [tmdbid=153312]");
  assert.equal(memory?.tmdbId, 153312, "这次确认的 153312 而不是被挪过来的旧记忆 999");
});

test("记住的季 / 集偏移只补空：作品目录里别的季、整理好的文件不被压，再整理不重复加偏移；没写季的新文件照样补上，勾记住不丢原来的", async () => {
  const work = "我和僵尸有个约会 (1998) [tmdbid=19389]";
  drive.tree.addFile(`/tv/${work}/Season 01/我和僵尸有个约会 - S01E01.mkv`);
  drive.tree.addFile(`/tv/${work}/Season 02/我和僵尸有个约会 - S02E13.mkv`);
  rememberMatch({ accountName: "acc", srcPath: `/tv/${work}`, mediaType: "tv", tmdbId: 19389, title: "我和僵尸有个约会", year: "1998", season: 2, episodeOffset: 12 });

  // 手动整理整个作品目录：整理好的都不动（以前第 1 季被压去第 2 季撞冲突、S02E13 被改成 S02E25）
  const whole = await createRun({ taskId: "t1", subPath: work });
  const ready = await untilStatus(whole.id, ["ready"]);
  assert.equal(ready.stats.planned, 0, listItems(whole.id).map((i) => `${i.action} ${i.srcPath} -> ${i.dstPath}`).join("\n"));
  assert.equal(ready.stats.conflicts, 0);
  const wholeUnit = getRunDetail(whole.id).units[0];
  assert.equal(wholeUnit.match?.reason, "上次确认过的识别结果");
  assert.equal(wholeUnit.seasonOverride, null, "记住的季不写进单元的季覆盖");
  assert.equal(wholeUnit.episodeOffset, 0);
  assert.ok(!wholeUnit.notes.some((n) => n.startsWith("按记住的识别")), "没用上就不提");
  cancelRun(whole.id);

  // 第 1 季的新文件落进作品目录（监控）：文件名写了 S01，不被记住的季压
  drive.tree.addFile(`/tv/${work}/我和僵尸有个约会.S01E05.mkv`);
  const s1 = await createRun({ taskId: "t1", paths: [`${work}/我和僵尸有个约会.S01E05.mkv`], mode: "auto", trigger: "monitor" });
  await untilStatus(s1.id, ["done"]);
  assert.ok(drive.tree.get(`/tv/${work}/Season 01/我和僵尸有个约会 - S01E05.mkv`), "进第 1 季");

  // 没写季的新文件：补上第 2 季、集数 +12；勾「记住」、这次没改季 / 偏移，原来记着的留着
  drive.tree.addFile(`/tv/${work}/我和僵尸有个约会.EP02.mkv`);
  const raw = await createRun({ taskId: "t1", paths: [`${work}/我和僵尸有个约会.EP02.mkv`], mode: "review", trigger: "monitor" });
  await untilStatus(raw.id, ["ready"]);
  const rawUnit = getRunDetail(raw.id).units[0];
  assert.equal(listItems(raw.id).find((i) => i.srcPath.endsWith("EP02.mkv"))!.dstPath, `/tv/${work}/Season 02/我和僵尸有个约会 - S02E14.mkv`);
  assert.ok(rawUnit.notes.includes("按记住的识别：1 个没写季的文件放第 2 季、集数 +12"), rawUnit.notes.join("；"));
  await patchUnit(raw.id, rawUnit.key, { remember: true });
  assert.ok(getRunDetail(raw.id).units[0].notes.includes("按记住的识别：1 个没写季的文件放第 2 季、集数 +12"), "重规划照样补空");
  await applyRun(raw.id);
  await untilStatus(raw.id, ["done"]);
  const memory = recallMatch("acc", `/tv/${work}`);
  assert.deepEqual([memory?.season, memory?.episodeOffset], [2, 12], "勾了记住、没改季 / 偏移：原来记着的留着");
});

test("自动触发的 run（按路径）也会列范围外的目标目录：已存在的不再 mkdir，撞名算冲突", async () => {
  drive.tree.addDir("/tv/沙丘：第二部 (2024) [tmdbid=693134]");
  drive.tree.addFile("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv");
  drive.tree.addDir("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  const run = await createRun({ taskId: "t1", paths: ["inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv", "inbox/BEEF.S01.1080p"], mode: "review", trigger: "share" });
  const ready = await untilStatus(run.id, ["ready"]);
  const items = listItems(run.id);
  assert.equal(items.filter((i) => i.action === "mkdir").length, 0, "目标目录都已存在");
  assert.equal(ready.stats.conflicts, 1);
  assert.equal(ready.status, "ready", "review 模式不自动执行");
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"));
});

test("源目录里已有和新名字一样的文件：中间改名会撞上，标冲突", async () => {
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  const ready = await untilStatus(run.id, ["ready"]);
  const c = listItems(run.id).find((i) => i.action === "conflict" && i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"));
  assert.ok(c, "原始那份和已规范的那份算出同一个名字");
  assert.ok(ready.stats.conflicts >= 1);
});

test("撤销：不相干的后续整理不挡；后面的整理动过这批文件就挡住并指向那一次，先撤后面那次就能撤", async () => {
  const first = await createRun({ taskId: "t1", paths: ["inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"], trigger: "share" });
  await untilStatus(first.id, ["ready"]);
  await applyRun(first.id);
  await untilStatus(first.id, ["done"]);
  assert.equal(getRunDetail(first.id).revertable.ok, true);
  // 后面整理了别的（BEEF）：不相干，前一次照样能撤
  const second = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(second.id, ["ready"]);
  await applyRun(second.id);
  await untilStatus(second.id, ["done"]);
  assert.equal(getRunDetail(first.id).revertable.ok, true, "第二次只动了 BEEF，没碰第一次挪好的电影");
  assert.equal(getRunDetail(second.id).revertable.ok, true);
  // 改了电影模板再整理整个任务：第三次把第一次挪好的电影又改了名
  replaceAppSettings({ ...readAppSettings(), organize: { templates: { movie: "{title} ({year}) {idTag}/{title}.{year}.{ext}" } } });
  const third = await createRun({ taskId: "t1" });
  await untilStatus(third.id, ["ready"]);
  await applyRun(third.id);
  await untilStatus(third.id, ["done"]);
  assert.ok(drive.tree.get("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部.2024.mkv"));
  const r = getRunDetail(first.id).revertable;
  assert.equal(r.ok, false);
  assert.equal(r.blockedBy?.id, third.id);
  await assert.rejects(revertRun(first.id), /先撤销那一次/);
  assert.equal(getRunDetail(second.id).revertable.ok, true, "第三次没动 BEEF（已经是规范名字）");
  await revertRun(third.id);
  await untilStatus(third.id, ["reverted"]);
  assert.equal(getRunDetail(first.id).revertable.ok, true, "后面那次撤掉了就能撤");
  await revertRun(first.id);
  await untilStatus(first.id, ["reverted"]);
  assert.ok(drive.tree.get("/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"));
  await assert.rejects(createRun({ taskId: "t1", subPath: "../x" }), /不合法/);
});

test("先撤前面的整理：它建的目录装着后面放进去的文件就留着；后面那次撤销挪走文件后一起删掉，前面那次记成已退回", async () => {
  const first = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(first.id, ["ready"]);
  await applyRun(first.id);
  await untilStatus(first.id, ["done"]);
  const show = "/tv/怒呛人生 (2023) [tmdbid=153312]";
  // 又落进来新的一集，自动整理进了第一次建的 Season 01（不用建目录）
  drive.tree.addFile("/tv/inbox/BEEF.S01E03.1080p.WEB-DL.mkv");
  const second = await createRun({ taskId: "t1", paths: ["inbox/BEEF.S01E03.1080p.WEB-DL.mkv"], trigger: "share" });
  await untilStatus(second.id, ["ready"]);
  assert.equal(listItems(second.id).filter((i) => i.action === "mkdir").length, 0);
  await applyRun(second.id);
  await untilStatus(second.id, ["done"]);
  assert.ok(drive.tree.get(`${show}/Season 01/怒呛人生 - S01E03.mkv`));
  // 先撤第一次：第二次没动它挪好的文件，能撤；它建的剧目录 / Season 01 里还有第二次的 E03，留着
  assert.equal(getRunDetail(first.id).revertable.ok, true);
  // 监控在「先挪回再改名」的窗口里按事件在中间位置另生成过一份：撤销镜像完要把它清掉，别留两份
  fs.mkdirSync(path.join(LOCAL, "inbox", "BEEF.S01.1080p"), { recursive: true });
  fs.writeFileSync(path.join(LOCAL, "inbox", "BEEF.S01.1080p", "怒呛人生 - S01E01.strm"), "stale");
  await revertRun(first.id);
  await untilStatus(first.id, ["reverted"]);
  assert.ok(localExists("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"));
  assert.ok(!localExists("inbox/BEEF.S01.1080p/怒呛人生 - S01E01.strm"), "中间位置那份清掉了");
  const dirsOf = (id: string) => listItems(id).filter((i) => i.action === "mkdir" && i.dstPath.startsWith(show));
  assert.deepEqual(dirsOf(first.id).map((i) => i.status), ["skipped", "skipped"]);
  assert.ok(drive.tree.get(`${show}/Season 01/怒呛人生 - S01E03.mkv`));
  // 撤销是先挪回再改回原名，115 会把挪回单独报一条（路径是 `源目录/新名字`），监控拉到它时这项多半已经是 reverted
  const e1 = listItems(first.id).find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  assert.equal(e1.status, "reverted");
  assert.ok(findOwnOperation(e1.nodeId, "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv", e1.finishedAt!), "撤销挪回后的中间路径也认");
  assert.ok(findOwnOperation(e1.nodeId, e1.srcPath, e1.finishedAt!), "退回的最终路径");
  const revertedBefore = getRunDetail(first.id).run.stats.reverted;
  // 再撤第二次：E03 挪回去，第一次留下的两个目录空了，一起删掉，第一次的记账跟着改
  await revertRun(second.id);
  const back = await untilStatus(second.id, ["reverted"]);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01E03.1080p.WEB-DL.mkv"));
  assert.equal(drive.tree.get(show), undefined, "前面整理留下的空目录删掉了");
  assert.ok(back.log.some((l) => l.includes("前面整理留下的空目录一起删了")));
  assert.deepEqual(dirsOf(first.id).map((i) => i.status), ["reverted", "reverted"]);
  assert.equal(getRunDetail(first.id).run.stats.reverted, revertedBefore + 2);
  assert.ok(!localExists("怒呛人生 (2023) [tmdbid=153312]"), "本地也没留下空目录");
});

test("预览里改匹配 / 改季 / 取消勾选：重新规划这个单元，其它不动", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const u = await patchUnit(run.id, "inbox/BEEF.S01.1080p", { match: { mediaType: "tv", tmdbId: 999 }, seasonOverride: 2 });
  assert.equal(u.match?.title, "另一部剧");
  assert.equal(u.dstRoot, "另一部剧 (2020) [tmdbid=999]");
  const items = listItems(run.id);
  assert.ok(items.some((i) => i.dstPath === "/tv/另一部剧 (2020) [tmdbid=999]/Season 02/另一部剧 - S02E01.mkv"));
  assert.ok(items.some((i) => i.dstPath.includes("沙丘：第二部")), "电影那个单元还在");
  const off = await patchUnit(run.id, "inbox/BEEF.S01.1080p", { selected: false });
  assert.equal(off.selected, false);
  assert.ok(listItems(run.id).filter((i) => i.unitKey === "inbox/BEEF.S01.1080p").every((i) => i.action === "skip"));
  assert.equal(getRunDetail(run.id).run.stats.planned, 2, "只剩电影：mkdir + move");
  const back = await patchUnit(run.id, "inbox/BEEF.S01.1080p", { selected: true });
  assert.equal(back.selected, true);
  assert.equal(listUnits(run.id).length, 2);
});

test("冲突：目标已存在的项不动，其余照常执行", async () => {
  drive.tree.addDir("/tv/沙丘：第二部 (2024) [tmdbid=693134]");
  drive.tree.addFile("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  const ready = await untilStatus(run.id, ["ready"]);
  assert.equal(ready.stats.conflicts, 1);
  const c = listItems(run.id).find((i) => i.action === "conflict")!;
  assert.equal(c.reason, "目标已存在");
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.ok(drive.tree.get("/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"), "冲突的没动");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv"));
  assert.equal(done.stats.failed, 0);
});

test("单项失败不影响其余；风控整轮停下，可以再执行接着来", async () => {
  // 移动时文件已经先原地改过名了，按新名字认
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 1);
  const bad = listItems(run.id).find((i) => i.status === "failed")!;
  assert.match(bad.error, /改不了/);
  assert.equal(bad.errorKind, "transient", "认不出的错误按临时算");
  assert.equal(bad.attempts, 1, "自动重试不算一轮");
  assert.ok(done.log.some((l) => l.includes("秒后重试")), "临时失败自动重试过");
  assert.equal(done.stats.failedByKind.transient, 1);
  assert.equal(getRunDetail(run.id).applicable.ok, true, "临时失败默认可以重试");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"), "同批的其它项照常");

  seed();
  drive.failWriteOn = (op) => (op === "rename" ? new Error("blocked by 405") : null);
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  const failed = await untilStatus(run2.id, ["failed"]);
  assert.match(failed.error, /网盘拒绝了请求/);
  assert.ok(listItems(run2.id).some((i) => i.status === "failed" && i.errorKind === "blocked"), "风控的项记成 blocked");
  assert.ok(!failed.log.some((l) => l.includes("秒后重试")), "风控不自动重试");
  const pendingBefore = listItems(run2.id).filter((i) => i.status === "pending").length;
  assert.ok(pendingBefore > 0, "停下时还有没做的项");
  drive.failWriteOn = null;
  await applyRun(run2.id);
  const done2 = await untilStatus(run2.id, ["done"]);
  assert.equal(listItems(run2.id).filter((i) => i.status === "pending").length, 0);
  assert.ok(done2.stats.done >= pendingBefore);
});

test("自动模式：全 high 且无冲突直接执行；有拿不准的只通知待确认", async () => {
  replaceTasks([{ ...task, organize: { mode: "auto" } }]);
  // 只给电影：high
  const run = await createRun({ taskId: "t1", paths: ["inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"], mode: "auto", trigger: "share" });
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.status, "done");
  assert.ok(drive.tree.get("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv"));
  assert.equal(notified.filter((e) => e.type === "organize-review").length, 0);
  // 剧是 medium：留着等确认
  const run2 = await createRun({ taskId: "t1", paths: ["inbox/BEEF.S01.1080p"], mode: "auto", trigger: "follow" });
  const ready = await untilStatus(run2.id, ["ready"]);
  assert.equal(ready.status, "ready");
  assert.equal(notified.filter((e) => e.type === "organize-review").length, 1);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "没动");
});

test("正片走了留下的跟着走：花絮 / sample 进 extras/、认不出类型的进作品目录，花絮撞名不卡自动整理；撤销全退回", async () => {
  const rel = "/tv/inbox/Alien.1979.1080p.BluRay";
  drive.tree.addDir(rel);
  for (const f of ["Alien.1979.1080p.BluRay.mkv", "Alien.1979.Trailer.mkv", "Featurettes/01.mkv", "Trailers/01.mkv", "sample.mkv", "更多资源请访问.txt"]) drive.tree.addFile(`${rel}/${f}`);
  // 同步任务给每个视频都生成了 strm，花絮和 sample 也有
  for (const f of ["Alien.1979.1080p.BluRay", "Alien.1979.Trailer", "Featurettes/01", "Trailers/01", "sample"]) {
    writeLocalStrm(`inbox/Alien.1979.1080p.BluRay/${f}.strm`, `tv/inbox/Alien.1979.1080p.BluRay/${f}.mkv`);
  }
  replaceTasks([{ ...task, organize: { mode: "auto" } }]);
  const run = await createRun({ taskId: "t1", paths: ["inbox/Alien.1979.1080p.BluRay"], mode: "auto", trigger: "share" });
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.conflicts, 0, "两个 01.mkv 撞名是留下，不是冲突");
  assert.equal(notified.filter((e) => e.type === "organize-review").length, 0, "没有因为花絮撞名改成等人确认");
  const work = "/tv/异形 (1979) [tmdbid=348]";
  for (const p of [`${work}/异形 (1979) - 1080p.mkv`, `${work}/extras/Alien.1979.Trailer.mkv`, `${work}/extras/01.mkv`, `${work}/extras/sample.mkv`, `${work}/更多资源请访问.txt`]) {
    assert.ok(drive.tree.get(p), p);
  }
  const items = listItems(run.id);
  assert.equal(items.find((i) => i.dstPath === `${work}/extras/sample.mkv`)!.reason, "按花絮处理");
  const stayed = items.filter((i) => i.srcPath.endsWith("/01.mkv") && i.action === "skip");
  assert.deepEqual(stayed.map((i) => i.reason), ["和 01.mkv 要去同一个位置，留在原处"]);
  assert.ok(drive.tree.get(stayed[0].srcPath), "撞名的那个留在原处");
  assert.ok(drive.tree.get(rel), "还剩一个文件，源目录不删");
  // 本地：花絮的 strm 跟到 extras/，内容改成新路径；留下的那个还在原处
  assert.equal(localRead("异形 (1979) [tmdbid=348]/extras/Alien.1979.Trailer.strm"), "/mnt/tv/异形 (1979) [tmdbid=348]/extras/Alien.1979.Trailer.mkv");
  assert.ok(localExists("异形 (1979) [tmdbid=348]/extras/sample.strm"));
  assert.ok(!localExists("inbox/Alien.1979.1080p.BluRay/Alien.1979.Trailer.strm"));
  assert.ok(localExists(`${stayed[0].srcPath.replace("/tv/", "").replace(/\.mkv$/, ".strm")}`));
  // 撤销：全部回到原处，建出来的目录删掉
  await revertRun(run.id);
  await untilStatus(run.id, ["reverted"]);
  for (const f of ["Alien.1979.1080p.BluRay.mkv", "Alien.1979.Trailer.mkv", "Featurettes/01.mkv", "Trailers/01.mkv", "sample.mkv", "更多资源请访问.txt"]) assert.ok(drive.tree.get(`${rel}/${f}`), `${f} 退回来了`);
  assert.equal(drive.tree.get(work), undefined, "作品目录和 extras/ 都删掉");
  assert.ok(localExists("inbox/Alien.1979.1080p.BluRay/Alien.1979.Trailer.strm"));
  assert.ok(!localExists("异形 (1979) [tmdbid=348]"));
});

test("自动整理挪走 / 改名了还没提交的复制：队列里的路径跟过去（发布目录没腾空也跟），整理办完放行等它的复制", async () => {
  replaceTasks([{ ...task, organize: { mode: "auto" } }]);
  const base = { account: "acc", dstBase: "/local/media", rootPath: "tv", taskId: "t1", trigger: "share" as const, afterCopy: "keep" as const, status: "pending" as const, stage: "waiting" as const, detail: "", attempts: 0, waits: 0, misses: 0 };
  const held = Date.now() + 600_000;
  saveCopies([
    { ...base, id: "movie", srcDir: "/tv/inbox", name: "Dune.Part.Two.2024.2160p.WEB-DL.mkv", dstDir: "/local/media/inbox", addedAt: Date.now() - 1_000, holdUntil: held },
    { ...base, id: "beef", srcDir: "/tv/inbox/BEEF.S01.1080p", name: "BEEF.S01E01.1080p.WEB-DL.mkv", dstDir: "/local/media/inbox/BEEF.S01.1080p", addedAt: Date.now() - 1_000, holdUntil: held },
  ]);
  try {
    // 电影把握大：直接执行，文件挪进作品目录并改名，inbox 还在（没腾空）
    const run = await createRun({ taskId: "t1", paths: ["inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"], mode: "auto", trigger: "share" });
    await untilStatus(run.id, ["done"]);
    const movie = listCopies().find((c) => c.id === "movie")!;
    assert.equal(movie.srcDir, "/tv/沙丘：第二部 (2024) [tmdbid=693134]");
    assert.equal(movie.name, "沙丘：第二部 (2024) - 2160p.mkv");
    assert.equal(movie.dstDir, "/local/media/沙丘：第二部 (2024) [tmdbid=693134]", "目标按整理后的层级摆");
    assert.equal(movie.holdUntil, undefined, "整理办完就放行");

    // 剧拿不准：留着等人确认，复制不再干等，按原路径放行
    const run2 = await createRun({ taskId: "t1", paths: ["inbox/BEEF.S01.1080p"], mode: "auto", trigger: "share" });
    await untilStatus(run2.id, ["ready"]);
    const beef = listCopies().find((c) => c.id === "beef")!;
    assert.equal(beef.srcDir, "/tv/inbox/BEEF.S01.1080p");
    assert.equal(beef.holdUntil, undefined);
  } finally {
    clearCopies();
  }
});

test("整理办完放行压着的复制按它开始那一刻的毫秒比：开始之后才登记的（哪怕同一秒）不放，要等下一次整理", async () => {
  replaceTasks([{ ...task, organize: { mode: "auto" } }]);
  const base = { account: "acc", srcDir: "/tv/other", dstBase: "/local/media", rootPath: "tv", taskId: "t1", trigger: "share" as const, afterCopy: "keep" as const, status: "pending" as const, stage: "waiting" as const, detail: "", attempts: 0, waits: 0, misses: 0, dstDir: "/local/media/other" };
  const held = Date.now() + 600_000;
  try {
    // 剧拿不准：留着等人确认，这时放行压着的复制
    const run = await createRun({ taskId: "t1", paths: ["inbox/BEEF.S01.1080p"], mode: "auto", trigger: "share" });
    saveCopies([
      { ...base, id: "before", name: "a.mkv", addedAt: run.createdAt * 1000 - 5_000, holdUntil: held },
      // created_at 只到秒：同一秒的末尾一定晚于开始那一刻，按秒比会被提前放掉
      { ...base, id: "after", name: "b.mkv", addedAt: run.createdAt * 1000 + 999, holdUntil: held },
    ]);
    await untilStatus(run.id, ["ready"]);
    assert.equal(listCopies().find((c) => c.id === "before")!.holdUntil, undefined, "开始之前登记的放行");
    assert.equal(listCopies().find((c) => c.id === "after")!.holdUntil, held, "开始之后才登记的接着压着");
  } finally {
    clearCopies();
  }
});

/* ------------------------------- 作品自己的空目录 ------------------------------- */

/** 这次整理排了哪些删空目录（网盘绝对路径，从深到浅） */
const rmdirsOf = (runId: string) => listItems(runId).filter((i) => i.action === "rmdir").map((i) => i.srcPath);

/** 预览 → 执行（自动模式直接执行完的就不用再点） */
async function organizeNow(input: Parameters<typeof createRun>[0]): Promise<string> {
  const run = await createRun(input);
  const r = await untilStatus(run.id, ["ready", "done"]);
  if (r.status === "ready") {
    await applyRun(run.id);
    await untilStatus(run.id, ["done"]);
  }
  return run.id;
}

test("手动 / 智能体整理完删掉作品独占的空目录：范围是只有片名的剧目录、季目录（单元根是上一级的剧目录）、一次给多个范围", async () => {
  // A 只有片名的剧目录：中文目录名、英文文件名，名字不像发布目录，以前留一个空壳
  drive.tree.addFile("/tv/怒呛人生/BEEF.S01E01.1080p.WEB-DL.mkv");
  let run = await createRun({ taskId: "t1", subPath: "怒呛人生", trigger: "agent" });
  await untilStatus(run.id, ["ready"]);
  assert.deepEqual(rmdirsOf(run.id), ["/tv/怒呛人生"], "清单里写着删这个空壳，执行前看得到");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(drive.tree.get("/tv/怒呛人生"), undefined);
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"));

  // B 季目录：季目录本来就删，上一级的剧目录（范围外，单元根）以前留着
  drive.tree.addFile("/tv/BEEF/Season 1/BEEF.S01E02.1080p.WEB-DL.mkv");
  insertShareFollow({
    id: "fr", name: "BEEF", libraryId: null, shareUrl: "", shareCode: "abr", receiveCode: "", watchCid: "0", watchPath: "", scope: [""],
    taskId: "t1", subPath: "BEEF", enabled: true, intervalMinutes: 60, status: "idle", lastError: "", errorStreak: 0,
    lastCheckedAt: null, lastChangeAt: null, nextCheckAt: 0, known: [], recent: [], organized: [], createdAt: 1, updatedAt: 1,
  });
  run = await createRun({ taskId: "t1", subPath: "BEEF/Season 1", trigger: "manual" });
  await untilStatus(run.id, ["ready"]);
  assert.deepEqual(rmdirsOf(run.id), ["/tv/BEEF/Season 1", "/tv/BEEF"]);
  assert.equal(getRunDetail(run.id).units[0].referencedBy, 1, "剧目录这次会删，指着它的追更也要改，算进引用数");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(drive.tree.get("/tv/BEEF"), undefined);
  assert.equal(getShareFollow("fr")!.subPath, "怒呛人生 (2023) [tmdbid=153312]", "追更跟到作品目录");

  // C 一次给多个范围：发布目录照旧删，只有片名的剧目录也删（换一套布景，免得和上面整理好的撞名）
  seed();
  drive.tree.addFile("/tv/Beef/BEEF.S01E03.1080p.WEB-DL.mkv");
  run = await createRun({ taskId: "t1", paths: ["Beef", "inbox/BEEF.S01.1080p"], trigger: "agent" });
  await untilStatus(run.id, ["ready"]);
  assert.deepEqual(rmdirsOf(run.id).sort(), ["/tv/Beef", "/tv/inbox/BEEF.S01.1080p"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(drive.tree.get("/tv/Beef"), undefined);
  assert.ok(drive.tree.get("/tv/inbox"), "收件箱不沾边");
});

test("目录名就是片名时，认不出的附属文件也跟进作品目录，目录才空得了", async () => {
  drive.tree.addFile("/tv/怒呛人生/BEEF.S01E01.1080p.WEB-DL.mkv");
  drive.tree.addFile("/tv/怒呛人生/海报.jpg");
  const run = await createRun({ taskId: "t1", subPath: "怒呛人生", trigger: "agent" });
  await untilStatus(run.id, ["ready"]);
  const art = listItems(run.id).find((i) => i.srcPath === "/tv/怒呛人生/海报.jpg")!;
  assert.equal(art.dstPath, "/tv/怒呛人生 (2023) [tmdbid=153312]/海报.jpg", "中文目录名 + 英文文件名：分单元时对不上，认出片名后知道是这部剧自己的目录");
  assert.deepEqual(rmdirsOf(run.id), ["/tv/怒呛人生"]);
});

test("留着的：名字对不上片名、只是包含片名、装着几部作品、别的任务的根目录、有云下载回执指着、还有别的东西；自动整理一律不删范围外", async () => {
  const planned = async (input: Parameters<typeof createRun>[0]) => {
    const run = await createRun(input);
    await untilStatus(run.id, ["ready"]);
    return rmdirsOf(run.id);
  };
  drive.tree.addFile("/tv/牛肉/BEEF.S01E01.1080p.WEB-DL.mkv");
  assert.deepEqual(await planned({ taskId: "t1", subPath: "牛肉", trigger: "agent" }), [], "目录名对不上片名：不知道是不是这部剧自己的目录，留着");

  drive.tree.addFile("/tv/downloads/BEEF.S01E02.1080p.WEB-DL.mkv");
  assert.deepEqual(await planned({ taskId: "t1", subPath: "downloads", trigger: "agent" }), [], "收件箱里直接放着这部剧的散文件：单元根就是它");

  drive.tree.addFile("/tv/uploads/Up.2009.1080p.BluRay.mkv");
  assert.deepEqual(await planned({ taskId: "t1", subPath: "uploads", trigger: "agent" }), [], "uploads 里包含 Up，但不是《Up》自己的目录");

  drive.tree.addFile("/tv/异形/Alien.1979.1080p.BluRay.mkv");
  drive.tree.addFile("/tv/异形/Aliens.1986.1080p.BluRay.mkv");
  assert.deepEqual(await planned({ taskId: "t1", subPath: "异形", trigger: "agent" }), [], "装着两部电影（拆成了两个单元）：名字对上其中一部也不删");

  drive.tree.addFile("/tv/BEEF/Season 1/BEEF.S01E03.1080p.WEB-DL.mkv");
  drive.tree.addFile("/tv/BEEF/Season 2/BEEF.S02E01.1080p.WEB-DL.mkv");
  assert.deepEqual(await planned({ taskId: "t1", subPath: "BEEF/Season 1", trigger: "agent" }), ["/tv/BEEF/Season 1"], "剧目录下还有 Season 2：不删");

  // 同账号别的任务就建在这个目录上，或者建在它里面
  drive.tree.addFile("/tv/怒呛人生/BEEF.S01E04.1080p.WEB-DL.mkv");
  const other: TaskDefinition = { id: "t2", account: "acc", accountType: "quark", originPath: "tv/怒呛人生", targetPath: "organize-itest/t2", strmPrefix: "/mnt" };
  replaceTasks([task, other]);
  assert.deepEqual(await planned({ taskId: "t1", subPath: "怒呛人生", trigger: "agent" }), [], "别的任务的根目录");
  replaceTasks([task, { ...other, originPath: "/tv/怒呛人生/花絮/" }]);
  assert.deepEqual(await planned({ taskId: "t1", subPath: "怒呛人生", trigger: "agent" }), [], "装着别的任务的根目录");
  replaceTasks([task]);

  // 有待兑现的云下载回执指进去：115 的目标目录加任务时就定了，删了后面的下载没地方落；兑现了的不拦
  const receipt = { kind: "strm", infoHash: "h9", account: "acc", taskId: "t1", subPath: "怒呛人生", name: "x", addedAt: Date.now(), detail: "", attempts: 0, misses: 0 };
  try {
    writeKv(KEY.offlineFollowups, [{ ...receipt, status: "pending" }]);
    assert.deepEqual(await planned({ taskId: "t1", subPath: "怒呛人生", trigger: "agent" }), [], "云下载还没下完");
    writeKv(KEY.offlineFollowups, [{ ...receipt, status: "done" }]);
    assert.deepEqual(await planned({ taskId: "t1", subPath: "怒呛人生", trigger: "agent" }), ["/tv/怒呛人生"]);
  } finally {
    writeKv(KEY.offlineFollowups, []);
  }
  assert.deepEqual(await planned({ taskId: "t1", subPath: "怒呛人生", mode: "review", trigger: "offline" }), [], "自动触发的：范围本身也不按片名删");

  // D 转存进原来就有的子目录，自动整理的新增路径是文件：不删范围外（后面几集可能还要落进来）。
  // 这次为转存新建的子目录，转存那边会把整个目录当新增路径交过来，挪空了跟着删（见 mcp-p3.itest）
  drive.tree.addFile("/tv/Beef/BEEF.S01E05.1080p.WEB-DL.mkv");
  const walked = drive.calls.walkSubtree;
  await organizeNow({ taskId: "t1", paths: ["Beef/BEEF.S01E05.1080p.WEB-DL.mkv"], mode: "auto", trigger: "share" });
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E05.mkv"));
  assert.ok(drive.tree.get("/tv/Beef"), "空了也留着");
  assert.equal(drive.calls.walkSubtree, walked, "也不去网盘整棵列它：追更、云下载每来一集都列一遍太费网盘");

  // 网盘监控给收件箱里的新文件起的自动整理：连整棵列都不列（每个新文件都列一遍收件箱太费网盘）
  drive.tree.addFile("/tv/收件箱/BEEF.S01E06.1080p.WEB-DL.mkv");
  const walks = drive.calls.walkSubtree;
  assert.deepEqual(await planned({ taskId: "t1", paths: ["收件箱/BEEF.S01E06.1080p.WEB-DL.mkv"], mode: "review", trigger: "monitor" }), []);
  assert.equal(drive.calls.walkSubtree, walks, "新增路径是文件，范围本身不整棵列；收件箱也没去列");
});

test("换了匹配按新片名重算：目录名对上了新认的片名，才排删空目录", async () => {
  drive.tree.addFile("/tv/另一部剧/BEEF.S01E01.1080p.WEB-DL.mkv");
  const run = await createRun({ taskId: "t1", subPath: "另一部剧", trigger: "agent" });
  await untilStatus(run.id, ["ready"]);
  assert.deepEqual(rmdirsOf(run.id), [], "认成了 BEEF，目录名对不上");
  const key = getRunDetail(run.id).units[0].key;
  await patchUnit(run.id, key, { match: { mediaType: "tv", tmdbId: 999 } });
  assert.deepEqual(rmdirsOf(run.id), ["/tv/另一部剧"], "换成「另一部剧」：这就是它自己的目录");
});

test("撤销：删掉的剧目录和季目录建回来，文件退回原处；追更的子目录跟过去又跟回来", async () => {
  drive.tree.addFile("/tv/BEEF/Season 1/BEEF.S01E01.1080p.WEB-DL.mkv");
  insertShareFollow({
    id: "fb", name: "BEEF", libraryId: null, shareUrl: "", shareCode: "abc", receiveCode: "", watchCid: "0", watchPath: "", scope: [""],
    taskId: "t1", subPath: "BEEF/Season 1", enabled: true, intervalMinutes: 60, status: "idle", lastError: "", errorStreak: 0,
    lastCheckedAt: null, lastChangeAt: null, nextCheckAt: 0, known: [], recent: [], organized: [], createdAt: 1, updatedAt: 1,
  });
  const runId = await organizeNow({ taskId: "t1", subPath: "BEEF/Season 1", trigger: "agent" });
  assert.equal(drive.tree.get("/tv/BEEF"), undefined);
  const moved = getShareFollow("fb")!.subPath;
  assert.ok(moved.startsWith("怒呛人生 (2023) [tmdbid=153312]"), `追更跟到作品目录：${moved}`);
  await revertRun(runId);
  await untilStatus(runId, ["reverted"]);
  assert.ok(drive.tree.get("/tv/BEEF/Season 1/BEEF.S01E01.1080p.WEB-DL.mkv"), "文件退回原处，剧目录、季目录都建回来了");
  assert.equal(getShareFollow("fb")!.subPath, "BEEF/Season 1");
});

test("撤销不拽错：落进原来就有的作品目录的，指着作品目录的追更不往回拽；删目录那条没成的，不从作品目录往回反推", async () => {
  const work = "怒呛人生 (2023) [tmdbid=153312]";
  const follow = (id: string, subPath: string) =>
    insertShareFollow({
      id, name: id, libraryId: null, shareUrl: "", shareCode: id, receiveCode: "", watchCid: "0", watchPath: "", scope: [""],
      taskId: "t1", subPath, enabled: true, intervalMinutes: 60, status: "idle", lastError: "", errorStreak: 0,
      lastCheckedAt: null, lastChangeAt: null, nextCheckAt: 0, known: [], recent: [], organized: [], createdAt: 1, updatedAt: 1,
    });
  // 作品目录原来就有（里面有第 5 集），一条追更本来就指着它
  drive.tree.addFile(`/tv/${work}/Season 01/怒呛人生 - S01E05.mkv`);
  drive.tree.addFile("/tv/BEEF/Season 1/BEEF.S01E01.1080p.WEB-DL.mkv");
  follow("fw", work);
  follow("fb", "BEEF/Season 1");
  let runId = await organizeNow({ taskId: "t1", subPath: "BEEF/Season 1", trigger: "agent" });
  assert.equal(drive.tree.get("/tv/BEEF"), undefined);
  assert.equal(getShareFollow("fb")!.subPath, `${work}/Season 01`);
  await revertRun(runId);
  await untilStatus(runId, ["reverted"]);
  assert.ok(drive.tree.get("/tv/BEEF/Season 1/BEEF.S01E01.1080p.WEB-DL.mkv"));
  assert.equal(getShareFollow("fw")!.subPath, work, "原来就指着作品目录的不往回拽");
  assert.equal(getShareFollow("fb")!.subPath, `${work}/Season 01`, "作品目录不是这次建的，分不清谁是跟过去的，一律不动");

  // 剧目录删失败了（执行时就没删成）：作品目录是这次建的，季目录那条照常跟回来；单元根那条不反推
  seed();
  replaceShareFollows([]);
  drive.tree.addFile("/tv/BEEF/Season 1/BEEF.S01E01.1080p.WEB-DL.mkv");
  follow("fb", "BEEF/Season 1");
  drive.failWriteOn = (op, p) => (op === "rmdir" && p === "/tv/BEEF" ? new Error("目录删不掉") : null);
  const run = await createRun({ taskId: "t1", subPath: "BEEF/Season 1", trigger: "agent" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done", "failed"]);
  runId = run.id;
  drive.failWriteOn = null;
  assert.ok(drive.tree.get("/tv/BEEF"), "剧目录没删成");
  // 执行完之后才建的追更，指着新的作品目录
  follow("fw", work);
  await revertRun(runId);
  await untilStatus(runId, ["reverted"]);
  assert.equal(getShareFollow("fb")!.subPath, "BEEF/Season 1", "季目录删了又建回来：跟回来");
  assert.equal(getShareFollow("fw")!.subPath, work, "剧目录一直在，没有东西从它挪到作品目录，不往回推");
});

test("115 式：没有 walkSubtree，预览只有路径，执行时按父目录列一次拿 id", async () => {
  const inner = drive;
  const noWalk = withoutWalk(inner);
  setDriveProviderFactory((a) => (a.name === "acc" ? noWalk : null));
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  assert.ok(listItems(run.id).filter((i) => i.kind !== "dir").every((i) => !i.nodeId), "预览阶段没有 id");
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  assert.ok(inner.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"));
  assert.ok(listItems(run.id).filter((i) => i.status === "done" && i.kind === "video").every((i) => i.nodeId), "执行时解析到的 id 记进流水账");
  assert.ok(inner.calls.listDir <= 3, `每个父目录只列一次，刚建的目标目录不列（实际 ${inner.calls.listDir}）`);
});

test("取消：预览中取消 → cancelled；同一任务同时只有一次整理", async () => {
  drive.beforeCall = () => new Promise((r) => setTimeout(r, 30));
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await assert.rejects(createRun({ taskId: "t1" }), /进行中/);
  cancelRun(run.id);
  const r = await untilStatus(run.id, ["cancelled", "ready"]);
  assert.ok(r.status === "cancelled" || r.status === "ready");
});

/* ------------------------------- 失败项：分类 / 重试 / 放弃 / 撤销对称 ------------------------------- */

test("临时失败在执行中自动重试一次：第一次改名抛网络错、第二次成功，不算失败", async () => {
  let calls = 0;
  drive.failWriteOn = (op, p) => (op === "rename" && p.endsWith("BEEF.S01E02.1080p.WEB-DL.mkv") && ++calls === 1 ? new Error("read ECONNRESET") : null);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0, "第二次成功了");
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "done");
  assert.equal(ep2.errorKind, "");
  assert.equal(ep2.attempts, 1, "自动重试不算一轮");
  assert.ok(done.log.some((l) => l.includes("秒后重试")), "日志里说了在重试");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv"));
});

test("预览后文件被移走：记成 stale，默认重试不碰它、点名才重试；放弃后 run 收口", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  drive.tree.remove("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 1);
  assert.equal(done.stats.failedByKind.stale, 1);
  const bad = listItems(run.id).find((i) => i.status === "failed")!;
  assert.equal(bad.errorKind, "stale");
  assert.equal(bad.attempts, 1);
  assert.ok(!done.log.some((l) => l.includes("秒后重试")), "stale 不自动重试");
  assert.equal(getRunDetail(run.id).applicable.ok, false, "默认没有可重试的");
  assert.equal(notified.filter((e) => e.type === "organize-done" && e.failedByKind?.stale === 1).length, 1, "通知里带着分类");
  // 点名重试：还是找不到，再失败一次
  await applyRun(run.id, [bad.id]);
  const again = await untilStatus(run.id, ["done"]);
  assert.equal(again.stats.failed, 1);
  assert.equal(listItems(run.id).find((i) => i.id === bad.id)!.attempts, 2, "点名重试算第二轮");
  await assert.rejects(applyRun(run.id, ["nope"]), /没有可以重试的/);
  // 放弃：标成 skipped，run 里没有失败了
  const r = await skipItems(run.id, [bad.id]);
  assert.deepEqual(r, { skipped: 1, renamedBack: 0, refused: [] });
  const after = { ...getRunDetail(run.id), items: listItems(run.id) };
  assert.equal(after.run.stats.failed, 0);
  assert.equal(after.run.stats.failedByKind.stale, 0);
  const it = after.items.find((i) => i.id === bad.id)!;
  assert.equal(it.status, "skipped");
  assert.equal(it.errorKind, "stale", "放弃了类别还留着");
  assert.match(it.error, /^已放弃：/);
  assert.equal(after.applicable.ok, false);
  // 再放弃一次：没有需要放弃的
  const r2 = await skipItems(run.id, [bad.id]);
  assert.equal(r2.skipped, 0);
  assert.equal(r2.refused.length, 1);
});

test("放弃原地改了名还没挪走的项：先在网盘上改回原名再标放弃", async () => {
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 1);
  const bad = listItems(run.id).find((i) => i.status === "failed")!;
  assert.equal(bad.errorKind, "transient");
  assert.equal(bad.curPath, "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv");
  assert.equal(bad.attempts, 1);
  drive.failWriteOn = null;
  const r = await skipItems(run.id, [bad.id]);
  assert.equal(r.renamedBack, 1);
  assert.equal(r.skipped, 1);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"), "名字改回去了");
  assert.equal(drive.tree.get("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv"), undefined);
  const it = listItems(run.id).find((i) => i.id === bad.id)!;
  assert.equal(it.status, "skipped");
  assert.equal(it.curPath, "");
  assert.equal(getRunDetail(run.id).run.stats.failed, 0);
  assert.ok(localExists("inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.strm"), "本地一直没动");
  // 改不回去就仍是失败：改名再次被拒
  seed();
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  await untilStatus(run2.id, ["done"]);
  const bad2 = listItems(run2.id).find((i) => i.status === "failed")!;
  drive.failWriteOn = (op) => (op === "rename" ? new Error("blocked by 405") : null);
  const r2 = await skipItems(run2.id, [bad2.id]);
  assert.equal(r2.skipped, 0);
  assert.equal(r2.refused.length, 1);
  const still = listItems(run2.id).find((i) => i.id === bad2.id)!;
  assert.equal(still.status, "failed");
  assert.equal(still.errorKind, "blocked");
  assert.match(still.error, /改回原名失败/);
  assert.equal(still.curPath, "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv", "位置没变");
});

test("放弃建目录项：连带放弃要进这个目录的项；中断的 run 放弃完剩下的就收口成 done", async () => {
  drive.failWriteOn = (op, p) => (op === "mkdir" && p.endsWith("Season 01") ? new Error("115：文件名不能包含特殊字符") : null);
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  const mk = listItems(run.id).find((i) => i.action === "mkdir" && i.dstPath.endsWith("Season 01"))!;
  assert.equal(mk.status, "failed");
  assert.equal(mk.errorKind, "rejected");
  assert.equal(done.stats.failedByKind.rejected, 1);
  const eps = listItems(run.id).filter((i) => i.dstPath.includes("/Season 01/"));
  assert.ok(eps.length >= 2);
  assert.ok(eps.every((i) => i.status === "failed" && i.errorKind === "stale"), "目录没建成，进目录的项都是「网盘上没有目录」");
  const r = await skipItems(run.id, [mk.id]);
  assert.equal(r.skipped, 1 + eps.length, "连带放弃");
  assert.ok(listItems(run.id).filter((i) => i.dstPath.includes("/Season 01/")).every((i) => i.status === "skipped"));
  assert.equal(getRunDetail(run.id).run.stats.failed, 0);

  // 风控中断的 run：放弃完剩下的失败项之后没有要做的了 → done
  seed();
  drive.failWriteOn = (op) => (op === "rename" ? new Error("blocked by 405") : null);
  const run2 = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  const stopped = await untilStatus(run2.id, ["failed"]);
  assert.equal(stopped.stage, "apply");
  const rest = listItems(run2.id).filter((i) => i.status === "failed" || i.status === "pending").map((i) => i.id);
  assert.ok(rest.length > 0);
  drive.failWriteOn = null;
  const r2 = await skipItems(run2.id, rest);
  assert.equal(r2.refused.length, 0);
  const after = { ...getRunDetail(run2.id), items: listItems(run2.id) };
  assert.equal(after.run.status, "done", "没剩下要做的，收口");
  assert.equal(after.run.error, "");
  assert.equal(after.applicable.ok, false);
});

test("本地镜像失败：网盘那步算完成、记成 mirror；再执行只补本地不碰网盘；放弃就是不再提醒", async () => {
  // 本地放一个同名文件挡住作品目录，镜像建不了目录
  fs.writeFileSync(path.join(LOCAL, "怒呛人生 (2023) [tmdbid=153312]"), "占位");
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0, "网盘那步都成了");
  assert.ok(done.stats.failedByKind.mirror >= 2, `本地没跟上的项（${done.stats.failedByKind.mirror}）`);
  const ep1 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  assert.equal(ep1.status, "done");
  assert.equal(ep1.errorKind, "mirror");
  assert.match(ep1.error, /本地镜像失败/);
  assert.ok(drive.tree.get(ep1.dstPath), "网盘上已经挪好");
  assert.ok(localExists("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "本地还在原处");
  assert.equal(getRunDetail(run.id).applicable.ok, true, "有本地要补");
  assert.ok(notified.some((e) => e.type === "organize-done" && (e.failedByKind?.mirror ?? 0) >= 2));
  // 补做：只动本地
  fs.rmSync(path.join(LOCAL, "怒呛人生 (2023) [tmdbid=153312]"));
  const before = { ...drive.calls };
  await applyRun(run.id);
  const again = await untilStatus(run.id, ["done"]);
  assert.equal(again.stats.failedByKind.mirror, 0);
  assert.deepEqual(
    { rename: drive.calls.rename, move: drive.calls.move, mkdir: drive.calls.mkdir, rmdir: drive.calls.rmdir },
    { rename: before.rename, move: before.move, mkdir: before.mkdir, rmdir: before.rmdir },
    "没碰网盘的写接口",
  );
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.ok(!localExists("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"));
  assert.equal(getRunDetail(run.id).applicable.ok, false);

  // 放弃镜像失败：状态还是 done，只是不再当失败项
  seed();
  fs.writeFileSync(path.join(LOCAL, "怒呛人生 (2023) [tmdbid=153312]"), "占位");
  const run2 = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  await untilStatus(run2.id, ["done"]);
  const mirrors = listItems(run2.id).filter((i) => i.errorKind === "mirror").map((i) => i.id);
  const r = await skipItems(run2.id, mirrors);
  assert.equal(r.skipped, mirrors.length);
  const items = listItems(run2.id).filter((i) => mirrors.includes(i.id));
  // 状态和类别都不变（监控见到自有事件仍会补本地），只是标了放弃、不再当失败项
  assert.ok(items.every((i) => i.status === "done" && i.errorKind === "mirror" && i.givenUp && i.error.startsWith("已放弃：本地未同步")));
  assert.equal(getRunDetail(run2.id).run.stats.failedByKind.mirror, 0);
  assert.equal(getRunDetail(run2.id).groups.length, 0, "面板里不再有它");
  assert.equal(getRunDetail(run2.id).applicable.ok, false, "也不会再被「重试」捞起来");
  assert.equal(getRunDetail(run2.id).revertable.ok, true, "网盘上动过的还能撤");
  fs.rmSync(path.join(LOCAL, "怒呛人生 (2023) [tmdbid=153312]"), { force: true });
});

test("撤销时一项在网盘上失败：状态仍是 done、记类别；run 标已撤销但有没退回的，不能再执行，再撤销一次就完成", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.stage, "revert");
  assert.equal(reverted.stats.notReverted, 1);
  assert.equal(reverted.stats.failedByKind.transient, 1);
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "done", "文件还在整理后的位置，状态照实");
  assert.equal(ep2.errorKind, "transient");
  assert.equal(ep2.curPath, "");
  assert.ok(drive.tree.get(ep2.dstPath));
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv", "本地也还在整理后的位置");
  const detail = { ...getRunDetail(run.id), items: listItems(run.id) };
  assert.equal(detail.revertable.ok, true, "还能继续撤销");
  assert.equal(detail.applicable.ok, false, "开始撤销后不能再执行");
  assert.match(detail.applicable.reason ?? "", /只能继续撤销/);
  await assert.rejects(applyRun(run.id), /只能继续撤销/);
  assert.equal(notified.filter((e) => e.type === "organize-done" && e.reverted && e.notReverted === 1).length, 1);
  // 监控：撤销失败的项本地和网盘仍一致，自有事件照旧认成自己的（按 errorKind 判，mirror 才不跳）
  assert.ok(findOwnOperation(ep2.nodeId, ep2.dstPath, Math.floor(Date.now() / 1000)));
  // 放弃撤销：文件留在整理后的位置，状态照实还是 done，只标放弃
  assert.deepEqual(getRunDetail(run.id).groups.map((g) => [g.key, g.itemIds.length, g.held]), [["transient", 1, 0]]);
  const r = await skipItems(run.id, [ep2.id]);
  assert.equal(r.skipped, 1);
  const given = listItems(run.id).find((i) => i.id === ep2.id)!;
  assert.equal(given.status, "done");
  assert.equal(given.givenUp, true);
  assert.equal(getRunDetail(run.id).revertable.ok, false, "放弃之后没有要退回的了");
  assert.equal(getRunDetail(run.id).run.stats.notReverted, 0);
  assert.equal(getRunDetail(run.id).groups.length, 0);

  // 同样的场景不放弃、再撤销一次：这次成功，连上一轮没删掉的自建目录也一起删
  seed();
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  await untilStatus(run2.id, ["done"]);
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  await revertRun(run2.id);
  await untilStatus(run2.id, ["reverted"]);
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01"), "还有文件的自建目录留着");
  drive.failWriteOn = null;
  await revertRun(run2.id);
  const again = await untilStatus(run2.id, ["reverted"]);
  assert.equal(again.stats.notReverted, 0);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"));
  assert.equal(localRead("inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.strm"), "/mnt/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  assert.equal(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]"), undefined, "空了的自建目录第二次撤销时删掉");
  assert.equal(getRunDetail(run2.id).revertable.ok, false);
});

test("撤销时挪回来了、改回原名失败：记着中间位置，再撤销只改名，本地镜像回到原位", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.failWriteOn = (op, p) => (op === "rename" && p === "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv" ? new Error("改不了") : null);
  await revertRun(run.id);
  const first = await untilStatus(run.id, ["reverted"]);
  assert.equal(first.stats.notReverted, 1);
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "done");
  assert.equal(ep2.curPath, "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv");
  assert.ok(drive.tree.get(ep2.curPath), "网盘上在中间位置");
  assert.ok(localExists("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.strm"), "本地还没动");
  // 监控在这个窗口里看到的移动事件（路径是中间位置）要认成自己的
  assert.ok(findOwnOperation(ep2.nodeId, ep2.curPath, Math.floor(Date.now() / 1000)));
  // 挪回了没改名的不给放弃
  const r = await skipItems(run.id, [ep2.id]);
  assert.equal(r.skipped, 0);
  assert.match(r.refused[0]?.reason ?? "", /只能继续撤销/);
  drive.failWriteOn = null;
  const moves = drive.calls.move;
  await revertRun(run.id);
  const second = await untilStatus(run.id, ["reverted"]);
  assert.equal(second.stats.notReverted, 0);
  assert.equal(drive.calls.move, moves, "第二次没有再挪");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"));
  assert.equal(localRead("inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.strm"), "/mnt/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  assert.ok(!localExists("怒呛人生 (2023) [tmdbid=153312]"));
  assert.equal(listItems(run.id).find((i) => i.id === ep2.id)!.curPath, "");
});

test("撤销时文件已经不在整理后的位置：记成 failed + stale 不再归整理管，其余照常退回；风控中断撤销后能继续撤销", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.tree.remove("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv");
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "failed");
  assert.equal(ep2.errorKind, "stale");
  assert.match(ep2.error, /已不在整理后的位置/);
  assert.equal(reverted.stats.notReverted, 1);
  assert.equal(reverted.stats.failedByKind.stale, 1);
  assert.equal(getRunDetail(run.id).revertable.ok, false, "找不到的不算还有事");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "其余退回了");
  const r = await skipItems(run.id, [ep2.id]);
  assert.equal(r.skipped, 1);
  assert.equal(getRunDetail(run.id).run.stats.notReverted, 0);

  seed();
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  await untilStatus(run2.id, ["done"]);
  drive.failWriteOn = (op) => (op === "move" ? new Error("blocked by 405") : null);
  await revertRun(run2.id);
  const stopped = await untilStatus(run2.id, ["failed"]);
  assert.equal(stopped.stage, "revert");
  assert.match(stopped.error, /撤销已停下/);
  assert.equal(getRunDetail(run2.id).applicable.ok, false, "撤销中断的 run 不能执行");
  assert.equal(getRunDetail(run2.id).revertable.ok, true);
  drive.failWriteOn = null;
  await revertRun(run2.id);
  const done = await untilStatus(run2.id, ["reverted"]);
  assert.equal(done.stats.notReverted, 0);
  assert.ok(drive.tree.get("/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"));
});

test("预览之后目标目录里多了同名文件：动手前先看一眼，撞名的记 rejected 不碰网盘（115 会悄悄改成 (1)），放弃时改回原名", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  // 别人往目标目录放了一个和 E02 目标同名的文件
  drive.tree.addDir("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  drive.tree.addFile("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv");
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failedByKind.rejected, 1);
  const bad = listItems(run.id).find((i) => i.status === "failed")!;
  assert.equal(bad.errorKind, "rejected");
  assert.match(bad.error, /目标目录里已经有同名文件/);
  assert.equal(bad.curPath, "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv", "原地改了名、没挪");
  assert.ok(!drive.log.some((l) => l.startsWith("move /tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv")), "没去撞");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"), "同批的其它项照常");
  const r = await skipItems(run.id, [bad.id]);
  assert.equal(r.renamedBack, 1);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"), "改回原名了");

  // 源目录里多了和新名字撞的：改名那步就拦下，文件原样不动
  seed();
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv");
  await applyRun(run2.id);
  await untilStatus(run2.id, ["done"]);
  const bad2 = listItems(run2.id).find((i) => i.status === "failed")!;
  assert.equal(bad2.errorKind, "rejected");
  assert.match(bad2.error, /源目录里已经有同名文件/);
  assert.equal(bad2.curPath, "", "还没动就拦下了");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"));
  // 放弃半路项时原名被占：不改回去，留给用户
  seed();
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  const run3 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run3.id, ["ready"]);
  await applyRun(run3.id);
  await untilStatus(run3.id, ["done"]);
  drive.failWriteOn = null;
  const half = listItems(run3.id).find((i) => i.status === "failed")!;
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  const r3 = await skipItems(run3.id, [half.id]);
  assert.equal(r3.skipped, 0);
  assert.match(r3.refused[0]?.reason ?? "", /原位置已经有同名文件/);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv"), "没动");
});

test("撤销时原位置又有了同名文件：记 rejected 不碰网盘，文件留在整理后的位置，可以放弃撤销", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv");
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.stats.notReverted, 1);
  assert.equal(reverted.stats.failedByKind.rejected, 1);
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "done");
  assert.equal(ep2.errorKind, "rejected");
  assert.match(ep2.error, /原位置已经有同名文件/);
  assert.ok(drive.tree.get(ep2.dstPath), "还在整理后的位置");
  assert.ok(!drive.log.some((l) => l.startsWith(`move ${ep2.dstPath}`)), "没去撞");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "其它退回了");
  const r = await skipItems(run.id, [ep2.id]);
  assert.equal(r.skipped, 1);
  assert.equal(getRunDetail(run.id).run.stats.notReverted, 0);
});

test("连环改名（集偏移）：目标名被本轮别的项占着不算撞名，按依赖顺序一个个改", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  const u = getRunDetail(run.id).units[0];
  // E01 → E02、E02 → E03：E01 的目标名正被 E02 占着
  await patchUnit(run.id, u.key, { episodeOffset: 1 });
  const plan = listItems(run.id).filter((i) => i.action === "move" && i.kind === "video").map((i) => [baseOf(i.srcPath), baseOf(i.dstPath)]);
  assert.deepEqual(plan, [["BEEF.S01E01.1080p.WEB-DL.mkv", "怒呛人生 - S01E02.mkv"], ["BEEF.S01E02.1080p.WEB-DL.mkv", "怒呛人生 - S01E03.mkv"]]);
  // 先把源目录里造一个「本轮别的项会占着」的局面：E02 已经原地改成了 E01 的目标名（模拟上一轮改到一半）
  drive.tree.move("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv", "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv");
  const e2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  updateItem(e2.id, { curPath: "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv" });
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0, "没有被当成撞名");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E03.mkv"));
  const renames = drive.log.filter((l) => l.startsWith("rename ") && l.includes(" -> "));
  assert.ok(renames.findIndex((l) => l.endsWith("-> 怒呛人生 - S01E03.mkv")) < renames.findIndex((l) => l.endsWith("-> 怒呛人生 - S01E02.mkv")), "占着名字的那项先改");
});

test("上次挪到一半没记账：文件已经在目标目录里就只记账，不再挪也不算撞名", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const ep1 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  // 模拟进程在 write.move 之后、记账之前崩了：文件已经在目标位置，账上还是 pending + curPath
  drive.tree.addDir("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  drive.tree.move(ep1.srcPath, ep1.dstPath);
  updateItem(ep1.id, { curPath: "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv" });
  const moves = drive.calls.move;
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  const after = listItems(run.id).find((i) => i.id === ep1.id)!;
  assert.equal(after.status, "done");
  assert.equal(after.curPath, "");
  assert.ok(!drive.log.some((l) => l.startsWith(`move /tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E01.mkv`)), "没有再挪一次");
  assert.ok(drive.calls.move > moves, "别的项照常挪");
  assert.equal(localRead("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm"), "/mnt/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv", "本地镜像补上了");
});

test("撤销阶段放弃一个执行时改了名没挪走的项：一样先改回原名；放弃掉的失败 mkdir 撤销时不碰同名目录", async () => {
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.failWriteOn = null;
  const half = listItems(run.id).find((i) => i.status === "failed")!;
  assert.ok(half.curPath, "原地改了名没挪走");
  // 撤销被风控打断在别的项上：E02 还是 failed + curPath，run 进了撤销阶段
  drive.failWriteOn = (op) => (op === "move" ? new Error("blocked by 405") : null);
  await revertRun(run.id);
  await untilStatus(run.id, ["failed"]);
  drive.failWriteOn = null;
  assert.equal(getRunDetail(run.id).run.stage, "revert");
  const r = await skipItems(run.id, [half.id]);
  assert.equal(r.renamedBack, 1, "撤销阶段也先改回原名");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"));
  assert.equal(listItems(run.id).find((i) => i.id === half.id)!.curPath, "");

  // 放弃掉的失败 mkdir：从没建过，后来别人建了同名目录，撤销时不能把它当自建目录删掉
  seed();
  drive.failWriteOn = (op, p) => (op === "mkdir" && p.endsWith("Season 01") ? new Error("115：文件名不能包含特殊字符") : null);
  const run2 = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run2.id, ["ready"]);
  await applyRun(run2.id);
  await untilStatus(run2.id, ["done"]);
  drive.failWriteOn = null;
  const mk = listItems(run2.id).find((i) => i.action === "mkdir" && i.dstPath.endsWith("Season 01"))!;
  await skipItems(run2.id, [mk.id]);
  drive.tree.addDir("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  await revertRun(run2.id);
  await untilStatus(run2.id, ["reverted"]);
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01"), "别人建的同名目录还在");
});

test("已规范命名的目录带集偏移整理：撤销也按依赖倒序退回，跨目录挪回的中间名不撞自己人", async () => {
  drive.tree.addDir("/tv/done/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  for (const e of ["01", "02", "03"]) drive.tree.addFile(`/tv/done/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E${e}.mkv`);
  const run = await createRun({ taskId: "t1", subPath: "done" });
  await untilStatus(run.id, ["ready"]);
  const u = getRunDetail(run.id).units.find((x) => x.match?.tmdbId === 153312)!;
  await patchUnit(run.id, u.key, { episodeOffset: 1 });
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  for (const e of ["02", "03", "04"]) assert.ok(drive.tree.get(`/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E${e}.mkv`), `E${e} 到位`);
  const mark = drive.log.length;
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.stats.notReverted, 0, "全部退回");
  assert.equal(reverted.stats.failed, 0);
  for (const e of ["01", "02", "03"]) assert.ok(drive.tree.get(`/tv/done/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E${e}.mkv`), `E${e} 退回原名`);
  assert.equal(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]"), undefined, "自建目录空了删掉");
  // E02←E03 的中间名 S01E03 会被 E03←E04 的原名占住：得先退 E01←E02、再 E02←E03、最后 E03←E04
  const backs = drive.log.slice(mark).filter((l) => l.startsWith("rename ") && l.includes(" -> "));
  const at = (e: string) => backs.findIndex((l) => l.endsWith(`-> 怒呛人生 - S01E${e}.mkv`));
  assert.ok(at("01") >= 0 && at("01") < at("02") && at("02") < at("03"), `退回顺序：${backs.join(" | ")}`);
});

test("目录已在库里只改集号（原地改名的连环）：撤销时按依赖倒序改回", async () => {
  drive.tree.addDir("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  for (const e of ["01", "02", "03"]) drive.tree.addFile(`/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E${e}.mkv`);
  const run = await createRun({ taskId: "t1", subPath: "怒呛人生 (2023) [tmdbid=153312]" });
  await untilStatus(run.id, ["ready"]);
  const u = getRunDetail(run.id).units.find((x) => x.match?.tmdbId === 153312)!;
  await patchUnit(run.id, u.key, { episodeOffset: 1 });
  const plan = listItems(run.id).filter((i) => i.kind === "video");
  assert.deepEqual(plan.map((i) => i.action), ["rename", "rename", "rename"]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  for (const e of ["02", "03", "04"]) assert.ok(drive.tree.get(`/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E${e}.mkv`), `E${e} 改好`);
  const mark = drive.log.length;
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.stats.notReverted, 0, "全部退回");
  for (const e of ["01", "02", "03"]) assert.ok(drive.tree.get(`/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E${e}.mkv`), `E${e} 改回`);
  assert.equal(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E04.mkv"), undefined);
  const backs = drive.log.slice(mark).filter((l) => l.startsWith("rename ") && l.includes(" -> "));
  const at = (e: string) => backs.findIndex((l) => l.endsWith(`-> 怒呛人生 - S01E${e}.mkv`));
  assert.ok(at("01") >= 0 && at("01") < at("02") && at("02") < at("03"), `改回顺序：${backs.join(" | ")}`);
});

test("放弃了本地镜像失败的项再撤销：网盘上照样退回（放弃只是不再补本地），退回后不再是放弃状态", async () => {
  fs.writeFileSync(path.join(LOCAL, "怒呛人生 (2023) [tmdbid=153312]"), "占位");
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  const mirrors = listItems(run.id).filter((i) => i.errorKind === "mirror");
  assert.ok(mirrors.length >= 2);
  await skipItems(run.id, mirrors.map((i) => i.id));
  assert.ok(listItems(run.id).filter((i) => i.givenUp).length >= 2);
  assert.equal(getRunDetail(run.id).revertable.ok, true, "网盘上挪过的项放弃了本地也还能撤");
  fs.rmSync(path.join(LOCAL, "怒呛人生 (2023) [tmdbid=153312]"));
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.stats.notReverted, 0);
  const ep1 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  assert.equal(ep1.status, "reverted");
  assert.equal(ep1.givenUp, false, "退回之后不再是放弃状态");
  assert.equal(ep1.errorKind, "");
  assert.ok(drive.tree.get(ep1.srcPath), "放弃过的项也退回了原处");
  assert.equal(drive.tree.get(ep1.dstPath), undefined);
  assert.ok(localExists("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "本地 strm 在原处");
  assert.equal(getRunDetail(run.id).revertable.ok, false);
});

test("连环改名里给我腾名字的那一项撞了别人：等它的那项不再改（名字还被占着，115 会悄悄变成 (1)），记 rejected 说明原因", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(run.id, ["ready"]);
  const u = getRunDetail(run.id).units[0];
  await patchUnit(run.id, u.key, { episodeOffset: 1 });
  // E02 已经原地改成了 E01 的目标名（上一轮改到一半），而它自己的目标名被别人占了
  drive.tree.move("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv", "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv");
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E03.mkv");
  const e2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  updateItem(e2.id, { curPath: "/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv" });
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.ok(done.stats.failed >= 2, `E01 / E02 都失败（${done.stats.failed}）`);
  const e1 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  assert.equal(e1.errorKind, "rejected");
  assert.match(e1.error, /没改成/);
  assert.equal(listItems(run.id).find((i) => i.id === e2.id)!.errorKind, "rejected");
  assert.ok(!drive.log.some((l) => l.startsWith("rename /tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv")), "没去改 E01 的名");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "E01 原地没动");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/怒呛人生 - S01E02.mkv"), "E02 还在中间名上");
});

test("跨目录移动三个串成链：目标名被本轮别的项占着的等它挪走，一轮解不开就再来一轮，不按撞名记", async () => {
  for (const d of ["a", "b", "c", "d"]) drive.tree.addDir(`/tv/${d}`);
  const x = drive.tree.addFile("/tv/a/f.mkv");
  const y = drive.tree.addFile("/tv/b/f.mkv");
  const z = drive.tree.addFile("/tv/c/f.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  // 直接改清单：X 要去的名字被 Y 占着，Y 要去的被 Z 占着；按目标目录分批的顺序，一轮只能解开 Z
  const base = { unitKey: "", kind: "video" as const, action: "move" as const, reason: "", status: "pending" as const, error: "" };
  replaceItems(run.id, [
    { id: "x", seq: 0, ...base, srcPath: "/tv/a/f.mkv", dstPath: "/tv/b/f.mkv", nodeId: x.id },
    { id: "y", seq: 1, ...base, srcPath: "/tv/b/f.mkv", dstPath: "/tv/c/f.mkv", nodeId: y.id },
    { id: "z", seq: 2, ...base, srcPath: "/tv/c/f.mkv", dstPath: "/tv/d/f.mkv", nodeId: z.id },
  ]);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0, listItems(run.id).map((i) => i.error).join(" | "));
  assert.ok(!drive.tree.get("/tv/a/f.mkv") && drive.tree.get("/tv/b/f.mkv") && drive.tree.get("/tv/c/f.mkv") && drive.tree.get("/tv/d/f.mkv"));
  assert.deepEqual(
    drive.log.filter((l) => l.startsWith("move ") && l.includes(" -> ")),
    ["move /tv/c/f.mkv -> /tv/d", "move /tv/b/f.mkv -> /tv/c", "move /tv/a/f.mkv -> /tv/b"],
    "占着名字的先挪走",
  );
});

test("进程重启时 run 停在 applying 但清单上已经没事：收口成 done 并做收尾（追更目录改写），而不是标失败卡住", async () => {
  insertShareFollow({
    id: "f5", name: "BEEF", libraryId: null, shareUrl: "", shareCode: "abe", receiveCode: "", watchCid: "0", watchPath: "", scope: [""],
    taskId: "t1", subPath: "inbox/BEEF.S01.1080p", enabled: true, intervalMinutes: 60, status: "idle", lastError: "", errorStreak: 0,
    lastCheckedAt: null, lastChangeAt: null, nextCheckAt: 0, known: [], recent: [], organized: [], createdAt: 1, updatedAt: 1,
  });
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(getShareFollow("f5")!.subPath, "怒呛人生 (2023) [tmdbid=153312]");
  // 模拟最后一项做完、run 状态还没写就重启：状态回到 applying，收尾没做过
  replaceShareFollows([{ ...getShareFollow("f5")!, subPath: "inbox/BEEF.S01.1080p" }]);
  updateRun(run.id, { status: "applying" });
  assert.equal(reconcileInterruptedRuns(), 1);
  const detail = { ...getRunDetail(run.id), items: listItems(run.id) };
  assert.equal(detail.run.status, "done");
  assert.equal(detail.run.error, "");
  assert.equal(getShareFollow("f5")!.subPath, "怒呛人生 (2023) [tmdbid=153312]", "收尾做了");
  assert.equal(detail.revertable.ok, true);
  // 真没做完的还是标失败，用户可以再执行
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  updateRun(run2.id, { status: "applying" });
  assert.equal(reconcileInterruptedRuns(), 1);
  assert.equal(getRunDetail(run2.id).run.status, "failed");
  assert.match(getRunDetail(run2.id).run.error, /进程重启/);
});

test("放弃一部分之后还剩 stale / rejected 的失败项：run 不能收口成 done；都放弃了才收口", async () => {
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  drive.tree.remove("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.failWriteOn = null;
  const e1 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  const e2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(e1.errorKind, "stale");
  assert.equal(e2.errorKind, "transient");
  // 像进程重启那样把 run 标成失败：放弃临时失败的那项之后 stale 的还在，不能算收口
  updateRun(run.id, { status: "failed", error: "进程重启" });
  await skipItems(run.id, [e2.id]);
  assert.equal(getRunDetail(run.id).run.status, "failed", "stale 的还没处理");
  assert.ok(getRunDetail(run.id).groups.some((g) => g.key === "stale"));
  await skipItems(run.id, [e1.id]);
  assert.equal(getRunDetail(run.id).run.status, "done");
  assert.equal(getRunDetail(run.id).run.error, "");
});

test("撤销时网盘说找不到（按文案归 stale）：项保持 done 记 stale，面板里有这一组，能继续撤销或放弃", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("object not found") : null);
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  drive.failWriteOn = null;
  const ep2 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E02.1080p.WEB-DL.mkv"))!;
  assert.equal(ep2.status, "done");
  assert.equal(ep2.errorKind, "stale");
  assert.equal(reverted.stats.notReverted, 1);
  const g = getRunDetail(run.id).groups.find((x) => x.key === "stale");
  assert.ok(g && g.retry && g.skip && g.itemIds.includes(ep2.id), "撤销阶段的 stale 也有一组");
  const r = await skipItems(run.id, [ep2.id]);
  assert.equal(r.skipped, 1);
  assert.equal(getRunDetail(run.id).run.stats.notReverted, 0);
  assert.equal(getRunDetail(run.id).groups.length, 0);
});

test("文件名夹着零宽空格、集数直接跟在标题后面：预览认出集数，执行后网盘和本地 strm 都换成规范名字", async () => {
  drive = new FakeDrive("quark", account);
  fs.rmSync(LOCAL, { recursive: true, force: true });
  const zw = (ep: string) => `回家的诱惑.2011.S01E\u200B${ep}\u200B`;
  drive.tree.addFile(`/tv/回家的诱惑/${zw("36")}.mkv`);
  drive.tree.addFile(`/tv/回家的诱惑/${zw("37")}.mkv`);
  drive.tree.addFile("/tv/我和僵尸有个约会/season1/我和僵尸有个约会01.mkv");
  drive.tree.addFile("/tv/我和僵尸有个约会/season1/我和僵尸有个约会10.mkv");
  writeLocalStrm(`回家的诱惑/${zw("36")}.strm`, `tv/回家的诱惑/${zw("36")}.mkv`);
  writeLocalStrm("我和僵尸有个约会/season1/我和僵尸有个约会10.strm", "tv/我和僵尸有个约会/season1/我和僵尸有个约会10.mkv");
  const run = await createRun({ taskId: "t1", subPath: "" });
  await untilStatus(run.id, ["ready"]);
  const detail = { ...getRunDetail(run.id), items: listItems(run.id) };
  assert.deepEqual(detail.units.map((u) => u.dstRoot).sort(), ["回家的诱惑 (2011) [tmdbid=84656]", "我和僵尸有个约会 (1998) [tmdbid=19389]"]);
  assert.deepEqual(detail.units.flatMap((u) => u.notes), [], "不再说「按同一部电影的多个版本处理」");
  const home = "/tv/回家的诱惑 (2011) [tmdbid=84656]/Season 01";
  const zombie = "/tv/我和僵尸有个约会 (1998) [tmdbid=19389]/Season 01";
  const srcOf = (dst: string) => detail.items.find((i) => i.dstPath === dst)?.srcPath;
  assert.equal(srcOf(`${home}/回家的诱惑 - S01E36.mkv`), `/tv/回家的诱惑/${zw("36")}.mkv`);
  assert.equal(srcOf(`${home}/回家的诱惑 - S01E37.mkv`), `/tv/回家的诱惑/${zw("37")}.mkv`);
  assert.equal(srcOf(`${zombie}/我和僵尸有个约会 - S01E01.mkv`), "/tv/我和僵尸有个约会/season1/我和僵尸有个约会01.mkv");
  assert.equal(srcOf(`${zombie}/我和僵尸有个约会 - S01E10.mkv`), "/tv/我和僵尸有个约会/season1/我和僵尸有个约会10.mkv");
  assert.equal(detail.items.filter((i) => i.action === "skip").length, 0, "没有「看不出是第几集」");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.ok(drive.tree.get(`${home}/回家的诱惑 - S01E36.mkv`));
  assert.equal(drive.tree.get(`/tv/回家的诱惑/${zw("36")}.mkv`), undefined);
  assert.equal(localRead("回家的诱惑 (2011) [tmdbid=84656]/Season 01/回家的诱惑 - S01E36.strm"), `/mnt${home}/回家的诱惑 - S01E36.mkv`);
  assert.ok(!localExists(`回家的诱惑/${zw("36")}.strm`), "夹着零宽空格的旧 strm 跟着挪走");
  assert.equal(localRead("我和僵尸有个约会 (1998) [tmdbid=19389]/Season 01/我和僵尸有个约会 - S01E10.strm"), `/mnt${zombie}/我和僵尸有个约会 - S01E10.mkv`);
});

test("范围直接选在季目录上：季号按目录认、标题按剧目录认；腾空的季目录删掉，指着它的追更改到新的季目录，撤销再改回来", async () => {
  drive = new FakeDrive("quark", account);
  fs.rmSync(LOCAL, { recursive: true, force: true });
  drive.tree.addFile("/tv/我和僵尸有个约会/season1/我和僵尸有个约会01.mkv");
  drive.tree.addFile("/tv/我和僵尸有个约会/season2/我和僵尸有个约会2.EP01.mkv");
  drive.tree.addFile("/tv/我和僵尸有个约会/season2/我和僵尸有个约会2.EP02.mkv");
  const follow = (id: string, shareCode: string, subPath: string) =>
    insertShareFollow({
      id, name: "僵尸", libraryId: null, shareUrl: "", shareCode, receiveCode: "", watchCid: "0", watchPath: "", scope: [""],
      taskId: "t1", subPath, enabled: true, intervalMinutes: 60, status: "idle", lastError: "", errorStreak: 0,
      lastCheckedAt: null, lastChangeAt: null, nextCheckAt: 0, known: [], recent: [], organized: [], createdAt: 1, updatedAt: 1,
    });
  follow("f3", "abe", "我和僵尸有个约会/season2");
  follow("f4", "abf", "我和僵尸有个约会");
  const run = await createRun({ taskId: "t1", subPath: "我和僵尸有个约会/season2" });
  await untilStatus(run.id, ["ready"]);
  const detail = { ...getRunDetail(run.id), items: listItems(run.id) };
  assert.equal(detail.units.length, 1);
  const unit = detail.units[0];
  assert.equal(unit.rootPath, "我和僵尸有个约会", "单元根是剧目录");
  assert.equal(unit.match?.tmdbId, 19389, "按剧目录名去搜，不是文件里的「我和僵尸有个约会2」");
  assert.equal(unit.referencedBy, 1, "只数范围里的追更：指着剧目录的那条这次不会改");
  const season = "/tv/我和僵尸有个约会 (1998) [tmdbid=19389]/Season 02";
  const srcOf = (dst: string) => detail.items.find((i) => i.dstPath === dst)?.srcPath;
  assert.equal(srcOf(`${season}/我和僵尸有个约会 - S02E01.mkv`), "/tv/我和僵尸有个约会/season2/我和僵尸有个约会2.EP01.mkv");
  assert.equal(srcOf(`${season}/我和僵尸有个约会 - S02E02.mkv`), "/tv/我和僵尸有个约会/season2/我和僵尸有个约会2.EP02.mkv");
  assert.deepEqual(detail.items.filter((i) => i.action === "rmdir").map((i) => i.srcPath), ["/tv/我和僵尸有个约会/season2"], "季目录腾空了删，剧目录在范围外不碰");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(drive.tree.get("/tv/我和僵尸有个约会/season2"), undefined);
  assert.ok(drive.tree.get("/tv/我和僵尸有个约会/season1/我和僵尸有个约会01.mkv"), "范围外的季不动");
  assert.equal(getShareFollow("f3")!.subPath, "我和僵尸有个约会 (1998) [tmdbid=19389]/Season 02", "追更跟到新的季目录");
  assert.equal(getShareFollow("f4")!.subPath, "我和僵尸有个约会", "剧目录还在，指着它的不动");
  await revertRun(run.id);
  await untilStatus(run.id, ["reverted"]);
  assert.ok(drive.tree.get("/tv/我和僵尸有个约会/season2/我和僵尸有个约会2.EP01.mkv"));
  assert.equal(getShareFollow("f3")!.subPath, "我和僵尸有个约会/season2", "撤销后改回原来的季目录");
});

test("整理整部剧：腾空删掉的季目录有自己的映射，指着 season2 的追更改到 Season 02（不是前缀拼出来的 作品目录/season2），撤销都改回来", async () => {
  drive = new FakeDrive("quark", account);
  fs.rmSync(LOCAL, { recursive: true, force: true });
  drive.tree.addFile("/tv/我和僵尸有个约会/season1/我和僵尸有个约会01.mkv");
  drive.tree.addFile("/tv/我和僵尸有个约会/season2/我和僵尸有个约会2.EP01.mkv");
  const follow = (id: string, shareCode: string, subPath: string) =>
    insertShareFollow({
      id, name: "僵尸", libraryId: null, shareUrl: "", shareCode, receiveCode: "", watchCid: "0", watchPath: "", scope: [""],
      taskId: "t1", subPath, enabled: true, intervalMinutes: 60, status: "idle", lastError: "", errorStreak: 0,
      lastCheckedAt: null, lastChangeAt: null, nextCheckAt: 0, known: [], recent: [], organized: [], createdAt: 1, updatedAt: 1,
    });
  follow("f5", "abg", "我和僵尸有个约会/season2");
  follow("f6", "abh", "我和僵尸有个约会");
  const run = await createRun({ taskId: "t1", subPath: "" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(drive.tree.get("/tv/我和僵尸有个约会"), undefined, "剧目录腾空删掉");
  assert.equal(getShareFollow("f5")!.subPath, "我和僵尸有个约会 (1998) [tmdbid=19389]/Season 02");
  assert.equal(getShareFollow("f6")!.subPath, "我和僵尸有个约会 (1998) [tmdbid=19389]");
  await revertRun(run.id);
  await untilStatus(run.id, ["reverted"]);
  assert.equal(getShareFollow("f5")!.subPath, "我和僵尸有个约会/season2");
  assert.equal(getShareFollow("f6")!.subPath, "我和僵尸有个约会");
});

test("本地 nfo 的 id 和它自己写的标题对不上：不采用、单元提示里说一句，按搜索认；对得上就直接用", async () => {
  const nfo = path.join(LOCAL, "inbox/BEEF.S01.1080p/tvshow.nfo");
  fs.mkdirSync(path.dirname(nfo), { recursive: true });
  fs.writeFileSync(nfo, `<tvshow><title>怒呛人生</title><uniqueid type="tmdb">999</uniqueid></tvshow>`);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const unit = getRunDetail(run.id).units.find((u) => u.rootPath === "inbox/BEEF.S01.1080p")!;
  assert.deepEqual([unit.match?.tmdbId, unit.match?.reason], [153312, "标题对上，文件名里没有年份"], "按搜索认的");
  assert.deepEqual(unit.notes, ["本地 tvshow.nfo 里的 tmdbid（999）在 TMDB 上是「另一部剧」，和 nfo 里写的标题对不上，没采用"]);
  fs.writeFileSync(nfo, `<tvshow><title>怒呛人生</title><originaltitle>BEEF</originaltitle><tmdbid>153312</tmdbid></tvshow>`);
  const again = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(again.id, ["ready"]);
  const ok = getRunDetail(again.id).units.find((u) => u.rootPath === "inbox/BEEF.S01.1080p")!;
  assert.deepEqual([ok.match?.tmdbId, ok.match?.confidence, ok.match?.reason], [153312, "high", "本地 tvshow.nfo 里的 tmdbid"]);
  assert.deepEqual(ok.notes, []);
});

test("并进已有作品目录：作品级图片撞名留在原处、不算冲突，执行照常，源目录留着那张图", async () => {
  drive.tree.addFile("/tv/怒呛人生 (2023) [tmdbid=153312]/poster.jpg");
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/poster.jpg");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  const ready = await untilStatus(run.id, ["ready"]);
  assert.equal(ready.stats.conflicts, 0);
  const detail = { ...getRunDetail(run.id), items: listItems(run.id) };
  const poster = detail.items.find((i) => i.srcPath === "/tv/inbox/BEEF.S01.1080p/poster.jpg")!;
  assert.deepEqual([poster.action, poster.reason], ["skip", "目标位置已经有同名的，留在原处"]);
  assert.ok(!detail.items.some((i) => i.action === "rmdir" && i.srcPath === "/tv/inbox/BEEF.S01.1080p"), "源目录还剩那张图，不删");
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/poster.jpg"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/tvshow.nfo"), "作品目录里没有的照常挪过去");
});

test("patchUnit 之后别的单元照旧：谁先占到目标不变，附属文件撞名还是留在原处、不算冲突", async () => {
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/poster.jpg");
  drive.tree.addFile("/tv/inbox/怒呛人生.S01.720p/怒呛人生.S01E01.720p.mkv");
  drive.tree.addFile("/tv/inbox/怒呛人生.S01.720p/poster.jpg");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const actions = () => {
    const items = listItems(run.id);
    return ["/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv", "/tv/inbox/怒呛人生.S01.720p/怒呛人生.S01E01.720p.mkv", "/tv/inbox/怒呛人生.S01.720p/poster.jpg"].map((p) => items.find((i) => i.srcPath === p)?.action);
  };
  assert.deepEqual(actions(), ["move", "conflict", "skip"]);
  await patchUnit(run.id, "inbox/BEEF.S01.1080p", { remember: true });
  assert.deepEqual(actions(), ["move", "conflict", "skip"], "改了别的单元，这边的结果不变（原来从库里的项反推，720p 那集会反过来抢到目标）");
  assert.equal(getRunDetail(run.id).run.stats.conflicts, 1);
});

/* ------------------------------- 整理页评审（2026-09-15）：并发、取消、重启、重新预览 ------------------------------- */

test("改单元还没落库时执行 / 删除回 409；改完再执行，记账落在新清单上", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const p = patchUnit(run.id, "inbox/BEEF.S01.1080p", { selected: false });
  assert.throws(() => deleteRun(run.id), /还有修改在保存/);
  await assert.rejects(applyRun(run.id), /还有修改在保存/);
  await p;
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "取消勾选的单元没动");
  assert.ok(drive.tree.get("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv"));
  assert.ok(done.stats.done > 0);
  assert.equal(done.stats.done, listItems(run.id).filter((i) => i.status === "done").length);
});

test("改单元时预览被取消：patch 回来什么都不写；换匹配等 TMDB 的时候另一个改动先落库，换匹配回来在它的基础上改", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const before = listItems(run.id).map((i) => i.id).sort();
  const p = patchUnit(run.id, "inbox/BEEF.S01.1080p", { selected: false });
  cancelRun(run.id);
  await assert.rejects(p, /不能改了/);
  assert.deepEqual(listItems(run.id).map((i) => i.id).sort(), before, "清单没被换掉");
  assert.equal(getRunDetail(run.id).units.find((u) => u.key === "inbox/BEEF.S01.1080p")?.selected, true);

  seed();
  const run2 = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run2.id, ["ready"]);
  await Promise.all([
    patchUnit(run2.id, "inbox/BEEF.S01.1080p", { match: { mediaType: "tv", tmdbId: 999 } }),
    patchUnit(run2.id, "inbox/BEEF.S01.1080p", { remember: true }),
  ]);
  const u = getRunDetail(run2.id).units.find((x) => x.key === "inbox/BEEF.S01.1080p")!;
  assert.equal(u.match?.tmdbId, 999);
  assert.equal(u.dstRoot, "另一部剧 (2020) [tmdbid=999]");
  assert.equal(u.remember, true, "「记住」没被换匹配的那次盖回去");
});

test("执行中途取消：做完的项进统计、日志有收尾那句、识别记忆照常写、不发通知；剩下的能接着执行", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await patchUnit(run.id, "inbox/BEEF.S01.1080p", { remember: true });
  // 真网盘的请求被取消时抛 AbortError：假网盘在挪 tvshow.nfo 那一刻取消并抛出（它排在最后一批）
  drive.failWriteOn = (op, p) => {
    if (op !== "move" || !p.endsWith("tvshow.nfo")) return null;
    cancelRun(run.id);
    return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  };
  await applyRun(run.id);
  const stopped = await untilStatus(run.id, ["cancelled"]);
  const items = listItems(run.id);
  assert.ok(stopped.stats.done > 0);
  assert.equal(stopped.stats.done, items.filter((i) => i.status === "done").length, "统计按清单算，不是预览时的数");
  assert.ok(stopped.stats.pending > 0, "没做的还在");
  assert.ok(stopped.log.some((l) => l.includes("已取消：")), "收尾那句进了日志");
  assert.equal(recallMatch("acc", "/tv/怒呛人生 (2023) [tmdbid=153312]")?.tmdbId, 153312, "识别记忆照常写");
  assert.equal(notified.filter((e) => e.type === "organize-done").length, 0, "取消不发通知");
  assert.equal(getRunDetail(run.id).applicable.ok, true, "剩下的能接着执行");
  drive.failWriteOn = null;
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  assert.equal(done.stats.pending, 0);
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/tvshow.nfo"));
});

test("撤销中途取消：退回的进统计；追更只在有文件真退回了的目录才改回去，一个都没退回的继续指着作品目录", async () => {
  insertShareFollow({
    id: "f9", name: "BEEF", libraryId: null, shareUrl: "", shareCode: "abz", receiveCode: "", watchCid: "0", watchPath: "", scope: [""],
    taskId: "t1", subPath: "inbox/BEEF.S01.1080p", enabled: true, intervalMinutes: 60, status: "idle", lastError: "", errorStreak: 0,
    lastCheckedAt: null, lastChangeAt: null, nextCheckAt: 0, known: [], recent: [], organized: [], createdAt: 1, updatedAt: 1,
  });
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(getShareFollow("f9")!.subPath, "怒呛人生 (2023) [tmdbid=153312]");
  // 撤销按流水账倒着退，BEEF 的文件排在前面：第一次挪回就被取消
  drive.failWriteOn = (op) => {
    if (op !== "move") return null;
    cancelRun(run.id);
    return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  };
  await revertRun(run.id);
  const stopped = await untilStatus(run.id, ["cancelled"]);
  assert.equal(stopped.stage, "revert");
  assert.ok(stopped.stats.notReverted > 0, "没退回的有数");
  assert.ok(stopped.log.some((l) => l.includes("已取消：退回")));
  assert.equal(getShareFollow("f9")!.subPath, "怒呛人生 (2023) [tmdbid=153312]", "BEEF 一个文件都没退回：追更继续指着作品目录");
  assert.equal(getRunDetail(run.id).revertable.ok, true);
  drive.failWriteOn = null;
  await revertRun(run.id);
  await untilStatus(run.id, ["reverted"]);
  assert.equal(getShareFollow("f9")!.subPath, "inbox/BEEF.S01.1080p", "退完了才改回去");
});

test("单元结构不在内存里（进程重启过）：editable=false、改单元 409，但能直接执行；重新预览按原范围和触发来源建新的手动预览", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  assert.equal(getRunDetail(run.id).editable, true);
  __test_dropPlanState(run.id);
  assert.equal(getRunDetail(run.id).editable, false);
  await assert.rejects(patchUnit(run.id, "inbox/BEEF.S01.1080p", { selected: false }), /重新预览/);
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0);
  assert.equal(getRunDetail(run.id).editable, false, "执行过的不能改");

  seed();
  const auto = await createRun({ taskId: "t1", paths: ["inbox/BEEF.S01.1080p"], mode: "review", trigger: "share" });
  await untilStatus(auto.id, ["ready"]);
  assert.equal(notified.filter((e) => e.type === "organize-review").length, 1);
  const again = await repreviewRun(auto.id);
  assert.deepEqual([again.trigger, again.mode, again.scopePaths, again.scopePath], ["share", "manual", ["inbox/BEEF.S01.1080p"], ""]);
  await untilStatus(again.id, ["ready"]);
  assert.equal(notified.filter((e) => e.type === "organize-review").length, 1, "重新预览是手动的，不再发待确认通知");
  assert.equal(getRunDetail(again.id).units.length, 1);
});

test("启动时收拢堆着的待执行预览：同任务同范围只留最新的一条", async () => {
  // 老版本留下的那种堆积：同一个任务连着好几次预览，谁也没作废谁（新预览作废旧的是后来才有的）
  const small = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(small.id, ["ready"]);
  const whole: string[] = [];
  for (let i = 0; i < 3; i++) {
    const run = await createRun({ taskId: "t1" });
    await untilStatus(run.id, ["ready"]);
    whole.push(run.id);
  }
  // 把被新预览作废掉的那几条扳回待执行，模拟没有这套收拢时的样子
  for (const id of [small.id, ...whole.slice(0, 2)]) updateRun(id, { status: "ready", error: "", finishedAt: null });
  assert.equal(collapseStaleReadyRuns(), 3, "留最新的一条「整个任务」，它覆盖得了的都作废");
  assert.deepEqual(whole.map((id) => getRunDetail(id).run.status), ["cancelled", "cancelled", "ready"]);
  assert.equal(getRunDetail(whole[0]).run.error, "已被同范围更新的预览取代");
  assert.equal(getRunDetail(small.id).run.status, "cancelled", "范围更小的那次被「整个任务」覆盖");
  assert.equal(collapseStaleReadyRuns(), 0, "再来一次没有可收的");
});

test("预览完成时作废范围被它覆盖的旧待执行预览（不覆盖的留着，整个任务覆盖一切）；作废 / 取消的预览不能当失败项执行", async () => {
  const beef = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(beef.id, ["ready"]);
  const dune = await createRun({ taskId: "t1", paths: ["inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"], mode: "review", trigger: "share" });
  await untilStatus(dune.id, ["ready"]);
  const inbox = await createRun({ taskId: "t1", subPath: "inbox" });
  const ready = await untilStatus(inbox.id, ["ready"]);
  for (const id of [beef.id, dune.id]) {
    const r = getRunDetail(id).run;
    assert.deepEqual([r.status, r.error], ["cancelled", "已被新的预览取代"]);
  }
  assert.ok(ready.log.some((l) => l.includes("作废了 2 个")));
  assert.ok(ready.log.some((l) => l.includes("预览完成")), "预览的收尾那句也落进了日志");
  const old = getRunDetail(beef.id);
  assert.deepEqual([old.executed, old.applicable.ok, old.groups.length], [false, false, 0], "作废的预览没有「没做完」的项、不能执行");
  await assert.rejects(applyRun(beef.id), /没有执行过/);

  const narrower = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
  await untilStatus(narrower.id, ["ready"]);
  assert.equal(getRunDetail(inbox.id).run.status, "ready", "范围小的不作废范围大的");
  const whole = await createRun({ taskId: "t1" });
  await untilStatus(whole.id, ["ready"]);
  assert.equal(getRunDetail(inbox.id).run.status, "cancelled");
  assert.equal(getRunDetail(narrower.id).run.status, "cancelled");
  // 手动取消的待执行预览也一样
  cancelRun(whole.id);
  assert.equal(getRunDetail(whole.id).applicable.ok, false);
});

test("待执行的预览旧了：之后同任务又执行过整理 → changed（指向那一次）；超过一天 → old；执行不拦", async () => {
  const realNow = Date.now;
  try {
    const beef = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
    await untilStatus(beef.id, ["ready"]);
    assert.equal(getRunDetail(beef.id).outdated, undefined);
    // 预览是按秒记的：把钟往后拨几秒，另一次整理结束得确实比预览晚
    Date.now = () => realNow() + 5000;
    const dune = await createRun({ taskId: "t1", paths: ["inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"], trigger: "share" });
    await untilStatus(dune.id, ["ready"]);
    assert.equal(getRunDetail(beef.id).run.status, "ready", "范围不相交，不作废");
    await applyRun(dune.id);
    await untilStatus(dune.id, ["done"]);
    const o = getRunDetail(beef.id).outdated;
    assert.deepEqual([o?.kind, o?.runId], ["changed", dune.id]);
    Date.now = realNow;
    // 清掉上面那几次（dune 的结束时间在拨过的钟上，会让新的预览也显示 changed）
    __test_resetOrganize();
    seed();
    const fresh = await createRun({ taskId: "t1", subPath: "inbox/BEEF.S01.1080p" });
    await untilStatus(fresh.id, ["ready"]);
    Date.now = () => realNow() + 25 * 3600 * 1000;
    assert.equal(getRunDetail(fresh.id).outdated?.kind, "old");
    Date.now = realNow;
    await applyRun(fresh.id);
    const done = await untilStatus(fresh.id, ["done"]);
    assert.equal(done.stats.failed, 0);
  } finally {
    Date.now = realNow;
  }
});

test("留存：放着没执行的预览过期也删；每个任务只按真正执行过的留最近几次", async () => {
  const mk = (status: OrganizeRun["status"], applied: boolean): string => {
    const run = insertRun({ id: randomUUID(), taskId: "t1", accountName: "acc", scopePath: "", scopePaths: [], mode: "manual", trigger: "manual" });
    replaceItems(run.id, [{ id: randomUUID(), unitKey: "", seq: 0, kind: "video", action: "move", srcPath: "/tv/a.mkv", dstPath: "/tv/b.mkv", nodeId: "", reason: "", status: applied ? "done" : "pending" }]);
    updateRun(run.id, { status });
    return run.id;
  };
  const applied = Array.from({ length: 7 }, () => mk("done", true));
  const previews = [mk("ready", false), mk("cancelled", false), mk("failed", false)];
  const n = deleteFinishedRunsBefore(Math.floor(Date.now() / 1000) + 60, 5);
  assert.equal(n, 2 + previews.length);
  const left = new Set(listRunRows({ taskId: "t1", limit: 200 }).map((r) => r.id));
  assert.deepEqual(applied.filter((id) => left.has(id)), applied.slice(-5), "留最近 5 次执行过的");
  assert.ok(previews.every((id) => !left.has(id)), "没执行过的预览不占名额，过期就删");
});

test("待处理：跨任务列出待执行、有失败的、自动触发的预览失败；干净完成的和手动取消的预览不列，不带日志", async () => {
  const clean = await createRun({ taskId: "t1", paths: ["inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"], trigger: "share" });
  await untilStatus(clean.id, ["ready"]);
  await applyRun(clean.id);
  await untilStatus(clean.id, ["done"]);
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("怒呛人生 - S01E02.mkv") ? new Error("改不了") : null);
  const failing = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(failing.id, ["ready"]);
  await applyRun(failing.id);
  await untilStatus(failing.id, ["done"]);
  drive.failWriteOn = null;
  const cancelled = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(cancelled.id, ["ready"]);
  cancelRun(cancelled.id);
  drive.failWith = new Error("boom");
  const autoFailed = await createRun({ taskId: "t1", paths: ["inbox/BEEF.S01.1080p"], mode: "review", trigger: "monitor" });
  await untilStatus(autoFailed.id, ["failed"]);
  drive.failWith = null;
  const waiting = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(waiting.id, ["ready"]);
  const list = listAttention();
  const reasonOf = (id: string) => list.find((a) => a.run.id === id)?.reason;
  assert.equal(reasonOf(clean.id), undefined);
  assert.equal(reasonOf(failing.id), "failures");
  assert.equal(reasonOf(cancelled.id), undefined);
  assert.equal(reasonOf(autoFailed.id), "preview-failed");
  assert.equal(reasonOf(waiting.id), "ready");
  assert.ok(list.every((a) => a.run.log.length === 0), "不带日志");
});

/* ------------------------------- 整理页评审（2026-09-15）：多个范围、按文件勾选、批量勾选、换匹配搜索 ------------------------------- */

test("手动范围要是网盘上的目录：不存在 / 是文件直接 400；套在别的范围里的去掉", async () => {
  await assert.rejects(createRun({ taskId: "t1", subPath: "nope" }), /网盘上找不到 \/tv\/nope/);
  await assert.rejects(createRun({ taskId: "t1", paths: ["inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"] }), /不是目录/);
  const run = await createRun({ taskId: "t1", paths: ["inbox", "inbox/BEEF.S01.1080p"] });
  assert.deepEqual(run.scopePaths, ["inbox"]);
  await untilStatus(run.id, ["ready"]);
});

test("手动选多个范围：每个范围照单一范围的规则来，一次预览；腾空的目录不越过范围，收件箱式的范围不删", async () => {
  drive.tree.addFile("/tv/other/Dune.Part.Two.2024.1080p.WEB-DL.mkv");
  const run = await createRun({ taskId: "t1", paths: ["inbox/BEEF.S01.1080p", "other"] });
  const ready = await untilStatus(run.id, ["ready"]);
  assert.ok(ready.log.some((l) => l.includes("（2 个目录：inbox/BEEF.S01.1080p、other）")), "日志里手动的多个范围说「N 个目录」，不说新增路径");
  const detail = getRunDetail(run.id);
  assert.deepEqual(detail.units.map((u) => u.rootPath).sort(), ["inbox/BEEF.S01.1080p", "other"]);
  assert.deepEqual(
    listItems(run.id).filter((i) => i.action === "rmdir").map((i) => i.srcPath),
    ["/tv/inbox/BEEF.S01.1080p"],
    "发布目录范围腾空了删；other 是收件箱式的范围、inbox 在范围外，都不碰",
  );
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.ok(drive.tree.get("/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 1080p.mkv"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"));
  assert.equal(drive.tree.get("/tv/inbox/BEEF.S01.1080p"), undefined);
  assert.ok(drive.tree.get("/tv/other"), "other 空了也留着");
  assert.ok(drive.tree.get("/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"), "范围外的不动");
});

test("自动整理的新增路径：它本身腾空了删，上级（转存落点）不列进删目录", async () => {
  drive.tree.addFile("/tv/转存/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  const run = await createRun({ taskId: "t1", paths: ["转存/BEEF.S01.1080p"], trigger: "share" });
  await untilStatus(run.id, ["ready"]);
  assert.deepEqual(listItems(run.id).filter((i) => i.action === "rmdir").map((i) => i.srcPath), ["/tv/转存/BEEF.S01.1080p"]);
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.equal(drive.tree.get("/tv/转存/BEEF.S01.1080p"), undefined);
  assert.ok(drive.tree.get("/tv/转存"), "转存落点空了也不删（原来会被当成空目录删掉）");
});

test("按文件勾选：勾掉的文件和它的字幕留下、源目录不删；勾回来照常；执行时勾掉的留在原处", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const ep1 = listItems(run.id).find((i) => i.srcPath.endsWith("S01E01.1080p.WEB-DL.mkv"))!;
  assert.equal((await patchItems(run.id, [ep1.id], { selected: false })).changed, 1);
  assert.deepEqual(getRunDetail(run.id).units.find((u) => u.key === "inbox/BEEF.S01.1080p")?.excluded, [ep1.srcPath]);
  const by = (suffix: string) => listItems(run.id).find((i) => i.srcPath.endsWith(suffix))!;
  assert.deepEqual([by("S01E01.1080p.WEB-DL.mkv").action, by("S01E01.1080p.WEB-DL.mkv").reason], ["skip", "没勾选这个文件"]);
  assert.equal(by("chs.srt").action, "skip", "字幕跟着它的视频留下");
  assert.equal(by("S01E02.1080p.WEB-DL.mkv").action, "move");
  assert.ok(!listItems(run.id).some((i) => i.action === "rmdir" && i.srcPath === "/tv/inbox/BEEF.S01.1080p"), "源目录还有东西，不删");
  const counts = getRunDetail(run.id).counts["inbox/BEEF.S01.1080p"];
  assert.deepEqual([counts.excluded, counts.skipped], [1, 1], "勾掉的算没勾选；跟着留下的字幕算要看一眼的跳过");
  // 勾回来：用重规划之后清单里的 id
  await patchItems(run.id, [by("S01E01.1080p.WEB-DL.mkv").id], { selected: true });
  assert.equal(by("S01E01.1080p.WEB-DL.mkv").action, "move");
  assert.equal(by("chs.srt").action, "move");
  // 勾掉第二集再执行
  await patchItems(run.id, [by("S01E02.1080p.WEB-DL.mkv").id], { selected: false });
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.mkv"), "勾掉的留在原处");
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"));
  await assert.rejects(patchItems(run.id, [ep1.id], { selected: true }), /只有待执行的整理能改/);
});

test("目录名末尾带空格（网盘上真有这种名字）：按文件勾选 / 冲突处理照样对得上号", async () => {
  drive.tree.addFile("/tv/怒呛人生/Season 1 /BEEF.S01E03.1080p.WEB-DL.mkv");
  const run = await createRun({ taskId: "t1", subPath: "怒呛人生" });
  await untilStatus(run.id, ["ready"]);
  const it = listItems(run.id).find((i) => i.srcPath.endsWith("S01E03.1080p.WEB-DL.mkv"))!;
  assert.equal(it.srcPath, "/tv/怒呛人生/Season 1 /BEEF.S01E03.1080p.WEB-DL.mkv", "记账的路径保留段尾的空格");
  assert.equal((await patchItems(run.id, [it.id], { selected: false })).changed, 1);
  const after = listItems(run.id).find((i) => i.srcPath.endsWith("S01E03.1080p.WEB-DL.mkv"))!;
  assert.deepEqual([after.action, after.reason], ["skip", "没勾选这个文件"], "取消勾选真的生效了");
});

test("冲突选「改名保留」/「挪进重复文件」：预览按办法重排，执行后网盘和本地都对得上", async () => {
  drive.tree.addFile("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  writeLocalStrm("怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.strm", "tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const by = (suffix: string) => listItems(run.id).find((i) => i.srcPath.endsWith(suffix))!;
  assert.deepEqual([by("S01E01.1080p.WEB-DL.mkv").action, by("S01E01.1080p.WEB-DL.mkv").reason], ["conflict", "目标已存在"]);
  // 改名保留：加画质后缀，字幕跟着新名字
  await patchItems(run.id, [by("S01E01.1080p.WEB-DL.mkv").id], { resolve: { how: "rename" } });
  assert.equal(by("S01E01.1080p.WEB-DL.mkv").dstPath, "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01 - 1080p.mkv");
  assert.equal(by("chs.srt").dstPath, "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01 - 1080p.zh-CN.srt");
  assert.deepEqual(getRunDetail(run.id).units.find((u) => u.key === "inbox/BEEF.S01.1080p")?.resolutions, {
    "/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv": { how: "rename" },
  });
  // 改主意：挪进重复文件目录，原来的目录层级留着
  await patchItems(run.id, [by("S01E01.1080p.WEB-DL.mkv").id], { resolve: { how: "duplicate" } });
  assert.equal(by("S01E01.1080p.WEB-DL.mkv").dstPath, "/tv/重复文件/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  assert.equal(by("chs.srt").dstPath, "/tv/重复文件/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.ok(drive.tree.get("/tv/重复文件/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"), "原来那份不动");
  assert.ok(!localExists("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "挪进重复文件目录 = 出了媒体库：本地 strm 删掉");
  assert.ok(!localExists("重复文件/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "重复文件目录不镜像到本地");
  // 重复文件目录里的东西不再当作品扫
  const again = await createRun({ taskId: "t1" });
  await untilStatus(again.id, ["ready"]);
  assert.ok(getRunDetail(again.id).units.every((u) => !u.rootPath.startsWith("重复文件")), "重复文件目录不成单元");
  // 撤销挪回来：本地 strm 跟着回来
  await revertRun(run.id);
  await untilStatus(run.id, ["reverted", "failed", "done"]);
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "网盘上挪回原处");
  assert.ok(localExists("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "本地 strm 重新生成");
});

test("冲突办法只给冲突的文件：不冲突的文件选办法回 400、名字还是模板算的；选过办法的能改主意、能撤回", async () => {
  drive.tree.addFile("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const by = (suffix: string) => listItems(run.id).find((i) => i.srcPath.endsWith(suffix))!;
  const ep2 = by("S01E02.1080p.WEB-DL.mkv");
  assert.equal(ep2.action, "move");
  for (const resolve of [{ how: "custom" as const, name: "随便起的名字" }, { how: "delete" as const }]) {
    await assert.rejects(patchItems(run.id, [ep2.id], { resolve }), (err: unknown) => err instanceof HttpError && err.status === 400 && err.extra.code === "NOT_CONFLICT");
  }
  assert.equal(by("S01E02.1080p.WEB-DL.mkv").dstPath, "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv");
  assert.deepEqual(getRunDetail(run.id).units.find((u) => u.key === "inbox/BEEF.S01.1080p")?.resolutions, {}, "被拒的没记到单元上");
  // 冲突项选了办法就不再是 conflict，照样能换办法、撤回
  await patchItems(run.id, [by("S01E01.1080p.WEB-DL.mkv").id], { resolve: { how: "rename" } });
  assert.notEqual(by("S01E01.1080p.WEB-DL.mkv").action, "conflict");
  await patchItems(run.id, [by("S01E01.1080p.WEB-DL.mkv").id], { resolve: { how: "custom", name: "怒呛人生 - S01E01 - 另一版" } });
  assert.equal(by("S01E01.1080p.WEB-DL.mkv").dstPath, "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01 - 另一版.mkv");
  // 撤回 = 留在原处（取消勾选）；要再选办法得先勾回来，勾回来又是冲突
  await patchItems(run.id, [by("S01E01.1080p.WEB-DL.mkv").id], { resolve: null });
  assert.equal(by("S01E01.1080p.WEB-DL.mkv").action, "skip");
  await assert.rejects(patchItems(run.id, [by("S01E01.1080p.WEB-DL.mkv").id], { resolve: { how: "rename" } }), /只有冲突的文件/);
  await patchItems(run.id, [by("S01E01.1080p.WEB-DL.mkv").id], { selected: true });
  assert.equal(by("S01E01.1080p.WEB-DL.mkv").action, "conflict");
  await patchItems(run.id, [by("S01E01.1080p.WEB-DL.mkv").id], { resolve: { how: "duplicate" } });
  assert.equal(by("S01E01.1080p.WEB-DL.mkv").dstPath, "/tv/重复文件/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
});

test("选过的冲突办法跟着冲突走：换季 / 集偏移清掉、同一批不许再选；没撞上的（取消勾选）清掉，重新勾上不会悄悄复活删除", async () => {
  drive.tree.addFile("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const key = "inbox/BEEF.S01.1080p";
  const by = (suffix: string) => listItems(run.id).find((i) => i.srcPath.endsWith(suffix))!;
  const unit = () => getRunDetail(run.id).units.find((u) => u.key === key)!;
  const ep1 = by("S01E01.1080p.WEB-DL.mkv");

  // 换了季：原来对着 Season 01 选的删除清掉；换回来冲突还在，但不会带着删除回来
  await patchItems(run.id, [ep1.id], { resolve: { how: "delete" } });
  assert.equal(getRunDetail(run.id).run.stats.plannedDelete, 2);
  await patchUnit(run.id, key, { seasonOverride: 2 });
  assert.deepEqual(unit().resolutions, {});
  assert.equal(getRunDetail(run.id).run.stats.plannedDelete, 0);
  await patchUnit(run.id, key, { seasonOverride: null });
  assert.equal(by("S01E01.1080p.WEB-DL.mkv").action, "conflict");
  assert.equal(getRunDetail(run.id).run.stats.plannedDelete, 0, "换回来不会复活删除");

  // 同一批里换季又给它选办法：还没看到新的冲突，不许
  await assert.rejects(
    patchPlan(run.id, { units: [{ key, seasonOverride: 2 }], files: [{ unitKey: key, srcPath: by("S01E01.1080p.WEB-DL.mkv").srcPath, resolve: { how: "delete" } }] }),
    (err: unknown) => err instanceof HttpError && err.extra.code === "RESOLVE_AFTER_REPLAN",
  );

  // 取消勾选整个单元：选过的办法没撞上就清掉，重新勾上是个没选办法的冲突
  await patchItems(run.id, [by("S01E01.1080p.WEB-DL.mkv").id], { resolve: { how: "delete" } });
  await patchUnit(run.id, key, { selected: false });
  assert.deepEqual(unit().resolutions, {});
  await patchUnit(run.id, key, { selected: true });
  assert.equal(by("S01E01.1080p.WEB-DL.mkv").action, "conflict");
  assert.equal(getRunDetail(run.id).run.stats.plannedDelete, 0);

  // 绕路：集偏移让第二集撞上第一集的位置、趁机给它起名、再把偏移改回去——改回去时名字跟着清掉，还是模板的名字
  await patchUnit(run.id, key, { episodeOffset: -1 });
  const ep2 = by("S01E02.1080p.WEB-DL.mkv");
  assert.equal(ep2.action, "conflict");
  await patchItems(run.id, [ep2.id], { resolve: { how: "custom", name: "随便起的名字" } });
  assert.match(by("S01E02.1080p.WEB-DL.mkv").dstPath, /随便起的名字\.mkv$/);
  await patchUnit(run.id, key, { episodeOffset: 0 });
  assert.equal(by("S01E02.1080p.WEB-DL.mkv").dstPath, "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E02.mkv");
  assert.deepEqual(unit().resolutions, {});
});

test("待确认的清单只能整份执行：带 ids 只挑几项的拒掉（ids 只给重试用）；能不能执行里带着删除项的个数", async () => {
  drive.tree.addFile("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const by = (suffix: string) => listItems(run.id).find((i) => i.srcPath.endsWith(suffix))!;
  await patchItems(run.id, [by("S01E01.1080p.WEB-DL.mkv").id], { resolve: { how: "delete" } });
  assert.equal(getRunSummary(run.id).applicable.deletes, 2);
  await assert.rejects(applyRun(run.id, [by("S01E02.1080p.WEB-DL.mkv").id]), (err: unknown) => err instanceof HttpError && err.extra.code === "IDS_ON_READY");
  assert.equal(getRunDetail(run.id).run.status, "ready", "什么都没执行");
});

test("冲突选「删掉这一份」/「覆盖」：执行时真删，删掉的项撤销退不回来", async () => {
  drive.tree.addFile("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const by = (suffix: string) => listItems(run.id).find((i) => i.srcPath.endsWith(suffix))!;
  await patchItems(run.id, [by("S01E01.1080p.WEB-DL.mkv").id], { resolve: { how: "delete" } });
  assert.deepEqual([by("S01E01.1080p.WEB-DL.mkv").action, by("chs.srt").action], ["delete", "delete"], "跟着的字幕一起删");
  assert.equal(getRunDetail(run.id).run.stats.plannedDelete, 2);
  // 改成覆盖：先删目标那份，再挪过去
  await patchItems(run.id, [by("S01E01.1080p.WEB-DL.mkv").id], { resolve: { how: "replace" } });
  const del = listItems(run.id).find((i) => i.action === "delete")!;
  assert.equal(del.srcPath, "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.equal(by("S01E01.1080p.WEB-DL.mkv").action, "move");
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  assert.ok(drive.log.includes("remove /tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"), "先删掉原来那份");
  const removeAt = drive.log.indexOf("remove /tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  const moveAt = drive.log.findIndex((l) => l.startsWith("move ") && l.includes("怒呛人生 - S01E01.mkv"));
  assert.ok(removeAt >= 0 && moveAt > removeAt, `删除要排在移动前面：${JSON.stringify(drive.log)}`);
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"), "位置上现在是新挪过去的那份");
  await revertRun(run.id);
  await untilStatus(run.id, ["reverted", "failed", "done"]);
  const reverted = getRunDetail(run.id);
  assert.ok(reverted.run.log.some((l) => l.includes("退不回来")), "撤销日志里说清楚删掉的退不回来");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"), "挪走的退回来了");
  assert.equal(listItems(run.id).find((i) => i.action === "delete")!.status, "done", "删掉的还是删掉了");
});

test("批量勾选单元：一次重规划；没识别出来的不能勾", async () => {
  drive.tree.addFile("/tv/inbox/Unknown.Show.S01E01.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const keys = getRunDetail(run.id).units.map((u) => u.key);
  assert.equal(keys.length, 3);
  assert.equal((await patchUnits(run.id, keys, { selected: false })).changed, 2, "识别出来的两个");
  assert.equal(getRunDetail(run.id).run.stats.planned, 0);
  assert.equal((await patchUnits(run.id, keys, { selected: true })).changed, 2);
  assert.ok(getRunDetail(run.id).units.every((u) => u.selected === !!u.match), "没识别的还是不勾");
  assert.ok(getRunDetail(run.id).run.stats.planned > 0);
});

test("换匹配弹框的 TMDB 搜索：按类型 / 年份搜（去重）、按编号查；没配 TMDB 400", async () => {
  assert.deepEqual((await searchCandidates({ query: "beef" })).map((c) => [c.tmdbId, c.mediaType]), [[153312, "tv"]]);
  assert.equal((await searchCandidates({ query: "beef", year: "2023" })).length, 1, "电影、剧集各搜一次，同一部只留一条");
  const byId = await lookupCandidate("movie", 693134);
  assert.deepEqual([byId.title, byId.year, byId.mediaType], ["沙丘：第二部", "2024", "movie"]);
  await assert.rejects(lookupCandidate("tv", 123456), /TMDB 上没有剧集 123456/);
  setOrganizeDeps({ tmdb: () => null, notify: async () => true, retryDelayMs: 5 });
  try {
    await assert.rejects(searchCandidates({ query: "x" }), /TMDB 未配置/);
  } finally {
    setOrganizeDeps({
      tmdb: (_s, opts) => new StubTmdb(opts?.fresh === true),
      notify: async (ev) => {
        notified.push(ev);
        return true;
      },
      retryDelayMs: 5,
    });
  }
});

test("刷新 TMDB 信息：按新译名重算、把握理由备选勾选照旧；没变就不动（冲突办法留着）；没识别的 400；TMDB 挂了整批不改；预览带 refreshTmdb 跳过缓存", async () => {
  // 目标位置上已有 E01：撞出一个冲突，给它选个办法，看刷新会不会把办法清掉
  drive.tree.addDir("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01");
  drive.tree.addFile("/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  drive.tree.addFile("/tv/inbox/Nobody.Knows.This.S01E01.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const key = "inbox/BEEF.S01.1080p";
  const before = listUnits(run.id).find((u) => u.key === key)!;
  assert.equal(before.match?.title, "怒呛人生");
  const conflict = listItems(run.id).find((i) => i.unitKey === key && i.action === "conflict")!;
  assert.ok(conflict, "E01 应该撞上目标位置已有的那份");
  await patchItems(run.id, [conflict.id], { resolve: { how: "rename" } });
  const resolved = listUnits(run.id).find((u) => u.key === key)!;
  assert.equal(Object.keys(resolved.resolutions).length, 1);

  // 没变：什么都不动，冲突办法还在
  StubTmdb.freshCalls = [];
  const same = await patchUnit(run.id, key, { refresh: true });
  assert.deepEqual(StubTmdb.freshCalls, [true], "刷新建的客户端要求跳过缓存");
  assert.deepEqual(same, resolved);

  // TMDB 上改了译名：按新名重算，把握 / 理由 / 备选 / 勾选照旧，原来给冲突选的办法作废
  StubTmdb.beefTitle = "怒呛人生（新译名）";
  try {
    const renamed = await patchUnit(run.id, key, { refresh: true });
    assert.equal(renamed.match?.title, "怒呛人生（新译名）");
    assert.equal(renamed.dstRoot, "怒呛人生（新译名） (2023) [tmdbid=153312]");
    assert.equal(renamed.match?.confidence, before.match?.confidence);
    assert.equal(renamed.match?.reason, before.match?.reason);
    assert.deepEqual(renamed.match?.candidates, before.match?.candidates);
    assert.equal(renamed.selected, before.selected);
    assert.deepEqual(renamed.resolutions, {});
    const items = listItems(run.id);
    assert.ok(
      items.some((i) => i.dstPath === "/tv/怒呛人生（新译名） (2023) [tmdbid=153312]/Season 01/怒呛人生（新译名） - S01E02.mkv"),
      items.map((i) => i.dstPath).join("\n"),
    );
    assert.ok(items.some((i) => i.dstPath.includes("沙丘：第二部")), "别的单元不动");

    // TMDB 挂了：整批不改
    StubTmdb.failBeef = true;
    await assert.rejects(patchUnit(run.id, key, { refresh: true }), /TMDB 挂了/);
    StubTmdb.failBeef = false;
    assert.equal(listUnits(run.id).find((u) => u.key === key)!.match?.title, "怒呛人生（新译名）");
  } finally {
    StubTmdb.beefTitle = "怒呛人生";
    StubTmdb.failBeef = false;
  }

  // 没识别出来的不能刷新
  const nobody = listUnits(run.id).find((u) => !u.match)!;
  assert.ok(nobody, "应该有一个认不出的单元");
  await assert.rejects(patchUnit(run.id, nobody.key, { refresh: true }), (err: unknown) => err instanceof HttpError && err.extra.code === "NO_MATCH");

  // 整个范围：预览 / 重新预览带 refreshTmdb → 客户端跳过缓存，日志说明
  StubTmdb.freshCalls = [];
  const whole = await createRun({ taskId: "t1", subPath: "inbox", refreshTmdb: true });
  const wholeReady = await untilStatus(whole.id, ["ready"]);
  assert.ok(StubTmdb.freshCalls.includes(true));
  assert.ok(wholeReady.log.some((l) => l.includes("刷新 TMDB 信息")), wholeReady.log.join("\n"));
  StubTmdb.freshCalls = [];
  const again = await repreviewRun(whole.id, { refreshTmdb: true });
  assert.ok((await untilStatus(again.id, ["ready"])).log.some((l) => l.includes("刷新 TMDB 信息")));
  assert.ok(StubTmdb.freshCalls.includes(true));
  StubTmdb.freshCalls = [];
  const plain = await repreviewRun(again.id);
  assert.ok(!(await untilStatus(plain.id, ["ready"])).log.some((l) => l.includes("刷新 TMDB 信息")));
  assert.ok(!StubTmdb.freshCalls.includes(true), "不带标记的照旧走缓存");
});

test("按本地 strm 结构整理：本地改了名的 strm 决定网盘的名字和位置，字幕跟着；本地 strm 只改内容；撤销连本地一起退回；TMDB 的改法被拒；同步中互相让路", async () => {
  // 模拟别的工具在本地整理过：strm 和字幕改名挪进作品目录，strm 内容仍指着网盘原路径
  const local = (rel: string) => path.join(LOCAL, ...rel.split("/"));
  fs.mkdirSync(local("怒呛人生 (2023)/Season 01"), { recursive: true });
  fs.renameSync(local("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), local("怒呛人生 (2023)/Season 01/怒呛人生 - S01E01.strm"));
  fs.renameSync(local("inbox/BEEF.S01.1080p/BEEF.S01E02.1080p.WEB-DL.strm"), local("怒呛人生 (2023)/Season 01/怒呛人生 - S01E02.strm"));
  fs.renameSync(local("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt"), local("怒呛人生 (2023)/Season 01/怒呛人生 - S01E01.chs.srt"));
  // 两个 strm 指着同一个文件：跳过
  writeLocalStrm("Movies/沙丘：第二部 (2024)/沙丘：第二部 (2024).strm", "tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv");
  writeLocalStrm("Movies/沙丘 2/沙丘 2.strm", "tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv");
  // 别的前缀的（别的任务 / 手改的）：不猜
  fs.mkdirSync(local("别的"), { recursive: true });
  fs.writeFileSync(local("别的/x.strm"), "/elsewhere/tv/inbox/x.mkv");

  // 不需要 TMDB
  setOrganizeDeps({ tmdb: () => null, notify: async () => true, retryDelayMs: 5 });
  let run: OrganizeRun;
  try {
    run = await createRun({ taskId: "t1", subPath: "inbox", naming: "local" });
  } finally {
    setOrganizeDeps({ tmdb: (_s, opts) => new StubTmdb(opts?.fresh === true), notify: async () => true, retryDelayMs: 5 });
  }
  assert.equal(run.naming, "local");
  const ready = await untilStatus(run.id, ["ready"]);
  // 两集 + 指着电影的两份 + 别的前缀的一份
  assert.ok(ready.log.some((l) => l.includes("本地 5 个 strm：对上范围里 3 个文件，2 个要改名 / 挪动") && l.includes("1 个文件被多个 strm 指着") && l.includes("1 个 strm 的内容对不上")), ready.log.join("\n"));

  const units = listUnits(run.id);
  const beef = units.find((u) => u.key === "local:怒呛人生 (2023)")!;
  assert.ok(beef, JSON.stringify(units.map((u) => u.key)));
  assert.equal(beef.match, null);
  assert.equal(beef.selected, true);
  assert.equal(beef.dstRoot, "怒呛人生 (2023)");
  assert.equal(beef.rootPath, "inbox/BEEF.S01.1080p");
  const items = listItems(run.id);
  const e01 = items.find((i) => i.srcPath === "/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv")!;
  assert.equal(e01.action, "move");
  assert.equal(e01.dstPath, "/tv/怒呛人生 (2023)/Season 01/怒呛人生 - S01E01.mkv");
  const sub = items.find((i) => i.srcPath.endsWith("BEEF.S01E01.1080p.WEB-DL.chs.srt"))!;
  assert.equal(sub.dstPath, "/tv/怒呛人生 (2023)/Season 01/怒呛人生 - S01E01.chs.srt");
  const dune = items.find((i) => i.srcPath.endsWith("Dune.Part.Two.2024.2160p.WEB-DL.mkv"))!;
  assert.equal(dune.action, "skip");
  assert.match(dune.reason, /多个 strm/);
  assert.ok(items.some((i) => i.action === "mkdir" && i.srcPath === "/tv/怒呛人生 (2023)/Season 01"));
  assert.ok(!items.some((i) => i.srcPath.endsWith("tvshow.nfo")), "没有同名前缀的视频，tvshow.nfo 不动也不进清单");
  assert.equal(getRunDetail(run.id).counts["local:inbox"]?.skipped, 1, "被两个 strm 指着的那项要算进单元的「跳过」，页面才会把它列进要处理");
  assert.equal(ready.stats.planned, 5, "两集 + 字幕 + 两层目录");

  // TMDB 那套改法没有对象；勾选 / 取消勾选照常
  await assert.rejects(patchUnit(run.id, beef.key, { match: { mediaType: "tv", tmdbId: 999 } }), (err: unknown) => err instanceof HttpError && err.extra.code === "NOT_TMDB_RUN");
  await assert.rejects(patchUnit(run.id, beef.key, { refresh: true }), (err: unknown) => err instanceof HttpError && err.extra.code === "NOT_TMDB_RUN");
  const off = await patchUnit(run.id, beef.key, { selected: false });
  assert.equal(off.selected, false);
  assert.ok(listItems(run.id).filter((i) => i.unitKey === beef.key).every((i) => i.action === "skip"));
  assert.equal((await patchUnits(run.id, [beef.key], { selected: true })).changed, 1, "批量勾选也认本地结构的单元");

  // 执行：网盘按本地结构改名挪动，本地 strm 内容换成新路径（名字位置不变），本地字幕不动
  await applyRun(run.id);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.stats.failed, 0, done.log.join("\n"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023)/Season 01/怒呛人生 - S01E01.mkv"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023)/Season 01/怒呛人生 - S01E02.mkv"));
  assert.ok(drive.tree.get("/tv/怒呛人生 (2023)/Season 01/怒呛人生 - S01E01.chs.srt"));
  assert.ok(drive.tree.get("/tv/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"), "被两个 strm 指着的没动");
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/tvshow.nfo"), "没人跟的 nfo 留在原处");
  assert.equal(localRead("怒呛人生 (2023)/Season 01/怒呛人生 - S01E01.strm"), "/mnt/tv/怒呛人生 (2023)/Season 01/怒呛人生 - S01E01.mkv");
  assert.ok(localExists("怒呛人生 (2023)/Season 01/怒呛人生 - S01E01.chs.srt"));
  assert.ok(!localExists("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"));

  // 撤销：网盘退回，本地 strm 也挪回同步时的位置和名字
  await revertRun(run.id);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.stats.notReverted, 0, reverted.log.join("\n"));
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv"));
  assert.ok(drive.tree.get("/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.chs.srt"));
  assert.equal(localRead("inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.strm"), "/mnt/tv/inbox/BEEF.S01.1080p/BEEF.S01E01.1080p.WEB-DL.mkv");
  assert.ok(!localExists("怒呛人生 (2023)/Season 01/怒呛人生 - S01E01.strm"));

  // 同步正在跑：按本地结构的预览 / 执行都等它；反过来整理在跑时同步跳过这一轮
  assert.ok(reserveTaskStart("t1"));
  try {
    await assert.rejects(createRun({ taskId: "t1", subPath: "inbox", naming: "local" }), (err: unknown) => err instanceof HttpError && err.extra.code === "TASK_SYNCING");
  } finally {
    releaseTaskStart("t1");
  }
  const planning = await createRun({ taskId: "t1", subPath: "inbox", naming: "local" });
  const sync = await startTask("t1");
  assert.equal(sync.status, 409);
  assert.match(String(sync.body.message), /整理在进行/);
  await untilStatus(planning.id, ["ready"]);
  await assert.rejects(createRun({ taskId: "t1", subPath: "inbox", naming: "local", mode: "auto" }), (err: unknown) => err instanceof HttpError && err.extra.code === "LOCAL_MANUAL_ONLY");
});

/* ------------------------------- 探测编码 ------------------------------- */

/** 假的探测：open 记下读了谁，analyze 回一个 4K HEVC DV + DDP Atmos 的结果（fail 时抛） */
const probeFake = { opened: [] as string[], fail: false };
const PROBE_RESULT = {
  media: {
    "@ref": "",
    track: [
      { "@type": "General", Format: "Matroska", Duration: "60" },
      { "@type": "Video", Format: "HEVC", Width: 3840, Height: 2160, BitDepth: 10, HDR_Format: "Dolby Vision", HDR_Format_Compatibility: "HDR10" },
      { "@type": "Audio", Format: "E-AC-3", Format_Commercial_IfAny: "Dolby Digital Plus with Dolby Atmos", Channels: 6, Language: "en", Default: "Yes" },
    ],
  },
} as unknown as MediaInfoResult;
function useProbeFake(): void {
  probeFake.opened = [];
  probeFake.fail = false;
  setProbeDeps({
    open: async (link, size) => {
      probeFake.opened.push(link.url);
      return { size: size ?? 1, read: async () => new Uint8Array(0) };
    },
    analyze: async () => {
      if (probeFake.fail) throw new Error("读文件头超时");
      return { result: PROBE_RESULT, bytesRead: 1024, reads: 1 };
    },
  });
}

test("探测编码：设置开着就在预览时探文件名缺标签的视频，模板的 {resolution} 用探测结果补；有标签的不探；第二次预览走缓存，大小变了重探", async () => {
  useProbeFake();
  try {
    drive.tree.addFile("/tv/probe/Dune.Part.Two.2024.mkv", { size: 1000 });
    drive.tree.addFile("/tv/probe/Up.2009.1080p.mkv", { size: 1000 });
    replaceAppSettings({ ...readAppSettings(), organize: { probe: "missing" } });
    const run = await createRun({ taskId: "t1", subPath: "probe" });
    await untilStatus(run.id, ["ready"]);
    assert.equal(probeFake.opened.length, 1, "只探文件名里没有分辨率的那个");
    assert.ok(probeFake.opened[0].endsWith("/tv/probe/Dune.Part.Two.2024.mkv"), probeFake.opened[0]);
    const dune = listItems(run.id).find((i) => i.srcPath.endsWith("Dune.Part.Two.2024.mkv"))!;
    assert.equal(baseOf(dune.dstPath), "沙丘：第二部 (2024) - 2160p.mkv");
    const up = listItems(run.id).find((i) => i.srcPath.endsWith("Up.2009.1080p.mkv"))!;
    assert.equal(baseOf(up.dstPath), "飞屋环游记 (2009) - 1080p.mkv", "文件名里有的以文件名为准");
    assert.ok(getRunDetail(run.id).run.log.some((l) => l.includes("探测编码：1 个视频")), getRunDetail(run.id).run.log.join("\n"));

    // 再预览：缓存里有，不碰网盘
    await cancelRun(run.id);
    const again = await createRun({ taskId: "t1", subPath: "probe" });
    await untilStatus(again.id, ["ready"]);
    assert.equal(probeFake.opened.length, 1);
    assert.equal(baseOf(listItems(again.id).find((i) => i.srcPath.endsWith("Dune.Part.Two.2024.mkv"))!.dstPath), "沙丘：第二部 (2024) - 2160p.mkv");

    // 文件换了（大小不同）：缓存不算，重探
    await cancelRun(again.id);
    drive.tree.get("/tv/probe/Dune.Part.Two.2024.mkv")!.size = 2000;
    const third = await createRun({ taskId: "t1", subPath: "probe" });
    await untilStatus(third.id, ["ready"]);
    assert.equal(probeFake.opened.length, 2);
  } finally {
    setProbeDeps(null);
  }
});

test("探测编码：设置关着预览不探；按单元探后重新规划；探缺标签的跳过有标签的和失败过的，按单元点会重试；本地结构的清单不探", async () => {
  useProbeFake();
  try {
    drive.tree.addFile("/tv/probe/Dune.Part.Two.2024.mkv", { size: 1000 });
    drive.tree.addFile("/tv/probe/Up.2009.1080p.mkv", { size: 1000 });
    const run = await createRun({ taskId: "t1", subPath: "probe" });
    await untilStatus(run.id, ["ready"]);
    assert.equal(probeFake.opened.length, 0);
    const dune = listUnits(run.id).find((u) => u.match?.tmdbId === 693134)!;
    const up = listUnits(run.id).find((u) => u.match?.tmdbId === 14160)!;
    assert.equal(baseOf(listItems(run.id).find((i) => i.srcPath.endsWith("Dune.Part.Two.2024.mkv"))!.dstPath), "沙丘：第二部 (2024).mkv");

    // 读不到：记下来，「探缺标签的」不再碰它
    probeFake.fail = true;
    let r = await probeUnits(run.id, { missing: true });
    assert.deepEqual([r.probed, r.failed, r.units], [0, 1, 0]);
    assert.equal(r.files[0].error, "读文件头超时");
    assert.equal(r.files[0].path, "/tv/probe/Dune.Part.Two.2024.mkv");
    r = await probeUnits(run.id, { missing: true });
    assert.deepEqual([r.probed, r.failed], [0, 1], "失败过的照旧算没读到、原因还在");
    assert.equal(r.files[0].error, "读文件头超时");
    assert.equal(probeFake.opened.length, 1, "但不再读网盘");

    // 按单元点：失败过的重试，读到了就重新规划
    probeFake.fail = false;
    r = await probeUnits(run.id, { key: dune.key });
    assert.deepEqual([r.probed, r.cached, r.failed, r.units], [1, 0, 0, 1]);
    assert.equal(r.files[0].summary, "HEVC · 2160p 10bit · DV · DDP Atmos 5.1 en");
    assert.equal(baseOf(listItems(run.id).find((i) => i.srcPath.endsWith("Dune.Part.Two.2024.mkv"))!.dstPath), "沙丘：第二部 (2024) - 2160p.mkv");
    // 再按单元点：直接用缓存
    r = await probeUnits(run.id, { key: dune.key });
    assert.deepEqual([r.probed, r.cached], [1, 1]);
    assert.equal(probeFake.opened.length, 2);
    // 文件名里有 1080p 的：按单元探也读，名字不变
    r = await probeUnits(run.id, { key: up.key });
    assert.equal(r.probed, 1);
    assert.equal(baseOf(listItems(run.id).find((i) => i.srcPath.endsWith("Up.2009.1080p.mkv"))!.dstPath), "飞屋环游记 (2009) - 1080p.mkv");
    // keys：这些单元里缺标签的——都有了
    r = await probeUnits(run.id, { keys: [dune.key, up.key] });
    assert.deepEqual([r.probed, r.failed], [0, 0]);
    await assert.rejects(probeUnits(run.id, {}), /至少/);
    await assert.rejects(probeUnits(run.id, { key: "nope" }), (err: unknown) => err instanceof HttpError && err.status === 404);

    await cancelRun(run.id);
    const local = await createRun({ taskId: "t1", subPath: "inbox", naming: "local" });
    await untilStatus(local.id, ["ready"]);
    await assert.rejects(probeUnits(local.id, { missing: true }), (err: unknown) => err instanceof HttpError && err.extra.code === "NOT_TMDB_RUN");
  } finally {
    setProbeDeps(null);
  }
});

/* ------------------------------- 改标题 / 钉季集 / 改文件名 ------------------------------- */

test("改标题 / 年份：按改后的命名重新规划，TMDB 的译名不动；清掉回到 TMDB 的；换匹配时清掉、同一次给的照给；记住后下次预览照用", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const key = "inbox/BEEF.S01.1080p";
  const u = await patchUnit(run.id, key, { title: "怒呛人生：第一季", year: "2024" });
  assert.equal(u.titleOverride, "怒呛人生：第一季");
  assert.equal(u.yearOverride, "2024");
  assert.equal(u.dstRoot, "怒呛人生：第一季 (2024) [tmdbid=153312]");
  assert.equal(u.match?.title, "怒呛人生");
  assert.ok(listItems(run.id).some((i) => i.dstPath === "/tv/怒呛人生：第一季 (2024) [tmdbid=153312]/Season 01/怒呛人生：第一季 - S01E01.mkv"), listItems(run.id).map((i) => i.dstPath).join("\n"));
  await assert.rejects(patchUnit(run.id, key, { title: "a/b" }), /不能带/);
  await assert.rejects(patchUnit(run.id, key, { year: "24" }), /四位/);
  const back = await patchUnit(run.id, key, { title: null, year: "" });
  assert.equal(back.titleOverride, "");
  assert.equal(back.yearOverride, "");
  assert.equal(back.dstRoot, "怒呛人生 (2023) [tmdbid=153312]");
  await patchUnit(run.id, key, { title: "另一个名字" });
  const swapped = await patchUnit(run.id, key, { match: { mediaType: "tv", tmdbId: 999 } });
  assert.equal(swapped.titleOverride, "", "换了作品，改的标题是上一部的");
  const both = await patchUnit(run.id, key, { match: { mediaType: "tv", tmdbId: 153312 }, title: "一起给的" });
  assert.equal(both.titleOverride, "一起给的");
  assert.equal(both.dstRoot, "一起给的 (2023) [tmdbid=153312]");

  // 记住：执行后记进记忆，下次在新位置认出同一部就照用
  await patchUnit(run.id, key, { title: "怒呛人生：第一季", year: "2024", remember: true });
  await applyRun(run.id);
  await untilStatus(run.id, ["done"]);
  const mem = recallMatch("acc", "/tv/怒呛人生：第一季 (2024) [tmdbid=153312]")!;
  assert.ok(mem, "记住了");
  assert.equal(mem.titleOverride, "怒呛人生：第一季");
  assert.equal(mem.yearOverride, "2024");
  const next = await createRun({ taskId: "t1", subPath: "怒呛人生：第一季 (2024) [tmdbid=153312]" });
  await untilStatus(next.id, ["ready"]);
  const row = listUnits(next.id)[0];
  assert.equal(row.titleOverride, "怒呛人生：第一季");
  assert.equal(row.yearOverride, "2024");
  assert.ok(row.notes.some((n) => n.includes("按记住的识别：标题用「怒呛人生：第一季」、年份用 2024")), row.notes.join("\n"));
  assert.equal(row.dstRoot, "怒呛人生：第一季 (2024) [tmdbid=153312]");
  assert.ok(listItems(next.id).filter((i) => i.kind === "video").every((i) => i.action === "keep"), "已经按改的名字放好了");
});

test("钉季 / 集：看不出集数的文件钉了集就能排；钉了的不受季覆盖 / 集偏移影响；只给剧集的视频；撤掉回到原样", async () => {
  drive.tree.addFile("/tv/inbox/BEEF.S01.1080p/BEEF.1080p.WEB-DL.mkv");
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const key = "inbox/BEEF.S01.1080p";
  const noEp = listItems(run.id).find((i) => i.srcPath.endsWith("/BEEF.1080p.WEB-DL.mkv"))!;
  assert.equal(noEp.action, "skip");
  assert.equal(noEp.reason, "看不出是第几集");
  const v1 = planFingerprint(run.id);
  await patchItems(run.id, [noEp.id], { pin: { season: 2, episode: 7 } });
  assert.notEqual(planFingerprint(run.id), v1);
  assert.deepEqual(listUnits(run.id).find((x) => x.key === key)!.pins, { [noEp.srcPath]: { season: 2, episode: 7 } });
  const at = () => listItems(run.id).find((i) => i.srcPath === noEp.srcPath)!;
  assert.equal(at().dstPath, "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 02/怒呛人生 - S02E07.mkv");
  await patchUnit(run.id, key, { seasonOverride: 3, episodeOffset: 10 });
  assert.equal(at().dstPath, "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 02/怒呛人生 - S02E07.mkv", "钉了的不受季覆盖 / 偏移影响");
  assert.ok(listItems(run.id).some((i) => i.dstPath.endsWith("/Season 03/怒呛人生 - S03E11.mkv")), "没钉的照旧");
  const srt = listItems(run.id).find((i) => i.kind === "subtitle")!;
  await assert.rejects(patchItems(run.id, [srt.id], { pin: { episode: 1 } }), (err: unknown) => err instanceof HttpError && err.extra.code === "PIN_NOT_VIDEO");
  const movie = listItems(run.id).find((i) => i.srcPath.endsWith("Dune.Part.Two.2024.2160p.WEB-DL.mkv"))!;
  await assert.rejects(patchItems(run.id, [movie.id], { pin: { episode: 1 } }), (err: unknown) => err instanceof HttpError && err.extra.code === "PIN_NOT_TV");
  await patchItems(run.id, [at().id], { pin: null });
  assert.deepEqual(listUnits(run.id).find((x) => x.key === key)!.pins, {});
  assert.equal(at().action, "skip");
});

test("改文件名：目录照旧、扩展名补上、字幕跟着；不能带目录；撤掉回到模板的名字", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const key = "inbox/BEEF.S01.1080p";
  const e01 = listItems(run.id).find((i) => i.srcPath.endsWith("BEEF.S01E01.1080p.WEB-DL.mkv"))!;
  const at = () => listItems(run.id).find((i) => i.srcPath === e01.srcPath)!;
  await patchItems(run.id, [e01.id], { name: "怒呛人生 第一集" });
  assert.deepEqual(listUnits(run.id).find((x) => x.key === key)!.renames, { [e01.srcPath]: "怒呛人生 第一集" });
  assert.equal(at().dstPath, "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 第一集.mkv");
  assert.equal(listItems(run.id).find((i) => i.srcPath.endsWith(".chs.srt"))!.dstPath, "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 第一集.zh-CN.srt");
  await assert.rejects(patchItems(run.id, [at().id], { name: "a/b" }), /不能带目录/);
  await patchItems(run.id, [at().id], { name: null });
  assert.deepEqual(listUnits(run.id).find((x) => x.key === key)!.renames, {});
  assert.equal(at().dstPath, "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
});

test("本地结构的清单：能改文件名（字幕跟着），不能改标题、钉季集", async () => {
  const run = await createRun({ taskId: "t1", subPath: "inbox", naming: "local" });
  await untilStatus(run.id, ["ready"]);
  const video = listItems(run.id).find((i) => i.kind === "video" && i.srcPath.endsWith("BEEF.S01E01.1080p.WEB-DL.mkv"))!;
  assert.ok(video, listItems(run.id).map((i) => i.srcPath).join("\n"));
  await assert.rejects(patchUnit(run.id, video.unitKey, { title: "x" }), (err: unknown) => err instanceof HttpError && err.extra.code === "NOT_TMDB_RUN");
  await assert.rejects(patchItems(run.id, [video.id], { pin: { episode: 3 } }), (err: unknown) => err instanceof HttpError && err.extra.code === "NOT_TMDB_RUN");
  await patchItems(run.id, [video.id], { name: "自己起的名" });
  const after = listItems(run.id).find((i) => i.srcPath === video.srcPath)!;
  assert.equal(after.action, "rename");
  assert.equal(after.dstPath, "/tv/inbox/BEEF.S01.1080p/自己起的名.mkv");
  const srt = listItems(run.id).find((i) => i.srcPath.endsWith("BEEF.S01E01.1080p.WEB-DL.chs.srt"))!;
  assert.equal(srt.dstPath, "/tv/inbox/BEEF.S01.1080p/自己起的名.chs.srt", "本地的附属文件按视频的新主名跟");
});

test("任务自己的命名模板 / id 标签 / 集标题：按任务上的规划，全局的不变", async () => {
  replaceAppSettings({ ...readAppSettings(), organize: { idTag: "jellyfin" } });
  replaceTasks([{ ...task, organize: { templates: { movie: "{title} ({year}) {idTag}/{title}.{year}.{ext}" }, idTag: "emby", episodeTitle: false } }]);
  const run = await createRun({ taskId: "t1", subPath: "inbox" });
  await untilStatus(run.id, ["ready"]);
  const items = listItems(run.id);
  assert.ok(items.some((i) => i.dstPath === "/tv/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部.2024.mkv"), items.map((i) => i.dstPath).join("\n"));
  assert.ok(items.some((i) => i.dstPath === "/tv/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv"), "剧集模板任务上没设，沿用全局默认；id 标签按任务上的 emby");
});
