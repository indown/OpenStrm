/**
 * 让挂载层刷新目录缓存的调度：攒批、浅先、没配不动、object not found / 挂载根填错 / 别的错误都不拦后面的、files.landed 订阅、
 * 上一批还在跑时登记的接着刷、批次中途换依赖不落到真服务、两个挂载层各走各的映射。
 * 挂载层是桩（test/fake-mount-target.ts）；OpenList / CD2 两个真目标只验「配没配好」那一步（走真的设置和账号表）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/mount-cache/refresh.itest.ts
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { fakeMountTarget } from "../../test/fake-mount-target.js";
import { events } from "../events.js";
import { cd2MountCacheTarget } from "./cd2.js";
import { openlistMountCacheTarget } from "./openlist.js";
import { flushMountRefresh, scheduleMountRefresh, setMountRefreshDeps, startMountRefresh, stopMountRefresh } from "./refresh.js";

const olAccount: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
const drive: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "refresh-itest/tv", strmPrefix: "/mnt" };

let baseline: { accounts: AccountInfo[]; openlistCopy: AppSettings["openlistCopy"]; cd2: AppSettings["cd2"] };
let listed: string[] = [];
let failWith: Record<string, Error> = {};
/** 某个目录刷到一半先卡住（模拟上一批还在跑） */
let gate: { dir: string; wait: Promise<void> } | null = null;

const target = (mounts: Record<string, string> | null = { acc: "/115" }) =>
  fakeMountTarget({
    mounts,
    listed,
    fail: (dir) => failWith[dir],
    gate: (dir) => (gate && gate.dir === dir ? gate.wait : undefined),
    isMisconfigured: (err) => err instanceof Error && /storage not found/i.test(err.message),
  });

before(() => {
  baseline = { accounts: listAccounts(), openlistCopy: readAppSettings().openlistCopy, cd2: readAppSettings().cd2 };
  replaceAccounts([drive, olAccount]);
});

beforeEach(() => {
  listed = [];
  failWith = {};
  gate = null;
  setMountRefreshDeps({ targets: () => [target()], quietMs: 10, maxWaitMs: 200 });
  startMountRefresh();
});

afterEach(() => {
  stopMountRefresh();
  setMountRefreshDeps(null);
});

after(() => {
  replaceAccounts(baseline.accounts);
  patchAppSettings({ openlistCopy: baseline.openlistCopy, cd2: baseline.cd2 });
});

test("整理改了名：源目录、目标目录按挂载根换成挂载层路径，浅的在前；攒在一起的几次登记只刷一遍；删掉的源目录不刷", async () => {
  scheduleMountRefresh("acc", ["/movie/A (2013)/a.mkv", "/movie/A (2014)/a.mkv", "/movie/A (2013)", "/movie/A (2014)"], { removed: ["/movie/A (2013)"] });
  scheduleMountRefresh("acc", ["/movie/A (2014)/poster.jpg"]);
  await flushMountRefresh();
  assert.deepEqual(listed, ["/115/movie", "/115/movie/A (2014)"]);
});

test("挂载层没配（mounts 为 null）或这个网盘账号没填挂载根：什么都不调", async () => {
  setMountRefreshDeps({ targets: () => [target(null)], quietMs: 10 });
  scheduleMountRefresh("acc", ["/movie/A/a.mkv"]);
  await flushMountRefresh();
  assert.deepEqual(listed, []);

  setMountRefreshDeps({ targets: () => [target({ other: "/other" })], quietMs: 10 });
  scheduleMountRefresh("acc", ["/movie/A/a.mkv"]);
  await flushMountRefresh();
  assert.deepEqual(listed, [], "acc 没填挂载根");
});

test("真目标的「配没配好」：OpenList 看「复制到 OpenList」的账号和挂载根，CD2 看它那一节的地址、凭据、映射", () => {
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local", mounts: { acc: "/115" } } });
  assert.deepEqual(openlistMountCacheTarget.prepare()?.mounts ?? null, { acc: "/115" });
  patchAppSettings({ openlistCopy: {} });
  assert.equal(openlistMountCacheTarget.prepare()?.mounts ?? null, null, "没选 OpenList 账号");

  patchAppSettings({ cd2: { url: "http://cd2.local:19798", apiToken: "tok", mounts: { acc: "/115盘/" } } });
  assert.deepEqual(cd2MountCacheTarget.prepare()?.mounts ?? null, { acc: "/115盘" }, "映射归一：去尾斜杠");
  patchAppSettings({ cd2: { url: "http://cd2.local:19798", username: "u", password: "p", mounts: { acc: "/115" } } });
  assert.deepEqual(cd2MountCacheTarget.prepare()?.mounts ?? null, { acc: "/115" }, "用户名口令也算凭据");
  patchAppSettings({ cd2: { url: "http://cd2.local:19798", username: "u", mounts: { acc: "/115" } } });
  assert.equal(cd2MountCacheTarget.prepare()?.mounts ?? null, null, "只有用户名没有口令");
  patchAppSettings({ cd2: { apiToken: "tok", mounts: { acc: "/115" } } });
  assert.equal(cd2MountCacheTarget.prepare()?.mounts ?? null, null, "没地址");
  patchAppSettings({ cd2: { url: "http://cd2.local:19798", apiToken: "tok" } });
  assert.equal(cd2MountCacheTarget.prepare()?.mounts ?? null, null, "没映射");
  patchAppSettings({ cd2: {} });
});

