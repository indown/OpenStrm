/**
 * /mcp 的闭环：起真实端口，用官方 SDK 的客户端连（新旧两版协议各一次），网盘用内存假网盘，115 云下载接口换成桩。
 *   - 门口：开关、Origin（同名的也不放）、令牌（401 带 WWW-Authenticate，Open WebUI 那种不带 Accept 的探测也一样）、
 *     默认密码、GET / DELETE 405、限流（批量消息按条数扣）、CORS 头穿过接管的响应
 *   - 档位：只读令牌看不到写工具；看不到的工具、参数不对也进调用记录
 *   - 工具：总览、任务列表、看目录、看分享、转存（生成 strm、去重、force、转存成功但 strm 失败不重存、多要追更只补建、
 *     子目录自动建、参数严格）、云下载、同步开跑到结束 / 没活可干、错误变成 isError
 *   - 每次调用都进调用记录
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/routes/mcp/mcp.itest.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import http from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AccountInfo, AppSettings, TaskDefinition } from "@openstrm/shared";
import { registerErrorHandling } from "../../plugins/error-handler.js";
import { authPlugin } from "../../plugins/auth.js";
import mcpRoute from "./index.js";
import { DEFAULT_AUTH } from "../../db/defaults.js";
import { writeAuthPassword } from "../../db/repositories/auth.js";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { createApiToken, deleteAllApiTokens } from "../../db/repositories/api-tokens.js";
import { listAgentCalls } from "../../db/repositories/agent-audit.js";
import { patchAppSettings, readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { DATA_DIR } from "../../paths.js";
import { setDriveProviderFactory } from "../../services/drive/registry.js";
import { __test_resetFollows, listFollows, setFollowServiceDeps } from "../../services/follow/service.js";
import { setOfflineTransport, type OfflineTransport } from "../../services/cloud-115/offline.js";
import { __test_resetOffline, listFollowups, setOfflineServiceDeps } from "../../services/offline/service.js";
import { __test_resetAgentQuota, takeAgentQuota } from "../../services/agent/rate-limit.js";
import { __test_resetJobs } from "../../services/agent/jobs.js";
import { __test_resetTransferCaches } from "../../services/agent/tools/transfer.js";
import { cancelAllRunningTasks } from "../../services/task/registry.js";
import { FakeDrive } from "../../test/fake-drive.js";

const a115: AccountInfo = { accountType: "115", name: "a", cookie: "c" };
const tv: TaskDefinition = { id: "m-tv", account: "a", accountType: "115", originPath: "tv", targetPath: "mcp-itest/tv", strmPrefix: "/mnt/pan" };
const movies: TaskDefinition = { id: "m-movies", account: "a", accountType: "115", originPath: "movies", targetPath: "mcp-itest/movies", strmPrefix: "/mnt/pan" };
/** 网盘上是空目录、本地却有东西：开了删除多余文件也不删，只给提醒 */
const empty: TaskDefinition = {
  id: "m-empty", account: "a", accountType: "115", originPath: "empty", targetPath: "mcp-itest/empty", strmPrefix: "/mnt/pan", removeExtraFiles: true,
};

/** 115 云下载接口的桩：链接里带 bad 的回失败；offlineWebFail 设了就让 web 接口回这个（模拟登录超时） */
let offlineWebFail: Record<string, unknown> | null = null;
/** 列表桩回的任务；取消的用例塞一条进去看 offline_list 带不带 infoHash */
let offlineTasks: Record<string, unknown>[] = [];
/** web 接口收到的调用：取消要看 task_del 带的 hash 和 flag */
const offlineWebCalls: Array<{ ac: string; params: Record<string, unknown>; method: string }> = [];
const offlineTransport: OfflineTransport = {
  async web(_acc, ac, params, method) {
    offlineWebCalls.push({ ac, params: { ...params }, method });
    if (offlineWebFail) return offlineWebFail;
    if (ac === "task_lists") return { page: 1, page_count: 1, page_size: 30, count: offlineTasks.length, quota: 5, total: 10, tasks: offlineTasks };
    if (ac === "get_quota_info") return { state: true, quota: 5, total: 10 };
    return { state: true };
  },
  async ssp(_acc, _ac, payload) {
    const urls = Object.keys(payload).filter((k) => k.startsWith("url[")).map((k) => String(payload[k]));
    return {
      state: true,
      data: {
        state: true,
        result: urls.map((u, i) =>
          u.includes("bad") ? { state: false, errno: 10004, error_msg: "链接无效", url: u } : { state: true, errno: 0, info_hash: `h${i}`, name: `n${i}`, url: u },
        ),
      },
    };
  },
  async downPath() {
    return { state: true, errno: null, data: [] };
  },
};

