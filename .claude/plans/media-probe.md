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

## 预算到顶给半截结果（2026-11-05）

**起因**：用户在 115 `/movie` 里探测编码，别的都探到了，就「福尔摩斯小姐」三部电影没有探测信息（v2.24.0 发布组写法之后看得更明显：目标名只有 1080p）。

**真机（config 库只读拷贝，Provider + probeDriveFile 直接跑，没起后端）**：三部的直链都能取到，失败原因都是「读取量超过上限（64 次 / 96 MB）」；对照组 `生化危机：爆发夜 (2026)`（16 GB）在没有 Emby 回填缓存的 lab 里也一样失败。把预算放到 512 MB 量访问模式：
- `福尔摩斯小姐：失踪的侯爵 (2020) - 1080p.mkv`（15.2 GB，Netflix 原生 WEB-DL）：**31 条音轨 + 44 条字幕轨**，MediaInfoLib 从头顺序读 150 MB 才凑齐每条轨的首帧，再跳到文件尾读一块看时长，共 76 次 / 151 MB / 34 秒。
- 生化危机（2160p HDR10+，41 条字幕轨）：512 MB / 256 次读完还没停（字幕首条靠后）。
- 读模式都是从 0 顺序往后，HDR 元数据、Atmos、主音轨这些在最前面几 MB 就有了；多出来的读取全是为了靠后的字幕首条和文件尾的时长。
- 顺带一个脚本坑：`openRangeSource` 不带设置里的 User-Agent 直链一律 403——115 直链和取链时的 UA 绑定，不是 CDN 的连接上限。

**改法**：
- `mediainfo.ts` `analyzeSource`：预算到顶不再抛 `ProbeBudgetError`，给 mediainfo.js 一个空块让它收尾（`shouldReadMore` 对空块返回 false → `openBufferFinalize` + `inform`），结果带 `truncated: true`。`ProbeBudgetError` 只剩超时子类在用。
- `probe.ts`：`MediaProbe.truncated`；`probeFromResult(result, bytesRead, truncated)`；半截里没有视频轨才算失败，文案「读了前 N MB 还没找到视频轨（上限 …）」；`probeSummary` 末尾加「只读了前 N MB」。旧版留下的失败缓存（错误含「读取量超过上限」）当没探过，预览自动探测 / 探测缺标签的都会重探，不用人再按作品点一次。
- 三部福尔摩斯小姐在默认 96 MB 预算下复跑：各 48 次 / 96 MB / 20–24 秒，`H.264 · 1080p · DDP Atmos 5.1 en · 31 条音轨 · 字幕 en/zh/ar/cs · 只读了前 96 MB`、`HEVC · 2160p 10bit · DV · DDP Atmos 5.1 en · 2 条音轨 · …`、`HEVC · 2160p 10bit · DDP Atmos 5.1 en · …`，标签四项齐全。
- 没改预算数值：96 MB 已经够拿标签，再大只是多花时间等字幕。

**测试**：`mediainfo.test`「MKV …」加预算只够第一块的半截用例（标签齐、摘要带「只读了前」）、「MP4 的 moov 在尾部」改成截断后半截里没有视频轨；`probe.test` 摘要末尾；`organize.itest` 探测编码一测加「旧版失败缓存自动重探」。

**原盘 ISO（同日补测，用户问「原盘的生化危机也没有探测信息」）**：`/movie` 里三部 UHD 原盘 `.iso`（各 52 GB）在旧预算下同样失败。改成半截结果后：
- 《生化危机6：终章》：96 MB 截断就有 `HEVC · 2160p 10bit · HDR10 · TrueHD Atmos 7.1 · 16 条音轨`，标签四项齐。
- 《生化危机5：惩罚》《生化危机4：战神再生》：只有 `HEVC · 2160p 10bit · HDR10`，没有音轨——不是预算问题：放宽到 512 MB 让 MediaInfo 自己停（读了头 58 MB + 文件尾 42 MB，truncated=false），结果还是没有音轨。原因是 mediainfo.js 把 ISO 当成裸的 BDAV 流（General.Format = BDAV，Duration 只有 32 秒），不解析 UDF / BDMV 目录、不按播放列表找主片，只看镜像最前面那段 m2ts：6 的那段正好是正片（音轨全在），4 / 5 的那段是只有视频 + PGS 的菜单 / 片头。
- 结论：原盘 ISO 的探测只能保证视频编码 / 分辨率 / HDR，音轨看镜像里第一段 m2ts 是什么。要稳就得自己解析 UDF 找到主播放列表的 m2ts 偏移再喂 MediaInfo，另起方案，这次不做。

