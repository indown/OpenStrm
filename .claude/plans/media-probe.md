# 媒体探测：读网盘视频的编码 / 分辨率 / HDR / 音轨（mediainfo.js）

> 状态：2026-10-19 核心（9cd07b1）和 Emby 回填（327dfec）都已实施，随 **v2.18.0-rc.3**（35535ad，rc 镜像 11f89afcc6d3）发出；夜里真机补验后的修补（123cfdd：直链临时故障重试 + 预算 96 MB、Emby 回填 pending 列表）随 **v2.18.0-rc.4**（41ec8f3）发出：Release 四作业 + CI@v2 全绿，rc 镜像 0f6a4d462bd1（amd64 / arm64），GitHub Release 是预发布；latest 仍是 v2.17.0（3267a1383fbf），main 未动在 43a627c。没有新迁移。
> 来源：分析「我们的整理哪里做得不好」时发现技术标签只从文件名解析；用户问 tmm 能不能识别编码、我们能不能内置 MediaInfo、mediainfo.js 是不是最优解，最后说「按你的推荐开始，但网盘的清晰度不准确」——所以不用网盘接口那一层，以探测为准，Emby 回填做第二步。

## 决定

1. **引擎 mediainfo.js**（MediaInfoLib 的 WASM 版，BSD-2，约 3 MB，架构无关）。进程里一个实例、串行用；`analyzeData(getSize, readChunk)` 的 `readChunk` 用网盘直链 + `Range` 请求实现，只读它要的那几块（MKV 是文件头，MP4 的 moov 在尾部时多读一次）。
2. **预算**：每个文件最多读 64 MB、最多 48 次 Range（每次 2 MB）、120 秒；超了算失败「读取量超过上限」，不半途给结果。（最初定的 12 MB / 8 次在真机上不够：MediaInfoLib 要在第一个簇里找到每条轨的首帧，68 GiB 的 4K remux 顺序读了 33 MB，见末节。）直链走各家 Provider 的 `downloadLink`（115 按路径换 pickcode、夸克用 fid 当 token、OpenList 用 raw_url），带 Provider 给的请求头，经现有限流通道。
3. **结果落库**（迁移 0025，`media_probes`）：键 = 账号 + 文件 id（115 / 夸克），没有 id 的按绝对路径；存大小做失效判断（大小变了重探），`status` ok / failed、`data` JSON、`error`、`probed_at`。文件内容不会变，不设 TTL。
4. **标签口径和文件名解析一致**（`parse-name.ts` 的词表）：分辨率按高度 → 2160p / 1080p / 720p / 576p / 480p；编码 AVC → H.264、HEVC → HEVC、AV1 / VP9 / XviD；音频取主音轨的格式 → AAC / AC3 / DDP（E-AC-3）/ DTS / DTS-HD / TrueHD / FLAC / Opus / MP3 / PCM；HDR：Dolby Vision → DV、SMPTE ST 2094 App 4 → HDR10+、ST 2086 → HDR10、HLG → HLG。模板变量 `{resolution}` `{videoCodec}` `{audio}` `{hdr}` 在文件名没有对应标签时回退到探测结果；文件名有的以文件名为准（用户的发布组标签更贴近习惯）。
5. **什么时候探测**：
   - 预览里单元卡片「探测编码」：这部作品的视频全探一遍（有缓存的不读网盘），然后重新规划；
   - 工具条「探测缺标签的」：当前清单里勾选的单元中，模板用到的标签在文件名里缺失的视频；
   - 设置「预览时自动探测文件名没有标签的视频」（默认关：大库第一次预览会很慢），开了就在识别之后、规划之前做，日志里报进度；
   - 智能体 `organize_probe`。
   - 不在执行阶段探测；按本地 strm 结构的 run 不探（不走模板）。
6. **第二步：Emby 回填**。配了 Emby 的，整理执行并刷新之后，按本地 strm 路径查 Emby 的 MediaStreams 回填缓存，以后写 nfo 不重复探测。先做核心，这步看时间。

## 数据流

