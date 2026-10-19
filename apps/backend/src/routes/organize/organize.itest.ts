/**
 * 整理路由的闭环：鉴权、校验、建 run / 看详情 / 改单元 / 执行 / 撤销 / 删除、模板试算、识别记忆、清空 TMDB 缓存。
 * 网盘换成内存假网盘，TMDB 换成桩。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/organize/organize.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import axios, { type AxiosResponse } from "axios";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings, OrganizeItem, OrganizeProbeResult, OrganizeRun, OrganizeRunDetail, OrganizeRunSummary, OrganizeTemplatePreview, OrganizeUnit, TaskDefinition } from "@openstrm/shared";
import type { MediaInfoResult } from "mediainfo.js";
import { __test_resetMediaProbes } from "../../db/repositories/media-probes.js";
import { setProbeDeps } from "../../services/media/probe.js";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import organizeRoute from "./index.js";
import settingsRoute from "../settings/index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { __test_resetOrganize, readTmdbCache, rememberMatch, writeTmdbCache } from "../../db/repositories/organize.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import type { TmdbDetails, TmdbEpisode, TmdbSearchResult } from "../../services/tmdb.js";
import { TmdbClient, type TmdbApi } from "../../services/organize/identify.js";
import { setOrganizeDeps, waitForRun } from "../../services/organize/run.js";
import { FakeDrive } from "../../test/fake-drive.js";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };
const account: AccountInfo = { accountType: "quark", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "quark", originPath: "movies", targetPath: "organize-route-itest/movies", strmPrefix: "/mnt" };
const drive = new FakeDrive("quark", account);

class StubTmdb implements TmdbApi {
  /** 刷新 TMDB 信息的测试：改这个就等于 TMDB 上改了译名 */
  static duneTitle = "沙丘：第二部";
  /** 每次建客户端是不是要求跳过缓存（deps.tmdb 的 opts.fresh） */
  static freshCalls: boolean[] = [];
  constructor(fresh = false) {
    StubTmdb.freshCalls.push(fresh);
  }
  async search(query: string): Promise<TmdbSearchResult[]> {
    return query.toLowerCase() === "dune part two" ? [{ id: 693134, mediaType: "movie", title: "沙丘：第二部", year: "2024", posterUrl: "", overview: "" }] : [];
  }
  async details(kind: "movie" | "tv", id: number): Promise<TmdbDetails | null> {
    const base = { id, mediaType: kind, enTitle: "", posterUrl: "", imdbId: "", genreIds: [], countries: [], originalLanguage: "", aliases: [] };
    if (id === 693134) return { ...base, title: StubTmdb.duneTitle, originalTitle: "Dune: Part Two", year: "2024" };
    if (id === 438631) return { ...base, title: "沙丘", originalTitle: "Dune", year: "2021" };
    return null;
  }
  async season(): Promise<TmdbEpisode[]> {
    return [];
  }
}

const json = async <T,>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>, expect = 200): Promise<T> => {
  const res = await app.inject({ method, url, headers: auth, ...(payload !== undefined ? { payload } : {}) });
  assert.equal(res.statusCode, expect, `${method} ${url} → ${res.statusCode} ${res.body}`);
  return res.json() as T;
};

