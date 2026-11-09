/**
 * 测试里换掉真挂载层（OpenList / CD2）：记下让它刷了哪些目录（已换算成挂载层路径），能按目录造错、卡住。
 */
import type { MountCacheTarget } from "../services/mount-cache/refresh.js";

export function fakeMountTarget(opts: {
  name?: string;
  /** 网盘账号名 → 挂载根；null = 没配这个挂载层 */
  mounts: Record<string, string> | null;
  /** 刷过的目录按顺序记在这里 */
  listed: string[];
  /** 给某个目录造个错 */
  fail?: (dir: string) => Error | undefined;
  /** 某个目录刷到一半先卡住（模拟上一批还在跑） */
  gate?: (dir: string) => Promise<void> | undefined;
  isMissing?: (err: unknown) => boolean;
  isMisconfigured?: (err: unknown) => boolean;
}): MountCacheTarget {
  return {
    name: opts.name ?? "FakeMount",
    prepare: () =>
      opts.mounts
        ? {
            mounts: opts.mounts,
            refresh: async (dir) => {
              opts.listed.push(dir);
              await opts.gate?.(dir);
              const err = opts.fail?.(dir);
              if (err) throw err;
            },
          }
        : null,
    isMissing: opts.isMissing ?? ((err) => err instanceof Error && /not found/i.test(err.message)),
    ...(opts.isMisconfigured ? { isMisconfigured: opts.isMisconfigured } : {}),
  };
}
