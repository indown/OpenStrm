# 刷新 TMDB 信息（issue #11 第二步）

> 第一步（设置页「清空 TMDB 缓存」）的分析和做法见 organize.md 末节「TMDB 缓存：手动清空」。这份是第二步：按作品 / 按范围只刷新详情和季集，不清全库。
> 状态：2026-10-19 已实施、真机验过（见末节「实施记录」），合成 b819063 随 **v2.18.0-rc.1**（88236db）发出：Release 四作业 + CI@v2 全绿，rc 镜像 463cac882654（amd64 / arm64），GitHub Release 是预发布；latest 仍是 v2.17.0，main 未动在 43a627c。

## 要解决的事

TMDB 上作品改了译名 / 海报 / 集标题，整理预览还按缓存里的旧的（详情 7 天、季 1 天）。用户要的是：预览里挑一部刷新，或这次范围里的全部刷新；只改预览不动网盘；失败保留原预览。

## 决定

1. **刷新 = 身份不变、只重取**。按单元现在的 TMDB 编号重新拉详情和季集（跳过缓存，结果写回缓存），再按新信息重规划。不重新搜索：搜索缓存照用——目录名是按旧名起的，旧名反而更容易对上，刷新只是换详情。
2. **单个作品就地刷新**：走 `patchPlan` 现成的换匹配 / 重规划路径，勾选、把握、理由、备选、季 / 集偏移、记忆补的季（fill）都保留；详情和集标题都没变就什么都不改（冲突办法也不清）。
3. **整个范围 = 新建预览时带标记**：整理页「预览」和 run 头部「重新预览」都能带「刷新 TMDB 信息」，这次预览的 TMDB 客户端跳过读缓存。不做就地批量刷新：几百部 × 250 ms 节流一个 HTTP 请求装不下、要做成后台 job，而预览本来就是 job。代价是和重新预览一样，没「记住」的手动改动不保留——确认文案说清楚；要保留就逐部刷新。
4. **开关挂在客户端上，不改 `TmdbApi` 接口**：`new TmdbClient(key, lang, { fresh: true })`，`deps.tmdb(settings, { fresh })`。测试的桩不用动。
5. **字段名 `refreshTmdb`**（run 级）/ **`refresh`**（单元补丁）。`POST /runs` 和 `/repreview` 已有的 `fresh` 是「作废待确认清单」，别碰。
6. run 行不加列、不做迁移：预览开头写一条日志就够，中断的 run 本来就标失败。

## 后端

### A. `TmdbClient` 的 fresh 开关（`services/organize/identify.ts`、`run-state.ts`）

- 构造函数加第三个参数 `opts?: { fresh?: boolean }`。
- `cached()`：fresh 时跳过 `readTmdbCache`，memo 照用（同一个客户端里一部剧的几个季目录只拉一次），拉到的照常 `writeTmdbCache`（海报墙、下次预览都受益）。只影响 `details` / `season`；`search` 走原路（见决定 1：在 `search()` 里显式不传 fresh）。
- `run-state.ts` 的 `Deps.tmdb` 签名改成 `(settings, opts?: { fresh?: boolean }) => TmdbApi | null`，真实现透传给构造函数。

### B. 单元补丁 `refresh`（`preview.ts` `patchPlan`，shared `OrganizeUnitPatch`）

- `OrganizeUnitPatch.refresh?: boolean`；路由 `unitPatchSchema` 加 `refresh: z.boolean().optional()`。
- 预检那一轮：`patch.refresh` 的单元也进 `reidentified`（同一批不许给它的文件选办法，和换匹配一个道理：目标可能变）。
- 换匹配循环改成：
  - `target = patch.match ?? (patch.refresh ? row.match : undefined)`；没 target 而 refresh → `400 NO_MATCH`「这部还没识别出来，先换匹配」。
  - `same = row.match && 同编号同类型`；`same && !patch.refresh` → 照旧 continue。
  - 客户端 `deps.tmdb(state.settings, { fresh: !!patch.refresh })`；`identifyUnit` 的 known 证据 source：same 时「刷新 TMDB 信息」，否则「手动指定」。
  - same（纯刷新）：新 match = `{ ...r.match, confidence: row.match.confidence, reason: row.match.reason, candidates: row.match.candidates ?? [] }`。和旧 match 比 title / originalTitle / enTitle / year / posterUrl / imdbId / genreIds / countries / originalLanguage / seasons，再比 episodeTitles；全一样 → `reidentified.delete(key)`、不进 picked（`applyUnitPatch` 拿不到 picked 就沿用旧 match，`sameUnitRow` 相等，什么都不写）；有变 → picked，带 `keep: true`。
  - picked 落库那段：`keep` 的不清 `state.fills` / `state.identifyNotes`，只换 episodeTitles。drafts 里 `fill: picked.get(key)?.keep ? state.fills.get(key) : picked.has(key) ? null : state.fills.get(key)`。
