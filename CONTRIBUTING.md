# 贡献指南

这份文件记录的是本仓库实际在用的开发流程：怎么分支、怎么提交、改动要配什么测试、方案和记录写在哪、评审怎么收口、什么改动必须在真网盘上验过、怎么发版。人读这份；AI 助手先读 `CLAUDE.md`（只摘了硬规矩），细节仍以这里为准。

1. [分支与版本](#1-分支与版本)
2. [提交信息](#2-提交信息)
3. [本地环境](#3-本地环境)
4. [代码约定](#4-代码约定)
5. [自动化测试](#5-自动化测试)
6. [方案文件](#6-方案文件)
7. [评审](#7-评审)
8. [真机测试](#8-真机测试)
9. [发布](#9-发布)
10. [PR 清单](#10-pr-清单)

## 1. 分支与版本

| 分支 | 用途 |
|---|---|
| `v2` | 开发分支。所有 PR 都以它为目标 |
| `main` | 永远等于最新正式版。只在发正式版时从 `v2` 快进，平时不接 PR、不直接提交 |
| `v1` | 旧版，已冻结，只做保底 |

- 历史是一条直线，没有 merge 提交。PR 只用 rebase 合入；合入前把分支 rebase 到最新的 `v2`。仓库设置里只开放 rebase 合入，不用 merge 或 squash 按钮。
- 功能分支叫 `feat/<topic>` 或 `fix/<topic>`。
- 版本号写在根目录、`apps/backend`、`apps/frontend` 三个 `package.json` 里（`packages/shared` 不带版本），只在发版提交里改，功能 PR 不要动。
- 版本标签：`vX.Y.Z-rc.N` 是预发布，只推 `v2` 和 tag；`vX.Y.Z` 是正式版，发完把 `main` 快进过去。细节见第 9 节。
- 只有维护者发版、推 tag。

## 2. 提交信息

格式是 `type(scope): 英文祈使句`，正文英文，解释为什么这么改，不复述 diff。

- `type`：`feat` / `fix` / `style` / `refactor` / `test` / `docs` / `chore`。
- `scope`：模块名，看 `git log` 沿用已有的：`organize`、`proxy`、`emby`、`follow`、`drive`、`settings`、`strm`、`agent`、`library`、`plans`（方案文件）、`release`（发版）等。
- 几个真实例子：

  ```
  feat(organize): missing episodes, never-organize directories, edit dialog
  fix(proxy): verify path-cache hits and re-resolve when a cached pickcode yields no link
  docs(plans): record the real-device checks for the organize batch
  chore(release): v2.19.0-rc.2
  ```

- 不加 `Co-Authored-By` 之类的尾注；用了什么工具不写进提交。
- 交错在同一批文件里的改动合成一个提交，别为了拆而拆。方案文件（`.claude/plans/`）的更新单独一个 `docs(plans):` 提交，和代码提交分开。
- 发版提交固定写 `chore(release): vX.Y.Z`，只改三个版本号。

## 3. 本地环境

需要 Node.js 24 和 pnpm 9（`corepack enable pnpm` 会按 `package.json` 的 `packageManager` 取对应版本）。仓库是 pnpm workspace，用 npm 装不出正确的依赖树。

```bash
pnpm install
pnpm dev        # backend(4000) + Emby 代理(8091) + next dev(3000)
```

- 生产镜像里没有 Next 进程：前端静态导出，由 backend 在 3000 上一并托管。要看和容器一样的拓扑：`pnpm build:frontend` 后用 `FRONTEND_DIR=apps/frontend/out` 起 backend。
- `next dev` 的 `/api` 反代会把事件流整条缓冲住，而且 30 秒就断：在 dev 上看 strm 校验进度、实时任务日志会一直停在「准备中」，这不是 bug。要看流式效果走上面的生产拓扑。
- 环境变量见 README「配置说明 / 环境变量」。开发时常用的：`CONFIG_DIR` / `DATA_DIR`（库和 strm 输出的位置）、`BACKEND_PORT` / `BACKEND_HOST`、`PROXY_PORT`、`LOG_LEVEL`、`FRONTEND_DIR`；前端 dev 用 `BACKEND_URL` 指向另一个端口的后端。
- **不要对着自己真实的 `config/openstrm.db` 做实验。** 后端一起来就会按库里的账号开始网盘轮询、Telegram 长轮询和 Emby 刷新。联调一律用拷贝或全新的库、另开端口，做法见第 8.2 节。
- `config/`、`data/`、`.env` 已在 `.gitignore` 里，不要想办法提交进来。

## 4. 代码约定

这些是 v2 架构评审后定下来、之后一直沿用的约定。新代码照着写；想改约定先开 issue 讨论，不要在功能 PR 里顺手改。

### 通用

- TypeScript `strict` 全开，前后端都是；`packages/shared` 是纯类型包，没有构建步骤。
- 注释和界面文案用中文。注释解释「为什么这么做」和「不这么做会怎样」，不复述代码在做什么（`.github/workflows/ci.yml` 里的注释是范本）。
- 任何凭据（cookie、令牌、口令、api key）不进代码、测试夹具、方案文件、截图、提交信息。`scripts/check-hygiene.sh` 会扫常见形状，CI 也跑它；扫不到不等于可以写。
- 新建文件前先 `git ls-files <path>` 或 `ls` 确认不存在，再决定是新建还是追加。已有文件被整个覆盖掉时测试不一定会报错，只会少几条用例。
- 源码里不放不可见字符（零宽空格、方向控制符、BOM 之类）。要在代码里表示它们用 `String.fromCharCode` 或反斜杠加 u 的字面转义；提交前用脚本扫一遍改过的文件。

### 后端（`apps/backend`，Fastify + drizzle + SQLite）

- 请求入参一律 `parse(schema, request.body)`（`lib/validate.ts`，zod）。实体 schema 放 `schemas/entities.ts`，用 `satisfies z.ZodType<…>` 钉在 shared 的类型上。
- 错误只有一种壳 `{ message, ...extra }`：路由里 `throw new HttpError(status, message, extra)`（`lib/http-error.ts`）。成功响应直接返回 payload，没有 `{ code, data }` 包装。
- 上游（115、夸克、OpenList、TMDB、Telegram、Emby、HDHive）出错用 `upstreamError(message, extra)`，状态固定 500、上游状态码放 `extra.upstreamStatus`。不要回 502 / 504：Cloudflare 会把源站的 502 / 504 换成它自己的错误页，`message` 到不了浏览器。
- 设置按顶层 key 合并写（`patchAppSettings`）；`replaceAppSettings` / `replaceTasks` / `replaceAccounts` 只给测试恢复快照用。
- 网盘只经 `services/drive/` 的 `DriveProvider` / `ShareProvider` / `ChangeSource` 接口访问。路由和业务服务里不写 `accountType === "115"` 这类分叉，不直接 import `cloud-115/*`、`quark/*` 客户端（它们只被 `drive/providers/*` 用）。新增一种网盘 = 再写一个 Provider。
- 日志用 `lib/logger.ts` 的 pino 实例，service 里 `moduleLogger("<模块名>")`；不用 `console.*`。错误 extra 里的 `data` 不进日志。
- 后台循环（巡检、监控、Telegram 轮询）用 `lib/polling.ts` 的 `createPollingLoop`，失败走指数退避、停机时能退出；通知统一走 `services/notify.ts`。
- 数据库：改 `db/schema.ts` 后 `pnpm db:generate` 生成顺序编号的迁移（`src/db/migrations/00NN_<name>.sql`，当前到 0028）。迁移只增不改：已经发出去的迁移文件不能回头改，要改就再加一个。迁移文件会被 `build` 拷进 `dist`，CI 的冒烟会检查镜像里有没有。

### 前端（`apps/frontend`，Next.js 静态导出，Tailwind + Radix 组件）

- API 调用集中在 `lib/api.ts`；读错误用 `lib/axios.ts` 的 `apiErrorBody` / `apiErrorMessage`。
- 页面壳用现成的 `PageHeader` / `StatusBadge` / `EmptyState` / 骨架屏组件；颜色用 brand 和状态 token，不写死色值；主题走 next-themes，浅色 / 深色都要看。
- 表单用 react-hook-form；设置页的脏状态保存条、弹框的三档宽度、路径组合控件沿用已有的；开关行用勾选框。
- 后台轮询用 `hooks/use-polling.ts` 的 `usePolling`，不自己写 `setInterval`。
- 两个常踩的坑：`SelectTrigger` 要矮一档必须传 `size="sm"`，加 `className="h-8"` 没用；Radix Select 放在 form 里会先回一次空值，`onValueChange` 写成 `(v) => v && setX(v)`。
- 改全局样式（画布、面板、`--muted` 一族、主题 token）时，验证必须包含带海报墙的页面：任务页、strm 管理、整理页，而且墙得真的画出来。空库上墙不渲染，看着像验过了其实没有。
- 错误提示要告诉用户下一步做什么，不只报「失败」。

## 5. 自动化测试

```bash
pnpm typecheck && pnpm lint && pnpm test     # 提交前三样都要过，CI 跑的也是这三样

# 只跑一个文件：CONFIG_DIR / DATA_DIR 必须指到临时目录
cd apps/backend
CONFIG_DIR=/tmp/openstrm-test/config DATA_DIR=/tmp/openstrm-test/data pnpm test:file src/services/follow/organize.itest.ts
```

后端测试用 `node --test`，分三层，按改动落在哪层加用例：

| 层 | 文件 | 特点 |
|---|---|---|
| 单元 | `*.test.ts` | 纯函数 / 纯逻辑，不碰库和网络 |
| 集成 | `*.itest.ts` | 带库。`src/test/setup.ts` 给每个测试文件开独立的临时 `CONFIG_DIR` / `DATA_DIR` 并跑迁移，跑完删掉；没指定这两个变量会直接拒绝运行，免得改掉开发者真实的库和 strm 目录 |
| 端到端 | `src/routes/proxy/proxy.e2e.ts` | 对着真 Emby 容器验代理。`scripts/emby-lab.sh up` 起环境，`pnpm test:e2e` 跑，需要 Docker；用法见 `.claude/plans/302-proxy-migration.md` |

- 网盘一律用 `src/test/fake-drive.ts` 的 `FakeDrive`，经 `setDriveProviderFactory` 注入；用例里不连真网盘。真 HTTP 只在 `quark/client.itest.ts`、`quark/share.itest.ts` 这类客户端测试里对着本地假服务用。
- 改了行为就要有对应层的用例；修 bug 先写能复现的用例（修前失败、修后通过），方案文件里记下用例名。
- 后端全量约 1600 条、4 分多钟，`--test-concurrency=1`。**跑的时候别改 `apps/backend/src` 和 `packages/shared`**：每个测试文件是独立进程，轮到它才读磁盘上的源码，读到改一半的会整批导入失败，那一轮结果作废。
- 计时类用例的间隔和断言要留余量，CI 的机器比本机慢。
- 前端单测是 `src/lib/**/*.test.ts`。界面改动还要做浏览器冒烟：用全新的临时库起一个后端、`next dev` 指过去，把改到的页面在浅色 / 深色、宽屏 / 窄屏下各走一遍。

## 6. 方案文件

非琐碎的改动先写方案，再动代码。方案、实施记录、评审记录、真机记录、发布记录都在同一份文件里，跟代码一起提交，这样一个功能的来龙去脉在仓库里就能找全。

- 什么要写：新功能、行为变化、涉及网盘 / 整理 / 代理 / 迁移的修复。一行的文案或样式修复不用。
- 位置：`.claude/plans/<topic>.md`，从 `.claude/plans/_template.md` 复制。一个主题一份；后续阶段追加到末尾，不另起文件。现有的 20 多份都是这个写法，`follow-organize.md` 从起因到发布最完整，可以当范本。
- 章节固定：起因 / 方案（含「不做」）/ 测试 / 进度 / 实施记录 / 评审与修补 / 真机验证 / 发布。每节带日期，记录写实际发生的事（提交号、用例名、看到的文件名），不写「已完成」三个字了事。
- 更新方案用 `docs(plans):` 单独提交。
- 方案只放在仓库里。不发布成共享页面、不贴到外部文档工具，哪怕是为了方便评审。
- 方案里可以写测试分享码、测试目录名、提交号；不能写 cookie、令牌、口令。

## 7. 评审

- 顺序：一批功能做完 → 先真机走一遍用户会走的路（第 8 节）→ 评审 → 发 rc。真机常常比评审更快找出真问题（数据形状、网盘行为、体验），所以放前面。
- 评审看什么：正确性（并发、撤销是否对称、失败分类、边界）、是否守第 4 节的约定、测试覆盖、文案。用工具评审和人评审看的是同一份清单。
- 评审发现的项**全部修完**，不按「收益小」「下次再说」自己留下。只有两种可以留：缺凭据没法验、要产品决策；这两种单列出来写明原因。
- 修完记进方案文件的「评审与修补」一节：每条一行，发现 → 修法 → 回归用例。
- 评审修补之后，涉及的真机场景要复跑（第 8.4 节）。
- 给 PR 做评审的人：对照第 10 节的清单；拿不准的让作者补用例，不接受口头解释。

## 8. 真机测试

自动化测试里网盘是假的、Emby 是桩。网盘接口的真实形状、限流、风控、目录树的层级、Emby 的响应细节，只有在真账号上才看得到；这个项目的大多数线上 bug 都是在这一步抓住的。

### 8.1 什么改动必须真机

| 改动 | 要求 |
|---|---|
| `services/drive/` 及各 Provider、115 / 夸克 / OpenList 客户端 | 必须 |
| 分享转存、追更、网盘监控、复制队列 | 必须 |
| 整理的预览 / 执行 / 撤销、命名模板 | 必须，而且执行和撤销成对验 |
| Emby 代理、302、播放路由规则 | 必须，对着真 Emby（`scripts/emby-lab.sh`）加真网盘 |
| 数据库迁移 | 必须，用带生产数据形状的库拷贝跑一次升级 |
| Telegram 通知链路、智能体工具 | 必须 |
| 纯界面、纯函数、文案、不改行为的重构 | 冷测试即可：单测 + 浏览器冒烟 |

拿不准的按「必须」算。

### 8.2 环境隔离：lab 库

真机不等于生产。永远用一份隔离出来的库和目录，哪怕只是看一眼。

1. **拷库**：只读方式把 `config/openstrm.db` 备份到 lab 目录：`sqlite3 "file:config/openstrm.db?mode=ro&immutable=1" ".backup <lab>/config/openstrm.db"`。`-wal` / `-shm` 不要跟着拷。要验「空库第一次用」就直接用新目录，不拷。
2. **另开端口**：`CONFIG_DIR=<lab>/config DATA_DIR=<lab>/data BACKEND_PORT=4100 BACKEND_HOST=127.0.0.1 pnpm --filter @openstrm/backend dev`；前端 `BACKEND_URL=http://127.0.0.1:4100 next dev -p 3223`。别和自己常跑的 3000 / 4000 / 8096 撞。
3. **拆掉和外界的连线**：拷贝里把管理口令换成临时随机的；关掉 Telegram、网盘监控、Emby 回填、HDHive、TMDB、所有任务的 cron；删掉生产任务和追更订阅。只建名字带 `lab` 的任务，网盘目录用专用目录（例如 `/lab20261022`），strm 输出到 lab 的 `data/`。
4. **凭据**：账号 cookie 随拷贝进 lab 库没问题；别人给的 TMDB 令牌、Emby key 只放 lab 库，验完连库一起删。写探测脚本时错误只打 `name / code / message`，别把整个请求对象打出来，请求头里有 cookie。
5. **样本**：用固定的测试分享（方案文件里记分享码和提取码），能挑小文件就挑小的。
6. **磁盘**：复制大文件前先 `df -h` 看余量；Docker 里删掉的文件要容器退了才释放空间。实验结束 `docker rm -f` 容器，别只 stop。
7. **外部服务的实验环境**：Emby 用 `scripts/emby-lab.sh up|main|down`（`EMBY_PORT` 别用自己常跑的 8096）；OpenList 容器 v4.1 之后要 `-e PUID=0 -e PGID=0` 且 bind 进去的数据目录 `chmod 777`，不然起来就退出。更多坑见 `.claude/plans/drive-notes.md`。

### 8.3 写操作要授权

转存、删除、移动、改名、整理执行、归档、复制：任何会改动真实网盘账号内容的操作，做之前先写清楚

- 会存什么、存到哪个目录、大概多大；
- 会不会连带触发监控、自动整理、Emby 刷新、Telegram 通知；

等账号主人点头再做。一次授权只管这一次，换个场景再问。

- 整理一律三步：只读预览 → 执行 → 撤销，三步都看。撤销后核对目录和文件回到原位、空壳目录有没有删干净。
- 做完报告：留在网盘上的路径、lab 库和 strm 输出的位置；删不删由账号主人定。
- 别用自己的生产 strm 目录当输出；别让 lab 后端连上自己的生产 Emby。

### 8.4 记录格式

真机的过程和结果写进方案文件的「真机验证（日期）」一节，模板里有骨架：

- **环境**：lab 库从哪拷的、端口、关掉了什么、建了哪些 lab 任务和目录、用了哪个分享。
- **场景表**：`| 场景 | 结果 |`。场景从方案「测试」一节事先列好的真机清单来；结果写实际看到的（文件落到哪、名字变成什么、接口回了什么），不写「通过」两个字。
- **真机发现的问题（已修）**：每条写现象、原因、修法、回归用例名；修完把那个场景复跑一次并记下。
- **日志**：lab 后端日志里除了预期之外没有告警和报错；有就写出来。
- **收尾**：lab 目录、库、令牌删了没有。

`follow-organize.md` 的「真机验证（2026-10-14）」一节是现成的范本。

### 8.5 分工

- **外部贡献者**：冷测试（第 5 节）必须全过。有真账号就按 8.2 到 8.4 做，记录写进方案文件；没有就在 PR 里写明「只做了冷测试」和原因，并写清改动会影响哪种网盘、哪条链路，方便维护者复跑。
- **维护者**：发 rc 前用自己的账号按方案里的场景复跑一遍，结果记进方案文件；正式版前至少跑过一轮 rc。

## 9. 发布

只有维护者发版。rc 和正式版的差别只在 tag 名和 `main` 动不动。

1. 工作区里压着的方案记录先单独 `docs(plans):` 提交。
2. `chore(release): vX.Y.Z[-rc.N]`：改根目录、`apps/backend`、`apps/frontend` 三个 `package.json` 的版本号，别的不动。
3. `git tag -a vX.Y.Z[-rc.N] -m vX.Y.Z[-rc.N]`，然后 `git push origin v2 vX.Y.Z[-rc.N]`。
4. 正式版再做：`git branch -f main v2 && git push origin main`。`main` 一直在 `v2` 的历史上，这一步是纯快进；真分叉了先停下来查，不造 merge 提交。
5. 等 `Release` 工作流四个作业全绿（Typecheck, lint and tests / Build amd64 / Build arm64 / Merge manifest and release）和 `CI` 全绿。Release 会重跑类型检查、lint 和测试，不过就不构建、不推镜像。
6. 核对 Docker Hub：版本 tag 的 digest 和 `latest` 一致（rc 不动 `latest`）；GitHub Release 的 prerelease 标记对（rc 是，正式版不是）。
7. Release 的说明里工作流只自动生成对比链接，升级说明（行为变化、要不要改配置、带了哪些迁移）手动贴。
8. 方案文件「发布」一节记下：发布提交、tag、带的提交范围、迁移编号、镜像 digest、`main` 动没动。

回滚见 README「升级与回滚」。

## 10. PR 清单

`.github/PULL_REQUEST_TEMPLATE.md` 会把这份清单带进每个 PR。勾不上的项写明原因，不要空着。

- 目标分支是 `v2`，已 rebase 到最新 `v2`，没有 merge 提交
- 提交信息 `type(scope): 英文祈使句`，没有 Co-Authored-By 尾注
- `pnpm typecheck`、`pnpm lint`、`pnpm test` 本地全过
- 改了行为就有对应层的用例；修 bug 有复现用例
- 方案文件已更新，或写明是一行修复不需要
- 真机验证一节已填，或写明只做了冷测试和原因
- 数据库改动有顺序编号的迁移，没改已发布的迁移
- 代码 / 测试 / 方案里没有凭据（`scripts/check-hygiene.sh` 过）
- 界面改动：浏览器冒烟过，浅色 / 深色、窄屏看过；改全局样式带着海报墙页面看过
- 没动版本号
