# Emby 起播速度分析（2026-10-21）

> 状态：**分析，未实施**。对着 `routes/proxy/*`、`services/resolve/direct-link.ts`、`services/cloud-115/client.ts`、throttle.md 的实测数字和 media-probe.md 的 Emby 行为记录写的。

## 一、一次起播到底经过什么

以 115 + 302 为例，客户端按「播放」之后依次发生：

```
① 客户端 → 代理(8091) POST /Items/{id}/PlaybackInfo
   → 代理原样转给 Emby
   → Emby 看这个条目有没有 MediaStreams：
        没有（strm 条目入库时不探，Items/{id}/Refresh 也不探，只在首次 PlaybackInfo 时探）
        → 按 strm 里写的地址起 ffprobe：挂载路径就经 rclone / CD2 读文件头；http 前缀就经 OpenList 取直链再读
        → 读到各轨首包才算完（115 的 remux 文件实测要读到 32 MB），几秒到几十秒
        → 持久化，以后不再探
   → 代理改写：可直连、关转码、DirectStreamUrl 指回代理
② 客户端 → 代理 GET /Videos/{id}/stream
   → 凭据闸门 → 路由规则 →（Infuse：先 302 回代理自己换一跳 UA）
   → 直链缓存（LRU 2000 条、15 分钟、键带 UA）命中就 302
   → 没命中：查 Emby 拿路径（1 次 HTTP）→ 剥挂载前缀 / 对任务 → getIdToPath（fsDirGetId 定目录 + 列父目录找文件，1–3 次 115 请求）
     → getDownloadUrlWeb（proapi ufile/download，1 次，直链和 UA 绑定）→ 302
③ 客户端 → 115 CDN：TLS 握手、首字节、按容器要的几次 Range（mp4 的 moov 在尾部就得先去读尾）
```

throttle.md 里 2026-10-02 的实测（限流 1 次/秒）：②冷启动 **4.4 秒**（按路径找 3 次 + 取链 1 次，每次被限流器隔 1 秒）；路径有缓存时 **0.4 秒**（只剩取链 1 次）；直链缓存命中 ≈ 0。①的 ffprobe 没量过，按经验挂载路径几秒到几十秒、http 前缀快一些；③取决于 CDN 和容器，几百毫秒。

所以**首次播一部新片** ≈ ① 几秒到几十秒 + ② 2–4 秒 + ③ 零点几秒；**同一部第二次播** ≈ ② 0–0.4 秒 + ③。用户感觉「慢」几乎都是第一次，而第一次里 Emby 自己的 ffprobe 占大头，我们的代理只占其次。

夸克 / OpenList 账号不走 302：②变成 Emby 自己向 OpenList 拉流（Node 不参与），①同样存在。

## 二、已经有的

直链 LRU（15 分钟、UA 进键）、条目查询 LRU、Infuse 两跳、PlaybackInfo 改写成直连 + 关转码（不然限码率的客户端会去要转码流，字节全过 Node）、代理是独立进程（取直链不排在同步后面）、`getPickcodeToId` 的 pickcode 缓存、Emby 回填（Emby 探出来的流 → 我们的 media_probes，方向是反的，对起播没帮助）。

## 三、能做的，按收益 / 代价排

### 0. 先量，再改（半天）

代理的 302 日志加分段耗时：查 Emby、找路径、取链、总计（ms），缓存命中也记一个 0；PlaybackInfo 那条记 Emby 回答用了多久、条目有没有 MediaStreams（看响应里的 MediaStreams 长度）。设置页「连接自检」加一项「起播诊断」：挑一个条目模拟 PlaybackInfo + stream，把这几段摆出来。没有这一步，下面哪条该先做、做完有没有用都是猜。

### 1. 入库预热：让 Emby 在没人看的时候把 ffprobe 做掉（1 天，收益最大）

