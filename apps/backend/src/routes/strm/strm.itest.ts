/**
 * strm 管理路由的闭环：鉴权、校验、各接口形状、任务运行中 409。网盘走内存假网盘（test/fake-drive.ts）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/strm/strm.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import axios from "axios";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  AccountInfo,
  AppSettings,
  OrganizeUnit,
  StrmAllPostersResult,
  StrmPosterResult,
  StrmDeleteResult,
  StrmFileInfo,
  StrmListResult,
  StrmRegenerateResult,
  StrmRewriteResult,
  StrmScanResult,
  StrmSearchResult,
  StrmVerifyEvent,
  StrmVerifyResult,
  TaskDefinition,
} from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import strmRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { deleteRun, insertRun, replaceUnits, writeTmdbCache } from "../../db/repositories/organize.js";
import { DATA_DIR } from "../../paths.js";
import { releaseTaskStart, reserveTaskStart } from "../../services/task/registry.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { verify, verify$ } from "../../services/strm/manage.js";
import { resetPostersAcrossTasks, settlePostersAcrossTasks } from "../../services/strm/poster.js";
import type { DriveEntry } from "../../services/drive/types.js";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };

const acc115: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const accOl: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://x" };
const t115: TaskDefinition = { id: "r-main", account: "acc", accountType: "115", originPath: "tv", targetPath: "strm-itest/tv", strmPrefix: "/mnt/pan" };
const tOl: TaskDefinition = { id: "r-ol", account: "ol", accountType: "openlist", originPath: "x", targetPath: "strm-itest/ol", strmPrefix: "/mnt/ol" };
/** 海报用例自己的一棵树：混在 r-main 里会改变前面那些用例的条目数 */
const tPoster: TaskDefinition = { id: "r-poster", account: "acc", accountType: "115", originPath: "posters", targetPath: "strm-itest/poster", strmPrefix: "/mnt/pan" };

