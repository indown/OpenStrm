/**
 * 复制完删源，走真的 Provider（FakeDrive），不打桩。
 * copy.itest 把 removeSource / listDriveChildren 换成了桩，这条不可逆的路子只有这里覆盖：
 * 整理把文件挪走之后不能删错、目录没复制全不能删、删的是不是那个节点。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/copy/remove-source.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../paths.js";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { setDriveProviderFactory } from "../drive/registry.js";
import { FakeDrive } from "../../test/fake-drive.js";
import type { OpenlistTaskInfo } from "../openlist/client.js";
import { flushMountRefresh, setMountRefreshDeps, startMountRefresh, stopMountRefresh } from "../mount-cache/refresh.js";
import { fakeMountTarget } from "../../test/fake-mount-target.js";
import type { DriveEntry, DriveNode } from "../drive/types.js";
import { __test_resetCopy, enqueueCopy, listCopies, setCopyServiceDeps, stopCopyWatcher, tickCopies } from "./service.js";

let baseline: { accounts: AccountInfo[]; tasks: TaskDefinition[]; openlistCopy: AppSettings["openlistCopy"] };
const account: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const olAccount: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
const drive = new FakeDrive("115", account);

/**
 * 115 那样的目录缓存：按路径找文件看的是进程内缓存的目录清单，列目录不带 fresh 拿的也是那份。
 * snapshot 之后再加进来的文件，缓存里没有（真机撞到：转存弹框刚列过任务目录，接着转存进来的文件钉不住节点）
 */
class CachedListingDrive extends FakeDrive {
  private readonly cached = new Map<string, DriveEntry[]>();
  async snapshot(dir: string): Promise<void> {
    const id = this.tree.get(dir)!.id;
    this.cached.set(id, await super.listDir(id));
  }
  override async listDir(id: string, signal?: AbortSignal, opts?: { fresh?: boolean }): Promise<DriveEntry[]> {
    if (!opts?.fresh && this.cached.has(id)) return this.cached.get(id)!;
    return super.listDir(id, signal);
  }
  override async resolvePath(path: string, signal?: AbortSignal): Promise<DriveNode | null> {
    const node = this.tree.get(path);
    if (!node || node.isDir) return super.resolvePath(path, signal);
    const parent = this.tree.get(path.slice(0, path.lastIndexOf("/")) || "/");
    const listing = parent ? await this.listDir(parent.id, signal) : [];
    const hit = listing.find((e) => e.name === path.slice(path.lastIndexOf("/") + 1));
    return hit ? { id: hit.id, isDir: hit.isDir } : null;
  }
}

/** OpenList 那一侧仍然是桩：这条测试关心的是网盘那一侧 */
let names: Record<string, string[]> = {};
/** 复制跑完之后目标目录变成什么样（提交前目标必须是空的，不然会被当成「复制过了」跳过） */
let afterCopy: Record<string, string[]> = {};
/** 复制期间网盘上发生的事（整理把源文件挪走、换成同名的另一个） */
let duringCopy: (() => void) | null = null;
let now = 1_800_000_000_000;

const olTask = (over: Partial<OpenlistTaskInfo> = {}): OpenlistTaskInfo => ({
  id: "tid1", name: "copy", state: 2, progress: 100, error: "", endedAt: now, ...over,
});

/** 本地镜像着 /tv 的任务（删源之后要把对应的 strm 一起删掉） */
const localTask: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "copy-remove-itest/tv", strmPrefix: "/mnt" };
const LOCAL = path.join(DATA_DIR, "copy-remove-itest", "tv");
function localFile(rel: string): string {
  const full = path.join(LOCAL, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "/mnt/x");
  return full;
}

/** 登记 → 提交 → 报完成，一路跑到删源那一步 */
async function copyThrough(source: { path: string; isDir?: boolean; nodeId?: string }): Promise<void> {
  enqueueCopy({ account: "acc", sources: [source], rootPath: "/tv", taskId: "t1", trigger: "monitor", afterCopy: "delete" });
  await stopCopyWatcher();
  now += 30_000;
  await tickCopies(); // 阶段一：源在 OpenList 里可见 → 提交
  await tickCopies(); // 阶段二：任务已结束 → done → 删源
}