`ScopeEntry`（有 id / size）→ `UnitFile.probe?: ProbeTags`（预览开始时从缓存填，探测后更新）→ `fileVars(file)`：`parsed.tags.x || file.probe?.x` → 模板。`renameVariants`（冲突改名保留的区分后缀）也用同一份标签。

## 落点

- `services/media/mediainfo.ts`：实例、串行队列、`probeRemote(link, size, opts)`。
- `services/media/probe.ts`：`MediaProbe` 模型、`probeTags()`、缓存读写、`probeFiles(provider, task, files)`（直链 → 探测 → 落库）。测试用 `setProbeDeps({ probe })` 换掉真探测。
- `db/repositories/media-probes.ts` + schema + 迁移 0025。
- `preview.ts`：`attachProbes(state)`（从缓存填）、`probeUnits(runId, { key | missing })`（探 → 替换 `file.probe` → `replanRun`）；自动探测挂在识别之后。
- 路由 `POST /api/organize/runs/:id/probe { key?, missing? }`；items 接口的每一项带 `probe` 标签（界面文件表显示）。
- 设置 `organize.probe: "off" | "missing"`。
- 智能体 `organize_probe`。
- 前端：单元卡片按钮、工具条按钮、文件表一行小字、设置页勾选。

## 测试

- 单测：`probeTags`（各档位 / HDR 判定 / 主音轨选择）、读取预算（假 readChunk 计数）。
- run.itest：假探测器 → 单元探测后 `{videoCodec}` 进了文件名、缓存命中不再探、失败项有说明；设置开自动探测时预览就探。
- 路由 / MCP 各一条；快照更新。
- 真机：115 上一个真 mkv（只读文件头）看编码 / 分辨率 / HDR；夸克 / OpenList 的「假视频」要能优雅失败。

## 实施记录（2026-10-19）

> 状态：核心做完、测过、真机验过；第二步（Emby 回填）没做。未提交。

**落点和方案一致**，几处和原计划不同的地方：

- `services/media/mediainfo.ts`：`analyzeSource(source)` + `openRangeSource(link, size?)`，不是原计划的 `probeRemote`；直链大小没给时先读第一块、从 `Content-Range` 拿总大小，第一块留给 offset 0 不白读；服务端不理 Range 回 200 时 `maxContentLength` 拦下来算「直链不支持 Range 读取」。超时和读取预算分两个错误类（`ProbeTimeoutError` 才丢实例重建）。预算改成 64 MB / 48 次 / 120 秒、每次 2 MB（原因见下）。
- `services/media/probe.ts`：`probeDriveFile(provider, accountName, target, { signal, retryFailed })` 不抛（失败也是结果），缓存键 `id:<fid>` / `path:<绝对路径>`，大小对不上不算缓存；`cachedProbeTags()` 给预览开始时批量填。测试用 `setProbeDeps({ open, analyze })` 换掉直链和引擎。
- `preview.ts`：`attachProbes()` 在 `newPlanState` 之后从缓存填 `UnitFile.probe`；设置 `organize.probe === "missing"` 时 `autoProbe()` 在识别前探文件名缺模板标签的视频，进度写在识别那一栏，日志一行「探测编码：N 个视频…」；`probeUnits(runId, { key | keys | missing }, { retryFailed })`：`key` 探单元全部视频（默认重试失败过的），`keys` 探这些单元里缺标签的（界面「探测缺标签的视频」传列出来且勾着的），`missing` 探清单里勾选的全部单元（智能体用）；失败过的不再读网盘但照旧算没读到、带原因；探完 `replanRun`，`units` 是重新规划前后项指纹真变了的单元数（不是碰过的单元数）。`decorateItemsWithProbes()` 让 items 接口的每项带 `probe` 标签（只在单元结构还在内存里时）。
- 路由 `POST /api/organize/runs/:id/probe { key? | keys? | missing?, retryFailed? }`，返回 `OrganizeProbeResult`；本地 strm 结构的清单 400 `NOT_TMDB_RUN`。
- 智能体 `organize_probe { run, unit? | missing? }`，run 档、organize 组；返回每个文件的摘要 / 原因、`changed`、`planVersion`、`confirmText`、`next`；只读令牌看不到。快照已更新（工具 44 个）。
- 前端：单元卡片「探测编码」（有匹配、非 local）、清单上方批量行「探测缺标签的视频」、文件表「原来」一列下面一行小字「探测到 1080p H.264 AAC」、设置页开关「预览时自动探测文件名缺标签的视频」。
- 没做：Emby 回填（第二步）；执行阶段不探；标签只回退 `{resolution} {videoCodec} {audio} {hdr}` 四个，`{source}` 探不出来。

