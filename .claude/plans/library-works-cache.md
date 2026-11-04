# 收藏夹海报墙：聚合结果缓存，接口不再每次全量重算

## 起因

2026-11-03 用户反馈：收藏夹页「每次打开的时候都特别慢」「首屏特别慢，点进来一直加载」「没有加载完就切换到别的 tab 的时候，也会阻碍其他页面的加载」；追问后给的数字：收藏夹几万个单元，`GET /api/library/works` 一次要 5 秒。

本机对着合成库量的（M 系列芯片、回环，`tsx` 起的 scratch 后端；用户的 NAS 大约慢 8 倍）：

| 规模 | /api/library | works 最近入库 | works 按名称 |
|---|---|---|---|
| 5 千单元 | 6 ms | 31 ms | — |
| 2 万单元 | 15 ms | 110 ms | 462 ms |
| 10 万单元 / 5.5 万部 | 71 ms | 611 ms | 2.5 s |

10 万单元时 works 的 611 ms 拆开：`workGroups()` 全量 GROUP BY 加建对象 503 ms，`unidentifiedUnits()` 63 ms，`unitStatusCounts()` 45 ms；按名称 / 年份排序各 2.4 s，全花在每次比较都新建 locale 比较器的 `localeCompare` 上（换成复用的 `Intl.Collator` 是 67 ms）。`/api/library` 里的 `unitSummaries()` 61 ms。

同时每 100 ms 探 `/api/health`：works 跑着时 health 从 2 ms 涨到 500–630 ms。原因是 `listWorks` 每次请求都同步重算整面墙，Node 单线程，别的页面的请求全排在它后面；页面又在有单元待认时每 5 秒轮询 works、索引中 / 有待认时每 3 秒轮询 list，TMDB 不稳时单元每 10 分钟重试一轮、pending 长期清不掉，轮询就一直打。切页时在飞的请求没有取消，服务端照算。

扫本地目录（`localOwned` → `scanLocalWorks`）4000 部作品在 SSD 上 504 ms，不是主因。海报直连 TMDB（w500）是另一个独立的问题，这份方案不碰。

## 方案

### 后端：作品墙视图留在内存里、按单元增量维护

- 新模块 `db/repositories/library-changes.ts`：一个极小的变更广播（`onLibraryChange` / `notifyLibraryChange`），变更有两种：`{ kind: "unit", sourceId, unitKey, before, after }`（单个单元的 status / tmdbId / mediaType 前后状态）和 `{ kind: "all" }`。仓库层的写函数在写完后广播；视图模块订阅。用广播而不是互相 import，是为了不在 `library-units.ts` 和视图模块之间绕成环。
- 新模块 `db/repositories/library-works-view.ts`：`worksView()` 返回 `{ generation, groups: Map<作品键, WorkGroup>, unidentified: Map<单元键, UnitRow>, counts, summaries: Map<sourceId, SourceUnitSummary> }`。第一次读时用现有的 `workGroups` / `unidentifiedUnits` / `unitStatusCounts` / `unitSummaries` 全量建一次；之后：
  - 单个单元变了：涉及的一两个 `(mediaType, tmdbId)` 分组用带条件的同一条 GROUP BY 重查（走 `library_units_tmdb_idx`，毫秒级）；没认出的那一条按单元键重查；计数按前后分类加减；这个来源的统计用带 `source_id` 条件的同一条 GROUP BY 重查（走主键前缀）。generation 加一。
  - 批量操作（重切 `replaceUnits`、`deleteUnits`、`resetAutoIdentified`、分享状态进出 expired、删来源、换链接改了分享码）：整个丢掉，下次读再建。
  - `invalidateWorksView()` 给测试和批量路径用。