const ROOT = path.join(DATA_DIR, "strm-itest", "tv");
const POSTER_ROOT = path.join(DATA_DIR, "strm-itest", "poster");
const drives = new Map<string, FakeDrive>();
const writeUnder = (root: string, rel: string, content: string) => {
  const p = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
const write = (rel: string, content: string) => writeUnder(ROOT, rel, content);
const writePoster = (rel: string, content: string) => writeUnder(POSTER_ROOT, rel, content);

before(async () => {
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  // 海报那几级回退不许联网：apiKey 空的话缓存没命中就直接放弃
  replaceAppSettings({ ...baseline.settings, tmdb: { apiKey: "", language: "zh-CN" } });
  replaceTasks([t115, tOl, tPoster]);
  replaceAccounts([acc115, accOl]);
  await writeAuthPassword("strm-itest-pw");
  fs.rmSync(path.join(DATA_DIR, "strm-itest"), { recursive: true, force: true });
  write("Show/Season 1/ep1.strm", "/mnt/pan/tv/Show/Season 1/ep1.mkv");
  write("Show/Season 1/ep2.strm", "/old/tv/Show/Season 1/ep2.mkv");
  write("Show/x.part", "");
  // 海报用的目录：本地图片 / 目录名里的 id 标签 / 只有整理记录认得 / 什么线索都没有
  writePoster("Local Show/poster.jpg", "fake-jpeg-bytes");
  writePoster("Local Show/Season 1/ep1.strm", "/mnt/pan/posters/Local Show/Season 1/ep1.mkv");
  // 跟 strm 同名的图：本工具自己的产物就长这样（图片跟着片子从网盘下过来）
  writePoster("Named Movie (2025)/雷霆特攻队 (2025) - 2160p.strm", "/mnt/pan/posters/Named Movie (2025)/雷霆特攻队 (2025) - 2160p.mkv");
  writePoster("Named Movie (2025)/雷霆特攻队 (2025) - 2160p.jpg", "fake-jpeg-bytes");
  // 一季里每集都有同名图：那是集的剧照，不能拿来当整季的海报
  writePoster("Thumbed Season/ep1.strm", "/mnt/pan/posters/Thumbed Season/ep1.mkv");
  writePoster("Thumbed Season/ep1.jpg", "fake-jpeg-bytes");
  writePoster("Thumbed Season/ep2.strm", "/mnt/pan/posters/Thumbed Season/ep2.mkv");
  writePoster("Thumbed Season/ep2.jpg", "fake-jpeg-bytes");
  // 但带明确海报后缀的，几集都不歧义
  writePoster("Suffixed Season/ep1.strm", "/mnt/pan/posters/Suffixed Season/ep1.mkv");
  writePoster("Suffixed Season/ep1-thumb.jpg", "fake-jpeg-bytes");
  writePoster("Suffixed Season/ep2.strm", "/mnt/pan/posters/Suffixed Season/ep2.mkv");
  writePoster("Suffixed Season/ep2-poster.jpg", "fake-jpeg-bytes");
  writePoster("Tagged Show (2024) [tmdbid=77]/Season 1/ep1.strm", "/mnt/pan/posters/Tagged Show (2024) [tmdbid=77]/Season 1/ep1.mkv");
  writePoster("Organized Show/Season 1/ep1.strm", "/mnt/pan/posters/Organized Show/Season 1/ep1.mkv");
  writePoster("Plain Show/ep1.strm", "/mnt/pan/posters/Plain Show/ep1.mkv");

  // 115 账号的网盘：tv/Show/Season 1 下有 ep1 和 ep3；OpenList 账号的网盘是空的
  const d115 = new FakeDrive("115", acc115);
  d115.tree.addFile("/tv/Show/Season 1/ep1.mkv");
  d115.tree.addFile("/tv/Show/Season 1/ep3.mkv");
  drives.set("acc", d115);
  drives.set("ol", new FakeDrive("openlist", accOl));
  setDriveProviderFactory((account) => drives.get(account.name) ?? null);

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(strmRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  setDriveProviderFactory(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(path.join(DATA_DIR, "strm-itest"), { recursive: true, force: true });
  await writeAuthPassword(DEFAULT_AUTH.password);
});

const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth, payload: payload as Record<string, unknown> });
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

test("不带令牌一律 401", async () => {
  assert.equal((await app.inject({ method: "GET", url: `/api/strm/list?${q({ taskId: "r-main" })}` })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/strm/scan", payload: { taskId: "r-main" } })).statusCode, 401);
});

test("任务不存在 404；入参校验 400", async () => {
  assert.equal((await get(`/api/strm/list?${q({ taskId: "nope" })}`)).statusCode, 404);
  assert.equal((await get("/api/strm/list")).statusCode, 400, "缺 taskId");
  assert.equal((await get(`/api/strm/file?${q({ taskId: "r-main" })}`)).statusCode, 400, "缺 path");
  assert.equal((await get(`/api/strm/search?${q({ taskId: "r-main", q: "  " })}`)).statusCode, 400, "q 空");
  assert.equal((await get(`/api/strm/search?${q({ taskId: "r-main", q: "a", limit: "9999" })}`)).statusCode, 400, "limit 超限");
  assert.equal((await post("/api/strm/delete", { taskId: "r-main", paths: [] })).statusCode, 400, "paths 空");
  assert.equal((await post("/api/strm/regenerate", { taskId: "r-main" })).statusCode, 400, "缺 path");
  assert.equal((await post("/api/strm/regenerate", { taskId: "r-main", path: "Show", mode: "nuke" })).statusCode, 400, "mode 不认识");
  assert.equal((await get(`/api/strm/list?${q({ taskId: "r-main", path: "../x" })}`)).statusCode, 400, "越界");
});

test("list / file / search 的形状", async () => {
  const root = await get(`/api/strm/list?${q({ taskId: "r-main" })}`);
  assert.equal(root.statusCode, 200, root.body);
  const rootBody = root.json<StrmListResult>();
  assert.equal(rootBody.exists, true);
  assert.deepEqual(rootBody.entries.map((e) => `${e.kind}:${e.name}`), ["dir:Show"]);

  const season = (await get(`/api/strm/list?${q({ taskId: "r-main", path: "Show/Season 1" })}`)).json<StrmListResult>();
  assert.equal(season.path, "Show/Season 1");
  assert.deepEqual(season.entries.map((e) => e.name), ["ep1.strm", "ep2.strm"]);
  assert.equal((await get(`/api/strm/list?${q({ taskId: "r-main", path: "Nope" })}`)).statusCode, 404);
  assert.deepEqual((await get(`/api/strm/list?${q({ taskId: "r-ol" })}`)).json<StrmListResult>(), { path: "", exists: false, entries: [] });

  const file = (await get(`/api/strm/file?${q({ taskId: "r-main", path: "Show/Season 1/ep2.strm" })}`)).json<StrmFileInfo>();
  assert.equal(file.reason, "prefix-mismatch");
  assert.equal(file.matches, false);
  assert.equal(file.expectedContent, "/mnt/pan/tv/Show/Season 1/ep2.mkv");

  const found = (await get(`/api/strm/search?${q({ taskId: "r-main", q: "EP" })}`)).json<StrmSearchResult>();
  assert.deepEqual(found.hits.map((h) => h.path), ["Show/Season 1/ep1.strm", "Show/Season 1/ep2.strm"]);
  assert.equal(found.truncated, false);
});

test("scan / rewrite / delete", async () => {
  const scanRes = await post("/api/strm/scan", { taskId: "r-main" });
  assert.equal(scanRes.statusCode, 200, scanRes.body);
  const scanned = scanRes.json<StrmScanResult>();
  assert.equal(scanned.counts["stale-content"], 1);
  assert.equal(scanned.counts["leftover-part"], 1);
  assert.equal(scanned.strm, 2);

  const dryRes = await post("/api/strm/rewrite", { taskId: "r-main", path: "Show", dryRun: true });
  assert.equal(dryRes.statusCode, 200, dryRes.body);
  const dry = dryRes.json<StrmRewriteResult>();
  assert.equal(dry.dryRun, true);
  assert.equal(dry.changed, 1);
  const appliedRes = await post("/api/strm/rewrite", { taskId: "r-main", path: "Show" });
  assert.equal(appliedRes.statusCode, 200, appliedRes.body);
  const applied = appliedRes.json<StrmRewriteResult>();
  assert.equal(applied.dryRun, false);
  assert.equal(applied.changed, 1);
  assert.equal(fs.readFileSync(path.join(ROOT, "Show", "Season 1", "ep2.strm"), "utf8"), "/mnt/pan/tv/Show/Season 1/ep2.mkv");

  assert.equal((await post("/api/strm/delete", { taskId: "r-main", paths: ["Show/x.part", ""] })).statusCode, 400, "空路径过不了校验");
  const delRes = await post("/api/strm/delete", { taskId: "r-main", paths: ["Show/x.part", "Nope/none"] });
  assert.equal(delRes.statusCode, 200, delRes.body);
  const del = delRes.json<StrmDeleteResult>();
  assert.equal(del.deleted, 1);
  assert.equal(del.failed.length, 1);
  assert.equal(fs.existsSync(path.join(ROOT, "Show", "x.part")), false);
});

test("regenerate / verify：任何网盘类型都能做（OpenList 本地目录不存在 404 / 校验 0 条）；115 任务 200；任务运行中写操作 409", async () => {
  assert.equal((await post("/api/strm/regenerate", { taskId: "r-ol", path: "Show" })).statusCode, 404, "本地还没有这个目录");
  const olVerify = await post("/api/strm/verify", { taskId: "r-ol" });
  assert.equal(olVerify.statusCode, 200, olVerify.body);
  assert.equal(olVerify.json<StrmVerifyResult>().checked, 0);

  const regen = await post("/api/strm/regenerate", { taskId: "r-main", path: "Show" });
  assert.equal(regen.statusCode, 200, regen.body);
  assert.deepEqual(regen.json<StrmRegenerateResult>(), { mode: "fill", remoteFiles: 2, generated: 1, skipped: 1, removed: 0 });
  assert.equal((await post("/api/strm/regenerate", { taskId: "r-main", path: "" })).statusCode, 400, "根目录");

  const verified = await post("/api/strm/verify", { taskId: "r-main", path: "Show" });
  assert.equal(verified.statusCode, 200, verified.body);
  const v = verified.json<StrmVerifyResult>();
  assert.equal(v.checked, 3);
  assert.deepEqual(v.missing.map((m) => `${m.path}:${m.reason}`), ["Show/Season 1/ep2.strm:file-missing"]);

  assert.ok(reserveTaskStart("r-main"));
  try {
    assert.equal((await post("/api/strm/regenerate", { taskId: "r-main", path: "Show" })).statusCode, 409);
    assert.equal((await post("/api/strm/delete", { taskId: "r-main", paths: ["Show/Season 1/ep3.strm"] })).statusCode, 409);
    assert.equal((await post("/api/strm/rewrite", { taskId: "r-main", path: "Show" })).statusCode, 409);
    assert.equal((await post("/api/strm/rewrite", { taskId: "r-main", path: "Show", dryRun: true })).statusCode, 200, "dryRun 不拦");
    assert.equal((await post("/api/strm/verify", { taskId: "r-main", path: "Show" })).statusCode, 200, "校验不拦");
  } finally {
    releaseTaskStart("r-main");
  }
});

const sseEvents = (body: string): StrmVerifyEvent[] =>
  body
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as StrmVerifyEvent);

test("校验的流式版：先推进度再推结果，结论和阻塞版一致", async () => {
  const res = await post("/api/strm/verify/stream", { taskId: "r-main", path: "Show" });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);

  const events = sseEvents(res.body);
  const first = events[0];
  assert.equal(first?.type, "progress", "开头就该有一条进度，不能让弹框空着");
  assert.equal(first.type === "progress" ? first.progress.phase : "", "collect");

  const last = events.at(-1);
  assert.equal(last?.type, "done");
  const streamed = last?.type === "done" ? last.result : null;
  const blocking = (await post("/api/strm/verify", { taskId: "r-main", path: "Show" })).json<StrmVerifyResult>();
  assert.deepEqual(streamed, blocking, "两条路的结论必须一样");
});

test("流式版的失败走事件，不回 5xx（响应头早发了，Cloudflare 还会把 5xx 换成自己的页面）", async () => {
  const res = await post("/api/strm/verify/stream", { taskId: "r-main", path: "没有这个目录" });
  assert.equal(res.statusCode, 200, "已经是 200 的事件流了，改不了状态码");
  const last = sseEvents(res.body).at(-1);
  assert.equal(last?.type, "error");
  assert.match(last?.type === "error" ? last.message : "", /不存在/);
});

test("流式版：任务不存在还是普通 404（流还没开）；入参照样校验", async () => {
  assert.equal((await post("/api/strm/verify/stream", { taskId: "nope" })).statusCode, 404);
  assert.equal((await post("/api/strm/verify/stream", {})).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/strm/verify/stream", payload: { taskId: "r-main" } })).statusCode, 401);
});

test("校验流退订：中止信号跟着传到网盘请求上，活儿立刻停", async () => {
  const drive = drives.get("acc")!;
  const real = drive.listDir.bind(drive);
  const patchable = drive as unknown as { listDir: (id: string, signal?: AbortSignal) => Promise<DriveEntry[]> };
  let seen: AbortSignal | undefined;
  let entered!: () => void;
  const inFlight = new Promise<void>((resolve) => (entered = resolve));
  patchable.listDir = async (id, signal) => {
    seen = signal;
    entered();
    // 挂住，好在「正在问网盘」的当口退订
    await new Promise((r) => setTimeout(r, 500));
    return real(id);
  };
  try {
    const sub = verify$(t115, drive, "Show").subscribe({ next: () => {}, error: () => {} });
    await inFlight;
    assert.equal(seen?.aborted, false, "还在跑，不该是中止的");
    sub.unsubscribe();
    assert.equal(seen?.aborted, true, "退订（关弹框 / 断连）要把中止传到网盘请求上");
  } finally {
    patchable.listDir = real;
  }
});

test("校验被取消：整轮以中止收场，不会假装「缺失 0」顺利跑完", async () => {
  const already = new AbortController();
  already.abort();
  await assert.rejects(
    verify(t115, drives.get("acc")!, "Show", { signal: already.signal }),
    (err: Error) => err.name === "AbortError",
    "已经掐了还从头跑一遍本地目录，等于取消不算数",
  );

  // 跑到一半掐：假网盘不认 signal，得靠阶段边界那道检查兜住
  const drive = drives.get("acc")!;
  const real = drive.listDir.bind(drive);
  const patchable = drive as unknown as { listDir: (id: string, signal?: AbortSignal) => Promise<DriveEntry[]> };
  const midway = new AbortController();
  patchable.listDir = async (id) => {
    midway.abort();
    return real(id);
  };
  try {
    await assert.rejects(
      verify(t115, drive, "Show", { signal: midway.signal }),
      (err: Error) => err.name === "AbortError",
    );
  } finally {
    patchable.listDir = real;
  }
});

test("流式校验走真的 HTTP：进度和结论都推得出去", async () => {
  // 必须是真连接：app.inject() 不触发 req/res 的 'close'，曾经整条流一开就自关都测不出来
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const res = await fetch(`http://127.0.0.1:${port}/api/strm/verify/stream`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ taskId: "r-main", path: "Show" }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = (await res.text())
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as StrmVerifyEvent);
  assert.ok(events.length >= 2, `至少该有进度和结论两条，实际 ${events.length} 条`);
  assert.equal(events[0]?.type, "progress");
  assert.equal(events.at(-1)?.type, "done");
});

/** 海报用例共用：一条整理记录，默认让 Organized Show 有 ④ 那一级的海报 */
function organizedUnit(runId: string, dstRoot = "Organized Show", tmdbId = 99): OrganizeUnit {
  return {
    runId,
    key: "u1",
    rootPath: dstRoot,
    rawName: dstRoot,
    parsedTitle: dstRoot,
    parsedYear: "",
    match: {
      mediaType: "tv",
      tmdbId,
      title: "整理过的剧",
      originalTitle: "Organized Show",
      year: "2023",
      posterUrl: "https://image.tmdb.org/t/p/w500/run.jpg",
      confidence: "high",
      reason: "测试",
    },
    seasonOverride: null,
    episodeOffset: 0,
    dstRoot,
    selected: true,
    remember: false,
    fileCount: 1,
    videoCount: 1,
    referencedBy: 0,
    notes: [],
    excluded: [],
    resolutions: {},
    titleOverride: "",
    yearOverride: "",
    pins: {},
    renames: {},
    kinds: {},
    missing: {},
  };
}

test("海报：本地图片 / 目录名 id 标签 / 整理记录三级都能拿到", async () => {
  writeTmdbCache("details:tv:77:zh-CN", { posterUrl: "https://image.tmdb.org/t/p/w500/tag.jpg", title: "带标签的剧", year: "2024" });
  insertRun({ id: "run-poster", taskId: "r-poster", accountName: "acc", scopePath: "", scopePaths: [], mode: "manual", trigger: "manual" });
  replaceUnits("run-poster", [organizedUnit("run-poster")]);
  try {
    const res = await post("/api/strm/posters", {
      taskId: "r-poster",
      paths: [
        "Local Show",
        "Named Movie (2025)",
        "Thumbed Season",
        "Suffixed Season",
        "Tagged Show (2024) [tmdbid=77]",
        "Organized Show",
        "Plain Show",
      ],
    });
    assert.equal(res.statusCode, 200, res.body);
    const { posters } = res.json<StrmPosterResult>();

    assert.deepEqual(posters["Local Show"], { source: "local", url: "Local Show/poster.jpg" });
    assert.deepEqual(
      posters["Named Movie (2025)"],
      { source: "local", url: "Named Movie (2025)/雷霆特攻队 (2025) - 2160p.jpg" },
      "跟 strm 同名的图要认出来——这是本工具自己产出的样子",
    );
    assert.equal(posters["Thumbed Season"], undefined, "一季里每集一张同名图是剧照，不能当整季海报");
    assert.deepEqual(
      posters["Suffixed Season"],
      { source: "local", url: "Suffixed Season/ep2-poster.jpg" },
      "带 -poster 后缀的不歧义，几集都认；-thumb 是横版，不认",
    );
    assert.equal(posters["Tagged Show (2024) [tmdbid=77]"]?.source, "tmdb");
    assert.equal(posters["Tagged Show (2024) [tmdbid=77]"]?.url, "https://image.tmdb.org/t/p/w500/tag.jpg");
    assert.equal(posters["Organized Show"]?.source, "run");
    assert.equal(posters["Organized Show"]?.url, "https://image.tmdb.org/t/p/w500/run.jpg");
    assert.equal(posters["Plain Show"], undefined, "什么线索都没有的目录不该出现在结果里");
    assert.deepEqual(
      [...res.json<StrmPosterResult>().known].sort(),
      ["Local Show", "Named Movie (2025)", "Organized Show", "Suffixed Season", "Tagged Show (2024) [tmdbid=77]"].sort(),
      "Thumbed Season / Plain Show 没有任何线索，不算认出来",
    );
  } finally {
    deleteRun("run-poster");
  }
});

/* ------------------------------- 海报：联网 ------------------------------- */

type TmdbAnswer = { title?: string; name?: string; release_date?: string; first_air_date?: string; poster_path?: string } | null | Error;

/**
 * 在 axios 上截住 TMDB 的详情请求，一个都不出本机。answer 决定怎么回：对象是 200、null 是 404、Error 是连不上；
 * 也可以返回一个一直不完成的 Promise，把请求拖住
 */
function fakeTmdb(answer: (kind: string, id: number) => TmdbAnswer | Promise<TmdbAnswer>) {
  const asked: string[] = [];
  const hook = axios.interceptors.request.use((config) => {
    const m = /^https:\/\/api\.themoviedb\.org\/3\/(movie|tv)\/(\d+)$/.exec(config.url ?? "");
    if (m) {
      asked.push(`${m[1]}/${m[2]}`);
      config.adapter = async (cfg) => {
        const a = await answer(m[1], Number(m[2]));
        if (a instanceof Error) throw a;
        return { data: a ?? {}, status: a ? 200 : 404, statusText: a ? "OK" : "Not Found", headers: {}, config: cfg };
      };
    }
    return config;
  });
  return { asked, stop: () => axios.interceptors.request.eject(hook) };
}

const useTmdbKey = (on: boolean) => replaceAppSettings({ ...readAppSettings(), tmdb: { apiKey: on ? "test-key" : "", language: "zh-CN" } });

/** 一个只给这组用例用的库：墙上只有它，断言才能写成精确的 */
function isolatedLibrary(id: string) {
  const root = path.join(DATA_DIR, "strm-itest", id);
  const task: TaskDefinition = { id, account: "acc", accountType: "115", originPath: id, targetPath: `strm-itest/${id}`, strmPrefix: "/mnt/pan" };
  const put = (rel: string, content: string | Buffer = "x") => {
    const p = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const cleanup = () => {
    replaceTasks([t115, tOl, tPoster]);
    resetPostersAcrossTasks();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, task, put, cleanup };
}

test("海报：strm 页离线的几级全试过才联网，offline 不联网，404 也记住，连不上就不再一个个等", async () => {
  const dirs = ["Net A (2020) [tmdbid=9001]", "Net B (2020) [tmdbid=9002]", "Net Run (2020) [tmdbid=9004]"];
  const down = ["Down C (2020) [tmdbid=9005]", "Down D (2020) [tmdbid=9006]"];
  for (const d of [...dirs, ...down]) writePoster(`${d}/x.strm`, `/mnt/pan/posters/${d}/x.mkv`);
  insertRun({ id: "run-net", taskId: "r-poster", accountName: "acc", scopePath: "", scopePaths: [], mode: "manual", trigger: "manual" });
  replaceUnits("run-net", [organizedUnit("run-net", dirs[2], 9004)]);
  const tmdb = fakeTmdb((_kind, id) => {
    if (id === 9001) return { title: "甲", release_date: "2020-01-01", poster_path: "/a.jpg" };
    if (id >= 9005) return new Error("connect ETIMEDOUT");
    return null;
  });
  useTmdbKey(true);
  try {
    const off = (await post("/api/strm/posters", { taskId: "r-poster", paths: dirs, offline: true })).json<StrmPosterResult>();
    assert.deepEqual(tmdb.asked, [], "offline 一个都不问");
    assert.deepEqual([...off.known].sort(), [...dirs].sort(), "带 id 标签就算认出来了，拿没拿到图不要紧");
    assert.equal(off.posters[dirs[2]]?.source, "run", "整理记录和 id 标签说的是同一部：离线就有图");

    const on = (await post("/api/strm/posters", { taskId: "r-poster", paths: dirs })).json<StrmPosterResult>();
    assert.equal(on.posters[dirs[0]]?.url, "https://image.tmdb.org/t/p/w500/a.jpg");
    assert.equal(on.posters[dirs[1]], undefined, "两种类型 TMDB 都说没有");
    assert.equal(on.posters[dirs[2]]?.source, "run");
    assert.deepEqual(tmdb.asked, ["movie/9001", "movie/9002", "tv/9002"], "没有子目录先当电影问，404 再问剧；有整理记录的不问");

    tmdb.asked.length = 0;
    await post("/api/strm/posters", { taskId: "r-poster", paths: dirs });
    assert.deepEqual(tmdb.asked, [], "有图的、404 的都记在缓存里，不再问");

    await post("/api/strm/posters", { taskId: "r-poster", paths: down });
    assert.deepEqual(tmdb.asked, ["movie/9005"], "连不上：第一个失败就停，剩下的不再一个个等超时");
  } finally {
    tmdb.stop();
    useTmdbKey(false);
    deleteRun("run-net");
    for (const d of [...dirs, ...down]) fs.rmSync(path.join(POSTER_ROOT, d), { recursive: true, force: true });
  }
});

test("海报接口的入参和越界", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/strm/posters", payload: { taskId: "r-poster", paths: ["x"] } })).statusCode, 401);
  assert.equal((await post("/api/strm/posters", { taskId: "r-poster", paths: [] })).statusCode, 400, "paths 空");
  assert.equal((await post("/api/strm/posters", { taskId: "nope", paths: ["x"] })).statusCode, 404);
  // 越界的路径不报错，只是这个目录没海报——背景图不该把整页拖挂
  assert.deepEqual((await post("/api/strm/posters", { taskId: "r-poster", paths: ["../../etc"] })).json<StrmPosterResult>().posters, {});
});

test("本地图片：带上 Content-Type 和 ETag，只放行图片", async () => {
  const url = `/api/strm/image?${q({ taskId: "r-poster", path: "Local Show/poster.jpg" })}`;
  const res = await get(url);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.equal(res.body, "fake-jpeg-bytes");
  const etag = String(res.headers.etag);
  assert.ok(etag, "要给 ETag");

  const again = await app.inject({ method: "GET", url, headers: { ...auth, "if-none-match": etag } });
  assert.equal(again.statusCode, 304, "没变就回 304");

  assert.equal((await get(`/api/strm/image?${q({ taskId: "r-main", path: "Show/Season 1/ep1.strm" })}`)).statusCode, 400, "不是图片");
  assert.equal((await get(`/api/strm/image?${q({ taskId: "r-poster", path: "Local Show/nope.jpg" })}`)).statusCode, 404);
  assert.equal((await get(`/api/strm/image?${q({ taskId: "r-poster", path: "../../secret.png" })}`)).statusCode, 400, "越界");
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
});

test("全库海报：所有任务的作品目录按修改时间新的在前，季目录算到剧上，没线索的不出现", async () => {
  resetPostersAcrossTasks();
  writeTmdbCache("details:tv:77:zh-CN", { posterUrl: "https://image.tmdb.org/t/p/w500/tag.jpg", title: "带标签的剧", year: "2024" });
  insertRun({ id: "run-wall", taskId: "r-poster", accountName: "acc", scopePath: "", scopePaths: [], mode: "manual", trigger: "manual" });
  replaceUnits("run-wall", [organizedUnit("run-wall")]);
  // 修改时间从新到旧；故意和名字的顺序错开
  const newestFirst = ["Tagged Show (2024) [tmdbid=77]", "Organized Show", "Local Show", "Suffixed Season", "Named Movie (2025)"];
  const now = Date.now() / 1000;
  newestFirst.forEach((rel, i) => fs.utimesSync(path.join(POSTER_ROOT, rel), now - i * 60, now - i * 60));
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/strm/posters/all" })).statusCode, 401);
    const res = await get("/api/strm/posters/all");
    assert.equal(res.statusCode, 200, res.body);
    const { posters } = res.json<StrmAllPostersResult>();
    assert.deepEqual(
      posters.map((p) => [p.taskId, p.path, p.source]),
      [
        // 目录名带 id 标签：名字就说明是一部作品，不用往里走
        ["r-poster", "Tagged Show (2024) [tmdbid=77]", "tmdb"],
        // 下面是季目录：作品就是这一层的剧
        ["r-poster", "Organized Show", "run"],
        ["r-poster", "Local Show", "local"],
        ["r-poster", "Suffixed Season", "local"],
        ["r-poster", "Named Movie (2025)", "local"],
      ],
      "Thumbed Season / Plain Show / r-main 的 Show 都没有线索，不该出现",
    );
    assert.equal(posters[2].url, "Local Show/poster.jpg", "local 的地址相对任务根，前端拿 taskId 去 /api/strm/image 取");
  } finally {
    deleteRun("run-wall");
    resetPostersAcrossTasks();
  }
});