**测试**：`services/media/probe.test.ts`（映射 / 词表 / 分辨率档 / 缓存键）、`services/media/mediainfo.test.ts`（真 WASM 跑 ffmpeg 生成的 mkv / mp4，没 ffmpeg 就跳过；本地 http 验 Range 读取、不理 Range 的直链、预算、超时、取消）、`run.itest`（自动探测 / 缓存 / 大小变了重探 / 按单元 / keys / 失败过的 / 本地清单 400）、`organize.itest`、`mcp-p3.itest` 各一条。全量 1618 个通过。

**真机（2026-10-19，实验库是本机 config 库的消毒副本，只读探测，什么都没执行）**：

- 115 `movie/明日边缘 (2014) - 2160p.mkv`（68.5 GiB 原盘 remux，77 Mbps）：第一次按 12 MB / 8 次的预算失败「读取量超过上限」。追踪读取位置：MediaInfoLib 从头顺序读了 33 MB（每条轨的首帧：HDR 元数据、Atmos 都在帧里）再跳到文件尾读一块，共 34 次 / 34.6 MB / 19 秒（1 MB 一块）。WASM 版没有 ParseSpeed 可调，预算放到 64 MB / 48 次 / 120 秒、块改 2 MB 后 11 秒读到：`HEVC · 2160p 10bit · HDR10 · TrueHD Atmos 7.1 en-US · 4 条音轨 · 字幕 zh-Hans-CN/zh-Hant-TW/zh-Hant-HK/en-US`，标签 `{resolution: 2160p, videoCodec: HEVC, audio: TrueHD, hdr: HDR10}`。
- 115 `tv/东京三十岁左右 (2026)/Season 01`（5 个 1 GB mp4，文件名没有分辨率）：实验库剧集模板加了 `[ - {resolution}]`，「探测缺标签的」5 个 15.9 秒全读到 `H.264 · 1080p · AAC 2.0`，目标名变成 `… - S01E01 - 1080p.mp4`；再点一次 0 个要探（标签已经有了）。
- 夸克 `tv/东京三十而已 (2026)/Season 01`（5 个 1 GB mp4）：37.8 秒全读到，同样的结果；夸克直链比 115 慢一倍多，但 Range 没问题。
- 界面（前端 dev 3223 + 实验后端 4100）：单元卡片「探测编码」在「刷新 TMDB」右边，点了弹「读到 5 个视频，清单没有变化」（全是缓存）；展开文件表，「原来」一列下面一行小字「探测到 1080p H.264 AAC」；两部以上时清单上方批量行多了「探测缺标签的视频」，文件名都带 2160p 的两部点了弹「没有要探的视频：文件名里都有模板要用的标签，或者模板没用 {resolution} 这些变量」；设置页「整理与命名」多了「预览时自动探测文件名缺标签的视频」开关。实验库、口令、令牌用完已删。
- 没验的：OpenList（Local 存储的 raw_url 支持 Range，本地 http 测试覆盖了同一条路）；夸克 / OpenList 上的「假视频」优雅失败只在单测里验过（analyze 抛错 → 记 failed 带原因）；设置开着「预览时自动探测」的真机整库预览没跑（只跑了单元级）。

## 第二步：Emby 回填（2026-10-19 做完）