Emby 的 strm 条目只在首次 PlaybackInfo 才探。我们已经有每两分钟一轮的入库检查（`services/emby/library-new.ts`，刷新后 30 秒加急，还记着「没流的条目」pending 列表给回填用）：在同一个循环里，对新入库、还没有 MediaStreams 的条目，由服务端自己调一次 `POST /Items/{id}/PlaybackInfo`（带 API key 和一个用户 id），Emby 就会去探并持久化；用户之后点播放时 ① 这一段就没了。节奏：一次一个、隔几秒，整理 / 同步在跑时让路；一轮最多 N 条，剩下的下一轮接着；可以关（设置里一个开关，默认开）。顺带 Emby 回填也提前拿到流信息。

要先在 emby-lab 里验两件事：服务端发的 PlaybackInfo 是否同样触发探测并持久化（media-probe.md 记的是客户端那次会，服务端带 API key 的大概率一样）；探测时 Emby 读的是 strm 里的地址——挂载路径的用户走的是 rclone / CD2，http 前缀的走 OpenList，这两条路的慢是它们自己的，预热只是把它挪到看不见的时候。

另一条路是把我们 mediainfo.js 探到的流信息**写进 Emby**（UpdateItem 带 MediaStreams），Emby 就不用读文件；Emby 的 UpdateItem 接不接受 MediaStreams 没有把握，lab 里试一次就知道，能成就比预热更省（不用再读一遍文件头）。

### 2. PlaybackInfo 时顺手把直链解析掉（半天，收益第二）

②的 0.4–4 秒本来可以和①重叠：PlaybackInfo 经过代理时已经知道条目 id、媒体源 id、路径（响应体里的 MediaSources[].Path，不用再查 Emby）和 UA，改写完响应后异步把直链解析好放进 linkCache / lookupCache，客户端紧接着的 stream 请求就命中。UA 一致的客户端（Emby 网页 / 手机端 / 电视端）直接受益；Infuse 第二跳的 UA 和 PlaybackInfo 的不一样，直链预热不到，但路径 → pickcode 这一段可以预热（加一个 path → pickcode 的 LRU），第二跳只剩取链 1 次。

### 3. 冷路径少打两个请求（半天）

`getIdToPath` 每次都 `fsDirGetId` + 列父目录。同步早就把列过的目录写进了 `path_cache`（path → id），代理进程只读库也能查：先查 `path_cache` 拿文件 id → `getPickcodeToId`（已有缓存）→ 取链，冷启动从 4 次请求降到 2 次；`path_cache` 没有的再退回现在的找法。整理改名 / 移动已经同步维护 `path_cache`，监控也在用，数据是新鲜的。

### 4. 直链缓存按真实有效期（小）

115 直链 URL 里带过期时间（`t=`）；现在一律 15 分钟，到期后拖一下进度条要重新取链 0.4 秒。按 URL 里的过期时间减一分钟缓存，快到期时后台续一次（同一个 UA），长片看到一半不会因为换链卡一下。

### 5. 限流给起播留口子（小，做完 3 再看要不要）

代理进程的限流器把 115 请求匀成 1/N 秒一个，冷启动的几次请求被硬生生拉开。可以让代理进程的限流器允许一个小的突发（Bottleneck 的 reservoir 或 `maxConcurrent` 2 + `minTime` 减半）——风控看的是持续速率，起播这几次突发不碍事；但「两个进程各按 N 发」的现状本来就是上限两倍，再放开要克制。

### 6. HEAD 也 302（小）

现在 HEAD 一律回源让 Emby 答，Emby 为了填 Content-Length 可能会去开一次文件（挂载路径下就是一次远程读）。直链在缓存里时 HEAD 直接 302 给客户端（ffprobe、主流播放器都跟随），没缓存的照旧回源。先用第 0 步看看哪些客户端起播前发 HEAD。

### 7. 不在我们手里、但要写进文档的

