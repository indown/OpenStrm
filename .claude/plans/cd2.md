# CloudDrive2 接入：目录缓存刷新 + 复制引擎（OpenList 那两条的 CD2 版）

## 起因

2026-11-09 用户：「接下来看 cd2 这条路吧，有的用户用的是 cd2，没有用 openlist+rclone」，随后又说「复制任务也要一起支持一下 cd2 吧，你一起看看怎么制定计划」。分两个阶段：**阶段 1 目录缓存刷新**（下面「方案」），**阶段 2 复制引擎**（文末「阶段 2」，等用户定两件事再开工）。2026-11-10 追加**阶段 3 CD2 做成账号类型**（文末，rc.2 发布之后）。OpenList 那条（.claude/plans/openlist-cache-refresh.md，v2.26.0-rc.1）解决的是经 OpenList 挂载回源的用户；用 CloudDrive2（CD2）挂载网盘给 Emby 回源的用户碰到的是同一件事：整理 / 转存在网盘上改了名，CD2 的目录缓存不知道，挂载里半小时内还是旧名字。README 一直把 CD2 和 rclone 并列成两种挂载路径（emby-playback-latency.md 也记过 ffprobe 经 rclone / CD2 读文件头）。

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

- 不做 CD2 账号类型（账户页 + Provider）：这里只需要「刷一下目录」，没有同步 / 转存 / 整理要经 CD2。（2026-11-10 改了主意：见文末「阶段 3」，CD2 做成账号类型，连接信息搬进账户页。）
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

## 阶段 3：CD2 做成账号类型——能建同步任务，连接信息搬进账户页（2026-11-10 方案）

### 起因

2026-11-10 用户看着设置页问：「CloudDrive2 账号的配置是不是应该放到账号管理里面」。现状确实不对称：OpenList 的地址和口令在账户页，CD2 的地址和凭据在设置页（阶段 1「不做」里定的：只需要刷目录，没有东西要经 CD2）。

只把凭据搬过去不行。账户页的每个账号都得是能挂任务的网盘 Provider：

- `providerFor`（drive/registry.ts）对认不出的类型直接抛。
- 网盘监控（life/monitor.ts 的 `listAccounts().map(providerFor)`）和智能体总览（agent/tools/core.ts）对所有账号调它，多一个取不到 Provider 的账号就炸。
- 任务弹框的账号下拉不过滤类型。
- 设置页两节把「不是 OpenList 的账号」都当网盘，会给 CD2 账号自己出一行映射。

OpenList 在账户页是因为它能建同步任务，复制和刷新只是复用那个账号。所以要搬就把 CD2 做成真正的账号类型。用户：「做吧，先写阶段 3 的方案」。

收益：CD2 用户能给 CD2 里挂的任何云盘（115 / 夸克之外的也行）生成 strm、做整理，现在只有 OpenList 用户有这条路。

时机：`settings.cd2` 的连接字段只在 v2.26.0-rc.2 里出现过。赶在 v2.26.0 转正前改，正式版用户不涉及。

### CD2 这边有什么（2026-11-10 重新拉的 proto，文件里标的版本仍是 1.1.2）

- `FindFileByPath(FindFileByPathRequest{parentPath=1, path=2}) → CloudDriveFile`，注释是 find file info by full path。
- `CloudDriveFile`：name=2、size=4、fileType=5、writeTime=7（Timestamp）、isDirectory=30、readOnly=80（只读云盘和压缩包目录，写操作一律不支持）。
- `RenameFile(RenameFileRequest{theFilePath=1, newName=2})`。
- `MoveFile(MoveFileRequest{theFilePaths=1[], destPath=2, conflictPolicy=3（Overwrite 0 / Rename 1 / Skip 2）, moveAcrossClouds=4, handleConflictRecursively=5})`。
- `DeleteFile(FileRequest{path=1})`。另有 `DeleteFilePermanently`（注释：目前只有阿里支持），所以 `DeleteFile` 是网盘的普通删除，进不进回收站看那家网盘。
- 上面三个都回 `FileOperationResult{success=1, errorMessage=2, resultFilePaths=3[]}`。
- `GetDownloadUrlPath(GetDownloadUrlPathRequest{path=1, preview=2, lazy_read=3, get_direct_url=4}) → DownloadUrlPathInfo{downloadUrlPath=1, expiresIn=2, directUrl=3, userAgent=4, additionalHeaders=5}`。`downloadUrlPath` 形如 `/static/{SCHEME}/{HOST}/{PREVIEW}/path/to/file?token=<令牌>`，三个占位符换成 CD2 地址的协议、host:port、`false`，接在 CD2 地址后面就是能直接 GET 的地址。
- `GetApiTokenInfo(StringValue{value=1}) → TokenInfo{rootDir=2, permissions=3, expires_in=4, friendly_name=5}`，注释是 get user created API token info by token string。
- `TokenPermissions` 里用得上的：allow_list=1（GetSubFiles、FindFileByPath）、allow_create_folder=4、allow_read=7（文件下载）、allow_rename=8、allow_move=9、allow_copy=10、allow_delete=11、allow_get_transfer_tasks=27。

只在 proto 上看到、真机没验过的五件事（每件都有退路，见「顺序」）：

1. FindFileByPath 的两个参数怎么拆，找不到时回什么。
2. MoveFile 撞名时 Skip 的表现，`resultFilePaths` 里有什么。
3. 下载地址要不要另带 `authorization`，支不支持 Range。
4. API 令牌能不能查自己的 TokenInfo。
5. 令牌限了 rootDir 时，路径是不是相对它。

### 做法

**账号类型**（`packages/shared` 的 types/account.ts）

- `AccountCd2 { accountType: "cd2"; name; url; apiToken?; username?; password? }`，并进 `AccountInfo`。字段名和 `Cd2Connection` 一致，账号对象可以直接当连接传。
- `DriveKind` 跟着多一个 `"cd2"`；后端 `KIND_LABEL`、前端 `DRIVE_LABEL`（「CD2」）和 `DRIVE_FULL_LABEL`（「CloudDrive2」）各补一项。
- zod（schemas/entities.ts）：`accountCd2Schema` 进 `accountInputSchema`，地址用设置页现在那条规则；`accountPatchSchema.accountType` 加 `cd2`。
- 凭据齐不齐：路由里的 `missingCredentials` 搬进 `services/drive/credentials.ts`，和 `credentialProblem` 放一起，路由不再认类型。加一支：cd2 要地址，外加令牌或「用户名 + 口令」。
- 掩码（lib/secrets.ts）：`ACCOUNT_SECRETS` 加 `apiToken`；`SETTING_SECRETS` 里 cd2 的两行删掉，设置里不再有凭据。

**Provider**（新文件 `services/drive/providers/cd2.ts`，照 providers/openlist.ts 的形状：id 就是路径，rootId 是 `/`）

- 能力：`{ share: false, changes: false, write: true }`。
- `resolvePath`：根直接回；其余 `FindFileByPath(父目录, 名字)`，`isCd2Missing` 回 null。
- `listDir(id, signal, { fresh })`：`cd2ListEntries`，`fresh` 对应 forceRefresh；条目补 `modifiedAt`（writeTime）。
- `listSubtree` / `walkSubtree`：逐层 `GetSubFiles(forceRefresh=true)`，和 OpenList 的 walk 一样，同步要看最新的；根目录不存在抛 `RemoteDirNotFoundError`。
- `downloadLink`：`GetDownloadUrlPath(path)`，占位符换好拼成地址，过账号的 `normal` 限流通道（同 OpenList）。不要 directUrl：云盘直链常和 UA、请求头绑定，走 CD2 自己的地址最省事。地址里带令牌，日志不打整条。
- `classifyError`：`Cd2Error` 的 UNAUTHENTICATED(16) 和 PERMISSION_DENIED(7) 归 `auth`（后者的原文带着缺哪项权限），其余 null。
- 写操作：
  - `mkdir` = `CreateFolder`，「已存在」吞掉。
  - `rename` = `RenameFile`，回新路径当 id。
  - `move` = 一次 `MoveFile`（路径都是绝对的，不用按源目录分组），`conflictPolicy=Skip`：不覆盖、不自动改名。回来后按 `resultFilePaths` 核对每个目标，缺的按「目标已有同名」抛。整理动手前本来就会列目标目录查撞名，这里只兜竞态。
  - `rmdirIfEmpty` = 强制刷新列一遍，空了才 `DeleteFile`。
  - `remove` = `DeleteFile`。
  - 不实现 `renameMany`：`RenameFiles` 部分失败怎么回不清楚，逐个改。

