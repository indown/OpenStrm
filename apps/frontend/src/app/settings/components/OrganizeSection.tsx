"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { OrganizeCategoryRule, OrganizeSettings, OrganizeTemplatePreview } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SwitchRow } from "@/components/switch-row";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { FieldHint } from "@/components/field-hint";
import { TemplateEditor, previewFor } from "@/components/template-editor";
import { SkipDirs } from "./SkipDirs";
import { DEFAULT_TEMPLATES, SERVERS, STRUCTURES, buildTemplate, detectServer, detectStructure, serverFromIdTag, type MediaKind, type ServerPreset } from "@/lib/organize-presets";
import { joinMovie, joinTv, splitMovie, splitTv } from "@/lib/template-parts";

export { DEFAULT_TEMPLATES };

/** 分类规则的一行：`名称: genre=16,99; country=CN,TW; lang=zh`，没有条件的是兜底 */
export function parseCategoryLines(text: string): OrganizeCategoryRule[] {
  const out: OrganizeCategoryRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    const name = (colon === -1 ? line : line.slice(0, colon)).trim();
    if (!name) continue;
    const rule: OrganizeCategoryRule = { name };
    if (colon !== -1) {
      for (const part of line.slice(colon + 1).split(";")) {
        const [k, v] = part.split("=").map((x) => x.trim());
        if (!k || !v) continue;
        const values = v.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
        if (k === "genre") rule.genreIds = values.map(Number).filter((n) => Number.isFinite(n));
        else if (k === "country") rule.countries = values.map((x) => x.toUpperCase());
        else if (k === "lang") rule.languages = values.map((x) => x.toLowerCase());
      }
    }
    out.push(rule);
  }
  return out;
}

export function formatCategoryLines(rules: OrganizeCategoryRule[] | undefined): string {
  return (rules ?? [])
    .map((r) => {
      const conds = [
        r.genreIds?.length ? `genre=${r.genreIds.join(",")}` : "",
        r.countries?.length ? `country=${r.countries.join(",")}` : "",
        r.languages?.length ? `lang=${r.languages.join(",")}` : "",
      ].filter(Boolean);
      return conds.length ? `${r.name}: ${conds.join("; ")}` : r.name;
    })
    .join("\n");
}

const DEFAULT_CATEGORY_TEXT = {
  movie: "动画电影: genre=16\n纪录片: genre=99\n华语电影: lang=zh,cn,bo,za\n日韩电影: lang=ja,ko\n外语电影",
  tv: "国漫: genre=16; country=CN,TW,HK\n日番: genre=16; country=JP\n动画: genre=16\n纪录片: genre=99\n综艺: genre=10764,10767\n国产剧: country=CN,TW,HK\n日韩剧: country=JP,KR\n欧美剧",
};

const KIND_LABEL: Record<MediaKind, string> = { movie: "电影", tv: "剧集" };
const KEEP_NAME_FILE = "{originalName}.{ext}";

type Props = {
  value: OrganizeSettings;
  onChange: (next: OrganizeSettings) => void;
};