async function untilStatus(id: string, statuses: OrganizeRun["status"][]): Promise<OrganizeRunDetail> {
  for (let i = 0; i < 200; i++) {
    await waitForRun(id);
    const d = await json<OrganizeRunDetail>("GET", `/api/organize/runs/${id}`);
    if (statuses.includes(d.run.status)) return d;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("run 没有到预期状态");
}

before(async () => {
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  replaceTasks([task]);
  replaceAccounts([account]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"], downloadExtensions: [], tmdb: { apiKey: "x" }, organize: {} });
  await writeAuthPassword("organize-itest-pw");
  drive.tree.addFile("/movies/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv");
  drive.tree.addFile("/movies/probe/Dune.Part.Two.2024.mkv", { size: 1000 });
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  setOrganizeDeps({ tmdb: (_s, opts) => new StubTmdb(opts?.fresh === true), notify: async () => true, retryDelayMs: 5 });

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(organizeRoute);
  await app.register(settingsRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  setOrganizeDeps(null);
  setDriveProviderFactory(null);
  __test_resetOrganize();
  __test_resetMediaProbes();
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(path.join(DATA_DIR, "organize-route-itest"), { recursive: true, force: true });
});

test("没带 token 一律 401；坏输入 400", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/organize/runs" })).statusCode, 401);
  const bad = await app.inject({ method: "POST", url: "/api/organize/runs", headers: auth, payload: {} });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, "VALIDATION");
  const missing = await app.inject({ method: "POST", url: "/api/organize/runs", headers: auth, payload: { taskId: "nope" } });
  assert.equal(missing.statusCode, 404);
});

test("建 run → 详情 → 改匹配 → 执行 → 撤销 → 删除", async () => {
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "inbox" }, 201);
  assert.equal(run.status, "planning");
  const ready = await untilStatus(run.id, ["ready"]);
  assert.equal(ready.units.length, 1);
  assert.equal(ready.units[0].match?.tmdbId, 693134);
  assert.equal(ready.revertable.ok, false);
  assert.equal(ready.editable, true);

  const list = await json<{ runs: OrganizeRun[] }>("GET", "/api/organize/runs?taskId=t1");
  assert.equal(list.runs.length, 1);

  const unit = await json<OrganizeUnit>("PUT", `/api/organize/runs/${run.id}/unit`, { key: ready.units[0].key, match: { mediaType: "movie", tmdbId: 438631 }, remember: true });
  assert.equal(unit.match?.title, "沙丘");
  assert.equal(unit.dstRoot, "沙丘 (2021) [tmdbid=438631]");

  const applying = await json<OrganizeRun>("POST", `/api/organize/runs/${run.id}/apply`);
  assert.equal(applying.status, "applying");
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.run.stats.failed, 0);
  assert.ok(drive.tree.get("/movies/沙丘 (2021) [tmdbid=438631]/沙丘 (2021) - 2160p.mkv"));
  assert.equal(done.revertable.ok, true);
  // 记住了：记忆接口能看到、能删
  const matches = await json<{ matches: Array<{ srcPath: string }> }>("GET", "/api/organize/matches?account=acc");
  assert.equal(matches.matches.length, 1);
  assert.equal(matches.matches[0].srcPath, "/movies/沙丘 (2021) [tmdbid=438631]");

  // 正在进行中不能再建
  await json("POST", `/api/organize/runs/${run.id}/revert`);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.run.status, "reverted");
  assert.ok(drive.tree.get("/movies/inbox/Dune.Part.Two.2024.2160p.WEB-DL.mkv"));

  await json("DELETE", `/api/organize/runs/${run.id}`);
  await json("GET", `/api/organize/runs/${run.id}`, undefined, 404);
  await json("DELETE", "/api/organize/matches", { accountName: "acc", srcPath: "/movies/沙丘 (2021) [tmdbid=438631]" });
  assert.equal((await json<{ matches: unknown[] }>("GET", "/api/organize/matches")).matches.length, 0);
});

test("失败项：执行带 ids 只重试点名的；放弃接口标掉失败项；详情里有 applicable", async () => {
  drive.failWriteOn = (op, p) => (op === "move" && p.endsWith("沙丘：第二部 (2024) - 2160p.mkv") ? new Error("改不了") : null);
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "inbox" }, 201);
  await untilStatus(run.id, ["ready"]);
  await json("POST", `/api/organize/runs/${run.id}/apply`);
  const done = await untilStatus(run.id, ["done"]);
  assert.equal(done.run.stats.failed, 1);
  assert.equal(done.run.stats.failedByKind.transient, 1);
  assert.equal(done.applicable.ok, true);
  assert.equal(done.applicable.count, 1);
  const bad = (await json<{ items: OrganizeItem[] }>("GET", `/api/organize/runs/${run.id}/items?group=transient`)).items[0];
  assert.equal(bad.status, "failed");
  assert.equal(bad.errorKind, "transient");
  assert.equal(bad.attempts, 1);
  // 入参校验
  assert.equal((await app.inject({ method: "POST", url: `/api/organize/runs/${run.id}/skip`, headers: auth, payload: { ids: [] } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: `/api/organize/runs/${run.id}/apply`, headers: auth, payload: { ids: "x" } })).statusCode, 400);
  // 点名重试：这次成功
  drive.failWriteOn = null;
  await json("POST", `/api/organize/runs/${run.id}/apply`, { ids: [bad.id] });
  const again = await untilStatus(run.id, ["done"]);
  assert.equal(again.run.stats.failed, 0);
  assert.equal(again.applicable.ok, false);
  assert.ok(drive.tree.get("/movies/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv"));
  // 放弃：没有失败项时全是 refused
  const r = await json<{ skipped: number; refused: unknown[] }>("POST", `/api/organize/runs/${run.id}/skip`, { ids: [bad.id] });
  assert.equal(r.skipped, 0);
  assert.equal(r.refused.length, 1);
  await json("POST", `/api/organize/runs/${run.id}/revert`);
  const reverted = await untilStatus(run.id, ["reverted"]);
  assert.equal(reverted.run.stage, "revert");
  assert.equal(reverted.applicable.ok, false);
  assert.equal((await app.inject({ method: "POST", url: `/api/organize/runs/${run.id}/apply`, headers: auth })).statusCode, 409);
  await json("DELETE", `/api/organize/runs/${run.id}`);
});

