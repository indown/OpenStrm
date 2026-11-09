# CloudDrive2 接入：目录缓存刷新 + 复制引擎（OpenList 那两条的 CD2 版）

## 起因

2026-11-09 用户：「接下来看 cd2 这条路吧，有的用户用的是 cd2，没有用 openlist+rclone」，随后又说「复制任务也要一起支持一下 cd2 吧，你一起看看怎么制定计划」。分两个阶段：**阶段 1 目录缓存刷新**（下面「方案」），**阶段 2 复制引擎**（文末「阶段 2」，等用户定两件事再开工）。OpenList 那条（.claude/plans/openlist-cache-refresh.md，v2.26.0-rc.1）解决的是经 OpenList 挂载回源的用户；用 CloudDrive2（CD2）挂载网盘给 Emby 回源的用户碰到的是同一件事：整理 / 转存在网盘上改了名，CD2 的目录缓存不知道，挂载里半小时内还是旧名字。README 一直把 CD2 和 rclone 并列成两种挂载路径（emby-playback-latency.md 也记过 ffprobe 经 rclone / CD2 读文件头）。

CD2 的接口：没有 REST，只有 gRPC（默认 19798，明文 HTTP/2，和它的网页同端口）。官方 proto 在 `https://www.clouddrive2.com/api/clouddrive.proto`（2026-11-09 拉到的是 1.1.2）：

- `GetSystemInfo(Empty) → CloudDriveSystemInfo`：不要鉴权，拿来验地址通不通。
- `GetToken(GetTokenRequest{userName, password, totpCode?}) → JWTToken{success, errorMessage, token, expiration}`：用户名口令换 JWT。
- CD2 设置页还能生成「API 令牌」（`CreateToken` / `TokenInfo{token, rootDir, permissions, expires_in}`），和 JWT 一样放在 metadata `authorization: Bearer <token>` 里用（社区的 Python 客户端就是这么做的：`insecure_channel` + `("authorization", f"Bearer {token}")`）。
- `GetSubFiles(ListSubFileRequest{path, forceRefresh, checkExpires?}) → stream SubFilesReply`：`forceRefresh=true` 绕过缓存重新问网盘并写回缓存，社区的「CD2 目录自动刷新」工具用的就是它。

ssm 上现在没装 CD2（用户 2026-11-09 说的），所以这条线的真机要另起一个 CD2 实例。

## 方案（阶段 1：目录缓存刷新）

### 调度器通用化

OpenList 那条的 `services/openlist/refresh.ts` 里，「哪些目录变了、攒批、浅先、去重、排除已删目录」和 OpenList 本身无关，只有「按挂载根换路径 + 调 fs/list refresh」是 OpenList 的。拆成：

- `services/mount-cache/refresh.ts`：调度器。`scheduleMountRefresh(account, paths, { removed })`、`startMountRefresh()`（订阅 files.landed）、`flushMountRefresh(maxMs?)`、`setMountRefreshDeps` / `stopMountRefresh`（测试）。一批到点时对每个**配好的目标**各算一遍：目标给出这个网盘账号的挂载根，没有就跳过这个目标。
- `services/mount-cache/openlist.ts`：OpenList 目标（`copyConfigIfReady` + `openlistListDir(refresh:true)`，错误分类和日志照旧）。
- `services/mount-cache/cd2.ts`：CD2 目标（下面）。
- 六处接入点和 index.ts 改成调 `scheduleMountRefresh` / `startMountRefresh` / `flushMountRefresh`；`refresh.test.ts` / `refresh.itest.ts` 跟着搬到 `mount-cache/`。

### CD2 客户端 `services/cd2/client.ts`

不引 `@grpc/grpc-js` + proto-loader（要 vendor 134 KB 的 proto、多十几 MB 依赖）：只用到三个 RPC、报文都是字符串和布尔，自己写：

- `lib/protobuf.ts`：varint、length-delimited 的编码，和一个把一条扁平报文解成 `{字段号 → 值}` 的解码（JWTToken 只看 1/2/3 三个字段，`expiration` 这种子报文原样跳过）。
- `lib/grpc.ts`：`node:http2` 明文连接，unary 和 server-streaming 两个助手：请求 `POST /clouddrive.CloudDriveFileSrv/<方法>`，`content-type: application/grpc`、`te: trailers`、可选 `authorization`，报文前 5 字节帧头（压缩位 0 + 大端长度）；响应按帧拆，trailer 里 `grpc-status` 非 0 抛 `GrpcError(code, message)`；连不上 / 超时是 transport 类错误。超时 `DEFAULT_TIMEOUT_MS`。
- `client.ts`：`cd2SystemInfo(cfg)`、`cd2Token(cfg)`（API 令牌直接用；用户名口令换 JWT，按 `expiration` 提前 1 小时在内存里缓存、`UNAUTHENTICATED`（16）时清掉重登一次）、`cd2RefreshDir(cfg, path)`（GetSubFiles forceRefresh，把流读完只看状态）、`cd2ListDir(cfg, path)`（不刷新，检查用，只数条目）。`Cd2Error { code, transport }`，`isCd2Missing`（NOT_FOUND 5 或文案里 not found / 不存在）。

### 设置

`settings.cd2`（新，`packages/shared` 的 `Cd2Settings`）：`url`（如 `http://192.168.1.10:19798`）、`apiToken`、`username`、`password`、`mounts`（网盘账号名 → 在 CD2 里的路径，如 `{ "115": "/115" }`，CD2 里云盘名是用户起的）。`apiToken` 和 `password` 进 `lib/secrets.ts` 的 `SETTING_SECRETS`（读回掩码、原样提交不改）。后端 zod：url 要 http(s)://；令牌和用户名口令至少一组，缺了保存时不拦（目标就当没配）。

`cd2ConfigIfReady()`：url 有、（apiToken 或 username+password）有、mounts 非空才算配好。

### 检查接口

