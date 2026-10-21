/**
 * Emby 入库通知：/Items 查询和 Telegram 都换成桩，直接驱动 tickEmbyNew 验证游标与聚合。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/emby/library-new.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AppSettings } from "@openstrm/shared";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { readKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { __test_resetMediaProbes, countMediaProbes, getMediaProbes, putMediaProbe } from "../../db/repositories/media-probes.js";
import { cachedProbeTags, probeTags } from "../media/probe.js";
import type { NotifyEvent } from "../notify.js";
import {
  __test_resetEmbyNew,
  getEmbyNewWatcherStatus,
  nudgeEmbyNewWatch,
  setEmbyNewDeps,
  startEmbyNewWatcher,
  stopEmbyNewWatcher,
  tickEmbyNew,
  type EmbyNewItem,
} from "./library-new.js";

let baseline: AppSettings;
let baselineTasks: ReturnType<typeof listTasks> = [];
/** 桩 Emby：null = 未配置 */
let page: EmbyNewItem[] | null = [];
/** 桩的「按 id 取」：从这里找；记下每次问了哪些 id */
let byId: Record<string, EmbyNewItem> = {};
let byIdCalls: string[][] = [];
let fetchCalls = 0;
let notified: NotifyEvent[] = [];
/** 桩的预热：记下问过哪些 id；回什么流由测试定；问完可以改 byId 模拟 Emby 落库 */
let pbiCalls: string[] = [];
let pbiResult: (id: string, signal?: AbortSignal) => Array<{ MediaStreams?: unknown[] }> = () => [];
let busy = false;

const T0 = 1_800_000_000_000;
const ep = (over: Partial<EmbyNewItem>): EmbyNewItem => ({
  id: `${over.seriesName ?? "剧"}-${over.episode ?? 0}`,
  type: "Episode",
  name: `第 ${over.episode ?? 0} 集`,
  seriesName: "怪奇物语",
  season: 5,
  at: T0,
  ...over,
});
const movie = (over: Partial<EmbyNewItem>): EmbyNewItem => ({
  id: "m1", type: "Movie", name: "沙丘 2", year: 2024, at: T0, ...over,
});

before(() => {
  baseline = readAppSettings();
  baselineTasks = listTasks();
  setEmbyNewDeps({
    // 按 Emby 的样子翻页：从第 start 条起给 limit 条
    fetch: async (limit, start) => {
      fetchCalls += 1;
      return page ? page.slice(start, start + limit) : null;
    },
    fetchByIds: async (ids) => {
      byIdCalls.push(ids);
      return page ? ids.map((id) => byId[id]).filter((i): i is EmbyNewItem => !!i) : null;
    },
    notify: async (ev) => {
      notified.push(ev);
    },
    playbackInfo: async (id, signal) => {
      pbiCalls.push(id);
      return pbiResult(id, signal);
    },
    busy: () => busy,
    wait: async () => {},
  });
});

beforeEach(async () => {
  await __test_resetEmbyNew();
  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100" } });
  page = [];
  byId = {};
  byIdCalls = [];
  fetchCalls = 0;
  notified = [];
  pbiCalls = [];
  pbiResult = () => [];
  busy = false;
});

after(async () => {
  replaceTasks(baselineTasks);
  __test_resetMediaProbes();
  await __test_resetEmbyNew();
  setEmbyNewDeps(null);
  replaceAppSettings(baseline);
});

test("通知开关关着：Emby 照样问一次（给探测缓存回填），但不通知、通知的游标不动", async () => {
  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100", notify: { embyNew: false } } });
  page = [ep({ episode: 1, at: T0 })];
  await tickEmbyNew();
  assert.equal(fetchCalls, 1);
  assert.equal(notified.length, 0);
  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100" } });
  await tickEmbyNew();
  assert.equal(notified.length, 0, "打开后首轮只定位通知的游标，存量不算新增");
  page = [ep({ episode: 2, at: T0 + 1000 }), ...page];
  await tickEmbyNew();
  assert.equal(notified.length, 1);
});

