/**
 * 设置页「网盘挂载」两家共用的挂载映射工具。
 *
 *   pnpm --filter @openstrm/frontend test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { joinLayerPath, layerAccountStatus, mountClashes, mountExample, mountKey, mountRowVerdict, tidyMounts, withMount } from "./mount-layer";

test("mountKey：去空白、收斜杠、去尾斜杠、补头斜杠；根还是 /，空的还是空", () => {
  assert.equal(mountKey(" 115/ "), "/115");
  assert.equal(mountKey("//115//tv//"), "/115/tv");
  assert.equal(mountKey("/"), "/");
  assert.equal(mountKey("  "), "");
});

test("mountClashes：同一个路径的网盘账号互相报出来；写法不同的同一个路径也算；删掉的账号和空的不算", () => {
  const c = mountClashes({ a: "/115", b: " 115/ ", c: "/quark", gone: "/quark", d: "  " }, ["a", "b", "c", "d"]);
  assert.deepEqual(
    [...c.entries()].sort(([x], [y]) => x.localeCompare(y)),
    [
      ["a", ["b"]],
      ["b", ["a"]],
    ],
  );
  assert.deepEqual(mountClashes({ a: "/x", b: "/x", c: "/x" }, ["a", "b", "c"]).get("a"), ["b", "c"], "三个撞一起时各报另外两个");
  assert.equal(mountClashes(undefined, ["a"]).size, 0);
});

test("joinLayerPath：中间只留一个斜杠，挂在根上的也对；段里的空格原样留着", () => {
  assert.equal(joinLayerPath("/115", "tv"), "/115/tv");
  assert.equal(joinLayerPath("/115/", "/tv/"), "/115/tv");
  assert.equal(joinLayerPath("/", "tv"), "/tv");
  assert.equal(joinLayerPath("/", ""), "/");
  assert.equal(joinLayerPath("/115", "Season 1 "), "/115/Season 1 ");
});

test("mountExample：按两家各自的习惯给；同类型好几个账号、认不出的类型用账号名", () => {
  const quark = { name: "kk", accountType: "quark" };
  assert.equal(mountExample("openlist", quark, 1), "/quark");
  assert.equal(mountExample("cd2", quark, 1), "/夸克网盘");
  assert.equal(mountExample("cd2", { name: "my115", accountType: "115" }, 1), "/115");
  assert.equal(mountExample("openlist", { name: "my115", accountType: "115" }, 2), "/my115");
  assert.equal(mountExample("openlist", { name: "x", accountType: "other" }, 1), "/x");
});

test("layerAccountStatus：选的账号在不在、类型对不对；账号列表还没读到时先当在", () => {
  const accounts = [
    { name: "ol", accountType: "openlist" },
    { name: "nas-cd2", accountType: "cd2" },
  ];
  assert.deepEqual(layerAccountStatus(accounts, "openlist", "ol"), { missing: false, usable: true });
  assert.deepEqual(layerAccountStatus(accounts, "openlist", " ol "), { missing: false, usable: true }, "两头的空白不算");
  assert.deepEqual(layerAccountStatus(accounts, "openlist", "gone"), { missing: true, usable: false });
  assert.deepEqual(layerAccountStatus(accounts, "cd2", "ol"), { missing: true, usable: false }, "选成了别的类型也算不在");
  assert.deepEqual(layerAccountStatus(accounts, "cd2", ""), { missing: false, usable: false }, "没选");
  assert.deepEqual(layerAccountStatus(null, "cd2", "gone"), { missing: false, usable: true }, "列表还没读到");
});

test("withMount / tidyMounts：打字时原样留着、空白就删掉这一行；提交前去两头空白、丢掉空的", () => {
  assert.deepEqual(withMount({ a: "/115" }, "b", " /my 115 "), { a: "/115", b: " /my 115 " });
  assert.deepEqual(withMount({ a: "/115", b: "/x" }, "b", "  "), { a: "/115" });
  assert.deepEqual(withMount(undefined, "a", "/115"), { a: "/115" });
  assert.deepEqual(tidyMounts({ a: " /my 115 ", b: "  ", c: "/quark" }), { a: "/my 115", c: "/quark" });
  assert.equal(tidyMounts(undefined), undefined);
});

test("mountRowVerdict：网盘上就没有的任务目录不怪这里填的路径（2026-11-11 真机：lab 任务目录还没建，检查却说挂载根填错了）", () => {
  const base = { short: "OpenList", field: "挂载根", clashWith: null };
  // 网盘上就不在：黄的，说和挂载根无关
  const gone = mountRowVerdict({ ...base, probed: 1, lost: [], gone: ["/lab1111/tv"] });
  assert.equal(gone.tone, "warn");
  assert.match(gone.text, /^能打开；1 个任务的目录在网盘上就不在（\/lab1111\/tv），和挂载根无关/);
  assert.doesNotMatch(gone.text, /填错/);
  // 有对得上的就一起说
  assert.match(mountRowVerdict({ ...base, probed: 3, lost: [], gone: ["/a"] }).text, /^能打开，2 个任务目录对得上；1 个任务的目录/);
  // 网盘上有、挂载层里没有：照旧算填错，网盘上没有的附在后面
  const lost = mountRowVerdict({ ...base, probed: 4, lost: ["/115/tv", "/115/movie", "/115/x"], gone: ["/old"] });
  assert.equal(lost.tone, "bad");
  assert.equal(lost.text, "3 个任务目录在 OpenList 里找不到（/115/tv、/115/movie 等）：挂载根多半填错了；另有 1 个任务的目录在网盘上就不在（/old）");
  // 撞车优先于「网盘上没有」，也是红的
  const clash = mountRowVerdict({ ...base, probed: 2, lost: [], gone: ["/old"], clashWith: ["kk（夸克）"] });
  assert.equal(clash.tone, "bad");
  assert.match(clash.text, /^能打开，但和 kk（夸克） 填的是同一个挂载根.*；另有 1 个任务的目录在网盘上就不在/);
  // 全对 / 没有任务
  assert.deepEqual(mountRowVerdict({ ...base, probed: 2, lost: [], gone: [] }), { tone: "ok", text: "能打开，2 个任务目录都对得上" });
  assert.deepEqual(mountRowVerdict({ ...base, probed: 0, lost: [], gone: [] }), { tone: "ok", text: "能打开" });
});