`POST /api/cd2/check`，body 是设置页当前填的值（掩码按库里的原值还原）：先 `GetSystemInfo`，再拿令牌，再对每个挂载根 `GetSubFiles(path, forceRefresh=false)` 数条目。回 `{ system: { ok, message, version?, loggedIn }, auth: { ok, message }, mounts: [{ account, path, ok, entries?, message }] }`，不回任何令牌。

### 界面

设置页「复制到 OpenList」后面加一节「CloudDrive2 目录刷新」（锚点 `cd2`）：说明一段；地址 / API 令牌 / 用户名 / 口令四个输入（令牌和用户名口令二选一，提示写清）；各网盘账号在 CD2 里的路径（复用 OpenList 那节的布局，没有「选目录」按钮——CD2 没有现成的浏览接口可复用，填文字）；「检查连接和路径」按钮调 `/api/cd2/check`，结果 toast。表单里和 openlistCopy 一样整块一个值。

### 文档

README 302 一节那段「回源经 OpenList 挂载」后面补 CD2：填上 CD2 地址和令牌，改动后同样让它刷新；CD2 自己的挂载是它直接提供的，刷完就对，不像 rclone 还要等一个 `--dir-cache-time`。

### 行为变化（要用户点头）

新设置一节，默认空 = 不做任何事。配了之后整理 / 转存 / 监控到的改动 / 删源 / 归档之后会多几次对 CD2 的 `GetSubFiles(forceRefresh)`，CD2 再问一次网盘。没有迁移。

### 不做

- 不做 CD2 账号类型（账户页 + Provider）：这里只需要「刷一下目录」，没有同步 / 转存 / 整理要经 CD2。
- 不按 CD2 的 `GetMountPoints` 自动推挂载映射：映射的是「网盘账号 → CD2 里的云盘路径」，CD2 的挂载点是「CD2 里的路径 → 本机路径」，不是一回事；检查按钮能验填得对不对就够了。
- 不接 `@grpc/grpc-js`：见上。
- TOTP（2FA）账号：`GetToken` 支持 `totpCode` 但我们不收一次性码；开了 2FA 的用 API 令牌。文案里说。

## 测试（阶段 1）

- 单元 `lib/protobuf.test.ts`：varint 边界（0、127、128、2^32 以上）、字符串 / 布尔编码、扁平报文解码、未知字段和子报文跳过。
- 集成 `services/cd2/client.itest.ts`：`node:http2` 起一个假 gRPC 服务（认 GetSystemInfo / GetToken / GetSubFiles，记下每次的 path / forceRefresh / authorization，能按配置回 UNAUTHENTICATED、NOT_FOUND、流里发两帧再 trailer）：令牌换取和缓存、过期前重登、UNAUTHENTICATED 清缓存重试一次、API 令牌直接带、forceRefresh=true 真发出去、NOT_FOUND 归 missing、连不上归 transport。
- 集成 `services/mount-cache/refresh.itest.ts`：原 OpenList 那份改名搬过来，加：两个目标都配了各走各的挂载根；只配 CD2 时 OpenList 不动；一个目标炸了另一个照常。
- 集成 `routes/cd2/check.itest.ts`：对着假 gRPC 服务，三段结果各一种失败。
- 原来接入点的 itest（run / monitor / remove-source / archive-source / share）只改 import 和桩的名字。
- 真机（**要用户提供 CD2 实例**，ssm 上没装）：Docker `cloudnas/clouddrive2` 起在 ssm 或本机，CD2 网页里登录 115（扫码），云盘名记下来填进挂载映射；lab 库另开端口、`cd2.url` 指过去。场景：转存 → 整理预览 / 执行 / 撤销，每步用 `GetSubFiles(path, forceRefresh=false)` 看 CD2 的缓存几秒内变不变，CD2 有本机挂载的话 `ls` 一下挂载目录。对照：不配 CD2 时 CD2 的缓存多久才变（看它的设置里目录缓存时间）。

## 阶段 2：复制引擎（2026-11-09 用户定了「引擎全局一个」，开工）

### CD2 这边有什么

proto 里和复制有关的：`CopyFile(CopyFileRequest{theFilePaths[], destPath, conflictPolicy Overwrite/Rename/Skip}) → FileOperationResult{success, errorMessage, resultFilePaths}`；进度在 `GetCopyTasks → CopyTask{taskMode, sourcePath, destPath, status Pending/Scanning/Scanned/Completed/Failed, totalFiles, uploadedFiles, failedFiles, skippedFiles, errors[]{time, message}, startTime, endTime}`（一条任务对应一个源条目，按 sourcePath + destPath 认）；取消 `CancelCopyTask(sourcePath, destPath)`；建目录 `CreateFolder(parentPath, folderName) → CreateFolderResult{folderCreated, result}`（不递归）；列目录 `GetSubFiles` 解 `CloudDriveFile{name=2, size=4, isDirectory=30}`。

**目标可以是本地硬盘**：CD2 能把本机目录当一个存储加进来（`APIAddLocalFolder(AddLocalFolderRequest{localFolderPath})`，网页里叫「本地文件夹」），加进来之后它就是 CD2 里的一个根目录（比如 `/hdd`），`CopyFile` 从 `/115/...` 复制到 `/hdd/...` 就落在硬盘上。其余存储类型还有各家网盘和 WebDAV / S3 / SFTP / FTP / SMB / 另一台 CloudDrive。（第一版方案写成「没有本地磁盘」，是 grep 漏了 `APIAddLocalFolder`，用户指出后改正。）

### 做法

**引擎接口**（`services/copy/engines.ts`）：现在 `services/copy/service.ts` 的 `deps.openlist` 就是这个形状，抽成 `CopyEngine { listNames(cfg, dir); listEntries?(cfg, dir); mkdir(cfg, dir); copy(cfg, srcDir, dstDir, names) → CopyTaskInfo[]; copyTasks(cfg) → { undone, done } }`。`deps.openlist` 留着（现有 itest 都往它上面打桩），再加 `deps.cd2`，`engineOf(cfg)` 按 `cfg.engine` 选。`CopyTaskInfo` 就是原来的 `OpenlistTaskInfo`（名字不改，少动文件）。

