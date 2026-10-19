# 整理与规范化命名（organize）—— 设计

> 状态：**已实施（后端 + 前端），待真机验证**。最后更新：2026-09-11

## 要解决的事

网盘里的目录和文件名是资源站 / 字幕组 / PT 的原始命名，strm 库照抄过来，Emby 只能靠猜：

```
tv/怒呛人生/BEEF.S01.1080p.NF.WEB-DL.DDP5.1.H.264-XXX/BEEF.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-XXX.mkv
tv/[Nekomoe kissaten][Sousou no Frieren][01][1080p][JPSC].mp4
movie/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv
```

典型后果：剧名带一串技术词识别错片、年份缺失匹配到重名作品、字幕组的 `[01]` 认不出季集、同一部剧散在三个目录、电影目录里塞着 sample 和花絮。
需要两件事：**规范化命名**（原地改成媒体服务器认得的名字）和**整理**（挪进 `作品 (年份)/Season 01/` 这样的标准结构）。两者是同一条流水线的两种输出。

## 业界怎么做

### 目标：媒体服务器的命名规范

三家官方文档给的规范高度一致，差别只在 id 标签的写法：

| | 电影 | 剧集 | id 标签 | 多版本 / 多段 |
|---|---|---|---|---|
| Emby | `Avatar (2009)/Avatar (2009).mkv` | `Glee (2009)/Season 01/Glee S01E01.mp4`，特别篇 `Season 00` 或 `Specials` | `[tmdbid=36557]`、`[tmdb-36557]`、`{tmdbid=36557}`（tmdb / imdb / tvdb 都认） | `300 (2006) - 1080p.mkv`、`300 (2006) - 4K.mkv`；`-cd1`、`-part1`、`-disc1` |
| Jellyfin | `Movie (2019) [tmdbid-xxx]/Movie (2019) [tmdbid-xxx].mp4` | 季目录必须是 `Season 01`（明确说别写 `S01`） | `[tmdbid-xxx]`、`[imdbid-tt…]` | `Movie (2021) - 2160p.mp4`；字幕 `Film.en.forced.srt` |
| Plex | `Batman Begins (2005) {tmdb-272}/Batman Begins (2005) {tmdb-272}.mp4` | `Show (2010) {tvdb-…}/Season 01/Show - s01e01.mkv` | `{tmdb-272}`、`{edition-Director's Cut}` | 同上 |

共同点：**目录名 = 标题 + (年份) + id 标签**，剧集下一层固定 `Season NN`，文件名重复目录名再接 `S01E01` / 版本标签；花絮进 `extras` / `trailers` 这类固定子目录；多集 `S01E01-E02`；日播 `2020-01-31`。目录名里带 TMDB id 是让刮削百分百命中的最有效办法，三家都认。

### 过程：整理工具怎么做

| 工具 | 识别 | 命名 | 预览 | 撤销 | 分类 | 网盘 |
|---|---|---|---|---|---|---|
| Sonarr / Radarr | 解析文件名 + TVDB/TMDB，导入时人工可改匹配 | token 模板：`{Series TitleYear}/Season {season:00}/{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}`；多集样式六选一；非法字符替换、冒号五种策略（默认 Smart：`: ` → ` - `） | 「Rename」先列出 旧路径 → 新路径，逐条勾选再执行 | 无 | 根目录级 | 无 |
| FileBot | 解析 + 多库匹配，左原名右新名对照 | Groovy 表达式 `{n} - {s00e00} - {t}`，自带 `{plex}` `{emby}` `{jellyfin}` `{kodi}` 预设 | 有 | `history.xml` 记录每次改名，`Revert` 一键回退 | 无 | 无 |
| 国内主流的网盘整理工具 | 正则 + **自定义识别词**（屏蔽词 / `A => B` 替换 / `前 <> 后 >> EP+1` 集数偏移 / 直指 `{[tmdbid=xxx;type=tv;s=1]}`）+ TMDB | Jinja2 模板，默认电影 `{{title}} ({{year}})/{{title}} ({{year}}){% if part %}-{{part}}{% endif %}{% if videoFormat %} - {{videoFormat}}{% endif %}{{fileExt}}`，剧集 `{{title}} ({{year}})/Season {{season}}/{{title}} - {{season_episode}} - 第 {{episode}} 集{{fileExt}}` | 手动整理：选目录 → 识别 → 可改类型 / TMDBID / 季 / 集偏移 → 执行 | 整理历史可重做（`/redo`）、可连文件一起删 | `category.yaml` 二级分类：按 `genre_ids` / `origin_country` / `original_language` 分到 动画电影 / 华语电影 / 国漫 / 日番… | 支持 115 等网盘内移动改名，再生成 strm |
| tinyMediaManager | 先刮削后改名 | `${title} (${year})` 模板 | 预览后执行 | 无 | 无 | 无 |

### 提炼出的原则

1. **识别和命名分开**：先把文件变成结构化事实（类型、TMDB id、季、集、版本标签），再由模板产出名字。识别结果可被人改、改过的要记住。
2. **命名以媒体服务器的规范为准**，把 provider id 写进目录名；模板只提供有限变量和可选段，不做图灵完备（Jinja2 那种全功能模板是维护负担，Sonarr 的 token 更稳）。
3. **一律预览 → 人工确认 → 执行**，逐条可勾选、可改匹配；认不出的默认跳过，绝不瞎猜。
4. **幂等 + 可撤销**：每一步记 from → to；已经规范的文件再跑一次是零变更；出了错能按记录退回去。
5. **限流分批**：网盘接口有风控，能批量的接口用批量，不能的逐条限速。
6. **完成后联动**：strm 跟着走、通知媒体服务器刷新、通知人。
7. **增量自动化**：新入库的内容（转存、追更、云下载、监控新增）走同一条流水线，规则配一次。

## 方案

### 定位：整理作用在网盘上，本地 strm 跟随

本项目所有链路——全量同步（`planSync` 按相对路径对照）、网盘监控（事件路径 → 本地路径）、追更（`subPath`）、strm 校验 / 重写（`inspectStrm` 从本地文件名推算网盘路径）、302（strm 内容 = 前缀 + 网盘路径）——都建立在一个不变量上：**本地目录树是网盘目录树的镜像**。

只改本地 strm 名而不动网盘（「虚拟整理」）就得在每条链路里维护一张网盘路径 ↔ 本地路径的映射表：`removeExtraFiles` 会把改过名的 strm 当多余删掉再按原名生成；校验会把每个文件报成 `name-mismatch`；监控搬家算不出本地位置；OpenList 和其它工具看到的仍然是乱的。代价远大于给 Provider 加三个写操作。国内主流的网盘整理工具也是直接在网盘内移动改名。

所以：**在网盘上改名 / 移动，本地 strm 由整理器自己同步镜像**（不等监控），监控随后收到的自有事件识别为已处理。作用范围以同步任务为单位，任务的 `originPath` 就是媒体库根；一个任务一种库（电影 / 剧集 / 混合，混合按识别结果分流）。

### 流水线

```
范围（任务 + 子目录；或转存 / 追更 / 云下载 / 监控给的新增路径）
→ 扫描   provider.walkSubtree 拿整棵子树，按「作品单元」分组
→ 识别   recognize：识别词预处理 → 解析文件名 / 目录名 → 单元级综合    （纯函数，样本表驱动测试）
→ 匹配   identify：nfo / 影库条目 / 记忆 里的 tmdbId 直接用；否则 TMDB 搜索打分，给置信度
→ 规划   plan：模板 + 分类 → 目标路径；冲突检测；源 == 目标 的标 keep       （纯函数）
→ 预览   按单元折叠的 from → to 列表；换匹配 / 改季 / 集偏移 / 勾选
→ 执行   apply：mkdir → 批量改名 / 移动 → 本地镜像 → 逐条记账 → 清理空目录
→ 收尾   scheduleEmbyRefresh、改写受影响的追更 / 云下载 subPath、Telegram
→ 撤销   revert：按记录逆序退回，逐条校验节点仍在目标位置
```

预览是后台作业（1000 个单元要几百次 TMDB 请求，现有 scrape-worker 是 4 req/s），`organize_runs` 记状态，页面轮询；可取消。

### 识别（recognize）

把 `services/media-title.ts` 的 cutoff 解析扩成完整的 `parseMediaName()`（保留现有 `normalizeTitle` 供影库刮削用，或让它改调新函数）：

```ts
interface ParsedName {
  title: string; year?: string;
  season?: number; episode?: number; episodeEnd?: number;   // S01E01-E02
  absolute?: number;                                         // 字幕组的 [13]、- 13
  isSpecial?: boolean; date?: string;                        // SP / OVA / 日播 2020-01-31
  part?: string; edition?: string;                           // part1 / cd1；导剪版 / 加长版
  tags: { resolution?; source?; videoCodec?; audio?; hdr?; group? };
  subtitleLang?: string; forced?: boolean;                   // 字幕文件才有
}
```

规则来源：guessit / anitomy 的思路 + 现有 `QUALITY_TOKENS`。中文特化：`第一季` / `第01集` / `E01` / `[01]` / ` - 01`；字幕组前缀 `[Sub][Title][01][1080p]`（方括号段序）；`国语 / 粤语 / 中字 / 简繁` 归入标签；`SP / OVA / OAD / 特别篇` 归特别篇；`1080p` 和 `13` 同时出现时集数取靠前的两位数。

**作品单元**：直接含视频文件的目录是候选；目录名是 `Season 1` / `S01` / `第一季` / `Specials` 时单元是上一级；扁平目录里解析出多个标题就按标题 + 年份拆成多个单元（电影堆、散集堆）。单元级综合时目录名优先于文件名（目录名通常是干净的「剧名 + 年份」），季从季目录 / 文件名推，集只看文件名。

**识别词**（沿用国内用户熟悉的那套语法）：

```
屏蔽词
被替换词 => 替换词
前定位词 <> 后定位词 >> EP+12          集数偏移，支持 EP+1 / 2*EP-1
被替换词 => 替换词 && 前 <> 后 >> EP-1
被替换词 => {[tmdbid=95396;type=tv;s=2]}   直接指定
```

全局一份，任务可以再加自己的；存 `app.organize.rules`。

**证据优先级**：同目录 `tvshow.nfo` / `<video>.nfo` 里的 `<tmdbid>` 或 `<uniqueid type="tmdb">` → 影库条目的 `tmdbId`（从影库转存的路径） → `organize_matches` 里用户确认过的 → 识别词直指 → 目录名解析 → 文件名解析。

### 匹配（identify）

TMDB：已有 `services/tmdb.ts` 的 search，补 `tv/{id}`（季数、每季集数、集标题，可选）和 `movie/{id}`，加 `tmdb_cache` 表（key `type:id:lang`）。

打分：标题（归一化后，对照 `title` / `original_title` / `alternative_titles`）完全相等 +3，年份相等 +2、差 1 年 +1，类型与解析一致 +1，`popularity` 只做同分排序。置信度：

- **high**：tmdbId 来自 nfo / 影库 / 记忆 / 识别词；或标题相等且年份相等。
- **medium**：标题相等但无年份可比 / 差一年；或首选领先第二名 ≥ 3 分。
- **low**：其余有结果的。
- **none**：无结果——预览里单列「待处理」，可搜索或手填 tmdbId。

剧集拉到季集清单后做两件事：解析出的集数超过该季集数 → 试按绝对集数折算（前几季集数累加），标 medium 并在预览里说明；`第二季` 目录里文件只有 `[13]` 这种，同理。

### 命名（naming）

模板用 token，Sonarr / Radarr 风格；`[ … ]` 是可选段，段内变量都为空整段丢弃；路径段整体为空则去掉这一层（分类关掉时 `{category}/` 自然消失）。

```
{category} {title} {originalTitle} {enTitle} {year} {tmdbId} {imdbId} {idTag}
{season} {season00} {episode} {episode00} {episodeRange} {absolute} {episodeTitle}
{part} {edition} {resolution} {source} {videoCodec} {audio} {hdr} {group} {ext}
```

`{title}` 跟设置里的 `tmdb.language`（默认 zh-CN）；`{idTag}` 按设置风格生成：`[tmdbid=693134]`（Emby，默认）/ `[tmdbid-693134]`（Jellyfin）/ `{tmdb-693134}`（Plex）/ 不写。

默认模板：

```
电影  {category}/{title} ({year}) {idTag}/{title} ({year})[ - {edition}][ - {resolution}].{ext}
剧集  {category}/{title} ({year}) {idTag}/Season {season00}/{title} - S{season00}E{episode00}[ - {episodeTitle}].{ext}
```

产出：

```
电影/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv
电影/沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.zh-CN.srt
剧集/怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv
剧集/葬送的芙莉莲 (2023) [tmdbid=209867]/Season 01/葬送的芙莉莲 - S01E01.mkv
剧集/葬送的芙莉莲 (2023) [tmdbid=209867]/Season 00/葬送的芙莉莲 - S00E01.mkv
```

规则细节：

- 多集 `S01E01-E02`（Sonarr 的 Prefixed Range，Emby / Jellyfin 都认）；特别篇 `Season 00`；多段保留 `-part1`；多版本靠 `[ - {resolution}]`，同一单元两个文件产出同名 → 冲突。
- 字幕跟着同名视频走：`{视频主名}.{lang}[.forced].{ext}`，语言归一 `chs / sc / 简体 → zh-CN`，`cht / tc / 繁体 → zh-TW`，`eng → en`，认不出就不写语言段。`poster.jpg` / `fanart.jpg` / `tvshow.nfo` 随单元目录移动、名字不动；`<video>.nfo` 跟视频改名。
- 非法字符 `: \ / > < ? * | "` 替换（115 目录名明确不允许 `" < >`）；冒号默认 Smart（`: ` → ` - `，其余 → `-`），可选删除 / 短横；全角标点保留；首尾空格和点去掉；单段 ≤ 200 字节，超长截标题不截 `S01E01`。
- `sample`、`-trailer`、`Featurettes` 这类：sample 跳过，花絮按 Emby 规范挪进单元下的 `extras/`（默认关，开了才动）。
- 二级分类（默认关）：JSON 版的 category.yaml，`{ name, genreIds?, originCountry?, originalLanguage? }` 顺序匹配、全部条件同时满足才命中、都不中用最后一条兜底；预置一份「动画电影 / 华语电影 / 外语电影；国产剧 / 日番 / 欧美剧 / 纪录片」。

### 规划与冲突（plan）

每个单元产出 items：`{ srcPath, nodeId, dstPath, kind: video|subtitle|nfo|image|dir|other, action }`。

- `keep`：源 == 目标，灰显不计数——已整理的库再跑是零变更。
- `rename`：同一父目录只改名；`move`：跨目录（可能同时改名）。
- `mkdir`：目标目录不存在（同一部剧再来一季时目录已存在 → 复用，这是增量的常态）。
- `conflict`：目标已存在且不是同一节点；两个源映射到同一目标；目标目录是另一个任务的 `originPath`。冲突项默认不勾，给出原因。
- `skip`：未匹配单元里的文件、`other` 类文件、sample。
- `rmdir`：执行后变空的源目录（可关）。

保护：不动任务根目录本身；不删除任何文件；目标必须仍在本任务 `originPath` 下；一次 run 上限 20000 个文件，超了让用户缩小范围。

### 执行、镜像与撤销（apply / mirror / revert）

按单元顺序执行，每条 op 一行记账：

1. `mkdir` 目标目录链（115 `files/add`，夸克 `/file`），拿到 id 再往里挪——115 `files/move` 对不存在的 pid 也会成功、产生悬空节点，所以永远用刚建 / 刚解析到的 id。
2. 先原地改名再移动：115 `files/batch_rename`（一次 ≤ 100 个 `files_new_name[fid]`）、`files/move`（一次 ≤ 100 个 fid，接口注明不要并发，串行）；夸克 `/file/rename`、`/file/move`（`action_type: 1, filelist, to_pdir_fid`，回 task_id 且未完成就复用 `quarkWaitTask`）；OpenList `/api/fs/rename` `/api/fs/move` `/api/fs/mkdir`。全部走 `scheduleForAccount` 的账号级限流。
3. **本地镜像**：每条 op 成功后立刻按 `services/life/handlers.ts` 的 `relocate` 逻辑挪本地文件并重写 strm 内容（把它抽成可复用的 `mirrorRelocate({ oldPath, newPath, isDir, nodeId })`）。不等监控：监控可能没开，夸克快照最短 5 分钟。115 同时更新 `path_cache`（`rememberListing` / 直接 upsert），后续生活事件才能解析出正确的旧路径。
4. 记账：item `status = done`，附 `finishedAt`；失败的记 error 继续下一条，风控（`classifyError === "blocked"`）整轮暂停，run 可续跑（`pending` 的从头再来，`done` 的跳过）。
5. 收尾：清理空目录（只删本次腾空的）、`scheduleEmbyRefresh()`、改写 subPath（见下）、Telegram `organize-done`。

**监控自有事件**：执行完之后监控会收到我们自己产生的 rename / move 事件。处理前先查 `organize_items`：同 nodeId、同新路径、24 小时内 done → 记 skipped「整理已处理」。没查到也无害：`relocate` 发现本地 from 不存在会退化成 handleCreate，重写同样内容（目录会重新 listDir 一遍，只是费接口）。

**撤销**：只允许对最近一次 `done` 的 run 做；按 done 的 item 逆序：校验节点当前路径 == `dstPath`（115 按 path_cache / resolvePath 对 id，夸克 resolvePath），对不上就跳过并列出；`move` / `rename` 反向执行，`mkdir` 的目录变空了就删（只删空目录，需要 `rmdirIfEmpty`），本地同样镜像回去；run 标 `reverted`。

### 自动整理（增量）

任务级设置 `organize.mode`：`off`（默认）/ `review`（只生成待确认的 run 并通知「N 项待确认」）/ `auto`（high 置信度且无冲突的单元直接执行，其余留待确认）。

触发点都已有明确的「新增路径」：`saveSelectionToTask` 完成（转存）、追更 tick 转存成功、云下载回执生成 strm 后、监控 `create` 目录事件。影库转存自带 `tmdbId / mediaType / year`，直接当 high 匹配，免识别。

**路径回写**：追更订阅 `share_follows.sub_path` 和云下载回执 `offline.followups[].subPath` 指向任务下的相对目录，被整理挪走后它们会报「目标目录不存在」。run 收尾时把 `task_id` 相同、`sub_path` 等于或以被移动目录旧相对路径开头的记录改成新路径（同一事务）；预览里提示「此目录被 N 条追更订阅引用，执行后自动改写」。

### 数据模型

```
organize_runs      id, task_id, scope_path, mode(manual|auto), status(planning|ready|applying|done|failed|cancelled|reverted),
                   stats(json: units/items/done/failed/skipped/conflicts), error, created_at, started_at, finished_at
organize_items     id, run_id, unit_key, kind, action, src_path, node_id, dst_path, match(json), confidence, selected,
                   status(pending|done|failed|reverted), error, finished_at        ← 既是计划也是撤销用的流水账
organize_matches   account_name, src_path, media_type, tmdb_id, season, episode_offset, title, year, updated_at
                   ← 用户在预览里改过并勾了「记住」的识别结果，下次同目录直接用
tmdb_cache         key, value(json), fetched_at
settings           app.organize = { templates, idTag, colon, categories, rules, cleanupEmptyDirs, extras, auto }
TaskDefinition    += organize?: { mode?: "off"|"review"|"auto"; libraryType?: "movie"|"tv"|"mixed" }
```

时间戳统一秒（`unixepoch`）；id 一律字符串。

### 接口

```
POST /api/organize/runs                     { taskId, subPath?, paths?: string[] }   建 run 并后台识别 + 规划 → { id }
GET  /api/organize/runs?taskId=&page=       run 列表（不带 items）
GET  /api/organize/runs/:id                 run + 按单元分组的 items（分页）
PUT  /api/organize/runs/:id/units/:key      { match?: { mediaType, tmdbId, season?, episodeOffset? }, selected?, remember? }  改匹配后重新规划该单元
PUT  /api/organize/runs/:id/items           { ids, selected }
POST /api/organize/runs/:id/apply           执行（异步）；进度 GET /api/organize/runs/:id/log（SSE，沿用任务日志流的做法）
POST /api/organize/runs/:id/cancel
POST /api/organize/runs/:id/revert
POST /api/organize/preview-name             { template, sample }   设置页实时试算
GET  /api/tmdb/tv/:id                        季集清单（带缓存）；搜索复用 POST /api/library/tmdb/search
```

