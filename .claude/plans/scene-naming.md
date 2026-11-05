# 整理命名：发布组写法（点号连接、来源叠加 Remux、多音轨）

## 起因（2026-11-05）

用户问 `Peter.Rabbit.2018.2160p.BluRay.REMUX.HEVC.DTS-HD.MA.TrueHD.7.1.Atmos.mkv` 这种格式的命名模板是什么。对着代码核过：没有预设能生成这种格式，自定义模板也只能近似。

- 解析器（`services/organize/parse-name.ts`）对这个名字认出的标签只有 resolution `2160p` / source `BluRay` / videoCodec `HEVC` / audio `DTS-HD`；REMUX、MA、TrueHD、7.1、Atmos 全丢：source 和 audio 各只留第一个命中（`??=`），`ma` / `7.1` 在噪音词表，`glueDottedTech` 把 `DTS-HD.MA` 粘成 `DTS-HD`、`DDP5.1` 粘成 `DDP5`。
- 模板引擎（`services/organize/template.ts`）只有变量和可选段，没有转换：`{enTitle}` 渲染成 `Peter Rabbit`，空格变不成点。
- 用 `{enTitle}.{year}[.{resolution}][.{source}][.{videoCodec}][.{audio}][-{group}].{ext}` 实渲出来是 `Peter Rabbit.2018.2160p.BluRay.HEVC.DTS-HD.mkv`。

用户：「按照你的推荐制定计划开始吧」。推荐的三处：标题点号连接、source 允许 BluRay 和 Remux 叠加、audio 保留多条音轨拼接。

## 方案

### 1. 模板引擎：变量后缀与兜底

- 语法 `{a|b|c:.}`：`|` 是兜底，前一个为空就用下一个；`:.` / `:_` / `:-` 后缀把值按发布组写法连接——先照旧清洗（`cleanValue`），再去掉 `' ’ " “ ” ! ,`、`&` 写成 `and`、丢掉只剩横线 / 冒号的词（冒号策略留下的 ` - `），按空白分词后用后缀字符连接。`{title:.}`：`Dune: Part Two` → `Dune.Part.Two`；`{audio:.}`：`DTS-HD MA TrueHD 7.1 Atmos` → `DTS-HD.MA.TrueHD.7.1.Atmos`。
- 后缀作用于整条兜底链，只写在末尾；不写后缀照旧。可选段「变量全空就整段丢」看的是兜底之后的值。
- 校验：链里每个名字都要在 `TEMPLATE_VARS` 里，后缀只认 `.` `_` `-`（错误文案「变量 {x:y} 的后缀只能是 :. :_ :-」）。
- 认「作品根」的两条正则要认新写法：`plan.ts` 的 `rootTemplate`（含片名 / id 变量的那一层及之上）和前端 `template-parts.ts` 的 `RE_WORK_VAR` / `RE_SEASON_VAR`，`{enTitle|originalTitle:.}` 也算含片名变量。

### 2. 解析器：来源叠加 Remux、音频按音轨攒

- source：盘 / 网络来源词（BluRay / WEB-DL …）照旧取第一个；`remux` / `bdremux` / `原盘` 记一个标志，最后拼成 `BluRay Remux`（只有 remux 词就是 `Remux`；`bdremux` 算 BluRay + Remux）。`hasReleaseNoise` 的强来源判断改成按词看。
- audio：按出现顺序攒、空格连接、去重：音频词表里的词（DDP / DTS-HD / TrueHD / Atmos …）；声道 `5.1` / `7.1` / `2.0`（粘在编码后的 `DDP5.1`、独立的 `.7.1.`、`6ch` / `8ch` 这类）只在紧跟音频词时才算；`MA` / `HRA` 只跟在 DTS-HD 后面才算。`glueDottedTech` 不再把 `DTS-HD.MA` 粘成 `DTS-HD`、`DDP5.1` 粘成 `DDP5`（改成 `DDP51`，解析时拆回 `DDP 5.1`）。`AC3-5.1` 以前把 `51` 当成发布组，顺手修掉。
- **行为变化**：`{audio}` 从 `DDP` 变成 `DDP 5.1 Atmos`，`{source}` 可能是 `BluRay Remux`。只影响模板里用了这两个变量的用户（默认模板没用），这些文件下次整理会被改名。
- 探测（`services/media/probe.ts` 的 `probeTags`）回填的 audio 同样写成「编码 声道 Atmos」（`DDP 5.1 Atmos`），和文件名解析出来的形状一致；Emby 回填走同一个函数。