- strm 前缀选 http（OpenList `/d/`）还是挂载路径，决定 Emby 探测走哪条路：FUSE 挂载的读要经过挂载工具自己的直链 + 分块缓存，通常比 OpenList 302 慢；开 302 的用户建议填 OpenList 地址（README 已经写了两种都行，可以加一句哪个快）。
- 客户端「最大码率」别限：限了就被规则送去转码或中转。
- mp4 的 moov 在尾部的文件起播多一次 Range；整理时探测能看出来（mediainfo 读到 moov 的位置），可以在清单里标一句「建议 faststart」，但我们不改文件。
- 夸克没有 302，起播快慢是夸克 CDN 和 OpenList 的事；只有 1 这一条对它有用。

## 四、建议的顺序

0 → 1 → 2 → 3，一两天；4、5、6 看 0 量出来的数字再定。真机环境用 `scripts/emby-lab.sh`（真 Emby 容器 + strm 库 + 直链桩）量①和②，再接真 115 量一遍 ③。

## 实施计划（2026-10-21，用户：「按你的推荐制定计划开始吧」）

顺序 0 → 1 → 2 → 3，每步独立提交；4 / 5 / 6 看第 0 步量出来的数字再定。

**第 0 步 量**：`redirect.ts` 的 302 日志带 `lookupMs / pathMs / linkMs / totalMs`（缓存命中记 0），302 响应加 `Server-Timing` 头；`playback-info.ts` 记 Emby 回答用了多久、条目有没有 MediaStreams（`embyMs`、`hasStreams`）。`ResolveResult` 的成功分支多一个 `timings`。设置页 Emby 一节加「起播诊断」：`POST /api/emby/playback-diagnose`，挑最近入库的一个 strm 条目（或指定 id），服务端走一遍 PlaybackInfo（量 Emby 的时间、有没有流）+ 直链解析（分段），把几段时间和结论摆出来。

**第 1 步 预热**：lab 先验两件事——服务端带 API key 的 `POST /Items/{id}/PlaybackInfo?UserId=` 能不能让 Emby 探 strm 并持久化；`POST /Items/{id}`（UpdateItem）带 MediaStreams 能不能直接写进去。能写就两条都做（有探测缓存的写、没有的预热），不能就只预热。预热挂在 `library-new.ts` 的一轮里：pending 列表里没流的条目，服务端自己发 PlaybackInfo，一次一个、隔 3 秒、一轮最多 5 条；设置 `emby.prewarm`（默认开）；整理 / 同步在跑时不预热（让路）。

**第 2 步 预解析**：`playback-info.ts` 改写完响应后，对每个我们的媒体源异步调 `redirect.ts` 导出的 `prewarmLink({ itemId, mediaSourceId, path, mediaSource, userAgent })`：直接用响应体里的路径填 lookupCache，再解析直链填 linkCache；同 key 并发只跑一次；失败只记 debug。`direct-link.ts` 加 path → pickcode 的 LRU（1 小时），Infuse 第二跳换 UA 时至少省掉找路径那几次。

**第 3 步 少打请求**：`toDirectUrl` 先查 `path_cache`（按账号 + 绝对路径取 file_id，代理进程只读库也能查）→ `getPickcodeToId`（已有缓存）→ 取链；没有的退回 `getIdToPath`。

**测试**：proxy.itest（日志字段、Server-Timing、PlaybackInfo 之后 stream 命中缓存、桩只被调一次）、library-new.itest（pending 条目触发预热、一轮上限、开关关掉不发、整理在跑不发）、direct-link 单测（path_cache 命中走短路、没命中退回）。lab：真 Emby 容器验第 1 步的两个前提，再把 strm 指向容器里的真文件量首播前后。

### 实验记录：真 Emby 容器（2026-10-21，`scripts/emby-lab.sh up`，EMBY_PORT=8097）

strm 指向容器里一个 ffmpeg 生成的 5 秒 mp4（像 Emby 主机挂着网盘），另一条指向宿主机 http 静态服务（像 http 前缀）。看 Emby 日志里 ffprobe 的行数判断有没有探测：

