# 设置页「网盘挂载」+「复制」：把挂载层配置从复制里拆出来

## 起因

2026-11-11 用户看着设置页问：「设置里 复制到 OpenList / CloudDrive2 和 CloudDrive2 这两个模块 是不是需要重新设计一下」。对着代码看下来是四处毛病，根子是「挂载层」（OpenList 或 CD2 的账号 + 各网盘挂在它里面的位置）这一个概念被拆在两节里：

1. **复制引擎切到 CD2 后，OpenList 的配置从页面上消失了，但还在生效。** `OpenlistCopySection.tsx` 按 `isCd2` 把「OpenList 账号」「挂载根」两块藏掉，可后端的 OpenList 目录缓存刷新不看引擎，照样用它们（`mount-cache/openlist.ts` → `copy/paths.ts` 的 `openlistMountConfigIfReady`，注释写明「复制引擎选了 CD2 的人 OpenList 挂载照样要刷」）。用 OpenList 挂载回源、又用 CD2 复制的人，这份配置看不到、改不了、也没法检查。
2. **同一类配置放在两个地方。** CD2 的映射有自己一节，OpenList 的映射却在「复制」那一节里。只想刷新缓存、不复制的 OpenList 用户也得去复制那节填，README 里写的就是「不开复制也行」。
3. **两节的依赖方向是反的。** 复制一节在上面，选 CD2 时却读下面那一节的值（`page.tsx` 的 `form.watch("cd2")`），提示语写「在下面填」。选 CD2 时两节的检查按钮调的都是 `/api/cd2/check`，结果都拼成一条很长的 toast。
4. **两套映射的校验不一样。** OpenList 这边会提示两个网盘账号填了同一个挂载根，检查时还逐个核对任务目录在不在；CD2 这边两样都没有。映射填错的后果两边一样：复制拿错文件，开了删源还会删错原件。两块代码基本是复制粘贴。

另外功能名「复制到 OpenList / CD2」读着像复制进 OpenList，实际是借它们复制到别的存储。给用户的推荐是只把设置页那一节改叫「复制」，任务弹框、strm 页、复制队列、智能体说明和 README 里的功能名先不动（改名面太大）。用户：「好的，按照你的推荐制定计划开始吧」。

写方案时又查到三处同一个根因（前端直接读 OpenList 那份配置、不看复制引擎）的功能问题，复制引擎是 CD2 的人碰得到：

- 云下载页的复制队列面板：`configured` 只看 `openlistCopy.account` + `mounts`。队列空着时整块不显示；有记录时「新建复制」是灰的，提示「先到设置页配好 OpenList 账号和挂载根」。
- 云下载弹框：「下载完成后复制走」的勾选框只在选了 OpenList 账号、这个 115 填了 OpenList 挂载根时才出现，选目标子目录列的也是 OpenList 账号。CD2 引擎下勾选框不出现。
- 新建复制弹框（`AddCopyDialog`）：选目标目录列的是 `openlistCopy.account`，CD2 引擎下列错了账号（没选 OpenList 账号时是空的）。

还有 Telegram 的三处按钮 / 回话写死「OpenList 复制走」，判断本身是按引擎的。

## 方案

### 设置页结构

```
网盘挂载（OpenList / CloudDrive2）       id="mount"，导航「网盘挂载」
  一段说明：挂载回源和复制都靠这里；填好了，改动网盘后会刷新它的目录缓存
  OpenList 面板（id="openlist"）
    标题条：名字 + 状态标（没配 / 账号不在了 / 没填路径 / N 个网盘）
    账号
    各网盘在 OpenList 里的挂载根（选目录；撞车警告；检查结果标在那一行下面）
    [检查连接和路径]
  CloudDrive2 面板（id="cd2"，老锚点照样能跳）
    同上，叫「在 CD2 里的路径」
  某种账号一个都没有、也没存过这一家的配置时，面板只剩一行「还没有 X 账号…」

复制                                   id="openlist-copy"（任务列表「复制没生效」的链接不变），导航「复制」
  用哪个复制：OpenList / CloudDrive2
    下面一行说这一家配齐没有：没选账号 / 账号不在了 / 一个网盘都没填 / 能复制哪几个网盘（没填的不复制），带去上面那块面板的链接
  默认目标目录：选目录走引擎那一家的账号
  [检查]：目标目录在不在；CD2 另看凭据和「获取传输任务」「复制」权限
```

- 不管引擎选谁，两块面板都一直显示。
- 两块面板是同一个组件（`kind = "openlist" | "cd2"`），两家只差文案、示例和连接检查：OpenList 列一次根目录 `/`；CD2 调 `/api/cd2/check`（地址、凭据；令牌的权限表读得到时看「浏览」那项缺不缺）。
- 映射行：撞车警告两家都有（同一家里两个网盘账号填了同一个路径，只算账户页现在还在的网盘账号）。检查结果按行标在输入框下面：路径打不开 / 任务目录对不上（路径 + 任务的 `originPath` 打不开）/ 能打开、N 个任务目录都对得上。这一行改过就不再显示旧结果，换了账号整块结果作废。
- 复制一节的检查只管目标目录和引擎自己要的权限；映射在上面的面板里查，不再两边各查一遍。
- 检查结果一条一行摆在页面上（✓ / ✗ / 提示），toast 只说一句结论。
- 账号列表由设置页读一次，分给两节（原来两节各读一次）。

### 数据

存的形状不变：`openlistCopy { engine, account, mounts, dstDir, srcDir }`、`cd2 { account, mounts }`。面板改 `openlistCopy` 的 `account` / `mounts` 和整个 `cd2`，复制一节改 `openlistCopy` 的 `engine` / `dstDir`；两节都经 `form.setValue(…, { shouldDirty: true })` 写同一个表单值，保存条照常数改动。没有迁移，后端读配置的逻辑不动。

