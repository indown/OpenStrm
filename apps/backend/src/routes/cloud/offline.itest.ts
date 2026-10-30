/**
 * 云下载路由闭环：网络层换成桩，验证参数怎么落到 115 接口、结果怎么回、回执怎么登记。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/cloud/offline.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import offlineRoute from "./offline.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { Cloud115Error } from "../../services/cloud-115/client.js";
import { setOfflineTransport, type OfflineTransport } from "../../services/cloud-115/offline.js";
import {
  __test_resetOffline,
  listFollowups,
  setOfflineServiceDeps,
  stopOfflineWatcher,
} from "../../services/offline/service.js";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[] };

const accounts: AccountInfo[] = [
  { accountType: "115", name: "acc", cookie: "UID=1; CID=2" },
  { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://x" },
];
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "tv", strmPrefix: "/mnt" };

type Call = { kind: "web" | "ssp" | "downPath"; ac?: string; params?: Record<string, unknown>; method?: string };
const calls: Call[] = [];
/** 桩的行为按用例改：抛错、回什么列表 */
const behavior: { throwOnWeb?: Error; tasks?: Record<string, unknown>[] } = {};

const sampleTask = (over: Record<string, unknown>) => ({
  info_hash: "h", add_time: 1, percentDone: 100, size: 10, name: "n", file_id: "d", delete_file_id: "r",
  file_category: 1, move: 1, status: 2, status_text: "下载成功", url: "magnet:?xt=urn:btih:h", del_path: "n", wp_path_id: "d",
  ...over,
});

const transport: OfflineTransport = {
  async web(_acc, ac, params, method) {
    calls.push({ kind: "web", ac, params, method });
    if (behavior.throwOnWeb) throw behavior.throwOnWeb;
    if (ac === "task_lists") return { page: 1, page_count: 1, page_size: 30, count: 1, quota: 5, total: 10, tasks: behavior.tasks ?? [sampleTask({})] };
    if (ac === "get_quota_info") return { state: true, quota: 5, total: 10 };
    return { state: true };
  },
  async ssp(_acc, ac, payload) {
    calls.push({ kind: "ssp", ac, params: payload });
    const urls = Object.keys(payload).filter((k) => k.startsWith("url[")).map((k) => String(payload[k]));
    return {
      state: true,
      data: {
        state: true,
        result: urls.map((url, i) =>
          url.includes("dup")
            ? { state: false, errno: 10008, error_msg: "任务已存在", url }
            : { state: true, errno: 0, info_hash: `hash${i}`, name: `name${i}`, url },
        ),
      },
    };
  },
  async downPath() {
    calls.push({ kind: "downPath" });
    return { state: true, errno: null, data: [{ file_id: "123", file_name: "云下载", is_selected: "1" }, { file_id: "456", file_name: "assets", is_selected: "0" }] };
  },
};

const resolved: string[] = [];

before(async () => {
  baseline = { tasks: listTasks(), accounts: listAccounts() };
  replaceAccounts(accounts);
  replaceTasks([task]);
  await writeAuthPassword("offline-itest-pw");
  setOfflineTransport(transport);
  setOfflineServiceDeps({
    resolveDirId: async (_acc, path) => { resolved.push(path); return "999"; },
    generate: async () => ({ generatedCount: 1, skippedCount: 0, invalidNames: [] }),
    notify: async () => {},
  });

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(offlineRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

beforeEach(async () => {
  calls.length = 0;
  resolved.length = 0;
  delete behavior.throwOnWeb;
  delete behavior.tasks;
  await __test_resetOffline();
});

after(async () => {
  await app.close();
  await __test_resetOffline();
  setOfflineTransport(null);
  setOfflineServiceDeps(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  await writeAuthPassword(DEFAULT_AUTH.password);
});

const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth, payload: payload as Record<string, unknown> | undefined });

test("没有 token 一律 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/115/offline" });
  assert.equal(res.statusCode, 401);
});

test("GET /api/115/offline：默认取第一个 115 账号，任务归一化，带回执与循环状态", async () => {
  const res = await call("GET", "/api/115/offline?page=2");
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.account, "acc");
  assert.equal(body.quota, 5);
  assert.equal(body.tasks[0].state, "done");
  assert.equal(body.tasks[0].resultId, "r");
  assert.deepEqual(body.followups, []);
  assert.equal(body.watcher.running, false);
  const list = calls.find((c) => c.ac === "task_lists");
  assert.deepEqual(list?.params, { page: 2, page_size: 30 });
  assert.equal(list?.method, "GET");
});

