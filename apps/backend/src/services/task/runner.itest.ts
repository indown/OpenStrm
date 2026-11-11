/**
 * 用本地 openlist 桩把 startTask 整条跑通：拉目录树、建 strm、下载附件、写执行历史；
 * 第二次跑没有变化就是 "no files to download"；并发启动同一任务只能进去一个
 * （以前 running 表在拉完目录树之后才登记，这几百毫秒到几分钟的窗口挡不住第二次）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/task/runner.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { deleteAccount, insertAccount, listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { deleteTask, insertTask, updateTask } from "../../db/repositories/tasks.js";
import { deleteTaskExecution, getTaskExecution, getTaskHistory } from "../task-history.js";
import { resetThrottle } from "../throttle.js";
import { FakeCd2 } from "../../test/fake-cd2.js";
import { __test_resetCd2Tokens } from "../cd2/client.js";
import { clearQuarkCaches, QUARK_UA, setQuarkApiBase } from "../quark/client.js";
import { cancelRunningTask, isTaskRunning, waitForTaskStart } from "./registry.js";
import { startTask } from "./runner.js";

const TASK = "runner-itest";
const ORIGIN = "/media/Show";
/** 单文件失败的用例用另一棵树：一个 nfo 的直链 404 */
const ORIGIN_PARTIAL = "/media/Partial";
/** 文件名过长：一段 252 字节的名字加 .strm 就超过 255 */
const ORIGIN_LONG = "/media/Long";
const LONG_NAME = `${"字".repeat(84)}.mkv`;
/** 没权限：目标目录只读 */
const ORIGIN_PERM = "/media/Perm";
/** 没权限但只有一个文件：流比整轮停先结束，结论仍按整轮停记 */
const ORIGIN_PERM1 = "/media/Perm1";
let listDelayMs = 0;
let listCalls = 0;
let holdRaw = false;
let emptyRemote = false;
let rawRequests = 0;
const held = new Set<http.ServerResponse>();