**客户端**（services/cd2/client.ts）

- 新增 `cd2FindFile`、`cd2Rename`、`cd2Move`、`cd2Delete`、`cd2DownloadUrl`、`cd2TokenInfo`。
- `cd2ListEntries` 多解一个 writeTime。

**注册与错误**

- `registry.ts` 的 `providerFor` 加一支。
- `drive/errors.ts` 的 `driveErrorFacts` 认 `Cd2Error`：
  - NOT_FOUND(5) 给 status 404，整理按它判「过期」。
  - 连不上、UNAVAILABLE(14)、DEADLINE_EXCEEDED(4) 算 transport，值得重试。
  - UNAUTHENTICATED(16) 是 authCode。
  - 其余 gRPC 码不塞进 status：分类器按 HTTP 状态看 429 / 5xx，gRPC 的小整数放进去没有意义。
- `driveErrorToHttp` 加一支 `upstreamError`。
- `DriveProvider` 加 `readonly pathIds: boolean`（id 就是路径：OpenList 和 CD2 为 true）。`organize/revert.ts` 里那处 `provider.kind !== "openlist"` 改看它，功能代码里不多一个类型字面量。
- 「挂载层账号」（OpenList / CD2，不是网盘）的判断：后端放 `services/drive/types.ts`（`isMountLayerKind`），前端放 `lib/drive.ts`，各一行、注明两边一起动。`packages/shared` 只有类型，放不了运行时代码。用它替掉这几处的 `!== "openlist"`：设置页两节的映射行、监控页的账号列表、任务弹框的复制开关、后端 `copyBlockerFor`。

**设置**：`Cd2Settings` 变成 `{ account?: string; mounts? }`

- `account` 是账户页里 CD2 账号的名字，和 `openlistCopy.account` 对称。挂载层仍是全局一个 CD2。
- `services/cd2/config.ts`：`cd2AccountOf(settings)`（选了、账号在、类型对、地址和凭据齐才给）；`cd2MountsOf` 不变；`cd2ConfigIfReady` = 账号 + 非空映射。
- `copy/paths.ts`：
  - `CopyConfig.cd2` 换成 `AccountCd2 | null`。
  - `resolveCopyConfig` 和 `copySettingsGap` 的 CD2 分支改成四种说法：还没选 CD2 账号、账号不存在、不是 CloudDrive2 账号、缺地址或凭据。
  - `copyBlockerFor` 的全局核对两种引擎都做；「OpenList 账号的任务用不着复制」扩成挂载层账号。
- `copy/service.ts` 的 `afterCopiedInner`：目标目录落在哪个任务下，按挂载层账号的名字找（OpenList 引擎是那个 OpenList 账号，CD2 引擎是那个 CD2 账号）。复制到 `/hdd/media` 之后，如果有 CD2 账号的任务同步的就是 `/hdd/media`，给那个任务发 `files.landed`，和 OpenList 那边一个行为。（2026-11-10 真机后更正：这里原来写的是「顺带给它生成 strm」，不对——听 `files.landed` 的是自动整理和目录缓存刷新，不生成 strm，OpenList 引擎一直也是这样。）
- `mount-cache/cd2.ts`、`copy/engines.ts`：只是配置来源变了。

**迁移 0030**（纯数据，写法同 0021）

- `app.cd2` 里有地址的：建一个 `cd2` 类型的账号，名字 `cd2`（撞名加随机后缀），地址、令牌、用户名、口令搬过去；`app.cd2` 改写成 `{ account: 那个名字, mounts: 原样 }`。
- 没填过地址的：只把连接字段去掉。
- 升级后刷新和复制照常，不用重填。代码里不留旧形状的兼容读法。

**接口**

- `POST /api/cd2/check`，body `{ account?, url?, apiToken?, username?, password?, mounts? }`：
  - 给了 url 就按这份草稿验（账户弹框里还没保存的值），掩码按 `account` 那个账号的原值还原。
  - 没给 url 就用 `account` 存着的那份（设置页的检查按钮）。
  - 结果在现有四段（地址、凭据、复制、各映射）之外加一段 `permissions`：用的是 API 令牌时 `GetApiTokenInfo` 读权限，按用途说缺什么；令牌限了根目录的也说出来。读不到 TokenInfo（权限不够、老版本没有这个接口）就退回现在的探测法，不报错。
- `POST /api/cd2/list` 删掉：CD2 账号走通用的 `/api/directory/remote/list`。
- 账号路由不加分支，凭据检查在 drive 层。

**令牌权限按用途**（界面上的叫法以 CD2 设置页为准，真机时对一遍；rc.2 真机记的是「读」「复制」「查看传输任务」）

| 用途 | proto 里的权限 |
|---|---|
| 目录刷新、浏览 | allow_list |
| 同步（字幕 / nfo 下到本地、媒体探测） | 再加 allow_read |
| 整理 | 再加 allow_create_folder、allow_rename、allow_move、allow_delete |
| 复制引擎 | allow_copy、allow_get_transfer_tasks、allow_create_folder |

复制那行的 allow_create_folder 是这次对着代码和 proto 看出来的缺口：rc.2 的说明只写了三项，而复制到还不存在的子目录要先 `CreateFolder`，队列里建目录失败是吞掉的，接着 `CopyFile` 会因为目标不存在一直等。rc.2 真机只复制到存储根，没撞上。新的 `permissions` 一段会把它说出来，README 一并改。

**界面**

- 账户页：
  - 类型下拉加「CloudDrive2」；字段是地址、API 令牌、用户名、口令，令牌和用户名口令二选一，提示里带上面的权限表。
  - 多一个「检查连接」按钮，调 `/api/cd2/check`，结果 toast。
  - 列表的认证信息列显示地址，外加令牌掩码或用户名；类型徽标用中文标签。
  - 空状态和页头文案补 CloudDrive2。
- 设置页「CloudDrive2」一节：
  - 四个连接输入换成「CD2 账号」下拉。没有就提示去账户页加；选的账号不在了标出来（同 OpenList 账号那一栏）。
  - 各网盘路径那几行加「选目录」按钮，现在有账号可浏览了。
  - 「检查连接和路径」传 `{ account, mounts }`。
- 设置页「复制到 OpenList / CloudDrive2」一节：`cd2Ready` 改成「选了 CD2 账号」；选目录和检查改走账号。
- 任务弹框：
  - 账号下拉里类型用中文标签；`canBrowseRemote` 不再列类型。
  - 复制开关对挂载层账号的任务都禁用，说明改成「OpenList / CloudDrive2 账号的任务用不着复制…」。
  - `copyGapInDialog` 的 CD2 分支跟着后端改。
  - CD2 引擎下选复制目标，走 CD2 账号的目录浏览。
  - CD2 账号的任务，strm 前缀的提示写「CD2 挂载到媒体服务器那台机器上的路径」。
- 监控页账号列表、命令面板：按挂载层账号过滤、用中文标签。

**智能体 / 文档**

- 智能体说明里账号类型补 CloudDrive2：能同步、浏览、整理；没有转存、追更、监控、云下载。
- `DST_SUBDIR_HINT` 里的「OpenList 账号名」按引擎说成 CD2 账号名：CD2 引擎下终于有账号可以 `drive_browse` 了。工具名和参数都不变。
- README：账号类型四种、账户页怎么填 CD2、设置页那节改成选账号、权限表、CD2 任务的 strm 前缀怎么填。

**顺序**

1. 先做客户端新接口和假服务。
2. 对着 lab CD2 做一轮**只读探测**，把上面五件没验过的事探明（不改网盘）。各自的退路：FindFileByPath 不好用就列父目录找名字；`resultFilePaths` 靠不住就对源路径再查一次；下载地址要头就放进 `DriveLink.headers`；查不了 TokenInfo 就只用探测法；rootDir 的结论写进提示。
3. 再做 Provider、设置和迁移、界面。
4. 同一个 lab 实例留到最后走真机。