const d115 = new FakeDrive("115", a115, { share: true });
const LINK = "https://115.com/s/abc?password=1234";

let app: FastifyInstance;
let url: string;
let readToken: string;
let dailyToken: string;
let dailyTokenId: string;
let baseline: { tasks: TaskDefinition[]; accounts: AccountInfo[]; settings: AppSettings };

before(async () => {
  baseline = { tasks: listTasks(), accounts: listAccounts(), settings: readAppSettings() };
  replaceTasks([tv, movies, empty]);
  replaceAccounts([a115]);
  replaceAppSettings({ ...baseline.settings, strmExtensions: [".mkv"], downloadExtensions: [], agent: { enabled: true, uiBaseUrl: "http://nas:3000" } });
  await writeAuthPassword("mcp-itest-pw");

  d115.tree.addDir("/tv/Show");
  d115.tree.addFile("/movies/Dune/Dune.mkv");
  d115.tree.addDir("/empty");
  fs.mkdirSync(path.join(DATA_DIR, "mcp-itest", "empty"), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "mcp-itest", "empty", "old.strm"), "/mnt/pan/empty/old.mkv");
  const share = d115.share!.define("abc", { title: "115 剧", password: "1234" });
  share.addFile("/S1/E01.mkv", { hash: "a" });
  share.addFile("/S1/E02.mkv", { hash: "b" });
  share.addFile("/readme.txt");
  setDriveProviderFactory((account) => (account.name === "a" ? d115 : null));
  setFollowServiceDeps({ notify: async () => {}, random: () => 0.5, gapMs: 0 });
  setOfflineTransport(offlineTransport);
  setOfflineServiceDeps({ resolveDirId: async () => "999", generate: async () => ({ generatedCount: 1, skippedCount: 0, invalidNames: [] }), notify: async () => {} });

  readToken = createApiToken({ name: "只读", scopes: ["read"], toolsets: ["sync", "transfer"], expiresAt: null }).token;
  const daily = createApiToken({ name: "日常", scopes: ["read", "run", "write"], toolsets: ["sync", "transfer"], expiresAt: null });
  dailyToken = daily.token;
  dailyTokenId = daily.info.id;

  app = Fastify();
  registerErrorHandling(app);
  // 和 index.ts 一样全局挂 CORS：它设的头要能穿过 /mcp 接管的响应
  await app.register(cors, { origin: true });
  await app.register(authPlugin);
  await app.register(mcpRoute);
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
});

after(async () => {
  cancelAllRunningTasks();
  await app.close();
  await __test_resetFollows();
  setFollowServiceDeps(null);
  await __test_resetOffline();
  setOfflineTransport(null);
  setOfflineServiceDeps(null);
  setDriveProviderFactory(null);
  __test_resetJobs();
  __test_resetTransferCaches();
  __test_resetAgentQuota();
  deleteAllApiTokens();
  replaceTasks(baseline.tasks);
  replaceAccounts(baseline.accounts);
  replaceAppSettings(baseline.settings);
  fs.rmSync(path.join(DATA_DIR, "mcp-itest"), { recursive: true, force: true });
  await writeAuthPassword(DEFAULT_AUTH.password);
});

// 每个用例连客户端、调工具都要扣配额（一个用例二三十次很常见）：各用例从满桶开始，只有限流那几个自己掏空
beforeEach(() => {
  __test_resetAgentQuota();
});

interface ConnectOpts {
  modern?: boolean;
  /** 声明 elicitation 并按这个答复确认框；不给就不声明 */
  elicit?: (message: string) => { action: "accept" | "decline" | "cancel"; content?: Record<string, string | number | boolean | string[]> };
}

async function connect(token: string, opts: ConnectOpts = {}): Promise<Client> {
  const client = new Client(
    { name: "mcp-itest", version: "1.0.0" },
    {
      ...(opts.modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
      ...(opts.elicit ? { capabilities: { elicitation: {} } } : {}),
    },
  );
  if (opts.elicit) {
    const answer = opts.elicit;
    client.setRequestHandler("elicitation/create", async (request) => answer((request.params as { message: string }).message));
  }
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

/** 调一个工具，把 text 块里的 JSON 解出来 */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const block = (res.content as Array<{ type: string; text?: string }>)[0];
  assert.equal(block?.type, "text", `${name} 没回 text 块`);
  return { isError: res.isError === true, data: JSON.parse(block.text!) as Record<string, any> };
}

const rawPost = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("门口：没令牌 401 带 WWW-Authenticate（Open WebUI 那种不带 Accept、params 为空的探测也一样）", async () => {
  const probe = await rawPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(probe.status, 401);
  assert.match(probe.headers.get("www-authenticate") ?? "", /^Bearer /);

  const bad = await rawPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: "Bearer ostk_nope" });
  assert.equal(bad.status, 401);
  // JWT 不认：/mcp 只收智能体令牌
  const jwt = await rawPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: `Bearer ${await app.signJwt({ username: "admin" })}` });
  assert.equal(jwt.status, 401);
});

