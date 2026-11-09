# 改动网盘后让 OpenList 刷新目录缓存（整理后挂载路径半小时才更新）

## 起因

2026-11-06 用户反馈：整理改了名字，网盘上已经更新，但服务器上 rclone 挂载的路径（`~/webdav`，rclone → OpenList WebDAV → 115）要过很久才刷新；不走 302 时 Emby 回源按 strm 里的挂载路径找文件，找不到就播不了。例子：`~/webdav/115/movie/彗星来的那一夜 (2013) [tmdbid=220289]`。

ssm 上只读排查（lab 拷贝查库、`rclone lsd` 看 OpenList、`ls` 看挂载，没改任何配置），服务器时间 UTC：

| 时间 | 事件 |
|---|---|
| 21:25:36 | `movie/彗星来的那一夜 (2013) [tmdbid=220289]` 落到 115，监控生成 strm |
| 21:25:39 ~ 21:28:51 | 某次经挂载的访问让 OpenList 把 `/115/movie` 的列表存进缓存，里面是 `(2013)` |
| 21:27:16 ~ 21:28:58 | 整理 run（智能体触发，naming=tmdb）：mkdir `(2014)`，三个文件改名挪进去，rmdir `(2013)`；115 事件流随后确认 |
| 21:28:55 | 本地 strm 改成 `(2014)/Coherence.2014.1080p.Remux.MPEG-2.DTS-HD.5.1.strm`，内容指向挂载里的 `(2014)` 路径 |
| 21:48 ~ 21:50 | OpenList 和挂载仍只列出 `(2013)` 和旧文件名；Emby 日志里同一部片 16:31 那一轮就是 ffprobe `(2014)/…mkv` 报 No such file or directory |
| 21:57:26 | OpenList 缓存到期重新问 115，列出 `(2014)` |
| 22:00:58 | rclone 挂载跟上 |

从整理完到挂载正确 32 分钟。三层各自的情况：

- 115：整理完立刻就是 `(2014)`。
- OpenList v4.2.6：115 存储「缓存过期时间」30 分钟。只有经 OpenList 自己做的改动会清缓存；freeStrm 走 115 接口改的它不知道。**主因**。drive-notes 里记过同一条坑（复制功能为此才带 refresh 列目录）。
- rclone 1.68.1：`--dir-cache-time` 默认 5 分钟，WebDAV 没有变更推送（`--poll-interval` 无效）；到期后重新问 OpenList，拿到的还是缓存。挂载没开 `--rc`，外面也没法让它立即忘掉。

用户环境：openstrm 容器里已经配好 OpenList 账号（设置页「复制到 OpenList」）和挂载根 `115 → /115`、`kuake → /kuake`；任务 strmType=local、前缀 `/root/webdav/115`、115 任务开了 302。

## 方案

OpenList 的 `/api/fs/list` 带 `refresh:true` 会绕过缓存直接问上游并把结果写回缓存（client.ts 文件头已记）。所以：**每次 freeStrm 知道网盘目录变了，就对改动过的目录刷一遍**。改动过的目录 = 新增 / 删除 / 改名 / 挪动条目的**父目录**（源和目标两边）。网盘路径 → OpenList 路径用「复制到 OpenList」已有的挂载根换算（`toOpenlistPath`），不加新设置。

### 新模块 `services/openlist/refresh.ts`

- `openlistDirsToRefresh(paths, { removed })`：纯函数。每个路径取父目录，去重，按深度浅的在前（父目录缓存里没有的子目录直接刷会 object not found，见 drive-notes），排除这次已经删掉的目录（整理 rmdir 的源目录）。**只刷父目录、不往上刷到根**：新建的目录由知道这件事的调用方把目录本身报上来（整理的 mkdir 项、转存建出来的 createdDir、监控的目录事件、归档目录链），它的父目录才会刷。评审前的版本是一路刷到根，`/115`、`/115/tv` 这种几千条的目录每批都重列一遍，115 有限流，评审时改掉。
- `scheduleOpenlistRefresh(accountName, drivePaths)`：登记，不阻塞调用方。进程内按账号攒 1.5 秒（监控事件一条条来；封顶 10 秒），到点取 `copyConfigIfReady()`：没配 OpenList 账号、这个网盘账号没填挂载根，或模块没启动，什么都不做。有配置就按浅先顺序逐个 `openlistListDir(acc, dir, { refresh: true })`（串行：OpenList 对 115 存储自己限速）。一批完了记一行 info；失败的汇总成一行 warn（object not found 只记 debug——目录已经不在了，多半是刷到了被删的目录）。
- `startOpenlistRefresh()`：index.ts 启动时调，订阅 `files.landed`（转存 / 追更 / 云下载 / 监控新增 / 复制完成都发这个事件，带任务和相对路径），并打开模块。测试里不 start 就不动，免得配了 OpenList 账号的 itest 往假地址发请求。
- `setOpenlistRefreshDeps` / `flushOpenlistRefresh`：仅供测试，换掉列目录、调短攒的时间、等队列排空。

