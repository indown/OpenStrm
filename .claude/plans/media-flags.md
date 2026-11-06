# 媒体信息标签的 UI 优化（用户：「2160p HEVC DV TrueHD 7.1 Atmos 这些探测信息可以用好看的图标吗」）

## 起因

2026-11-05 用户看完 v2.24.1 的探测结果后问：这些探测信息能不能用好看的图标，页面别的地方能不能也放这些标识。分析现状：

- 探测结果只在整理页「看文件」表格里以一行灰字出现（`UnitList.tsx` 的「探测到 2160p HEVC DV TrueHD 7.1 Atmos」），作品卡片、run 头部、strm 页都没有。
- 前端只拿到 `MediaProbeTags` 四个字符串；后端 `media_probes` 里存着容器、时长、宽高、位深、帧率、码率、全部音轨（编码 / 声道 / 语言 / Atmos）、字幕语言、是否截断、是不是 Emby 回填。
- 同一类标签已经有三种画法：搜索结果行、收藏夹作品弹框、收藏夹命中列表是细边框小字，HDHive 弹框是灰底圆角块，整理页是纯文字。
- 文件名说 2160p、实测 1080p 这种冲突现在被静默吞掉（模板按文件名优先）。

图标调研：装的 lucide 没有按标签（4K / HDR / 编码 / 音频格式）的图标，只有 Monitor / AudioLines / Captions / Disc3 这类分类图标；别的图标库也没有一套能把这些标签都覆盖、风格又和 lucide 对得上的。所以标签以文字旗标为主，图标只用来分组，和 Jellyfin / Emby / Plex 的做法一致。

用户看过两张本机渲染的对比图后选了「lucide 分类图标 + 自画的分家淡彩旗标」，不引新图标库；实色底的旗标只用在海报角标。

## 方案

### 旗标组件（前端）

`components/media-flags.tsx`：`<MediaFlags flags grouped? max? />`。

- 一枚旗标 = `{ label, family, title? }`，family 是 `video | hdr | audio | subs | source | plain | warn`。
- 样式：`h-5 px-1.5 rounded border font-mono text-[11px] font-medium uppercase tracking-wide tabular-nums`。颜色只走 token：
  - video `border-flag-video/35 bg-flag-video/10 text-flag-video`，hdr 同理用 `flag-hdr`，audio 用 `flag-audio`；
  - subs / source / plain：`border-border text-muted-foreground`；
  - warn：`border-warning/30 bg-warning/12 text-warning`，不大写、用 sans。
- `grouped` 时按组摆：画面（video + hdr，图标 Monitor）、声音（audio，AudioLines）、字幕（subs，Captions）、片源（source，Disc3）、其它（plain，无图标）、警告（warn，无图标）。不 grouped 就按传入顺序平铺，没有图标（搜索行、收藏夹）。
- `max`：超过的折成「+N」，整串放 title。
- 新 token：`--flag-video` / `--flag-hdr` / `--flag-audio`，浅色 `oklch(0.55 0.13 230)` / `oklch(0.62 0.15 70)` / `oklch(0.55 0.16 300)`，暗色 `oklch(0.78 0.11 230)` / `oklch(0.82 0.14 80)` / `oklch(0.78 0.12 300)`；`@theme inline` 加 `--color-flag-*`。这是全局 token 改动，验证要带着海报墙页面。

`lib/media-flags.ts`（纯函数，有单测）：

- `displayResolution`：2160p → 4K，4320p → 8K，其余原样；
- `flagsFromTags(tags)`：搜索 / 收藏夹的标题标签（`services/pansou/tags.ts` 的词）分家：4K / 1080p / 720p → video；HDR / 杜比视界 → hdr（杜比视界显示 DV）；全景声 / 国语 / 粤语 → audio（全景声显示 Atmos）；中字 → subs；原盘 / REMUX / WEB / 蓝光 / 枪版 → source；季 / 集 / 完结 / 合集 / 体积 → plain；
- `flagsFromBrief(media, conflicts)`：文件表用。画面：分辨率、编码、`10bit`、HDR；声音：`编码 声道`、Atmos、主音轨语言；字幕：语言去重最多 3 个 + 「+N」；冲突一枚 warn「文件名写 X · 实测 Y」；
- `flagsFromUnitMedia(media)`：作品卡片用。某项只有一种取值就一枚，多种就每种一枚带「×N」；冲突数 > 0 一枚 warn「N 个文件名和实测对不上」；
- `briefTitle(media)`：悬停全文「读文件头探测 · 3840×2160 · 10bit · 23.98 fps · 78 Mbps · 主音轨 TrueHD 7.1 Atmos en · 4 条音轨 · 字幕 zh/en · 只读了前 96 MB」/「Emby 回填 · …」。

