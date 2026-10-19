# 按本地 strm 的结构整理网盘（issue #12）

> 状态：2026-10-19 已实施（见末节「实施记录」），115 / 夸克 / OpenList 三家真机都走完预览 → 执行 → 撤销全链路，合成 883d1d6 随 **v2.18.0-rc.2**（68e6231）发出：Release 四作业 + CI@v2 全绿，rc 镜像 44e11fb7c165（amd64 / arm64），GitHub Release 是预发布；latest 仍是 v2.17.0，main 未动在 43a627c。
> 来源：[#12](https://github.com/indown/OpenStrm/issues/12) 用户用别的媒体整理软件在本地给 strm 改名、挪目录，希望网盘文件跟着改成同样的相对结构，不再经过 TMDB 识别和模板。

## 为什么值得做

全量同步按**路径**对账（`task/plan.ts` 的 `planSync`）：本地 strm 改了名，旧位置算「缺」会再生成一份，改过名的那份算「多余」，任务开着「删除本地多余文件」就会被删掉。strm 管理的体检对改了名的 strm 也明确不处理（`inspectStrm` 记 `name-mismatch`、不可重写）。所以用别的工具整理本地库在今天不是「没支持」而是会被破坏；这个功能把「本地改了名」变成一种命名来源。

## 对原需求的调整

1. **不分阶段**：网盘上和视频同名前缀的字幕 / nfo / 图片一起跟着改（和整理模块的附属文件规则一致）；本地已有的字幕等下载类文件不动，那是用户自己改过的。
2. **做成整理的一种「命名来源」，不做独立功能**：预览 / 执行 / 撤销 / 失败分类重试 / 放弃 / 历史 / 待处理 / Telegram 通知 / 网盘监控认出自家操作 / 追更和云下载回执和复制队列改路径，全部复用。新写的只有计划器、一个 run 字段和界面上的区别。
3. **「本地 strm 根目录 + 对应网盘根目录」就是同步任务本身**，不另选；范围照整理的范围（整个任务，或若干子目录）。
4. **和同步互锁**（原需求没提，不做就出事）：任务正在同步时不能预览 / 执行；整理在跑时该任务的同步这一轮跳过；预览结果里按任务配置给警告（定时同步、删除本地多余文件）。
5. **永远不删网盘文件**，不提供「本地缺了就删」的选项，删除是同步 / 归档的事；也**不自动执行**（只允许 manual 模式，不进 auto / review）。
6. 内容前缀对不上本任务的 strm（别的任务、别的账号、手改过的）记成跳过并列出来，不猜。
7. **撤销会把本地 strm 一并挪回同步时的位置**（镜像的不变量就是「本地跟着网盘」），确认文案里写明。

## 映射规则（`services/organize/local-naming.ts`，纯函数部分进单测）

- 本地索引：走任务 `targetPath` 下全部 `.strm`（跳过暂存区 `isStagingDir`、嵌套的别的任务根 `nestedForeignRoots`，复用 `strm/manage.ts` 的 walk）；读内容 → 去 `task.strmPrefix`（原样或 encodeURI 过的，同 `inspect.ts` 的 `stripPrefix`）→ 按 `enablePathEncoding` 解码 → 必须以 `originPath/` 开头 → 源相对路径 `src`；扩展名取内容最后一段（同 `inspectStrm` 的 `EXT_RE`）。`inspectStrm` 本身在改了名时不回 `actualRemote`，要在它旁边加一个只做「内容 → 网盘路径」的函数，不核对文件名。
- 目标相对路径 `dst` = 本地相对路径去 `.strm` + 源扩展名。
- `src === dst` → keep（界面上归「已规范」）。
- 只有**范围内**的源文件进计划：内容指向范围外的，预览说明里给计数「N 个 strm 指向这次范围之外」。
- 范围内的源文件没有任何 strm 指着 → keep（不删、不提示，同步会管）。
- 一个源被多个 strm 指 → 这个源 skip，原因「多个 strm 指向同一个文件」并列出本地路径。
- 内容指向的文件不在网盘上 → 不是计划项，说明里计数「M 个 strm 指向的文件已不在网盘上（strm 管理页能体检）」。
- 目标落在暂存区（归档 / 重复文件目录）→ skip。
- 附属文件：源目录里和视频同 stem 的字幕 / nfo / 图片 → 跟到目标目录，名字换成新 stem + 原后缀（复用 plan.ts 的附属规则：`follows`、`soft`——目标被占就留原处，不算冲突）。
- 冲突：目标已存在、两个源同一目标 → `conflict`，办法沿用整理的五种（改名保留 / 自己起名 / 挪进重复文件目录 / 删掉 / 覆盖），默认留在原处。
- 建目录 / 删空目录交给 `finalizeItems`（`cleanupEmptyDirs` 设置照用；范围根不删）。

## 单元

- 单元 = **本地的作品目录**：strm 的父目录；父目录是季目录（Season xx / S01 / 第 x 季 / Specials，复用 `inspect.ts` 的判断）就上一级。`key` = 本地相对目录；`rawName` = 目录名；`dstRoot` = 该目录；`rootPath` = 这些源文件共同的网盘目录（不一致就 ""）；`match = null`；`selected` 默认 true；`fileCount` / `videoCount` 按源文件数；`notes` 放跳过原因。
- 没有 strm 对应的范围内文件不成单元（它们 keep，不出现在清单里）。

## 数据与状态

- 迁移 0024：`organize_runs.naming TEXT NOT NULL DEFAULT 'tmdb'`；`OrganizeRun.naming: "tmdb" | "local"`；`CreateRunInput.naming`；`toRun` / `insertRun` 带上。
- `PlanState.naming` + `PlanState.local: Map<unitKey, LocalUnit>`（`LocalUnit = { key, dstRoot, rootPath, files: Array<{ src, dst, nodeId?, kind: "video" | "sidecar", follows?: string }>, notes }`）。
- 新的 `planUnitFor(state, row)`：`naming === "local"` 走 `planLocalUnit(localUnit, { selected, excluded, resolutions })`，否则走现在的 `planUnit`。`preview()` 和 `replanRun` 都改成调它，`patchPlan` 的文件勾选 / 冲突办法 / 单元勾选于是天然可用。
- `patchPlan`：local 的 run 收到 `match` / `seasonOverride` / `episodeOffset` / `refresh` / `remember` → `400 NOT_TMDB_RUN`「按本地 strm 结构整理的清单没有识别结果可改」。
- `toUnitRow`：`selected = naming === "local" ? true : !!match`；批量勾选（`patchUnits` 过滤 `r.match`）和智能体「没识别出来的单元不能勾」只对 tmdb run。
- `afterApply`：`rememberMatch` 只对有 match 的（自然跳过）；`learnFollowOrganized` 只对 tmdb run（它学的是识别结果）；目录映射 / 追更 / 云下载 / 复制队列改路径照常。
- `afterAutoPreview` 碰不到（local 只允许 manual）。

## 预览流程（`preview()` 的分支）

1. 同今天：列范围 → `entries`。
2. `naming === "local"`：不 `buildUnits`、不识别；读本地索引（并发 16、受 `ORGANIZE_LIMITS.MAX_FILES` 约束）；按映射规则构造 `LocalUnit`；日志一行：「本地 X 个 strm，对上范围内 Y 个文件，Z 个要动；跳过 N（分类）」。
3. plans → `listOutsideDstDirs`（范围外的目标目录照列）→ `finalizeItems` → 落库，同今天。

## 互锁与保护

- `createRun(naming: "local")` 和 `applyRun`：`isTaskRunning(task.id)` → `409`「任务正在同步，等它结束再按本地结构整理」。
- 任务 runner 启动同步时：该任务有 planning / applying / reverting 的整理 → 定时的跳过这一轮（记一条历史说明），手动的拦下提示。今天同步和整理之间没有任何互锁，这条对 TMDB 整理同样有益。
- 预览完成后 run 级 notes（新字段 `OrganizeRun.notes: string[]`，不做迁移就塞进 log 的末尾也行，先用 log）：任务开着「删除本地多余文件」→「执行前别跑同步：改过名的 strm 会被当多余删掉」；开着定时 →「下次定时在 HH:MM，建议先执行或先关掉」。
- 风控 / 临时失败 / stale / rejected 的处理沿用。

## 界面

- 整理页：范围旁加「命名来源」下拉（按 TMDB 识别 + 模板 / 按本地 strm 的目录结构）；选本地时下方一行说明，并把 removeExtraFiles / cron 的警告提前画出来。
- run 头部：命名来源芯片；本地 run 的单元卡片不画海报、把握徽标换成「按本地结构」、标题用目录名、「原：网盘目录 → 本地目录」；隐藏换匹配 / 季集偏移 / 刷新 TMDB / 记住 / 找资源；保留勾选、看文件、文件勾选、冲突办法。
- 历史、待处理列表：芯片。
- 执行 / 撤销的确认文案：本地 run 加「撤销会把本地 strm 挪回同步时的位置」。

## 智能体

- `organize_preview` 加 `naming`（默认 tmdb）；`unitView` 对 local run 不给 `why: unmatched` 和 candidates，带 `naming`；`organize_adjust` 对 local run 的 tmdbId / season / episodeOffset / refresh / remember 报 VALIDATION；confirmText 开头写「按本地 strm 结构」。工具清单快照更新。

## 通知

- organize-review / 执行完成 / 撤销的 Telegram 文案带来源。

## 测试

- 单测 `local-naming.test.ts`：前缀 / 编码 / 扩展名 / 已规范 / 多对一 / 跨任务 / 暂存区 / 范围外 / 不在网盘 / 附属文件跟随 / 季目录归到剧目录。
- `run.itest.ts`：FakeDrive + LOCAL 下手写改过名的 strm（模拟别的工具）→ 预览项正确 → 执行：网盘改名移动、本地 strm 内容重写、网盘字幕跟随、本地字幕不动 → 撤销全退回（本地也回去）；local run 的 patch 拒绝 TMDB 字段、文件勾选和冲突办法可用；同步在跑 409；removeExtraFiles 警告；子目录范围。
- `organize.itest.ts`：`naming` 参数、迁移后旧 run 读出来是 tmdb；`mcp-p3.itest.ts`：`organize_preview naming` + `organize_adjust` 拒绝。
- 浏览器冒烟（scratch 库 + 假网盘）；真机：115 上用 `files/copy` 造一个小目录（写操作要用户批准），本地用脚本模拟改名，预览 / 执行 / 撤销各一遍。

## 文档与发布

- README 整理一节加小节「用别的工具整理好本地 strm 之后，让网盘跟着改」，写清顺序：先整理本地 → 立刻按本地结构整理网盘 → 再同步；开着「删除本地多余文件」的别在中间跑同步。
- 升级说明：迁移 0024；行为变化：有整理在跑时同步会跳过这一轮。

## 不做

- 不上传本地视频；不按本地缺失删网盘；不把本地的 nfo / 图片传到网盘；跨任务 / 跨账号挪动；不自动触发。

## 工作量

后端（计划器 + run 字段 + 互锁）1.5 天，前端 1 天，智能体 + 测试 1 天，真机半天。

## 实施记录（2026-10-19）

按计划做完，和计划的出入：

- **代码落点**：`services/organize/local-naming.ts`（内容 → 网盘路径、本地索引、映射成单元、`planLocalUnit`）；`preview.ts` 里 `preview()` 按 `run.naming` 分支到 `previewLocal`，两条路共用新抽出来的 `newPlanState`；`planUnitFor` 让 `patchPlan` / `replanRun` 对两种 run 一视同仁，local 的 run 收到 match / 季 / 偏移 / refresh / remember 回 `400 NOT_TMDB_RUN`。
- **「排上了」的口径**：`run-state.ts` 加 `unitActive`（勾选且有匹配，或 key 带 `local:` 前缀），`computeStats` / `activeItemFilter` / `failureGroups` / `dirMappings` / `query.ts` 的 `unitCounts` 全改用它——不然 local 的项执行时会被 `activeItemFilter` 全过滤掉、统计全是 0。真机上第一版就是「跳过」没算进单元计数，被两个 strm 指着的那项在页面上归进了「已规范」。
- **TMDB**：local 的 run 不要 key——`preview()` 里缺 key 的检查挪到分支之后（第一版放在前面，测试里先暴露）。
- **互锁**：`createRun` / `applyRun` 对 local 查 `isTaskRunning`；`task/runner.ts` 的 `startTask` 在占位前查同任务有没有 planning / applying / reverting 的整理，有就回 409「这次同步跳过」（不进历史、不通知，和「已经在跑」一个待遇）。
- **迁移 0024**：`organize_runs.naming` 默认 `tmdb`。没有新的设置项。
- **智能体**：`organize_preview.naming`（again 时沿用旧 run 的）、`organize_adjust` 对 local run 拒绝换匹配 / 季 / 偏移 / 记住 / 刷新和 `select: confident`；视图里 local 单元不算 `unmatched`、带 `naming: local` 和 `target`；`confirmTextOf` 换一句「名字和位置照本地 strm 的目录结构来」。快照更新。
- **前端**：整理页「命名来源」下拉 + 说明 + 按任务配置的警告（删除本地多余文件 / 定时）；run 头部芯片 + 同一条警告；单元卡片 `local` 时没海报、徽标「按本地结构」、标题用目录名、藏掉换匹配 / 季集 / 刷新 TMDB / 记住 / 找资源；执行 / 撤销确认文案各加一句；历史和待处理列表带「按本地 strm 结构」。
- **测试**：`local-naming.test.ts` 4 条（内容解析、映射 + 附属 + 暂存区、规划）；`run.itest.ts` 1 条闭环（本地改名 → 预览 → 拒绝 TMDB 改法 → 勾选 → 执行：网盘改名、本地 strm 只改内容、本地字幕不动 → 撤销：网盘和本地都退回 → 同步占位时 409 → 整理中同步 409 → auto 模式 400 → 单元计数里的跳过）；`organize.itest.ts` 1 条（naming 落库、重新预览沿用、非法值 400）；`mcp-p3.itest.ts` 1 条。后端全量 1603 过 1603（计数修补前），修补后整理相关 141 条再过；tsc / eslint / next lint 干净。

真机（115，只读预览，没执行）：实验库是 config 库的拷贝（只留 115 tv 任务，监控 / Telegram / Emby / 智能体 / 定时全关，追更和复制队列清空，临时口令），本地 scratch 的 data/tv 下手写 strm 模拟别的工具整理过：`人生切割术 (2022)/Season 02/人生切割术 - S02E01..03.strm` 指着 `Severance (2022) [tmdbid=95396]/Season 02/`、`杀人机器人 (2025)/Season 01/…S01E01..02.strm` 指着 Murderbot、E04 留在原位置（已经一样）、Murderbot E09 两个 strm 指着、一个别的前缀的。范围选这两个作品目录，`naming: local`：

- 日志「本地 9 个 strm：对上范围里 7 个文件，5 个要改名 / 挪动，1 个已经一样；1 个文件被多个 strm 指着（跳过）；1 个 strm 的内容对不上这个任务」+「注意：任务开着『删除本地多余文件』…」。
- 4 个单元、10 项要动（6 个文件 + 4 个建目录）、1 项已规范、1 项跳过；`Severance - S02E01.nfo` 跟着 E01 改成 `人生切割术 - S02E01.nfo`。
- 页面：命名来源下拉、本地结构的说明和警告、run 芯片、单元卡片、文件清单（原来 → 整理后）、执行确认框「本地 strm 的内容改成新的网盘路径（名字和位置不变，Emby 不受影响）」、历史里的芯片都对；控制台无报错。执行只开了确认框就取消，115 没有写操作。

收尾：实验后端 / 前端停掉，实验库（含 cookie）和本地 strm 删掉，浏览器 token 清掉、标签页关掉。

真机执行 / 撤销（用户说「你用真机验证吧」，2026-10-19 晚）：实验库里只留一个测试任务 `orglab`（115 `/organize-lab` → 本地 `organize-lab`，不删多余文件、不定时），用 115 的 `files/copy` 从 `/tv` 的真文件服务端复制造场景：`inbox/Severance.S02/{Severance - S02E01.mkv, .nfo}`、`inbox/Murderbot.S01/{Murderbot - S01E01.mkv, S01E02.mkv}`（脚本在会话 scratchpad 的 lab115.mts，只认 `/organize-lab`；`fsDirGetId` 回的是原始响应对象、要取 `.id`，`listDirEntries` 回的是原始条目 `n` / `fid` / `cid`）。先跑一次同步生成 3 个 strm + 下载 nfo，再手动把它们挪成 `人生切割术 (2022)/Season 02/人生切割术 - S02E01.{strm,nfo}`、`杀人机器人 (2025)/Season 01/…S01E01..02.strm`：

- 预览（范围 inbox，naming local）：2 个单元、10 项（3 个视频 + nfo 跟随、4 个建目录、2 个删空目录）、0 冲突，10 秒。
- 执行：25 秒，10 项全成；115 上两部进了新目录、nfo 跟到 `人生切割术 - S02E01.nfo`、腾空的 `Severance.S02` / `Murderbot.S01` 删掉、范围根 `inbox` 留着；本地 strm 名字位置不变、内容换成新路径，本地 nfo 没动。
- 撤销：31 秒，退回 10 项；115 树和开始时逐项一致（目录重建、文件退回、新建的目录删掉）；本地 strm 和 nfo 都挪回 `inbox/…` 原名，内容改回原路径，空目录清掉。
- 收尾：`/organize-lab` 整目录进 115 回收站（删之前核对过只有这次造的东西），实验后端停掉，实验库（含 cookie）删掉。

夸克 / OpenList（用户说「夸克和 OpenList 也真机测一下吧」，2026-10-19 晚）：同一份实验库里两个任务——`qk-lab`（夸克 `/organize-lab` → 本地 `qk-lab`）和 `ol-lab`（本机 OpenList 容器的 Local 存储挂 `/lab` → 本地 `ol-lab`，容器按 memory 里的方子起：`-e PUID=0 -e PGID=0`、data / media 目录 777、只绑 127.0.0.1:5244、`admin set` 口令、`storage/create` driver Local）。场景和 115 的一样：`inbox/Severance.S02/{S02E01.mkv, .nfo}` + `inbox/Murderbot.S01/{S01E01, S01E02}.mkv`——夸克用秒传造（从 `/tv` 里挑一个小文件只读下载算 md5 / sha1，`upload/pre` + `update/hash`，四个副本都是同一张 855 KB 图片的字节，原件没动；脚本 labquark.mts 在会话 scratchpad），OpenList 直接在挂载目录里放随机字节的文件。各跑一次同步生成 strm（夸克的「nfo」下了 855 KB），再手动挪成本地结构，`naming: local`、范围 inbox：

| | 预览 | 执行 | 撤销 |
|---|---|---|---|
| 夸克 | 2 单元 10 项，9 秒 | 10 项全成，21 秒 | 退回 10 项，26 秒 |
| OpenList | 2 单元 10 项，1 秒 | 10 项全成，1 秒 | 退回 10 项，1 秒 |

两家执行后网盘树都是 `人生切割术 (2022)/Season 02/{mkv,nfo}` + `杀人机器人 (2025)/Season 01/{E01,E02}`、腾空的源目录删掉、inbox 留着；本地 strm 原地改内容、nfo 不动。撤销后两家网盘树和同步时逐项一致，本地 strm / nfo 挪回原位、内容改回。两家的计划和 115 的 planVersion 一样（夸克 `93b871a548`，和 115 那次相同——同样的路径同样的项），说明计划器不依赖网盘。

收尾：夸克 `/organize-lab` 整目录删进回收站（删前核对只有四个副本），OpenList 容器 `docker rm -f` 连数据目录删掉、Docker Desktop 停掉（它起来时顺带把用户自己的 `emby-local-test` 容器拉起来了，停 Docker 就回到原状），实验后端停掉，实验库（含 cookie）删掉。

没验的：本地 strm 上万时的索引耗时（并发 16 读，没压测）。
