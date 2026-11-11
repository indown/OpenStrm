/**
 * OpenList 这个挂载层：账号和挂载根来自设置页「网盘挂载」里的 OpenList（存在 openlistCopy 里，和复制引擎选谁无关），刷新就是 /api/fs/list 带 refresh:true
 * （绕过缓存问上游，结果写回缓存；client.ts 文件头记着）。
 */
import { openlistMountConfigIfReady } from "../copy/paths.js";
import { isOpenlistMissing, isOpenlistStorageMissing, openlistListDir } from "../openlist/client.js";
import type { MountCacheTarget } from "./refresh.js";

export const openlistMountCacheTarget: MountCacheTarget = {
  name: "OpenList",
  prepare: () => {
    const cfg = openlistMountConfigIfReady();
    if (!cfg) return null;
    return {
      mounts: cfg.mounts,
      refresh: async (dir) => {
        await openlistListDir(cfg.account, dir, { refresh: true });
      },
    };
  },
  isMissing: isOpenlistMissing,
  isMisconfigured: isOpenlistStorageMissing,
};