### 词表归一

显示层统一：HEVC / H.265 / x265 → HEVC，H.264 / AVC / x264 → H.264，EAC3 / DD+ → DDP，杜比视界 → DV，全景声 → Atmos。后端冲突比较用同一套归一（`media-info.ts` 的 `codecFamily`）。

### 后端：精简媒体信息、冲突、单元汇总

shared 新类型（`types/organize.ts`）：

- `MediaBrief`：resolution / width / height / videoCodec / bitDepth / frameRate / hdr / audioCodec / channels / atmos / audioLanguage / audioCount / subtitleLanguages / container / durationMs / bitrateKbps / source（`probe` 读文件头、`emby` 回填，按 `bytesRead` 分）/ truncated。
- `MediaConflict { kind: resolution | videoCodec | hdr; named; probed }`。
- `OrganizeUnitMedia { videos; probed; resolution / videoCodec / bitDepth / hdr / audio: MediaValueCount[]; conflicts }`，取值是模板口径（文件名优先、探测兜底），按出现次数降序；bitDepth 只有实测值。

落点：

- `services/media/probe.ts`：`mediaBrief(probe)`；`cachedProbeTags` 改成 `cachedProbes`（回 `MediaProbe`），调用方自己取 tags 和 brief。
- `services/organize/media-info.ts`（新）：`mediaConflicts(tags, brief)`、`unitMedia(unit)`、`codecFamily`。冲突只比两边都有的：分辨率按归一后的档（4K → 2160p、1080i 当 1080p；UHD 不比，它在发布组命名里常指片源）；编码按家族（10bit / 8bit / Hi10P 不是编码，跳过）；HDR 只在三种情况算：文件名有 HDR 类标签而实测是 SDR、文件名写 DV 而实测不是 DV、文件名写 SDR 而实测有 HDR。音频不比（多音轨时文件名写哪条都对）。
- `units.ts` `UnitFile.media?: MediaBrief`，`preview.ts` 的 `attachProbes` / `autoProbe` / `probeUnits` 三处连 `probe` 一起填。
- `preview.ts`：`decorateItemsWithProbes` 改名 `decorateItemsWithMedia`，项上带 `media` + `conflicts`（`OrganizeItem.probe` 去掉，界面没别的地方用）；新增 `decorateUnitsWithMedia`，`query.ts` 的 `getRunDetail` 用它。都只在 planState 还在内存时有，和原来一样。
- 智能体工具不改（`organize-view.ts` 只挑固定字段）。

### 替换现有四处

搜索结果行 `ResultRow.tsx`、收藏夹弹框 `LibraryWorkDialog.tsx`、收藏夹命中 `LibraryHits.tsx`、HDHive 弹框 `HdhiveSearchDialog.tsx`：标签换成 `<MediaFlags flags={flagsFromTags(tags)} max={…} />`。搜索行正在筛的标签加 `ring-1 ring-current`。排序沿用 `displayTags`。

### 整理页

- 作品卡片：标题行下面加一行 `<MediaFlags grouped flags={flagsFromUnitMedia(unit.media)} />`，title 写「N 个视频里 M 个读过文件头，其余按文件名」。
- 文件表：「原来」列下面那行灰字换成 `<MediaFlags grouped flags={flagsFromBrief(it.media, it.conflicts)} />`，整行 title 用 `briefTitle`。

### 不做

- 命名模板的优先级不动（文件名仍优先于探测）：冲突只提示，改不改名字是另一个产品决策，先看真机上冲突多不多。
- 不引第三方图标库，不用图片素材。
- strm 页的行旗标 / 文件详情面板媒体信息块、收藏夹海报角标、run 头部探测覆盖率：留到下一阶段，追加在本文件末尾。
- 不持久化单元汇总（和项上的探测标签一样，只在预览还在内存时有）。