挂在现有的 Emby 入库检查循环上（`services/emby/library-new.ts`，两分钟一轮、刷新后 30 秒加急）：`/Items` 多要 `MediaSources`（里面带 Emby 分析过的 `MediaStreams`），每轮把新条目的媒体源交给 `services/media/emby-streams.ts`：strm 内容（MediaSource.Path）用 `remoteOfStrmContent` 按任务换算回网盘文件 → Emby 的流（Codec 短名、VideoRangeType、Profile / DisplayTitle 里的 Atmos）映射成同一份 `MediaProbe` → 写进 `media_probes`（键只有路径；`bytesRead` 是 0）。读文件头得到的结果（bytesRead > 0）不覆盖；Emby 回填的会被下一次回填更新。回填有自己的游标（`emby.probeCursor`），首轮把最近 50 条也回填；**通知开关关着现在也会问 Emby 一次**（原来「开关关着连 Emby 都不问」），只是不通知、通知的游标照旧停着。
查缓存：有 id 的文件先按 `id:` 键再退到 `path:` 键（`keysOf`），Emby 回填的才用得上。`videoCodecOf` / `audioCodecOf` 顺手认了 Emby 的短名（h264 / hevc / mpeg4 / mpeg2video / vc1、eac3 / truehd / mp3 / pcm_*）。
测试：library-new.itest（开关关着照样回填、对上任务的才写、没视频流的不写、首轮回填、有 id 退到路径、读文件头的不覆盖）。真机没验（本机没有常驻的 Emby；OpenList 实验环境那套 emby-lab.sh 能起一个，留给下次）。

## 真机补验（2026-10-19 夜）

- **OpenList**：本机 openlist 容器（Local 存储，PUID/PGID=0）挂 ffmpeg 造的三个小文件（H.264 1080p AAC 2.0 / HEVC 720p 10bit AAC 5.1 / mp4 H.264 AC3 5.1），实验账号 + 任务 `src/tv`：预览 → 按单元探测 3 个 2.1 秒全读到，标签 / 语言 / 声道都对；OpenList 的 `/d/` 直链回 206。
- **整库自动探测的耗时（夸克）**：设置开 `probe: missing`、剧集模板加 `[ - {resolution}]`，预览 `黑白清道夫 (2026)` 整部剧（10 集，每集 4 GB 4K HEVC + DDP + 字幕轨）：**9 分钟**，读到 6 个、4 个「读取量超过上限（48 次 / 64 MB）」。追踪：夸克直链只有约 1 MB/s（2 MB 一块要 1.5–2 秒），MediaInfoLib 从头顺序读到每条轨（含字幕轨）的首个包才停，这些文件要 42–66 MB，所以每个 45–70 秒。还碰到两次直链半路断开 / 20 秒超时（夸克对连续读会抖）。
- **能不能更早停**：自己驱动 `Open_Buffer_Continue` 看状态位——115 的 remux 上 `Filled` 位和最终完成一样都在 32 MB 处才亮（读到每条轨的首包之前它不认为「填好了」），所以没有「读完轨道表就停」的捷径；WASM 版没有 ParseSpeed。
- **改法**（123cfdd，随 rc.4 发出）：预算放到 96 MB / 64 次 / 240 秒；每块请求超时 20 → 60 秒；一次读遇到超时 / 服务端断开（ECONNABORTED / ECONNRESET / aborted / socket hang up）换连接重试一次。真实成本写进文档：夸克上一个 4K 文件一两分钟，1080p 的 mp4 几秒；自动探测默认关，开了整库第一次预览很慢。
- **Emby 回填**：本机 Emby 容器（emby-lab.sh）+ strm 指向容器里挂的同一批小文件。Emby 入库时 `MediaStreams` 是空的（size 0），`Items/{id}/Refresh` 也不分析；对 strm 条目要等首次播放（`PlaybackInfo`）才 ffprobe 并持久化。所以回填加了 pending：入库时没流的条目记下 id（最多 200 条、30 天），之后每轮按 id 再问，有了流再回填；条目没了也拿掉。

## 还没做的

- 探测结果现在只喂模板；写 nfo 时可以直接用 `media_probes` 里的完整结果（音轨 / 字幕 / 码率都存了）。