- `library-units.ts` 现有的聚合查询加可选条件：`workGroups(filter?)`、`unidentifiedUnits(filter?)`、`unitSummaries(sourceId?)`；单单元写函数（`saveIdentified` / `saveDetails` / `ignoreUnit` / `resetUnit`）写前先读一次主键上的三个字段当 before，写后再读当 after，广播；`setUnitRetry` 只动 retryAt / error，不广播；`recordSaves` 不影响视图，不广播。`library-shares.ts` 的 `updateShare` 在 status 进出 expired 时广播 all；`media-library.ts` 的 `remove` 和改了 shareCode 的 `update` 广播 all。
- `services/library/works.ts`：`listWorks` 改读视图，并按 generation 缓存一层「映射好的 LibraryWork 数组 + 每种排序各一份排好的数组 + 关键词筛选用的归一化名字」；一次请求只剩在排好的数组上筛选、切片。返回给调用方的条目是副本，`owned` 标在副本上，缓存里的对象不被改。排序比较器换成模块级 `Intl.Collator("zh-CN", { numeric: true })`，年份直接比数字。`lookupWorks` 同样改读缓存。
- `routes/library/index.ts` 的列表接口、智能体工具的 `overview` / `library_sources` 改读 `worksView().summaries` / `.counts`。
- 启动后延迟 1 秒预热一次视图（`index.ts` 在 listen 之后），这样重启后第一次打开不用再等那 5 秒；预热失败只记日志。

内存：10 万单元 / 5.5 万部时视图加缓存约几十 MB，几万单元的库更少。

### 前端

- `LibraryWorks.tsx`、`library/page.tsx` 的拉取都带 `AbortController`：新一轮开始先取消上一轮，组件卸载时取消；取消的不算错误（`axios.isCancel`）。`lib/api.ts` 的 `library.list` / `library.works` 接 `signal`。
- 作品墙不再等 `/api/library` 回来才挂：`tab === "works"` 且（还没加载完或来源非空）就挂 `LibraryWorks`，两个请求并行；页签行也在加载中就显示，免得墙先出现、页签再顶下来一截。来源确认为空时照旧换成空状态。
- 轮询退避：待认数连续 6 轮（30 秒）没变，作品墙轮询从 5 秒放到 15 秒；一变回到 5 秒。

### 不做

- 海报走后端代理、改 w342：独立问题，另起方案。
- 把聚合挪到 worker 线程：缓存住以后每次请求只剩筛选切片，没必要。
- SQL 层分页：筛选和排序要跨全库，内存里做比在 SQLite 里 ORDER BY 再 LIMIT 快，而且 `localeCompare` 式的中文排序 SQLite 做不了。
- 多进程共享视图：写入只发生在后端这一个进程里（Emby 代理进程不写单元），进程内广播够用。

## 测试

- `db/repositories/library-works-view.itest.ts`（新）：种几来源若干单元，每做一步变更（认出、换成另一部、认不出、补类型、忽略、重认、重切、删单元、分享进出 expired、删来源、换链接、全部重认）后，把增量维护的视图和 `invalidateWorksView()` 后重建的视图逐项比对（groups / unidentified / counts / summaries）。
- `services/library/works.ts` 现有用例（`library-works.itest.ts`、`library.itest.ts`、智能体 `library.itest.ts`）在同一进程里改单元再读墙，天然覆盖「缓存没失效」这类错。
- 排序：按名称、按年份的用例各加一条（中文 / 数字混排、年份空的排最后）。
- 前端：typecheck / lint；浏览器冒烟：首屏并行、切页请求取消、空库空状态、轮询退避。
- 合成库前后对比：10 万单元时 works 的耗时，和 works 跑着时 `/api/health` 的延迟。

## 进度

- [x] 后端：变更广播 + 视图模块 + 仓库写函数广播
- [x] 后端：works.ts 改读视图 + 排序比较器 + 列表接口 / 智能体工具改读视图 + 预热
- [x] 测试：视图 itest、排序用例
- [x] 前端：取消请求、并行首屏、轮询退避
- [x] 全量测试 + 浏览器冒烟 + 合成库前后对比
- [x] 评审修补（2026-11-04，8 条全修）
- [x] 提交、发正式版 v2.23.1（用户 2026-11-04 定的直接发正式版）

