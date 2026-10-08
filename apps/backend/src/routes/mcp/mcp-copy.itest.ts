/**
 * 「复制到 OpenList」接进智能体的闭环：起真实端口，用官方 SDK 的客户端连 /mcp，网盘用内存假网盘，
 * OpenList 那几个调用换成桩、115 云下载接口换成桩；复制循环跑不出结果（桩里什么都看不见），只看登记了什么。
 *   - share_save 的 copy：不填按任务开关（开着删源的如实说）、true 这次复制（不删源）、false 这次不复制；
 *     明说要复制却没配好，转存前就报 COPY_NOT_READY、网盘没动；任务开着复制却没配好的，结果里说清楚；
 *     去重时多要 copy 只补复制、不再转存，上次交给了会直接执行的自动整理的不补
 *   - offline_add 的 copy / copyDstDir：不给 task 也能下完复制（平铺）、给了 copyDstDir 却不复制报错、没填挂载根报错；
 *     strmAfterDownload 只算生成 strm 的回执；offline_list 把两种回执分开列
 *   - follow_check 带回 copy；没开转存那一组的令牌不叫它调 copy_list
 *   - copy_list / copy_retry：条数、过滤、配置、能不能重试、各种状态；只读令牌看不到 copy_retry
 *   - drive_archive：不管复制、把网盘上的目录 / 文件收进任务目录下的「归档」；正在复制的不动；只读令牌看不到
 *   - overview / tasks_list 的复制字段
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/mcp/mcp-copy.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import mcpRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { createApiToken, deleteAllApiTokens } from "../../db/repositories/api-tokens.js";
import { writeKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import { __test_resetOrganize } from "../../db/repositories/organize.js";
import { patchAppSettings, readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import { __test_resetAgentQuota } from "../../services/agent/rate-limit.js";
import { __test_resetJobs } from "../../services/agent/jobs.js";
import { __test_resetTransferCaches } from "../../services/agent/tools/transfer.js";
import { __test_resetCopy, enqueueCopy, listCopies, setCopyServiceDeps, stopCopyWatcher, type CopyRecord } from "../../services/copy/service.js";
import { saveCopies } from "../../services/copy/queue.js";
import { __test_resetFollows, setFollowServiceDeps } from "../../services/follow/service.js";
import { setOfflineTransport, type OfflineTransport } from "../../services/cloud-115/offline.js";
import { __test_resetOffline, listFollowups, setOfflineServiceDeps, type OfflineFollowup } from "../../services/offline/service.js";
import { __test_resetAutoOrganize, startAutoOrganize } from "../../services/organize/auto.js";
import { cancelAllRuns, setOrganizeDeps } from "../../services/organize/run.js";
import type { TmdbApi } from "../../services/organize/identify.js";
import { cancelAllRunningTasks } from "../../services/task/registry.js";
import { FakeDrive } from "../../test/fake-drive.js";

const a115: AccountInfo = { accountType: "115", name: "a", cookie: "c" };
const ol: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
/** 没开复制 */
const tv: TaskDefinition = { id: "c-tv", account: "a", accountType: "115", originPath: "tv", targetPath: "mcp-copy/tv", strmPrefix: "/mnt/pan" };
/** 开着复制、复制后删源，目标目录填在任务上 */
const movies: TaskDefinition = {
  id: "c-movies",
  account: "a",
  accountType: "115",
  originPath: "movies",
  targetPath: "mcp-copy/movies",
  strmPrefix: "/mnt/pan",
  copyToOpenlist: { enabled: true, dstDir: "/local/movies", afterCopy: "delete" },
};
/** 开着自动整理（把握大的直接执行），没开复制 */
const anime: TaskDefinition = {
  id: "c-anime", account: "a", accountType: "115", originPath: "anime", targetPath: "mcp-copy/anime", strmPrefix: "/mnt/pan", organize: { mode: "auto" },
};
const COPY_SETTINGS = { account: "ol", dstDir: "/local/media", mounts: { a: "/115" } };
const LOCAL = path.join(DATA_DIR, "mcp-copy");

/** 什么都认不出的 TMDB：自动整理建得出清单，但不会动网盘 */
class BlankTmdb implements TmdbApi {
  async search() {
    return [];
  }
  async details() {
    return null;
  }
  async season() {
    return [];
  }
}

/** 115 云下载接口的桩：每条链接都收下，info hash 按下标给 */
const offlineTransport: OfflineTransport = {
  async web(_acc, ac) {
    if (ac === "task_lists") return { page: 1, page_count: 1, page_size: 30, count: 0, quota: 5, total: 10, tasks: [] };
    if (ac === "get_quota_info") return { state: true, quota: 5, total: 10 };
    return { state: true };
  },
  async ssp(_acc, _ac, payload) {
    const urls = Object.keys(payload).filter((k) => k.startsWith("url[")).map((k) => String(payload[k]));
    return {
      state: true,
      data: {
        state: true,
        result: urls.map((u, i) =>
          u.includes("dn=dup")
            ? { state: false, errno: 10008, error_msg: "任务已存在", info_hash: "hdup", name: "旧的", url: u }
            : { state: true, errno: 0, info_hash: `h${i}`, name: `n${i}`, url: u },
        ),
      },
    };
  },
  async downPath() {
    return { state: true, errno: null, data: [] };
  },
};

let d115: FakeDrive;
let app: FastifyInstance;
let url: string;
let readToken: string;
let dailyToken: string;
/** 只开了追更那一组：追更检查的结果里不能叫它去调 copy_list */
let followOnlyToken: string;
let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };

before(async () => {
  startAutoOrganize();
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  replaceAccounts([a115, ol]);
  replaceTasks([tv, movies, anime]);
  replaceAppSettings({
    ...baseline.settings,
    strmExtensions: [".mkv"],
    downloadExtensions: [],
    tmdb: { apiKey: "x", language: "zh-CN" },
    organize: {},
    openlistCopy: COPY_SETTINGS,
    agent: { enabled: true, uiBaseUrl: "http://nas:3000" },
  });
  await writeAuthPassword("mcp-copy-pw");
  setCopyServiceDeps({
    openlist: {
      listNames: async () => [],
      mkdir: async () => {},
      copy: async () => [],
      copyTasks: async () => ({ undone: [], done: [] }),
    },
    notify: async () => {},
  });
  setFollowServiceDeps({ notify: async () => {}, random: () => 0.5, gapMs: 0 });
  setOfflineTransport(offlineTransport);
  setOfflineServiceDeps({ resolveDirId: async () => "999", generate: async () => ({ generatedCount: 1, skippedCount: 0, invalidNames: [] }), notify: async () => {} });
  setOrganizeDeps({ tmdb: () => new BlankTmdb(), notify: async () => true, retryDelayMs: 5 });

  const all = ["sync", "transfer", "organize", "follow", "strm"] as const;
  readToken = createApiToken({ name: "只读", scopes: ["read"], toolsets: [...all], expiresAt: null }).token;
  dailyToken = createApiToken({ name: "日常", scopes: ["read", "run", "write"], toolsets: [...all], expiresAt: null }).token;
  followOnlyToken = createApiToken({ name: "只追更", scopes: ["read", "run", "write"], toolsets: ["follow"], expiresAt: null }).token;

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(mcpRoute);
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
});

