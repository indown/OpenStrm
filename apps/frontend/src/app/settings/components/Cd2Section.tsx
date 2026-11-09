"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { AccountInfo, Cd2Settings } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { accountLabel } from "@/lib/drive";
import { apiErrorMessage } from "@/lib/axios";

/** CD2 之外的网盘账号才需要映射（OpenList 账号是另一个挂载层，不在这里） */
const isDriveAccount = (a: AccountInfo): boolean => a.accountType !== "openlist";

const MOUNT_EXAMPLE: Record<string, string> = { "115": "/115", quark: "/夸克网盘" };
const mountExample = (a: AccountInfo, sameKindCount: number): string => (sameKindCount > 1 ? `/${a.name}` : (MOUNT_EXAMPLE[a.accountType] ?? `/${a.name}`));

type Props = {
  value: Cd2Settings;
  onChange: (next: Cd2Settings) => void;
};

/**
 * 「CloudDrive2」：地址 + 凭据（API 令牌或用户名口令）+ 每个网盘账号在 CD2 里的路径。
 * 配齐了，整理 / 转存 / 删源改动网盘之后就让 CD2 刷新改过的目录，经 CD2 挂载回源播放的不用等它的缓存过期。
 * 整块当一个值交给表单（同 OpenlistCopySection）。
 */
export function Cd2Section({ value, onChange }: Props) {
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);

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

  const driveAccounts = (accounts ?? []).filter(isDriveAccount);
  const url = (value.url ?? "").trim();
  const hasCredential = Boolean((value.apiToken ?? "").trim() || ((value.username ?? "").trim() && value.password));
  const mountCount = Object.values(value.mounts ?? {}).filter((v) => v.trim()).length;
  const configured = Boolean(url) && hasCredential && mountCount > 0;

  const check = async () => {
    setChecking(true);
    try {
      const r = await api.cd2.check({ url, apiToken: value.apiToken ?? "", username: value.username ?? "", password: value.password ?? "", mounts: value.mounts ?? {} });
      const lines = [
        `${r.system.ok ? "✓" : "✗"} 地址：${r.system.message}`,
        `${r.auth.ok ? "✓" : "✗"} 凭据：${r.auth.message}`,
        ...(r.copy ? [`${r.copy.ok ? "✓" : "✗"} 复制：${r.copy.message}`] : []),
        ...r.mounts.map((m) => `${m.ok ? "✓" : "✗"} ${accountLabel(m.account, driveAccounts.find((a) => a.name === m.account)?.accountType)} → ${m.path}：${m.message}`),
      ];
      // 复制那段只有复制引擎选了 CD2 才要紧，不算进整体红绿，只在 toast 里列出来
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
        用 CloudDrive2（CD2）挂载网盘给 Emby 回源的，填上它的地址、凭据和各网盘在 CD2 里的路径：
        整理 / 转存 / 删源改动网盘之后会让 CD2 刷新改过的目录，挂载里不用等它的缓存过期。三样都填了才会动，留空就什么都不做。
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">CD2 地址</Label>
          <Input value={value.url ?? ""} placeholder="http://192.168.1.10:19798" onChange={(e) => set({ url: e.target.value })} />
          <p className="text-xs text-muted-foreground">和 CD2 网页同一个端口，默认 19798</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">API 令牌</Label>
          <Input value={value.apiToken ?? ""} placeholder="CD2 设置页「API 令牌」里生成" autoComplete="off" onChange={(e) => set({ apiToken: e.target.value })} />
          <p className="text-xs text-muted-foreground">推荐。填了令牌就不用下面的用户名口令；开了两步验证的账号只能用令牌。权限至少勾「读」；复制引擎选 CD2 的话还要「复制」和「查看传输任务」</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">用户名</Label>
          <Input value={value.username ?? ""} placeholder="登录 CD2 的账号" autoComplete="off" onChange={(e) => set({ username: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">口令</Label>
          <Input type="password" value={value.password ?? ""} placeholder="没有令牌时和用户名一起填" autoComplete="new-password" onChange={(e) => set({ password: e.target.value })} />
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
                  <Input value={value.mounts?.[a.name] ?? ""} placeholder={mountExample(a, sameKind)} onChange={(e) => setMount(a.name, e.target.value)} />
                </div>
              );
            })}
          </div>
        )}
        <Button type="button" variant="outline" size="sm" disabled={!url || checking} title={url ? undefined : "先填地址"} onClick={() => void check()}>
          {checking ? <Loader2 className="size-4 animate-spin" /> : null}
          检查连接和路径
        </Button>
        {url && !configured && (
          <p className="text-xs text-warning">{!hasCredential ? "还缺凭据：API 令牌，或用户名加口令。" : "还没填任何网盘在 CD2 里的路径，不会刷新。"}</p>
        )}
      </div>
    </section>
  );
}
