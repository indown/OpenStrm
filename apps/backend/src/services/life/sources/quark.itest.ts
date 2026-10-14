/**
 * 直接驱动快照源的 pull：首轮建快照、增删改名各出什么事件、整个目录被清空能收敛、
 * 大比例删除先压一轮再放。网盘是 FakeDrive，快照走真库。
 * 同一组场景按两种走法各跑一遍（每轮整棵列 / 按目录指纹增量），事件必须一样；指纹增量另有一组看代价和兜底。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/life/sources/quark.itest.ts
 */
import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import type { AccountInfo, TaskDefinition } from "@openstrm/shared";
import { deleteDriveSnapshots, readDriveSnapshot, writeDriveSnapshot } from "../../../db/repositories/life.js";
import type { ChangeCursor, ChangeEvent, PullResult } from "../../drive/types.js";
import { FakeDrive, type FakeDriveOptions } from "../../../test/fake-drive.js";
import { __test_resetQuarkSnapshotSource, QuarkSnapshotSource, type SnapEntry, type SnapMeta } from "./quark.js";

const account: AccountInfo = { accountType: "quark", name: "snap", cookie: "c" };
const taskKk: TaskDefinition = { id: "t", account: "snap", accountType: "quark", originPath: "kk", targetPath: "snap-itest", strmPrefix: "/mnt" };
const taskGone: TaskDefinition = { id: "t2", account: "snap", accountType: "quark", originPath: "gone", targetPath: "snap-itest-gone", strmPrefix: "/mnt" };
let tasks: TaskDefinition[] = [taskKk];
let drive: FakeDrive;
let source: QuarkSnapshotSource;
let warned: string[];
const brief = (events: ChangeEvent[]) => events.map((e) => `${e.kind} ${e.oldPath ? `${e.oldPath} -> ` : ""}${e.path}`);

/** 拉一轮：把 changes 解析成完整事件；commit 默认打开（模拟监控处理完这一轮），failed 是处理失败的事件 id */
async function pull(
  cursor: ChangeCursor = { time: 1, id: "latest" },
  { commit = true, failed = [] as string[] } = {},
): Promise<{ events: ChangeEvent[]; raw: PullResult }> {
  const raw = await source.pull(cursor, { tasks, signal: new AbortController().signal, log: (level, msg) => level === "warn" && warned.push(msg) });
  const events = await Promise.all(raw.changes.map((c) => c.resolve()));
  if (commit) raw.commit?.(failed);
  return { events, raw };
}

function setup(fingerprints: FakeDriveOptions["fingerprints"]): void {
  deleteDriveSnapshots("snap");
  __test_resetQuarkSnapshotSource();
  drive = new FakeDrive("quark", account, { fingerprints });
  source = new QuarkSnapshotSource(drive);
  warned = [];
  tasks = [taskKk];
  drive.tree.addDir("/kk");
}

after(() => deleteDriveSnapshots("snap"));