test("全库海报：共用一个本地目录的任务只走一遍，嵌在里面的任务根归它自己的任务", async () => {
  resetPostersAcrossTasks();
  const twin: TaskDefinition = { ...tPoster, id: "r-poster-twin" };
  const inner: TaskDefinition = { ...tPoster, id: "r-poster-inner", originPath: "posters/Local Show", targetPath: "strm-itest/poster/Local Show" };
  replaceTasks([t115, tOl, tPoster, twin, inner]);
  try {
    const { posters } = (await get("/api/strm/posters/all")).json<StrmAllPostersResult>();
    const paths = posters.map((p) => p.path);
    assert.equal(paths.filter((p) => p === "Named Movie (2025)").length, 1, "同一个本地目录的两个任务只走一遍");
    assert.ok(!paths.includes("Local Show"), "嵌在里面的任务根不算外层任务的作品目录");
    const own = posters.filter((p) => p.taskId === "r-poster-inner");
    assert.deepEqual(
      own.map((p) => ({ path: p.path, source: p.source, url: p.url })),
      [{ path: "", source: "local", url: "poster.jpg" }],
      "它自己的任务去走：任务根就是那部作品",
    );
  } finally {
    replaceTasks([t115, tOl, tPoster]);
    resetPostersAcrossTasks();
  }
});