test("重新预览：按原范围建一个新的手动预览（201）；没有的 run 404", async () => {
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "inbox" }, 201);
  await untilStatus(run.id, ["ready"]);
  const again = await json<OrganizeRun>("POST", `/api/organize/runs/${run.id}/repreview`, undefined, 201);
  assert.notEqual(again.id, run.id);
  assert.deepEqual([again.scopePath, again.mode, again.trigger], ["inbox", "manual", "manual"]);
  await untilStatus(again.id, ["ready"]);
  await json("POST", "/api/organize/runs/nope/repreview", undefined, 404);
  await json("DELETE", `/api/organize/runs/${run.id}`);
  await json("DELETE", `/api/organize/runs/${again.id}`);
});

test("待处理接口：要鉴权，返回 runs 数组，每条带原因、不带日志", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/organize/attention" })).statusCode, 401);
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "inbox" }, 201);
  await untilStatus(run.id, ["ready"]);
  const r = await json<{ runs: Array<{ run: OrganizeRun; reason: string }> }>("GET", "/api/organize/attention");
  const mine = r.runs.find((a) => a.run.id === run.id);
  assert.equal(mine?.reason, "ready");
  assert.deepEqual(mine?.run.log, []);
  await json("DELETE", `/api/organize/runs/${run.id}`);
});

test("详情不带项、带按单元的计数；summary 只有 run 和开关；items 按单元 / 分组按需拉，参数都没给 400", async () => {
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "inbox" }, 201);
  const d = await untilStatus(run.id, ["ready"]);
  assert.equal((d as unknown as { items?: unknown }).items, undefined, "详情不再带全部项");
  const key = d.units[0].key;
  assert.equal(d.counts[key].changing, 1);
  assert.ok(d.dirCount >= 1, "建作品目录那一项");
  const s = await json<OrganizeRunSummary>("GET", `/api/organize/runs/${run.id}/summary`);
  assert.equal(s.run.id, run.id);
  assert.equal((s as unknown as { units?: unknown }).units, undefined);
  const mine = await json<{ items: OrganizeItem[] }>("GET", `/api/organize/runs/${run.id}/items?unit=${encodeURIComponent(key)}`);
  assert.ok(mine.items.length > 0 && mine.items.every((i) => i.unitKey === key));
  const dirs = await json<{ items: OrganizeItem[] }>("GET", `/api/organize/runs/${run.id}/items?unit=`);
  assert.equal(dirs.items.length, d.dirCount);
  assert.equal((await app.inject({ method: "GET", url: `/api/organize/runs/${run.id}/items`, headers: auth })).statusCode, 400);
  await json("GET", `/api/organize/runs/nope/items?unit=`, undefined, 404);
  await json("DELETE", `/api/organize/runs/${run.id}`);
});

