/**
 * 「复制到 OpenList」队列的路由：看队列、手动发起、重试、不跟了。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/copy/copy.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import copyRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { createApiToken, deleteAllApiTokens } from "../../db/repositories/api-tokens.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { __test_resetCopy, enqueueCopy, listCopies, setCopyServiceDeps, type CopyRecord } from "../../services/copy/service.js";
import { saveCopies } from "../../services/copy/queue.js";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { accounts: AccountInfo[]; tasks: TaskDefinition[]; openlistCopy: AppSettings["openlistCopy"]; agent: AppSettings["agent"] };

const drive: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const olAccount: AccountInfo = { accountType: "openlist", name: "ol", account: "u", password: "p", url: "http://ol.local" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "copy-itest/tv", strmPrefix: "/mnt" };

const call = (method: "GET" | "POST" | "DELETE", url: string, body?: Record<string, unknown>, headers: Record<string, string> = auth) =>
  app.inject({ method, url, headers, ...(body ? { payload: body } : {}) });

before(async () => {
  baseline = { accounts: listAccounts(), tasks: listTasks(), openlistCopy: readAppSettings().openlistCopy, agent: readAppSettings().agent };
  replaceAccounts([drive, olAccount]);
  replaceTasks([task]);
  // 令牌要能用得先开智能体接入
  patchAppSettings({ agent: { ...(readAppSettings().agent ?? {}), enabled: true } });
  const fake = new FakeDrive("115", drive);
  fake.tree.addFile("/tv/Show/E01.mkv");
  setDriveProviderFactory((a) => (a.name === "acc" ? fake : null));
  setCopyServiceDeps({
    openlist: { listNames: async () => [], mkdir: async () => {}, copy: async () => [], copyTasks: async () => ({ undone: [], done: [] }) },
    notify: async () => {},
  });
  patchAppSettings({ openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { acc: "/115" } } });
  await writeAuthPassword("copy-itest-pw");

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(copyRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});

beforeEach(async () => {
  await __test_resetCopy();
});

after(async () => {
  await __test_resetCopy();
  setCopyServiceDeps(null);
  setDriveProviderFactory(null);
  deleteAllApiTokens();
  await app.close();
  await writeAuthPassword(DEFAULT_AUTH.password);
  replaceAccounts(baseline.accounts);
  replaceTasks(baseline.tasks);
  patchAppSettings({ openlistCopy: baseline.openlistCopy, agent: baseline.agent });
});

test("POST /api/copy：手动发起；复制后删源要令牌有「删除」档，会话不受限；任务不存在 404，参数不对 400", async () => {
  const ok = await call("POST", "/api/copy", { taskId: "t1", paths: ["Show"] });
  assert.equal(ok.statusCode, 200, ok.body);
  const body = ok.json() as { queued: number; afterCopy: string; items: Array<{ path: string; outcome: string }> };
  assert.equal(body.queued, 1);
  assert.equal(body.afterCopy, "keep");
  assert.deepEqual(body.items.map((i) => [i.path, i.outcome]), [["Show", "queued"]]);
  assert.equal(listCopies()[0].trigger, "manual");

  const write = createApiToken({ name: "写", scopes: ["read", "run", "write"], toolsets: ["transfer"], expiresAt: null }).token;
  const danger = createApiToken({ name: "删", scopes: ["read", "run", "write", "danger"], toolsets: ["transfer"], expiresAt: null }).token;
  const denied = await call("POST", "/api/copy", { taskId: "t1", paths: ["Show/E01.mkv"], afterCopy: "delete" }, { authorization: `Bearer ${write}` });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, "INSUFFICIENT_SCOPE");
  // 没明说、任务设的就是复制后删除：一样要「删除」档
  replaceTasks([{ ...task, copyToOpenlist: { enabled: true, afterCopy: "delete" } }]);
  const implied = await call("POST", "/api/copy", { taskId: "t1", paths: ["Show/E01.mkv"] }, { authorization: `Bearer ${write}` });
  assert.equal(implied.statusCode, 403, implied.body);
  assert.equal(implied.json().code, "INSUFFICIENT_SCOPE");
  replaceTasks([task]);
  const allowed = await call("POST", "/api/copy", { taskId: "t1", paths: ["Show/E01.mkv"], afterCopy: "delete" }, { authorization: `Bearer ${danger}` });
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.equal(allowed.json().afterCopy, "delete");
  const viaSession = await call("POST", "/api/copy", { taskId: "t1", paths: ["Show/E01.mkv"], afterCopy: "archive" });
  assert.equal(viaSession.statusCode, 200, viaSession.body);
  assert.equal(viaSession.json().items[0].outcome, "duplicate", "同一个文件已经排着");

  assert.equal((await call("POST", "/api/copy", { taskId: "没有", paths: ["Show"] })).statusCode, 404);
  assert.equal((await call("POST", "/api/copy", { taskId: "t1", paths: [] })).statusCode, 400);
  assert.equal((await call("POST", "/api/copy", { taskId: "t1", paths: ["Show"], afterCopy: "burn" })).statusCode, 400);
});

test("POST /api/copy/after：按记录 id 事后归档（目标里没看到就不动）；删除要「删除」档；ids 和 taskId + paths 二选一；GET 带 canAfterCopy", async () => {
  const now = Date.now();
  saveCopies([
    { id: "k1", account: "acc", srcDir: "/tv/Show", name: "E01.mkv", isDir: false, dstDir: "/local/media/Show", dstBase: "/local/media", rootPath: "/tv", taskId: "t1", trigger: "monitor", afterCopy: "keep", addedAt: now, status: "done", stage: "copying", detail: "复制完成", doneAt: now, attempts: 0, waits: 0, misses: 0 },
    { id: "p1", account: "acc", srcDir: "/tv/Show", name: "E02.mkv", dstDir: "/local/media/Show", dstBase: "/local/media", rootPath: "/tv", taskId: "t1", trigger: "monitor", afterCopy: "keep", addedAt: now, status: "pending", stage: "waiting", detail: "", attempts: 0, waits: 0, misses: 0 },
  ]);
  const list = (await call("GET", "/api/copy")).json() as { items: Array<{ id: string; canAfterCopy: boolean }> };
  assert.deepEqual(Object.fromEntries(list.items.map((i) => [i.id, i.canAfterCopy])), { k1: true, p1: false });

  // 桩里 OpenList 什么都列不出来：核对不过，源文件不动，照实说
  const res = await call("POST", "/api/copy/after", { ids: ["k1"], afterCopy: "archive" });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { afterCopy: string; done: number; items: Array<{ id: string; path: string; outcome: string; detail?: string }> };
  assert.equal(body.afterCopy, "archive");
  assert.equal(body.done, 0);
  assert.deepEqual(body.items.map((i) => [i.id, i.path, i.outcome]), [["k1", "Show/E01.mkv", "incomplete"]]);
  assert.match(body.items[0].detail ?? "", /没有这一份/);

  assert.equal((await call("POST", "/api/copy/after", { ids: ["k1"], taskId: "t1", paths: ["Show"], afterCopy: "archive" })).statusCode, 400, "二选一");
  assert.equal((await call("POST", "/api/copy/after", { afterCopy: "archive" })).statusCode, 400, "都没给");
  assert.equal((await call("POST", "/api/copy/after", { ids: ["k1"], afterCopy: "keep" })).statusCode, 400, "去向只能是归档 / 删除");
  assert.equal((await call("POST", "/api/copy/after", { ids: ["k1"] })).statusCode, 400, "去向必填");
  assert.equal((await call("POST", "/api/copy/after", { taskId: "没有", paths: ["Show"], afterCopy: "archive" })).statusCode, 404);

  const write = createApiToken({ name: "写-after", scopes: ["read", "run", "write"], toolsets: ["transfer"], expiresAt: null }).token;
  const denied = await call("POST", "/api/copy/after", { ids: ["k1"], afterCopy: "delete" }, { authorization: `Bearer ${write}` });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, "INSUFFICIENT_SCOPE");
  const viaToken = await call("POST", "/api/copy/after", { ids: ["k1"], afterCopy: "archive" }, { authorization: `Bearer ${write}` });
  assert.equal(viaToken.statusCode, 200, "归档只要「改网盘」档");
  const readOnly = createApiToken({ name: "读-after", scopes: ["read"], toolsets: ["transfer"], expiresAt: null }).token;
  assert.equal((await call("POST", "/api/copy/after", { ids: ["k1"], afterCopy: "archive" }, { authorization: `Bearer ${readOnly}` })).statusCode, 403);
});

test("没有 token 一律 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/copy" });
  assert.equal(res.statusCode, 401);
});

test("GET /api/copy：队列和循环状态一起给", async () => {
  enqueueCopy({ account: "acc", sources: ["/tv/某剧/S01/E01.mkv"], rootPath: "/tv", trigger: "monitor" });
  const res = await call("GET", "/api/copy");
  assert.equal(res.statusCode, 200);
  const body = res.json() as { items: Array<{ name: string; dstDir: string }>; total: number; watcher: { pending: number } };
  assert.equal(body.items.length, 1);
  assert.equal(body.total, 1);
  assert.equal(body.items[0].name, "E01.mkv");
  assert.equal(body.items[0].dstDir, "/local/media/某剧/S01");
  assert.equal(body.watcher.pending, 1);
});

test("重试：只有办完/失败的才让重试，不存在的 404", async () => {
  enqueueCopy({ account: "acc", sources: ["/tv/a.mkv"], trigger: "manual" });
  const [c] = listCopies();
  const running = await call("POST", `/api/copy/${c.id}/retry`);
  assert.equal(running.statusCode, 409, "还在跑的不用重试");

  const missing = await call("POST", "/api/copy/没这个 id/retry");
  assert.equal(missing.statusCode, 404);
});

test("DELETE /api/copy/:id：从队列里去掉", async () => {
  enqueueCopy({ account: "acc", sources: ["/tv/a.mkv"], trigger: "manual" });
  const [c] = listCopies();
  const res = await call("DELETE", `/api/copy/${c.id}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { success: true });
  assert.equal(listCopies().length, 0);
});


test("GET /api/copy：每条带 canRetry；能重试的排在前面、再是还在跑的，老的失败不会被新的成功挤出去", async () => {
  const now = Date.now();
  const rec = (id: string, over: Partial<CopyRecord>): CopyRecord => ({
    id, account: "acc", srcDir: "/tv", name: `${id}.mkv`, dstDir: "/local/media", dstBase: "/local/media", taskId: "", trigger: "monitor", afterCopy: "keep",
    addedAt: now, status: "done", stage: "waiting", detail: "", attempts: 0, waits: 0, misses: 0, doneAt: now, ...over,
  });
  saveCopies([
    rec("done", { addedAt: now }),
    rec("pending", { status: "pending", addedAt: now - 1_000, doneAt: undefined }),
    rec("gone", { status: "skipped", superseded: true, addedAt: now - 500 }),
    rec("failed", { status: "failed", addedAt: now - 60_000 }),
  ]);
  const res = await call("GET", "/api/copy?limit=2");
  assert.equal(res.statusCode, 200);
  const body = res.json() as { items: Array<{ id: string; canRetry: boolean }>; total: number };
  assert.deepEqual(body.items.map((i) => i.id), ["failed", "pending"]);
  assert.deepEqual(body.items.map((i) => i.canRetry), [true, false]);
  assert.equal(body.total, 4);
  const all = (await call("GET", "/api/copy")).json() as { items: Array<{ id: string; canRetry: boolean }> };
  assert.equal(all.items.find((i) => i.id === "gone")?.canRetry, false, "用不着了的不给重试");
});