**CD2 引擎**（`services/cd2/copy-engine.ts`，客户端加四个接口）：

- `listNames / listEntries` = `GetSubFiles(forceRefresh=true)` 解 name / isDirectory / size。
- `mkdir` = 从挂载根往下逐级 `CreateFolder`（CD2 的不递归；「已存在」的结果吞掉）。
- `copy(srcDir, dstDir, names)` = 一次 `CopyFile(theFilePaths = names 各自拼上 srcDir, destPath = dstDir, conflictPolicy = Skip)`；`success=false` 抛错。返回和 names 一一对应的任务：id `源路径→目标目录`、name `copy 源路径 to 目标目录`（队列按名字认任务时用的是源路径最后两段，这个 name 带着）、state pending。
- `copyTasks()` = `GetCopyTasks`：Completed → done（state `succeeded`）、Failed → done（state `failed`，error 是 errors 的 message 拼起来，没有就「N 个文件失败」）、其余 → undone；progress = uploadedFiles / totalFiles；endedAt = endTime。
- 队列里「任务列表里找不到这次复制」那一支改成先核对目标：目标里已经有这一份（`verifyCopied`）就算完成，再找不到才记 miss。CD2 完成得快的任务会不会从 `GetCopyTasks` 里消失没法确定（真机再看），OpenList 被手动清掉任务时也顺带受益。
- `isMissingDir` 同时认 `Cd2Error` 的 NOT_FOUND。

**配置**（`copy/paths.ts`）：`openlistCopy.engine?: "openlist" | "cd2"`（默认 openlist，老用户不变）。`CopyConfig { engine; account: AccountOpenlist | null; cd2: Cd2Connection | null; dstDir; mounts }`：选 OpenList 时和现在一样；选 CD2 时 `cd2` 来自设置页 CloudDrive2 一节（`cd2ConnectionOf`），`mounts` 也来自那一节（`cd2MountsOf`，网盘在 CD2 里的路径只填一处），不再要求 OpenList 账号。`copySettingsGap` / `copyBlockerFor` 按引擎说缺什么（「还没填 CloudDrive2 的地址」「还没填 CD2 的 API 令牌或用户名口令」「账号 X 还没填在 CD2 里的路径」）。`afterCopiedInner` 里「目标目录落在哪个用这个 OpenList 账号的任务下」只在 OpenList 引擎下算。队列说明里的「OpenList」按引擎换成「CloudDrive2」。

**检查与浏览**：`POST /api/cd2/list { path }` 回 DirectoryNode[]（只给目录），给设置页和任务弹框「从 CD2 里选」目标目录用。

**界面**：

- 设置页那一节改叫「复制到 OpenList / CloudDrive2」，多一个「用哪个复制」下拉：OpenList（默认）/ CloudDrive2。选 CD2 时：OpenList 账号那一栏不显示；挂载根那一块换成一句「网盘在 CD2 里的路径在上面的 CloudDrive2 一节填」；默认目标目录的「选目录」走 `/api/cd2/list`；「检查这些目录」走 `/api/cd2/check`（映射）+ `/api/cd2/list`（目标目录）。页面把 `cd2` 那块的值也传给它（`form.watch`）。
- 任务弹框：标签改「复制到 OpenList / CD2」，说明按设置页选的引擎说；「复制到哪」的「选目录」按引擎走 OpenList 账号或 CD2；`copyGapInDialog` 加引擎和 cd2 设置两个参数，和后端 `copySettingsGap` 同一套条件。
- strm 页、复制队列面板、云下载弹框里写死的「复制到 OpenList」改成「复制到 OpenList / CD2」；内部字段 `copyToOpenlist`、接口路径、智能体工具名都不改（兼容老配置和老客户端），智能体说明里补一句「引擎按设置页选的」。

**文档**：README 复制那段补引擎选项和 CD2 的填法（先在 CD2 里把硬盘目录加成「本地文件夹」）。

### 行为变化（要用户点头）

默认引擎仍是 OpenList，老配置不变。选了 CD2 的：复制提交到 CD2、进度看 CD2 的任务列表、目标目录是 CD2 里的路径；网盘在 CD2 里的路径只在 CloudDrive2 一节填一次（刷新和复制共用）。队列遇到「任务列表里找不到」先核对目标，目标里有了就算完成（两种引擎都是）。

### 不做

- 不做每任务可选引擎（用户定的）。
- 不做 CD2 的「下载到本机」（`DownloadFile` 那一套）：复制到「本地文件夹」存储已经能落硬盘。
- 不改 `copyToOpenlist` / `copy_*` 这些内部名字和工具名。

### 测试（阶段 2）

- `copy/paths.test.ts`：CD2 引擎下 `copySettingsGap` 四种缺法、`resolveCopyConfig` 两种引擎各给什么。
- `cd2/client.itest.ts`：新加的列条目（name / isDir / size）、逐级建目录（已存在吞掉）、CopyFile 的请求形状和 success=false、GetCopyTasks 解码。
- `copy/cd2-engine.itest.ts`：对着假 gRPC 服务跑真引擎：登记 → 提交（CopyFile 收到的路径和目标）→ 盯任务（Pending → Completed）→ done；Failed 带 errors；任务消失但目标里有了 → 完成；目录不存在 → 等待计数；两个条目一批提交。
- `routes/cd2/list.itest.ts`：列目录只给目录；不存在 404。
- 前端：`lib/openlist-copy.test.ts`（若有）加 CD2 分支；设置页和任务弹框浏览器冒烟（引擎切换、文案、选目录）。
- 真机：CD2 实例挂 115 + 一个「本地文件夹」（ssm 的 `/mnt/hdd` 下的 lab 目录）；转存一集 → 看队列提交到 CD2、进度、完成、目标目录里有文件、删源 / 归档照旧。

## 进度