### 接入点（和现在调 `scheduleEmbyRefresh()` 的地方一一对应）

| 哪里 | 传什么路径 |
|---|---|
| 整理执行收尾 `finishApply` | 这次 done 的 mkdir / rename / move / rmdir / delete 项的 srcPath 和 dstPath；排除 done 的 rmdir 源目录。放在 Emby 刷新之前，Emby 入库预热的 ffprobe 才不会撞空 |
| 整理撤销收尾 `finishRevert` | reverted 的同类项，同样两边都给；排除 reverted 的 mkdir 目录（撤销时删掉了） |
| `files.landed` 订阅 | `absOf(task, rel)`，新文件所在目录 |
| 网盘监控 `apply()`，每条非整理自己造成、能解析出路径的事件 | 事件的 path 和 oldPath（外部改名 / 移动 / 删除也让 OpenList 跟上；不管落不落在任务里、本地动没动，目录事件也报，它的父目录才会刷） |
| 复制后删源 / 归档 `applyAfterCopy` | 源路径；归档还有落点目录链里任务目录以下的每一层（可能是这次新建的）和「落点/名字」 |
| 分享转存 `saveSelectionToTask`（界面 / 收藏夹 / 追更 / 智能体 / Telegram 共用） | 条目的网盘路径 + 为这次转存新建的目录；转存失败收回目录时也刷它的父目录。真机补上的（原先只靠 files.landed） |
| 停机 `shutdown()` | `flushOpenlistRefresh(2000)`：攒着还没发的刷掉，最多等两秒 |

strm 页「删除」只删本地文件，不动网盘，不接。

### 界面与文档

- 设置页「复制到 OpenList」的说明补一句：填了挂载根的账号，整理 / 转存 / 删源之后还会让 OpenList 刷新改过的目录；挂载根那段「不填的账号不复制」改成「不复制，也不刷新缓存」。
- README 302 一节补一段：OpenList 的目录缓存不会因 freeStrm 的改动失效，配上账号和挂载根就会主动刷新；rclone 再等一个 `--dir-cache-time`（默认 5 分钟，可以调小）。

### 行为变化（要用户点头）

配了 OpenList 账号和挂载根的用户，整理 / 转存 / 删源之后会多几次对 OpenList 的 `fs/list refresh` 请求，每个目录一次，OpenList 再去问一次网盘。没配的不受影响。

### 不做

- rclone rc（`vfs/forget` / `vfs/refresh`）：要用户给挂载加 `--rc` 并开给容器网段，先看这一步够不够；够了就不做。
- 不加「刷新缓存」开关：配了挂载根就刷。不想刷只能把挂载根留空（那也就不能复制）。**产品决策**，默认开。
- 不在 drive Provider 的写层挂钩：会把 OpenList 耦进网盘层，而且监控看到的外部改动盖不到。
- 不改 OpenList 的缓存时间、不改 rclone 参数：用户侧配置，README 提一句。

## 测试