### 3. 预设「发布组写法」

- `lib/organize-presets.ts` 两类各加结构 `scene`：目录照规范（`{category}/{title} ({year}) {idTag}`，剧集再加 `Season {season00}`），文件名
  - 电影 `{enTitle|originalTitle:.}.{year}[.{edition:.}][.{resolution}][.{source:.}][.{videoCodec}][.{hdr}][.{audio:.}][-{group}][-{part}].{ext}`
  - 剧集 `{enTitle|originalTitle:.}.S{season00}E{episode00}[.{episodeTitle:.}][.{resolution}][.{source:.}][.{videoCodec}][.{hdr}][.{audio:.}][-{group}].{ext}`
  - 和「保留原文件名」一样不随服务器变；设置页切服务器时这两种文件名原样保留。
- 变量表下面加一行写法说明（兜底、后缀）；`template-vars.ts` 的 source / audio 示例改成新形状；试算接口（`POST /api/organize/preview-name`）两个样例的标签改成真用 `parseMediaName` 从样例文件名解析，变量表「本例」列看到的就是解析器的真实输出。
- Readme 的预设列表更新（那里还写着「Plex 风格」）。

### 不做

- `{resolution}` 遇到 `UHD` + `2160p` 同时出现时仍取先出现的：改了会让默认模板下的文件被改名。
- `{hdr}` 仍只留第一个（`DV.HDR` → `DV`）。
- 发布组写法里的标题不做 romaji / 别名选择；没有英文名就用原名。
- 不加全局「空格换点」开关：按变量写后缀更精确，目录名还得留空格给 Emby。

## 测试

- `template.test`：兜底链、三种后缀、后缀作用于链、标点清理、校验错误文案、可选段里带后缀的变量全空整段丢。
- `parse-name.test`：Peter Rabbit 这条（source `BluRay Remux`、audio `DTS-HD MA TrueHD 7.1 Atmos`）、带 `-FraMeSToR`、Dune 的 audio 改成 `DDP 5.1 Atmos`、`BDRemux`、`蓝光原盘REMUX`、`AC3-5.1`、`DTS-HD.MA.5.1-GROUP`、`7.1` 不跟在音频词后不算、`hasReleaseNoise` 对 `BluRay Remux`。
- `plan.test`：作品根认 `{enTitle|originalTitle:.}`。
- `probe.test` / `mediainfo.test` / `organize.itest` / `library-new.itest`：`probeTags` 的 audio 新形状。
- 前端 `organize-presets.test` / `template-parts.test`：scene 预设拆拼、反推、含后缀的 `RE_WORK_VAR`。
- 浏览器冒烟（scratch 库）：设置页电影 / 剧集选「发布组写法」看示例；切服务器文件名保留；变量表说明；任务弹框预设列表。

## 进度

- [x] 1 模板引擎（2026-11-05）
- [x] 2 解析器 + 探测（2026-11-05）
- [x] 3 预设 + 文案 + Readme（2026-11-05）
- [x] typecheck / lint / 测试全过（2026-11-05，后端 1727 / 前端 11）
- [x] 浏览器冒烟（2026-11-05）
- [x] 真机（2026-11-05，115 `/lab1105`，预览 / 执行 / 撤销三步都验）
- [ ] 提交（等用户定）

## 实施记录（2026-11-05）