test("全库海报：结果缓存几分钟，任务表变了就重算", async () => {
  resetPostersAcrossTasks();
  const first = (await get("/api/strm/posters/all")).json<StrmAllPostersResult>().posters;
  writePoster("Fresh Movie/poster.jpg", "fake-jpeg-bytes");
  try {
    const cached = (await get("/api/strm/posters/all")).json<StrmAllPostersResult>().posters;
    assert.deepEqual(cached, first, "任务表没变、没过期：给上次的结果，不重新走一遍");
    replaceTasks([t115, tOl, tPoster, { ...tOl, id: "r-extra", targetPath: "strm-itest/extra" }]);
    const fresh = (await get("/api/strm/posters/all")).json<StrmAllPostersResult>().posters;
    assert.ok(
      fresh.some((p) => p.path === "Fresh Movie"),
      "任务表变了就重算",
    );
  } finally {
    fs.rmSync(path.join(POSTER_ROOT, "Fresh Movie"), { recursive: true, force: true });
    replaceTasks([t115, tOl, tPoster]);
    resetPostersAcrossTasks();
  }
});

test("全库海报：找作品目录的规则", async () => {
  const lib = isolatedLibrary("r-walk");
  const soloRoot = path.join(DATA_DIR, "strm-itest", "solo");
  const solo: TaskDefinition = { id: "r-solo", account: "acc", accountType: "115", originPath: "solo", targetPath: "strm-itest/solo/Solo (2022) [tmdbid=9202]", strmPrefix: "/mnt/pan" };
  // 分类目录里散放一个 strm：底下的作品不能跟着丢
  lib.put("电影/Loose.strm");
  lib.put("电影/Movie A (2020)/a.strm");
  lib.put("电影/Movie A (2020)/poster.jpg", "img");
  lib.put("电影/Movie B (2021) [tmdbid=9201]/b.strm");
  // 合集封面：合集自己算一张，底下的作品照样找
  lib.put("合集/cover.jpg", "img");
  lib.put("合集/Movie C (2019)/c.strm");
  lib.put("合集/Movie C (2019)/c.jpg", "img");
  // # / @ 开头的不一定是系统目录：整理默认模板就能生成 `#活着 (2020) [tmdbid=…]`
  lib.put("#活着 (2020) [tmdbid=9205]/x.strm");
  lib.put("@追更/Show D/Season 1/d.strm");
  lib.put("@追更/Show D/poster.jpg", "img");
  // 真的系统目录、隐藏目录不进
  lib.put("@eaDir/Junk (2000)/poster.jpg", "img");
  lib.put("@eaDir/Junk (2000)/j.strm");
  lib.put(".hidden/Hidden (2000)/poster.jpg", "img");
  lib.put(".hidden/Hidden (2000)/h.strm");
  // 季目录按整理那套规则认（Season.01 也算），剧里的花絮目录不是作品
  lib.put("某剧/folder.jpg", "img");
  lib.put("某剧/Season.01/e1.strm");
  lib.put("某剧/Season.02/e2.strm");
  lib.put("某剧/花絮/PV.strm");
  lib.put("某剧/花絮/PV.jpg", "img");
  // 名字撞上 Object 原型属性的目录
  lib.put("constructor/c.strm");
  // 名字末尾带空格
  lib.put("Trailing /poster.jpg", "img");
  lib.put("Trailing /t.strm");
  // 任务根自己带 id 标签（只同步了一部作品）
  writeUnder(path.join(soloRoot, "Solo (2022) [tmdbid=9202]"), "s.strm", "x");
  writeTmdbCache("details:movie:9201:zh-CN", { posterUrl: "https://image.tmdb.org/t/p/w500/b.jpg", title: "B", year: "2021" });
  writeTmdbCache("details:movie:9205:zh-CN", { posterUrl: "https://image.tmdb.org/t/p/w500/alive.jpg", title: "活着", year: "2020" });
  writeTmdbCache("details:movie:9202:zh-CN", { posterUrl: "https://image.tmdb.org/t/p/w500/solo.jpg", title: "独", year: "2022" });
  replaceTasks([lib.task, solo]);
  resetPostersAcrossTasks();
  try {
    const { posters } = (await get("/api/strm/posters/all")).json<StrmAllPostersResult>();
    assert.deepEqual(
      posters.map((p) => `${p.taskId}:${p.path}`).sort(),
      [
        "r-solo:",
        "r-walk:#活着 (2020) [tmdbid=9205]",
        "r-walk:@追更/Show D",
        "r-walk:Trailing ",
        "r-walk:合集",
        "r-walk:合集/Movie C (2019)",
        "r-walk:某剧",
        "r-walk:电影/Movie A (2020)",
        "r-walk:电影/Movie B (2021) [tmdbid=9201]",
      ].sort(),
    );
    assert.ok(
      posters.every((p) => typeof p.url === "string" && p.url.length > 0),
      "每一张都要有地址",
    );
    const trailing = posters.find((p) => p.path === "Trailing ");
    assert.equal((await get(`/api/strm/image?${q({ taskId: "r-walk", path: trailing?.url ?? "" })}`)).statusCode, 200, "名字带空格的目录，图也取得到");
    const res = (await post("/api/strm/posters", { taskId: "r-walk", paths: ["constructor", "某剧"] })).json<StrmPosterResult>();
    assert.ok(!Object.hasOwn(res.posters, "constructor"), "原型属性名的目录不会冒出一条假海报");
    assert.equal(res.posters["某剧"]?.url, "某剧/folder.jpg");
  } finally {
    lib.cleanup();
    fs.rmSync(soloRoot, { recursive: true, force: true });
  }
});