test("批量勾选单元、按文件勾选、TMDB 搜索 / 按编号查；参数不对 400", async () => {
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "inbox" }, 201);
  const d = await untilStatus(run.id, ["ready"]);
  const key = d.units[0].key;
  assert.equal((await json<{ changed: number }>("PUT", `/api/organize/runs/${run.id}/units`, { keys: [key], selected: false })).changed, 1);
  assert.equal((await app.inject({ method: "PUT", url: `/api/organize/runs/${run.id}/units`, headers: auth, payload: { keys: [key] } })).statusCode, 400);
  await json("PUT", `/api/organize/runs/${run.id}/units`, { keys: [key], selected: true });
  const items = (await json<{ items: OrganizeItem[] }>("GET", `/api/organize/runs/${run.id}/items?unit=${encodeURIComponent(key)}`)).items;
  const video = items.find((i) => i.kind === "video")!;
  assert.equal((await json<{ changed: number }>("PUT", `/api/organize/runs/${run.id}/items`, { ids: [video.id], selected: false })).changed, 1);
  assert.equal((await json<OrganizeRunDetail>("GET", `/api/organize/runs/${run.id}`)).counts[key].excluded, 1);
  assert.equal((await app.inject({ method: "PUT", url: `/api/organize/runs/${run.id}/items`, headers: auth, payload: { ids: [], selected: true } })).statusCode, 400);
  const s = await json<{ results: Array<{ tmdbId: number }> }>("POST", "/api/organize/tmdb/search", { query: "dune part two", type: "movie", year: "2024" });
  assert.equal(s.results[0].tmdbId, 693134);
  assert.equal((await app.inject({ method: "POST", url: "/api/organize/tmdb/search", headers: auth, payload: { query: "x", year: "24" } })).statusCode, 400);
  assert.equal((await json<{ title: string }>("GET", "/api/organize/tmdb/movie/438631")).title, "沙丘");
  await json("GET", "/api/organize/tmdb/tv/1", undefined, 404);
  await json("DELETE", `/api/organize/runs/${run.id}`);
});

test("模板试算：默认模板出样例；坏模板报错但不抛", async () => {
  const ok = await json<OrganizeTemplatePreview>("POST", "/api/organize/preview-name", {});
  assert.equal(ok.movie, "沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv");
  assert.equal(ok.tv, "怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv");
  assert.deepEqual(ok.errors, []);
  const plex = await json<OrganizeTemplatePreview>("POST", "/api/organize/preview-name", { idTag: "plex", episodeTitle: true, templates: { tv: "{title}/S{season00}E{episode00}[ - {episodeTitle}].{ext}" } });
  assert.equal(plex.movie, "沙丘：第二部 (2024) {tmdb-693134}/沙丘：第二部 (2024) - 2160p.mkv");
  assert.equal(plex.tv, "怒呛人生/S01E01 - 飞鸟不鸣.mkv");
  const bad = await json<OrganizeTemplatePreview>("POST", "/api/organize/preview-name", { templates: { movie: "{titel}.{ext}" }, rules: ["a <> b >> 1"] });
  assert.equal(bad.errors.length, 2);
});

test("设置：坏模板 / 坏识别词存不进去；好的存得进去", async () => {
  const bad = await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { organize: { templates: { movie: "{title}" } } } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /ext/);
  const badRule = await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { organize: { rules: ["x <> y >> nope"] } } });
  assert.equal(badRule.statusCode, 400);
  await json("PUT", "/api/settings", { organize: { idTag: "jellyfin", rules: ["高清剧集"], auto: "review" } });
  assert.equal(readAppSettings().organize?.idTag, "jellyfin");
  rememberMatch({ accountName: "acc", srcPath: "/x", mediaType: "tv", tmdbId: 1, title: "", year: "", season: null, episodeOffset: 0 });
});

test("清空 TMDB 缓存：库里的行删掉，还活着的客户端把进程内 memo 一起丢掉", async () => {
  const key = "details:movie:438631:zh-CN";
  writeTmdbCache(key, { id: 438631, title: "沙丘", collection: null });
  const client = new TmdbClient("x", "zh-CN");
  assert.equal((await client.details("movie", 438631))?.title, "沙丘");

  const { cleared } = await json<{ cleared: number }>("DELETE", "/api/organize/tmdb/cache");
  assert.ok(cleared >= 1);
  assert.equal(readTmdbCache(key, 3600), null);

  // 库里换成新的一版：memo 要是没丢，读到的还是旧的「沙丘」
  writeTmdbCache(key, { id: 438631, title: "沙丘（新译名）", collection: null });
  assert.equal((await client.details("movie", 438631))?.title, "沙丘（新译名）");
  assert.ok((await json<{ cleared: number }>("DELETE", "/api/organize/tmdb/cache")).cleared >= 1);
});