### 行为变化（要用户点头）

1. 账户页多一种 CloudDrive2 账号：能建同步任务、浏览目录、整理。没有分享转存、追更、网盘监控、云下载、302，任务上的复制开关不可用（和 OpenList 账号一样）。
2. 设置页 CloudDrive2 一节不再填地址和凭据，改成选账号。rc.2 里填过的由迁移 0030 自动搬成一个叫 `cd2` 的账号，不用重填。**这一版带迁移**。
3. 同步 CD2 任务时每个目录都让 CD2 强制刷新一遍（同 OpenList）：结果是最新的，代价是大库同步时 CD2 要逐目录问网盘。
4. 整理在 CD2 任务上直接改网盘：改名、移动、建目录走 CD2；冲突里选「删掉 / 覆盖」走 CD2 的普通删除，进不进回收站看那家网盘。
5. 复制引擎是 CD2 时，目标目录正好在某个 CD2 账号任务的目录下的，复制完把新文件交给那个任务的自动整理（任务开着自动整理才有动作；OpenList 引擎一直如此）。（2026-11-10 真机后更正：给用户确认时写的是「顺带给那个任务生成 strm」，说错了，已当面更正，代码没变。）
6. API 令牌要勾的权限变多，见上面的表。用用户名口令登录的不受影响。

### 不做

- 302、分享转存、追更、网盘监控、云下载：CD2 账号没有这些能力位，界面按能力自动不出现。
- CD2 账号任务的「复制」：没有新文件的来路，同 OpenList 账号。
- 用云盘直链（`get_direct_url`）：先走 CD2 自己的下载地址。
- 多个 CD2 当挂载层：账户页可以加多个 CD2 账号、各自建任务，但刷新和复制只用设置页选的那一个。
- `RenameFiles` 批量改名、`DeleteFilePermanently`、按 CD2 的事件推送做监控。
- 同步时给 CD2 的列目录另加限流：和 OpenList 一样不加，CD2 自己对各家网盘有节流；大库的实际耗时真机时量。

### 测试

自动化：

- `db/cd2-account-migration.itest.ts`（照 throttle-migration 的写法，把 0030 的语句对着造好的旧数据跑）：有地址 → 建账号并改写设置，令牌和口令原样；用户名口令那种；没地址 → 不建账号、连接字段去掉；已有叫 `cd2` 的账号 → 换名字且设置指向新名字；跑两遍不重复建。
- `routes/crud.itest.ts`（账号）：建 cd2 账号缺地址、缺凭据被拒；读回令牌和口令是掩码；PUT 带掩码不改原值；改成空串清掉。
- `services/drive/credentials.test.ts`：四种类型各缺什么。
- `services/cd2/client.itest.ts`：FindFileByPath 找到和找不到；RenameFile / MoveFile / DeleteFile 的请求形状和 success=false；MoveFile 被跳过（`resultFilePaths` 里没有）要抛；下载地址占位符替换（http、https、带端口）；列目录解出 writeTime；TokenInfo 解码。
- `services/drive/providers/cd2.itest.ts`（对着假 gRPC 服务）：resolvePath 的根、有、没有；listDir 的 fresh 真带 forceRefresh；listSubtree 根不存在抛 `RemoteDirNotFoundError`、顶层空目录在结果里；五个写操作的返回 id；rmdirIfEmpty 非空回 false；classifyError 四种。
- `services/drive/registry.test.ts`：cd2 账号分派到 `Cd2Provider`。`services/drive/errors.test.ts`：`Cd2Error` 的三种事实。
- `services/task/runner.itest.ts`：CD2 账号的任务对着假服务同步一遍，strm 内容是前缀 + 路径。
- `services/organize`：撤销里「id 变了不算另一个文件」那条改按 `pathIds` 断言。
- 换夹具的四份：`copy/paths.test.ts`、`copy/cd2-engine.itest.ts`、`mount-cache/refresh.itest.ts`、`routes/cd2/check.itest.ts`，从 `settings.cd2` 的连接字段换成 CD2 账号 + `settings.cd2.account`。另加：
  - paths：没选账号、账号删了、类型不对。
  - check：按账号查；草稿带掩码按账号还原；permissions 一段；读不到 TokenInfo 时退回探测。
  - cd2-engine：目标在 CD2 账号任务下 → 发 `files.landed`。
- `routes/cd2/list.itest.ts` 随路由删掉；`/api/directory/remote/list` 加一条 cd2 账号的。
- `test/fake-cd2.ts`：加 FindFileByPath、RenameFile、MoveFile、DeleteFile、GetDownloadUrlPath、GetApiTokenInfo；目录树改成能改动、带大小和时间。假服务是 h2c，不同端口另起 HTTP 太绕，经下载地址真取文件这一段留给真机。
- 前端：`lib/openlist-copy.test.ts` 的 CD2 分支。

浏览器冒烟（scratch 库）：账户页加、改 CD2 账号和掩码；设置页两节；任务弹框选 CD2 账号；监控页不出现 CD2 账号。宽屏 + 390px，深浅色各一遍。

真机（**要用户再配合起一次 lab CD2**：浏览器登录、扫码加 115、加本地文件夹、生成令牌；起法在上面「真机验证」的收尾一段和 drive-notes）。会改动真实网盘的每一步先说清楚、等批准：

1. 只读探测（「顺序」第 2 步）：五件事各记结论。
2. 账户页加 CD2 账号、「检查连接」：权限齐全、故意少勾几项各看一次说法；用户名口令登录一次。
3. 任务弹框浏览 CD2 目录，建 lab 任务指向 `/115open/lab<日期>`。
4. 同步：strm 内容；字幕 / nfo 经 CD2 下载地址下到本地；媒体探测读得出。
5. 整理三步：只读预览 → 执行 → 撤销；撞名时 MoveFile 的表现；冲突选删除走一次，看进不进 115 回收站。
6. 回归：设置页选这个 CD2 账号后，目录刷新和一次复制照常（复制到一个还不存在的子目录，顺带验「建目录」权限）；目标目录建成 CD2 账号任务，看复制完 strm 有没有跟上。
7. 迁移：lab 库里造一份 rc.2 形状的 `app.cd2`，升级后账号建出来、设置改写、刷新和复制不用重填。
8. 顺手记下：几百个目录的任务全量同步要多久。

### 进度（阶段 3）

- [x] 方案（2026-11-10）
- [x] 用户确认行为变化（2026-11-10：「好的，按照你推荐的开始吧」——六条都认，lab CD2 开工早期就起、先做只读探测）
- [x] 客户端新接口 + 假服务（2026-11-10）
- [x] lab CD2 探测（2026-11-10：只读部分和 `/hdd/probe` 里写的部分都跑了，结论见「探测记录」）
- [x] 账号类型 + 掩码 + 凭据检查搬层（2026-11-10；设置那边的掩码表等改设置形状时一起动）
- [x] Cd2Provider + 注册 / 错误 / pathIds / 挂载层判断（2026-11-10；照 proto 猜的那几处等探测后对齐）
- [x] 设置形状 + 迁移 0030 + 配置读取处（2026-11-10）
- [x] 检查接口（permissions）+ 删 /api/cd2/list（2026-11-10）
- [x] 界面（账户页 / 设置页两节 / 任务弹框 / 监控页 / 命令面板）（2026-11-10）
- [x] 智能体说明 + README（2026-11-10）
- [x] 测试 + 全量（2026-11-10：后端全量 1821 / 1821，前端 24 / 24，typecheck / lint 过）
- [x] 浏览器冒烟（2026-11-10，见「浏览器冒烟」）
- [x] 真机（2026-11-10，见「真机记录」；用户批准后在 115 的 `/lab1110` 里做完，实验环境已全部删除）
- [ ] 评审：没做。用户 2026-11-10：「真机测试做完之后不用review，直接停掉然后把实验环境都删除」
- [x] 发布：v2.26.0-rc.3（2026-11-11，见文末「发布（阶段 3）」）
- [x] 转正：v2.26.0 正式版（2026-11-11，见文末「发布（v2.26.0 正式版）」）

## 实施记录（2026-11-10，阶段 3，进行中）

