"use client";

import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** 清单里最多列这么多条，剩下的只说个数 */
export const DELETE_LIST_MAX = 5;

/** 页面级的删除确认：五个入口（选择栏 / 行 / 详情 / 体检 / 校验）共用这一个 */
export function DeleteStrmDialog({
  target,
  deleting,
  onCancel,
  onConfirm,
}: {
  /** label 是标题里那半句（「所选 3 项」）；paths 是清单的前几条，写成给人看的路径；count 是一共几项。null = 关着 */
  target: { label: string; paths: string[]; count: number } | null;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={target != null} onOpenChange={(open) => !open && !deleting && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">删除{target?.label}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>会从本地目录里删除（目录连同里面的内容一起删），网盘里的文件不受影响。</p>
              <ul className="space-y-0.5 font-mono text-xs text-foreground">
                {(target?.paths ?? []).map((p) => (
                  <li key={p} className="break-all">
                    {p}
                  </li>
                ))}
                {target && target.count > target.paths.length && <li className="text-muted-foreground">…等 {target.count} 项</li>}
              </ul>
              <p className="font-medium text-destructive">此操作无法撤销。</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={deleting}
          >
            {deleting ? <Loader2 className="size-4 animate-spin" /> : "删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
