import type { Cd2Settings, CopyAfterCopy, OpenlistCopySettings, TaskCopySettings } from "@openstrm/shared";

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
 */
export function copyGapInDialog(
  cfg: OpenlistCopySettings,
  account: string,
  taskDstDir: string | undefined,
  accounts: Array<{ name: string; accountType: string }>,
  cd2?: Cd2Settings,
): string | null {
  if (cfg.engine === "cd2") {
    // 引擎是 CloudDrive2：用哪个 CD2 账号和映射都看设置页 CloudDrive2 那一节
    const cd2Name = (cd2?.account ?? "").trim();
    if (!cd2Name) return "复制选了 CloudDrive2，设置页的 CloudDrive2 一节还没选 CD2 账号，开着也不会复制";
    if (accounts.length > 0 && !accounts.some((a) => a.name === cd2Name && a.accountType === "cd2")) {
      return `设置页选的 CD2 账号「${cd2Name}」已经不在了，开着也不会复制`;
    }
    if (!cd2?.mounts?.[account]?.trim()) return `账号 ${account} 还没在设置页 CloudDrive2 一节填「在 CD2 里的路径」，开着也不会复制`;
  } else {
    if (!cfg.account) return "设置页还没选 OpenList 账号，开着也不会复制";
    if (accounts.length > 0 && !accounts.some((a) => a.name === cfg.account && a.accountType === "openlist")) {
      return `设置页选的 OpenList 账号「${cfg.account}」已经不在了，开着也不会复制`;
    }
    if (!cfg.mounts?.[account]?.trim()) return `账号 ${account} 还没在设置页填「在 OpenList 里的挂载根」，开着也不会复制`;
  }
  if (!normTargetDir(taskDstDir) && !normTargetDir(cfg.dstDir)) {
    // 下面的「复制到哪」填成 / 的由那一栏自己报错；这里只替设置页那个说清楚 / 不算
    return isOpenlistRootInput(cfg.dstDir) && !isOpenlistRootInput(taskDstDir)
      ? "没有目标目录：设置页的默认目标目录填的是根 /，等于没填。在下面的「复制到哪」里填一个，或者到设置页改掉"
      : "没有目标目录：在下面的「复制到哪」里填一个，或者到设置页填默认目标目录";
  }
  return null;
}