### 文件

- 新：`settings/components/MountSection.tsx`（一节 + 面板组件）、`CopySection.tsx`、`check-lines.tsx`（检查结果的行）；`lib/mount-layer.ts`（`mountKey` / `mountClashes` / `joinLayerPath` / `mountExample`）+ `mount-layer.test.ts`。
- 删：`OpenlistCopySection.tsx`、`Cd2Section.tsx`。
- `lib/openlist-copy.ts`：加 `copyLayer(cfg, cd2)`（复制用的那一家：引擎、账号名、映射，和后端 `resolveCopyConfig` 同一个口径）、`copyLayerUsable`、`COPY_ENGINE_LABEL`。
- 顺带修：`CopyQueuePanel`、`AddOfflineTaskDialog`、`AddCopyDialog` 改用 `copyLayer`；Telegram 三处按 `copyEngineLabel`。

### 指路的话

「设置页的「复制到 OpenList」」「设置页的 CloudDrive2 一节」这类说法，按缺的是什么改成「设置页「网盘挂载」」或「设置页「复制」」：

- 后端：`copy/paths.ts`（`copyMountFieldLabel` 两家都带上「（设置页「网盘挂载」）」、`resolveOpenlistMountConfig`、`copySettingsGap`）、`cd2/config.ts` 的 `cd2AccountProblem`、`offline/service.ts` 两处、`telegram/commands.ts`、智能体 `tools/copy.ts` 三处和 `tools/transfer.ts` 一处；相关注释顺手改。
- 前端：`lib/openlist-copy.ts` 的 `copyGapInDialog`、`AddTaskDialog`、`AddCopyDialog`、`SaveToDriveDialog`、`CopyQueuePanel`。
- README：302 一节的回源提示、云下载那段（顺手把还停在 `srcDir` 时代的「先配好三样」改掉）、「CloudDrive2 账号」一节、「设置页」清单。

### 行为变化（方向用户已点头）

1. 设置页「复制到 OpenList / CloudDrive2」「CloudDrive2」两节换成「网盘挂载」「复制」；OpenList 的账号和挂载根搬到「网盘挂载」，引擎选哪个都看得见。
2. CD2 的映射也有撞车警告和任务目录核对。
3. 报错、智能体提示、Telegram 里指路的说法变了。
4. 复制引擎是 CD2 时：云下载页的复制队列面板和「新建复制」能用了，云下载弹框里出现「下载完成后复制走」；新建复制弹框、云下载弹框选目标目录列的是 CD2 账号；Telegram 按钮写「CloudDrive2」。

### 不做

- 不改存储形状、不迁移：内部名字（`openlistCopy`、`copyToOpenlist`）照旧。
- 不改功能名「复制到 OpenList / CD2」（任务弹框、strm 页、复制队列、智能体工具说明）、工具名、接口。
- 不加「刷新缓存」开关：openlist-cache-refresh.md 定过，配了挂载根就刷。
- 不把映射搬进账户页、挂在每个 OpenList / CD2 账号上：概念上更对、还能有多个挂载层，但要再迁移一次，后端读这两份配置的地方都得改，账户弹框也会变重；眼下没人要多个挂载层。
- 不把映射检查搬到后端：前端经通用的目录浏览接口查，两家同一套，CD2 只多一步连接检查。

## 测试

- 前端单测：`lib/mount-layer.test.ts`（`mountKey` 归一；撞车只算现在还在的网盘账号、空的不算；`joinLayerPath`；示例按类型和同类型数量）；`lib/openlist-copy.test.ts` 加 `copyLayer` / `copyLayerUsable`，文案断言跟着改。
- 后端只改文案：`routes/crud.itest.ts`「设置页还没选 OpenList 账号」、`copy/paths.test.ts` 三处 CD2 的断言跟着改；全量跑一遍。
- 浏览器冒烟（全新 scratch 库起 4100 + `next dev` 3223；scratchpad 里写一个假 OpenList（login / fs/list），CD2 用 `test/fake-cd2.ts`）：
  1. 设置页：两节和导航；`#openlist-copy`、`#cd2`、`#openlist` 三个锚点能跳。
  2. 面板：没有某种账号时收成一行；选账号、填路径、选目录；两家的撞车警告；检查——连不上、路径打不开、任务目录对不上、全对，结果标在对的行上，改一行只清那一行。
  3. 复制：切引擎时两块面板都在；配齐状态的几种说法和链接；默认目标目录选目录 / 检查；保存、刷新后还在。
  4. 云下载页：CD2 引擎下复制队列面板出现、「新建复制」能点，选目标目录列的是 CD2 账号；云下载弹框（115 账号）出现「下载完成后复制走」，选子目录列 CD2。
  5. 任务弹框的复制提示文案。
  - 宽屏 + 390px，深色 / 浅色。
- 真机：按 CONTRIBUTING 8.1 这次是界面、文案和前端入口的判断，后端行为不变，冷测 + 冒烟就够；评审修完后用户要了真机（见末节「真机验证」），CD2 引擎下经云下载弹框复制这条链路也在那里补上了。

## 进度

- [x] 方案（2026-11-11）
- [x] 后端文案 + 断言（2026-11-11）
- [x] 前端 lib + 单测（2026-11-11）
- [x] 设置页两节（2026-11-11）
- [x] 顺带修的三处 + Telegram（2026-11-11）
- [x] README（2026-11-11）
- [x] typecheck / lint / test 全量（2026-11-11：后端 1822 / 1822，前端 30 / 30）
- [x] 浏览器冒烟（2026-11-11，见末节）
- [x] 评审：`/code-review medium`，9 条全修（2026-11-11，见「评审与修补」）
- [x] 真机：OpenList + CD2 + 115 / 夸克，两处真机发现已修（2026-11-11，见「真机验证」）
- [x] 第二轮评审（真机后）：`/code-review medium`，9 条全修（2026-11-11，见「第二轮评审与修补」）
- [x] 提交 / 发版：v2.27.0 正式版（2026-11-11，见「发布」）

