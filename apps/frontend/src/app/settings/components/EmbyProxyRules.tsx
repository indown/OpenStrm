"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { AccountInfo } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FieldHint } from "@/components/field-hint";
import { api } from "@/lib/api";

/** 表单里的一行路径映射：三个字段都是字符串，空串 = 没填（提交时再去掉） */
export type PathMappingRow = { from: string; account: string; to: string };

/** 表单里的一条路由规则：条件全是字符串，remote 用空串表示「任意」 */
export type RouteRuleRow = {
  action: "redirect" | "relay";
  note: string;
  userAgent: string;
  client: string;
  deviceName: string;
  deviceId: string;
  path: string;
  remote: "" | "lan" | "wan";
};

const EMPTY_RULE: RouteRuleRow = { action: "relay", note: "", userAgent: "", client: "", deviceName: "", deviceId: "", path: "", remote: "" };

/** 115 账号：路径映射只能指向 115——夸克取文件要带 Cookie，302 不了；OpenList 也不走 302 */
function useAccounts115() {
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.accounts
      .list()
      .then((list) => setAccounts(list.filter((a) => a.accountType === "115")))
      .catch(() => setFailed(true));
  }, []);
  return { accounts, failed };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** 一条规则的外壳：序号 + 上下移 / 删除，正文由调用方给 */
function RuleRow({
  index,
  total,
  onRemove,
  onMove,
  children,
}: {
  index: number;
  total: number;
  onRemove: () => void;
  /** 不给就不显示上下移（路径映射不分先后：按最长前缀匹配） */
  onMove?: (delta: -1 | 1) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">第 {index + 1} 条</span>
        <div className="flex items-center gap-1">
          {onMove && (
            <>
              <Button type="button" variant="ghost" size="icon" className="size-7" disabled={index === 0} title="上移" onClick={() => onMove(-1)}>
                <ArrowUp className="size-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="size-7" disabled={index === total - 1} title="下移" onClick={() => onMove(1)}>
                <ArrowDown className="size-3.5" />
              </Button>
            </>
          )}
          <Button type="button" variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" title="删除这条" onClick={onRemove}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      {children}
    </div>
  );
}

type EditorProps<T> = { value: T[]; onChange: (next: T[]) => void };

/**
 * 302 代理的路径映射：Emby 看到的路径前缀 → 哪个 115 账号的哪个目录。
 * 任务推得出来的不用填，这张表是给任务推不出来的那部分路径准备的。
 */