- 单元 `services/openlist/refresh.test.ts`：父目录计算、去重、浅先、排除已删目录、根目录下的条目、同一目录内改名只刷一个。
- 集成 `services/openlist/refresh.itest.ts`：没配 OpenList 账号 / 这个账号没挂载根不调；两批合成一次、顺序浅先；object not found 不拦后面的、其他错误记警告也不拦；`files.landed` 事件按任务 originPath 拼出目录；没 start 不动。
- 集成 `organize/run.itest.ts`：执行后登记了旧目录、新目录的父目录（排除删掉的源目录）；撤销后同样。
- 集成 `life/monitor.itest.ts`：监控处理改名 / 删除事件后登记了新旧路径的目录。
- 集成 `copy/remove-source.itest.ts` 或 `after.itest.ts`：删源 / 归档后登记了源目录（和归档目录）。
- 真机（ssm 的 OpenList + 115，lab 库另开端口）：
  1. 转存小文件到 `/lab<日期>`，看 OpenList 多久列出来（files.landed 路）。
  2. 整理预览 → 执行：执行完几秒内 `rclone lsd webdav:/115/lab…` 应列出新目录名；挂载在一个 `--dir-cache-time` 内跟上。
  3. 撤销：同样看两层。
  4. 对照：同一操作不配挂载根时仍是 30 分钟。

## 进度

- [x] 方案（2026-11-09）
- [x] 后端模块 + 五处接入（2026-11-09）
- [x] 设置页文案 + README（2026-11-09）
- [x] 测试（2026-11-09，后端全量 1756 过）
- [x] 真机（2026-11-09，转存 / 执行 / 撤销 / 转存复跑 + 评审修补后执行 / 撤销复跑）
- [x] 评审 medium 9 条全修（2026-11-09）
- [ ] 提交、rc、ssm 升级验证

## 实施记录（2026-11-09）

**新模块** `apps/backend/src/services/openlist/refresh.ts`：

- `openlistDirsToRefresh(paths, { removed })`：父目录，去重，按深度浅先；`removed` 里的目录跳过。第一版是「父目录连同再往上到根」（转存 / 监控只给文件路径，看不出哪一级是新建的），评审指出 `/115`、`/115/tv` 每批重列太贵，改成只刷父目录、新建目录由调用方报（见「评审与修补」第 2 条）。
- `scheduleOpenlistRefresh(account, paths, { removed })`：按账号攒（安静 1.5 秒，封顶 10 秒），到点取 `copyConfigIfReady()`（copy/paths.ts 新加的不抛错版本）换成 OpenList 路径，串行 `fs/list refresh:true`。一批一行 info；失败汇总一行 warn；object not found 只记 debug。上一批没跑完时登记的接着刷。模块没 `start` 就什么都不做（itest 里配了 OpenList 账号的不会往假地址发请求）。
- `startOpenlistRefresh()` 在 index.ts 紧跟 `startAutoOrganize()`，订阅 `files.landed`。

**接入**：`organize/apply.ts` finishApply（done 的 mkdir / rename / move / rmdir / delete 两边路径，排除 done 的 rmdir 源目录；放在 `scheduleEmbyRefresh()` 之前）；`organize/revert.ts` finishRevert（reverted 的同类项，排除 reverted 的 mkdir 目录）；`life/monitor.ts` apply() 里 `res.changed` 时给 `ev.path` / `ev.oldPath`；`copy/service.ts` applyAfterCopy 删源 / 归档成功后给源路径（归档再给 `to` 和 `to/name`，两种形状都盖到）；`files.landed` 订阅盖转存 / 追更 / 云下载 / 监控新增 / 复制完成。strm 页「删除」只删本地，没接。

**界面 / 文档**：`OpenlistCopySection.tsx` 说明补一句、挂载根提示改成「不复制，也不刷新缓存」；`Readme.md` 302 一节补一段（仓库里 README.md 和 Readme.md 是同一个文件的两种大小写，git 只认 Readme.md）。没有新设置、没有迁移。

**测试**（都过）：