**原盘 ISO 的便宜做法（同日实验，未实施）**：不解析 UDF，直接把镜像从中点起当成一段裸 BDAV 流喂给 MediaInfo（按 2048 字节扇区对齐，`read(o) → src.read(base + o)`）。《生化危机5》从 50% 处起：24 秒 / 96 MB 截断，`HEVC · 2160p 10bit · HDR10 · TrueHD Atmos 7.1 · 19 条音轨`，默认轨是 TrueHD Atmos；从 20% 处起结果一样（62 秒，直链慢了些）。原理：正片占了镜像的绝大部分，中点几乎必在正片里，TS 的 PAT / PMT 每几十毫秒重复一次，MediaInfo 从任意位置都能同步上。拿不到的只有音轨语言（在播放列表的 STN 表里，裸流里没有），标签用不到。正经做法（解析 UDF 2.50 含 metadata partition → 目录 → PLAYLIST/*.mpls 挑最长的 → 主片 m2ts 的区段偏移）估计四五百行加合成镜像的测试，先不做。

## 方案：原盘 ISO 从镜像中点取样（2026-11-05，用户：「按你的推荐制定计划开始吧」）

**做法**：`probe.ts` 加 `probeView(source, path)`：路径以 `.iso` 结尾就把来源包成从镜像中点起的视图（`base = floor(size / 2 / 2048) * 2048`，`read(o) → source.read(base + o)`，`size` 相应减掉），别的文件原样。`probeDriveFile` 用视图喂 MediaInfo，缓存行的 size 仍记整个文件的。`MediaProbe.sampleOffset` 记从哪个偏移起读的；`probeSummary` 截断提示按它写「只读了中间 N MB」，半截里没有视频轨的失败文案也分开写。不解析 UDF，不挑播放列表。

**不做**：音轨语言（在播放列表 STN 表里，裸流没有）；双正片的盘中点可能落在另一部上，不处理；DVD ISO 走同一条路（MPEG-PS 从任意位置也能同步），不单独验。

**测试**：`probe.test` 的 `probeView`（扇区对齐、偏移映射、非 ISO 原样）和摘要文案；`mediainfo.test` 用 ffmpeg 生成 m2ts（`-f mpegts -mpegts_m2ts_mode 1`），从中点起喂 MediaInfo 能同步出 H.264 + AAC。真机：三张 UHD 原盘 ISO 各探一次看音轨，再探一部 mkv 确认没受影响。

**进度**：
- [x] 实现 + 单测（2026-11-05）
- [x] 真机三张 ISO（2026-11-05）
- [x] 记录（2026-11-05）
- [ ] 提交 / 发版（等用户定）

### 实施记录（2026-11-05）

`probe.ts`：`probeView(source, path)`（`.iso` 且大于 4 个扇区才取样；`base = floor(size / 2 / 2048) * 2048`；视图的 `read` 加基准、`size` 减掉）；`probeDriveFile` 用视图喂 MediaInfo，缓存行 `size` 仍是整个文件；`MediaProbe.sampleOffset`，`probeFromResult(result, bytesRead, truncated, sampleOffset)`；摘要「只读了中间 N MB」，半截里没有视频轨时文案「从镜像中点读了 N MB 还没找到视频轨」/「镜像中点读到的不是能识别的视频流」。README 探测段补一句。测试：`probe.test`「原盘 ISO 从镜像中点取样」（对齐 / 偏移 / 非 ISO 原样 / 太小不取样）+ 摘要文案；`mediainfo.test`「蓝光 m2ts 从中间起喂也能同步出轨道」——ffmpeg 生成 m2ts（`-f mpegts -mpegts_m2ts_mode 1`）要加 `-g 12`，默认两秒的测试片只有开头一个关键帧、SPS 不重复，从中间起拿不到分辨率（真盘关键帧一两秒一个，96 MB 里有好几个）。typecheck / lint 干净，media 两个文件 13 条过。

### 真机验证（2026-11-05，115，只读）

**环境**：config 库只读拷贝，Provider + `probeDriveFile` 直接跑（没起后端），默认预算 96 MB / 64 次，验完拷贝删了。

| 文件 | 结果 |
|---|---|
| 生化危机4：战神再生 - UHD.iso（53 GB） | 36 秒：`HEVC · 2160p 10bit · HDR10 · TrueHD Atmos 7.1 · 14 条音轨 · 只读了中间 96 MB`，标签 `{2160p, HEVC, TrueHD 7.1 Atmos, HDR10}` |
| 生化危机5：惩罚 - UHD.iso（52 GB） | 98 秒（这次直链慢）：`… TrueHD Atmos 7.1 · 19 条音轨`，同上 |
| 生化危机6：终章 - UHD.iso（52 GB） | 49 秒：`… TrueHD Atmos 7.1 · 16 条音轨`，和从头读一样 |
| 生化危机：爆发夜（mkv） | 28 秒：`HEVC · 2160p 10bit · HDR10+ · DDP Atmos 5.1 en · 只读了前 96 MB`，不受影响 |
| 福尔摩斯小姐：失踪的侯爵（mkv） | 28 秒：`H.264 · 1080p · DDP Atmos 5.1 en · 31 条音轨 · 只读了前 96 MB`，不受影响 |

缓存行：ISO 的 `size` 是整个文件的大小，`data.sampleOffset` 约为一半（28 GB 左右），`truncated` 1。音轨语言 ISO 里都是空（裸流没有）。没有告警；网盘没动。
