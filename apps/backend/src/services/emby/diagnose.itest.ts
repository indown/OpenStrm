/**
 * 起播诊断：Emby 和网盘都换成桩，验挑条目、两段计时和失败原因的透传。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/emby/diagnose.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import { resetSettingsMemo } from "../settings-safe.js";
import { diagnosePlayback, pickColdStrm, setDiagnoseDeps, type DiagnoseItem } from "./diagnose.js";

const baseline = readAppSettings();

function setEmby(apiKey: string, url = "http://127.0.0.1:1") {
  replaceAppSettings({ ...baseline, emby: { url, apiKey } });
  resetSettingsMemo();
}

const probed: DiagnoseItem = {
  Id: "1",
  Name: "已探过",
  Type: "Episode",
  Path: "/media/a/S01E01.strm",
  MediaSources: [{ Path: "/mnt/pan/a/S01E01.mkv", MediaStreams: [{}, {}] }],
};
const cold: DiagnoseItem = {
  Id: "2",
  Name: "没探过",
  Type: "Episode",
  Path: "/media/a/S01E02.strm",
  MediaSources: [{ Path: "/mnt/pan/a/S01E02.mkv", MediaStreams: [] }],
};
const local: DiagnoseItem = { Id: "3", Name: "本地", Type: "Movie", Path: "/media/m/x.mp4", MediaSources: [{ Path: "/media/m/x.mp4", MediaStreams: [] }] };

before(() => setEmby("k"));
after(() => {
  setDiagnoseDeps(null);
  replaceAppSettings(baseline);
  resetSettingsMemo();
});

test("挑条目：strm 里优先没探测过的，本地文件不算", () => {
  assert.equal(pickColdStrm([local, probed, cold])?.Id, "2");
  assert.equal(pickColdStrm([local, probed])?.Id, "1", "都探过就取最近的 strm");
  assert.equal(pickColdStrm([local]), null);
});

test("自动挑的冷条目：PlaybackInfo 带回流算 probed，直链两段用时原样透传；量之前先忘掉内存里的记录", async () => {
  const calls: string[] = [];
  setDiagnoseDeps({
    listRecent: async () => [local, probed, cold],
    playbackInfo: async (id) => {
      calls.push(`pbi:${id}`);
      return [{ Path: "/mnt/pan/a/S01E02.mkv", MediaStreams: [{}, {}, {}] }];
    },
    forget: (path) => {
      calls.push(`forget:${path}`);
    },
    resolve: async (path, ua) => {
      calls.push(`resolve:${path}:${ua}`);
      return { ok: true, url: "https://cdn/x", accountName: "主号", panPath: "/a/S01E02.mkv", timings: { pathMs: 1200, linkMs: 300, pathVia: "db" } };
    },
  });
  const d = await diagnosePlayback({ userAgent: "Infuse" });
  assert.deepEqual(calls, ["pbi:2", "forget:/mnt/pan/a/S01E02.mkv", "resolve:/mnt/pan/a/S01E02.mkv:Infuse"]);
  assert.equal(d.item.id, "2");
  assert.equal(d.item.picked, true);
  assert.equal(d.item.path, "/mnt/pan/a/S01E02.mkv", "直链按媒体源的 Path（strm 的内容）解析，不是 strm 文件自己的路径");
  assert.equal(d.emby.streamsBefore, 0);
  assert.equal(d.emby.streamsAfter, 3);
  assert.equal(d.emby.probed, true);
  assert.equal(d.emby.error, null);
  assert.equal(d.link.ok, true);
  assert.equal(d.link.account, "主号");
  assert.equal(d.link.pathMs, 1200);
  assert.equal(d.link.linkMs, 300);
  assert.ok(d.totalMs >= 0);
});

test("指定 id：早就探过的不算 probed；直链换不到把原因带回去", async () => {
  setDiagnoseDeps({
    getItem: async (id) => (id === "1" ? probed : null),
    playbackInfo: async () => [{ Path: "/mnt/pan/a/S01E01.mkv", MediaStreams: [{}, {}] }],
    resolve: async () => ({ ok: false, reason: "not-found" }),
  });
  const d = await diagnosePlayback({ itemId: "1" });
  assert.equal(d.item.picked, false);
  assert.equal(d.emby.probed, false);
  assert.equal(d.emby.streamsBefore, 2);
  assert.equal(d.link.ok, false);
  assert.equal(d.link.reason, "not-found");
  assert.equal(d.link.account, null);

  await assert.rejects(diagnosePlayback({ itemId: "404" }), (err: { status?: number }) => err.status === 404);
});

test("Emby 没回答和解析抛异常都不让诊断失败，记成 error", async () => {
  setDiagnoseDeps({
    getItem: async () => cold,
    playbackInfo: async () => {
      throw new Error("Emby 504 Gateway Timeout");
    },
    resolve: async () => {
      throw new Error("115 风控");
    },
  });
  const d = await diagnosePlayback({ itemId: "2" });
  assert.equal(d.emby.error, "Emby 504 Gateway Timeout");
  assert.equal(d.emby.streamsAfter, 0, "没回答就按诊断前的流数算");
  assert.equal(d.emby.probed, false);
  assert.equal(d.link.reason, "error");
  assert.equal(d.link.error, "115 风控");
});

test("最近入库没有 strm 条目回 404；Emby 没配（key 或地址）回 400", async () => {
  setDiagnoseDeps({ listRecent: async () => [local] });
  await assert.rejects(diagnosePlayback(), (err: { status?: number }) => err.status === 404);
  setEmby("");
  try {
    await assert.rejects(diagnosePlayback({ itemId: "1" }), (err: { status?: number }) => err.status === 400);
    setEmby("k", "");
    await assert.rejects(diagnosePlayback({ itemId: "1" }), (err: { status?: number }) => err.status === 400, "没填地址也是 400，不能对着默认网关地址去问");
  } finally {
    setEmby("k");
  }
});

test("挑条目 / 取条目时 Emby 连不上：按上游错误回（500 + 原话），不是未处理异常", async () => {
  setDiagnoseDeps({
    getItem: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(diagnosePlayback({ itemId: "1" }), (err: { status?: number; message?: string }) => err.status === 500 && /Emby 没回答：fetch failed/.test(err.message ?? ""));
});

test("同步 / 整理在跑时不量：回 409 让用户等它们跑完", async () => {
  setDiagnoseDeps({ getItem: async () => cold, busy: () => true });
  await assert.rejects(diagnosePlayback({ itemId: "2" }), (err: { status?: number }) => err.status === 409);
});