- `openlist/refresh.test.ts` 4 条：上级连带 / 浅先、同目录改名只刷一处、排除已删目录、根目录条目 / 空路径 / 末尾空格。
- `openlist/refresh.itest.ts` 6 条：攒批去重 + 排除源目录、没配账号 / 没挂载根不调、not found 与别的错误都不拦、files.landed 按 originPath 拼路径、上一批在跑时登记的接着刷、没 start 不动。
- `organize/run.itest.ts` +1：执行后刷 `/quark`、`/quark/tv`、`/quark/tv/inbox`、作品目录、电影目录、季目录，不刷腾空删掉的 `inbox/BEEF.S01.1080p`，父目录排在子目录前；撤销后只刷 `/quark`、`/quark/tv`、`/quark/tv/inbox`、退回来的 `inbox/BEEF.S01.1080p`。
- `life/monitor.itest.ts` +1：新增 / 改名 / 删除三条事件后刷 `/115`、`/115/tv`、`/115/tv/Show`。
- `copy/remove-source.itest.ts` +1、`copy/archive-source.itest.ts` +1：删源刷源目录链；归档还刷 `归档/某剧/S01` 那条链（挂载根来自设置页）。
- 后端全量 1756 过（4 分 51 秒；真机后补了 receive 直接登记的修复和 share.itest 一条回归，再跑 1757 过、5 分 02 秒），前端单测 20 过；三包 typecheck / lint、check-hygiene 干净。设置页文案的浏览器冒烟（lab 后端 4100 + `next dev` 3223，宽屏 1920 和 390px iframe，深色 / 浅色各一遍）：「复制到 OpenList」一节新加的那句和挂载根提示「不复制，也不刷新缓存」都正常换行、没有溢出。

**真机准备（没动网盘）**：ssm 上用 python 的 sqlite backup 只读备份 `config/openstrm.db` 到本机 lab 目录（scratch，验完删），隔离：生产任务 / 追更 / 令牌 / OAuth / 审计全删，Emby / Telegram / 监控 / HDHive / 检查更新 / PanSou 置空，口令换成临时随机的，OpenList 账号地址改成 `http://127.0.0.1:5244`（ssh 隧道到 ssm 的 5244）。隧道通，用 lab 账号对 `/115/movie` 带 refresh 列目录 1.1 秒返回 27 项。

## 评审与修补（2026-11-09）

`/code-review medium`，9 条，全修：

1. 挂载根填错时 OpenList 回 `failed get storage: storage not found`，被 `isNotFound` 当成「目录不存在」吞成 debug，整批没有任何告警 → client.ts 新增 `isOpenlistStorageMissing`，这种算失败记 warn 并点名挂载根；一批里一个都刷不到、又都说不存在的也 warn → `refresh.itest`「object not found、storage not found 和别的错误都不拦后面的目录」。
2. 每批把父目录一路刷到根，`/115`、`/115/tv` 这种几千条的目录每批重列，115 限流 → 只刷条目的父目录；新建目录由调用方报目录本身：整理的 mkdir 项本来就在、转存报 `createdDir`、监控对目录事件也登记、归档报落点目录链（`archiveChainEntries`）→ `refresh.test` 四条、`run.itest` / `monitor.itest` / `remove-source.itest` / `archive-source.itest` / `share.itest` 的期望全部改成父目录。
3. `shutdown()` 只 flush 了 Emby 刷新，timer 都 unref 了，SIGTERM 落在攒批窗口里刷新整个丢掉 → `flushOpenlistRefresh(maxMs)` 带封顶，停机时最多等两秒。
4. `refreshAccountDirs` 每个目录都现读 `deps`，测试收尾 `stop + setDeps(null)` 时正在跑的批次剩下的目录会落到真 OpenList（假地址）→ `drain` 开跑时把 `listDir / config` 抓下来整批用 → `refresh.itest`「批次跑到一半换回真依赖」。
5. 复制那处注释说归档的 `to` 可能是条目本身，其实 `archiveSourceReal` 两个分支回的都是目录 → 注释改掉，路径改成源 + 归档目录链 + 「落点/名字」。
6. `isNotFound` 重写了 providers/openlist.ts 的 `isMissing`（少了 `不存在` / `no such`）→ 抽成 client.ts 的 `isOpenlistMissing`，两处共用。
7. `absPathOf` 用 drive/types 的 `normalizePath`，会削掉段首尾空格，和 copy/paths.ts「只管斜杠」的规矩冲突 → 改用 `normDir` + `joinPath`。
8. 监控只在 `res.changed` 时刷：落在任务外的改动、目录事件（新建目录的处理器 changed=false）都不刷 → 每条非整理自己造成、能解析出路径的事件都登记（problem 事件除外）→ `monitor.itest` 加了目录事件、任务外文件、problem 事件三种。
9. 转存失败 `dropCreatedDir` 收回新建目录后不刷，OpenList 这期间列到过的话会留一个 404 的目录 → 失败分支也刷它的父目录；成功时 `createdDir` 一并报上 → `share.itest`「为转存新建的目录（createdDir）…」。