## 测试

- 后端单元：`services/media/probe.test.ts` 加 `mediaBrief`（主音轨 / Atmos / 字幕去重 / Emby 回填 source / truncated）；`services/organize/media-info.test.ts`（冲突三类的正反例、UHD 不比、10bit 不比、单元汇总的分布与 conflicts 计数）。
- 后端集成：`routes/organize/organize.itest.ts` 探测编码一测改成断言 `media` / `conflicts`，详情里单元带 `media` 汇总；`run.itest.ts` 探测两测跟着改断言。
- 前端：`lib/media-flags.test.ts`（分家、归一、折叠、冲突文案、悬停全文）。
- 浏览器冒烟：浅色 / 暗色、宽 / 窄，整理页（卡片 + 文件表，带海报墙）、搜索结果、收藏夹弹框、HDHive 弹框。

## 进度

- [x] 后端：类型、brief、冲突、汇总、装饰、用例（2026-11-05）
- [x] 前端：token、lib、组件、四处替换、整理页两处、用例（2026-11-05）
- [x] typecheck / lint / 全量测试（2026-11-05，后端 1734 / 前端 18）
- [x] 浏览器冒烟（2026-11-05，假后端 + dev）
- [x] 评审（2026-11-06，两个阶段一起评，15 条确认项 + 截掉的性能 / 重复项全修，见末节「评审修补」；修补未提交）
- [ ] rc

## 实施记录（2026-11-05）

**后端**

- shared `types/organize.ts`：`MediaBrief`、`MediaConflict`、`MediaValueCount`、`OrganizeUnitMedia`；`OrganizeItem.probe` 换成 `media?` + `conflicts?`（界面没别的地方用 probe，智能体工具只挑固定字段）；`OrganizeUnit.media?`。
- `services/media/probe.ts`：`mediaBrief(probe)`（主音轨、字幕语言去重、`bytesRead` 0 算 Emby 回填）；新增 `cachedProbes()` 回整份 `MediaProbe`，`cachedProbeTags` 留着当薄包装（`library-new.itest` 还在用）。
- `services/organize/media-info.ts`（新）：`codecFamily` / `resolutionBucket` / `mediaConflicts` / `unitMedia`。和方案一致；汇总里分辨率按档、编码按家族归一（x265 和 HEVC 不算两种），bitDepth 只有实测值。
- `units.ts` `UnitFile.media`；`preview.ts` 三处（`attachProbes` / `autoProbe` / `probeUnits`）连 probe 一起填；`decorateItemsWithProbes` 改名 `decorateItemsWithMedia`（项上带 media + conflicts）。
- 和方案不同：`decorateUnitsWithMedia` 放在 `run-state.ts`（`planStates` 旁边），不放 preview.ts —— `query.ts` 只 import run-state，不用引 preview 绕圈；`getRunDetail` 的 units 经它装饰。
- 用例：`probe.test`「mediaBrief」、`media-info.test`（3 条：归一 / 冲突 / 汇总）、`organize.itest` 探测编码一测改断言 media + 单元汇总，加 `probe-conflict` 夹具（文件名 1080p x264、实测 2160p HEVC → 两条冲突、汇总按文件名口径、conflicts 计 1）。`run.itest` 没动（没断言过 probe）。后端全量 1734 过，typecheck / lint 干净。

**前端**

- `globals.css`：`--flag-video` / `--flag-hdr` / `--flag-audio` 浅色暗色各一套 + `@theme inline` 的 `--color-flag-*`，值和方案一致。
- `lib/media-flags.ts`（纯函数）+ `components/media-flags.tsx`（`Flag` / `MediaFlags`，grouped 时画面 / 声音 / 字幕 / 片源四组各一枚 lucide 图标）。
- 替换：`ResultRow`（正在筛的旗标 `ring-1 ring-current`）、`LibraryWorkDialog`、`LibraryHits`、`HdhiveSearchDialog`（四组数组经 `flagsFromHdhive`）；整理页 `UnitList` 卡片标题下一行汇总旗标、文件表「原来」列下面一行实测旗标 + 冲突，悬停全文 `briefTitle` / `unitMediaTitle`；`probeLine` 删了。
- 和方案不同：搜索 / 收藏夹的「杜比视界」「全景声」没改写成 DV / Atmos，和筛选按钮的字一致，只上了 HDR / 声音两家的颜色。
- 冒烟发现并修：字幕语言按显示名再去一次重（zh-Hans / zh-Hant 都是「中」，原来会画成「中 / 中」），`subtitleLabel` 加 Set + 用例。
- 用例 `lib/media-flags.test.ts` 7 条；前端 18 条过，typecheck / lint 干净。