// ---- 假 openlist ----
const tree: Record<string, Array<{ name: string; is_dir: boolean }>> = {
  [ORIGIN]: [{ name: "S1", is_dir: true }],
  [`${ORIGIN}/S1`]: [
    { name: "ep1.mkv", is_dir: false },
    { name: "ep1.nfo", is_dir: false },
  ],
  [ORIGIN_PARTIAL]: [
    { name: "ep1.mkv", is_dir: false },
    { name: "ep1.nfo", is_dir: false },
    { name: "missing.nfo", is_dir: false },
  ],
  [ORIGIN_LONG]: [
    { name: "ep1.mkv", is_dir: false },
    { name: LONG_NAME, is_dir: false },
  ],
  [ORIGIN_PERM]: [
    { name: "ep1.mkv", is_dir: false },
    { name: "ep2.mkv", is_dir: false },
    { name: "ep3.mkv", is_dir: false },
  ],
  [ORIGIN_PERM1]: [{ name: "ep1.mkv", is_dir: false }],
};
const server = http.createServer((req, res) => {
  const json = (body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === "/api/auth/login") return json({ code: 200, data: { token: "tok" } });
    if (req.url === "/api/fs/list") {
      listCalls++;
      const content = emptyRemote ? [] : (tree[body.path as string] ?? []);
      setTimeout(() => json({ code: 200, data: { content } }), listDelayMs);
      return;
    }
    if (req.url === "/api/fs/get") return json({ code: 200, data: { raw_url: `${base}/raw${body.path}` } });
    if (req.url?.startsWith("/raw/")) {
      rawRequests++;
      if (req.url.endsWith("/missing.nfo")) {
        res.writeHead(404);
        return res.end("gone");
      }
      if (holdRaw) {
        // 发一点就挂住，模拟正在进行的大文件下载
        res.writeHead(200, { "content-type": "text/plain", "content-length": "1000" });
        res.write("partial");
        held.add(res);
        res.on("close", () => held.delete(res));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`content of ${req.url}`);
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// ---- 假夸克 ----
const quarkTree: Record<string, Array<{ fid: string; file_name: string; file: boolean }>> = {
  "0": [{ fid: "q-media", file_name: "media", file: false }],
  "q-media": [{ fid: "q-show", file_name: "Show", file: false }],
  "q-show": [{ fid: "q-s1", file_name: "S1", file: false }],
  "q-s1": [
    { fid: "q-ep1", file_name: "ep1.mkv", file: true },
    { fid: "q-nfo", file_name: "ep1.nfo", file: true },
  ],
};
const QUARK_COOKIE = "kps=1; __puus=abc";
const quarkServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (url.pathname === "/file/sort") {
      const list = quarkTree[url.searchParams.get("pdir_fid") ?? ""] ?? [];
      return json(200, { status: 200, code: 0, data: { list }, metadata: { _total: list.length } });
    }
    if (url.pathname === "/file/info/path_list") {
      // 这个假网盘不认路径：回空，客户端退回逐段列目录
      return json(200, { status: 200, code: 0, data: [] });
    }
    if (url.pathname === "/file/download") {
      const { fids } = JSON.parse(raw) as { fids: string[] };
      return json(200, { status: 200, code: 0, data: fids.map((fid) => ({ fid, download_url: `${quarkBase}/dl/${fid}` })) });
    }
    if (url.pathname.startsWith("/dl/")) {
      // 夸克的直链没有 cookie / Referer / 取链时的 UA 就取不到；这里照样把关，证明头真的传到了下载那一步
      const ok =
        req.headers.cookie === QUARK_COOKIE &&
        req.headers.referer === "https://pan.quark.cn" &&
        req.headers["user-agent"] === QUARK_UA;
      if (!ok) {
        res.writeHead(403);
        return res.end("forbidden");
      }
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`content of ${url.pathname.slice(4)}`);
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise<void>((r) => quarkServer.listen(0, "127.0.0.1", r));
const quarkBase = `http://127.0.0.1:${(quarkServer.address() as { port: number }).port}`;

// ---- 假 Emby：只记刷新请求 ----
const embyRefreshes: string[] = [];
const embyServer = http.createServer((req, res) => {
  embyRefreshes.push(`${req.method} ${req.url}`);
  res.writeHead(204);
  res.end();
});
await new Promise<void>((r) => embyServer.listen(0, "127.0.0.1", r));
const embyBase = `http://127.0.0.1:${(embyServer.address() as { port: number }).port}`;

const baseline = { settings: readAppSettings(), accounts: listAccounts() };
const outDir = path.join(process.env.DATA_DIR!, TASK);

async function waitFor(cond: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

before(() => {
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"], downloadExtensions: [".nfo"] });
  replaceAccounts([
    { accountType: "openlist", name: "ol", account: "u", password: "p", url: base },
    { accountType: "quark", name: "qk", cookie: QUARK_COOKIE },
  ]);
  setQuarkApiBase(quarkBase);
  insertTask({
    id: TASK,
    account: "ol",
    accountType: "openlist",
    originPath: ORIGIN,
    targetPath: `${TASK}/out`,
    strmPrefix: "http://strm.local",
  });
});

after(async () => {
  await waitFor(() => !isTaskRunning(TASK), "任务结束", 5000).catch(() => {});
  deleteTask(TASK);
  for (const h of getTaskHistory(TASK)) deleteTaskExecution(h.id);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(outDir, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  setQuarkApiBase(null);
  clearQuarkCaches();
  quarkServer.closeAllConnections();
  await new Promise<void>((r) => quarkServer.close(() => r()));
  embyServer.closeAllConnections();
  await new Promise<void>((r) => embyServer.close(() => r()));
});

test("整条跑通：strm 落盘、附件下载、历史记完成", async () => {
  const res = await startTask(TASK);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.message, "2 files to download");
  await waitFor(() => !isTaskRunning(TASK), "任务结束");

  const strm = fs.readFileSync(path.join(outDir, "out/S1/ep1.strm"), "utf8");
  assert.ok(strm.startsWith("http://strm.local"), strm);
  assert.ok(strm.endsWith(`${ORIGIN}/S1/ep1.mkv`), strm);
  assert.equal(fs.readFileSync(path.join(outDir, "out/S1/ep1.nfo"), "utf8"), `content of /raw${ORIGIN}/S1/ep1.nfo`);

  await waitFor(() => getTaskHistory(TASK)[0]?.status === "completed", "历史标完成");
  const [h] = getTaskHistory(TASK);
  assert.equal(h.summary.totalFiles, 2);
  assert.equal(h.summary.downloadedFiles, 2);
});

test("再跑一次没有变化：no files to download，不新建执行记录", async () => {
  const before = getTaskHistory(TASK).length;
  const res = await startTask(TASK);
  assert.equal(res.status, 200);
  assert.equal(res.body.message, "no files to download");
  assert.equal(getTaskHistory(TASK).length, before);
});

test("并发启动同一任务：拉目录树期间第二次进来必须 409", async () => {
  fs.rmSync(outDir, { recursive: true, force: true }); // 让它有活干，否则跑不出 running 状态
  listDelayMs = 300;
  listCalls = 0;
  try {
    const [a, b] = await Promise.all([startTask(TASK), startTask(TASK)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], `两次结果：${JSON.stringify([a, b])}`);
    assert.equal(listCalls, 2, "只应拉一次目录树（两级目录各一次），第二次启动在拉之前就被挡下");
  } finally {
    listDelayMs = 0;
  }
  await waitFor(() => !isTaskRunning(TASK), "任务结束");
  assert.equal(getTaskHistory(TASK).filter((h) => h.status === "completed").length, 2);
});

test("removeExtraFiles：本地多出来的文件和空目录被删掉，远端仍有的不动；暂存区（归档 / 重复文件）里的本地文件不算多余", async () => {
  updateTask(TASK, { removeExtraFiles: true });
  fs.writeFileSync(path.join(outDir, "out/S1/stray.strm"), "x");
  fs.mkdirSync(path.join(outDir, "out/Empty/Deeper"), { recursive: true });
  // 升级前就叫「归档」的目录：远端那边不再列它，本地这边也不能因此把里面的 strm 当多余删掉
  fs.mkdirSync(path.join(outDir, "out/归档/老剧"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "out/归档/老剧/E01.strm"), "x");
  try {
    const res = await startTask(TASK);
    assert.equal(res.status, 200);
    assert.equal(res.body.message, "no files to download", "远端没新文件，只做清理");
    assert.equal(fs.existsSync(path.join(outDir, "out/S1/stray.strm")), false);
    assert.equal(fs.existsSync(path.join(outDir, "out/Empty")), false, "顶层空目录整个删掉");
    assert.ok(fs.existsSync(path.join(outDir, "out/S1/ep1.strm")), "远端仍有的不能被删");
    assert.ok(fs.existsSync(path.join(outDir, "out/S1/ep1.nfo")));
    assert.ok(fs.existsSync(path.join(outDir, "out/归档/老剧/E01.strm")), "暂存区里的留着");
  } finally {
    fs.rmSync(path.join(outDir, "out/归档"), { recursive: true, force: true });
    updateTask(TASK, { removeExtraFiles: false });
  }
});

test("只清理了本地多余文件、没有要下载的：也通知媒体库刷新；整轮停在第一个文件时清理过的也要刷新", async () => {
  updateTask(TASK, { removeExtraFiles: true });
  replaceAppSettings({ ...readAppSettings(), emby: { ...readAppSettings().emby, url: embyBase, apiKey: "k" } });
  fs.writeFileSync(path.join(outDir, "out/S1/stray.strm"), "x");
  embyRefreshes.length = 0;
  try {
    const res = await startTask(TASK);
    assert.equal(res.body.message, "no files to download");
    await waitFor(() => embyRefreshes.length > 0, "刷新请求到了", 5000);
    assert.match(embyRefreshes[0], /Library\/Refresh/);
  } finally {
    updateTask(TASK, { removeExtraFiles: false });
  }
  // 长名那份写不进去、正常那份也没有（已经在），只有清理：完成数 0、有失败，仍要刷新
  const id = `${TASK}-long-refresh`;
  insertTask({ id, account: "ol", accountType: "openlist", originPath: ORIGIN_LONG, targetPath: `${TASK}/longr`, strmPrefix: "http://strm.local", removeExtraFiles: true });
  const dir = path.join(process.env.DATA_DIR!, TASK, "longr");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ep1.strm"), "http://strm.local/media/Long/ep1.mkv");
  fs.writeFileSync(path.join(dir, "stray.strm"), "x");
  embyRefreshes.length = 0;
  try {
    const res = await startTask(id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await waitFor(() => !isTaskRunning(id), "任务结束");
    await waitFor(() => getTaskHistory(id)[0]?.status !== "running", "历史收尾");
    const [h] = getTaskHistory(id);
    assert.equal(h.summary.downloadedFiles, 0);
    assert.equal(h.summary.deletedFiles, 1);
    assert.equal(h.summary.failedFiles, 1);
    await waitFor(() => embyRefreshes.length > 0, "清理过就要刷新", 5000);
  } finally {
    replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"], downloadExtensions: [".nfo"] });
    for (const x of getTaskHistory(id)) deleteTaskExecution(x.id);
    deleteTask(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeExtraFiles：远端目录为空时拒绝清理本地（多半是导出失败），并在响应里说明", async () => {
  updateTask(TASK, { removeExtraFiles: true });
  emptyRemote = true;
  try {
    const res = await startTask(TASK);
    assert.equal(res.status, 200);
    assert.equal(res.body.message, "no files to download");
    assert.match(String(res.body.warning), /远端目录为空.*已跳过清理/);
    assert.ok(fs.existsSync(path.join(outDir, "out/S1/ep1.strm")), "本地库不能被清空");
    assert.ok(fs.existsSync(path.join(outDir, "out/S1/ep1.nfo")));
  } finally {
    emptyRemote = false;
    updateTask(TASK, { removeExtraFiles: false });
  }
});

test("取消：进行中的下载被中止且不留半截文件，排队的不再发请求，历史标 cancelled", async () => {
  fs.rmSync(outDir, { recursive: true, force: true });
  tree[`${ORIGIN}/S1`].push({ name: "ep2.nfo", is_dir: false }, { name: "ep3.nfo", is_dir: false });
  // 下载并发 1：一个挂在半路，另外两个排在限流器队列里
  replaceAppSettings({
    ...readAppSettings(),
    throttle: { requestsPerSecond: 10, requestConcurrency: 2, downloadConcurrency: 1 },
  });
  resetThrottle();
  holdRaw = true;
  rawRequests = 0;
  try {
    const res = await startTask(TASK);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await waitFor(() => rawRequests === 1 && held.size === 1, "第一个下载挂上");

    assert.equal(cancelRunningTask(TASK, "测试取消"), true);
    assert.equal(isTaskRunning(TASK), false);
    await waitFor(() => held.size === 0, "服务端看到下载连接被掐断");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rawRequests, 1, "排队的两个不该再发请求");

    const left = fs.readdirSync(path.join(outDir, "out/S1"));
    assert.ok(!left.some((n) => n.endsWith(".part")), `半截文件要删掉，实际剩下 ${left.join(",")}`);
    assert.ok(!left.some((n) => n.endsWith(".nfo")), `没下完的不能顶着正式文件名，实际剩下 ${left.join(",")}`);

    const [h] = getTaskHistory(TASK);
    assert.equal(h.status, "cancelled");
    assert.equal(h.summary.errorMessage, "测试取消");
    assert.equal(cancelRunningTask(TASK), false, "已经取消的再取消返回 false");
  } finally {
    holdRaw = false;
    for (const r of held) r.destroy();
    tree[`${ORIGIN}/S1`].length = 2;
    replaceAppSettings({ ...readAppSettings(), throttle: baseline.settings.throttle });
    resetThrottle();
  }
});

test("起不来也进历史：账号不存在 → 500，历史里有一条 failed 并写明原因", async () => {
  const id = `${TASK}-noacc`;
  insertTask({ id, account: "ghost", accountType: "openlist", originPath: ORIGIN, targetPath: `${TASK}/noacc`, strmPrefix: "x" });
  try {
    const pending = startTask(id);
    // 启动期间就连上日志流的人（SSE 路由）靠这个知道任务最后是起来了还是没起来
    const outcome = waitForTaskStart(id);
    const res = await pending;
    assert.equal(res.status, 500);
    assert.deepEqual(await outcome, { status: 500, message: "账号不存在：ghost" });
    const [h] = getTaskHistory(id);
    assert.ok(h, "启动阶段失败也要留一条执行记录");
    assert.equal(h.status, "failed");
    assert.match(h.summary.errorMessage ?? "", /账号不存在：ghost/);
    assert.ok(h.endTime, "记录应已结束，不能挂着 running");
    assert.equal(isTaskRunning(id), false);
  } finally {
    for (const h of getTaskHistory(id)) deleteTaskExecution(h.id);
    deleteTask(id);
  }
});

test("单个文件下载失败不拖死任务：其余照常完成，历史记 failed 并写明是哪个文件", async () => {
  const id = `${TASK}-partial`;
  insertTask({ id, account: "ol", accountType: "openlist", originPath: ORIGIN_PARTIAL, targetPath: `${TASK}/partial`, strmPrefix: "http://strm.local" });
  const dir = path.join(process.env.DATA_DIR!, TASK, "partial");
  const rawBefore = rawRequests;
  try {
    const res = await startTask(id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.message, "3 files to download");
    await waitFor(() => !isTaskRunning(id), "任务结束");
    assert.ok(fs.existsSync(path.join(dir, "ep1.strm")), "strm 照常生成");
    assert.equal(fs.readFileSync(path.join(dir, "ep1.nfo"), "utf8"), `content of /raw${ORIGIN_PARTIAL}/ep1.nfo`, "其它下载照常完成");
    assert.ok(!fs.existsSync(path.join(dir, "missing.nfo")) && !fs.existsSync(path.join(dir, "missing.nfo.part")), "失败的文件不留半截");

    await waitFor(() => getTaskHistory(id)[0]?.status !== "running", "历史收尾");
    const [h] = getTaskHistory(id);
    assert.equal(h.status, "failed");
    assert.equal(h.summary.totalFiles, 3);
    assert.equal(h.summary.downloadedFiles, 2, "完成数记真实值，不再是 0");
    assert.equal(h.summary.failedFiles, 1);
    assert.equal(h.summary.errorMessage, "1 个文件失败：网盘上已没有 1", "摘要按类别");
    assert.deepEqual(h.summary.failures, { gone: 1 });
    assert.match(h.summary.advice ?? "", /不用处理/);
    assert.equal(h.summary.stopped, undefined, "单个文件没了不停整轮");

    // 历史里的事件行：开始事件、带文件名的失败事件、带结论的结束事件
    const lines = getTaskExecution(h.id)!.logs.map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.start === true && l.total === 3 && l.strmTotal === 1 && l.downloadTotal === 2), "第一行是开始事件");
    const failLine = lines.find((l) => l.filePath === "missing.nfo" && typeof l.error === "string");
    assert.ok(failLine && failLine.kind === "download", "失败事件带文件名");
    assert.equal(failLine.reason, "gone");
    assert.equal(failLine.message, "网盘上已经没有这个文件");
    assert.match(failLine.advice, /不用处理/);
    assert.equal(rawRequests, rawBefore + 2, "404 不重试：ep1.nfo 一次、missing.nfo 一次");
    const done = lines.find((l) => l.done === true);
    assert.equal(done?.status, "failed");
    assert.equal(done?.finished, 2);
    assert.equal(done?.failed, 1);
  } finally {
    for (const h of getTaskHistory(id)) deleteTaskExecution(h.id);
    deleteTask(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("文件名过长：事前预判，不碰文件系统，历史和事件里带分类、说明和「去整理」", async () => {
  const id = `${TASK}-long`;
  insertTask({ id, account: "ol", accountType: "openlist", originPath: ORIGIN_LONG, targetPath: `${TASK}/long`, strmPrefix: "http://strm.local" });
  const dir = path.join(process.env.DATA_DIR!, TASK, "long");
  try {
    const res = await startTask(id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.message, "2 files to download");
    await waitFor(() => !isTaskRunning(id), "任务结束");
    assert.ok(fs.existsSync(path.join(dir, "ep1.strm")), "正常的照常生成");
    assert.deepEqual(fs.readdirSync(dir), ["ep1.strm"], "过长的没去碰文件系统");
    await waitFor(() => getTaskHistory(id)[0]?.status !== "running", "历史收尾");
    const [h] = getTaskHistory(id);
    assert.equal(h.status, "failed");
    assert.equal(h.summary.downloadedFiles, 1);
    assert.equal(h.summary.failedFiles, 1);
    assert.equal(h.summary.errorMessage, "1 个文件失败：文件名过长 1");
    assert.deepEqual(h.summary.failures, { "name-too-long": 1 });
    assert.match(h.summary.advice ?? "", /整理/);
    const lines = getTaskExecution(h.id)!.logs.map((l) => JSON.parse(l));
    const fail = lines.find((l) => l.filePath === LONG_NAME && typeof l.error === "string");
    assert.equal(fail?.reason, "name-too-long");
    assert.equal(fail?.attempted, false, "标明没尝试");
    assert.deepEqual(fail?.action, { type: "organize", subPath: "" });
    assert.match(fail?.message ?? "", /255 字节/);
  } finally {
    for (const h of getTaskHistory(id)) deleteTaskExecution(h.id);
    deleteTask(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("目标目录只读：第一个文件没权限就整轮停，剩下的算未尝试，历史写明原因和建议", { skip: process.getuid?.() === 0 ? "root 不受权限限制" : false }, async () => {
  const id = `${TASK}-perm`;
  insertTask({ id, account: "ol", accountType: "openlist", originPath: ORIGIN_PERM, targetPath: `${TASK}/perm`, strmPrefix: "http://strm.local" });
  const dir = path.join(process.env.DATA_DIR!, TASK, "perm");
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o555);
  try {
    const res = await startTask(id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await waitFor(() => !isTaskRunning(id), "任务结束");
    await waitFor(() => getTaskHistory(id)[0]?.status !== "running", "历史收尾");
    const [h] = getTaskHistory(id);
    assert.equal(h.status, "failed");
    assert.equal(h.summary.stopped?.reason, "permission");
    assert.match(h.summary.stopped?.advice ?? "", /PUID/);
    assert.equal((h.summary.failedFiles ?? 0) + (h.summary.stopped?.remaining ?? 0), 3, "失败的加没轮到的就是全部");
    assert.match(h.summary.errorMessage ?? "", /^没有写入 data 目录的权限；/);
    assert.ok((h.summary.failures?.permission ?? 0) >= 1);
    const done = getTaskExecution(h.id)!.logs.map((l) => JSON.parse(l)).find((l) => l.done === true);
    assert.equal(done?.stopped?.reason, "permission");
  } finally {
    fs.chmodSync(dir, 0o755);
    for (const h of getTaskHistory(id)) deleteTaskExecution(h.id);
    deleteTask(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("只读目录里只有一个文件：流先结束也按整轮停记，摘要是原因加建议", { skip: process.getuid?.() === 0 ? "root 不受权限限制" : false }, async () => {
  const id = `${TASK}-perm1`;
  insertTask({ id, account: "ol", accountType: "openlist", originPath: ORIGIN_PERM1, targetPath: `${TASK}/perm1`, strmPrefix: "http://strm.local" });
  const dir = path.join(process.env.DATA_DIR!, TASK, "perm1");
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o555);
  try {
    const res = await startTask(id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await waitFor(() => !isTaskRunning(id), "任务结束");
    await waitFor(() => getTaskHistory(id)[0]?.status !== "running", "历史收尾");
    const [h] = getTaskHistory(id);
    assert.equal(h.status, "failed");
    assert.equal(h.summary.stopped?.reason, "permission");
    assert.equal(h.summary.stopped?.remaining, 0);
    assert.match(h.summary.errorMessage ?? "", /^没有写入 data 目录的权限；/, "不是「1 个文件失败：没有写入权限 1」");
    assert.match(h.summary.advice ?? "", /PUID/);
  } finally {
    fs.chmodSync(dir, 0o755);
    for (const h of getTaskHistory(id)) deleteTaskExecution(h.id);
    deleteTask(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("不存在的任务 404", async () => {
  assert.equal((await startTask("nope")).status, 404);
});

test("夸克账号整条跑通：逐层列目录建树、strm 落盘、附件带 cookie 下载、历史记完成", async () => {
  const id = `${TASK}-quark`;
  insertTask({ id, account: "qk", accountType: "quark", originPath: ORIGIN, targetPath: `${TASK}/quark`, strmPrefix: "http://strm.local" });
  const dir = path.join(process.env.DATA_DIR!, TASK, "quark");
  try {
    const res = await startTask(id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.message, "2 files to download");
    await waitFor(() => !isTaskRunning(id), "任务结束");

    const strm = fs.readFileSync(path.join(dir, "S1/ep1.strm"), "utf8");
    assert.ok(strm.startsWith("http://strm.local"), strm);
    assert.ok(strm.endsWith(`${ORIGIN}/S1/ep1.mkv`), strm);
    assert.equal(fs.readFileSync(path.join(dir, "S1/ep1.nfo"), "utf8"), "content of q-nfo");

    await waitFor(() => getTaskHistory(id)[0]?.status !== "running", "历史收尾");
    const [h] = getTaskHistory(id);
    assert.equal(h.status, "completed", h.summary.errorMessage);
    assert.equal(h.summary.downloadedFiles, 2);

    const again = await startTask(id);
    assert.equal(again.body.message, "no files to download");
  } finally {
    for (const h of getTaskHistory(id)) deleteTaskExecution(h.id);
    deleteTask(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("源目录在网盘上不存在：500 中止，本地文件一个不动，历史记 failed 并说明原因", async () => {
  const id = `${TASK}-quark-missing`;
  insertTask({ id, account: "qk", accountType: "quark", originPath: "/media/Renamed", targetPath: `${TASK}/quark-missing`, strmPrefix: "http://strm.local" });
  const dir = path.join(process.env.DATA_DIR!, TASK, "quark-missing");
  fs.mkdirSync(path.join(dir, "S1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "S1", "keep.strm"), "http://strm.local/media/Renamed/S1/keep.mkv");
  try {
    const res = await startTask(id);
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.message, "远端目录树里找不到源目录");
    assert.match(String(res.body.details), /已中止，避免把本地文件当多余删掉/);
    assert.ok(fs.existsSync(path.join(dir, "S1", "keep.strm")), "本地文件不能动");
    await waitFor(() => getTaskHistory(id).length > 0, "历史里有失败记录");
    const [h] = getTaskHistory(id);
    assert.equal(h.status, "failed");
    assert.match(String(h.summary.errorMessage), /找不到源目录/);
  } finally {
    for (const h of getTaskHistory(id)) deleteTaskExecution(h.id);
    deleteTask(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CloudDrive2 账号整条跑通：逐层强制刷新列目录、strm 内容是前缀 + CD2 里的路径；源目录不在照样中止", async () => {
  const fake = new FakeCd2();
  await fake.start();
  __test_resetCd2Tokens();
  fake.tree = { "/": ["115open/"], "/115open": ["media/"], "/115open/media": ["Show/"], "/115open/media/Show": ["S1/"], "/115open/media/Show/S1": ["ep1.mkv", "ep2.mkv"] };
  insertAccount({ accountType: "cd2", name: "nas-cd2", url: fake.url, apiToken: "api-token" });
  const id = `${TASK}-cd2`;
  // originPath 存的是不带前导斜杠的（任务保存时归一过）
  insertTask({ id, account: "nas-cd2", accountType: "cd2", originPath: "115open/media/Show", targetPath: `${TASK}/cd2`, strmPrefix: "/mnt/CloudNAS" });
  const dir = path.join(process.env.DATA_DIR!, TASK, "cd2");
  try {
    const res = await startTask(id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.message, "2 files to download");
    await waitFor(() => !isTaskRunning(id), "任务结束");
    assert.equal(fs.readFileSync(path.join(dir, "S1/ep1.strm"), "utf8"), "/mnt/CloudNAS/115open/media/Show/S1/ep1.mkv");
    assert.equal(fs.readFileSync(path.join(dir, "S1/ep2.strm"), "utf8"), "/mnt/CloudNAS/115open/media/Show/S1/ep2.mkv");
    const listed = fake.calls.filter((c) => c.method === "GetSubFiles");
    assert.deepEqual(listed.map((c) => [c.path, c.forceRefresh]), [["/115open/media/Show", true], ["/115open/media/Show/S1", true]], "同步要看最新的：每一层都让 CD2 绕过目录缓存");
    await waitFor(() => getTaskHistory(id)[0]?.status !== "running", "历史收尾");
    assert.equal(getTaskHistory(id)[0]?.status, "completed", getTaskHistory(id)[0]?.summary.errorMessage);
    assert.equal((await startTask(id)).body.message, "no files to download");

    // 源目录在 CD2 里没了（云盘被摘掉、目录改名）：中止，不把本地的当多余删掉
    delete fake.tree["/115open/media/Show"];
    fake.tree["/115open/media"] = [];
    const gone = await startTask(id);
    assert.equal(gone.status, 500, JSON.stringify(gone.body));
    assert.equal(gone.body.message, "远端目录树里找不到源目录");
    assert.ok(fs.existsSync(path.join(dir, "S1/ep1.strm")), "本地文件不能动");
  } finally {
    await waitFor(() => !isTaskRunning(id), "任务结束", 5000).catch(() => {});
    for (const h of getTaskHistory(id)) deleteTaskExecution(h.id);
    deleteTask(id);
    deleteAccount("nas-cd2");
    fs.rmSync(dir, { recursive: true, force: true });
    await fake.stop();
  }
});