- [x] 方案（2026-11-09）
- [x] 阶段 1：调度器通用化 + 接入点改名（2026-11-09）
- [x] 阶段 1：protobuf / grpc / cd2 客户端（2026-11-09）
- [x] 阶段 1：设置 + 密钥掩码 + 检查接口（2026-11-09）
- [x] 阶段 1：设置页一节 + README（2026-11-09）
- [x] 阶段 1：测试（2026-11-09：mount-cache/refresh.test + refresh.itest、lib/protobuf.test、cd2/client.itest、routes/cd2/check.itest + list.itest）
- [x] 阶段 1：真机（2026-11-09，ssm 上的 lab CD2 + 115 开放平台，见末节）
- [x] 阶段 2：方案（2026-11-09，引擎全局一个）
- [x] 阶段 2：后端引擎接口 + CD2 引擎 + 配置（2026-11-09）
- [x] 阶段 2：界面 + README（2026-11-09）
- [x] 阶段 2：测试（2026-11-09，全量见实施记录）
- [x] 阶段 2：真机（2026-11-09，两次复制：兜底按目标核对那条路和正常盯任务那条路都走过，见末节）

## 评审与修补（2026-11-09，阶段 1 + 阶段 2 一起评）

用户定了以后评审默认中等强度。`/code-review medium`，9 条，全修：

1. 队列按 id 命中 done 列表时跳过了「提交之后才结束」的时间过滤，CD2 的 id 是「源→目标」，上一轮同一条的旧任务会被当成这次的结果（旧的 Failed 让这次直接失败，旧的 Completed 让这次提前算完成甚至去删源）→ `CopyEngine.taskIdsReused`（CD2 为 true），这种引擎按 id 命中也要过时间；OpenList 的 id 全局唯一照旧信 id → `cd2-engine.itest`「上一轮同一条留在列表里的旧任务不算这次的结果」。
2. `isAlreadyExists = /exist|已存在|已经有/` 把 "does not exist" 也吞了，父目录 / 存储不在时 `cd2EnsureDir` 当「已存在」跳过 → 先排除 not exist / 不存在 → `client.itest` 建目录到不存在的存储根要报 does not exist。
3. 老版本 CD2 只有 fileType 时回退写反了（`?? 1n`）：proto3 不发 0，目录会被认成文件 → `?? 0n` → `client.itest`「老版本 CD2 只有 fileType：目录仍认成目录」；假服务同时改成像真 CD2 一样两个字段都发。
4. gRPC 流只收到 close（RST_STREAM NO_ERROR / GOAWAY）时没人结束 Promise，要等到 30 秒超时 → `req.on("close")` / `session.on("close")` 没结束的按连接层错误马上报 → `client.itest`「服务端只回首部就把流关掉」要在 5 秒内报错。
5. 带 forceRefresh 的 GetSubFiles 用 30 秒超时，几千条的目录在 115 限流下不够 → 列目录的调用改成 5 分钟。
6. 浏览目录（设置页、任务弹框选目标）走的 `cd2ListEntries` 写死 forceRefresh=true，每点一层都让 CD2 重新问网盘 → `cd2ListEntries(conn, path, { refresh })` 默认 false，引擎传 true，`/api/cd2/list` 和检查接口走缓存 → `client.itest` 断言默认不刷。
7. Telegram 选复制目标目录从直接调 `openlistListDir`（走缓存）换成了引擎的 `listEntries`（refresh:true），悄悄变成每一步都刷新 → `CopyEngine.listEntries(cfg, dir, { refresh })`，Telegram 传 false。
8. 两个挂载层目标在 `mounts()` 和 `refresh()` 里各读一次设置，一批几十个目录就打几十次库，中途改设置两边还会不一致 → `MountCacheTarget.prepare()` 一批开跑读一次，给出 mounts 和拿着同一份配置的 refresh；`fake-mount-target` 跟着改。
9. `copyConfigIfReady` 没人用了，注释还说给 mount-cache/openlist.ts 用 → 删掉。

修完：三包 typecheck / lint、hygiene 干净；`client.itest` 9、`cd2-engine.itest` 6、`mount-cache` 13、`routes/cd2` 7 全过；后端全量 1788 过（4 分 56 秒），前端单测 20 过。涉及的真机场景（CD2 刷新、CD2 复制）等 CD2 实例一起跑。

## 实施记录（2026-11-09，阶段 1）

**调度器通用化**：`services/openlist/refresh.ts` 拆成 `services/mount-cache/refresh.ts`（调度：`scheduleMountRefresh` / `startMountRefresh` / `flushMountRefresh(maxMs?)` / `setMountRefreshDeps` / `stopMountRefresh`，`MountCacheTarget { name, mounts(), refresh(dir), isMissing, isMisconfigured? }`，一批到点对每个目标各算一遍、开跑时抓住 `deps.targets()`）、`mount-cache/openlist.ts`（OpenList 目标：挂载根 = `copyConfigIfReady().mounts`，刷新 = `openlistListDir(refresh:true)`，missing / storage not found 的判断来自 openlist/client.ts）、`mount-cache/cd2.ts`（CD2 目标：`cd2ConfigIfReady`，刷新 = `cd2RefreshDir`）。六处接入点（整理 apply / revert、监控、复制后删源归档、转存、index.ts 启动与停机）改名；`refresh.test.ts` / `refresh.itest.ts` 搬到 mount-cache，`test/fake-mount-target.ts` 给所有 itest 当桩（run / monitor / remove-source / archive-source / share 五份原来直接换 listDir 的改成换目标）。