## 实施记录（2026-11-11）

**后端（只改文案，读配置的逻辑没动）**

- `copy/paths.ts`：`copyMountFieldLabel` 两家都带上「（设置页「网盘挂载」）」——这一栏在「网盘挂载」，而「复制没生效」的徽标链到的是「复制」一节；`resolveOpenlistMountConfig` 改成「复制还没配置好：设置页「网盘挂载」里还没选 OpenList 账号」（留着「还没配置好」，`followup.itest` 按它断言）；`copySettingsGap` 两条。
- `cd2/config.ts` 的 `cd2AccountProblem`（没选账号那句）；`offline/service.ts` 三处（挂载根那条去掉和括号重复的「先到设置页填上」、目标目录那条、旧 `srcDir` 的日志）；`telegram/commands.ts` 配置不全的提示；智能体 `tools/copy.ts` 三处、`tools/transfer.ts` 一处。注释：mount-cache 两个目标、`routes/cd2/check.ts`、`services/cd2/check.ts`（`mounts` 参数设置页不再带）、shared 的 `OpenlistCopySettings` / `Cd2Settings` / `Cd2CheckResult` / `AccountCd2`。
- Telegram 三处写死的「OpenList 复制走 / 复制到」按 `copyEngineLabel(copyEngineOf(settings))`。用例 `telegram/commands.test.ts`「贴磁力链接：复制引擎选的是 CloudDrive2 时按钮和回话都说 CloudDrive2，配没配看 CD2 那一份」。
- 断言跟着改：`routes/crud.itest.ts`（「设置页「网盘挂载」里还没选 OpenList 账号」）、`copy/paths.test.ts`（CD2 三处，两处挂载根的说法钉上「（设置页「网盘挂载」）」）、`copy/remove-source.itest.ts` 一句断言说明。

**前端**

- `lib/mount-layer.ts`（`mountKey` / `mountClashes` / `joinLayerPath` / `mountExample`）+ `mount-layer.test.ts` 4 条；`lib/openlist-copy.ts` 加 `COPY_ENGINE_LABEL` / `copyLayer` / `copyLayerUsable`（`openlist-copy.test.ts` +2），`copyGapInDialog` 的说法改指「网盘挂载」「复制」。
- `settings/components/MountSection.tsx`（一节 + 面板组件 `LayerPanel`）、`CopySection.tsx`、`check-lines.tsx`；删掉 `OpenlistCopySection.tsx`、`Cd2Section.tsx`。`page.tsx`：导航换成「网盘挂载」「复制」；账号列表页面读一次分给两节；两节经 `form.setValue(…, { shouldDirty: true })` 写 `openlistCopy` / `cd2`。
- 和方案不一样、方案外加的：
  - 两家的账号下拉选了账号之后多一项「不用 OpenList / 不用 CloudDrive2」：以前选上就回不到没选的状态（只能去删账号），面板状态标会一直黄着。
  - 路径输入（各网盘的路径、默认目标目录）打字时原样存、失焦再去两头空白：老的每敲一个键就 trim，路径中间的空格打不进去。后端读的时候本来就会 trim。
  - 面板标题条带状态标：未配置 / 没选账号 / 账号不在了 / 没填路径 / 路径重复 / N 个网盘。
  - 账号下拉、各路径输入都用 `htmlFor` 连上了标签。
- 顺带修的三处：`CopyQueuePanel` 用 `copyLayerUsable`；`AddOfflineTaskDialog` 用 `copyLayer`（state 从 `openlistCopy` 改名 `copySetup`）；`AddCopyDialog` 用 `copyLayer`，标题改「新建复制」、说明按引擎说、选子目录列引擎那一家的账号，挂载层账号的任务不再说「到设置页补上」。指路文案：`SaveToDriveDialog`（勾选框改叫「转存后复制走（OpenList / CD2）」）、`AddTaskDialog`、`CopyQueuePanel`。
- README：302 一节回源提示、云下载那段（停在 `srcDir` 时代的「先配好三样 …/115/云下载」换成「网盘挂载」+「复制」两处，勾选框名字对上界面）、Telegram 按钮、「CloudDrive2 账号」一节、「设置页」清单加「网盘挂载」「复制」两条。

**测试**：三包 typecheck / lint 过；后端全量 1822 / 1822（5 分 06 秒，比上次多的一条是 Telegram 那条），前端 30 / 30（+6）。改过的 33 个文件扫过不可见字符和特殊空白：0。冒烟后又改了两处前端（状态标、toast），前端 typecheck / lint / 单测重跑过。

## 浏览器冒烟（2026-11-11）

**环境**：全新 scratch 库起 `127.0.0.1:4100`，预加载把 115 / 夸克账号换成 `FakeDrive`，`HTTPS_PROXY` 指到 `127.0.0.1:9` 挡住所有出站 HTTPS（115 云下载列表因此报连不上，预期内）；scratchpad 里写的假 OpenList（`127.0.0.1:5299`，只认 login / fs/list）；`test/fake-cd2.ts` 起的假 CD2；`next dev` 3223。账号 my115（115）、kk（夸克）、ol（OpenList）、nas-cd2（CD2），任务 my115 `/tv`、kk `/shows`。口令换成临时随机的，token 由只听回环口、给一次就退出的小服务交给页面，没进工具输出。

