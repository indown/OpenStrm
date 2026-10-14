/**
 * 监控循环的通用行为，用 FakeDrive 的变更队列驱动，不认任何一家网盘：
 * 拉到的事件按顺序交给 handlers 落盘、游标逐条推进、problem 事件只记 skipped、
 * 处理失败不拦住后面的事件、夸克那样的快照来源也能挂进同一条循环。
 * 115 专属的门禁 / 405 降级 / 路径还原在 sources/cloud115.itest.ts。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/life/monitor.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { KEY } from "../../db/keys.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { deleteDriveSnapshots, deleteKv, deleteLifeEventsBefore, listRecentLifeEvents, readDriveSnapshot, readKv } from "../../db/repositories/life.js";
import {
  __test_resetOrganize,
  insertRun as insertOrganizeRun,
  replaceItems as replaceOrganizeItems,
  updateItem as updateOrganizeItem,
  updateRun as updateOrganizeRun,
} from "../../db/repositories/organize.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { lifeEvents } from "../../db/schema.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import type { ChangeEvent } from "../drive/types.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { __test_flushAutoOrganize, __test_resetAutoOrganize, setAutoOrganizeDeps, startAutoOrganize } from "../organize/auto.js";
import { __test_resetCopy, listCopies } from "../copy/service.js";
import { events } from "../events.js";
import { releaseTaskStart, reserveTaskStart } from "../task/registry.js";
import { QuarkSnapshotSource } from "./sources/quark.js";
import { getLifeMonitorStatus, probeLifeEvents, startLifeMonitor, stopLifeMonitor } from "./monitor.js";

const baseline = { settings: readAppSettings(), accounts: listAccounts(), tasks: listTasks() };
const acctA: AccountInfo = { accountType: "115", name: "A", cookie: "cookie-A" };
const acctQ: AccountInfo = { accountType: "quark", name: "Q", cookie: "cookie-Q" };
const taskA: TaskDefinition = { id: "m-a", account: "A", accountType: "115", originPath: "tv", targetPath: "monitor-itest/tv", strmPrefix: "/mnt/pan" };
const taskQ: TaskDefinition = { id: "m-q", account: "Q", accountType: "quark", originPath: "kk", targetPath: "monitor-itest/kk", strmPrefix: "/mnt/kk" };
/** A 账号的第二个任务：同步只占 tv 时，movie 里的变化照常处理 */
const taskA2: TaskDefinition = { id: "m-a2", account: "A", accountType: "115", originPath: "movie", targetPath: "monitor-itest/movie", strmPrefix: "/mnt/pan" };
const localRoot = path.join(DATA_DIR, "monitor-itest");

let dA: FakeDrive;
let dQ: FakeDrive;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`等待超时：${what}`);
    await sleep(20);
  }
}
const statusOf = (name: string) => getLifeMonitorStatus().accounts.find((a) => a.name === name);
const configure = (lifeMonitor: Record<string, unknown>) => replaceAppSettings({ ...baseline.settings, lifeMonitor });

let seq = 0;
const ev = (o: Partial<ChangeEvent> & Pick<ChangeEvent, "kind" | "path">): ChangeEvent => ({
  id: `e${++seq}`,
  oldPath: null,
  isDir: false,
  nodeId: `n${seq}`,
  at: 1_900_000_000 + seq,
  ...o,
});

