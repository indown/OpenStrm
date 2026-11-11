"use client";

import { useCallback } from "react";
import { TreeSelectDialog } from "@/components/TreeSelectDialog";
import { api } from "@/lib/api";
import { apiErrorMessage, apiErrorStatus } from "@/lib/axios";

/**
 * 「网盘挂载」「复制」两节共用的两样：在挂载层账号（OpenList / CD2）里打不打得开一个路径、从它的根目录起选目录。
 * 两节都经通用的目录浏览接口走，两家同一套；以前各写一份，修了一边另一边就落下
 */

/** 这个账号里打不打得开 path：null = 打得开，不然是打不开的原因 */
export async function openProblem(account: string, path: string): Promise<string | null> {
  try {
    await api.directory.remote(account, path);
    return null;
  } catch (err) {
    return apiErrorMessage(err, "打不开");
  }
}

/**
 * 网盘账号自己（不经挂载层）这个目录在不在：no 是接口回 404（目录不存在）；
 * unknown 是别的错（cookie 过期、连不上、不是目录），分不出在不在
 */
export async function driveDirState(account: string, path: string): Promise<"yes" | "no" | "unknown"> {
  try {
    await api.directory.remote(account, path);
    return "yes";
  } catch (err) {
    return apiErrorStatus(err) === 404 ? "no" : "unknown";
  }
}

/** 从挂载层账号的根目录起选一个目录；选中的是不带开头斜杠的相对路径 */
export function LayerDirPicker({
  title,
  layerTitle,
  account,
  onPick,
  onClose,
}: {
  title: string;
  /** 「OpenList」/「CloudDrive2」 */
  layerTitle: string;
  account: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  // TreeSelectDialog 的 load 一换就重拉根目录：设置页每改一个字段都整页重渲染，这里不稳住的话弹框开着也会一直重列
  const load = useCallback((path: string) => api.directory.remote(account, path ? `/${path}` : "/"), [account]);
  return (
    <TreeSelectDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={
        <>
          从 {layerTitle} 账号 {account} 的根目录里选
        </>
      }
      load={load}
      onConfirm={(path) => {
        onPick(path);
        onClose();
      }}
    />
  );
}