test("门口：GET / DELETE 405，不鉴权；别的网站的 Origin 403", async () => {
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(url, { method: "DELETE" })).status, 405);
  const evil = await rawPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${dailyToken}`, origin: "https://evil.example" });
  assert.equal(evil.status, 403);
});

test("门口：开关关着 404", async () => {
  patchAppSettings({ agent: { enabled: false } });
  try {
    const res = await rawPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${dailyToken}` });
    assert.equal(res.status, 404);
    assert.equal((await fetch(url)).status, 404);
  } finally {
    patchAppSettings({ agent: { enabled: true, uiBaseUrl: "http://nas:3000" } });
  }
});

test("门口：超出限流 429 带 retry-after", async () => {
  const t = createApiToken({ name: "限流", scopes: ["read"], toolsets: ["sync", "transfer"], expiresAt: null });
  while (takeAgentQuota(t.info.id).ok) {
    /* 把桶掏空 */
  }
  const res = await rawPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${t.token}` });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) >= 1);
});

test("老协议：2025-06-18 和 2025-11-25 的 initialize 都原样接住", async () => {
  for (const version of ["2025-06-18", "2025-11-25"]) {
    const res = await rawPost(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "old", version: "1" } } },
      { authorization: `Bearer ${readToken}`, accept: "application/json, text/event-stream" },
    );
    assert.equal(res.status, 200, await res.clone().text());
    const text = await res.text();
    const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    assert.equal(json.result.protocolVersion, version);
    assert.equal(json.result.serverInfo.name, "openstrm");
    assert.match(json.result.instructions, /必须遵守/);
    assert.equal(res.headers.get("mcp-session-id"), null, "无状态：不发会话 id");
  }
});

test("只读令牌只看到只读工具；新旧两版协议的客户端都连得上", async () => {
  const legacy = await connect(readToken);
  const modern = await connect(readToken, { modern: true });
  try {
    for (const client of [legacy, modern]) {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      assert.ok(names.includes("overview"));
      assert.ok(!names.includes("share_save"));
      assert.ok(!names.includes("sync_start"));
      for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
    }
  } finally {
    await legacy.close();
    await modern.close();
  }
});

test("prompts：「找片入库」和收藏夹的三个流程按令牌展开（只读令牌不提 share_save）；用不上的令牌不声明 prompts 能力", async () => {
  const read = await connect(readToken);
  const daily = await connect(dailyToken, { modern: true });
  const syncOnly = await connect(createApiToken({ name: "只同步", scopes: ["read"], toolsets: ["sync"], expiresAt: null }).token);
  try {
    const { prompts } = await read.listPrompts();
    assert.deepEqual(
      prompts.map((p) => [p.name, p.title, p.arguments?.map((a) => [a.name, a.required])]),
      [
        ["find_and_save", "找片入库", [["title", true], ["type", false]]],
        ["library_fix", "收藏纠错", [["which", false]]],
        ["library_rescue", "失效找回", []],
        ["library_series", "补全剧集", [["title", true]]],
      ],
    );
    const readText = (await read.getPrompt({ name: "find_and_save", arguments: { title: "沙丘2" } })).messages[0].content as { type: string; text: string };
    assert.equal(readText.type, "text");
    assert.match(readText.text, /openInUi/);
    assert.doesNotMatch(readText.text, /share_save/);

    const dailyText = (await daily.getPrompt({ name: "find_and_save", arguments: { title: "繁花", type: "剧集" } })).messages[0].content as { text: string };
    assert.match(dailyText.text, /share_save，带 organize: true/);
    await assert.rejects(daily.getPrompt({ name: "find_and_save", arguments: { title: "" } }), /Invalid arguments/);
    // 没参数的、带参数的收藏夹流程都展得开
    const rescue = (await daily.getPrompt({ name: "library_rescue" })).messages[0].content as { text: string };
    assert.match(rescue.text, /library_sources（status: expired）/);
    const series = (await read.getPrompt({ name: "library_series", arguments: { title: "权力的游戏" } })).messages[0].content as { text: string };
    assert.match(series.text, /^帮我把「权力的游戏」缺的季补上/);
    assert.doesNotMatch(series.text, /share_save，带/, "只读令牌不转存");
    await assert.rejects(read.getPrompt({ name: "library_series", arguments: {} }), /Invalid arguments/);

    assert.equal(syncOnly.getServerCapabilities()?.prompts, undefined);
  } finally {
    await read.close();
    await daily.close();
    await syncOnly.close();
  }
});

test("总览和任务列表；认不出的任务回 isError + hint", async () => {
  const client = await connect(dailyToken);
  try {
    const overview = await call(client, "overview");
    assert.equal(overview.isError, false);
    assert.equal(overview.data.token.name, "日常");
    assert.equal(overview.data.tasks, 3);
    assert.ok(Array.isArray(overview.data.notes));

    const list = await call(client, "tasks_list", { query: "movies" });
    assert.equal(list.data.total, 1);
    assert.equal(list.data.tasks[0].id, "m-movies");
    assert.equal(list.data.tasks[0].label, "a · movies");

    const missing = await call(client, "sync_status", { task: "不存在的任务" });
    assert.equal(missing.isError, true);
    assert.equal(missing.data.code, "TASK_NOT_FOUND");
    assert.ok(missing.data.hint);
  } finally {
    await client.close();
  }
});

test("看分享、转存：生成 strm；10 分钟内同样的请求不再转存；force 再存一份", async () => {
  const client = await connect(dailyToken);
  try {
    const inspect = await call(client, "share_inspect", { link: `${LINK} 提取码：1234` });
    assert.equal(inspect.isError, false, JSON.stringify(inspect.data));
    assert.equal(inspect.data.title, "115 剧");
    const s1 = inspect.data.items.find((i: { name: string }) => i.name === "S1");
    assert.ok(s1?.isDir);
    assert.match(inspect.data.openInUi, /^http:\/\/nas:3000\/home\?share=/);

    const saved = await call(client, "share_save", { link: LINK, task: "tv", subPath: "Show", itemIds: [s1.id] });
    assert.equal(saved.isError, false, JSON.stringify(saved.data));
    assert.equal(saved.data.state, "done");
    assert.equal(saved.data.strmGenerated, 2);
    assert.equal(fs.readFileSync(path.join(DATA_DIR, "mcp-itest", "tv", "Show", "S1", "E01.strm"), "utf8"), "/mnt/pan/tv/Show/S1/E01.mkv");

    const again = await call(client, "share_save", { link: LINK, task: "tv", subPath: "Show", itemIds: [s1.id] });
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.jobId, saved.data.jobId);

    const job = await call(client, "job_status", { jobId: saved.data.jobId });
    assert.equal(job.data.status, "done");

    const forced = await call(client, "share_save", { link: LINK, task: "tv", subPath: "Show", itemIds: [s1.id], force: true });
    assert.equal(forced.data.state, "done");
    assert.notEqual(forced.data.jobId, saved.data.jobId);

    // 转存之前就失败了（网盘上目标是个同名文件）不算重复：原样重试不会被当成重复拦下
    d115.tree.addFile("/tv/Broken");
    const failed = await call(client, "share_save", { link: LINK, task: "tv", subPath: "Broken", itemIds: [s1.id] });
    assert.equal(failed.isError, true, JSON.stringify(failed.data));
    const retried = await call(client, "share_save", { link: LINK, task: "tv", subPath: "Broken", itemIds: [s1.id] });
    assert.notEqual(retried.data.duplicate, true, "失败之后原样重试不该被当成重复");

    const unknown = await call(client, "share_save", { link: LINK, task: "tv", itemIds: ["no-such-id"] });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.data.code, "ITEM_NOT_FOUND");
  } finally {
    await client.close();
  }
});

test("同步：开跑后用 sync_status 等到结束，历史里查得到", async () => {
  const client = await connect(dailyToken);
  try {
    const started = await call(client, "sync_start", { task: "movies" });
    assert.equal(started.isError, false, JSON.stringify(started.data));
    assert.ok(["running", "up_to_date", "starting"].includes(started.data.state), started.data.state);

    const status = await call(client, "sync_status", { task: "m-movies", waitSeconds: 10 });
    assert.equal(status.data.state, "completed", JSON.stringify(status.data));
    assert.equal(status.data.done, 1);
    assert.ok(fs.existsSync(path.join(DATA_DIR, "mcp-itest", "movies", "Dune", "Dune.strm")));

    const byId = await call(client, "sync_status", { executionId: status.data.executionId, detail: "full" });
    assert.equal(byId.data.executionId, status.data.executionId);
    assert.deepEqual(byId.data.failedFiles, []);

    const history = await call(client, "sync_history", { task: "movies" });
    assert.ok(history.data.executions.some((e: { executionId: string }) => e.executionId === status.data.executionId));

    const idle = await call(client, "sync_cancel", { task: "movies" });
    assert.equal(idle.data.state, "idle");
  } finally {
    await client.close();
  }
});

/** tools/call 走原始 HTTP：批量、令牌看不到的工具这些 SDK 客户端不好构造的场景用 */
const rpcHeaders = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" });
const toolCall = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

/** 响应可能是 JSON 也可能是 SSE：把里面的 JSON-RPC 消息都解出来 */
async function rpcMessages(res: Response): Promise<Array<Record<string, any>>> {
  const text = await res.text();
  if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [v];
  }
  return text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
}

test("门口：批量消息按条数扣配额，超过 10 条整个拒掉", async () => {
  const t = createApiToken({ name: "批量", scopes: ["read"], toolsets: ["sync", "transfer"], expiresAt: null });
  const batch = [1, 2, 3].map((i) => toolCall(i, "tasks_list"));
  const res = await rawPost(batch, rpcHeaders(t.token));
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await rpcMessages(res)).length, 3);
  // 桶里原本 30 个：扣掉 3 个之后再掏，最多还能拿到 27 个（加上这点时间里补回来的）
  let left = 0;
  while (takeAgentQuota(t.info.id).ok) left++;
  assert.ok(left <= 28, `批量只扣了一个配额：还剩 ${left}`);

  __test_resetAgentQuota();
  const tooMany = await rawPost(Array.from({ length: 11 }, (_, i) => toolCall(i, "tasks_list")), rpcHeaders(t.token));
  assert.equal(tooMany.status, 400);
});

test("门口：令牌看不到的工具、编出来的工具、参数不对，都进调用记录；参数不对回 JSON 的 VALIDATION", async () => {
  const t = createApiToken({ name: "越权试探", scopes: ["read"], toolsets: ["sync", "transfer"], expiresAt: null });
  const res = await rawPost([toolCall(1, "share_save", { link: LINK, task: "tv" }), toolCall(2, "rm_rf", { path: "/" })], rpcHeaders(t.token));
  assert.equal(res.status, 200);
  const replies = await rpcMessages(res);
  assert.ok(replies.every((r) => r.error || r.result?.isError), JSON.stringify(replies));

  const client = await connect(t.token);
  try {
    const bad = await call(client, "job_status", { jobId: "" });
    assert.equal(bad.isError, true);
    assert.equal(bad.data.code, "VALIDATION");
    assert.ok(bad.data.hint);
  } finally {
    await client.close();
  }

  const rows = listAgentCalls({ tokenId: t.info.id, limit: 20 });
  const byTool = new Map(rows.map((r) => [r.tool, r]));
  assert.match(byTool.get("share_save")?.error ?? "", /^TOOL_NOT_ALLOWED/);
  assert.match(byTool.get("rm_rf")?.error ?? "", /^UNKNOWN_TOOL/);
  assert.match(byTool.get("job_status")?.error ?? "", /^VALIDATION/);
  assert.ok(rows.every((r) => r.ip === "127.0.0.1"), "调用记录带 IP");
  assert.ok(!byTool.get("share_save")!.args.includes("1234"), "被挡下的调用参数里的提取码也要抹");
});

test("门口：浏览器来的请求（Origin 放行的）拿得到 CORS 头；和 Host 同名的 Origin 不放行（DNS 重绑定）", async () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "b", version: "1" } } };
  const res = await rawPost(init, { ...rpcHeaders(readToken), origin: "http://localhost:6274" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:6274");

  // fetch 改不了 Host，用 node:http 直接发：Host 和 Origin 都是攻击者的域名
  const { port } = new URL(url);
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { ...rpcHeaders(readToken), "content-type": "application/json", host: `evil.example:${port}`, origin: `http://evil.example:${port}` } },
      (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(init));
  });
  assert.equal(status, 403);
});