| 场景 | 结果 |
|---|---|
| 设置页结构 | 导航「网盘挂载」「复制」；`#mount`、`#cd2`（老锚点落在 CD2 面板上）、`#openlist-copy` 都跳得到 |
| OpenList 面板 | 选账号后状态「没填挂载根」，按钮旁黄字；my115 填 `/115`、kk 填「 /115/ 」→ 两行都出撞车警告（写法不同也认），失焦去掉了空白；检查 → my115「能打开，1 个任务目录都对得上」，kk 输入框标红、「1 个任务目录在 OpenList 里找不到（/115/shows）：挂载根多半填错了」，按钮下「连上了」，toast 一句；kk 改成 `/quark` → 只清掉 kk 那行的旧结果，再检查全绿 |
| CloudDrive2 面板 | 选目录弹框列出 CD2 根下的 115open、夸克网盘、hdd；两行填同一个路径 → 撞车警告（以前 CD2 没有）；检查 → 地址、凭据两行，kk 标红「1 个任务目录在 CD2 里找不到（/115open/shows）：路径多半填错了」（以前 CD2 不查任务目录）；改对后全绿 |
| 复制 · OpenList 引擎 | 「用 OpenList 账号「ol」复制，能复制的网盘：my115、kk（夸克）。改」；选目录弹框列 OpenList 根，选 `/local/downloads`，检查「默认目标目录 /local/downloads 在」 |
| 复制 · 切到 CloudDrive2 | 上面两块面板都还在；说明、占位、检查按钮（「检查目标目录和令牌权限」）跟着换；目标还是 OpenList 的路径时检查报「默认目标目录（/local/downloads）所在的 /local 打不开」，另一行「能看传输任务，复制进度盯得到」；从 CD2 里选 `/hdd/media` 后全绿 |
| 保存、刷新 | 库里 `openlistCopy {engine: cd2, account: ol, dstDir: /hdd/media, mounts}`、`cd2 {account: nas-cd2, mounts}`，形状没变；刷新后都在 |
| 账号被删 | 删掉 nas-cd2：从 `#openlist-copy` 进来，「复制」说「「网盘挂载」里给 CloudDrive2 选的账号「nas-cd2」已经不在了，复制不了。去换一个」，链接跳到 CD2 面板（状态「账号不在了」、下拉里「nas-cd2（已不存在）」）；选「不用 CloudDrive2」→「没选账号」；清掉两行路径 → 面板收成一行「还没有 CloudDrive2 账号…」 |
| 云下载页（库里 `openlistCopy` 只剩 engine 和 dstDir，没有 OpenList 账号和挂载根） | 复制队列面板照样出现、「新建复制」能点（改之前这种配置下整块不显示）；新建复制弹框标题「新建复制」，说明「…交给 CloudDrive2…」，选子目录「在 /hdd/media 下面选一个目录（CloudDrive2 账号 nas-cd2）」；添加云下载弹框里出现「下载完成后复制走（OpenList / CD2）」，勾上后列的是 CD2 的 `/hdd/media`（改之前不出现） |
| 任务弹框 | 复制开关的说明「…先在设置页「网盘挂载」里配好 CloudDrive2 账号和这个网盘在 CD2 里的路径，在「复制」里填好目标目录」 |
| 窄屏 / 主题 | 390px iframe 深色、浅色各一份：两块面板、复制一节、检查结果行都正常 |
| 控制台 | 开着控制台跟踪重新加载，三个检查各跑一遍：没有报错，也没有 React 警告 |

**冒烟里改掉的**：两个网盘撞车时面板状态标还是绿的「2 个网盘」→ 加「挂载根重复 / 路径重复」；OpenList 引擎检查通过的 toast 也说「权限」→ 按引擎说。

**日志**：scratch 后端除了三条「connect ECONNREFUSED 127.0.0.1:9」（115 云下载列表被挡住）和改口令前的默认口令提示，没有别的告警和报错。

**收尾**：前端、后端、两个假服务都停了，3223 / 4100 / 5299 没人听；scratchpad 清空（scratch 库、临时口令、token、脚本、日志）；浏览器里这个来源的 localStorage 已清空。冒烟用的第一个标签页卡在「离开此网站？」提示上关不掉（页面里有没保存的改动），要手动关一下。

**没验的**：真机（按 CONTRIBUTING 8.1 这次是界面、文案和前端入口的判断，冷测 + 冒烟）；CD2 引擎下经云下载弹框真复制一次（后端那条链路 rc.2 真机只走过 `POST /api/copy`）；OpenList 连不上时面板的说法（没起断开的假服务）。

## 评审与修补（2026-11-11）

用户：「review」。`/code-review medium`（评审默认中等强度），9 条，全修：

