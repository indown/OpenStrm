# 复制到 OpenList：从「云下载专属」变成通用的后续动作（设计）

> 状态：**三个阶段已实施**（`55ebe6c` / `2852933` / `f534d20`，未推送、未发版；末节有实施记录和和设计稿不一样的地方）；**2026-09-22 真机验证过**，真机暴露的两个大问题和一批小问题已修（见末节「真机验证」，改动在工作区，未提交）。2026-09-22。起因：用户问「复制到 OpenList 是不是可以优化一下了」，并确认四个方向都要，外加「不止 115，夸克、以后接入的网盘都能触发复制」。

## 现状

配置 `settings.openlistCopy`（`packages/shared/src/types/settings.ts:120`）：一个 OpenList 账号 + `srcDir`（115 默认下载目录**在 OpenList 里的完整路径**，手打）+ `dstDir`（目标目录，手打）。

能用它的只有一条路：云下载页添加任务、**且下到 115 默认目录**（不选任务、不选目录）时勾「下载完成后让 OpenList 复制走」。别的一律拒绝：

```ts
// services/offline/service.ts:329
if (opts.copyToOpenlist) {
  if (task || dirId != null) throw new HttpError(400, "「复制到 OpenList」只支持下载到 115 默认目录");
```

之后的机制是对的，值得整个搬走复用（`services/offline/service.ts:647 submitOpenlistCopy` / `:698 pollOpenlistCopies`）：

- 115 下完 → 带 `refresh:true` 列 `srcDir`（不刷新看不见刚下完的文件）→ 产物名出现了才提交 `/api/fs/copy`；没出现不算失败，最多等 10 轮（`copyWaits`，和「115 列表里找不到任务」的 `misses` 分开计）。
- `/api/fs/copy` 对目录是「父任务展开子任务」，父任务结束只代表列目录完成，真正的进度在 `/api/task/copy/undone|done` 里，所以要一直盯到 undone 里没有自己的任务，再去 done 里对成败（按 `endedAt` 滤掉陈年同名任务）。
- 回执落在 settings 表的 `offline.followups` 键，重启不丢；7 天没结果就放弃；提交失败重试 3 次。

**四个短板**（对应用户点的四项）：

1. 只认 115 默认目录。根因是 `srcDir` 是一条手打的死路径，没有「网盘路径 → OpenList 路径」的换算。
2. 只有云下载能触发。转存 / 追更 / 网盘监控落下的新文件都没法复制走。
3. 复制完只发一条 Telegram（`notify({type:"offline-copied"})`），Emby 不知道、源文件留在网盘上。
4. 复制失败只能重下 115 任务（`offlineRestart`），没法单独重试复制。

还有一条用户明确提的：**不止 115**。夸克、以后的网盘都要能触发。现在这套只存在于 `offline/service.ts` 这条 115 专属的流水线里。

## 关键缺口：网盘路径 ↔ OpenList 路径

`DriveProvider`（`services/drive/types.ts:89`）有 `resolvePath` / `listDir` / `listSubtree` / `write`，但**没有任何东西知道这个网盘挂在 OpenList 的哪个路径下**；`AccountInfo` 里也没有。全站唯一的映射就是那条 `srcDir`。

所以第一件事是把映射补成配置：

```ts
export type OpenlistCopySettings = {
  account?: string;                    // 用哪个 openlist 账号调 API（不变）
  dstDir?: string;                     // 默认目标目录（不变）
  /** 网盘账号名 → 它在 OpenList 里的挂载根，例如 { my115: "/115", quark1: "/quark" } */
  mounts?: Record<string, string>;
  /** 复制成功后把网盘上那份删掉（搬运）。默认 false */
  deleteAfterCopy?: boolean;
  srcDir?: string;                     // 旧字段，只给「115 默认下载目录」那条路兜底，见「迁移」
};
```

有了 `mounts`，任意网盘路径都能换算：`openlistPath = mounts[account] + 网盘绝对路径`。115 挂在 `/115`、任务目录是 `/tv`，那么 `/tv/某剧/S01E01.mkv` 在 OpenList 里就是 `/115/tv/某剧/S01E01.mkv`。夸克、以后的网盘同理，功能代码里不出现 `accountType === "…"`（`services/drive/types.ts:1` 的规矩）。

**为什么放设置里而不是账号表**：挂载点是「这个网盘在那个 OpenList 实例里的位置」，是两个账号之间的关系，不是网盘账号自己的属性；而且复制功能本来就只认一个 OpenList 账号（`openlistCopy.account`），放一起改一处就够，也不用动 `AccountInfo` 和账号页。

**界面**：设置页「复制到 OpenList」里，账号下面列出所有 115 / 夸克账号，每个给一行挂载根（`InputGroup` + 浏览按钮，直接从那个 OpenList 账号的根目录挑，`api.directory.remote`）。填完点「检查」：列一遍 `mounts[account]`，把这个账号下每个任务的 `originPath` 拼上去验证存在，不存在就指出是哪一条。

## 方案

### 1. 把复制抽成一个服务：`services/copy/service.ts`

从 `offline/service.ts` 里搬出来，改成不认来源、只认「网盘账号 + 一批网盘绝对路径 + 目标目录」：

```ts
export interface CopyRequest {
  account: string;        // 网盘账号名（115 / 夸克 / …）
  paths: string[];        // 网盘绝对路径，文件或目录
  dstDir?: string;        // OpenList 目标目录；不给用设置里的 dstDir
  taskId?: string;        // 有任务就记上，界面和「整理挪目录」时要用
  trigger: CopyTrigger;   // "offline" | "share" | "follow" | "monitor" | "manual"
}
/** 登记待复制；同步返回，内部排队，绝不往调用方抛 */
export function enqueueCopy(req: CopyRequest): void;
```

队列记录落 settings KV 的新键 `copy.queue`（`db/keys.ts`），形状照着 `OfflineFollowup`（`offline/service.ts:66`）：`{ id, account, srcPath, name, dstDir, taskId, trigger, status, detail, attempts, waits, misses, copyTaskId, submittedAt, addedAt }`。一个 `createPollingLoop`（30 秒，没待办自己停）负责推进，阶段和今天完全一样：**等产物在 OpenList 里可见 → 提交复制 → 盯任务 → 成败落地**。云下载那条流水线改成只管登记，不再自己做复制。

去重靠 `(account, srcPath, dstDir)`：队列里已经有同一条待办就不重复登记（监控会对同一个文件反复报事件）。提交前再列一遍目标目录，已经有同名的就跳过记「目标已存在」——`/api/fs/copy` 的 `overwrite` 一直是 `false`，不拦的话 OpenList 那边会堆同名任务。

**合并**：同一轮里同一个源目录下的多个名字合成一次 `/api/fs/copy`（`openlistCopy(account, srcDir, dstDir, names[])` 本来就收数组）。监控是一个文件一个事件，不合并会把几百个文件排成几百个任务。

### 2. 四个触发点

都在「新文件已经落到网盘上」那一刻，和 `maybeAutoOrganize` / `scheduleEmbyRefresh` 并排，一样是 `void`、失败只记日志：

| 来源 | 接在哪 | 已有的路径信息 |
|---|---|---|
| 云下载 | `offline/service.ts:629` 旁边（strm 回执完成处）；默认目录那条保持现在的即时登记 | `task.originPath` + `f.subPath` + 产物名 |
| 转存 | `share/receive.ts:107` 旁边（`maybeAutoOrganize` 已经在那儿算好 `paths`） | `fullOriginPath` + 每个 `item.name` |
| 追更 | `follow/service.ts:575` 旁边，用现成的 `landed`（任务相对路径） | `task.originPath` + `landed[]` |
| 监控 | `life/monitor.ts:389` 旁边，同样守 `res.arrived && res.changed` 和 `ownOk`（整理自己造成的事件不能再复制一遍） | `ev.path` 就是网盘绝对路径 |

监控那条沿用 `maybeAutoOrganize` 的 `debounce`（30 秒）思路：攒一会儿再登记，正好也让上面的「同源目录合并」生效。

### 3. 开关：任务级 + 一次性覆盖

照抄 `organize` 的那套（`TaskDefinition.organize` → `taskInputSchema` → `AddTaskDialog`，见 `services/organize/settings.ts:81`）：

```ts
// packages/shared/src/types/task.ts
copyToOpenlist?: { enabled?: boolean; dstDir?: string };   // dstDir 不填用全局的
```

- 任务弹框里一个开关 +（开了才出现的）目标目录选择器，说明写「转存 / 追更 / 云下载 / 监控到新文件时，让 OpenList 把它复制到这里」。
- 一次性覆盖：转存弹框、`POST /api/share`、`POST /api/library/:id/save-to-task` 加 `copy?: boolean`，和现有的 `organize?: boolean` 同一个位置、同一套写法。
- 全局前提缺失（没配 OpenList 账号 / 这个网盘账号没填挂载根）→ 一律当关，和「没配 TMDB key 就不自动整理」（`organize/auto.ts:59`）一个路子。
- 任务存的是 JSON blob（`db/repositories/tasks.ts:8`），**不用迁移**。

### 4. 复制完之后

按顺序，每一步失败都不影响前一步的「已复制」：

1. `scheduleEmbyRefresh()`——复制到本地盘的就是真文件，Emby 得扫一遍才看得见。
2. 目标目录正好落在某个 **OpenList 账号任务** 的 `originPath` 下时，按那个任务的策略 `maybeAutoOrganize({ task, paths, trigger: "copy" })`。落在别处（纯备份目录）就不整理。
3. `deleteAfterCopy` 开着时，删掉网盘上那份——**走 Provider 的 `write.remove`**（`services/drive/types.ts:86`），不走 OpenList 的 `/fs/move`：OpenList 的移动不跨存储，而且删源必须用网盘自己的接口才准。只有 `status === "done"` 且目标目录里确认看得见同名条目才删。
4. `notify`：现有的 `offline-copied` / `offline-copy-failed` 改成通用的 `copy-done` / `copy-failed`（带 trigger 和任务名），旧的两个保留一轮以免 Telegram 设置里的开关语义突变。

### 5. 失败能重试

- 新路由：`GET /api/copy`（最近的队列记录）、`POST /api/copy/:id/retry`（失败的重新排队，计数清零）、`DELETE /api/copy/:id`（不跟了）。
- 界面：云下载页现在那行 `FollowupLine`（`app/offline/page.tsx:627`）照旧显示，失败时多一个「重试复制」按钮；任务卡片上显示「复制中 N / 失败 N」，点开是同一个列表。
- 失败原因写全：OpenList 那边的 `error` 原文 + 我们这边的阶段（没看见产物 / 提交失败 / 复制失败 / 目标已存在）。

### 6. 整理挪了目录怎么办

队列里带 `taskId` 的待办记的是网盘绝对路径，整理会在网盘上改名 / 移动。照 `rewriteOfflineSubPaths`（`offline/service.ts:759`）和 `rewriteFollowSubPaths`（`follow/service.ts:641`）再写一个 `rewriteCopyPaths(taskId, mappings, dryRun)`，接在整理执行完的同一处。

## 迁移

`mounts` 是新键，`dstDir`、`account` 不动。唯一尴尬的是 `srcDir`：它是「115 默认下载目录在 OpenList 里的完整路径」，从它反推不出挂载根（不知道默认目录在 115 上的路径是什么）。

两条路，**建议第一条**：

1. **查一次 115 的默认下载目录路径**（`offlineDownPaths` 给的是 id + 名字），有了它就能从旧的 `srcDir` 反推出挂载根，自动填进 `mounts`，`srcDir` 随后作废（`0017_*.sql` 照 `0007_drop_retired_settings.sql` 的样子删键）。
   **前提没验**：`fsFiles` 现在只取了响应里的 `data` / `count`（`services/cloud-115/client.ts:342`），115 的文件列表接口是不是真带祖先链（`path: [{file_id,file_name}…]`）要先打一次接口确认；确认不了就直接走第二条，别为它硬凑。