test("门口：还在用默认密码时拿着令牌也不让进", async () => {
  await writeAuthPassword(DEFAULT_AUTH.password);
  try {
    const res = await rawPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, rpcHeaders(dailyToken));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "PASSWORD_CHANGE_REQUIRED");
  } finally {
    await writeAuthPassword("mcp-itest-pw");
  }
});

test("看目录：同一个目录从账号根和从任务进来，结果里的任务和相对路径各按各的口径", async () => {
  const client = await connect(dailyToken);
  try {
    const byAccount = await call(client, "drive_browse", { account: "a", path: "tv/Show" });
    assert.equal(byAccount.data.task, undefined);
    assert.equal(byAccount.data.path, "tv/Show");
    const byTask = await call(client, "drive_browse", { task: "tv", path: "Show" });
    assert.equal(byTask.data.task.id, "m-tv");
    assert.equal(byTask.data.path, "Show", "缓存只存列表，不能把上一个调用方的口径带过来");
    assert.equal(byTask.data.drivePath, "tv/Show");
  } finally {
    await client.close();
  }
});

test("看分享：标题跟着列表回来不再单独调 info（列表没带才调）；提取码错了不拿缓存", async () => {
  __test_resetTransferCaches();
  const client = await connect(dailyToken);
  try {
    const before = d115.share!.calls.info;
    const ok = await call(client, "share_inspect", { link: LINK });
    assert.equal(ok.data.title, "115 剧");
    assert.equal(d115.share!.calls.info, before);

    const wrong = await call(client, "share_inspect", { link: "https://115.com/s/abc?password=9999" });
    assert.equal(wrong.isError, true, "提取码不对要报错，不能拿对的那次的缓存");
    assert.equal(wrong.data.code, "SHARE_GONE");

    __test_resetTransferCaches();
    d115.share!.titleInList = false;
    const fallback = await call(client, "share_inspect", { link: LINK });
    assert.equal(fallback.data.title, "115 剧");
    assert.equal(d115.share!.calls.info, before + 1);
  } finally {
    d115.share!.titleInList = true;
    await client.close();
  }
});