| 动作 | 结果 |
| --- | --- |
| 服务端 `POST /Items/{id}/PlaybackInfo?api_key=`（不带 UserId、不带设备档案、body `{}`） | 200，真跑 ffprobe，MediaStreams / Container / Size / RunTimeTicks 落库；`/Items?Ids=` 再查带着流回来 |
| 同一条目再问 PlaybackInfo | 不再探，110 ms → 14 ms |
| 带 `UserId=` | 一样，不是必需 |
| http 的 strm | 一样探、一样落库 |
| `POST /Items/{id}/Refresh?MetadataRefreshMode=FullRefresh` | 204 但 **不探**（和分析里的判断一致：扫库 / 刷新都不碰 strm 的流） |
| `POST /Items/{id}`（UpdateItem）带 MediaStreams | 204 但 **不落**，之后 PlaybackInfo 照样探——「把探测缓存写回 Emby」这条路走不通 |
| strm 指向读不到的 `/mnt/pan/…` | PlaybackInfo 仍 200（SupportsDirectStream true，我们照样 302），但 **每次都重探**（一次 3 回 ffprobe），永远不落库 |
| PlaybackInfo 响应里 `MediaSources[].Path` | 就是 strm 的内容（`/mnt/pan/...`），302 要解析的就是它——第 2 步预解析可以直接从响应体拿，不用再问 Emby |

结论：第 1 步只做「预热」（服务端替播放器问一次 PlaybackInfo），不做「写回」。探测失败的条目（Emby 主机读不到 strm 指向的位置）预热帮不上，每条只试一次、别反复试。

### 第 0 步实施记录（2026-10-21）

- `direct-link.ts` 成功分支带 `timings { pathMs, linkMs }`；`redirect.ts` 的 302 日志带 `lookupMs / pathMs / linkMs / totalMs`，响应头 `Server-Timing: lookup;dur=…, path;dur=…, link;dur=…, total;dur=…`，缓存命中是 `cache;desc=hit, total;dur=…`；`playback-info.ts` 记 `embyMs` 和流数（0 = Emby 刚才探测失败），响应头 `Server-Timing: emby;dur=…, streams;desc=N`。
- `POST /api/emby/playback-diagnose`（`services/emby/diagnose.ts`，deps 可注入）：没指定 id 就在最近入库 50 条里挑还没探测过的 strm，服务端问一次 PlaybackInfo（`requestPlaybackInfo`，只带 API Key）、再调 `resolveEmbyPath` 换直链，把两段用时、流数前后、失败原因回给前端；设置页 Emby 一节的「起播诊断」块（`PlaybackDiagnoseButton`）把结论写成人话。shared 多了 `PlaybackDiagnosis` / `DirectLinkFailure`（后端 `ResolveFailure` 改成它的别名）。
- 真 Emby 验过：自动挑到唯一没探过的那条（132 ms、流 0 → 2、probed），探过的 14 ms；不存在的 id 回 404。

### 第 1 步实施记录：入库后预热（2026-10-21，e90a1d2）

- 只做「预热」不做「写回」（实验记录里 UpdateItem 不落）。`library-new.ts` 每轮在 pending（入库时没流的条目）里挑还没预热过的，服务端 `requestPlaybackInfo`（只带 API Key）一次一条、隔 3 秒、一轮最多 5 条；先预热再按 id 看一眼，这轮探好的同一轮就回填探测缓存。探测不到的（Emby 读不到 strm 指向的位置）记 `warmedAt`，隔 24 小时再试，不每轮都试。
- 让路：`listRunningTaskIds().length > 0 || organize jobs.size > 0` 时整轮不预热。设置 `emby.prewarm`（默认开），设置页 Emby 一节「入库后预热媒体流」开关。
- deps 多了 `playbackInfo / busy / wait` 三个可注入项；library-new.itest 新增两条用例（一轮 5 条、问过不重问、同轮回填；探不到只问一次 / 开关关 / 让路）。
- 真 Emby 验过：新建 3 条冷 strm，临时后端第一轮日志「预热了 5 个新入库条目的媒体流，3 个 Emby 已探测落库，2 个 Emby 探测不到」，三条新条目随后都是 2 条流。