before(() => {
  baseline = { accounts: listAccounts(), tasks: listTasks(), openlistCopy: readAppSettings().openlistCopy };
  replaceAccounts([account, olAccount]);
  replaceTasks([]);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { acc: "/115" } } });
  setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  setCopyServiceDeps({
    openlist: {
      listNames: async (_cfg, dir) => names[dir] ?? [],
      mkdir: async () => {},
      copy: async () => {
        Object.assign(names, afterCopy);
        duringCopy?.();
        return [olTask({ state: 1, endedAt: null })];
      },
      copyTasks: async () => ({ undone: [], done: [olTask()] }),
    },
    notify: async () => {},
    now: () => now,
    embyRefresh: () => {},
    // removeSource / listDriveChildren 故意不给：就是要跑真的那两个
  });
});

beforeEach(async () => {
  await __test_resetCopy();
  drive.tree.nodes.clear();
  drive.calls.remove = 0;
  drive.log.length = 0;
  names = {};
  afterCopy = {};
  duringCopy = null;
});

after(async () => {
  fs.rmSync(path.join(DATA_DIR, "copy-remove-itest"), { recursive: true, force: true });
  await __test_resetCopy();
  setCopyServiceDeps(null);
  setDriveProviderFactory(null);
  replaceAccounts(baseline.accounts);
  replaceTasks(baseline.tasks);
  patchAppSettings({ openlistCopy: baseline.openlistCopy });
});

test("文件复制完：网盘上那份真的删掉了", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };

  // 任务目录在本地镜像着：删源之后这条 strm 指着的就是一个不存在的文件
  replaceTasks([localTask]);
  const strm = localFile("某剧/S01/E01.strm");
  try {
    await copyThrough({ path: "/tv/某剧/S01/E01.mkv" });
  } finally {
    replaceTasks([]);
  }

  const [c] = listCopies();
  assert.equal(c.status, "done");
  assert.match(c.detail, /网盘上那份已删，本地 strm 也删了/);
  assert.equal(drive.tree.get("/tv/某剧/S01/E01.mkv"), undefined, "源文件该没了");
  assert.equal(fs.existsSync(strm), false, "115 的监控对不上自己删的文件（路径缓存当场就清了），不能指望它来收拾");
});

test("整理把同名文件换成了另一个：nodeId 对不上就不删", async () => {
  const node = drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };

  // 登记时记下的是这个 id，复制期间整理把它挪走、原地又出现了一个同名的
  drive.tree.remove("/tv/某剧/S01/E01.mkv");
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");

  await copyThrough({ path: "/tv/某剧/S01/E01.mkv", nodeId: node.id });

  assert.match(listCopies()[0].detail, /换成了别的文件，没删/);
  assert.ok(drive.tree.get("/tv/某剧/S01/E01.mkv"), "换过的那份不能删");
  assert.equal(drive.calls.remove, 0);
});

test("源已经不在原处（复制期间被挪走了）：什么都不删", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
  duringCopy = () => drive.tree.remove("/tv/某剧/S01/E01.mkv");
  await copyThrough({ path: "/tv/某剧/S01/E01.mkv" });
  assert.match(listCopies()[0].detail, /已不在原处，没删/);
  assert.equal(drive.calls.remove, 0);
});

test("提交时网盘上就没有这个路径（OpenList 的缓存还留着）：复制照走，删源关掉并说明", async () => {
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
  await copyThrough({ path: "/tv/某剧/S01/E01.mkv" });
  const [c] = listCopies();
  assert.equal(c.status, "done");
  assert.match(c.detail, /核对不了，源文件没动/);
  assert.equal(drive.calls.remove, 0);
});

test("没带节点 id 的（追更、115 转存）：提交时钉住，复制期间被换成同名的另一个就不删", async () => {
  const original = drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
  duringCopy = () => {
    drive.tree.remove("/tv/某剧/S01/E01.mkv");
    drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  };
  await copyThrough({ path: "/tv/某剧/S01/E01.mkv" });
  const [c] = listCopies();
  assert.equal(c.nodeId, original.id, "钉的是提交那一刻路径上的那一份");
  assert.match(c.detail, /换成了别的文件，没删/);
  assert.equal(drive.calls.remove, 0);
});

test("目录只复制了一半：一层子项对不上就不删", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  drive.tree.addFile("/tv/某剧/S01/E02.mkv");
  names = { "/115/tv/某剧": ["S01"] };
  // E02 还没搬过去
  afterCopy = { "/local/media/某剧": ["S01"], "/local/media/某剧/S01": ["E01.mkv"] };

  await copyThrough({ path: "/tv/某剧/S01", isDir: true });

  assert.match(listCopies()[0].detail, /目标里少了 1 项/);
  assert.ok(drive.tree.get("/tv/某剧/S01/E02.mkv"), "没复制全的目录一个都不能删");
  assert.equal(drive.calls.remove, 0);
});