1. 「检查连接和路径」不算撞车：两个网盘账号填了同一个挂载根、各自的任务目录又都打得开时，检查报「都对得上」（原来的 OpenList 检查会把撞车算进错误）→ 撞车的行检查结果标红「能打开，但和 X 填的是同一个挂载根，分不清是哪个网盘的文件」，算进 toast 的错误数 → 复测：my115 / my115b 都填 `/115`、两边 `/tv` 都在，两行都是这句、toast「OpenList：2 处不对」。
2. 各网盘的路径打字时不再去空白、只在失焦时去，⌘S 不失焦就保存会把空白存进去 → 打字时照旧原样留着（中间的空格才打得进去），设置页提交时（`toSettings`）统一 `tidyMounts`：去两头空白、丢掉空的 → 用例 `mount-layer.test.ts`「withMount / tidyMounts…」；复测：输入框还在焦点上就 ⌘S，库里存的是 `/115open/my 115b`。
3. 默认目标目录同上 → 提交时 `dstDir.trim()`；复测存的是 `/hdd/my media`（中间的空格留着）。评审说的「失焦去空白后检查结果的键变了、结果会消失」不成立：键本来就用 `dst.trim()`。
4. 账号列表读不出来时（`accounts` 为 null、`accountsFailed`），「复制」掉到「用 X 账号复制」那句灰字，像是配好了 → 多一种说法「账号列表没读出来，确认不了「网盘挂载」里选的 X 账号「…」还在，刷新页面再试」（黄字）→ 复测：在页面里把 `GET /api/account` 改到一个不存在的地址再进设置页，出的就是这句。
5. CD2 面板的检查只说浏览缺什么，同步 / 整理缺的权限在设置页上看不到了（原来那一节会列整条权限）→ 读得到权限表时：浏览缺了标红，否则把整条「权限：…」列出来（缺了是黄色提示，不算进红绿：只刷新目录的人用不着整理那几项）→ 复测：假 CD2 令牌开「令牌管理」、只勾列出 / 读取 / 复制 / 获取传输任务，面板出黄字「权限：令牌缺权限：整理缺「创建文件夹」「重命名」「移动」「删除」；复制缺「创建文件夹」」，「复制」一节的检查标红「令牌缺复制要的权限：「创建文件夹」」。
6. 检查一个个串着列目录，几十个任务要等十几秒 → 新 `lib/async.ts` 的 `mapLimit`，先并发看各路径本身、再并发查打得开的那些下面的任务目录，上限 4 → 用例 `async.test.ts` 两条；复测：假 OpenList 每次列目录压 150 ms，记到的同时在跑的峰值是 4。
7. 任务弹框和 `copyGapInDialog` 还在各自手写「引擎 → 账号 / 映射」→ 都改用 `copyLayer` + `COPY_ENGINE_LABEL`，账号在不在用新的 `layerAccountStatus`（`mount-layer.ts`，设置页两节、任务弹框、`copyGapInDialog` 共用）；任务弹框「从 X 里选」顺带补上了 OpenList 引擎下账号被删时也灰掉（原来只有 CD2 查）→ `openlist-copy.test.ts` 原有断言不动照过，`mount-layer.test.ts`「layerAccountStatus…」；复测任务弹框文案、选目录按钮、占位都对。
8. 「复制」一节和面板各有一份「打不打得开」「账号在不在」、选目录弹框 → `layerAccountStatus` 进 `mount-layer.ts`；`openProblem` 和 `LayerDirPicker`（`load` 用 `useCallback` 稳住，TreeSelectDialog 的 load 一换就重拉根目录）进新的 `settings/components/layer-common.tsx`，两节都用它。
9. OpenList 的映射还放在 `openlistCopy` 里，两节各自拿渲染时的那份合并写回，晚到的回调（比如选目录弹框）会拿旧快照把另一节刚改的冲掉 → 存储形状按方案不动（不迁移是给用户推荐、用户点了头的），具体的风险改掉：设置页给两节的是 `updateOpenlistCopy(fn)` / `updateCd2(fn)`，每次都按 `form.getValues` 拿到的当前值改；面板里的改动都写成「按当前值改哪几个字段」（`withMount` 等）。复测：先在「复制」切引擎，再改 CD2 面板一行路径、再改目标目录，⌘S 保存：库里引擎、目标目录、CD2 那一行都是新值，OpenList 的账号和三行挂载根原样没丢。「选目录弹框晚到」那种时序没有专门造。

修完：三包 typecheck / lint 过；前端单测 34 / 34（+4：`async.test.ts` 2、`mount-layer.test.ts` 2）；后端这一轮没动（全量仍是上面的 1822 / 1822）；改过的 34 个文件扫过不可见字符：0。评审修补涉及的场景在新的 scratch 环境里复测过（同冒烟那一套，假 CD2 令牌改成能读权限表、缺整理和「创建文件夹」；加了第二个 115 账号 my115b 和它的 `/tv` 任务造撞车），结果见上面各条；开着控制台跟踪重新加载、三个检查各跑一遍，没有报错和警告；收尾同上：服务都停了、scratchpad 清空、浏览器里的 token 删了、标签页关了。

## 真机验证（2026-11-11）

用户：「真机测试吧」。写操作逐件问过，用户批准了：建 lab 目录、传测试视频、经 OpenList 复制一次；本机起 lab CD2；经 CD2 复制一次、云下载加复制一次；收尾时删掉网盘上留下的东西。

**环境**

- lab 库：`config/openstrm.db` 只读拷到 scratchpad。这个库还停在迁移 15，起后端前用脚本迁到 30。关掉了 Telegram、Emby、TMDB、HDHive、PanSou、网盘监控、自动整理、更新检查、收藏夹巡检、智能体；删了 3 个生产任务、追更和云下载回执；管理口令换成临时随机的。后端 `127.0.0.1:4100`，`next dev` 跑在 3223。
- 真实库里只有 115 和夸克两个账号，没有 OpenList / CD2 账号，也没存过挂载配置，所以设置页一进来就是两块面板都没配的样子。
- OpenList：本机 Docker 起 `openlistteam/openlist` v4.2.9（`127.0.0.1:5244`），lab 账号叫 `ol-lab`。三个存储：
  - `/115`：115 Cloud，cookie 从 lab 库拷贝里读
  - `/quark`：Quark
  - `/local`：Local，挂 scratchpad 里的目录当复制目标
- CD2：本机 Docker 起 `cloudnas/clouddrive2` v1.1.3（`127.0.0.1:19798`，arm64），只挂 `/Config` 和一个本地目录，没开 FUSE。用户自己登录、扫码授权 115 开放平台（根目录 `/115open`）、加本地文件夹 `/media`、生成令牌（勾了令牌管理）。lab 账号叫 `cd2-lab`。
- lab 任务：`115 · lab1111/tv → lab1111-115`、`kuake · lab1111/tv → lab1111-kuake`，都没有 cron。
- 网盘上的东西：
  - 115、夸克各建了 `/lab1111/tv`
  - 往 115 传了本机 ffmpeg 生成的 `lab1111.S01E01.mkv`（305,059 B）
  - 115 云下载了公开样片 `Big_Buck_Bunny_360_10s_1MB.mkv`（test-videos.co.uk，957,162 B）