- `applyUnitPatch` 不用动：picked 的 match 是新对象，`sameUnitRow` 按引用比不相等，照常重规划。`selected` 沿用（没传 match 就不强制勾上）。
- TMDB 失败照旧从 identifyUnit 抛出去 → `upstreamError`，整批不改，原预览还在。
- `patchUnit` 返回值不变（页面自己比前后，见 H）。

### C. run 级 `refreshTmdb`（`preview.ts` `createRun` / `preview()`，`run.ts` `repreviewRun`，路由）

- `CreateRunInput.refreshTmdb?: boolean`；`createSchema` / `repreviewSchema` 各加 `refreshTmdb: z.boolean().optional()`；`repreviewRun(runId, { refreshTmdb })` 透传。
- `startJob(run.id, (job) => preview(job, run.id, { refreshTmdb }))`；`preview()` 里 `deps.tmdb(settings, { fresh: !!opts.refreshTmdb })`，开头 `jobLog`：「跳过 TMDB 缓存：每部作品的详情和季集重新向 TMDB 拉取，作品多会慢一些」。
- 「重新预览」的 `guardSupersede` 逻辑不变。

### D. 智能体（`services/agent/tools/organize.ts`）

- `organize_adjust` 的 `changeSchema` 加 `refresh: z.boolean().optional()`，describe：「单元：按现在的匹配跳过缓存重新向 TMDB 拉详情和季集（TMDB 上改了译名时用），信息没变就什么都不改」；映射到 `patch.refresh`。
- `organize_preview` 加 `refreshTmdb`，describe 同上加一句「作品多会慢」。
- 工具数不变，说明文字里不用提。

## 前端

### F. `lib/api.ts`

- `createRun(input)` 的入参类型加 `refreshTmdb?`；`repreview(id, opts?: { refreshTmdb?: boolean })`。`patchUnit` 的类型跟着 shared 走。

### G. 整理页发起预览（`organize/page.tsx`）

- 「预览」按钮旁加勾选框「刷新 TMDB 信息」，`FieldHint`：「跳过缓存重新拉每部作品的详情和季集，TMDB 上改了译名时用；作品多会慢」。默认不勾、不记忆、预览发起后复位。

### H. run 视图（`RunView.tsx`）

- `refreshUnit(unit)`：`markPatching` → `api.organize.patchUnit(runId, key, { refresh: true })` → `load()` → 比前后的 `match.title` / `match.year` / `dstRoot` 和这个单元的 `counts.changing`：
  - 名字 / 年份 / 目标目录变了 → `toast.success("「旧」→「新」，已按新信息重新规划")`
  - 只有清单变了（集标题之类）→ 「TMDB 信息有更新，清单已重新规划」
  - 都没变 → `toast.info("TMDB 上的信息没有变化")`
  - 失败 → `toast.error(apiErrorMessage(err, "刷新失败"))` + `load()`（和 `patchUnit` 一样）
- 头部「重新预览」改成主按钮 + 右侧小箭头的下拉（`DropdownMenu`，写法参考 `AgentSection.tsx`），菜单项「重新预览并刷新 TMDB 信息」，描述一行「没「记住」的手动改动不保留；只想刷新某一部就在它那一行点」。

### I. 单元列表（`UnitList.tsx`）

- 行动作区 `editable && m` 时在「换匹配」右边加「刷新 TMDB」（`RefreshCw` 图标，`h-8`），title：「不换作品，跳过缓存重新拉这部的详情和季集，按新信息重新规划」。`onRefresh` 顺着现有 `onMatch` / `onAdjust` 的路传下去。

## 测试

- `organize.itest.ts`（已有 DB 和路由）：fresh 客户端跳过库里的值、拉到的写回、同一客户端第二次走 memo；`PUT /unit { refresh }` 200；没识别的 400 `NO_MATCH`；`POST /runs { refreshTmdb }` 201 且日志有「跳过 TMDB 缓存」；`POST /repreview { refreshTmdb }` 201。
- `run.itest.ts`：桩的详情可改（Map 里换 title）：刷新 → `dstRoot` 按新名、confidence / reason / candidates / selected / fill 照旧，其它单元不动；没变 → `changed` 空、已选的冲突办法还在；TMDB 抛错 → 单元和清单原样；`deps.tmdb` 捕获 opts 断言 `fresh: true`（纯换匹配是 undefined）；`refreshTmdb` 的预览同样断言。
- `mcp-p3.itest.ts`：`organize_adjust` 一条 refresh、`organize_preview` 一条 refreshTmdb。
- 前端 tsc / lint；浏览器冒烟（scratch 库 + 桩，见 memory「本机 UI 预览环境」）：勾选框、行按钮三种提示、下拉项。
- 真机：要用户的 TMDB key（本机没有）。造「旧名」不用等 TMDB 真改：预览一次后直接改 scratch 库 `tmdb_cache` 里那部的 `title`，再预览显示假旧名 → 点「刷新 TMDB」→ 真名回来、目标目录跟着变；115 / 夸克只读预览，不执行。