**CD2 客户端**：`lib/protobuf.ts`（varint、字符串 / 布尔 / 整数 / 嵌套的编码，扁平解码；proto3 默认值不发）、`lib/grpc.ts`（node:http2 明文或 TLS，`grpcCall(baseUrl, service, method, body, { authorization, timeoutMs, signal })` 收回所有帧，trailer 或首部里的 grpc-status 非 0 抛 `GrpcError(code)`，连不上 / 超时 / 非 200 是 transport）、`services/cd2/client.ts`（`cd2SystemInfo` 不鉴权；`cd2Token`：API 令牌直接用，用户名口令换 JWT 按 expiration 提前一小时缓存、键带口令哈希（换口令不能命中旧令牌）；`UNAUTHENTICATED` 且用的是 JWT 时清缓存重登一次；`cd2RefreshDir` / `cd2ListDir` = GetSubFiles forceRefresh true / false，把流读完数条目；`isCd2Missing` = NOT_FOUND 或文案）、`services/cd2/config.ts`（`cd2ConnectionOf` / `cd2MountsOf` / `cd2ConfigIfReady`）。没引新依赖。

**设置与接口**：shared `Cd2Settings { url, apiToken, username, password, mounts }` + `Cd2CheckResult`；zod `cd2` 节（url 要像个地址）；`lib/secrets.ts` 把 `cd2.apiToken`、`cd2.password` 加进掩码表；`POST /api/cd2/check`（routes/cd2/check.ts）：按页面当前值连一次，掩码换回库里的原值，三段：GetSystemInfo → 凭据（API 令牌不经 GetToken，拿到手不算验过，带着列一次根目录才算）→ 每个映射 GetSubFiles 数条目；不回令牌。

**界面**：`settings/components/Cd2Section.tsx`（地址 / API 令牌 / 用户名 / 口令四个输入，各网盘账号在 CD2 里的路径，「检查连接和路径」按钮把三段结果拼成一条 toast，地址填了但没配齐时一行黄字提示缺什么）；设置页导航加「CloudDrive2」、表单 schema / 默认值 / 提交带上 `cd2`；`api.cd2.check`；README 302 一节补 CD2 一句。

**测试**：`lib/protobuf.test.ts` 4；`services/cd2/client.itest.ts` 6（对着 `test/fake-cd2.ts`：node:http2 的假 gRPC 服务，认 GetSystemInfo / GetToken / GetSubFiles，记调用、能按配置造 UNAUTHENTICATED / NOT_FOUND、分帧）；`routes/cd2/check.itest.ts` 5；`mount-cache/refresh.test.ts` 4、`refresh.itest.ts` 9（加了真目标「配没配好」、两个目标各走各的、一个炸了另一个照常）；原五份 itest 全过（share 15、remove-source 11、archive-source 8、run 90、monitor 20）。写用例时撞到并改掉的：嵌套报文测试字段号撞了；令牌缓存键只按用户名、换口令还命中旧令牌（改成带口令哈希）；假服务的 JWT 计数没在用例间重置（加 `reset()`）。后端全量 1776 过（5 分 00 秒），前端单测 20 过；三包 typecheck / lint、hygiene 干净。

**界面冒烟**：全新 scratch 库起 4100（改掉默认口令）+ `next dev` 3223，加一个夸克占位账号让映射行出现；宽屏 1920 和 390px iframe、深色 / 浅色各一遍，排版正常；填地址 `http://127.0.0.1:1` + 令牌 + 映射点「检查连接和路径」→ 红 toast「✗ 地址：…connect ECONNREFUSED…；✗ 凭据：地址都没通，凭据先不验；✗ kuake（夸克） → /夸克：凭据没过，没查」；点保存 →「保存成功」，刷新后令牌显示 `••••1234`、地址和映射还在（掩码链路通）。连接被拒的文案太啰嗦（http2 的原话「The pending stream has been canceled (caused by: connect ECONNREFUSED …)」），随后在 grpc.ts 里按 ECONNREFUSED / ETIMEDOUT / EHOSTUNREACH 换成人话。冒烟环境已停、scratch 目录已删。

**没做 / 待办**：真机要 CD2 实例（ssm 上没装）；阶段 2 复制引擎等用户定两件事。

## 实施记录（2026-11-09，阶段 2）

**引擎接口**：`services/copy/engines.ts`——`CopyEngine { listNames, listEntries?, mkdir, copy, copyTasks }`，`openlistCopyEngine`（原 `realDeps.openlist` 搬过来，账号从 `cfg.account` 取、没有就抛）、`cd2CopyEngine`（`cd2ListEntries` / `cd2EnsureDir` / `cd2CopyFiles` + `GetCopyTasks`；任务 id `源路径→目标目录`，name `copy 源 to 目标`；Completed → succeeded、Failed → failed 带 errors 拼起来的原文，其余 undone；progress 按 uploadedFiles / totalFiles）。service.ts 里 `Deps.openlist` 和 `Deps.cd2` 都是 `CopyEngine`，`engineOf(cfg)` 按 `cfg.engine` 选，13 处 `deps.openlist.` 改成走它；`isMissingDir` 同时认 `Cd2Error` 的 NOT_FOUND；`afterCopiedInner` 的「目标落在哪个 OpenList 账号的任务下」只在有 OpenList 账号时算；listSource / submitReady / pollSubmitted 里说明和日志的「OpenList」换成 `copyEngineLabel(cfg.engine)`。`pollSubmitted` 任务列表里找不到时先 `verifyCopied` 核对目标，有了算完成（说明写「任务列表里已经没有它，目标里核对到了这一份」），没有才记 miss。

**配置**：shared `CopyEngine = "openlist" | "cd2"`、`OpenlistCopySettings.engine?`；zod 收 `engine`。`CopyConfig { engine, account | null, cd2: Cd2Connection | null, dstDir, mounts }`；`resolveCopyConfig` 选 CD2 时用 `cd2ConnectionOf` / `cd2MountsOf`（缺地址、缺凭据各一条 400），选 OpenList 时走新抽出来的 `resolveOpenlistMountConfig`；`openlistMountConfigIfReady` 给 `mount-cache/openlist.ts` 用——OpenList 挂载层的刷新只看 OpenList 账号和挂载根，和复制引擎选谁无关（第一版让它复用 `copyConfigIfReady`，引擎切到 CD2 时 OpenList 刷新会拿到 CD2 的映射和空账号，typecheck 先报出来）。`copySettingsGap` / `copyBlockerFor` 按引擎说缺什么；`OPENLIST_ROOT_TARGET` 文案「OpenList 根 /」改成「根 /」（两家一样）。Telegram 命令里浏览复制目标目录改走 `listOpenlistEntries(cfg, path)`（引擎无关）。

