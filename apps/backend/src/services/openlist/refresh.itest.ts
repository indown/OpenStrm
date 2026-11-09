/**
 * 让 OpenList 刷新目录缓存的调度：攒批、浅先、没配不动、object not found / storage not found 不拦后面的、files.landed 订阅、
 * 上一批还在跑时登记的接着刷、批次中途换依赖不落到真 OpenList。列目录是桩，配置走真的设置和账号表。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/openlist/refresh.itest.ts
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { events } from "../events.js";
import { OpenlistError } from "./client.js";
import { flushOpenlistRefresh, scheduleOpenlistRefresh, setOpenlistRefreshDeps, startOpenlistRefresh, stopOpenlistRefresh } from "./refresh.js";

const olAccount: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
const drive: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "refresh-itest/tv", strmPrefix: "/mnt" };
const configured: AppSettings["openlistCopy"] = { account: "ol", dstDir: "/local", mounts: { acc: "/115" } };

let baseline: { accounts: AccountInfo[]; openlistCopy: AppSettings["openlistCopy"] };
let listed: string[] = [];
let failWith: Record<string, Error> = {};
/** 某个目录列到一半先卡住（模拟上一批还在跑） */
let gate: { dir: string; wait: Promise<void> } | null = null;

const fakeListDir = async (_acc: unknown, dir: string): Promise<unknown[]> => {
  listed.push(dir);
  if (gate && gate.dir === dir) await gate.wait;
  const err = failWith[dir];
  if (err) throw err;
  return [];
};

before(() => {
  baseline = { accounts: listAccounts(), openlistCopy: readAppSettings().openlistCopy };
  replaceAccounts([drive, olAccount]);
});

beforeEach(() => {
  listed = [];
  failWith = {};
  gate = null;
  patchAppSettings({ openlistCopy: configured });
  setOpenlistRefreshDeps({ listDir: fakeListDir, quietMs: 10, maxWaitMs: 200 });
  startOpenlistRefresh();
});

afterEach(() => {
  stopOpenlistRefresh();
  setOpenlistRefreshDeps(null);
});

after(() => {
  replaceAccounts(baseline.accounts);
  patchAppSettings({ openlistCopy: baseline.openlistCopy });
});

test("整理改了名：源目录、目标目录按挂载根换成 OpenList 路径，浅的在前；攒在一起的几次登记只刷一遍；删掉的源目录不刷", async () => {
  scheduleOpenlistRefresh("acc", ["/movie/A (2013)/a.mkv", "/movie/A (2014)/a.mkv", "/movie/A (2013)", "/movie/A (2014)"], { removed: ["/movie/A (2013)"] });
  scheduleOpenlistRefresh("acc", ["/movie/A (2014)/poster.jpg"]);
  await flushOpenlistRefresh();
  assert.deepEqual(listed, ["/115/movie", "/115/movie/A (2014)"]);
});

test("没配 OpenList 账号，或这个网盘账号没填挂载根：什么都不调", async () => {
  patchAppSettings({ openlistCopy: {} });
  scheduleOpenlistRefresh("acc", ["/movie/A/a.mkv"]);
  await flushOpenlistRefresh();
  assert.deepEqual(listed, []);

  patchAppSettings({ openlistCopy: { account: "ol", mounts: { other: "/other" } } });
  scheduleOpenlistRefresh("acc", ["/movie/A/a.mkv"]);
  await flushOpenlistRefresh();
  assert.deepEqual(listed, [], "acc 没填挂载根");
});

test("object not found（目录已经不在了）、storage not found（挂载根填错）和别的错误都不拦后面的目录，只记日志", async () => {
  failWith["/115/movie/gone"] = new OpenlistError("OpenList /api/fs/list 失败：failed get objs: object not found", 500, false);
  failWith["/115/movie/wrong"] = new OpenlistError("OpenList /api/fs/list 失败：failed get storage: storage not found", 500, false);
  failWith["/115/movie/down"] = new OpenlistError("OpenList /api/fs/list 失败：HTTP 502", 502, true);
  scheduleOpenlistRefresh("acc", ["/movie/gone/a.mkv", "/movie/wrong/a.mkv", "/movie/down/a.mkv", "/movie/ok/b.mkv"]);
  await flushOpenlistRefresh();
  assert.deepEqual(listed, ["/115/movie/down", "/115/movie/gone", "/115/movie/ok", "/115/movie/wrong"]);
});

test("files.landed：按任务 originPath 拼出网盘路径，刷新新文件所在的目录", async () => {
  events.emit("files.landed", { task, paths: ["Show/Season 1/E01.mkv", "Show/Season 1/E02.mkv", "Movie (2020)"], trigger: "share" });
  await flushOpenlistRefresh();
  assert.deepEqual(listed, ["/115/tv", "/115/tv/Show/Season 1"]);
});

test("上一批还在跑时登记的，跑完接着刷", async () => {
  let release!: () => void;
  gate = { dir: "/115/a", wait: new Promise<void>((r) => (release = r)) };
  scheduleOpenlistRefresh("acc", ["/a/x.mkv"]);
  const flushing = flushOpenlistRefresh();
  // 第一批已经开始、卡在 /115/a 上
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(listed, ["/115/a"]);
  scheduleOpenlistRefresh("acc", ["/b/y.mkv"]);
  release();
  await flushing;
  assert.deepEqual(listed, ["/115/a", "/115/b"]);
});

test("批次跑到一半换回真依赖（测试收尾 stop + setDeps(null)）：这一批剩下的目录仍走开跑时的桩，不落到真 OpenList", async () => {
  let release!: () => void;
  gate = { dir: "/115/a", wait: new Promise<void>((r) => (release = r)) };
  scheduleOpenlistRefresh("acc", ["/a/x.mkv", "/b/y.mkv"]);
  const flushing = flushOpenlistRefresh();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(listed, ["/115/a"]);
  stopOpenlistRefresh();
  setOpenlistRefreshDeps(null);
  release();
  await flushing;
  assert.deepEqual(listed, ["/115/a", "/115/b"], "/115/b 仍记在桩里，没有去连 http://ol.local");
});

test("模块没启动（测试里没 start）：登记了也不动", async () => {
  stopOpenlistRefresh();
  scheduleOpenlistRefresh("acc", ["/movie/A/a.mkv"]);
  await flushOpenlistRefresh();
  assert.deepEqual(listed, []);
});
