/**
 * 归档到暂存区的路由：POST /api/drive/archive。会话和「写 + 转存那一组」的令牌能用，只读令牌 403；任务不存在 404、参数不对 400。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/drive/archive.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import archiveRoute from "./archive.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { createApiToken, deleteAllApiTokens } from "../../db/repositories/api-tokens.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import { __test_resetCopy, setCopyServiceDeps } from "../../services/copy/service.js";
import { FakeDrive } from "../../test/fake-drive.js";

let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: { accounts: AccountInfo[]; tasks: TaskDefinition[]; agent: AppSettings["agent"] };
let fake: FakeDrive;

const drive: AccountInfo = { accountType: "115", name: "acc", cookie: "c" };
const task: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "drive-archive-itest/tv", strmPrefix: "/mnt" };

const call = (body: Record<string, unknown>, headers: Record<string, string> = auth) => app.inject({ method: "POST", url: "/api/drive/archive", headers, payload: body });

before(async () => {
  baseline = { accounts: listAccounts(), tasks: listTasks(), agent: readAppSettings().agent };
  replaceAccounts([drive]);
  replaceTasks([task]);
  // 令牌要能用得先开智能体接入
  patchAppSettings({ agent: { ...(readAppSettings().agent ?? {}), enabled: true } });
  fake = new FakeDrive("115", drive);
  fake.tree.addFile("/tv/Show/E01.mkv");
  fake.tree.addFile("/tv/Show/E02.mkv");
  setDriveProviderFactory((a) => (a.name === "acc" ? fake : null));
  setCopyServiceDeps({ notify: async () => {} });
  await writeAuthPassword("drive-archive-itest-pw");

  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(archiveRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
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
  patchAppSettings({ agent: baseline.agent });
});

test("POST /api/drive/archive：会话收一个文件进归档；参数不对 400、任务不存在 404；写令牌能用、只读令牌 403", async () => {
  const res = await call({ taskId: "t1", paths: ["Show/E01.mkv"] });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { done: number; archiveDir: string; items: Array<{ path: string; outcome: string; to?: string }> };
  assert.equal(body.done, 1);
  assert.equal(body.archiveDir, "/tv/归档");
  assert.deepEqual(body.items.map((i) => [i.path, i.outcome, i.to]), [["Show/E01.mkv", "archived", "/tv/归档/Show"]]);
  assert.ok(fake.tree.get("/tv/归档/Show/E01.mkv"));
  assert.equal(fake.tree.get("/tv/Show/E01.mkv"), undefined);

  assert.equal((await call({ taskId: "t1", paths: [] })).statusCode, 400);
  assert.equal((await call({ taskId: "t1" })).statusCode, 400);
  assert.equal((await call({ paths: ["Show"] })).statusCode, 400);
  const staging = await call({ taskId: "t1", paths: ["归档/Show"] });
  assert.equal(staging.statusCode, 400);
  assert.match(staging.json().message, /暂存区/);
  assert.equal((await call({ taskId: "没有", paths: ["Show"] })).statusCode, 404);

  const readOnly = createApiToken({ name: "只读", scopes: ["read"], toolsets: ["transfer"], expiresAt: null }).token;
  assert.equal((await call({ taskId: "t1", paths: ["Show/E02.mkv"] }, { authorization: `Bearer ${readOnly}` })).statusCode, 403);
  const otherSet = createApiToken({ name: "只同步", scopes: ["read", "run", "write"], toolsets: ["sync"], expiresAt: null }).token;
  assert.equal((await call({ taskId: "t1", paths: ["Show/E02.mkv"] }, { authorization: `Bearer ${otherSet}` })).statusCode, 403);
  assert.ok(fake.tree.get("/tv/Show/E02.mkv"), "被拒的没动");
  const write = createApiToken({ name: "写", scopes: ["read", "run", "write"], toolsets: ["transfer"], expiresAt: null }).token;
  const viaToken = await call({ taskId: "t1", paths: ["Show/E02.mkv"] }, { authorization: `Bearer ${write}` });
  assert.equal(viaToken.statusCode, 200, viaToken.body);
  assert.equal(viaToken.json().items[0].outcome, "archived");
  assert.ok(fake.tree.get("/tv/归档/Show/E02.mkv"));
  assert.equal((await app.inject({ method: "POST", url: "/api/drive/archive", payload: { taskId: "t1", paths: ["Show"] } })).statusCode, 401, "没有 token 一律 401");
});