2. 反推不了就保留 `srcDir` 只服务「下到 115 默认目录」这一条老路，设置页标成「旧配置」，新装的人只填 `mounts`。

无论哪条，**已经配好的人升级后不能失效**：`mounts` 空 + `srcDir` 有值时，默认目录那条照旧工作。

## 分阶段

1. **打底**：`mounts` 配置 + 设置页那一节重做（挂载根 + 检查按钮）+ `services/copy/service.ts`（队列、循环、去重、合并）+ 云下载改成调它、解除「只能默认目录」+ 重试路由和按钮。这一阶段做完，115 和夸克的云下载 / 任意目录都能复制走。
2. **铺开**：任务级开关 + 转存 / 追更 / 监控三个触发点 + 一次性覆盖参数 + 任务卡片上的状态。
3. **收尾**：复制完 Emby 刷新、落在 OpenList 任务里就自动整理、`deleteAfterCopy`、通知事件改名、`rewriteCopyPaths`。

## 不做

- **多个 OpenList 账号同时当目标**：复制功能仍然只认一个 `openlistCopy.account`。真有两个目标的需求再说。
- **OpenList → 网盘 的反向复制**：现在没有场景。
- **覆盖同名**：`overwrite` 保持 `false`，撞名就跳过并记原因，不悄悄盖掉别人的文件。
- **按文件类型过滤**：先整目录 / 整条目复制；要不要只复制视频文件等做完一轮再看。

## 风险

- **夸克的可见性延迟**比 115 更没谱（监控那边本来就是靠轮询对比），`copyWaits` 的轮数可能要按网盘分开配；先沿用 10 轮，真机验的时候盯这个数。
- **监控 + 自动整理同时开**：整理会把文件挪走，队列里的路径可能在复制前就失效。靠 `ownOk` 守住整理自己造成的事件 + `rewriteCopyPaths` 跟着改；真机要专门验「监控到新文件 → 自动整理 → 复制」这条串起来的顺序。
- **大目录**：一个目录几百个文件时 OpenList 会展开成几百个子任务，`/api/task/copy/undone` 一轮拉回来的量不小；按名字匹配（`r.name.includes(f.name)`）在同名文件多的时候可能串味，阶段一就把匹配改成「父任务 id + 提交时间窗」双条件。
- **删源**（`deleteAfterCopy`）是不可逆的，默认关，界面上要说清「复制成功且目标里确认看得见才删」，并且第一版只对「整条目复制」生效，不对单文件事件生效。

## 测试

- 单测：路径换算（`mounts` + 网盘路径 → OpenList 路径，含中文、空格、结尾斜杠）、去重、同源目录合并、`rewriteCopyPaths`。
- 假 OpenList：给 `Deps.openlist`（`offline/service.ts:150` 已有这个注入口，搬过去继续用）写一个假实现，覆盖「产物迟迟不可见」「父任务展开子任务」「done 里有陈年同名任务」三种。
- FakeDrive 覆盖 `write.remove`（删源）那一步。
- 真机：115 + 夸克各跑一遍「转存 → 复制 → Emby 刷新」，以及「监控到新文件 → 复制」。

## 实施记录（2026-09-22）

三个阶段一口气做完，三个提交，都在 v2 上（未推送、未发版）：

| 提交 | 内容 |
|---|---|
| `55ebe6c` | 挂载映射 + `services/copy`（`paths.ts` / `queue.ts` / `service.ts`）+ 云下载改成交接 + `/api/copy` + 设置页一节重做 + 云下载页的队列面板 |
| `2852933` | 任务级开关（`TaskDefinition.copyToOpenlist`）+ 转存 / 追更 / 监控三个触发点 + 一次性勾选 |
| `f534d20` | 复制完：Emby 刷新、目标落在 OpenList 任务里就自动整理（`trigger: "copy"`）、按任务删源、通知改名、`rewriteCopyPaths` |

**和设计稿不一样的几处**（都是评审 / 实现时发现的）：

- **目标目录按层级摆，不是平铺**。设计稿只说了 `dstDir`，但监控是一个文件一条事件，平铺过去一季四十集会挤进同一个目录还撞名。`CopyRequest` 因此多了 `rootPath`（通常是 `task.originPath`），`dstDirFor` 把相对那一段的目录结构原样搬到目标下面。
- **提交前先 `mkdir`**：`/fs/copy` 不会自己建目标目录。
- **源目录在 OpenList 里不存在 → 第一轮就失败**（挂载根填错了），和「产物还没出现」（等 10 轮）分开。两个计数器 `waits` / `misses` 各管一个阶段，换阶段清零对方。
- **保留期拆开**：失败留 7 天、办完留 2 天、上限 500 条。监控一个文件一条记录，共用一个窗口的话一批成功会把唯一能动手的失败记录挤掉。
- **合批在 tick 里做，不在登记时 debounce**：登记就落 KV（进程被杀不丢），`SETTLE_MS = 10s` 只是让同目录的兄弟文件凑进同一批。
- **删源核对 nodeId**：整理可能已经把文件挪走、原路径上换成了另一个同名文件，只按路径删会删错。
- **追更给转存传 `copy: false`**，自己按整轮的新增登记一次，来源才显示成「追更」而不是「转存」。
- **`resolveDirPath` 做成了 offline 的注入点**：`handoffCopy` 要把 115 的目标目录 id 反解成路径，测试里不能打接口。

**验证**：后端 990 个测试全过（新增 43 个：`copy.itest.ts` 31、`paths.test.ts` 7、路由 4、监控 2、追更 1、crud 1，外加云下载那边重写的几条）、三包 tsc / eslint、`next build` 都过。本机用一个假 OpenList（`http.createServer`，实现 login / fs.list / fs.mkdir / fs.copy / task.copy.undone|done）在浏览器里走通了整条链路：设置页填挂载根 → 「检查这些目录」通过 → 队列面板显示失败记录 → 点「重试复制」→ 列源目录、建目标目录、提交复制（`names: ["E01.mkv"]`、`overwrite: false`）→ 盯任务 → 「已复制」，循环自己停。任务弹框的开关、目标目录、删源三件也在浏览器里看过。

**还没验的**：真机（真 115 / 夸克 + 真 OpenList）；转存 / 追更 / 监控三个触发点只有 itest，没在真机上跑过；旧 `srcDir` → 挂载根的自动换算没有真 115 账号可验（逻辑有测试，接口那步没有）。

### 两轮评审的修补（2026-09-22，同日）

三个提交做完之后自查了两轮，21 条全部修完（按仓库惯例不留「收益小」的尾巴）。按危害排：

**会丢数据 / 丢活儿的**

- **队列的读—改—写夹着网络等待**：一轮 tick 里要 await 好几秒的 OpenList 调用，期间监控 / 转存随时往同一个键里加记录、界面也可能删记录，原来「开头读一份、结尾整份写回」会把期间别人写的整片抹掉。循环里的改动改走 `commitCopies(changed)`：重读、按 id 合并、再写；`queue.ts` 开头写了这条硬要求。
- **`persist()` 把 `touched` 清空了**：一轮里分多组提交，第一组 persist 之后集合被清掉，后面几组的改动就再也没写回去。集合改成只进不清，每次 persist 全量合并。
- **裁剪把能动手的失败记录挤掉**：监控是一个文件一条记录，一季四十集成功之后，共用一个 500 条窗口会把唯一还能重试的失败记录冲走。改成三桶：pending 不限（限了会把已经提交给 OpenList 的挤出去，那些复制就再没人跟了）、失败 7 天 / 200 条、办完 2 天 / 500 条。
- **云下载回执谎报兑现**：`enqueueCopy` 原来返回 `void`，队列没收下（配置被删、挂载根没填）时回执照样记「已交给复制队列」，这次复制既不在队列里也没人知道它没了。改成返回 `{ queued, skipped }`，`handoffCopy` 据此把回执判失败。
- **没有目标目录时复制到根**：设置里的默认目标目录和任务上的都为空时，`dstDir` 算出来是 `/`。改成登记直接拒绝并说明原因。
- **删源只看名字在不在**：OpenList 一开始就把目标目录建出来了，里面可能一个文件都没搬完。`verifyCopied` 对目录再比一层子项名，缺一个就不删；`adopted`（升级前接管、不知道源在哪）的一律不删。
- **任务级开关被设置页的值绕过**：`copyOptionsFor` 里删源只在任务自己的开关打开时才生效。

**认错对象 / 状态机**

- 两条记录按任务名互相抢结果 → `claimed` 集合避开别人明确认领的 id；`adopted` 的 `taskKey` 返回空串，只按 id 认。
- 提交一批后按位置绑任务 id，只在「回来的任务数 == 提交的名字数」时才绑，否则全部按名字认。
- 手动点过「重试」之后，目标里已有同名不能再悄悄跳过（`retried` 标记，改成如实失败）。
- `rewriteCopyPaths` 只改了目录没改文件名（整理改名之后永远等不到那个文件），目标目录也停在改名前的层级 → 名字一起改、`dstDir` 按 `dstBase` 重算。这个函数原来零覆盖，补了 `queue.test.ts`。
- `normDir` 会 trim，网盘上以空格结尾的目录名会被改坏 → 只有手打的设置值走新的 `normConfigDir`，网盘路径一律不 trim。

**通知 / 界面 / 其它**

- 一个文件一条通知 → 一轮合成一条（成 / 败各一条，多了写「等 N 个」），Telegram 那边不会因为限流把后面的整片丢掉；失败**一定发**，四个触发点都是没人看着的后台活儿。
- `GET /api/copy` 读了两遍队列、还把全部记录发给只显示 20 条的面板 → 读一遍、`limit` 默认 50、带 `total`。
- 面板轮询抖一下就整块消失 → 留着上一份、旁边写一句。
- 设置页挂载根那一行缺 key（浏览器控制台有 React 警告）。

**补的测试**：`queue.test.ts`（11 条，裁剪 / 合并 / 去重 / 改路径）、`remove-source.itest.ts`（7 条，删源走真的 Provider + FakeDrive，覆盖 nodeId 对不上、目录没复制全、网盘报错、没开开关四种不删的情形）；`copy.itest.ts` 里「done 里的陈年同名任务」那条原来根本没走到 `endedAt` 过滤（任务名对不上，靠「找不到」通过的），改成名字能对上、只靠结束时间区分。

**验证**：`pnpm test` 1017 个全过、三包 tsc / eslint、`next build` 都过。

## 真机验证（2026-09-22）

用户说「真机验证一下」。

**环境**：本机 Docker 起一个 OpenList（v4.2.6）当实验品，挂三个存储——`/115`（115 Cloud 驱动，用 `config/openstrm.db` 里 115 账号的 cookie）、`/quark`（Quark 驱动，夸克账号的 cookie）、`/local`（Local 驱动，挂到 scratch 目录，当复制目标）。后端跑在 `config/openstrm.db` 的只读拷贝上（4100，只监听 127.0.0.1）：生产任务、HDHive 全删，Telegram 换成假 token + `TELEGRAM_API_BASE` 指到本机假服务（记下每条 sendMessage），Emby 指到本机假服务（记下 `/Library/Refresh`），监控按 latest 模式只看启动之后的事件。前端 dev 3223。115 根下建 `/copylab115`、`/copylab115-staging`，夸克根下建 `/copylabqk`，都在生产任务目录之外。测试视频用 ffmpeg 造（200 多 KB）；夸克那边用之前给过的测试分享（一集 900 MB 左右，OpenList 从夸克拉约 2.3 MB/s）。本机配置库里的 TMDB key 是两个空格，整理识别靠目录名里的 `[tmdbid=…]` 标签 + 往 scratch 库的 `tmdb_cache` 里预置那部剧的详情和第一季。