before(() => {
  startAutoOrganize();
  replaceAccounts([acctA, acctQ]);
  replaceTasks([taskA, taskQ]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"], downloadExtensions: [".nfo"] });
  setDriveProviderFactory((account) => (account.name === "A" ? dA : account.name === "Q" ? dQ : null));
});

beforeEach(async () => {
  await stopLifeMonitor();
  dA = new FakeDrive("115", acctA, { changes: true });
  dQ = new FakeDrive("quark", acctQ, { changes: false });
  // 夸克没有事件流：把快照来源挂到假网盘上，走的就是线上那条路径
  Object.assign(dQ, { capabilities: { share: false, changes: true }, changes: new QuarkSnapshotSource(dQ) });
  fs.rmSync(localRoot, { recursive: true, force: true });
  for (const name of ["A", "Q"]) deleteKv(KEY.lifeCursor(name));
  deleteDriveSnapshots();
});

after(async () => {
  await stopLifeMonitor();
  setDriveProviderFactory(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(localRoot, { recursive: true, force: true });
  deleteDriveSnapshots();
});

test("事件按顺序落地：新增写 strm、改名搬文件、删除清理；游标逐条推进；problem 事件只记 skipped", async () => {
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  dA.tree.addDir("/tv/Show");
  dA.tree.addFile("/tv/Show/ep1.mkv");
  dA.changes!.queue.push(
    ev({ id: "c1", kind: "create", path: "/tv/Show/ep1.mkv" }),
    ev({ id: "c2", kind: "rename", path: "/tv/Show/ep1 v2.mkv", oldPath: "/tv/Show/ep1.mkv" }),
    ev({ id: "c3", kind: "create", path: "orphan.mkv", problem: "父目录 404 无法解析" }),
    ev({ id: "c4", kind: "remove", path: "/tv/Show/ep1 v2.mkv" }),
  );
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    assert.equal(statusOf("A")?.source, "fake");
    const settled = () => {
      const st = statusOf("A")?.stats;
      return !!st && st.handled + st.skipped + st.failed === 4;
    };
    await waitFor(settled, "第一轮四条都处理完");
    const st = statusOf("A")!;
    assert.equal(st.stats.events, 4);
    assert.equal(st.stats.handled, 3);
    assert.equal(st.stats.skipped, 1);
    assert.ok(!fs.existsSync(path.join(localRoot, "tv", "Show")), "改名后又删除，本地不应留下东西");
    const rows = listRecentLifeEvents(10);
    assert.deepEqual(
      rows.filter((e) => e.accountName === "A").map((e) => [e.id, e.status, e.kind]).sort(),
      [["c1", "done", "create"], ["c2", "done", "rename"], ["c3", "skipped", "create"], ["c4", "done", "remove"]],
    );
    assert.equal(rows.find((e) => e.id === "c3")?.detail, "父目录 404 无法解析");
    assert.equal(rows.find((e) => e.id === "c2")?.oldPath, "/tv/Show/ep1.mkv");
    assert.deepEqual(readKv(KEY.lifeCursor("A")), { time: 1_900_000_000 + 4, id: "c4" });
    assert.equal(getLifeMonitorStatus().db.snapshots, 0, "115 不建快照");
    assert.equal(dA.changes!.commits, 1, "四条都处理完才 commit 一次");
  } finally {
    await stopLifeMonitor();
  }
});

test("整理自己做的事件按 errorKind 判：本地没跟上（mirror）的照常处理把本地补回来，撤销在网盘那步失败的（transient）仍跳过", async () => {
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  dA.tree.addDir("/tv/Show");
  dA.tree.addFile("/tv/Show/new1.mkv");
  dA.tree.addFile("/tv/Show/new2.mkv");
  const now = Math.floor(Date.now() / 1000);
  insertOrganizeRun({ id: "org-own", taskId: "m-a", accountName: "A", scopePath: "", scopePaths: [], mode: "manual", trigger: "manual" });
  const base = { unitKey: "u", kind: "video" as const, action: "rename" as const, reason: "" };
  replaceOrganizeItems("org-own", [
    { id: "own-mirror", seq: 0, ...base, srcPath: "/tv/Show/old1.mkv", dstPath: "/tv/Show/new1.mkv", nodeId: "n-mirror", status: "done", error: "本地镜像失败：EACCES" },
    { id: "own-ok", seq: 1, ...base, srcPath: "/tv/Show/old2.mkv", dstPath: "/tv/Show/new2.mkv", nodeId: "n-ok", status: "done", error: "改不了" },
  ]);
  updateOrganizeItem("own-mirror", { errorKind: "mirror", finishedAt: now });
  updateOrganizeItem("own-ok", { errorKind: "transient", finishedAt: now });
  dA.changes!.queue.push(
    ev({ id: "o1", kind: "rename", path: "/tv/Show/new1.mkv", oldPath: "/tv/Show/old1.mkv", nodeId: "n-mirror" }),
    ev({ id: "o2", kind: "rename", path: "/tv/Show/new2.mkv", oldPath: "/tv/Show/old2.mkv", nodeId: "n-ok" }),
  );
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => {
      const st = statusOf("A")?.stats;
      return !!st && st.handled + st.skipped + st.failed === 2;
    }, "两条都处理完");
    const rows = listRecentLifeEvents(10).filter((e) => e.accountName === "A");
    assert.equal(rows.find((e) => e.id === "o1")?.status, "done", "镜像失败的：事件照常处理");
    assert.ok(fs.existsSync(path.join(localRoot, "tv", "Show", "new1.strm")), "本地由事件补回来");
    assert.equal(rows.find((e) => e.id === "o2")?.status, "skipped");
    assert.equal(rows.find((e) => e.id === "o2")?.detail, "整理已处理，本地已镜像");
    assert.ok(!fs.existsSync(path.join(localRoot, "tv", "Show", "new2.strm")), "跳过的不动本地");
  } finally {
    await stopLifeMonitor();
    __test_resetOrganize();
  }
});