test("全库海报：本地图太大，离线有小图就换小图、本地那张留作后备；没有还是用它；比 /image 上限还大的当没有", async () => {
  const lib = isolatedLibrary("r-big");
  const withAlt = "Big Poster (2021) [tmdbid=9301]";
  const huge = "Huge (2020) [tmdbid=9302]";
  lib.put(`${withAlt}/x.strm`);
  lib.put(`${withAlt}/poster.jpg`, Buffer.alloc(600 * 1024));
  lib.put("Big Alone/x.strm");
  lib.put("Big Alone/poster.jpg", Buffer.alloc(600 * 1024));
  lib.put(`${huge}/x.strm`);
  lib.put(`${huge}/poster.jpg`, "");
  fs.truncateSync(path.join(lib.root, huge, "poster.jpg"), 17 * 1024 * 1024); // 稀疏文件，不真占盘
  writeTmdbCache("details:movie:9301:zh-CN", { posterUrl: "https://image.tmdb.org/t/p/w500/small.jpg", title: "大图", year: "2021" });
  writeTmdbCache("details:movie:9302:zh-CN", { posterUrl: "https://image.tmdb.org/t/p/w500/huge-alt.jpg", title: "巨图", year: "2020" });
  replaceTasks([lib.task]);
  resetPostersAcrossTasks();
  try {
    const { posters } = (await get("/api/strm/posters/all")).json<StrmAllPostersResult>();
    const by = new Map(posters.map((p) => [p.path, p]));
    assert.deepEqual(
      { url: by.get(withAlt)?.url, fallback: by.get(withAlt)?.fallback },
      { url: "https://image.tmdb.org/t/p/w500/small.jpg", fallback: `${withAlt}/poster.jpg` },
    );
    assert.deepEqual({ source: by.get("Big Alone")?.source, url: by.get("Big Alone")?.url, fallback: by.get("Big Alone")?.fallback }, { source: "local", url: "Big Alone/poster.jpg", fallback: undefined });
    assert.equal(by.get(huge)?.url, "https://image.tmdb.org/t/p/w500/huge-alt.jpg", "比 16MB 还大：/image 不给，当没有");

    const res = (await post("/api/strm/posters", { taskId: lib.task.id, paths: [withAlt, huge] })).json<StrmPosterResult>();
    assert.equal(res.posters[withAlt]?.source, "local", "strm 页不按大小换");
    assert.equal(res.posters[huge]?.source, "tmdb", "太大的在 strm 页一样当没有");
  } finally {
    lib.cleanup();
  }
});