### 第 2 步实施记录：PlaybackInfo 后预解析（5887ddb）

- `rewritePlaybackInfo` 改回改写过的媒体源列表；`handlePlaybackInfo` 回完响应对每个改写过的源调 `redirect.ts` 的 `prewarmLink`（后台跑）：先用响应里的 `MediaSources[].Path` 填 `lookupCache`（302 不再问 Emby），再 `resolveLink` 填 `linkCache`。key 算法抽成 `cacheKeys()`，MediaSourceId 从改写后的 DirectStreamUrl 里取，和客户端随后发来的流请求一致。
- 302 主路径现在也先看 `lookupCache`；流请求比预解析先到就 `await` 它（`inflight` map），响应 `Server-Timing: cache;desc=prewarm`。Infuse 这类第二跳换 UA 的客户端只预热找路径（`warmPanPath`），不换链。
- `direct-link.ts`：115 调用抽成可注入（`setResolverDeps`），路径 → pickcode 内存缓存 1 小时（`findPickcode`，不分 UA），`clearLinkCache` 顺带清它；`locate()` 把「归哪个账号、盘内路径」拆出来给 `resolveEmbyPath` / `warmPanPath` 共用。
- proxy.itest 新增三条（预解析后 stream 不问 Emby 不解析；stream 先到等预解析；Infuse 只预热路径），`reset()` 改成先等预解析跑完；老用例复原桩统一用 `defaultResolver`（之前三处复原的桩不记 UA，把新用例带偏过）。

### 第 3 步实施记录：路径缓存短路（9ef610d）

- `findPickcode` 三条路：内存 → `findPathCacheFile(account, path)`（path_cache 里账号 + 绝对路径、只认文件行，有索引）→ `getPickcodeToId(file_id)`（一个请求，客户端还有半小时缓存）→ 退回 `getIdToPath` 逐级列目录。库里的 file_id 失效（接口报错）就当没命中。`getPickcodeToId` 的 id 放宽成 `number | string`：file_id 超过 2^53，转 number 会失真。
- `ResolveTimings.pathVia: memo | db | list`，进 302 日志、预解析日志和诊断结果（前端写成「内存里记着 / 库里的路径缓存直接给了文件 id / 逐级列目录找到的」）。

### 真机（只读）验证：用户的 115 账号拷贝 + 实验 Emby（2026-10-21）

临时 API（4101）+ 代理（8092）跑在 config 库的 scratch 拷贝上（Telegram / 生活事件 / 智能体关掉，Emby 指到实验容器），strm 指向 `/root/webdav/115/tv/怪物：丽兹·波顿的故事 (2026) {tmdb-299939}/Season 1/….mkv`（Emby 容器里读不到它，所以 Emby 自己探不出流，和「没给 Emby 挂网盘」的部署一样）：

| 场景 | 结果 |
| --- | --- |
| 诊断接口（指定 id，冷） | Emby 63 ms（流 0 → 0，没探到）；直链 ok，找路径 1366 ms（list）+ 取链 2211 ms |
| PlaybackInfo(VLC) → 紧接着要流 | PlaybackInfo `emby;dur=51`；流请求 302，`cache;desc=prewarm, total 4828`（等预解析：找路径 2783 list + 取链 2067）；再来一次 `cache;desc=hit, total 0` |
| 换 UA 要流 | `lookup;desc=cache, path;dur=0（memo）, link;dur=603` |
| 写进 path_cache、重启代理 | `lookup 36, path;dur=1454（db，一个请求）, link 1572` |
| Infuse：PlaybackInfo 只预热路径 → 第一跳回自己 → 第二跳 | 第二跳 `lookup;desc=cache, path;dur=0（memo）, link;dur=522` |

读数里 115 每个请求 0.5～1.5 秒（限流 1 req/s + 网络），所以省请求数就是省秒数：路径走内存 / 库之后冷解析只剩取链那一个请求。取链本身 0.5～2 秒是 115 接口的，我们动不了。