test("目录不存在、挂载根填错（storage not found）和别的错误都不拦后面的目录，只记日志", async () => {
  failWith["/115/movie/gone"] = new Error("failed get objs: object not found");
  failWith["/115/movie/wrong"] = new Error("failed get storage: storage not found");
  failWith["/115/movie/down"] = new Error("HTTP 502");
  scheduleMountRefresh("acc", ["/movie/gone/a.mkv", "/movie/wrong/a.mkv", "/movie/down/a.mkv", "/movie/ok/b.mkv"]);
  await flushMountRefresh();
  assert.deepEqual(listed, ["/115/movie/down", "/115/movie/gone", "/115/movie/ok", "/115/movie/wrong"]);
});

test("files.landed：按任务 originPath 拼出网盘路径，刷新新文件所在的目录", async () => {
  events.emit("files.landed", { task, paths: ["Show/Season 1/E01.mkv", "Show/Season 1/E02.mkv", "Movie (2020)"], trigger: "share" });
  await flushMountRefresh();
  assert.deepEqual(listed, ["/115/tv", "/115/tv/Show/Season 1"]);
});

test("上一批还在跑时登记的，跑完接着刷", async () => {
  let release!: () => void;
  gate = { dir: "/115/a", wait: new Promise<void>((r) => (release = r)) };
  scheduleMountRefresh("acc", ["/a/x.mkv"]);
  const flushing = flushMountRefresh();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(listed, ["/115/a"], "第一批已经开始、卡在 /115/a 上");
  scheduleMountRefresh("acc", ["/b/y.mkv"]);
  release();
  await flushing;
  assert.deepEqual(listed, ["/115/a", "/115/b"]);
});

test("批次跑到一半换回真依赖（测试收尾 stop + setDeps(null)）：这一批剩下的目录仍走开跑时的桩，不落到真服务", async () => {
  let release!: () => void;
  gate = { dir: "/115/a", wait: new Promise<void>((r) => (release = r)) };
  scheduleMountRefresh("acc", ["/a/x.mkv", "/b/y.mkv"]);
  const flushing = flushMountRefresh();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(listed, ["/115/a"]);
  stopMountRefresh();
  setMountRefreshDeps(null);
  release();
  await flushing;
  assert.deepEqual(listed, ["/115/a", "/115/b"], "/115/b 仍记在桩里，没有去连真的 OpenList / CD2");
});

test("两个挂载层都配了：各按自己的挂载根刷；一个炸了另一个照常；只配一个时另一个不动", async () => {
  const cd2Listed: string[] = [];
  const cd2 = fakeMountTarget({ name: "CD2", mounts: { acc: "/115网盘" }, listed: cd2Listed, fail: (dir) => (dir === "/115网盘/movie" ? new Error("boom") : undefined) });
  setMountRefreshDeps({ targets: () => [target(), cd2], quietMs: 10 });
  scheduleMountRefresh("acc", ["/movie/A/a.mkv", "/movie/B"]);
  await flushMountRefresh();
  assert.deepEqual(listed, ["/115/movie", "/115/movie/A"]);
  assert.deepEqual(cd2Listed, ["/115网盘/movie", "/115网盘/movie/A"], "CD2 第一个目录炸了，第二个照刷；OpenList 那边不受影响");

  listed.length = 0;
  cd2Listed.length = 0;
  setMountRefreshDeps({ targets: () => [target(null), cd2], quietMs: 10 });
  scheduleMountRefresh("acc", ["/movie/C/c.mkv"]);
  await flushMountRefresh();
  assert.deepEqual(listed, [], "OpenList 没配就不动");
  assert.deepEqual(cd2Listed, ["/115网盘/movie/C"]);
});

test("模块没启动（测试里没 start）：登记了也不动", async () => {
  stopMountRefresh();
  scheduleMountRefresh("acc", ["/movie/A/a.mkv"]);
  await flushMountRefresh();
  assert.deepEqual(listed, []);
});
