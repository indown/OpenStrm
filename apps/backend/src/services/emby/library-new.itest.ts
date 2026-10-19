/**
 * Emby 入库通知：/Items 查询和 Telegram 都换成桩，直接驱动 tickEmbyNew 验证游标与聚合。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/emby/library-new.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AppSettings } from "@openstrm/shared";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
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
let fetchCalls = 0;
let notified: NotifyEvent[] = [];

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
    fetch: async () => {
      fetchCalls += 1;
      return page ? [...page] : null;
    },
    notify: async (ev) => {
      notified.push(ev);
    },
  });
});

beforeEach(async () => {
  await __test_resetEmbyNew();
  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100" } });
  page = [];
  fetchCalls = 0;
  notified = [];
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