错误壳照 `{ message, ...extra }`，上游失败 `upstreamError`，输入 `parse(schema, body)`。

### 前端

- 新页 `/organize`「整理」（侧栏放在 strm 管理之后）：选任务 + 目录（复用 `DirectoryTreeDialog` 的远程目录树）→ 「预览」→ 单元列表：海报缩略、标题 (年)、类型、TMDB 链接、置信度 `StatusBadge`（high 成功色 / medium 警告 / low 危险 / none 中性）、文件数，单元操作「换匹配」（TMDB 搜索弹框，复用影库那套）「季 / 集偏移」「跳过」「记住」；展开看 from → to，差异段高亮；底部粘性栏「执行 N 条」；执行中进度条 + 日志；完成摘要 + 「撤销」。「历史」tab 列 runs。手机上单元是卡片。
- 设置页「整理」区块：电影 / 剧集模板（输入时下方实时显示样例）、id 标签风格、冒号策略、集标题开关、二级分类开关 + 规则表、识别词（textarea，每行一条）、空目录清理、花絮处理、自动整理默认策略。
- 新建 / 编辑任务：库类型 + 自动整理模式。
- `SaveToDriveDialog`：「转存后整理」勾选（默认取任务设置）。
- strm 管理体检：新增 `nonstandard-name` 问题类型，点过去预填整理范围。
- Telegram：`organize-done` / `organize-review`（待确认清单）两个事件，开关 `notify.organize`。

### 网盘 Provider 写操作

`DriveProvider` 加可选 `write`，`capabilities.write` 标有无；`providerForTask(task, "write")` 没有就 400：

```ts
interface DriveWriteOps {
  mkdir(parentId: string, name: string, signal?): Promise<DriveNode>;
  rename(id: string, newName: string, signal?): Promise<void>;
  renameMany?(pairs: Array<{ id: string; name: string }>, signal?): Promise<void>;   // 115 批量
  move(ids: string[], toDirId: string, signal?): Promise<void>;
  rmdirIfEmpty(id: string, signal?): Promise<boolean>;
}
```

`FakeDrive` 补同一组（`FakeTree` 已有 `move`），整理服务的测试全走它。

### 不做

- 不做 NFO / 图片刮削：目录名带 tmdbid 后 Emby 自己刮得准；以后要做也是独立功能。
- 不做复制 / 硬链接 / 软链接：网盘没有这些概念。
- 不做「仅本地」虚拟命名（理由见定位）。
- 不做 Jinja 表达式，不做音乐。
- 不删除任何网盘文件；空目录清理只碰本次腾空的目录。

### 风险与取舍

- **识别错 → 错名字进 Emby**：只有 high 才自动执行；其余人工确认；能撤销。
- **网盘风控**：批量接口 + 串行 + 账号限流；大库分目录跑；blocked 整轮停。
- **Emby 把改名后的条目当新条目**，播放记录可能丢——所有整理工具的共同代价，页面上写明，建议建库前一次整理完。
- **115 目录信息有几分钟缓存**：执行后立刻在 strm 管理页校验可能误报；本地镜像由整理器自己做，不依赖网盘再列一遍。
- **追更 / 云下载的相对路径**靠收尾回写保证，回写失败要进 run 的 error 并通知。
- **夸克没有批量接口**：一部剧几百集就是几百次请求，限速下要几分钟，预览里给预估。

## 分阶段

1. **内核（纯函数）**：`services/organize/` 下 `parse-name.ts`、`units.ts`、`rules.ts`（识别词）、`template.ts`、`plan.ts`；用一百来条真实乱命名样本做表驱动测试。
2. **Provider 写操作** 115 / 夸克 / OpenList + `FakeDrive`；表和 repository；`identify.ts`（TMDB + 缓存 + 打分）；`run.ts`（preview → apply → mirror → revert）；路由；itest 覆盖执行、续跑、撤销、镜像、监控自有事件跳过。
3. **页面**：整理页 + 设置区块 + 任务表单字段。
4. **记忆与规则**：`organize_matches`、识别词作用域、二级分类预置。
5. **自动化接入**：转存 / 追更 / 云下载 / 监控四个触发点、subPath 回写、Telegram。
6. **真机验证**：115 和夸克各过一遍——改名、跨目录移动、多版本、字幕跟随、撤销、监控不重复处理、Emby 识别结果、追更目录改写后下一次 tick 正常。

## 已定（2026-09-11，按推荐值实施）

- `{category}` 段和二级分类第一版就有，默认关；关掉时模板里的分类段自动消失。预置一份按类型 / 国家 / 语言分的分类表，设置页按行编辑。
- 集标题默认关（模板里留着 `[ - {episodeTitle}]` 可选段，开了才拉季详情）。
- 自动整理默认全局 `off`，任务上可覆盖；转存弹框有「转存后整理」勾选（任务设了 auto 就直接执行，否则待确认）。

## 进度

- [x] 内核（纯函数）：`services/organize/parse-name.ts`（64 条样本）、`rules.ts`、`units.ts`、`template.ts`、`plan.ts`、`settings.ts`、`identify.ts`（TMDB 桩测试）
- [x] Provider 写操作：`DriveWriteOps`（mkdir / rename / renameMany / move / rmdirIfEmpty），115（`files/add`、`files/batch_rename`、`files/move`、`rb/delete`，同步维护 path_cache）、夸克（`/file`、`/file/rename`、`/file/move`、`/file/delete`，异步任务轮询）、OpenList（`/api/fs/*`）、`FakeDrive`
- [x] 表与迁移 0011：`organize_runs / organize_units / organize_items / organize_matches / tmdb_cache`；repository；留存清理进 housekeeping
- [x] `run.ts`：预览（列范围 → 分单元 → 识别 → 规划 → 范围外目标目录列一次查冲突）→ 改单元重规划 → 执行（mkdir → 批量改名 → 按目标目录批量移动，批失败逐个再试 → 本地镜像 → 记账 → 删空目录 → 追更 / 云下载 subPath 改写 → 记忆 → Emby 刷新 → 通知）→ 撤销；进程重启把中断的 run 标失败可续跑
- [x] 自动整理入口 `auto.ts`：转存 / 追更 / 云下载 / 监控四个触发点，监控事件攒 30s；监控对整理自己的改名 / 移动事件按 (nodeId, 新路径) 跳过
- [x] 路由 `routes/organize/*`、设置 schema（模板 / 识别词入口校验）、任务 `organize` 字段、Telegram `organize-done / organize-review`
- [x] strm 管理体检新增「命名不规范」
- [x] 前端：`/organize` 页（范围 → 预览 → 单元卡片 / 换匹配 / 季与集偏移 / 勾选 / 记住 → 执行 → 撤销 → 历史）、设置页「整理」区块（模板实时试算、id 标签、冒号、分类、识别词、自动策略）、任务弹框（库类型 / 自动整理）、转存弹框「转存后整理」、Telegram 开关
- [x] 测试：后端 632 个全过（新增 parse-name 66、rules 7、template 6、units 6、plan 9、identify 7、run.itest 18、organize 路由 4）；前端 typecheck / lint / next build 干净
- [x] 2026-09-11 评审一轮（自审 + 自动化评审），修掉的：监控只认最终路径、认不出「先原地改名」的中间事件（现在 `findOwnOperation` 认中间路径 / 反向路径 / 建目录，按事件时间和 hits ≤ 2 限定）；按路径自动触发的 run 不列范围外目标目录（现在按整棵列过的 roots 判）；改名后没挪走的中间状态不落库（加了 `cur_path`，续跑不重复改名、撤销能改回去）；本地镜像失败被吞、监控又跳过（镜像先于 done、失败记在 error、监控见 error 不跳）；失败项再执行不重试；记忆被 repath 的旧记忆盖掉（先 repath 后 remember）；`nonstandard-name` 把集名里的 Web / Cam 当噪音（先认规范形状）；「转存后整理」的 review 语义被丢（run.mode 现在有 review）；同秒建的 run 撤销判定靠随机 id（改 rowid）；`..` 范围路径；mkdir 前先看目录在不在；夸克批量移动分批；TMDB 节流和影库刮削共用一条时间线
- [x] 2026-09-11 真机验证（本机浏览器 + 115 / 夸克真账号）：115 电影目录（`Captain.America.Brave.New.World.2025...` → `美国队长4 (2025) [tmdbid=822119]/美国队长4 (2025) - 2160p.mkv`，nfo 跟随）、115 剧集目录（`Lord.of.the.Flies.S01...` → `蝇王 (2026) [tmdbid=270572]/Season 01/蝇王 - S01Exx.mkv`）、夸克剧集目录（`亿万地堡（2025）/S01/...` → `亿万地堡 (2025) [tmdbid=245648]/Season 01/...`）各走完 预览 → 执行 → 本地 strm 镜像（内容按段 URL 编码，和生成器一致）→ 监控把自己的事件认出来跳过 → 撤销 → 网盘 / 本地都回原样；115 `files/add` 回 `cid`、夸克 `/file/move` 走任务轮询都确认了；换匹配弹框的 TMDB 搜索也在真机看过。真机暴露并修掉的：
  - 本地镜像按路径匹配任务会串到别的账号（115 和夸克都有 `tv`，夸克的整理把 strm 写进了 115 任务的本地目录）：`ExecCtx.tasks` 只放同账号的任务（和监控一致），itest 加了「别的账号同名 originPath」的用例
  - 范围目录本身腾空后不删：范围就是某个发布目录（名字带年份 / 季集标记 / 发布噪音，`looksLikeReleaseDir`）时一起删，`inbox`、`电影` 这种收件箱式的留着，任务根永远不删
  - 清单里带目录项（夸克 / OpenList 的 walkSubtree）时，子目录删掉后上级还算「没空」，从深到浅清不干净：rmdir 一层就把这条目录项从 remaining 里去掉
  - 监控认不出整理自己的删目录事件（115 的删除事件路径已经不在缓存里、报成根目录下的名字；夸克快照可能在撤销开始之后才看到执行时的那次删除）：`findOwnOperation` 加 kind=remove 按节点认（rmdir 项不看状态，mkdir 项只认 reverted），115 的新建目录事件（folder）也一并跳过；监控对所有事件种类都先问一遍
  - 页面在标签页不可见时不轮询（`document.visibilityState`），回到前台 2 秒内会刷新——不是 bug，自动化测试时容易误判，记一笔
- [x] 2026-09-11 真机第二轮（本机 Docker 起 Emby + OpenList，115 真盘造假）：
  - OpenList（Local 存储挂假媒体，ffmpeg 造的小 mkv + 手写 srt / ass / nfo）：多版本电影 `Dune.Part.Two.2024.{2160p.DV.HDR,1080p}` → `沙丘2 (2024) [tmdbid=693134]/沙丘2 (2024) - 2160p.mkv` / `- 1080p.mkv`，字幕跟随并带语言标签（`chs`→`zh-CN`、`eng`→`en`，`.ass` 也跟）；剧集两集 + 字幕 + `tvshow.nfo` 进 `怒呛人生 (2023) [tmdbid=154385]/Season 01/`；OpenList 的 mkdir / rename / move / remove 四个写操作真机通过；撤销全部回原样
  - 115：用 `files/copy` 复制现有文件伪造 `Dune.Part.Two.2024.WEB-DL`（两个 mkv + 两个 nfo），多版本命名和 nfo 跟随通过，监控把 6 条自有事件（含删目录）全认出来；撤销后删掉伪造目录，监控随之清掉本地。115 改名不能改扩展名（`.nfo` 改 `.srt` 会保留 `.nfo`），所以 115 上造不出假字幕；夸克没有复制 / 上传接口，没在夸克上造假
  - Emby（amilys/embyserver，本地 strm 目录挂进容器，库开互联网元数据）：整理完 OpenStrm 触发的 `/Library/Refresh` 生效；`[tmdbid=…]` 目录标签被 Emby 直接认成 ProviderIds.Tmdb=693134 / 154385；`片名 (年) - 1080p` / `- 2160p` 两个文件在 `/Users/{id}/Items` 里合并成一部电影两个版本（`/Items` 端点不合并是 Emby 自己的展示逻辑；同 tmdbid 的目录也会按元数据合并）；strm 里的 `http://host.docker.internal:5244/d/…` 能被 Emby 探测到流信息
  - 真机暴露并修掉的：识别打分只比本地化标题、不比原名，「Dune Part Two」被同名花絮抢走、「BEEF」认成 Celebrity Beef（搜索结果现在带 `originalTitle` 一起打分；标题和原名都没对上时拿前五名的详情看别名，谁命中选谁；搜索缓存键加了版本号让旧形状的条目过期）
- [x] 2026-09-11 v2.5.0-rc.1 发出后用户问「剧集 / 电影没放自己的目录、散在 tv/ 或 movie/ 根下会怎样」：写集成测试一跑抓到 bug——范围根下只要有一个文件带集标记，根下所有散文件都被当成同一部剧并成一个单元，文件没标题时还会拿任务目录名（tv）去搜。现在范围根只看文件标题是否一致，不一致就按标题拆，任务根的名字永远不拿去搜（`units.ts`），随 v2.5.0-rc.2 发出
- [x] 2026-09-11 生产反馈「整理完旧的 strm 还在」：现象是旧剧集目录还在、最深层却是规范后的文件名，另外新目录里也有一份。根因是整理和网盘监控赛跑——整理先原地改名再批量挪，整库整理要跑几分钟，监控在「改了名还没挪走」的窗口里拉到改名事件，而 `findOwnOperation` 只认 done / reverted 的项，pending 的没认出来，监控把本地 strm 原地改了名；等镜像按原名找本地文件找不到，就在新目录另写了一份。修法：`findOwnOperation` 认 pending 且 cur_path 非空的项（改名事件按中间名字、移动事件按目标）；`mirrorRelocate` 加 `oldPathAlt`，原名找不到时按中间名字接着搬。本机小目录几秒跑完、监控插不进来，所以之前真机没暴露。已有的残留用任务全量同步（开「删除多余文件」）或体检清掉
- [ ] 真机没覆盖到的：追更目录改写后的下一次 tick（库里没有追更订阅可用）、夸克上的多版本 / 字幕（造不出文件）
- [x] 2026-09-14 失败项处理已实施并在 OpenList / 115 / 夸克三家真机验过（设计见下一节，实施与设计的出入、真机结论都在那一节末尾的「实施记录」）：后端 `failures.ts`（分类 / 重试谓词）+ `errorKind` / `attempts` / `run.stage` + 迁移 0012 + 执行中临时失败自动重试一次 + `apply` 带 ids + `POST /runs/:id/skip` + 撤销侧 curPath / done 带错 / 再撤销 + 监控按 errorKind 跳过 + Telegram 分类文案；前端 `FailurePanel` 分组给按钮、头部按钮互斥、徽标、历史芯片。后端 647 个测试全过（新增 failures 3、run.itest 8、路由 1、监控 1、通知 1、OpenList 1），前端 typecheck / lint / build 干净。OpenList 真机（Docker Local 存储 + 真 TMDB）走完：预览后移走文件 → `object not found` 归 stale → 面板「重新预览」；本地目录只读 → mirror → 「补本地」；容器停掉再撤销 → ECONNREFUSED 归 transient、自动重试一次、run 已撤销但 1 项没退回 → 起容器「继续撤销」；整理后删掉文件再撤销 → failed + stale「已找不到」→ 放弃；预览后目标被占 → OpenList 回 `code 403 file [x] exists`——原来 Provider 把 403 一律当 auth、整轮按风控停下，已改成只有权限 / token 文案的 403 才算 auth，撞名归 rejected，批量移动失败后逐个定位到那一项，「放弃」先把原地改了名的文件改回原名（真机确认）

## 失败项处理（设计，2026-09-14，未实施）

> 用户提问：「整理或者撤销的时候，关于失败项如何优化」。下面先列现状的问题，再给方案。

### 现状的问题

代码位置：`services/organize/run.ts` 的 `execute` / `revert`、`life/monitor.ts` 的 `findOwnOperation` 跳过规则、`app/organize/page.tsx` 的 `RunView`。

1. **失败只有一种颜色**。`status = failed` + 原始错误文本（`网盘上找不到 /x`、`115 接口返回 405 …`、夸克 code），用户不知道该重试、重新预览还是放弃。
2. **「继续执行」不分青红皂白**。把所有 failed 重来一遍，包括注定失败的（源文件预览后被移走、名字网盘不接受），每次都失败，run 永远挂着「N 项失败」。
3. **没有「放弃」**。没法把某项标掉让 run 收口。
4. **本地镜像失败没有出口**。`done` + `本地镜像失败` 的项不在重试范围，只能等监控（可能没开）或全量同步。
5. **撤销侧的失败是死胡同**：
   - done 项撤销抛错 → 标 `failed`、`cur_path` 空 → 不算 `touched` → 下一次撤销不包含它；run 若已标 `reverted`，撤销按钮也没了。
   - 风控中断撤销 → run 标 `failed` → 前端按「failed + 有 failed 项」反而显示**「继续执行」**，点了会把已经在目标位置的文件按源路径去找，再报「找不到」。
   - 撤销 move 项是先挪回再改名；挪回成功、改名失败时的中间位置没记（apply 侧有 `cur_path`，revert 侧没有），第二次撤销按 `dstPath` 找不到 → 「跳过」，文件卡在 `源目录/新名字`。
   - 撤销中跳过的 done 项（不在目标位置 / 节点变了 / 目录非空）被改成 `skipped`，run 显示「已撤销」，摘要里没有「N 项没退回」——`computeStats` 只按 `action = skip` 计 skipped，按状态 skipped 的不出现在任何数字里。
6. **rmdir 被 115 缓存拖成「目录不是空的」** → `skipped`，不在重试范围，空目录永远留着。
7. **网络抖动直接记 failed**，要人来点；直链那边（`resolveDownload`）早就有 3 次重试的先例。
8. **摘要 / Telegram 只有一个数字**「失败 N」。

### 目标

- 每个失败项回答三个问题：**文件现在在哪**（状态只描述位置）、**为什么失败**（分类 + 原文）、**下一步是什么**（重试 / 重新预览 / 放弃 / 补本地）。
- 一次性失败自己消化：网络抖动在 run 内自动重试；风控 / 登录失效仍整轮停。
- run 一定能收口：所有失败项都有出路，最终 `failed` 归零或被用户明确放弃。
- 撤销和执行对称：半路状态有记录、能续、能再撤，不会把撤销失败当执行失败。

### 1. 失败分类 `errorKind`

`OrganizeItem` 加 `errorKind` 和 `attempts`（DB `error_kind text default ''`、`attempts integer default 0`），`error` 原文保留。分类函数 `classifyFailure(provider, err)` 放 `services/organize/failures.ts`，和 `drive/errors.ts` 一样按三家错误类 instanceof 判：

| kind | 判定 | 意思 | 下一步 |
|---|---|---|---|
| `blocked` | `provider.classifyError` 是 blocked / auth | 风控 / 登录失效 | 整轮停（现状）；修好账号后「重试」 |
| `stale` | 我们自己抛的 `StaleError`（源找不到、父目录没了、目标位置已被占，替换现在的字符串 `Error`）、`RemoteDirNotFoundError`、网盘的「不存在」（115 / axios 404、OpenList 的 object not found、夸克对应 code） | 预览之后网盘变了 | 「重新预览」或「放弃」；默认不重试 |
| `rejected` | 网盘明确拒绝这个名字 / 目标：同名已存在、非法字符、名字过长（各家的码 / 文案实施时按客户端里已有的认；认不出的一律归 transient） | 名字网盘不接受 | 「放弃」，提示改模板 / 识别词后重新预览；默认不重试 |
| `mirror` | 网盘那步成功、`mirrorRelocate` / `mirrorRmdir` 抛错 | 本地 strm 没跟上 | 「重试」只做本地，不碰网盘 |
| `transient` | 其余：网络 / 超时 / 5xx / 夸克任务超时 / 未知 | 临时 | run 内自动重试一次，仍失败留给「重试」 |

未知错误归 transient 是安全默认：改名 / 移动重试一次最多再失败一次，不会造成新的状态。

### 2. 状态只描述位置

不变量：**`curPath` 非空 ⇒ 文件在 `curPath`；否则由状态决定**——`pending` / `failed` 在 `srcPath`，`done` 在 `dstPath`，`reverted` 在 `srcPath`，`skipped` 不再归我们管。