beforeEach(async () => {
  cancelAllRuns();
  __test_resetOrganize();
  __test_resetAutoOrganize();
  await __test_resetCopy();
  await __test_resetOffline();
  await __test_resetFollows();
  __test_resetAgentQuota();
  __test_resetJobs();
  __test_resetTransferCaches();
  patchAppSettings({ openlistCopy: COPY_SETTINGS });
  d115 = new FakeDrive("115", a115, { share: true });
  for (const dir of ["/tv", "/movies", "/anime"]) d115.tree.addDir(dir);
  setDriveProviderFactory((account) => (account.name === "a" ? d115 : null));
  fs.rmSync(LOCAL, { recursive: true, force: true });
});

after(async () => {
  cancelAllRuns();
  cancelAllRunningTasks();
  await app.close();
  await __test_resetCopy();
  setCopyServiceDeps(null);
  await __test_resetOffline();
  setOfflineTransport(null);
  setOfflineServiceDeps(null);
  await __test_resetFollows();
  setFollowServiceDeps(null);
  setOrganizeDeps(null);
  setDriveProviderFactory(null);
  __test_resetOrganize();
  __test_resetAutoOrganize();
  __test_resetJobs();
  __test_resetTransferCaches();
  __test_resetAgentQuota();
  deleteAllApiTokens();
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(LOCAL, { recursive: true, force: true });
  await writeAuthPassword(DEFAULT_AUTH.password);
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "mcp-copy", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

/** 调一个工具，把 text 块里的 JSON 解出来 */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const block = (res.content as Array<{ type: string; text?: string }>)[0];
  assert.equal(block?.type, "text", `${name} 没回 text 块`);
  return { isError: res.isError === true, data: JSON.parse(block.text!) as Record<string, any> };
}

/** 在假网盘上定义一个 115 分享，返回它的链接 */
function defineShare(code: string, files: string[]): string {
  const share = d115.share!.define(code, { title: `分享 ${code}` });
  for (const f of files) share.addFile(f);
  return `https://115.com/s/${code}`;
}

const MAGNET = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";
/** 115 上原本就有的（桩回「任务已存在」） */
const DUP_MAGNET = "magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff&dn=dup";

/** 队列里的一条记录：只填测试关心的，其余给默认值 */
function record(over: Partial<CopyRecord>): CopyRecord {
  return {
    id: "r",
    account: "a",
    srcDir: "/movies",
    name: "x.mkv",
    dstDir: "/local/movies",
    afterCopy: "keep",
    dstBase: "/local/movies",
    rootPath: "/movies",
    taskId: "c-movies",
    trigger: "share",
    addedAt: Date.now(),
    status: "pending",
    stage: "waiting",
    detail: "等着复制到 OpenList",
    attempts: 0,
    waits: 0,
    misses: 0,
    ...over,
  };
}

function followup(over: Partial<OfflineFollowup>): OfflineFollowup {
  return { infoHash: "h", account: "a", taskId: "", subPath: "", name: "n", addedAt: Date.now(), status: "pending", detail: "等待 115 下载完成", attempts: 0, misses: 0, ...over };
}

test("工具清单：copy_list 只读就有、copy_retry 要改网盘档，都在转存那一组", async () => {
  const read = await connect(readToken);
  const daily = await connect(dailyToken);
  const followOnly = await connect(followOnlyToken);
  try {
    const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
    const r = await names(read);
    assert.ok(r.includes("copy_list"));
    assert.ok(!r.includes("copy_retry"), "只读令牌看不到重试");
    const d = await names(daily);
    assert.ok(d.includes("copy_list") && d.includes("copy_retry"));
    const f = await names(followOnly);
    assert.ok(!f.includes("copy_list") && !f.includes("copy_retry"), "没开转存那一组就没有");
    const retry = (await daily.listTools()).tools.find((t) => t.name === "copy_retry")!;
    assert.equal(retry.annotations?.readOnlyHint, false);
    assert.equal(retry.annotations?.idempotentHint, true);
  } finally {
    await read.close();
    await daily.close();
    await followOnly.close();
  }
});

test("转存：任务开着复制后删源 → 结果如实说会删源；没开复制的任务 copy: true 也复制、不删源；任务开着复制时 copy: false 被拒、网盘没动", async () => {
  const client = await connect(dailyToken);
  try {
    const onTask = await call(client, "share_save", { link: defineShare("cpa1", ["/E01.mkv", "/E02.mkv"]), task: "movies" });
    assert.equal(onTask.data.state, "done", JSON.stringify(onTask.data));
    assert.equal(onTask.data.copy.queued, 2);
    assert.equal(onTask.data.copy.dstDir, "/local/movies");
    assert.equal(onTask.data.copy.deleteSource, true);
    assert.match(onTask.data.copy.note, /删掉网盘上的源文件/);
    assert.match(onTask.data.copy.note, /copy_list/);
    let rows = listCopies();
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.trigger, "share");
      assert.equal(r.taskId, "c-movies");
      assert.equal(r.afterCopy, "delete");
      assert.equal(r.dstDir, "/local/movies");
    }

    // 任务开着复制时「这次不复制」兑现不了（网盘监控也会交给复制，界面上的勾选框同样锁着）：转存前就拒，网盘不动
    const receives = d115.share!.calls.receive;
    const skip = await call(client, "share_save", { link: defineShare("cpa2", ["/X.mkv"]), task: "movies", copy: false });
    assert.equal(skip.isError, true);
    assert.equal(skip.data.code, "COPY_ALWAYS_ON");
    assert.match(skip.data.hint, /任务设置里关掉/);
    assert.equal(d115.share!.calls.receive, receives, "没转存");
    assert.equal(d115.tree.get("/movies/X.mkv"), undefined);

    const forced = await call(client, "share_save", { link: defineShare("cpa3", ["/Y.mkv"]), task: "tv", copy: true });
    assert.equal(forced.data.copy.queued, 1, JSON.stringify(forced.data));
    assert.equal(forced.data.copy.dstDir, "/local/media", "任务上没填目标目录就用设置页的");
    assert.equal(forced.data.copy.deleteSource, false, "任务没开删源就不删");
    rows = listCopies();
    const y = rows.find((r) => r.name === "Y.mkv")!;
    assert.equal(y.afterCopy, "keep");
    assert.equal(y.taskId, "c-tv");

    // 没开复制的任务：copy: false 和不传一样，都不复制
    for (const [code, args] of [["cpa4", {}], ["cpa5", { copy: false }]] as const) {
      const off = await call(client, "share_save", { link: defineShare(code, [`/${code}.mkv`]), task: "tv", ...args });
      assert.equal(off.data.state, "done", JSON.stringify(off.data));
      assert.equal(off.data.copy, undefined, "任务没开、这次也没要：不带 copy");
    }
    assert.equal(listCopies().length, 3);
  } finally {
    await client.close();
  }
});
test("转存：明说要复制却没配好，转存前就报 COPY_NOT_READY、网盘没动；任务开着复制却没配好的照常转存，结果里说清楚", async () => {
  patchAppSettings({ openlistCopy: { ...COPY_SETTINGS, mounts: {} } });
  const client = await connect(dailyToken);
  try {
    const refused = await call(client, "share_save", { link: defineShare("cpb1", ["/A.mkv"]), task: "tv", copy: true });
    assert.equal(refused.isError, true);
    assert.equal(refused.data.code, "COPY_NOT_READY");
    assert.match(refused.data.error, /挂载根/);
    assert.match(refused.data.hint, /设置页/);
    assert.equal(d115.tree.get("/tv/A.mkv"), undefined, "没转存");
    assert.equal(d115.share!.calls.receive, 0);

    const blocked = await call(client, "share_save", { link: defineShare("cpb2", ["/B.mkv"]), task: "movies" });
    assert.equal(blocked.data.state, "done", JSON.stringify(blocked.data));
    assert.ok(d115.tree.get("/movies/B.mkv"));
    assert.equal(blocked.data.copy.queued, 0);
    assert.equal(blocked.data.copy.deleteSource, false);
    assert.match(blocked.data.copy.reason, /挂载根/);
    assert.match(blocked.data.copy.note, /设置页/);
    assert.equal(listCopies().length, 0);
  } finally {
    await client.close();
  }
});

