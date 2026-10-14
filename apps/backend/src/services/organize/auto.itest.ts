/**
 * 自动整理入口和复制队列的衔接：整理起不来时，为等它而压着的复制要立刻放行。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/organize/auto.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AppSettings, TaskDefinition } from "@openstrm/shared";
import { patchAppSettings, readAppSettings } from "../../db/repositories/settings.js";
import { listTasks, replaceTasks } from "../../db/repositories/tasks.js";
import { HttpError } from "../../lib/http-error.js";
import { clearCopies, listCopies, saveCopies } from "../copy/queue.js";
import { events } from "../events.js";
import { __test_flushAutoOrganize, __test_resetAutoOrganize, autoOrganizeBusy, setAutoOrganizeDeps, startAutoOrganize } from "./auto.js";

const task: TaskDefinition = { id: "t1", account: "acc", accountType: "115", originPath: "tv", targetPath: "tv", strmPrefix: "/mnt", organize: { mode: "auto" } };
let baseline: { tasks: TaskDefinition[]; tmdb: AppSettings["tmdb"] };

before(() => {
  startAutoOrganize();
  baseline = { tasks: listTasks(), tmdb: readAppSettings().tmdb };
  replaceTasks([task]);
  patchAppSettings({ tmdb: { apiKey: "k" } });
});

after(() => {
  __test_resetAutoOrganize();
  setAutoOrganizeDeps(null);
  clearCopies();
  replaceTasks(baseline.tasks);
  patchAppSettings({ tmdb: baseline.tmdb });
});

test("整理建 run 失败（不是「正在整理」）：为等它压着的复制立刻放行，不干等兜底的 10 分钟", async () => {
  const now = Date.now();
  saveCopies([
    {
      id: "held",
      account: "acc",
      srcDir: "/tv/某剧",
      name: "E01.mkv",
      dstDir: "/local/media/某剧",
      afterCopy: "keep",
      dstBase: "/local/media",
      rootPath: "tv",
      taskId: "t1",
      trigger: "share",
      addedAt: now - 1_000,
      status: "pending",
      stage: "waiting",
      detail: "",
      attempts: 0,
      waits: 0,
      misses: 0,
      holdUntil: now + 600_000,
    },
  ]);
  setAutoOrganizeDeps({
    createRun: async () => {
      throw new HttpError(400, "识别词有语法错误：第 1 行");
    },
  });
  events.emit("files.landed",{ task, paths: ["某剧/E01.mkv"], trigger: "share" });
  await __test_flushAutoOrganize();
  assert.equal(listCopies()[0].holdUntil, undefined);
});

test("任务正有整理在跑（409）：接着压着，等重试的那一次办完再放", async () => {
  const now = Date.now();
  saveCopies([
    {
      id: "held",
      account: "acc",
      srcDir: "/tv/某剧",
      name: "E01.mkv",
      dstDir: "/local/media/某剧",
      afterCopy: "keep",
      dstBase: "/local/media",
      rootPath: "tv",
      taskId: "t1",
      trigger: "share",
      addedAt: now - 1_000,
      status: "pending",
      stage: "waiting",
      detail: "",
      attempts: 0,
      waits: 0,
      misses: 0,
      holdUntil: now + 600_000,
    },
  ]);
  setAutoOrganizeDeps({
    createRun: async () => {
      throw new HttpError(409, "任务已有一次整理在进行中");
    },
    retryMs: 60_000,
  });
  events.emit("files.landed",{ task, paths: ["某剧/E01.mkv"], trigger: "share" });
  await __test_flushAutoOrganize();
  assert.equal(listCopies()[0].holdUntil, now + 600_000);
  __test_resetAutoOrganize();
});

test("有攒着的自动整理（把握大的直接执行）时 autoOrganizeBusy 为真；只出待确认清单的、清掉之后都为假", async () => {
  setAutoOrganizeDeps({
    createRun: async () => {
      throw new HttpError(400, "不该真的建出来");
    },
    debounceMs: 60_000,
  });
  try {
    assert.equal(autoOrganizeBusy("t1"), false);
    events.emit("files.landed",{ task, paths: ["某剧/E01.mkv"], trigger: "monitor", debounce: true });
    assert.equal(autoOrganizeBusy("t1"), true);
    __test_resetAutoOrganize();
    assert.equal(autoOrganizeBusy("t1"), false);
    events.emit("files.landed",{ task: { ...task, organize: { mode: "review" } }, paths: ["某剧/E01.mkv"], trigger: "monitor", debounce: true });
    assert.equal(autoOrganizeBusy("t1"), false, "只出待确认清单的不会自己动网盘");
  } finally {
    __test_resetAutoOrganize();
    setAutoOrganizeDeps(null);
  }
});

test("追更带的识别提示：攒着的按文件合并（同一个文件留后来的）；任务正有整理在跑（409）重排时也带着", async () => {
  const hint = (path: string, season: number) => ({ path, mediaType: "tv" as const, tmdbId: 1, season, episodeOffset: 0, seasonFallback: null, titles: [], label: "某剧" });
  const seen: Array<{ paths: string[]; hints: string[] }> = [];
  let busy = true;
  setAutoOrganizeDeps({
    createRun: async (input) => {
      seen.push({ paths: input.paths ?? [], hints: (input.hints ?? []).map((h) => `${h.path}:${h.season}`) });
      if (busy) throw new HttpError(409, "任务已有一次整理在进行中");
      return {} as never;
    },
    retryMs: 60_000,
  });
  events.emit("files.landed", { task, paths: ["某剧"], trigger: "follow", hints: [hint("某剧/E01.mkv", 2)] });
  events.emit("files.landed", { task, paths: ["某剧/E02.mkv"], trigger: "follow", hints: [hint("某剧/E02.mkv", 2), hint("某剧/E01.mkv", 3)] });
  await __test_flushAutoOrganize();
  busy = false;
  await __test_flushAutoOrganize();
  const want = { paths: ["某剧", "某剧/E02.mkv"], hints: ["某剧/E01.mkv:3", "某剧/E02.mkv:2"] };
  assert.deepEqual(seen, [want, want]);
  __test_resetAutoOrganize();
});