test("回填探测缓存：Emby 分析过的流按 strm 内容换算回网盘文件写进缓存；首轮也回填；读文件头得到的结果不覆盖；游标推进后不重复写", async () => {
  replaceTasks([{ id: "emby-t", account: "acc", accountType: "quark", originPath: "tv", targetPath: "x/tv", strmPrefix: "/mnt" }]);
  __test_resetMediaProbes();
  const streams = [
    { Type: "Video", Codec: "hevc", Width: 3840, Height: 2160, BitDepth: 10, VideoRange: "HDR", VideoRangeType: "DOVI", RealFrameRate: 23.976 },
    { Type: "Audio", Codec: "eac3", Profile: "Dolby Digital Plus + Dolby Atmos", DisplayTitle: "英语 Dolby Digital+ Atmos 5.1", Channels: 6, Language: "eng", IsDefault: true },
    { Type: "Subtitle", Codec: "subrip", Language: "chi" },
  ];
  page = [
    ep({ episode: 1, at: T0, sources: [{ path: "/mnt/tv/A/A.S01E01.mkv", size: 1234, container: "mkv", streams }] }),
    ep({ episode: 2, at: T0 - 1000, sources: [{ path: "/other/tv/B.mkv", size: 1, streams }] }),
    ep({ episode: 3, at: T0 - 2000, sources: [{ path: "/mnt/tv/A/A.S01E03.mkv", size: 1, streams: [{ Type: "Audio", Codec: "aac" }] }] }),
  ];
  await tickEmbyNew();
  const rows = getMediaProbes("acc", ["path:/tv/A/A.S01E01.mkv", "path:/tv/A/A.S01E03.mkv"]);
  const row = rows.get("path:/tv/A/A.S01E01.mkv")!;
  assert.ok(row, "对上任务的写进去了");
  assert.equal(row.size, 1234);
  assert.deepEqual(probeTags(row.data!), { resolution: "2160p", videoCodec: "HEVC", audio: "DDP", hdr: "DV" });
  assert.equal(row.data!.audio[0].atmos, true);
  assert.equal(row.data!.audio[0].language, "eng");
  assert.equal(rows.get("path:/tv/A/A.S01E03.mkv"), undefined, "没有视频流的不写");
  assert.equal(countMediaProbes(), 1, "对不上任务的不写");
  // 有 id 的目标也能退到按路径找
  assert.deepEqual(cachedProbeTags("acc", [{ path: "/tv/A/A.S01E01.mkv", id: "fid1", size: 1234 }]).get("/tv/A/A.S01E01.mkv"), { resolution: "2160p", videoCodec: "HEVC", audio: "DDP", hdr: "DV" });

  // 读文件头得到的结果（bytesRead > 0）不被 Emby 的覆盖
  putMediaProbe({ ...row, data: { ...row.data!, bytesRead: 100, video: { ...row.data!.video!, codec: "AV1" } }, probedAt: 1 });
  page = [ep({ episode: 4, at: T0 + 1000, sources: [{ path: "/mnt/tv/A/A.S01E01.mkv", size: 1234, streams }] })];
  await tickEmbyNew();
  assert.equal(getMediaProbes("acc", ["path:/tv/A/A.S01E01.mkv"]).get("path:/tv/A/A.S01E01.mkv")!.data!.video!.codec, "AV1");
});

test("Emby 未配置（fetch 回 null）：不动游标；配置好后首轮只定位、不补报存量", async () => {
  page = null;
  await tickEmbyNew();
  assert.equal(notified.length, 0);

  page = [ep({ episode: 1, at: T0 }), ep({ episode: 2, at: T0 - 1000 })];
  await tickEmbyNew();
  assert.equal(notified.length, 0, "首轮只定位游标");
  await tickEmbyNew();
  assert.equal(notified.length, 0, "没有新条目就不响");
});