**场景**

| 场景 | 结果 |
|---|---|
| 设置页初始（真实库：只有 115 / 夸克，没有挂载配置） | OpenList 面板「未配置」，两行占位 `/115`、`/quark`；CD2 面板收成一行「还没有 CloudDrive2 账号…」；「复制」一节黄字「「网盘挂载」里 OpenList 还没选账号，选好之前不会复制」 |
| OpenList 面板：选账号、选目录 | 选 `ol-lab` 后状态变「没填挂载根」。选目录弹框列出 OpenList 根（115 / quark / local），展开 115 是真 115 的根目录（云下载、tv、movie…），夸克也一样。填 `/115`、`/quark` 后状态「2 个网盘」 |
| 检查：任务目录还没建 | 改之前两行都标红「1 个任务目录在 OpenList 里找不到（/115/lab1111/tv）：挂载根多半填错了」，可挂载根其实是对的（见下面「真机发现的问题」1）。改之后两行黄字「能打开；1 个任务的目录在网盘上就不在（/lab1111/tv），和挂载根无关…」，输入框不标红 |
| 检查：建好目录后 | 两行「能打开，1 个任务目录都对得上」，toast「OpenList 连上了，各网盘的挂载根都对得上」 |
| 检查：夸克故意填 `/local` | 夸克那行标红「1 个任务目录在 OpenList 里找不到（/local/lab1111/tv）：挂载根多半填错了」，toast「OpenList：1 处不对，看标红的几行」。网盘上有、挂载层里没有，照旧算填错 |
| 检查：夸克故意填 `/115`（和 115 撞） | 状态「挂载根重复」，夸克那行出撞车提示；检查后两行都红「能打开，但和 … 填的是同一个挂载根，分不清是哪个网盘的文件」。`/115/lab1111/tv` 真的打得开，没有撞车判断的话这里会报「都对得上」 |
| 复制 · OpenList | 「用 OpenList 账号「ol-lab」复制，能复制的网盘：115、kuake（夸克）」。目标填 `/local/lab1111`，检查「还不存在，第一次复制时会自动建」。保存后 `openlistCopy {account, dstDir, mounts}`、`cd2 {}` |
| 云下载页 · OpenList 引擎 | 复制队列面板出现，「新建复制」说「交给 OpenList」，选子目录列 `ol-lab` 的 `/local/lab1111`。云下载弹框里有「下载完成后复制走」，勾上列 `/local/lab1111`。任务弹框打开复制开关后没有缺项提示，「复制到哪」的占位是默认目标目录 |
| CD2 面板 | 有了 CD2 账号面板就展开。选目录弹框列出 `/115open`、`/media`。115 填 `/115open`，检查「能打开，1 个任务目录都对得上」；连接三行：地址「连上了，CD2 已登录（…）」、凭据「API 令牌可用」、权限「令牌权限齐全…」。故意填 `/media` 报「1 个任务目录在 CD2 里找不到（/media/lab1111/tv）：路径多半填错了」 |
| 复制 · 切到 CD2 | 「用 CloudDrive2 账号「cd2-lab」复制，能复制的网盘：115；kuake（夸克） 没填路径，不复制」。目标还是 `/local/lab1111` 时检查报「所在的 /local 打不开：目录不存在: /local」，另一行「能看传输任务，复制进度盯得到」；改成 `/media/lab1111` 后「还不存在，第一次复制时会自动建」，toast「目标目录和令牌权限都没问题」。保存后 `openlistCopy.engine` 是 `cd2`，OpenList 的账号和两行挂载根原样留着 |
| 云下载页 · CD2 引擎 | 「新建复制」说「交给 CloudDrive2」，选子目录「在 /media/lab1111 下面选一个目录（CloudDrive2 账号 cd2-lab）」；云下载弹框里「下载完成后复制走」列的是 CD2 的 `/media/lab1111` |
| 真复制 · OpenList | 「新建复制」选 115 · lab1111/tv 下的 `lab1111.S01E01.mkv`，复制到 `/local/lab1111`。日志「已提交 OpenList 复制 1 项」→「复制完成」；文件落到本地存储，305,059 B，md5 和原件一致；面板「已复制 … 复制完成」 |
| 真复制 · CD2 | 同一个文件复制到 `/media/lab1111`。日志「已提交 CloudDrive2 复制 1 项：/115open/lab1111/tv → /media/lab1111」，30 秒后「复制完成」；md5 一致 |
| 云下载 + 复制 · CD2（rc.2 起没在真机上走过的那条） | 115 离线下载样片到 `lab1111/tv`，30 秒后日志「云下载完成… 已生成 1 个 strm」、「登记 1 个待复制（115 → /media/lab1111，来自云下载）」。接着 OpenList、CloudDrive2 各刷新了 1 个目录的缓存（引擎是 CD2，OpenList 那份映射照样在用）。然后「已提交 CloudDrive2 复制」→「复制完成」，文件 957,162 B，md5 和源站一致；strm 内容是 `/lab1111/tv/Big_Buck_Bunny_360_10s_1MB.mkv` |

**真机发现的问题（已修）**