test("转存：子目录不存在就建；itemIds 空的、参数名写错的直接报错（不会整层都存）；null 当没填", async () => {
  const client = await connect(dailyToken);
  try {
    const s1 = (await call(client, "share_inspect", { link: LINK })).data.items.find((i: { name: string }) => i.name === "S1");
    const saved = await call(client, "share_save", { link: LINK, task: "tv", subPath: "New/Deep", itemIds: [s1.id] });
    assert.equal(saved.data.state, "done", JSON.stringify(saved.data));
    assert.ok(d115.tree.get("/tv/New/Deep")?.isDir);
    assert.ok(fs.existsSync(path.join(DATA_DIR, "mcp-itest", "tv", "New", "Deep", "S1", "E01.strm")));

    const receives = d115.share!.calls.receive;
    for (const args of [{ itemIds: [] }, { itemIds: ["  "] }, { item_ids: [s1.id] }]) {
      const r = await call(client, "share_save", { link: LINK, task: "tv", ...args });
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.equal(r.data.code, "VALIDATION", JSON.stringify(r.data));
    }
    assert.equal(d115.share!.calls.receive, receives, "参数不对不该转存任何东西");

    // 有的模型把没填的可选参数写成 null：当没填，和上面那次是同一个请求
    const nulls = await call(client, "share_save", { link: LINK, task: "tv", subPath: "New/Deep", itemIds: [s1.id], dirId: null, follow: null });
    assert.equal(nulls.data.duplicate, true, JSON.stringify(nulls.data));
  } finally {
    await client.close();
  }
});

