/**
 * OpenList 这个挂载层：账号和挂载根复用「复制到 OpenList」那一节的（和复制引擎选谁无关），刷新就是 /api/fs/list 带 refresh:true
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
