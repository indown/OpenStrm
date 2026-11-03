/**
 * 分享接口的闭环：按链接挑账号、info / list / receive、跨网盘类型 400、没账号 400、转存后生成 strm、顺手建追更。
 * 115 和夸克各一个内存假网盘。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/share/share.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import shareRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import { __test_resetFollows, setFollowServiceDeps } from "../../services/follow/service.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { patchAppSettings } from "../../db/repositories/settings.js";
import { clearCopies, listCopies } from "../../services/copy/queue.js";
import { enqueueCopy, stopCopyWatcher } from "../../services/copy/service.js";
import { isTaskRunning } from "../../services/task/registry.js";
import { __test_setAsyncStartGrace } from "../../services/share/receive.js";

const a115: AccountInfo = { accountType: "115", name: "a", cookie: "c" };
const aQuark: AccountInfo = { accountType: "quark", name: "q", cookie: "c" };
const t115: TaskDefinition = { id: "s-115", account: "a", accountType: "115", originPath: "tv", targetPath: "share-itest/tv", strmPrefix: "/mnt/pan" };
const tQuark: TaskDefinition = { id: "s-quark", account: "q", accountType: "quark", originPath: "kk", targetPath: "share-itest/kk", strmPrefix: "/mnt/kk" };

const d115 = new FakeDrive("115", a115, { share: true });
const dQuark = new FakeDrive("quark", aQuark, { share: true });
const LINK_115 = "https://115.com/s/abc?password=1234";
const LINK_QUARK = "https://pan.quark.cn/s/qk123?pwd=abcd";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };

before(async () => {
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  replaceTasks([t115, tQuark]);
  replaceAccounts([a115, aQuark]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"] });
  await writeAuthPassword("share-itest-pw");

  d115.tree.addDir("/tv/Show");
  const s115 = d115.share!.define("abc", { title: "115 剧", password: "1234" });
  s115.addFile("/S1/E01.mkv", { hash: "a" });
  s115.addFile("/S1/E02.mkv", { hash: "b" });
  s115.addFile("/readme.txt");

  dQuark.tree.addDir("/kk/Show");
  const sQuark = dQuark.share!.define("qk123", { title: "夸克剧", password: "abcd" });
  sQuark.addFile("/E01.mkv");
  sQuark.addFile("/E02.mkv");
  sQuark.addDir("/Extras");
  sQuark.addFile("/Extras/making.mkv");
  setDriveProviderFactory((account) => (account.name === "a" ? d115 : account.name === "q" ? dQuark : null));
  setFollowServiceDeps({ notify: async () => {}, random: () => 0.5, gapMs: 0 });

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(shareRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  await __test_resetFollows();
  setFollowServiceDeps(null);
  setDriveProviderFactory(null);
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(path.join(DATA_DIR, "share-itest"), { recursive: true, force: true });
  await writeAuthPassword(DEFAULT_AUTH.password);
});

const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/share", headers: auth, payload });

test("不带令牌 401；不认识的链接 400", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/share", payload: { action: "info", url: LINK_115 } })).statusCode, 401);
  const bad = await post({ action: "info", url: "https://example.com/s/xyz" });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /不认识这个分享链接/);
});

test("info / list：按链接挑同类账号，条目归一化，夸克条目带 token", async () => {
  const info = await post({ action: "info", url: LINK_115 });
  assert.equal(info.statusCode, 200, info.body);
  assert.deepEqual(info.json(), { kind: "115", account: "a", title: "115 剧", fileCount: 2 });

  const list = await post({ action: "list", url: LINK_115 });
  assert.equal(list.statusCode, 200, list.body);
  const entries = list.json().entries as Array<{ name: string; isDir: boolean; hash?: string }>;
  assert.deepEqual(entries.map((e) => [e.name, e.isDir]).sort(), [["S1", true], ["readme.txt", false]]);
  assert.equal(list.json().kind, "115");

  const qinfo = await post({ action: "info", url: LINK_QUARK });
  assert.equal(qinfo.json().account, "q");
  const qlist = await post({ action: "list", url: LINK_QUARK, dirId: "0" });
  const qentries = qlist.json().entries as Array<{ id: string; name: string; token?: string }>;
  assert.equal(qentries.length, 3, "两个文件 + Extras 目录");
  assert.ok(qentries.every((e) => e.token?.startsWith("tok-")), "夸克转存要的 token 跟着条目一起给前端");
});

test("提取码不对 → 500 且说明分享不可用；指定了打不开的账号 → 400", async () => {
  const wrong = await post({ action: "info", url: "https://115.com/s/abc?password=0000" });
  assert.equal(wrong.statusCode, 500);
  assert.match(wrong.json().message, /分享不可用/);
  assert.equal(wrong.json().code, "SHARE_GONE");
  assert.equal(wrong.json().reason, "password", "提取码不对：分享其实还在，界面标「要提取码」而不是「已失效」");
  const gone = await post({ action: "info", url: "https://115.com/s/nosuch?password=1234" });
  assert.equal(gone.json().code, "SHARE_GONE");
  assert.equal(gone.json().reason, "gone");
  // 整段分享文字（链接后面跟着提取码）也认得出
  const pasted = await post({ action: "info", url: "链接：https://115.com/s/abc 提取码：1234 复制这段打开" });
  assert.equal(pasted.statusCode, 200, pasted.body);
  const other = await post({ action: "info", url: LINK_115, account: "q" });
  assert.equal(other.statusCode, 400);
});

test("receive 到任务目录（sync）：转存进网盘、按子树生成 strm；跨网盘类型 400；顺手建追更", async () => {
  const list = await post({ action: "list", url: LINK_115 });
  const s1 = (list.json().entries as Array<{ id: string; name: string; isDir: boolean }>).find((e) => e.name === "S1")!;
  const res = await post({ action: "receive", url: LINK_115, taskId: "s-115", subPath: "Show", mode: "sync", items: [s1], follow: { intervalMinutes: 60 }, watchDirId: "0", watchPath: "", name: "115 剧" });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.mode, "sync");
  assert.equal(body.generatedCount, 2);
  assert.equal(body.strmGenerated, true);
  assert.ok(d115.tree.get("/tv/Show/S1/E02.mkv"), "整个目录转存进了任务目录的 Show 下");
  assert.equal(fs.readFileSync(path.join(DATA_DIR, "share-itest", "tv", "Show", "S1", "E01.strm"), "utf8"), "/mnt/pan/tv/Show/S1/E01.mkv");
  assert.equal(body.follow?.name, "115 剧", "顺手建了追更");
  assert.equal(body.follow?.taskId, "s-115");

  const cross = await post({ action: "receive", url: LINK_QUARK, taskId: "s-115", items: [{ id: "x", name: "x", isDir: false }] });
  assert.equal(cross.statusCode, 400);
  assert.match(cross.json().message, /夸克网盘的分享，不能转存到115 网盘/);
});

test("夸克 receive：带 token 转存，夸克给的顶层 id 直接用来列子树", async () => {
  const qlist = await post({ action: "list", url: LINK_QUARK });
  const items = qlist.json().entries as Array<{ id: string; name: string; isDir: boolean; token?: string }>;
  const res = await post({ action: "receive", url: LINK_QUARK, taskId: "s-quark", subPath: "Show", mode: "sync", items });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().generatedCount, 3, "两个文件 + 目录里的一个");
  assert.ok(dQuark.tree.get("/kk/Show/E01.mkv"));
  assert.ok(fs.existsSync(path.join(DATA_DIR, "share-itest", "kk", "Show", "E02.strm")));
  assert.ok(fs.existsSync(path.join(DATA_DIR, "share-itest", "kk", "Show", "Extras", "making.strm")));
  assert.equal(dQuark.share!.calls.receive, 1);
  const extrasId = dQuark.tree.get("/kk/Show/Extras")!.id;
  assert.ok(dQuark.log.includes(`listSubtree ${extrasId}`), `目录要按转存回来的顶层 id 列子树，实际调用：${dQuark.log.join(" | ")}`);
  assert.ok(!dQuark.log.includes("listSubtree /kk/Show/Extras"), "不该退回按路径找");
});

test("receive 到任务目录（async，后台同步）：任务开着复制时照样交给复制队列", async () => {
  const ol: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
  replaceAccounts([a115, aQuark, ol]);
  replaceTasks([t115, { ...tQuark, copyToOpenlist: { enabled: true, dstDir: "/local/kk" } }]);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { q: "/quark" } } });
  dQuark.tree.addDir("/kk/Async");
  try {
    const qlist = await post({ action: "list", url: LINK_QUARK });
    const e01 = (qlist.json().entries as Array<{ id: string; name: string; isDir: boolean; token?: string }>).find((e) => e.name === "E01.mkv")!;
    const res = await post({ action: "receive", url: LINK_QUARK, taskId: "s-quark", subPath: "Async", mode: "async", items: [e01] });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().mode, "async");
    const [c] = listCopies();
    assert.ok(c, "后台模式也要排上复制，不然任务开着复制、转存时选了后台就悄悄不复制了");
    assert.equal(c.trigger, "share");
    assert.equal(c.srcDir, "/kk/Async");
    assert.equal(c.name, "E01.mkv");
    assert.equal(c.dstDir, "/local/kk/Async");
    assert.equal(c.holdUntil, undefined, "后台模式不整理，不用等");
  } finally {
    await stopCopyWatcher();
    clearCopies();
    for (let i = 0; i < 100 && isTaskRunning("s-quark"); i++) await new Promise((r) => setTimeout(r, 50));
    replaceAccounts([a115, aQuark]);
    replaceTasks([t115, tQuark]);
    patchAppSettings({ openlistCopy: baseline.settings.openlistCopy });
  }
});

test("同步转存：复制在生成 strm 之前就登记好，这期间网盘监控按文件报上来的被整条目包着、不单独登记；strm 没生成好也照样带回复制，为等整理压着的放行", async () => {
  const ol: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
  replaceAccounts([a115, aQuark, ol]);
  const copying = { ...tQuark, copyToOpenlist: { enabled: true, dstDir: "/local/kk" } };
  replaceTasks([t115, copying]);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { q: "/quark" } } });
  dQuark.tree.addDir("/kk/Early");
  dQuark.tree.addDir("/kk/Broken");
  const tmdbBefore = readAppSettings().tmdb;
  try {
    const qlist = await post({ action: "list", url: LINK_QUARK });
    const entries = qlist.json().entries as Array<{ id: string; name: string; isDir: boolean; token?: string }>;
    const extras = entries.find((e) => e.name === "Extras")!;

    // 转存完、生成 strm 那几下网盘调用当中，网盘监控按文件报上来一个
    const receivedBefore = dQuark.share!.calls.receive;
    let during: ReturnType<typeof enqueueCopy> | null = null;
    dQuark.beforeCall = async () => {
      if (during || dQuark.share!.calls.receive === receivedBefore) return;
      during = enqueueCopy({ account: "q", sources: [{ path: "/kk/Early/Extras/making.mkv" }], rootPath: "/kk", taskId: "s-quark", trigger: "monitor", dstDir: "/local/kk" });
    };
    const res = await post({ action: "receive", url: LINK_QUARK, taskId: "s-quark", subPath: "Early", mode: "sync", items: [extras] });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().copy?.queued, 1);
    const seen = during as ReturnType<typeof enqueueCopy> | null;
    assert.ok(seen, "生成 strm 时调过网盘");
    assert.equal(seen.queued, 0, "被整条目包着，不单独登记");
    assert.equal(seen.covered, 1);
    assert.deepEqual(listCopies().map((c) => [c.srcDir, c.name, c.trigger]), [["/kk/Early", "Extras", "share"]]);

    // strm 没生成好（转存之后列目录挂了）：复制照样带回来；任务开着直接执行的整理，登记时压着等它，这次不交给整理了就放行
    await stopCopyWatcher();
    clearCopies();
    replaceTasks([t115, { ...copying, organize: { mode: "auto" } }]);
    patchAppSettings({ tmdb: { apiKey: "k" } });
    const brokenBefore = dQuark.share!.calls.receive;
    dQuark.beforeCall = async () => {
      if (dQuark.share!.calls.receive > brokenBefore) throw new Error("风控了");
    };
    const broken = await post({ action: "receive", url: LINK_QUARK, taskId: "s-quark", subPath: "Broken", mode: "sync", items: [extras] });
    assert.notEqual(broken.statusCode, 200);
    assert.equal(broken.json().received, true);
    assert.equal(broken.json().copy?.queued, 1);
    const [c] = listCopies();
    assert.equal(c.name, "Extras");
    assert.equal(c.holdUntil, undefined, "这次没交给整理，不用等它");
    assert.match(c.detail, /这次没交给整理/);
  } finally {
    dQuark.beforeCall = null;
    await stopCopyWatcher();
    clearCopies();
    replaceAccounts([a115, aQuark]);
    replaceTasks([t115, tQuark]);
    patchAppSettings({ openlistCopy: baseline.settings.openlistCopy, tmdb: tmdbBefore });
  }
});

test("这次明确勾了复制、这个账号却没填挂载根：转存前就 400，网盘不碰", async () => {
  const ol: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
  replaceAccounts([a115, aQuark, ol]);
  // 只给夸克填了挂载根，115 账号 a 没填
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { q: "/quark" } } });
  const receivedBefore = d115.share!.calls.receive;
  try {
    const list = await post({ action: "list", url: LINK_115 });
    const readme = (list.json().entries as Array<{ id: string; name: string; isDir: boolean }>).find((e) => e.name === "readme.txt")!;
    const res = await post({ action: "receive", url: LINK_115, taskId: "s-115", mode: "sync", items: [readme], copy: true });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /没法复制到 OpenList：账号 a 还没填「在 OpenList 里的挂载根」/);
    assert.equal(d115.share!.calls.receive, receivedBefore, "转存都没发起：不能转存完了才悄悄不复制");
    assert.equal(listCopies().length, 0);
  } finally {
    replaceAccounts([a115, aQuark]);
    patchAppSettings({ openlistCopy: baseline.settings.openlistCopy });
  }
});

test("receive 带 copyDstDir：复制落在指定的子目录；越界、不复制却给了都是 400，网盘不碰", async () => {
  const ol: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
  replaceAccounts([a115, aQuark, ol]);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { a: "/115" } } });
  const receivedBefore = d115.share!.calls.receive;
  try {
    const list = await post({ action: "list", url: LINK_115 });
    const readme = (list.json().entries as Array<{ id: string; name: string; isDir: boolean }>).find((e) => e.name === "readme.txt")!;
    const outside = await post({ action: "receive", url: LINK_115, taskId: "s-115", mode: "sync", items: [readme], copy: true, copyDstDir: "/elsewhere" });
    assert.equal(outside.statusCode, 400, outside.body);
    assert.equal(outside.json().code, "COPY_DST_INVALID");
    assert.match(outside.json().message, /只能是 \/local\/media/);
    const unused = await post({ action: "receive", url: LINK_115, taskId: "s-115", mode: "sync", items: [readme], copyDstDir: "/local/media/tv" });
    assert.equal(unused.statusCode, 400, unused.body);
    assert.equal(unused.json().code, "COPY_DST_UNUSED");
    assert.equal(d115.share!.calls.receive, receivedBefore, "转存都没发起");
    assert.equal(listCopies().length, 0);

    const res = await post({ action: "receive", url: LINK_115, taskId: "s-115", mode: "sync", items: [readme], copy: true, copyDstDir: "/local/media/tv/" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().copy?.dstDir, "/local/media/tv", "尾斜杠归一");
    const [c] = listCopies();
    assert.equal(c.name, "readme.txt");
    assert.equal(c.dstDir, "/local/media/tv");
  } finally {
    await stopCopyWatcher();
    clearCopies();
    replaceAccounts([a115, aQuark]);
    patchAppSettings({ openlistCopy: baseline.settings.openlistCopy });
  }
});

test("后台模式：同步迟迟起不来（远端目录树导出慢）也先回话，不让前端超时报「保存失败」", async () => {
  __test_setAsyncStartGrace(50);
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  // 只卡住拉远端目录树那一步（115 的整树导出偶尔几分钟不好），转存本身照常
  dQuark.beforeCall = async () => {
    if (dQuark.log.at(-1)?.startsWith("listSubtree")) await gate;
  };
  dQuark.tree.addDir("/kk/Slow");
  try {
    const qlist = await post({ action: "list", url: LINK_QUARK });
    const e02 = (qlist.json().entries as Array<{ id: string; name: string; isDir: boolean; token?: string }>).find((e) => e.name === "E02.mkv")!;
    const t0 = Date.now();
    const res = await post({ action: "receive", url: LINK_QUARK, taskId: "s-quark", subPath: "Slow", mode: "async", items: [e02] });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().mode, "async");
    assert.equal(res.json().taskId, "s-quark", "界面靠它链到任务日志");
    assert.ok(Date.now() - t0 < 3000, "不能等同步拉完目录树才回话");
    assert.ok(dQuark.tree.get("/kk/Slow/E02.mkv"), "转存已经成了");
  } finally {
    release();
    dQuark.beforeCall = null;
    __test_setAsyncStartGrace(null);
    for (let i = 0; i < 100 && isTaskRunning("s-quark"); i++) await new Promise((r) => setTimeout(r, 50));
  }
});

test("receive 的条目名字不能含 / 或是 . / ..：接口层 400，网盘不会被碰", async () => {
  const before = d115.share!.calls.receive;
  for (const name of ["../x.mkv", "a/b.mkv", "..", ""]) {
    const res = await post({ action: "receive", url: LINK_115, taskId: "s-115", subPath: "Show", mode: "sync", items: [{ id: "s-abc-1", name, isDir: false }] });
    assert.equal(res.statusCode, 400, `${JSON.stringify(name)} → ${res.body}`);
  }
  assert.equal(d115.share!.calls.receive, before);
});

test("receive 到网盘目录（不生成 strm）：toDirId 或 toPath 二选一，都没有 400", async () => {
  const list = await post({ action: "list", url: LINK_115 });
  const readme = (list.json().entries as Array<{ id: string; name: string; isDir: boolean }>).find((e) => e.name === "readme.txt")!;
  d115.tree.addDir("/inbox");
  const byPath = await post({ action: "receive", url: LINK_115, toPath: "inbox", items: [readme] });
  assert.equal(byPath.statusCode, 200, byPath.body);
  assert.equal(byPath.json().received, 1);
  assert.ok(d115.tree.get("/inbox/readme.txt"));
  const byId = await post({ action: "receive", url: LINK_115, toDirId: d115.tree.get("/inbox")!.id, items: [readme] });
  assert.equal(byId.statusCode, 200, byId.body);
  assert.equal((await post({ action: "receive", url: LINK_115, items: [readme] })).statusCode, 400);
  assert.equal((await post({ action: "receive", url: LINK_115, toPath: "nope", items: [readme] })).statusCode, 404);
});

test("没有同类账号：说清楚要加哪种账号", async () => {
  replaceAccounts([a115]);
  try {
    const res = await post({ action: "info", url: LINK_QUARK });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /添加一个夸克网盘账号/);
  } finally {
    replaceAccounts([a115, aQuark]);
  }
});
