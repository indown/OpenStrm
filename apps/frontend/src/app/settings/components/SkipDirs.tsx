"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { AccountInfo, OrganizeSkip } from "@openstrm/shared";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { accountLabel } from "@/lib/drive";
import { fmtTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** 不整理的目录清单：改了立刻生效（不走设置页的保存条）；整理页作品卡片「…」里加的也在这里 */
export function SkipDirs() {
  const [skips, setSkips] = useState<OrganizeSkip[] | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [account, setAccount] = useState("");
  const [path, setPath] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="space-y-2">
      <Label>不整理的目录</Label>
      <p className="text-xs text-muted-foreground">
        预览时这些目录下的东西不当作品扫：手工整理过的、不想动的目录放这里；整理页作品卡片的「…」里也能加。改了立刻生效，不用点保存。
      </p>
      {skips === null ? (
        <p className="text-xs text-muted-foreground">读取中…</p>
      ) : skips.length === 0 ? (
        <p className="text-xs text-muted-foreground">还没有。</p>
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
        <div className="w-full space-y-1 sm:w-44">
          <Label className="text-xs text-muted-foreground">账号</Label>
          <Select value={account} onValueChange={setAccount} disabled={accounts.length === 0}>
            <SelectTrigger className="h-8 w-full text-xs">
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
        <div className="min-w-0 flex-1 space-y-1">
          <Label className="text-xs text-muted-foreground">网盘目录（绝对路径）</Label>
          <Input className="h-8 font-mono text-xs" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/tv/旧剧" onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void add()} />
        </div>
        <div className="w-full space-y-1 sm:w-48">
          <Label className="text-xs text-muted-foreground">备注（可不填）</Label>
          <Input className="h-8 text-xs" value={note} onChange={(e) => setNote(e.target.value)} placeholder="手工整理过" />
        </div>
        <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => void add()} disabled={busy || !account || !path.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : "添加"}
        </Button>
      </div>
    </div>
  );
}