test("转存去重：多要 copy 只补上次真正转存的条目、不再转存；不在原处的（被挪走、换成同名的另一份）不补；再要一次不会排两份", async () => {
  const client = await connect(dailyToken);
  try {
    const share = d115.share!.define("cpc1", { title: "整层" });
    share.addFile("/A.mkv");
    const link = "https://115.com/s/cpc1";
    const first = await call(client, "share_save", { link, task: "tv" });
    assert.equal(first.data.state, "done", JSON.stringify(first.data));
    assert.equal(first.data.copy, undefined);
    const receives = d115.share!.calls.receive;

    // 分享者后来又加了 B：整层转存的去重键还是同一个，补复制只认上次存进来的 A
    share.addFile("/B.mkv");
    const extra = await call(client, "share_save", { link, task: "tv", copy: true });
    assert.equal(extra.data.duplicate, true, JSON.stringify(extra.data));
    assert.match(extra.data.message, /只补上了复制/);
    assert.equal(extra.data.copy.queued, 1);
    assert.equal(extra.data.copy.deleteSource, false);
    assert.equal(d115.share!.calls.receive, receives, "网盘上没再存一份");
    assert.equal(d115.tree.get("/tv/B.mkv"), undefined, "B 没转存，也不该复制");
    const [rec] = listCopies();
    assert.equal(listCopies().length, 1);
    assert.equal(rec.name, "A.mkv");
    assert.equal(rec.srcDir, "/tv");
    assert.equal(rec.trigger, "share");
    assert.equal(rec.nodeId, d115.tree.get("/tv/A.mkv")!.id, "钉住核对时看到的那一份");

    // 再要一次：上次那个作业的结果不会被补复制改写，所以会再核对一遍，队列里已经有了，不排第二份
    const again = await call(client, "share_save", { link, task: "tv", copy: true });
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.copy.queued, 0);
    assert.match(again.data.copy.note, /已经在复制队列里/);
    assert.equal(listCopies().length, 1, "不排第二份");

    // 被整理挪走的、原处换成同名另一份的：按原路径复制不到，不补
    const link2 = defineShare("cpc2", ["/C.mkv", "/D.mkv"]);
    const saved2 = await call(client, "share_save", { link: link2, task: "tv" });
    assert.equal(saved2.data.state, "done", JSON.stringify(saved2.data));
    d115.tree.move("/tv/C.mkv", "/tv/某剧 (2020)/C.mkv");
    d115.tree.remove("/tv/D.mkv");
    d115.tree.addFile("/tv/D.mkv");
    const moved = await call(client, "share_save", { link: link2, task: "tv", copy: true });
    assert.equal(moved.data.duplicate, true, JSON.stringify(moved.data));
    assert.match(moved.data.copySkipped, /2 项里有 2 项已经不在原处/);
    assert.equal(moved.data.copy, undefined);
    assert.doesNotMatch(moved.data.message, /补上了复制/);
    assert.equal(listCopies().length, 1, "一条都没排");
  } finally {
    await client.close();
  }
});

test("转存去重：上次交给了自动整理（把握大的直接执行）、文件没被挪动的，照样补复制", async () => {
  const client = await connect(dailyToken);
  try {
    const link = defineShare("cpc3", ["/Some.Show.S01E01.mkv"]);
    const organized = await call(client, "share_save", { link, task: "anime" });
    assert.equal(organized.data.state, "done", JSON.stringify(organized.data));
    assert.ok(organized.data.organize, "交给了整理");
    const late = await call(client, "share_save", { link, task: "anime", copy: true });
    assert.equal(late.data.duplicate, true, JSON.stringify(late.data));
    assert.equal(late.data.copySkipped, undefined, "认不出的没被挪走，照样补");
    assert.equal(late.data.copy.queued, 1);
    const [rec] = listCopies().filter((c) => c.taskId === "c-anime");
    assert.equal(rec.name, "Some.Show.S01E01.mkv");
  } finally {
    await client.close();
  }
});

test("转存：同一个文件已经排着一条要删源的，这次没再排也如实说会删源；网盘监控先排了不删源的那条，整条目转存把删源补上", async () => {
  // 监控先登记了 E01（监控一律不删源）；整条目转存带着任务的「复制后删源」来了
  enqueueCopy({ account: "a", sources: [{ path: "/movies/E01.mkv", nodeId: "n-e01" }], rootPath: "movies", taskId: "c-movies", trigger: "monitor", afterCopy: "keep", dstDir: "/local/movies" });
  await stopCopyWatcher();
  const client = await connect(dailyToken);
  try {
    const saved = await call(client, "share_save", { link: defineShare("cpe1", ["/E01.mkv", "/E02.mkv"]), task: "movies" });
    assert.equal(saved.data.state, "done", JSON.stringify(saved.data));
    assert.equal(saved.data.copy.queued, 1, "E02 新排，E01 已经排着");
    assert.equal(saved.data.copy.deleteSource, true);
    const e01 = listCopies().find((r) => r.name === "E01.mkv")!;
    assert.equal(e01.trigger, "monitor");
    assert.equal(e01.afterCopy, "delete", "删源补上了，不因为谁先登记而丢");
    assert.equal(e01.nodeId, "n-e01");

    // 排着的那条要删源，这次（没开删源的任务上明说要复制）没再排：删不删源照排着的那条说
    enqueueCopy({ account: "a", sources: [{ path: "/tv/F.mkv", nodeId: "n-f" }], rootPath: "tv", taskId: "c-tv", trigger: "share", afterCopy: "delete" });
    await stopCopyWatcher();
    const dup = await call(client, "share_save", { link: defineShare("cpe2", ["/F.mkv"]), task: "tv", copy: true });
    assert.equal(dup.data.copy.queued, 0, JSON.stringify(dup.data));
    assert.equal(dup.data.copy.deleteSource, true);
    assert.match(dup.data.copy.note, /排着的那些复制成功后会删掉网盘上的源文件/);
  } finally {
    await client.close();
  }
});