/** 设置页的「整理」区块：服务器预设 + 电影 / 剧集两个模板面板（实时试算），分类和识别词按行编辑 */
export function OrganizeSection({ value, onChange }: Props) {
  const [preview, setPreview] = useState<OrganizeTemplatePreview | null>(null);
  const [rulesText, setRulesText] = useState((value.rules ?? []).join("\n"));
  const [movieCats, setMovieCats] = useState(value.categories?.movie ? formatCategoryLines(value.categories.movie) : DEFAULT_CATEGORY_TEXT.movie);
  const [tvCats, setTvCats] = useState(value.categories?.tv ? formatCategoryLines(value.categories.tv) : DEFAULT_CATEGORY_TEXT.tv);
  const [tab, setTab] = useState<MediaKind>("movie");
  const timer = useRef<NodeJS.Timeout | null>(null);
  const extrasId = useId();

  const set = (patch: Partial<OrganizeSettings>) => onChange({ ...value, ...patch });
  const movieTpl = value.templates?.movie ?? "";
  const tvTpl = value.templates?.tv ?? "";
  const idTag = value.idTag ?? "emby";
  const colon = value.colon ?? "smart";
  const episodeTitle = value.episodeTitle === true;
  const specials = value.specials === "specials" ? "specials" : "season00";
  const extrasDir = value.extrasDir ?? "";
  const extrasDirName = extrasDir.trim() || "extras";
  const catsEnabled = value.categories?.enabled === true;
  // 没填的模板按默认模板算（后端也是这么算的）；预设按 id 标签写法对应的服务器生成文件名细节
  const effMovie = movieTpl.trim() ? movieTpl : DEFAULT_TEMPLATES.movie;
  const effTv = tvTpl.trim() ? tvTpl : DEFAULT_TEMPLATES.tv;
  const server = serverFromIdTag(idTag);
  const activeServer = detectServer({ idTag, specials, extrasDir: extrasDirName, movie: effMovie, tv: effTv });
  const structureLabel = (type: MediaKind) => STRUCTURES[type].find((s) => s.key === detectStructure(type, type === "movie" ? effMovie : effTv, server))?.label ?? "自定义";

  // 模板 / 风格 / 分类一变就试算一次（防抖），错误直接显示在面板里
  const previewKey = useMemo(
    () => JSON.stringify([movieTpl, tvTpl, idTag, colon, episodeTitle, rulesText, catsEnabled, movieCats, tvCats]),
    [movieTpl, tvTpl, idTag, colon, episodeTitle, rulesText, catsEnabled, movieCats, tvCats],
  );
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.organize
        .previewName({
          templates: { movie: movieTpl, tv: tvTpl },
          idTag,
          colon,
          episodeTitle,
          rules: rulesText.split("\n"),
          categories: { enabled: catsEnabled, movie: parseCategoryLines(movieCats), tv: parseCategoryLines(tvCats) },
        })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 400);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  /** 套一个服务器：改 id 标签、特别篇 / 花絮目录名和两条模板的文件名细节；目录结构（年份 / 系列 / 分类那几层）和「保留原文件名」照旧 */
  const applyServer = (s: ServerPreset) => {
    const m = splitMovie(effMovie);
    const t = splitTv(effTv);
    const movie = m ? joinMovie({ dir: m.dir, file: m.file === KEEP_NAME_FILE ? m.file : s.movieFile }) : buildTemplate("movie", "default", s.key);
    const tv = t
      ? joinTv({ dir: t.dir, season: t.season, file: t.file === KEEP_NAME_FILE ? t.file : s.tvFile.replace("{ABS}", t.file.includes("{absolute") ? "[ - {absolute000}]" : "") })
      : buildTemplate("tv", "default", s.key);
    set({ idTag: s.idTag, specials: s.specials, extrasDir: s.extrasDir, templates: { movie, tv } });
  };

  const ruleErrors = preview?.errors.filter((e) => e.startsWith("识别词")) ?? [];

  return (
    <section id="organize" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
      <h2 className="text-base font-medium">整理与规范化命名</h2>
      <p className="text-sm text-muted-foreground">
        「整理」页按 TMDB 识别网盘里的文件，套下面的模板在网盘上改名 / 归位，本地 strm 跟着走。电影和剧集各一套模板；任务弹框里能给某个任务单独设。
      </p>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium">媒体服务器</span>
          {SERVERS.map((s) => (
            <Button key={s.key} type="button" variant={activeServer === s.key ? "secondary" : "outline"} size="sm" className="h-8 text-xs" onClick={() => applyServer(s)} title={s.hint}>
              {s.label}
            </Button>
          ))}
          <span className="text-xs text-muted-foreground">{activeServer ? `当前是 ${SERVERS.find((s) => s.key === activeServer)?.label} 的规范` : "当前是自定义写法"}</span>
        </div>
        <p className="text-xs text-muted-foreground">按一下只改 id 标签写法、特别篇和花絮目录名、两类模板的文件名细节；目录结构（年份 / 系列 / 分类那几层）保留。</p>
      </div>

      <div className="space-y-3">
        <div role="tablist" aria-label="命名模板" className="flex gap-1 border-b">
          {(["movie", "tv"] as MediaKind[]).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === k ? "border-brand font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {KIND_LABEL[k]}
              <span className="ml-1 text-xs font-normal text-muted-foreground">· {structureLabel(k)}</span>
            </button>
          ))}
        </div>
        {tab === "movie" ? (
          <TemplateEditor type="movie" mode="settings" value={movieTpl} fallback={DEFAULT_TEMPLATES.movie} server={server} preview={previewFor(preview, "movie")} onChange={(v) => set({ templates: { ...(value.templates ?? {}), movie: v } })} />
        ) : (
          <TemplateEditor type="tv" mode="settings" value={tvTpl} fallback={DEFAULT_TEMPLATES.tv} server={server} preview={previewFor(preview, "tv")} onChange={(v) => set({ templates: { ...(value.templates ?? {}), tv: v } })}>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <SwitchRow
                label="文件名里写集标题"
                description="每部剧多拉几次 TMDB 季详情；对 Emby 识别没影响，纯观感。"
                checked={episodeTitle}
                onCheckedChange={(v) => set({ episodeTitle: v })}
              />
              <div className="space-y-2 rounded-md border p-3">
                <Label>特别篇目录名</Label>
                <Select value={specials} onValueChange={(v) => set({ specials: v as OrganizeSettings["specials"] })}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="season00">Season 00（Emby / Jellyfin 默认）</SelectItem>
                    <SelectItem value="specials">Specials（Plex / Kodi 惯例）</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">第 0 季的季目录：模板渲染出的 Season 00 换成 Specials；Emby / Jellyfin 两种都认。</p>
              </div>
            </div>
          </TemplateEditor>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="space-y-2">
          <Label>id 标签写法</Label>
          <Select value={idTag} onValueChange={(v) => set({ idTag: v as OrganizeSettings["idTag"] })}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="emby">Emby：[tmdbid=123]</SelectItem>
              <SelectItem value="jellyfin">Jellyfin：[tmdbid-123]</SelectItem>
              <SelectItem value="plex">Plex：{"{tmdb-123}"}</SelectItem>
              <SelectItem value="none">不写</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">目录名里带 id，媒体库刮削百分百命中；Emby 三种都认。</p>
        </div>
        <div className="space-y-2">
          <Label>冒号处理</Label>
          <Select value={colon} onValueChange={(v) => set({ colon: v as OrganizeSettings["colon"] })}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="smart">智能：「: 」→「 - 」，其余「-」</SelectItem>
              <SelectItem value="delete">删掉</SelectItem>
              <SelectItem value="dash">换成 -</SelectItem>
              <SelectItem value="spaceDash">换成「 -」</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">只处理半角冒号；中文的「：」原样保留。</p>
        </div>
        <div className="space-y-2">
          <Label>自动整理默认策略</Label>
          <Select value={value.auto ?? "off"} onValueChange={(v) => set({ auto: v as OrganizeSettings["auto"] })}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">关：只手动整理</SelectItem>
              <SelectItem value="review">生成待确认清单并通知</SelectItem>
              <SelectItem value="auto">把握大的直接执行，其余待确认</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">转存 / 追更 / 云下载 / 监控到新文件时按它来；任务上可以单独设。</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <SwitchRow
          label="预览时自动探测文件名缺标签的视频"
          description="模板用了 {resolution} {videoCodec} {audio} {hdr} 而文件名里没有时，读那个视频的文件头（几 MB）补上；读过的有缓存，大库第一次预览会慢。关着也能在清单里按作品点「探测编码」。"
          checked={value.probe === "missing"}
          onCheckedChange={(v) => set({ probe: v ? "missing" : "off" })}
        />
        <SwitchRow
          label="执行后删掉腾空的源目录"
          description="只删这次挪空的目录；范围目录本身是发布目录或季目录时也一起删，任务根目录和 inbox 这种收件箱目录不删。"
          checked={value.cleanupEmptyDirs !== false}
          onCheckedChange={(v) => set({ cleanupEmptyDirs: v })}
        />
        <SwitchRow
          label={`花絮挪进作品目录下的 ${extrasDirName}/`}
          description="预告、NCOP、sample、Featurettes 目录里的文件跟着正片走；关掉就留在原处，旧目录也就删不掉。"
          checked={value.extras !== "keep"}
          onCheckedChange={(v) => set({ extras: v ? "move" : "keep" })}
        />
        <SwitchRow
          label={`二级分类（${"{category}"} 那一层）`}
          description="按 TMDB 的类型 / 国家 / 语言分到 动画电影、国产剧 这类子目录；关掉时模板里的分类段自动消失。"
          checked={catsEnabled}
          onCheckedChange={(v) =>
            set({
              categories: {
                ...(value.categories ?? {}),
                enabled: v,
                movie: parseCategoryLines(movieCats),
                tv: parseCategoryLines(tvCats),
              },
            })
          }
        />
      </div>

      {value.extras !== "keep" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Label htmlFor={extrasId}>花絮目录名</Label>
          <Input id={extrasId} value={extrasDir} placeholder="extras" className="h-8 w-40 font-mono text-xs" onChange={(e) => set({ extrasDir: e.target.value })} />
          <span className="text-muted-foreground">Emby / Jellyfin 认 extras；Plex 只认 Other、Featurettes 这几个固定名字；不能带斜杠，留空就是 extras。</span>
        </div>
      )}

      {catsEnabled && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>电影分类</Label>
            <Textarea
              rows={6}
              className="font-mono text-xs"
              value={movieCats}
              onChange={(e) => {
                setMovieCats(e.target.value);
                set({ categories: { ...(value.categories ?? {}), movie: parseCategoryLines(e.target.value) } });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label>剧集分类</Label>
            <Textarea
              rows={6}
              className="font-mono text-xs"
              value={tvCats}
              onChange={(e) => {
                setTvCats(e.target.value);
                set({ categories: { ...(value.categories ?? {}), tv: parseCategoryLines(e.target.value) } });
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground md:col-span-2">
            每行一条，从上到下第一条命中的生效；上面模板示例里的分类层就是按这里算的
            <FieldHint label="分类规则怎么写">
              每行一条，从上到下第一条命中的生效，没有条件的那条是兜底：
              <code className="mt-1 block break-all">名称: genre=16,99; country=CN,TW; lang=zh</code>
              <span className="mt-1 block">genre 是 TMDB 的类型 id（16 动画、99 纪录片、10764 真人秀、10767 脱口秀）。</span>
            </FieldHint>
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label>自定义识别词</Label>
        <Textarea
          rows={5}
          className="font-mono text-xs"
          value={rulesText}
          onChange={(e) => {
            setRulesText(e.target.value);
            set({ rules: e.target.value.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()) });
          }}
          placeholder={"高清剧集\nFrieren => 葬送的芙莉莲\n葬送的芙莉莲 - <> [ >> EP-12\n某某剧 第二部 => {[tmdbid=95396;type=tv;s=2]}"}
        />
        {ruleErrors.length > 0 && (
          <ul className="space-y-0.5 text-xs text-destructive">
            {ruleErrors.map((e, i) => (
              <li key={i} className="break-all">{e}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          每行一条，四种写法
          <FieldHint label="识别词怎么写">
            <span className="block">
              <code>屏蔽词</code>
            </span>
            <span className="mt-1 block">
              <code>被替换词 =&gt; 替换词</code>
            </span>
            <span className="mt-1 block break-all">
              <code>前定位词 &lt;&gt; 后定位词 &gt;&gt; EP+12</code>（集数偏移）
            </span>
            <span className="mt-1 block break-all">
              <code>被替换词 =&gt; {"{[tmdbid=123;type=tv;s=2]}"}</code>（直接指定）
            </span>
          </FieldHint>
        </p>
      </div>

      <SkipDirs />
    </section>
  );
}