**客户端新接口 + 假服务**

- `lib/grpc.ts`：`GRPC_STATUS` 补 DEADLINE_EXCEEDED(4)、UNIMPLEMENTED(12)。
- `services/cd2/client.ts`：
  - `Cd2Entry` 多一个 `modifiedAt`（writeTime 的秒数换成毫秒）；解条目抽成 `parseFile`，int64 超出安全整数的当没给（负数走 varint 会解成巨大的无符号数）。
  - 新增 `cd2FindFile(父目录, 名字)`（NOT_FOUND 或空报文回 null）、`cd2Rename`、`cd2Move`（带 Skip，回 `resultFilePaths`）、`cd2Delete`、`cd2DownloadUrl` + `fillDownloadUrl`（占位符替换单独一个纯函数）、`cd2TokenInfo`（用户名口令登录的不问；PERMISSION_DENIED / UNIMPLEMENTED / NOT_FOUND 回 null，令牌失效和连不上照常抛）。
- `test/fake-cd2.ts`：加 FindFileByPath、RenameFile、MoveFile（三种冲突策略）、DeleteFile、GetDownloadUrlPath、GetApiTokenInfo；目录树是活的（改名 / 移动 / 删除连子树一起动）；`deny` 按方法名回 PERMISSION_DENIED；`mtimes` 给条目带修改时间。这些行为是照 proto 猜的，探测之后按真 CD2 的表现改。
- `services/cd2/client.itest.ts` 加 4 条，整份 13 过：「FindFileByPath：找到的带类型、大小、修改时间…」「改名、移动、删除：目录树真的变了…」「下载地址：占位符换成 CD2 地址的协议、host:port 和 false…」「GetApiTokenInfo：读出权限、根目录、有效期…」。

**账号类型 + 掩码 + 凭据检查搬层**

- `packages/shared`：`AccountCd2 { accountType: "cd2", name, url, apiToken?, username?, password? }` 并进 `AccountInfo`。
- `schemas/entities.ts`：`accountCd2Schema` 进 `accountInputSchema`，`accountPatchSchema.accountType` 加 `cd2`。地址像不像地址、凭据齐不齐不放在 zod 里：改账号走的是宽松的 patch，规则放 drive 层两条路都管得到。
- `services/drive/credentials.ts`：`missingCredentials` 从账号路由搬过来，加 cd2 一支（要地址、地址得像地址、令牌或「用户名 + 口令」）；`routes/account/index.ts` 只剩调用。
- `lib/secrets.ts`：`ACCOUNT_SECRETS` 加 `apiToken`。
- `drive/registry.ts`：`KIND_LABEL` 补 `cd2`。这时 `providerFor` 还没有 cd2 这一支（等 Provider），库里也还建不出会被用到的 cd2 账号。
- 用例：`services/drive/credentials.test.ts`「missingCredentials：四种账号各缺什么…」；`routes/crud.itest.ts`「POST/PUT /api/account：CloudDrive2 账号要地址和一组凭据…」。两份共 36 过。三包 typecheck、涉及文件的 lint、hygiene 干净；全量还没跑。

**lab 准备**：ssm 上现在没有 CD2 容器和镜像（2026-11-10 15:37 UTC 只读看的），`/mnt/hdd` 余 7.5T。起容器的脚本、端口转发、探测脚本（只读部分默认跑，`--write` 才在 `/hdd/probe` 里试建目录 / 改名 / 移动撞名 / 删除，115 上不动）都在本机 scratchpad 的 lab-cd2 目录，没进仓库。

**Provider + 注册 / 错误 / pathIds / 挂载层判断**（2026-11-10，探测结果还没回来，先照假服务写，探测后只需对齐客户端）

- 新文件 `services/drive/providers/cd2.ts`：`Cd2Provider`（`kind: "cd2"`，根 `/`，`pathIds: true`，能力 `{ share: false, changes: false, write: true }`）和 `Cd2Write`。
  - 路径只归一斜杠，不削每一段两边的空白（和 OpenList 那份不一样）：id 是从 CD2 列出来的名字拼的，网盘上真有带尾空格的目录名，削了就找不着。
  - `resolvePath` 只发 `FindFileByPath(父目录, 名字)`，不列父目录；`listDir` 默认走 CD2 缓存、`fresh` 才 forceRefresh；`walk` 每层 forceRefresh，只有根不存在才换成 `RemoteDirNotFoundError`。
  - `move`：一次 `MoveFile` 带 Skip，按 `resultFilePaths` 核对，没挪过去的抛 `CD2 MoveFile 没有挪过去：… 里已存在同名的 …`（整理的分类器按「已存在 / 同名」归 rejected）。
  - `classifyError`：只认 UNAUTHENTICATED(16) / PERMISSION_DENIED(7)，transport 的不算。
- `drive/types.ts`：`DriveProvider.pathIds`（四家 + FakeDrive 都补了；FakeDrive 多一个 `pathIds` 选项）、`isMountLayerKind`。`organize/revert.ts` 那处改看 `pathIds`。
- `drive/registry.ts`：`providerFor` 加 cd2 一支。
- `drive/errors.ts`：
  - `Cd2Error` 的事实照方案；多定了一条：`api: false`。CD2 的文案里常带路径（`object not found: /115/…`），按文案猜账号问题会被路径里的「405」「cookie」带偏，登录失效 / 缺权限按 gRPC 码认就够。
  - 「没有这个路径」用 `isCd2Missing`（NOT_FOUND 或文案）给 404，不只看状态码：CD2 很多失败是 `success=false` 加一句话，没有 gRPC 码。
  - `driveErrorToHttp` 的 extra 用 `grpcStatus`（不叫 `upstreamStatus`，那个是 HTTP 状态）。
- 登录失效的两处说法顺手改成不只说 cookie（CD2 是令牌、OpenList 是密码）：`download/failure.ts` 的建议「更新 cookie、密码或令牌」，Telegram 账号告警「登录凭据（cookie / 密码 / 令牌）已失效」。
- **批量移动只成了一部分**（当时没定，探测后定了，见「探测记录」第 2 条和后面的「探测之后的改动」）：一项被 Skip、别的照挪时，整批当普通失败抛的话，整理逐个重试会把已经挪过去的记成 stale。

**设置形状 + 迁移 0030 + 配置读取处**

- `packages/shared`：`Cd2Settings = { account?, mounts? }`；`Cd2CheckResult` 多一段 `permissions { ok, message, rootDir?, missing: [{ use, lacks }] }`，新类型 `Cd2TokenUse`。
- `schemas/entities.ts`：`settings.cd2` 改成 `z.object({ account, mounts })`（不是 looseObject）：没刷新的旧页面还会带着 url / apiToken 提交，多余的键丢掉，不让它们再落回设置里。
- `lib/secrets.ts`：`SETTING_SECRETS` 去掉 cd2 的两行。
- `services/cd2/config.ts`：`cd2AccountState`（四种用不了的原因）、`cd2AccountProblem`（各一句话）、`cd2AccountOf`、`cd2ConfigIfReady`（`conn` 就是那个 CD2 账号）。
- `copy/paths.ts`：`CopyConfig.cd2: AccountCd2 | null`；CD2 分支四种说法；`copyBlockerFor` 两种引擎都去账号表核对；挂载层账号的任务那句抽成 `MOUNT_LAYER_TASK_NO_COPY`（「OpenList / CloudDrive2 账号的任务用不着复制…」）。
- `copy/service.ts` `afterCopiedInner`：按引擎取挂载层账号名找任务。`copy/engines.ts`、`mount-cache/cd2.ts` 只是配置来源变了。
- 迁移 `0030_cd2_account.sql`（drizzle-kit `--custom` 生成的空文件 + 手写三条语句；快照和 0029 相同）：
  1. 填过地址、还没指向账号的：先把账号名记进 `$.account`（`cd2`，已有同名账号就 `cd2-` 加 6 位随机十六进制）。
  2. 按记下的名字 `INSERT … ON CONFLICT DO NOTHING` 建账号；空串的字段不带。
  3. `app.cd2` 改写成只剩 `account` 和 `mounts`。
  - 先记名字再建账号，是为了第 3 步不用回头去猜刚才建的是哪个。只认 `app.cd2` 是 JSON 对象的；只填了地址没填凭据的也建账号（账户页接着填）。

