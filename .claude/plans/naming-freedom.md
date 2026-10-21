# 整理的命名自由度与编辑能力（接「用户为什么用第三方整理」的分析）

> 状态：三批（A3 + B1 + B2 → A1 + A5 → A2 + B3）2026-10-19 全部实施（b8a61aa / 8a41513 / d35e7e6，迁移 0026、0027），随 **v2.18.0-rc.3**（35535ad）发出：Release 与 CI 全绿，rc 镜像 11f89afcc6d3，latest 仍是 v2.17.0，main 未动。A4 被「探测编码」（media-probe.md）替代，不做；暂缓项见各节。
> 来源：#12 的作者用别的媒体整理软件在本地改名；用户问「我们的整理哪里做得不好」。分析列了五条，用户先要看「命名自由度」和「编辑能力」这两条。

## 现状（对着代码核实过）

**命名**

- 模板只有全局两套（电影 / 剧集），`TEMPLATE_VARS` 共 25 个：category / title / originalTitle / enTitle / year / tmdbId / imdbId / idTag / season / season00 / episode / episode00 / absolute / absolute000 / episodeTitle / part / edition / resolution / source / videoCodec / audio / hdr / group / ext / originalName（最后一个设置页的说明里没写）。语法：`{var}`、可选段 `[ … ]`（里面的变量全空就整段丢掉，`/` 可以放在可选段里）、`\` 转义。没有「二选一」兜底，没有派生变量。
- 按任务只有 `libraryType` 和自动模式（`TaskOrganizeSettings`），模板、id 标签、集标题、分类、识别词都是全局的。
- 标题永远是 TMDB 的译名（`match.title`）；`TmdbDetails.aliases` 里已经有别名 + 各语言翻译，但没露出来给人选。年份同理。
- 合集：TMDB 的 `belongs_to_collection` 没拉，`OrganizeMatch` 没有合集，模板没有 `{collection}`。
- 技术标签（分辨率 / 来源 / 编码 / HDR / 压制组）只从文件名解析（`fileVars` 读 `parsed.tags`），文件名干净就全空。115 `files` 接口的 `vdi`（清晰度档位）、夸克 `file/sort` 的分辨率字段都没解析（夸克 `RawFile` 只取了 fid / name / size / category / updated_at / include_items）。
- 日期型节目：解析认得日期（`ParsedName.date`，分单元时算有集数），但规划没有对应的季集，模板也没有日期变量。

**编辑**

- 单元能改：换匹配（搜索 / 备选 / 编号）、季覆盖、集偏移、勾选、记住、刷新 TMDB 信息。
- 文件能改：勾选；冲突项选办法（改名保留 / 自己起名 / 挪进重复文件 / 删掉 / 覆盖）——「自己起名」只对冲突项开放（2026-09 的设计里明确不做逐项改目标名）。
- 按文件钉季 / 集只有一条路：设置页的识别词 `{[tmdbid=…;s=2;e=5]}` 命中文件名（`DirectSpec` → `resolveEpisode` 的 `pin`）。通道是现成的，但要去写识别词，预览里点不了。
- 文件类型（正片 / 花絮 / 字幕 / 图片 / 其它）全靠规则判断，判错了（以前真踩过：Making、The Menu 被当花絮）用户没法改判，只能等我们改规则。
- 没有批量编辑（除了勾选）；执行后不能改（撤销重来）。

## 方案

### A. 命名自由度

**A1 按任务覆盖模板**（1 天）

- `TaskOrganizeSettings` 加 `templates?: { movie?: string; tv?: string }`、`idTag?`、`episodeTitle?`（分类、识别词、冒号仍全局，够用了）。任务是 JSON 存的，不用迁移。
- `resolveOrganizeSettings(settings, task?)`：任务上非空的覆盖全局；`preview()`、`patchPlan`（`state.org`）、模板试算 `POST /api/organize/preview-name` 带 `taskId`。
- 任务弹框（`AddTaskDialog`）「整理」段加「命名模板」折叠区：两个输入框留空就沿用全局，下面同样的实时试算。

**A2 电影合集**（1 天）

- `getDetails` 多取 `belongs_to_collection { id, name }` → `TmdbDetails.collection` → `OrganizeMatch.collection?: { id, name }`。
- 模板变量 `{collection}`（电影才有，剧集永远空）；推荐写法 `{category}/[{collection}/]{title} ({year}) {idTag}/…`——可选段带 `/`，没合集时整段消失。`dstRoot` 的「作品根」判断（模板里含 title / idTag 的那一层及之上）自然把合集层包进去。
- Emby / Jellyfin / Kodi 都能递归扫，合集目录只是浏览文件系统时好看；它们自己的合集仍按 TMDB 建。

**A3 按作品改标题 / 年份，从别名里挑**（1.5 天）

- `organize_units` 加 `title_override`、`year_override`（迁移 0025）；`OrganizeUnit.titleOverride / yearOverride`；`OrganizeUnitPatch.title / year`（`null` 清掉）。换匹配时清掉。
- `planUnit` 里 `title = row.titleOverride || match.title`、`year` 同理；`workTitles` / `isNamedAfter` 把覆盖也算进片名（删空目录、单元根判断才一致）。
- 记忆：`organize_matches` 加 `title_override`（同一迁移）；勾了「记住」的，下次同目录命中记忆时覆盖照用（和季 / 偏移一样只补空）。
- 别名来源：`GET /api/organize/tmdb/:type/:id` 返回多带 `aliases`（`TmdbDetails.aliases`：alternative_titles + translations），弹框按需拉，不塞进单元 JSON。
- 界面：单元卡片加「改标题」：弹框里当前标题、「用原名」「用英文名」、别名列表一键选、手填；年份同框。
- 智能体：`organize_adjust.changes[].title / year`；confirmText 加「其中改了标题 N 部」。

**A4 网盘侧的清晰度**（0.5 天 + 先核实）

- 先用只读脚本看 115 `files` 的 `vdi`（1 SD / 2 HD / 3 FHD / 4 1080P / 5 4K 这一类档位）和夸克 `file/sort` 有没有 `video_height` / `video_max_resolution`。有就 `ScopeEntry.resolution?` → `UnitFile` → `fileVars` 里 `resolution: parsed.tags.resolution || file.resolution`。OpenList 没有，照旧留空。

**A5 预设模板与说明**（0.5 天）

- 设置页模板输入框旁加「预设」：Emby 默认 / 按年份分目录 / 按合集 / 动画用绝对集数 / Plex 风格；说明里补上 `{originalName}`、可选段里放 `/` 的用法、几个示例。#12 作者想要的 `Movies/2024/片名/` 其实现在就能写，缺的是看见。

**暂缓**：派生变量 `{decade}` / `{titleInitial}`（中文首字母要拼音库）；日期型节目（要 TMDB 集的 air_date 再按日期配集，约一周）。

### B. 编辑能力

**B1 按文件钉季 / 集**（1 天）

- `organize_units` 加 `pins`（JSON，`srcPath → { season?, episode? }`，迁移 0025 一起）；`OrganizeUnitPatch.files[].pin`（`patchPlan` 的 `files` 补丁加 `season` / `episode`，`null` 清掉）。
- `resolveEpisode` 的 `pin` 来源：`unit.pins[file.path] ?? file.direct`；钉了的文件不再受季覆盖 / 集偏移影响（和识别词直指一个待遇）。
- 界面：文件行上「第几集」（对「看不出是第几集」的跳过项最有用，任何视频都能改）；智能体 `changes[]` 对文件编号开放 `season` / `episode`。

**B2 任意文件改名**（0.5 天）

- `organize_units` 加 `renames`（JSON，`srcPath → 文件名`）；`patchPlan` 的 `files[].name`。
- `planUnit` / `planLocalUnit` 算完目标后换掉文件名（目录照旧，扩展名没写就补）；在 `videoDst.set` 之前套，字幕 / nfo 按 `ownerDst` 跟着变。冲突办法里的「自己起名」保留（撞上才用）。
- 智能体 `changes[].newName` 从「只在 custom 时」放开为任意文件；confirmText 加「手动改名 N 个文件」。

**B3 文件类型改判**（0.5 天）

- `organize_units` 加 `kinds`（JSON，`srcPath → "video" | "extra"`）；`buildUnits` 之后、规划之前套：当正片的进正片流程，当花絮的走 extras。界面：文件行「当正片 / 当花絮」。这是以前靠改规则修的坑，给用户一个开关比不断补规则稳。

**暂缓**：批量编辑（先看 B1 / B2 落地后的用法）、执行后编辑（撤销重来就够）。

### 迁移与数据

- 迁移 0025：`organize_units` 加 `title_override`、`year_override`、`pins`、`renames`、`kinds`；`organize_matches` 加 `title_override`。都有默认值，旧 run 读出来是空。
- `planFingerprint` 把这些字段算进去（改了就换版本号，智能体执行时能对上）。
- 按本地 strm 结构的 run：B2 改名可用，其余（标题 / 钉集 / 类型）没有对象，照旧 400。

### 顺序

1. A3 + B1 + B2（一批，共用迁移 0025 和文件行的交互）：约 3 天。
2. A1 + A5：约 1.5 天。
3. A2 + A4 + B3：约 2 天。

每批照旧：单测 → run.itest → 路由 / MCP 测试 → 浏览器冒烟 → 真机只读预览。

## 实施记录：第一批 A3 + B1 + B2（2026-10-19）

> 做完、测过、浏览器 + 真机（115 只读预览）验过；未提交时用户让接着往下做，已本地提交。

**数据**：迁移 0026——`organize_units` 加 `title_override` / `year_override` / `pins` / `renames`，`organize_matches` 加 `title_override` / `year_override`。`OrganizeUnit.titleOverride / yearOverride / pins / renames`（后两个键是网盘绝对路径，和 excluded / resolutions 一样），`OrganizeEpisodePin { season?, episode? }`，`OrganizeMatchMemory` 多两个覆盖字段。`planFingerprint` 把四个字段算进去。

**规划（plan.ts）**：`UnitPlanInput` 多 `titleOverride / yearOverride / pins / renames`。标题 / 年份只换 `{title}` `{year}`（原名、英文名照旧），作品根跟着变；`ownsDir` 的目录名判断把改后的标题也算进片名。`resolveEpisode` 多一个 `userPin` 参数，优先级在识别词直指之上、待遇一样（钉了季不看季覆盖，钉了集不偏移）；字幕按自己的名字找主人，主人钉到哪就跟到哪。改名在 `push` 里套：目录照旧、`withExt` 补扩展名，`videoDst` 存改后的目标所以字幕 / 同名 nfo / thumb 按新主名跟；本来「不动」的（花絮留在原处、认不出类型的）改了名就按改名算，理由换成「按填的名字改名」。`planLocalUnit` 也收 `renames`：视频按填的名字，附属按视频的新主名重算；为此 `mapLocalStrm` 不再只给要挪的视频挂附属（不动的也挂，都是 keep），不然本地清单里改名拽不动字幕。

**改清单（preview.ts）**：`OrganizeUnitPatch.title / year`（null / 空串回到 TMDB 的；本地清单 400 NOT_TMDB_RUN；没识别的 400 NO_MATCH；带 `/` 或年份不是四位 400）。换了作品（picked 且不是刷新）清掉覆盖，同一次给的照给。文件补丁 `FilePatch` 多 `pin`（只给剧集单元里的视频：PIN_NOT_VIDEO / PIN_NOT_TV，本地清单 NOT_TMDB_RUN；null 撤）和 `name`（不能带目录；null / 空串撤）；钉了、改了名的文件会重新勾上（和选冲突办法一样）。`cleanupRoots` 改成按单元行的片名（`unitTitles` = 识别出的几个名字 + 改的标题）判断独占目录。预览时命中记忆、认出的还是记忆里那一部，就把记住的标题 / 年份套上并写一条「按记住的识别：标题用「X」、年份用 Y」的备注；执行后 `afterApply` 把覆盖记进 `organize_matches`（这次没改的沿用原来记着的，和季 / 偏移一个口径）。追更提示里的 title 用生效的标题。

**接口**：`PUT /runs/:id/unit` 多 `title / year`；`PUT /runs/:id/items` 多 `pin / name`（路由原来只透传 selected / resolve，这次一起改了）；`GET /api/organize/tmdb/:type/:id/titles` 给译名 / 原名 / 英文名 / 年份 / 别名（别名去掉和前三者重复的）。

**智能体**：`organize_adjust.changes[]` 单元上多 `title / year`（空串回到 TMDB 的），文件上 `season / episode` 是钉（-1 取消），`newName` 不带 `resolve` 就是改名（空串取消；带 `resolve: custom` 还是冲突时才用的名字）；单元上给 `episode` 报错。`unitView` 多 `title / year`（改过才有），`fileView` 多 `pin / newName`；confirmText 多一句「其中改了标题 / 年份 N 部、钉了季 / 集 N 个文件、手动改名 N 个文件」。快照已更新（工具数不变）。

**前端**：单元卡片「改标题」（`TitleDialog`：译名 / 原名 / 英文名 / 别名一键选，自己填，年份同框，「用 TMDB 的」回到原样；元信息行多「标题 → X」「年份 → Y」）；文件行「…」（`FileMenu`：钉季 / 集…（剧集的视频）、改文件名…、钉过 / 改过的能撤）；`PinDialog` 季 / 集两格至少填一个；`RenameDialog` 加 `title / initialName / onClear` 给任意文件复用；行上「钉在 S02E07」「改名为 X」小字。顺手修了一处：本地结构的清单里文件行原来不可编辑（`editable && !!m`，local 没有 match），现在 `!!m || local`。识别记忆弹框显示记住的标题 / 年份。

**测试**：plan.test（标题 / 年份、钉季集四种组合、改名带附属、原地改名）、local-naming.test（改名带附属、不动的改名）、run.itest（改标题 → 清掉 → 换匹配清掉 → 记住 → 下次预览套上；钉集 → 季覆盖 / 偏移不影响 → 只给剧集视频 → 撤；改名 → 字幕跟 → 撤；本地清单能改名不能改标题 / 钉）、organize.itest（校验、PIN_NOT_TV、别名接口）、mcp-p3（adjust 改标题 + 钉 + 改名，confirmText）。全量：见下。

**真机 / 浏览器（115 只读预览，`tv/东京三十岁左右 (2026) [tmdbid=325124]`，5 集，什么都没执行）**：TMDB 的译名是「东京三十而已」而目录叫「东京三十岁左右」——正是改标题的用处。改标题弹框从真 TMDB 拉到 6 个别名（东京三十而已 / Tokyo middle 30 / Tokyo Mid 30s / 三十而已 日本版 / トウキョウ ミドルサーティー / 東京三十歲左右）；填「东京三十岁左右」后 5 项全变「不变」（文件本来就按这个名字放好的）。「…」→ 钉季 / 集 把 E01 钉成 S02E07：变「移动」到 Season 02、目录操作多一条 mkdir。「…」→ 改文件名把 E02 改成「东京三十岁左右 第2集」：变「改名」、自动补 .mp4。自动化点「…」小按钮容易点偏（24px），用 ref 点就行，不是功能问题。实验库、口令、令牌用完已删。

## 实施记录：第二批 A1 + A5（2026-10-19）

**A1 按任务覆盖**：`TaskOrganizeSettings` 加 `templates { movie?, tv? }` / `idTag` / `episodeTitle`（任务是 JSON 存的，没有迁移）；任务的 zod 校验和设置页共用 `templateField()`（空串算没填，填了必须是合法模板）。`resolveOrganizeSettings(settings, task?)`：任务上非空的盖过全局，分类 / 识别词 / 冒号 / 花絮仍全局；只有 `preview()` 传 task（规划、`planContext`、重规划都吃 `state.org`），`afterApply` / 影库那几处只用 rules，不用传。任务弹框「整理」下面多一块可折叠的「命名模板」（任务上设过就默认展开）：预设下拉、电影 / 剧集模板、id 标签、集标题，沿用设置页的实时试算（留空那格按全局算），「清空，沿用全局」一键回退；提交时留空的不存。

**A5 预设与说明**：`lib/organize-presets.ts` 五个预设（默认 / 按年份分目录 / 动画带绝对集数 / Plex 风格 / 只归目录保留原文件名），`components/template-preset-picker.tsx` 设置页和任务弹框共用；设置页说明补上 `{absolute000}` `{originalName}` 和「可选段里能放 /」。「按合集」预设等 A2 做完再加。`DEFAULT_TEMPLATES` 搬到 lib 里：预设模块引设置页组件、设置页组件又引预设选择器，浏览器里报「Cannot access 'DEFAULT_TEMPLATES' before initialization」——浏览器冒烟抓出来的，typecheck / lint 都不报。

**测试**：settings.test（任务覆盖 / 留空沿用 / 分类识别词仍全局）、run.itest（任务自己的电影模板 + idTag，剧集沿用全局）、crud.itest（合法模板存得进、坏模板 400）。浏览器：115 tv 任务套「动画：文件名带绝对集数」预设 → 保存 → 重开显示「这个任务单独设了」且模板还在；设置页预设下拉和说明正常。

## 实施记录：第三批 A2 + B3（2026-10-19）

**A2 电影系列**：`getDetails` 收 `belongs_to_collection`（名字按请求语言，zh-CN 下是「沙丘（系列）」这种）→ `TmdbDetails.collection`（电影总有这个键，不属于系列是 null）→ `OrganizeMatch.collection?`；模板变量 `{collection}`（剧集永远空），推荐写法 `[{collection}/]`，作品根的判断（含 title / idTag 的那一层及之上）自然把系列层包进去；设置页试算的电影样例带 `collection`；预设多了「电影按系列归档」。刷新 TMDB 信息比较（`sameMatchData`）把系列名算进去。
缓存：详情缓存键不能带版本——海报墙 `strm/poster.ts` 直接读同一个键；老条目没有 `collection` 这个键，`TmdbClient.details` 对电影发现缺键就当没缓存重拉一次写回（补过的是新形状，不再重拉），不然 `{collection}` 在老条目上要等七天。

**B3 文件类型改判**：`OrganizeUnit.kinds`（迁移 0027，网盘绝对路径 → video / extra）；`planUnit` 的三处「是不是花絮」（正片循环、字幕找主人、附属处理）都走 `asExtra()`：人改判了听人的，否则看目录和名字；改判成花絮的理由写「按花絮处理（人改判的）」。只给视频文件（KIND_NOT_VIDEO），本地清单 400（NOT_TMDB_RUN）。文件补丁 / 路由 / `ItemsPatch` / 智能体 `changes[].kind`（video / extra / auto，只给文件）/ `fileView.kind` / confirmText「改判正片 / 花絮 N 个文件」/ 前端「…」里「当正片」「当花絮」「撤掉改判」+ 行上小字「改判为正片 / 花絮」。

**测试**：plan.test（`[{collection}/]` 有 / 没有系列；花絮目录里的一集改判成正片按集排、正片改判成花絮进 extras/）、run.itest（改判 → 只给视频 → 撤 → 本地 400）、organize.itest（老缓存自愈一次、新形状不重拉；原来三处缓存夹具补上 `collection: null`）、mcp-p3（kind extra / auto，单元上 kind 报错）。注意：带 `-trailer` 后缀的文件名 parse-name 并不当花絮（测试时发现），花絮目录（Featurettes/）才是；要不要把 `-trailer` 等 Emby 后缀也算花絮另议。

**真机 / 浏览器（115 只读预览，什么都没执行）**：`movie/黑客帝国 (1999) [tmdbid=603]` 真 TMDB 回了 `collection: {id: 2344, name: "黑客帝国（系列）"}`（老缓存缺键自愈重拉了一次）；给 115 movie 任务套「电影按系列归档」预设后预览，作品根变成 `黑客帝国（系列）/黑客帝国 (1999) [tmdbid=603]`、文件 move 进去。`tv/东京三十岁左右` 的 E03 在「…」里选「当花絮」：变 move 到 `…/extras/`、行上「改判为花絮 / 按花絮处理（人改判的）」。实验库、口令、令牌用完已删。

## 方案：模板 / 预设交互重做（借鉴 tinyMediaManager，2026-10-21）

### 起因

现在是一个「套用预设…」下拉，选一项把电影、剧集两格一起覆盖。六个预设里「电影按系列归档」只有电影有意义、「动画：绝对集数」只有剧集有意义，但都把另一格写回默认：先套系列归档再套绝对集数，系列目录就没了，界面上没提示。任务弹框更糟：剧集库的任务套一个剧集预设，电影模板也被钉到任务上、从此不跟全局。选完下拉回到占位，看不出两格现在是哪个预设。另外一整条带斜杠的长模板（约 100 字）在一个单行输入框里很难读，手机上更是。

### tinyMediaManager 的做法（对着官方文档核过，docs/movies/renamer、docs/tvshows/renamer、博客 multiple-renamer-profiles）

- 电影和剧集的改名器是两套独立设置页；v5.3 起每套各自有「renamer profiles」：面板顶上一个 profile 选择器（Select / Create / Duplicate / Rename / Delete），升级时老设置迁成名叫 Default 的 profile，一个 profile 装的是目录模板 + 文件模板 + 清理选项。
- 模板按层拆格：电影是 Folder name + Filename；剧集是 Folder name + Season folder name + Episode filename。某格留空就不生成那一层（剧集不建季目录）。
- 字段下面一张变量表：Token / Description / Example 三列，示例值来自用户自己的库。
- 空格 / 冒号 / 非 ASCII / 非法字符的替换是独立选项，不进模板。
- 高级项：season 0 叫 Specials、多集文件的命名样式、只有一部电影的系列要不要也建系列目录。

### 借什么、不借什么

借四条：**按类型分开**（电影 / 剧集各一个面板，预设各一份，不存在「一个动作写两类」）；**按层拆格**（目录 / 季目录 / 文件名，后端还是存一条串，前端拆 / 拼）；**变量表带示例值、点一下插进光标处**；**预设选择器反映当前状态**（像 profile 选择器：等于哪个预设就显示哪个，否则显示「自定义」）。

不借：空格 / ASCII 替换（中文库用不上，冒号已经有）；用户自建 profile（放第二步，可选）；Specials / 多集样式（另一个话题）。

### 第一步（本轮）

**设置页「整理与规范化命名」**：模板那块改成两个 tab「电影」「剧集」（手机和桌面都用 tab，每个面板占满宽度，长路径的示例才摆得下）。tab 上带当前预设名，比如「电影 · 默认」「剧集 · 动画绝对集数」，不点开也知道两边各是什么。面板里从上到下：

```
预设   [默认（Emby / Jellyfin）        ▾]   恢复默认
       作品目录带年份和 id 标签                      ← 命中的预设的 hint；自定义时写「自定义写法」