test("转存：已经转存进网盘、只是本地 strm 没生成好（received），原样重试不再转存，提示用 sync_start 补", async () => {
  // 本地要建 strm 目录的地方是个文件：转存成功之后生成 strm 失败
  fs.mkdirSync(path.join(DATA_DIR, "mcp-itest", "tv"), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "mcp-itest", "tv", "Clash"), "x");
  const client = await connect(dailyToken);
  try {
    const s1 = (await call(client, "share_inspect", { link: LINK })).data.items.find((i: { name: string }) => i.name === "S1");
    const receives = d115.share!.calls.receive;
    const failed = await call(client, "share_save", { link: LINK, task: "tv", subPath: "Clash", itemIds: [s1.id] });
    assert.equal(failed.isError, true, JSON.stringify(failed.data));
    assert.equal(failed.data.received, true);
    assert.match(failed.data.hint, /sync_start/);
    assert.equal(d115.share!.calls.receive, receives + 1);

    const retried = await call(client, "share_save", { link: LINK, task: "tv", subPath: "Clash", itemIds: [s1.id] });
    assert.equal(retried.data.duplicate, true, JSON.stringify(retried.data));
    assert.equal(retried.data.received, true);
    assert.equal(d115.share!.calls.receive, receives + 1, "重试不能再转存一遍：网盘里会多一份");
  } finally {
    await client.close();
  }
});