test("撤销时挪回来了、改回原名那步失败的项（done 带 curPath）：本地还没跟上，事件照常处理把本地搬过去", async () => {
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  dA.tree.addDir("/tv/Show");
  dA.tree.addDir("/tv/Other");
  dA.tree.addFile("/tv/Show/new3.mkv");
  fs.mkdirSync(path.join(localRoot, "tv", "Other"), { recursive: true });
  fs.writeFileSync(path.join(localRoot, "tv", "Other", "new3.strm"), "http://x/tv/Other/new3.mkv");
  const now = Math.floor(Date.now() / 1000);
  insertOrganizeRun({ id: "org-half", taskId: "m-a", accountName: "A", scopePath: "", scopePaths: [], mode: "manual", trigger: "manual" });
  replaceOrganizeItems("org-half", [
    { id: "own-half", seq: 0, unitKey: "u", kind: "video", action: "move", reason: "", srcPath: "/tv/Show/old3.mkv", dstPath: "/tv/Other/new3.mkv", nodeId: "n-half", status: "done", error: "改不回" },
  ]);
  updateOrganizeItem("own-half", { errorKind: "transient", finishedAt: now, curPath: "/tv/Show/new3.mkv" });
  dA.changes!.queue.push(ev({ id: "o3", kind: "move", path: "/tv/Show/new3.mkv", oldPath: "/tv/Other/new3.mkv", nodeId: "n-half" }));
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => {
      const st = statusOf("A")?.stats;
      return !!st && st.handled + st.skipped + st.failed === 1;
    }, "处理完");
    const row = listRecentLifeEvents(10).find((e) => e.id === "o3");
    assert.equal(row?.status, "done", `没跳过：${row?.detail}`);
    assert.ok(fs.existsSync(path.join(localRoot, "tv", "Show", "new3.strm")), "本地跟着挪回来了");
    assert.ok(!fs.existsSync(path.join(localRoot, "tv", "Other", "new3.strm")));
  } finally {
    await stopLifeMonitor();
    __test_resetOrganize();
    // 事件的时间是造出来的未来值，会一直排在「最近」的最前面，把后面用例里的真事件挤出 listRecentLifeEvents 的窗口
    deleteLifeEventsBefore(Number.MAX_SAFE_INTEGER);
  }
});

test("撤销还在跑、挪回来了还没改回原名（done 带 curPath，run 在 reverting）：正常的中间状态，事件跳过，本地等撤销自己镜像", async () => {
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  dA.tree.addDir("/tv/Show");
  dA.tree.addDir("/tv/Other");
  dA.tree.addFile("/tv/Show/new4.mkv");
  fs.mkdirSync(path.join(localRoot, "tv", "Other"), { recursive: true });
  fs.writeFileSync(path.join(localRoot, "tv", "Other", "new4.strm"), "http://x/tv/Other/new4.mkv");
  const now = Math.floor(Date.now() / 1000);
  insertOrganizeRun({ id: "org-mid", taskId: "m-a", accountName: "A", scopePath: "", scopePaths: [], mode: "manual", trigger: "manual" });
  updateOrganizeRun("org-mid", { status: "reverting", stage: "revert" });
  replaceOrganizeItems("org-mid", [
    { id: "own-mid", seq: 0, unitKey: "u", kind: "video", action: "move", reason: "", srcPath: "/tv/Show/old4.mkv", dstPath: "/tv/Other/new4.mkv", nodeId: "n-mid", status: "done", error: "" },
  ]);
  updateOrganizeItem("own-mid", { finishedAt: now, curPath: "/tv/Show/new4.mkv" });
  dA.changes!.queue.push(ev({ id: "o4", kind: "move", path: "/tv/Show/new4.mkv", oldPath: "/tv/Other/new4.mkv", nodeId: "n-mid" }));
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => {
      const st = statusOf("A")?.stats;
      return !!st && st.handled + st.skipped + st.failed === 1;
    }, "处理完");
    const row = listRecentLifeEvents(10).find((e) => e.id === "o4");
    assert.equal(row?.status, "skipped", `应该跳过：${row?.detail}`);
    assert.ok(fs.existsSync(path.join(localRoot, "tv", "Other", "new4.strm")), "本地不动，等撤销改完名自己镜像");
    assert.ok(!fs.existsSync(path.join(localRoot, "tv", "Show", "new4.strm")));
  } finally {
    await stopLifeMonitor();
    __test_resetOrganize();
    deleteLifeEventsBefore(Number.MAX_SAFE_INTEGER);
  }
});