// 没有指纹接口的网盘每轮整棵列；夸克按目录指纹只列变了的目录。同样的网盘变化，两种走法出的事件必须一样
for (const mode of [
  { name: "每轮整棵列", fingerprints: false },
  { name: "按目录指纹增量", fingerprints: true },
]) {
  describe(mode.name, () => {
    beforeEach(() => setup(mode.fingerprints));

    test("首轮只建快照；之后新增 / 改名 / 移动 / 删除各出一条，目录级只报最上层；快照跟着更新", async () => {
      drive.tree.addDir("/kk/S1");
      drive.tree.addFile("/kk/S1/e1.mkv", { size: 1 });
      const first = await pull();
      assert.deepEqual(first.events, []);
      assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 2);

      drive.tree.addFile("/kk/S1/e2.mkv", { size: 1 });
      drive.tree.addDir("/kk/S2");
      drive.tree.addFile("/kk/S2/x.mkv");
      drive.tree.move("/kk/S1/e1.mkv", "/kk/S1/e1 v2.mkv");
      const second = await pull();
      assert.deepEqual(brief(second.events).sort(), ["create /kk/S1/e2.mkv", "create /kk/S2", "rename /kk/S1/e1.mkv -> /kk/S1/e1 v2.mkv"]);
      assert.ok(second.events.every((e) => e.id.startsWith("q:snap:") && e.token === e.nodeId));

      drive.tree.move("/kk/S2", "/kk/S1/S2");
      drive.tree.remove("/kk/S1/e2.mkv");
      const third = await pull();
      assert.deepEqual(brief(third.events), ["remove /kk/S1/e2.mkv", "move /kk/S2 -> /kk/S1/S2"], "删除在搬动前面");
      assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 4);
    });

    test("all 模式首轮把现有条目全当新增（目录只报顶层）", async () => {
      drive.tree.addDir("/kk/S1");
      drive.tree.addFile("/kk/S1/e1.mkv");
      drive.tree.addFile("/kk/top.mkv");
      const r = await pull({ time: 0, id: "all" });
      assert.deepEqual(brief(r.events).sort(), ["create /kk/S1", "create /kk/top.mkv"]);
    });

    test("小目录整个被清空：列到 0 条就是真空了，下一轮直接出删除事件（不会永远跳过）", async () => {
      drive.tree.addDir("/kk/S1");
      for (let i = 1; i <= 7; i++) drive.tree.addFile(`/kk/S1/e${i}.mkv`);
      await pull();
      drive.tree.remove("/kk/S1");
      const r = await pull();
      assert.deepEqual(brief(r.events), ["remove /kk/S1"]);
      assert.deepEqual(warned, []);
      assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 0);
    });

    test("大目录一轮少了三成以上：第一轮只告警不删、快照里留着；第二轮还是这样才出删除事件；中途恢复就作罢", async () => {
      drive.tree.addDir("/kk/S1");
      for (let i = 1; i <= 12; i++) drive.tree.addFile(`/kk/S1/e${i}.mkv`);
      await pull();
      drive.tree.remove("/kk/S1");
      const first = await pull();
      assert.deepEqual(first.events, [], "第一轮压下");
      assert.match(warned[0] ?? "", /13\/13 项消失.*先不删/);
      assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 13, "被压下的删除留在快照里");
      const second = await pull();
      assert.deepEqual(brief(second.events), ["remove /kk/S1"], "第二轮放行");
      assert.match(warned[1] ?? "", /连续两轮/);
      assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 0);

      // 再来一次：压下之后目录原样回来了（同样的 id，比如列目录抖了一下）→ 什么都不报，计数清零，下次再大删还是先压
      drive.tree.addDir("/kk/S1");
      for (let i = 1; i <= 12; i++) drive.tree.addFile(`/kk/S1/e${i}.mkv`);
      await pull();
      const kept = [...drive.tree.nodes].filter(([p]) => p === "/kk/S1" || p.startsWith("/kk/S1/"));
      drive.tree.remove("/kk/S1");
      await pull();
      for (const [p, node] of kept) drive.tree.nodes.set(p, node);
      const back = await pull();
      assert.deepEqual(back.events, [], "原样回来了就当没发生");
      drive.tree.remove("/kk/S1");
      const again = await pull();
      assert.deepEqual(again.events, [], "上一轮已恢复，这轮的大删除重新从压一轮开始");
    });

    test("同名替换：旧 id 的删除排在新 id 的新增前面；目录搬进新建目录时先搬再建", async () => {
      drive.tree.addDir("/kk/S1");
      drive.tree.addFile("/kk/S1/e1.mkv");
      drive.tree.addDir("/kk/A");
      drive.tree.addFile("/kk/A/x.mkv");
      await pull();
      // S1 整个删掉再建同名的（新 id）；A 搬进新建的 N 里
      drive.tree.remove("/kk/S1");
      drive.tree.addDir("/kk/S1");
      drive.tree.addFile("/kk/S1/e1.mkv");
      drive.tree.addDir("/kk/N");
      drive.tree.move("/kk/A", "/kk/N/A");
      const { events } = await pull();
      assert.deepEqual(brief(events), ["remove /kk/S1", "move /kk/A -> /kk/N/A", "create /kk/N", "create /kk/S1"]);
    });

    test("快照要等 commit 才落库：没 commit 的一轮，下一轮拿旧快照重新对比、事件再出一遍；游标一直带着模式", async () => {
      drive.tree.addFile("/kk/a.mkv");
      const first = await pull({ time: 0, id: "all" });
      assert.deepEqual(brief(first.events), ["create /kk/a.mkv"]);
      assert.equal(first.raw.cursor.id, "all", "模式跟着游标走，后来才扫到的根照样按 all 建快照");
      drive.tree.addFile("/kk/b.mkv");
      const uncommitted = await pull({ time: 1, id: "all" }, { commit: false });
      assert.deepEqual(brief(uncommitted.events), ["create /kk/b.mkv"]);
      assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 1, "没 commit，库里还是上一轮的快照");
      const again = await pull({ time: 2, id: "all" });
      assert.deepEqual(brief(again.events), ["create /kk/b.mkv"], "重新对比，同样的事件再出一遍");
      assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 2);
      const quiet = await pull({ time: 3, id: "all" });
      assert.deepEqual(quiet.events, []);
    });

    test("某个根列不了：记进 warnings 跳过它，别的根照常出事件，commit 只写好的根的快照；根回来后按模式建快照", async () => {
      tasks = [taskKk, taskGone];
      drive.tree.addFile("/kk/a.mkv");
      const first = await pull({ time: 0, id: "all" });
      assert.deepEqual(brief(first.events), ["create /kk/a.mkv"]);
      assert.match(first.raw.warnings?.[0] ?? "", /^\/gone 列目录失败：/);
      assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 1);
      assert.equal(readDriveSnapshot<SnapEntry>("snap", "/gone"), null);

      drive.tree.addDir("/gone");
      drive.tree.addFile("/gone/g.mkv");
      const second = await pull({ time: 1, id: "all" });
      assert.equal(second.raw.warnings, undefined);
      assert.deepEqual(brief(second.events), ["create /gone/g.mkv"], "根回来了，第一次扫到按 all 模式把现有的当新增");
      assert.equal(readDriveSnapshot<SnapEntry>("snap", "/gone")?.entries.length, 1);
    });

    test("删除阀门碰上同名替换：替换的那份不算消失、照常先删后建；真正消失的才压一轮", async () => {
      drive.tree.addDir("/kk/S1");
      for (let i = 1; i <= 6; i++) drive.tree.addFile(`/kk/S1/e${i}.mkv`);
      drive.tree.addDir("/kk/S2");
      for (let i = 1; i <= 6; i++) drive.tree.addFile(`/kk/S2/e${i}.mkv`);
      await pull();
      // S1 删了再转存同名的（新 id）；S2 真的删了
      drive.tree.remove("/kk/S1");
      drive.tree.addDir("/kk/S1");
      for (let i = 1; i <= 6; i++) drive.tree.addFile(`/kk/S1/e${i}.mkv`);
      drive.tree.remove("/kk/S2");
      const first = await pull();
      assert.deepEqual(brief(first.events), ["remove /kk/S1", "create /kk/S1"], "同名替换照常先删后建；S2 的删除先压下");
      assert.match(warned[0] ?? "", /7\/14 项消失/);
      const second = await pull();
      assert.deepEqual(brief(second.events), ["remove /kk/S2"], "第二轮只放行真正消失的 S2，不会再删已经换好的 S1");
      assert.equal(readDriveSnapshot<SnapEntry>("snap", "/kk")?.entries.length, 7);
    });

    test("处理失败的变更不进新快照：下一轮重新对比会再发一次；成功的不再发", async () => {
      drive.tree.addFile("/kk/a.mkv");
      await pull();
      drive.tree.addDir("/kk/New");
      drive.tree.addFile("/kk/New/n.mkv");
      drive.tree.addFile("/kk/b.mkv");
      drive.tree.remove("/kk/a.mkv");
      const r = await pull({ time: 1, id: "latest" }, { commit: false });
      assert.deepEqual(brief(r.events), ["remove /kk/a.mkv", "create /kk/b.mkv", "create /kk/New"]);
      const failedNew = r.events.find((e) => e.path === "/kk/New")!.id;
      const failedRemove = r.events.find((e) => e.kind === "remove")!.id;
      r.raw.commit?.([failedNew, failedRemove]);
      const again = await pull();
      assert.deepEqual(brief(again.events), ["remove /kk/a.mkv", "create /kk/New"], "失败的两条再来一次，b.mkv 已经记进快照不再发");
      assert.deepEqual((await pull()).events, []);
    });

    test("某个根列不了：目录不存在只是 warning；cookie 失效这类账号错误原样抛出去让监控告警退避", async () => {
      tasks = [taskKk, taskGone];
      drive.tree.addFile("/kk/a.mkv");
      const r = await pull({ time: 0, id: "all" });
      assert.deepEqual(brief(r.events), ["create /kk/a.mkv"]);
      assert.match(r.raw.warnings?.[0] ?? "", /^\/gone 列目录失败/);
      drive.failWith = new Error("require login [guest]");
      await assert.rejects(pull(), /require login/);
    });
  });
}