### 路径缓存短路的风险与修补（2026-10-21，用户问「路径缓存短路有风险吗」）

风险都是「缓存过期」一类：
1. **无声播错文件**：path_cache 的行是「账号 + 路径 → file_id」。路径被另一个文件占了、原文件没删只是挪走、中间没人更新这一行（整理 / 归档 / 删除走 Provider 会同步改，转存 / 追更 / 整理解析路径时写入，生活事件监控处理 115 的改名 / 删除；**监控没开时外部改动不会写进来**，行能留 180 天），按旧 file_id 取 pickcode 就播成挪走的那个。
2. **同路径换了文件会卡一小时**：内存记的 pickcode / 库里的 file_id 失效，库这条会退回列目录，但「取链失败」没有退回，内存记着旧 pickcode 一小时（以前直链缓存只有 15 分钟）。
3. 同路径多行时 `.get()` 随便取一行。

修补（同日提交）：
- `files/file?file_id=` 只回 file_id / file_name / pick_code / sha1 / file_size，**没有父目录**；`files/get_info?file_id=` 回 `fid / cid（父目录）/ n / pc / s / aid / sha …`，不存在时 `state:false, code:20018`（真机验过）。新 `getFileInfoById` 用 get_info；`findPickcode` 的库路线拿档案和行核对：文件名一样、父目录一样（parent_id 是 0 的老行只看名字）、`aid === 1`，对不上就退回列目录。
- `toDirectUrl`：pickcode 来自内存 / 库而取链失败（回空或抛错）→ 清内存、`findPickcode(..., { fresh: true })` 现找一次再取；现找的取链失败照旧 no-url / 抛错。
- `findPathCacheFile` 按 `updated_at desc, rowid desc` 取最新行。
- 真机只读：父目录错的行 → list 2075 ms；对的行 → db 524 ms（一个请求）；内存 0 ms；整条解析取链 1381 ms。

### 评审与修补（2026-10-21，用户「review 一下」，`/code-review max 04195a2..HEAD`，15 条全部确认、全部修完）

评审范围是 rc.1 之后的十个提交。第一次跑撞上模型额度，重跑后给了 15 条，核对代码都是真问题；另外顺手修了它「超出条数上限」里的三条（Alist 式路径没有前导斜杠、路由规则已查过条目时 Server-Timing 仍报 `lookup;dur=0`、前端 120 秒超时比后端最坏情况短）。一个提交修完，按严重程度：

