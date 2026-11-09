/**
 * 列 CloudDrive2 目录的接口：只给目录、形状同 /api/directory/remote/list；目录不存在 404；没配 CD2 400。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/cd2/list.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppSettings } from "@openstrm/shared";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { authPlugin } from "../../plugins/auth.js";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { __test_resetCd2Tokens } from "../../services/cd2/client.js";
import { FakeCd2 } from "../../test/fake-cd2.js";
import listRoute from "./list.js";

const fake = new FakeCd2();
let app: FastifyInstance;
let auth: Record<string, string>;
let baseline: AppSettings["cd2"];

before(async () => {
  baseline = readAppSettings().cd2;
  await fake.start();
  await writeAuthPassword("cd2-list-itest-pw");
  app = Fastify();
  registerErrorHandling(app);
  await app.register(authPlugin);
  await app.register(listRoute);
  await app.ready();
  auth = { authorization: `Bearer ${await app.signJwt({ username: DEFAULT_AUTH.username })}` };
});
beforeEach(() => {
  fake.reset();
  fake.tree = { "/": ["115/", "hdd/"], "/115": ["movie/", "tv/", "readme.txt"] };
  __test_resetCd2Tokens();
  patchAppSettings({ cd2: { url: fake.url, apiToken: "api-token" } });
});
after(async () => {
  await app.close();
  await fake.stop();
  patchAppSettings({ cd2: baseline });
  await writeAuthPassword(DEFAULT_AUTH.password);
});

const list = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/cd2/list", headers: auth, payload });

test("只给目录，id 是完整路径；根目录不给 path 也行", async () => {
  const res = await list({ path: "/115" });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), [
    { name: "movie", id: "/115/movie", isDir: true, hasChildren: true },
    { name: "tv", id: "/115/tv", isDir: true, hasChildren: true },
  ]);
  const root = await list({});
  assert.deepEqual(root.json().map((n: { name: string }) => n.name), ["115", "hdd"]);
});

test("目录不存在 404；设置里没填 CD2 400", async () => {
  const missing = await list({ path: "/115/nope" });
  assert.equal(missing.statusCode, 404);
  patchAppSettings({ cd2: {} });
  const unset = await list({ path: "/115" });
  assert.equal(unset.statusCode, 400);
  assert.match(unset.json().message, /CloudDrive2 一节还没填/);
});