## 实施记录（2026-11-03）

按方案做，没有偏离。工作区未提交。

- 后端
  - 新：`db/repositories/library-changes.ts`（`onLibraryChange` / `notifyLibraryChange`，两种变更：单元 before / after、all）；`db/repositories/library-works-view.ts`（`worksView()` 懒建、`invalidateWorksView()`、`warmWorksView()`、按单元增量维护：分组按 `(mediaType, tmdbId)` 重查、没认出的按单元键重查、计数按前后分类加减、来源统计按来源重查；增量出错就作废重建）。
  - `library-units.ts`：`saveIdentified` / `saveDetails` / `ignoreUnit` / `resetUnit` 写前读主键上的 status / tmdbId / mediaType、写后广播；`replaceUnits` / `deleteUnits` / `resetAutoIdentified`（有变动时）广播 all；`setUnitRetry`、`recordSaves` 不广播。`workGroups(only?)`、`unidentifiedUnits(only?)`、`unitSummaries(sourceId?)` 加可选条件。
  - `library-shares.ts` 的 `updateShare`：status 进出 expired 时广播 all（只记 checkedAt 的不广播）；`media-library.ts` 的 `remove`、改了 shareCode 的 `update` 广播 all。
  - `services/library/works.ts`：`listWorks` / `lookupWorks` 改读视图，按 generation 缓存映射好的 LibraryWork 数组、每种排序各一份预排的、按名字筛用的归一化名字；给出去的是副本；排序用模块级 `Intl.Collator("zh-CN", { numeric: true })`，年份比数字。`routes/library/index.ts` 的列表接口、智能体 `overview` / `library_sources` 改读 `worksView().summaries` / `.counts`。`index.ts` listen 后 1 秒 `warmWorksView()`，失败只记 warn。
- 前端
  - `lib/api.ts` 的 `library.list` / `library.works` 接 `signal`；`library/page.tsx` 的 `fetchEntries` 和 `LibraryWorks.tsx` 的 `fetchWorks` / `loadMore` 带 AbortController，新一轮取消上一轮、卸载取消，`axios.isCancel` 的不算错；作品墙在 `tab === "works" && (!loaded || entries.length > 0)` 时就挂，和来源列表并行拉；页签行在加载中就显示（分享数等加载完再显示）；轮询在待认数连续 6 轮没变后从 5 秒放到 15 秒，一变回到 5 秒，停止轮询时归零。
- 测试：新 `db/repositories/library-works-view.itest.ts` 三条（单元级变动逐步和重建比对；批量变动作废、只记时间 / 改标题不作废；listWorks 排序 / 筛选 / 副本）；后端全量 1715 条全过、前端 11 条全过，两端 typecheck / lint 过。

## 合成库验证（2026-11-03）

**环境**：scratchpad 里全新建的库（没有真实账号、没有 TMDB 令牌、没拷 config），合成 500 个来源 / 10 万单元 / 5.5 万部作品 + 两个 lab 任务指向合成的 strm 目录（4000 部）；后端 `tsx` 起在 127.0.0.1:4123，前端 `next dev` 3223 指过去；口令换成随机临时的，验完删了。

