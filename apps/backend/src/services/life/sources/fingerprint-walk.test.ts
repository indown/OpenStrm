/**
 * 按目录指纹拼树的边角：根换了、旧子项已经在别处列出来、首轮怎么估 recheck、要存的和看到的不一样时挂 recheck。
 * 主要场景（增删改名移动、节流、整棵对比自检）在 quark.itest.ts 里连着快照源一起测。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountInfo } from "@openstrm/shared";
import { FakeDrive, type FakeDriveOptions } from "../../../test/fake-drive.js";
import { fullScan, hasFingerprints, incrementalWalk, markDiverged, type SnapEntry, type SnapMeta } from "./fingerprint-walk.js";

const account: AccountInfo = { accountType: "quark", name: "fw", cookie: "c" };
const signal = new AbortController().signal;

function makeDrive(fingerprints: FakeDriveOptions["fingerprints"] = true): FakeDrive {
  const d = new FakeDrive("quark", account, { fingerprints });
  d.tree.addDir("/r");
  return d;
}
const io = (d: FakeDrive) => ({ dirFingerprints: d.dirFingerprints!, listDir: d.listDir.bind(d) });
const paths = (list: SnapEntry[]) => list.map((e) => e.path).sort();

test("hasFingerprints：有 meta 且每个目录都记了子项数才算新格式", () => {
  const meta: SnapMeta = { rootId: "r", modifiedAt: 1, items: 1, fullAt: 1 };
  assert.equal(hasFingerprints({ entries: [{ path: "a", id: "a", isDir: true, items: 0 }], meta }), true);
  assert.equal(hasFingerprints({ entries: [{ path: "a", id: "a", isDir: true }], meta }), false, "旧格式：目录没有子项数");
  assert.equal(hasFingerprints({ entries: [], meta: null }), false, "没有 meta");
  assert.equal(hasFingerprints({ entries: [{ path: "f", id: "f", isDir: false }], meta }), true, "文件不看子项数");
});

test("markDiverged：要存的和看到的子项不一样的目录挂 recheck，根挂在 meta 上；一样就原样返回", () => {
  const meta: SnapMeta = { rootId: "r", modifiedAt: 1, items: 2, fullAt: 1 };
  const observed: SnapEntry[] = [
    { path: "A", id: "A", isDir: true, items: 1 },
    { path: "A/x", id: "x", isDir: false },
    { path: "B", id: "B", isDir: true, items: 0 },
  ];
  const same = markDiverged(observed, observed, meta);
  assert.equal(same.entries, observed);
  assert.equal(same.meta, meta);

  // A 下的 x 处理失败被剔掉、一个压下的删除 C 留在根下
  const stored: SnapEntry[] = [observed[0]!, observed[2]!, { path: "C", id: "C", isDir: true, items: 0 }];
  const r = markDiverged(stored, observed, meta);
  assert.equal(r.entries.find((e) => e.id === "A")?.recheck, true);
  assert.equal(r.entries.find((e) => e.id === "B")?.recheck, undefined);
  assert.equal(r.meta.recheck, true);
  assert.equal(observed[0]!.recheck, undefined, "不改传进来的条目");
});

test("根按原路径找不到、或者删了重建换了 id：返回 null，交给整棵列", async () => {
  const d = makeDrive();
  d.tree.addFile("/r/A/x.mkv");
  const snap = await fullScan(d, "/r", null, { signal });
  d.tree.move("/r", "/r-renamed");
  assert.equal(await incrementalWalk(io(d), "/r", snap, { signal }), null);
  d.tree.remove("/r-renamed");
  d.tree.addDir("/r");
  assert.equal(await incrementalWalk(io(d), "/r", snap, { signal }), null);
});

test("没列的目录沿用旧子项时，已经在别处列出来的不再算它的，它挂 recheck 下轮重列", async () => {
  const d = makeDrive();
  d.tree.addFile("/r/A/x.mkv");
  d.tree.addDir("/r/B");
  const snap = await fullScan(d, "/r", null, { signal });
  // 绕过指纹规则：x 从 A 挪到 B，A 里补一个 y 让它的子项数和时间都不变——A 看起来没变、不会去列
  const x = d.tree.get("/r/A/x.mkv")!;
  d.tree.nodes.delete("/r/A/x.mkv");
  d.tree.nodes.set("/r/B/x.mkv", x);
  d.tree.nodes.set("/r/A/y.mkv", { id: "y", isDir: false, size: 1 });
  d.tree.get("/r/B")!.modifiedAt = (d.tree.get("/r/B")!.modifiedAt ?? 0) + 1;
  const r = (await incrementalWalk(io(d), "/r", snap, { signal }))!;
  assert.deepEqual(paths(r.entries), ["A", "B", "B/x.mkv"]);
  assert.equal(r.entries.find((e) => e.path === "A")?.recheck, true);
  const next = (await incrementalWalk(io(d), "/r", r, { signal }))!;
  assert.deepEqual(paths(next.entries), ["A", "A/y.mkv", "B", "B/x.mkv"], "下一轮列 A，看到 y");
});

test("首轮整棵列没有上一份可比：updated_at 离现在 10 分钟以内的目录挂 recheck，久的不挂", async () => {
  let now = Date.now() - 3600_000;
  const d = makeDrive({ clock: () => now });
  d.tree.addFile("/r/Old/x.mkv");
  now = Date.now() - 60_000;
  d.tree.addFile("/r/New/y.mkv");
  const r = await fullScan(d, "/r", null, { signal });
  assert.equal(r.entries.find((e) => e.path === "Old")?.recheck, undefined);
  assert.equal(r.entries.find((e) => e.path === "New")?.recheck, true);
  assert.equal(r.meta.recheck, true, "根刚因为 New 刷新过");
  assert.deepEqual(r.misses, []);
});

test("有上一份带指纹的快照时整棵列：只给指纹变了的、新出现的目录挂 recheck", async () => {
  const d = makeDrive();
  d.tree.addFile("/r/A/x.mkv");
  d.tree.addFile("/r/B/y.mkv");
  const first = await fullScan(d, "/r", null, { signal });
  d.tree.addFile("/r/B/z.mkv");
  d.tree.addFile("/r/C/w.mkv");
  const r = await fullScan(d, "/r", first, { signal });
  assert.equal(r.entries.find((e) => e.path === "A")?.recheck, undefined);
  assert.equal(r.entries.find((e) => e.path === "B")?.recheck, true);
  assert.equal(r.entries.find((e) => e.path === "C")?.recheck, true);
  assert.equal(r.meta.recheck, true, "根下多了 C");
  assert.deepEqual(r.misses, [], "变了的目录指纹也变了，不算增量漏掉");
});

test("没有指纹接口的网盘：整棵列照样能用，meta 里根的指纹是空的", async () => {
  const d = makeDrive(false);
  d.tree.addFile("/r/A/x.mkv");
  const r = await fullScan(d, "/r", null, { signal });
  assert.deepEqual(paths(r.entries), ["A", "A/x.mkv"]);
  assert.equal(r.meta.rootId, "");
  assert.equal(hasFingerprints(r), false, "下一轮还是整棵列");
});
