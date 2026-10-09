<div align="center">
  <img src="apps/frontend/public/logo.png" alt="OpenStrm Logo" width="200" height="200">
</div>

# OpenStrm

一个开源的 **Strm 生成工具**：把 115、夸克、OpenList 上的影视目录同步成本地 `.strm`，交给 Emby 这类媒体服务器播放；115 的还能 302 到直链播放。

> **安全提示**：Next.js 的 [CVE-2025-66478](https://nextjs.org/blog/CVE-2025-66478)（React2Shell，CVSS 10.0，可导致远程代码执行）影响使用 App Router 的 Next.js 15.x / 16.x，而且要有 Next.js 服务端在跑才能利用。v2 起生产镜像里没有 Next.js 服务进程——前端是静态导出，由后端进程直接托管——所以**当前版本不受影响**；锁定的 `next@15.4.8` 也是官方公告列出的 15.4.x 修复版本。仍在使用 v0.2.4 及更早版本的请尽快升级；那些版本若曾以未修复状态暴露在公网，建议轮换应用密钥。

## ✨ 为什么做这个软件

希望此项目能帮助大家更简单创建的自己strm库。  

该项目的目标是：**开放、简洁、可改造**。  

本项目参考或依赖以下项目： 
- [p115client](https://github.com/ChenyangGao/p115client/)
- [Alist](https://github.com/alist-org/alist)  
- [Openlist](https://github.com/OpenListTeam/OpenList)  
- [embyExternalUrl](https://github.com/bpking1/embyExternalUrl)  
- [rclone](https://github.com/rclone/rclone)  
- [PanSou](https://github.com/fish2018/pansou)（资源搜索，可选）  

## 🚀 特性

- 开源自由
- 三种网盘账号：115、夸克、OpenList。同步任务把网盘目录生成成本地的 `.strm`，字幕 / nfo / 海报这类小文件按扩展名直接下到本地；支持自定义前缀（方便配合媒体服务器使用），可以手动跑，也可以按 cron 定时跑
- 115 基于目录树导出生成，一次拿到整棵树
- 夸克网盘：同步生成 strm、随片下载字幕 / nfo、分享转存、追更、网盘监控、strm 校验与重新生成，和 115 用同一套页面。夸克没有整树导出，一次同步要逐个目录翻页，大库别把定时设太密；夸克直链取文件必须带 Cookie，所以不支持 302
- OpenList：同步、浏览目录、整理都能用；没有分享转存、追更、网盘监控，也不走 302
- 分享转存与追更：顶栏贴 115 / 夸克分享链接就能看内容、转存到同一网盘的任务目录并生成 strm，勾上「追更」后定时检查分享里的新增并自动转存（夸克分享条目没有 sha1，改名 / 换文件靠分享内 id 识别；夸克还会先问服务端「相对上次转存有没有新增」，没有就不用列目录）
- 网盘监控：115 走生活事件流实时增量；夸克没有事件流，靠定时把任务目录整棵列一遍和上一轮快照对比（最短 5 分钟一轮，大库等于高频同步），一轮里消失超过三成先不删本地文件，下一轮还是这样才删。可以同时监控多个账号，每个账号各跑各的
- 115 云下载：磁力 / ed2k / http 链接交给 115 云端下载，下到任务目录后自动生成 strm
- 资源搜索：接上自己部署的 PanSou，按片名搜网盘分享和磁力，搜到的 115 / 夸克分享一键转存，磁力交给 115 云下载；顶栏的输入框、⌘K 和智能体都能搜。详见下方「资源搜索」
- 收藏夹：收藏的分享（还没存进网盘）会把目录树抄下来建索引，几百部的大包也能按片名、英文名、年份搜到里面的每一部；配了 TMDB 还会认出一部部作品，按海报墙看、同一部的几个版本合成一张卡。首页搜索、⌘K、Telegram 和智能体都先搜收藏夹，点一条就能打开或转存。分享失效了自动标出来，能找替代、更新链接或一键清理。详见下方「收藏夹」
- 整理与规范化命名：按 TMDB 识别网盘里的影视文件，在网盘上改名、归到 `作品 (年份) [tmdbid=…]/Season 01/作品 - S01E01.ext` 这样的媒体服务器规范目录，本地 strm 跟着挪；先预览再执行，做过的能撤销，冲突和失败项都有处理办法。详见下方「整理与规范化命名」
- strm 管理：按任务浏览生成的 strm，体检、校验指向的文件在网盘上还在不在、改了前缀后批量修正、补齐或重建
- 失败说清楚原因和办法：文件名过长、名字里有本地文件系统不认的字符、磁盘满、没权限、cookie 失效、风控……按原因归类并给出下一步（名字的问题能一键跳去「整理」）；磁盘满、没权限、账号失效这类整轮都会失败的直接停下，不再逐个文件白试
- Emby 302 直链（115）、Telegram 机器人（通知 + 遥控）
- 智能体接入（MCP）：Claude Code、Codex、Open WebUI 这类 AI 客户端用令牌连上来，claude.ai、ChatGPT 网页从公网走 OAuth 连上来，能查任务和同步进度、开始同步、搜资源、看分享、转存、收藏分享、按作品逛收藏夹（同一部的几个版本、你本地是不是已经有了）、添加云下载（可顺带复制到 OpenList，复制队列能看、失败的能重试），替你核对整理清单（认不准的去 TMDB 找、冲突选办法）、你点头后执行或撤销，管理追更，查找、体检、修正 strm；分权限档，每次调用都有记录
- 检查更新：默认不联网，在设置页点一下才查；也可以开每天自动查
- ⌘K（Windows / Linux 上是 Ctrl+K）命令面板：跳页面、找任务 / 账户 / 追更，对找到的任务直接开始同步、看日志或去整理
- 支持账号级限流和重试逻辑
- 轻量：一个容器、一个 SQLite 库文件，易于二次开发

## 🎬 Emby 302 直链

命中挂载点的媒体不再由本服务中转字节，而是 302 到 115 直链，由客户端直接向 CDN 取——这是代理层存在的理由。

**前置配置**：

1. 在设置页配置 Emby 地址和 API Key
2. 新建同步任务时开启 **302 开关**（只有 115 账号的任务有这个开关）。前缀填本地挂载路径（如 `/mnt/115`，会自动拼上 /账号名）或 OpenList 的 `/d/` 地址（如 `http://192.168.1.10:5244/d/115`，不拼账号名）都可以：换到 115 直链就 302，换不到时回给 Emby 按 strm 里的地址播放。用 OpenList 地址时 `/d/` 要能无签名访问（全局「签名所有」和该存储的「启用签名」都关掉）、挂的是同一个 115 账号；关掉签名后知道路径的人都能直接下载，所以 OpenList 只需对 Emby 可达，不要开在公网上
3. Emby 客户端连本项目的 **8091** 端口，而不是 Emby 自己的 8096

> 建议把 115 账号的命名和 OpenList 或 CD 里保持一致：找不到直链时才能正确回源。

**两张规则表**（设置页「Emby」一节，保存即生效、不用重启）：

- **路径映射**：Emby 看到的路径前缀 → 哪个 115 账号的哪个目录。开了 302 的任务自己就能推出这层关系，不用填；只有任务推不出来的才填——别的工具生成的 strm、挂载结构不是「一个前缀对一个目录」的。多条取最长前缀，手填的优先于任务推出来的
- **播放路由规则**：按客户端（User-Agent、客户端名、设备名、设备 id）、来源（内网 / 外网）、路径决定走 302 直链还是交给 Emby 自己播（中转或转码）。从上到下第一条命中的生效；条件都不填就全部命中，所以加一条什么都不填的「交给 Emby」等于把 302 关掉；一条都没命中照常 302。「交给 Emby」的请求 PlaybackInfo 原样、流请求回源，限了码率的外网播放就能转码。「来源」要在反代后面认得出，容器得设 `TRUST_PROXY`（8091 和管理界面用同一个变量）

怎么确认真的走了 302，见下方「确认 302 是否生效」。

## 🗂️ 整理与规范化命名

侧栏「整理」页：按 TMDB 识别网盘里的影视文件，直接在**网盘上**改名、归到媒体服务器认的标准目录，本地 strm 跟着挪，不用重新同步。115、夸克、OpenList 都能用。

**先配 TMDB**：设置页「TMDB」一节填 API 读访问令牌（API Read Access Token）——TMDB 账号设置里 API 页上那串很长的 v4 令牌（`eyJ` 开头），不是 32 位的 v3 API Key。

**一次整理**：

1. 选任务和范围：整个任务，或者多选其中几个目录（直接选季目录也行）
2. 「预览」：只读网盘和 TMDB，不改任何东西。每部作品标出把握大小；认错的点「换匹配」，按片名搜，或直接填 TMDB 编号 / 贴 TMDB 链接；文件名里只有绝对集数的可以改季、设集偏移；勾上「记住这个识别」，下次整理同一个目录直接按它认；不想动的取消勾选
3. 「执行」：在网盘上建目录、改名、移动，本地 strm 同步挪过去。被挪走的目录如果被追更或云下载引用着，那边的路径一起改写
4. 做过的能「撤销」，按记录逆序退回

默认模板整理出来是这样（设置页能改模板，输入时实时显示样例）：

```
沙丘：第二部 (2024) [tmdbid=693134]/沙丘：第二部 (2024) - 2160p.mkv
怒呛人生 (2023) [tmdbid=153312]/Season 01/怒呛人生 - S01E01.mkv
```

字幕跟着视频改名，语言后缀统一成 `zh-CN`、`zh-TW`、`en` 这样；和视频同名的 nfo 跟着改名。

正片挪走以后，同一个目录里剩下的也跟着走，旧目录腾空就删掉：花絮（预告、NCOP、sample、`Featurettes/` 这类目录里的）进作品目录下的 `extras/`；目录是这部作品自己的，里面认不出的图片和别的文件原名进作品目录。目标位置有同名的就留在原处，不算冲突。已经在作品目录里的不重新摆。

**冲突**：目标位置已经有同名文件时，这一项默认留在原处，可以逐个选怎么办：改名保留两份（加画质 / 来源 / 压制组之类的区分后缀）、自己填名字、挪进任务根下的 `重复文件/`（那里不生成 strm，也不再被整理扫描）、删掉这一份、覆盖目标那份。删掉和覆盖会把文件扔进网盘回收站（115 / 夸克；OpenList 看挂的是什么存储），**撤销退不回来**。

**失败项**：按原因分组——网盘拒绝（风控或登录失效，整轮已经停下）、临时失败（执行时已自动重试过）、预览后网盘变了、名字不被网盘接受、本地没跟上——每组给出能做的事：重试、重新预览或放弃。撤销也一样，半路停下的能接着撤。

**自动整理**：转存、追更、云下载、网盘监控带来的新文件可以自动整理。设置页给默认策略，任务上可以单独设：关 / 生成待确认清单并通知 / 把握大的直接执行、其余留待确认。

其它都在设置页「整理与命名」：id 标签写法（Emby / Jellyfin / Plex）、冒号处理、文件名里写集标题、执行后删掉腾空的源目录、花絮要不要跟着挪进 `extras/`、按类型 / 地区 / 语言分的二级分类、识别词（屏蔽、替换、集数偏移、直接指定 TMDB 编号）。

## 📁 strm 管理

侧栏「strm 管理」按任务浏览生成的本地 strm 目录，可以搜文件名；点开一个 strm 能看到它的内容和解析出的网盘路径。「工具」里有：

- **体检**：同名嵌套（多半是重复生成的一层）、空目录、内容过期（和任务现在的前缀 / 网盘路径 / 编码设置对不上）、无法解析、疑似重复剧集、下载中断留下的 `.part`、命名不规范（一键跳去「整理」）
- **校验网盘路径**：逐个核对 strm 指向的文件在网盘上还在不在，不在的可以直接删掉
- **修正**：改了任务的前缀或路径编码之后，按现在的设置批量重写对不上的 strm，先预览改动再写
- **重新生成**：「补齐」只生成缺的；「重建」按网盘现在的目录重来，本地多出来的 strm 会删掉，字幕 / nfo 等附件不动

目录的「更多操作」和 strm 行上还能把网盘上的那一份**复制到 OpenList**（见下文）或**归档到暂存区**：挪进任务目录下的「归档」（原来的层级留着），本地对应的 strm 删掉，之后不再同步、监控、整理；不管有没有复制到 OpenList，也不核对别处有没有副本。想恢复的话到网盘里挪回去就行。

## ☁️ 115 云下载

侧栏「云下载」页对应 115 的离线下载：贴上磁力、ed2k、http(s)、ftp 链接（每行一条，直接贴 40 位 info hash 也行），由 115 在云端下载到网盘。

下载位置二选一：

- **同步任务的目录**（可进子目录）：下载完成后自动只为这次下载的文件/目录生成 strm，不用再跑全量同步。回执落在数据库里，服务重启后接着盯；结果（生成了几个、为什么失败）直接显示在任务行下面，配置了 Telegram 的话也会推一条。
- **网盘里的任意目录**：只下载，不管 strm。

下载到 115 默认目录时还可以勾选「**下载完成后让 OpenList 复制走**」：115 下完，就通知 OpenList 把产物从挂载的 115 存储复制到另一个存储（比如挂载的本地磁盘），并一直盯到 OpenList 复制完（目录会被 OpenList 拆成逐文件任务，也一并盯）。先在设置页配好三样：openlist 账号、115 默认下载目录在 OpenList 里的路径（如 `/115/云下载`）、复制目标目录；添加时还能从目标目录出发逐层进子文件夹，选这一次具体复制到哪。成败同样进回执和 Telegram 通知。

列表支持翻页、重试失败任务、删除（可选连网盘文件一起删）、清空已完成 / 失败；配额剩余量显示在顶部。添加任务用的是 115 客户端的加密接口，和 App 内添加等价；接口只认 cookie，不需要额外配置。

## 🔭 资源搜索

接上自己部署的 [PanSou](https://github.com/fish2018/pansou)（网盘资源搜索服务，怎么部署、怎么配频道和插件见它的项目主页），就能按片名搜网盘分享和磁力：侧栏「资源搜索」页、顶栏输入框、⌘K、Telegram（`/s 片名`）和智能体都能搜。搜到的 115 / 夸克分享一键转存，磁力交给 115 云下载。

在设置页「资源搜索」一节填 PanSou 的地址（它开了登录的再填用户名和密码），点「检查连接」看看通没通；链接有效性检测、屏蔽词也在这一节。后端设了 `HTTP_PROXY` / `HTTPS_PROXY` 的话，把 PanSou 的主机名写进 `NO_PROXY`，不然请求会绕到代理上去。

## 🔖 收藏夹

收藏夹是收藏分享的地方，115 和夸克的分享都能收，收着的还没存进你的网盘，要看的时候再转存。收进来的分享会把**目录树抄下来建索引**，之后在首页搜索、⌘K、Telegram、智能体里按片名、英文名、年份都能搜到里面的每一部——几百部电影的分类大包也一样。

- **收藏**：收藏夹页「收藏分享」贴链接（整段「链接：… 提取码：…」也行）收下整个分享，一次可以贴好几个（一行一个，或者一段接一段），加之前先列出认出了哪几个、哪些已经收过，加完每个的结果都列在框里；只想收其中一个目录的，在分享详情里进到那一层点「收藏」。同一个分享不会重复收：收过整包再收里面的目录会提示已收录，先收了子目录再收整包会把它们并进来。
- **建索引**：先抄浅层，分类和作品目录名几秒就能搜，文件名在后台慢慢补；抄的时候让着同步和 302 播放，上千个目录的大包要几分钟到几十分钟，进度在收藏夹页上，服务重启后接着抄。分享里加了片，点「重新建索引」。
- **搜索**：目录名、里面的文件名（英文原名、年份、集数通常在文件名里）和上级目录都算，空格分开的几个词都要有（年份例外：对得上的排前面，对不上的照样给，剧集目录常常不写年份），「阿甘正传」「Forrest Gump」「阿甘正传 1994」搜到的是同一个目录，汉字数字和阿拉伯数字也通用（「35岁」搜得到「三十五岁」）。一条结果是一个目录：名字、画质标签、在分享里的位置、大小、视频数和样例文件名，剧集还列出下一层的季目录名，看一眼就能判断是不是要的那一部；「打开」让分享详情直接定位到那一层，「转存」存到任务目录（和分享详情里一样能顺带追更、整理、复制到 OpenList）。首页搜索里收藏夹的结果排在网上的前面，没配 PanSou 也能搜收藏夹。
- **分享失效**：按分享记，同一个分享里的全部一起算。分享明确说取消、过期的直接判失效；说法含糊的隔几小时复查，连着三次打不开才算；分享还在、只是某个目录打不开的，只标那个目录。每天巡检一遍（每个分享一次请求，设置页「收藏夹」一节能关），确认失效的推一条 Telegram（可关）。失效分享里的结果在搜索里折叠在最后，能一键「找替代」；上传者重发了新链接，用「更新链接」接上；只是一时打不开被判了失效的（比如分享在审核），点「再查一次」，能打开了就接着用；不要了在收藏夹页「已失效」里一键清理（只删收藏夹的记录和索引，网盘上的文件和 strm 都不动）。
- **按作品看**：配了 TMDB，抄完的目录树会切成一部部作品（季目录归到剧、合集里一部一个）拿去认，收藏夹页「作品」是海报墙：同一部作品的几个版本、几季合成一张卡，能按电影 / 剧集筛。认出来的正式名、原名、英文名、别名也能搜（上传者把文件名写成中文的剧，照样能用英文名搜到）。认得没把握的在「待确认」里，没认出的在「没认出」里：点开作品「换匹配」（先列识别时的备选，也能按片名或 TMDB 编号搜），确实不是影视的标成「不是影视」。剧的几季一季一个目录分开放的，作品弹框里能「一起转存」到同一个位置。改了整理的识别词以后，来源菜单里「重新识别作品」。
- **智能体**：`library_search` 瞬间搜收藏夹，`resource_search` 的结果里也先带上收藏夹的前几条；条目里带着链接和目录 id，能直接 `share_inspect` 看内容、`share_save` 转存。`library_works` 按作品逛（能按名字、年份、类型、国家 / 地区筛，比如「韩剧」「科幻片」；也能一次对一份片单，逐个说有没有），`library_work` 看一部作品在收藏夹里的全部版本、你本地是不是已经有了（本地 strm 目录里认得出的、从收藏夹存过的；没整理过的目录认不出）、剧一季一个目录的一次存全季；`library_add` 把分享收进来（一次能好几个）；`library_match` 改认错 / 没认出的（改之前先列给你看）；`library_sources` 看收藏的分享、哪些失效了、里面有哪些作品。作品弹框和海报墙上也会标「已经有了 / 已有」。

## 🤖 Telegram 机器人

侧栏「Telegram」页填上 @BotFather 给的 bot token 和自己的 chat id（给机器人发 `/id` 就能看到），开启轮询即可；不需要公网地址。

- **通知**：任务完成 / 失败（含定时触发的启动失败，带原因）、云下载完成、收藏夹里的分享失效、追更（转存了新文件、分享失效、长期没更新；配了资源搜索的话后两种带「搜替代资源」按钮）、Emby 入库（新条目进了媒体库，按剧聚合；要先配好 Emby 地址和 API Key）、整理（执行完成、生成了待确认清单）、网盘账号 cookie 失效或被封控（同一原因一小时只提醒一次）、有新版本（同一个版本只发一次）。每类可单独关掉；任务开始和新版本默认不发。
- **直接发链接**：磁力 / ed2k / http 链接 → 选下到哪个任务目录（可逐层进入子文件夹，比如 `tv/某剧/Season 1`），交给 115 云下载，下完自动生成 strm；配置了「复制到 OpenList」的话还会多一个「115 默认目录，下完让 OpenList 复制走」按钮（同样能逐层选复制到哪个子文件夹）；115 / 夸克分享链接 → 看一眼内容，选转存到同一网盘的哪个任务目录（同样可进子文件夹）并触发同步。
- **命令**：`/tasks` 任务列表（带运行按钮）、`/status`、`/history`、`/offline`、`/cancel`、`/s 片名` 搜资源（收藏夹的列在最前面；网上搜要先配好资源搜索；私聊里直接发片名也行，群里只认 `/s`）。

只回应白名单里的用户 id（陌生人私聊会收到自己的 id，加进白名单即可），群里只认配置的那个 chat id。会改动网盘或跑任务的动作（运行任务、添加云下载、转存分享）各有开关，默认全关。

## 🧠 智能体接入（MCP）

让 AI 客户端通过 [MCP](https://modelcontextprotocol.io) 调用 OpenStrm：说一句「把这个分享转存到电视剧任务，整理好」「电影任务跑一下同步，跑完告诉我失败了哪些」「整理一下动漫任务，认不准的列给我看」，由它去调工具。

**开启**：设置页「智能体接入」一节，打开开关并保存；再「新建令牌」（要再输一次登录密码），每个客户端单独建一个。

- **权限档**：只读（查任务、同步进度和记录、搜资源、逛收藏夹、网盘目录、分享内容、云下载列表、复制到 OpenList 的队列、整理清单、追更、strm 体检）/ 日常（再加开始 / 取消同步、收藏分享、转存分享、添加云下载、重试失败的复制、事后归档复制好的源文件、把网盘上的目录 / 文件收进暂存区、整理的预览 / 改清单 / 执行 / 撤销、追更的检查和修改、修正 strm）/ 完全（再加删 strm、按网盘重建 strm、删追更、执行带删除项的整理）。整理清单里给冲突选「删掉 / 覆盖」日常档就能做（只是改清单）；清单里有删除项时，没有完全档的它执行不了，会请你在整理页点执行。只读令牌根本看不到会改网盘的工具。账号 cookie、设置、备份这些永远不对令牌开放。
- **工具集**：同步、搜资源 / 收藏 / 转存与云下载（收藏夹、复制到 OpenList 的队列也在这一组）、整理、追更、strm 管理五组，可以只开需要的几组，工具少了本地小模型选得更准。选「全部」记下的是当时的那几组：以后的版本加了新的一组，要回来勾上才能用——手建的令牌点「修改」，网页客户端在「已连接的客户端」里点「改权限」，改完立即生效。
- **整理交给它**：它看得到整理清单（认不出、把握不大、有冲突的排在前面），能去 TMDB 找对的那部、改季和集偏移、给冲突选办法，再把一段 OpenStrm 自己写的摘要（`confirmText`）给你看。你点头后它才执行；执行时要带上你看过的那一版清单的编号（`planVersion`），清单后来又变过（比如你在界面上改了）就会被拒，得重新给你看。执行过的能撤销。
- **复制到 OpenList**：转存、云下载可以要这一次也复制（任务没开复制也行），不说就按任务上的开关；任务开着复制的没法这一次不复制（和界面一样，网盘监控也会把新文件交给复制）。云下载指定复制到哪，只能选任务上或设置页填的目标目录、以及它们下面的目录。结果里会说排没排上、复制到哪、复制完删不删网盘上的源文件；任务开着「复制后删源」的，工具说明要求它事先告诉你。复制队列它能看、失败的能重试；「不跟了」只能在云下载页点。已经复制好的，还能让它事后把网盘上的源文件归档（挪进任务目录下的「归档」，可逆）或删除（要完全档）——复制时去向选的是不动、或者当时没处理成的用得上；动手前会先核对目标里那一份齐了（目录逐层比、文件比大小），不齐的不动。不管有没有复制、只想把网盘上的某部片 / 某个目录收起来（不在库里出现，但先别删）的，用 `drive_archive` 挪进任务目录下的「归档」，本地 strm 跟着删，可逆；它不核对别处有没有副本，正在复制的不动。
- **当面确认**：执行 / 撤销整理、删除类操作之前，支持的客户端会先弹一个确认框，这一步模型插不上手。要客户端用 2026-07-28 版的 MCP 协议、并且声明支持确认框（elicitation）才会弹；用老协议的客户端，确认就在对话里做（工具描述要求它先征得你同意，执行整理还要带上你看过的那一版清单）。
- **令牌只显示一次**，库里只存哈希；用不到了就在设置页撤销，怀疑泄露就「全部撤销」。改密码不会让令牌和已连接的网页客户端失效，改密码页上可以勾「同时撤销」把它们一起收回。
- **每次调用都有记录**：设置页「最近调用」里能看到哪个令牌、从哪个 IP 调了什么、成没成；被挡下的越权调用也记。
- **收藏夹的三个命令**：「收藏纠错」（没认出、认得没把握的，它看目录名和文件名判断是哪一部、去 TMDB 核对，列成表给你看，你同意后改）、「失效找回」（失效分享里有哪些作品，逐部在收藏夹别处、网上找替代，你同意后收下）、「补全剧集」（给个剧名，对比你本地有的季和收藏夹里的，缺的你同意后转存）。类型、国家 / 地区是认出来以后从 TMDB 补的，以前认过的在后台慢慢补上，不用重认。
- **找片入库**：支持 MCP prompts 的客户端里多一个「找片入库」命令（Claude Code 里是 `/mcp__openstrm__find_and_save`），给个片名，它照「确认片名 → 搜资源 → 挑几个候选 → 看分享内容 → 你同意后转存并整理」一步步来，剧集还会问要不要追更。只读令牌走到看分享内容为止，把预填好的转存框链接给你。令牌要有「搜资源 / 收藏 / 转存与云下载」那一组才有这个命令；收藏夹里有的，它会先看这部有哪几个版本、你本地是不是已经有了。
- **「在 OpenStrm 里打开」**：工具结果里会带跳回管理界面的链接，比如预填好的转存框、这次同步的日志页。打开了「这个域名也用来打开管理界面」的默认用公网地址拼；其它情况在设置里填管理界面地址（比如 `http://nas:3000`），不填就不给链接。

**连接**：MCP 地址是 `http://<你的地址>:3000/mcp`，新建令牌后弹框里有各家的配置片段，照着复制：

```bash
# Claude Code
claude mcp add --transport http openstrm http://nas:3000/mcp --header "Authorization: Bearer ostk_…"

# Codex（命令行 / IDE / 桌面端共用配置）
export OPENSTRM_TOKEN=ostk_…
codex mcp add openstrm --url http://nas:3000/mcp --bearer-token-env-var OPENSTRM_TOKEN
```

- **Open WebUI**（0.6.31 起）：管理员设置 → Integrations → External Tool Servers → Add Connection，Type 选 MCP Streamable HTTP，ID 填 `openstrm`，URL 填 MCP 地址，Auth 选 Bearer 填令牌。连接是从 Open WebUI 的容器里发起的：和 OpenStrm 在同一个 compose 网络里就写 `http://openstrm:3000/mcp`。Open WebUI 调用工具前不会问人，令牌只给「只读」或「日常」；想每次先确认，给它设环境变量 `ENABLE_TOOL_PERMISSIONS=true`，再在对话里选「Ask for approval」。
- **其它客户端**（Cherry Studio、Cursor 等）：传输类型选 Streamable HTTP（不要选 SSE），地址填 MCP 地址，请求头加 `Authorization: Bearer ostk_…`。
- Codex 用 `codex exec` 无人值守跑时，需要批准的工具调用会被直接拒掉；要让它能转存、跑同步，把这几个工具的 `approval_mode` 设成 `approve`。执行整理（`organize_apply`）不建议无人值守放行：它该在你看过清单之后再调。

### 网页客户端（claude.ai、ChatGPT）与公网部署

claude.ai、ChatGPT 是从它们自己的服务器连过来的，要一个公网 https 地址，并走 OAuth 授权（不用令牌）。

**已经能从外网用 https 打开 OpenStrm 的（多数人就这一个域名）**，三步：

1. 用外网地址（比如 `https://nas.example.com`）打开设置 →「智能体接入」：打开「开启智能体接入」，「公网地址」点「用当前地址」，保存。它会同时打开「这个域名也用来打开管理界面」和「授权页上允许用管理员密码批准」。然后在「连接自检」点「检查一遍」。在局域网里打开设置的，「公网地址」手动填外网地址，再自己打开这两个开关。
   反代 / Tunnel 一般不用改，两种例外：域名已经套了 Cloudflare Access 的，要按下面的办法给机器对机器的几个路径建 Bypass 应用；开了 Cloudflare 的 Bot Fight Mode / WAF 质询的，要给这几个路径放行（见本节末尾）。不然 claude.ai、ChatGPT 连不进来。
2. 在客户端里添加连接器，地址填 `https://nas.example.com/mcp`：
   - claude.ai：设置 → 连接器（Connectors）→ 添加自定义连接器，点「连接」；
   - ChatGPT：设置里打开开发者模式（Developer mode），到 chatgpt.com/plugins 点「+」，鉴权选 OAuth。ChatGPT 只有网页版能用；Plus 套餐在开发者模式里能不能用会改网盘的工具，OpenAI 的文档说法不一，以实测为准。
3. 客户端弹出 OpenStrm 的授权页：选档位、输入管理界面的登录密码，批准后自动跳回客户端。授权页上的密码批准只对 claude.ai、ChatGPT 和本机、局域网里的客户端开放；别的客户端（比如谁都能动态注册、回调在别的公网域名上的）用配对码批准，免得有人拿假冒的客户端骗你一键批了。

公网地址要用 443 端口（地址里不带端口号）：claude.ai 的服务器只往 443 端口连，带别的端口的地址连不上（官方文档没写，社区多次报告过）。家宽 443 被封的，用 Cloudflare Tunnel 最省事。

放在反代或 Cloudflare Tunnel 后面的，容器要设 `TRUST_PROXY`（取值见下面的环境变量表）；自检里的「来源地址」一项会告诉你设对没有，信任过头（来源能伪造）也查得出来。没设对的后果：登录失败退避会把所有人都算成反代一个地址，别人试错几次，你自己也登不上。两个前提：反代要往 `X-Forwarded-For` 里追加客户端地址（nginx 写 `$proxy_add_x_forwarded_for`，Caddy、Nginx Proxy Manager、cloudflared 默认如此）；OpenStrm 的端口不能绕过反代从公网直接连上——发布端口时绑到局域网地址或 `127.0.0.1`（比如 `192.168.1.10:3000:3000`），或者用防火墙挡住，家宽有公网 IPv6 的尤其要注意——不然别人能自己写来源地址。

在别的设备上批准（比如授权页开在电脑上，人拿着手机）：授权页上有一个配对码，到设置页「待批准」点「批准」，输入配对码和当前密码；在 Telegram 页打开「允许批准网页客户端的连接」后，把配对码发给机器人也行（打开它要输当前密码；之后换了机器人、chat id 或往白名单里加人，它会自动关掉，要用再打开）。要输配对码是因为授权码是发给「拿着授权页」的那个人的，而授权页谁都能打开、也能冒充 claude.ai 发起：输入你眼前授权页上的配对码，批的才一定是你自己这一条。不是你发起的请求直接拒绝（请求多了可以「全部拒绝」）。给的档位不会超过客户端自己要的（claude.ai、ChatGPT 要的是日常三档）；要让它删东西，连上之后在设置页「已连接的客户端」里点「改权限」改成完全（要再输一次登录密码；改完立即生效、不用重连，用完改回日常）。已连接的客户端随时可以断开。

管理界面在公网上，管理员密码要够长、别和别处重复。一小时里密码错得太多时（换着地址试），外面来的每次尝试都会放慢，配了 Telegram 的会收到告警；从局域网直接打开的不受影响。想再加一层（或者域名本来就套着 Cloudflare Access）：整个域名一个 Access 应用（你的登录策略），再给机器对机器的几个路径各建一个 Bypass 应用——`/mcp`、`/oauth/token`、`/oauth/register`、`/oauth/revoke`、`/.well-known/oauth-protected-resource`（及 `/mcp` 结尾的那个）、`/.well-known/oauth-authorization-server`（Access 按最具体的路径匹配）。已经套着 Access 的，这几个路径必须放行，不然 claude.ai、ChatGPT 连不进来（自检会直接说是被 Access 挡住了）。授权页 `/oauth/authorize` 是你自己的浏览器打开的，可以留在 Access 后面，这样别人连授权页都打不开。

客户端怎么认：默认走**动态注册**，OpenStrm 不用往外访问。设置里可以打开「用 CIMD 认客户端」（claude.ai、ChatGPT 都支持，授权页能显示经过核实的域名），但 OpenStrm 要能直接访问 claude.ai、chatgpt.com 去取客户端说明——国内网络一般不行，打开后用「检查一遍」确认取得到。

走 Cloudflare（Tunnel，或者反代前面套了橙云）时，给上面那几个机器对机器的路径加 WAF 跳过规则、关掉质询；免费版的 Bot Fight Mode 跳不过去，开着的话可能把 claude.ai、ChatGPT 的请求挡在挑战页上。

#### 进阶：管理界面不放公网，给智能体单独一个子域名

管理界面只在局域网 / VPN 里用的，可以只把智能体用的几个路径放到公网上：

1. 给智能体单独开一个子域名（比如 `mcp.example.com`）指到 OpenStrm，反代或 Cloudflare Tunnel **只放行**这几个路径：`/mcp`、`/oauth/*`、`/.well-known/oauth-protected-resource`（及 `/mcp` 结尾的那个）、`/.well-known/oauth-authorization-server`。容器加 `TRUST_PROXY=true`。
2. 设置页「公网地址」填 `https://mcp.example.com`，「这个域名也用来打开管理界面」**保持关**：这个域名下 OpenStrm 自己也只放行上面那几个路径，管理界面在它下面打不开。「授权页上允许用管理员密码批准」默认关（公网上不放密码框），批准回到局域网里的设置页输入配对码做。
3. 客户端里的地址填 `https://mcp.example.com/mcp`，其余同上；批准用配对码（见上面「在别的设备上批准」那段）。

**Caddy**：

```caddyfile
mcp.example.com {
    @agent path /mcp /oauth/* /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/mcp /.well-known/oauth-authorization-server
    handle @agent {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        respond 404
    }
}
```

**nginx**（`/mcp` 的响应是流式的，别缓冲）：

```nginx
server {
    server_name mcp.example.com;
    # listen 443 ssl; 证书配置略

    location = /mcp {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location ~ ^/(oauth/(authorize|authorize/status|authorize/password|token|register|revoke)|\.well-known/(oauth-protected-resource(/mcp)?|oauth-authorization-server))$ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / {
        return 404;
    }
}
```

**Cloudflare Tunnel**（cloudflared 可以作为一个容器和 OpenStrm 放在同一个 compose 里，`service` 直接写容器名；在 Zero Trust 面板里建 Public Hostname 时 Path 字段照同样的规则填）：

```yaml
ingress:
  - hostname: mcp.example.com
    path: ^/(mcp|oauth/.*|\.well-known/(oauth-protected-resource(/mcp)?|oauth-authorization-server))$
    service: http://openstrm:3000
  - hostname: mcp.example.com
    service: http_status:404
  - service: http_status:404
```

这个子域名要套 Cloudflare Access 的话，同样按上面的办法给机器对机器的几个路径建 Bypass 应用；不能整个子域名直接罩上：claude.ai、ChatGPT 是从服务器连过来的，过不了 Access 的登录页。

**注意**：

- 同步、转存是后台活儿：工具会先返回，再用 `sync_status` / `job_status` 等结果；每次调用最多等 45 秒。
- 每个令牌平均每分钟 120 次、一下子最多 30 次（MCP 和直接调接口合在一起算），超了回 429。
- 分享里的文件名是别人写的，工具说明里已经提醒模型「只当数据看」；转存、云下载这类改网盘的操作，调用前会先征得你同意（看客户端：Claude Code、Codex 默认会问，Open WebUI 默认不问）。

## 📦 安装 & 使用

### 使用 Docker (推荐)

只是部署的话不用克隆仓库，一个 `docker-compose.yml` 就够了。找个空目录放它，`data`、`config` 两个目录启动时会自动建在旁边：

```bash
mkdir openstrm && cd openstrm
curl -fsSLO https://raw.githubusercontent.com/indown/OpenStrm/main/docker-compose.yml
docker compose up -d
```

机器上连不上 `raw.githubusercontent.com` 的话，用浏览器打开仓库里的 [docker-compose.yml](docker-compose.yml)，内容存成同名文件放进这个目录也一样。

镜像是 `indown/openstrm:latest`，支持 linux/amd64 和 linux/arm64。时区默认 `Asia/Shanghai`；`PUID` / `PGID`、`LOG_LEVEL` 等可选项在文件里以注释写好了，要用就去掉 `#` 再 `docker compose up -d` 一次，各项说明见下方「环境变量」。

启动后打开 `http://<机器 IP>:3000`，接着看下方「第一次用」。

不用 compose 的话：

```bash
docker run -d \
  --name openstrm \
  -p 3000:3000 \
  -p 8091:8091 \
  -e TZ=Asia/Shanghai \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config:/app/config \
  indown/openstrm:latest
```

**端口说明**：
- `3000`: 管理界面和 API（同一个进程）
- `8091`: Emby 302 代理端口（Emby 客户端使用此端口连接）

**目录挂载说明**：
- `./data`: 生成的 `.strm` 文件，以及字幕、nfo 等随片下载的文件。Emby 挂的是同一个目录
- `./config`: 只有一个 `openstrm.db`——账号、设置、任务、执行历史、登录凭据全在里面

日志走标准输出，`docker logs openstrm` 就能看；compose 里已经配了按大小轮转。镜像自带 HEALTHCHECK（`GET /api/health`，不鉴权，返回状态、版本和运行时长），`docker ps` 能看到 healthy 状态。

> **从 v2.0.0 之前升级**：旧版 compose 用的是 `./strmData`。换用新文件前先 `mv strmData data`，否则容器会对着一个空目录，Emby 那边的媒体库也会跟着空掉。
>
> v2 起配置存放在 SQLite，不再有 `config.json`。旧版的 `config.json` 不会被自动导入，需要在界面里重新配置。
>
> v1 的 302 层是 nginx + emby2Alist，那套 `constant.js` 里的自定义配置**不会被自动导入**。`mediaPathMapping` 和 `routeRule` 在设置页「Emby」一节有对应物（路径映射、播放路由规则，按 v2 的形式手动填一遍，见上方「Emby 302 直链」）；`clientSelfAlistRule` 解决的 Infuse 拖进度问题已经内置，不用配；其它规则（虚拟字幕、媒体库过滤、搜索增强、转码均衡等）没有对应物。挂载结构就是一个前缀对一个目录、用主流客户端播放的话什么都不用填。

### 第一次用

1. 打开 `http://<机器 IP>:3000`，用 `admin` / `admin` 登录，按提示改掉密码（见下方「首次登录」）
2. 「账户」页添加网盘账号：115 和夸克填 Cookie，OpenList 填地址和账号密码
3. 「任务」页新建任务：选账户和远程路径（网盘上的目录）；本地路径是 `./data` 下的相对路径；Strm 前缀是写进 strm 的路径开头，填媒体服务器能读到网盘文件的地方——rclone、CloudDrive2 的挂载路径（如 `/mnt/115`），或 OpenList 的 `/d/` 地址。要 302 的话看上方「Emby 302 直链」
4. 跑一次，strm 就生成在 `./data/<本地路径>` 下
5. 媒体服务器的媒体库指向这个目录（按它自己容器里看到的路径填）

### 升级与回滚

升级前先在设置页点「下载备份」，然后：

```bash
docker compose pull
docker compose up -d
```

启动时会自动迁移数据库，不用手动操作。

`latest` 只跟正式版走。想用预发布版（`-rc.N`）或者退回旧版本，就把 compose 里的镜像写成具体版本号，如 `indown/openstrm:v2.9.0`。回滚要连库一起退：新版本可能已经改过库结构，按下方「备份与恢复」换回升级前下载的那份备份。

有没有新版本、改了什么，设置页最上面的「更新」一节能看到，见下方「检查更新」。

### 从源码构建镜像

改了代码想跑自己的版本，在仓库根目录执行：

```bash
docker compose -f docker-compose.build.yml up -d --build
```

### 本地开发

需要 **Node.js 24** 和 **pnpm 9**。仓库是 pnpm workspace，用 npm 装不出正确的依赖树。

```bash
git clone https://github.com/indown/OpenStrm.git
cd OpenStrm

# pnpm 版本由 package.json 的 packageManager 字段锁定，corepack 会自动取对应版本
corepack enable pnpm
pnpm install

# 同时启动 backend(4000) / Emby 代理(8091) / 前端 next dev(3000)
# 生产镜像里没有 Next 服务进程：前端是静态导出，由 backend 在 3000 上一并托管
pnpm dev
```

测试、类型检查和 lint：

```bash
pnpm test        # 后端全部单元/集成测试（node --test），跑在 /tmp/openstrm-test 下的临时库上
pnpm typecheck   # shared / backend / frontend 三个包
pnpm lint

# 只跑一个文件：CONFIG_DIR / DATA_DIR 必须指定，用例会改写设置表、在 DATA_DIR 里建删目录
cd apps/backend
CONFIG_DIR=/tmp/openstrm-test/config DATA_DIR=/tmp/openstrm-test/data pnpm test:file src/services/task/runner.itest.ts
```

代理层还有一套对着真实 Emby 的端到端对照（`scripts/emby-lab.sh up|main|down` 起环境，`pnpm test:e2e` 跑），需要 Docker，用法见 `.claude/plans/302-proxy-migration.md`。

## 🔧 配置说明

### 首次登录

默认账号 `admin` / `admin`。

**首次登录会强制要求修改密码**——在改掉之前，除修改密码本身以外的接口一律返回 403。

密码经 scrypt 哈希后存进 `config/openstrm.db`，不再以明文保存，因此**无法通过编辑文件修改**。忘记密码目前只能删掉 `config/openstrm.db` 重新初始化（账号、设置、任务会一并丢失）。

> 从旧版本升级上来的实例，原先的明文密码仍然可以登录，并在登录成功时自动转成哈希存储，不需要做任何操作。

### 环境变量

全部可选，不设也能正常运行。

| 变量 | 默认 | 说明 |
|---|---|---|
| `TZ` | `UTC` | 定时任务按这个时区解释 cron 表达式。compose 示例里已设为 `Asia/Shanghai`；不设的话 `0 3 * * *` 会在北京时间 11:00 跑 |
| `JWT_SECRET` | 首次启动随机生成并持久化 | 登录令牌的签名密钥。只有在需要轮换密钥、或多个副本共享同一份登录状态时才手动指定；改动会让所有已登录会话立即失效 |
| `LOG_LEVEL` | `info` | 排查「播放没走 302」时设为 `debug` |
| `CONFIG_DIR` / `DATA_DIR` | `/app/config`、`/app/data` | 容器内路径，一般不用改；改了要同步改 `volumes` 的挂载点 |
| `PUID` / `PGID` | 不设，以 root 运行 | 设了就用这个 uid/gid 跑两个进程（NAS 上用 `id` 查自己的）。`config` 目录会自动改归属；之前用 root 生成的 `data` 里的文件请自己 `chown` 一次 |
| `TRUST_PROXY` | 关 | 放在反代 / Cloudflare Tunnel 后面时设。`true`：反代和 OpenStrm 在同一台机器或同一个局域网 / docker 网络里（信任本机和内网来的代理，`X-Forwarded-For` 从右往左取第一个不是它们的地址）；数字：信任最近几跳（比如 CDN → nginx → OpenStrm 填 `2`，前提是源站只能经过 CDN 访问）；也可以直接写代理的地址 / 网段，逗号分隔。前提：反代往 `X-Forwarded-For` 里追加客户端地址，OpenStrm 的端口不能绕过反代从公网直接连上，不然来源能伪造。登录限流、公网上的限流和日志里的客户端 IP 都按它来；设置页「连接自检」的「来源地址」一项会查设得对不对。Emby 代理（8091）也按它取来源：播放路由规则里的「来源」条件、回源给 Emby 的 X-Real-IP 都用这个地址 |
| `FRAME_ANCESTORS` | 只许同源 | 管理界面防点击劫持：默认只许同源页面把它嵌进去（v2.12 起的新行为：之前用 iframe 把 OpenStrm 嵌在导航页、仪表盘里的，升级后要设这个）。写允许嵌入它的地址（空格或逗号分隔，比如 `https://home.example.com`），写 `*` 不限制，只写 `'none'` 谁都不许嵌；写错的项启动日志里有警告、会被跳过 |
| `BACKEND_PORT` / `PROXY_PORT` | `3000` / `8091` | 两个进程的监听端口。改了 `PROXY_PORT` 要同步改 compose 的 `ports` 映射；HEALTHCHECK 跟着 `BACKEND_PORT` 走 |
| `BACKEND_HOST` | `0.0.0.0` | 只想给本机反代用时可设为 `127.0.0.1`（容器里一般不用改） |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | 连不上 Telegram 官方接口时指到自己的反代，如 `https://tg.example.com` |
| `HTTPS_PROXY` / `NO_PROXY` | 不设 | 后端访问外网 https 地址（GitHub、TMDB、Telegram……）走的代理。注意 115 / 夸克的接口和下载也会一起走它，一般不用设；要设的话把不想绕出去的域名写进 `NO_PROXY`，接了 PanSou 的话它的主机名也写进去 |

### 备份与恢复

备份用设置页的「下载备份」（或带登录 token 请求 `GET /api/system/backup`），拿到的是一致的快照。库是 WAL 模式，直接拷 `openstrm.db` 可能拷到一半。

恢复：

```bash
docker compose down
# 备份文件替换库文件；-wal / -shm 是上次运行留下的日志，必须一起删掉，否则会把旧内容合回去
cp openstrm-backup.db config/openstrm.db
rm -f config/openstrm.db-wal config/openstrm.db-shm
docker compose up -d
```

`./data` 里的 strm 可以随时用同步任务重新生成，不需要备份；随片下载的字幕、nfo 想留的话按普通文件备份即可。

### 放在反向代理后面

管理界面（3000）按普通站点反代即可。Emby 代理（8091）多一条要求：Emby 的实时通知走 WebSocket，反代要放行升级请求。Caddy 只需一行：

```caddyfile
emby.example.com {
    reverse_proxy 127.0.0.1:8091
}
```

nginx：

```nginx
location / {
    proxy_pass http://127.0.0.1:8091;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Emby 客户端里填反代后的地址；302 给出的是 115 直链，不经过反代。反代后面给容器加 `TRUST_PROXY=true`：管理界面和 Emby 代理（8091）都按它取来源地址，播放路由规则里的「来源」条件、回源给 Emby 的客户端 IP 都靠它。

### 设置页

按节排，右边有目录可以跳；改了没保存时底部一直挂着保存条，⌘S / Ctrl+S 也能保存。

- **更新**：当前 / 最新版本、更新说明、立即检查、自动检查开关，见下方「检查更新」
- **基础设置**：User-Agent（请求 115 接口、下载字幕 / nfo 这类随片文件时带的）；Strm 文件扩展名（这些生成 strm）和下载文件扩展名（这些直接下到本地），都会自动转小写；额外的媒体挂载路径（开了 302 的任务的前缀会自动算进去，这里只填任务之外也想让代理接管的前缀）
- **网盘限流**：每个网盘账号各算各的，保存后立即生效，不用重启。每秒请求数（默认 2）管这个账号的所有接口请求——列目录、取直链、转存、整理、监控都算，请求匀速发出去，可以填小数，0.5 就是两秒一个；接口并发数（默认 2）；文件下载并发数（默认 5），下载不占每秒请求数。被网盘风控过就把每秒请求数调小
- **Emby**：地址和 API Key——同步后通知 Emby 刷新媒体库、302 代理、入库通知都用它；匿名 302 开关见下；路径映射和播放路由规则见上方「Emby 302 直链」
- **TMDB**：API 读访问令牌和默认语言（不填是 `zh-CN`）。整理靠它识别影视；strm 管理页的海报墙在目录里没有现成图片时，也用它补海报
- **资源搜索**：PanSou 的地址、用户名和密码（它开了登录才填）、自动检测链接是否有效、屏蔽词，「检查连接」用表单里还没保存的值试，见上方「资源搜索」
- **复制到 OpenList**：见上方「115 云下载」
- **整理与命名**：见上方「整理与规范化命名」
- **智能体接入**：开关、公网地址（「用当前地址」、这个域名也用来打开管理界面、授权页上用密码批准、CIMD）、管理界面地址、令牌、网页客户端（待批准、已连接、预注册客户端、连接自检）和最近调用，见上方「智能体接入（MCP）」；令牌和网页客户端的操作立即生效，不走保存条

最下面是「下载备份」。

### 检查更新

默认**不联网**：装上之后不会主动发任何外网请求。设置页「更新」一节：

- 「立即检查」随时能按，5 分钟内只查一次
- 打开「自动检查更新」后，启动 30 秒后查一次，之后每天一次
- 查的是 GitHub 的发布接口，只发一个匿名 GET，不带账号、路径和任何统计
- 跑正式版的只跟正式版比；跑 rc 的连 rc 一起比，也可以用「包含预发布版本」自己定
- 有新版本时侧栏版本号旁边亮一个小圆点；Telegram 的「新版本」通知默认关，同一个版本只发一次

国内连不上 GitHub 是常态，页面上会如实显示检查失败，不影响其它功能。

### 匿名 302 开关

`emby.allowAnonymousRedirect`，默认 **关闭**，在设置页的 Emby 区块里有开关；下面的命令行方式留给没有界面的场景。

关闭时，不携带任何 Emby 凭据（query 和请求头里都没有令牌）的请求不会被解析成 115 直链，而是原样回源交给 Emby 自己裁决。打开则恢复旧行为——用服务端配置的管理员 API Key 去解析，这意味着**任何能访问 8091 端口的人，报一个条目 id 就能拿到你的媒体直链**，无需登录 Emby。

绝大多数播放器都会带令牌，不需要打开。只有确认播放器一个令牌都不发时才考虑。命令行方式：

```bash
docker exec -w /app/backend openstrm node -e '
const D = require("better-sqlite3");
const db = new D("/app/config/openstrm.db");
db.pragma("busy_timeout = 5000");
const emby = JSON.parse(db.prepare("select value from settings where key = ?").get("app.emby").value);
emby.allowAnonymousRedirect = true;
db.prepare("update settings set value = ? where key = ?").run(JSON.stringify(emby), "app.emby");
console.log("已设置:", emby);
'
```

配置是每个请求现读的，改完立即生效，不用重启。

### 确认 302 是否生效

```bash
docker logs -f openstrm 2>&1 | grep -E "直链|直连|回源|凭据"
```

要看到**两行**才算真的走了直连：

```
{"itemId":"72340","msg":"PlaybackInfo 已改写为直连"}
{"itemId":"72340","account":"主号","ua":"…","msg":"302 到 115 直链"}
```

只有第一行说明客户端没走到重定向，字节仍在经由本服务中转。最硬的判据是播放时看 `docker stats`——真走了 302，容器网络流量应该基本不动。

## 📄 许可证

本项目采用 [MIT License](LICENSE) 许可证。

界面自带的等宽字体不在 MIT 的范围内：`apps/frontend/public/fonts/` 下的 `jetbrains-mono-latin-*.woff2` 是 JetBrains Mono，按 SIL Open Font License 1.1 分发，许可证原文和字体放在一起（[OFL.txt](apps/frontend/public/fonts/OFL.txt)）。

## 💬 交流群组

欢迎加入我们的 Telegram 群组进行交流讨论：

[![Telegram Group](https://img.shields.io/badge/Telegram-OpenStrm%20Group-blue?style=for-the-badge&logo=telegram)](https://t.me/OpenStrmGroup)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request 来改进这个项目。

## ⚠️ 免责声明

本项目仅供学习和研究使用。请确保你遵守相关的法律法规和服务条款。