- 执行失败：`failed` + kind（现状，位置语义不变；改名后挪不动的仍是 `failed` + `curPath`）。
- **撤销失败：状态保持 `done`**，只写 `error` / `errorKind`。文件确实还在整理后的位置，`touched` 仍成立，下一次撤销自然包含它；`hasLaterAppliedRun` 也照常认它。
- 撤销中「文件已不在整理后的位置 / 位置上是另一个文件 / 目录非空」：`skipped` + kind `stale`（终态，只列出来）。
- 撤销 move 项先挪回再改名：挪回成功后立刻 `updateItem({ curPath: 源目录/新名字 })`，改名成功再清空并标 `reverted`；改名失败 → `done` + `curPath` + kind。再撤销时 `done && curPath` 只做改名。撤销侧镜像传 `oldPathAlt: curPath`（和 apply 侧对称，监控抢先动了本地也能找到）。
- rmdir「目录不是空的」：仍 `skipped`，但 kind `transient`，重试集合里包含它（一次 listDir + 可能的删除，幂等、便宜）。

监控的跳过规则从 `own.error === ""` 改成 **`own.errorKind !== "mirror"`**：撤销在网盘那步失败的项本地和网盘仍一致，自有事件照旧跳过；只有镜像失败才让事件去补本地。`findOwnOperation` 对 done 项认的中间路径 `源目录/新名字` 恰好也是撤销的中间位置（先挪回再改名），不用改。迁移时把已有 `done` 且 error 以「本地镜像失败」开头的项回填 kind `mirror`，规则切换才不漏。

### 3. `run.stage` 与按钮

`OrganizeRun.stage: "apply" | "revert"`（DB `stage text default 'apply'`）。`revertRun` 开始时置 `revert`，之后不再回到 apply——开始撤销的 run 只能继续撤销。

- `applyRun`：`stage === "revert"` 一律 409「这次整理已经开始撤销，只能继续撤销」。前端 `canApply` 同一条件，彻底堵掉问题 5 的第二条。
- `revertability`：状态在 `done / failed / cancelled / reverted` 之一（多了 `reverted`）+ 仍有 `touched` 项 + 没有更晚的已执行 run。`hasLaterAppliedRun` 的状态列表补上 `reverted`（有剩余 done 项的「已撤销」run 还是占着文件）。
- 撤销收尾的 run 状态：全部退回 → `reverted`；有剩余但没被风控打断 → 仍 `reverted`，`stats.notReverted > 0`，界面「已撤销 · N 项没退回」+「继续撤销」；风控 / 登录中断 → `failed` + error，`stage = revert`，界面「继续撤销」，绝不出现「继续执行」。
- 执行收尾不变：有单项失败仍是 `done`，界面「已完成 · N 项失败」+「重试失败项」。

迁移回填：`status in ('reverted','reverting')` 的 run → `stage = 'revert'`。

### 4. run 内自动重试

写操作统一包一层 `attempt(it, fn)`：失败先 `classifyFailure`，`transient` 且 `attempts < 2` 就等 `RETRY_DELAY_MS = 3000` 再来一次；`blocked` 立即抛出让整轮停；其余直接记失败。每次真实尝试 `attempts + 1`。批量改名 / 移动失败后现有的「改为逐个」本身就是一次重试，transient 时在逐个之前也等 3 秒；`blocked` 不逐个。镜像失败不自动重试（本地 FS 错误基本不是抖动），留给「重试」。

### 5. 重试集合

`applyRun` 加可选 `{ ids?: string[] }`。不给 ids 时按 `retryable(it)` 取：

- mkdir / rename / move：`pending`；`failed` 且 kind ∈ {transient, blocked, ''}；`done` 且 kind `mirror`（只重做镜像，不碰网盘）。
- rmdir：`pending` / `failed` / `skipped` 都重来。
- kind `stale` / `rejected` 的 **只有 ids 里点名才重试**（面板上用户对着那一组点「重试」）。

执行顺序不变：mkdir → 改名 → 移动 → 镜像补做 → rmdir。镜像补做单独一步放在网盘操作之前，网盘被风控时本地也能先补上。

### 6. 「放弃」

`POST /api/organize/runs/:id/skip { ids }`（≤ 500 个；有 job 在跑就 409）：

- `failed` 且 `curPath` 空：直接 `skipped`，kind 保留，error 前缀「已放弃：」。
- `failed` 且 `curPath` 非空（原地改了名、没挪走）：先在网盘上把名字改回 `srcPath` 的名字（一步），成功才 `skipped`；改不回去就仍是 `failed` + 新 error。原则：**放弃 = 用一步把文件放回干净位置，没有这一步的只能重试**。
- `done` + kind `mirror`：`skipped`，error「已放弃：本地未同步，可用全量同步或体检补齐」。
- `stage = revert` 的 `done` + error 且 `curPath` 空：`skipped`，error「已放弃撤销，文件留在整理后的位置」；`curPath` 非空（挪回了没改名）的**不给放弃**，只能重试（改回原名就是那一步失败的操作本身，没有别的干净位置）。兜底出口是删记录。
- 放弃 mkdir 项时把 `dstPath` 在它之下的 pending / failed 项一起放弃（不然它们下次重试全变 stale）。

放弃后重算 stats；`failed` 减少，run 能收口成干净的 `done` / `reverted`。

### 7. 「重新预览」

前端行为，不加接口：对 stale 一组点「重新预览」= 先对这组调 skip，再 `POST /api/organize/runs { taskId, subPath: run.scopePath, paths: run.scopePaths }`（**同范围**）并跳到新 run。幂等性保证已整理好的全是 `keep`，新 run 里只剩真正没做的；TMDB 有缓存，二次识别便宜。不按单元目录重新预览：单元源目录常常已被腾空删掉，按它扫只会得到空 run。

### 8. 摘要与通知

- `stats` 加 `failedByKind: Record<kind, number>`、`notReverted`（stage revert 下 done-带错 + skipped-stale 之和）。stats 是 JSON，不用迁移。
- 历史列表每行带「N 项失败」/「N 项没退回」小徽标。
- Telegram `organize-done`：`失败 3（临时 2、预览后变了 1），到「整理」页重试或放弃`；撤销变体 `N 项没退回`。payload 加 `failedByKind` / `notReverted`。自动模式（auto）的 run 失败也只到这一步：run 内已经自动重试过临时失败，风控停了就是要人管，不再排定时重试。

### 9. 前端

- `RunView` 头部和单元列表之间加 `FailurePanel`，只在有事可做时出现。分组顺序：网盘拒绝 / 需要重新登录 → 临时失败 → 预览后变了 → 名字不被接受 → 本地没跟上 → （stage revert）没退回。每组：数量、一句话解释、按钮（重试 / 重新预览 / 放弃，按上面的规则出现）、展开看项（路径、错误原文、已试 N 次）。
- 头部按钮互斥：`ready` →「执行 N 项」；`stage apply` 且有可重试项 →「重试失败项（N）」；`stage revert` 且 `revertable` →「继续撤销」。
- `ItemStatus` 徽标：`failed` →「失败 · 临时 / 预览后变了 / 名字不被接受 / 网盘拒绝」；`done` + mirror →「完成，本地未同步」（现有）；`stage revert` 的 `done` + error →「未退回」；`done` + `curPath` →「已挪回，待改名」；`skipped` + kind →「已放弃」。
- 放弃的确认框说明半路项会先改回原名。

### 10. 迁移 0012

```sql
ALTER TABLE organize_items ADD COLUMN error_kind text DEFAULT '' NOT NULL;
ALTER TABLE organize_items ADD COLUMN attempts integer DEFAULT 0 NOT NULL;
ALTER TABLE organize_runs ADD COLUMN stage text DEFAULT 'apply' NOT NULL;
UPDATE organize_runs SET stage = 'revert' WHERE status IN ('reverted', 'reverting');
UPDATE organize_items SET error_kind = 'mirror' WHERE status = 'done' AND error LIKE '本地镜像失败%';
```

### 11. 测试（run.itest 追加）

- transient 自动重试：第一次 rename 抛网络错、第二次成功 → 项 `done`、`attempts = 2`、run 无失败。
- blocked 不自动重试、整轮停（现有用例加 kind 断言）。
- stale：预览后删掉源文件 → `failed` + kind `stale`；不带 ids 的重试不碰它；带 ids 重试再失败一次；skip 后 run 收口。
- 放弃半路项：move 失败留 `curPath` → skip → 网盘上名字改回原名、状态 `skipped`。
- mirror 补做：镜像抛错 → `done` + kind `mirror`；再 apply 只做本地、网盘调用计数不变。
- 撤销单项失败：一项 move 回去时抛错 → 状态仍 `done` + kind、run `reverted`、`notReverted = 1`、`revertable.ok`；第二次撤销完成。
- 撤销半路：挪回成功、改名失败 → `done` + `curPath`；第二次撤销只改名（rename 计数 +1、move 不变）；本地镜像回到原位。
- 撤销开始后 apply 409；风控中断撤销的 run 前端条件（`stage`）由 `getRunDetail` 的字段钉住。
- 监控：done + revert 失败（kind transient）的自有事件仍跳过；kind mirror 的不跳（现有用例改按 kind）。
- 迁移回填：旧数据的 reverted run 有 `stage = revert`、镜像失败项有 kind `mirror`。

### 不做

- 不做逐项改目标名（`rejected` 的路是改模板 / 识别词后重新预览）。
- 不做跨 run 的定时自动重试；run 内一次 + Telegram 提醒 + 一键重试够用。
- 不改「run 有单项失败仍算 `done`」的语义。

### 分阶段

1. 后端：`failures.ts` + `errorKind` / `attempts` + run 内自动重试 + stats 分类 + 迁移 0012。
2. 撤销对称：`stage`、done 带错、撤销侧 `curPath`、再撤销、监控按 kind 跳过。
3. skip 接口 + 重试集合 + apply `ids`。
4. 前端面板 / 按钮 / 徽标 + Telegram 文案。
5. 真机：115 上人为制造 stale（预览后手动挪走一个文件）、撤销时断网一次、镜像目录改成只读各走一遍。

### 实施记录（2026-09-14）

- `attempts` 的含义改成「这一项被执行 / 撤销了几轮」（每轮 apply / revert 对处理到的项 +1，执行中的自动重试不算），界面上「已试 N 轮」；原设计的「每次真实尝试」会把 先改名再移动 的正常两步也算成 2 次，用户看着像失败过。
- 撤销时「文件已不在整理后的位置 / 位置上是另一个文件」记成 `failed` + `stale`（不是 skipped）：这样 `notReverted` 能只数 done + failed-stale，执行时就没成的 failed（非 stale，文件还在原处）不算没退回；面板里这组叫「已找不到」，只有「放弃」。
- 撤销循环用 `revertWorkItem(it, true)`：连上一轮「目录不是空的」留下的 skipped 自建目录也再看一眼（文件退回后可能空了）；判断「还有没有事」（revertability、放弃后收口）用不带参数的版本，不然永远退不完。
- 撤销循环里的分支顺序：先 reverted+mirror 补本地 → 再 `curPath && status !== done`（执行侧半路项改回原名）→ 再按 action 分；一开始写成 `status !== done` 让 skipped 的 mkdir 项走进了改名分支，`resolvePath("")` 拿到根目录、把整棵假网盘改了名（itest 抓到的）。
- `retryableItem` 对 rmdir：skipped + stale（目录已经不在）不再试；skipped + transient（不是空的）顺带再看一眼，但 `applicable` 判「有没有事」时不算它，免得每个完成的 run 都挂着「重试失败项」。
- OpenList 的 `classifyError`：`code 403` 只有文案像权限 / token（permission / forbidden / token / login / guest…）才算 auth；`file [x] exists` 这种文件系统层的 403 归 null，由 `classifyFailure` 按文案归 rejected。真机踩到。
- 「重新预览」按 run 的原范围建新 run：范围是子目录（inbox）时，已经挪出去的作品不在范围里，新 run 只剩没做的（可能是 0 部作品）；范围是整个任务时已整理好的全是「不变」。两种都对，界面文案「已经整理好的会显示为不变」在子目录范围时不完全适用，先不改。
- **动手前先看一眼目标目录（2026-09-14 真机之后加的）**：115 的 `files/move` 遇到同名不报错，悄悄把挪进去的文件改成 `xxx(1)`，记账里的 dstPath 和真实名字对不上、本地 strm 指向别人的文件（115 真机撞到）。现在改名前看源目录、移动前看目标目录、撤销挪回前看原位置，有同名就记 `rejected` 不碰网盘（`namesIn` + `occupied` + `clashError`）；刚 mkdir 的目录直接当空的不列。列目录走 `provider.listDir(id, signal, { fresh: true })` 绕过 115 进程内 5 分钟的 `filesListCache`（`DriveProvider.listDir` 多了可选的第三个参数，只有 115 实现），不然预览之后别人放进来的看不见。夸克对同名是明确拒绝（`/file/rename` 400 code 23008 `file is doloading[存在同名文件]`，`同名` 命中 REJECTED_RE），OpenList 回 403 `file [x] exists`。
- **115 / 夸克真机（2026-09-14）**：115 用 `files/copy` 从真文件复制三份到隔离目录 `_orgtest115/BEEF.S01.1080p/`（认成 怒呛人生 154385），夸克把 亿万地堡 的 E01–E03 挪进 `_orgtest/亿万地堡.S01.2025.1080p/` 改成乱名（认成 245648 high），后端用拷到 scratch 的库（监控 / Telegram / Emby / cron 全关，本地 strm 只写 scratch）。走通：预览后挪走文件 → 115 `网盘上找不到` 归 stale（夸克按 id 操作，挪走的文件照样能改名移动，做不出 stale）；预览后目标被占 → 两家都被动手前的检查拦成 rejected、半路项「放弃」改回原名（115 上第一次跑就是这里暴露了悄悄改成 (1) 的问题）；整理后删掉 / 挪走文件再撤销 → `failed + stale`「已找不到」→ 放弃。结束后 115 的伪造目录整个进回收站，夸克目录树和开始时逐字节一致。没覆盖：风控（不能故意触发）、夸克上的 stale（不删真文件做不出来）。另外夸克把目标季目录改名之后整理照样成功——它按缓存里的目录 id 挪，文件进了改名后的目录而记账仍是旧路径，本地 strm 要等监控快照纠正，属于按 id 的网盘固有行为，没改。
- 真机实验的坑：`pkill -f "tsx src/index.ts"` 杀不到（真实进程是 `node …/tsx/dist/cli.mjs src/index.ts`），端口占着新进程起不来还以为重启了；115 进程内目录缓存 5 分钟，脚本在另一个进程里挪了文件、后端预览还按旧清单算冲突，要么等要么重启后端。

### 评审后的修补（2026-09-14 晚，未提交部分随同步失败分类一起在工作区）

代码评审（八个角度 + 核实）在 2d07cd8 上抓到并修掉的：
- **连环改名被误判成撞名**：集偏移这种 E02→E01、E03→E02 的计划，改名前的检查看到目标名被占就拒了。现在占着名字的是本轮自己的节点就不算撞名（`occupied` 认一组「我们的」id），按依赖排序一个个改（占着我目标名的那项先改；A↔B 互占才拒），有连环时不用批量改名接口。移动那步同理：被本轮别的项占着的先推迟，所有批次跑完再来一遍。
- **进程崩溃后重跑把已经挪好的文件判成撞名**：目标目录里那个同名文件就是自己的节点 → 直接记账（含镜像），不再挪；改名那步同样。
- **「放弃」改成显式字段 `givenUp`**（表 `organize_items.given_up`，迁移 0012 重出，仍未发布）：不再靠错误文案前缀。放弃镜像失败的项保留 `errorKind = mirror`（监控见到自有事件仍会把本地补回来），只是不进统计 / 面板 / 重试集合；撤销阶段放弃 done 项也保持 `done`（文件就在那里），`revertWorkItem` 对 givenUp 的 done 不再算有事——放弃的只是本地镜像（kind mirror）的除外，见末节「真机复测」。
- **撤销循环不再碰放弃掉的失败 mkdir**：skipped 的 mkdir 只在有 nodeId（真建过）且不是放弃的才再看一眼，否则会把别人后来建的同名目录删掉。
- **撤销阶段放弃执行时改了名没挪走的项**：以前直接标 skipped 把位置忘了；现在不管哪个阶段，带 curPath 的 failed / pending 一律先改回原名。
- **放弃时的原名占用检查**改用 `namesIn`（fresh 列目录）+ `occupied`，和执行 / 撤销同一套；`namesIn` / `dirIdOf` 现在只要 `ListCtx`（provider / signal / 两个缓存）。
- **目录缓存原地更新**：改名 / 挪动之后 `noteRenamed` / `noteMoved` 改本轮缓存，不再整个丢掉再 fresh 列一遍（扁平目录几百部电影就是几百次列目录）。刚 mkdir 的目录直接当空的。
- **迁移回填补全**：`stage = revert` 也覆盖被风控 / 取消打断、状态是 failed / cancelled 但已有 reverted 项的 run；`error_kind = mirror` 也覆盖 reverted 状态的旧镜像失败项。
- **OpenList `listDir` 把 `fresh` 传成 `refresh`**：之前忽略了，撞名检查在 OpenList 上读的是它自己的缓存。
- **`notReverted` 只数撤销时找不到的**（撤销给 lost 项记了 finishedAt），执行时就没成的 stale 失败（文件在原处）不算。
- **失败面板分组挪到后端**（`failureGroups` → `OrganizeRunDetail.groups`，含每组的 retry / skip / repreview / held），前端只管文案（`failureGroupMeta`）；`applicability.count` 不再把「目录不是空的」的 rmdir 算进按钮上的数字。
- 清理：`messageOf` 收进 `lib/errors.ts`，`errMsg` / `causeOf` 删掉；两个分类器不再 import 三家客户端的错误类，改用 `drive/errors.ts` 的 `driveErrorFacts`（状态码 / 传输层 / 异步任务 / 登录码）；`REJECTED_RE` 去掉 `invalid`、`missing` 这种泛词；执行前的失败项归零用一条 `updateItems`。
- 没改的（评审提过但不值得）：`curPath` 在执行 / 撤销两个阶段各有含义（靠 status 区分，路径本身相同）；前端 `groups` 之外仍保留 `applicable` / `revertable` 两个后端算的开关。
- 新增用例：连环改名按依赖顺序、上次挪到一半没记账、撤销阶段放弃半路项 + 放弃掉的 mkdir 不碰同名目录；放弃镜像 / 放弃撤销的断言改成看 `givenUp`。
### 真机复测（2026-09-14 晚，评审修补之后）

环境同上一轮：Docker OpenList（Local 存储 + 假媒体）、115 / 夸克真账号、后端跑 scratch 拷贝的库（迁移 0012 在拷贝上跑过，监控 / Telegram / Emby / cron 全关）、真 TMDB。走通：

- A 预览后目标被占 → rejected（动手前的检查拦住，网盘没动）→「放弃」先改回原名 → run 收口成 done → 撤销：放弃项原地不动、其余退回、本地 strm 跟着回。
- B1 已规范命名的目录（在 `done/` 子目录里）带集偏移 +1 → 执行时同目录连环改名按依赖顺序（E03→E04 先）→ 撤销全部退回、目录树和 strm 与开始时一致。
- B2 目录已在库里只改集号（纯 rename 项）→ 撤销。
- C 整理后在网盘外删掉一个文件再撤销 → `failed + stale`「已找不到」→ 放弃 → `notReverted` 归零、run 收口。
- D 本地作品目录只读 → 三项 done + mirror（文案「没有写入 data 目录的权限；检查属主 / PUID / PGID」）→ 放弃一项 → 目录改回可写「重试」只补其余两项 → 撤销连放弃过的那项一起退回。
- 夸克真机：亿万地堡 E06–E08 用 `paths` 圈出来、集偏移 +1 原地连环改名（E08→E09 先）→ 撤销按依赖倒序改回，季目录清单（名字 / id / 大小）逐字节一致。
- 浏览器：整理页 `?run=` 打开 A 的 run，头部徽标、「需要处理的项」面板（名字不被接受 · 1，重试 / 放弃 / 看文件）、放弃对话框、撤销都走了一遍。

复测暴露并修掉的两个 bug（都是撤销侧）：

