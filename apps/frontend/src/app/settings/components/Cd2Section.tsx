"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { AccountInfo, Cd2Settings } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TreeSelectDialog } from "@/components/TreeSelectDialog";
import { api } from "@/lib/api";
import { accountLabel, isMountLayerKind } from "@/lib/drive";
import { apiErrorMessage } from "@/lib/axios";

const MOUNT_EXAMPLE: Record<string, string> = { "115": "/115", quark: "/夸克网盘" };
const mountExample = (a: AccountInfo, sameKindCount: number): string => (sameKindCount > 1 ? `/${a.name}` : (MOUNT_EXAMPLE[a.accountType] ?? `/${a.name}`));

type Props = {
  value: Cd2Settings;
  onChange: (next: Cd2Settings) => void;
};

/**
 * 「CloudDrive2」：用哪个 CD2 账号（地址和凭据在账户页）+ 每个网盘账号在 CD2 里的路径。
 * 配齐了，整理 / 转存 / 删源改动网盘之后就让 CD2 刷新改过的目录，经 CD2 挂载回源播放的不用等它的缓存过期；复制引擎选 CD2 时也用这一节。
 * 整块当一个值交给表单（同 OpenlistCopySection）。
 */
export function Cd2Section({ value, onChange }: Props) {
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [browsing, setBrowsing] = useState<{ title: string; onPick: (path: string) => void } | null>(null);

  useEffect(() => {
    api.accounts
      .list()
      .then(setAccounts)
      .catch(() => setFailed(true));
  }, []);

  const set = (patch: Partial<Cd2Settings>) => onChange({ ...value, ...patch });
  const setMount = (account: string, path: string) => {
    const mounts = { ...(value.mounts ?? {}) };
    if (path.trim()) mounts[account] = path.trim();
    else delete mounts[account];
    set({ mounts });
  };

  const cd2Accounts = (accounts ?? []).filter((a) => a.accountType === "cd2");
  /** 要填路径的是网盘账号：挂载层账号（OpenList、CD2 自己）不在这里 */
  const driveAccounts = (accounts ?? []).filter((a) => !isMountLayerKind(a.accountType));
  const cd2Name = (value.account ?? "").trim();
  const cd2Missing = cd2Name !== "" && accounts !== null && !cd2Accounts.some((a) => a.name === cd2Name);
  const usable = cd2Name !== "" && !cd2Missing;
  const mountCount = Object.values(value.mounts ?? {}).filter((v) => v.trim()).length;

  const loadDirs = useCallback((path: string) => (cd2Name ? api.directory.remote(cd2Name, path ? `/${path}` : "/") : Promise.resolve([])), [cd2Name]);

  const check = async () => {
    setChecking(true);
    try {
      const r = await api.cd2.check({ account: cd2Name, mounts: value.mounts ?? {} });
      const lines = [
        `${r.system.ok ? "✓" : "✗"} 地址：${r.system.message}`,
        `${r.auth.ok ? "✓" : "✗"} 凭据：${r.auth.message}`,
        // 读得到令牌的权限表就按用途说（CD2 只给带「令牌管理」权限的令牌读）；读不到才列「获取传输任务」那一下探测
        ...(r.permissions ? [`${r.permissions.ok ? "✓" : "✗"} 权限：${r.permissions.message}`] : r.copy ? [`${r.copy.ok ? "✓" : "✗"} 复制：${r.copy.message}`] : []),
        ...r.mounts.map((m) => `${m.ok ? "✓" : "✗"} ${accountLabel(m.account, driveAccounts.find((a) => a.name === m.account)?.accountType)} → ${m.path}：${m.message}`),
      ];
      // 权限那段不算进整体红绿：只刷新目录的人用不着整理、复制那几项，列出来给人看就行
      const allOk = r.system.ok && r.auth.ok && r.mounts.every((m) => m.ok);
      if (allOk) toast.success(lines.join("；"));
      else toast.error(lines.join("；"));
    } catch (err) {
      toast.error(apiErrorMessage(err, "检查失败"));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section id="cd2" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
      <h2 className="text-base font-medium">CloudDrive2</h2>
      <p className="text-sm text-muted-foreground">
        用 CloudDrive2（CD2）挂载网盘给 Emby 回源的，选上它的账号、填上各网盘在 CD2 里的路径：
        整理 / 转存 / 删源改动网盘之后会让 CD2 刷新改过的目录，挂载里不用等它的缓存过期。两样都有才会动，留空就什么都不做。
        CD2 的地址和凭据在「账户」页的 CloudDrive2 账号上填。
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">CD2 账号</Label>
          <Select value={cd2Name} onValueChange={(v) => v && set({ account: v })} disabled={cd2Accounts.length === 0 && !cd2Missing}>
            <SelectTrigger className="w-full">
              <SelectValue
                placeholder={accounts === null ? (failed ? "账号列表没读出来" : "加载中…") : cd2Accounts.length === 0 ? "还没有 CloudDrive2 账号" : "选择账号"}
              />
            </SelectTrigger>
            <SelectContent>
              {cd2Missing && <SelectItem value={cd2Name}>{cd2Name}（已不存在）</SelectItem>}
              {cd2Accounts.map((a) => (
                <SelectItem key={a.name} value={a.name}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className={cd2Missing ? "text-xs text-warning" : "text-xs text-muted-foreground"}>
            {failed
              ? "账号列表没读出来，刷新页面再试"
              : cd2Missing
                ? `账号「${cd2Name}」已经不在了，或者不是 CloudDrive2 账号：换一个，或者到「账户」页重新添加`
                : accounts !== null && cd2Accounts.length === 0
                  ? "还没有 CloudDrive2 账号，先到「账户」页添加一个"
                  : "刷新目录缓存、当复制引擎都用这个账号；账户页可以有多个 CD2 账号各自建任务，挂载层只用这一个"}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">各个网盘在 CD2 里的路径</h3>
          <p className="text-xs text-muted-foreground">
            CD2 里添加云盘时起的名字就是它的根目录，比如 115 叫 <code>115</code> 就填 <code>/115</code>。
            网盘上的路径拼上它就是 CD2 里的路径；不填的账号不刷新。
          </p>
        </div>
        {failed ? (
          <p className="text-sm text-destructive">账号列表没读出来，刷新页面再试。</p>
        ) : accounts === null ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : driveAccounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有 115 / 夸克账号，先到「账户」页添加。</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {driveAccounts.map((a) => {
              const label = accountLabel(a.name, a.accountType);
              const sameKind = driveAccounts.filter((b) => b.accountType === a.accountType).length;
              return (
                <div key={a.name} className="flex flex-col gap-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
                  <InputGroup>
                    <InputGroupInput value={value.mounts?.[a.name] ?? ""} placeholder={mountExample(a, sameKind)} onChange={(e) => setMount(a.name, e.target.value)} />
                    <InputGroupButton
                      disabled={!usable}
                      title={usable ? "从 CloudDrive2 里选" : "先选 CD2 账号"}
                      onClick={() => setBrowsing({ title: `选择 ${label} 在 CD2 里的路径`, onPick: (p) => setMount(a.name, `/${p}`) })}
                    >
                      <FolderOpen />
                    </InputGroupButton>
                  </InputGroup>
                </div>
              );
            })}
          </div>
        )}
        <Button type="button" variant="outline" size="sm" disabled={!usable || checking} title={usable ? undefined : "先选 CD2 账号"} onClick={() => void check()}>
          {checking ? <Loader2 className="size-4 animate-spin" /> : null}
          检查连接和路径
        </Button>
        {usable && mountCount === 0 && <p className="text-xs text-warning">还没填任何网盘在 CD2 里的路径，不会刷新。</p>}
      </div>

      {browsing && (
        <TreeSelectDialog
          open
          onOpenChange={(o) => !o && setBrowsing(null)}
          title={browsing.title}
          description={<>从 CloudDrive2 账号 {cd2Name} 的根目录里选</>}
          load={loadDirs}
          onConfirm={(path) => {
            browsing.onPick(path);
            setBrowsing(null);
          }}
        />
      )}
    </section>
  );
}