| 场景 | 改前 | 改后 |
|---|---|---|
| works 最近入库（60 条） | 611 ms | 7 ms（重启后第一次 31 ms） |
| works 按名称 | 2.5 s | 14 ms（第一次 75 ms） |
| works 按年份 | 2.5 s | 25 ms（第一次 134 ms） |
| /api/library（500 个来源） | 71 ms | 10 ms |
| works 跑着时每 100 ms 探 /api/health | p50 2 ms、最大 630 ms | p50 2 ms、p95 4 ms、最大 58 ms |
| 模拟识别（每 0.6 秒改一个单元，100 次）期间 works 每 5 秒一次 | — | 43–79 ms；每次改单元 p50 9 ms、最大 28 ms |
| 浏览器：进收藏夹 | — | `/api/library` 和 `/api/library/works` 同一毫秒发出，页签行和海报骨架一起出现 |
| 浏览器：请求在飞时切到任务页 | — | 两个在飞的请求都 abort，任务页正常出来，控制台没有报错 |
| 浏览器：配上（假的）TMDB 令牌、5839 个待认 | — | 轮询 5.1 / 5 / 5 秒，第 6 轮没变后下一次间隔 15.1 秒；自动化窗口隐藏时 usePolling 本来就停，所以中间有几十秒的空档 |

日志：lab 后端除假 TMDB 令牌引起的「TMDB 拒绝了请求（令牌不对？），收藏夹识别停一小时」一条 warn 外没有告警和报错。

收尾：lab 后端、dev 前端已停，浏览器里的临时令牌已清、标签页已关，scratchpad 里的临时口令 / 令牌文件已删；合成库留在 scratchpad（没有真实数据），会随会话清掉。没碰 config 目录和任何网盘。

没验的：用户真实库上的数字（几万单元、NAS CPU）；海报直连 TMDB 的问题不在这份方案里。

## 评审修补（2026-11-04）

发正式版前跑了一轮独立评审（medium），8 条全修，没有留项：

1. **整来源重认逐单元放回**：`reidentifySource` 逐个 `resetUnit`，每个都让视图增量重查一遍。合成库量过（视图建好时 251 个单元逐个 reset 166 ms，没建视图 186 ms，写本身占大头，增量多的只是来源统计 0.18 ms + 分组重查 0.16 ms），不算回归，但几千个单元的来源一条 UPDATE 更干脆：新增 `units.resetDoneUnits(sourceId)`（`status = 'done'` 的一条 UPDATE，广播一次 all），`reidentifySource` 改用它。
2. **启动预热白算**：索引工人重启后接着抄没抄完的来源，抄完一个就广播 all，预热的视图随即作废。改成 `countIndexing() === 0` 才预热。
3. **全新安装闪空状态**：一个来源都没有时作品墙比来源列表先回来，先出「还没有作品」/「配上 TMDB」再换成页面的「收藏夹是空的」。`LibraryWorks` 加 `sourcesLoaded`，来源没回来、墙又空着时只画骨架。
4. **增量更新失败只吞不记**：catch 里 `log.warn({ err, change })`，一直失败（每次写都退化成全量重建）能从日志看出来。
5. **补类型走整套单元变更**：`saveDetails` 只改类型 / 地区，却重查来源统计、加减计数。新加 `kind: "group"` 变更，只重查那一组。
6. **副本里的数组还和缓存共享**：`withOwned` 把 seasons / genres / countries 也复制；用例补了「改返回值里的数组不影响缓存」。
7. **对不存在的分享码写 expired 也作废视图**：按 UPDATE 的 `changes > 0` 判断；用例补了。
8. **单元键两套写法**：视图里 `JSON.stringify([sourceId, unitKey])`、海报墙上 `unit:<来源>:<单元键>`。`workKey` / `unitWorkKey` 放进 `library-units.ts`，视图、`works.ts`、智能体工具的 `unitRef`、`savedWorkKeys` 都用它。

验证：两端 typecheck / lint 过；后端全量 1715 条、前端 11 条全过（视图 itest 加了整来源重认 / 没这个分享 / 数组副本三段）。浏览器（全新空库起 lab 后端 4123 + dev 3223，临时口令，验完已停、令牌已清）：从任务页切到收藏夹，页签 + 海报骨架出现 56 ms 后直接换成「收藏夹是空的」，中间没有闪作品墙的空状态；换成合成库（5.5 万部）再进，100 ms 内出海报和计数，works 冷 51 ms、热 3 ms。