1. **撤销顺序**。撤销按流水账逆序退，连环改名的项倒回来会撞自己人：E03→E04 先退成 E03，轮到 E02→E03 挪回时中间名 E03 已经被占 → rejected（OpenList 真机就是这样挂的）。新增 `orderRevert`：A 的原名现在被本轮还没退回的 B 占着（同一原目录里 B 现在的名字 == A 的原名）就等 B 先退；跨目录挪回的 A 顶着现在的名字进原目录，撞上还在原目录里的 B 也等 B；转圈互占的单列记 rejected；目录项位置不动。用例两条（跨目录 / 同目录），把排序拿掉都会挂。
2. **放弃过镜像失败的项撤销时不退回**。`revertWorkItem` 对 givenUp 的 done 一律不算事，把「放弃补本地」和「放弃撤销」混成一个了——放弃本地镜像的项网盘那步是做过的，撤销时照样要退，不然 run 标已撤销、文件却留在整理后的位置。现在 done + mirror + givenUp 仍进撤销；撤销侧的结果都是新账（退回 / 网盘失败 / 找不到都把 givenUp 清掉，退回后不再显示「放弃」）；放弃镜像的对话框补一句「之后撤销时照样退回」。用例 + `failures.test` 断言。

顺手：rmdir「目录不是空的」的 115 缓存那句只在 115 上说。没改的观察：撤销时「已找不到」的项，本地 strm 留在整理后的位置（文件本来就不在了），等全量同步 / 体检清掉。

### 第二轮评审（2026-09-14 晚，959cbbb / df96401 提交之后）

`/code-review high` 覆盖 v2 上未发布的三个提交：10 条确认、2 条存疑、几条清理项，全部处理（整理侧的记这里，同步任务侧的记 task-failures.md）：

- **路径里的「405」「cookie」被当成风控**。115 的 `classifyError` 原来对任何错误按文案猜：`StaleError("网盘上找不到 /tv/Room 405/x")`、`PermanentError("File not found … /电影/1405年")` 都会变成 blocked，整轮停下且失败项永远在默认重试集里。现在 115 客户端的业务错误（`ensureOk`）有自己的类 `Cloud115ApiError`（带 errno），115 只对接口层的错误（`Cloud115Error` / `Cloud115ApiError` / `ShareApiError` / axios 响应）按文案猜；两个分类器共用 `drive/errors.ts` 的 `accountIssueOf`（provider → 登录码 → 只对接口错误的文案兜底），`classifyAccountIssue` 挪到那里（notify 转一手）；`classifyFailure` 先认自己的 `StaleError` / `RemoteDirNotFoundError` 再问账号问题；`driveErrorFacts` 多了 `api`，并会看 `PermanentError.cause`（OpenList 取文件信息回 401 那种，客户端现在把原错误挂在 cause 上）。
- **连环改名里给我腾名字的那项撞了别人**。依赖排序把「owner 不在待改集合里」当成已让路，owner 其实是预检失败、名字还占着，后面那项改过去要么被拒、要么被 115 悄悄改成 (1)。现在 owner 失败的项级联记 rejected（「占着 X 的那一项没改成」），逐个改名前再看一眼本轮的目录缓存。
- **跨目录移动只让路一轮**。三个串成链（X 要去的名字被 Y 占着，Y 的被 Z 占着）按目标目录批次的顺序一轮解不开，链头被记成撞名。现在有进展就再来一轮，一轮一个都没挪成才按撞名记。
- **监控把「挪回来了、改回原名失败」的项当已镜像**。done 带 curPath 时本地还没跟上（镜像在改名之后才做），事件要照常处理；`ownOk` 加了这一条。
- **进程在最后一项做完、run 状态还没写时重启**。标成 failed 后「没有要重试的项」，再也执行不了，收尾（追更目录改写、识别记忆）永远不跑，还挡着前一次整理的撤销。`reconcileInterruptedRuns` 现在先看清单：没事可做的按正常结束收口（`afterApply` / 新拆出的 `afterRevert`，两者都只做 DB 操作、改成同步）。
- **撤销阶段的 stale 没有分组**。done + stale（网盘按文案说找不到）进了统计却没有按钮；分组加了 stale，前端文案「退回时找不到位置」。
- **放弃后收口看错条件**。只看默认重试集是不是空的，stale / rejected 的失败项还在也会把 run 标成 done。现在按失败分组判断（本地没跟上的除外，执行本来就不因它算失败）。
- 清理：`orderRevert` 用查表代替 n² 扫描；`getRunDetail` 只列一次 items / units；撤销时按整理后的目录列一次（本轮缓存）找文件，不再每个文件 resolvePath；`mirrorBack` 复用 `intermediateOf`。
- 没改的两条存疑：`withRetry` 对 OpenList 按路径的移动在「超时但其实已挪成」后重发，记的原因会从 transient 变成 stale（文件的结局和以前一样，只是记账原因不同）；代理 / WAF 层不带权限字样的 403 现在归 transient 自动重试一次，而不是按登录失效整轮停——更保守，接受。

用例：`drive/errors.test.ts`（facts / accountIssueOf）、`failures.test` 的 stale 先于账号、`run.itest` 五条（owner 失败级联、三链移动、重启收口、放弃后不误收口、撤销阶段 stale 分组）、`monitor.itest` 的半路项。

## 识别补漏：零宽字符与标题后面粘着的集数（2026-09-14 夜）

用户贴了两张预览截图，两个单元的视频全是「跳过 · 看不出是第几集」：

- **回家的诱惑 (2011)**：E36–E68 共 33 个文件，名字看着是 `回家的诱惑.2011.S01E36.mp4`，实际是 `S01E` + U+200B + `36` + U+200B（本机 strm 镜像里 xxd 看得到，分享资源里常见）。`S01E36` 被拆坏，33 个文件解析成同一个标题、没有集数：单元阶段按「同名多版本的电影」猜类型并给了提示，TMDB 却认成剧集，提示和匹配自相矛盾，每集都跳过。E01–E35 名字干净（推测之前已经整理走了，截图单元里只剩这 33 个）。
- **我和僵尸有个约会 (1998)**：`season1/我和僵尸有个约会01.mp4 … 35.mp4`，标题和集数之间没有分隔，解析器把数字当成标题的一部分。

改动：

- `lib/text.ts` 的 `stripInvisible`：去掉 Unicode Default_Ignorable 字符（零宽空格 / 连接符、BOM、软连字符、方向控制符）。用在 `parseMediaName`、`parseWithRules`（识别词也看干净的名字）、`seasonDirNumber` / `isExtrasDirName`、`hasReleaseNoise`、`idTagFromName`，以及影库刮削的 `media-title.normalizeTitle`。网盘上的真实名字不动，改名的目标本来就是模板拼出来的干净名字。
- 解析器：标题后面补零的数字是集数——`X01` / `X 01` / `X01-02` / `X001`（在名字最后、或后面跟技术词）；`剧场版01`、`剧场版 01` 是第几部电影，不算。不补零的（`流浪地球2`、`速度与激情10`）解析时不定，`trailingNumber(parsed)` 只负责拆成「标题 + 数字」。
- `units.promoteTrailingEpisodes`：同一单元根下，尾巴数字在三种上下文里当集数——文件在季目录里；去掉数字后和已经有集数的兄弟同名（`X01 … X09` 带出 `X10 …`）；剧集库里有两个以上同名兄弟。电影系列（`叶问系列/叶问1 … 4`）三样都不沾，照旧按标题拆。字幕也一样认。
- `plan.resolveEpisode`：单元阶段没敢认的（单独一个新文件、没有季目录也没有兄弟），TMDB 已经认成剧集、去掉数字正好是剧名（对单元标题候选和 TMDB 译名 / 原名 / 英文名，用 `normalizeTitle` 比）时当绝对集数；模板的 `{absolute}` 也用这个数。
- 「N 个视频没有集数标记，按同一部电影的多个版本处理」改成 `Unit.multiVersion`，规划时 TMDB 没认成剧集才说。`normalizeTitle` 从 identify 挪到 parse-name（plan 要用，纯函数模块不该依赖带库的 identify）。

测试：parse-name 样本 11 条 + 零宽字符 / `trailingNumber` 两组，units 三条（季目录粘集数、平铺 / 剧集库 / 电影系列、零宽字符），plan 两条（TMDB 剧集兜底、多版本提示只对电影），`lib/text.test`，run.itest 一条（零宽字符 + 粘集数走完 预览 → 执行 → 本地 strm 跟着挪）。后端 694 个全过，typecheck / lint 干净。

真数据：拿本机 `data/tv` 镜像里的真实文件名（.strm 换回 .mp4）+ 真 TMDB 跑 单元 → 识别 → 规划（scratch 库，不碰网盘）。截图里的状态：回家的诱惑 33 个 → S01E36–E68（TMDB S1=68，把握大），我和僵尸有个约会 season1 → S01E01–E35（TMDB S1=35，基本对），两条提示都没了；整个镜像（含 season2 / 3 的 `我和僵尸有个约会2.EP01`）182 项移动、零冲突，只有一张 `184445.jpg` 找不到对应视频照旧跳过。

踩坑：测试里写的零宽字符转义（反斜杠 u200B 这种），经 Edit / Write 的参数一解码，文件里落的是真字符（普通字符串里 eslint 不报，模板串里 `no-irregular-whitespace` 才报）。写完用脚本把 Default_Ignorable 字符转回转义写法，再扫一遍确认源码里一个真字符都不剩。

### 范围直接选季目录（同一晚，用户说「季目录那个也一起修」）

原来范围选到 `我和僵尸有个约会/season2` 时，单元根停在范围目录本身（`unitRootFor` 不往范围外走）：季号认不出来、默认第 1 季，范围目录名 `season2` 当不了标题，只能拿文件里的 `我和僵尸有个约会2` 去搜。

- `buildUnits`：范围本身是季目录时，往上找单元根的边界放宽到它的上一级——和平时季目录归上一级一样，单元根是剧目录（标题、id 标签、影库证据、识别记忆都按剧目录认），季号从范围目录名来，文件还是只有范围里的；普通范围照旧不往上走。任务直接建在季目录上（任务根本身叫 `Season 2`）时上不去，季号也照样认。原来的 `scopeName` 选项其实只在单元根落在任务根时用、存的就是任务根的名字，改名 `taskRootName`，`run.ts` 一律传 originPath 的最后一段。
- `looksLikeReleaseDir` 把季目录（含 `Specials` / `番外`）也算上：范围是季目录、整理后腾空了就删；剧目录在范围外不碰。
- 追更 / 云下载落点：原来只在「单元根腾空删掉」时改写（单元根 → 作品目录）。季目录当范围时单元根是剧目录、不会被删，新加的 `dirMappings` 给其它腾空删掉的目录也出映射——里面直接放着的项都挪进了同一个目录的（`某剧/season2` → `作品目录/Season 02`），长的 from 排前面（改写取第一个命中的）。撤销时反过来，但非单元根的只认这次新建出来的目标目录（原来就有的目录，别的追更本来就可能指着它，不拽回来）。顺带，整理整部剧时指着 `某剧/season2` 的追更也改到 `Season 02`，不再是前缀拼出来的、并不存在的 `作品目录/season2`。
- 预览里「被 N 条追更 / 云下载引用」：单元根越到范围外时只数范围里的，指着剧目录的那条这次不会改。

测试：units 一条（季目录范围、季目录范围里粘集数、Specials、任务根是季目录、普通范围不往上走）；run.itest 两条（季目录范围：按剧目录识别、S02、只删季目录、追更跟到 Season 02、撤销改回、referencedBy 只数范围里的；整理整部剧：season2 的追更去 Season 02、剧目录的追更去作品目录、撤销都改回）；`looksLikeReleaseDir` 样本加 season2 / Specials / 番外。后端 697 个全过，typecheck / lint 干净。真数据：本机镜像 `我和僵尸有个约会/season2`（43 个 `我和僵尸有个约会2.EPxx`）当范围跑 → 单元根是剧目录、TMDB #19389、S02E01–E43 进 `Season 02`、删 season2、零冲突零跳过；截图那两个单元复跑结果不变。

## nfo / 图片 / 附属文件（2026-09-14 夜）

用户问「目录里有 nfo、png、jpg 会触发什么问题」。拿本机镜像的真实文件（`黑镜 (2011)` 整套刮削文件：tvshow.nfo、season.nfo、分集 nfo / thumb、poster / banner / clearlogo / background / characterart / seasonXX-*；随手放的 `184445.jpg`、`390561_front.jpg`；发布组的纯文本 nfo）和几种常见布局只跑 单元 → 规划，查到六处问题；用户说「按你推荐的制定计划开始吧」。

### 问题（按严重程度）

1. **nfo 证据取错 id。** 按路径排序只读前三个 nfo（`黑镜` 读到的是 season.nfo 和两个分集 nfo，tvshow.nfo 排不上），每个文件取第一个 `<tmdbid>`（演员块里的也算），整份没有才看 uniqueid（分集 nfo 里是这一集自己的 id）。同一正则套三种写法：本机分集 nfo 剧 id 写在最前 → 42009 对；剧 id 只在 uniqueid、演员带 `<tmdbid>` → 取到演员 40477；分集 nfo 只有自己的 uniqueid → 6085098。证据给 high，还排在目录名 `[tmdbid=…]` 前面，自动整理会直接执行。
2. **finalizeItems 在冲突判定之前取「会挪走的源」。** 冲突留下的项被当成挪走：删空目录算错（执行时跳过「目录不是空的」，预览是错的）；撞名判断也可能把东西排到还被占着的名字上（执行前的预检会拦成 rejected）。
3. **新一季并进已有作品目录卡住自动整理。** 新季带的 poster / fanart / tvshow.nfo 和作品目录里已有的撞名算冲突，自动整理要零冲突才直接执行。
4. **季目录里的 season.nfo / poster.jpg 当成作品级挪到剧目录根。** 放错层；多季互相撞名；剧根没海报时季海报变成剧海报。
5. **名单外的作品级图片跳过，旧目录删不掉。** background、characterart、seasonXX-thumb、extrafanart/ 这类。
6. **单视频目录里名字对不上的图片 / nfo 硬配给那个视频，还按视频名长度截原名**（`某片 (2021)0561_front.jpg`）。

### 方案

1. **nfo 证据（新模块 `nfo.ts`）**
   - `readNfoFacts(xml)`：按层级读 XML，只看根元素直属的子元素（演员 / 导演 / 合集块里的不算）。`tvshow` / `movie`：`uniqueid type="tmdb"`，没有再看 `<tmdbid>`，标题取 title + originaltitle；`episodedetails`：只认 `<tmdbid>`（有的刮削器在这写剧的 id），不认 uniqueid（这一集自己的），标题取 showtitle（它的 title 是集名）；`season` 和其它根没有作品 id；纯文本发布说明没有根元素，什么都不给。
   - `nfoEvidence(saveDir, unit)`：tvshow.nfo / movie.nfo 在前，其余按目录深浅；花絮目录里的和 season.nfo 不读；最多读 5 个；媒体类型按根元素定。
   - 识别核对：证据带着 nfo 自己写的标题（没写剧名的分集 nfo 用单元的标题），TMDB 详情的译名 / 原名 / 英文名 / 别名对不上就不用，单元提示里说一句，接着试下一条证据或去搜。
   - 证据顺序：目录名 `[tmdbid=…]`（多半是整理自己写的）→ 本地 nfo → 影库条目；`IdEvidence.known` 可以是数组，按顺序试。
2. **finalizeItems 收敛**：冲突判定按「还在挪的项」重算源集合，有新的项留下就再来一轮（项只会从挪变留，一定收敛）；建目录、删空目录都按最终结果。
3. **附属文件（字幕 / nfo / 图片）两个规划期标记**，不落库：
   - `soft`：目标被占（已存在、和别的项同目标、改名会撞源目录里的文件）不算冲突，标 skip「……留在原处」，不卡自动整理；
   - `follows`：跟着哪些视频，一个都没落到计划位置（冲突 / 跳过）就不挪，免得字幕 / nfo 挪到新目录挨着别的版本。
   - `patchUnit` 改成按内存里的单元把所有单元重新规划一遍再 finalizeItems（原来从库里的项反推，这两个标记会丢）。
4. **季这一层**：季目录里的目录级图片（poster / folder / fanart / banner / thumb …）和 season.nfo 进这个季目录里的视频要去的新季目录（取目标目录里最多的那个，跟着这批视频）；剧根的 `seasonXX-poster.jpg` 照旧进作品根。
5. **名单**：目录级图片补 background / characterart / discart / keyart；季图片 `season(数字|-all|-specials)(-图片种类)?`；艺术图目录 extrafanart / extrathumbs / .actors 像花絮目录一样归上一级（标 `artDir`），整个进作品目录。
6. **名字对不上的图片 / nfo**：单元有自己的目录（不是任务根、不是从大目录里拆出来的；范围根的话目录名就是这部作品）时原名跟进作品目录，否则照旧不动；不再硬配给唯一的视频、不再截名。

### 测试

- `nfo.test`：真实结构（本机三种 nfo 原样）、只有 uniqueid + 演员带 tmdbid、分集只有自己的 uniqueid、合集块、CDATA / 实体、纯文本；证据的读取顺序（临时目录里写文件）。
- `identify.test`：nfo 标题对不上被弃用、有提示、改去搜；证据数组按顺序、第一条弃用后用下一条；分集 nfo 用单元标题核对。
- `plan.test`：黑镜真实布局全部各就各位、旧目录删掉；季目录图片 / season.nfo 进新季目录；艺术图目录；并进已有作品目录不算冲突、源目录不删；视频冲突后附属文件留下、源目录不删；冲突让出的位置不再当空；名字对不上的原名跟进 / 大目录里的不动。
- `units.test`：艺术图目录归上一级；ownsDir。
- `run.itest`：本地 nfo 标题对不上 → 提示 + 按搜索认；并进已有作品目录零冲突执行成功；patchUnit 之后别的单元的 soft / follows 还在。

### 进度

- [x] nfo.ts + 识别核对 + 证据顺序
- [x] finalizeItems 收敛 + soft / follows + patchUnit 全量重规划
- [x] 季层 / 名单 / 艺术图目录 / 名字对不上的
- [x] 测试、真数据复跑、记录

### 实施记录（2026-09-14 夜）

按方案做完，另有两处是自审时补的：

- 跟某个视频同名的 nfo / thumb，要是那个视频没排上（看不出集数、和别的版本撞了同一个目标），只在已排上的视频里找会找不到，掉进「名字认不出」原名挪进作品目录、把视频留在原处；现在在单元的全部视频里找主人，主人没排上就跟着留下（「对应的视频没挪，跟着留在原处」）。
- 证据里的 id 在 TMDB 上查不到（分集自己的 id 被当成剧 id 这种）也记一句提示，再往下试。

验证：

- 后端 714 个测试全过（新增 nfo 4、identify 2、plan 7、units 1、run.itest 3），typecheck / lint 干净，源码里没有真零宽字符。
- 本机真实 nfo：`黑镜` 的 tvshow.nfo → 42009 + 标题「黑镜 / Black Mirror」，排在最前读；season.nfo → 没有作品 id；6 个分集 nfo → 42009（`<tmdbid>`，不取 uniqueid 6085098、不取演员块）；Severance / 美国队长4 的发布说明 nfo → 不是 XML。
- 真 TMDB（scratch 库）：tvshow.nfo → #42009 high；只有分集 nfo → 用目录名核对 → #42009 high；串进来的演员 id 40477 在 TMDB 上是「绝对达令」→ 对不上弃用、改搜 → #42009 high 并留提示（原来的取法会以 high 认成「绝对达令」）；分集 id 6085098 → TMDB 上查不到 → 提示 + 改搜。
- 布局模拟（只跑 单元 → 规划）：`黑镜 (2011)` 全部各就各位，零冲突零遗留，Season 7 和剧目录都腾空删掉；季目录里的 poster / season.nfo 进各自的 Season 0X；并进已有作品目录 → 三个 soft skip、零冲突、源目录不删；`雷霆特攻队/390561_front.jpg` → 原名进作品目录，不再截名。

没做：整理不改 nfo 的内容，用了集偏移 / 换匹配之后 nfo 里写的季号集号和新文件名对不上；只有改编号时才会出现，Emby 是否以 nfo 为准也没实测，先不动。

## 真机验证：识别补漏 / 季目录范围 / nfo（2026-09-15，v2.6.0-rc.2）

用户说「真机测试一下」。后端起在 scratch 拷贝的库上（关掉网盘监控 / Telegram / Emby / 任务定时，临时口令），115 真网盘 + 真 TMDB，前端 dev 3222 看页面。

只读预览（生产的 115 `tv` 任务，不执行）：