**走通的（都在真网盘 + 真 OpenList 上）**：

| 场景 | 结果 |
|---|---|
| 旧配置换算 | 库里只放 `srcDir: /115/云下载`、不放 mounts，启动时真 115 查到默认下载目录是 `/云下载`，换算成 `115 → /115`，srcDir 删掉 |
| 接管在途的复制 | 启动前先让 OpenList 真提交一个复制，库里造一条老版本的 `openlist-copy` 回执指着它的任务号；启动时接管、盯到完成 |
| 设置页 | 挂载根行、浏览 OpenList 目录选挂载根、保存 |
| 网盘监控（115） | 发布目录从 staging 挪进任务目录：监控 5 秒内看到、生成 strm、登记一条目录复制；OpenList 展开成父任务 + 两个子任务，全部完成，md5 一致；Telegram「已复制到 OpenList（网盘监控）」，30 秒后 Emby 刷新 |
| 转存（夸克） | 分享弹框只勾一集 + 一次性勾「转存后复制」（任务开关关着）：登记带夸克给的顶层 fid，906 MB 复制完大小一致、ffprobe 正常 |
| 追更（夸克）+ 删源 | 订阅建好后从 known 里删掉 EP08 模拟分享者新增，前三次检查按服务端信号跳过（设计如此），第四次转存 EP08 → 复制 → 目标里确认看得见 → 夸克上删进回收站；夸克监控下一轮看到新增不重复登记（去重），再下一轮看到删除把本地 strm 清掉 |
| 云下载（115） | 云下载弹框下到任务目录（任务开着复制）：115 真下完 → 生成 strm → 按任务自己的目标目录登记 → 复制完成，md5 和原始 URL 一致 |
| 失败 + 重试 | 挂载根改成 `/115x`：第一轮就失败、说清是挂载根，Telegram 发失败通知；改回来点「重试复制」→ 完成 |
| 复制完自动整理（目标侧） | OpenList 任务 `originPath=/local/lib115`、自动整理「把握大的直接执行」：复制完 30 秒建 trigger=copy 的 run，按 id 标签识别，在 OpenList 本地存储上改名进 `人生切割术 (2022) [tmdbid=95396]/Season 01/` |
| 监控 → 源侧自动整理 → 复制（设计稿「风险」里点名要验的） | 见下面修好之后那一节 |

**真机暴露的问题**（按危害排；全部已修，见下一节）：

1. **OpenList 的父目录缓存让「新建 / 改过名的目录」被当成挂载根填错**。发布目录在 115 上改了名，下一集的复制第一轮就失败：「OpenList 里没有 /115/copylab115/Severance.S01.1080p [tmdbid=95396]，检查一下账号 115 的挂载根填对没有」，还发了失败通知。手工复现：直接刷新子目录 `object not found`，父目录缓存里还是旧名字，刷新父目录之后子目录立刻能列。凡是 OpenList 之外在网盘上新建 / 改名的目录都会中：转存 / 追更存进新建的子目录、整理建的作品目录和季目录、用户在网盘 App 里改的名。
2. **源侧自动整理和复制互相不认账**。设计稿说「靠 rewriteCopyPaths 跟着改」，实际只喂了目录级映射（`dirMappings`：只有发布目录被整个腾空删掉才有），最常见的「一集挪进作品目录、顺手改名、发布目录里还剩别的集」根本没有映射，队列里还是旧路径，等 10 轮后失败。转存 / 追更 / 云下载是立刻建整理 run 的，复制要晾 10 秒 + 等下一轮，任务开着自动整理时几乎必中；监控是整理攒 30 秒、复制 10～40 秒，一半对一半。就算复制抢在前面，一季几十集的目录复制是 OpenList 逐个起子任务，整理中途把文件挪走，排在后面的子任务就找不到源文件。
3. 队列面板在「已复制」的行上也给了「重试」：点了之后目标里已经有这个文件，记录被改成「失败」并发一条失败通知；升级接管来的记录点了一定 409。
4. 转存弹框选「后台」时不排复制（后端只在同步模式里登记），任务开着复制也一样悄悄不复制。
5. 追更、115 转存登记时没有网盘节点 id，删源前的「路径上还是不是当初那一份」核对被跳过。
6. 设置页「检查这些目录」：挂载根只看能不能打开——夸克那一行填成 `/115` 也打得开，照样说没问题（设计稿本来要把任务目录拼上去验）；默认目标目录还不存在就报错，实际上复制前会自己 mkdir。
7. 云下载弹框：任务目录模式下写着「复制到 /local/copy」（设置页的默认值），实际按任务自己的目标目录复制；任务开着复制时勾选框却显示没勾；复制的勾选框排在「网盘里的任意目录」下面，看着像只对它有效。
8. 任务弹框的「复制到哪」只能手打，没有设置页那样的 OpenList 目录选择（设计稿写的是目录选择器）。
9. 设计稿第二阶段的「任务卡片上显示复制中 N / 失败 N」没做，复制队列只在云下载页，转存 / 追更 / 监控触发的复制在任务页看不到。
10. 小的：夸克那一行挂载根的占位写着 `/115`；选择弹框标题「选择kuake（夸克）」；已复制的说明「→ /local/lib115 · OpenList 已复制到 /local/lib115」重复；一轮落在好几个目录时通知只写第一个目录；失败通知不说去哪重试；`GET /api/copy` 仍把队列读了两遍（状态函数里又读一次）。

### 真机之后的修补（2026-09-22，工作区，未提交）

- **`listSource`**（services/copy/service.ts）：源目录找不到时，从挂载根往下逐级带 refresh 列一遍再试。挂载根本身列不出来才第一轮失败（「OpenList 里没有挂载根 …」）；挂载根在、源目录还是没有，按「还没出现」计 waits，满 10 轮失败并说「网盘上这个目录可能被挪走或改名了」。
- **整理 → 复制按文件跟**：`afterApply` / `afterRevert` 把这次真正挪过 / 改过名的文件（`movedFiles`，任务相对路径）连同腾空删掉的目录一起交给 `rewriteCopyPaths`。文件待办改到新位置（目标目录按新层级重算）；目录待办里有文件被挪走的，每个文件另起一条（继承删源意图，节点 id 提交时再钉）、目录被腾空删掉的记成跳过并说明；目录级映射兜底不变。
- **等整理办完再复制**：`CopyRequest.holdForOrganize` → 记录上的 `holdUntil`（兜底 10 分钟）。四个触发点在刚为同一批路径排了会直接执行的自动整理时设它（`effectiveAutoMode === "auto"`；只出待确认清单的不等）。整理到头（执行完、没有要动的、留着等人确认、失败或取消，以及建 run 本身失败）调 `releaseCopyHolds(taskId, run 创建之前)`：只放在这次整理开始之前登记的，之后登记的等下一次。
- **套在一起的记录不同时提交**（`overlapHold`）：夸克监控只报最上层的新目录，转存 / 追更按文件登记，第一次存进新建子目录时会套上。目录等里面按文件登记的先复制完（之后目标里已有这个目录，目录按「已存在」跳过）；里面的等外面已经在复制的目录办完。免得两个 OpenList 任务同时写同一个文件。
- **删源的节点 id 提交时钉住**：要删源又没带 id 的，提交前按路径向网盘取一次；取不到就这条不删源并在说明里写原因（`sourceKept`），接口报错按重试算。
- 后台模式转存也登记复制（不压着等整理——后台模式不整理）；转存弹框的「转存后复制」两种模式都显示。
- 界面：面板只在失败 / 跳过、且不是接管来的行上给「重试」；设置页挂载根按网盘类型给示例、选择弹框标题「选择 kuake（夸克） 的挂载根」、「检查」把每个任务的 originPath 拼上挂载根去找（找不到说「挂载根多半填错了」），目标目录不存在只提示「第一次复制时会自动建」、它所在的存储打不开才报错；任务弹框「复制到哪」加 OpenList 目录选择、占位写出默认目标目录；云下载弹框「下载完之后」单独一节，任务模式按任务自己的目标目录、任务开着复制时勾选框锁成勾上；任务列表加「复制」标和「复制中 N / 复制失败 N」，点开跳到云下载页的复制队列（`#copy-queue`）。
- 小修：已复制的说明改成「复制完成」；一轮落在好几个目录时通知写「X 等 N 个目录」；失败通知末尾加「在『云下载』页的复制队列里可以重试」；`getCopyWatcherStatus(rows)` 接收已读出的队列；`__test_flushAutoOrganize` 按开始时的那一批遍历（遇到 409 重新排进 pending 会一直转下去，新测试第一次跑就挂住了）。

**测试**：后端 1040 个全过（新增 23：copy.itest 11 条——父目录缓存没跟上 / 挂载根真没有 / 源目录真不在 / 两种套叠 / 等整理与兜底 / 钉节点三种 / 多目录通知；queue.test 5 条——按文件改路径、目录拆分、没腾空、拆分去重、放行只放整理之前的；remove-source 2 条——复制期间被挪走、钉住后被换成同名的；run.itest 1 条——自动整理挪走改名后队列跟过去、留待确认时放行；auto.itest 2 条——建 run 失败放行、409 接着压；followup.itest 1 条、share.itest 1 条后台模式登记），三包 tsc / eslint 干净。

**修好之后在真机上复跑**：

- 重试那条撞过缓存问题的记录 → 提交、完成；目标侧自动整理把它挪进 `人生切割术 (2022) [tmdbid=95396]/Season 01/人生切割术 - S01E06.mkv`。
- 父目录缓存：在 115 上（OpenList 之外）新建 `NewShow.S01`，确认 OpenList 的 `/115/copylab115` 缓存里没有它，再挪一集进去 → 第一轮就提交、完成，md5 一致。
- 监控 → 源侧自动整理 → 复制：115 任务开「把握大的直接执行」，E07 挪进带 id 标签的发布目录 → 登记时压着（「等自动整理先在网盘上改完名再复制」）→ 30 秒后整理在 115 上建作品目录 / 季目录、挪走并改名 → 队列里那条改成 `人生切割术 (2022) [tmdbid=95396]/Season 01/人生切割术 - S01E07.mkv`、目标按新层级、放行 → 下一轮提交（源目录是整理刚建的，靠上面那条修复才列得出来）→ 完成，md5 一致；监控把整理自己的三条事件认出来没有重复登记；目标侧整理看到已经规范，0 项要动。
- 界面：任务列表的徽标和跳转、面板只在失败行给重试、设置页检查（正确配置提示目标目录会自动建；夸克挂载根故意填 `/115` 报「任务目录在 OpenList 里找不到（/115/copylabqk）」）、占位 / 弹框标题、任务弹框目录选择、云下载弹框两种模式的复制说明、转存弹框后台模式下的复制勾选，都在浏览器里看过。

**没覆盖的**：115 转存 / 追更（手里没有 115 的分享链接；它们和夸克走同一段代码，区别只在 115 转存不给节点 id，已经由提交时钉住兜上）；夸克上「监控报新目录 + 转存按文件登记」真的撞在同一轮的时机（夸克快照 5 分钟一轮，窗口十几秒，靠 copy.itest 覆盖）；删源 + 夸克监控之外的「没开监控」情形下本地 strm 会留着指向已删的文件，要等下一次全量同步（开着「删除本地多余文件」）才清，行为和设计一致，没改。

### 115 分享真机验证（2026-09-23）