## 发布说明要写的

- 新增：设置页「清空 TMDB 缓存」；整理预览里每部作品的「刷新 TMDB」；「预览」「重新预览」可带「刷新 TMDB 信息」；智能体 `organize_adjust.changes[].refresh`、`organize_preview.refreshTmdb`。
- 行为变化：无（不带标记的预览和以前一样走缓存）。没有迁移。

## 不做

- 收藏夹的重新识别照旧走缓存（它的单例客户端在「清空 TMDB 缓存」时会丢 memo，要按作品刷新再说）。
- 不探测 TMDB 的改动、不改 TTL、不做就地批量刷新 job。

## 顺序

1. A + B + C + shared 类型 + 后端测试（半天）
2. F + G + H + I + 冒烟（半天）
3. D + mcp 测试（一两个小时）
4. README 整理一节补两句、发布说明；有 key 就真机走一遍

## 实施记录（2026-10-19）

按上面的顺序做完，和计划的出入：

- `TmdbClient.cached()` 多了一个 `skipStore` 参数，`details` / `season` 按构造时的 `fresh` 传，`search` 永远不传；memo 照用。
- `patchPlan` 的换匹配循环改成统一的 `target = patch.match ?? (refresh ? row.match : undefined)`；纯刷新时 `sameMatchData` + `sameEpisodeTitles` 都没变就 `reidentified.delete(key)`、不进 picked；有变的 picked 带 `keep: true`，落库那段不清 fills / identifyNotes，drafts 的 fill 也照留。
- 前端 `RunView.load()` 现在返回详情（给 `refreshUnit` 比 planVersion 用），`FailurePanel` 的 `onChanged` 包了一层保持 `Promise<void>`。
- 智能体：`organize_adjust.changes[].refresh` 在工具里先拦「没识别出来的单元」（VALIDATION），不等后端 400；`organize_preview.refreshTmdb`。工具清单快照（`tools.snapshot.json`）按 `UPDATE_SNAPSHOTS=1` 重生成，diff 只有这两个布尔字段。
- 测试：`organize.itest.ts` 加 2 条（fresh 客户端用 axios adapter 桩住网络；路由全链路），`run.itest.ts` 加 1 条（桩的 beefTitle 可改、failBeef 让详情失败；顺手把文件里另一处 `setOrganizeDeps` 的旧写法改成带 opts，不然刷新拿不到 fresh），`mcp-p3.itest.ts` 加 1 条。后端全量 1596 过 1596（快照更新后），tsc / eslint 干净；前端 tsc / next lint 干净。

真机（115 + 真 TMDB，只读预览，不执行）：实验库是 `config/openstrm.db` 的拷贝（只留 115 tv 任务，监控 / Telegram / Emby / 智能体 / 更新检查全关，追更和复制队列清空，临时口令，用户给的 TMDB key），后端 4100 只绑 127.0.0.1，前端 dev 3223。范围选 `/tv` 里已整理好的 `Murderbot (2025) [tmdbid=241554]` 和 `Severance (2022) [tmdbid=95396]`（TMDB zh-CN 现在就叫这两个英文名，预览 0 项要动）。造旧名不用等 TMDB 真改：直接改实验库 `tmdb_cache` 里 Severance 详情的 `title` 为「人生切割术（缓存旧名）」并把 fetched_at 设成现在。

- 普通「重新预览」确实按旧名算：Severance 变成「人生切割术（缓存旧名）(2022)」，9 项要动——issue 描述的现象复现。
- 单元行「刷新 TMDB」：提示「『人生切割术（缓存旧名）』→『Severance』，已按新译名重新规划」，回到 0 项要动；Murderbot 上点是「TMDB 上的信息没有变化」。
- 再种旧名 → 头部「重新预览」下拉「重新预览并刷新 TMDB 信息」：新 run 直接 0 项要动，日志第二行「刷新 TMDB 信息：每部作品的详情和季集跳过缓存重新向 TMDB 拉取…」，库里那行写回 Severance。
- 再种旧名 → 整理页勾「刷新 TMDB 信息」点「预览」：同样 0 项要动、有日志、勾选框发起后复位。
- 设置页「清空 TMDB 缓存」：确认框、提示「已清空 2 条 TMDB 缓存」，表单没被弄脏。
- 控制台没有报错。预览期间 115 只被列目录，没有写操作。

收尾：实验后端 / 前端 dev 停掉，浏览器里的 token 清掉、标签页关掉，scratch 里的库（含 cookie 和 key）、口令、token 全删。
