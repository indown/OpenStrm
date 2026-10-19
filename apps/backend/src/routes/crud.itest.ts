/**
 * task / account / settings 三组 CRUD 路由的闭环，以及它们和 cron 的联动。
 *
 * 钉住的行为：输入校验统一 400 + VALIDATION；任务 id 由服务端分配；增删改任务后
 * cron 立即重排（以前只在启动时同步一次）；设置按顶层键合并而不是整体替换。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/crud.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { registerErrorHandling } from "../plugins/error-handler.js";
import { authPlugin } from "../plugins/auth.js";
import { cronPlugin } from "../plugins/cron.js";
import taskRoute from "./task/index.js";
import taskCronRoute from "./task/cron.js";
import accountRoute from "./account/index.js";
import settingsRoute from "./settings/index.js";
import { DEFAULT_AUTH } from "../db/defaults.js";
import { writeAuthPassword } from "../db/repositories/auth.js";
import { patchAppSettings, readAppSettings, replaceAppSettings } from "../db/repositories/settings.js";
import { deleteTask, insertTask, listTasks, replaceTasks } from "../db/repositories/tasks.js";
import { listAccounts, replaceAccounts } from "../db/repositories/accounts.js";
import { releaseTaskStart, reserveTaskStart } from "../services/task/registry.js";
import { completeTaskExecution, createTaskExecution, deleteTaskExecution } from "../services/task-history.js";
import { resetThrottle, scheduleForAccount } from "../services/throttle.js";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { settings: AppSettings; tasks: TaskDefinition[]; accounts: AccountInfo[] };

before(async () => {
  baseline = { settings: readAppSettings(), tasks: listTasks(), accounts: listAccounts() };
  replaceTasks([]);
  replaceAccounts([]);
  // 默认口令下除改密外一律 403，先换掉
  await writeAuthPassword("crud-itest-pw");

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(cronPlugin);
  await app.register(taskRoute);
  await app.register(taskCronRoute);
  await app.register(accountRoute);
  await app.register(settingsRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

after(async () => {
  await app.close();
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  await writeAuthPassword(DEFAULT_AUTH.password);
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth, payload: payload as Record<string, unknown> | undefined });

// ---- 任务 ----

let taskId = "";

test("没有 token 一律 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/task" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "UNAUTHORIZED");
});

test("POST /api/task：校验失败 → 400 VALIDATION，message 指向字段", async () => {
  const res = await call("POST", "/api/task", { account: "", originPath: "/tv" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "VALIDATION");
  assert.match(res.json().message, /^account/);
});

test("POST /api/task：服务端分配 UUID，带 cron 表达式的任务不重启就排上", async () => {
  const res = await call("POST", "/api/task", {
    account: "acc",
    originPath: "/tv",
    targetPath: "tv",
    cronExpression: "0 0 1 1 *",
  });
  assert.equal(res.statusCode, 201);
  taskId = res.json().id;
  assert.match(taskId, /^[0-9a-f-]{36}$/, "id 由服务端生成");
  assert.ok(app.cron.listJobs().some((j) => j.taskId === taskId), "建任务后 cron 应立即重排");
});

test("GET /api/task：列表带运行状态、上次执行和下次定时", async () => {
  const res = await call("GET", "/api/task");
  assert.equal(res.statusCode, 200);
  const row = res.json().find((t: { id: string }) => t.id === taskId);
  assert.equal(row.status, "pending");
  assert.equal(row.originPath, "/tv");
  assert.equal(row.lastRun, null, "还没跑过");
  assert.match(String(row.nextRunAt), /^\d{4}-\d{2}-\d{2}T/, "有 cron 的任务带下次触发时间");

  // 有过执行记录之后，列表里带最近一条（不带 logs）
  const ex = createTaskExecution(taskId, { account: "acc", originPath: "/tv", targetPath: "tv" });
  completeTaskExecution(ex.id, "failed", { errorMessage: "boom" });
  try {
    const again = (await call("GET", "/api/task")).json().find((t: { id: string }) => t.id === taskId);
    assert.equal(again.lastRun.id, ex.id);
    assert.equal(again.lastRun.status, "failed");
    assert.equal(again.lastRun.summary.errorMessage, "boom");
    assert.equal("logs" in again.lastRun, false, "列表里不该带日志");
  } finally {
    deleteTaskExecution(ex.id);
  }
});

test("GET /api/task：copyBlocked 说这个任务要复制卡在哪，同类型的两个账号各看各的挂载根", async () => {
  const before = { accounts: listAccounts(), openlistCopy: readAppSettings().openlistCopy };
  const ol: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
  const drives: AccountInfo[] = [
    { accountType: "115", name: "115-a", cookie: "c" },
    { accountType: "115", name: "115-b", cookie: "c" },
  ];
  const base = { originPath: "/tv", targetPath: "tv", strmPrefix: "/mnt/pan" };
  const ids = ["cb-a", "cb-b", "cb-ol"];
  replaceAccounts([...drives, ol]);
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local", mounts: { "115-a": "/115" } } });
  insertTask({ ...base, id: "cb-a", account: "115-a", copyToOpenlist: { enabled: true } });
  insertTask({ ...base, id: "cb-b", account: "115-b", copyToOpenlist: { enabled: true } });
  insertTask({ ...base, id: "cb-ol", account: "ol", copyToOpenlist: { enabled: true } });
  try {
    const rows = (await call("GET", "/api/task")).json() as Array<{ id: string; copyBlocked: string | null }>;
    const blocked = (id: string) => rows.find((t) => t.id === id)?.copyBlocked;
    assert.equal(blocked("cb-a"), null, "填了挂载根的能复制");
    assert.match(blocked("cb-b") ?? "", /账号 115-b 还没填「在 OpenList 里的挂载根」/, "另一个 115 没填，要看得出来");
    assert.match(blocked("cb-ol") ?? "", /OpenList 账号的任务用不着复制/);

    // 设置页的默认目标目录是 /（以前存进去的）：等于没填，说清楚是 / 不算
    patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/", mounts: { "115-a": "/115" } } });
    const root = (await call("GET", "/api/task")).json() as Array<{ id: string; copyBlocked: string | null }>;
    assert.equal(root.find((t) => t.id === "cb-a")?.copyBlocked, "没有目标目录：设置页填的是 OpenList 根 /，等于没填");
    patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local", mounts: { "115-a": "/115" } } });

    // 设置上看着都齐，OpenList 账号却被删了：照样复制不了
    replaceAccounts(drives);
    const again = (await call("GET", "/api/task")).json() as Array<{ id: string; copyBlocked: string | null }>;
    assert.match(again.find((t) => t.id === "cb-a")?.copyBlocked ?? "", /OpenList 账号不存在：ol/);

    // 压根没配「复制到 OpenList」：每个任务都说一句短的
    patchAppSettings({ openlistCopy: undefined });
    const none = (await call("GET", "/api/task")).json() as Array<{ id: string; copyBlocked: string | null }>;
    assert.equal(none.find((t) => t.id === "cb-a")?.copyBlocked, "设置页还没选 OpenList 账号");
  } finally {
    for (const id of ids) deleteTask(id);
    replaceAccounts(before.accounts);
    patchAppSettings({ openlistCopy: before.openlistCopy });
  }
});

test("PUT /api/task：合并字段；清掉 cron 表达式后任务从 cron 摘掉", async () => {
  const res = await call("PUT", "/api/task", { id: taskId, strmPrefix: "/mnt/pan", cronExpression: "" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().strmPrefix, "/mnt/pan");
  assert.equal(res.json().originPath, "/tv", "没提交的字段要保留");
  assert.ok(!app.cron.listJobs().some((j) => j.taskId === taskId), "改掉表达式后不该还在 cron 里");
});

test("PUT /api/task：不存在的 id → 404", async () => {
  const res = await call("PUT", "/api/task", { id: "nope", strmPrefix: "/x" });
  assert.equal(res.statusCode, 404);
});

test("DELETE /api/task：运行中（含启动中）的任务不能删 → 409", async () => {
  assert.ok(reserveTaskStart(taskId));
  try {
    const res = await call("DELETE", `/api/task?id=${taskId}`);
    assert.equal(res.statusCode, 409);
    assert.match(res.json().message, /正在运行/);
  } finally {
    releaseTaskStart(taskId);
  }
  assert.equal(listTasks().length, 1, "409 时任务还在");
});

test("DELETE /api/task：删掉后再删 404", async () => {
  assert.equal((await call("DELETE", `/api/task?id=${taskId}`)).statusCode, 200);
  assert.equal((await call("DELETE", `/api/task?id=${taskId}`)).statusCode, 404);
  assert.equal(listTasks().length, 0);
});

test("POST/PUT /api/task：cron 表达式不合法 → 400，不会被存进库", async () => {
  const res = await call("POST", "/api/task", {
    account: "acc",
    originPath: "/tv",
    targetPath: "tv",
    cronExpression: "every day at 3am",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "VALIDATION");
  assert.match(res.json().message, /^cronExpression/);
  assert.equal(listTasks().length, 0, "校验失败的任务不能落库");

  const created = await call("POST", "/api/task", { account: "acc", originPath: "/tv", targetPath: "tv" });
  assert.equal(created.statusCode, 201);
  const bad = await call("PUT", "/api/task", { id: created.json().id, cronExpression: "61 * * * *" });
  assert.equal(bad.statusCode, 400);
  assert.equal(listTasks()[0]?.cronExpression, undefined, "PUT 校验失败不能改掉库里的值");
  await call("DELETE", `/api/task?id=${created.json().id}`);
});

test("POST /api/task/cron/preview：试算下几次执行；不合法的表达式 400 并说明原因", async () => {
  const ok = await call("POST", "/api/task/cron/preview", { expression: "0 3 * * *" });
  assert.equal(ok.statusCode, 200, ok.body);
  const { next } = ok.json<{ next: string[] }>();
  assert.equal(next.length, 3, "给前三次");
  // 每一次都在将来，而且严格递增——这是这个接口唯一要保证的事
  let prev = Date.now();
  for (const iso of next) {
    const t = new Date(iso).getTime();
    assert.ok(t > prev, `${iso} 应该晚于上一个`);
    prev = t;
  }
  // 和调度用的是同一个解析器：每天 03:00 应当都落在 3 点整
  for (const iso of next) assert.match(iso, /T03:00:00/, `${iso} 应该是 03:00`);

  // 形状对但字段越界：这正是前端那条 5 段正则拦不住、以前要等保存才发现的情况
  const bad = await call("POST", "/api/task/cron/preview", { expression: "99 3 * * *" });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(bad.json<{ message: string }>().message, /不合法/);

  assert.equal((await call("POST", "/api/task/cron/preview", { expression: "  " })).statusCode, 400, "空表达式");
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/task/cron/preview", payload: { expression: "0 3 * * *" } })).statusCode,
    401,
    "不带令牌",
  );
});

test("POST/PUT /api/task：任务级「复制到 OpenList」原样存取，改一次整块替换", async () => {
  const created = await call("POST", "/api/task", {
    account: "acc",
    originPath: "tv",
    targetPath: "tv",
    copyToOpenlist: { enabled: true, dstDir: "/local/media", deleteSource: true },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().id;
  // 老字段 deleteSource 读写时归一成 afterCopy
  assert.deepEqual(created.json().copyToOpenlist, { enabled: true, dstDir: "/local/media", afterCopy: "delete" });

  // 浅合并：整块替换，没带的字段跟着没了（同 organize）
  const put = await call("PUT", "/api/task", { id, copyToOpenlist: { enabled: false } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(listTasks().find((t) => t.id === id)?.copyToOpenlist, { enabled: false });

  const bad = await call("POST", "/api/task", {
    account: "acc",
    originPath: "tv",
    targetPath: "tv",
    copyToOpenlist: { enabled: "yes" },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, "VALIDATION");
  await call("DELETE", `/api/task?id=${id}`);
});

test("POST/PUT /api/task、PUT /api/settings：复制的目标目录不收 OpenList 根 /，空着照收", async () => {
  const base = { account: "acc", originPath: "tv", targetPath: "tv" };
  const bad = await call("POST", "/api/task", { ...base, copyToOpenlist: { enabled: true, dstDir: "/" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, "VALIDATION");
  assert.match(bad.json().message, /copyToOpenlist\.dstDir: 目标目录不能是 OpenList 根/);
  const created = await call("POST", "/api/task", { ...base, copyToOpenlist: { enabled: true, dstDir: "" } });
  assert.equal(created.statusCode, 201, "空着是没填，照收");
  const id = created.json().id;
  const put = await call("PUT", "/api/task", { id, copyToOpenlist: { enabled: true, dstDir: " // " } });
  assert.equal(put.statusCode, 400);
  await call("DELETE", `/api/task?id=${id}`);

  const before = readAppSettings().openlistCopy;
  try {
    const res = await call("PUT", "/api/settings", { openlistCopy: { account: "ol", dstDir: "/", mounts: {} } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /openlistCopy\.dstDir: 目标目录不能是 OpenList 根/);
    assert.deepEqual(readAppSettings().openlistCopy, before, "拒了就一样都没存");
    const ok = await call("PUT", "/api/settings", { openlistCopy: { account: "ol", dstDir: "/hhd", mounts: {} } });
    assert.equal(ok.statusCode, 200);
    assert.equal(readAppSettings().openlistCopy?.dstDir, "/hhd");
  } finally {
    patchAppSettings({ openlistCopy: before });
  }
});

test("POST/PUT /api/task：strmPrefix 去掉首尾空白和尾斜杠再入库", async () => {
  const created = await call("POST", "/api/task", {
    account: "acc",
    originPath: "tv",
    targetPath: "tv",
    strmPrefix: " http://h:5244/d/ ",
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().strmPrefix, "http://h:5244/d");
  const id = created.json().id;
  const put = await call("PUT", "/api/task", { id, strmPrefix: "/mnt/pan//" });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().strmPrefix, "/mnt/pan");
  assert.equal(listTasks().find((t) => t.id === id)?.strmPrefix, "/mnt/pan");
  await call("DELETE", `/api/task?id=${id}`);
});

test("POST /api/task：开 302 的任务也可以用 http(s) 前缀——代理按 URL 匹配挂载点，换不到直链回给 Emby", async () => {
  const created = await call("POST", "/api/task", {
    account: "acc",
    originPath: "tv",
    targetPath: "tv",
    strmPrefix: "http://ol.local:5244/d/115/",
    enable302: true,
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().strmPrefix, "http://ol.local:5244/d/115");
  assert.equal(created.json().enable302, true);
  await call("DELETE", `/api/task?id=${created.json().id}`);
});

test("库里已有解析不了的表达式：启动不炸，其余任务照常排程", async () => {
  // 绕过路由校验，模拟校验上线前存下的脏数据
  insertTask({ id: "bad-cron", account: "acc", originPath: "/a", targetPath: "a", cronExpression: "not a cron" });
  insertTask({ id: "good-cron", account: "acc", originPath: "/b", targetPath: "b", cronExpression: "0 0 1 1 *" });

  const boot = Fastify();
  await boot.register(cronPlugin);
  await boot.ready(); // onReady 里的 syncFromConfig 以前会在这里抛出来
  const jobs = boot.cron.listJobs().map((j) => j.taskId);
  assert.ok(jobs.includes("good-cron"), "好的表达式要排上");
  assert.ok(!jobs.includes("bad-cron"), "坏的只跳过自己");
  await boot.close();

  deleteTask("bad-cron");
  deleteTask("good-cron");
});

// ---- 账号 ----

test("POST /api/account：115 账号缺 cookie → 400，且说明原因", async () => {
  const res = await call("POST", "/api/account", { accountType: "115", name: "main" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /cookie/);
});

test("POST /api/account：建成功 201；同名再建 409", async () => {
  const res = await call("POST", "/api/account", { accountType: "115", name: "main", cookie: "c1" });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().cookie, "••••", "响应里的凭据也是掩码");
  assert.equal((listAccounts().find((a) => a.name === "main") as { cookie?: string }).cookie, "c1");
  const dup = await call("POST", "/api/account", { accountType: "115", name: "main", cookie: "c2" });
  assert.equal(dup.statusCode, 409);
});

test("PUT /api/account：只改提交的字段，cookie 沿用旧值", async () => {
  const res = await call("PUT", "/api/account", { name: "main", note: "hello" });
  assert.equal(res.statusCode, 200);
  const stored = listAccounts().find((a) => a.name === "main") as AccountInfo & { note?: string; cookie?: string };
  assert.equal(stored.note, "hello");
  assert.equal(stored.cookie, "c1");
});

test("GET /api/account 只给 cookie 末 4 位；编辑时原样提交掩码值不会覆盖真值", async () => {
  await call("PUT", "/api/account", { name: "main", cookie: "UID=1234567890;SEID=abc" });
  const listed = (await call("GET", "/api/account")).json().find((a: { name: string }) => a.name === "main");
  assert.equal(listed.cookie, "••••=abc");
  const res = await call("PUT", "/api/account", { name: "main", accountType: "115", cookie: listed.cookie, note: "edited" });
  assert.equal(res.statusCode, 200);
  const stored = listAccounts().find((a) => a.name === "main") as AccountInfo & { cookie?: string; note?: string };
  assert.equal(stored.cookie, "UID=1234567890;SEID=abc", "掩码值不能被写进库");
  assert.equal(stored.note, "edited");
});

test("POST /api/account 不接受掩码值当 cookie", async () => {
  const res = await call("POST", "/api/account", { accountType: "115", name: "masked", cookie: "••••abcd" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /cookie/);
});

test("POST /api/account：夸克账号缺 cookie → 400；带 cookie → 201 且响应掩码；PUT 掩码值不覆盖真值", async () => {
  const missing = await call("POST", "/api/account", { accountType: "quark", name: "qk" });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().message, /cookie/);

  const res = await call("POST", "/api/account", { accountType: "quark", name: "qk", cookie: "kps=1; __puus=abcdef" });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().accountType, "quark");
  assert.equal(res.json().cookie, "••••cdef");

  const listed = (await call("GET", "/api/account")).json().find((a: { name: string }) => a.name === "qk");
  const put = await call("PUT", "/api/account", { name: "qk", accountType: "quark", cookie: listed.cookie });
  assert.equal(put.statusCode, 200);
  assert.equal((listAccounts().find((a) => a.name === "qk") as { cookie?: string }).cookie, "kps=1; __puus=abcdef");
  assert.equal((await call("DELETE", "/api/account?name=qk")).statusCode, 200);
});

test("DELETE /api/account：删掉后再删 404", async () => {
  assert.equal((await call("DELETE", "/api/account?name=main")).statusCode, 200);
  assert.equal((await call("DELETE", "/api/account?name=main")).statusCode, 404);
});

// ---- 设置 ----

test("PUT /api/settings 按顶层键合并：只发 emby 不会抹掉 telegram", async () => {
  replaceAppSettings({
    ...readAppSettings(),
    telegram: { botToken: "t", chatId: "c" },
    emby: { url: "http://old", apiKey: "" },
  });
  const res = await call("PUT", "/api/settings", { emby: { url: "http://new", apiKey: "k" } });
  assert.equal(res.statusCode, 200);
  const s = readAppSettings();
  assert.equal(s.emby?.url, "http://new");
  assert.equal(s.telegram?.botToken, "t", "别的页面写的键不能被这次保存盖掉");
});

test("PUT /api/settings：类型不对 → 400 VALIDATION", async () => {
  const res = await call("PUT", "/api/settings", { strmExtensions: "not-an-array" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "VALIDATION");
});

test("PUT /api/settings：限流的值越界、并发不是整数 → 400；合法值保存后已经建好的限流器立刻按新值走", async () => {
  for (const bad of [
    { requestsPerSecond: 0.05 },
    { requestsPerSecond: 101 },
    { requestConcurrency: 1.5 },
    { requestConcurrency: 0 },
    { downloadConcurrency: 0.5 },
    { downloadConcurrency: 51 },
  ]) {
    const res = await call("PUT", "/api/settings", { throttle: bad });
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.equal(res.json().code, "VALIDATION");
  }

  // 先按「下载并发 1」把这个账号的限流器建出来，六个活排着
  await call("PUT", "/api/settings", { throttle: { requestsPerSecond: 100, requestConcurrency: 1, downloadConcurrency: 1 } });
  resetThrottle();
  let running = 0;
  let peak = 0;
  const hold = async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 60));
    running--;
  };
  const all = Promise.all(Array.from({ length: 6 }, () => scheduleForAccount("crud-throttle", "download", hold)));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(peak, 1);

  const ok = await call("PUT", "/api/settings", { throttle: { requestsPerSecond: 0.5, requestConcurrency: 1, downloadConcurrency: 3 } });
  assert.equal(ok.statusCode, 200, ok.body);
  await all;
  assert.equal(peak, 3, "不用重启，也不用等在跑的任务结束");
  assert.equal(readAppSettings().throttle?.requestsPerSecond, 0.5, "每秒请求数可以存小数（0.5 = 两秒一个）");
});

test("GET /api/settings：限流那一组总是补齐的三个值，库里没有、只填过一部分也一样", async () => {
  const throttleOf = async () => (await call("GET", "/api/settings")).json().throttle;
  const before = readAppSettings().throttle;
  try {
    patchAppSettings({ throttle: undefined });
    assert.deepEqual(await throttleOf(), { requestsPerSecond: 2, requestConcurrency: 2, downloadConcurrency: 5 });
    patchAppSettings({ throttle: { requestsPerSecond: 0.5 } });
    assert.deepEqual(await throttleOf(), { requestsPerSecond: 0.5, requestConcurrency: 2, downloadConcurrency: 5 });
  } finally {
    patchAppSettings({ throttle: before });
  }
});

test("GET /api/settings：直接返回设置对象，没有 code 壳", async () => {
  const res = await call("GET", "/api/settings");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().code, undefined);
  assert.equal(res.json().emby?.url, "http://new");
});

test("密钥只给末 4 位；回传掩码值不改真值，空串才清除", async () => {
  await call("PUT", "/api/settings", { emby: { url: "http://new", apiKey: "emby-secret-key-1234" } });
  const masked = (await call("GET", "/api/settings")).json().emby.apiKey;
  assert.equal(masked, "••••1234");

  await call("PUT", "/api/settings", { emby: { url: "http://newer", apiKey: masked } });
  assert.equal(readAppSettings().emby?.apiKey, "emby-secret-key-1234", "掩码值不能被写进库");
  assert.equal(readAppSettings().emby?.url, "http://newer", "同一次提交里的其它字段照常更新");

  await call("PUT", "/api/settings", { emby: { url: "http://newer", apiKey: "" } });
  assert.equal(readAppSettings().emby?.apiKey, "", "空串才是清除");
});

test("PUT /api/settings：资源搜索的屏蔽词去空白、去空、不分大小写去重；密码是掩码时沿用库里的；空数组清掉", async () => {
  await call("PUT", "/api/settings", { pansou: { baseUrl: "http://pansou", password: "pansou-pw-1234", blockWords: [" 预告 ", "", "TC", "tc", "枪版"] } });
  assert.deepEqual(readAppSettings().pansou?.blockWords, ["预告", "TC", "枪版"]);
  const masked = (await call("GET", "/api/settings")).json().pansou;
  assert.deepEqual(masked.blockWords, ["预告", "TC", "枪版"]);
  await call("PUT", "/api/settings", { pansou: { ...masked, blockWords: [] } });
  assert.deepEqual(readAppSettings().pansou?.blockWords, []);
  assert.equal(readAppSettings().pansou?.password, "pansou-pw-1234", "掩码的密码不写进库");
  const tooMany = await call("PUT", "/api/settings", { pansou: { blockWords: Array.from({ length: 51 }, (_, i) => `w${i}`) } });
  assert.equal(tooMany.statusCode, 400);
});

test("PUT /api/settings：PanSou 换了地址、密码还是掩码，存着的密码不跟着去新地址（清掉）；地址只是多了 / 或 /api 不算换", async () => {
  await call("PUT", "/api/settings", { pansou: { baseUrl: "http://pansou:8888", username: "admin", password: "pansou-pw-1234" } });
  const masked = (await call("GET", "/api/settings")).json().pansou;
  assert.notEqual(masked.password, "pansou-pw-1234");

  await call("PUT", "/api/settings", { pansou: { ...masked, baseUrl: "http://pansou:8888/api/" } });
  assert.equal(readAppSettings().pansou?.password, "pansou-pw-1234", "同一台：沿用");

  await call("PUT", "/api/settings", { pansou: { ...masked, baseUrl: "http://elsewhere:8888" } });
  assert.equal(readAppSettings().pansou?.baseUrl, "http://elsewhere:8888");
  assert.equal(readAppSettings().pansou?.password, "", "换了地址：清掉，要用就重新填");

  await call("PUT", "/api/settings", { pansou: { baseUrl: "http://elsewhere:8888", username: "admin", password: "new-pw-5678" } });
  assert.equal(readAppSettings().pansou?.password, "new-pw-5678", "重新填的照存");
  const bad = await call("PUT", "/api/settings", { pansou: { baseUrl: "http://admin:pw@elsewhere:8888" } });
  assert.equal(bad.statusCode, 400, "地址里不收用户名密码");
});

test("任务自己的命名模板：合法的存得进去、空串不算；坏模板 400", async () => {
  const created = await call("POST", "/api/task", {
    account: "acc",
    originPath: "tv",
    targetPath: "tv",
    organize: { libraryType: "tv", templates: { movie: "", tv: "{title}/Season {season00}/{title} - S{season00}E{episode00}.{ext}" }, idTag: "plex", episodeTitle: true },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(created.json().organize, { libraryType: "tv", templates: { movie: "", tv: "{title}/Season {season00}/{title} - S{season00}E{episode00}.{ext}" }, idTag: "plex", episodeTitle: true });
  const bad = await call("POST", "/api/task", { account: "acc", originPath: "tv", targetPath: "tv", organize: { templates: { tv: "{title}/{nope}.{ext}" } } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /剧集模板.*不认识的变量/);
});