**CD2 客户端新增**：`cd2ListEntries`（name / isDirectory=30（老版本退回 fileType=5）/ size）、`cd2CreateFolder` + `cd2EnsureDir`（存储根不建，逐级建，「已存在」吞掉）、`cd2CopyFiles`（conflictPolicy Skip=2，FileOperationResult.success=false 抛）、`cd2CopyTasks`（解 CopyTask 的 3/4/5/7/9/10/15/18）。`POST /api/cd2/list { path }` 列子目录（routes/cd2/list.ts），形状同 `/api/directory/remote/list`。

**界面**：`OpenlistCopySection` 改叫「复制到 OpenList / CloudDrive2」，加「用哪个复制」下拉；选 CD2 时 OpenList 账号和挂载根两块不显示、换成一句指向 CloudDrive2 一节的说明，默认目标目录的「选目录」和「检查这些目录」走 `/api/cd2/list`、`/api/cd2/check`（页面把 `cd2` 那块的值用 `form.watch` 传进来）。任务弹框：标签「复制到 OpenList / CD2」，说明按引擎说，`copyGapInDialog` 加 `cd2` 参数（和后端 `copySettingsGap` 同一套条件），「选目录」按引擎走 CD2 或 OpenList 账号。strm 页、复制队列面板、云下载弹框 / 列表、任务页徽标里写死的「OpenList」改成「OpenList / CD2」或去掉主语。README 复制那段补 CD2 的填法；智能体说明补一句引擎按设置页选的。内部字段 `copyToOpenlist`、接口路径、工具名都没改。

**测试**：`copy/paths.test.ts` +1（CD2 引擎下四种缺法、`resolveCopyConfig` 给 cd2 连接和映射、没选引擎仍是 OpenList；两条旧用例的「OpenList 根 /」文案跟着改）；`cd2/client.itest.ts` +1（四个新接口对着假服务）；`copy/cd2-engine.itest.ts` 5 条（真引擎 + FakeDrive + 假 gRPC：单条走完、两条一批一成一败、任务消失按目标核对算完成、任务消失目标也没有记 miss、CopyFile 被拒退回排队）；`routes/cd2/list.itest.ts` 2 条；`routes/cd2/check.itest.ts` 5 条照过。假服务（`test/fake-cd2.ts`）加 CreateFolder / CopyFile / GetCopyTasks、`advanceCopies()` / `failSources` / `failNextCopy` / `dropCompleted`。三包 typecheck / lint、hygiene 干净。目标目录填成根的文案从「OpenList 根 /」改成「根 /」（两家一样），`crud.itest` / `manual.itest` / `followup.itest` / `paths.test` 里五处断言跟着改。后端全量 1785 过（4 分 59 秒），前端单测 20 过。

**界面冒烟**：全新 scratch 库起 4100 + `next dev` 3223，加一个夸克占位账号。设置页：导航「复制到 OpenList / CD2」、标题「复制到 OpenList / CloudDrive2」，「用哪个复制」默认 OpenList；切到 CloudDrive2 后 OpenList 账号和挂载根两块消失、换成指向 CloudDrive2 一节的说明，目标目录占位变 `/hdd/media`；填 CD2 地址 `http://127.0.0.1:1` + 令牌 + 夸克路径后点「检查这些目录」→ 红 toast「CD2 地址：连不上 http://127.0.0.1:1：连接被拒绝…；CD2 凭据：地址都没通，凭据先不验；kuake（夸克） 在 CD2 里的路径（/夸克）：凭据没过，没查」；保存 →「保存成功」，刷新后引擎仍是 CloudDrive2、目标目录和 CD2 令牌（掩码）都在。宽屏 1920 深色和 390px 窄屏深色排版正常。任务弹框：选夸克账号后开关标签「复制到 OpenList / CD2」，说明「让 CloudDrive2 把它复制到另一个存储…先在设置页配好 CloudDrive2 的地址、凭据、这个网盘在 CD2 里的路径和目标目录」，占位「不填就用设置页的默认目标目录（/hdd/media）」，开关打开后没有缺配置的黄字，「选目录」按钮标题「从 CloudDrive2 里选」、点开的弹框说明「从 CloudDrive2 的根目录里选」（CD2 连不上时列表为空）。冒烟环境已停、scratch 目录已删。

**没做 / 待办**：真机要 CD2 实例（挂 115 + 一个「本地文件夹」）；提交等用户叫。

## 真机验证（2026-11-09，阶段 1 + 阶段 2 一起验）

**环境**：ssm 上没有 CD2，用 Docker 起了一个 lab 实例：`cloudnas/clouddrive2:latest`（跑起来是 v1.1.3，cloudapi 1.1.3），容器 `cd2-lab`，只绑 `127.0.0.1:19798`，配置目录给的是 `/root/cd2-lab/config`（挂到容器的 `/Config`，但没给 `CLOUDDRIVE_HOME=/Config`，这个目录从头到尾是空的：登录状态、115 授权、API 令牌都留在容器层里，收尾删容器就一起没了），把 NAS 上的 `/mnt/hdd/cd2lab` 挂进容器当 `/local/hdd`（给「本地文件夹」存储用）；没给 fuse，不做 CD2 自己的挂载（刷新效果看 CD2 的缓存接口）。本机 `ssh -L 19798:127.0.0.1:19798` 到 ssm，用户在本机浏览器登录 CD2、扫码加 115、加本地文件夹、生成 API 令牌。lab 库：ssm 上 python `sqlite3.backup` 只读备份 `config/openstrm.db`，scp 到本机 scratchpad 的 lab-cd2，隔离同阶段 1 的 OpenList 真机（生产任务 / 追更 / 令牌 / OAuth / 审计 / 任务历史删光，Emby / Telegram / 监控 / HDHive / 检查更新 / PanSou / 智能体置空，口令换临时随机的，OpenList 账号地址改成隧道）；lab 后端 `127.0.0.1:4100`。115 上沿用 `/lab1109`（前一轮留下的三集，撤销后在顶层、原名）。第一回话：我们的 gRPC 客户端对着真 CD2 调 `GetSystemInfo` → `loggedIn false, systemReady true`。