test("全库海报：共用本地目录的几个任务，整理记录合起来查，库类型说法不一就不当先验", async () => {
  const lib = isolatedLibrary("r-shared");
  const tvFirst: TaskDefinition = { ...lib.task, id: "r-shared-tv", organize: { libraryType: "tv" } };
  const movies: TaskDefinition = { ...lib.task, id: "r-shared-movie", originPath: "r-shared-2", organize: { libraryType: "movie" } };
  lib.put("NoTag Show/Season 1/y.strm");
  lib.put("Film X (2015) [tmdbid=9401]/x.strm");
  // 同一个编号在剧那边是另一部同年的作品：库类型听了排在前面的「剧」就会拿错
  writeTmdbCache("details:tv:9401:zh-CN", { posterUrl: "https://image.tmdb.org/t/p/w500/tv-wrong.jpg", title: "同号的剧", year: "2015" });
  writeTmdbCache("details:movie:9401:zh-CN", { posterUrl: "https://image.tmdb.org/t/p/w500/movie-right.jpg", title: "电影 X", year: "2015" });
  insertRun({ id: "run-shared", taskId: "r-shared-movie", accountName: "acc", scopePath: "", scopePaths: [], mode: "manual", trigger: "manual" });
  replaceUnits("run-shared", [organizedUnit("run-shared", "NoTag Show", 9402)]);
  replaceTasks([tvFirst, movies]);
  resetPostersAcrossTasks();
  try {
    const { posters } = (await get("/api/strm/posters/all")).json<StrmAllPostersResult>();
    const by = new Map(posters.map((p) => [p.path, p]));
    assert.equal(by.get("NoTag Show")?.url, "https://image.tmdb.org/t/p/w500/run.jpg", "另一个任务整理过的，也认");
    assert.equal(by.get("Film X (2015) [tmdbid=9401]")?.url, "https://image.tmdb.org/t/p/w500/movie-right.jpg", "说法不一：按目录结构猜（没有季目录就是电影）");
  } finally {
    deleteRun("run-shared");
    lib.cleanup();
  }
});

