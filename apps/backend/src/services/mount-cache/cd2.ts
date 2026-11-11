/**
 * CloudDrive2 这个挂载层：用哪个 CD2 账号、挂载映射来自设置页「网盘挂载」里的 CloudDrive2，刷新就是 GetSubFiles 带 forceRefresh。
 */
import { cd2RefreshDir, isCd2Missing } from "../cd2/client.js";
import { cd2ConfigIfReady } from "../cd2/config.js";
import type { MountCacheTarget } from "./refresh.js";

export const cd2MountCacheTarget: MountCacheTarget = {
  name: "CloudDrive2",
  prepare: () => {
    const cfg = cd2ConfigIfReady();
    if (!cfg) return null;
    return {
      mounts: cfg.mounts,
      refresh: async (dir) => {
        await cd2RefreshDir(cfg.conn, dir);
      },
    };
  },
  isMissing: isCd2Missing,
};