test("账号选择：不存在 404，不是 115 账号 400，一个 115 账号都没有 400", async () => {
  assert.equal((await call("GET", "/api/115/offline?account=nope")).statusCode, 404);
  assert.equal((await call("GET", "/api/115/offline?account=ol")).statusCode, 400);
  replaceAccounts([accounts[1]]);
  try {
    const res = await call("GET", "/api/115/offline");
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /No 115 account/);
  } finally {
    replaceAccounts(accounts);
  }
});

test("POST /api/115/offline：任务目录模式——按 originPath/子目录解析目录 id，逐条结果，登记回执", async () => {
  const res = await call("POST", "/api/115/offline", {
    urls: "magnet:?xt=urn:btih:one\nmagnet:?xt=urn:btih:dup\nthunder://nope\nhttps://a/b.mkv",
    taskId: "t1",
    subPath: " Season 1 / ",
  });
  await stopOfflineWatcher();
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.deepEqual(resolved, ["tv/Season 1"]);
  assert.equal(body.account, "acc");
  assert.equal(body.dirId, "999");
  assert.equal(body.dirPath, "tv/Season 1");
  assert.equal(body.added, 2);
  assert.equal(body.failed, 1);
  assert.deepEqual(body.invalid, ["thunder://nope"]);
  assert.equal(body.followup, true);
  assert.equal(body.results[1].message, "任务已存在");

  const ssp = calls.find((c) => c.kind === "ssp");
  assert.equal(ssp?.ac, "add_task_urls");
  assert.equal(ssp?.params?.["url[0]"], "magnet:?xt=urn:btih:one");
  assert.equal(ssp?.params?.["url[2]"], "https://a/b.mkv");
  assert.equal(ssp?.params?.wp_path_id, "999");

  const followups = listFollowups();
  assert.equal(followups.length, 2, "只有成功的两条登记回执");
  for (const f of followups) {
    assert.equal(f.status, "pending");
    assert.equal(f.taskId, "t1");
    assert.equal(f.account, "acc");
    assert.equal(f.subPath, "Season 1");
  }
  assert.deepEqual(followups.map((f) => f.infoHash).sort(), ["hash0", "hash2"]);

  // 列表接口把回执一并带回
  const list = await call("GET", "/api/115/offline");
  assert.equal(list.json().followups.length, 2);
});

test("POST /api/115/offline：网盘目录模式——wp_path_id 用给的 id，不登记回执；不给目录就不传 wp_path_id", async () => {
  const res = await call("POST", "/api/115/offline", { urls: ["magnet:?xt=urn:btih:one"], dirId: "123" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().followup, false);
  assert.equal(calls.find((c) => c.kind === "ssp")?.params?.wp_path_id, "123");
  assert.equal(listFollowups().length, 0);

  calls.length = 0;
  const root = await call("POST", "/api/115/offline", { urls: ["magnet:?xt=urn:btih:two"], dirId: 0 });
  assert.equal(root.statusCode, 200);
  assert.equal(calls.find((c) => c.kind === "ssp")?.params?.wp_path_id, "0", "0 是根目录，得原样传");

  calls.length = 0;
  const dflt = await call("POST", "/api/115/offline", { urls: ["magnet:?xt=urn:btih:three"] });
  assert.equal(dflt.statusCode, 200);
  assert.equal("wp_path_id" in (calls.find((c) => c.kind === "ssp")?.params ?? {}), false);
});

test("POST /api/115/offline：generateStrm=false 时任务目录模式也不登记回执；任务不存在 404", async () => {
  const res = await call("POST", "/api/115/offline", { urls: "magnet:?xt=urn:btih:one", taskId: "t1", generateStrm: false });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().followup, false);
  assert.equal(listFollowups().length, 0);
  assert.equal((await call("POST", "/api/115/offline", { urls: "magnet:?xt=urn:btih:one", taskId: "nope" })).statusCode, 404);
});

test("POST /api/115/offline：没有可提交的链接 400，缺 urls 400 VALIDATION", async () => {
  const res = await call("POST", "/api/115/offline", { urls: "thunder://a\n\n" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /thunder:\/\/a/);
  assert.deepEqual(res.json().invalid, ["thunder://a"]);
  assert.equal(calls.length, 0, "没提交给 115");
  const bad = await call("POST", "/api/115/offline", {});
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, "VALIDATION");
});