**模板引擎**（`services/organize/template.ts`）：`parseVarSpec` 解析 `{a|b|c:.}`——`|` 兜底链、末尾 `:.` / `:_` / `:-` 后缀；`releaseJoin` 去掉引号 / 逗号 / 叹号、`&` 写成 and、丢掉只剩横线 / 冒号的词，再用后缀连接；`renderTemplate` 的 `value()` 取链里第一个非空的清洗值再连接，可选段的「全空」看兜底之后。校验文案「变量 {x:y} 的后缀只能是 :. :_ :-」「不认识的变量 {name}」（链里逐个报）。作品根的判断（`plan.ts` 的 `RE_WORK_VAR`）和前端 `template-parts.ts` 的 `RE_WORK_VAR` / `RE_SEASON_VAR` 改成认花括号里任意位置的变量名。

**解析器**（`services/organize/parse-name.ts`）：`tech()` 拆成 `classify()`（回 audio / tech / false）+ 两个状态：`audioWords` 按出现顺序攒、去重；`afterAudio` 只在认出技术词时更新，不是技术词的不动它（`DTS-HD.MA.5.1-GROUP` 的尾段先整个试一次失败、再拆成两半认，后半才接得上）。`RE_CHANNELS`（71 / 51 / 20 / 6ch …）和 `RE_DTS_SUFFIX`（ma / hra / hr）只在 `afterAudio` 时记；`RE_AUDIO_GLUED` 认 `ddp51` 这种编码 + 声道。SOURCE 里 `remux` / `bdremux` / `原盘` 记 `remux` 标志（`bdremux` 顺手给 BluRay），最后拼成 `BluRay Remux`；`cjkReleaseTags` 改成返回是否原盘。`glueDottedTech`：`DDP5.1` → `DDP51`、不再把 `DTS-HD.MA` 粘成 `DTS-HD`。AUDIO 词表删掉粘着声道的死条目（glue 之后永远匹配不上），加 `dts-hdma` / `dtshdma` / `dts:x`。`RE_TECH_GROUP` 分支：后半是声道 / MA 就记音频、不记组名（`AC3-5.1` 以前把 `51` 当发布组）。`hasReleaseNoise` 的强来源按词看。

**探测**（`services/media/probe.ts`）：`probeTags().audio` = 编码 声道 Atmos（`DDP 5.1 Atmos`、`AAC 2.0`），`channelsLabel` 挪到它前面。

**试算接口**（`routes/organize/index.ts`）：两个样例的 resolution / source / videoCodec / audio / hdr / group 改为 `parseMediaName(样例文件名).tags`，沙丘的 audio 现在是 `DDP 5.1 Atmos`。

**前端**：`lib/organize-presets.ts` 加结构 `scene`（`SCENE_FILES` 电影 / 剧集各一条，`KEEP_NAME_FILE` 搬进来，`isServerIndependentFile`）；`OrganizeSection.applyServer` 切服务器时发布组写法和保留原名一样不动文件名；`lib/template-vars.ts` source / audio 的说明；`components/template-editor.tsx` 文件名那格的说明加兜底 / 后缀一句，变量表底下一行写法说明。Readme 的预设段落重写（原来还写着「Plex 风格」）。

**测试**：`template.test` 3 条（兜底链 / 后缀 / 标点 / 校验）、`parse-name.test` 9 条样本 + `hasReleaseNoise`、`plan.test` 1 条（作品根 + 兜底 + 文件名没标签时可选段全丢不留点）、`probe.test` / `mediainfo.test` / `organize.itest` / `library-new.itest` 的 audio 期望改成新形状；前端 `organize-presets.test` / `template-parts.test` 加 scene 预设与带后缀变量的拆拼。typecheck / lint 干净；后端全量 1727 过、前端 11 过。

**和方案不一样的**：没有。工作区未提交。

## 浏览器冒烟（2026-11-05）

**环境**：全新 scratch 库起后端 4100（只听 127.0.0.1，临时口令）+ `next dev` 3223，没碰 config 库；验完后端、前端都停掉，令牌和口令文件删掉。

