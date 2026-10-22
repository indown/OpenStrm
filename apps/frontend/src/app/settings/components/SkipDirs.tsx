"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { AccountInfo, OrganizeSkip } from "@openstrm/shared";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { accountLabel } from "@/lib/drive";
import { fmtTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TreeSelectDialog } from "@/components/TreeSelectDialog";

/** 不整理的目录清单：改了立刻生效（不走设置页的保存条）；整理页作品卡片「…」里加的也在这里 */
export function SkipDirs() {
  const [skips, setSkips] = useState<OrganizeSkip[] | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [account, setAccount] = useState("");
  const [path, setPath] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);

  const load = useCallback(
    () =>
      api.organize
        .skips()
        .then((r) => setSkips(r.skips))
        .catch((err) => toast.error(apiErrorMessage(err, "读取不整理的目录失败"))),
    [],
  );
  useEffect(() => {
    void load();
    api.accounts
      .list()
      .then((list) => {
        setAccounts(list);
        setAccount((a) => a || list[0]?.name || "");
      })
      .catch(() => {});
  }, [load]);

  const add = async () => {
    if (!account || !path.trim()) return;
    setBusy(true);
    try {
      await api.organize.addSkip({ accountName: account, path: path.trim(), note: note.trim() });
      setPath("");
      setNote("");
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, "没加进去"));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (s: OrganizeSkip) => {
    setBusy(true);
    try {
      await api.organize.removeSkip(s.accountName, s.path);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, "删不掉"));
    } finally {
      setBusy(false);
    }
  };
  const label = (name: string) => {
    const a = accounts.find((x) => x.name === name);
    return a ? accountLabel(a.name, a.accountType) : name;
  };
  // TreeSelectDialog 打开时按 load 拉根目录：要稳定，不然每次渲染都重拉
  const browse = useCallback((p: string) => api.directory.remote(account, p), [account]);

  return (
    <div className="space-y-2">
      <Label>不整理的目录</Label>
      <p className="text-xs text-muted-foreground">
        预览时这些目录下的东西不当作品扫：手工整理过的、不想动的目录放这里；整理页作品卡片的「…」里也能加。改了立刻生效，不用点保存。
      </p>
      {skips === null ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">读取中…</p>
      ) : skips.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">还没有不整理的目录。</p>
      ) : (
        <ul className="divide-y rounded-md border text-xs">
          {skips.map((s) => (
            <li key={`${s.accountName}:${s.path}`} className="flex items-start gap-2 px-3 py-2">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="break-all font-mono">{s.path}</div>
                <div className="text-muted-foreground">
                  {label(s.accountName)}
                  {s.note ? ` · ${s.note}` : ""} · {fmtTime(s.createdAt * 1000)}
                </div>
              </div>
              <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-destructive hover:text-destructive" onClick={() => void remove(s)} disabled={busy} aria-label={`不再跳过 ${s.path}`}>
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex w-full flex-col gap-1 sm:w-44">
          <Label className="text-xs font-medium text-muted-foreground">账号</Label>
          {/* 空值不收：账号列表和选中值同一批写进去时，Radix 隐藏的原生 select 还没有这个 option，会先回一次 ""，把自动选中的第一个账号冲掉 */}
          <Select value={account} onValueChange={(v) => v && setAccount(v)} disabled={accounts.length === 0}>
            {/* size="sm" 才是 32px：className 里的 h-8 压不过 data-[size=default]:h-9，三个控件会差一截 */}
            <SelectTrigger size="sm" className="w-full text-xs">
              <SelectValue placeholder={accounts.length === 0 ? "还没有账号" : "选账号"} />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.name} value={a.name}>
                  {accountLabel(a.name, a.accountType)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Label className="text-xs font-medium text-muted-foreground">网盘目录（绝对路径）</Label>
          <InputGroup className="h-8">
            <InputGroupInput className="font-mono text-xs md:text-xs" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/tv/旧剧" onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void add()} />
            <InputGroupButton onClick={() => setBrowseOpen(true)} disabled={!account} title={account ? "从网盘里选目录" : "先选账号"} aria-label="从网盘里选目录">
              <FolderOpen />
            </InputGroupButton>
          </InputGroup>
        </div>
        <div className="flex w-full flex-col gap-1 sm:w-48">
          <Label className="text-xs font-medium text-muted-foreground">备注（可不填）</Label>
          <Input className="h-8 text-xs md:text-xs" value={note} onChange={(e) => setNote(e.target.value)} placeholder="手工整理过" />
        </div>
        <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => void add()} disabled={busy || !account || !path.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : "添加"}
        </Button>
      </div>
      {account && (
        <TreeSelectDialog
          open={browseOpen}
          onOpenChange={setBrowseOpen}
          title="选不整理的目录"
          description={<>从 {label(account)} 的根目录起选一个目录；选中的填成绝对路径</>}
          load={browse}
          onConfirm={(p) => setPath(`/${p}`)}
        />
      )}
    </div>
  );
}
