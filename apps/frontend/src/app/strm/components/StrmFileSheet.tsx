"use client";

import { Fragment, useEffect, useState } from "react";
import { FileCog, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { StrmFileInfo } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusBadge } from "@/components/status-badge";
import { MediaFlags } from "@/components/media-flags";
import { Spinner } from "@/components/loading";
import { api } from "@/lib/api";
import { briefDetails, flagsFromBrief } from "@/lib/media-flags";
import { PARSE_REASON_LABEL, baseName, parentOf, strmErrorMessage, type RequestDelete } from "@/lib/strm";

type Props = {
  taskId: string;
  /** null = 关着 */
  path: string | null;
  onOpenChange: (open: boolean) => void;
  onDelete: RequestDelete;
  onDeleted: (path: string) => void;
};

/** 内容和任务配置对不上但还能算出应有内容的，才允许重写 */
const rewritableOf = (info: StrmFileInfo) => !info.reason || info.reason === "prefix-mismatch";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

/** 一个 strm 的详情：内容、解析出的网盘路径、和任务配置比对的结果；右侧抽屉，手机全宽 */
export function StrmFileSheet({ taskId, path, onOpenChange, onDelete, onDeleted }: Props) {
  const open = path != null;
  const [info, setInfo] = useState<StrmFileInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // 重写之后要重新读一遍
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open || !path || !taskId) return;
    let cancelled = false;
    setInfo(null);
    setError(null);
    setLoading(true);
    api.strm
      .file(taskId, path)
      .then((res) => {
        if (!cancelled) setInfo(res);
      })
      .catch((err) => {
        if (!cancelled) setError(strmErrorMessage(err, "读取 strm 失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, path, taskId, reloadKey]);

  const verify = async () => {
    if (!path) return;
    setVerifying(true);
    try {
      const res = await api.strm.verify(taskId, path);
      if (res.errors.length > 0) toast.error(`没能确认：${res.errors[0].message}`);
      else if (res.unparsable.length > 0) toast.warning(`无法解析出网盘路径：${PARSE_REASON_LABEL[res.unparsable[0].reason]}`);
      else if (res.missing.length > 0) toast.warning(res.note ? `网盘上找不到这个文件；${res.note}` : "网盘上找不到这个文件");
      else toast.success("网盘上还在");
    } catch (err) {
      toast.error(strmErrorMessage(err, "校验失败"));
    } finally {
      setVerifying(false);
    }
  };

  const rewrite = async () => {
    if (!path) return;
    setRewriting(true);
    try {
      const res = await api.strm.rewrite(taskId, path, false);
      if (res.changed > 0) toast.success("已重写为应有内容");
      else if (res.unparsable.length > 0) toast.warning(`没有重写：${PARSE_REASON_LABEL[res.unparsable[0].reason]}`);
      else toast.info("内容已经是最新的，没有改动");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast.error(strmErrorMessage(err, "重写失败"));
    } finally {
      setRewriting(false);
    }
  };

  const remove = async () => {
    if (!path) return;
    setDeleting(true);
    try {
      const res = await onDelete([path], `「${baseName(path)}」`);
      if (res && res.deleted > 0) onDeleted(path);
    } finally {
      setDeleting(false);
    }
  };

  const rewritable = info ? rewritableOf(info) : false;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="break-all pr-6">{path ? baseName(path) : ""}</SheetTitle>
          <SheetDescription className="break-all">{path ? parentOf(path) || "根目录" : ""}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          {loading ? (
            <Spinner label="正在读取…" />
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            info && (
              <>
                <Field label="状态">
                  {info.matches ? (
                    <StatusBadge tone="success">内容正确</StatusBadge>
                  ) : rewritable ? (
                    <StatusBadge tone="warning">与当前配置不一致</StatusBadge>
                  ) : (
                    <StatusBadge tone="danger">无法解析</StatusBadge>
                  )}
                </Field>
                <Field label="本地路径">
                  <p className="break-all font-mono text-xs">{info.path}</p>
                </Field>
                <Field label="文件内容">
                  <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">{info.content || "（空文件）"}</pre>
                </Field>
                <Field label="解析出的网盘路径">
                  {info.actualRemotePath ? (
                    <p className="break-all font-mono text-xs">{info.actualRemotePath}</p>
                  ) : (
                    <p className="text-xs text-destructive">
                      无法解析{info.reason ? `：${PARSE_REASON_LABEL[info.reason]}` : ""}
                    </p>
                  )}
                </Field>
                <Field label="媒体信息">
                  {info.media ? (
                    <div className="space-y-1.5">
                      <MediaFlags grouped flags={flagsFromBrief(info.media)} />
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                        {briefDetails(info.media).map((d) => (
                          <Fragment key={d.label}>
                            <dt className="text-muted-foreground">{d.label}</dt>
                            <dd className="break-all">{d.value}</dd>
                          </Fragment>
                        ))}
                      </dl>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">还没有这个文件的探测信息：到整理页按作品点「探测编码」，或者等 Emby 播放过后回填。</p>
                  )}
                </Field>
                {!info.matches && (
                  <Field label="按任务当前配置应有的内容">
                    {info.expectedContent ? (
                      <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">{info.expectedContent}</pre>
                    ) : (
                      <p className="text-xs text-muted-foreground">算不出：从现有内容里拿不到网盘文件的扩展名。</p>
                    )}
                    {info.reason && info.reason !== "prefix-mismatch" && (
                      <p className="text-xs text-muted-foreground">
                        {PARSE_REASON_LABEL[info.reason]}，不会自动重写；可以删掉后用「重新生成」按网盘目录重建。
                      </p>
                    )}
                  </Field>
                )}
              </>
            )
          )}
        </div>
        <SheetFooter className="flex-row flex-wrap gap-2 border-t">
          <Button variant="outline" onClick={() => void verify()} disabled={!info || verifying}>
            {verifying ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            校验此文件
          </Button>
          <Button onClick={() => void rewrite()} disabled={!info || info.matches || !rewritable || rewriting}>
            {rewriting ? <Loader2 className="size-4 animate-spin" /> : <FileCog className="size-4" />}
            重写为应有内容
          </Button>
          <Button variant="destructive" onClick={() => void remove()} disabled={deleting || !path}>
            {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            删除
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