test("从任务外挪进来的文件按新增处理，也交给自动整理；任务里挪动、本地没有退化成新增的不交", async () => {
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  // 自动整理要任务开了 review、配了 TMDB；createRun 换成记账的假函数，不真建 run
  replaceAppSettings({ ...readAppSettings(), tmdb: { apiKey: "x" } });
  replaceTasks([{ ...taskA, organize: { mode: "review" } }, taskQ]);
  const calls: Array<{ paths: string[]; trigger: string }> = [];
  setAutoOrganizeDeps({
    createRun: async (input) => {
      calls.push({ paths: input.paths ?? [], trigger: input.trigger ?? "" });
      return {} as never;
    },
    debounceMs: 0,
  });
  dA.tree.addDir("/tv/Show");
  dA.tree.addFile("/tv/Show/ep1.mkv");
  dA.tree.addFile("/tv/Show/ep2.mkv");
  dA.tree.addDir("/tv/Show2");
  dA.tree.addFile("/tv/Show2/ep3.mkv");
  dA.changes!.queue.push(
    ev({ id: "a1", kind: "move", path: "/tv/Show/ep1.mkv", oldPath: "/inbox/ep1.mkv" }),
    ev({ id: "a2", kind: "create", path: "/tv/Show/ep2.mkv" }),
    ev({ id: "a3", kind: "move", path: "/tv/Show2/ep3.mkv", oldPath: "/tv/Show/ep3.mkv" }),
  );
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => {
      const st = statusOf("A")?.stats;
      return !!st && st.handled + st.skipped + st.failed === 3;
    }, "三条都处理完");
    await __test_flushAutoOrganize();
    await waitFor(() => calls.flatMap((c) => c.paths).length >= 2, "自动整理收到路径");
    assert.deepEqual(calls.flatMap((c) => c.paths).sort(), ["Show/ep1.mkv", "Show/ep2.mkv"], "挪进来的和新增的交给自动整理，任务里挪动的不交");
    assert.ok(calls.every((c) => c.trigger === "monitor"));
    assert.ok(fs.existsSync(path.join(localRoot, "tv", "Show", "ep1.strm")), "挪进来的照新增生成 strm");
    assert.ok(fs.existsSync(path.join(localRoot, "tv", "Show2", "ep3.strm")), "本地没有的退化成新增，strm 照样生成");
  } finally {
    await stopLifeMonitor();
    __test_resetAutoOrganize();
    setAutoOrganizeDeps(null);
    replaceTasks([taskA, taskQ]);
    deleteLifeEventsBefore(Number.MAX_SAFE_INTEGER);
  }
});

test("任务开了「复制到 OpenList」：新落下的交给复制队列；整理自己造成的事件不交", async () => {
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  replaceAppSettings({
    ...readAppSettings(),
    openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { A: "/115" } },
  });
  replaceAccounts([...listAccounts(), { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" }]);
  replaceTasks([{ ...taskA, copyToOpenlist: { enabled: true } }, taskQ]);
  await __test_resetCopy();
  dA.tree.addDir("/tv/Show");
  dA.tree.addFile("/tv/Show/ep9.mkv");
  dA.changes!.queue.push(ev({ id: "c1", kind: "create", path: "/tv/Show/ep9.mkv" }));
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => listCopies().length > 0, "复制队列收到一条");
    const [c] = listCopies();
    assert.equal(c.account, "A");
    assert.equal(c.srcDir, "/tv/Show");
    assert.equal(c.name, "ep9.mkv");
    assert.equal(c.dstDir, "/local/media/Show", "任务目录里的层级原样带过去");
    assert.equal(c.trigger, "monitor");
  } finally {
    await stopLifeMonitor();
    await __test_resetCopy();
    replaceTasks([taskA, taskQ]);
    deleteLifeEventsBefore(Number.MAX_SAFE_INTEGER);
  }
});