用户给了一个 115 分享（`115cdn.com` 域名，末日地堡 2023：S1 四集、S3 十集，每集 3.6～7.6 GB）。环境同上一节（OpenList 这次只挂 `/115` + `/local`），测试目录 `/copylab115`，任务开着复制 + 删源；OpenList 从 115 拉约 9.8 MB/s，一集 6～7 分钟。每集核对完大小 / ffprobe 就删掉本地那份。

走通的：

- **同步转存 → 复制**（S03E04）：`115cdn.com` 链接认得出；监控随后收到 115 的「接收文件」事件，按文件报、和转存那条同路径，去重没有重复登记；复制中途重启后端，队列接着盯到完成；大小逐字节一致。
- **后台转存 → 复制 + 删源**（S03E03）：后台模式照样登记复制（这次修的）；提交时绕开缓存钉住 115 节点 id，复制完删进回收站。
- **追更 → 复制 + 删源**（S03E01）：订阅 Season 3，从 known 里抹掉一集，检查一次就转存（115 没有更新信号，直接列）→ 登记（来源「追更」）→ 钉住节点 → 复制 → 删源 → 本地 strm 一起删掉。

真机暴露、已修的：

1. **115 按路径找文件走的是进程内缓存 5 分钟的目录清单**：转存弹框刚列过任务目录，接着转存进来的文件在缓存里没有，提交时钉不住节点 → 删源被关掉（第一集就是这样：「提交时网盘上没找到这个路径的节点，核对不了，源文件没删」）；删源时同样会误判「源已不在原处」。修：复制这边的三处网盘查找（钉节点、删源、核对目录子项）改走 `lookupFresh`——父目录按路径解析，再 `listDir(…, { fresh: true })` 按名字找（整理那边挑同名早就这么绕）。remove-source.itest 加了一个带清单缓存的 FakeDrive 子类钉住它，把修复拿掉这条就挂。
2. **删源之后本地 strm 没人删**：115 Provider 的 `remove` 当场清掉路径缓存（`dropSubtree` + `forgetPathsUnder`），随后那条删除事件又不带父目录 id，监控对不上任何任务，当成根目录下的文件跳过；夸克是快照对比所以上一轮没暴露。修：删源成功后复制服务自己删本地镜像（`removeLocalMirror`：只认同账号的任务，目录整个删、文件走整理的 `mirrorDelete`），不再指望监控；说明里写「网盘上那份已删，本地 strm 也删了」。

后台模式转存那一次接口没返回（用户清完磁盘后接着查的）：

- 现象：转存成功、复制已登记之后，`startTask` 卡在拉 115 远端目录树 8 分钟以上没回来，前端的 180 秒超时先到、报「保存失败」，任务历史也没这次记录；随后手动启动同一个任务 7.5 秒正常。
- 排查：整树导出的每个请求都有超时、下载有空闲看门狗，唯一能等很久的是 `exportDirResult` 轮询导出状态（上限 10 分钟），所以那次多半是 115 的导出任务迟迟不报好。单独实测：同一账号同时导出两个目录、转存进目录后马上导出，都在 0.3～2 秒内好了；开 debug 日志按原条件（监控开着、任务开着复制 + 删源）走真接口后台转存一集，6.7 秒返回、导出第一次问就好了——**没复现**。
- 不管 115 为什么偶尔不报好，设计上有个真问题：「后台」模式的转存要等 `startTask` 把整棵远端目录树拉完才回话，115 大目录（整个 /tv）正常导出也要几分钟，前端照样会超时报「保存失败」。**已改**：只等 8 秒（`ASYNC_START_GRACE_MS`），起得快照常回结果，没回来就先回「已触发后台同步」（带任务 id，界面照样能链到日志），同步接着跑，起不来的原因 `startTask` 自己记进任务历史并发通知。share.itest 加了一条：卡住拉目录树那一步，接口照样立刻回话、转存已成。
- 导出状态轮询加了 debug 日志（回复变了才记），下次再卡能看到 115 到底回了什么。
- 顺带看到的：刚导出过的目录紧接着删会被 115 拒（errno 990009「删除[X]操作尚未执行完成，请稍后再试」），隔几秒再删就过；连着删两个别的目录没事，删文件没遇到。复制的删源删的是文件、而且不会刚好碰上导出，没加重试，记在这里。

最后这一集也按原条件复跑到底：复制完删源、本地 strm 一起删掉，大小逐字节一致。收尾删容器、退出 Docker，磁盘余量回到 83 GB。

**测试**：后端 1042 个全过（新增 115 目录缓存、后台转存不等目录树两条；删源的几条加了本地 strm 删除的断言），三包 tsc / eslint 干净。

**真机实验的坑**：OpenList 跑在 Docker 里，本地存储是 bind mount，**删掉复制过来的文件后空间不会马上回来**——Docker 的虚拟机还占着这些文件，要删容器、退出 Docker 才释放（这次一度只剩 2.8 GB，退出后回到 15 GB）。大文件真机实验要先看磁盘余量、每集做完就停容器，或者直接挑小文件。


## 手动发起复制（2026-09-25，方案）

用户的场景：转存时没勾复制（任务也没开），看了一会发现播放卡顿，想把这一部单独复制到 OpenList 挂的本地磁盘；界面和智能体里都要能发起。

### 现状

- 复制只在四个时机登记：转存（勾了复制 / 任务开着）、追更、网盘监控、云下载下完。队列面板只能看 / 重试 / 去掉，`routes/copy` 的注释写明没有「新建」。
- 事后把任务上的复制开关打开，只管以后新落进来的文件，已经在网盘上的不会补。
- 唯一的补救口子：智能体 `share_save` 10 分钟内同参数再调、带 `copy: true`，只给上次真正转存的条目补登记（登记前到网盘核对还在原位）。界面转存的、过了 10 分钟的都用不上。
- 绕路都不好：界面重新转存一次会往网盘再存一份；直接在 OpenList 网页里复制不经过队列，复制完不刷 Emby、不整理、不删源，队列里也看不到。
- 代码里 `CopyTrigger` 早留了 `"manual"`（界面标签「手动」），一直没有入口。

### 方案

**1. 服务层：`services/copy/manual.ts` 的 `enqueueManualCopy`**

入参：任务、相对任务网盘目录的路径（`normalizeSubPath` 口径，至少一段、最多 50 条）、可选目标目录、`signal`。

校验（都在动网盘之前）：

- `copyBlockerFor(settings)(task)` 不为 null → 400 `COPY_NOT_READY`，和转存框、任务列表同一套判断（含「OpenList 账号的任务用不着复制」）。
- 给了目标目录：`copyDstProblem`——只能是任务上 / 设置页的目标目录，或它们下面的目录（云下载已经是这条规则）。
- 任务正在整理（`autoOrganizeBusy`，或有 planning / applying 的 run，手动的也算）→ 409「整理完再复制」。登记时压着等整理的那套（`holdForOrganize`）用不上：`releaseCopyHolds` 只放整理开始之前登记的，这里登记的会干等 10 分钟兜底；直说更清楚。
- 路径不能是任务根本身：整目录复制会把 `tv` 摆成 `dst/tv`，和别的记录的层级（`dst/某剧`）对不上。要整任务就选它下面的条目。

到网盘核对每条路径（`provider.resolvePath`）：不存在 → 这条记 `missing`；拿到 `isDir` 和 `nodeId`（删源时核对，目录复制完核对全不全也靠 `isDir`）。

**补齐**（这个方案里最大的一块，见下面「为什么要补齐」）：源是目录、OpenList 目标目录里已经有同名目录 → 不登记整目录（会按「目标里已有」跳过，什么都不复制），改成按缺的补：源子树（`listSubtree` / `walkSubtree`）和目标逐层比对（`deps.openlist.listNames`，每个已存在的目标目录列一次），目标里缺的文件按文件登记、缺的子目录整目录登记；只比名字（和队列一致，残缺文件照旧走「重试 → 报失败叫人删」那条路）。上限：源 5000 个文件 / 200 个目录，超了 400「太大，缩小范围」。源是文件、目标已有同名 → 这条记 `exists`。

登记：`copyOptionsFor(task, true, settings, dstDir)` → `enqueueCopy({ account, sources: [{ path, isDir, nodeId }], rootPath: task.originPath, taskId, trigger: "manual", dstDir, deleteSource })`。`forced = true` 所以任务没开复制也登记；**删不删源只看任务开关**（`byTask && deleteSource`），和转存框的一次性勾选同一个原则。

返回 `{ queued, dstDir, deleteSource, items: [{ path, outcome }], reason? }`，`outcome` 是 `queued` / `filled`（补了 n 条）/ `duplicate`（已经排着或刚复制过）/ `exists` / `missing`。

和已有记录的关系：`findDuplicate` 去重照旧；这条整目录记录会把之后网盘监控按文件报上来的并进来（`coversRecord` 对任何来源的外层都生效）；已经按文件排着的转存 / 追更记录不并（那两条只并监控的），整目录本来要等它们复制完、再按「目标里已有」跳过——正是补齐要接住的情形，所以登记时目标里已有同名目录就直接走补齐，不让整目录白等。

复制完的后续照旧：刷 Emby、目标落在某个 OpenList 任务下就按它的策略自动整理、任务开着删源就删网盘源文件和本地 strm。

**2. REST**：`POST /api/copy`，body `{ taskId, paths, dstDir? }`，回上面的结果；`config: { agentScope: "write", agentToolset: "transfer" }`（和 `/retry` 同档）。

**3. 智能体：`copy_add`**（transfer 组、write 档、注解 readOnly false / destructive false / idempotent false / openWorld true，工具 35 → 36）

- 输入 `task`（id 或路径 / 最后一段）、`paths`（相对任务网盘目录，和 `share_save` 的 `subPath`、`drive_browse` 同口径）、`dstDir?`。
- 路径怎么找不加新工具：`strm_search` 按片名找本地 strm，结果里有对应的网盘路径，作品目录就是第一段；`drive_browse` 看目录。描述里写明。
- 描述要写的：**调用前把复制什么、到哪、删不删源告诉用户，同意再调**；任务开着「复制后删源」会删网盘源文件和本地 strm；目标里已有同名目录时只补缺的；不能选任务根；整理进行中会拒。
- 结果用 `copyOutcomeView` 同口径回显，外加 `items`；next 指向 `copy_list`。
- `USAGE_NOTES` 加一条：「看片卡顿、想把某部片放到本地磁盘」→ `strm_search` 找到网盘路径 → 征得同意 → `copy_add`。
- REST 档位声明如上；工具快照更新。

**4. 界面**

- 云下载页复制队列面板加「新建复制」：选任务（OpenList 账号的任务不列；`copyBlocked` 的灰掉并说原因）→ 用 `TreeSelectDialog`（`multiple`）浏览这个任务的网盘目录，目录、文件都能勾——`/api/directory/remote/list` 现在只回目录，加 `withFiles` 参数带上文件（名字、大小）→ 目标目录默认任务上 / 设置页的，能在它下面选子目录（复用云下载弹框那段 OpenList 浏览）→ 任务开着删源就红字说明「复制成功后会删掉网盘上的源文件和本地 strm」→ 提交后 toast 说排上几条、补了几条、已有 / 不存在几条。
- strm 管理页：目录行菜单和顶部「工具」菜单加「复制到 OpenList」，把当前目录预填进同一个弹框（本地相对路径就是网盘相对路径）；strm 文件行也给，用 `expectedRemotePath` 算出视频文件的路径。任务 `copyBlocked` 时菜单项灰掉、写原因。
- 海报墙是背景装饰，没有可点的作品，不做入口。Telegram 不做。

### 为什么要补齐

「后来才开复制」是最常见的来由：任务开了复制之后追更 / 监控把新集复制过去了，目标里已经有这个剧的目录，只是缺前面的集。这时整目录登记会被「目标里已有同名」跳过（OpenList `/fs/copy` 对已存在的目标名直接报 `file exists`，队列只能跳过），用户和智能体都没有别的办法——界面上还能一个个勾文件，智能体连文件名都拿不到。所以补齐放进第一版，不拆到以后。

