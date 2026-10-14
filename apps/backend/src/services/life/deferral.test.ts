/**
 * 全量同步在跑时监控的闸：哪些事件得等（落在正在同步的任务目录里，或者和前面在等的交叠），说明写什么，先后怎么保住。
 * 记下、补、失败重试连着监控循环一起在 monitor.itest.ts 里测。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DeferralGate, eventPaths, pathsOverlap } from "./deferral.js";

test("pathsOverlap：相等、一个在另一个下面算交叠；只是名字前缀相同的兄弟不算；根和谁都交叠；带不带前导 / 都认", () => {
  assert.equal(pathsOverlap("/tv", "/tv"), true);
  assert.equal(pathsOverlap("/tv/Show/e1.mkv", "/tv"), true);
  assert.equal(pathsOverlap("/tv", "/tv/Show"), true, "事件是任务目录的上级（整个 tv 改名）也算");
  assert.equal(pathsOverlap("/tv2/x.mkv", "/tv"), false);
  assert.equal(pathsOverlap("/movie", "/tv"), false);
  assert.equal(pathsOverlap("/", "/tv"), true);
  assert.equal(pathsOverlap("tv/Show", "/tv/"), true);
});

test("eventPaths：改名 / 移动带上旧路径；新增、删除只有一条；新旧一样的只算一条", () => {
  assert.deepEqual(eventPaths({ path: "/tv/b.mkv", oldPath: "/tv/a.mkv" }), ["/tv/b.mkv", "/tv/a.mkv"]);
  assert.deepEqual(eventPaths({ path: "/tv/a.mkv", oldPath: null }), ["/tv/a.mkv"]);
  assert.deepEqual(eventPaths({ path: "/tv/a.mkv", oldPath: "/tv/a.mkv" }), ["/tv/a.mkv"]);
});

test("落在正在同步的任务目录里的要等，说明里带上是哪个目录；别的目录照常", () => {
  const gate = new DeferralGate(() => ["/tv"]);
  assert.equal(gate.check({ path: "/tv/Show/e1.mkv", oldPath: null }), "同步任务在跑（/tv），等它跑完再处理");
  assert.equal(gate.check({ path: "/movie/m.mkv", oldPath: null }), null);
  assert.match(gate.check({ path: "/tv", oldPath: null }) ?? "", /同步任务在跑/, "任务目录自己被删也等");
});

test("先后不乱：前面在等的事件动到的路径，后面碰到同一处的跟着等，哪怕它自己不在同步的目录里", () => {
  const gate = new DeferralGate(() => ["/tv"]);
  // 从同步的目录挪到外面：挪的这条要等，之后外面那个文件上的改名也得排在它后面
  assert.ok(gate.check({ path: "/other/e1.mkv", oldPath: "/tv/Show/e1.mkv" }));
  assert.equal(gate.check({ path: "/other/e1 v2.mkv", oldPath: "/other/e1.mkv" }), "同一处前面还有没补上的变化，按先后跟着等");
  assert.equal(gate.check({ path: "/other/unrelated.mkv", oldPath: null }), null, "不交叠的照常");
});

test("补失败的事件用 hold 挡住后面同一处的；同步的目录每次现问——同步中途结束，后面的就不再因为它等", () => {
  let busy = ["/tv"];
  const gate = new DeferralGate(() => busy);
  busy = [];
  gate.hold({ path: "/tv/Show/info.nfo", oldPath: null });
  assert.ok(gate.check({ path: "/tv/Show/info.nfo", oldPath: null }), "补失败的那个文件上后来的事件跟着等");
  assert.equal(gate.check({ path: "/tv/Show/e2.mkv", oldPath: null }), null, "同步已经结束，同目录里别的文件照常");
  busy = ["/movie"];
  assert.match(gate.check({ path: "/movie/m.mkv", oldPath: null }) ?? "", /（\/movie）/);
});