test("任务没开复制：一条都不进复制队列", async () => {
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  replaceAppSettings({
    ...readAppSettings(),
    openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { A: "/115" } },
  });
  replaceTasks([taskA, taskQ]);
  await __test_resetCopy();
  dA.tree.addDir("/tv/Show3");
  dA.tree.addFile("/tv/Show3/ep1.mkv");
  dA.changes!.queue.push(ev({ id: "d1", kind: "create", path: "/tv/Show3/ep1.mkv" }));
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => (statusOf("A")?.stats.handled ?? 0) >= 1, "事件处理完");
    assert.equal(listCopies().length, 0);
  } finally {
    await stopLifeMonitor();
    await __test_resetCopy();
    deleteLifeEventsBefore(Number.MAX_SAFE_INTEGER);
  }
});

test("一条事件处理炸了记 failed，后面的照常处理", async () => {
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  dA.tree.addDir("/tv/S");
  dA.tree.addFile("/tv/S/a.mkv");
  dA.tree.addFile("/tv/S/b.mkv");
  // 下载类文件要打直链，让直链失败
  dA.tree.addFile("/tv/S/a.nfo");
  dA.changes!.queue.push(
    ev({ id: "f1", kind: "create", path: "/tv/S/a.nfo" }),
    ev({ id: "f2", kind: "create", path: "/tv/S/b.mkv" }),
  );
  dA.beforeCall = async () => {
    if (dA.log[dA.log.length - 1]?.startsWith("downloadLink")) throw new Error("直链被风控");
  };
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => (statusOf("A")?.stats.failed ?? 0) === 1 && (statusOf("A")?.stats.handled ?? 0) === 1, "一失败一成功");
    const rows = listRecentLifeEvents(10);
    assert.equal(rows.find((e) => e.id === "f1")?.status, "failed");
    assert.match(rows.find((e) => e.id === "f1")?.detail ?? "", /直链被风控/);
    assert.equal(fs.readFileSync(path.join(localRoot, "tv", "S", "b.strm"), "utf8"), "/mnt/pan/tv/S/b.mkv");
    assert.deepEqual(readKv(KEY.lifeCursor("A")), { time: 1_900_000_000 + seq, id: "f2" }, "失败的也推进游标，不会反复重放");
    assert.equal(dA.changes!.commits, 1);
    assert.deepEqual(dA.changes!.committedFailed, ["f1"], "失败的事件 id 交给来源，快照式来源据此不记这条");
  } finally {
    await stopLifeMonitor();
  }
});

test("快照来源挂进同一条循环：首轮只建快照，latest 模式不发事件；间隔按来源的下限抬高", async () => {
  configure({ accounts: ["Q"], pullMode: "latest", intervalSeconds: 5 });
  dQ.tree.addDir("/kk/Show");
  dQ.tree.addFile("/kk/Show/ep1.mkv");
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    assert.equal(statusOf("Q")?.source, "snapshot");
    await waitFor(() => (statusOf("Q")?.stats.rounds ?? 0) >= 1, "第一轮");
    assert.equal(statusOf("Q")?.stats.events, 0);
    assert.equal(getLifeMonitorStatus().db.snapshots, 1);
    assert.ok(getLifeMonitorStatus().logs.some((l) => l.includes("[Q] 启动：来源 snapshot，模式 latest，间隔 300s")), "间隔抬到 5 分钟");
    assert.ok(!fs.existsSync(path.join(localRoot, "kk")), "首轮不生成");
    assert.equal(dQ.calls.walkSubtree, 1);
  } finally {
    await stopLifeMonitor();
  }
});

test("快照来源 all 模式：首轮把现有文件全部当新增生成", async () => {
  configure({ accounts: ["Q"], pullMode: "all", intervalSeconds: 5 });
  dQ.tree.addDir("/kk/Show");
  dQ.tree.addFile("/kk/Show/ep1.mkv");
  dQ.tree.addFile("/kk/Show/ep2.mkv");
  dQ.tree.addFile("/kk/top.mkv");
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => (statusOf("Q")?.stats.handled ?? 0) === 2, "目录 + 顶层文件两条事件");
    assert.equal(fs.readFileSync(path.join(localRoot, "kk", "Show", "ep1.strm"), "utf8"), "/mnt/kk/kk/Show/ep1.mkv");
    assert.ok(fs.existsSync(path.join(localRoot, "kk", "Show", "ep2.strm")));
    assert.ok(fs.existsSync(path.join(localRoot, "kk", "top.strm")));
    const rows = listRecentLifeEvents(10).filter((e) => e.accountName === "Q");
    assert.deepEqual(rows.map((e) => e.path).sort(), ["/kk/Show", "/kk/top.mkv"], "目录只报最上层那条");
    assert.ok(rows.every((e) => e.id.startsWith("q:Q:")), "夸克事件 id 是合成的");
  } finally {
    await stopLifeMonitor();
  }
});