**检查接口 + 删 /api/cd2/list**

- 逻辑搬进 `services/cd2/check.ts`（`checkCd2`、`describeTokenPermissions`），路由 `routes/cd2/check.ts` 只剩解析和调用：按账号类型认 CD2 账号这种事不放在路由里。
- body `{ account?, url?, apiToken?, username?, password?, mounts? }`：带 url 是草稿（掩码按 `account` 那个账号还原），不带就查 `account` 存着的。
- `permissions`：读得到 TokenInfo 才有，按浏览 / 同步 / 整理 / 复制四种用途说缺什么，限了根目录的带上。**和方案不一样**：`copy` 那一下探测（GetCopyTasks）一直做，不只在读不到 TokenInfo 时；界面上有 `permissions` 就不再列 `copy` 那行。
- `routes/cd2/list.ts` 和它的用例删掉，`index.ts` 去掉注册；前端改走 `/api/directory/remote/list`。

**界面**

- `lib/drive.ts`：`DRIVE_LABEL.cd2 = "CD2"`、`DRIVE_FULL_LABEL.cd2 = "CloudDrive2"`、`isMountLayerKind`；`lib/api.ts`：`DriveKind` 加 `cd2`，`api.cd2.check` 收 `Cd2CheckDraft`，`api.cd2.list` 删掉。
- 账户弹框：类型多一项 CloudDrive2；四个字段（地址、API 令牌、用户名、口令），缺什么标在对应那一栏；权限说明；「检查连接」按表单里现在的值验（不用先保存）。提交时别的类型不带 `apiToken` / `username` 两个键。
- 账户页：CD2 账号的认证信息列显示地址 + 令牌掩码或用户名；类型徽标用中文全称；空状态和页头补 CloudDrive2。
- 设置页「CloudDrive2」一节：四个输入换成「CD2 账号」下拉（没有 / 不在了各有提示）；各网盘路径一行一个「选目录」；检查传 `{ account, mounts }`。
- 设置页复制一节：`cd2Ready` = 选了 CD2 账号且它还在；选目录、查目标目录走 CD2 账号的目录浏览；检查时令牌权限只看「复制」那一项。
- 任务弹框：账号下拉用中文类型；每种账号都能浏览远程目录；挂载层账号的任务复制开关禁用；CD2 引擎下从 CD2 账号里选复制目标；CD2 账号任务的 strm 前缀提示。
- 监控页账号列表按 `isMountLayerKind` 过滤、带类型；命令面板账号后面的类型用中文。

**智能体说明 + README**

- 说明第一句和「概念」补 CloudDrive2（挂载层：能同步、浏览、整理，没有转存、追更、监控、云下载）；前 512 个字符里的「必须遵守」没被挤出去（`agent.test.ts` 过）。
- `copy_list` 的 config 多两项：`engine`、`browseAccount`（OpenList 引擎是 OpenList 账号，CD2 引擎是设置页选的 CD2 账号）；`DST_SUBDIR_HINT` 和使用须知改成按它 `drive_browse`。`openlistAccount` 留着。
- README：账号四种；「第一次用」补 CD2；新增「CloudDrive2 账号」一小节（地址、凭据、权限表、任务怎么填、强制刷新、删除、挂载层只用选中的那个）；回源提示和云下载那段跟着改。

**用例**（单跑都过）

- 新文件：`db/cd2-account-migration.itest.ts`（7）、`services/drive/providers/cd2.itest.ts`（10）、前端 `lib/openlist-copy.test.ts`（4）。
- 加条目：`drive/registry.test.ts`（cd2 分派、pathIds / 挂载层）、`drive/errors.test.ts`（Cd2Error 的事实、只按码认账号问题）、`task/runner.itest.ts`（CD2 账号整条跑通）、`routes/directory/remote.itest.ts`（CD2 账号浏览）、`organize/run.itest.ts`（撤销按 pathIds）、`copy/cd2-engine.itest.ts`（目标在 CD2 账号任务下发 files.landed）。
- 换夹具：`copy/paths.test.ts`、`copy/cd2-engine.itest.ts`、`mount-cache/refresh.itest.ts`、`routes/cd2/check.itest.ts`（重写成 8 条）。`routes/crud.itest.ts`、`telegram/notify.itest.ts` 各改一句断言的文案。
- `listSubtree` 的口径记一笔：真正空的顶层目录不在同步视图里，只有「有子目录但没有文件」的顶层目录在（三家一个口径，`collectFilesAndTopEmptyDirs`）；方案里写的「顶层空目录在结果里」说的是后一种。

## 探测记录（2026-11-10，lab CD2 = ssm 上的 `cloudnas/clouddrive2:latest`）

对着「阶段 3」里五件只在 proto 上看到的事。脚本在本机 scratchpad（lab-cd2/probe.mts），令牌只在 scratchpad 的文件里，输出里的令牌和下载地址的查询参数都打了码。

1. **FindFileByPath 的参数**：`(父目录, 名字)` 能用；`(/, 相对路径)`、`("", 完整路径)`、`(完整路径, "")` 三种也都回同一个条目。找不到是 gRPC NOT_FOUND(5)，说法是 `find by path: "<完整路径>" not found under "<父目录>"`。→ `cd2FindFile` 不用改。
2. **MoveFile 撞名 + Skip**（用户加上本地文件夹 `hdd` 之后在 `/hdd/probe` 里试的，只动起容器时放的 5 个小文件）：
   - 一批两个源、一个撞名一个不撞：撞名的原地不动，不撞的照挪，**整个调用回 success=true、不报错**。
   - 单个撞名：同样回 success=true，什么都没动。
   - **`resultFilePaths` 两次都是空的**，挪成了的也不在里面（回包里只有 success 一个字段）。照它核对会把每次移动都判成没挪过去。
   - 挪完之后 CD2 的目录缓存当场就是新的（不强制刷新列出来就对，FindFileByPath 在旧位置回 null、新位置找得到）。
   - 源不存在：gRPC NOT_FOUND(5)。
   → `move` 改成挪完看源还在不在（见下面「探测之后的改动」）。
3. **下载地址**：`GetDownloadUrlPath` 回的路径形如 `/static/{SCHEME}/{HOST}/{PREVIEW}/<整条路径 URL 编码，斜杠也编成 %2F>?token=…&cloudname=…&membership=…`。换完占位符直接 GET：
   - 不带 `authorization`、带 `Range: bytes=0-1023` → 206，`content-range` 正确；带上 `authorization` 也一样。
   - 不带 Range → 200，`accept-ranges: bytes`，`content-length` 是文件大小。
   - 对目录取下载地址 → INVALID_ARGUMENT(3) `Cannot download directory`。
   - 试的是 115 里一个 9.1 GB 的文件，只读了头 1 KB；本地文件夹里一个 10 字节的文件表现一样。
   → `DriveLink` 不用带请求头，媒体探测的 Range 读法能用。
4. **API 令牌查自己的 TokenInfo**：不行。`GetApiTokenInfo` 回 PERMISSION_DENIED(7) `token management permission required`——只有带「令牌管理」权限的令牌才给读。→ `cd2TokenInfo` 回 null（已有这条路），检查接口的 `permissions` 一段平时出不来，只剩探测「查看传输任务」那一下。界面和 README 的说法跟着改了：少勾的权限靠用到时的报错（`… permission required`）发现，不再说「检查连接会按用途列出缺哪项」。不建议用户为了看权限表去勾「令牌管理」。
5. **令牌限了 rootDir 时的路径**：没法验（这个令牌没限根目录，TokenInfo 也读不到）。维持原样：读得到 rootDir 时只把它说出来，不对路径怎么写下结论。

顺带看到的：

- 列目录：`/115open` 13 项，头一次（缓存）1.1 秒，紧接着 forceRefresh 0.4 秒；一帧回完。不存在的目录是 NOT_FOUND(5)，说法同上。
- `CloudDriveFile` 实际带的字段号：1、2（name）、3（fullPathName）、6 / 7 / 8（三个时间，7 是 writeTime）、9、30（isDirectory）、33、63、64、66、72、75。目录不带 size(4)。
- `GetSystemInfo` 回的用户名是 CD2 自己打过码的。

