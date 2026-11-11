/**
 * 通知入口：开关过滤、去重、模板转义。发送函数换成桩。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/telegram/notify.itest.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { readAppSettings, replaceAppSettings } from "../../db/repositories/settings.js";
import type { InlineKeyboard } from "./bot.js";
import { __test_resetNotify, classifyAccountIssue, telegramNotify as notify, setButtonSender, setNotifySender } from "./notify.js";

const baseline = readAppSettings();
const sent: Array<{ chatId: string; text: string }> = [];
const task = { id: "t1", originPath: "tv/<剧集>", targetPath: "tv", account: "主号" };

before(() => setNotifySender(async (chatId, text) => { sent.push({ chatId, text }); }));
beforeEach(() => {
  sent.length = 0;
  __test_resetNotify();
  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100" } });
});
after(() => {
  setNotifySender(null);
  replaceAppSettings(baseline);
});

test("没配 token 或 chatId 就不发", async () => {
  replaceAppSettings({ ...baseline, telegram: { botToken: "t" } });
  assert.equal(await notify({ type: "task-start", task, total: 3 }), false);
  assert.equal(sent.length, 0);
});

test("默认开关：任务开始不发，完成 / 失败 / 云下载 / 账号告警发；可以逐项关掉", async () => {
  assert.equal(await notify({ type: "task-start", task, total: 3 }), false);
  assert.equal(await notify({ type: "task-done", task, status: "completed", total: 3, finished: 3, failed: 0, durationMs: 65_000 }), true);
  assert.match(sent[0].text, /✅ <b>同步完成<\/b>\ntv\/&lt;剧集&gt; → tv\n3\/3 个文件，用时 1 分 5 秒/);
  assert.equal(sent[0].chatId, "-100");

  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100", notify: { taskDone: false, taskStart: true } } });
  assert.equal(await notify({ type: "task-done", task, status: "completed", total: 3, finished: 3, failed: 0, durationMs: 1 }), false);
  assert.equal(await notify({ type: "task-start", task, total: 3, trigger: "cron" }), true);
  assert.match(sent.at(-1)!.text, /🚀 <b>任务开始<\/b>（定时）/);
});

test("失败与取消的文案带数量和原因，原因做 HTML 转义", async () => {
  await notify({ type: "task-done", task, status: "failed", total: 5, finished: 4, failed: 1, durationMs: 1000, message: "1 个文件失败：<x>.nfo" });
  assert.match(sent[0].text, /❌ <b>同步失败<\/b>[\s\S]*完成 4\/5 个文件，失败 1[\s\S]*1 个文件失败：&lt;x&gt;\.nfo$/);
  await notify({ type: "task-done", task, status: "failed", total: 5, finished: 2, failed: 3, durationMs: 1000, message: "3 个文件失败：文件名过长 3", advice: "用「整理」改成标准命名" });
  assert.match(sent[1].text, /3 个文件失败：文件名过长 3\n👉 用「整理」改成标准命名$/);
  await notify({ type: "task-done", task, status: "cancelled", total: 5, finished: 2, failed: 0, durationMs: 1000, message: "用户取消" });
  assert.match(sent[2].text, /⏹ <b>任务已取消<\/b>[\s\S]*完成 2\/5 个文件\n用户取消/);
});

test("整理完成 / 撤销的文案：失败按类别拆开、本地未同步单列、有事要处理就提示去整理页", async () => {
  await notify({ type: "organize-done", task, runId: "r1", units: 3, done: 8, failed: 0 });
  assert.match(sent[0].text, /🗂 <b>整理完成<\/b>[\s\S]*3 部作品，8 项已改名 \/ 移动$/);
  await notify({ type: "organize-done", task, runId: "r2", units: 3, done: 6, failed: 3, failedByKind: { transient: 2, blocked: 0, stale: 1, rejected: 0, mirror: 2 } });
  assert.match(sent[1].text, /⚠️ <b>整理完成（有失败）<\/b>[\s\S]*6 项已改名 \/ 移动，失败 3（临时失败 2、预览后变了 1），本地未同步 2\n到「整理」页重试或放弃$/);
  await notify({ type: "organize-done", task, runId: "r3", units: 3, done: 8, failed: 0, reverted: true, notReverted: 0 });
  assert.match(sent[2].text, /↩️ <b>整理已撤销<\/b>[\s\S]*8 项已退回$/);
  await notify({ type: "organize-done", task, runId: "r4", units: 3, done: 7, failed: 1, reverted: true, notReverted: 2, failedByKind: { transient: 1, blocked: 0, stale: 1, rejected: 0, mirror: 0 } });
  assert.match(sent[3].text, /⚠️ <b>整理已撤销（有没退回的）<\/b>[\s\S]*7 项已退回，2 项没退回（临时失败 1、预览后变了 1）\n到「整理」页继续撤销或放弃$/);
});

test("账号告警：认得出 cookie 失效和封控，同一账号同一原因一小时只发一次；认不出的不发", async () => {
  assert.equal(classifyAccountIssue("115：登录超时，请重新登录。（errno 990001）"), "cookie");
  assert.equal(classifyAccountIssue("115 接口返回 405: 您的访问被阻断"), "blocked");
  assert.equal(classifyAccountIssue("socket hang up"), null);

  assert.equal(await notify({ type: "account-alert", account: "主号", reason: "socket hang up", source: "网盘监控" }), false);
  assert.equal(await notify({ type: "account-alert", account: "主号", reason: "登录超时，请重新登录", source: "网盘监控" }), true);
  assert.match(sent[0].text, /⚠️ <b>网盘账号需要处理<\/b>\n账号 <b>主号<\/b> 的登录凭据（cookie \/ 密码 \/ 令牌）已失效[\s\S]*来源：网盘监控/);
  assert.equal(await notify({ type: "account-alert", account: "主号", reason: "登录超时，请重新登录", source: "网盘监控" }), false, "一小时内不重复");
  assert.equal(await notify({ type: "account-alert", account: "小号", reason: "登录超时", source: "网盘监控" }), true, "别的账号照发");
  assert.equal(await notify({ type: "account-alert", account: "主号", reason: "您的访问被阻断 405", source: "同步" }), true, "同账号不同原因照发");
});

test("启动失败：账号问题按账号告警去重（定时触发不会每半小时响一次），其它原因按任务去重", async () => {
  assert.equal(await notify({ type: "task-start-failed", task, reason: "读取 115 目录失败：登录超时，请重新登录", trigger: "cron" }), true);
  assert.match(sent[0].text, /网盘账号需要处理[\s\S]*来源：任务 tv\/&lt;剧集&gt; → tv/);
  assert.equal(await notify({ type: "task-start-failed", task, reason: "读取 115 目录失败：登录超时，请重新登录", trigger: "cron" }), false);
  assert.equal(await notify({ type: "account-alert", account: "主号", reason: "登录超时", source: "网盘监控" }), false, "监控撞到同一件事也不再响");

  assert.equal(await notify({ type: "task-start-failed", task, reason: "OpenList 登录失败", trigger: "cron" }), true);
  assert.match(sent.at(-1)!.text, /❌ <b>任务启动失败<\/b>（定时触发）\ntv\/&lt;剧集&gt; → tv\nOpenList 登录失败/);
  assert.equal(await notify({ type: "task-start-failed", task, reason: "OpenList 登录失败", trigger: "cron" }), false);
});

test("云下载：完成与失败", async () => {
  assert.equal(await notify({ type: "offline-done", name: "Show <S01>", detail: "已生成 8 个 strm", target: "tv/Show" }), true);
  assert.match(sent[0].text, /☁️ <b>云下载完成<\/b>\nShow &lt;S01&gt;\n已生成 8 个 strm\n→ tv\/Show/);
  assert.equal(await notify({ type: "offline-failed", name: "x", detail: "115 下载失败：资源违规" }), true);
  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100", notify: { offline: false } } });
  assert.equal(await notify({ type: "offline-done", name: "y", detail: "", target: "" }), false);
});

test("云下载：复制到 OpenList 的成败共用 offline 开关", async () => {
  assert.equal(await notify({ type: "offline-copied", name: "Show <S01>", target: "/local/dl" }), true);
  assert.match(sent[0].text, /📦 <b>已复制到 OpenList<\/b>\nShow &lt;S01&gt;\n→ \/local\/dl/);
  assert.equal(await notify({ type: "offline-copy-failed", name: "x", detail: "OpenList 复制失败：存储空间不足" }), true);
  assert.match(sent[1].text, /❌ <b>云下载未能复制到 OpenList<\/b>\nx\nOpenList 复制失败：存储空间不足/);
  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100", notify: { offline: false } } });
  assert.equal(await notify({ type: "offline-copied", name: "y", target: "" }), false);
  assert.equal(await notify({ type: "offline-copy-failed", name: "y", detail: "" }), false);
});

test("复制到 OpenList：源文件稍后自动再处理的另起一行；晚点再做也没成的单发一条；都走 offline 开关", async () => {
  assert.equal(
    await notify({ type: "copy-done", names: ["E01.mkv"], target: "/local/tv", source: "手动", retrying: ["E01.mkv：归档没成（网盘接口 30 秒没有回应）"] }),
    true,
  );
  assert.equal(sent[0].text, "📦 <b>已复制到 OpenList</b>（手动）\nE01.mkv\n→ /local/tv\n源文件稍后自动再处理：E01.mkv：归档没成（网盘接口 30 秒没有回应）");
  assert.equal(await notify({ type: "copy-kept", source: "手动", kept: ["E01 <1>.mkv：归档源文件失败：网盘接口 30 秒没有回应（自动重试 3 次都没成）"] }), true);
  assert.equal(
    sent[1].text,
    "⚠️ <b>复制后源文件没按设置处理</b>（手动）\nE01 &lt;1&gt;.mkv：归档源文件失败：网盘接口 30 秒没有回应（自动重试 3 次都没成）\n复制已经完成；网盘上那份还在原处，需要的话手动处理",
  );
  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100", notify: { offline: false } } });
  assert.equal(await notify({ type: "copy-kept", source: "手动", kept: ["x"] }), false);
});

test("Emby 入库：按剧聚合、连号折叠、电影带年份；批量只报总数；开关可关", async () => {
  const groups = [
    { kind: "tv" as const, name: "怪奇物语", season: 5, episodes: [5, 6, 7, 9], count: 4 },
    { kind: "movie" as const, name: "沙丘 2", year: 2024, episodes: [], count: 1 },
  ];
  assert.equal(await notify({ type: "emby-new", groups, total: 5 }), true);
  assert.match(sent[0].text, /📥 <b>Emby 入库<\/b>\n《怪奇物语》 S05 新增 4 集：E05-E07、E09\n《沙丘 2》\(2024\)/);

  assert.equal(await notify({ type: "emby-new", groups: [], total: 120 }), true);
  assert.match(sent[1].text, /新增 120 个条目（数量太多，不逐条列了）/);

  replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100", notify: { embyNew: false } } });
  assert.equal(await notify({ type: "emby-new", groups, total: 5 }), false);
});

test("启动失败带着网盘自己认出的账号问题：夸克的 require login 文案认不出，也按账号告警发", async () => {
  const quarkTask = { ...task, id: "t-quark-alert", account: "夸克号" };
  assert.equal(await notify({ type: "task-start-failed", task: quarkTask, reason: "读取夸克网盘目录失败：夸克 /file/sort 失败：require login [guest]", trigger: "cron", issue: "cookie" }), true);
  assert.match(sent.at(-1)!.text, /网盘账号需要处理[\s\S]*夸克号/);
  assert.equal(await notify({ type: "task-start-failed", task: quarkTask, reason: "读取夸克网盘目录失败：夸克 /file/sort 失败：require login [guest]", trigger: "cron", issue: "cookie" }), false, "同一账号同一原因一小时只发一次");
});

test("追更失效 / 停更：配了资源搜索就带「搜替代资源」按钮，没配就是普通通知", async () => {
  const withButtons: Array<{ text: string; buttons: InlineKeyboard }> = [];
  setButtonSender(async (_chatId, text, buttons) => void withButtons.push({ text, buttons }));
  try {
    assert.equal(await notify({ type: "follow-expired", id: "f1", name: "繁花", reason: "分享已取消" }), true);
    assert.equal(withButtons.length, 0);
    assert.match(sent.at(-1)!.text, /追更已停止/);

    replaceAppSettings({ ...baseline, telegram: { botToken: "t", chatId: "-100" }, pansou: { baseUrl: "http://pansou" } });
    assert.equal(await notify({ type: "follow-stale", id: "f2", name: "繁花", days: 30 }), true);
    assert.equal(withButtons.length, 1);
    assert.match(withButtons[0].text, /追更已暂停/);
    assert.deepEqual(withButtons[0].buttons, [[{ text: "🔍 搜替代资源", callback_data: "fsr:f2" }]]);
  } finally {
    setButtonSender(null);
  }
});
