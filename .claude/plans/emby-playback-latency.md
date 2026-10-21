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