- `回家的诱惑`：33 个带零宽空格的文件 → `回家的诱惑 (2011) [tmdbid=84656]/Season 01/回家的诱惑 - S01E36…E68`，把握大；并进已有的 Season 01，不建目录；范围目录名不像发布目录，腾空也不删（按设计）。
- `我和僵尸有个约会`：season1 的 33 个粘集数文件 → S01E01…E35（网盘上本来就缺 10 / 11），基本对；`184445.jpg` 原名跟进作品根；建 `Season 01`（作品目录里只有 Season 02 / 03），删 season1。
- `我和僵尸有个约会/season1`（季目录范围）：单元根到剧目录，只动范围里的 33 个视频，范围外的 jpg 不动，删 season1。
- `黑镜 (2011)`（只剩 background / characterart / season02-thumb 三张图）：0 个单元，什么都不动。

115 隔离目录：根下 `organize-lab`（所有任务目录之外，生产的监控不管），给它建了个测试任务，用 `files/copy` 从真实目录复制造六组——零宽字符两集 + 目标位置已有 poster；已有的 `回家的诱惑 (2011) [tmdbid=84656]/Season 01`（放了 E01）；季目录粘集数 + 剧根 jpg；只有图片的目录；目录名认不出（`BM`）+ tvshow.nfo + 发布名分集（mkv / nfo / -thumb 改名成 `Black.Mirror.S07E01.1080p.NF.WEB-DL.*`）；只有分集 nfo（`BM2`）。nfo 证据读的是本地同步下来的 nfo，所以先跑一遍同步任务把 strm 和 nfo / 图片拉到本地。

- 整个任务预览：BM「本地 tvshow.nfo 里的 tmdbid」#42009 把握大；BM2「本地 …S07E03….nfo 里的 tmdbid」#42009 把握大——真实分集 nfo 的根下直属 `<tmdbid>42009</tmdbid>`，uniqueid 是分集自己的 5534733，演员块里还有四个 `<tmdbid>`，都没取。BM / BM2 并进同一个作品目录，只建一次；分集 nfo / thumb 跟着视频的新名字；tvshow.nfo / poster / clearlogo / season07-poster 进作品根；目标已有 poster 的那张 soft skip「目标位置已经有同名的，留在原处」，零冲突。
- 执行：29 项全部完成，网盘和本地镜像（strm + 下载下来的 nfo / 图片）一致；撤销：29 项全部退回，零宽字符原样回来，本轮新建的两个作品目录删掉，原来就有的 `回家的诱惑 (2011) [tmdbid=84656]/Season 01`（带 E01）不动。
- 季目录范围 `我和僵尸有个约会/season1`：执行后 season1 删掉、剧根的 jpg 留着、3 集进新建的 `Season 01`；撤销后原样。
- patchUnit：取消勾选 BM 后，BM 的 10 项变「未勾选」跳过，BM2 还要用的两个建目录留着，BM 自己的两个删目录没了（29 → 17 项）。
- 页面：截图里那两个单元不再是「看不出是第几集」；nfo 证据、soft skip 的原因、目录操作、已完成 / 已撤销的状态都正常。

顺带看到的（不是这次改动带来的），用户说「按照你的推荐开始吧」，已改：

- 同一个 run：执行后「29 项完成」，撤销后页面「19 项已退回」，日志 / Telegram「退回 23 项」，三个数。页面的 `revertedCount` 只数改名 / 移动；后端撤销收尾用的 `n` 数文件和删掉的新建目录，删目录项标了 reverted 却没 `n++`。现在页面和后端都数 status = reverted 的项（累计，和执行时的 `stats.done` 同一个口径）；`n` 只留着决定刷不刷 Emby；「N 项没退回」仍是只数文件的 `stats.notReverted`，失败面板靠它。
- 执行 / 撤销的收尾那句（「执行完成：…」「撤销完成：…」和风控停下的那句）写在 `updateRun(… log: job.logs …)` 之后，从来没落进 run 的日志：页面上执行完的日志只有「开始执行」一行。挪到落库之前。
- 测试：run.itest「撤销」那条加断言——执行完的日志里有收尾那句；退回的项数等于执行时的 done 数、含建目录 / 删目录；撤销日志和通知里是同一个数。

没覆盖：追更 / 云下载落点改写（真库里没有记录引用这几个目录，`referencedBy` 全是 0，靠 run.itest）。

收尾：`/organize-lab` 进 115 回收站；scratch 库（含 cookie）、临时口令、token 删掉；lab 后端停掉，浏览器里的 token 清掉。

## 整理页评审与修补（2026-09-15，v2.6.0 之后）

> 用户先让分析整理页哪里不合理、哪里不完善（只读代码，列了 21 条），随后说「按照你的推荐制定计划开始吧」。阶段按推荐的顺序排（正确性 → 入口和撤销 → 页面功能），中间插一步详情接口的改造：后面的按文件勾选、筛选都要用按单元的计数和按需加载的文件表，先改数据形状省得返工。21 条全部有着落，只有「逐项改目标名」沿用原设计不做（见本节「不做」）。

### 发现（按影响排）

一、会出错或显示不对

1. **改单元和执行赛跑**：`patchUnit` 在 `await listOutsideDstDirs` 之后直接 `replaceItems`，不再看 run 状态；页面勾选框不设 busy，「执行」照常可点。范围是子目录时（每次勾选都要去网盘列目标目录）勾掉一个单元马上执行：执行拿旧项跑，patch 回来把项全删了重插，执行对旧 id 的记账全落空，撤销判「没有改动任何文件」。「放弃」（skipItems 里要改回原名，也有 await）和「重试失败项」之间是同一类窗口。
2. **取消执行 / 撤销走 `startJob` 的 catch**：只写状态和日志，stats 停在上一次，`afterApply`（追更目录改写、识别记忆）和 Emby 刷新都跳过；头部徽标、历史读 stats，失败面板读 items，两边对不上。
3. **预览失败 / 取消时正文说「范围里没有视频文件」**。
4. **进程重启后「待执行」的单元结构没了**（`planStates` 只在内存），页面照样给改，一点就 409。
5. **范围选择器从账号根开始**，选到任务目录外时整条路径被当成相对路径；手输 `/tv/某剧` 会变成 `/tv/tv/某剧`；目录不存在要等预览失败才知道。
6. **「没识别」提示说能手填**，换匹配弹框只有关键词搜索（multi 只取前 10、不能限年份 / 类型）。
7. **设置里「范围目录本身不动」和行为不符**：范围是发布目录 / 季目录时腾空了会一起删。
8. **文件表里所有 reason 都用错误色**：「未勾选」「花絮不动」「留在原处」和真失败一样红。
9. **执行确认框「改名 / 移动 N 项」的 N 含建目录 / 删目录**。纠正分析时的说法：单元卡的「要动」加上「目录操作」那一栏正好等于头部的数，不对的只是确认框的措辞。

二、流程上找不到、绕

10. **要人管的 run 没有入口**：自动整理的待确认清单、有失败要处理的 run，页面一进来都是空状态；历史按任务分、默认第一个任务、只取 30 条；侧栏没角标。
11. **只能撤销最近一次**（`hasLaterAppliedRun`）：开了自动整理，一集新剧自动执行一次，前面手动整理的整批就撤不了。
12. **任务下拉框和打开的 run 不同步**，run 视图看不出属于哪个任务；待执行的 run 头部没有「重新预览」。
13. **任务有整理在跑时点预览**：409 带了 runId，页面只弹 toast。
14. **一次只能选一个范围**：后端的 `paths` 是给自动整理的新增路径用的，页面没有多范围。
15. **放着不执行的预览永远不清理**；几天前的预览照样能直接执行，没有提示。

三、功能缺口

16. **只能整单元勾选，不能按文件**（设计里的 `PUT /runs/:id/items` 没做）。
17. **单元列表没有筛选 / 排序 / 批量**，已规范的作品也占一张卡；每次勾选都全量重规划，勾选框没有进行中的反馈。
18. **识别记忆看不到、删不掉**：接口和前端 api 都有，没有页面在用。
19. **详情一次带全部项**（上限 2 万个文件），执行中每 2 秒全量拉一次。
20. **strm 管理「命名不规范」没有直达整理的链接**（设计里说的「点过去预填整理范围」）。
21. 日志只显示最后 100 行（存了 300）；自动触发的 run 不列新增路径；冲突项没有就地处理的办法。

### 方案

**阶段一：正确性（1、2、4、3，外加 7、8、9 的文案 / 配色，以及 3、4 要用的「重新预览」接口）**

- 1：run 级「写操作进行中」计数：`patchUnit` / `skipItems` 进出各加减一，`applyRun` / `revertRun` / `deleteRun` 见到非零回 409「还有修改在保存，稍等再执行」。`patchUnit` 的写库全部挪到最后一个 await 之后的同步段：写之前再确认 `status === "ready"`、`planStates` 还是同一份（中途被取消 / 取代 / 删掉就 409、什么都不写），并从库里重读这个单元的最新行再套 patch（两个 patch 交错时后一个不会把前一个的改动盖回去）。前端：patch / 放弃进行中禁用执行 / 撤销 / 删除，勾选框显示进行中。
- 2：执行和撤销的主循环包一层，取消（AbortError / signal.aborted）不往外抛，走和正常结束一样的收尾：算 stats、日志「已取消：…」、状态 cancelled；执行侧照常 `afterApply` + Emby 刷新（取消多半停在移动那步，删空目录还没做，追更改写只会改已经删掉的目录）。撤销侧 `afterRevert` 改成按映射判断：这条映射下有文件已经退回（源目录又有了）才改回去，一个都没退回的继续指着作品目录——取消和部分失败（找不到 / 被拒）都靠这一条保证追更 / 云下载指着存在的目录。`dirMappings` 带上每条映射涉及的项。`reconcileInterruptedRuns` 标失败时按清单重算 stats。
- 4：详情加 `editable`（ready 且单元结构还在内存）；不能改时页面灰掉换匹配 / 季集偏移 / 勾选，给一条说明 +「重新预览」。
- 3：页面按状态区分：识别中 → 转圈；预览失败 → 「预览没做完」+ 错误原文 +「重新预览」；预览被取消 → 「预览已取消」+「重新预览」；只有预览完成且确实 0 个单元才说「范围里没有视频文件」。预览没完成时不显示「0 部作品 / 0 项要动」徽标。
- 重新预览：`POST /api/organize/runs/:id/repreview`，按原范围、原触发来源建一个新的手动（manual 模式，不自动执行、不发待确认通知）预览；新增路径的 run 保留新增路径的语义。页面上所有「重新预览」（失败面板的 stale 组、预览失败、不能再改、过期提示、头部按钮）都走它。
- 7：「执行后删掉腾空的源目录」说明改成：只删这次挪空的目录；范围目录本身是发布目录或季目录时也一起删，任务根目录和 inbox 这种收件箱目录不删。
- 8：文件表：错误原文、冲突原因用错误色；跳过的原因用警告色（单元没勾选 / 文件没勾选的用灰色）；不动的原因用灰色。
- 9：确认框拆开说：「改名 / 移动 X 个文件，建 Y 个目录，删 Z 个空目录」。

**阶段二：撤销和入口（11、15、13、10）**

- 11：撤销放宽成「后面的整理动过这次整理挪好的文件才拦」：同任务里更晚建的 run，有改名 / 移动项（done 或带 cur_path）的源路径正好是这次 done 项的目标路径，就不让撤，原因「后面的整理（时间）又动过这次整理挪好的文件，先撤销那一次」，带 `blockedBy`（页面给链接）。互不相干的后续整理（自动整理了一集新剧、整理了别的目录）不再挡。逐项撤销本来就逐项核对位置 / 节点 / 原位置占用，放宽之后仍然安全。**这改了原设计「撤销只允许对最近一次 done 的 run 做」的决定。** 只比路径不比节点 id：OpenList 的 id 不可靠，路径对不上的情况撤销时会按「已找不到」处理，不会弄乱。
- 15：预览完成时把同任务、范围被它覆盖的旧「待执行」预览标成已取消（error「已被新的预览取代」）。覆盖 = 旧范围的每一条路径都在新范围某条路径之下（整个任务覆盖一切）。详情加 `outdated`：待执行的预览之后同任务又有整理 / 撤销落了盘（finishedAt 晚于预览、有 done / reverted 项）→ `{ kind: "changed", at, runId }`；预览超过 24 小时 → `{ kind: "old", at }`；页面给提示条 +「重新预览」。执行不拦（执行前本来就逐项核对）。留存：待执行的预览也进 30 天清理；「每个任务至少留 5 次」只数真正执行过的 run（撤销要用的是它们）。
- 13：预览 409 带 runId 时 toast 带「查看」，点了直接打开那次整理。
- 10：新接口 `GET /api/organize/attention`：跨任务列出要人管的 run——待执行、进行中、执行阶段有失败或做了一半（`stats.pending`）、撤销阶段有没退回的。页面没打开 run 时在空状态上方列出来（任务、范围、触发来源、时间、数字，点了打开并切到对应任务）；侧栏「整理」挂角标（待执行 + 要处理，不含进行中），60 秒刷新一次、切页面时刷新。历史对话框加「加载更多」，已取消 / 失败的行带原因。

**阶段三：详情接口瘦身（19）**

- `GET /runs/:id` 不再带 items：另给按单元的计数 `counts[unitKey]`（要动 / 冲突 / 跳过 / 不变 / 要处理 / 完成 / 已退回 / 没勾选的文件）和目录操作数 `dirCount`；`stats` 加 `reverted`、`pending`；候选里的 overview 不下发。
- `GET /runs/:id/items?unit=<key>`（空串是目录操作）/ `?group=<失败分组>`：展开单元、展开失败分组时才拉。
- `GET /runs/:id/summary`：run（含进度 / 日志）+ 分组 + 按钮开关。执行 / 撤销中每 2 秒拉它，完整详情 10 秒一次、结束时再拉一次；展开着的文件表跟着完整详情刷新。
- page.tsx 顺便拆成 RunView / 单元列表 / 失败面板 / 历史 / 待处理几个组件。

**阶段四：页面功能（12、5、14、17、16、6、18、20、21）**

- 12：打开 run 时任务下拉框和范围切到 run 的任务 / 范围；换任务时关掉正在看的 run；run 头部写「任务：originPath → targetPath」和完整的网盘范围；待执行 / 预览失败 / 已取消的 run 头部有「重新预览」。
- 5：范围选择器从任务目录开始列（选出来的就是相对路径，出不了任务目录）；手输以 `/` 开头的按网盘绝对路径：在任务目录下就去掉前缀，不在就提示；`createRun` 对手动范围先 `resolvePath`，不存在 / 不是目录直接 400。
- 14：多个范围。选择器支持多选，范围框变成一组标签（可删、可手输回车添加）。多个范围 = 每个范围照单范围的规则来、再合在一起：`buildUnits` 的 `scopePath` 换成 `scopes`（每个文件按所在范围算边界，范围本身是季目录时边界放到上一级；「范围根的名字不可靠」对每个范围都成立；两个季目录范围会并回同一部剧）；`finalizeItems` 的删空目录换成 `scopeRoots: { path, removable }[]`：只删范围里面的目录，范围本身按「像发布目录 / 季目录」判断。手动多范围用 `paths` + trigger manual 建 run；新增路径（自动触发）的 run 仍按任务根分单元，识别语义不变。顺带修掉自动整理的一个老问题：新增路径的 run 以前按任务根往上找腾空的目录，而腾空判断只看列过的子树，新增路径的上级（比如转存落点 inbox）会被当成空目录列进删目录——里面还有别的就留一条「目录不是空的」，真空了就删掉转存落点。现在新增路径是目录的，它本身腾空了可删、上级不碰；是文件的不删任何目录。
- 17：单元列表加工具条：筛选（全部 / 要处理：没识别、不是把握大、有冲突、有失败、有跳过的问题 / 要动的 / 已规范）、按名字搜、排序（要处理的在前 / 按路径）；已规范（只有「不变」的项）默认收成一行「N 部已经是规范命名」；批量「全选 / 全不选 / 只选把握大的」走 `PUT /runs/:id/units { keys, selected }`，一次重规划。勾选进行中单元卡转圈、勾选框禁用。`listOutsideDstDirs` 记住列过的目录（`PlanState.listed`），重规划不再重复列。
- 16：按文件勾选。`organize_units.excluded`（迁移 0013，存相对路径，重规划不丢）+ `PUT /runs/:id/items { ids, selected }`；规划时没勾的文件 skip「没勾选这个文件」，跟着它的字幕 / nfo 一起留下。冲突的两份勾掉一份，另一份就能走——这就是冲突项的就地处理办法。顺带修规划里字幕找主人的老问题：以前只在排上了的视频里找，找不到还会退到「单元里唯一排上的那个视频」，没排上的视频（看不出集数 / 撞名 / 没勾）的字幕会被配给别的视频；现在在单元全部视频里找主人，主人没排上就跟着留下，唯一视频的兜底只在单元本来就只有一个视频时用。
- 6：换匹配弹框加类型（全部 / 电影 / 剧集）+ 年份；关键词是纯数字、`tmdbid=123` / `tmdb-123` 或 TMDB 链接时按编号查（纯数字电影 / 剧集都试）。新接口 `POST /api/organize/tmdb/search { query, type?, year? }`、`GET /api/organize/tmdb/:type/:id`，都走 TmdbClient（缓存 + 节流）。「没识别」的提示改成「换关键词、限定年份 / 类型，或直接填 TMDB 编号」。
- 18：整理页头部加「识别记忆」对话框：按账号列出记住的目录（类型、片名、年份、季 / 偏移、时间），可过滤、逐条删除（确认）。
- 20：strm 体检「命名不规范」每条加「去整理这个目录」，这一类的批量区加「整理这个范围」，跳 `/organize?task=&path=`。
- 21：日志显示存下的全部（最多 300 行），展开时滚到底；新增路径的 run 头部能展开看路径列表；冲突的就地处理见 16。

### 不做

- 逐项改目标名：沿用「失败项处理」一节的决定。名字由模板和识别结果决定，单个文件手改的名字下次预览又会被改回去；冲突靠按文件勾选（16）、换匹配 / 季集偏移、改模板处理。

### 测试

- run.itest：patch 进行中执行 409、patch 期间被取消不写孤儿项、两个 patch 交错不互相覆盖；执行中取消（假网盘在取消后抛 AbortError，模拟真网盘请求被掐断）stats / 日志 / 追更改写都对；撤销中取消、撤销部分失败时追更只改回有文件退回的；单元结构丢了 editable=false；预览完成取代被覆盖的旧预览、不覆盖的留着；repreview 保留触发来源和范围；outdated 两种；撤销放宽（不相干的后续整理不挡、动过这批文件的挡并给 blockedBy）；多范围（两个季目录并成一部剧、收件箱范围按标题拆、删空目录不越过范围）；新增路径的上级不删；按文件勾选（视频没勾字幕跟着留、冲突勾掉一份另一份能走）；批量勾选；attention；items / summary；手动范围不存在 400。现有用例里读 `getRunDetail(...).items` 的改成 `listItems`。
- units.test / plan.test：scopes、scopeRoots、字幕找主人。
- 路由 itest：新接口的鉴权 / 校验 / 形状。housekeeping：ready 进清理、只数执行过的 run。
- 前端 typecheck / lint（dev server 常驻 3222 时不跑 next build）。

### 进度

- [x] 阶段一：1、2、4、3、7、8、9 + repreview
- [x] 阶段二：11、15、13、10
- [x] 阶段三：19
- [x] 阶段四：12、5、14、17、16、6、18、20、21
- [x] 测试全过、实施记录

### 实施记录（2026-09-15）

四个阶段按方案做完。后端 737 个测试全过（整理相关 211 个：run.itest 新增 17 条、路由 itest 5 条、units 1 条、plan 3 条），前后端 typecheck / lint 干净；迁移 0013（`organize_units.excluded`）。

和方案的出入：

- 取消的收尾没有给 execute / revert 的主循环包 try：`startJob` 多了 `onAbort` 回调，AbortError 从网络请求里抛出来时由它调 `finishApply` / `finishRevert`，和正常结束走同一个出口（执行 / 撤销各自的收尾抽成了这两个函数）。
- page.tsx 在阶段三拆成 `RunView` / `UnitList` / `FailurePanel` / `HistoryDialog` / `AttentionList` / `MemoryDialog` / `helpers`（阶段四的功能都加在拆出来的组件上）。
- 按文件勾选的 `excluded` 存网盘绝对路径（和项的 srcPath 同一个口径），规划时换成相对路径。
- 手动范围必须是目录：原来有几条用例拿「手动 run + 文件路径」模拟自动整理，改成 `trigger: "share"`。
- 换匹配的搜索：不限类型但给了年份时电影、剧集各搜一次（TMDB 的 multi 搜索不认年份），结果按类型 + 编号去重。