| 场景 | 结果 |
|---|---|
| 用户在 CD2 里登录、扫码加 115（起名 `115open`，用的是 115 开放平台）、加本地文件夹 `/local/hdd`（起名 `hdd`）、生成 API 令牌 | 我们的客户端列 `/` 得到 `115open/`、`hdd/`，`/115open` 列出 115 根下 14 个目录（含 `lab1109`） |
| 设置：`cd2 { url, apiToken, mounts: {115: /115open} }`，`openlistCopy { engine: cd2, dstDir: /hdd }` → `POST /api/cd2/check`（令牌按掩码传回） | 三段全绿：「连上了，CD2 已登录」「API 令牌可用」「/115open 能列出来，14 个条目」；`POST /api/cd2/list /` 两个根；lab 任务 `lab1109` 的 copyBlocked 为空 |
| 整理执行（19:38:29 → 19:38:38 done，5 项）；执行前 19:35:08 已把 CD2 对 `/115open/lab1109` 的缓存列成三集原名 | lab 日志 19:38:41 `已让 CloudDrive2 刷新 3 个目录的缓存`（同一批 OpenList 目标因为这次没开 5244 隧道报连不上，两个目标互不影响）；19:38:49 按 CD2 现有缓存列 `/115open/lab1109` → `末日地堡 (2023) [tmdbid=125988]/`，季目录里三集都是新名字 |
| **对照**：把 lab 里的 CD2 映射清空（刷新目标关掉），撤销（19:42:07 → 19:42:23 reverted，5 项），从 19:42:34 起每 15 秒按 CD2 现有缓存列 `/115open/lab1109` | 19:42:34 第一次列就已经是三集原名，之后 4 分钟没再变。也就是说这个实例上 CD2 对 115 开放平台**自己就会跟**（多半是它的云盘事件监听；API 令牌没有 `GetAllCloudApis` 权限，`isCloudEventListenerRunning` 没读到，回的是 PERMISSION_DENIED 7，客户端把状态码带回来了）。所以执行那一步 19:38:49 看到的新名字分不清是我们刷的还是它自己跟的；能确认的是整条链路（配置 → 换路径 → GetSubFiles forceRefresh → 日志）在真 CD2 上走通、返回的是刷新后的列表。我们的刷新对这种云盘多余但无害；对没有事件监听的云盘才有用，这个实例上验不了 |
| 复制：映射恢复后 `POST /api/copy { taskId, paths: ["末日地堡(2023) - S03E03 - 第 3 集.mkv"], afterCopy: keep }`（3.96 GB，源在 `/lab1109` 顶层） | 19:47:33 登记，19:48:05 `已提交 CloudDrive2 复制 1 项：/115open/lab1109 → /hdd`，记录 stage copying、copyTaskId `/115open/lab1109/…mkv→/hdd`；NAS `/mnt/hdd/cd2lab/` 里 19:48 出现 `…mkv.clfstmp` + `.progress`（CD2 分两块下，19:50:18 已下 3.54 GB）。**真机发现的问题 1**：令牌只勾了读和复制，`GetCopyTasks` 回 PERMISSION_DENIED 7（`get transfer tasks permission required`），队列每轮都拿不到任务列表、会一直「复制中」——修：任务列表读不到时改按目标目录核对（CD2 复制中是 `.clfstmp` 临时名，最终名出现就是完成），说明里写清原因；`/api/cd2/check` 加一段 `copy` 探 GetCopyTasks 权限；设置页令牌提示和 README 写明要勾「读」「复制」「查看传输任务」；`cd2-engine.itest` +1、`check.itest` 补断言。改完 lab 后端热重载，记录说明变成「读不到 CloudDrive2 的复制任务列表（…permission required），改按目标目录核对，目标里还没有这一份」 |
| 第一条复制的收尾（令牌还没有「查看传输任务」） | 19:50:49 NAS 里最终名 `末日地堡(2023) - S03E03 - 第 3 集.mkv`（3,956,152,537 字节）出现、`.clfstmp` 消失；队列下一轮 19:51:04 记 done，说明「复制完成（CloudDrive2 的任务列表读不到，按目标目录核对到了这一份）」；按 CD2 现有缓存列 `/hdd` 也已经有它（CD2 自己写的目录自己就刷了） |
| 用户给令牌补上「查看传输任务」后，直接调 `GetCopyTasks` | 19:55:31 拿到 1 条：`sourcePath /115open/lab1109/…S03E03…mkv`、`destPath /hdd`、completed、total 1 / uploaded 1 / failed 0、errors 空、endTime 19:50:50 —— 字段号（3 / 4 / 5 / 7 / 9 / 10 / 15 / 18）和状态枚举对真 CD2 解对了；`POST /api/cd2/check` 第四段变绿「能看传输任务，复制进度盯得到」 |
| 第二条复制，走正常盯任务那条路：`POST /api/copy { paths: ["末日地堡(2023) - S03E01 - 第 1 集.mkv"], afterCopy: keep }`（4.19 GB） | 19:56:14 登记 → 19:56:45 `已提交 CloudDrive2 复制 1 项：/115open/lab1109 → /hdd` → 19:57:21 记录说明「CloudDrive2 复制中 0%」（CD2 的 uploadedFiles 按整文件计，单文件只有 0 和 1，没有中间值）→ 19:59:16 NAS 里最终名出现（4,191,999,497 字节）→ 19:59:45 `复制完成：/lab1109/…S03E01…mkv → /hdd`，记录 done、说明「复制完成」，队列清空后循环停止。提交到落地两分半，CD2 下 115 开放平台直链二十多 MB/s |
| **真机发现的问题 2**：第二条刚登记时记录说明是「等着复制到 OpenList」，引擎明明选的是 CloudDrive2 | 队列里几处状态 / 跳过原因 / 报错写死了 OpenList：登记时的「等着复制到 OpenList」、整理放行后的「…等着复制到 OpenList」、重试的「重新排队，等着复制到 OpenList」、「账号 X 没填「在 OpenList 里的挂载根」」、「「复制到 OpenList」没配置好」、云下载勾复制时的 400、转存勾复制时的 400、智能体 `copy_list` 的配置摘要（挂载映射只看 OpenList 那一节，引擎选 CD2 的会被说成「还没给任何网盘账号填挂载根」）。修：`copy/paths.ts` 加 `copyMountFieldLabel(engine)`（「在 OpenList 里的挂载根」/「在 CD2 里的路径」），`copySettingsGap` 也改用它（文案不变）；上面这些地方全部按 `copyEngineLabel` / `copyMountFieldLabel` 拼，典型文案「等着 CloudDrive2 复制」「等着 OpenList 复制」；轮询循环的日志名改成「复制队列」。「复制到 OpenList」作为设置页那一节 / 这个功能的名字（README、智能体工具说明、Telegram 提示）没改。只改文案和智能体摘要的取数，没有新测试；typecheck / lint 过，全量结果见下 |