1. **预热让假令牌能拿到直链**（redirect.ts）。两份缓存都按条目记、不分令牌；以前每次都带客户端令牌问 Emby、不认就 401 回源，PlaybackInfo 预热把条目路径先放进 lookupCache 之后这一步被跳过了——能访问代理端口的人报个条目 id、随便编个令牌就能换到 115 直链。修法：`trustedTokens`（15 分钟）——没被 Emby 认过的令牌先带着它查一次条目（Emby 裁决），认了才能用条目缓存 / 直链缓存；PlaybackInfo 透传成功时 `trustToken(客户端令牌)`。允许匿名 302 的部署照旧。测试：假令牌换 UA / 同 UA 都不 302、要问一次 Emby；认过的令牌换 UA 不问 Emby。
2. **库里的行核对父目录形同虚设**（direct-link.ts）。Provider 列目录（`rememberListing`）和整理挪文件（`noteRelocated`）写的行 `parent_id` 都是空的，核对退化成只看文件名；而且就算记了，上一级目录改了名它照样对得上。修法：不看行里的 parent_id，按路径现问目录 id（`fsDirGetId`，10 分钟缓存，列目录那条路第一步也是它）和档案里的 cid 比；根目录下的文件 cid 是 0。库路线冷的 2 个请求（get_info + getid），目录 id 热的 1 个。
3. **内存里的 pickcode 一小时不验**：同路径换了文件（整理的「替换」冲突办法、重新转存）会播旧文件最多一小时、所有 UA。修法：内存记录 15 分钟（和直链缓存一样长）、记下文件 id 和时刻；命中时读一眼库里这一行（本地读，不花请求），行比记录新（整理 / 转存 / 监控改过）就作废重新核对。监控没开时外部换文件的窗口回到以前直链缓存的量级。
4. **取链失败后的「现找一次」绕不过客户端缓存**：`fresh` 只跳过内存和库，`getIdToPath` 照样用 dirIdCache / filesListCache / pickcodeCache（get_info 刚把同一个 id 的 pickcode 喂了进去），重找回来还是那个 pickcode，第二次失败按「现找的」抛出去回源，而且内存又记上，每次播放都重复一遍。修法：`fresh` 一路传到 `fsDirGetId` / `listDirEntries` / `getPickcodeToId`，三份缓存都绕过。
5. **预热不认停机信号**：`tickEmbyNew` 不接 `createPollingLoop` 给的 signal，一轮预热最坏 5 × 90 秒，`stopEmbyNewWatcher()` 等它跑完才轮到 `app.close()`，docker 10 秒就 SIGKILL，pending 落库也丢。修法：signal 传到 `requestPlaybackInfo`（`AbortSignal.any` 和超时合起来）和两次之间的等待；掐断就停，在问的那条不记时间，pending 照样落库；另加每轮 60 秒的预算，超过就不开新的。
6. **诊断输入框回车提交整页设置**（前端）：输入框在设置页的 `<form>` 里，回车走 HTML 隐式提交，点到表单里第一个没写 type 的按钮（更新一节的「立即检查」）并 PATCH 整页设置。修法：`onKeyDown` 回车 `preventDefault` 并开始诊断（tag-input 同款）。
7. **取链的任何错误都当「pickcode 过期」**：超时、风控、cookie 失效（115 回 state:false，`decrypt(undefined)` 抛 TypeError）都触发清内存 → 列目录 → 再取，一次 30 秒变两次 60 秒，真正的错误还被盖掉。修法：`getDownloadUrlWeb` 先 `ensureOk`（state:false 按 115 的文案抛 Cloud115ApiError，data 不是密文回空）；只有「115 回答了不行、且不是登录失效 / 风控」（`classifyAccountIssue` 认不出账号问题）才算记录过期，而且只对内存里的 pickcode 重找——库里的刚核对过档案、现找的本来就新，取不到就是真失败，照常抛。`getFileInfoById` 的非 20018 失败同样改成 Cloud115ApiError；库路线里 get_info 的网络错误不再退回列目录（一样过不去），直接抛。
8. **预热拖住入库通知、加急被丢**：通知在 `backfillRound`（含预热）之后，一批剧集的 Telegram 要等几十秒到几分钟；`createPollingLoop` 的加急到点时正有一轮在跑就丢掉。修法：一轮的顺序改成 取条目 → 通知 → 回填（预热 → 按 id 再看）；polling.ts 的加急到点时正在跑就记下，这一轮一结束紧接着来一轮（监控那条循环也受益：同步结束的补跑不再丢）。
9. **多版本条目的预解析同时发、不限量、和真正的 302 同优先级**：各版本各自列一遍目录，客户端要的版本排在兄弟后面；PlaybackInfo 问过但没播的也排 2～4 个请求在别人前面。修法：`prewarmLink` 接 `after`，几个版本挨个来（第一个版本不等别的，后面的接着用目录缓存），只做前 3 个；限流器加 Bottleneck 优先级（`PRIORITY_BACKGROUND = 7`，通道链到节奏上一起带过去），预解析的 115 请求排在普通请求后面。`priority` 从 `resolveEmbyPath` → 客户端各函数 → `request115` → `scheduleForAccount` 一路传。
10. **`warmedAt` 在问之前就盖、抛错也留着**：Emby 重启 / 5xx / 90 秒超时的条目被按「探测失败」记 24 小时。修法：Emby 答了才记 `warmedAt`；没问成记 `failedAt`，十分钟后再试；停机掐断的什么都不记。
11. **一轮只看最新 50 条**：整季 80 集一次入库，后 30 集既不预热也不回填、通知总数也少。修法：`fetch(limit, startIndex)` 翻页——这一页最老的那条还比两个游标都新就翻下一页，最多 10 页，按 id 去重、一页没新的就停；首轮（没游标）只看一页。
12. **Infuse 的路径预热和第二跳撞车**：预热是 fire-and-forget、不在 inflight 里，`findPickcode` 没有单飞，第二跳几百毫秒内到就把同样的请求再发一遍、还排在预热后面。修法：`findPickcode` 按 `账号:路径` 单飞（`finding` Map），后到的等先到的结果。
13. **诊断的 Emby 失败成 500 未处理异常、不查地址**：`getItem` / `listRecent` 的 `fetch failed` 直接落到错误处理器（栈日志 + 500）；只查 apiKey 不查 url，url 空时 `embyUpstream()` 退到 docker 网关默认值，对着不存在的 Emby 报「没回答」。修法：地址和 key 都空则 400；取条目的失败包成 `upstreamError("Emby 没回答：…")`。
14. **诊断在 API 进程里量，不是播放代理**：同步 / 整理在跑时网盘请求排在几百个请求后面、量出来的是排队时间；第二次点命中 API 进程自己的内存、报 0 ms，而代理是冷的。修法：同步 / 整理在跑时回 409 让用户等；量之前 `forgetPanPath` 忘掉这条路径的内存记录，每次量的都是冷路径（相当于代理冷启动的用时）；界面文案说明。两进程各一套缓存这一点没法改，文档和文案里写明。
15. **客户端那条 PlaybackInfo 转发仍是 15 秒超时**（上游 `fetchUpstream`）：探测超过 15 秒的条目（最慢的那些）回源 → 客户端拿到没改写的回答去转码；而且回源时 body 是 Buffer，reply-from 按 application/json 把它 `JSON.stringify` 成 `{"type":"Buffer","data":[…]}`，设备档案丢了。修法：`fetchUpstream(request, { timeoutMs })`，PlaybackInfo 用 90 秒（和服务端自己问的一个常量）；`toEmby(request, reply, { body })` 带 contentType 原样转发。测试里起了个小应用对着假 Emby 的 echo 路由验 body 原样到达。

