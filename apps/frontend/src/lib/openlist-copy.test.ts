/**
 * 任务弹框里「开着复制却复制不了」卡在哪：条件和顺序跟后端 services/copy/paths.ts 的 copySettingsGap / copyBlockerFor 一样。
 * 挂载层账号（OpenList / CloudDrive2）的判断和后端 services/drive/types.ts 的 isMountLayerKind 一样。
 *
 *   pnpm --filter @openstrm/frontend test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isMountLayerKind } from "./drive";
import { copyGapInDialog, isOpenlistRootInput, normTargetDir } from "./openlist-copy";

const accounts = [
  { name: "my115", accountType: "115" },
  { name: "ol", accountType: "openlist" },
  { name: "nas-cd2", accountType: "cd2" },
];

test("OpenList 引擎：按设置页从上到下说缺哪样——没选账号、账号不在了、这个网盘没填挂载根、没有目标目录", () => {
  assert.match(copyGapInDialog({}, "my115", "", accounts) ?? "", /还没选 OpenList 账号/);
  assert.match(copyGapInDialog({ account: "gone", mounts: { my115: "/115" }, dstDir: "/local" }, "my115", "", accounts) ?? "", /OpenList 账号「gone」已经不在了/);
  assert.match(copyGapInDialog({ account: "nas-cd2", mounts: { my115: "/115" }, dstDir: "/local" }, "my115", "", accounts) ?? "", /已经不在了/, "选成了别的类型的账号也算不在");
  assert.match(copyGapInDialog({ account: "ol", mounts: { my115: "  " }, dstDir: "/local" }, "my115", "", accounts) ?? "", /账号 my115 还没在设置页填「在 OpenList 里的挂载根」/);
  assert.match(copyGapInDialog({ account: "ol", mounts: { my115: "/115" } }, "my115", "", accounts) ?? "", /没有目标目录/);
  assert.equal(copyGapInDialog({ account: "ol", mounts: { my115: "/115" } }, "my115", "/local/tv", accounts), null, "任务上填了目标目录也行");
  assert.equal(copyGapInDialog({ account: "ol", mounts: { my115: "/115" }, dstDir: "/local" }, "my115", "", accounts), null);
  assert.equal(copyGapInDialog({ account: "gone", mounts: { my115: "/115" }, dstDir: "/local" }, "my115", "", []), null, "账号列表还没读到时不查账号在不在");
});

test("CloudDrive2 引擎：看 CloudDrive2 一节选的账号和那里的路径，不要 OpenList 账号", () => {
  const cfg = { engine: "cd2" as const, dstDir: "/hdd/media" };
  assert.match(copyGapInDialog(cfg, "my115", "", accounts, {}) ?? "", /CloudDrive2 一节还没选 CD2 账号/);
  assert.match(copyGapInDialog(cfg, "my115", "", accounts, undefined) ?? "", /还没选 CD2 账号/);
  assert.match(copyGapInDialog(cfg, "my115", "", accounts, { account: "gone", mounts: { my115: "/115" } }) ?? "", /CD2 账号「gone」已经不在了/);
  assert.match(copyGapInDialog(cfg, "my115", "", accounts, { account: "ol", mounts: { my115: "/115" } }) ?? "", /已经不在了/, "选成了 OpenList 账号也算不在");
  assert.match(copyGapInDialog(cfg, "my115", "", accounts, { account: "nas-cd2", mounts: {} }) ?? "", /账号 my115 还没在设置页 CloudDrive2 一节填「在 CD2 里的路径」/);
  assert.equal(copyGapInDialog(cfg, "my115", "", accounts, { account: "nas-cd2", mounts: { my115: "/115open" } }), null);
  assert.match(copyGapInDialog({ engine: "cd2" }, "my115", "", accounts, { account: "nas-cd2", mounts: { my115: "/115open" } }) ?? "", /没有目标目录/);
  assert.equal(copyGapInDialog(cfg, "my115", "", [], { account: "gone", mounts: { my115: "/115" } }), null, "账号列表还没读到时不查账号在不在");
});

test("目标目录填成根 / 等于没填，并说清楚是设置页那个不算", () => {
  const gap = copyGapInDialog({ account: "ol", mounts: { my115: "/115" }, dstDir: "/" }, "my115", "", accounts) ?? "";
  assert.match(gap, /设置页的默认目标目录填的是根 \//);
  assert.equal(normTargetDir(" /local//tv/ "), "/local/tv");
  assert.equal(normTargetDir("/"), "");
  assert.equal(isOpenlistRootInput("//"), true);
  assert.equal(isOpenlistRootInput(""), false);
});

test("挂载层账号：OpenList 和 CloudDrive2 是，115 / 夸克和认不出的不是", () => {
  assert.deepEqual(["115", "quark", "openlist", "cd2", "", undefined].map(isMountLayerKind), [false, false, true, true, false, false]);
});