### 定下来的、不做的

- **不加一次性删源**：那是新的删除路径，智能体那边还要走 danger 档、当面确认。要删源的把任务上的开关打开即可，和现在的原则一致。
- **不给任务之外的目录**（`account` + 绝对路径）：层级、整理、Emby 刷新都靠任务；以后有需要再加。
- 任务根本身不让选；整理进行中 409；补齐只比名字。
- `share_save` 10 分钟内补复制那条路留着不动。

### 测试

- `services/copy/manual.test`（FakeDrive + OpenList 桩）：整目录登记；目标已有同名目录时补缺（缺文件按文件、缺子目录整目录、都齐了一条不登记）；文件已存在；路径不存在；任务根拒；任务整理中 409；`COPY_NOT_READY`；`dstDir` 越界；删源跟任务开关；随后监控报上来的被并进这条；太大拒。
- `routes/copy/copy.itest`：POST 的档位、参数校验。
- `routes/mcp/mcp-copy.itest`：`copy_add` 三种结果、只读令牌看不到、REST 档位。
- 前端：弹框在 scratch 后端上冒烟；strm 页入口预填。

### 量

后端约 300 行 + 测试；前端弹框约 300 行 + 两处入口。做完一起评审，随下一个 rc 发。

## 复制后的去向：不动 / 删除 / 归档（2026-09-25，方案）

用户提的：复制成功后三选一——不动、删除、归档；归档就是建一个归档文件夹，把源文件挪进去。

### 评估

赞成。三种各有用处：

- **不动**：云上留着，但 Emby 里同一集会有两份（云上的 strm 和本地那份）。
- **删除**：115 / 夸克的删除进回收站，过期就清空了；不可逆。
- **归档**：明确留一份，又从活动目录里拿掉——本地 strm 跟着删，Emby 里只剩本地那份；想恢复就挪回去。比删除安全，比不动干净。

### 归档目录放哪

任务目录下固定叫「归档」，和整理的「重复文件」一个做法；里面按任务相对路径原样摆：

- `tv/某剧/S01/E01.mkv` → `tv/归档/某剧/S01/E01.mkv`
- 整目录复制的 `tv/某剧` → `tv/归档/某剧`

为什么放任务里、不放账号级的独立目录：

- 不用配置、不用选路径。
- 「不进媒体库」的排除现成的：「重复文件」目录已经在全量同步（`task/runner.ts` 的 `listSubtree` 过滤）、网盘监控（`life/handlers.ts` 的 `matchTask`）、整理（`buildUnits` 前的过滤）三处被跳过，归档区照抄同一套。
- 任务建在网盘根（`/`）的也能用；账号级目录在这种任务下面根本放不到外面去。
- 还原就是挪回上一级，下次同步 / 监控自然把 strm 长回来。

代价：任务根下本来就有个叫「归档」的目录，升级后会被当成归档区、不再同步（和「重复文件」一样），升级说明里写一句。名字先定「归档」，怕撞再换 `_归档`。

### 数据模型

- 任务：`copyToOpenlist.afterCopy: "keep" | "delete" | "archive"`，默认 `keep`。旧的 `deleteSource: true` 读成 `delete`：任务是整段 JSON 存的（`tasks.data`），在 `repositories/tasks` 读出时归一，不用 SQL 迁移；写回只写 `afterCopy`。
- 复制记录：`afterCopy` 登记时冻结（和现在的 `deleteSource` 同一位置、同一时机）；旧记录在 `listCopies` 读出时归一；`sourceKept` 扩成「源没动的原因」。
- 云下载回执：`copyDeleteSource` → `copyAfterCopy`，加任务那一刻冻结，旧字段读时归一。
- 追更合并结果、监控（监控登记的一律 `keep`）、`coversRecord`（inner 不是 `keep` 时要和 outer 一样才算被包着）、`upgradeDeleteSource` → `upgradeAfterCopy`（`keep` 能被补成 `archive` / `delete`；`archive` 和 `delete` 撞上算先登记的，说明里写一句）。
- 现在 `deleteSource` 一共 51 处（15 个文件），都要过一遍。

### 执行

`afterCopiedInner` 同一道门：先 `verifyCopied`（目标里看得见、目录逐项齐了）、节点 id 核对，过了才按 `afterCopy` 动：

- `keep`：什么都不做。
- `delete`：现有 `removeSource`。
- `archive`：新加 `archiveSource(account, path, nodeId, task)`——算出归档路径 = `originPath/归档/相对路径`，`write.mkdir` 把父目录链建出来，`write.move` 挪过去。归档里已经有同名 → 源留着，说明「归档里已经有同名，源文件没动」（目录合并放第二期）；网盘不支持写 → `unsupported`，同删除。

归档成功后同样 `removeLocalMirror`：本地 strm 指着的路径已经空了，留着就是 Emby 里放不了的条目。监控随后会看到一次移动：旧路径在任务里、新路径在归档区被 `matchTask` 跳过 → 走「移出监控范围删本地」，本地早删了，空操作。

排除归档区的三处和「重复文件」并成一个 `isStagingDir(rel)`：`runner.listSubtree`、`handlers.matchTask`、整理 `buildUnits`。strm 校验 / 海报 / strm 页只看本地，不生成归档区的 strm，不用动；手动复制的补齐只比源和目标，不受影响。

### 界面

- 任务弹框：「复制后删源」开关换成三选一单选：不动 / 归档（写清放在任务目录下的「归档」里、怎么还原）/ 删除（红字：进回收站，过期清空，不可逆）。
- 队列面板每条显示「复制后：归档到 …」「复制后：删除」。
- 新建复制弹框（见「手动发起复制」）默认跟任务，可以改，三种都给，选删除要二次确认。
- 转存框 / 云下载框的一次性勾选只写「复制」，不加去向——那条原则不变。
- Telegram 云下载文案里的「删源」改成按 `afterCopy` 说。

### 智能体

- `copy_add` 加 `afterCopy?`：不给按任务；`keep` / `archive` 走 write 档（归档是网盘上的一次移动，可逆）；`delete` 要令牌有 danger 档，没有就 `SCOPE` 错误、提示让用户到设置页勾。描述写明：调用前把去向说给用户；归档放在哪、怎么还原。
- `share_save` / `offline_add` 不加去向参数，跟任务（和界面一致）。
- 结果里的 `copy.deleteSource` 保留（`afterCopy === "delete"`），加 `afterCopy`；`tasks_list` 的 `copyToOpenlist`、`copy_list` 的每条都带 `afterCopy`；`USAGE_NOTES` 那条改写；工具快照更新。

### 不做

- 归档目录合并（归档里已有同名目录时把里面的文件一个个挪进去）：第二期。
- 账号级归档目录。
- 「从归档恢复」的动作：先手动挪回；以后要再给。

### 测试

- `copy.itest`：归档全流程（建目录链、移动、本地 strm 删、说明）；归档里已有同名；不支持写；三种去向各自的说明；旧字段归一（任务 / 记录 / 回执）；`coversRecord` / `upgradeAfterCopy` 的新规则。
- `runner` / `handlers` / `organize`：归档区被跳过。
- `mcp-copy.itest`：`copy_add` 三种 `afterCopy`，没 danger 档要删被拒。
- 前端：任务弹框、队列面板、新建复制弹框在 scratch 后端上冒烟。

### 量

后端约 400 行 + 测试（含 51 处 `deleteSource` 的改动），前端约 200 行。和「手动发起复制」一起做、一起评审，随下一个 rc 发。

用户 2026-09-25 说「按你的推荐制定计划开始吧」：归档目录定名「归档」。

### 进度（两件一起）

- [x] A1 共享类型 / 任务 schema / 任务仓库读时归一：`afterCopy`
- [x] A2 复制队列与服务：记录、登记、包着 / 补去向的规则、执行三分支、归档实现
- [x] A3 归档区排除：全量同步、监控、整理
- [x] A4 云下载回执、追更合并、监控登记（Telegram 文案里本来就没写删源，不用动）
- [x] A5 智能体：结果 / tasks_list / copy_list 带 `afterCopy`，说明改写
- [x] A6 界面：任务弹框三选一、队列面板显示去向
- [x] B1 `enqueueManualCopy`（含补齐）+ `POST /api/copy`
- [x] B2 `copy_add` 工具 + 快照 + USAGE_NOTES
- [x] B3 远程列目录带文件；新建复制弹框；strm 页入口
- [x] 测试、tsc / eslint
- [x] 浏览器冒烟（scratch 后端 4100 + dev 3223）
- [x] 评审（15 + 次要项全修，见末节）

### 实施记录（2026-09-25，两件一起）

**去向 `afterCopy`**

- 共享类型 `CopyAfterCopy`；`TaskCopySettings.afterCopy`，`deleteSource` 留作旧字段。`lib/after-copy.ts`：`afterCopyOf`、`normalizeTaskCopy`、`AFTER_COPY_LABEL`。
- 任务仓库读写时把 `deleteSource` 收成 `afterCopy`（只在带旧字段时动，没填的不硬写 `keep`）；`insertTask` 返回归一后的样子，POST 的响应也就是归一过的。没有 SQL 迁移。
- 复制记录 `afterCopy` 必填，`listCopies` 读出时把老记录的 `deleteSource` 收进去；`CopyRequest.afterCopy`、`CopyEnqueueResult.pendingAfterCopy`、`CopyOutcome.afterCopy`（`deleteSource` 保留 = `afterCopy === "delete"`，`withAfterCopy` 一起给）。
- `coversRecord`：inner 不是「不动」时要和 outer 同一种去向；`upgradeAfterCopy`：只把「不动」的补成整条目带来的去向，删除和归档撞上算先登记的。
- 执行：同一道门（`verifyCopied` + 节点 id）之后按去向分支；`archiveSourceReal` 算出 `originPath/归档/相对路径`、`ensureDriveDir` 按父目录 id 逐级列（绕开路径缓存）建目录链、`write.move`；归档里已有同名 → `exists`，平铺复制的（没有 rootPath）→ `no-root`，都留着源、写说明。归档成功同样删本地 strm。
- 暂存区：`organize/duplicates.ts` 加 `ARCHIVE_DIR = "归档"`、`isStagingDir`；全量同步、监控 `matchTask`、整理 `buildUnits` 和自动整理的触发路径都换成它。
- 云下载回执 `copyAfterCopy`（旧 `copyDeleteSource` 读时归一）；`AddOfflineResponse.copyAfterCopy`；追更合并取第一组不是「不动」的；监控登记一律 `keep`。
- 智能体：`copyOutcomeView` / `taskCopyView` / `copy_list` / `copy_retry` 都带 `afterCopy` + `afterCopyText` + 老的 `deleteSource`；`afterCopyNote` 统一说法；说明、`USAGE_NOTES`、概念一句都改了。
- 界面：任务弹框换成三选一 Select（写 `afterCopy`）；任务列表徽标提示按去向说；队列面板每条显示「复制后归档 / 删除」。
- 测试：`deleteSource` 的 51 处引用连同测试一起改；`paths.test` 加老数据归一、任务没开复制时一次性发起不认去向；`followup.itest` 加归档冻结；`crud.itest` 验 POST 响应归一。

**手动发起复制**