按这些把假服务对齐了（`test/fake-cd2.ts`）：找不到的说法、下载地址的形状、目录不给下载、`GetApiTokenInfo` 默认拒（`tokenManagement = true` 才给），相关断言跟着改；`client.ts` 头注释记了这几条。

写的那部分另外看到的（都在 `/hdd/probe`，本地文件夹存储）：

- **失败多半走 gRPC 状态码，不是 `success=false`**：改名撞名是 ALREADY_EXISTS(6) `rename error: "x" already exists in "<目录>"`；改名 / 移动 / 删除的源不存在是 NOT_FOUND(5)。
- **CreateFolder**：目录已经在 → 照样回成功；父目录不在 → 连父目录一起建出来了（探测脚本因此在 probe 目录里多留了一个 `__nope__/x`）。这是本地文件夹存储的表现，115 上没试。
- **DeleteFile**：文件、空目录都删得掉；已经没了是 NOT_FOUND(5)。
- 探测脚本里「移动到不存在的目标」那一条没验成：那个目标目录被前面的 CreateFolder 建出来了。整理总是先建目录再挪，不靠这条。

**令牌权限在 CD2 界面上的叫法**（从 lab CD2 网页的静态资源里核的，没碰登录态）：分三组——文件操作（文件读取：列出文件、列出本地、读取文件、查看属性、获取空间信息；文件创建与写入：创建文件夹、创建文件、写入…；文件修改：重命名、移动、复制、删除、永久删除）、系统操作（系统读取里有「获取传输任务」，系统写入里有「令牌管理」）、账号操作。我们用到的八项对应：列出文件、读取文件、创建文件夹、重命名、移动、复制、删除、获取传输任务。rc.2 的界面和 README 写的「读」「查看传输任务」和界面对不上，这次一起改成界面上的叫法（检查接口的说法、账户弹框的权限说明、README 的表）。

### 探测之后的改动（2026-11-10）

- `services/cd2/client.ts`：`cd2Move` 不再返回 `resultFilePaths`；`isCd2AlreadyExists` 认 ALREADY_EXISTS(6)；`GRPC_STATUS` 补 INVALID_ARGUMENT(3)、ALREADY_EXISTS(6)。头注释记了真机表现。
- `drive/providers/cd2.ts` 的 `move`：
  - 挪完按源所在目录各列一遍（走 CD2 的缓存，不强制刷新——它自己动过之后缓存是准的，强制刷新反而可能撞上网盘那头列表滞后），还在原处的就是没挪成。
  - 没挪成的再看目标目录：有同名的报「已存在同名的 …」（整理归 rejected），看不出原因的照实说「CD2 回了成功但还在原处」。
  - 本来就在目标目录里的不发请求。
  - 同一批里有挪成的也有没挪成的：抛 `PartialMoveError`（`drive/types.ts` 新增，带着已经挪过去的「源路径 → 新 id」）；一个都没挪成才抛普通的 `Cd2Error`。
- `organize/apply.ts`：批量移动抛 `PartialMoveError` 时，已经挪过去的直接记完成，剩下的才逐个再试。`DriveWriteOps.move` 的契约注释补了这一条；别家网盘的批量接口要么全成要么全不成，不受影响。
- `mkdir`：吞「已存在」之前先确认占着名字的是个目录（是文件就照原样报）。
- 假服务（`test/fake-cd2.ts`、`test/fake-drive.ts`）：MoveFile 不回结果路径、撞名不报错；改名撞名回 6、源不存在回 5；`lenientCreateFolder` 模拟本地文件夹那种 CreateFolder；FakeDrive 多一个 `skipMoveOf` 模拟「撞名的原地不动、别的照挪」。
- 用例：`providers/cd2.itest.ts`（部分成功带上挪过去的、单个撞名是普通错误、核对不强制刷新、宽松的 CreateFolder）、`organize/run.itest.ts`「批量移动只成了一部分…」、`cd2/client.itest.ts` 跟着改。

## 浏览器冒烟（2026-11-10）

scratch 库的后端（127.0.0.1:4100）+ `next dev`（3223）+ 测试里的假 CD2 gRPC 服务（起在本机随机端口）。临时口令和 token 只在 scratchpad，页面的 token 由一个只听回环口、给一次就退出的小服务交过去；做完库、口令、token 都删了，服务都停了。

| 页面 | 看了什么 | 结果 |
|---|---|---|
| 账户页 | 新增 → 类型选 CloudDrive2；空着保存；填地址 + 令牌点「检查连接」；保存；列表；编辑（令牌是掩码「已保存」）→ 带掩码检查 → 原样保存 | 三处校验提示落在名称 / 地址 / 令牌那一栏；检查的 toast 三行都绿；列表显示地址 + `••••oken`，类型徽标是中文；带掩码检查通过（后端按账号还原）；库里这个账号只存了自己的字段 |
| 设置页「CloudDrive2」 | 选账号；my115 那行点选目录；检查连接和路径；保存 | 映射只有 115 / 夸克两行（OpenList、CD2 账号不在里面）；选目录框列的是 CD2 根下的目录；检查通过；保存后重开还在 |
| 设置页复制一节 | 引擎切到 CloudDrive2；默认目标目录从 CD2 里选 `/hdd/media`；检查这些目录 | 说明里带着选中的账号名；toast「CD2 连得上，各网盘的路径和目标目录都在」 |
| 任务弹框（CD2 账号） | 账号下拉；浏览远程目录选 `115open/tv`；前缀提示；复制开关；保存并跑 | 下拉是「nas-cd2（CloudDrive2）」这种中文类型；浏览列的是 CD2 目录；前缀提示是 CD2 的说法；复制开关禁用并说明原因；任务跑完 2/2，strm 内容 `/CloudNAS/115open/tv/…/BEEF.S01E01.mkv` |
| 任务弹框（115 账号，引擎 CD2） | 打开复制开关；「复制到哪」的选目录 | 说明按 CloudDrive2 说；选目录框「从 CloudDrive2 账号 nas-cd2 的根目录里选」 |
| 监控页 | 账号列表 | 只有 115 和夸克 |
| 窄屏（390px iframe）+ 浅色 | 账户页卡片、编辑弹框、设置页 CloudDrive2 一节 | 版式正常 |

冒烟里改掉的：

- 账户弹框加 `max-h-[90vh] overflow-y-auto`：CD2 那套字段加上校验提示后比矮屏幕高，原来会顶出视口。
- 账户弹框提交时每种类型只交自己的那几栏（`TYPE_FIELDS`）；编辑时没存过的字段补成空串，输入框不会从不受控变受控。
- 复制一节里「各网盘在 CD2 里的路径在上面的 CloudDrive2 一节填」改成「下面」（那一节在它下面）。
- 任务弹框远程路径的说明补上 CloudDrive2。
- 假服务按探测结果改了默认（令牌权限表不给读）之后重看了一次检查的 toast：只有地址、凭据、复制三行，和真机一致。

控制台没有报错或 React 警告。

## 真机记录（2026-11-10）

**环境**：ssm 上的 lab CD2（`cd2-lab` 容器，`cloudnas/clouddrive2:latest`，只绑 127.0.0.1:19798，这次带了 `CLOUDDRIVE_HOME=/Config`），本机 `ssh -L` 转发。用户在浏览器里登录、扫码加 115（`115open`）、加本地文件夹 `/local/hdd`（`hdd`）、生成 API 令牌（存在本机 scratchpad 的文件里）。lab 库：本机 `config/openstrm.db` 用 immutable 只读方式备份到 scratchpad，后端启动前先隔离——任务 / 追更 / 历史 / 监控事件 / 整理记录 / 缓存删光，只留 115 账号，Emby / Telegram / HDHive / PanSou / 智能体 / TMDB / 复制 / CD2 设置删掉，监控和检查更新关掉，云下载回执和各种游标删掉，口令换临时随机的；lab 后端 `127.0.0.1:4100`。