test("转存去重：回话带着上次的复制情况；没开复制的任务上次明说复制了、这次说 copy: false 的，说清楚管不了", async () => {
  const client = await connect(dailyToken);
  try {
    const link = defineShare("cpf1", ["/G.mkv"]);
    await call(client, "share_save", { link, task: "movies" });
    const repeat = await call(client, "share_save", { link, task: "movies" });
    assert.equal(repeat.data.duplicate, true);
    assert.equal(repeat.data.copy.queued, 1, JSON.stringify(repeat.data));
    assert.equal(repeat.data.copy.deleteSource, true, "上次那次会删源，重复的回话里照样说");
    assert.equal(repeat.data.copyNote, undefined);

    const link2 = defineShare("cpf2", ["/H.mkv"]);
    await call(client, "share_save", { link: link2, task: "tv", copy: true });
    const undo = await call(client, "share_save", { link: link2, task: "tv", copy: false });
    assert.equal(undo.data.duplicate, true);
    assert.match(undo.data.copyNote, /管不了它/);
    assert.equal(listCopies().filter((c) => c.name === "H.mkv").length, 1);
  } finally {
    await client.close();
  }
});

test("转存：条目进了网盘、strm 没生成好时，开着复制的照样排进复制队列，报错里带着 copy", async () => {
  // 本地任务目录的位置被一个文件占了：生成 strm 必然失败
  fs.mkdirSync(LOCAL, { recursive: true });
  fs.writeFileSync(path.join(LOCAL, "movies"), "不是目录");
  const client = await connect(dailyToken);
  try {
    const res = await call(client, "share_save", { link: defineShare("cpg1", ["/I.mkv"]), task: "movies" });
    assert.equal(res.isError, true, JSON.stringify(res.data));
    assert.equal(res.data.received, true);
    assert.equal(res.data.copy.queued, 1);
    assert.equal(res.data.copy.deleteSource, true);
    assert.match(res.data.copy.note, /copy_list/);
    const [rec] = listCopies();
    assert.equal(rec.name, "I.mkv");
    assert.ok(d115.tree.get("/movies/I.mkv"), "条目确实进了网盘");
  } finally {
    await client.close();
  }
});
test("云下载：不给 task 也能下完复制（平铺）、copyDstDir 跟着走；任务开着复制的按任务来、删不删源冻结在回执上；strmAfterDownload 只算生成 strm 的", async () => {
  const client = await connect(dailyToken);
  try {
    const bare = await call(client, "offline_add", { urls: MAGNET, copy: true });
    assert.equal(bare.isError, false, JSON.stringify(bare.data));
    assert.equal(bare.data.strmAfterDownload, false, "只复制不生成 strm");
    assert.equal(bare.data.copy.dstDir, "/local/media");
    assert.equal(bare.data.copy.deleteSource, false);
    assert.match(bare.data.copy.note, /平铺/);
    assert.match(bare.data.next, /copy_list/);
    let [f] = listFollowups();
    assert.equal(f.kind, "openlist-copy");
    assert.equal(f.copyDstDir, "/local/media");
    assert.equal(f.copyAfterCopy, "keep");
    assert.equal(f.taskId, "");

    const elsewhere = await call(client, "offline_add", { urls: MAGNET, copy: true, copyDstDir: " /local/media/别处/ " });
    assert.equal(elsewhere.data.copy.dstDir, "/local/media/别处");
    [f] = listFollowups();
    assert.equal(f.copyDstDir, "/local/media/别处");

    const byTask = await call(client, "offline_add", { urls: MAGNET, task: "movies" });
    assert.equal(byTask.data.strmAfterDownload, true);
    assert.equal(byTask.data.copy.dstDir, "/local/movies");
    assert.equal(byTask.data.copy.deleteSource, true, "按任务的「复制后删源」说");
    assert.equal(byTask.data.copy.afterCopy, "delete");
    assert.match(byTask.data.copy.note, /删掉网盘上的源文件/);
    [f] = listFollowups();
    assert.equal(f.kind ?? "strm", "strm");
    assert.equal(f.copyDstDir, "/local/movies", "生成 strm 的回执兼办复制");
    assert.equal(f.copyAfterCopy, "delete", "删不删源在加任务这一刻冻结");

    const plain = await call(client, "offline_add", { urls: MAGNET, task: "tv" });
    assert.equal(plain.data.strmAfterDownload, true);
    assert.equal(plain.data.copy, undefined);
    assert.doesNotMatch(plain.data.next, /copy_list/);
    // 没开复制的任务：copy: false 和不传一样
    const tvOff = await call(client, "offline_add", { urls: MAGNET, task: "tv", copy: false });
    assert.equal(tvOff.isError, false, JSON.stringify(tvOff.data));
    assert.equal(tvOff.data.copy, undefined);
  } finally {
    await client.close();
  }
});