- `services/copy/manual.ts`：`enqueueManualCopy`（校验 → 到网盘 `resolvePath` → 目标里没有整条登记 / 有同名目录走 `planFill` 补缺 / 有同名文件跳过 → 逐条 `enqueueCopy(trigger: "manual")`）；`TargetListing` 每个目标目录只列一次、上限 200 个；`sourceTree` 有 `walkSubtree` 用它，115 从 `listSubtree` 的文件路径推目录；上限 5000 个文件。任务正在整理（planning / applying / reverting 的 run，或攒着的自动整理）→ 409 `TASK_ORGANIZING`。
- `service.ts` 导出 `listOpenlistNames`（走 deps，测试能换桩）。
- `POST /api/copy`（write + transfer；`afterCopy: "delete"` 要 `requireAgentScope(danger)`，会话不受限）。
- `copy_add` 工具（transfer 组、write 档；`delete` 没有 danger 档报 `INSUFFICIENT_SCOPE`，提示改 archive）；把服务层的 `COPY_NOT_READY` / `TASK_ORGANIZING` / `COPY_DST_INVALID` / `TOO_LARGE` / `VALIDATION` 换成带提示的 ToolError；结果 = `copyOutcomeView` + `items`（每条带 `outcomeText`）。工具 36 个，快照已更新；`USAGE_NOTES` 加了「看片卡顿 → strm_search → 当面确认 → copy_add」。
- `/api/directory/remote/list` 加 `withFiles`（文件排在目录后面，带 size）。
- 界面：`components/AddCopyDialog.tsx`（任务 → `TreeSelectDialog` 多选目录 / 文件 → 目标根下选子目录 → 去向三选一，默认跟任务；选删除要二次确认；提交后逐条显示结果）；队列面板加「新建复制」（队列空着但配好了也显示）；strm 管理页目录行菜单 / 顶部工具菜单 / strm 文件行都有「复制到 OpenList」，strm 文件按 `expectedRemotePath` 换成任务相对路径。
- 测试：`manual.itest`（整目录 / 补齐 / 文件三态 / 115 式 / 拒绝六种 / 去向 / 重复与并进）；`routes/copy` 的 POST 与档位；`mcp-copy` 的 `copy_add`（含只读令牌看不到、删除要 danger）。
- 全量 1298 个通过；三包 tsc、两端 eslint 干净。
- 浏览器冒烟（全新 scratch 库起 4100、dev 3223，夸克假账号 + 两个任务 + 本地 strm；远程列目录和 POST /api/copy 在页面里换成 XHR 桩）：云下载页「新建复制」→ 选任务（Radix Select 用 keydown Enter）→ 树里勾目录和文件、展开子目录 → 去向改成删除（提示变红）→ 二次确认 → 结果逐条带徽标 + toast；strm 页目录行菜单、顶部工具菜单（根目录灰掉）、strm 文件行按钮都能预填进弹框，strm 文件按应指向的网盘路径换成任务相对路径；任务弹框三选一显示当前值；任务列表徽标提示按去向说。
  - 冒烟撞到一处：云下载页没有 115 账号时整页只有「去添加账号」，复制队列面板根本不渲染——只有夸克账号的用户看不到队列、也发不起复制。改成那个分支也渲染面板（面板没配好又空着时自己不显示）。

### 评审与修补（2026-09-25，`/code-review max`）

15 条主要发现 + 一批次要项，全部核实成立，除两条说明外都修了：

1. **删除档只按明说的 `afterCopy` 把关**：没明说、按任务设置落到删除的也会删。改成服务层按最终去向把关（`ManualCopyInput.allowDelete`，路由按会话 / 令牌有没有 danger 档给，工具按 `hasScope`），路由和工具都补了用例。
2. **`归档` 这个名字撞上用户原有目录**：远端不再列它，本地 `removeExtraFiles` 会把里面已有的 strm 当多余删掉。名字不改（和「重复文件」一个做法，用户定的），但全量同步的本地清单也跳过暂存区，原有 strm 不会被删；升级说明里要写这一条。用例在 runner.itest。
3. **手动登记的路径没查队列里包着它的整目录**：一次里选了父子路径、或队列里已有整目录复制时，子路径单独登记，整目录到时被「目标里已有」跳过。改成子路径去掉、队列里有还没提交的整目录包着（`findCoveringRecord`，任何来源都算）就记成 `covered`。
4. **列 OpenList 目标失败一律当「还没有」**：OpenList 挂了会整目录登记、到时跳过、缺的永远补不上。改成只有 `isMissingDir`（明确说没有）才算没有，其它一律报错、整个请求不登记。
5. **逐条登记、逐条校验**：后一条的 TOO_LARGE / 报错让前一条已经排上（可能带删源）。改成两阶段：先只看不改（所有 await 都在这一段），再一口气登记（一次 `enqueueCopy`，按 `perSource` 归到每条路径）。
6. **回话里的去向照抄请求的**：已经排着一条要删源的，这次说归档、没再排，回的却是归档。改成和 `enqueueCopyFor` 同一个口径（`pendingAfterCopy`）。
7. **115 按路径找刚落进来的文件看的是 5 分钟的缓存**：报「网盘上没有」。改用 `lookupFresh`（按父目录绕开缓存列）。
8. **路由不传 AbortSignal、前端 120 秒超时、网盘错误没走 `driveErrorToHttp`**：`abandonedSignal` 从资源搜索路由抽到 `lib/abandoned-signal.ts`，前端超时改 330 秒（和 strm 校验一样），网盘错误映射成上游错误。
9. **`normalizeSubPath` 削每段空格**：「Season 1 」这种名字找不到。改用 `strm/manage.ts` 的 `normalizeRel`（只收拢斜杠，拒 `..` 和 NUL）；`enqueueCopy` 里那句 `s.path.trim()` 也去掉了。用例：尾空格目录。
10. **暂存区能当源**：`uniquePaths` 拒 `isStagingDir`；`archiveSourceReal` 对本来就在归档里的回 `staged`，不会把「归档」挪进「归档」。
11. **弹框把 OpenList 账号的任务过滤掉，strm 页却给了入口**：下拉框空着、什么也说不出。改成不过滤、按后端算好的 `copyBlocked` 说原因，strm 页的入口在 `copyBlocked` 时灰掉并把原因放到 title。
12. **`copy_add` 套用 `copyOutcomeView`**：一条没排、带目标根就被说成「已经排着」。改成自己的 `manualCopyView`，按 items 说话。
13. **strm 页按文件名算的 `expectedRemotePath` 找网盘文件**：改用 `actualRemotePath ?? expectedRemotePath`，内容解析不出的单独提示。
14. **整理忙的检查只在开头看一次**：登记前再看一次（登记那一段没有 await）。
15. **归档整条路没测试、归档里已有同名时通知不提**：新加 `archive-source.itest.ts`（目录链、真挪、本地 strm、同一轮里目录链只建一次、已有同名、本来就在归档里、平铺 / 不支持写 / 节点换了）；复制成功但源文件没按设置处理的，`copy-done` 通知带 `kept` 说一声。

次要项：`ensureDriveDir` 每轮缓存目录链；`enqueueCopy` 找重复改成按「账号 + 目录 + 名字」索引；`Omit<CopyRequest, "deleteSource">` 改正；扩展名判断和 115 导出树用同一条规则（`drive/walk.ts` 的 `looksLikeFileName`，整理的 `listTree` 也引它）；`AddTaskDialog` 关着时不预选旧去向；`afterCopyOf` 认不得的值当不动、`afterCopiedInner` 不再把 else 当归档；`AFTER_COPY_LABEL` / `taskAfterCopy` 挪到 `lib/openlist-copy.ts`，前端三处 `deleteSource` 兜底删掉；`normalizeRecord` 复用 `afterCopyOf`；`transfer.ts` 两处用 `withAfterCopy`；弹框里自己猜「卡在哪」的三元删掉；`manual.ts` 两处到不了的保护删掉；`withoutWalk` 抽进 `test/fake-drive.ts`（整理和手动复制的测试共用）。

没改的两条：`planFill` 要先整棵列才知道文件数（115 是一次导出，列之前没法知道大小）；三处「mkdir -p」（转存的 `ensureSubDir`、整理的 `ensureDir`、归档的 `ensureDriveDir`）各自带着不同的缓存和错误口径，合并的收益抵不过风险。

全量后端测试通过，三包 tsc、两端 eslint 干净。

## 真机验证：手动发起复制 / 复制后的去向（2026-09-28，v2.12.1-rc.3）

用户说「把这一次和上一个 rc 都真机验证一下吧」。

**环境**：
- 后端同 organize.md 同日那一节（配置库只读拷贝、4100 只绑本机、Telegram 假服务）。
- Docker 起 OpenList v4.2.6，挂 `/115`、`/quark`（cookie 取自拷贝库）和 `/local`（scratch 目录，当复制目标）。
- 前端 dev 3223 接实验后端，浏览器里登录（临时口令换的会话令牌）。
- 测试文件是 ffmpeg 造的 200 多 KB 小视频，传进两个网盘的 `/v0928lab`，验完删了（进回收站）。

**走通的**：

| 场景 | 结果 |
|---|---|
| 云下载页「新建复制」（115，文件，不动） | 目录树列出真 115 上的目录和文件；复制完 md5 一致，源文件还在，来源「手动」 |
| strm 管理页目录行「复制到 OpenList」（115，目标里已有 E01） | 弹框预填任务和路径；结果「补了缺的（2）」，E02、E03 复制过去、md5 一致，E01 没动 |
| strm 文件行入口 | 按 strm 内容换回真实的 `.mkv` 路径；目标里已有 → 「目标里已有同名」 |
| `copy_add` 整目录 + 归档（115） | 第二次（去掉上一条记录后重发）成功：建「归档」、挪过去、本地 strm 删掉 |
| `copy_add` 删除，日常令牌 | `INSUFFICIENT_SCOPE`，什么也没排 |
| `copy_add` 文件 + 删除（夸克，完全令牌） | md5 一致，夸克上删掉（进回收站），本地 strm 删掉 |
| 任务设「开复制 + 归档」、`copy_add` 不传去向（夸克） | 按任务归档，整目录进 `copyqk/归档/怒呛人生`，本地 strm 删掉 |
| 界面「复制后删除」（115） | 二次确认「复制并删除」；md5 一致，115 上删掉，本地 strm 删掉 |
| 暂存区 | 两个任务的全量同步都「no files to download」，归档里的不长 strm；整理预览 0 个单元；115 监控看到挪进归档的事件，按暂存区跳过，不生成 strm、不登记复制 |
| 界面显示 | 队列面板每条带「手动」「复制后删除 / 归档」和去向说明；任务弹框三选一显示当前值；Telegram「已复制到 OpenList（手动）」，没按设置处理的带原因 |

**真机暴露的问题**（都还没改）：

1. **复制后归档 / 删除碰上一次临时错误就不再做了**。第一次 115 归档撞上接口 30 秒没回：复制成功了，源目录留在原处，说明和通知写「归档源文件失败：timeout of 30000ms exceeded」。记录已经是「已复制」，面板上没有补做这一步的入口，只能到网盘里手动挪。
2. **网盘接口超时的报错是英文原话**：手动复制接口回 500「timeout of 30000ms exceeded」，队列说明、通知里也是这句。在 3223 上看到的只有「发起复制失败」：next dev 的 `/api` 反代自己 30 秒就断了，这一点只影响开发环境。
3. `copy_add` 没有删除档时，报错总说「（这个任务设的就是复制后删除）」；这次是明说 `afterCopy: "delete"`，任务根本没开复制。
4. 新建复制的目录树里列出了「归档」，选了提交会被拒（后端不许暂存区当源）。
5. 一条都没排上（目标里已有 / 已经齐了）时，结果里仍写「复制在后台跑，大约 30 秒推进一轮」。
6. 监控对暂存区里的事件写「…不在任何任务的 originPath 下」，其实它在任务目录里，只是落在暂存区。

**没弄清的**：115 接口卡 30 秒只在实验后端进程里出现过。11:52、11:53、12:01 三次，前两次是手动复制登记时按父目录列目录，第三次在归档那一步，具体哪个接口没记下来。