做的过程中顺带发现并修掉的老问题：

1. 待执行的预览被取消（包括新加的「被新的预览取代」）之后，项全是 pending，页面会显示「重试失败项（N）」、失败面板出「没做完」，点了会把整份清单当失败项执行。现在详情多了 `executed`（有项被执行 / 撤销过），没执行过的 run 不给执行、不出「没做完」分组，只能重新预览。
2. 预览的收尾那句「预览完成：…」写在落库之后，从没进过 run 的日志（和 8609cf4 修的执行 / 撤销收尾同一个毛病）。
3. 改单元重规划时 `notes` 只取规划的提示，识别阶段的提示（nfo 证据没采用之类）一改就没了；现在 `PlanState.identifyNotes` 单独存着拼回去，手动换匹配时清掉。
4. 字幕找主人退到「单元里唯一排上的那个视频」：主人没排上（看不出集数 / 撞名 / 没勾）时字幕会被配给别的视频。
5. 自动整理的新增路径按任务根往上找腾空的目录，新增路径的上级（转存落点）会被列进删目录。
6. 改单元的写库在 await 之前、之后都有，两个 patch 交错时后一个会把前一个的改动盖回去（`remember` 被换匹配盖掉）；现在全在最后的同步段里、重读最新的行再套。

没做：逐项改目标名（见上面「不做」）。

待真机：多范围 / 按文件勾选 / 批量勾选在 115 上走一遍 预览 → 执行 → 撤销；撤销放宽在「手动整理后监控又自动整理了新一集」的真实场景里看一眼；侧栏角标和待处理列表。

### 浏览器冒烟（2026-09-15，scratch 后端 + 假网盘）

本机起了一个 scratch 库的后端：假夸克账号 + FakeDrive 目录树 + TMDB 桩，第二集的移动先失败四次（批量两次 + 逐个两次），留给失败面板重试。在前端 dev 页面里走了一遍：落地页的待处理列表、目录选择器多选 + 范围标签、多范围预览、工具条的筛选 / 搜索 / 排序、文件清单懒加载、按文件取消勾选化解冲突、批量勾选、换匹配按 TMDB 编号直查、执行确认的分项文案、执行、识别记忆的列表和删除、历史里的「已被新的预览取代」、失败面板懒加载清单 + 重试、整个任务预览里「已经是规范命名」的折叠行、侧栏角标。控制台没有报错。

冒烟时发现并修掉的：

1. 目录选择器：选中条要选了东西才出现，弹框高度跟着跳；多选时点行名会顺带展开 / 收起，勾着勾着树就合上了。现在选中条常驻（没选时显示操作提示），多选模式点行只勾选，展开只认箭头和文件夹图标。
2. 侧栏角标：预览很快做完时，`RunView` 第一次拿到的状态已经是 ready，没触发 `notifyOrganizeChanged`，角标要等 60 秒一次的轮询。现在状态一有变化（包括第一次拿到）就通知。
3. 手动多范围的 run：历史里显示成「整个任务（N 个新增路径）」，失败面板「重新预览」的确认文案说「整个任务」（老代码里只有自动整理会带多个路径）。现在历史、待处理列表、失败面板统一走 `lib/organize.ts` 的 `scopeLabel`：手动多范围说「N 个目录」，自动整理说「N 个新增路径」；详情头部原来就分开说了。
4. 同一次 run 的日志被后一个 job 冲掉（v2.6.0 就有）：执行、重试、撤销的 job 都从空日志开始写，落库时把前面的整段盖掉，重试完只剩重试那几行。现在 `startJob` 接着 run 已有的日志往下写（落库照旧只留最近 300 行）；run.itest 撤销那条加了断言（执行日志里还有预览那段，撤销日志里还有执行那段）。改完后端 737 个测试全过、typecheck 干净。

两处是自动化环境的问题，不是页面的：自动化的标签页 `visibilityState` 是 hidden，整理页的轮询会停（冒烟时在页面里改写了它）；换匹配弹框按 Esc 没关——弹框只在「正在按新的匹配重新规划」时拦关闭，右上角关闭按钮走同一个 `onOpenChange` 能关，判断是自动化发键没到 Radix 那里，没在真浏览器里复现。

### 115 真机验证（2026-09-15 晚）

用户说「115 真机测试一下」。做法同 rc.2：`config/openstrm.db` 只读拷一份到 scratch，只留一个测试任务 orglab（`/organize-lab` → 本地 `organize-lab`，混合库），Telegram / Emby 配置删掉、云下载回执清空，网盘监控先关（测监控时再开，只看启动之后的事件）；临时口令 + token；真 TMDB。115 根下用 `files/copy` 从生产目录复制造场景：`inbox-a/Friends.S01.1080p.BluRay.x264-GROUP`（E01 + 字幕、E02 的 1080p / 720p 两个版本）、`inbox-b` 一部电影、`inbox-c` 同一部电影的另一份（不选进范围）、`/organize-lab-staging` 放 E03 留给监控阶段；先跑一遍同步把 strm 拉到本地。

走通的：

- 多范围：目录选择器在真网盘上勾 inbox-a + inbox-b，一次预览 2 个单元（老友记 基本对、海底光缆 把握大），inbox-c 没被扫到；发布目录里还留着 720p，不删；inbox-b 腾空了留着（收件箱式范围）。
- 按文件勾选：去掉 720p，撞名消失（冲突 → 跳过「没勾选这个文件」），`excluded` 存网盘绝对路径；「只选把握大的」→「全选」来回点，720p 仍然没勾。
- 执行确认「改名 / 移动 4 个文件，建 3 个目录」，7 项全部完成，网盘和本地镜像一致；一次 run 的日志从预览到撤销是一本账。
- 监控 → 自动整理：任务改 review、开监控，把 E03 从 staging 挪进 inbox-a，39 秒后建出待确认的预览（1 个新增路径、进已有的 Season 01 不用建目录）；落地页「待处理（1）」、侧栏角标，从待处理点进去执行。手动那次照样能撤（撤销放宽生效）。
- 先撤前面、后撤后面：前面那次撤销时剧目录 / Season 01 里有 E03，标「目录不是空的，留着」；后面那次撤销完这两个目录一起删掉（修复见下 3），前面那次的记账跟着改成已退回（5 → 7 项）。

真机上发现并修掉的：

1. 从任务外把文件挪进任务目录（从云下载 / 最近接收挪进剧集目录）不触发自动整理：处理器按新增生成了 strm，但监控只在事件类型是 create 时交给自动整理，115 的挪入是 move_file。现在 `HandleResult.arrived` 标「新落进任务的」（新增、从任务外挪进来、旧路径不知道的），监控看它；任务里挪动、本地没有退化成新增的不算。
2. 监控开着撤销，字幕会多下载一份到 `源目录/新名字`。撤销是先挪回再改回原名，115 会把挪回单独报一条：
   - 监控在「挪完还没改名」的窗口里拉到它时，项是 done 带 cur_path，被当成「改名那步失败了」照常处理；路径缓存已经是新位置，旧路径 = 新路径，按新增下载了一份。
   - 窗口过了才拉到的，项已经是 reverted，`findOwnOperation` 认的却是 `目标目录/旧名字`（撤销走不到这个位置）。
   修法：撤销还在跑（run 是 reverting）时 done 带 cur_path 是正常的中间状态，事件跳过；撤销过的项认 `源目录/新名字`；撤销镜像从主路径挪成功后，中间位置要是有监控另生成的一份就清掉（`mirrorRelocate` 的 `oldPathAlt`）；每项能认的事件 2 → 4 条（执行、撤销各一条 rename + 一条 move，监控开着时执行那两条就把额度用完了）。
3. 撤销放宽后先撤前面的整理，它建的目录因为装着后面那次的文件留下（skipped），前面那次也撤完了；后面那次撤销完这些目录空了却没人删。现在撤销收尾时看这次挪走的文件所在的各级目录，是别的已撤销整理因为不空留下的自建目录、空了就删，那些项改成已退回、那次的统计重算（`listLeftoverDirs` / `sweepLeftoverDirs`）。
4. 手动多范围的预览日志说「（2 个新增路径）」，改成「（2 个目录：inbox-b、inbox-a）」；自动整理照旧说新增路径。
5. 落地页「待处理」已经出来了、侧栏角标还要等一分钟：待处理列表发现清单变了就 `notifyOrganizeChanged`，最多多拉一次。

看过、不是问题的：执行 / 撤销中截图里海报是空白——在页面里记了 DOM，图片一直是加载好的，是自动化标签页不重绘的截图假象；本地镜像把腾空的范围目录（inbox-b）清掉、网盘上留着，本地空目录对 Emby 没意义，按原设计。

测试：后端 740 个全过（run.itest 新增「先撤前面的整理」一条，改了撤销中间路径、认事件额度、多范围日志的断言；monitor.itest 新增「挪入也交给自动整理」「撤销中间状态跳过」两条），前后端 typecheck / lint 干净。

全部修完后又在 115 上走了两轮 inbox-a 预览 → 去掉 720p → 执行 → 撤销（监控全程开着）：执行时 2 条建目录 + 4 条移动、撤销时 4 条改名 + 2 条删目录全部认成自己的，本地没有多出来的文件，网盘和本地都回到原样。这两轮 115 都没把字幕「先挪回」单独报出来（修之前那两轮都报了），修复 2 在真机上没再碰到，靠 monitor.itest / run.itest 覆盖。

收尾：`/organize-lab`、`/organize-lab-staging` 进 115 回收站（删之前核对过里面只有这次造的东西）；lab 后端、前端 dev（3222，这次起的）停掉；scratch 库（含 cookie）、临时口令、token 删掉，浏览器里的 token 清掉、标签页关掉。

## 纯数字文件名与冲突处理（2026-09-16）

用户在夸克 `/tv` 上跑整理，两个问题：`遮天/129 4K.mp4`、`130 4K.mp4` 被认成三部不同的电影（《129》《La 130》《Shivanna 131》）；`凡人修仙传` 的两集报「冲突 · 目标已存在」，勾选框还是勾着的，但没有任何解决途径。

### 1. 整个文件名就是数字 → 集数

`129.mp4` 这种整名就是数字的，解析阶段本来就当集数（`parseMediaName` 的 bare 分支）；`129 4K.mp4` 后面粘了技术词，解析成了 `title=129 + resolution=4K`，于是每个文件都成了一个「电影」单元。

单看名字分不清是集数还是片名（《1917》《2012》），所以照 `trailingNumber` 的老路子：解析只给事实，上下文来定。

- `parse-name.ts` 加 `numericTitle(p)`：标题整个是 1–3 位数字（前导零去掉）、还没认出集数、名字里也没有年份时给出这个数字。
- `units.ts` 的 `promoteEpisodeNumbers`（原 `promoteTrailingEpisodes`）多一条 `promoteNumericTitles`：文件在季目录里，或者上级目录的名字能当标题、又不等于这个数字本身（`1917 (2019)/1917 4K.mkv` 是电影），就把数字当绝对集数、标题清空——标题随后从目录名来。电影库（`libraryType === "movie"`）和任务根（目录名是 `tv`、`media` 这种）不给。

### 2. 冲突的解决途径

问过用户两轮：先定了「改名保留 + 挪进重复文件目录」，随后用户要求「还应该能删除」「用户是不是应该能自己去改名」，最终五条都做（`OrganizeConflictChoice`）：

| 办法 | 做什么 |
| --- | --- |
| 留在原处（默认） | 不动，还算冲突；也可以直接取消勾选这个文件 |
| 改名保留 | 给这一份加区分后缀：先用画质 / 来源 / HDR / 编码 / 音频 / 压制组，都占了就 `(2)`…`(9)` |
| 自己改名 | 用户填目标文件名（不带目录；没写扩展名就补原来的），目录还是整理算出来的位置 |
| 挪进重复文件 | 挪到任务根下的 `重复文件/`，原来的目录层级留着 |
| 删掉这一份 | 删掉正在整理的这个源文件，目标那份不动 |
| 覆盖 | 先删掉目标位置那份（单独一条 delete 项，排在移动前面），再把这一份挪过去 |

跟着这个视频、又按它的名字命名的字幕 / 同名 nfo 一起走（改名跟新名字、挪重复文件目录跟进去、删除一起删）。

落地：

- 单元上多一列 `resolutions`（网盘绝对路径 → `{ how, name? }`，迁移 0014），和 `excluded` 一样重规划不丢；`PUT /runs/:id/items` 多收 `resolve`（null 是撤回选择）。
- `plan.ts`：`custom` 在算目标名时就落地（字幕跟着新主名）；其余在 `finalizeItems` 撞上了才生效——`retarget()` 一项只换一次目标，换完还撞（别的项抢先）就照旧按冲突留在原处。同一单元里两个版本撞同一个名字时，选过办法的那一份不再在 planUnit 里直接判冲突，留给 `finalizeItems` 按办法安排。
- 新动作 `delete`：`OrganizeAction` 多一个值，统计里单列 `plannedDelete`，执行阶段排在 mkdir 之后、改名 / 移动之前（覆盖要先腾位置）。动手前按目录清单核对名字和 id，位置上换了别的文件就记 stale 不删；已经不在了当做完。本地镜像 `mirrorDelete` 把对应的 strm 删掉。
- Provider 多一个写操作 `remove`（115 / 夸克进回收站，OpenList 看存储后端）；`DriveWriteOps` 的「绝不删文件」约定改成「只有用户对冲突明确选了删除 / 覆盖才删」。
- 删掉的项撤销退不回来：`revertPendingItem` / `revertWorkItem` 本来就只认改名 / 移动，撤销日志里单说一句，只删了文件的 run 撤销按钮的理由也单说。
- `重复文件/`（`services/organize/duplicates.ts`）是网盘上的暂存区，不算媒体库的一部分：整理不扫它（`buildUnits` 的入参过滤掉，冲突检测仍看得见里面有什么；自动整理的触发路径也过滤掉）、本地不镜像它（`matchTask` 当它不属于任何任务——挪进去时本地 strm 删掉，撤销挪回来再生成）、全量同步不给它生成 strm（`loadRemoteEntries` 过滤）。
  名字原本打算用 `.重复文件`（隐藏目录，媒体服务器天然跳过），真机上发现**夸克的列目录接口会把点开头的条目藏起来**（建得成、列不出来，用户在网盘里也看不到），只能用可见的名字。
- 前端：冲突行上多一个「怎么办」下拉（`CONFLICT_CHOICES`），选过就显示当前的办法；「自己改名」弹 `RenameDialog`；执行确认里多一句「其中 N 个文件是你选了删除 / 覆盖的，会进网盘回收站，撤销退不回来」。

测试：`parse-name.test.ts` / `units.test.ts` 各一条（纯数字名的各种上下文）、`plan.test.ts` 六条（五种办法 + 办法用不上时照旧留在原处）、`run.itest.ts` 两条（改名保留 → 改主意挪进重复文件 → 执行 → 重复文件目录不再成单元；删掉 / 覆盖 → 执行真删 → 撤销退不回删掉的）。后端 750 个全过，前后端 typecheck / lint 干净。

## 待处理列表分不清是哪一条（2026-09-16）

用户截图：落地页「待处理（6）」里六条长得一模一样——`待执行 tv · 整个任务` ×2、`待执行 movie · 整个任务` ×4，而且他 115 和夸克上各有一个叫 `tv` 的任务，「分不清是哪一个网盘的」。

- **身份**：列表只写任务的 `originPath`。现在写成 `账号（网盘）· 目录`（`lib/drive.ts` 的 `accountLabel`：账号名里已经有网盘名就不重复，`115` 不写成 `115（115）`）。整理页的任务下拉、run 详情头部的「任务：」也一起加上，转存弹框里那份本地的网盘名字表换成共享的。
- **先后**：创建时间原来在最右边一小行灰字里（窄屏还会被挤走）。现在紧跟在范围后面，写成 `今天 13:18` / `昨天 …` / `9 月 14 日 …`（`fmtWhen`，完整时间挂 title），历史弹框同样。
- **为什么会堆六条**：新预览作废同范围的旧预览（`supersedeCovered`）是 v2.7.0 才有的，之前留下的一直挂着。加了 `collapseStaleReadyRuns()`，启动时按同一条规则收拢：同任务里范围被更新那次覆盖的待执行预览作废（写「已被同范围更新的预览取代」），只留最新的一条——进程重启后旧预览本来也不能再改（单元结构只在内存里），留着只会误执行。
- 待执行那行的概括顺带带上冲突数（`3 部 · 7 项要动 · 2 项冲突`）。

假环境（两个假账号、都叫 tv 的任务）在浏览器里看过：三行分别是 `115 · tv`、`kuake（夸克） · tv`、`115 · movie`，窄到 380px 时主文案折行、右边概括还在。

## 整理完留下空文件夹（2026-09-25）

用户：「整理的时候如果按照搜索文件整理，最后会留一个空的文件夹，特别是 mcp 调用的时候」。

**确认有这个问题。** 临时用例（假网盘 + TMDB 桩，跑完删了）跑了七种范围：

| 场景 | 范围 | 单元根 | 结果 |
|---|---|---|---|
| A 只有片名的剧目录 | `怒呛人生`（智能体 / 手动） | `怒呛人生` | 空的 `怒呛人生` 留着，规划里没有删空目录 |
| B 从搜到的文件往上一级 | `BEEF/Season 1` | `BEEF`（越到范围外） | `Season 1` 删了，空的 `BEEF` 留着 |
| C 智能体给多个范围 | `怒呛人生` + `BEEF.S01.1080p` | 各自 | 发布目录删了，空的 `怒呛人生` 留着 |
| D 转存进 `subPath` 建出来的目录 | 自动整理的新增路径是文件 `BEEF/…mkv` | `BEEF` | 空的 `BEEF` 留着 |
| E 对照 | `BEEF.S01.1080p` | 同 | 删干净 |
| F 反例 | `inbox`，里面直接放着同一部剧的散文件 | `inbox` | 空的 `inbox` 留着（该留） |
| G 反例 | `BEEF/Season 1`，`BEEF` 下还有 `Season 2` | `BEEF` | `BEEF` 不空，留着（该留） |

原因：删空目录的边界（`plan.ts` 的 `finalizeItems` + `run.ts` 的 `scopeRootsOf`）。

- 只删范围**里面**腾空的目录。
- 范围本身只有名字「像发布目录 / 季目录」（`looksLikeReleaseDir`：带年份、季集标记、发布噪音）才删。
- 范围外面一律不碰。
- 自动整理的新增路径是文件时一个目录都不删。

智能体更容易碰上，有两个原因：

- 它转存时爱用片名当 `subPath`（场景 D）。
- 它按搜到的文件整理时，范围多半是文件所在的季目录，或者只有片名的剧目录（场景 A、B）。

界面上 strm 管理页、体检弹框跳整理时，预填的也是文件所在的目录。

**推荐的修法**：单元根（整理认定的「这部作品原来所在的目录」）里的东西全挪走后，如果它就是这部作品自己的目录，就一起删掉。

- 「是这部作品自己的目录」有两种：
  - 名字像发布目录 / 季目录（现有规则）；
  - 名字就是这部作品的片名：和 TMDB 的中文名、原名、英文名比，`normalizeTitle` 之后相同，或者目录名里包含片名。
  - 收件箱式的名字（`inbox`、`下载`、`电影`）对不上片名，照旧留着（场景 F）。
- 单元根在范围外的（B、D）：规划时去网盘把这个目录整棵列一遍（同 `listOutsideDstDirs` 的做法，记进 `state.listed`、重规划不再列），把里面的东西算进「还剩什么」。只有除了这次挪走的再没别的，才排删除（场景 G 不删）。
- 执行时本来就是 `rmdirIfEmpty`（不空不删），多一道保险；撤销时删掉的目录照常建回来；追更 / 云下载 / 复制队列里指着它的，照现有的 `dirMappings` 跟到作品目录。
- 清单里会列出这条「删空目录」，人和智能体执行前都看得到；受「整理完删空目录」开关（`cleanupEmptyDirs`）管。

测试：A–D 四种都删干净，E–G 行为不变；外加「单元根名字对不上片名不删」「范围外单元根里还有别的文件不删」「撤销把删掉的单元根建回来」。