test("新集按剧+季聚合、电影单列；游标推进后不重复报", async () => {
  page = [ep({ episode: 4, at: T0 })];
  await tickEmbyNew();

  page = [
    movie({ at: T0 + 3000 }),
    ep({ episode: 7, at: T0 + 2000 }),
    ep({ episode: 6, at: T0 + 2000 }),
    ep({ episode: 5, at: T0 + 1000 }),
    ...page,
  ];
  await tickEmbyNew();
  assert.equal(notified.length, 1);
  const evt = notified[0] as Extract<NotifyEvent, { type: "emby-new" }>;
  assert.equal(evt.type, "emby-new");
  assert.equal(evt.total, 4);
  assert.deepEqual(evt.groups, [
    { kind: "movie", name: "沙丘 2", year: 2024, episodes: [], count: 1 },
    { kind: "tv", name: "怪奇物语", season: 5, episodes: [5, 6, 7], count: 3 },
  ]);

  await tickEmbyNew();
  assert.equal(notified.length, 1, "游标已推进，不重复报");
});

test("同一毫秒多条：靠 id 集合补漏，不重报", async () => {
  page = [ep({ episode: 1, at: T0 })];
  await tickEmbyNew();
  // 同一毫秒又出现一条新的（同批入库共享 DateCreated）
  page = [ep({ episode: 2, at: T0 }), ep({ episode: 1, at: T0 })];
  await tickEmbyNew();
  assert.equal(notified.length, 1);
  assert.equal((notified[0] as Extract<NotifyEvent, { type: "emby-new" }>).total, 1);
  await tickEmbyNew();
  assert.equal(notified.length, 1);
});

test("一轮新增太多：只报总数，不逐条列", async () => {
  page = [ep({ episode: 1, at: T0 })];
  await tickEmbyNew();
  page = [
    ...Array.from({ length: 35 }, (_, i) => ep({ episode: i + 2, at: T0 + 1000 + i })),
    ...page,
  ];
  await tickEmbyNew();
  const evt = notified[0] as Extract<NotifyEvent, { type: "emby-new" }>;
  assert.equal(evt.total, 35);
  assert.deepEqual(evt.groups, []);
});

test("坏时间戳和缺 id 的条目直接丢弃", async () => {
  page = [ep({ episode: 1, at: T0 })];
  await tickEmbyNew();
  page = [ep({ episode: 2, at: Number.NaN }), ep({ id: "", episode: 3, at: T0 + 1000 }), ...page];
  await tickEmbyNew();
  assert.equal(notified.length, 0);
});

test("循环启停与加急：没起循环时 nudge 是空操作", async () => {
  nudgeEmbyNewWatch();
  assert.equal(getEmbyNewWatcherStatus().running, false);
  startEmbyNewWatcher();
  assert.equal(getEmbyNewWatcherStatus().running, true);
  await stopEmbyNewWatcher();
  assert.equal(getEmbyNewWatcherStatus().running, false);
});

test("入库时 Emby 还没分析流的条目：记进 pending，之后每轮按 id 再问，有了流就回填并拿掉；条目没了也拿掉", async () => {
  replaceTasks([{ id: "emby-t", account: "acc", accountType: "quark", originPath: "tv", targetPath: "x/tv", strmPrefix: "/mnt" }]);
  __test_resetMediaProbes();
  const empty = ep({ id: "e-empty", episode: 7, at: T0, sources: [{ path: "/mnt/tv/A/A.S01E07.mkv", size: 1, streams: [] }] });
  const gone = ep({ id: "e-gone", episode: 8, at: T0 - 1000, sources: [{ path: "/mnt/tv/A/A.S01E08.mkv", size: 1, streams: [] }] });
  page = [empty, gone];
  byId = { "e-empty": empty, "e-gone": gone };
  await tickEmbyNew();
  assert.equal(countMediaProbes(), 0, "没有流就不写");
  assert.deepEqual(byIdCalls.at(-1)?.sort(), ["e-empty", "e-gone"], "同一轮就按 id 问了一遍");

  // 下一轮：e-empty 播放过了有了流，e-gone 没了
  byId = { "e-empty": { ...empty, sources: [{ path: "/mnt/tv/A/A.S01E07.mkv", size: 2, streams: [{ Type: "Video", Codec: "h264", Width: 1920, Height: 1080 }] }] } };
  await tickEmbyNew();
  const row = getMediaProbes("acc", ["path:/tv/A/A.S01E07.mkv"]).get("path:/tv/A/A.S01E07.mkv")!;
  assert.ok(row, "有了流就回填");
  assert.equal(row.size, 2);
  const calls = byIdCalls.length;
  await tickEmbyNew();
  assert.equal(byIdCalls.length, calls, "都处理完了，pending 空了就不再按 id 问");
});