| 场景 | 结果 |
|---|---|
| **迁移 0030**：往这份老库（停在第 15 个迁移）里放一份 rc.2 形状的 `app.cd2`（地址 + 真令牌 + `{115: /115open}`），再跑迁移 | 15 → 31 个迁移全过；账号表多出 `cd2`（类型 cd2，地址、令牌原样，空的用户名口令没带过去）；`app.cd2` 变成 `{"account":"cd2","mounts":{"115":"/115open"}}` |
| 按迁移出来的账号「检查连接」（`POST /api/cd2/check { account: "cd2", mounts }`），没重填任何东西 | 四段全绿：连上了且 CD2 已登录、API 令牌可用、`/115open` 能列出来 13 个条目、能看传输任务。没有 `permissions` 一段（令牌读不了自己的权限表，和探测一致） |
| 目录浏览走通用接口（`/api/directory/remote/list`，账号 `cd2`） | 根下 `115open`、`hdd`；`/hdd` 下是探测留的 `probe` |

下面几步会动 115，先向用户说清了范围（只在新建的 `/lab1110` 里；测试文件是本机 ffmpeg 生成的 3 个 10 KB 视频 + 1 个字幕 + 1 个 nfo + 5 个小文本，共约 31 KB），用户：「好的，继续」。测试文件先由用户跑脚本经 ssh 放到 NAS 的 lab 文件夹（`/hdd/seed1110`），再经 CD2 的 CopyFile 传上 115。

| 场景 | 结果 |
|---|---|
| **放测试文件**：`CreateFolder` 建 `/115open/lab1110` 和子目录，`CopyFile` 把 10 个文件从 `/hdd/seed1110` 复制（上传）过去 | 17 秒，CD2 里 10 条复制任务全 completed，115 上 10 个文件大小都对 |
| **115 上的写操作表现**（`/lab1110/probe`，对照本地文件夹） | 和本地文件夹一样：CreateFolder 已存在回成功、父目录不在连父目录一起建；改名撞名 ALREADY_EXISTS(6)、源不存在 NOT_FOUND(5)；MoveFile 带 Skip 一批两个时撞名的原地不动、另一个照挪、回成功、`resultFilePaths` 空；单个撞名回成功什么都没动；MoveFile 的目标目录不在是 NOT_FOUND(5)；DeleteFile 文件和空目录都行。挪完之后不强制刷新和强制刷新列出来的一样（115 那头没有滞后） |
| **CD2 账号的任务**（`115open/lab1110/inbox` → 本地 `lab1110-cd2`，前缀 `/CloudNAS`）同步 | `5 files to download`，3.9 秒完成；3 个 strm 内容是 `/CloudNAS/115open/lab1110/inbox/…mkv`；字幕和 nfo 经 CD2 的下载地址下到本地，和原件逐字节一致 |
| **媒体探测**（直接调 `probeDriveFile`，经 Provider 的下载地址按 Range 读） | 两个测试视频都读出 `H.264 · 90p · AAC 1.0`（10 KB 整个读完，1 到 2.7 秒）；nfo 回「读到了文件头，但不是能识别的视频」 |
| **整理 · 预览**（lab 库没有 TMDB key，用「按本地 strm 结构」：先把本地 3 个 strm 改名挪进 `Lab Show (2024)/Season 01/`、`Lab Movie (2024)/`） | 2 个单元、7 项要动（建 3 个目录，挪 3 个视频 + 1 个同名字幕），0 冲突；`tvshow.nfo` 不同名、留在原处 |
| **整理 · 执行** | 6.1 秒，7 项全 done；115 上是新结构，本地 strm 内容和字幕跟着改了。先原地改名再 MoveFile、挪完按源所在目录核对这条路在真 CD2 上走通 |
| **整理 · 撤销** | 9.1 秒，7 项全退回；115 上和本地都回到同步时的样子，建出来的目录空了被删掉（`rmdirIfEmpty`）。撤销里「id 变了不算另一个文件」（`pathIds`）这条在真机上用到了 |
| **复制回归**（引擎 CD2，连接来自迁移出来的 `cd2` 账号）：115 账号的 lab 任务（`lab1110`）手动复制 `inbox/Lab.Movie….mkv`，默认目标 `/hdd/media` | 任务列表里 115 任务的 `copyBlocked` 是空、两个 CD2 账号任务是「OpenList / CloudDrive2 账号的任务用不着复制…」；登记后 31 秒提交 `/115open/lab1110/inbox → /hdd/media/inbox`（这个子目录原来不存在，CD2 引擎先建出来了），再 30 秒记 done；NAS 上文件 10259 字节 |
| 复制完，目标目录罩在一个 CD2 账号任务（`hdd/media`）下 | 没有可观察的动作，也不该有：发出去的 `files.landed` 是交给自动整理的，lab 里没有 TMDB key、任务的自动整理关着。事件发没发由 `cd2-engine.itest` 管。**这条我之前对用户说成了「顺带生成 strm」，是说错了**，已更正（方案、README、用例标题） |

**这次真机没验的**：

- 令牌限了根目录时路径怎么写（令牌没限，权限表也读不到）。
- 故意少勾权限时各处的报错（要另一个少勾的令牌）。
- 用用户名口令登录 CD2（要用户自己在界面里填）。
- 整理冲突里选「删掉这一份」这条界面路径：删除本身在探测里直接调过（`DeleteFile` 文件 / 空目录 / 非空目录都成）；进不进 115 回收站没法从 CD2 这头看，要用户在 115 里看一眼（这次删掉的 `delete-me.txt` 和整个 `/lab1110`）。
- 几百个目录的任务全量同步要多久：没有专用的大目录，没拿用户的真实片库去量。lab 里 5 个文件、2 层目录是 3.9 秒。
- 账户页 / 设置页对着真 CD2 的界面操作：界面用假 CD2 冒烟过，真机走的是同一批接口（迁移出来的账号、检查连接、目录浏览、建任务、同步、整理、复制都是接口驱动）。

**一处过程上的事**：复制回归那条命令第一次跑到一半被用户打断（工具调用记成被拒），但脚本已经把复制登记进去了，lab 后端照常把它跑完；之后再跑同一个脚本看到的是「目标里已经都有了」。被打断的调用可能已经做了一半，重跑前要先看现状。

**收尾（2026-11-10，用户：「真机测试做完之后不用review，直接停掉然后把实验环境都删除」）**：

- 115：`/lab1110` 先核对里面只有这次的 16 个条目，再经 CD2 `DeleteFile` 整个删掉（一次调用，非空目录也删得掉）；强制刷新列根目录回到 13 项。删掉的东西应该在 115 回收站里。
- ssm：`docker rm -f cd2-lab`、`docker rmi cloudnas/clouddrive2:latest`、`rm -rf /root/cd2-lab`（这次带了 `CLOUDDRIVE_HOME=/Config`，CD2 的登录状态、115 授权、API 令牌都在这个目录里，随它一起没了）、`rm -rf /mnt/hdd/cd2lab`（probe / seed1110 / media，共 31 个小文件）；核对过容器、镜像、两个目录都不在，19798 没人听。
- 本机：lab 后端（4100）、端口转发、监视脚本都停了；scratchpad 里的 lab 库（含 115 cookie 的拷贝和 CD2 令牌）、令牌文件、临时口令、脚本、日志、临时测试库全删了。浏览器里冒烟用的标签页早先已关、登录 token 已清。
- 单文件测试时 `mktemp -d` 在系统临时目录里留下的 25 个一次性测试目录（里面只有测试用的 config / data，没有真实凭据）：按通配批量清被权限规则拦了两次（不让扫共享临时目录、不让用变量拼出来的路径 `rm -rf`），最后逐个核对内容、用字面量绝对路径点名删掉。那里剩下的 4 个 `tmp.*` 是 11-09 的空目录，不是这次建的，没动。下回单文件测试的临时库直接放 scratchpad。
- 115 回收站：`/lab1110` 走的是 115 的普通删除（这个项目里所有删除都是这样），网盘上已经没有了，回收站里还留着这次的两项（`lab1110` 文件夹和探测时删的 `delete-me.txt`）。问了用户怎么处理（留着 / 用户自己清 / 我来彻底删），用户选「留在回收站」，没再动。
- 收尾后复查（2026-11-11 又完整查了一遍）：scratchpad 0 个条目；在会话临时目录、系统临时目录、`/tmp`、仓库里按名字找 lab 库拷贝 / 令牌文件 / 临时口令 / 实验脚本，都没有；除仓库自己的 config 外没有这两天建的 openstrm 库文件；没有实验进程（之前有一行匹配到的是执行检查命令的 shell 自己，PID 已不在；换成不会匹配到自己的写法是 0 个）；3223 / 4100 / 19798 没人听；ssm 上容器、镜像、`/root/cd2-lab`、`/mnt/hdd/cd2lab` 都不在。浏览器里冒烟用的 `127.0.0.1:3223` 这个来源的本地存储也清了（剩下的那一个键是浏览器扩展留的标记，不是登录 token）。
- 评审没做（用户要求）。代码都还在工作区，没提交。