- 同一时间另起的进程每次都 1～2 秒回来；一个长跑的探测进程每 45 秒查一次、查了 8 轮，一次没卡。
- 挂上记录 115 请求耗时的预加载、重启后端之后，再没出现。
- Node 24 的全局连接池空闲 5 秒就关连接，「复用死连接」解释不通。记在这里，下次再遇到先看是哪个接口。

**测试环境的坑**：
- `sqlite3 -readonly config/openstrm.db` 打不开，要用 `file:config/openstrm.db?mode=ro&immutable=1`。
- OpenList 的 `/api/admin/storage/list` 是 GET。
- 两个任务都用默认目标目录、任务根下又有同名目录时，补齐按名字比会互相当成「已经齐了」。测去向时给任务单独设目标目录。
- 同一源、同一目标刚复制过的会按「刚复制过」去重，要重做得先在队列里去掉那条。

**推荐的修法**：

1. **复制后的去向遇到临时错误自动再试**：
   - 网络断、超时、5xx / 429 这类错误不当最终结果。记录照旧是「已复制」，另记「去向待重试」（次数、下次时间）。复制推进时到点再做一次：1 分钟、5 分钟、15 分钟，最多三次。
   - 说明和通知先写「归档（删除）源文件没成（网盘接口超时），稍后自动再试」；三次都不成，才按现在的样子写「没按设置处理」并通知。
   - 重试前照旧先核对（复制还在、节点 id 对得上）。上一次其实已经挪走 / 删掉、只是没等到回话的：归档看归档目录里有没有这个名字，有就算归档成了；删除找不到源就写「网盘上已经没有这一份（多半上次已经删掉）」。
   - 明确的失败（节点换了、归档里已有同名、不支持写）照旧不重试。
2. **超时说人话**：
   - `driveErrorToHttp` 和复制的去向说明把 axios 超时换成「网盘接口 30 秒没有回应，稍后再试」，原话放括号里留底。
   - 115 请求超时时记一条带接口路径的警告日志，下次再卡能看到是哪个接口。
3. `copy_add` 的删除档报错：只在没明说、按任务设置落到删除时才说「这个任务设的就是复制后删除」，明说的直接说「afterCopy: "delete" 要…」。
4. 新建复制的目录树不列任务根下的暂存区（「归档」「重复文件」）。名字放进 shared，前后端共用一份。
5. 结果里一条都没排上时，不显示「复制在后台跑…」那句。
6. 监控对暂存区里的事件写「在任务的暂存区（归档 / 重复文件）里，不处理」。

测试：
- `copy.itest`：去向重试（超时后到点再做成功；三次都超时才最终失败并通知；上次其实挪成了算归档；明确失败不重试）。
- `errors` 单测：超时换成中文。
- `mcp-copy.itest`：删除档报错的两种说法。
- 监控：暂存区的说明。
- 前端：弹框在 scratch 后端上看一眼。

用户说「按照你的推荐制定计划开始吧」。

### 实施计划（真机问题的修补）

1. **去向晚点再试**（`copy/queue.ts`、`copy/service.ts`）：
   - 记录加 `afterRetry?: { attempts; nextAt }`：复制成功、去向碰上临时错误时记上，记录照旧是「已复制」。
   - 临时错误：网络断、超时（`driveErrorFacts().transport`）、网盘异步任务失败、5xx / 429。账号失效、风控不算。
   - 去向那段从 `afterCopiedInner` 抽成 `applyAfterCopy(c, cfg, retry)`。第一次和重试都走它；Emby 刷新、目标侧整理只在第一次做。
   - 间隔 1 / 5 / 15 分钟，三次用完按「没按设置处理」收场（`sourceKept`），说明末尾写「自动重试 3 次都没成」。
   - 推进循环：到点的一起处理，这一轮手里的也登记进 `tickRecords`（去掉一条时同步标掉）；循环在「有排队的，或者有等着重试去向的」时继续（`hasCopyWork`），启动时也按它起。
   - 重试时从「复制完成」重新拼说明。源不见了的情况：
     - 删除：当成上次已经删掉了，照删本地 strm，说明写「网盘上已经没有这一份（多半上次已经删掉）」；
     - 归档：`archiveSource` 带上 `retry`，看归档目录里有没有同名、节点 id 对得上的，有就算归档成了。
   - 通知：
     - 第一次复制完成的 `copy-done` 带 `retrying`，写「稍后自动再试」；
     - 三次都不成，另发一条 `copy-kept`「复制后源文件没按设置处理」；
     - 重试成了不再发。
2. **超时说人话**：
   - `lib/errors.ts` 加 `networkErrorText(err)`：axios 超时回「网盘接口 N 秒没有回应，稍后再试」，连不上回「连不上网盘接口（代码），稍后再试」，别的回 null。
   - `driveErrorToHttp` 兜底那支、复制去向的说明用它。
   - 115 请求超时记一条警告，带接口路径（不带请求头）。
3. `copy_add` 删除档的报错按「明说的 / 按任务设置的」分开说。
4. 前端新建复制：
   - 任务根那一层不列「归档」「重复文件」（名字记在 `lib/openlist-copy.ts`，和后端 `organize/duplicates.ts` 保持一致）；
   - 一条都没排上时不显示「复制在后台跑…」。
5. 监控：落在任务暂存区里的事件说「在任务的暂存区（归档 / 重复文件）里，不处理」；挪进暂存区的说「挪进暂存区，已删除本地 …」。
6. 测试：
   - `copy.itest`：超时后到点重试成功；三次都不成才收场并通知；删除 / 归档上次其实做成了；明确失败不重试；去掉的不再重试；只有重试时循环也转。
   - `drive/errors`：超时、连不上的说法。
   - `mcp-copy.itest`：删除档报错两种说法。
   - `life/handlers`：暂存区的说明。
   - 前端 tsc / eslint。
7. 收尾：后端全量、三包 tsc、两端 eslint；提交（不推送）。

### 进度（真机问题的修补）

- [x] 1 去向晚点再试
- [x] 2 超时说人话
- [x] 3 copy_add 报错
- [x] 4 前端两处
- [x] 5 监控说明
- [x] 6 测试
- [x] 7 收尾

### 实施记录（真机问题的修补，2026-09-28）

- **去向晚点再试**：
  - `copy/queue.ts`：记录加 `afterRetry { attempts, nextAt, why }`；`awaitingAfterRetry`、`hasCopyWork`（排着的，或去向等着晚点再做的）。
  - `copy/service.ts`：
    - 去向那段抽成 `applyAfterCopy(c, cfg, retry)`。Emby 刷新、目标侧整理还在 `afterCopiedInner`，只做一次。
    - 临时错误（`transientAfterCopyError`）：`driveErrorFacts` 的 transport / taskFailed、5xx / 429；账号问题（`accountIssueOf`）和中止不算。间隔 1 / 5 / 15 分钟（`AFTER_RETRY_DELAYS_MS`）。
    - 说明写「删源文件没成（…），1 分钟后自动再试（1/3）」；第四次还不成写「删源文件失败：…（自动重试 3 次都没成）」。
    - `tickCopies` 把到点的也拿进来，登记进 `tickRecords`；`retryAfterCopies` 从「复制完成」重拼说明再做，每条做完落库一次。复制设置被删了的直接收场（`settleAfterRetry`）。
    - 删除：重试时源不见了，当成上次已经删掉，照删本地 strm。
    - 归档：`archiveSourceReal` 带 `retry`，源不见了就看归档目录里同名的，节点 id 对得上才算归档成了，说明带「（上次其实已经挪过去了）」。
    - 循环的 `shouldContinue` 和 `startCopyWatcher` 改看 `hasCopyWork`。
  - `telegram/notify.ts`：`copy-done` 加 `retrying`（「源文件稍后自动再处理：…」）；新加 `copy-kept`（「复制后源文件没按设置处理」），和复制的其它通知一样走 offline 开关。重试那次收场没成的（超时用完、核对没过、节点换了等）都进 `copy-kept`；做成了不发。
- **超时说人话**：
  - `lib/errors.ts` 加 `networkErrorText`：axios 超时回「网盘接口 30 秒没有回应，稍后再试（原话）」，连不上回「连不上网盘接口（代码），稍后再试」。
  - `driveErrorToHttp` 兜底那支在前面带上是哪一步（「发起复制失败：…」）。
  - 复制去向的说明用它。
  - 115 的 `request115` 超时记 warn：主机 + 路径、方法、账号、限流通道，不带请求头和查询参数。
- `copy_add`：明说 `afterCopy: "delete"` 的报错是「afterCopy: "delete"（复制完删掉网盘上的源文件）要令牌有「删除」档」，按任务设置落到删除的照旧。
- 前端：
  - `lib/openlist-copy.ts` 加 `STAGING_DIRS`（和后端 `organize/duplicates.ts` 同名，改时两边一起动；shared 包只导出类型，放不了运行时常量）。
  - `AddCopyDialog` 的源目录树在任务根那一层滤掉它们；一条没排上时不显示「复制在后台跑…」。
- 监控：`handlers.ts` 加 `stagingOf` / `unmatchedReason`。
  - 暂存区里的新增 / 删除说「在任务的暂存区（归档）里，不处理」；
  - 挪进暂存区的说「移动进任务的暂存区（归档），已删除 …」。
- 测试：
  - `copy.itest` 加 5 个：超时后到点再删成、四次都超时才收场并发 `copy-kept`、上次其实删掉了、明确失败（普通报错、4xx）不重试、去掉的不再重试；删源的桩改成能按次抛错。
  - `archive-source.itest` 加 2 个：归档超时后到点挪成；上次其实挪过去了能认出来，id 对不上的不认、收场另发通知。
  - `lib/errors.test`、`drive/errors.test`、`life/handlers.itest`、`mcp-copy.itest`、`telegram/notify.itest` 各加 / 改 1 个。
- 变异核对：下面 13 处逐一去掉，对应用例各自失败，恢复后全过。
  - 临时错误一律不认；循环只看排着的；推进时不做到点的；不到点也做；
  - 删除重试时源不见不算删掉；归档不认上次挪成的；认的时候不核对 id；
  - 重试收场不另发通知；第一次通知不说稍后再试；次数不设上限；
  - 超时不换人话；监控不分暂存区；`copy_add` 报错不分明说。
- 后端全量 1323 个通过；三包 tsc、两端 eslint 通过。前端两处改动没在浏览器里看，只过了 tsc / eslint；真机没复验（造不出 115 超时，靠用例）。

### 真机验证（修补之后，2026-09-28）

用户说「真机测一下」。

**环境**：
- 同上一节：配置库只读拷贝、4100 只绑本机、OpenList 挂真 115 / 夸克和本地目录、Telegram 假服务、前端 dev 3223。
- 测试文件是几百 KB 的小视频，放在两个网盘的 `/v0928lab2`。
- 网盘超时造不出来，用预加载脚本在 axios 上按规则注入（规则文件改了就生效，同一规则的次数跨改动保留）：
  - `before`：请求不发出去，直接当 30 秒超时；
  - `after`：请求照发、网盘那边做成了，回话丢掉当超时，就是「其实做成了、只是没等到回话」。
- 除了注入，网盘、OpenList 复制、归档、删除、通知都是真的。

