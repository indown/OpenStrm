"use client";

import { useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { PlaybackDiagnosis } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";

const LINK_REASON: Record<NonNullable<PlaybackDiagnosis["link"]["reason"]>, string> = {
  "not-mounted": "这个条目不在任何挂载前缀下，播放不经过 302，直链这一段不适用。",
  "no-account": "找不到对应的 115 账号：任务或路径映射指向的账号已删、改名或不是 115。",
  "not-found": "网盘上找不到这个文件：strm 里的路径和网盘现状对不上。",
  "no-url": "找到了文件但拿不到直链：看看这个账号的 Cookie 是否还有效。",
  error: "直链解析出错。",
};

function embyNote(d: PlaybackDiagnosis): string {
  const e = d.emby;
  if (e.error) return `Emby 没回答：${e.error}`;
  if (e.probed) return "这次让 Emby 探测了一遍媒体流，首播多等的主要就是这段。探过一次就落库，之后播放不再探。";
  if (e.streamsBefore > 0) return "Emby 早就探测过这个条目，这次没有探测开销。想量冷启动，指定一个还没播过的条目 id。";
  return "Emby 没探出媒体流：它读不到 strm 指向的位置，每次起播都会重探几遍再放弃。给 Emby 挂上网盘、或改用 http 前缀才能让它探成功。";
}

const PATH_VIA: Record<NonNullable<PlaybackDiagnosis["link"]["pathVia"]>, string> = {
  memo: "内存里记着这个文件",
  db: "库里的路径缓存直接给了文件 id",
  list: "逐级列目录找到的",
};

function linkNote(d: PlaybackDiagnosis): string {
  const l = d.link;
  if (!l.ok) return `${LINK_REASON[l.reason ?? "error"]}${l.error ? ` ${l.error}` : ""}`;
  const parts = [`找路径 ${l.pathMs} ms${l.pathVia ? `（${PATH_VIA[l.pathVia]}）` : ""}，取链 ${l.linkMs} ms`];
  if (l.pathVia === "list" && l.pathMs >= 1000 && l.pathMs > l.linkMs) parts.push("找路径占大头：同步过的目录会进路径缓存，之后只要一个请求");
  return parts.join("；") + "。";
}

/**
 * 设置页 Emby 一节的「起播诊断」：服务端替播放器把首播的两段路走一遍，把用时摆出来。
 * 是一个动作不是表单字段：不碰表单的脏状态，按钮要 type="button" 免得把整页设置提交了
 */
export function PlaybackDiagnoseButton({ configured }: { configured: boolean }) {
  const [itemId, setItemId] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<PlaybackDiagnosis | null>(null);

  const run = async () => {
    setWorking(true);
    try {
      setResult(await api.emby.playbackDiagnose(itemId.trim() || undefined));
    } catch (err) {
      toast.error(apiErrorMessage(err, "起播诊断失败"));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium">起播诊断</p>
          <p className="text-xs text-muted-foreground">
            服务端替播放器走一遍首播的两段路：让 Emby 回答一次 PlaybackInfo（没探测过的条目会真的探测一次），再向网盘要一次直链。
            留空条目 id 就挑最近入库、还没探测过的 strm 条目。换直链量的是冷路径（不用内存里记着的），相当于播放代理冷启动时的用时；
            同步 / 整理在跑时先等它们跑完。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            // 这个输入框在整页设置的 <form> 里：回车默认会提交整页设置，这里截下来当「开始诊断」
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (!working && configured) void run();
            }}
            placeholder="条目 id（可留空）"
            className="h-8 w-40 text-xs"
            disabled={working}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => void run()} disabled={working || !configured} title={configured ? undefined : "先保存 Emby 地址和 API Key"}>
            {working ? <Loader2 className="size-4 animate-spin" /> : <Activity className="size-4" />}
            {working ? "诊断中…" : "开始诊断"}
          </Button>
        </div>
      </div>
      {result && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
          <dt className="text-muted-foreground">条目</dt>
          <dd className="min-w-0">
            <span className="font-medium">{result.item.name || result.item.id}</span>
            <span className="text-muted-foreground"> · {result.item.type} · id {result.item.id}{result.item.picked ? "（自动挑的）" : ""}</span>
            {result.item.path && <p className="truncate font-mono text-[11px] text-muted-foreground" title={result.item.path}>{result.item.path}</p>}
          </dd>
          <dt className="text-muted-foreground">Emby 回答</dt>
          <dd>
            <span className="font-medium tabular-nums">{result.emby.ms} ms</span>
            <span className="text-muted-foreground"> · 媒体流 {result.emby.streamsBefore} → {result.emby.streamsAfter} 条</span>
            <p className="text-muted-foreground">{embyNote(result)}</p>
          </dd>
          <dt className="text-muted-foreground">换直链</dt>
          <dd>
            <span className="font-medium tabular-nums">{result.link.ms} ms</span>
            {result.link.account && <span className="text-muted-foreground"> · 账号 {result.link.account}</span>}
            <p className="text-muted-foreground">{linkNote(result)}</p>
          </dd>
          <dt className="text-muted-foreground">合计</dt>
          <dd className="font-medium tabular-nums">{result.totalMs} ms</dd>
        </dl>
      )}
    </div>
  );
}