**浏览器冒烟（2026-11-05）**：没起真后端，用 scratchpad 里几十行的假 JSON 服务监听 4000（整理 run 详情 / 项、任务、设置、收藏夹搜索、PanSou 结果），`next dev -p 3223` 的 rewrites 转过去；登录态靠 localStorage 里一个 payload 带 exp 的假 JWT。看过：整理页作品卡片（电影一致 → `4K HEVC 10bit DV | DDP 5.1 Atmos`；剧集不一致 → `4K ×7 1080p ×3 … | 1 个文件名和实测对不上`；没识别的卡片没有旗标）、文件表三种行（齐全 / 三条冲突 / 没探测）、悬停 title 文案、搜索页收藏夹命中和 PanSou 行、筛选选中态，浅色 + 暗色，390px 用 public 下临时的 iframe 页看了（分组整体换行）。没看：HDHive 弹框、收藏夹作品弹框（同一组件、不分组画法已在搜索行验过）、海报墙页面（这次只加了三个旗标 token，没动画布 / muted / brand）。假后端、iframe 页、dev 进程都已清掉。

## 第二阶段：strm 页、收藏夹海报角标、探测覆盖率（2026-11-05，用户：「继续做吧」）

### 方案

**strm 页**

- 后端 `POST /api/strm/media { taskId, paths[] }`（read 档，最多 500 条）：每个 .strm 读内容、`inspectStrm` 拿网盘路径（解析得出的，解析不出就用应有的），按账号 + 绝对路径查 `media_probes` 的 `path` 列，回 `{ media: Record<相对路径, MediaBrief> }`。同一路径有两行（按 id 记的和 Emby 回填的）时取读过文件头的，再按 probedAt 新的。读不到的文件、不是 strm 的直接不在结果里。
- `GET /api/strm/file` 的 `StrmFileInfo` 多带 `media?`，同一条查法。
- 仓库 `getMediaProbesByPaths(account, paths)`：`path` 列没有索引，表就几千行，IN 查询够用，不加迁移。
- 前端：浏览 / 搜索列出来的 strm 行按 200 一批拉媒体信息，按路径缓存在 hook 里；行里名字下面一排不分组的旗标（最多 6 枚，整串在 title）；文件详情面板加「媒体信息」块：分组旗标 + 来源 / 画面 / 帧率 / 码率 / 时长 / 容器 / 音轨数 / 字幕一列小字；没有的说一句到整理页按作品「探测编码」或等 Emby 播放后回填。
- 局限写清：按 id 记的探测行里 `path` 是探测当时的路径，文件被整理挪过之后按新路径查不到（Emby 回填的会按新路径再写一行）。

**收藏夹海报角标**

- `workGroups` 多聚合一列 `group_concat(tags)`，并成 `WorkGroup.tags`（去重）；`LibraryWork.tags?`（非空才带）。
- `WorkCard` 右下角最多两枚：分辨率一枚（4K），HDR 一枚（杜比视界 → DV，否则 HDR），用 `Flag` 组件压在 `bg-background/85 backdrop-blur` 上，和现有「待确认 / 版本数 / 已有」三个角标同一种底。
- 没认出的单元自己一张卡：用它自己的 tags。

**探测覆盖率**

- 整理 run 头部徽标行加一枚「探测过 M / N 个视频」（按单元 `media.probed / videos` 加总；只在 tmdb 口径、可编辑、有视频时出现）；M < N 时是个按钮，点了对勾着的作品探文件名缺模板标签的视频（复用 `probeMissing`）；M = N 就只是徽标。

### 不做

- strm 页不触发探测（只读缓存）；要探到整理页去。
- 海报角标不画编码 / 音频（4K / HDR 两枚够了，多了压住海报）。
- 不给 `media_probes.path` 加索引（不发迁移）。

### 测试