test("快照来源的门禁：列根目录失败 → 该账号起不来并说明原因", async () => {
  configure({ accounts: ["Q"] });
  dQ.failWith = new Error("require login");
  const r = await startLifeMonitor();
  assert.equal(r.ok, false);
  assert.match(r.message, /^Q：网盘不可用：require login，请检查 cookie$/);
  assert.equal(statusOf("Q")?.running, false);
});

test("probe 对快照来源只验 cookie，并说明它没有事件流", async () => {
  configure({ accounts: ["Q"] });
  dQ.tree.addDir("/kk");
  const r = await probeLifeEvents(5, "Q");
  assert.equal(r.ok, true);
  assert.match(r.message, /cookie 有效，根目录 1 项；这个网盘没有事件流/);
});

test("115 和夸克账号同时监控：各走各的来源", async () => {
  configure({ accounts: ["A", "Q"], pullMode: "latest", intervalSeconds: 5 });
  dA.tree.addDir("/tv");
  dA.tree.addFile("/tv/a.mkv");
  dA.changes!.queue.push(ev({ id: "x1", kind: "create", path: "/tv/a.mkv" }));
  dQ.tree.addDir("/kk");
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(r.started, ["A", "Q"]);
    await waitFor(() => (statusOf("A")?.stats.handled ?? 0) === 1 && (statusOf("Q")?.stats.rounds ?? 0) >= 1, "两边各跑完一轮");
    assert.deepEqual(getLifeMonitorStatus().accounts.map((a) => [a.name, a.source]), [["A", "fake"], ["Q", "snapshot"]]);
    assert.ok(fs.existsSync(path.join(localRoot, "tv", "a.strm")));
  } finally {
    await stopLifeMonitor();
  }
});

test("来源报 warnings（某个根列不了）：记进 lastError 让人看见，事件照常处理，不按整轮失败退避", async () => {
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  dA.tree.addDir("/tv");
  dA.tree.addFile("/tv/w.mkv");
  dA.changes!.warnings = ["/gone 列目录失败：找不到"];
  dA.changes!.queue.push(ev({ id: "w1", kind: "create", path: "/tv/w.mkv" }));
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => (statusOf("A")?.stats.handled ?? 0) === 1, "事件处理完");
    const st = statusOf("A")!;
    assert.equal(st.running, true);
    assert.equal(st.lastError, "/gone 列目录失败：找不到");
    assert.equal(dA.changes!.commits, 1);
    assert.ok(getLifeMonitorStatus().logs.some((l) => l.includes("[warn] [A] /gone 列目录失败")));
    assert.ok(!getLifeMonitorStatus().logs.some((l) => l.includes("轮询失败")), "不是整轮失败");
  } finally {
    await stopLifeMonitor();
  }
});

/* ------------------------- 全量同步在跑时：先记下，跑完再补 ------------------------- */

const rowOf = (id: string) => listRecentLifeEvents(500).find((r) => r.id === id);
/** 前一条用例中途失败会留下待补的事件，串进后面的用例：每条开头清掉 */
const clearBacklog = () => db.update(lifeEvents).set({ status: "skipped" }).where(eq(lifeEvents.status, "deferred")).run();

