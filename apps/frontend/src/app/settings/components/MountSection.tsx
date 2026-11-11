"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { AccountInfo, Cd2Settings, OpenlistCopySettings } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { mapLimit } from "@/lib/async";
import { accountLabel, isMountLayerKind } from "@/lib/drive";
import { joinLayerPath, LAYER_META, layerAccountStatus, mountClashes, mountExample, mountRowVerdict, withMount, type MountLayerKind } from "@/lib/mount-layer";
import { CheckLines, type CheckLine } from "./check-lines";
import { driveDirState, LayerDirPicker, openProblem } from "./layer-common";

/** 下拉里「不用这一家」那一项的值：Radix Select 的值不能是空串 */
const NONE = "__none__";

/** 检查时同时列几个目录：一个个等要十几秒，全撒出去又会一下子压到挂载层和后面的网盘上 */
const CHECK_CONCURRENCY = 4;

/**
 * 两家只差这些说法；其余（选账号、各网盘的路径、撞车、检查）是同一套。
 * 全名、简称、那一栏叫什么来自 LAYER_META（「复制」一节、任务弹框也用它），这里只加面板自己的几句
 */
const META: Record<MountLayerKind, (typeof LAYER_META)[MountLayerKind] & { heading: string; hint: React.ReactNode; accountHint: string }> = {
  openlist: {
    ...LAYER_META.openlist,
    heading: "各网盘在 OpenList 里的挂载根",
    hint: (
      <>
        OpenList 把网盘挂在哪个目录下就填哪个，比如 115 挂在 <code>/115</code>。没填的网盘不刷新缓存，也不能经它复制。
      </>
    ),
    accountHint: "用这个账号调 OpenList 的接口",
  },
  cd2: {
    ...LAYER_META.cd2,
    heading: "各网盘在 CD2 里的路径",
    hint: (
      <>
        CD2 里添加云盘时起的名字就是它的根目录，比如叫 <code>115</code> 就填 <code>/115</code>。没填的网盘不刷新缓存，也不能经它复制。
      </>
    ),
    accountHint: "账户页可以有多个 CD2 账号各自建任务，刷新缓存和复制只用这里选的这一个",
  },
};

/** 一家挂载层面板里要改的那两样：选哪个账号、各网盘在它里面的路径 */
type LayerValue = { account?: string; mounts?: Record<string, string> };

type Props = {
  /** openlistCopy 那一份：这一节只改它的 account / mounts（engine / dstDir 归「复制」一节） */
  openlist: OpenlistCopySettings;
  /** 按表单里的当前值改（不是按这次渲染时拿到的那份）：「复制」一节也写 openlistCopy，拿旧快照合并会把它刚改的冲掉 */
  updateOpenlist: (fn: (cur: OpenlistCopySettings) => OpenlistCopySettings) => void;
  cd2: Cd2Settings;
  updateCd2: (fn: (cur: Cd2Settings) => Cd2Settings) => void;
  /** 账户页的账号；null = 还在读 */
  accounts: AccountInfo[] | null;
  accountsFailed: boolean;
};

/**
 * 「网盘挂载」：用 OpenList / CloudDrive2 挂载网盘的，各选一个账号、填各网盘挂在它里面的位置。
 *
 * 这份映射是两件事共用的：改动网盘后让它刷新目录缓存（mount-cache），复制按它换算路径（「复制」一节选引擎）。
 * 以前 OpenList 那份放在「复制」一节里、引擎切到 CD2 就藏起来，可刷新照样在用它——看不到、改不了，所以拆出来，
 * 两家并排、一直显示。存的形状没变：OpenList 的还在 openlistCopy 里，CD2 的在 cd2 里
 */
export function MountSection({ openlist, updateOpenlist, cd2, updateCd2, accounts, accountsFailed }: Props) {
  return (
    <section id="mount" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
      <h2 className="text-base font-medium">网盘挂载（OpenList / CloudDrive2）</h2>
      <p className="text-sm text-muted-foreground">
        用 OpenList 或 CloudDrive2 挂载网盘的，在这里选它的账号、填各网盘挂在它里面的位置。填好之后，整理、转存、删源改动了网盘，就让它刷新改过的目录，经它挂载回源的不用等缓存过期；下面的「复制」也按这里换算路径。用不上的留空。
      </p>
      <LayerPanel
        kind="openlist"
        value={openlist}
        update={(fn) => updateOpenlist((cur) => ({ ...cur, ...fn(cur) }))}
        legacySrcDir={openlist.srcDir}
        accounts={accounts}
        failed={accountsFailed}
      />
      <LayerPanel kind="cd2" value={cd2} update={(fn) => updateCd2((cur) => ({ ...cur, ...fn(cur) }))} accounts={accounts} failed={accountsFailed} />
    </section>
  );
}