- `strm.itest`：种两行探测缓存（`id:` 键 + `path:` 键，同一路径取读过文件头的那行），`/api/strm/media` 回 ep1 的 brief、ep2（内容是别的前缀）不在结果里、不是 strm 的路径不在、超过 500 条 400；`/api/strm/file` 带 media。
- `library-works-view.itest`：两个来源的同一部，tags 合并去重。
- 前端 `media-flags.test`：`briefDetails`、`posterMarks`。
- 冒烟：strm 页列表行 + 详情面板，收藏夹海报墙角标，整理 run 头部覆盖率徽标；浅暗各一遍。

### 进度

- [x] 后端：仓库查法、strm media 接口、file 带 media、works tags、用例（2026-11-05）
- [x] 前端：hook / 行 / 面板、海报角标、覆盖率徽标、用例（2026-11-05）
- [x] typecheck / lint / 全量（2026-11-05）
- [x] 冒烟（2026-11-05，假后端 + dev）
- [x] 评审（2026-11-06，两个阶段一起评，15 条确认项 + 截掉的性能 / 重复项全修，见末节「评审修补」；修补未提交）
- [ ] rc

### 实施记录（2026-11-05）

**后端**

- `db/repositories/media-probes.ts` `getMediaProbesByPaths`（按 path 列 IN 查，400 一批）；`services/media/probe.ts` `cachedProbesByPath`（同一路径两行取读过文件头的，再取新的）。
- `services/strm/manage.ts`：`readStrm` 带 `media`；新 `mediaOf(task, rels)`（只认 .strm，读内容 → `inspectStrm` → 解析出的路径优先、应有的兜底 → `normalizePath` 成绝对路径查缓存；读不到 / 不是 strm / 没缓存的不在结果里）；`STRM_LIMITS.MEDIA_MAX = 500`。路由 `POST /api/strm/media`（read 档）。
- 和方案不同：收藏夹单元没有 tags 列，单元的标签一直是读的时候从目录名 / 样本文件名认的。所以 `workGroups` 聚合的是 `json_group_array(json_array(raw_name, sample_file))`，在仓库层用 `services/pansou/tags.ts` 新抽出来的 `unitTags(rawName, sampleFile)` 算并集（和 `works.ts` 单元视图同一个口径，「第 N 季」不算）；`groupToWork` / `unitToWork` 非空才带 `tags`。按组算一次，不在每次列作品时重算（derivedOf 每个 generation 都会重映射全部分组）。
- shared：`StrmFileInfo.media?`、`StrmMediaResult`、`LibraryWork.tags?`。
- 用例：`strm.itest`「媒体信息」（两行同路径取读过文件头的、别的前缀 / 不是 strm / 没缓存的不在、file 带 media、空数组和 501 条 400）；`library-works-view.itest`「作品的 tags」（两个来源并集、季不算、增量和重建一致；`listWorks` 要带 view / offset / limit，不带 limit 列表是空的）。全量 1736 过，typecheck / lint 干净。

**前端**

- `lib/api.ts` `strm.media`；`use-strm-browser.ts` 按列出来的 strm 行 200 一批拉、按路径记着不重复问、换任务清空；`page.tsx` `EntryName` 名字下面一排不分组旗标（最多 6 枚，整串在 title），表格和卡片共用；`StrmFileSheet` 加「媒体信息」块（分组旗标 + `briefDetails` 一列小字），没有的说去整理页探或等 Emby 回填。
- `LibraryWorks.tsx` 作品卡右下角 `posterMarks`（4K 一枚、DV / HDR 一枚）用 `Flag` 压在 `bg-background/85 backdrop-blur` 上；`RunView.tsx` 头部「探测过 M / N 个视频」，M < N 且可编辑时是按钮，点了对勾着的作品 `probeMissing`。
- `lib/media-flags.ts` 加 `briefDetails` / `posterMarks`，用例各一条；前端 20 条过，typecheck / lint 干净。

