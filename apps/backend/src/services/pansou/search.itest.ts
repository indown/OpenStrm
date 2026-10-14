/**
 * 资源搜索的服务层对着假 PanSou：没配置的报错、网页的 first（先搜 TG + 预热全量）/ more / full、服务端多轮等结果（变多就再问、
 * 连着两轮不变才停、0 条要等插件跑完、预算、缓存、同一个词搭同一趟、第二轮出错用已有的）、链接检测（只收认得的分享、分批、缓存、
 * 不支持就记住、检查连接后重试）、检查连接、错误换算。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/pansou/search.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AccountInfo, ShareFollow, TaskDefinition } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { deleteAppSetting, writeAppSetting } from "../../db/repositories/settings.js";
import { listShareFollowRefs, listShareFollows, replaceShareFollows } from "../../db/repositories/share-follows.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { HttpError, UPSTREAM_ERROR_STATUS } from "../../lib/http-error.js";
import { settingsPatchSchema } from "../../schemas/entities.js";
import { FakePansou, SAMPLE } from "../../test/fake-pansou.js";
import { PansouError, __test_clearPansouTokens, __test_setSearchTimeout } from "./client.js";
import {
  __test_clearPansouCaches,
  __test_setRoundGap,
  checkResourceLinks,
  pansouHttpError,
  pansouStatus,
  searchPhase,
  searchSettled,
} from "./search.js";

const fake = new FakePansou();
let baselineAccounts: AccountInfo[];
let baselineTasks: TaskDefinition[];
let baselineFollows: ShareFollow[];

before(async () => {
  await fake.start();
  baselineAccounts = listAccounts();
  baselineTasks = listTasks();
  baselineFollows = listShareFollows();
  __test_setRoundGap(20);
});

after(async () => {
  await fake.stop();
  replaceAccounts(baselineAccounts);
  replaceTasks(baselineTasks);
  replaceShareFollows(baselineFollows);
  deleteAppSetting("pansou");
  __test_setRoundGap(3_000);
});

beforeEach(() => {
  fake.reset();
  __test_clearPansouTokens();
  __test_clearPansouCaches();
  writeAppSetting("pansou", { baseUrl: fake.url });
  replaceAccounts([
    { accountType: "115", name: "a", cookie: "c" },
    { accountType: "quark", name: "q", cookie: "c" },
  ]);
});

async function httpRejects(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof HttpError, String(err));
    assert.equal(err.status, status);
    assert.equal(err.extra.code, code);
    return true;
  });
}

test("没配置：三个入口都报 400 + PANSOU_NOT_CONFIGURED，不发请求", async () => {
  writeAppSetting("pansou", { baseUrl: "  " });
  await httpRejects(searchPhase("x", "first"), 400, "PANSOU_NOT_CONFIGURED");
  await httpRejects(searchSettled("x"), 400, "PANSOU_NOT_CONFIGURED");
  await httpRejects(checkResourceLinks(["https://115.com/s/swabc"]), 400, "PANSOU_NOT_CONFIGURED");
  assert.equal(fake.requests.length, 0);
});

test("first：频道、插件都有 → 回只搜 TG 的结果，同时发一个全量预热；more 搜全量", async () => {
  fake.onSearch = (body) => (body.src === "tg" ? { "115": [SAMPLE.l115] } : { "115": [SAMPLE.l115, SAMPLE.l115b], quark: [SAMPLE.quark] });
  const first = await searchPhase(" 沙丘2 ", "first");
  assert.equal(first.keyword, "沙丘2");
  assert.deepEqual(first.counts, { "115": 1 });
  // 预热不等：给它一点时间落地
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    fake.searches().map((r) => r.body.src).sort(),
    ["all", "tg"],
  );
  const more = await searchPhase("沙丘2", "more");
  assert.deepEqual(more.counts, { "115": 2, quark: 1 });
  assert.equal(fake.searches()[2].body.src, "all");
  assert.equal(more.items[0].action, "share");
});

test("first：只有插件（或者 health 读不到）就直接搜全量，不预热；refresh 只在 first 带", async () => {
  fake.health = { plugins: ["p"], channels: [] };
  fake.onSearch = () => ({ quark: [SAMPLE.quark] });
  await searchPhase("k", "first", { refresh: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fake.searches().length, 1);
  assert.deepEqual(fake.searches()[0].body, { kw: "k", src: "all", res: "merge", refresh: true });
  await searchPhase("k", "more", { refresh: true });
  assert.equal(fake.searches()[1].body.refresh, undefined, "more 带 refresh 会把刚写进的缓存冲掉");
});

test("full（REST 不给 phase）：频道、插件都有也直接搜全量、不预热，认 refresh", async () => {
  fake.onSearch = () => ({ quark: [SAMPLE.quark] });
  const r = await searchPhase("k", "full", { refresh: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(r.counts.quark, 1);
  assert.deepEqual(
    fake.searches().map((q) => q.body),
    [{ kw: "k", src: "all", res: "merge", refresh: true }],
  );
  assert.equal(fake.requests.filter((q) => q.path === "/api/health").length, 0, "不排轮次，不用看 health");
});

test("health 读不到也记住一阵：后面的搜索不再先干等它", async () => {
  fake.healthDown = true;
  fake.onSearch = () => ({ quark: [SAMPLE.quark] });
  await searchPhase("k", "first");
  await searchPhase("k2", "first");
  assert.equal(fake.requests.filter((r) => r.path === "/api/health").length, 1, "第二次不再问 health");
  assert.ok(fake.searches().every((r) => r.body.src === "all"), "读不到 health 就直接搜全量");
});

test("first 带 refresh：TG 那一问和预热都跳过缓存", async () => {
  fake.onSearch = () => ({});
  await searchPhase("k", "first", { refresh: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(
    fake.searches().map((r) => [r.body.src, r.body.refresh]).sort(),
    [["all", true], ["tg", true]],
  );
});

test("错误换算：限流 429；登录不上、连不上走上游错误（500，不回 401）", async () => {
  const rate = pansouHttpError(new PansouError("rate", "限流了", 429)) as HttpError;
  assert.equal(rate.status, 429);
  assert.equal(rate.extra.code, "PANSOU_RATE_LIMITED");
  const auth = pansouHttpError(new PansouError("auth", "要登录", 401)) as HttpError;
  assert.equal(auth.status, UPSTREAM_ERROR_STATUS);
  assert.equal(auth.extra.code, "PANSOU_AUTH");
  assert.equal(auth.extra.upstreamStatus, 401);
  const down = pansouHttpError(new PansouError("unavailable", "连不上")) as HttpError;
  assert.equal(down.status, UPSTREAM_ERROR_STATUS);
  assert.equal(down.extra.code, "PANSOU_UNAVAILABLE");
  assert.equal(down.extra.upstreamMessage, undefined, "自己的说法不带 upstreamMessage");
  const slow = pansouHttpError(new PansouError("timeout", "PanSou 这一问太久没回")) as HttpError;
  assert.equal(slow.status, UPSTREAM_ERROR_STATUS);
  assert.equal(slow.extra.code, "PANSOU_TIMEOUT", "超时单独一个码：和连不上是两回事");
  const said = pansouHttpError(new PansouError("bad_response", "PanSou：参数错误", 400, "参数错误")) as HttpError;
  assert.equal(said.extra.code, "PANSOU_UNAVAILABLE");
  assert.equal(said.extra.upstreamMessage, "参数错误");
  const other = new Error("x");
  assert.equal(pansouHttpError(other), other);

  fake.users = { admin: "pw" };
  await httpRejects(searchPhase("k", "more"), UPSTREAM_ERROR_STATUS, "PANSOU_AUTH");
});

test("多轮：变多就再问，连着两轮不再变多才停（complete）；每一轮都报进度", async () => {
  const lists = [[SAMPLE.l115], [SAMPLE.l115, SAMPLE.l115b], [SAMPLE.l115, SAMPLE.l115b]];
  fake.onSearch = (_b, nth) => ({ "115": lists[Math.min(nth, lists.length) - 1] });
  const rounds: Array<[number, number]> = [];
  const r = await searchSettled("沙丘2", { onRound: (round, links) => void rounds.push([round, links]) });
  assert.equal(r.complete, true);
  assert.deepEqual(r.counts, { "115": 2 });
  assert.deepEqual(rounds, [
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 2],
  ]);
  assert.ok(fake.searches().every((q) => q.body.src === "all"));
});

test("多轮：中途一轮没变多（平台期）不算补完，后面又变多了就接着问；最后只有一轮没变多还是 complete: false", async () => {
  const one = [SAMPLE.l115];
  const two = [SAMPLE.l115, SAMPLE.l115b];
  const lists = [one, one, two, two];
  fake.onSearch = (_b, nth) => ({ "115": lists[Math.min(nth, lists.length) - 1] });
  const r = await searchSettled("k");
  assert.equal(r.complete, false);
  assert.equal(r.counts["115"], 2, "平台期之后变多的那些拿到了");
  assert.equal(fake.searches().length, 4);
});

test("多轮：四轮都还在变多就是 complete: false；预算不够只问一轮", async () => {
  fake.onSearch = (_b, nth) => ({ magnet: Array.from({ length: nth }, (_, i) => ({ ...SAMPLE.magnet, url: `magnet:?xt=urn:btih:${String(i).padStart(40, "a")}` })) });
  const growing = await searchSettled("a");
  assert.equal(growing.complete, false);
  assert.equal(growing.counts.magnet, 4);
  assert.equal(fake.searches().length, 4);

  const once = await searchSettled("b", { budgetMs: 500 });
  assert.equal(once.complete, false);
  assert.equal(fake.searches().length, 5, "预算不够等下一轮");
});

test("多轮：0 条在插件跑完之前不算没有（只缓存一小会儿）；从第一次问起过了插件的最长时间，一轮没变多就算补完", async () => {
  __test_setRoundGap(20, 60, 400);
  try {
    fake.onSearch = () => ({});
    const first = await searchSettled("k");
    assert.equal(first.complete, false, "前几轮都是 0 条：插件可能还在跑");
    assert.equal(fake.searches().length, 4, "0 条的时候问满轮数");
    await new Promise((r) => setTimeout(r, 450));
    const later = await searchSettled("k");
    assert.equal(later.complete, true, "插件肯定跑完了还是 0 条：真没有");
    assert.equal(fake.searches().length, 6, "一轮没变多就停");
    await searchSettled("k");
    assert.equal(fake.searches().length, 6, "补完了的按长的那档缓存");

    // 有结果的也一样：插件早就跑完了，一轮没变多就算补完
    let asked = 0;
    fake.onSearch = () => {
      asked += 1;
      return { magnet: Array.from({ length: Math.min(asked, 4) }, (_, i) => ({ ...SAMPLE.magnet, url: `magnet:?xt=urn:btih:${String(i).padStart(40, "c")}` })) };
    };
    assert.equal((await searchSettled("k2")).complete, false, "四轮都在变多");
    await new Promise((r) => setTimeout(r, 450));
    const n = fake.searches().length;
    assert.equal((await searchSettled("k2")).complete, true);
    assert.equal(fake.searches().length - n, 2, "一轮没变多就停");
  } finally {
    __test_setRoundGap(20);
  }
});

test("多轮：同一个词同时搜，搭同一趟、不各问一套；每个等着的都收到进度", async () => {
  fake.onSearch = () => ({ delayMs: 40, data: { quark: [SAMPLE.quark] } });
  const roundsA: number[] = [];
  const roundsB: number[] = [];
  const [a, b] = await Promise.all([
    searchSettled("k", { onRound: (round) => void roundsA.push(round) }),
    searchSettled(" k ", { onRound: (round) => void roundsB.push(round) }),
  ]);
  assert.equal(fake.searches().length, 3, "和一个人搜一样多");
  assert.equal(a.complete, true);
  assert.equal(b.complete, true);
  assert.deepEqual(roundsA, [1, 2, 3]);
  assert.deepEqual(roundsB, [1, 2, 3]);

  // fresh 的另起一趟（要带 refresh）
  __test_clearPansouCaches();
  const before = fake.searches().length;
  await Promise.all([searchSettled("k2"), searchSettled("k2", { fresh: true })]);
  assert.equal(fake.searches().slice(before).filter((q) => q.body.refresh === true).length, 1);
  assert.ok(fake.searches().length - before > 3, "fresh 没搭别人的车");
});

test("多轮：一起等的人里有一个取消了，不连累别的；都取消了就不再问 PanSou", async () => {
  fake.onSearch = () => ({ delayMs: 80, data: { quark: [SAMPLE.quark] } });
  const ac = new AbortController();
  const gone = searchSettled("k", { signal: ac.signal });
  const stay = searchSettled("k");
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(gone, (err: unknown) => (err as Error).name === "AbortError");
  const r = await stay;
  assert.equal(r.complete, true);
  assert.equal(r.counts.quark, 1);

  const solo = new AbortController();
  const p = searchSettled("k2", { signal: solo.signal });
  setTimeout(() => solo.abort(), 20);
  await assert.rejects(p);
  const n = fake.searches().length;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fake.searches().length, n, "没人等了：后面的轮次不再问");
  // 取消的那趟没留下缓存，也没占着位置：再搜照常问
  await searchSettled("k2");
  assert.ok(fake.searches().length > n);
});

test("多轮：结果缓存 2 分钟，换个说法（筛选条件）再调不打 PanSou；fresh 绕过缓存并带 refresh", async () => {
  fake.onSearch = () => ({ quark: [SAMPLE.quark] });
  await searchSettled("k");
  const n = fake.searches().length;
  const again = await searchSettled(" k ");
  assert.equal(fake.searches().length, n, "同一个词走缓存");
  assert.equal(again.complete, true);
  // 缓存里放的是 PanSou 的原样，能做什么每次按账号现算
  replaceAccounts([]);
  assert.equal((await searchSettled("k")).items[0].action, null);
  await searchSettled("k", { fresh: true });
  assert.equal(fake.searches()[n].body.refresh, true);
});

test("多轮：没补完的结果只缓存一小会儿，过了再搜同一个词会重新问 PanSou", async () => {
  __test_setRoundGap(20, 60);
  try {
    fake.onSearch = (_b, nth) => ({ magnet: Array.from({ length: nth }, (_, i) => ({ ...SAMPLE.magnet, url: `magnet:?xt=urn:btih:${String(i).padStart(40, "b")}` })) });
    const first = await searchSettled("k");
    assert.equal(first.complete, false);
    const n = fake.searches().length;
    await searchSettled("k");
    assert.equal(fake.searches().length, n, "马上再调：走缓存");
    await new Promise((r) => setTimeout(r, 90));
    const later = await searchSettled("k");
    assert.ok(fake.searches().length > n, "过了没补完那档的缓存时间：重新问");
    assert.ok((later.counts.magnet ?? 0) > (first.counts.magnet ?? 0));
  } finally {
    __test_setRoundGap(20);
  }
});

test("多轮：第二轮起出错不算失败，拿已有的回去；第一轮出错照实报", async () => {
  fake.onSearch = (_b, nth) => (nth === 1 ? { quark: [SAMPLE.quark] } : { status: 500, raw: "boom" });
  const r = await searchSettled("k");
  assert.equal(r.complete, false);
  assert.equal(r.counts.quark, 1);

  __test_clearPansouCaches();
  fake.onSearch = () => ({ status: 429, raw: "slow down" });
  await httpRejects(searchSettled("k2"), 429, "PANSOU_RATE_LIMITED");
});

test("多轮：第一问没问成（连不上、限流、登录不上）不算问过：过了插件的最长时间再搜，也按刚开始搜来判", async () => {
  __test_setRoundGap(20, 60, 400);
  try {
    fake.onSearch = () => ({ status: 502, raw: "Bad Gateway" });
    await httpRejects(searchSettled("k"), UPSTREAM_ERROR_STATUS, "PANSOU_UNAVAILABLE");
    fake.onSearch = () => ({ status: 429, raw: "slow down" });
    await httpRejects(searchSettled("k"), 429, "PANSOU_RATE_LIMITED");
    await new Promise((r) => setTimeout(r, 450));
    fake.onSearch = () => ({});
    const n = fake.searches().length;
    const r = await searchSettled("k");
    assert.equal(r.complete, false, "插件这才开始跑：0 条不能当真没有、缓存 2 分钟");
    assert.equal(fake.searches().length - n, 4, "0 条时问满轮数");
  } finally {
    __test_setRoundGap(20);
  }
});

test("多轮：第一问超时的照样算问过（PanSou 收到了、插件在后台接着搜）：过了插件的最长时间再搜，一轮没变多就收", async () => {
  __test_setRoundGap(20, 60, 400);
  __test_setSearchTimeout(100);
  try {
    fake.onSearch = () => ({ delayMs: 300, data: {} });
    await httpRejects(searchSettled("k"), UPSTREAM_ERROR_STATUS, "PANSOU_TIMEOUT");
    await new Promise((r) => setTimeout(r, 450));
    fake.onSearch = () => ({});
    const n = fake.searches().length;
    const r = await searchSettled("k");
    assert.equal(r.complete, true);
    assert.equal(fake.searches().length - n, 2);
  } finally {
    __test_setRoundGap(20);
    __test_setSearchTimeout();
  }
});

test("多轮：先开始的一趟后回来，不拿旧结果盖掉后开始的（fresh）那趟已经写好的缓存", async () => {
  // 第一次搜索（先开始那趟的第一问）慢、只有一条；之后的都快、有两条
  fake.onSearch = (_b, nth) => (nth === 1 ? { delayMs: 200, data: { "115": [SAMPLE.l115] } } : { "115": [SAMPLE.l115, SAMPLE.l115b] });
  const older = searchSettled("k", { budgetMs: 50 });
  await new Promise((r) => setTimeout(r, 30));
  const newer = await searchSettled("k", { fresh: true });
  assert.equal(newer.complete, true);
  assert.equal(newer.counts["115"], 2);
  const old = await older;
  assert.equal(old.counts["115"], 1, "先开始那趟照样把自己的结果回给等它的人");
  const n = fake.searches().length;
  const cached = await searchSettled("k");
  assert.equal(fake.searches().length, n, "走缓存");
  assert.equal(cached.counts["115"], 2, "缓存里是后开始那趟的");
  assert.equal(cached.complete, true);
});

test("多轮：唯一等着的取消了，紧接着再搜同一个词，不会搭上那一趟被掐掉的", async () => {
  fake.onSearch = () => ({ delayMs: 60, data: { quark: [SAMPLE.quark] } });
  const ac = new AbortController();
  const first = searchSettled("k", { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(first);
  const again = await searchSettled("k");
  assert.equal(again.counts.quark, 1);
});

test("多轮：客户端取消就停；已经取消了的不发请求", async () => {
  fake.onSearch = () => ({ delayMs: 500, data: {} });
  const ac = new AbortController();
  const p = searchSettled("k", { signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p);
  const n = fake.searches().length;
  await assert.rejects(searchSettled("k3", { signal: AbortSignal.abort() }));
  assert.equal(fake.searches().length, n);
});

const follow = (over: Partial<ShareFollow>): ShareFollow => ({
  id: "f",
  name: "沙丘2",
  libraryId: null,
  shareUrl: "",
  shareCode: "",
  receiveCode: "",
  watchCid: "0",
  watchPath: "",
  scope: [""],
  taskId: "t115",
  subPath: "",
  enabled: true,
  intervalMinutes: 360,
  status: "idle",
  lastError: "",
  errorStreak: 0,
  lastCheckedAt: null,
  lastChangeAt: null,
  nextCheckAt: 0,
  known: [],
  recent: [],
  organized: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

test("订过追更的分享标 followed：按网盘 + 分享码对追更表（只存了分享码的靠任务认网盘）；停掉的标 stopped；缓存命中时也现对", async () => {
  replaceTasks([{ id: "t115", account: "a", accountType: "115", originPath: "tv", targetPath: "pansou-itest", strmPrefix: "/m" }]);
  replaceShareFollows([follow({ id: "f1", shareCode: "swabc123xyz" })]);
  // 标「已在追更」只读认分享的这几列，不把每条几百项的快照读出来
  assert.deepEqual(listShareFollowRefs(), [{ shareUrl: "", shareCode: "swabc123xyz", taskId: "t115", enabled: true }]);
  try {
    fake.onSearch = () => ({ "115": [SAMPLE.l115, SAMPLE.l115b], quark: [SAMPLE.quark] });
    const web = await searchPhase("沙丘2", "more");
    assert.deepEqual(
      web.items.filter((h) => h.followed).map((h) => [h.key, h.followed]),
      [["115:swabc123xyz", "active"]],
    );
    const first = await searchSettled("沙丘2");
    assert.deepEqual(
      first.items.filter((h) => h.followed).map((h) => [h.key, h.followed]),
      [["115:swabc123xyz", "active"]],
    );

    // 停掉的（失效、停更、暂停）是 stopped；同一个分享订了几个目录，有一个还在追就算在追
    replaceShareFollows([
      follow({ id: "f1", shareCode: "swabc123xyz", enabled: false, status: "expired" }),
      follow({ id: "f4", shareCode: "swdef456uvw", enabled: false, status: "stale" }),
      follow({ id: "f5", shareCode: "swdef456uvw", watchCid: "9", enabled: true }),
    ]);
    const mixed = await searchPhase("沙丘2", "more");
    assert.deepEqual(
      mixed.items.filter((h) => h.followed).map((h) => [h.key, h.followed]),
      [
        ["115:swabc123xyz", "stopped"],
        ["115:swdef456uvw", "active"],
      ],
    );

    // 订阅自己的分享链接说了是哪家网盘，就不看任务的 accountType（换账号时它不一定跟着改）
    replaceShareFollows([follow({ id: "f6", taskId: "t115", shareCode: "4efe86519372", shareUrl: SAMPLE.quark.url })]);
    const byLink = await searchPhase("沙丘2", "more");
    assert.deepEqual(
      byLink.items.filter((h) => h.followed).map((h) => h.key),
      ["quark:4efe86519372"],
    );

    // 任务删了的订阅按它存的分享链接认网盘；同一个分享码换了网盘不算
    replaceShareFollows([
      follow({ id: "f2", taskId: "gone", shareCode: "4efe86519372", shareUrl: SAMPLE.quark.url }),
      follow({ id: "f3", taskId: "gone", shareCode: "swdef456uvw", shareUrl: "https://pan.quark.cn/s/swdef456uvw" }),
    ]);
    const searches = fake.searches().length;
    const cached = await searchSettled("沙丘2");
    assert.equal(fake.searches().length, searches, "走的是缓存");
    assert.deepEqual(
      cached.items.filter((h) => h.followed).map((h) => [h.key, h.followed]),
      [["quark:4efe86519372", "active"]],
    );
  } finally {
    replaceShareFollows([]);
    replaceTasks([]);
  }
});

test("检测：只收认得的 115 / 夸克分享；链接不带提取码、提取码单给；结果按 key 回", async () => {
  const res = await checkResourceLinks([
    "https://anxia.com/s/swabc123xyz?password=u796",
    "https://pan.quark.cn/s/157e84553650?pwd=ab12",
    "https://pan.baidu.com/s/1abcdef",
    "magnet:?xt=urn:btih:b1caf2a9c5cabc705b056c06dc5365f1eaf4c098",
    "http://127.0.0.1:1/admin",
    "swabc123xyz",
  ]);
  assert.equal(res.supported, true);
  assert.deepEqual(res.results.map((r) => [r.key, r.state]).sort(), [
    ["115:swabc123xyz", "ok"],
    ["quark:157e84553650", "ok"],
  ]);
  // 两家网盘各一批
  assert.deepEqual(
    fake.requests.flatMap((r) => r.body.items as unknown[]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [
      { disk_type: "115", url: "https://115.com/s/swabc123xyz", password: "u796" },
      { disk_type: "quark", url: "https://pan.quark.cn/s/157e84553650", password: "ab12" },
    ],
  );
  assert.equal(fake.requests.length, 2);
});

test("检测：一批最多 5 条；结果缓存（说不准的不缓存）；PanSou 没有检测接口就记住、不再问", async () => {
  const urls = Array.from({ length: 12 }, (_, i) => `https://pan.quark.cn/s/abc${String(i).padStart(3, "0")}`);
  fake.onCheck = (items) => ({ results: items.map((it) => ({ url: it.url, state: it.url.endsWith("000") ? "uncertain" : "bad" })) });
  const first = await checkResourceLinks(urls);
  assert.equal(first.results.length, 12);
  assert.deepEqual(
    fake.requests.map((r) => (r.body.items as unknown[]).length).sort(),
    [2, 5, 5],
  );
  const again = await checkResourceLinks(urls);
  assert.equal(again.results.length, 12);
  assert.equal(fake.requests.length, 4, "只有说不准的那条再问一次");
  assert.equal((fake.requests[3].body.items as unknown[]).length, 1);

  __test_clearPansouCaches();
  fake.onCheck = null;
  assert.deepEqual(await checkResourceLinks(urls.slice(0, 1)), { supported: false, results: [] });
  const n = fake.requests.length;
  assert.deepEqual(await checkResourceLinks(urls.slice(1, 2)), { supported: false, results: [] });
  assert.equal(fake.requests.length, n, "记住了不支持");

  // 升级了 PanSou、点一下「检查连接」：马上重新试，不用等那一小时
  fake.onCheck = (items) => ({ results: items.map((i) => ({ url: i.url, state: "ok" })) });
  assert.equal((await pansouStatus()).ok, true);
  const retried = await checkResourceLinks(urls.slice(1, 2));
  assert.equal(retried.supported, true);
  assert.equal(retried.results.length, 1);
});

test("检测：同一批只放一家网盘的；同时最多 4 批在路上；「访问码错误」这类 bad 记成 locked", async () => {
  const quark = Array.from({ length: 22 }, (_, i) => `https://pan.quark.cn/s/qq${String(i).padStart(4, "0")}`);
  const p115 = Array.from({ length: 3 }, (_, i) => `https://115.com/s/sw${String(i).padStart(9, "0")}`);
  const arrivals: number[] = [];
  fake.onCheck = (items) => {
    arrivals.push(Date.now());
    return {
      delayMs: 150,
      data: { results: items.map((it) => ({ url: it.url, state: it.url.endsWith("qq0001") ? "bad" : "ok", summary: it.url.endsWith("qq0001") ? "访问码错误" : "链接有效" })) },
    };
  };
  const res = await checkResourceLinks([...quark, ...p115]);
  assert.equal(res.results.length, 25);
  const kinds = fake.requests.map((r) => [...new Set((r.body.items as Array<{ disk_type: string }>).map((i) => i.disk_type))]);
  assert.ok(kinds.every((k) => k.length === 1), "每批只有一家网盘的");
  assert.deepEqual(
    fake.requests.map((r) => (r.body.items as unknown[]).length).sort((a, b) => a - b),
    [2, 3, 5, 5, 5, 5],
  );
  arrivals.sort((a, b) => a - b);
  assert.ok(arrivals[3] - arrivals[0] < 100, "头 4 批一起发");
  assert.ok(arrivals[4] - arrivals[0] >= 120, "第 5 批要等前面有一批回来");
  const locked = res.results.find((r) => r.key === "quark:qq0001");
  assert.equal(locked?.state, "locked", "分享还在，只是提取码不对");
  assert.equal(res.results.filter((r) => r.state === "locked").length, 1);
});

test("检测：分批并行，失败的那批不连累已经回来的；全失败才报错", async () => {
  const urls = Array.from({ length: 12 }, (_, i) => `https://pan.quark.cn/s/par${String(i).padStart(3, "0")}`);
  fake.onCheck = (items) => (items.length === 2 ? { status: 500, raw: "boom" } : { results: items.map((i) => ({ url: i.url, state: "ok" })) });
  const partial = await checkResourceLinks(urls);
  assert.equal(partial.supported, true);
  assert.equal(partial.results.length, 10, "回来的那批照样用上");

  __test_clearPansouCaches();
  fake.onCheck = () => ({ status: 500, raw: "boom" });
  await assert.rejects(checkResourceLinks(urls.slice(0, 3)), (err: unknown) => err instanceof HttpError);
});

test("检测：只按链接对号，不按位置；PanSou 规范化过的链接也认；对不上的丢掉", async () => {
  fake.onCheck = (items) => ({
    results: [
      // 顺序反了、第一条带上了提取码（规范化过）、多一条对不上的、少一条
      { url: "https://example.com/other", state: "bad" },
      { url: "x", normalized_url: `${items[1].url}?pwd=zz`, state: "bad" },
      { url: items[0].url, state: "ok" },
    ],
  });
  const res = await checkResourceLinks(["https://pan.quark.cn/s/ord000", "https://pan.quark.cn/s/ord001", "https://pan.quark.cn/s/ord002"]);
  assert.deepEqual(
    res.results.map((r) => [r.key, r.state]).sort(),
    [
      ["quark:ord000", "ok"],
      ["quark:ord001", "bad"],
    ],
    "第三条 PanSou 没回：没有状态，也没被安上别人的",
  );
});

test("检查连接：没填地址、连不上、开了登录没填、密码错、掩码密码用库里的、没配频道插件都说清楚", async () => {
  deleteAppSetting("pansou");
  assert.deepEqual(await pansouStatus(), { configured: false, ok: false, message: "还没填 PanSou 的地址" });

  const down = await pansouStatus({ baseUrl: "http://127.0.0.1:9" });
  assert.equal(down.configured, true);
  assert.equal(down.ok, false);
  assert.match(down.message ?? "", /连不上 PanSou/);

  fake.health = { plugins: ["p1", "p2"], channels: ["c"] };
  assert.deepEqual(await pansouStatus({ baseUrl: `${fake.url}/api/` }), { configured: true, ok: true, authEnabled: false, plugins: 2, channels: 1 });

  fake.users = { admin: "pw" };
  const noUser = await pansouStatus({ baseUrl: fake.url });
  assert.equal(noUser.ok, false);
  assert.match(noUser.message ?? "", /开了登录/);
  const wrong = await pansouStatus({ baseUrl: fake.url, username: "admin", password: "nope" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.message ?? "", /用户名或密码不对/);

  writeAppSetting("pansou", { baseUrl: fake.url, username: "admin", password: "pw" });
  const masked = await pansouStatus({ baseUrl: `${fake.url}/`, username: "admin", password: "••••" });
  assert.equal(masked.ok, true, "表单里是掩码、地址没变：用库里存的密码");
  assert.equal((await pansouStatus()).ok, true, "不带参数就用已存的");

  // 地址改了还没保存：存着的密码不发给新地址
  writeAppSetting("pansou", { baseUrl: "http://127.0.0.1:9", username: "admin", password: "pw" });
  const logins = fake.requests.filter((r) => r.path === "/api/auth/login").length;
  const moved = await pansouStatus({ baseUrl: fake.url, username: "admin", password: "••••" });
  assert.equal(moved.ok, false);
  assert.match(moved.message ?? "", /地址改了/);
  assert.equal(fake.requests.filter((r) => r.path === "/api/auth/login").length, logins, "没去新地址登录");
  assert.equal((await pansouStatus({ baseUrl: fake.url, username: "admin", password: "pw" })).ok, true, "重新填了密码就能检查");

  writeAppSetting("pansou", { baseUrl: fake.url });
  fake.users = null;
  fake.health = { plugins: [], channels: [] };
  const empty = await pansouStatus();
  assert.equal(empty.ok, true);
  assert.match(empty.message ?? "", /没启用任何频道和插件/);
});

const note = (id: string, text: string) => ({ url: `https://pan.quark.cn/s/${id}`, password: "", note: text, datetime: "", source: "tg:chan" });

test("屏蔽词：标题或标签里带的藏掉（不分大小写）、报条数、counts 跟着减；改了屏蔽词，缓存里的结果现滤、不再问 PanSou", async () => {
  fake.onSearch = () => ({
    quark: [note("aaaa1111bbbb", "沙丘2 预告片"), note("cccc2222dddd", "沙丘2 2160p"), note("eeee3333ffff", "沙丘2 1080p 中字")],
    magnet: [SAMPLE.magnet],
  });
  writeAppSetting("pansou", { baseUrl: fake.url, blockWords: ["预告", "4k"] });
  const first = await searchSettled("沙丘2");
  assert.equal(first.blocked, 2, "「4k」对上的是 2160p 认出来的标签");
  assert.deepEqual(first.counts, { quark: 1, magnet: 1 });
  assert.deepEqual(
    first.items.map((h) => h.title),
    ["沙丘2 1080p 中字", "沙丘2-Dune.Part.Two.2024.1080p.WEBRip[1.6G]"],
  );
  assert.deepEqual(first.items[0].tags, ["1080p", "中字"]);

  const asked = fake.searches().length;
  writeAppSetting("pansou", { baseUrl: fake.url, blockWords: [] });
  const again = await searchSettled("沙丘2");
  assert.equal(fake.searches().length, asked, "走的是缓存");
  assert.equal(again.blocked, undefined);
  assert.deepEqual(again.counts, { quark: 3, magnet: 1 });
  // 网页那一问也滤
  writeAppSetting("pansou", { baseUrl: fake.url, blockWords: ["中字"] });
  const web = await searchPhase("沙丘2", "more");
  assert.equal(web.blocked, 1);
});

test("PanSou 地址：只收 http(s)，带用户名密码、? 参数、# 的不收", () => {
  const url = (baseUrl: string) => settingsPatchSchema.safeParse({ pansou: { baseUrl } }).success;
  assert.equal(url(""), true, "空串是清掉");
  assert.equal(url("http://pansou:8888"), true);
  assert.equal(url("https://so.example.com/sub/"), true);
  assert.equal(url("ftp://pansou"), false);
  assert.equal(url("http://user:pw@pansou:8888"), false);
  assert.equal(url("http://pansou:8888/?x=1"), false);
  assert.equal(url("http://pansou:8888/#a"), false);
  assert.equal(url("http://pan sou"), false);
});

test("设置里的屏蔽词：去空白、去空、不分大小写去重；太长、太多的不收", () => {
  const ok = settingsPatchSchema.parse({ pansou: { blockWords: [" 预告 ", "", "TC", "tc", "花絮"] } });
  assert.deepEqual(ok.pansou?.blockWords, ["预告", "TC", "花絮"]);
  assert.equal(settingsPatchSchema.safeParse({ pansou: { blockWords: ["长".repeat(31)] } }).success, false);
  assert.equal(settingsPatchSchema.safeParse({ pansou: { blockWords: Array.from({ length: 51 }, (_, i) => `w${i}`) } }).success, false);
});

test("titleEn：作为 ext.title_en 交给 PanSou（first、预热都带）；不给就没有 ext", async () => {
  fake.onSearch = () => ({ quark: [SAMPLE.quark] });
  await searchPhase("沙丘2", "first", { titleEn: " Dune: Part Two " });
  await new Promise((r) => setTimeout(r, 50));
  const bodies = fake.searches().map((r) => r.body);
  assert.equal(bodies.length, 2, "TG 那一问 + 全量预热");
  for (const b of bodies) assert.deepEqual(b.ext, { title_en: "Dune: Part Two" });
  await searchPhase("沙丘2", "more");
  assert.equal(fake.searches()[2].body.ext, undefined);
});

test("屏蔽词「TC」「CAM」只藏真带着这个词的：The Witcher、Cat Club、James Cameron 留着", async () => {
  fake.onSearch = () => ({
    quark: [
      note("aaaa0001", "The.Witcher.S01.2160p"),
      note("aaaa0002", "Cat Club (2024)"),
      note("aaaa0003", "阿凡达 James Cameron 2009"),
      note("aaaa0004", "沙丘2 TC版"),
      note("aaaa0005", "Movie.2024.CAM.x264"),
      note("aaaa0006", "沙丘2 预告片"),
    ],
  });
  writeAppSetting("pansou", { baseUrl: fake.url, blockWords: ["预告", "枪版", "TC", "CAM"] });
  const r = await searchSettled("k");
  assert.equal(r.blocked, 3);
  assert.deepEqual(
    r.items.map((h) => h.title),
    ["The.Witcher.S01.2160p", "Cat Club (2024)", "阿凡达 James Cameron 2009"],
  );
});

test("屏蔽词的匹配口径：全角半角、大小写、空白都不计较，「第1季」也藏掉 S01 认出的标签「第 1 季」", async () => {
  fake.onSearch = () => ({
    quark: [note("aaaa1111bbbb", "繁花.S01.2023.1080p"), note("cccc2222dddd", "繁花 第2季"), note("eeee3333ffff", "Show-TC.MX")],
  });
  writeAppSetting("pansou", { baseUrl: fake.url, blockWords: ["第1季", "ＴＣ"] });
  const r = await searchSettled("繁花");
  assert.equal(r.blocked, 2);
  assert.deepEqual(
    r.items.map((h) => h.title),
    ["繁花 第2季"],
  );
});