/** 一行的检查结果，连同检查时这一行填的值：值改过就不再显示，免得旧的「对得上」误导人 */
type RowResult = { mount: string; line: CheckLine };
type PanelCheck = { account: string; connection: CheckLine[]; rows: Record<string, RowResult> };

function LayerPanel({
  kind,
  value,
  update,
  legacySrcDir,
  accounts,
  failed,
}: {
  kind: MountLayerKind;
  value: LayerValue;
  /** fn 拿到的是表单里的当前值，回要改的那几个字段 */
  update: (fn: (cur: LayerValue) => LayerValue) => void;
  /** 只有 OpenList 有：很早的版本存的「115 默认下载目录在 OpenList 里的路径」，升级时没换算成挂载根的 */
  legacySrcDir?: string;
  accounts: AccountInfo[] | null;
  failed: boolean;
}) {
  const meta = META[kind];
  const idBase = useId();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<PanelCheck | null>(null);
  const [browsing, setBrowsing] = useState<{ title: string; onPick: (path: string) => void } | null>(null);

  const name = (value.account ?? "").trim();
  const mounts = value.mounts ?? {};
  const layerAccounts = (accounts ?? []).filter((a) => a.accountType === kind);
  /** 要填路径的是网盘账号：挂载层账号（OpenList、CD2 自己）不在这里 */
  const driveAccounts = (accounts ?? []).filter((a) => !isMountLayerKind(a.accountType));
  const { missing, usable } = layerAccountStatus(accounts, kind, name);
  /** 页面上看得到的那几行里填了的（删掉的网盘账号留下的旧行不算） */
  const filled = driveAccounts.filter((a) => mounts[a.name]?.trim());
  const hasSaved = name !== "" || Object.values(mounts).some((m) => m?.trim());
  /** 这一家的账号一个都没有、也没存过它的配置：不用它的人只看到一行字 */
  const collapsed = accounts !== null && !failed && layerAccounts.length === 0 && !hasSaved;
  const clashes = mountClashes(
    mounts,
    driveAccounts.map((a) => a.name),
  );
  const labelOf = (acc: string): string => accountLabel(acc, driveAccounts.find((a) => a.name === acc)?.accountType);
  // 结果只对检查时选的那个账号有效
  const shown = result && result.account === name ? result : null;

  const status: { tone: StatusTone; text: string } | null =
    accounts === null
      ? null
      : missing
        ? { tone: "warning", text: "账号不在了" }
        : !name
          ? hasSaved
            ? { tone: "warning", text: "没选账号" }
            : { tone: "neutral", text: "未配置" }
          : filled.length === 0
            ? { tone: "warning", text: `没填${meta.field}` }
            : clashes.size > 0
              ? { tone: "warning", text: `${meta.field}重复` }
              : { tone: "success", text: `${filled.length} 个网盘` };

  const setMount = (account: string, path: string) => update((cur) => ({ mounts: withMount(cur.mounts, account, path) }));
  /** 失焦时去两头的空白（提交时设置页还会再收拾一遍，⌘S 不失焦也存不进空白） */
  const trimMount = (account: string) => {
    const raw = mounts[account];
    if (raw !== undefined && raw !== raw.trim()) setMount(account, raw.trim());
  };

  /**
   * 路径光能打开还不够：填成了别的网盘的根（夸克那一行填了 /115）也打得开。
   * 所以把这个网盘账号下每个任务的目录拼上去，都得在挂载层里找得到，才算填对了（网盘上本来就没有的任务目录不算，只提醒）；
   * 两个网盘账号填了同一个路径也算错——两边目录结构一样时每条路径都打得开，可复制会拿错文件。
   * 连接没通就不逐行查了：每一行都会报同一个错
   */
  const check = async () => {
    if (!usable) return;
    setChecking(true);
    try {
      const connection: CheckLine[] = [];
      let reachable: boolean;
      if (kind === "cd2") {
        const r = await api.cd2.check({ account: name });
        connection.push({ tone: r.system.ok ? "ok" : "bad", text: `地址：${r.system.message}` });
        connection.push({ tone: r.auth.ok ? "ok" : "bad", text: `凭据：${r.auth.message}` });
        // 令牌的权限表只有带「令牌管理」权限的才读得到。浏览缺了这一节就用不了，算错；
        // 同步 / 整理 / 复制缺的照实列出来（不算进红绿：只刷新目录的人用不着），复制要的在「复制」一节还会再查
        if (r.permissions) {
          const lacks = r.permissions.missing.find((m) => m.use === "browse")?.lacks;
          connection.push(
            lacks
              ? { tone: "bad", text: `令牌缺浏览要的权限：${lacks.map((l) => `「${l}」`).join("")}` }
              : { tone: r.permissions.ok ? "ok" : "warn", text: `权限：${r.permissions.message}` },
          );
        }
        reachable = r.system.ok && r.auth.ok;
      } else {
        const why = await openProblem(name, "/");
        connection.push(why ? { tone: "bad", text: `连不上 OpenList：${why}` } : { tone: "ok", text: "连上了" });
        reachable = !why;
      }
      const rows: Record<string, RowResult> = {};
      if (reachable) {
        // 任务列表读不出来就只查路径本身
        const tasks = await api.tasks.list().catch(() => []);
        const targets = driveAccounts.map((a) => ({ account: a.name, raw: mounts[a.name] ?? "" })).filter((t) => t.raw.trim());
        // 先看每个路径本身打不打得开，再把打得开的那些下面的任务目录一起查；两步都限着并发
        const rootProblems = await mapLimit(targets, CHECK_CONCURRENCY, (t) => openProblem(name, t.raw.trim()));
        const probes = targets.flatMap((t, i) =>
          rootProblems[i]
            ? []
            : tasks
                .filter((task) => task.account === t.account)
                .map((task) => ({ account: t.account, origin: task.originPath, path: joinLayerPath(t.raw.trim(), task.originPath) })),
        );
        const probeProblems = await mapLimit(probes, CHECK_CONCURRENCY, (p) => openProblem(name, p.path));
        // 挂载层里找不到的，再直接问网盘这个任务目录在不在：网盘上就没有（改了名、删了、还没建）是任务自己的事，
        // 不能说成这里的路径填错了——真机上 lab 任务的目录还没建，检查就把填对了的挂载根标红了
        const misses = probes.filter((_, j) => probeProblems[j]);
        const missStates = await mapLimit(misses, CHECK_CONCURRENCY, (p) => driveDirState(p.account, p.origin));
        targets.forEach((t, i) => {
          const rootProblem = rootProblems[i];
          if (rootProblem) {
            rows[t.account] = { mount: t.raw, line: { tone: "bad", text: `打不开：${rootProblem}` } };
            return;
          }
          const mine = misses.flatMap((p, j) => (p.account === t.account ? [{ p, state: missStates[j] }] : []));
          const others = clashes.get(t.account);
          rows[t.account] = {
            mount: t.raw,
            line: mountRowVerdict({
              short: meta.short,
              field: meta.field,
              probed: probes.filter((p) => p.account === t.account).length,
              lost: mine.filter((m) => m.state !== "no").map((m) => m.p.path),
              gone: mine.filter((m) => m.state === "no").map((m) => `/${m.p.origin.replace(/^\/+/, "")}`),
              clashWith: others ? others.map(labelOf) : null,
            }),
          };
        });
      }
      setResult({ account: name, connection, rows });
      const lines = [...connection, ...Object.values(rows).map((r) => r.line)];
      const bad = lines.filter((l) => l.tone === "bad").length;
      if (bad > 0) toast.error(`${meta.title}：${bad} 处不对，看标红的几行`);
      else if (Object.keys(rows).length === 0) toast.warning(`${meta.title} 连上了，还没填任何网盘的${meta.field}`);
      else if (lines.some((l) => l.tone === "warn")) toast.warning(`${meta.title} 连上了，有要留意的地方，看黄色那几行`);
      else toast.success(`${meta.title} 连上了，各网盘的${meta.field}都对得上`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "检查失败"));
    } finally {
      setChecking(false);
    }
  };

  const accountId = `${idBase}-account`;

  return (
    <div id={meta.anchor} className="scroll-mt-20 overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2">
        <h3 className="text-sm font-medium">{meta.title}</h3>
        {status && <StatusBadge tone={status.tone}>{status.text}</StatusBadge>}
      </div>

      {collapsed ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          还没有 {meta.title} 账号。用 {meta.title} 挂载网盘的，先到
          <Link href="/account" className="text-brand hover:underline">
            「账户」页
          </Link>
          添加一个，再回来填。
        </p>
      ) : (
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={accountId} className="text-xs font-medium text-muted-foreground">
                {meta.title} 账号
              </Label>
              <Select
                value={name}
                onValueChange={(v) => v && update(() => ({ account: v === NONE ? undefined : v }))}
                disabled={layerAccounts.length === 0 && !missing && !name}
              >
                <SelectTrigger id={accountId} className="w-full">
                  <SelectValue
                    placeholder={
                      failed ? "账号列表没读出来" : accounts === null ? "加载中…" : layerAccounts.length === 0 ? `还没有 ${meta.title} 账号` : "选择账号"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {name && <SelectItem value={NONE}>不用 {meta.title}</SelectItem>}
                  {missing && <SelectItem value={name}>{name}（已不存在）</SelectItem>}
                  {layerAccounts.map((a) => (
                    <SelectItem key={a.name} value={a.name}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className={missing ? "text-xs text-warning" : "text-xs text-muted-foreground"}>
                {failed
                  ? "账号列表没读出来，刷新页面再试"
                  : missing
                    ? `账号「${name}」已经不在了，或者不是 ${meta.title} 账号：换一个，或者到「账户」页重新添加`
                    : accounts !== null && layerAccounts.length === 0
                      ? `还没有 ${meta.title} 账号，先到「账户」页添加一个`
                      : meta.accountHint}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <h4 className="text-sm font-medium">{meta.heading}</h4>
              <p className="text-xs text-muted-foreground">{meta.hint}</p>
            </div>
            {failed ? (
              <p className="text-sm text-destructive">账号列表没读出来，刷新页面再试。</p>
            ) : accounts === null ? (
              <p className="text-sm text-muted-foreground">加载中…</p>
            ) : driveAccounts.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">还没有 115 / 夸克账号，先到「账户」页添加。</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {driveAccounts.map((a, i) => {
                  const label = accountLabel(a.name, a.accountType);
                  const sameKind = driveAccounts.filter((b) => b.accountType === a.accountType).length;
                  const clash = clashes.get(a.name);
                  const raw = mounts[a.name] ?? "";
                  const rowResult = shown?.rows[a.name];
                  const rowLine = rowResult && rowResult.mount === raw ? rowResult.line : null;
                  const inputId = `${idBase}-mount-${i}`;
                  return (
                    <div key={a.name} className="flex flex-col gap-1.5">
                      <Label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
                        {label}
                      </Label>
                      <InputGroup>
                        <InputGroupInput
                          id={inputId}
                          value={raw}
                          placeholder={mountExample(kind, a, sameKind)}
                          aria-invalid={rowLine?.tone === "bad" ? true : undefined}
                          onChange={(e) => setMount(a.name, e.target.value)}
                          onBlur={() => trimMount(a.name)}
                        />
                        <InputGroupButton
                          disabled={!usable}
                          title={usable ? `从 ${meta.title} 里选` : `先选 ${meta.title} 账号`}
                          onClick={() => setBrowsing({ title: `选择 ${label} 在 ${meta.short} 里的${meta.field}`, onPick: (p) => setMount(a.name, `/${p}`) })}
                        >
                          <FolderOpen />
                        </InputGroupButton>
                      </InputGroup>
                      {clash && (
                        <p className="text-xs text-warning">
                          和 {clash.map(labelOf).join("、")} 填的是同一个{meta.field}。不同的网盘账号挂在不同的位置，除非它们本来就是同一个账号，否则复制会到别的账号里找文件
                        </p>
                      )}
                      {rowLine && <CheckLines lines={[rowLine]} />}
                    </div>
                  );
                })}
              </div>
            )}
            {kind === "openlist" && legacySrcDir && Object.keys(mounts).length === 0 && (
              <p className="text-xs text-warning">
                旧配置里的源目录（{legacySrcDir}）没能自动换算成挂载根（115 接口没通或默认下载目录变过）。在上面填好挂载根并保存，复制才会重新工作。
              </p>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!usable || checking}
                title={usable ? undefined : `先选 ${meta.title} 账号`}
                onClick={() => void check()}
              >
                {checking ? <Loader2 className="size-4 animate-spin" /> : null}
                检查连接和路径
              </Button>
              {usable && accounts !== null && filled.length === 0 && (
                <p className="text-xs text-warning">还没填任何网盘的{meta.field}：不会刷新缓存，也不能经它复制。</p>
              )}
            </div>
            {shown && <CheckLines lines={shown.connection} />}
          </div>
        </div>
      )}

      {browsing && (
        <LayerDirPicker title={browsing.title} layerTitle={meta.title} account={name} onPick={browsing.onPick} onClose={() => setBrowsing(null)} />
      )}
    </div>
  );
}