test("同步任务在跑：它目录里的变化先记下、不动本地，别的任务目录照常；同步一结束不等下一轮就补上，先后不乱", async () => {
  clearBacklog();
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  replaceTasks([taskA, taskA2, taskQ]);
  reserveTaskStart("m-a");
  dA.changes!.queue.push(
    ev({ id: "sync-d1", kind: "create", path: "/tv/Show/ep1.mkv" }),
    ev({ id: "sync-d2", kind: "rename", path: "/tv/Show/ep1 v2.mkv", oldPath: "/tv/Show/ep1.mkv" }),
    ev({ id: "sync-d3", kind: "create", path: "/movie/m.mkv" }),
  );
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => statusOf("A")?.stats.handled === 1 && statusOf("A")?.stats.deferred === 2, "第一轮：movie 处理了，tv 两条记下");
    assert.ok(fs.existsSync(path.join(localRoot, "movie", "m.strm")), "别的任务目录照常");
    assert.ok(!fs.existsSync(path.join(localRoot, "tv")), "同步在跑的目录不动本地");
    const st = statusOf("A")!;
    assert.equal(st.backlog, 2);
    assert.deepEqual(st.syncing, ["/tv"]);
    assert.equal(rowOf("sync-d1")?.status, "deferred");
    assert.match(rowOf("sync-d1")?.detail ?? "", /同步任务在跑（\/tv）/);
    assert.ok(getLifeMonitorStatus().logs.some((l) => l.includes("先记下 2 条变化")));

    // 5 秒一轮：3 秒内补上，说明是同步结束的事件插的加急，不是等到了下一轮
    releaseTaskStart("m-a", { status: 200, message: "no files to download", idle: true });
    await waitFor(() => statusOf("A")?.backlog === 0, "同步一结束就补", 3000);
    assert.ok(fs.existsSync(path.join(localRoot, "tv", "Show", "ep1 v2.strm")), "先建后改名，本地是改名后的");
    assert.ok(!fs.existsSync(path.join(localRoot, "tv", "Show", "ep1.strm")));
    assert.equal(rowOf("sync-d1")?.status, "done");
    assert.equal(rowOf("sync-d2")?.status, "done");
    assert.deepEqual(statusOf("A")?.syncing, []);
    assert.ok(getLifeMonitorStatus().logs.some((l) => l.includes("补上了同步期间记下的 2 条变化")));
  } finally {
    releaseTaskStart("m-a");
    await stopLifeMonitor();
    replaceTasks([taskA, taskQ]);
  }
});

test("补失败：这一处这一轮先停、下一轮再试，连着三次还不行记失败；后面同一处的跟着等，不相干的照常补", async () => {
  clearBacklog();
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  reserveTaskStart("m-a");
  // info.nfo 要下载，网盘上又没有这个文件：补的时候取直链会失败
  dA.changes!.queue.push(
    ev({ id: "sync-f1", kind: "create", path: "/tv/Show/info.nfo" }),
    ev({ id: "sync-f2", kind: "remove", path: "/tv/Show/info.nfo" }),
    ev({ id: "sync-f3", kind: "create", path: "/tv/Other/ok.mkv" }),
  );
  const r = await startLifeMonitor();
  try {
    assert.equal(r.ok, true, r.message);
    await waitFor(() => statusOf("A")?.stats.deferred === 3, "三条都记下");
    releaseTaskStart("m-a", { status: 500, message: "读取115目录失败" });
    await waitFor(() => (rowOf("sync-f1")?.detail ?? "").includes("第 1 次"), "第一次补失败");
    assert.equal(rowOf("sync-f1")?.status, "deferred");
    assert.equal(rowOf("sync-f2")?.status, "deferred", "同一个文件后面的删除跟着等");
    assert.match(rowOf("sync-f2")?.detail ?? "", /按先后跟着等/);
    await waitFor(() => rowOf("sync-f3")?.status === "done", "不相干的照常补");
    assert.ok(fs.existsSync(path.join(localRoot, "tv", "Other", "ok.strm")));
    // 「同步结束」再发两次，各插一轮加急：第三次还失败就记失败，后面的删除接着补
    events.emit("task.finished", { taskId: "m-a" });
    await waitFor(() => (rowOf("sync-f1")?.detail ?? "").includes("第 2 次"), "第二次补失败");
    events.emit("task.finished", { taskId: "m-a" });
    await waitFor(() => rowOf("sync-f1")?.status === "failed", "第三次还失败就记失败");
    assert.match(rowOf("sync-f1")?.detail ?? "", /补了 3 次都没成/);
    await waitFor(() => rowOf("sync-f2")?.status === "skipped", "删除接着补（本地本来就没有，跳过）");
    assert.equal(statusOf("A")?.backlog, 0);
  } finally {
    releaseTaskStart("m-a");
    await stopLifeMonitor();
  }
});