test("POST /api/115/offline/delete：hash[i] + flag，顺带清掉这些任务的回执", async () => {
  await call("POST", "/api/115/offline", { urls: "magnet:?xt=urn:btih:one\nmagnet:?xt=urn:btih:two", taskId: "t1" });
  await stopOfflineWatcher();
  assert.equal(listFollowups().length, 2);
  calls.length = 0;

  const res = await call("POST", "/api/115/offline/delete", { infoHashes: ["hash0"], deleteFiles: true });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { success: true, account: "acc", removed: 1, followupsDropped: 1 });
  const del = calls.find((c) => c.ac === "task_del");
  assert.equal(del?.method, "POST");
  assert.deepEqual(del?.params, { flag: 1, "hash[0]": "hash0" });
  assert.deepEqual(listFollowups().map((f) => f.infoHash), ["hash1"]);

  calls.length = 0;
  await call("POST", "/api/115/offline/delete", { infoHashes: ["a", "b"] });
  assert.deepEqual(calls.find((c) => c.ac === "task_del")?.params, { flag: 0, "hash[0]": "a", "hash[1]": "b" });
  assert.equal((await call("POST", "/api/115/offline/delete", { infoHashes: [] })).statusCode, 400);
});

test("POST /api/115/offline/clear：flag 透传，越界 400", async () => {
  const res = await call("POST", "/api/115/offline/clear", { flag: 2 });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(calls.find((c) => c.ac === "task_clear")?.params, { flag: 2 });
  assert.equal((await call("POST", "/api/115/offline/clear", { flag: 9 })).statusCode, 400);
});

test("POST /api/115/offline/restart：info_hash 透传，作废的回执重新变回待办", async () => {
  await call("POST", "/api/115/offline", { urls: "magnet:?xt=urn:btih:one", taskId: "t1" });
  await stopOfflineWatcher();
  // 让 115 把它报成失败，跑一轮回执把它作废
  behavior.tasks = [sampleTask({ info_hash: "hash0", status: -1, status_text: "资源违规" })];
  const { tickFollowups } = await import("../../services/offline/service.js");
  await tickFollowups();
  assert.equal(listFollowups()[0].status, "failed");
  assert.match(listFollowups()[0].detail, /资源违规/);

  calls.length = 0;
  const res = await call("POST", "/api/115/offline/restart", { infoHash: "hash0" });
  await stopOfflineWatcher();
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(calls.find((c) => c.ac === "restart")?.params, { info_hash: "hash0" });
  assert.equal(listFollowups()[0].status, "pending");
  assert.equal(listFollowups()[0].attempts, 0);
});

test("GET /api/115/offline/downpath：默认目录列表", async () => {
  const res = await call("GET", "/api/115/offline/downpath");
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), {
    dirs: [
      { id: "123", name: "云下载", selected: true },
      { id: "456", name: "assets", selected: false },
    ],
  });
});

// 不回 502：Cloudflare 会把源站的 502 / 504 换成它自己的错误页，原话就丢了（lib/http-error.ts）
test("115 出错要说出来：405 风控 → 500 + upstreamStatus；普通错误 → 500 原话；state=false → 500 带 115 的说法", async () => {
  behavior.throwOnWeb = new Cloud115Error(405, { state: false, error: "您的访问被阻断" }, "https://lixian.115.com/web/lixian/");
  const blocked = await call("GET", "/api/115/offline");
  assert.equal(blocked.statusCode, 500);
  assert.equal(blocked.json().upstreamStatus, 405);
  assert.match(blocked.json().message, /访问被阻断/);

  behavior.throwOnWeb = new Error("socket hang up");
  const net = await call("POST", "/api/115/offline/clear", { flag: 0 });
  assert.equal(net.statusCode, 500);
  assert.equal(net.json().message, "socket hang up");

  delete behavior.throwOnWeb;
  const orig = transport.web;
  transport.web = async () => ({ state: false, errno: 99, error: "请先登录" });
  try {
    const res = await call("GET", "/api/115/offline");
    assert.equal(res.statusCode, 500);
    assert.match(res.json().message, /请先登录/);
  } finally {
    transport.web = orig;
  }
});