现在的缓存口径：直链 15 分钟（UA 进 key）、条目查询 15 分钟、**认过的令牌 15 分钟**、**路径 → pickcode 内存 15 分钟**（命中时核对库里这一行没改过）、115 客户端 pickcode 30 分钟 / 目录 id 10 分钟 / 目录列表 5 分钟、path_cache 行 180 天。库路线冷的 2 个请求（get_info + getid）、目录 id 热的 1 个。

测试：direct-link 35、proxy 54、library-new 15、diagnose 8、polling 新增「加急撞上正在跑的一轮」；前端 typecheck / lint / 11 个单测过。

顺手的三处清理（评审「超出条数」里的）：pending 里探过了但只有音频流的条目拿掉（以前没有视频流就一直挂着、每轮按 id 问到 30 天）；diagnose.ts 用 lib/errors 的 `messageOf`，不再自带一份；115 客户端按 id 取 pickcode 的缓存键收成 `pickcodeKey()`（files/file 和 get_info 两条路喂同一份缓存，键必须一个算法）。全量后端 1672 过。

### 发布：v2.19.0-rc.2（2026-10-21，用户「发个 rc」）

a08f5c0 = rc.1 + 第 0～3 步 + 路径缓存风险修补 + 评审 15 条全修 + 版本号；没有迁移。Release #114 四作业和 CI@v2 #135 全绿，Docker Hub rc 镜像 8649ce43052b（amd64 / arm64），GitHub Release 是预发布，latest 仍是 v2.18.0，main 未动。正式版说明要写：设置页 Emby 一节新增「入库后预热媒体流」（默认开）和「起播诊断」；302 响应带 Server-Timing；代理只给 Emby 认过的令牌用缓存（令牌第一次来要先过一次 Emby）。