目录   [{category}/{title} ({year}) {idTag}                       ]
       可以多层：系列 / 年份目录写在这里，[{collection}/]、{year}/
文件名 [{title} ({year})[ - {edition}][ - {resolution}][-{part}].{ext}]

示例   目录  外语电影/沙丘：第二部 (2024) [tmdbid=693134]
       文件  沙丘：第二部 (2024) - 2160p.mkv

变量（点一下插进光标处）                                    展开 / 收起
 {title}        片名                          沙丘：第二部
 {year}         年份                          2024
 {collection}   所属系列，不属于系列就空        沙丘（系列）
 …
```

剧集面板多一格「季目录」（`Season {season00}`），说明写「留空就不建季目录」；「文件名里写集标题」从下面的开关区挪进剧集面板（它只影响剧集）。id 标签写法、冒号处理、自动整理策略还在面板下面，两类共用。顶上那段把所有变量堆成一行 `<code>` 的说明删掉，换成两句：`[ … ]` 可选段里的变量全为空就整段丢掉，段里可以带 `/`。

**预设按类型各一份**（`lib/organize-presets.ts` 改成 `{ key, label, hint, movie?: { dir, file }, tv?: { dir, season, file } }`，只给有的类型）：

- 电影：默认（Emby / Jellyfin）/ 按年份分目录 / 按系列归档 / Plex 风格 / 只归目录保留原文件名
- 剧集：默认（Emby / Jellyfin）/ 按年份分目录 / 动画：文件名带绝对集数 / Plex 风格 / 只归目录保留原文件名

选择器的值按这格的内容反推：拼成整条后和各预设的整条比（去首尾空白），等于哪个显示哪个，否则「自定义」；「恢复默认」就是选默认那一项。预设只填自己这个类型的格子，另一类一个字不动。

**拆 / 拼规则**（`lib/template-parts.ts`，纯函数，带测试）：

- 按括号深度扫一遍模板（`\[` `\]` 转义照 parseTemplate 的规矩），只认深度 0 的 `/` 作分层点，`[{collection}/]` 里的 `/` 不算。
- 电影：最后一个分层点之前是目录、之后是文件名；没有分层点就目录空、整条是文件名。
- 剧集：最后一段是文件名；倒数第二段**含季变量且不含 title / idTag / tmdbId** 才算季目录（`{title} S{season00}` 这种是把季写进剧目录，不是季目录），否则季目录空；剩下的全拼成目录。
- 拼：电影 `dir ? dir + "/" + file : file`；剧集 `[dir, season, file]` 去空后用 `/` 连。
- 括号不配对（本来就是坏模板）拆不了：退回单格「整条模板」编辑并显示校验错误。
- 文件名、季目录两格里打 `/` 给行内提示「目录层级写到上面那格」，照样拼进去，后端校验照旧，下次打开会按拆法归位。
- **拆了再拼必须一字不差**：设置页的脏状态是比字符串，面板初始化只拆不回写，只有用户动了才 onChange；否则一打开设置页就「有未保存改动」。测试覆盖六个预设、无季目录、系列目录、多层目录、括号里带斜杠、坏模板这些来回。

**变量表**：每个面板一张，列是 变量 / 说明 / 本例的值。说明是前端静态表（`lib/template-vars.ts`：category 分类目录，按下面的规则算出来、关掉分类就没这层；collection 电影所属系列（TMDB）；title / originalTitle / enTitle / year / tmdbId / imdbId / idTag（按「id 标签写法」）；season / season00 / episode / episode00 / absolute / absolute000 / episodeTitle（要开集标题）；part 分段 / edition 版本 / resolution / source / videoCodec / audio / hdr / group 发布组 / originalName 原文件名不含扩展名 / ext）。电影面板不列季集类，剧集面板不列 collection / edition。值从试算接口回来。点一行把 `{var}` 插到这个面板最后聚焦的那格的光标处（记 ref + selectionStart），没聚焦过就追加到文件名。默认收起，展开状态记 localStorage。

**示例**：渲染结果按最后一个 `/` 分成「目录」「文件」两行（像 tMM 分别显示 Folder name / Filename）。试算请求多带 `categories`（设置页当前的分类规则文本解析后），后端用 `pickCategory` 给样例算分类（沙丘 → 外语电影、怒呛人生 → 欧美剧），示例里就有分类这一层，分类规则改了也立刻看得见；现在样例 category 是空串、这层直接消失，用户看不到自己的分类规则起没起作用。

**任务弹框「命名模板」**：按库类型给面板——电影库只给电影面板，剧集库只给剧集面板，混合给两个 tab。预设选择器第一项是「跟随全局（默认（Emby / Jellyfin））」，括号里是全局命中的预设名（弹框打开时拉一次 `api.settings.get()`，复制那块已经在拉，合并成一次）：

- 跟随全局：三格只读显示全局的拆法（灰字），示例按全局算；表单里对应的模板串是空串，提交时不存。
- 选一个预设：三格填上预设的值，可编辑。
- 选「自定义」：三格从全局的值起步、可编辑（不让人从空白开始写）。
- 「清空，沿用全局」：回到跟随全局。
- 自定义 / 预设状态下文件名必填（行内错误 + 表单 setError 拦提交）；任务上的模板要么没有、要么完整，不再有半套。
- 库类型是电影 / 剧集时另一类不是不存在：先验只管看不出类型的文件，剧集库里认出电影照样用电影模板。所以面板下面留一行链接「也给电影设一套（这个库里认出电影时用）」，点开才显示另一面板；任务上另一类已经有值就直接展开。老任务因为旧选择器带上的那套「默认」模板会在这里露出来，用户看一眼清掉就行，不自动删。
- `hasOwnNaming` 口径不变。「文件名里写集标题」的三选一进剧集面板；id 标签写法仍在面板外两类共用。

**后端**：`POST /api/organize/preview-name` 的请求多收 `categories`（和设置页同一个形状，可选），响应多返 `vars: { movie: Record<string, string>, tv: Record<string, string> }`（样例变量的清洗前原值，idTag 已按风格拼好）。模板存储不变（`templates.movie` / `templates.tv` 还是一条串），预设不落库，任务字段不变，没有迁移。

**测试 / 冒烟**：`template-parts.test.ts` 来回拆拼；preview-name 的 vars 和分类；settings.test 不动；浏览器：设置页 390px 和桌面各走一遍（切 tab、套预设、改一格看选择器变「自定义」、点变量插入、展开变量表），任务弹框三种库类型各一遍、跟随全局 → 预设 → 自定义 → 清空、保存重开；特别验「打开设置页不出现未保存改动」。

**工作量**：前端约 1 天（拆拼函数 + 测试、面板组件两处共用、预设改形状、变量表），后端半天不到，冒烟半天。合计 1.5 天。

### 第二步（可选）：用户自建预设 = tMM 的 profiles

`settings.organize.profiles: Array<{ name, movie?, tv? }>` 存用户自己的写法，预设选择器里内置的和自建的分组列，多「保存为新预设…」「改名」「删除」（内置的只读）。任务上加 `organize.profile?: string` 按名字引用，`resolveOrganizeSettings` 先解引用再被任务自己的 `templates` 盖；删一个有任务在用的预设要拦（「3 个任务在用」）。价值：改一次写法，所有引用它的任务跟着变，现在是每个任务一份拷贝。约 1 天，等用户真有一堆同类任务要同时改时再做。

### 第三步（可选）：用库里的作品试算

tMM 的变量表示例值来自自己的库。`GET /api/organize/samples`：从最近几次整理 run 里各类型挑最多 10 个有匹配的单元，取第一个视频按规划同一条路算变量（`planUnit` 里的 common + `fileVars` 抽成可复用的函数），返回 `{ label: "片名 (年份) · 文件名", mediaType, vars }`；试算请求可带 `vars` 覆盖内置样例。面板示例旁一个「示例作品」下拉，默认「内置样例」。约半天。内置样例已经把每个变量都演示到了，这步纯锦上添花。

> 2026-10-21 修正：预设列表里「Plex 风格」和「按年份分目录」不是一个轴的东西。改成「服务器」（设置页顶上 Emby / Jellyfin / Plex / Kodi 四个按钮，管 id 标签 + 文件名细节 + Specials / 花絮目录名）× 「结构预设」（每类一个下拉，只管目录结构），预设定义是 结构 × 服务器 → 模板 的函数。详见 organize-tmm.md 第六节；整个整理模块对照 tMM 的分析也在那份文件。