| 场景 | 结果 |
|---|---|
| 设置页电影面板选「发布组写法」 | tab 变「电影 · 发布组写法」，三格填上，示例 `沙丘：第二部 (2024) [tmdbid=693134]/Dune.Part.Two.2024.2160p.WEB-DL.H.265.DV.DDP.5.1.Atmos-FLUX.mkv` |
| 变量表 | `{source}` WEB-DL、`{audio}` DDP 5.1 Atmos（解析器的真实输出），表底下有写法说明 |
| 剧集面板选「发布组写法」 | 示例 `怒呛人生 (2023) [tmdbid=153312]/Season 01/BEEF.S01E01.1080p.WEB-DL.H.264.DDP.5.1-NTb.mkv` |
| 切服务器到 Plex | 两个 tab 仍是发布组写法、文件名不动，「当前是 Plex 的规范」，示例 id 标签变 `{tmdb-693134}` |
| 保存 | 「保存成功」，`GET /api/settings` 里两条模板原样存进去（后端校验接受兜底链 / 后缀） |
| 浅色主题 | 面板正常 |
| 390px iframe | 没有横向滚动，预设下拉占满宽、「恢复默认」落到下一行、提示文字换行 |
| 任务弹框「命名模板」（混合库） | 跟随全局显示「跟随全局设置（发布组写法）」，示例同全局；下拉里有「发布组写法」 |

lab 后端日志没有告警和报错。真机（真网盘上按发布组写法预览 / 执行 / 撤销）没跑，等用户定。

## 真机验证（2026-11-05，115）

用户：「真机测试一下」「批准了一起做吧」，TMDB v4 读取令牌在对话里给的，只写进 lab 库，验完连库一起删了。

**环境**：`config/openstrm.db` 只读 `.backup` 到 scratchpad 的 lab 目录，后端 `127.0.0.1:4101`（`BACKEND_HOST=127.0.0.1`），临时口令；Telegram / Emby / HDHive 设置删掉、网盘监控关掉、三个生产任务删掉，只留任务 `lab1105`（115，originPath / targetPath 都是 `lab1105`，strmPrefix `/lab115`，整理 off，库类型 tv）；全局模板换成两条「发布组写法」预设（id 标签 Emby、集标题关）。网盘目录 `/lab1105` 用 Provider 的 `write.mkdir` 在 115 根下新建；样本从测试分享 `115cdn.com/s/swsgklr3z1r`（提取码 wbc1，末日地堡 2023）只转存 S03E01 / S03E02 两集（各约 4.2 GB，`toDirId` 直接存进 `/lab1105`，不经任务），再用 `write.rename` 改成发布组风格的名字 `Silo.S03E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv`、`Silo.S03E02.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-GROUP.mkv`。预览 / 执行 / 撤销全走接口（scratchpad 的 `org.py`）。

| 场景 | 结果 |
|---|---|
| 预览（`POST /api/organize/runs {taskId: lab1105}`） | 6 秒 ready；1 个单元「lab1105」→ tv 125988 末日地堡 (2023) [medium]「标题对上，文件名里没有年份」；TMDB 回的 `enTitle` 是空串，`{enTitle|originalTitle:.}` 退到原名 `Silo`；4 项要动（2 mkdir + 2 move）、0 冲突；目标 `/lab1105/末日地堡 (2023) [tmdbid=125988]/Season 03/Silo.S03E01.2160p.WEB-DL.H.265.DV.DDP.5.1.Atmos-FLUX.mkv` 和 `…/Silo.S03E02.1080p.BluRay.Remux.AVC.DTS-HD.MA.5.1-GROUP.mkv`（ATVP 当噪音丢掉，REMUX 叠成 BluRay.Remux，DTS-HD.MA.5.1 / DDP.5.1.Atmos 按出现顺序）；缺集 S03 3–10 |
| 执行 | 10 秒 done：4 项完成 0 失败；115 上 `fresh` 列目录看到 `末日地堡 (2023) [tmdbid=125988]/Season 03/` 下正是上面两个名字，大小不变 |
| 撤销 | 14 秒 reverted：退回 4 项；`/lab1105` 顶层回到两个发布组风格的原名、两层空目录删干净；lab `data/lab1105/` 里的两个 strm 也回到原名 |