test("云下载：同一批里有新链接、也有 115 上原本就有的：新的生成 strm 并复制，原本就有的也登记复制（删不删源到下完时看在不在任务目录里）", async () => {
  const client = await connect(dailyToken);
  try {
    const res = await call(client, "offline_add", { urls: `${MAGNET}\n${DUP_MAGNET}`, task: "movies" });
    assert.equal(res.isError, false, JSON.stringify(res.data));
    assert.equal(res.data.added, 1);
    assert.equal(res.data.strmAfterDownload, true);
    assert.match(res.data.copy.note, /在任务目录里的按层级摆/);
    const byHash = new Map(listFollowups().map((f) => [f.infoHash, f]));
    assert.equal(byHash.get("h0")?.kind ?? "strm", "strm");
    assert.equal(byHash.get("h0")?.copyDstDir, "/local/movies");
    const dup = byHash.get("hdup");
    assert.ok(dup, "原本就有的那条不能漏掉");
    assert.equal(dup.kind, "openlist-copy");
    assert.equal(dup.taskId, "c-movies");
    assert.equal(dup.copyDstDir, "/local/movies");
  } finally {
    await client.close();
  }
});
test("云下载：任务开着复制时 copy: false 被拒；给了 copyDstDir 却不复制、或者落在目标目录外面都报错；没填挂载根、OpenList 账号不可用的照实说", async () => {
  const client = await connect(dailyToken);
  try {
    const skip = await call(client, "offline_add", { urls: MAGNET, task: "movies", copy: false });
    assert.equal(skip.isError, true);
    assert.equal(skip.data.code, "COPY_ALWAYS_ON");
    assert.equal(listFollowups().length, 0, "没提交");

    for (const args of [{ copyDstDir: "/local/media/x" }, { task: "tv", copyDstDir: "/local/media/x" }, { task: "tv", copy: false, copyDstDir: "/local/media/x" }]) {
      const res = await call(client, "offline_add", { urls: MAGNET, ...args });
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.equal(res.data.code, "VALIDATION");
      assert.match(res.data.error, /copyDstDir/);
    }
    // 复制目标只能在任务上、设置页的目标目录下面：别的网盘的挂载根不行
    const outside = await call(client, "offline_add", { urls: MAGNET, task: "movies", copyDstDir: "/quark/x" });
    assert.equal(outside.isError, true);
    assert.equal(outside.data.code, "VALIDATION");
    assert.match(outside.data.error, /\/local\/movies 或 \/local\/media/);
    assert.equal(listFollowups().length, 0);
    // 任务开着复制：不传 copy 也算会复制，copyDstDir 有用（在任务的目标目录下面）
    const ok = await call(client, "offline_add", { urls: MAGNET, task: "movies", copyDstDir: "/local/movies/另存" });
    assert.equal(ok.data.copy.dstDir, "/local/movies/另存", JSON.stringify(ok.data));

    patchAppSettings({ openlistCopy: { ...COPY_SETTINGS, mounts: {} } });
    await __test_resetOffline();
    const refused = await call(client, "offline_add", { urls: MAGNET, copy: true });
    assert.equal(refused.isError, true);
    assert.equal(refused.data.code, "COPY_NOT_READY");
    assert.match(refused.data.error, /挂载根/);
    assert.equal(listFollowups().length, 0, "没提交");

    const blocked = await call(client, "offline_add", { urls: MAGNET, task: "movies" });
    assert.equal(blocked.isError, false, JSON.stringify(blocked.data));
    assert.match(blocked.data.copy.reason, /挂载根/);
    assert.match(blocked.data.copy.note, /设置页/);

    // 设置上都填了，OpenList 账号却被删了：不许诺复制，回执也不带复制目标
    patchAppSettings({ openlistCopy: COPY_SETTINGS });
    replaceAccounts([a115]);
    await __test_resetOffline();
    const gone = await call(client, "offline_add", { urls: MAGNET, task: "movies" });
    assert.equal(gone.isError, false, JSON.stringify(gone.data));
    assert.match(gone.data.copy.reason, /OpenList 账号不存在/);
    assert.equal(listFollowups()[0].copyDstDir, undefined);
  } finally {
    replaceAccounts([a115, ol]);
    await client.close();
  }
});
test("云下载列表：「下完只复制」的回执单独列，生成 strm 又要复制的带 copyTo", async () => {
  writeKv(KEY.offlineFollowups, [
    followup({ infoHash: "s1", name: "片子.mkv", taskId: "c-movies", copyDstDir: "/local/movies" }),
    followup({ infoHash: "c1", name: "只复制.mkv", kind: "openlist-copy", copyDstDir: "/local/media" }),
    followup({ infoHash: "c2", name: "复制过了.mkv", kind: "openlist-copy", copyDstDir: "/local/media", status: "done", detail: "已交给复制队列：/local/media", doneAt: Date.now() }),
  ]);
  const client = await connect(readToken);
  try {
    const res = await call(client, "offline_list", {});
    assert.equal(res.isError, false, JSON.stringify(res.data));
    assert.deepEqual(res.data.strmPending.map((f: { name: string; copyTo?: string }) => [f.name, f.copyTo]), [["片子.mkv", "/local/movies"]]);
    assert.deepEqual(res.data.copyPending.map((f: { name: string; copyTo?: string }) => [f.name, f.copyTo]), [["只复制.mkv", "/local/media"]]);
    assert.equal(res.data.copyRecent[0].status, "done");
    assert.match(res.data.copyRecent[0].detail, /复制队列/);
  } finally {
    await client.close();
  }
});

test("追更检查：任务开着复制，新增排进复制队列、结果带 copy；没开转存那一组的令牌不叫它调 copy_list", async () => {
  const code = "cpd1";
  const share = d115.share!.define(code, { title: "新剧" });
  share.addFile("/S01E01.mkv");
  const daily = await connect(dailyToken);
  const followOnly = await connect(followOnlyToken);
  try {
    const saved = await call(daily, "share_save", { link: `https://115.com/s/${code}`, task: "movies", follow: true });
    assert.equal(saved.data.state, "done", JSON.stringify(saved.data));
    // 转存那一下已经排了复制：清掉，下面只看追更那一轮的
    await __test_resetCopy();
    const followId = saved.data.follow.id as string;

    share.addFile("/S01E02.mkv");
    const checked = await call(daily, "follow_check", { follow: followId });
    assert.equal(checked.data.state, "done", JSON.stringify(checked.data));
    assert.equal(checked.data.run.added, 1);
    assert.equal(checked.data.copy.queued, 1);
    assert.equal(checked.data.copy.deleteSource, true);
    assert.match(checked.data.copy.note, /copy_list/);
    const [rec] = listCopies();
    assert.equal(rec.trigger, "follow");
    assert.equal(rec.name, "S01E02.mkv");

    share.addFile("/S01E03.mkv");
    const other = await call(followOnly, "follow_check", { follow: followId });
    assert.equal(other.data.copy.queued, 1, JSON.stringify(other.data));
    assert.doesNotMatch(other.data.copy.note, /copy_list/, "它调不了 copy_list");
    assert.match(other.data.copy.note, /云下载页/);

    const quiet = await call(daily, "follow_check", { follow: followId });
    assert.equal(quiet.data.copy, undefined, "没有新增就不带 copy");
  } finally {
    await daily.close();
    await followOnly.close();
  }
});