1. **任务目录在网盘上本来就不在时，检查把填对了的挂载根标红。**
   - 现象：目录还没建、改了名或删了，面板都说「挂载根多半填错了」。老 OpenList 检查就是这个说法，这次 CD2 也用上了同一套。
   - 原因：只看挂载层里找不找得到。
   - 修法：
     - 挂载层里找不到的，再用网盘账号直接查一次任务目录。只有回 404 才算不在；cookie 过期这类别的错，照旧按填错说。
     - 网盘上就不在的单独说，黄字，不算错；和填错、撞车同时出现时附在后面。
     - 结论抽成 `lib/mount-layer.ts` 的 `mountRowVerdict`，两家面板共用。
     - 有黄字时 toast 也说「有要留意的地方」。以前 CD2 只缺整理权限那种黄字，toast 也报「都对得上」。
   - 用例：`mount-layer.test.ts`「mountRowVerdict：网盘上就没有的任务目录不怪这里填的路径…」。
   - 复跑：目录没建时两行黄字；建好后全绿；夸克填 `/local` 照旧标红。
2. **云下载完成后才排进来的复制，要刷新页面才看得到。**
   - 现象：页面开着时，云下载页的复制队列面板一直不出现这条复制。CD2 引擎下的「下载完成后复制走」这次才有入口，看上去像是没复制。
   - 原因：面板只在有在跑的复制时轮询；空闲时别处登记进来的，它不知道。
   - 修法：云下载页把各条回执的状态拼成 `refreshKey` 传给 `CopyQueuePanel`，一变面板就重新拉一次；拉到在跑的复制，面板自己的 5 秒轮询就接上了。（第二轮评审后换成了空闲轮询，见「第二轮评审与修补」第 4 条。）
   - 复测：没有组件测试的架子，在浏览器里截住 `/api/115/offline` 的回话。回执状态不变时，云下载列表拉 3 次、复制队列 0 次；来回翻状态时，两边各 4 次。
3. **不是代码问题，记进 drive-notes。**
   - OpenList v4.2.9 首次启动不建 admin，要带 `OPENLIST_ADMIN_PASSWORD`。
   - 115 新建目录要等 `files/getid` 认（drive-notes 原来就有这条）。这次 14:17 建、14:21 才能按路径找到，这期间「新建复制」的「从网盘里选」是空的。

**日志**

- lab 后端 1387 行全是 info，没有告警和报错。
- 27 个 404 都是查不存在的目录：建目录之前、115 认出新目录之前、目标目录还没建、删完之后的核对。
- CD2 容器日志里没有报错。

**收尾**

- 网盘：经 OpenList 删掉了 115 和夸克上的 `/lab1111`（115 的两个文件进了回收站）；115 云下载列表里样片那条记录也删了（只删记录）。两边按路径查都是 404。
- 本机：两个容器 `docker rm -f`、镜像 `rmi`，Docker Desktop 关了。lab 库（cookie、CD2 令牌）、OpenList 数据、CD2 配置（登录状态、115 授权、令牌）、样片、脚本、日志都随 scratchpad 一起删了。
- 浏览器：token 删了，标签页关了。

**修完**：前端 typecheck / lint 过，单测 35 / 35（+1：`mount-layer.test.ts` 的 `mountRowVerdict`）；后端这一轮没动；改过的 36 个文件扫过不可见字符：0。

## 第二轮评审与修补（2026-11-11）

用户：「review吧」。`/code-review medium`，看的是整个没提交的改动（包括真机后的两处修补），9 条，全修：

1. **任务列表「复制没生效」的徽标永远跳 `#openlist-copy`。** 现在那是「复制」一节，可多数卡住的原因（没选挂载层账号、没填挂载根 / 路径、选的账号不在了）要到「网盘挂载」里改。
   - 修法：后端把判断收进 `copyBlockFor`，一次给出原因和去哪儿改（`CopyBlockSpot`：`openlist` / `cd2` / `copy` / `null`）。`copySettingsGap`、`copyBlockerFor` 改成在外面包一层只取原因，判断只有一份。
   - `GET /api/task` 多带 `copyBlockedAt`。徽标按它跳到 `#openlist` / `#cd2` / `#openlist-copy`；挂载层账号的任务（`null`）打开任务设置。提示语也跟着说「去设置页」还是「打开任务设置」。
   - 用例：`paths.test.ts`「copyBlockFor：卡在哪的同时说去设置页哪儿改…」，`crud.itest.ts` 的 `GET /api/task` 加了 `copyBlockedAt` 断言。
2. **云下载弹框不核对选的挂载层账号还在不在。** 账号删了，「下载完成后复制走」照样出现，选子目录列个空，提交时才被后端拒。修法：打开时连同设置一起读账号列表，`layerAccountStatus` 说不在就不给这一块；账号列表读不到就只看设置。
3. **复制队列面板的 `configured` 只看有没有账号名。** 选的账号删了，「新建复制」照样能点。修法：`copyLayerUsable(layer, accounts)` 也要账号还在（同名的别的类型也不算），面板连同设置一起读账号列表。用例：`openlist-copy.test.ts`「copyLayerUsable…」加了账号删了、类型不对两种。
4. **`refreshKey` 只治了一个症状。** 只有云下载回执的状态变了才重新拉；转存、追更、监控、智能体排进来的复制照样看不到，打开页面时还会拉两次。修法：去掉 `refreshKey`（云下载页回到原样），面板空闲时每 20 秒看一眼，有在跑的照旧 5 秒；没配复制、队列又空着的不看，页面在后台也不看。
5. **CD2 那次「获取传输任务」探测的结果，读得到权限表时也摆出来了。** 旧代码只在读不到权限表时才用它，现在探测碰上一次临时出错，就会和权限表打架、出黄字。修法：读得到权限表就以它为准，复制那项不缺就说「令牌的复制权限齐全」；读不到才看探测。
6. **`resolveOpenlistMountConfig` 没选账号时说「复制还没配置好」。** 这个函数刷新目录缓存也在用（那边没配就回 null，不会报出去），这句话说成复制不对。修法：它自己改成中性的「OpenList 挂载还没配置好：…」；「复制还没配置好：…」挪到 `resolveCopyConfig` 里先说，复制时看到的话一字不变（`followup.itest` 照旧按「还没配置好」断言）。
7. **智能体给用户指路时还说「云下载页的「复制到 OpenList」」「任务设置里关掉「复制到 OpenList」」。** 界面上那块面板和任务开关都叫「复制到 OpenList / CD2」。
   - 修法：这些指路的话改成界面上的叫法：`tools/copy.ts` 6 处、`tools/transfer.ts` 4 处、`copy/paths.ts` 的 `COPY_ALWAYS_ON` 报错。
   - 注释里两处说的是旧设置页一节，也改了：`tools/copy.ts` 的映射来源、`mount-cache/refresh.ts`。
   - 工具标题、描述里的功能名按方案不改，智能体的工具列表因此没变。