用户说「按照你的推荐制定计划开始吧」。

### 实施计划

`ownsDir`（`units.ts`）用不上：它只拿目录名和文件名里的标题比，「中文目录名 + 英文文件名」（场景 A）判不出来；自动整理时范围是任务根，它会把收件箱（`inbox`）也认成作品目录。所以判断改成拿目录名去比识别出来的 TMDB 片名。

1. `parse-name.ts` 加 `isWorkFolder(name, titles)`：`looksLikeReleaseDir`，或者 `normalizeTitle` 后目录名等于片名、或包含片名（片名至少两个字）。片名只用 TMDB 匹配的中文名、原名、英文名。不用单元自己的标题，那里面混着从目录名来的候选，`inbox` 会自己认自己。
2. `run.ts`：
   - 把 `walkScope` 里整棵列目录的那段抽成 `listTree`；
   - 预览时，越到范围外的单元根（不是任务根、不在已经列过的范围里）先确认是目录，再整棵列一遍，条目并进 `state.entries`，记进 `state.outsideRoots`；列失败的不记，就不删。这一步不看匹配，换了匹配之后的重规划不用再去网盘。
3. `run.ts` 加 `cleanupRoots(state, matchOf)`：在 `state.scopeRoots` 的基础上，单元根等于某个范围根、或者在 `state.outsideRoots` 里、并且 `isWorkFolder` 成立的，记成可删的根。范围里面的目录腾空了本来就删，不用管。预览和 `replanRun` 调 `finalizeItems` 时都用它，重规划按当时的匹配现算。
4. `finalizeItems` 不用改：可删的根本来就会成为候选，「空不空」按并进来的条目算。
5. 测试（`run.itest`）：
   - 场景 A–D 都删干净，E–G 行为不变；
   - 单元根名字对不上片名不删；
   - 换了匹配后按新片名重算；
   - 撤销把删掉的单元根建回来、文件退回原处；
   - 追更的 subPath 跟到作品目录。

### 进度

- [x] 1 isWorkFolder
- [x] 2 列越到范围外的单元根
- [x] 3 cleanupRoots 接进预览和重规划
- [x] 5 测试

### 实施记录（2026-09-25）

- `parse-name.ts`：`isWorkFolder(name, titles)`：像发布目录，或 `normalizeTitle` 后目录名等于片名、包含片名（片名至少两个字；片名里包含目录名的不算，免得「美剧」这种分类目录被当成《美剧狂人》的目录）。
- `run.ts`：
  - `listTree` 从 `walkScope` 抽出来；
  - 预览时 `listOutsideUnitRoots` 把越到范围外的单元根整棵列一遍，条目并进 `state.entries`、记进 `state.outsideRoots`（新字段）；太大（超过一次整理的文件上限）、不是目录、列失败的不记，也就不删。
  - 和计划不一样：只列名字对得上片名的（片名连「换匹配」的备选一起算，`workTitles(m, true)`）。计划里是不看匹配全列，自查时发现网盘监控给收件箱里每个新文件起的自动整理，单元根就是收件箱，每次都要整棵列一遍收件箱（115 走目录树导出），最后又不删。代价：换成备选之外的片名后，范围外的单元根不会补列、也就不删，范围根本身不受影响。
  - `cleanupRoots(state, matchOf)`：单元根等于某个范围根、或者在 `outsideRoots` 里，而且 `isWorkFolder(目录名, [中文名, 原名, 英文名])` 成立的，记成可删的根。
  - 预览和 `replanRun` 都用它；`replanRun` 按改完的匹配现算。
- `finalizeItems` 没动。
- 测试：
  - `run.itest` 加 4 个：删干净的三种范围、留着的五种（含「收件箱不去列」，按 `walkSubtree` 次数断言）、换了匹配重算、撤销建回来 + 追更跟过去又跟回来；
  - `parse-name.test` 加 1 个。
  - `cleanupRoots` 临时改成不加根，三个正面用例失败，「留着的」那条照过，恢复后全过。

### 评审与修补（2026-09-25，第二版做法）

`/code-review max` 里整理这边的几条都成立：

1. **`isWorkFolder` 太宽**：按包含比，`uploads` 被当成电影《Up》的目录；只看「像发布目录」的话，`蓝光`、`Remux`、`[待整理]`、`美剧 2024` 都算。
2. **自动整理删掉还在用的落点目录**：比如云下载 E01–E08 下到 `Beef`，E01 一整理就把 `Beef` 删了，后面几集 115 的目标目录没了。
3. **撤销拽错**：单元根的反向映射不看作品目录是不是这次新建的，删目录那条没成也照样反推，原本就指着作品目录的追更、复制记录、识别记忆被拽回旧目录。
4. **装着几部作品的目录**，只要其中一部名字对上就删。
5. **嵌套任务的根目录**会被外层任务的整理删掉。
6. **115 丢了节点 id**：整棵列的条目没有 id，把 `listOutsideDstDirs` 带 id 的条目挡掉了，覆盖删除时核对不了。
7. **附属文件跟不走**：「中文目录名 + 英文文件名」时附属图片 / nfo 留在原处（`ownsDir` 只看文件名），目录照样空不了。

另外被截掉的几条：每一集都整棵列一遍、状态泄漏、重复列目录、引用数少算。

收窄后的做法：

- **只对手动 / 智能体发起的整理生效**（`handPicked`）。自动整理（转存、追更、云下载、监控）照旧不删范围外、也不删新增路径所在的目录。第 2、5 条、「每集整棵列一遍」都出在自动整理上。
  - 智能体用片名当 `subPath` 转存（场景 D）就不修了，改成在 `share_save` 的说明和「找片入库」里写明：要整理就别给 `subPath`，整理会建规范的作品目录。
- **目录名要就是这部作品的名字**：`isNamedAfter(name, titles)` 用 `parseMediaName` 解析目录名得到的片名，和 TMDB 的中文名、原名、英文名比，`normalizeTitle` 后完全相同才算。不再按包含比，也不再单凭「像发布目录」就算；范围根原有的「像发布目录就删」规则不动。
- **只删一部作品独占的目录**：扎在这个目录上的单元只有一个，而且不是从大目录里拆出来的。
- **不删**：
  - 别的同账号任务的根目录，或者装着别的任务根目录的；
  - 有待兑现的云下载回执指进去的（115 的目标目录在加任务时就定了，删了后面的下载就没地方落）。追更、复制队列里指进去的照旧跟到作品目录。
- **只在有必要时去网盘列**：开着「整理完删空目录」、名字对得上（连换匹配的备选）、独占、不是任务根、这个单元确实要把东西挪出这个目录，这几条都满足才列。
  - 嵌套的只列外层；
  - 有 `walkSubtree` 的网盘，目标目录落在列过的目录里就不再列；
  - 合并条目时同一路径优先留带 id 的（第 6 条）。
- **附属文件**：`planUnit` 里单元不是拆出来的、目录名就是这部作品的名字，也算作品自己的目录，认不出的图片 / nfo 跟进作品目录（第 7 条）。
- **撤销**：
  - 「删掉的目录」「新建的目录」只认这次真的删了 / 建了、撤销时退回了的；
  - 单元根的反向映射也要求作品目录是这次新建的，原本就有的作品目录不往回拽（第 3 条）。
  - 这是原来就有的毛病，这次删得多了才冒出来，一起修。
- **引用数**：预览时单元根会被删的，引用按整个单元根算，重规划换了匹配也跟着重算。
- **泄漏**：自动整理一项都不用动时，内存里的规划状态随手释放。

### 第二版实施记录（2026-09-25）

- `parse-name.ts`：`isWorkFolder` 换成 `isNamedAfter(name, titles)`。
  - 目录名用 `parseMediaName` 解析出片名（连同别名），归一化后和识别出来的片名完全相同才算；一个字的不认。
  - 「全集」「番外」这种标记词解析时本来就去掉，所以 `怒呛人生 全集` 算。
  - `怒呛人生和朋友们` 不算；`uploads` 对《Up》也不算。
- `plan.ts`：`planUnit` 里，单元根算作品自己的目录有两种：分单元时就认出来的（`ownsDir`）；不是拆出来的、目录名就是识别出来的片名。认不出的图片 / nfo 跟进作品目录。
- `run.ts`：
  - `ownWorkRoot(state, unit, titles)`，要求：
    - 名字对得上；
    - key 不带 `|`：一个目录只会分出一个单元，除非按标题拆开，所以「只有一个单元」和「不是拆出来的」是一回事，只查 key；
    - 不是、也不装着同账号别的任务的根目录；
    - 没有待兑现的云下载回执指进去。
  - `cleanupRoots` 只对 `handPicked` 生效。`listOutsideUnitRoots` 同样只在 `handPicked` 且开着删空目录时列，另外要求：
    - 这个单元确实把东西挪出单元根；
    - 嵌套的只列外层，里层一起记进 `outsideRoots`。
  - `PlanState` 加了 `handPicked`、`scopes`、`refPaths`、`offlineRefs`（`rewriteOfflineSubPaths` 的 dry run）、`otherTaskRoots`。
  - 引用数：`refsOf` 等清单定下来再算。
    - 单元根在范围里，或者这次清单里会删它，按整个单元根数；重规划换了匹配也重算、落库。
    - 只看「删得了」不够：范围外的剧目录里还有别的季时删不了，指着它的追更不会改。原有用例「范围直接选在季目录上」就卡在这。
  - 合并条目：`mergePreferId` 同一路径留带 id 的；`listOutsideDstDirs` 遇到已知条目没 id 的，照样交出带 id 的那份。
    - 有 `walkSubtree` 的网盘，目标目录落在整棵列过的单元根里就不再列；115 照列。
    - 收窄之后，「目标目录在范围外的单元根里」基本碰不上，这一条是兜底，没单独写用例。
  - `afterAutoPreview`：一项都不用动时 `planStates.delete`。
  - `afterRevert`：删掉的目录只认 `rmdir` 状态是 reverted 的，新建的目录只认 `mkdir` 状态是 reverted 的；单元根那条映射也要求作品目录在「新建的」里。
    - 代价：落进原来就有的作品目录时，撤销后这次跟过去的追更也留在作品目录（分不清哪些是跟过去的）。
    - 撤销被取消、建的目录还没来得及删的，这一轮不改回去，接着撤销做完再改。
- 智能体：`share_save` 的 `subPath` 说明、「找片入库」第 5 步都写上「要整理就别拿片名建子目录」。工具快照不含说明文字，不用更新。
- 测试：
  - `run.itest`：
    - 删干净的三种：
      - A 剧目录；
      - B 季目录，外加指着剧目录的追更算进引用数、执行后跟到作品目录；
      - C 一次给多个范围。
    - 附属文件跟进作品目录。
    - 留着的：
      - 对不上片名、`uploads`、`异形` 里装两部；
      - 别的任务的根目录、装着别的任务根目录的；
      - 有待兑现的云下载回执（兑现了的不拦）；
      - 剧目录下还有别的季；
      - 自动触发时范围本身；
      - D（自动整理不删也不列）、收件箱不列。
    - 撤销不拽错：原来就有的作品目录、剧目录没删成。
  - `parse-name.test` 改成测 `isNamedAfter`。
- 变异核对：下面几处逐一去掉，对应用例各自失败，恢复后全过。
  - 两道 `handPicked`；
  - 拆分单元；
  - 别的任务根；
  - 云下载回执；
  - 按片名认作品目录；
  - 撤销的两处过滤；
  - 引用数；
  - 范围外的单元根。

## 智能体转存整理后还留空目录（2026-09-28）

用户：「现在智能体转存整理的时候还是会产生一个空文件夹」。

**原因**：第二版只让手动 / 智能体发起的整理（`handPicked`）删作品目录。智能体 `share_save` 带整理走的是自动整理（来源「转存」），场景 D 当时没修，只在 `subPath` 说明和「找片入库」里劝模型别给 `subPath`。模型照样会给（ChatGPT 还会缓存旧的工具说明），这个子目录就留下了。设置页「智能体 → 最近调用」里能看到那次 `share_save` 带没带 `subPath`。

临时用例（MCP 客户端调 `share_save` 带 `organize: true`，假网盘 + TMDB 桩，跑完删了）：

| 场景 | 分享根 | subPath | 结果 |
|---|---|---|---|
| S1 | 片名目录 `怒呛人生/` | 不给 | 删干净 |
| S2 | 散文件 | `怒呛人生` | 空的 `怒呛人生` 留着 |
| S3 | 发布目录 `BEEF.S01.1080p/` | `怒呛人生` | 发布目录删了，空的 `怒呛人生` 留着 |
| S4 | `怒呛人生/Season 1/` | 不给 | 删干净 |
| S5 | 散文件 | 不给 | 干净 |
| S6 | `怒呛人生/` 里夹着 `更多资源.txt` | 不给 | 目录连 txt 留着（不认识的类型不动，照旧） |
| S7 | 散文件，顺手追更 | `怒呛人生` | 空的 `怒呛人生` 留着；之后每集落进来、被整理挪走，一直空着 |
| S8 | 散文件 | `美剧/怒呛人生`（`美剧` 已有） | 空的 `美剧/怒呛人生` 留着 |

**顺带查出一个更要紧的（S12）**：分享根是片名目录、不给 `subPath`、顺手追更，正是「找片入库」教模型的做法。整理把 `怒呛人生` 挪空删掉后，下一次追更报「无法在网盘上找到保存目录：tv/怒呛人生」，新集数进不来，任务开着自动整理也一样。

- 原因：追更把分享里的层级拼在 `subPath` 后面当落点（`subPath/怒呛人生`）。整理收尾只改写 `subPath` 本身，拼出来的这一层删掉了就没人管。
- 界面上「转存 + 追更」、任务开着自动整理的都会碰上，不只智能体。

**另一个小的**：追更触发的整理在整理记录里记成「转存」。`saveSelectionToTask` 每组转存完先按「转存」排了整理，追更最后那次同样的路径并进去，来源用的是先到的。

**推荐的修法**：转存时为这次转存建出来的目录，只是装这次条目的临时容器。交给整理时交这个目录，不交里面的条目；自动整理本来就会把「新落进来的目录」腾空后删掉。

1. **`share_save`**：
   - `ensureSubDir` 回这次建出来的最上一层：`美剧` 已有、只建了 `美剧/怒呛人生`，就是它；都已有就是空。
   - 建了目录的，交给整理的新增路径换成这个目录。补整理（去重那条路）也用它，记进 `SaveMeta`。
   - 原来就有的目录照旧不删，包括以前留下的空壳，那些要手动删一次。
   - 不改成「要整理就拒绝 `subPath`」：认不出来的片留在子目录里，比散在任务根下好；也省一个来回。
2. **追更**：
   - 落点（`subPath/分享里的层级`）不在，就一级级建出来；建出来的最上一层同样整个交给整理。
   - 任务目录本身不在，照旧报错。
   - 行为变化：追更的落点目录被人删掉 / 改名了，以前报「找不到保存目录」、连错 3 次通知；以后会重新建出来接着转存。
   - S7 这样也收得住。第一次整理删掉 `怒呛人生` 时，指着它的追更跟到作品目录（现有的 `dirMappings`）。追更要是在整理删完之后才建的（智能体先等整理建出来、再建追更，自动执行快的时候会这样），或者分享根是目录、`subPath` 没有映射，下一次落点不在就建出来再整理，照样收干净。
3. **追更的整理来源**：`saveSelectionToTask` 加 `organizeTrigger`，追更传「追更」，去掉最后那次重复的交接。
4. **说明文字**：`subPath` 说明、「找片入库」第 5 步去掉「会留空壳」，保留「要整理就不用给」。
5. **测试**：
   - `share_save`：S2 / S3 / S7 / S8 删干净；原来就有的子目录不删；补整理也交目录。
   - 追更：S12 能接着落；落点建出来、又被整理删掉；任务目录不在照旧报错（改 `service.itest` 里「转存失败」那条的布景）；整理记录里来源是「追更」。
   - `run.itest` 场景 D 那条的注释改成「转存进原来就有的子目录」。

不做：S6 是「不认识的文件类型不动」的既有规则，删了就是删用户的文件。

用户说「按照你的推荐制定计划开始吧」。

### 实施计划

1. **`share/receive.ts`**：
   - 新加 `ensureSaveDir(provider, originPath, subPath, signal)`：保存目录不在就一级级建出来，回这次建出来的最上一层（相对任务目录，本来都在是 `""`）。
   - 任务目录本身不在、路上撞上同名文件、账号建不了目录，抛 `SaveDirError`（带 `reason`），调用方换成自己的说法。
   - `SaveSelectionOpts` 加 `createdDir`（调用方为这次转存建出来的最上一层）和 `organizeTrigger`（默认「转存」，追更传「追更」）。
   - 交给整理时有 `createdDir` 就交它；它得是 `subPath` 本身或上级，不是就不认，照旧交条目。
2. **`share_save`**：
   - `ensureSubDir` 改成调 `ensureSaveDir`，错误照旧换成带提示的 `ToolError`，回建出来的那层。
   - 作业里传给 `saveSelectionToTask`，记进 `SaveMeta.createdDir`。
   - 补整理：上次建的目录逐层 `listDir fresh` 核对，还只装着上次的条目才交目录。这期间别的转存也落进来了的，照旧交条目，免得把别的也一起整理了。
3. **追更 `runCheck`**：
   - 每组转存前 `ensureSaveDir`。建了目录的记一行日志、传 `createdDir`；出错算这一组失败，和转存失败一样退避、连错 3 次通知。
   - 传 `organizeTrigger: "follow"`，去掉最后那次 `maybeAutoOrganize` 和 `landed`。
4. **说明文字**：`share_save` 的 `subPath`、「找片入库」第 5 步。
5. **测试**：
   - `mcp-p3.itest`：
     - 散文件、发布目录转存进新建的 `怒呛人生`，只建了 `美剧/怒呛人生` 的，整理后都删干净；
     - 原来就有的子目录照旧留着；
     - 补整理交目录，混进了别的就交条目；
     - 转存 + 追更：新建目录删掉后追更跟到作品目录，下一集落进作品目录；
     - 分享根是片名目录、不给 `subPath` 的追更：整理删掉目录后，下一集照样落进来。
   - `follow/service.itest`：
     - 落点被删（订阅的 `subPath`、分享里的层级两种）：建出来接着转存，交给整理的是建出来的目录、来源「追更」；
     - 落点在的照旧交条目；
     - 任务目录不在照旧报错（改「转存失败」那条的布景）。
   - `run.itest` 场景 D 的注释。
6. **收尾**：后端全量、前后端 tsc / eslint；`/code-review max` 全修；提交。推送、发 rc 等用户点头。

### 进度

- [x] 1 receive.ts
- [x] 2 share_save
- [x] 3 追更
- [x] 4 说明文字
- [x] 5 测试
- [x] 6 收尾：没做评审（用户说先不评审，直接提交）

### 实施记录（2026-09-28）

- `share/receive.ts`：
  - `ensureSaveDir`：保存目录不在就一级级建出来，回这次建出来的最上一层。上一层是刚建的，下面就不再问网盘。
  - `SaveDirError` 带 `reason`：`task-root` / `not-a-dir` / `read-only`。
  - `SaveSelectionOpts.createdDir`、`organizeTrigger`：有 `createdDir`（要是 `subPath` 本身或上级）就把它交给整理，否则交条目；来源默认「转存」。
  - 计划外多做的：转存本身没成（`share.receive` 抛错）时，`dropCreatedDir` 把建出来的目录从落点往上删回去，只删空的。自查时发现不删的话，下次重试目录已经在了，就当成原来就有的，整理完照样留空壳。
- `share_save`：
  - `ensureSubDir` 包一层 `ensureSaveDir`，错误照旧换成带提示的 `ToolError`。
  - 建出来的记进 `SaveMeta.createdDir`，传给 `saveSelectionToTask`。
  - 补整理时 `onlySavedIn` 逐层 `listDir fresh` 核对：从建出来的那层往下，每层只有下一层这一个目录，落点里只有上次的条目，才交目录。
- 追更 `runCheck`：
  - 每组转存前 `ensureSaveDir`，建了就记一行日志。
  - `createdInRound` 记这一轮建出来的目录，后面的组落在里面的也交它。前一组的整理可能已经跑完，只交里面那层会把它留成空壳。
  - 传 `organizeTrigger: "follow"`，去掉最后那次交接和 `landed`。