test("目录复制全了：整个目录删掉", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  drive.tree.addFile("/tv/某剧/S01/E02.mkv");
  names = { "/115/tv/某剧": ["S01"] };
  afterCopy = { "/local/media/某剧": ["S01"], "/local/media/某剧/S01": ["E01.mkv", "E02.mkv"] };

  replaceTasks([localTask]);
  const e01 = localFile("某剧/S01/E01.strm");
  localFile("某剧/S01/E02.strm");
  const other = localFile("某剧/S02/E01.strm");
  try {
    await copyThrough({ path: "/tv/某剧/S01", isDir: true });
  } finally {
    replaceTasks([]);
  }

  assert.match(listCopies()[0].detail, /网盘上那份已删，本地 strm 也删了/);
  assert.equal(drive.tree.get("/tv/某剧/S01"), undefined);
  assert.equal(fs.existsSync(path.dirname(e01)), false, "本地同名目录整个删掉");
  assert.equal(fs.existsSync(other), true, "别的季不碰");
});

test("网盘删不了（报错）：复制仍然算成功，只在说明里写一句", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
  drive.failWriteOn = (op) => (op === "remove" ? new Error("回收站满了") : null);

  try {
    await copyThrough({ path: "/tv/某剧/S01/E01.mkv" });
  } finally {
    drive.failWriteOn = null;
  }

  const [c] = listCopies();
  assert.equal(c.status, "done", "复制本身成了，删源失败不该翻案");
  assert.match(c.detail, /删源文件失败：回收站满了/);
});

test("没开删源开关：一个网盘写操作都不做", async () => {
  drive.tree.addFile("/tv/某剧/S01/E01.mkv");
  names = { "/115/tv/某剧/S01": ["E01.mkv"] };
  afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };

  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", trigger: "monitor" });
  await stopCopyWatcher();
  now += 30_000;
  await tickCopies();
  await tickCopies();

  assert.equal(listCopies()[0].status, "done");
  assert.ok(drive.tree.get("/tv/某剧/S01/E01.mkv"), "没开开关就别碰源文件");
  assert.equal(drive.calls.remove, 0);
});

test("115 式目录缓存：缓存里的清单还没有刚转存的文件，钉节点和删源都得绕开缓存去找", async () => {
  const cachedDrive = new CachedListingDrive("115", account);
  cachedDrive.tree.addDir("/tv/某剧/S01");
  await cachedDrive.snapshot("/tv/某剧/S01"); // 转存弹框先列过：这时目录还是空的
  const node = cachedDrive.tree.addFile("/tv/某剧/S01/E01.mkv");
  setDriveProviderFactory((a) => (a.name === "acc" ? cachedDrive : null));
  try {
    names = { "/115/tv/某剧/S01": ["E01.mkv"] };
    afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
    await copyThrough({ path: "/tv/某剧/S01/E01.mkv" });
    const [c] = listCopies();
    assert.equal(c.nodeId, node.id, "提交时要钉得住：按缓存找就是 null，删源会被关掉");
    assert.match(c.detail, /网盘上那份已删/);
    assert.equal(cachedDrive.tree.get("/tv/某剧/S01/E01.mkv"), undefined);
  } finally {
    setDriveProviderFactory((a) => (a.name === "acc" ? drive : null));
  }
});

test("删源之后让 OpenList 刷新源目录连同上级：经 OpenList 挂载回源的别再看到已删的文件", async () => {
  const listed: string[] = [];
  setMountRefreshDeps({ targets: () => [fakeMountTarget({ mounts: { acc: "/115" }, listed })], quietMs: 10 });
  startMountRefresh();
  try {
    drive.tree.addFile("/tv/某剧/S01/E01.mkv");
    names = { "/115/tv/某剧/S01": ["E01.mkv"] };
    afterCopy = { "/local/media/某剧/S01": ["E01.mkv"] };
    await copyThrough({ path: "/tv/某剧/S01/E01.mkv" });
    assert.match(listCopies()[0].detail, /网盘上那份已删/);
    await flushMountRefresh();
    assert.deepEqual(listed, ["/115/tv/某剧/S01"], "只刷源文件所在的目录；挂载根来自设置页「网盘挂载」里的 OpenList");
  } finally {
    stopMountRefresh();
    setMountRefreshDeps(null);
  }
});