**冒烟（2026-11-05，假后端 + dev，和第一阶段同一套）**：strm 页卡片视图三种行（齐全 / 截断 / 没有）、详情面板媒体信息块、收藏夹海报墙角标（4K + DV、HDR、没有）、整理 run 头部「探测过 5 / 11 个视频」按钮，浅色暗色各看了一遍。这次 `resize_window` 把窗口定在了 606px 没再放得开，所以 strm 表格视图没看到（行里的名字组件和卡片视图是同一个）。假后端里 `/api/follow` 要回 `{ follows: [] }` 不然收藏夹页在 followedKeys 那里炸，记一笔。假后端、dev 进程都已清掉。

## 评审修补（2026-11-06，用户：「review一下」）

评审（/code-review，6614341..HEAD）回来 15 条确认项，外加几条被篇幅截掉的性能 / 重复代码项，按规矩全部修完。后端全量 1742 过、前端 20 过，typecheck / lint 干净，卫生脚本 ok。修补未提交。

**strm 页按路径查缓存（`services/strm/manage.ts` 的 `remoteAbsOf`）**

- 开了路径编码的任务：文件名本身不用编码时 inspect 把目录段的 `%20` 原样留着，和整理页记的（解码后的）路径对不上，整页没旗标 → 内容和应有的一字不差就按本地路径算；解析出来的按任务的编码开关解码。
- `normalizePath` 会削掉段首尾的空白，整理页写缓存用的 `absOf` 不削（夸克 / OpenList 目录名带空格是真实存在的）→ 改成和 `absOf` 同一拼法。
- 文件名对不上（name-mismatch）的 strm 指向的是别的文件，原来拿「应有的那个文件」的缓存充数 → 只有前缀对不上才用应有的兜底；共用输出目录的兄弟任务的 strm 不查（同 scan / verify 的 `isForeignStrm`）。
- 一页两百个 strm 每个都走 `resolveManagedPath`（两次 realpath，网络盘上要几百毫秒）→ 根解析一次，每个文件只做词法检查（只读内容当查缓存的键、什么都不写）。
- 用例：`strm.itest` 新增一条（编码任务的两种内容、段尾空格、name-mismatch、兄弟任务、同一路径两行大小不同取新的）。

**缓存行的选取和跟随**

- `cachedProbesByPath`：两行记的大小都有又不一样，说明换过文件，取新的；否则读过文件头的优先、再取新的（原来读过文件头的无条件赢，换了文件还显示旧的实测）。
- 整理执行 / 撤销后缓存行的 path 跟着文件走（`db/repositories/media-probes.ts` 的 `repathMediaProbes`，按路径记的行连键一起换），和 `repathMatches` 放在同一处；`organize.itest` 执行 / 撤销那条加了断言。
- `media_probes` 加 `(account_name, path)` 索引：**迁移 0029**（strm 页按路径查原来是扫账号的全部行；这次发版要带迁移，发版说明记一句）。

**冲突判定和汇总口径（`services/organize/media-info.ts`）**

- Emby 自己的流只有 `VideoRange` + `ExtendedVideoType`，`VideoRangeType` 是 Jellyfin 的字段，回填出来一律是「HDR」，DV 片全被判成「文件名写 DV · 实测 HDR」→ 回填读 `ExtendedVideoType`（DolbyVision / Hdr10 / Hdr10Plus / Hlg / None）；实测只知道是 HDR 的分不出是不是 DV，不算冲突。
- 汇总只数正片：花絮 / 样片（人改判的听人的，`units.ts` 新抽的 `asExtraFile`，plan.ts 同一口径）和取消勾选的不算（`run-state.ts` 的 `mediaSkipOf`）；探测目标也同样过滤（花絮不套模板，探了没处用）。
- 文件名标签归一后为空的（10bit 占了编码位、UHD 占了分辨率位）退到实测，不再在汇总里消失；文件名写 SDR 的不进 hdr 分布。
- 音频按统一写法归一（`audioKey`：EAC3 / DD+ → DDP、DD → AC3、DTS-HD MA → DTS-HD、顺序统一成「编码 声道 Atmos」），文件名和实测的同一种音频不再分成两条；前端的 `displayCodec` / `displayAudioCodec` 随之删掉，归一只在后端一处。
- 8K：`resolutionLabel` 加 4320p 档，文件名写 8K 的不再报冲突。
- `OrganizeUnitMedia.lacking`：文件名缺模板标签、又没探过的正片数。run 头部「探测过 M / N」只在 lacking > 0 时是按钮——原来 M < N 就是按钮，发布组命名的库点了永远是「没有要探的视频」。
- `mediaBrief`：und / zxx 这种占位语言码不当语言（Emby 照抄 ffprobe 的 tag）。