test("监控停了再起：记下待补的在库里，重新启动后第一轮就补上", async () => {
  clearBacklog();
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  reserveTaskStart("m-a");
  dA.changes!.queue.push(ev({ id: "sync-s1", kind: "create", path: "/tv/later.mkv" }));
  assert.equal((await startLifeMonitor()).ok, true);
  try {
    await waitFor(() => statusOf("A")?.stats.deferred === 1, "记下");
    await stopLifeMonitor();
    releaseTaskStart("m-a", { status: 200, message: "no files to download", idle: true });
    assert.equal(rowOf("sync-s1")?.status, "deferred", "监控停着没人补");
    assert.equal(getLifeMonitorStatus().accounts.find((a) => a.name === "A")?.backlog, 1, "停着的账号状态里也看得到");
    assert.equal((await startLifeMonitor()).ok, true);
    await waitFor(() => rowOf("sync-s1")?.status === "done", "重启后第一轮补上");
    assert.ok(fs.existsSync(path.join(localRoot, "tv", "later.strm")));
  } finally {
    releaseTaskStart("m-a");
    await stopLifeMonitor();
  }
});

test("记下待补的事件被重拉到（115 重启后游标没跟上）：不再处理第二遍，补的时候只处理一次", async () => {
  clearBacklog();
  configure({ accounts: ["A"], pullMode: "latest", intervalSeconds: 5 });
  reserveTaskStart("m-a");
  dA.changes!.queue.push(ev({ id: "sync-x1", kind: "create", path: "/tv/dup.mkv" }));
  assert.equal((await startLifeMonitor()).ok, true);
  try {
    await waitFor(() => statusOf("A")?.stats.deferred === 1, "记下");
    const rounds = statusOf("A")!.stats.rounds;
    dA.changes!.queue.push(ev({ id: "sync-x1", kind: "create", path: "/tv/dup.mkv" }));
    // 同步还在跑：插一轮加急，这一轮重拉到同一条
    events.emit("task.finished", { taskId: "m-a" });
    await waitFor(() => (statusOf("A")?.stats.rounds ?? 0) > rounds, "又跑了一轮");
    assert.equal(statusOf("A")?.stats.deferred, 1, "重拉到的那条没再记一遍");
    releaseTaskStart("m-a", { status: 200, message: "no files to download", idle: true });
    await waitFor(() => rowOf("sync-x1")?.status === "done", "补上");
    assert.equal(statusOf("A")?.stats.handled, 1, "只处理了一次");
  } finally {
    releaseTaskStart("m-a");
    await stopLifeMonitor();
  }
});

test("快照来源一样：同步在跑时变化先记下、快照照常往前走（跑完补上之后不会再报一遍）", async () => {
  clearBacklog();
  configure({ accounts: ["Q"], pullMode: "latest", intervalSeconds: 5 });
  // 只能整棵列的快照来源最短 5 分钟一轮：测试里压到 1 秒（实际按设置的 5 秒），好看到后面几轮
  Object.defineProperty(dQ.changes, "minIntervalSeconds", { get: () => 1, configurable: true });
  dQ.tree.addFile("/kk/Show/ep1.mkv");
  assert.equal((await startLifeMonitor()).ok, true);
  try {
    await waitFor(() => (statusOf("Q")?.stats.rounds ?? 0) >= 1, "首轮建快照");
    reserveTaskStart("m-q");
    dQ.tree.addFile("/kk/Show/ep2.mkv");
    await waitFor(() => statusOf("Q")?.stats.deferred === 1, "下一轮看到 ep2，先记下", 8000);
    assert.ok(!fs.existsSync(path.join(localRoot, "kk", "Show", "ep2.strm")));
    assert.ok(readDriveSnapshot<{ path: string }>("Q", "/kk")?.entries.some((e) => e.path === "Show/ep2.mkv"), "快照照常往前走");
    releaseTaskStart("m-q", { status: 200, message: "no files to download", idle: true });
    await waitFor(() => fs.existsSync(path.join(localRoot, "kk", "Show", "ep2.strm")), "跑完补上", 3000);
    const rounds = statusOf("Q")!.stats.rounds;
    await waitFor(() => (statusOf("Q")?.stats.rounds ?? 0) > rounds, "再跑一轮", 8000);
    assert.equal(statusOf("Q")?.stats.events, 1, "快照已经往前走了，不会再报一遍");
    assert.equal(statusOf("Q")?.stats.handled, 1);
  } finally {
    releaseTaskStart("m-q");
    await stopLifeMonitor();
  }
});