test("转存 + 追更：名字是分享标题（子目录是「标题 / 路径」），整层转存追整层；同样的请求多要 follow 只补建订阅", async () => {
  __test_resetTransferCaches();
  const client = await connect(dailyToken);
  try {
    const root = await call(client, "share_inspect", { link: LINK });
    const s1 = root.data.items.find((i: { name: string }) => i.name === "S1");
    const readme = root.data.items.find((i: { name: string }) => i.name === "readme.txt");

    const plain = await call(client, "share_save", { link: LINK, task: "movies", itemIds: [readme.id] });
    assert.equal(plain.data.state, "done", JSON.stringify(plain.data));
    const receives = d115.share!.calls.receive;
    const withFollow = await call(client, "share_save", { link: LINK, task: "movies", itemIds: [readme.id], follow: true });
    assert.equal(withFollow.data.duplicate, true, JSON.stringify(withFollow.data));
    assert.equal(withFollow.data.follow?.name, "115 剧");
    assert.equal(d115.share!.calls.receive, receives, "只补建订阅，不再转存");

    // 追子目录：没看过这个目录就不知道它在分享里的路径，先别动
    __test_resetTransferCaches();
    const unknown = await call(client, "share_save", { link: LINK, task: "movies", subPath: "S1sub", dirId: s1.id, follow: true });
    assert.equal(unknown.data.code, "DIR_PATH_UNKNOWN");

    await call(client, "share_inspect", { link: LINK });
    const inside = await call(client, "share_inspect", { link: LINK, dirId: s1.id });
    assert.equal(inside.data.path, "S1");
    const sub = await call(client, "share_save", { link: LINK, task: "movies", subPath: "S1sub", dirId: s1.id, follow: true });
    assert.equal(sub.data.state, "done", JSON.stringify(sub.data));
    const f = listFollows().follows.find((x) => x.id === sub.data.follow?.id);
    assert.ok(f, JSON.stringify(sub.data));
    assert.equal(f.name, "115 剧 / S1");
    assert.equal(f.watchPath, "S1");
    // 整层（没给 itemIds）：分享者以后在这一层加的目录也要追到
    assert.deepEqual(f.scope, [""]);
  } finally {
    await client.close();
  }
});

test("云下载：重复和认不出的链接不占名额；每条结果带着是哪个链接；账号失效的错误带「别重试」的提示", async () => {
  const client = await connect(dailyToken);
  try {
    const lines = ["magnet:?xt=urn:btih:aaa", "magnet:?xt=urn:btih:aaa", "thunder://xyz", "magnet:?xt=urn:btih:bad", ...Array.from({ length: 49 }, () => "magnet:?xt=urn:btih:aaa")];
    const added = await call(client, "offline_add", { urls: lines.join("\n"), task: "tv" });
    assert.equal(added.isError, false, JSON.stringify(added.data));
    assert.deepEqual(added.data.invalid, ["thunder://xyz"]);
    assert.equal(added.data.results.length, 2);
    const bad = added.data.results.find((r: { ok: boolean }) => !r.ok);
    assert.equal(bad.url, "magnet:?xt=urn:btih:bad", "失败的那条要说清是哪个链接");

    offlineWebFail = { state: false, errno: 990001, error: "登录超时，请重新登录" };
    const list = await call(client, "offline_list", {});
    assert.equal(list.isError, true);
    assert.match(list.data.hint ?? "", /不要反复重试/);
  } finally {
    offlineWebFail = null;
    await client.close();
  }
});