修补后：三包 typecheck / lint 干净；`refresh.test` 4、`refresh.itest` 7、`share.itest` 15、`remove-source` 11、`archive-source` 8、`run.itest` 90、`monitor.itest` 20 全过；后端全量 1759 过（4 分 57 秒）。涉及的真机场景（整理执行 / 撤销）复跑见「真机验证」末尾。

## 真机验证（2026-11-09）

**环境**：ssm 上用 python 的 sqlite backup 只读备份 `config/openstrm.db`，scp 到本机 scratchpad 的 lab 目录；隔离脚本把口令换成临时随机的，生产任务 / 追更 / 令牌 / OAuth / 审计 / 任务历史全删，Emby / Telegram / 网盘监控 / HDHive / 检查更新 / PanSou 置空，OpenList 账号地址改成 `http://127.0.0.1:5244`（ssh 隧道到 ssm 的 5244，OpenList v4.2.6 挂着 115 Cloud，缓存 30 分钟）。lab 后端 `pnpm --filter @openstrm/backend dev`，`127.0.0.1:4100`。lab 任务 `lab1109`（115，originPath / targetPath 都是 `lab1109`，strmPrefix `/root/webdav/115`，302 开，不复制）。测试分享 `115cdn.com/s/swsgklr3z1r`（提取码 wbc1，末日地堡 2023）只转存 S03E01 / S03E02。两层的观察都在 ssm 上：OpenList 那层用 `rclone lsd/lsl webdav:/115/…`（另起的 rclone 进程，经 WebDAV 直接问 OpenList 的缓存），挂载那层 `ls /root/webdav/115/…`。时间都是 UTC。

写操作（转存、执行、撤销）被自动模式的权限分类器拦下，由用户在本会话里用 `!` 前缀亲自跑同一份脚本（scratchpad 里的 `receive.py` / `organize.py`）。

| 场景 | 结果 |
|---|---|
| 建 `/lab1109`（Provider `write.mkdir`，根下） | 15:53:39 建成；lab 后端进程内 5 分钟的 115 目录清单缓存还没有它，转存报「无法在网盘上找到保存目录」，重启 lab 后端后才认 |
| 转存两集（`organize: false`） | 16:03:52 → 16:03:54 成功，`generatedCount 2`，lab `data/lab1109/` 下两个 strm。**OpenList 没被刷新**：16:04:04 `rclone lsd webdav:/115/` 仍没有 `lab1109`，lab 后端日志里没有 openlist-refresh 的记录——`files.landed` 只在交给整理时才发（见下面「真机发现的问题」）。16:05:19 手动调 OpenList `fs/list /115 refresh:true` 补上，之后列 `/115/lab1109` 把两个旧名字缓存进去 |
| 整理预览（`POST /api/organize/runs {taskId}`） | 16:05:23 建 run，16:08:50 ready（115 导出目录树等了两分半，探测编码两集各读了一次）：1 个单元 → tv 125988 末日地堡 (2023) [high]「标题和年份都对上」；4 项：mkdir `末日地堡 (2023) [tmdbid=125988]`、mkdir `…/Season 03`、两集 move 成 `Silo.S03E01.你是谁？.1080p.H.264.DDP.5.1.Atmos.mkv` / `Silo.S03E02.一切安好.…mkv`，0 冲突 |
| 执行前把两层的旧名字缓存好 | 16:10:04 `rclone lsl webdav:/115/lab1109/` 和 `ls /root/webdav/115/lab1109` 都列出两个旧文件名 |
| 执行 | 16:13:53 → 16:14:13 done，4 项完成 0 失败；lab 日志 16:14:17 `已让 OpenList 刷新 4 个目录的缓存（账号 115）`（`/115`、`/115/lab1109`、作品目录、季目录）。**16:14:22 OpenList 经 WebDAV 已列出新结构**（`末日地堡 (2023) [tmdbid=125988]/Season 03/Silo.S03E01…`），而它那份缓存本来要到 16:35:19 才过期。挂载 16:14:22 还是旧名字，**16:15:07 翻成新目录**：离执行完成 54 秒，正好是它 16:10:04 那次列目录的 5 分钟 `--dir-cache-time` 到期。对照 11-06 的 32 分钟 |
| 撤销 | 16:20:11 → 16:20:34 reverted，退回 4 项；lab 日志 16:20:37 `已让 OpenList 刷新 2 个目录的缓存`（`/115`、`/115/lab1109`，撤销时删掉的作品目录 / 季目录没刷）。16:20:45 OpenList 和挂载都已是两个原名（挂载 16:15:07 那次列目录的 5 分钟刚好在 16:20:07 到期，第一次 `ls` 就拿到了刷新后的 OpenList 结果）；lab `data/lab1109/` 下两个 strm 回到原名 |
| 转存复跑（修了 receive 直接登记之后，S03E03，`organize: false`） | 16:25:24 → 16:25:26 成功，`generatedCount 1`；lab 日志 16:25:29 `已让 OpenList 刷新 2 个目录的缓存`（`/115`、`/115/lab1109`）。**16:25:34 OpenList 经 WebDAV 已列出三集**，它那份缓存本来要到 16:50:37 才过期；挂载 16:26:03 列出第三集（16:20:46 那次列目录的 5 分钟到期） |