test("入库后预热：pending 里的条目服务端问一次 PlaybackInfo，一轮最多 5 条、问过的不再问；探好的同一轮就回填", async () => {
  replaceTasks([{ id: "emby-t", account: "acc", accountType: "quark", originPath: "tv", targetPath: "x/tv", strmPrefix: "/mnt" }]);
  __test_resetMediaProbes();
  const items = [1, 2, 3, 4, 5, 6, 7].map((n) => ep({ id: `w-${n}`, episode: n, at: T0 - n, sources: [{ path: `/mnt/tv/W/W.S01E0${n}.mkv`, size: 1, streams: [] }] }));
  page = items;
  byId = Object.fromEntries(items.map((i) => [i.id, i]));
  // Emby 探完就落库：预热桩顺手把 byId 里的那条换成带流的
  pbiResult = (id) => {
    byId[id] = { ...byId[id], sources: [{ path: byId[id].sources![0].path, size: 2, streams: [{ Type: "Video", Codec: "h264", Width: 1920, Height: 1080 }] }] };
    return [{ MediaStreams: [{}, {}] }];
  };
  await tickEmbyNew();
  assert.deepEqual(pbiCalls, ["w-1", "w-2", "w-3", "w-4", "w-5"], "按入库先后、一轮最多 5 条");
  assert.equal(countMediaProbes(), 5, "这轮预热探好的，同一轮按 id 再问时就回填了");

  await tickEmbyNew();
  assert.deepEqual(pbiCalls.slice(5), ["w-6", "w-7"], "下一轮接着问剩下的");
  assert.equal(countMediaProbes(), 7);

  const before = pbiCalls.length;
  await tickEmbyNew();
  assert.equal(pbiCalls.length, before, "都探好、pending 空了就不再问");
});

test("pending 里探过了但只有音频流的条目：没东西可回填，拿掉，不再每轮按 id 问", async () => {
  __test_resetMediaProbes();
  const audio = ep({ id: "a-1", episode: 1, sources: [{ path: "/mnt/tv/A/A.S01E01.mkv", size: 1, streams: [] }] });
  page = [audio];
  byId = { "a-1": { ...audio, sources: [{ path: "/mnt/tv/A/A.S01E01.mkv", size: 1, streams: [{ Type: "Audio", Codec: "aac" }] }] } };
  pbiResult = () => [{ MediaStreams: [{ Type: "Audio" }] }];
  await tickEmbyNew();
  assert.deepEqual(byIdCalls.at(-1), ["a-1"], "入库时没流：进了 pending、同一轮按 id 问了");
  const calls = byIdCalls.length;
  await tickEmbyNew();
  assert.equal(byIdCalls.length, calls, "只有音频流也算探过了，pending 空了就不再问");
});

test("预热排在通知后面：Emby 探测要等几十秒，入库通知不等它", async () => {
  page = [ep({ episode: 1, at: T0 })];
  await tickEmbyNew();
  const fresh = ep({ id: "n-2", episode: 2, at: T0 + 1000, sources: [{ path: "/mnt/tv/N/N.S01E02.mkv", size: 1, streams: [] }] });
  page = [fresh, ...page];
  byId = { "n-2": fresh };
  let notifiedWhenProbing = -1;
  pbiResult = () => {
    notifiedWhenProbing = notified.length;
    return [{ MediaStreams: [{}] }];
  };
  await tickEmbyNew();
  assert.deepEqual(pbiCalls, ["n-2"]);
  assert.equal(notifiedWhenProbing, 1, "问 PlaybackInfo 的时候通知已经发出去了");
});

