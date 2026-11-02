"use client";

import * as React from "react";
import axios from "axios";
import { QrCode, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { Qrcode115App, Qrcode115Start } from "@openstrm/shared";

import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { cn } from "@/lib/utils";
import { usePolling } from "@/hooks/use-polling";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** 下拉里的端；顺序就是显示顺序，第一个是默认。网页和桌面端不给：网页 cookie 跑不了任务，桌面端 115 已停用 */
const APPS: Array<{ value: Qrcode115App; label: string }> = [
  { value: "alipaymini", label: "支付宝小程序" },
  { value: "wechatmini", label: "微信小程序" },
  { value: "tv", label: "电视端" },
  { value: "android", label: "安卓 App" },
  { value: "ios", label: "iOS App" },
];

type Phase = "idle" | "loading" | "waiting" | "scanned" | "expired" | "cancelled" | "error";

const STATUS_TEXT: Record<Phase, string> = {
  idle: "",
  loading: "正在向 115 要二维码…",
  waiting: "打开 115 手机 App，扫这个二维码",
  scanned: "已扫码，在手机上点「确认登录」",
  expired: "二维码过期了，重新生成一个",
  cancelled: "手机上取消了登录",
  error: "没成功",
};

const OVERLAY_TEXT: Partial<Record<Phase, string>> = {
  loading: "生成中…",
  scanned: "已扫码",
  expired: "已过期",
  cancelled: "已取消",
  error: "出错了",
};

interface Qrcode115PanelProps {
  /** 编辑已有账号时为 true：按钮叫「重新扫码」 */
  hasSaved: boolean;
  /** 扫码确认后把 cookie 交给表单；用户还是要点保存，和手填一样 */
  onCookie: (cookie: string, userName?: string) => void;
}

/**
 * 账户弹框里的 115 扫码登录：选端 → 显示二维码 → 轮询状态 → 确认后 cookie 进表单。
 * 内嵌在表单里不另开弹框：弹框套弹框在手机上没法看。按钮都是 type="button"，不然会把外面的账号表单提交掉。
 */
export function Qrcode115Panel({ hasSaved, onCookie }: Qrcode115PanelProps) {
  const [open, setOpen] = React.useState(false);
  const [app, setApp] = React.useState<Qrcode115App>("alipaymini");
  const [session, setSession] = React.useState<Qrcode115Start | null>(null);
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [error, setError] = React.useState("");
  // 查状态那次请求会挂很久（后端等 115 的长轮询）：换码、收起、卸载时把它掐掉，
  // 回来的结果还要对一下 uid，免得旧码的结局盖到新码头上，或者面板已经不在了还往表单里塞 cookie
  const sessionRef = React.useRef<Qrcode115Start | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const mountedRef = React.useRef(true);

  const dropSession = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    sessionRef.current = null;
    setSession(null);
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const start = React.useCallback(
    async (which: Qrcode115App) => {
      dropSession();
      setPhase("loading");
      setError("");
      try {
        const s = await api.accounts.qrcode115.start(which);
        if (!mountedRef.current) return;
        sessionRef.current = s;
        abortRef.current = new AbortController();
        setSession(s);
        setPhase("waiting");
      } catch (err) {
        if (!mountedRef.current) return;
        setPhase("error");
        setError(apiErrorMessage(err, "拿不到二维码"));
      }
    },
    [dropSession],
  );

  const openPanel = () => {
    setOpen(true);
    void start(app);
  };
  const closePanel = () => {
    dropSession();
    setOpen(false);
    setPhase("idle");
  };
  const changeApp = (v: Qrcode115App) => {
    setApp(v);
    void start(v);
  };

  // 后端那一步可能要等 115 挂着的请求回来（最长 30 秒）；usePolling 上一轮没回不叠发，正好
  usePolling(
    async () => {
      const current = sessionRef.current;
      if (!current) return;
      const { uid } = current;
      const stale = () => !mountedRef.current || sessionRef.current?.uid !== uid;
      try {
        const r = await api.accounts.qrcode115.status(uid, abortRef.current?.signal);
        if (stale()) return;
        if (r.status === "confirmed") {
          onCookie(r.cookie, r.userName);
          toast.success(r.userName ? `已拿到「${r.userName}」的 cookie，保存后生效` : "已拿到 cookie，保存后生效");
          closePanel();
          return;
        }
        setPhase(r.status);
        if (r.status === "expired" || r.status === "cancelled") dropSession();
      } catch (err) {
        if (stale() || axios.isCancel(err)) return;
        setPhase("error");
        setError(apiErrorMessage(err, "查不到扫码状态"));
        dropSession();
      }
    },
    1500,
    { enabled: open && session !== null && (phase === "waiting" || phase === "scanned") },
  );

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="button" variant="outline" size="sm" onClick={openPanel}>
          <QrCode className="size-4" />
          {hasSaved ? "重新扫码" : "扫码登录"}
        </Button>
        <p className="text-xs text-muted-foreground">
          推荐扫码。手填的话必须是 115 App 端登录的 cookie，网页版（UID 里带 A1）能看目录但跑不了任务。
        </p>
      </div>
    );
  }

  const overlay = OVERLAY_TEXT[phase];
  const retryable = phase === "expired" || phase === "cancelled" || phase === "error";
  return (
    <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">登录端</span>
        <Select value={app} onValueChange={(v) => v && changeApp(v as Qrcode115App)}>
          <SelectTrigger size="sm" className="w-40" aria-label="登录端">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {APPS.map((a) => (
              <SelectItem key={a.value} value={a.value}>
                {a.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => void start(app)} disabled={phase === "loading"}>
            <RefreshCw className={cn("size-4", phase === "loading" && "animate-spin")} />
            刷新
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={closePanel}>
            收起
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        每个端同时只能登一个：选手机 App 会把手机上的 115 顶下线，OpenList 之类的工具正在用的端也别选。小程序端平时用不到，默认选它。
      </p>
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        {/* 二维码要对比度，深色主题下也保持白底 */}
        <div className="relative size-48 shrink-0 overflow-hidden rounded-md bg-white p-2">
          {session ? (
            // 图是后端内联的 data URL，next/image 不认
            // eslint-disable-next-line @next/next/no-img-element
            <img src={session.image} alt="115 登录二维码" className="size-full" />
          ) : null}
          {overlay ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/90 text-sm text-foreground">
              {overlay}
            </div>
          ) : null}
        </div>
        <div className="space-y-2 text-sm">
          <p className="font-medium">{STATUS_TEXT[phase]}</p>
          {phase === "error" ? <p className="text-destructive">{error}</p> : null}
          {retryable ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void start(app)}>
              重新生成
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
