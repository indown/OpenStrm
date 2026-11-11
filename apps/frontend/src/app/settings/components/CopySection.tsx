"use client";

import { useId, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { AccountInfo, Cd2Settings, OpenlistCopySettings } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { accountLabel, isMountLayerKind } from "@/lib/drive";
import { LAYER_META, layerAccountStatus } from "@/lib/mount-layer";
import { copyLayer, isOpenlistRootInput, OPENLIST_ROOT_TARGET } from "@/lib/openlist-copy";
import { CheckLines, type CheckLine } from "./check-lines";
import { LayerDirPicker, openProblem } from "./layer-common";

type Props = {
  /** openlistCopy 那一份：这一节只改它的 engine / dstDir（账号和各网盘的路径归「网盘挂载」） */
  value: OpenlistCopySettings;
  /** 按表单里的当前值改：「网盘挂载」一节也写 openlistCopy，拿这次渲染时的旧快照合并会把它刚改的冲掉 */
  update: (fn: (cur: OpenlistCopySettings) => OpenlistCopySettings) => void;
  /** cd2 那一份：引擎选 CloudDrive2 时用哪个账号、各网盘的路径看它 */
  cd2: Cd2Settings;
  /** 账户页的账号；null = 还在读 */
  accounts: AccountInfo[] | null;
  accountsFailed: boolean;
};

/**
 * 「复制」：网盘上新落下的文件让 OpenList 或 CloudDrive2 复制到另一个存储。这里只管用谁复制、默认复制到哪；
 * 那一家的账号和各网盘挂在它里面的位置在上面「网盘挂载」里（刷新缓存也用那一份），复制哪些任务看任务上的开关。
 * 锚点还叫 openlist-copy：任务列表「复制没生效」的徽标链到这里
 */
export function CopySection({ value, update, cd2, accounts, accountsFailed }: Props) {
  const idBase = useId();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ key: string; lines: CheckLine[] } | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const layer = copyLayer(value, cd2);
  const isCd2 = layer.engine === "cd2";
  // 叫法和「网盘挂载」里那块面板是同一份（LAYER_META）
  const { title: engineLabel, short, field, anchor } = LAYER_META[layer.engine];
  /** 「网盘挂载」里这一家那块面板的锚点 */
  const panel = `#${anchor}`;
  const driveAccounts = (accounts ?? []).filter((a) => !isMountLayerKind(a.accountType));
  const { missing, usable: ready } = layerAccountStatus(accounts, layer.engine, layer.account);
  const filled = driveAccounts.filter((a) => layer.mounts[a.name]?.trim());
  const unfilled = driveAccounts.filter((a) => !layer.mounts[a.name]?.trim());
  const labels = (list: AccountInfo[]): string => list.map((a) => accountLabel(a.name, a.accountType)).join("、");
  const dst = value.dstDir ?? "";
  const rootError = isOpenlistRootInput(dst);
  // 结果只对检查时的引擎、账号、目标目录有效：改了哪样都不再显示
  const checkKey = JSON.stringify([layer.engine, layer.account, dst.trim()]);
  const shown = result?.key === checkKey ? result.lines : null;

  /** 选的这一家配齐没有：缺什么就说什么，带去上面那块面板的链接 */
  const goto = (text: string) => (
    <a href={panel} className="text-brand hover:underline">
      {text}
    </a>
  );
  const readiness: { warn: boolean; body: React.ReactNode } | null =
    accounts === null && !accountsFailed
      ? null
      : !layer.account
        ? { warn: true, body: <>「网盘挂载」里 {engineLabel} 还没选账号，选好之前不会复制。{goto("去选")}</> }
        : accountsFailed
          ? // 读不到账号列表就分不出选的账号还在不在：别摆出「配好了」的样子
            { warn: true, body: <>账号列表没读出来，确认不了「网盘挂载」里选的 {engineLabel} 账号「{layer.account}」还在，刷新页面再试。</> }
          : missing
            ? { warn: true, body: <>「网盘挂载」里给 {engineLabel} 选的账号「{layer.account}」已经不在了，复制不了。{goto("去换一个")}</> }
            : filled.length === 0
              ? { warn: true, body: <>「网盘挂载」里还没给任何网盘填在 {short} 里的{field}，填了的网盘才复制得了。{goto("去填")}</> }
              : {
                  warn: false,
                  body: (
                    <>
                      用 {engineLabel} 账号「{layer.account}」复制，能复制的网盘：{labels(filled)}
                      {unfilled.length > 0 && <>；{labels(unfilled)} 没填{field}，不复制</>}。{goto("改")}
                    </>
                  ),
                };

  /**
   * 只查复制自己的事：目标目录（不存在不要紧，第一次复制时会建，但它所在的存储得在），CD2 再看令牌能不能复制、看传输任务。
   * 各网盘的路径对不对在「网盘挂载」里查
   */
  const check = async () => {
    if (!ready) return;
    setChecking(true);
    const key = checkKey;
    try {
      const lines: CheckLine[] = [];
      let reachable = true;
      if (isCd2) {
        const r = await api.cd2.check({ account: layer.account });
        if (!r.system.ok || !r.auth.ok) {
          lines.push({ tone: "bad", text: `CD2 连不上：${r.system.ok ? r.auth.message : r.system.message}` });
          reachable = false;
        } else {
          // 权限表读得到（令牌带「令牌管理」）就以它为准，看复制那一项缺什么；读不到才看「获取传输任务」那一下探测。
          // 两样都摆出来的话，探测碰上一次临时出错就会和权限表说的打架
          const lacks = r.permissions?.missing.find((m) => m.use === "copy")?.lacks;
          if (lacks) lines.push({ tone: "bad", text: `令牌缺复制要的权限：${lacks.map((l) => `「${l}」`).join("")}` });
          else if (r.permissions) lines.push({ tone: "ok", text: "令牌的复制权限齐全" });
          else if (r.copy) lines.push({ tone: r.copy.ok ? "ok" : "warn", text: r.copy.message });
        }
      }
      const d = dst.trim();
      if (isOpenlistRootInput(d)) lines.push({ tone: "bad", text: OPENLIST_ROOT_TARGET });
      else if (!d) lines.push({ tone: "warn", text: "没填默认目标目录：只有任务上填了「复制到哪」的才复制得了" });
      else if (reachable) {
        const why = await openProblem(layer.account, d);
        if (!why) lines.push({ tone: "ok", text: `默认目标目录 ${d} 在` });
        else {
          const top = `/${d.split("/").filter(Boolean)[0] ?? ""}`;
          const topWhy = top === "/" ? null : await openProblem(layer.account, top);
          if (topWhy) lines.push({ tone: "bad", text: `默认目标目录（${d}）所在的 ${top} 打不开：${topWhy}` });
          else lines.push({ tone: "ok", text: `默认目标目录 ${d} 还不存在，第一次复制时会自动建` });
        }
      }
      setResult({ key, lines });
      const bad = lines.filter((l) => l.tone === "bad").length;
      if (bad > 0) toast.error(`复制：${bad} 处不对，看标红的几行`);
      else if (lines.some((l) => l.tone === "warn")) toast.warning("复制能用，有要留意的地方，看黄色那几行");
      else toast.success(isCd2 ? "目标目录和令牌权限都没问题" : "目标目录没问题");
    } catch (err) {
      toast.error(apiErrorMessage(err, "检查失败"));
    } finally {
      setChecking(false);
    }
  };

  const engineId = `${idBase}-engine`;
  const dstId = `${idBase}-dst`;

  return (
    <section id="openlist-copy" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
      <h2 className="text-base font-medium">复制</h2>
      <p className="text-sm text-muted-foreground">
        网盘上新落下的文件（云下载、转存、追更、网盘监控），让 OpenList 或 CloudDrive2 复制到另一个存储，比如挂载的本地硬盘。复制哪些看任务上的「复制到 OpenList / CD2」开关；这里选用谁复制、默认复制到哪。
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={engineId} className="text-xs font-medium text-muted-foreground">
            用哪个复制
          </Label>
          <Select value={layer.engine} onValueChange={(v) => v && update((cur) => ({ ...cur, engine: v === "cd2" ? "cd2" : "openlist" }))}>
            <SelectTrigger id={engineId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openlist">OpenList</SelectItem>
              <SelectItem value="cd2">CloudDrive2</SelectItem>
            </SelectContent>
          </Select>
          {readiness && <p className={readiness.warn ? "text-xs text-warning" : "text-xs text-muted-foreground"}>{readiness.body}</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={dstId} className="text-xs font-medium text-muted-foreground">
            默认目标目录
          </Label>
          <InputGroup>
            <InputGroupInput
              id={dstId}
              value={dst}
              placeholder={isCd2 ? "/hdd/media" : "/local/downloads"}
              aria-invalid={rootError ? true : undefined}
              // 打字时原样存（不然中间的空格打不进去），失焦去两头空白；⌘S 不失焦也没事，提交时设置页会再收拾一遍
              onChange={(e) => {
                const next = e.target.value;
                update((cur) => ({ ...cur, dstDir: next }));
              }}
              onBlur={() => dst !== dst.trim() && update((cur) => ({ ...cur, dstDir: (cur.dstDir ?? "").trim() }))}
            />
            <InputGroupButton
              disabled={!ready}
              title={ready ? `从 ${engineLabel} 账号 ${layer.account} 里选` : `先在「网盘挂载」里给 ${engineLabel} 选账号`}
              onClick={() => setBrowsing(true)}
            >
              <FolderOpen />
            </InputGroupButton>
          </InputGroup>
          <p className="text-xs text-muted-foreground">
            任务上没填「复制到哪」时复制到这里。是 {short} 里的路径，还不存在的目录第一次复制时会自动建
            {isCd2 ? "；要复制到硬盘，先在 CD2 里把硬盘目录加成「本地文件夹」存储" : ""}
          </p>
          {rootError && <p className="text-xs text-destructive">{OPENLIST_ROOT_TARGET}</p>}
        </div>
      </div>

      <div className="space-y-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!ready || checking}
          title={ready ? undefined : `先在「网盘挂载」里给 ${engineLabel} 选账号`}
          onClick={() => void check()}
        >
          {checking ? <Loader2 className="size-4 animate-spin" /> : null}
          {isCd2 ? "检查目标目录和令牌权限" : "检查目标目录"}
        </Button>
        {shown && <CheckLines lines={shown} />}
      </div>

      {browsing && (
        <LayerDirPicker
          title="选择默认目标目录"
          layerTitle={engineLabel}
          account={layer.account}
          onPick={(path) => update((cur) => ({ ...cur, dstDir: `/${path}` }))}
          onClose={() => setBrowsing(false)}
        />
      )}
    </section>
  );
}
