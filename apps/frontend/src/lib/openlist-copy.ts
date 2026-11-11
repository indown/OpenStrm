import type { Cd2Settings, CopyAfterCopy, CopyEngine, OpenlistCopySettings, TaskCopySettings } from "@openstrm/shared";
import { LAYER_META, layerAccountStatus } from "./mount-layer";

/**
 * 任务根下不进媒体库的暂存区：整理挪重复文件的「重复文件」、复制后归档的「归档」。
 * 名字和后端 services/organize/duplicates.ts 一样（改名时两边一起动）；新建复制不给选它们，后端也不许拿它们当源
 */
export const STAGING_DIRS: readonly string[] = ["重复文件", "归档"];

/** 目标目录填成 OpenList 根时的说法（和后端 OPENLIST_ROOT_TARGET 一样） */
export const OPENLIST_ROOT_TARGET = "目标目录不能是根 /：根上没有存储，复制不进去。填一个具体的目录，比如 /local/downloads";

/**
 * 复制的目标目录（设置页的默认值、任务上的、这一次选的）：去空白、收斜杠、去尾斜杠、补头斜杠；
 * 空的和 OpenList 根 `/` 都还空串——根上没有存储，复制不进去，算没填。
 * 和后端 services/copy/paths.ts 的 normTargetDir 一样（改规则时两边一起动）；挂载根不走这个，存储可以挂在 / 上
 */
export function normTargetDir(p?: string): string {
  const t = (p ?? "").trim().replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return t ? (t.startsWith("/") ? t : `/${t}`) : "";
}

/** 填了东西、归一后却是 OpenList 根（`/`、`//` 这种）：设置页、任务上都不收 */
export function isOpenlistRootInput(p?: string): boolean {
  return Boolean(p?.trim()) && !normTargetDir(p);
}

/** 复制引擎的叫法（和后端 copyEngineLabel 一样）：就是那一家挂载层的全名 */
export const COPY_ENGINE_LABEL: Record<CopyEngine, string> = { openlist: LAYER_META.openlist.title, cd2: LAYER_META.cd2.title };

/** 复制用的那一家挂载层：引擎、设置页「网盘挂载」里给它选的账号名、各网盘账号在它里面的路径 */
export type CopyLayer = { engine: CopyEngine; account: string; mounts: Record<string, string> };

/**
 * 复制用的是哪一家：引擎是 CloudDrive2 就看 cd2 那一份，不然看 openlistCopy 里 OpenList 的那部分。
 * 和后端 services/copy/paths.ts 的 resolveCopyConfig 同一个口径（改的时候两边一起动）。
 * 浏览复制目标目录、判断复制入口给不给都看它——直接读 openlistCopy.account 的话，引擎选了 CD2 的人会被当成没配好
 */
export function copyLayer(cfg: OpenlistCopySettings | undefined, cd2: Cd2Settings | undefined): CopyLayer {
  return cfg?.engine === "cd2"
    ? { engine: "cd2", account: (cd2?.account ?? "").trim(), mounts: cd2?.mounts ?? {} }
    : { engine: "openlist", account: (cfg?.account ?? "").trim(), mounts: cfg?.mounts ?? {} };
}

/**
 * 发得起复制：那一家选了账号、而且这个账号还在账户页里（删了、换了类型的不算）、至少一个网盘填了路径（目标目录可以只在任务上填）。
 * accounts 是 null（没读到）时只看设置：读账号失败不该把复制入口全藏起来，真提交时后端还会再核对
 */
export function copyLayerUsable(layer: CopyLayer, accounts: ReadonlyArray<{ name: string; accountType: string }> | null): boolean {
  return layerAccountStatus(accounts, layer.engine, layer.account).usable && Object.values(layer.mounts).some((m) => Boolean(m?.trim()));
}

/** 复制成功后源文件去向的叫法（任务弹框、队列面板、新建复制弹框共用） */
export const AFTER_COPY_LABEL: Record<CopyAfterCopy, string> = { keep: "不动", delete: "删除", archive: "归档" };

/** 任务上复制成功后源文件怎么办；任务没开复制就是不动。后端读写时已经把老字段归一成 afterCopy，这里只认它 */
export function taskAfterCopy(cfg: TaskCopySettings | undefined): CopyAfterCopy {
  return cfg?.enabled ? (cfg.afterCopy ?? "keep") : "keep";
}

/**
 * 任务弹框里「开着复制却复制不了」卡在哪，null = 设置上齐了。
 *
 * 条件和顺序跟后端 services/copy/paths.ts 的 copySettingsGap 一样（改条件时两边一起动），
 * 说法是给弹框的：目标目录那条就在弹框里能补上。保存过的任务不用这个——
 * 任务列表接口直接带着后端算好的 copyBlocked。
 * accounts 是空的（还在读 / 读失败）就不查 OpenList / CD2 账号在不在，免得误报。
 * 用哪一家、选的账号、各网盘的路径都经 copyLayer 取，账号在不在用 layerAccountStatus，和设置页两节一个口径。
 */
export function copyGapInDialog(
  cfg: OpenlistCopySettings,
  account: string,
  taskDstDir: string | undefined,
  accounts: Array<{ name: string; accountType: string }>,
  cd2?: Cd2Settings,
): string | null {
  const layer = copyLayer(cfg, cd2);
  const meta = LAYER_META[layer.engine];
  if (!layer.account) {
    // 引擎没选（默认 OpenList）的不提「复制选了谁」
    return layer.engine === "cd2"
      ? `复制选了 ${meta.title}，设置页「网盘挂载」里还没选 ${meta.title} 账号，开着也不会复制`
      : `设置页「网盘挂载」里还没选 ${meta.title} 账号，开着也不会复制`;
  }
  if (layerAccountStatus(accounts.length > 0 ? accounts : null, layer.engine, layer.account).missing) {
    return `设置页「网盘挂载」里选的 ${meta.short} 账号「${layer.account}」已经不在了，开着也不会复制`;
  }
  if (!layer.mounts[account]?.trim()) {
    return `账号 ${account} 还没在设置页「网盘挂载」里填「在 ${meta.short} 里的${meta.field}」，开着也不会复制`;
  }
  if (!normTargetDir(taskDstDir) && !normTargetDir(cfg.dstDir)) {
    // 下面的「复制到哪」填成 / 的由那一栏自己报错；这里只替设置页那个说清楚 / 不算
    return isOpenlistRootInput(cfg.dstDir) && !isOpenlistRootInput(taskDstDir)
      ? "没有目标目录：设置页「复制」里的默认目标目录填的是根 /，等于没填。在下面的「复制到哪」里填一个，或者到设置页改掉"
      : "没有目标目录：在下面的「复制到哪」里填一个，或者到设置页「复制」里填默认目标目录";
  }
  return null;
}