test("复制队列：各状态的条数、过滤、配置；能不能重试；只读令牌的下一步请用户去界面重试；设置没配好照实说", async () => {
  saveCopies([
    record({ id: "f1", status: "failed", name: "失败.mkv", detail: "OpenList 复制失败：磁盘满了", doneAt: Date.now() }),
    record({ id: "s1", status: "skipped", name: "跳过.mkv", taskId: "c-tv", srcDir: "/tv", rootPath: "/tv", dstDir: "/local/media", doneAt: Date.now() }),
    record({ id: "d1", status: "done", name: "好了.mkv", doneAt: Date.now() }),
    record({ id: "p1", status: "pending", name: "在跑.mkv", afterCopy: "delete" }),
    record({ id: "a1", status: "failed", name: "接管的.mkv", adopted: true, srcDir: "", taskId: "", doneAt: Date.now() }),
    record({ id: "x1", status: "skipped", name: "拆开了.mkv", superseded: true, detail: "整理把「拆开了」里的文件挪到了别处", doneAt: Date.now() }),
  ]);
  const daily = await connect(dailyToken);
  const read = await connect(readToken);
  try {
    const all = await call(daily, "copy_list", {});
    assert.equal(all.isError, false, JSON.stringify(all.data));
    assert.deepEqual(all.data.counts, { pending: 1, failed: 2, done: 1, skipped: 2 });
    assert.equal(all.data.total, 6);
    assert.equal(all.data.config.configured, true);
    assert.equal(all.data.config.openlistAccount, "ol");
    assert.equal(all.data.config.defaultDstDir, "/local/media");
    assert.deepEqual(all.data.config.mounts, { a: "/115" });
    const byId = new Map(all.data.items.map((i: Record<string, any>) => [i.id, i]));
    const f1 = byId.get("f1") as Record<string, any>;
    assert.equal(f1.canRetry, true);
    assert.equal(f1.statusText, "失败");
    assert.equal(f1.source, "/movies/失败.mkv");
    assert.equal(f1.trigger, "转存");
    assert.equal(f1.task.label, "a · movies");
    assert.equal((byId.get("s1") as Record<string, any>).canRetry, true, "跳过的也能重试");
    assert.equal((byId.get("d1") as Record<string, any>).canRetry, false, "已复制的不给重试");
    assert.equal((byId.get("x1") as Record<string, any>).canRetry, false, "用不着了的（整理拆开了、后来复制好了）不给重试");
    assert.equal((byId.get("p1") as Record<string, any>).deleteSource, true);
    const adopted = byId.get("a1") as Record<string, any>;
    assert.equal(adopted.canRetry, false);
    assert.equal(adopted.source, null);
    assert.equal(adopted.task, undefined);
    assert.match(all.data.next, /copy_retry/);
    assert.match(all.data.next, /别连续快速轮询/);
    assert.equal(all.data.openInUi, "http://nas:3000/offline#copy-queue");

    const failed = await call(daily, "copy_list", { status: "failed" });
    assert.deepEqual(failed.data.items.map((i: { id: string }) => i.id).sort(), ["a1", "f1"]);
    const tvOnly = await call(daily, "copy_list", { task: "tv" });
    assert.deepEqual(tvOnly.data.items.map((i: { id: string }) => i.id), ["s1"]);
    assert.equal(tvOnly.data.task.id, "c-tv");
    assert.deepEqual(tvOnly.data.counts, { pending: 0, failed: 0, done: 0, skipped: 1 });

    const readOnly = await call(read, "copy_list", {});
    assert.doesNotMatch(readOnly.data.next, /copy_retry/);
    assert.match(readOnly.data.next, /云下载页/);

    patchAppSettings({ openlistCopy: { ...COPY_SETTINGS, account: "" } });
    const broken = await call(daily, "copy_list", {});
    assert.equal(broken.data.config.configured, false);
    assert.match(broken.data.config.problem, /OpenList 账号/);
    assert.match(broken.data.next, /设置页/);
  } finally {
    await daily.close();
    await read.close();
  }
});

test("copy_add：手动把任务目录里已有的目录交给复制；复制后删源要「删除」档；只读令牌看不到这个工具", async () => {
  d115.tree.addFile("/tv/Show/E01.mkv");
  d115.tree.addFile("/tv/Show/E02.mkv");
  const daily = await connect(dailyToken);
  const read = await connect(readToken);
  try {
    assert.ok(!(await read.listTools()).tools.some((t) => t.name === "copy_add"), "只读令牌没有 copy_add");
    const tool = (await daily.listTools()).tools.find((t) => t.name === "copy_add")!;
    assert.match(tool.description ?? "", /得到同意再调用/);

    const res = await call(daily, "copy_add", { task: "tv", paths: ["Show"] });
    assert.equal(res.isError, false, JSON.stringify(res.data));
    assert.equal(res.data.queued, 1);
    assert.equal(res.data.dstDir, "/local/media", "任务上没填目标目录就用设置页的");
    assert.equal(res.data.afterCopy, "keep", "任务没开复制：不动源文件");
    assert.deepEqual(res.data.items, [{ path: "Show", outcome: "queued", queued: 1, isDir: true, outcomeText: "已排进队列" }]);
    assert.match(res.data.note, /已排进复制队列/);
    assert.match(res.data.next, /copy_list/);
    const [row] = listCopies();
    assert.equal(row.trigger, "manual");
    assert.equal(row.name, "Show");
    assert.equal(row.isDir, true);
    assert.equal(row.nodeId, d115.tree.get("/tv/Show")!.id);
    await stopCopyWatcher();

    // 再来一次：已经排着，如实说
    const dup = await call(daily, "copy_add", { task: "tv", paths: ["Show"] });
    assert.equal(dup.data.queued, 0);
    assert.equal(dup.data.items[0].outcome, "duplicate");

    // 网盘上没有的
    const missing = await call(daily, "copy_add", { task: "tv", paths: ["没有的"] });
    assert.equal(missing.data.queued, 0);
    assert.equal(missing.data.items[0].outcome, "missing");
    assert.match(missing.data.reason, /网盘上没有/);
    assert.match(missing.data.note, /没有排上：网盘上没有/, "一条没排的原因要照实说，不能说成「已经排着」");

    // 日常令牌没有「删除」档：复制后删源拒掉，网盘和队列都不动
    const del = await call(daily, "copy_add", { task: "tv", paths: ["Show/E01.mkv"], afterCopy: "delete" });
    assert.equal(del.isError, true);
    assert.equal(del.data.code, "INSUFFICIENT_SCOPE");
    assert.match(del.data.hint, /archive/);
    assert.match(del.data.error, /^afterCopy: "delete"/, "明说的就说明说的");
    assert.doesNotMatch(del.data.error, /这个任务设的/, "tv 任务根本没开复制，不能说成任务设的");
    assert.equal(listCopies().length, 1);

    // 任务设的就是复制后删除（movies）：没明说 afterCopy 也拒，网盘和队列都不动
    d115.tree.addFile("/movies/M.mkv");
    const implied = await call(daily, "copy_add", { task: "movies", paths: ["M.mkv"] });
    assert.equal(implied.isError, true, JSON.stringify(implied.data));
    assert.equal(implied.data.code, "INSUFFICIENT_SCOPE");
    assert.match(implied.data.error, /这个任务设的就是复制后删除/);
    assert.equal(listCopies().length, 1);

    // 归档不用「删除」档
    const archive = await call(daily, "copy_add", { task: "tv", paths: ["Show/E02.mkv"], afterCopy: "archive" });
    assert.equal(archive.isError, false, JSON.stringify(archive.data));
    assert.equal(archive.data.afterCopy, "archive");
    assert.match(archive.data.note, /归档/);
    await stopCopyWatcher();

    // 任务目录本身、目标目录越界
    const root = await call(daily, "copy_add", { task: "tv", paths: [""] });
    assert.equal(root.isError, true);
    const dst = await call(daily, "copy_add", { task: "tv", paths: ["Show"], dstDir: "/elsewhere" });
    assert.equal(dst.isError, true);
    assert.equal(dst.data.code, "COPY_DST_INVALID");
  } finally {
    await stopCopyWatcher();
    await daily.close();
    await read.close();
  }
});

