/**
 * 启动阶段的等待：任务在 starting（拉远端目录树）时 waitForTaskStart 挂住，releaseTaskStart 时以启动结果落定；
 * 没在启动立刻返回；客户端断开（signal）也返回并把等待者摘掉。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/task/registry.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Subject, Subscription } from "rxjs";
import { events } from "../events.js";
import {
  cancelRunningTask,
  getRunningTask,
  registerRunningTask,
  releaseTaskStart,
  reserveTaskStart,
  unregisterRunningTask,
  waitForTaskStart,
  type RunningTask,
} from "./registry.js";

/** 30ms 内没落定就当还挂着 */
const settledOrPending = (p: Promise<unknown>) =>
  Promise.race([p.then(() => "settled" as const), new Promise<"pending">((r) => setTimeout(() => r("pending"), 30))]);

test("没在启动的任务：立刻返回 undefined", async () => {
  assert.equal(await waitForTaskStart("idle"), undefined);
});

test("启动中：挂住直到 releaseTaskStart，拿到启动结果；注册进 running 的能查到", async () => {
  assert.equal(reserveTaskStart("t1"), true);
  const wait = waitForTaskStart("t1");
  assert.equal(await settledOrPending(wait), "pending", "拉目录树期间应一直等");
  registerRunningTask("t1", { subject: new Subject(), subscription: new Subscription(), logs: [] });
  releaseTaskStart("t1", { status: 200, message: "3 files to download" });
  assert.deepEqual(await wait, { status: 200, message: "3 files to download" });
  assert.ok(getRunningTask("t1"), "起来了的任务 release 之后 running 里有");
  unregisterRunningTask("t1");
});

test("起不来：release 带失败结果，所有等待者拿到同一份，running 里没有它", async () => {
  reserveTaskStart("t2");
  const a = waitForTaskStart("t2");
  const b = waitForTaskStart("t2");
  releaseTaskStart("t2", { status: 500, message: "账号不存在：ghost" });
  assert.deepEqual(await a, { status: 500, message: "账号不存在：ghost" });
  assert.deepEqual(await b, { status: 500, message: "账号不存在：ghost" });
  assert.equal(getRunningTask("t2"), undefined);
  assert.equal(await waitForTaskStart("t2"), undefined, "启动阶段已结束，再等直接返回");
});

test("客户端断开：signal 中止后立刻返回 undefined，之后 release 没人再等", async () => {
  reserveTaskStart("t3");
  const ac = new AbortController();
  const wait = waitForTaskStart("t3", ac.signal);
  ac.abort();
  assert.equal(await wait, undefined);
  releaseTaskStart("t3", { status: 500, message: "x" });
  const already = new AbortController();
  already.abort();
  reserveTaskStart("t4");
  assert.equal(await waitForTaskStart("t4", already.signal), undefined, "已中止的 signal 不挂");
  releaseTaskStart("t4");
});

test("任务不在跑了就发 task.finished：启动阶段就结束的、跑完的、被取消的各发一次；取消后 runner 收尾不重复发，没占过位的不发", () => {
  const seen: string[] = [];
  const off = events.on("task.finished", ({ taskId }) => seen.push(taskId));
  const fakeRun = (): RunningTask => ({ subject: new Subject(), subscription: new Subscription(), logs: [] });
  try {
    reserveTaskStart("f1");
    releaseTaskStart("f1", { status: 200, message: "no files to download", idle: true });
    assert.deepEqual(seen, ["f1"], "无事可做 / 起不来：启动阶段结束就是结束");

    reserveTaskStart("f2");
    registerRunningTask("f2", fakeRun());
    releaseTaskStart("f2", { status: 200, message: "3 files to download" });
    assert.deepEqual(seen, ["f1"], "起来了：启动阶段结束时还在跑，不发");
    unregisterRunningTask("f2");
    assert.deepEqual(seen, ["f1", "f2"], "跑完发");

    reserveTaskStart("f3");
    registerRunningTask("f3", fakeRun());
    releaseTaskStart("f3", { status: 200, message: "1 file to download" });
    cancelRunningTask("f3");
    unregisterRunningTask("f3");
    assert.deepEqual(seen, ["f1", "f2", "f3"], "取消发一次，runner 收尾再 unregister 不重复发");

    releaseTaskStart("never");
    unregisterRunningTask("never");
    assert.deepEqual(seen, ["f1", "f2", "f3"]);
  } finally {
    off();
  }
});