8. **两家的叫法三处各写一份。** `MountSection` 的 META、`CopySection` 的三元式、`copyGapInDialog` 写死的「在 CD2 里的路径」。修法：`lib/mount-layer.ts` 加 `LAYER_META`（全名、简称、那一栏叫什么、面板锚点），三处都从它取。`COPY_ENGINE_LABEL` 也由它来，面板的 `id` 用它的锚点。说出来的话一字没变，原有断言照过。
9. **Telegram 云下载回话里的引擎是事后另读一遍设置拿的。**
   - 评审说「回执记的是另一家」不成立：回执不记引擎，下完才按当时的设置排队。
   - 但回话该说这次添加时核对用的那一家。修法：`addOfflineTasks` 的回包加 `copyEngine`，回话按它说。
   - 用例：`telegram/commands.test.ts`「云下载回话说的引擎按回包里添加时核对用的那一家…」。

**复测**（全新 scratch 库 + `next dev`，占位账号 my115 / ol / nas-cd2，出站全挡）：

| 场景 | 结果 |
|---|---|
| 接口按配置给的 `copyBlockedAt` | 什么都没配 → `openlist`；OpenList 齐了、没目标目录 → `copy`；CD2 没填路径、CD2 账号不在了 → `cd2`；挂载层账号的任务 → `null` |
| 徽标点击 | CD2 账号不在了：跳到 `/settings#cd2`，面板在视口里（「账号不在了」）；没目标目录：跳到 `/settings#openlist-copy`；挂载层账号的任务：打开「编辑任务」 |
| 「复制」一节 CD2 检查（页面里截住 `/api/cd2/check` 的回话） | 权限表说齐全、探测临时失败：只说「令牌的复制权限齐全」，toast success；没有权限表：照旧黄字「令牌读不了传输任务…」，toast warning |
| 复制队列面板 | 账号在：显示、「新建复制」能点；空闲时 `/api/copy` 每 20 秒一次（第 9、29 秒）；CD2 账号换成不在的：队列空着时整块不显示 |
| 云下载弹框 | 账号在：有复制那一块（这条任务开着复制，锁成勾上）；账号不在：没有 |
| 控制台 | 任务、设置、云下载三页重新加载：没有报错和警告 |

**修完**：
- 前端 typecheck / lint 过，单测 35 / 35。
- 后端 typecheck 过。改到的几组先单独跑过：`paths.test` 16、`telegram/commands.test` 34、`crud.itest` 34、`offline/followup.itest` 32、`mcp-copy.itest` 21，都过。
- 后端全量 1824 / 1824（5 分 09 秒，比上次多的 2 条就是这轮加的）；全仓 typecheck / lint 过；改过的文件扫过不可见字符：0。

## 发布（2026-11-11）

用户：「发正式版吧」。没走 rc，直接发正式版（v2.23.0、v2.24.0、v2.25.0 也是这样）。

- 提交：
  - `0b0b57d feat(settings): give mount layers their own section and make copy follow the engine`
  - `8ea3be0 docs(plans): record the mount/copy settings split, its reviews and real-device run`
  - `0112463 chore(release): v2.27.0`（只改三个 `package.json` 的版本号）
- tag `v2.27.0`（注释 `v2.27.0`）。`v2.26.0..v2.27.0` 带了 f4ab0a9（v2.26.0 的发布记录）和上面三个提交。
- 发版前在改好版本号的这份代码上跑了根目录 typecheck / lint / test：后端 1824 / 1824，前端 35 / 35。
- 20:56 UTC `git push origin v2 v2.27.0`，main 从 d294614 快进到 0112463（main == v2 == v2.27.0）。
- 21:08 UTC 全部核对完：
  - Release 四个作业 + CI@v2 + CI@main 全绿；
  - Docker Hub `v2.27.0` 和 `latest` 同为 074e269948f7（amd64 + arm64）；
  - GitHub Release 不是 prerelease，是仓库最新。
- 迁移：没有。设置键：没有新的（存储形状不变）。接口：`GET /api/task` 每行多了 `copyBlockedAt`；`addOfflineTasks` 的回包多了 `copyEngine`（Telegram 回话用）。
- 升级说明交用户手动贴，要点：
  - 设置页两节换成「网盘挂载」「复制」，不用改配置；
  - CD2 引擎下云下载页三处复制入口能用了；
  - 任务列表「复制没生效」按原因跳到对的地方；
  - 复制队列空闲时也会刷新；
  - 选的账号被删了，复制入口就不出现；
  - 指路的说法改了。
- 盯梢时碰到两件事：
  - GitHub 的作业列表接口对匿名请求有一阵一直回 502，脚本改成取不到就看整个运行的结论；
  - 运行列表已经显示 completed / success 时，第四个作业（Merge manifest and release）可能还在跑，要以作业的结论为准。