**收尾（2026-11-09 20:05 UTC 前后）**：ssm 上 `docker rm -f cd2-lab` 已删（`/root/cd2-lab/config` 是空目录，CD2 的登录状态 / 115 授权 / lab API 令牌都随容器没了，没有要撤销的令牌）；本机 lab 后端（4100）和 19798 隧道已停；scratchpad 的 lab-cd2（lab 库、临时口令、lab 登录令牌、CD2 令牌、脚本、日志）已删。留下的三样（NAS `/mnt/hdd/cd2lab/` 两集共 7.6 GB、115 `/lab1109/` 三集、ssm `/root/cd2-lab/` 空目录）用户说「删一下」，20:20 UTC 前后全删了：NAS 和空目录直接 ssh 删；115 那边重新只读备份一份生产库到本机 scratch，走项目自己的 115 Provider 逐个 `remove`（进回收站）再 `rmdirIfEmpty`，核对 `/lab1109` 已不在，scratch 备份随手删掉。115 上这一轮什么都没留。下回再起 lab CD2：`docker run -d --name cd2-lab --restart no -p 127.0.0.1:19798:19798 -e CLOUDDRIVE_HOME=/Config -v /root/cd2-lab/config:/Config -v /mnt/hdd/cd2lab:/local/hdd -e TZ=Asia/Shanghai cloudnas/clouddrive2:latest`，浏览器走 `ssh -L 19798:127.0.0.1:19798` 登录、扫码加 115、加本地文件夹、生成令牌（勾「读」「复制」「查看传输任务」）。

**文案修补后的全量**：第一遍 1789 过 1788、挂 1 个——`copy.itest`「任务列表拿不到：这一轮一个字段都不改」是修问题 1 之前的契约（任务列表读不到就什么都不动），兜底一加它必然挂；真机前那次全量 1788 是在兜底之前跑的，兜底之后只跑过 cd2-engine / check 两个文件，这里补上。按新契约重写：状态、阶段、任务号不动、不算「列表里没找到」、说明写清是任务列表读不到、目标里有了算完成；顺手把兜底说明分成两种——目标目录能读就带核对结果（「改按目标目录核对：目标里没看到这一份」/「…少了 N 项」），目标目录也读不到（多半整个服务连不上）就说「目标目录也读不到，下轮再看」，不再一律说「目标里还没有这一份」（`cd2-engine.itest` 的断言同步改）。第二遍：typecheck / lint 过，后端全量 1789 / 1789，shared 20 / 20。

## 发布（2026-11-09）

用户：「提交一下发 rc 吧」。`00bc7a4` feat(cd2)（两阶段代码 + 测试 + 设置页 + README，含真机后的两处修补）→ `4d758ca` docs(plans) 方案 + drive-notes → `855058f` chore(release): v2.26.0-rc.2（三个 package.json 从 2.26.0-rc.1 升到 2.26.0-rc.2，shared 仍 2.0.0）；tag `v2.26.0-rc.2`（注释 v2.26.0-rc.2），`git push origin v2 v2.26.0-rc.2`（20:23 UTC），main 没动（仍 == v2.25.0 5f1d88b）。没有迁移。接着 rc.1（OpenList 刷新）在 2.26.0 这条线上继续出 rc，不另开 2.27（惯例同 v2.17 / v2.18：一个小版本在 rc 期间攒几个功能）。

工作流：CI 和 Release 都绿（Release 四个作业 Typecheck, lint and tests / Build amd64 / Build arm64 / Merge manifest and release 全 success，20:34 UTC 完成，推送到全绿 11 分钟）。GitHub Release `v2.26.0-rc.2` 是 prerelease。Docker Hub `indown/openstrm:v2.26.0-rc.2` digest `sha256:c00716290f34e663329e974a1bd19a02e5c94b96c8018eb7708bfb60e1069f94`（amd64 + arm64，20:34 推上），`latest` 仍是 v2.25.0 的 `sha256:c7aa598bd933…`，没动。升级说明交用户手动贴（草稿给了用户：新增设置页「CloudDrive2」一节和「用哪个复制」下拉，默认仍是 OpenList、老用户不用改配置；CD2 令牌权限要读 / 复制 / 查看传输任务；复制队列文案改按引擎；没有迁移）。

待办：用户把 ssm 上的 openstrm 换到这个 tag 后，用真片走一次整理看 rclone 挂载（rc.1 那条也还没验）；CD2 用户的反馈等 issue。
