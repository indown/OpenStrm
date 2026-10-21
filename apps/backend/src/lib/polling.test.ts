/**
 *   pnpm test:file src/lib/polling.test.ts
 *
 * 间隔取到毫秒级，靠真实时钟推进；断言都留了余量，不卡具体时刻。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPollingLoop } from "./polling.js";
import { moduleLogger } from "./logger.js";

const log = moduleLogger("polling-test");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("例行按间隔跑；stop 之后不再跑，并等在跑的那一轮收尾", async () => {
  let ticks = 0;
  let finished = 0;
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 20,
    tick: async () => {
      ticks++;
      await wait(30);
      finished++;
    },
  });
  loop.start();
  assert.equal(loop.running, true, "start 之后同步就该是运行中");
  await wait(200);
  const seen = ticks;
  assert.ok(seen >= 2, `200ms 里至少该跑两轮，实际 ${seen}`);
  await loop.stop();
  assert.equal(loop.running, false);
  assert.equal(finished, seen, "stop 要等最后一轮收尾");
  await wait(60);
  assert.equal(ticks, seen, "停了就不该再有新的一轮");
});

test("stop 会中止交给 tick 的 signal：挂着的长活儿立刻退出，不算失败", async () => {
  let aborted = false;
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 5,
    tick: (signal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  });
  loop.start();
  await wait(20);
  const t0 = Date.now();
  await loop.stop();
  assert.ok(Date.now() - t0 < 500, "不用等那两秒");
  assert.equal(aborted, true);
  assert.equal(loop.lastError, null, "被 stop 掐断的不算失败");
});

test("backoffBaseMs：间隔为 0 的长轮询失败后按基数退避，不是按 0 退避", async () => {
  const at: number[] = [];
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 0,
    backoffBaseMs: 30,
    maxBackoffMs: 60,
    tick: async () => {
      at.push(Date.now());
      throw new Error("x");
    },
  });
  loop.start();
  await wait(260);
  await loop.stop();
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  assert.ok(gaps.length >= 3, `该有好几轮，实际 ${gaps.length}`);
  assert.ok(gaps[0] >= 25, `第一次失败后等基数 30ms，实际 ${gaps[0]}ms`);
  assert.ok(gaps[1] >= 50, `第二次翻倍到 60ms，实际 ${gaps[1]}ms`);
  assert.ok(gaps[2] >= 50 && gaps[2] < 150, `封顶 60ms，实际 ${gaps[2]}ms`);
});

test("onExit：自己收工的、被 stop 的都叫，每次 start 只叫一次", async () => {
  let exits = 0;
  let keep = true;
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 5,
    tick: async () => {},
    shouldContinue: () => keep,
    onExit: () => exits++,
  });
  loop.start();
  await wait(20);
  keep = false;
  await wait(60);
  assert.equal(loop.running, false, "shouldContinue 说不干了就退");
  assert.equal(exits, 1, "自己收工叫一次");
  await loop.stop();
  assert.equal(exits, 1, "已经退了的再 stop 不再叫");
  keep = true;
  loop.start();
  await wait(20);
  await loop.stop();
  assert.equal(exits, 2, "被 stop 的也叫");
});

test("上一轮没跑完不会再起一轮", async () => {
  let inFlight = 0;
  let peak = 0;
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 5,
    tick: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await wait(40);
      inFlight--;
    },
  });
  loop.start();
  await wait(150);
  await loop.stop();
  assert.equal(peak, 1, `同时最多一轮在跑，实际峰值 ${peak}`);
});

test("间隔从上一轮结束算起，不是固定节拍（别把上游打得更密）", async () => {
  const gaps: number[] = [];
  let endedAt = 0;
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 60,
    tick: async () => {
      if (endedAt) gaps.push(Date.now() - endedAt);
      // 一轮比间隔还长：按节拍的话下一轮会紧贴着开跑
      await wait(100);
      endedAt = Date.now();
    },
  });
  loop.start();
  await wait(600);
  await loop.stop();
  assert.ok(gaps.length >= 2, `该跑了几轮，实际间隔 ${gaps.join("/")}`);
  assert.ok(
    gaps.every((g) => g >= 45),
    `每轮之间都要留够 60ms 的空档，实际 ${gaps.join("/")}`,
  );
});

test("失败按次数退避：第一次等 intervalMs，之后翻倍，封顶 maxBackoffMs", async () => {
  const waits: number[] = [];
  let last = Date.now();
  let attempts = 0;
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 20,
    maxBackoffMs: 80,
    tick: async () => {
      const now = Date.now();
      if (attempts > 0) waits.push(now - last);
      last = now;
      attempts++;
      throw new Error("炸了");
    },
  });
  loop.start();
  await wait(400);
  await loop.stop();
  assert.equal(loop.lastError, "炸了", "失败原因要留在状态里");
  assert.ok(waits.length >= 4, `该重试好几次，实际间隔 ${waits.join("/")}`);
  assert.ok(waits[0] >= 15 && waits[0] < 35, `第一次退避该在 20ms 上下，实际 ${waits[0]}`);
  assert.ok(waits[1] >= 35 && waits[1] < 65, `第二次该翻倍到 40ms，实际 ${waits[1]}`);
  assert.ok(waits.slice(2).every((w) => w < 140), `封顶之后不该再涨，实际 ${waits.join("/")}`);
});

test("退避期间 lastError 一直留着：别让坏掉的循环在状态里显示成没事", async () => {
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 40,
    tick: async () => {
      await wait(5);
      throw new Error("115 登录失效");
    },
  });
  loop.start();
  await wait(20);
  assert.equal(loop.lastError, "115 登录失效");
  // 整个退避窗口里抽查若干次，任何一刻都不该变成 null
  for (let i = 0; i < 8; i++) {
    await wait(10);
    assert.equal(loop.lastError, "115 登录失效", `第 ${i} 次抽查时错被清掉了`);
  }
  await loop.stop();
});

test("成功一次退避就归零；tick 自己记的错留到下一轮跑完", async () => {
  let n = 0;
  const done: Array<(() => void) | undefined> = [];
  const afterRound = (k: number) => new Promise<void>((r) => (done[k] = r));
  const round2 = afterRound(2);
  const round3 = afterRound(3);
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 30,
    tick: async () => {
      n++;
      if (n === 1) throw new Error("第一轮炸了");
      if (n === 2) loop.noteError("这一轮有个账号没拉到");
      done[n]?.();
    },
  });
  loop.start();
  await round2;
  assert.equal(loop.lastError, "这一轮有个账号没拉到", "tick 自己记的不该被成功清掉");
  await round3;
  // 结论是在这一轮 settle 之后才定的，让出一拍
  await wait(5);
  assert.equal(loop.lastError, null, "干干净净跑完一轮就该清掉");
  await loop.stop();
});

test("shouldContinue 说不干了就收工，start 能重新起", async () => {
  let n = 0;
  let more = true;
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 15,
    tick: async () => {
      n++;
    },
    shouldContinue: () => more,
    doneMessage: "没活了，收工",
  });
  loop.start();
  await wait(50);
  more = false;
  await wait(60);
  assert.equal(loop.running, false, "收工之后不算在跑");
  const stopped = n;
  await wait(50);
  assert.equal(n, stopped, "收工之后不该再跑");
  more = true;
  loop.start();
  await wait(40);
  assert.ok(n > stopped, "能重新起");
  await loop.stop();
});

test("失败的那一轮也要问 shouldContinue：别卡在退避里一直醒着打接口", async () => {
  let n = 0;
  let more = true;
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 20,
    maxBackoffMs: 40,
    tick: async () => {
      n++;
      throw new Error("一直失败");
    },
    shouldContinue: () => more,
  });
  loop.start();
  await wait(60);
  assert.ok(n >= 2, "先失败几轮");
  more = false;
  await wait(120);
  assert.equal(loop.running, false, "待办没了就该收工，哪怕正一路失败");
  const stopped = n;
  await wait(120);
  assert.equal(n, stopped, "收工之后不该再打接口");
});

test("shouldContinue 自己抛了：当没问过，循环照跑，不把进程带崩", async () => {
  let n = 0;
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 15,
    tick: async () => {
      n++;
    },
    shouldContinue: () => {
      throw new Error("SQLITE_BUSY");
    },
  });
  loop.start();
  await wait(100);
  assert.ok(n >= 2, `循环该照跑，实际只跑了 ${n} 轮`);
  assert.equal(loop.running, true, "不能留下一个 running=false 却没法重起的壳");
  await loop.stop();
});

test("firstDelayMs 只等一次：之后按 intervalMs 来，不是每轮都再等一遍首延迟", async () => {
  const at: number[] = [];
  const t0 = Date.now();
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 20,
    firstDelayMs: 80,
    tick: async () => {
      at.push(Date.now() - t0);
    },
  });
  loop.start();
  await wait(220);
  await loop.stop();
  assert.ok(at.length >= 4, `首延迟之后该按 20ms 跑，实际只跑了 ${at.length} 轮：${at.join("/")}`);
  assert.ok(at[0] >= 70, `第一轮要等满首延迟，实际 ${at[0]}ms`);
  assert.ok(at[1] - at[0] < 60, `第二轮不该再等一次首延迟，实际隔了 ${at[1] - at[0]}ms`);
});

test("加急：窗口内重复调只算一次；没起循环时是空操作", async () => {
  let n = 0;
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 10_000,
    firstDelayMs: 10_000,
    tick: async () => {
      n++;
    },
  });
  loop.nudge(10);
  await wait(40);
  assert.equal(n, 0, "没起循环时加急什么也不做");
  loop.start();
  loop.nudge(30);
  loop.nudge(30);
  loop.nudge(30);
  await wait(90);
  assert.equal(n, 1, "三次加急合成一轮");
  await loop.stop();
});

test("加急到点时正有一轮在跑：这一轮一结束紧接着来一轮，不丢", async () => {
  const starts: number[] = [];
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 10_000,
    tick: async () => {
      starts.push(Date.now());
      await wait(80);
    },
  });
  loop.start();
  await wait(20); // 第一轮在跑
  loop.nudge(10); // 到点时第一轮还没跑完
  await wait(200);
  assert.equal(starts.length, 2, `加急该在第一轮结束后马上插一轮，实际跑了 ${starts.length} 轮`);
  assert.ok(starts[1] - starts[0] < 10_000 && starts[1] - starts[0] >= 80, "紧接着上一轮，不是等满间隔");
  await loop.stop();
});

test("加急能打断退避：不能被一个十分钟的退避吞掉", async () => {
  let n = 0;
  const loop = createPollingLoop({
    name: "测试循环",
    log,
    intervalMs: 50,
    maxBackoffMs: 100_000,
    tick: async () => {
      n++;
      throw new Error("一直失败");
    },
  });
  loop.start();
  await wait(80);
  const beforeNudge = n;
  assert.ok(beforeNudge >= 1);
  // 这时退避已经涨到几百毫秒往上；加急该马上插一轮
  loop.nudge(5);
  await wait(60);
  assert.ok(n > beforeNudge, `加急该插进一轮，实际还停在 ${n}`);
  await loop.stop();
});
