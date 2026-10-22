"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { OrganizeTemplatePreview } from "@openstrm/shared";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { STRUCTURES, buildTemplate, detectStructure, type MediaKind, type ServerKey, type StructureKey } from "@/lib/organize-presets";
import { hasTopLevelSlash, joinMovie, joinTv, splitMovie, splitRenderedPath, splitTv, type TvParts } from "@/lib/template-parts";
import { templateVarsFor } from "@/lib/template-vars";

export interface TemplatePreviewData {
  /** 样例渲染出来的路径 */
  path: string;
  /** 样例的变量值（变量表「本例」列） */
  vars: Record<string, string>;
  errors: string[];
}

type FieldKey = "dir" | "season" | "file" | "raw";

const VARS_OPEN_KEY = "openstrm.templateVars.open";

function readVarsOpen(): boolean {
  try {
    return localStorage.getItem(VARS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** 一个类型（电影 / 剧集）的命名模板面板：预设、按层拆开的几格、示例、变量表。设置页和任务弹框共用 */
export function TemplateEditor({
  type,
  value,
  onChange,
  server,
  fallback,
  mode,
  preview,
  disabled = false,
  children,
}: {
  type: MediaKind;
  /** 存的那条模板；空串 = 没填（设置页按默认模板算，任务弹框是跟随全局） */
  value: string;
  onChange: (next: string) => void;
  /** 预设按哪个服务器生成文件名细节 */
  server: ServerKey;
  /** value 为空时实际生效的模板：设置页是默认模板，任务弹框是全局的 */
  fallback: string;
  mode: "settings" | "task";
  preview?: TemplatePreviewData | null;
  disabled?: boolean;
  /** 面板底部塞的额外控件（剧集：集标题、特别篇目录名） */
  children?: ReactNode;
}) {
  const id = useId();
  const following = mode === "task" && value.trim() === "";
  const effective = value.trim() ? value : fallback;
  const movie = type === "movie";
  // 两种类型统一成三格，电影的季那格永远是空串（拼的时候不用）
  const split = movie ? splitMovie(effective) : splitTv(effective);
  const parts = split ? { dir: split.dir, season: (split as Partial<TvParts>).season ?? "", file: split.file } : null;
  const raw = parts === null;
  const structure: StructureKey | "custom" = detectStructure(type, effective, server) ?? "custom";
  const selectValue = following ? "global" : structure;
  const fallbackStructure = detectStructure(type, fallback, server);
  const structures = STRUCTURES[type];
  const structureLabel = (key: StructureKey | null) => structures.find((s) => s.key === key)?.label ?? "自定义写法";

  const refs = { dir: useRef<HTMLInputElement>(null), season: useRef<HTMLInputElement>(null), file: useRef<HTMLInputElement>(null), raw: useRef<HTMLInputElement>(null) };
  const focused = useRef<FieldKey>("file");
  /** 变量表插入之后把光标放回插入点后面（React 重新渲染之后） */
  const caret = useRef<{ key: FieldKey; pos: number } | null>(null);
  useEffect(() => {
    const c = caret.current;
    if (!c) return;
    caret.current = null;
    const el = refs[c.key].current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(c.pos, c.pos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const [varsOpen, setVarsOpen] = useState(false);
  useEffect(() => setVarsOpen(readVarsOpen()), []);
  const toggleVars = () => {
    const next = !varsOpen;
    setVarsOpen(next);
    try {
      localStorage.setItem(VARS_OPEN_KEY, next ? "1" : "0");
    } catch {
      /* 私密窗口之类：不记就不记 */
    }
  };

  const emit = (next: { dir?: string; season?: string; file?: string }) => {
    if (!parts) return;
    const p = { dir: next.dir ?? parts.dir, season: next.season ?? parts.season, file: next.file ?? parts.file };
    onChange(movie ? joinMovie(p) : joinTv(p));
  };

  const pick = (key: string) => {
    if (key === "global") onChange("");
    else if (key === "custom") onChange(effective);
    else onChange(buildTemplate(type, key as StructureKey, server));
  };

  /** 变量表点一行：插到最后聚焦的那格的光标处；跟随全局时先把全局的抄过来再插 */
  const insert = (name: string) => {
    const token = `{${name}}`;
    const key: FieldKey = raw ? "raw" : focused.current === "raw" ? "file" : focused.current;
    const el = refs[key].current;
    const current = key === "raw" || !parts ? effective : parts[key as "dir" | "season" | "file"];
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? start;
    const next = current.slice(0, start) + token + current.slice(end);
    caret.current = { key, pos: start + token.length };
    if (key === "raw") onChange(next);
    else if (key === "dir") emit({ dir: next });
    else if (key === "season") emit({ season: next });
    else emit({ file: next });
  };

  const fieldProps = (key: FieldKey) => ({
    ref: refs[key],
    onFocus: () => {
      focused.current = key;
    },
    disabled,
    readOnly: following,
    className: `font-mono text-xs ${following ? "bg-muted/40 text-muted-foreground" : ""}`,
  });

  const rendered = preview ? splitRenderedPath(preview.path) : null;
  const seasonPart = parts?.season ?? "";
  const fileSlash = !!parts && hasTopLevelSlash(parts.file);
  const seasonSlash = !movie && hasTopLevelSlash(seasonPart);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`${id}-preset`}>预设</Label>
        <Select value={selectValue} onValueChange={pick} disabled={disabled}>
          <SelectTrigger id={`${id}-preset`} size="sm" className="w-full text-xs sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[60]">
            {mode === "task" && <SelectItem value="global">跟随全局设置（{structureLabel(fallbackStructure)}）</SelectItem>}
            {structures.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.label}
              </SelectItem>
            ))}
            <SelectItem value="custom" disabled={!following}>
              自定义写法
            </SelectItem>
          </SelectContent>
        </Select>
        {!following && structure !== "default" && (
          <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => pick("default")} disabled={disabled}>
            <RotateCcw className="size-3.5" />
            恢复默认
          </Button>
        )}
        <p className="basis-full text-xs text-muted-foreground">
          {following ? "不给这个任务单独设；设置页改了这里跟着变" : structure === "custom" ? "改过预设里的任何一格就是它；选一个预设会整个换掉" : structures.find((s) => s.key === structure)?.hint}
        </p>
      </div>

      {raw ? (
        <div className="space-y-1">
          <Label htmlFor={`${id}-raw`}>整条模板</Label>
          <Input id={`${id}-raw`} value={effective} onChange={(e) => onChange(e.target.value)} {...fieldProps("raw")} />
          <p className="text-xs text-destructive">这条模板的 [ ] 不配对，拆不开按层编辑；改好之后会自动拆开。</p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor={`${id}-dir`}>{movie ? "作品目录" : "剧集目录"}</Label>
            <Input id={`${id}-dir`} value={parts!.dir} onChange={(e) => emit({ dir: e.target.value })} {...fieldProps("dir")} />
            <p className="text-xs text-muted-foreground">可以多层：年份目录写 {"{year}/"}，{movie ? "系列目录写 [{collection}/]，" : ""}分类目录是 {"{category}/"}。</p>
          </div>
          {!movie && (
            <div className="space-y-1">
              <Label htmlFor={`${id}-season`}>季目录</Label>
              <Input id={`${id}-season`} value={seasonPart} onChange={(e) => emit({ season: e.target.value })} {...fieldProps("season")} />
              {seasonSlash ? <p className="text-xs text-destructive">季目录只有一层；多出来的层级写到上面的剧集目录里。</p> : <p className="text-xs text-muted-foreground">留空就不建季目录，所有集直接放在剧集目录下。</p>}
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor={`${id}-file`}>文件名</Label>
            <Input id={`${id}-file`} value={parts!.file} onChange={(e) => emit({ file: e.target.value })} {...fieldProps("file")} />
            {fileSlash ? <p className="text-xs text-destructive">文件名里不能有 /，目录层级写到上面那格。</p> : <p className="text-xs text-muted-foreground">末尾要有 .{"{ext}"}；[ … ] 可选段里的变量全为空就整段丢掉。</p>}
          </div>
        </div>
      )}

      <div className="space-y-0.5 text-xs">
        <div className="text-muted-foreground">示例</div>
        {rendered ? (
          <>
            <div className="break-all">
              <span className="mr-1 text-muted-foreground">目录</span>
              {rendered.dir || "（没有目录层）"}
            </div>
            <div className="break-all">
              <span className="mr-1 text-muted-foreground">文件</span>
              {rendered.file}
            </div>
          </>
        ) : (
          <div className="text-muted-foreground">…</div>
        )}
        {preview && preview.errors.length > 0 && (
          <ul className="space-y-0.5 text-destructive">
            {preview.errors.map((e, i) => (
              <li key={i} className="break-all">
                {e}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={toggleVars}>
          {varsOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          变量（点一下插进光标处）
        </button>
        {varsOpen && (
          <div className="mt-2 overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">变量</th>
                  <th className="px-2 py-1 text-left font-medium">说明</th>
                  <th className="px-2 py-1 text-left font-medium">本例</th>
                </tr>
              </thead>
              <tbody>
                {templateVarsFor(type).map((v) => (
                  <tr key={v.name} className="border-t">
                    <td className="px-2 py-1 whitespace-nowrap">
                      <button type="button" className="font-mono text-brand hover:underline disabled:no-underline disabled:opacity-60" onClick={() => insert(v.name)} disabled={disabled} title={`插入 {${v.name}}`}>
                        {`{${v.name}}`}
                      </button>
                    </td>
                    <td className="px-2 py-1 text-muted-foreground">{v.label}</td>
                    <td className="px-2 py-1 break-all">{preview?.vars[v.name] || <span className="text-muted-foreground">（空）</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {children}
    </div>
  );
}

/** 试算结果里属于某一类的那部分：路径、变量值、带「电影模板：」「剧集模板：」前缀的错误 */
export function previewFor(preview: OrganizeTemplatePreview | null, type: MediaKind): TemplatePreviewData | null {
  if (!preview) return null;
  const prefix = type === "movie" ? "电影模板" : "剧集模板";
  return { path: preview[type], vars: preview.vars?.[type] ?? {}, errors: preview.errors.filter((e) => e.startsWith(prefix)) };
}