**最后的验证（2026-11-10，真机之后又改了几处注释、假服务里移动目标不在的回法、README 那句更正）**：后端全量 1821 / 1821，后端 lint、三个包的 typecheck 过，前端 24 / 24、lint 过、`next build` 静态导出成功，`scripts/check-hygiene.sh` ok。

## 发布（阶段 3，2026-11-11）

用户：「发个rc」。提交前在根目录跑了 `pnpm typecheck && pnpm lint && pnpm test`（后端 1821 / 1821，前端 24 / 24）。评审没做（用户前一天的要求）。

`ed2cc54` feat(cd2)（阶段 3 的代码、测试、迁移 0030、README）→ `b7cf971` docs(plans)（方案 + drive-notes）→ `5521b03` chore(release): v2.26.0-rc.3（三个 package.json 从 2.26.0-rc.2 升到 2.26.0-rc.3，shared 仍 2.0.0）；tag `v2.26.0-rc.3`（注释 v2.26.0-rc.3），`git push origin v2 v2.26.0-rc.3`（14:41 UTC），main 没动（仍 == v2.25.0 5f1d88b）。**带迁移 0030**（纯数据：rc.2 里填过地址的 `app.cd2` 变成一个 `cd2` 账号，设置里只留账号名和映射）。接着 rc.1（OpenList 刷新）、rc.2（CD2 刷新 + 复制引擎）在 2.26.0 这条线上出的第三个 rc。

工作流：CI（Typecheck and tests、Docker image）和 Release（Typecheck, lint and tests / Build amd64 / Build arm64 / Merge manifest and release）全 success，14:53 UTC 完成，推送到全绿 12 分钟。GitHub Release `v2.26.0-rc.3` 是 prerelease，仓库的 latest release 仍是 v2.25.0。Docker Hub `indown/openstrm:v2.26.0-rc.3` digest `sha256:53ddb465e7e9e3b04fe28019b45e0bf30b42f7254d0bbe9e73aebf69596d88f8`（amd64 + arm64，14:52 推上），`latest` 仍是 v2.25.0 的 `sha256:c7aa598bd933…`，没动。

升级说明交用户手动贴，草稿要点：

- 新增：账户页多一种 CloudDrive2 账号（地址 + API 令牌，或用户名口令），CD2 里挂的任何云盘都能建同步任务、浏览目录、整理；没有分享转存、追更、网盘监控、云下载、302。
- 设置页「CloudDrive2」一节不再填地址和凭据，改成选账号。rc.2 里填过的升级时自动变成一个叫 `cd2` 的账号（带迁移 0030），不用重填；回滚要连库一起退。
- CD2 任务同步时每个目录都让 CD2 重新向网盘要一遍；整理直接经 CD2 改网盘，冲突里选删除走 CD2 的普通删除。
- 复制引擎选 CD2 时，目标目录在某个 CD2 账号任务目录下的，复制完把新文件交给那个任务的自动整理（和 OpenList 引擎一样）。
- 令牌权限按用途勾，叫法改成和 CD2 界面一致：浏览「列出文件」；同步再加「读取文件」；整理再加「创建文件夹」「重命名」「移动」「删除」；复制引擎要「复制」「获取传输任务」「创建文件夹」（最后一项是新要求：复制到还不存在的子目录要先建目录）。
- 「检查连接」平时验地址、凭据和「获取传输任务」；按用途列缺哪项权限只有带「令牌管理」权限的令牌才看得到。

待办：用户把 ssm 上的 openstrm 换到这个 tag，用自己的 CD2 走一遍（账户页那个自动迁移出来的 `cd2` 账号、建 CD2 任务、整理）；rc.1 的 rclone 挂载那条也还没用真片验；v2.26.0 转正等用户。

## 发布（v2.26.0 正式版，2026-11-11）

用户在 rc.3 发出半小时后：「发个正式版吧」。没有等 ssm 上的真片验证（rc.1 的 rclone 挂载、rc.2 / rc.3 的 CD2 都只在 lab 上验过），是用户定的。

工作区是干净的，没有压着的方案记录。先把三个 package.json 改成 2.26.0，在这份代码上跑了 `pnpm typecheck && pnpm lint && pnpm test`（后端 1821 / 1821，前端 24 / 24），再提交。

`d294614` chore(release): v2.26.0（三个 package.json 从 2.26.0-rc.3 改成 2.26.0，shared 仍 2.0.0）；tag `v2.26.0`（注释 v2.26.0），`git push origin v2 v2.26.0`，然后 `git branch -f main v2 && git push origin main`：main 从 `5f1d88b`（v2.25.0）快进到 `d294614`，15:15 UTC。main == v2 == v2.26.0。

这一版相对 v2.25.0 带的东西（14 个提交）：

- `8492f60` feat(openlist)：改动网盘后让 OpenList 刷新目录缓存（rc.1，方案在 `openlist-cache-refresh.md`）。
- `00bc7a4` feat(cd2)：CloudDrive2 当目录缓存刷新目标和复制引擎（rc.2）。
- `ed2cc54` feat(cd2)：CloudDrive2 做成账号类型，带 Provider（rc.3）。
- 其余是 docs(plans) 和三个 rc 的版本号提交。
- **迁移 0030**（纯数据）。从 v2.25.0 直接升上来的库里没有 `app.cd2`，这条迁移什么都不做；用过 rc.2 的才会被搬成 `cd2` 账号。

工作流：CI@v2、CI@main（各自 Typecheck and tests、Docker image）和 Release（Typecheck, lint and tests / Build amd64 / Build arm64 / Merge manifest and release）全 success，15:27 UTC 完成，推送到全绿 12 分钟。GitHub Release `v2.26.0` 不是 prerelease，是仓库的 latest release。Docker Hub `indown/openstrm:v2.26.0` 和 `latest` 同为 `sha256:20801a6b967df57fadd862a28d5146ae7ae799a4ba811851b0a4868aaa0f10bb`（amd64 + arm64，15:26 推上）。

升级说明交用户手动贴，草稿要点（相对 v2.25.0）：

- 新增「改动网盘后刷新挂载层的目录缓存」：整理、转存、追更、云下载、监控到的改动、复制后删源 / 归档之后，让 OpenList 或 CloudDrive2 刷新改过的目录，经它们挂载回源的不用等缓存过期。OpenList 那边复用「复制到 OpenList」里的账号和挂载根，CD2 那边在设置页「CloudDrive2」一节选账号、填各网盘在 CD2 里的路径；没配的不受影响，配了的会多几次列目录请求。
- 新增 CloudDrive2 账号类型：账户页填地址 + API 令牌（或用户名口令），CD2 里挂的任何云盘都能建同步任务、浏览目录、整理；没有分享转存、追更、网盘监控、云下载、302。
- 复制可以改用 CloudDrive2：设置页「复制到 OpenList / CloudDrive2」里「用哪个复制」，默认仍是 OpenList，老用户不用改配置。
- 令牌权限按用途勾（叫法同 CD2 界面）：浏览「列出文件」；同步再加「读取文件」；整理再加「创建文件夹」「重命名」「移动」「删除」；复制引擎要「复制」「获取传输任务」「创建文件夹」。
- 带迁移 0030；回滚要连库一起退。用过 rc.2 的：设置页里填的 CD2 地址和凭据升级时自动变成一个叫 `cd2` 的账号。

没验过、留给用户反馈的：真实片库上 rclone 挂载跟上 OpenList 刷新的效果；CD2 令牌限根目录、少勾权限、用户名口令登录；CD2 大库全量同步的耗时。阶段 3 没做评审。