test("copy_after：按记录 id 事后归档源文件（目标里不全的不动、齐了才挪，本地 strm 跟着删）；删除要「删除」档；只读令牌看不到；copy_list 带 canAfterCopy", async () => {
  d115.tree.addFile("/tv/Show/E01.mkv", { size: 9 });
  d115.tree.addFile("/tv/Show/E02.mkv", { size: 9 });
  const local = path.join(LOCAL, "tv", "Show", "E01.strm");
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, "/mnt/pan/tv/Show/E01.mkv");
  /** OpenList 目标目录里现有的条目：这条用例自己换一套桩，结束时换回去 */
  const names: Record<string, string[]> = {};
  setCopyServiceDeps({
    openlist: {
      listNames: async (_cfg, dir) => names[dir] ?? [],
      listEntries: async (_cfg, dir) => (names[dir] ?? []).map((name) => ({ name, size: 9 })),
      mkdir: async () => {},
      copy: async () => [],
      copyTasks: async () => ({ undone: [], done: [] }),
    },
    notify: async () => {},
  });
  saveCopies([
    record({ id: "k1", status: "done", taskId: "c-tv", rootPath: "/tv", srcDir: "/tv/Show", name: "E01.mkv", isDir: false, dstDir: "/local/media/Show", dstBase: "/local/media", doneAt: Date.now(), detail: "复制完成" }),
    record({ id: "k2", status: "done", taskId: "c-tv", rootPath: "/tv", srcDir: "/tv/Show", name: "E02.mkv", isDir: false, dstDir: "/local/media/Show", dstBase: "/local/media", doneAt: Date.now(), detail: "复制完成" }),
  ]);
  const daily = await connect(dailyToken);
  const read = await connect(readToken);
  try {
    assert.ok(!(await read.listTools()).tools.some((t) => t.name === "copy_after"), "只读令牌没有 copy_after");
    const tool = (await daily.listTools()).tools.find((t) => t.name === "copy_after")!;
    assert.match(tool.description ?? "", /得到同意再调用/);

    const list = await call(daily, "copy_list", { status: "done" });
    assert.deepEqual(list.data.items.map((i: Record<string, unknown>) => [i.id, i.canAfterCopy]), [["k1", true], ["k2", true]]);
    assert.match(list.data.next, /copy_after/);

    // 目标里还什么都没有：核对不过，不动
    const incomplete = await call(daily, "copy_after", { ids: ["k1"], afterCopy: "archive" });
    assert.equal(incomplete.isError, false, JSON.stringify(incomplete.data));
    assert.equal(incomplete.data.state, "done");
    assert.equal(incomplete.data.done, 0);
    assert.equal(incomplete.data.items[0].outcome, "incomplete");
    assert.equal(incomplete.data.items[0].outcomeText, "目标里这一份不全，没动");
    assert.match(incomplete.data.next, /copy_add/);
    assert.ok(d115.tree.get("/tv/Show/E01.mkv"));

    // 目标里齐了：挪进归档，本地 strm 删掉
    names["/local/media/Show"] = ["E01.mkv"];
    const ok = await call(daily, "copy_after", { ids: ["k1"], afterCopy: "archive" });
    assert.equal(ok.isError, false, JSON.stringify(ok.data));
    assert.equal(ok.data.done, 1);
    assert.equal(ok.data.afterCopy, "archive");
    assert.deepEqual(ok.data.items.map((i: Record<string, unknown>) => [i.path, i.outcome, i.to]), [["Show/E01.mkv", "archived", "/tv/归档/Show"]]);
    assert.match(ok.data.note, /归档了 1 条/);
    assert.ok(d115.tree.get("/tv/归档/Show/E01.mkv"));
    assert.equal(d115.tree.get("/tv/Show/E01.mkv"), undefined);
    assert.equal(fs.existsSync(local), false);
    assert.equal(listCopies().find((c) => c.id === "k1")!.afterCopy, "archive");

    // 日常令牌没有「删除」档：拒掉，网盘不动
    const del = await call(daily, "copy_after", { ids: ["k2"], afterCopy: "delete" });
    assert.equal(del.isError, true);
    assert.equal(del.data.code, "INSUFFICIENT_SCOPE");
    assert.match(del.data.hint, /archive/);
    assert.ok(d115.tree.get("/tv/Show/E02.mkv"));

    // 按路径指：task + paths，和 ids 不能一起给
    const both = await call(daily, "copy_after", { ids: ["k2"], task: "tv", paths: ["Show/E02.mkv"], afterCopy: "archive" });
    assert.equal(both.isError, true);
    assert.equal(both.data.code, "VALIDATION");
    names["/local/media/Show"] = ["E01.mkv", "E02.mkv"];
    const byPath = await call(daily, "copy_after", { task: "tv", paths: ["Show/E02.mkv"], afterCopy: "archive" });
    assert.equal(byPath.isError, false, JSON.stringify(byPath.data));
    assert.deepEqual(byPath.data.items.map((i: Record<string, unknown>) => [i.id, i.outcome]), [["k2", "archived"]], "接着用队列里那条记录");
    assert.ok(d115.tree.get("/tv/归档/Show/E02.mkv"));
  } finally {
    await daily.close();
    await read.close();
    setCopyServiceDeps({
      openlist: { listNames: async () => [], mkdir: async () => {}, copy: async () => [], copyTasks: async () => ({ undone: [], done: [] }) },
      notify: async () => {},
    });
  }
});