test("刷新 TMDB 信息的客户端：详情跳过库里的值直接问 TMDB、拉到的写回；同一个客户端第二次走 memo", async () => {
  const key = "details:movie:693134:zh-CN";
  writeTmdbCache(key, { id: 693134, title: "旧译名", collection: null });
  let calls = 0;
  const adapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    calls += 1;
    return { data: { id: 693134, title: "沙丘：第二部", original_title: "Dune: Part Two", release_date: "2024-02-27" }, status: 200, statusText: "OK", headers: {}, config } as AxiosResponse;
  };
  try {
    assert.equal((await new TmdbClient("x", "zh-CN").details("movie", 693134))?.title, "旧译名", "不刷新的照旧读缓存");
    const fresh = new TmdbClient("x", "zh-CN", { fresh: true });
    assert.equal((await fresh.details("movie", 693134))?.title, "沙丘：第二部");
    assert.equal(calls, 1);
    assert.equal(readTmdbCache<{ title: string }>(key, 3600)?.title, "沙丘：第二部", "拉到的写回库里");
    await fresh.details("movie", 693134);
    assert.equal(calls, 1, "同一个客户端第二次走 memo");
    assert.equal((await new TmdbClient("x", "zh-CN").details("movie", 693134))?.title, "沙丘：第二部", "别的客户端从库里读到新的");
    assert.equal(calls, 1);
  } finally {
    axios.defaults.adapter = adapter;
  }
});

test("刷新 TMDB 信息：单元按新译名重算，没变就什么都不动，没识别的 400；预览 / 重新预览带 refreshTmdb 跳过缓存", async () => {
  drive.tree.addFile("/movies/refresh/Dune.Part.Two.2024.2160p.WEB-DL.mkv");
  drive.tree.addFile("/movies/refresh/Nobody.Knows.This.2020.mkv");
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "refresh" }, 201);
  const ready = await untilStatus(run.id, ["ready"]);
  const dune = ready.units.find((u) => u.match?.tmdbId === 693134)!;
  const nobody = ready.units.find((u) => !u.match)!;
  assert.ok(dune && nobody, JSON.stringify(ready.units.map((u) => [u.key, u.match?.tmdbId])));
  // 前面的测试把 id 标签写法改成了 jellyfin，这里不认死一种
  assert.match(dune.dstRoot, /^沙丘：第二部 \(2024\) \[tmdbid[=-]693134\]$/);

  // 没变：200、单元原样
  StubTmdb.freshCalls = [];
  const same = await json<OrganizeUnit>("PUT", `/api/organize/runs/${run.id}/unit`, { key: dune.key, refresh: true });
  assert.deepEqual(StubTmdb.freshCalls, [true], "刷新建的客户端要求跳过缓存");
  assert.equal(same.match?.title, "沙丘：第二部");
  assert.equal(same.dstRoot, dune.dstRoot);

  // TMDB 上改了译名：按新名重算，把握和理由照旧
  StubTmdb.duneTitle = "沙丘 2";
  try {
    const renamed = await json<OrganizeUnit>("PUT", `/api/organize/runs/${run.id}/unit`, { key: dune.key, refresh: true });
    assert.equal(renamed.match?.title, "沙丘 2");
    assert.equal(renamed.dstRoot, dune.dstRoot.replace("沙丘：第二部", "沙丘 2"));
    assert.equal(renamed.match?.confidence, dune.match?.confidence);
    assert.equal(renamed.match?.reason, dune.match?.reason);
    assert.equal(renamed.selected, dune.selected);
    const items = await json<{ items: OrganizeItem[] }>("GET", `/api/organize/runs/${run.id}/items?unit=${encodeURIComponent(dune.key)}`);
    assert.ok(items.items.some((it) => it.dstPath.includes("沙丘 2 (2024)")), JSON.stringify(items.items.map((it) => it.dstPath)));
  } finally {
    StubTmdb.duneTitle = "沙丘：第二部";
  }

  // 没识别出来的不能刷新
  const bad = await app.inject({ method: "PUT", url: `/api/organize/runs/${run.id}/unit`, headers: auth, payload: { key: nobody.key, refresh: true } });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().code, "NO_MATCH");

  // 整个范围：预览和重新预览都能带 refreshTmdb
  StubTmdb.freshCalls = [];
  const whole = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "refresh", refreshTmdb: true }, 201);
  const wholeReady = await untilStatus(whole.id, ["ready"]);
  assert.ok(StubTmdb.freshCalls.includes(true));
  assert.ok(wholeReady.run.log.some((l) => l.includes("刷新 TMDB 信息")), wholeReady.run.log.join("\n"));
  StubTmdb.freshCalls = [];
  const again = await json<OrganizeRun>("POST", `/api/organize/runs/${whole.id}/repreview`, { refreshTmdb: true }, 201);
  const againReady = await untilStatus(again.id, ["ready"]);
  assert.ok(StubTmdb.freshCalls.includes(true));
  assert.ok(againReady.run.log.some((l) => l.includes("刷新 TMDB 信息")));
  StubTmdb.freshCalls = [];
  const plain = await json<OrganizeRun>("POST", `/api/organize/runs/${again.id}/repreview`, {}, 201);
  const plainReady = await untilStatus(plain.id, ["ready"]);
  assert.ok(!StubTmdb.freshCalls.includes(true), "不带标记的照旧走缓存");
  assert.ok(!plainReady.run.log.some((l) => l.includes("刷新 TMDB 信息")));
});