test("全库海报：请求里不等 TMDB，后台补到了再换上；年份对不上换一种类型；问过的不再问", async () => {
  const lib = isolatedLibrary("r-warm");
  lib.put("Local One/a.strm");
  lib.put("Local One/poster.jpg", "img");
  lib.put("Slow (2021) [tmdbid=9101]/x.strm");
  lib.put("Wrong Kind (2010) [tmdbid=9102]/x.strm");
  lib.put("Nothing (2012) [tmdbid=9103]/x.strm");
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tmdb = fakeTmdb(async (kind, id) => {
    if (id === 9101) {
      await hold;
      return { title: "慢", release_date: "2021-05-01", poster_path: "/slow.jpg" };
    }
    if (id === 9102) {
      return kind === "movie"
        ? { title: "同号的别的电影", release_date: "1999-01-01", poster_path: "/other.jpg" }
        : { name: "对的剧", first_air_date: "2010-03-01", poster_path: "/right.jpg" };
    }
    return null;
  });
  replaceTasks([lib.task]);
  useTmdbKey(true);
  resetPostersAcrossTasks();
  try {
    const first = (await get("/api/strm/posters/all")).json<StrmAllPostersResult>().posters;
    assert.deepEqual(
      first.map((p) => p.path),
      ["Local One"],
      "离线有的先给，不等 TMDB（9101 这时候还拖着没回）",
    );
    release();
    await settlePostersAcrossTasks();
    const after = (await get("/api/strm/posters/all")).json<StrmAllPostersResult>().posters;
    const by = new Map(after.map((p) => [p.path, p]));
    assert.equal(by.get("Slow (2021) [tmdbid=9101]")?.url, "https://image.tmdb.org/t/p/w500/slow.jpg", "后台补到了，重算一遍换上");
    assert.equal(by.get("Wrong Kind (2010) [tmdbid=9102]")?.url, "https://image.tmdb.org/t/p/w500/right.jpg", "年份对不上是另一部，换另一种类型");
    assert.ok(!by.has("Nothing (2012) [tmdbid=9103]"));

    const asked = tmdb.asked.length;
    resetPostersAcrossTasks();
    await get("/api/strm/posters/all");
    await settlePostersAcrossTasks();
    assert.equal(tmdb.asked.length, asked, "有图的、没图的都记在缓存里，重算也不再问");
  } finally {
    release();
    tmdb.stop();
    useTmdbKey(false);
    lib.cleanup();
  }
});

test("全库海报：TMDB 连不上就歇一阵，不是每次都去撞", async () => {
  const lib = isolatedLibrary("r-down");
  lib.put("Offline (2020) [tmdbid=9111]/x.strm");
  const tmdb = fakeTmdb(() => new Error("connect ETIMEDOUT"));
  replaceTasks([lib.task]);
  useTmdbKey(true);
  resetPostersAcrossTasks();
  try {
    await get("/api/strm/posters/all");
    await settlePostersAcrossTasks();
    assert.deepEqual(tmdb.asked, ["movie/9111"], "连不上：这个 id 问一次就停");
    // 任务表变了当场重算，又有等联网的线索——但还在歇着
    replaceTasks([lib.task, { ...tOl, id: "r-down-extra", targetPath: "strm-itest/down-extra" }]);
    await get("/api/strm/posters/all");
    await settlePostersAcrossTasks();
    assert.deepEqual(tmdb.asked, ["movie/9111"], "歇着的时候不再去撞");
  } finally {
    tmdb.stop();
    useTmdbKey(false);
    lib.cleanup();
  }
});