test("drive_archive：不管复制过没有，把网盘上的目录 / 文件收进任务目录下的「归档」（本地 strm 跟着删、复制好的记录标成已归档）；正在复制的不动；只读令牌看不到", async () => {
  d115.tree.addFile("/tv/Show/E01.mkv", { size: 9 });
  d115.tree.addFile("/tv/Show/E02.mkv", { size: 9 });
  d115.tree.addFile("/tv/Other/E01.mkv", { size: 9 });
  const local = path.join(LOCAL, "tv", "Show", "E01.strm");
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, "/mnt/pan/tv/Show/E01.mkv");
  saveCopies([
    record({ id: "k1", status: "done", taskId: "c-tv", rootPath: "/tv", srcDir: "/tv/Show", name: "E01.mkv", isDir: false, dstDir: "/local/media/Show", dstBase: "/local/media", doneAt: Date.now(), detail: "复制完成" }),
    record({ id: "p1", status: "pending", taskId: "c-tv", rootPath: "/tv", srcDir: "/tv/Other", name: "E01.mkv", isDir: false, dstDir: "/local/media/Other", dstBase: "/local/media" }),
  ]);
  const daily = await connect(dailyToken);
  const read = await connect(readToken);
  try {
    assert.ok(!(await read.listTools()).tools.some((t) => t.name === "drive_archive"), "只读令牌没有 drive_archive");
    const tool = (await daily.listTools()).tools.find((t) => t.name === "drive_archive")!;
    assert.match(tool.description ?? "", /得到同意再调用/);

    // 目标里什么都没有也照收：不核对副本
    const res = await call(daily, "drive_archive", { task: "tv", paths: ["Show", "Other/E01.mkv", "没有的"] });
    assert.equal(res.isError, false, JSON.stringify(res.data));
    assert.equal(res.data.state, "done");
    assert.equal(res.data.done, 1);
    assert.equal(res.data.archiveDir, "/tv/归档");
    assert.deepEqual(
      res.data.items.map((i: Record<string, unknown>) => [i.path, i.outcome, i.outcomeText, i.to]),
      [
        ["Show", "archived", "已归档", "/tv/归档"],
        ["Other/E01.mkv", "copying", "正在复制到 OpenList，没动", undefined],
        ["没有的", "missing", "网盘上没有这条路径", undefined],
      ],
    );
    assert.match(res.data.note, /收进暂存区 1 条/);
    assert.match(res.data.next, /copy_after/);
    assert.match(res.data.openInUi, /\/strm\?taskId=c-tv/);
    assert.ok(d115.tree.get("/tv/归档/Show/E02.mkv"));
    assert.equal(d115.tree.get("/tv/Show"), undefined);
    assert.ok(d115.tree.get("/tv/Other/E01.mkv"), "正在复制的没动");
    assert.equal(fs.existsSync(local), false);
    assert.equal(listCopies().find((c) => c.id === "k1")!.afterCopy, "archive", "复制好的记录标成已归档");

    const bad = await call(daily, "drive_archive", { task: "tv", paths: ["归档/Show"] });
    assert.equal(bad.isError, true);
    assert.equal(bad.data.code, "VALIDATION");
    assert.match(bad.data.hint, /drive_browse/);
  } finally {
    await daily.close();
    await read.close();
  }
});

test("重试：失败 / 跳过的重新排队，已经在队列里的算成功；已复制的、接管的、不存在的不收；全都不行回 isError", async () => {
  saveCopies([
    record({ id: "f1", status: "failed", afterCopy: "delete", attempts: 3, doneAt: Date.now() }),
    record({ id: "s1", status: "skipped", name: "跳过.mkv", doneAt: Date.now() }),
    record({ id: "d1", status: "done", name: "好了.mkv", doneAt: Date.now() }),
    record({ id: "p1", status: "pending", name: "在跑.mkv" }),
    record({ id: "a1", status: "failed", name: "接管的.mkv", adopted: true, srcDir: "", doneAt: Date.now() }),
    record({ id: "x1", status: "skipped", name: "拆开了.mkv", superseded: true, doneAt: Date.now() }),
  ]);
  const client = await connect(dailyToken);
  try {
    const res = await call(client, "copy_retry", { ids: ["f1", "s1", "p1", "f1"] });
    assert.equal(res.isError, false, JSON.stringify(res.data));
    assert.equal(res.data.retried, 2);
    assert.equal(res.data.results.length, 3, "重复的 id 只算一次");
    const byId = new Map(res.data.results.map((r: Record<string, any>) => [r.id, r]));
    assert.equal((byId.get("f1") as Record<string, any>).deleteSource, true);
    assert.equal((byId.get("p1") as Record<string, any>).alreadyQueued, true);
    assert.match(res.data.note, /删掉网盘上的源文件/);
    const rows = new Map(listCopies().map((c) => [c.id, c]));
    assert.equal(rows.get("f1")!.status, "pending");
    assert.equal(rows.get("f1")!.attempts, 0);
    assert.equal(rows.get("f1")!.retried, true);
    assert.equal(rows.get("s1")!.status, "pending");

    const refused = await call(client, "copy_retry", { ids: ["d1", "a1", "x1", "没这条"] });
    assert.equal(refused.isError, true);
    assert.equal(refused.data.code, "NOT_RETRYABLE");
    assert.deepEqual(refused.data.results.map((r: { code: string }) => r.code), ["NOT_RETRYABLE", "NOT_RETRYABLE", "NOT_RETRYABLE", "COPY_NOT_FOUND"]);
    assert.match(refused.data.results[2].error, /用不着了/);
    assert.match(refused.data.results[0].error, /已经复制好了/);
    assert.equal(listCopies().find((c) => c.id === "d1")!.status, "done", "已复制的没动");

    const missing = await call(client, "copy_retry", { ids: ["没这条"] });
    assert.equal(missing.data.code, "COPY_NOT_FOUND");
  } finally {
    await client.close();
  }
});

test("总览和任务列表：复制配没配好、队列里在跑的 / 失败的、下完才复制的；开了复制的任务带 copyToOpenlist（卡住的带原因）", async () => {
  saveCopies([record({ id: "p1", status: "pending" }), record({ id: "f1", status: "failed", doneAt: Date.now() })]);
  writeKv(KEY.offlineFollowups, [
    followup({ infoHash: "c1", kind: "openlist-copy", copyDstDir: "/local/media" }),
    followup({ infoHash: "s1", taskId: "c-movies", copyDstDir: "/local/movies" }),
    followup({ infoHash: "s2", taskId: "c-tv" }),
  ]);
  const client = await connect(readToken);
  try {
    const overview = await call(client, "overview", {});
    assert.deepEqual(overview.data.openlistCopy, { configured: true, pending: 1, failed: 1, afterDownload: 2 });
    assert.equal(overview.data.offlinePendingStrm, 2, "只复制的回执不算生成 strm 的");
    assert.ok(overview.data.notes.some((n: string) => n.includes("copyToOpenlist")));

    const tasks = await call(client, "tasks_list", {});
    const byId = new Map(tasks.data.tasks.map((t: Record<string, any>) => [t.id, t]));
    assert.deepEqual((byId.get("c-movies") as Record<string, any>).copyToOpenlist, { dstDir: "/local/movies", afterCopy: "delete", afterCopyText: "删除", deleteSource: true });
    assert.equal((byId.get("c-tv") as Record<string, any>).copyToOpenlist, undefined, "没开复制的不带");

    patchAppSettings({ openlistCopy: { ...COPY_SETTINGS, mounts: {} } });
    const blocked = await call(client, "tasks_list", {});
    const m = blocked.data.tasks.find((t: { id: string }) => t.id === "c-movies");
    assert.match(m.copyToOpenlist.blocked, /挂载根/);
    const off = await call(client, "overview", {});
    assert.equal(off.data.openlistCopy.configured, false);
  } finally {
    await client.close();
  }
});