export function PathMappingsEditor({ value, onChange }: EditorProps<PathMappingRow>) {
  const { accounts, failed } = useAccounts115();
  const update = (i: number, patch: Partial<PathMappingRow>) => onChange(value.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  // 只有一个 115 账号时直接选上，少点一下
  const add = () => onChange([...value, { from: "", account: accounts?.length === 1 ? accounts[0].name : "", to: "" }]);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          路径映射
          <FieldHint label="路径映射怎么填">
            代理拿到播放请求后，先按 Emby 报上来的路径（也就是 strm 里写的那个）找出文件在哪个网盘账号的哪个目录，再去换直链。
            开了 302 的任务自己就能推出这层关系：strm 前缀 + 网盘目录。这张表只给任务推不出来的用——别的工具生成的 strm，
            或者挂载结构不是「一个前缀对一个目录」的。多条映射取最长的前缀；手填的优先于任务推出来的。
            例：前缀 <code>/mnt/115/主号/电影</code>、账号「主号」、网盘目录 <code>/视频/电影</code>，
            那 <code>/mnt/115/主号/电影/a.mkv</code> 就到主号盘里找 <code>/视频/电影/a.mkv</code>。
          </FieldHint>
        </h3>
        <p className="text-xs text-muted-foreground">开了 302 的任务不用填。只填任务推不出来的：别的工具生成的 strm、挂载结构不是「一个前缀对一个目录」的。</p>
      </div>
      {failed && <p className="text-xs text-destructive">账号列表没读出来，刷新页面再试。</p>}
      {value.map((row, i) => {
        const missing = row.account !== "" && accounts !== null && !accounts.some((a) => a.name === row.account);
        return (
          <RuleRow key={i} index={i} total={value.length} onRemove={() => remove(i)}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field label="Emby 看到的路径前缀" hint="strm 里写的路径开头：本地挂载路径，或 OpenList 的 /d/ 地址">
                <Input value={row.from} placeholder="/mnt/115/主号/电影" onChange={(e) => update(i, { from: e.target.value })} />
              </Field>
              <Field label="网盘账号" hint={missing ? `账号「${row.account}」已经不在了，这条映射不会生效` : "只有 115 账号能 302"}>
                <Select value={row.account} onValueChange={(v) => update(i, { account: v })} disabled={accounts !== null && accounts.length === 0 && !missing}>
                  <SelectTrigger className="w-full" aria-invalid={missing ? true : undefined}>
                    <SelectValue placeholder={accounts === null ? "加载中…" : accounts.length === 0 ? "还没有 115 账号" : "选择账号"} />
                  </SelectTrigger>
                  <SelectContent>
                    {missing && <SelectItem value={row.account}>{row.account}（已不存在）</SelectItem>}
                    {(accounts ?? []).map((a) => (
                      <SelectItem key={a.name} value={a.name}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="对应的网盘目录" hint="不填就是根目录">
                <Input value={row.to} placeholder="/视频/电影" onChange={(e) => update(i, { to: e.target.value })} />
              </Field>
            </div>
          </RuleRow>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus />
        添加一条映射
      </Button>
    </div>
  );
}

/**
 * 302 代理的播放路由规则：按客户端 / 来源 / 路径决定走直链还是交给 Emby。
 * 顺序有意义（第一条命中的生效），所以每条能上下移。
 */
export function RouteRulesEditor({ value, onChange }: EditorProps<RouteRuleRow>) {
  const update = (i: number, patch: Partial<RouteRuleRow>) => onChange(value.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const add = () => onChange([...value, { ...EMPTY_RULE }]);
  const move = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          播放路由规则
          <FieldHint label="路由规则怎么填">
            每条规则是「满足这些条件的播放请求，302 到直链还是交给 Emby」。填了的条件都满足才算命中（与关系）；
            一个条件都不填就是全部命中——想临时关掉 302，加一条什么都不填的「交给 Emby」就行。
            规则从上到下看，第一条命中的生效；一条都没命中照常 302。
            「交给 Emby」时 PlaybackInfo 原样、流请求回源，Emby 自己中转或转码：限了码率的外网播放、拿着 302 播不了的播放器、不想走直链的目录都用它。
            客户端名、设备名、设备 id 就是 Emby 控制台「设备」页里显示的那些（请求头 X-Emby-Authorization 里的 Client / Device / DeviceId）。
            「来源」分内网（本机、私有网段）和外网；放在反代后面要给容器设 TRUST_PROXY 才认得出。
          </FieldHint>
        </h3>
        <p className="text-xs text-muted-foreground">按客户端、来源、路径决定走 302 直链，还是交给 Emby 自己播（中转或转码）。从上到下第一条命中的生效；条件都不填就全部命中；一条都没命中照常 302。</p>
      </div>
      {value.map((row, i) => (
        <RuleRow key={i} index={i} total={value.length} onRemove={() => remove(i)} onMove={(d) => move(i, d)}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="处理方式">
              <Select value={row.action} onValueChange={(v) => update(i, { action: v === "redirect" ? "redirect" : "relay" })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="relay">交给 Emby（中转或转码）</SelectItem>
                  <SelectItem value="redirect">302 到直链</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="来源">
              <Select value={row.remote || "any"} onValueChange={(v) => update(i, { remote: v === "lan" || v === "wan" ? v : "" })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">任意</SelectItem>
                  <SelectItem value="lan">内网（本机、私有网段）</SelectItem>
                  <SelectItem value="wan">外网</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="User-Agent 包含">
              <Input value={row.userAgent} placeholder="例如 Infuse" onChange={(e) => update(i, { userAgent: e.target.value })} />
            </Field>
            <Field label="客户端名包含">
              <Input value={row.client} placeholder="例如 Emby Web、Emby for Android TV" onChange={(e) => update(i, { client: e.target.value })} />
            </Field>
            <Field label="设备名包含">
              <Input value={row.deviceName} placeholder="例如 Chrome Windows" onChange={(e) => update(i, { deviceName: e.target.value })} />
            </Field>
            <Field label="设备 id 等于">
              <Input value={row.deviceId} placeholder="Emby 控制台「设备」页里的 id" onChange={(e) => update(i, { deviceId: e.target.value })} />
            </Field>
            <Field label="Emby 看到的路径以此开头">
              <Input value={row.path} placeholder="/mnt/115/主号/4K" onChange={(e) => update(i, { path: e.target.value })} />
            </Field>
            <Field label="备注">
              <Input value={row.note} placeholder="只给自己看" onChange={(e) => update(i, { note: e.target.value })} />
            </Field>
          </div>
        </RuleRow>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus />
        添加一条规则
      </Button>
    </div>
  );
}