评审修补之后复跑（lab 后端经 tsx watch 重载，带全部 9 条修补；`/lab1109` 顶层三集）：

| 场景 | 结果 |
|---|---|
| 预览 | 16:48:44 → 16:49:18 ready：1 个单元 → 末日地堡 (2023) [high]，5 项（2 mkdir + 3 move），0 冲突；16:49:18 两层都缓存着三个旧名字 |
| 执行 | 16:53:58 → 16:54:08 done，5 项；日志 16:54:12 `已让 OpenList 刷新 3 个目录的缓存`（`/115/lab1109`、作品目录、季目录——不再刷根）。16:54:17 OpenList 已列出新结构（它那份缓存 16:25:29 设的，要到 16:55:29 才过期）；挂载 16:54:28 翻成新目录（16:49:18 那次列目录的 5 分钟到期） |
| 撤销 | 17:17:43 → 17:17:59 reverted，5 项；日志 17:18:02 `已让 OpenList 刷新 1 个目录的缓存`（只有 `/115/lab1109`：撤销删掉的两层目录不刷，根不刷）。17:18:07 OpenList 和挂载都已是三个原名（OpenList 那份 16:54:12 设的缓存要到 17:24:12 才过期）；lab 下三个 strm 回到原名 |

**真机发现的问题（已修）**：

1. 转存时选了「不整理」，OpenList 不刷新。现象：16:03 转存成功后 OpenList 半小时内都列不出 `lab1109`，lab 日志里没有 openlist-refresh 记录。原因：刷新只订阅了 `files.landed`，而 `share/receive.ts` 只在交给整理时才发这个事件（`opts.organize !== false`），后台模式（async）也不发。修法：`saveSelectionToTask` 在网盘 `receive` 成功后直接 `scheduleOpenlistRefresh(account, 条目的网盘绝对路径)`，不管整不整理、同步还是后台；界面 / 收藏夹存到任务 / 追更 / 智能体 / Telegram 五条转存链路都经它。回归用例：`routes/share/share.itest.ts`「receive 时选了不整理（organize: false）：照样让 OpenList 刷新…」。复跑：上表「转存复跑」。
2. 不算 bug、记一笔：lab 后端进程内 115 目录清单缓存 5 分钟，Provider 直接在根下 mkdir 之后，转存按路径找不到新目录（「无法在网盘上找到保存目录」）。生产里目录都是界面建的、同一进程知道，碰不到；lab 重启后端即可。

日志：lab 后端日志里除两次 `listen EADDRINUSE`（我误杀了监听进程、`pnpm dev` 的看护又拉了一个，两份看护重载时抢端口）之外没有告警和报错；openlist-refresh 的四条都是 info。

收尾：lab 后端（两个 `pnpm dev` 看护 37810 / 57049 和它们的 tsx watch、监听进程）按 PID 停掉，4100 已空；ssh 隧道（5244）关掉；scratchpad 里的 lab 目录（含 115 cookie 的库拷贝 672 MB、临时口令、令牌、脚本、测试临时目录）整个删掉。115 上留下 `/lab1109/`（S03E01–E03 三集，约 12 GB，撤销后在顶层、原名），删不删由用户定；lab 任务只存在于已删除的 lab 库里。