test("预热：Emby 没回答（抛错）不按探测失败记一天，记另一个时间十分钟后再试；停机掐断的那条什么都不记", async () => {
  __test_resetMediaProbes();
  const cold = ep({ id: "f-1", episode: 1, sources: [{ path: "/mnt/tv/F/F.S01E01.mkv", size: 1, streams: [] }] });
  page = [cold];
  byId = { "f-1": cold };
  pbiResult = () => {
    throw new Error("fetch failed");
  };
  await tickEmbyNew();
  assert.deepEqual(pbiCalls, ["f-1"]);
  let pending = readKv<Array<{ id: string; warmedAt?: number; failedAt?: number }>>(KEY.embyProbePending) ?? [];
  assert.equal(pending[0]?.warmedAt, undefined, "没问成不算探测过");
  assert.ok(pending[0]?.failedAt, "记下没问成的时间");
  await tickEmbyNew();
  assert.deepEqual(pbiCalls, ["f-1"], "十分钟内不再问");

  // 停机：信号一掐就停，这条既不算探过也不算没问成，下次启动再问
  await __test_resetEmbyNew();
  pbiCalls = [];
  const ac = new AbortController();
  pbiResult = (_id, signal) => {
    ac.abort();
    signal?.throwIfAborted();
    return [];
  };
  await tickEmbyNew(ac.signal);
  assert.deepEqual(pbiCalls, ["f-1"]);
  pending = readKv<Array<{ id: string; warmedAt?: number; failedAt?: number }>>(KEY.embyProbePending) ?? [];
  assert.equal(pending[0]?.warmedAt, undefined);
  assert.equal(pending[0]?.failedAt, undefined);
  pbiResult = () => [{ MediaStreams: [{}] }];
  await tickEmbyNew();
  assert.deepEqual(pbiCalls, ["f-1", "f-1"], "下一轮接着问");
});

test("一轮新增超过一页（整季八十集一次入库）：往后翻页，全部进 pending、通知按总数报", async () => {
  __test_resetMediaProbes();
  page = [ep({ episode: 0, at: T0 - 100_000 })];
  await tickEmbyNew();
  const season = Array.from({ length: 80 }, (_, i) => ep({ id: `s-${i + 1}`, episode: i + 1, at: T0 + 1000 + i, sources: [{ path: `/mnt/tv/S/S.S01E${i + 1}.mkv`, size: 1, streams: [] }] }));
  page = [...season].reverse().concat(page);
  byId = Object.fromEntries(season.map((i) => [i.id, i]));
  fetchCalls = 0;
  await tickEmbyNew();
  assert.equal(fetchCalls, 2, "一页 50 条装不下就翻第二页");
  assert.equal((notified[0] as Extract<NotifyEvent, { type: "emby-new" }>).total, 80);
  assert.equal(byIdCalls.at(-1)?.length, 80, "八十集都进了 pending");
});

test("预热：Emby 探不到的只问一次不反复问；关掉开关不问；同步 / 整理在跑时让路、空下来再问", async () => {
  __test_resetMediaProbes();
  const cold = ep({ id: "c-1", episode: 1, sources: [{ path: "/mnt/tv/C/C.S01E01.mkv", size: 1, streams: [] }] });
  page = [cold];
  byId = { "c-1": cold };
  pbiResult = () => [{ MediaStreams: [] }];
  await tickEmbyNew();
  assert.deepEqual(pbiCalls, ["c-1"]);
  await tickEmbyNew();
  assert.deepEqual(pbiCalls, ["c-1"], "探不到的记了时间，隔天才再试，这轮不重复问");

  await __test_resetEmbyNew();
  replaceAppSettings({ ...readAppSettings(), emby: { prewarm: false } });
  pbiCalls = [];
  await tickEmbyNew();
  assert.deepEqual(pbiCalls, [], "开关关着不预热");
  assert.ok(byIdCalls.length > 0, "但 pending 照样按 id 再问（Emby 自己播放过也会有流）");

  await __test_resetEmbyNew();
  replaceAppSettings({ ...readAppSettings(), emby: {} });
  busy = true;
  await tickEmbyNew();
  assert.deepEqual(pbiCalls, [], "同步 / 整理在跑：让路");
  busy = false;
  await tickEmbyNew();
  assert.deepEqual(pbiCalls, ["c-1"], "空下来那轮就问了");
});