**前端**

- strm 页媒体信息 hook：问成了才记「问过」，在问的另记一份，没问成的（超时、5xx）下次列到再问；不再因为 `visible` 变化（筛选、进子目录）丢掉在途的响应；刷新 / 换目录忘掉重问（整理页探过 / Emby 回填过的这时才会出现）；换任务靠 taskId 判丢弃。`media` 改成 Map：根目录下叫 constructor 的条目会撞上对象原型，整页炸掉。
- `briefTitle` 改成从 `briefDetails` 生成（一行一项，含编码 / 位深 / HDR / 主音轨，方案里原来承诺的 10bit / 主音轨补上了），两份格式合一；`MediaFlags` 组件的分组 / 不分组合成一条路径。
- `works.ts` `unitToWork` 的 `unitTags` 只算一次；仓库层的行映射抽成 `toRow`。

**没改的（说明）**

- 全量重建 `workGroups` 时按名字认标签约 +0.4 s / 10 万单元（评审量的）：只在启动预热和整个作废重建时发生，不在请求路径上；增量维护只重算变了的那一组。
- 前端 `flagsFromTags` 的家族表和后端 `tags.ts` 的词表仍各一份：一个是认词、一个是上色，职责不同。

**冒烟（2026-11-06，假后端 + dev 3223，窗口 1920 宽）**：按 CLAUDE.md「改全局样式要带着海报墙看」补了三页——任务页（`/api/strm/posters/all` 回 12 张）、strm 页（根目录 12 个作品目录的墙）、整理页（识别出的 10 部作品的海报），浅色 / 暗色各一遍，墙都真的画出来了（页面里 `/api/posters/` 的 img 180–200 张全部加载完）。顺带看了：strm 表格视图的行旗标（上次窗口窄只看到卡片视图）、详情面板的媒体信息块、点「刷新」后假后端日志里 list 后面紧跟着一次 media（忘掉重问生效）、整理 run 头部「探测过 13 / 19 个视频」按钮和它的 title、作品卡片旗标。没看：lacking = 0 时头部徽标的非按钮态（只是三元分支，typecheck 过）、8K 旗标（单测覆盖）。假后端、dev 进程、标签页都清掉了。

## 发布（2026-11-06）

用户：「提交发正式版吧」。`5f1d88b` `chore(release): v2.25.0` = `f0e606f` feat(media) 两阶段的媒体信息标签 + `1cf1d63` docs(plans) + `b5265fd` fix(media) 评审修补 + `33ec994` docs(plans) + 三个 package.json 升到 2.25.0（shared 仍 2.0.0）；tag 注释 `v2.25.0`。`git push origin v2 v2.25.0`，main 从 `36c368f` 快进到 `5f1d88b`（main == v2 == v2.25.0）。**带迁移 0029**（`media_probes` 加 (account_name, path) 索引，没有数据改动）；新接口 `POST /api/strm/media`；没有新设置键。发前做过：后端全量 1742 / 前端 20、typecheck / lint、假后端浏览器冒烟（含海报墙三页浅暗）、评审 15 条全修；没做真机（这次改动不碰网盘，只读缓存和文件头探测结果）。升级说明交用户手动贴，要点：整理页作品卡片 / 文件表、strm 页、搜索 / 收藏夹 / HDHive 的探测与文件名标签统一成旗标；文件名和实测对不上会提示；strm 页按 strm 指向的路径查探测缓存（整理页探过或 Emby 回填过的才有）；收藏夹海报角标 4K / DV / HDR；run 头部「探测过 M / N」按钮；命名模板的优先级不变（仍文件名优先）。

结果：11:10 盯梢脚本回 RELEASE_OK——Release 四作业（Typecheck, lint and tests / Build amd64 / Build arm64 / Merge manifest and release）+ CI@v2 + CI@main 全绿（11:00 推 → 11:10），Docker Hub `v2.25.0` 与 `latest` 同为 `c7aa598bd933`（amd64 + arm64），GitHub Release 非 prerelease、是仓库最新。main == v2.25.0；这条记录之后作为 docs(plans) 提交推到 v2，main 不动。