**真机发现的问题**：没有。两件顺手记下的事：转存接口走任务（`taskId`）要任务有 `strmPrefix`（报「所选任务缺少 targetPath 或 strmPrefix 配置」），直接 `toDirId` 存就不用；Provider 的写操作在 `provider.write`（`mkdir` / `rename`），不在 provider 本身。新建的 `/lab1105` 约 5 分钟后做整理预览，115 导出目录树直接认了。

日志：lab 后端日志里没有 warn / error 级别的行。

收尾：lab 后端已停，lab 目录（库、令牌、口令、data）整个删了。网盘上的 `115:/lab1105/` 和里面两集用户说「删除吧」之后用 Provider 的 `write.remove` + `rmdirIfEmpty` 删了（两集进 115 回收站，目录删掉，`resolvePath` 已找不到）；删时又只读拷了一次 config 库拿凭据，用完即删。

## 发布（2026-11-05）

用户：「发正式版吧」。`b6e24db` `chore(release): v2.24.0` = `3419378` feat(organize) 发布组写法 + `e42c8cb` docs(plans) + 三个 package.json 升到 2.24.0（shared 仍 2.0.0）；tag 注释 `v2.24.0`。`git push origin v2 v2.24.0`，main 从 `2bc8836` 快进到 `b6e24db`（main == v2 == v2.24.0）。没有迁移、没有新设置键。发前做过：后端全量 1727 / 前端 11、浏览器冒烟、115 真机三步。升级说明交用户手动贴，要点：模板新语法 `{a|b}` 兜底和 `:.` / `:_` / `:-` 后缀；预设「发布组写法」；`{audio}` 从单个编码变成「编码 声道 Atmos」按文件名顺序连起来、`{source}` 带 `Remux`，模板里用了这两个变量的文件下次整理会被改名（默认模板没用）；探测回填的 audio 同形状。CI / Release / Docker Hub 结果见下一行。

→ 13:54 盯梢脚本回 RELEASE_OK：Release 四作业（Typecheck, lint and tests / Build amd64 / Build arm64 / Merge manifest and release）+ CI@v2 + CI@main 全绿（本机 13:44 推 → 13:54），Docker Hub `v2.24.0` 与 `latest` 同为 `sha256:8aefc5b83348…`（amd64 + arm64），GitHub Release 非 prerelease、是仓库最新。**v2.24.0 正式版已发**，main == v2.24.0。

## 发布后修补（2026-11-05，工作区未提交）

用户问 `Enola.Holmes.2020.1080p.mkv` 选了发布组写法后「主音轨信息以及视频编码什么都没展示出来，是没探测到吗」。查的时候发现一个 v2.24.0 带出去的缺口：`preview.ts` 的 `probeVarsOf` 按字面找 `{audio}` 等四个变量判断模板用没用到探测标签，发布组预设写的是 `{audio:.}`，于是 audio 不算「模板要用的标签」——文件名里已经有画质、编码、HDR 的视频（`Movie.2160p.HDR.x265.mkv` 这种）在「探测缺标签的视频」/ 预览自动探测里永远不会被探，`{audio}` 一直空；像 Enola 这种缺编码的文件照样会探（videoCodec / hdr 没带后缀），所以它不是用户那条看不到编码的原因。修法：`template.ts` 加 `templateVarNames()`（按解析器收变量名，兜底链、后缀、可选段里的都算），`probeVarsOf` 改用它。回归：`template.test`「templateVarNames」、`organize.itest` 探测编码一测里加「模板写成 `{audio:.}`，missing 模式照样探、目标名带 `.DDP.5.1`」。typecheck / lint 干净，template.test + organize.itest 27 条过。

用户那条的解释：探测只在三处触发——作品卡片「探测编码」、清单上方「探测缺标签的视频」、设置页「预览时自动探测」（默认关）；没触发时模板只能用文件名里有的标签，`Enola.Holmes.2020.1080p.mkv` 只有 1080p，所以目标名没有编码和音频。探过的文件行会显示「探测到 …」，没读到会 toast 原因。