/** 从现在起网盘调用的增量：问了几次指纹（50 个路径一次）、列了几个目录、整棵列了几次 */
function counter(): () => { fp: number; list: number; walk: number } {
  const start = { ...drive.calls };
  return () => ({
    fp: drive.calls.fingerprints - start.fingerprints,
    list: drive.calls.listDir - start.listDir,
    walk: drive.calls.walkSubtree - start.walkSubtree,
  });
}

/** 一部两季的剧 + 一部电影；拉两轮：首轮整棵列建快照，第二轮是第一次增量 */
async function baseline(): Promise<void> {
  drive.tree.addFile("/kk/Show/S1/e1.mkv");
  drive.tree.addFile("/kk/Show/S1/e2.mkv");
  drive.tree.addFile("/kk/Show/S2/e1.mkv");
  drive.tree.addFile("/kk/Movie/m.mkv");
  await pull();
  await pull();
}

describe("按目录指纹增量：只列变了的目录，靠 recheck 和整棵对比兜底", () => {
  beforeEach(() => setup(true));

  test("没有变化的一轮：只问一次指纹，不列目录，快照不重写；最短间隔 60 秒", async () => {
    await baseline();
    const snap = readDriveSnapshot<SnapEntry, SnapMeta>("snap", "/kk")!;
    writeDriveSnapshot("snap", "/kk", snap.entries, 1, snap.meta!);
    const used = counter();
    assert.deepEqual((await pull()).events, []);
    assert.deepEqual(used(), { fp: 1, list: 0, walk: 0 });
    assert.equal(readDriveSnapshot("snap", "/kk")?.scannedAt, 1, "一个目录都没列，快照原样");
    assert.equal(source.minIntervalSeconds, 60);
  });

  test("季目录里加一集：只列那个季目录；下一轮因为刚变过再列一次，之后就不列了", async () => {
    await baseline();
    drive.tree.addFile("/kk/Show/S1/e3.mkv");
    let used = counter();
    assert.deepEqual(brief((await pull()).events), ["create /kk/Show/S1/e3.mkv"]);
    assert.deepEqual(used(), { fp: 1, list: 1, walk: 0 });
    used = counter();
    assert.deepEqual((await pull()).events, []);
    assert.deepEqual(used(), { fp: 1, list: 1, walk: 0 }, "recheck：隔一轮再列一次");
    used = counter();
    await pull();
    assert.deepEqual(used(), { fp: 1, list: 0, walk: 0 });
  });

  test("删一集：父目录的时间不变，靠子项数发现", async () => {
    await baseline();
    const before = drive.tree.get("/kk/Show/S1")!.modifiedAt;
    drive.tree.remove("/kk/Show/S1/e1.mkv");
    assert.equal(drive.tree.get("/kk/Show/S1")!.modifiedAt, before, "夸克删除不刷新父目录的时间");
    const used = counter();
    assert.deepEqual(brief((await pull()).events), ["remove /kk/Show/S1/e1.mkv"]);
    assert.deepEqual(used(), { fp: 1, list: 1, walk: 0 });
  });

  test("节流窗口里的改名：父目录时间和子项数都没变，这一轮看不到，下一轮靠 recheck 补上", async () => {
    let now = Date.UTC(2026, 0, 1);
    drive = new FakeDrive("quark", account, { fingerprints: { throttleMs: 5500, clock: () => now } });
    source = new QuarkSnapshotSource(drive);
    drive.tree.addDir("/kk");
    now += 10_000;
    drive.tree.addFile("/kk/S1/e1.mkv");
    now += 10_000;
    await pull();
    await pull();
    drive.tree.addFile("/kk/S1/e2.mkv");
    assert.deepEqual(brief((await pull()).events), ["create /kk/S1/e2.mkv"]);
    now += 2_000;
    const stamp = drive.tree.get("/kk/S1")!.modifiedAt;
    drive.tree.move("/kk/S1/e2.mkv", "/kk/S1/e2 v2.mkv");
    assert.equal(drive.tree.get("/kk/S1")!.modifiedAt, stamp, "2 秒前刚刷新过：节流，父目录的时间不动");
    assert.deepEqual(brief((await pull()).events), ["rename /kk/S1/e2.mkv -> /kk/S1/e2 v2.mkv"]);
    const used = counter();
    assert.deepEqual((await pull()).events, []);
    assert.equal(used().list, 0, "补上之后不再列");
  });

  test("剧目录改名：只列根和它自己，季目录的指纹没变、沿用快照不重列", async () => {
    await baseline();
    drive.tree.move("/kk/Show", "/kk/Show 2");
    const used = counter();
    assert.deepEqual(brief((await pull()).events), ["rename /kk/Show -> /kk/Show 2"]);
    assert.deepEqual(used(), { fp: 1, list: 2, walk: 0 });
    const paths = readDriveSnapshot<SnapEntry>("snap", "/kk")!.entries.map((e) => e.path);
    assert.ok(paths.includes("Show 2/S1/e1.mkv") && !paths.some((p) => p.startsWith("Show/")), "子树沿用快照，路径换了前缀");
    // 存的是根目录列表里看到的、列它之前的指纹：下一轮只因为刚变过再列一次，之后不再列
    let after = counter();
    await pull();
    assert.equal(after().list, 2, "根和 Show 2 各 recheck 一次");
    after = counter();
    await pull();
    assert.equal(after().list, 0);
  });

  test("挪出任务目录：按删除走", async () => {
    await baseline();
    drive.tree.move("/kk/Movie", "/elsewhere/Movie");
    assert.deepEqual(brief((await pull()).events), ["remove /kk/Movie"]);
  });

  test("新转存进来一整棵：从新目录往下整棵列，只报最上层", async () => {
    await baseline();
    drive.tree.addFile("/kk/New/S1/e1.mkv");
    drive.tree.addFile("/kk/New/S1/e2.mkv");
    const used = counter();
    assert.deepEqual(brief((await pull()).events), ["create /kk/New"]);
    assert.deepEqual(used(), { fp: 1, list: 3, walk: 0 }, "根、New、New/S1");
  });

  test("path_list 认不出某个目录：退到列它的上级，事件照样对，之后每轮多列一次上级", async () => {
    await baseline();
    drive.fingerprintMiss = (p) => p === "/kk/Show/S1";
    drive.tree.addFile("/kk/Show/S1/e3.mkv");
    let used = counter();
    assert.deepEqual(brief((await pull()).events), ["create /kk/Show/S1/e3.mkv"]);
    assert.deepEqual(used(), { fp: 1, list: 2, walk: 0 }, "Show 和 S1");
    await pull();
    used = counter();
    assert.deepEqual((await pull()).events, []);
    assert.deepEqual(used(), { fp: 1, list: 1, walk: 0 }, "只列 Show 看 S1 的指纹");
  });

  test("子目录超过 100 个的大平铺目录：每轮直接列它，不逐个问子目录的指纹", async () => {
    for (let i = 1; i <= 120; i++) drive.tree.addFile(`/kk/d${i}/m.mkv`);
    await pull();
    await pull();
    let used = counter();
    assert.deepEqual((await pull()).events, []);
    assert.deepEqual(used(), { fp: 1, list: 1, walk: 0 }, "只问根自己的指纹，列根一次");
    drive.tree.addFile("/kk/d7/extra.mkv");
    used = counter();
    assert.deepEqual(brief((await pull()).events), ["create /kk/d7/extra.mkv"]);
    assert.deepEqual(used(), { fp: 1, list: 2, walk: 0 });
  });

  test("首轮（all 模式）处理失败的新增：快照里剔掉它，根挂 recheck，下一轮重列重发", async () => {
    drive.tree.addFile("/kk/Show/S1/e1.mkv");
    const r = await pull({ time: 0, id: "all" }, { commit: false });
    assert.deepEqual(brief(r.events), ["create /kk/Show"]);
    r.raw.commit?.([r.events[0]!.id]);
    const snap = readDriveSnapshot<SnapEntry, SnapMeta>("snap", "/kk")!;
    assert.deepEqual(snap.entries, []);
    assert.equal(snap.meta?.recheck, true, "根下的 Show 没处理成：根的指纹没变也要重列");
    assert.deepEqual(brief((await pull({ time: 1, id: "all" })).events), ["create /kk/Show"]);
    assert.deepEqual((await pull({ time: 2, id: "all" })).events, []);
  });

  test("旧格式的快照（目录没记子项数）：第一轮整棵列补上指纹，之后按增量", async () => {
    drive.tree.addFile("/kk/S1/e1.mkv");
    const s1 = drive.tree.get("/kk/S1")!;
    const e1 = drive.tree.get("/kk/S1/e1.mkv")!;
    writeDriveSnapshot(
      "snap",
      "/kk",
      [
        { path: "S1", id: s1.id, isDir: true, modifiedAt: s1.modifiedAt },
        { path: "S1/e1.mkv", id: e1.id, isDir: false, size: 1, modifiedAt: e1.modifiedAt },
      ],
      1,
    );
    let used = counter();
    assert.deepEqual((await pull()).events, []);
    assert.equal(used().walk, 1);
    const snap = readDriveSnapshot<SnapEntry, SnapMeta>("snap", "/kk")!;
    assert.equal(snap.meta?.rootId, drive.tree.get("/kk")!.id);
    assert.ok(snap.entries.every((e) => !e.isDir || typeof e.items === "number"));
    used = counter();
    await pull();
    assert.equal(used().walk, 0);
  });

  test("每 12 小时整棵对比一次：增量漏掉的（指纹没变、子项却变了）被自检发现并照常处理", async () => {
    await baseline();
    // 绕过指纹规则改个名（真网盘上不会这样）：S1 的时间和子项数都不变，增量看不出来
    const node = drive.tree.get("/kk/Show/S1/e1.mkv")!;
    drive.tree.nodes.delete("/kk/Show/S1/e1.mkv");
    drive.tree.nodes.set("/kk/Show/S1/e1 renamed.mkv", node);
    assert.deepEqual((await pull()).events, [], "增量看不出来");
    const snap = readDriveSnapshot<SnapEntry, SnapMeta>("snap", "/kk")!;
    writeDriveSnapshot("snap", "/kk", snap.entries, snap.scannedAt, { ...snap.meta!, fullAt: Date.now() - 13 * 3600_000 });
    const used = counter();
    assert.deepEqual(brief((await pull()).events), ["rename /kk/Show/S1/e1.mkv -> /kk/Show/S1/e1 renamed.mkv"]);
    assert.equal(used().walk, 1);
    assert.match(warned.join("\n"), /整棵对比发现增量漏掉的变化：1 个目录（Show\/S1）/);
    const after12h = counter();
    await pull();
    assert.equal(after12h().walk, 0, "整棵对比之后又回到增量");
  });

  test("任务目录本身被改名：按原路径找不到，整棵列报 warning、快照不动", async () => {
    await baseline();
    drive.tree.move("/kk", "/kk2");
    const r = await pull();
    assert.deepEqual(r.events, []);
    assert.match(r.raw.warnings?.[0] ?? "", /^\/kk 列目录失败/);
    assert.ok(readDriveSnapshot("snap", "/kk"), "快照留着，改回来还能接着用");
  });
});