test("命名来源：naming=local 建的 run 记着来源、不要 TMDB；没有本地 strm 就是 0 个单元；别的值 400", async () => {
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "refresh", naming: "local" }, 201);
  assert.equal(run.naming, "local");
  const ready = await untilStatus(run.id, ["ready"]);
  assert.equal(ready.run.naming, "local");
  assert.equal(ready.units.length, 0);
  // 前面的测试执行过一次整理，本地留着一个指着别处的 strm：对上范围里 0 个文件
  assert.ok(ready.run.log.some((l) => l.includes("个 strm：对上范围里 0 个文件")), ready.run.log.join("\n"));
  const again = await json<OrganizeRun>("POST", `/api/organize/runs/${run.id}/repreview`, {}, 201);
  assert.equal(again.naming, "local", "重新预览沿用命名来源");
  await untilStatus(again.id, ["ready"]);
  const bad = await app.inject({ method: "POST", url: "/api/organize/runs", headers: auth, payload: { taskId: "t1", subPath: "refresh", naming: "bogus" } });
  assert.equal(bad.statusCode, 400);
  const plain = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "refresh" }, 201);
  assert.equal(plain.naming, "tmdb");
  await untilStatus(plain.id, ["ready"]);
});

test("探测编码：key / keys / missing 至少给一个 400、没有的单元 404；探完项上带 probe、清单按标签重新规划；本地结构的清单 400", async () => {
  __test_resetMediaProbes();
  const result = {
    media: {
      "@ref": "",
      track: [
        { "@type": "Video", Format: "HEVC", Width: 3840, Height: 2160, HDR_Format: "SMPTE ST 2086" },
        { "@type": "Audio", Format: "E-AC-3", Channels: 6 },
      ],
    },
  } as unknown as MediaInfoResult;
  setProbeDeps({ open: async (_l, size) => ({ size: size ?? 1, read: async () => new Uint8Array(0) }), analyze: async () => ({ result, bytesRead: 1, reads: 1 }) });
  try {
    const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "probe" }, 201);
    const ready = await untilStatus(run.id, ["ready"]);
    const unit = ready.units.find((u) => u.match?.tmdbId === 693134)!;
    assert.equal((await app.inject({ method: "POST", url: `/api/organize/runs/${run.id}/probe`, headers: auth, payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/api/organize/runs/${run.id}/probe`, headers: auth, payload: { key: "nope" } })).statusCode, 404);
    const r = await json<OrganizeProbeResult>("POST", `/api/organize/runs/${run.id}/probe`, { key: unit.key });
    assert.deepEqual([r.probed, r.cached, r.failed, r.units], [1, 0, 0, 1]);
    assert.equal(r.files[0].summary, "HEVC · 2160p · HDR10 · DDP 5.1");
    const { items } = await json<{ items: OrganizeItem[] }>("GET", `/api/organize/runs/${run.id}/items?unit=${encodeURIComponent(unit.key)}`);
    const movie = items.find((i) => i.srcPath.endsWith(".mkv"))!;
    assert.equal(r.files[0].path, movie.srcPath);
    assert.deepEqual(movie.probe, { resolution: "2160p", videoCodec: "HEVC", audio: "DDP", hdr: "HDR10" });
    assert.ok(movie.dstPath.endsWith("沙丘：第二部 (2024) - 2160p.mkv"), movie.dstPath);
    const again = await json<OrganizeProbeResult>("POST", `/api/organize/runs/${run.id}/probe`, { keys: [unit.key] });
    assert.equal(again.probed + again.failed, 0, "缺的标签已经有探测结果了，不用再探");
    const local = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "refresh", naming: "local" }, 201);
    await untilStatus(local.id, ["ready"]);
    const bad = await app.inject({ method: "POST", url: `/api/organize/runs/${local.id}/probe`, headers: auth, payload: { missing: true } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().code, "NOT_TMDB_RUN");
  } finally {
    setProbeDeps(null);
  }
});

test("改标题 / 年份、钉季集、改文件名的接口：校验 400、电影不能钉；别名接口给译名 / 原名 / 别名", async () => {
  const run = await json<OrganizeRun>("POST", "/api/organize/runs", { taskId: "t1", subPath: "probe" }, 201);
  const ready = await untilStatus(run.id, ["ready"]);
  const unit = ready.units.find((u) => u.match?.tmdbId === 693134)!;
  const titled = await json<OrganizeUnit>("PUT", `/api/organize/runs/${run.id}/unit`, { key: unit.key, title: "沙丘 2", year: "2024" });
  assert.equal(titled.titleOverride, "沙丘 2");
  assert.match(titled.dstRoot, /^沙丘 2 \(2024\) \[tmdbid[=-]693134\]$/, "前面的测试可能把 id 标签写法换成了 jellyfin 的");
  assert.equal((await app.inject({ method: "PUT", url: `/api/organize/runs/${run.id}/unit`, headers: auth, payload: { key: unit.key, title: "a/b" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: `/api/organize/runs/${run.id}/unit`, headers: auth, payload: { key: unit.key, year: "20x4" } })).statusCode, 400);
  const { items } = await json<{ items: OrganizeItem[] }>("GET", `/api/organize/runs/${run.id}/items?unit=${encodeURIComponent(unit.key)}`);
  const movie = items.find((i) => i.kind === "video")!;
  assert.equal((await app.inject({ method: "PUT", url: `/api/organize/runs/${run.id}/items`, headers: auth, payload: { ids: [movie.id], pin: {} } })).statusCode, 400, "季或集至少给一个");
  const pinned = await app.inject({ method: "PUT", url: `/api/organize/runs/${run.id}/items`, headers: auth, payload: { ids: [movie.id], pin: { episode: 1 } } });
  assert.equal(pinned.statusCode, 400);
  assert.equal(pinned.json().code, "PIN_NOT_TV");
  assert.equal((await app.inject({ method: "PUT", url: `/api/organize/runs/${run.id}/items`, headers: auth, payload: { ids: [movie.id] } })).statusCode, 400);
  await json<{ changed: number }>("PUT", `/api/organize/runs/${run.id}/items`, { ids: [movie.id], name: "沙丘第二部 4K" });
  const after = await json<{ items: OrganizeItem[] }>("GET", `/api/organize/runs/${run.id}/items?unit=${encodeURIComponent(unit.key)}`);
  const video = after.items.find((i) => i.kind === "video")!;
  assert.match(video.dstPath, /\/沙丘 2 \(2024\) \[tmdbid[=-]693134\]\/沙丘第二部 4K\.mkv$/, video.dstPath);
  const titles = await json<{ title: string; originalTitle: string; enTitle: string; year: string; aliases: string[] }>("GET", "/api/organize/tmdb/movie/693134/titles");
  assert.equal(titles.title, "沙丘：第二部");
  assert.equal(titles.originalTitle, "Dune: Part Two");
  assert.deepEqual(titles.aliases, []);
});

test("旧缓存没有 collection 键的电影详情：当没缓存重拉一次并写回；补过的不再重拉（海报墙读同一个键，键不带版本）", async () => {
  const key = "details:movie:603:zh-CN";
  writeTmdbCache(key, { id: 603, title: "黑客帝国" });
  let calls = 0;
  const adapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    calls += 1;
    return {
      data: { id: 603, title: "黑客帝国", original_title: "The Matrix", release_date: "1999-03-30", belongs_to_collection: { id: 2344, name: "黑客帝国（系列）" } },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    } as AxiosResponse;
  };
  try {
    const d = await new TmdbClient("x", "zh-CN").details("movie", 603);
    assert.equal(calls, 1);
    assert.deepEqual(d?.collection, { id: 2344, name: "黑客帝国（系列）" });
    assert.deepEqual(readTmdbCache<{ collection: unknown }>(key, 3600)?.collection, { id: 2344, name: "黑客帝国（系列）" });
    await new TmdbClient("x", "zh-CN").details("movie", 603);
    assert.equal(calls, 1, "补过的缓存是新形状，不再重拉");
  } finally {
    axios.defaults.adapter = adapter;
  }
});
