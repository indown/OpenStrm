/**
 * 网盘路径 ↔ OpenList 路径的换算。不碰网络；只有 CloudDrive2 引擎那一条要往账号表里放账号（配置是按账号取的）。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/copy/paths.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppSettings } from "@openstrm/shared";
import { listAccounts, replaceAccounts } from "../../db/repositories/accounts.js";
import { HttpError } from "../../lib/http-error.js";
import {
  baseName,
  checkCopyDstDir,
  copyBlockerFor,
  copyDstProblem,
  copyOptionsFor,
  copySettingsGap,
  dstDirFor,
  isOpenlistRootInput,
  joinPath,
  normDir,
  normTargetDir,
  parentDir,
  relativeTo,
  resolveCopyConfig,
  toOpenlistPath,
} from "./paths.js";

test("checkCopyDstDir：这次指定的复制目标——没给回 undefined；这次不会复制、任务开着却说不复制、越界、不是路径各有各的 code", () => {
  const s = { openlistCopy: { account: "ol", dstDir: "/local/media", mounts: { a: "/115" } } } as unknown as AppSettings;
  const off = { copyToOpenlist: { enabled: false, dstDir: "/local/media/tv" } };
  const on = { copyToOpenlist: { enabled: true, dstDir: "/local/movies" } };
  assert.equal(checkCopyDstDir(off, true, undefined, s), undefined);
  assert.equal(checkCopyDstDir(off, true, "  ", s), undefined, "空串当没给");
  assert.equal(checkCopyDstDir(off, true, "/local/media/movie/", s), "/local/media/movie", "归一");
  assert.equal(checkCopyDstDir(on, undefined, "/local/movies/4K", s), "/local/movies/4K", "任务开着不传 copy 也算会复制");
  assert.equal(checkCopyDstDir(null, true, "/local/media/x", s), "/local/media/x", "没任务只看设置页的目标目录");
  const code = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (err) {
      return (err as HttpError).extra.code;
    }
    return null;
  };
  assert.equal(code(() => checkCopyDstDir(off, undefined, "/local/media/tv", s)), "COPY_DST_UNUSED");
  assert.equal(code(() => checkCopyDstDir(null, undefined, "/local/media/tv", s)), "COPY_DST_UNUSED");
  assert.equal(code(() => checkCopyDstDir(on, false, "/local/movies/4K", s)), "COPY_ALWAYS_ON", "任务开着复制：copy: false 兑现不了，不能说成「这次不会复制」");
  assert.equal(code(() => checkCopyDstDir(off, true, "/elsewhere", s)), "COPY_DST_INVALID");
  assert.equal(code(() => checkCopyDstDir(off, true, "/", s)), "COPY_DST_INVALID", "OpenList 根不行");
  assert.equal(code(() => checkCopyDstDir(off, true, "//", s)), "VALIDATION");
});

test("normDir：补头斜杠、去尾斜杠、收起连着的斜杠", () => {
  assert.equal(normDir("/115"), "/115");
  assert.equal(normDir("115"), "/115");
  assert.equal(normDir("/115/"), "/115");
  assert.equal(normDir("/115//云下载//"), "/115/云下载");
  assert.equal(normDir("/"), "/");
  assert.equal(normDir(""), "");
  assert.equal(normDir(undefined), "");
});

test("名字和父目录不 trim：网盘上真有结尾带空格的目录名", () => {
  assert.equal(baseName("/tv/Season 1 /E01.mkv"), "E01.mkv");
  assert.equal(parentDir("/tv/Season 1 /E01.mkv"), "/tv/Season 1 ");
  assert.equal(baseName("/tv/某剧 "), "某剧 ");
  assert.equal(parentDir("/tv"), "/");
});

test("toOpenlistPath：挂载根拼在网盘绝对路径前面", () => {
  const mounts = { my115: "/115", quark1: "/quark", root: "/" };
  assert.equal(toOpenlistPath(mounts, "my115", "/tv/某剧/S01E01.mkv"), "/115/tv/某剧/S01E01.mkv");
  assert.equal(toOpenlistPath(mounts, "quark1", "/来自：分享"), "/quark/来自：分享");
  assert.equal(toOpenlistPath(mounts, "root", "/tv"), "/tv", "挂载根是 / 时不多一层");
  assert.equal(toOpenlistPath(mounts, "没配过的账号", "/tv"), null);
});

test("relativeTo：不在根下面的返回 null", () => {
  assert.equal(relativeTo("/tv", "/tv/某剧/S01/E01.mkv"), "某剧/S01/E01.mkv");
  assert.equal(relativeTo("/tv", "/tv"), "");
  assert.equal(relativeTo("/tv", "/movies/别的"), null);
  assert.equal(relativeTo("/tv", "/tvshows/像但不是"), null, "只认整段前缀");
  assert.equal(relativeTo("/", "/tv/某剧"), "tv/某剧");
});

test("dstDirFor：目录层级原样搬到目标下面，不平铺", () => {
  assert.deepEqual(dstDirFor("/local/media", "/tv", "/tv/某剧/S01/E01.mkv"), { dstDir: "/local/media/某剧/S01", flattened: false });
  assert.deepEqual(dstDirFor("/local/media", "/tv", "/tv/某剧"), { dstDir: "/local/media", flattened: false });
  assert.deepEqual(dstDirFor("/local/media/", "/tv", "/tv/a/b.mkv"), { dstDir: "/local/media/a", flattened: false });
});

test("dstDirFor：没给根、或路径不在根下面，就平铺到目标目录", () => {
  assert.deepEqual(dstDirFor("/local/media", undefined, "/云下载/Show.S01"), { dstDir: "/local/media", flattened: false });
  assert.deepEqual(dstDirFor("/local/media", "/tv", "/别处/Show.S01"), { dstDir: "/local/media", flattened: true });
});

test("joinPath：中间只留一个斜杠", () => {
  assert.equal(joinPath("/115", "/tv"), "/115/tv");
  assert.equal(joinPath("/115/", "tv"), "/115/tv");
  assert.equal(joinPath("/", "tv"), "/tv");
  assert.equal(joinPath("/115", ""), "/115");
});

const withCopy = (openlistCopy: AppSettings["openlistCopy"]) => ({ openlistCopy }) as unknown as AppSettings;

test("copySettingsGap：按设置页从上到下说缺哪样；同类型的两个账号各看各的挂载根", () => {
  assert.match(copySettingsGap("115-a", withCopy(undefined)) ?? "", /还没选 OpenList 账号/);
  const s = withCopy({ account: "ol", dstDir: "/local", mounts: { "115-a": "/115", "115-b": "  " } });
  assert.equal(copySettingsGap("115-a", s), null);
  assert.match(copySettingsGap("115-b", s) ?? "", /账号 115-b 还没填「在 OpenList 里的挂载根」/, "只填了空白等于没填");
  assert.match(copySettingsGap("夸克", s) ?? "", /账号 夸克 还没填/);
  const noDst = withCopy({ account: "ol", mounts: { "115-a": "/115" } });
  assert.match(copySettingsGap("115-a", noDst) ?? "", /没有目标目录/);
  assert.equal(copySettingsGap("115-a", noDst, "/local/tv"), null, "任务上填了目标目录也行");
});

test("copyOptionsFor：要复制却配不齐就当关，blocked 说卡在哪；本来就不复制的不带 blocked", () => {
  const s = withCopy({ account: "ol", dstDir: "/local", mounts: { "115-a": "/115" } });
  // 老数据只有 deleteSource：读成 delete
  const on = { enabled: true, deleteSource: true };
  assert.deepEqual(copyOptionsFor({ account: "115-a", copyToOpenlist: on }, undefined, s), { enabled: true, dstDir: undefined, afterCopy: "delete" });
  assert.equal(copyOptionsFor({ account: "115-a", copyToOpenlist: { enabled: true, afterCopy: "archive" } }, undefined, s).afterCopy, "archive");
  assert.equal(copyOptionsFor({ account: "115-a", copyToOpenlist: { enabled: true } }, undefined, s).afterCopy, "keep");
  const blocked = copyOptionsFor({ account: "115-b", copyToOpenlist: on }, undefined, s);
  assert.equal(blocked.enabled, false);
  assert.equal(blocked.afterCopy, "keep");
  assert.match(blocked.blocked ?? "", /115-b 还没填/, "第二个 115 没填挂载根：任务开着复制也不复制，但要说出来");
  assert.match(copyOptionsFor({ account: "115-b" }, true, s).blocked ?? "", /115-b/, "一次性勾的也算要复制");
  assert.equal(copyOptionsFor({ account: "115-b", copyToOpenlist: on }, false, s).blocked, undefined, "这次明说不复制");
  assert.equal(copyOptionsFor({ account: "115-b" }, undefined, s).blocked, undefined, "任务上没开");
  assert.deepEqual(copyOptionsFor({ account: "115-a" }, true, s), { enabled: true, dstDir: undefined, afterCopy: "keep" }, "一次性勾选不动源文件");
  assert.equal(copyOptionsFor({ account: "115-a", copyToOpenlist: { enabled: false, afterCopy: "archive" } }, true, s).afterCopy, "keep", "任务没开复制：一次性勾的不认任务上留着的去向");
});

test("normTargetDir：目标目录填成 OpenList 根 / 算没填；isOpenlistRootInput 认出填的是根", () => {
  assert.equal(normTargetDir("/"), "");
  assert.equal(normTargetDir(" / "), "");
  assert.equal(normTargetDir("//"), "");
  assert.equal(normTargetDir("/hhd/tv/"), "/hhd/tv");
  assert.equal(normTargetDir("hhd"), "/hhd");
  assert.equal(normTargetDir(undefined), "");
  assert.equal(isOpenlistRootInput("/"), true);
  assert.equal(isOpenlistRootInput(" // "), true);
  assert.equal(isOpenlistRootInput(""), false, "空着是没填，不是填了根");
  assert.equal(isOpenlistRootInput("  "), false);
  assert.equal(isOpenlistRootInput(undefined), false);
  assert.equal(isOpenlistRootInput("/hhd"), false);
});

test("copySettingsGap：目标目录填成 / 等于没填，并说清楚是 / 不算", () => {
  const rootDefault = withCopy({ account: "ol", dstDir: "/", mounts: { "115-a": "/115" } });
  assert.equal(copySettingsGap("115-a", rootDefault), "没有目标目录：设置页填的是根 /，等于没填");
  assert.equal(copySettingsGap("115-a", rootDefault, "/hhd/tv"), null, "任务上填了具体目录就行");
  assert.equal(copySettingsGap("115-a", rootDefault, "/"), "没有目标目录：任务上和设置页填的是根 /，等于没填");
  const s = withCopy({ account: "ol", dstDir: "/hhd", mounts: { "115-a": "/115" } });
  assert.equal(copySettingsGap("115-a", s, "/"), null, "任务上的 / 算没填，落回设置页的默认目标目录");
});

test("copyOptionsFor：目标目录填成 / 的不往下传，给出去的都是归一过的", () => {
  const s = withCopy({ account: "ol", dstDir: "/hhd", mounts: { "115-a": "/115" } });
  assert.equal(copyOptionsFor({ account: "115-a", copyToOpenlist: { enabled: true, dstDir: "/" } }, undefined, s).dstDir, undefined);
  assert.equal(copyOptionsFor({ account: "115-a", copyToOpenlist: { enabled: true, dstDir: "/hhd/tv/" } }, undefined, s).dstDir, "/hhd/tv");
  assert.equal(copyOptionsFor({ account: "115-a", copyToOpenlist: { enabled: true, dstDir: "/hhd/tv" } }, true, s, "/").dstDir, "/hhd/tv", "这一次给的 / 不顶掉任务上的");
  const rootDefault = withCopy({ account: "ol", dstDir: "/", mounts: { "115-a": "/115" } });
  const off = copyOptionsFor({ account: "115-a", copyToOpenlist: { enabled: true } }, undefined, rootDefault);
  assert.equal(off.enabled, false);
  assert.match(off.blocked ?? "", /根 \/，等于没填/);
});

test("copyDstProblem：这一次指定成 / 的拒；填成 / 的也不算「只能在它下面选」的范围", () => {
  const s = withCopy({ account: "ol", dstDir: "/hhd", mounts: {} });
  assert.match(copyDstProblem("/", null, s) ?? "", /不能是根 \//);
  assert.equal(copyDstProblem("/hhd/tv", null, s), null);
  const rootDefault = withCopy({ account: "ol", dstDir: "/", mounts: {} });
  assert.match(copyDstProblem("/115/tv", null, rootDefault) ?? "", /都没填/, "设置页填 / 不能让哪儿都成了范围");
  assert.match(copyDstProblem("/115/tv", { copyToOpenlist: { dstDir: "/hhd/tv" } }, rootDefault) ?? "", /只能是 \/hhd\/tv，/);
});

test("引擎选 CloudDrive2：缺什么看 CD2 那一节选的账号，不要 OpenList 账号；resolveCopyConfig 给那个 CD2 账号和它的映射", () => {
  const baseline = listAccounts();
  try {
    replaceAccounts([
      { accountType: "cd2", name: "nas-cd2", url: "http://cd2.local:19798", apiToken: "tok" },
      { accountType: "cd2", name: "half", url: "http://cd2.local:19798" },
      { accountType: "openlist", name: "ol", account: "a", password: "p", url: "http://ol" },
    ]);
    const base = withCopy({ engine: "cd2", dstDir: "/hdd/media" });
    assert.match(copySettingsGap("115-a", base) ?? "", /CloudDrive2 一节还没选 CD2 账号/);
    const ok: AppSettings = { ...base, cd2: { account: "nas-cd2", mounts: { "115-a": "/115/" } } };
    assert.equal(copySettingsGap("115-a", ok), null, "OpenList 账号一个都没选也行");
    assert.match(copySettingsGap("夸克", ok) ?? "", /账号 夸克 还没填「在 CD2 里的路径」/);
    const cfg = resolveCopyConfig(ok);
    assert.equal(cfg.engine, "cd2");
    assert.equal(cfg.account, null);
    assert.deepEqual(cfg.cd2, { accountType: "cd2", name: "nas-cd2", url: "http://cd2.local:19798", apiToken: "tok" });
    assert.deepEqual(cfg.mounts, { "115-a": "/115" }, "映射来自 CD2 那一节，归一过");
    assert.equal(cfg.dstDir, "/hdd/media");

    // 设置上选了、账号表里却用不了的：没选 / 账号删了 / 类型不对 / 缺凭据，各有各的说法
    const pick = (account: string): AppSettings => ({ ...base, cd2: { account, mounts: { "115-a": "/115" } } });
    const why = (s: AppSettings): string => {
      try {
        resolveCopyConfig(s);
        return "";
      } catch (err) {
        return err instanceof HttpError ? err.message : String(err);
      }
    };
    assert.equal(why(base), "「复制」选了 CloudDrive2，但设置页的 CloudDrive2 一节还没选 CD2 账号");
    assert.equal(why(pick("gone")), "CloudDrive2 账号不存在：gone");
    assert.equal(why(pick("ol")), "ol 不是 CloudDrive2 账号");
    assert.equal(why(pick("half")), "CloudDrive2 账号 half 缺少地址或凭据");

    // copyBlockerFor 连账号表一起看：选的 CD2 账号用不了的说出来；没选的话短的那句留给 copySettingsGap
    assert.equal(copyBlockerFor(ok)({ account: "115-a" }), null);
    assert.equal(copyBlockerFor(pick("gone"))({ account: "115-a" }), "CloudDrive2 账号不存在：gone");
    assert.equal(copyBlockerFor(pick("half"))({ account: "115-a" }), "CloudDrive2 账号 half 缺少地址或凭据");
    assert.equal(copyBlockerFor(base)({ account: "115-a" }), "复制选了 CloudDrive2，设置页的 CloudDrive2 一节还没选 CD2 账号");
    // 挂载层账号（OpenList / CD2）的任务用不着复制，两种引擎下都一样
    for (const settings of [ok, withCopy({ account: "ol", dstDir: "/local", mounts: { "nas-cd2": "/x" } })]) {
      assert.match(copyBlockerFor(settings)({ account: "nas-cd2" }) ?? "", /OpenList \/ CloudDrive2 账号的任务用不着复制/);
      assert.match(copyBlockerFor(settings)({ account: "ol" }) ?? "", /OpenList \/ CloudDrive2 账号的任务用不着复制/);
    }
  } finally {
    replaceAccounts(baseline);
  }
  // 没选引擎 = OpenList，照旧要账号
  assert.match(copySettingsGap("115-a", withCopy({ dstDir: "/local" })) ?? "", /还没选 OpenList 账号/);
});