- 说明文字：`subPath` 说明、「找片入库」第 5 步。
- 测试：
  - `mcp-p3.itest` 加 3 个：
    - 新建目录删干净的三种（片名目录、两层都新建、只建了下面一层），原来就有的留着，转存没成的收回；
    - 补整理：只装着上次的交目录，混进了别的交条目；
    - 追更：新建子目录删掉后追更跟到作品目录、下一集落进作品目录；分享根是片名目录的，下一集照样落进来、整个交给整理、来源「追更」、再整理干净。
  - `follow/service.itest` 加 2 个：落点建回来（订阅的落点、分享里的层级、一轮里好几组）、落点在的照旧交条目；转存没成把建出来的删回去。
  - `follow/service.itest` 改 2 个布景：「转存失败」「服务端更新信号」里造失败的办法，从删落点改成删任务目录。
  - `run.itest` 场景 D 的注释。
- 变异核对：下面 8 处逐一去掉，对应用例各自失败，恢复后全过。
  - 不认 `createdDir`；
  - 追更不建落点；
  - 一轮里只交自己建的；
  - 转存没成不收回；
  - 补整理不核对；
  - 补整理不交目录；
  - 来源不传；
  - `share_save` 不传 `createdDir`。
- 后端全量 1312 个通过；后端 / 前端 / shared 的 tsc 和后端 eslint 通过。
- `/code-review max` 没做：用户说先不评审，直接提交。真机没验。

### 真机验证（2026-09-28）

用户说「把这一次和上一个 rc 都真机验证一下吧」，给了 TMDB 令牌（只放在实验库里，验完删了）。

**环境**：
- 后端跑在 `config/openstrm.db` 的只读拷贝上（4100，只绑 127.0.0.1）：生产任务、云下载回执删掉，Telegram 指到本机假服务，Emby、监控、定时都关了。
- 智能体用 MCP 官方客户端连 `/mcp`，令牌分「完全」「日常」两个。
- 测试区是两个网盘根下的 `/v0928lab`，验完连同转存进来的剧集一起删了（进回收站）。
- 分享用以前给过的两个：115 `swsgklr3z1r`（末日地堡，TMDB 125988）；夸克 `da70039d1349`（日剧，TMDB 上查不到，识别词直指到 111240，只为让整理能动文件）。
- 任务整理设「把握大的直接执行」，不开复制。

**115**（全部符合预期）：

| 场景 | 结果 |
|---|---|
| 散文件存进新建的「末日地堡」 | 范围是 `["末日地堡"]`，执行后只剩作品目录，本地 strm 跟过去 |
| `美剧/末日地堡`，`美剧` 原来就有 | 范围是 `["美剧/末日地堡"]`，只删这一层，`美剧` 留着 |
| 存进新建的「追更新建」+ 追更 | 目录删掉、追更跟到作品目录；从已知清单抹掉一集后检查，落进作品目录，整理来源「追更」 |
| 追更落点带分享里的「Season 3」，网盘上没有 | 日志「落点不在了，建了 …/Season 3」，整理来源「追更」、范围 `["Season 3"]`，挪完删掉；再来一轮同样重建（115 的路径缓存没拿旧目录） |
| 同样的转存 10 分钟内先不整理、再要整理 | 补整理交的是整个 `补整理` 目录，挪完删掉 |

**夸克**：
- 散文件存进新建目录：交目录、删干净。
- 分享根是片名目录、不给子目录的追更（S12）：前三次检查按服务端信号跳过（设计如此），第四次转存，落点重建、整理后删掉；再来一轮同样重建。

后端日志没有警告和错误。

**没在真机上覆盖**：转存本身失败时收回建出来的目录（真网盘上造不出转存失败）；补整理「混进了别的只交条目」那条。都有用例。

## 集标题 / 片名里的词被当成花絮（2026-10-02）

用户在 115 `/tv` 上预览《绝望写手》第五季：十集里九集照常挪，`Hacks.S05E04.Whos.Making.Dinner.2160p.Stan.WEB-DL.DDP.5.1.H.265-BlackTV.mkv` 标「不变 · 花絮不动」，问「为什么认为是花絮」。

### 根因

`parseMediaName` 的 `marker()` 对每个词都查一遍 `RE_EXTRA` / `RE_SPECIAL` / `sample`，不看这个词站在哪。集标题「Whos Making Dinner」里的 `Making` 撞上花絮词表里的 `making`（本意是 making-of），整个文件 `isExtra`，规划时走「花絮不动」；花絮设成「挪进 extras/」的话会被挪进去。

同一个毛病的其它样子（都实跑确认过）：

- 集标题里有 menu / trailer / preview / pv → 花絮；有 special → 特别篇；有 sample → `isSample`，分单元时直接丢掉，预览里连这一行都没有。
- 片名里有这些词：`The.Menu.2022` 标题只剩「The」还带花絮标记；`Making.a.Murderer.S01E01`、`Trailer.Park.Boys.S01E01`、`Special.Ops.S01E01` 标题是空的。目录里一个正片都数不出来，成不了单元，预览里看不到这部作品。
- 默认剧集模板带 `{episodeTitle}`：整理好的 `Show - S01E03 - The Menu.mkv` 再过一遍也会被当成花絮。
- 括号里的 `(Special Edition)` 当成特别篇（逐词试「是不是全是技术词」时，`special` 先被认成了标记）。

### 修法：标记要看位置

- **集标题**：认出集号（`S05E04`、`1x03`、`E03`、`第03集`、字幕组的 ` - 05`）或日播日期之后、第一个技术词之前的正文是集标题，里面的词不当特别篇 / 花絮 / sample 的标记。实现是一个 `episodeTitle` 开关：`setEpisode` / `setAbsolute` / 日期打开，`cutAt("tech")` 关上。这一段里的多词括号也算正文（`S01E01 (Making Friends)`）。
- **片名**：`special(s)` / `menu` / `trailer(s)` / `preview` / `making` / `bts` / `sample` 这几个普通单词（`RE_WORD_MARKER`），标题还没切断、后面还有年份或季集标记（中间没隔着技术词；紧跟的括号年份也算，字幕组风格的方括号年份不算）时是标题词（`titleGoesOn`）。`sp` / `ova` / `ncop` / `pv` 这种行话、带数字的 `menu01` / `trailer2` 不看后面，照旧。
- **括号里整段是版本名**（`(Special Edition)`）：里面的词不当标记，和别的括号版本名一样当噪音切掉。只修误判，不顺手把括号里的版本名记成 `edition`——记了的话 `某剧 [未删减版] 01` 末尾的 01 会按「剧场版 01 是第 1 部电影」那条规则不再当集数（试过，退回来了）。

照旧算标记的：前面没有集号的（`Show.S01.NCOP`、`Show - PV 03`、`Dune.2024.Trailer.1080p`、`Show.Trailer`、`making.mkv`）、集号后面单独成段的（`S01E05 (Preview)`、`- 01 [NCOP]`）、技术词之后的（`s01e01.720p.hdtv.x264-grp.sample`）。

### 没动的

- 没有年份也没有季集标记的 `The Menu.mkv`、`The.Menu.1080p.BluRay`：单看名字和 `Dune Trailer.mkv` 是一个形状，还是当花絮。
- `Making a Murderer - 01`：字幕组式的 ` - 01` 不算标题终点（`Trailer - 01` 得是花絮）。
- 换来的代价：标记写在年份 / 集号前面的花絮（`Dune.Trailer.2024.1080p`、`Dune - Making Of (2024)`、`Show.Special.S00E01`）现在读成标题的一部分，表现为认不出作品或和正片撞名。预览里看得见，不会悄悄动错。
- 本来就认不出的花絮写法（`Movie-trailer`、`Movie.2020.1080p-trailer`、分开写的 `Behind the Scenes`）、括号里的版本名不进 `{edition}`，都没碰。

### 测试

- 新旧解析器逐条对比（脚本在会话 scratchpad，没进仓库）：HEAD 上 126 个测试文件里的名字 + 本机 `data/` 的路径段共 9719 条，结果一条没变；手写的一百五十多个边角样本和新加的测试样本里变了 64 个，逐条看过方向都对，「真花絮不能变」那一组一条没变。
- `parse-name.test.ts` 样本表加 34 条：20 条在旧解析器上过不了，其余是回归（真花絮照旧、`某剧 [未删减版] 01` 照旧是第 1 集）。`plan.test.ts` 加一条：带 Making 的那一集和别的集一样挪、字幕跟着，花絮设成挪也不进 `extras/`。
- 用户现场的目录（十集 + 三张图）过一遍分单元 → 规划：十集都进 `Season 05`。
- 当前线上版本的临时办法也验过：识别词加一行 `Whos.Making.Dinner => Whos.Dinner`，旧解析器就认成 S05E04。
- 那次整理要是已经执行了（旧目录里只剩 E04）：修复后再预览一次，E04 认成正片挪进 `Season 05`，旧目录跟着删掉（模拟过）。
- 后端全量 1470 个通过，tsc / eslint 干净。真机没验。

## 留在原处的文件要不要跟着走（2026-10-02）

修上面那个误判时用户接着问：「哪怕是花絮或者是别的内容，操作是不变的话，是不是应该跟着其他文件一起挪到新的文件夹内，和其他图片一样？」

### 改之前的规则

单元认出来、勾选了、正片要挪的前提下：

| 文件 | 改之前怎么办 |
| --- | --- |
| 正片、字幕、同名 nfo / 图片、作品级 nfo / 图片 | 跟着挪 |
| 名字认不出的图片 / nfo | 作品自己的目录（`ownsDir`）里原名进作品目录；否则「找不到对应的视频」留下 |
| 花絮（花絮目录里的任何文件 + 按名字认出的） | 默认「花絮不动」；设置打开才进 `<作品目录>/extras/`，只留文件名 |
| 认不出类型的（txt / url / 音频 / 压缩包，`kind = other`） | 「不认识的文件类型，不动」 |
| sample | 分单元时丢掉，预览里没有这一行 |
| 看不出第几集的正片、没勾的、冲突的 | 留下 |

### 留下之后会怎样（`buildUnits` + `planUnit` + `finalizeItems` 模拟过）

一个发布目录里放：正片 + 字幕 + 名字带 Trailer 的视频 + `Featurettes/` 两个 + `Trailers/` 一个 + sample + txt / url / flac + 广告图 + poster。

- 默认设置：正片、字幕、两张图走了，另外 8 个文件留下，源目录删不掉。
- 打开「花絮挪进 extras/」：花絮走了，sample 和三个认不出类型的还在，源目录照样删不掉。`Trailers/01.mkv` 和 `Featurettes/01.mkv` 拍平后撞名，记成硬冲突；自动整理有冲突就整轮不执行（`preview.ts` 的 `stats.conflicts === 0`），等于一个花絮撞名卡住了正片。
- 两种设置下，下一次整理这个目录都成不了单元（没有正片），留下的东西以后的预览里再也看不到。
- 留下的视频本地还有 strm，旧目录还在媒体库范围里，多半会被扫成一条多余的条目（没在真 Emby 上验）。

规则自己也不一致：广告图跟着进作品目录，广告 txt / url 留下；sample 连显示都不显示。

### 结论和推荐

方向对：正片走了以后，留下的东西没有上下文、没人再管，应该跟着走。但不能都「和图片一样」原名放进作品目录：花絮是视频，平铺在作品目录 / 季目录里会被媒体服务器当成另一个版本或者一集，得进 `extras/`。

1. 花絮默认进 `<作品目录>/extras/`：现有开关的默认值从「不动」改成「挪」，开关留着。花絮项同时改成附属（`soft`、跟着正片）：撞名就留在原处，不算冲突，不卡自动整理。照旧平铺、只留文件名：Emby 文档写明 extras 目录里「Nested folders are not supported」，保留子目录的做法不能用；撞名的就留下。
2. sample 当花絮处理，进 `extras/`；至少要在预览里出现。
3. 认不出类型的文件：作品自己的目录里原名跟进作品目录，和认不出的图片 / nfo 同一条规则（`ownsDir`、`soft`、正片没挪就不跟）。收件箱 / 任务根里散着的照旧不动，不知道归谁。
4. 不跟的：看不出第几集的正片、没勾的、冲突的。这些要人决定，而且下次预览还看得见。

代价：

- 按名字认花絮会认错。默认挪以后，认错的正片会被放进 `extras/`（现在是留在旧目录，两种都不对；上一节的修复压低了误判）。预览里这类行最好标一句「按花絮处理」。
- 广告 txt / url 会进作品目录，广告图现在就这样。媒体服务器不认这些文件，只是网盘上看着乱。
- 同名的垃圾文件第二次会撞名留下（同一个站的第二季，广告图同名），旧目录还是删不掉。「跟着走」解决不了这个，得另做「垃圾文件」规则（按名字 / 扩展名，整理时删进回收站，默认空）；那是自动删文件，单独再议。
- 只对以后的整理生效。以前留在旧目录里的不会被捡回来，那些目录成不了单元。

「不删除任何文件」不变，挪动都能撤销。

### 推荐的做法（用户问「你推荐如何处理」，随后说「按照你的推荐开始吧」）

媒体服务器这边核实过：Emby 的剧集 / 电影文档都认作品目录（剧集还认季目录）下的 `extras` 子目录，Jellyfin 同样认剧集目录和季目录下的 `extras`；Emby 明说 extras 里不支持嵌套目录。所以 `<作品目录>/extras/<文件名>` 这个落点是对的，平铺也是对的。

分三步，前两步各一个提交：

1. **解析修复单独提交**（上一节，已经验过）。它和策略无关，是实打实的 bug。
2. **「跟着走」一个提交**：
   - 花絮默认进 `extras/`：`resolveOrganizeSettings` 的 `extras` 默认值改成 `move`，设置页的勾选框按「不是 keep 就勾上」显示；手动设过的不受影响。
   - 花絮项带 `soft` + `follows`（跟单元里所有正片）：撞名留下、不算冲突；正片没挪它也不挪。
   - sample 不再在 `buildUnits` 里丢掉，当花絮处理。
   - `kind = other` 的文件走认不出的图片 / nfo 那条 `placeOf` 规则（`ownsDir` 才跟）。
   - 预览里花絮行的理由写「按花絮处理」，认错了能看出来。
   - 不动：看不出第几集的正片、没勾的、冲突的。
   - 升级说明要写一句行为变化：没设过这个开关的，花絮从这版起默认跟着进 `extras/`。
3. **垃圾文件规则先不做**。它是自动删文件，等第 2 步上线、看旧目录里实际还剩什么再定。已知会剩的：同一个站的下一季，同名广告图撞名留下。

验证：用例之外，在用户 115 `/tv` 上只读预览一遍（要用户批准），再和解析修复一起发 rc。

### 实施记录（2026-10-02）

解析修复先单独提交了（`b0bf9b0`）。「跟着走」照上面第 2 步做，和计划有三处出入：

- **已经在作品目录里的不重新摆**（计划里没有，真机预览时想到的）。花絮默认挪以后，整理过的库再跑会把 `作品目录/Featurettes/…`、`片名 (2024)-trailer.mkv` 这些媒体服务器本来就认的放法拍进 `extras/`，季目录里的杂项会被拽到剧根目录。所以「跟着走」只管作品目录外面的文件：`planUnit` 里 `inWork = 路径在 dstRoot 之下`，花絮和 `other` 都先看它。
- **收藏夹不带 sample**。`buildUnits` 不再丢 sample 之后，收藏夹的单元 `fileIds` 会多出 sample（转存作品时一起带上）；`library/units.ts` 的 `others` 里把它滤掉，行为和以前一样。
- **不动的花絮理由不变**。设置成留在原处的、已经在作品目录里的，都还是「花絮不动」。

落地：

- `settings.ts`：`extras` 默认 `move`。设置页勾选框 `value.extras !== "keep"`，说明里加了 sample 和「关掉旧目录删不掉」。
- `units.ts`：`parsed.isSample` 的文件标 `isExtra` 留在单元里（不参与认作品、不算版本数）。只有 sample 的目录照旧成不了单元。
- `plan.ts`：花絮 → `<dstRoot>/extras/<文件名>`，理由「按花絮处理」，带 `soft` + `follows: allVideos`；`kind = other` 走 `placeOf`（`ownsDir` 才跟），同样是附属。
- 前端不用改显示：理由本来就跟在源文件名下面，挪动的行是灰字；每一行都能单独取消勾选，认错的花絮勾掉就留在原处。
- README 的整理一节加了一段「正片挪走以后剩下的也跟着走」。

模拟的那个发布目录现在：12 个文件走 11 个，只剩撞名的 `Trailers/01.mkv`（标「跳过 · 和 01.mkv 要去同一个位置，留在原处」），sample 在预览里看得见。

测试：

- `plan.test.ts` 五条：默认值 + 理由；一个发布目录全部跟着走、源目录从深到浅删掉；花絮撞名是跳过不是冲突；正片没挪都不跟、任务根里的杂项不动；整理过的库（电影 / 剧集）再跑全是不变。`units.test.ts` 改一条（sample 留在单元里当花絮）。
- `run.itest.ts` 一条闭环：假网盘上自动整理直接执行（撞名没让它改成等确认）→ 网盘和本地 strm 都对 → 撤销全部退回、建出来的目录删掉。
- `library-works.itest.ts` 的种子目录里加了一个 `sample.mkv`：那部电影的 `fileIds` 还是两个（正片 + 图片）。
- 变异核对：默认值改回不动、花絮不算附属、花絮不跟正片、sample 照旧丢掉、杂项不跟、作品目录里的也重新摆、收藏夹不滤 sample，七处逐个去掉，各自有用例失败，恢复后全过。
- 后端全量 1475 个通过；三个包的 tsc 和 eslint 干净。
- **真 115 只读预览**（实验库是本机 config 库的拷贝；Provider 套了一层壳，写操作和分享一律拦下；本机没有 TMDB key，用只认《绝望写手》的桩）：`/tv/【高清剧集网发布 …】绝望写手.第五季…` 走真预览流程，十集全部进 `绝望写手 (2021) [tmdbid=124101]/Season 05/`（E04 在内），三张广告图进作品目录，发布目录腾空删掉，0 冲突 0 跳过。预览前后各列了一次 `/tv`，都是 32 项，没有写操作。这个目录里没有花絮 / sample / 杂项，「跟着走」在真数据上没碰到。

没验的：真 TMDB；真网盘上执行（只预览了）；Emby 对 `extras/` 的实际表现（只查了文档）。

升级说明要写：没动过「花絮挪进 extras/」开关的，从这版起花絮和 sample 默认跟着正片进作品目录下的 `extras/`，目录是作品自己的时里面认不出类型的文件也跟进作品目录；想保持原样就把开关关掉。

## TMDB 缓存：手动清空（issue #11，2026-10-19）

用户反馈（[#11](https://github.com/indown/OpenStrm/issues/11)）：TMDB 上作品改了名，再次整理预览还按旧名（`tmdb_cache` 里详情 7 天、搜索 / 季 1 天），重启容器清不掉库里的缓存，也没有入口。核实：名字一律来自 `fromDetails` 读详情；「重新预览」「换匹配」都走缓存，换回同一个编号在 `patchUnit` 里直接跳过；整理每次操作 new 一个 `TmdbClient`、memo 只活一次操作，收藏夹那边是进程级单例、memo 没有过期。

第一步先做全局清空：

- `purgeTmdbCache()`（`services/organize/identify.ts`）：删库里全部行 + 模块级 `generation` 加一，活着的客户端下次 `cached()` 时发现代数变了就 `memo.clear()`（收藏夹单例也就跟着作废）。
- `DELETE /api/organize/tmdb/cache` → `{ cleared }`，只给人用（没声明 agentScope，令牌 403）。
- 设置页 TMDB 一节 `TmdbCacheButton`：说明 + 按钮 + 确认框；是动作不是字段，`type="button"`、不碰表单脏状态。
- `organize.itest.ts` 加一条：写一行 → 客户端读到 → 清空 → 库里没了 → 库里换新值后同一个客户端读到新值（证明 memo 丢了）。

没做、留给下一步（issue 里真正要的）：按作品 / 按本次范围只刷新详情和季（`TmdbClient.cached()` 加跳过读取的选项，`PUT /runs/:id/unit` 走现有换匹配路径用当前编号重认，`repreview` 加标记；`repreview` 已有的 `fresh` 是作废待确认清单的意思，别重名）。

第二步（按作品 / 按范围刷新详情和季集，不清全库）的计划在 tmdb-refresh.md。