test("云下载：取消 → 115 收到 task_del、回执一并撤掉；列表带 infoHash；连文件一起删要删除档、新协议客户端先确认", async () => {
  const fullToken = createApiToken({ name: "完全", scopes: ["read", "run", "write", "danger"], toolsets: ["sync", "transfer"], expiresAt: null }).token;
  const asked: string[] = [];
  const daily = await connect(dailyToken);
  const declining = await connect(fullToken, { modern: true, elicit: (m) => (asked.push(m), { action: "decline" }) });
  const accepting = await connect(fullToken, { modern: true, elicit: (m) => (asked.push(m), { action: "accept", content: { confirm: true } }) });
  const pendingHashes = () => listFollowups().filter((f) => f.account === "a" && f.status === "pending").map((f) => f.infoHash);
  try {
    const added = await call(daily, "offline_add", { urls: "magnet:?xt=urn:btih:one\nmagnet:?xt=urn:btih:two", task: "tv" });
    assert.equal(added.data.added, 2, JSON.stringify(added.data));
    assert.deepEqual(added.data.results.map((r: { infoHash: string }) => r.infoHash), ["h0", "h1"]);
    assert.ok(pendingHashes().includes("h0") && pendingHashes().includes("h1"), "两条都登记了回执");

    // 列表里每条带 infoHash（取消要用它指任务）；没兑现的回执也带
    offlineTasks = [{ info_hash: "h0", name: "n0", status: 1, percentDone: 40, size: 10, add_time: 1, url: "magnet:?xt=urn:btih:one", file_id: "999", wp_path_id: "999", delete_file_id: "r", del_path: "n0", file_category: "1" }];
    const list = await call(daily, "offline_list", {});
    assert.equal(list.isError, false, JSON.stringify(list.data));
    assert.equal(list.data.tasks[0].infoHash, "h0");
    assert.ok(list.data.strmPending.some((f: { infoHash: string }) => f.infoHash === "h1"));

    // 只取消：task_del 带 flag 0 和 hash（重复、带空白的归一），回执撤掉
    offlineWebCalls.length = 0;
    const cancelled = await call(daily, "offline_cancel", { infoHashes: ["h1", " h1 "] });
    assert.equal(cancelled.isError, false, JSON.stringify(cancelled.data));
    assert.equal(cancelled.data.cancelled, 1);
    assert.equal(cancelled.data.followupsDropped, 1);
    assert.equal(cancelled.data.deleteFiles, false);
    const del = offlineWebCalls.find((c) => c.ac === "task_del");
    assert.equal(del?.method, "POST");
    assert.deepEqual(del?.params, { flag: 0, "hash[0]": "h1" });
    assert.ok(!pendingHashes().includes("h1") && pendingHashes().includes("h0"), "只撤掉取消的那条的回执");

    // 连文件一起删：日常档被拒，115 没收到
    offlineWebCalls.length = 0;
    const refused = await call(daily, "offline_cancel", { infoHashes: ["h0"], deleteFiles: true });
    assert.equal(refused.isError, true);
    assert.equal(refused.data.code, "INSUFFICIENT_SCOPE");
    assert.equal(refused.data.required, "danger");
    assert.equal(offlineWebCalls.length, 0);

    // 完全档：新协议客户端先弹确认框，拒绝就不动；同意才带 flag 1 发给 115
    const no = await call(declining, "offline_cancel", { infoHashes: ["h0"], deleteFiles: true });
    assert.equal(no.isError, true);
    assert.equal(no.data.code, "DECLINED");
    assert.equal(asked.length, 1);
    assert.match(asked[0], /取消 1 个 115 云下载任务.*删掉/);
    assert.equal(offlineWebCalls.length, 0);
    assert.ok(pendingHashes().includes("h0"));

    const yes = await call(accepting, "offline_cancel", { infoHashes: ["h0"], deleteFiles: true });
    assert.equal(yes.isError, false, JSON.stringify(yes.data));
    assert.equal(asked.length, 2);
    assert.equal(yes.data.deleteFiles, true);
    assert.deepEqual(offlineWebCalls.find((c) => c.ac === "task_del")?.params, { flag: 1, "hash[0]": "h0" });
    assert.ok(!pendingHashes().includes("h0"));

    // 115 说登录超时：原话带回来，提示别反复重试
    offlineWebFail = { state: false, errno: 990001, error: "登录超时，请重新登录" };
    const failed = await call(daily, "offline_cancel", { infoHashes: ["h0"] });
    assert.equal(failed.isError, true);
    assert.match(failed.data.error, /登录超时/);
    assert.match(failed.data.hint ?? "", /不要反复重试/);
  } finally {
    offlineWebFail = null;
    offlineTasks = [];
    await daily.close();
    await declining.close();
    await accepting.close();
  }
});

test("同步：没活可干的那次启动，sync_status 不拿更早的记录顶替；远端为空跳过清理的提醒带出来", async () => {
  const client = await connect(dailyToken);
  try {
    // movies 上一个用例已经同步过：这次无事可做，也不留执行记录
    const again = await call(client, "sync_start", { task: "movies" });
    assert.equal(again.data.state, "up_to_date", JSON.stringify(again.data));
    const status = await call(client, "sync_status", { task: "movies" });
    assert.equal(status.data.state, "up_to_date", JSON.stringify(status.data));

    const empty = await call(client, "sync_start", { task: "m-empty" });
    assert.equal(empty.data.state, "up_to_date", JSON.stringify(empty.data));
    assert.match(empty.data.warning ?? "", /远端目录为空/);
    const emptyStatus = await call(client, "sync_status", { task: "m-empty" });
    assert.match(emptyStatus.data.warning ?? "", /远端目录为空/);
    assert.ok(fs.existsSync(path.join(DATA_DIR, "mcp-itest", "empty", "old.strm")), "远端为空时不能把本地清掉");
  } finally {
    await client.close();
  }
});

test("每次工具调用都进调用记录：令牌名、工具名、成败；提取码抹掉", async () => {
  const calls = listAgentCalls({ tokenId: dailyTokenId, limit: 200 });
  const tools = new Set(calls.map((c) => c.tool));
  for (const t of ["overview", "tasks_list", "share_inspect", "share_save", "sync_start"]) assert.ok(tools.has(t), t);
  assert.ok(calls.every((c) => c.tokenName === "日常"));
  assert.ok(calls.some((c) => !c.ok && c.error.startsWith("TASK_NOT_FOUND")));
  const inspect = calls.find((c) => c.tool === "share_inspect")!;
  assert.ok(!inspect.args.includes("1234"), inspect.args);
  assert.ok(!calls.some((c) => c.tool.startsWith("POST ")), "MCP 的 HTTP 请求不再重复记一笔");
  assert.ok(calls.every((c) => c.ip === "127.0.0.1"));
});