| 场景 | 注入 | 结果 |
|---|---|---|
| 115 剧A：整目录复制 + 归档 | `files/move` before ×1 | 第一次「归档源文件没成（…），1 分钟后自动再试（1/3）」，源和本地 strm 不动；1 分钟后挪进「归档」，本地 strm 删掉，不再发通知 |
| 115 剧B：整目录复制 + 归档 | `files/move` after ×1 | 115 上真挪过去了、回话丢了，记成稍后再试；重试时认出「已归档到 …（上次其实已经挪过去了）」，没挪第二次，本地 strm 删掉 |
| 115 剧C：文件复制 + 删除 | `rb/delete` after ×1 | 115 上真删了（进回收站）；重试时「网盘上已经没有这一份（多半上次已经删掉了），本地 strm 也删了」 |
| 夸克 剧Q：整目录复制 + 归档 | `file/move` before ×4 | 1 / 5 / 15 分钟各重试一次，第四次收场，见表下 |
| 115 剧D：界面新建复制 | 登记时 `GET files` before ×1 | toast「发起复制失败：网盘接口 30 秒没有回应，稍后再试（timeout of 30000ms exceeded）」，弹框留着；再点一次排上、复制完成 |

- 通知：第一次复制完成合成一条「已复制到 OpenList（手动）」，末尾写「源文件稍后自动再处理：…」三项；重试成了的不再发。
- 剧Q 在 13:27、13:28、13:33、13:49 各失败一次（1 / 5 / 15 分钟的间隔都对上了）。第四次收场：
  - 说明「复制完成；归档源文件失败：网盘接口 30 秒没有回应（自动重试 3 次都没成）」；
  - Telegram 单发「⚠️ 复制后源文件没按设置处理（手动）…复制已经完成；网盘上那份还在原处，需要的话手动处理」；
  - 夸克上源目录还在原处（旁边多一个第一次建好的空「归档」），本地 strm 保留；
  - 这一条收场后循环自己停了（「复制队列已清空，循环停止」）。
  - 整个过程后端没有一条 error。
- 115 超时时后端记了 warn「115 接口 30 秒没有回应」，带 `webapi.115.com/rb/delete`、`files/move`、方法、限流通道。
- 重启：剧Q 等最后一次时重启后端，队列里一条排着的都没有，循环照样起来（「复制队列循环启动」），到点接着做。
- 界面：
  - 新建复制的目录树根上只有「剧D」「剧C」，「归档」没列；
  - 再对剧D 发起一次，结果「目标里已经都有了」，没有「复制在后台跑」那句。
- `copy_add`（日常令牌、明说删除）：「afterCopy: "delete"（复制完删掉网盘上的源文件）要令牌有「删除」档」。
- 监控：两次挪进归档都记成「/v0928lab2/c115/归档/剧A 在任务的暂存区（归档）里，不处理」。115 的挪动事件不带旧路径，按新增处理。

**真机上改的一处**：复制说明和通知里原因用了带「稍后再试（英文原话）」的长说法，后面紧跟「1 分钟后自动再试」，读着别扭，还像在叫人自己重试。`networkErrorText` 加 `brief`，复制的去向只要原因本身：
- 「删源文件没成（网盘接口 30 秒没有回应），1 分钟后自动再试（1/3）」；
- 「删源文件失败：网盘接口 30 秒没有回应（自动重试 3 次都没成）」。

接口报错照旧是长说法。对应用例改了期望，加了 `brief` 的单测。

## 事后处理源文件：copy_after（2026-10-07）

起因：用户转述智能体的话「当前这个 MCP 版本没有单独的『把已复制完成的源文件移到归档』接口」。查了，属实，而且不只 MCP 没有：

- 去向（afterCopy）只能在登记那一刻定（任务设置，或 copy_add 这一次指定），记录上「登记时冻结」；`upgradeAfterCopy` 只补还在排队的。
- 对复制好的再 copy_add 传 archive：`enqueueManualCopy` 看到目标里已经有同名就判「目标里已经都有了」，一条不登记，归档意图静默丢掉。
- REST 只有看 / 发起 / 重试 / 去掉，面板只有重试和去掉；drive_browse 只读、organize 是改名、strm_delete 只删本地，智能体完全做不到。
- 伏笔：2026-09-25 方案把「从归档恢复」留到以后；真机那次记过「记录已经是已复制，面板上没有补做这一步的入口」，后来只加了临时错误自动重试。

用户说「按你的推荐开始吧」。

### 方案

**服务层**：新模块 `copy/after.ts`，`settleAfterCopy({ afterCopy: "archive" | "delete", ids? | task + paths?, dstDir?, allowDelete, signal?, onProgress? })`。

- 两种指法归到同一条处理路径：按路径为主（办完的记录只留两天，更早复制的只能这么指；和 copy_add 同一口径，`uniquePaths` 同一套校验），按 id 为辅（界面按钮、copy_list 给的 id）。
- 核对比复制完自动处理那道门严一层：源还在原处（知道节点 id 的要对得上）、目标里这一份齐了——目录逐层比名字（复用 `planFill`），文件比大小。为此 `TargetListing` 改成带类型 / 大小的 `entries()`（`names()` 由它派生），`planFill` 返回 `{ missing, mismatched }`（手动复制只看 `missing`），`deps.openlist` 多一个可选的 `listEntries`（桩只给 `listNames` 的照样能跑、只比名字）。不齐的 `incomplete`，让人先 copy_add 补（它只补缺的）。
- 动手复用 `applyAfterCopy`：导出，签名改成 `(c, cfg, { retry, verified })`，返回结构化的 `AfterCopyOutcome`（archived / removed / retry / kept），说明、`sourceKept`、`afterRetry` 照旧写在记录上。`verified: true` 跳过它自己那层一级核对。归档 / 删除 + 删本地 strm + 临时错误挂 `afterRetry` 由循环再做（这边 `startCopyWatcher` 把循环拉起来）都是现成的。当场回话、不发通知；挂到 `afterRetry` 的按老规矩由循环收尾通知。
- 记录：队列里有复制好的那条就接着用（`afterCopy` 改成这次的、`sourceKept` 清掉、`doneAt` 刷新、detail 前缀「复制完成（事后归档）」）；没有的新记一条 done、trigger manual、detail「目标里已经有这一份，事后处理源文件」，用 `saveCopies` 整份写（`commitCopies` 的 added 会按「刚复制过」去重，人把文件挪回来再归档一次时会把新记录吞掉）。还在复制的用 `upgradeAfterCopy`（导出，参数放宽成 Pick）补去向，结果 `scheduled`；记录上已经有去向的不改（先登记的算）。
- 两阶段：先只看不改（任何一条核对不了——网盘、OpenList 读不到——整个请求都不动；单条整目录太大 TOO_LARGE 只拦那一条），再逐条处理、随手写回；每条处理完叫一次 `onProgress`。动手前再看一眼任务有没有在整理。`resetArchiveDirCache` 开始前清一次目录链缓存（那份缓存本来是一轮一清的）。
- 判定 `afterCopyBlocker` / `canAfterCopy`（service.ts，和 `retryBlocker` 并列）：done、不是接管、有 taskId 和 rootPath、没在自动重试、去向是不动或 `sourceKept` 有值（归档里有同名、超时三次没成的还能再来）。pending 另算。
- 结果 `items[]` 每条：`outcome` = archived / deleted / retrying / kept / incomplete / missing / scheduled / pending / invalid，带 path（任务相对）、id、name、isDir、detail、to。

**REST**：`POST /api/copy/after`（write + transfer；删除按最终去向由服务层把关，令牌要 danger，会话不受限），`GET /api/copy` 每条带 `canAfterCopy`。

**工具** `copy_after`（transfer 组、write 档；注解 idempotent、非破坏性——归档可逆，删除靠档位把关，和 copy_add 一致）：ids 或 task + paths 二选一，afterCopy 必填；40 秒内直接回、超了交给作业用 job_status 等（和 share_save 同一套）。`copy_list` 每条带 `canAfterCopy`，有能处理的给一句提示；服务端说明的「概念」和 USAGE_NOTES 各加一句。工具 42 → 43。

**界面**：队列面板 `canAfterCopy` 的记录多一个「归档源文件」按钮，确认框说清先核对、归档放哪、本地 strm 删、怎么恢复；结果按 outcome 提示。删除不进界面（任务级设置和智能体有）。

**不做**：按记录 id 删除平铺复制（没任务）的源；「从归档恢复」仍是手动挪回。

### 实施记录（2026-10-07）

按方案做完，未提交。

- `services/copy/service.ts`：`OpenlistTargetEntry`、`deps.openlist.listEntries?`、`listOpenlistEntries`；`applyAfterCopy` 导出 + 返回 `AfterCopyOutcome`（说明文案一字没改，archive-source / copy 的用例原样过）；`upgradeAfterCopy` 导出；`resetArchiveDirCache`；`afterCopyBlocker` / `canAfterCopy`。
- `services/copy/manual.ts`：导出 `assertNotOrganizing`、`uniquePaths`、`TargetListing`（entries + names）、`planFill`（`FillPlan`）、`sizeMismatch`。
- `services/copy/after.ts`（新）：上面那套。
- `routes/copy/index.ts`：`POST /api/copy/after`、`canAfterCopy`。
- `services/agent/tools/copy.ts`：`copy_after`、`copy_list` 的 `canAfterCopy` 和提示；`tools/index.ts` 登记；`instructions.ts` 两句；快照 +1。
- 前端：`lib/api.ts` 的 `CopyItem.canAfterCopy`、`CopyAfterInput / Result`、`api.copy.after`；`CopyQueuePanel` 按钮 + 确认框 + 结果提示。
- README「智能体接入」两处。
- 测试：新 `copy/after.itest.ts` 10 条（按 id 归档、整目录缺项 / 大小对不上 / 齐了、排着的补去向、八种不能处理的原因、归档里同名 / 节点换了、按路径新记一条、按路径接着用旧记录 + 网盘没有 + 目标没有、十种拒绝、删除、超时挂重试到点挪成）；`routes/copy/copy.itest` +1、`routes/mcp/mcp-copy.itest` +1；manual / archive-source / copy / remove-source 四个文件 100 条原样过；工具快照更新。tsc、eslint 前后端都过。
- 真机（2026-10-07 下午，用户批准后在 115 上做的）：本机 OpenList 容器挂 `115 Cloud`（cookie 来自配置库只读拷贝）+ `Local`（scratch 目录），scratch 后端 4100、前端 dev 3223；115 根下建 `/v1007lab`，经 OpenList 上传三个 340 KB 的测试视频，`POST /api/copy` 复制到 `/local`（约 70 秒完成，去向不动）。
  - REST `POST /api/copy/after`（按 id）：3.6 秒，`archived`、`to: /v1007lab/归档`；记录 detail「复制完成（事后归档）；网盘上那份已归档到 /v1007lab/归档，本地 strm 也删了」，`canAfterCopy` 变 false；115 上 `/v1007lab/归档/after-test.mkv` 340827、原处没了；本地 strm 删了。**115 报的大小和 OpenList Local 报的一致**（340827），文件大小核对这一层在真机上不会误拦。
  - MCP（官方 SDK 客户端连 /mcp，日常令牌）：`copy_list` 每条带 `canAfterCopy`、提示指向 copy_after；`copy_after` 传 delete 报 INSUFFICIENT_SCOPE（提示换 archive）；ids 和 task + paths 一起给报 VALIDATION；按 `task: "v1007lab", paths: ["after-test2.mkv"]` 3.65 秒 `archived`（state done、带 jobId，接着用了队列里那条记录）；再来一次 `missing`「网盘上没有这条路径（源文件已不在原处）」。
  - 界面（3223）：队列面板只有去向是不动的那条有「归档源文件」按钮；确认框文案对；点「归档」约 4 秒后 toast「已归档到 /v1007lab/归档，本地 strm 已删」，行上变成「复制后归档」+ 新 detail，按钮消失。
  - 收尾：`/115/v1007lab`（里面只剩「归档」+ 三个测试视频）经 OpenList `fs/remove` 删进 115 回收站，根目录列表里已经没有它；容器 `docker rm -f`，带 cookie 的 scratch 文件删掉。
