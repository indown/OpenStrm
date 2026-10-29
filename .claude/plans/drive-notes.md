# 网盘与 Emby 的已知坑

真机上踩到的、代码里看不出来的事实。按网盘分，每条带日期。踩到新坑追加到这里，不另起文件。

## 115

### cookie 和登录端绑定（2026-10-16）

- cookie 里 `UID=` 形如 `用户id_A1_时间戳`，中段标识登录端：A1 = 网页 / 桌面浏览器，D1 = iOS App，F1 = Android，I1 = TV，R1 / R2 = 微信 / 支付宝小程序。
- 浏览目录走 `webapi.115.com`，网页 cookie 能用；运行任务的导出目录树和取直链走 `proapi.115.com/android/2.0/...`，网页 cookie 会回 `{"state":false,"error":"请重新登录","errno":99}`。症状就是「添加任务能看到目录，运行任务报请重新登录」。
- 判断：看用户 cookie 的 UID 中段是不是 A1。解决：用 App 端扫码拿 cookie，选不常用的端，常用端会被顶下线。
- 要兼容网页 cookie 的话：导出改 `webapi.115.com/files/export_dir`，直链改 `proapi.115.com/app/chrome/downurl`（后者 2024 年底被风控过）。

### 导出目录树的根从父目录开始（2026-09-08）

- 导出 `tv/<剧>` 时树的第一行是 `tv`；导出 `tv/<剧>/Season 1` 时第一行是 `<剧>`；只有导出一级目录时第一行才是「根目录」。
- 处理导出树要按目标目录的路径段去树里定位（后缀匹配），不能盲目剥一层，否则分享转存、追更整目录会生成多一层的 strm。
- 导出会在网盘建一个临时 txt 再删掉，「只读」探测也算动了一下网盘。

### CDN 按文件限并发连接（2026-10-22）

- 同一文件上挂着一两个没读完的连接时，再来的请求一律 403：同一条直链、新取的直链、换 UA 取的直链都一样；同账号的另一个文件照常 206。按文件计，不按链接、不按账号。
- 连接全关掉后还要约 2 分钟才恢复（0 / 10 / 30 / 60 秒仍 403，120 秒 206）。
- 读一段就关、换偏移再连（拖动）不累积。直链 `t=` 约三天半过期；UA 绑定照旧。
- 302 模式下客户端直连 CDN，代理关不掉客户端留下的连接，清直链缓存、重新取链都没用。「某播放器退出再进 403、等两分钟就好」先怀疑客户端没关连接；让用户退出后立刻播同剧另一集就能验证。现成绕法：代理的播放路由规则按 UA 把那个播放器设成交给 Emby。
- 实验时连接别挂超过几十秒，测完放掉。

### 新建目录要等几分钟 `files/getid` 才认（2026-10-28）

经 OpenList 在 115 根下新建目录、传进文件后，按名字列目录（`resolvePath` → 列根目录）马上能看到，但按路径查 id 的 `files/getid` 要过 5～7 分钟才不再回 0。全量同步的 `listSubtree` 走的是 getid，所以刚建的任务目录同步会报「远端目录树里找不到源目录」，隔几分钟再跑就好；归档、复制、清理这些走 `resolvePath` 的不受影响。真机：17:03 建目录，17:04～17:09 每 30 秒重试都失败，17:09:58 成功。

## 夸克

### 目录指纹（2026-10-14）

| 操作 | 父目录 `updated_at` | 父目录 `include_items` |
|---|---|---|
| 新建 / 秒传进来 / 移入 | 刷新 | +1 |
| 原地改名 | 刷新 | 不变 |
| 移出 | 不变 | -1 |
| 删除 | 不变 | -1 |
| 孙辈变化 | 不变 | 不变 |

- 父目录刷新后约 5.5 秒内的变化不再刷新它；`include_items` 不受节流。监控的指纹 = `updated_at` + `include_items`，刚因变化列过的目录下一轮再列一次兜住节流。
- `update_view_at` / `operated_at` 是访问时间（取直链、播放就变），不能当变化信号。
- `POST /file/info/path_list` 一次最多 50 个路径，只回存在的目录（文件路径、大小写不对都直接不回）。
- 同一请求第一次发常要 2～7 秒，新进程的第一个请求可能卡满 30 秒；实验脚本开头先预热（列一次根目录、短超时、重试几次），计时别把它当限流差别。
- 造测试文件不碰原件：下载一个小文件算 md5 / sha1，`file/upload/pre` + `file/update/hash` 秒传。
- 点开头的目录别当「隐藏目录」用：2026-09-16 列目录时它不出现，2026-10-14 又出现了，行为不稳定。

### 分享与追更接口（2026-09-09）

- Cookie 模式 host `drive-pc.quark.cn`，都带 `?pr=ucpro&fr=pc`。分享转存三步（token → detail 翻页 → save，再轮询 task）在 `services/quark/share.ts`，改字段先看那里。
- `share/sharepage/detail` 回的 `share_fid_token` 跟着 `stoken` 一起过期，缓存要一起失效。
- 服务端追更：`share/inc_update_list` 带 `{pwd_id, stoken, page, page_size}`，403 code 41040 = 分享没有更新、41043 = 没转存过；自己转存过且没新增回 200 空列表。`share/update_list` 缺一个叫 `shareReadStaues` 的参数，试了十几种拼法都不认，先放弃。
- 没有任何操作日志 / 事件流接口，网盘监控只能定时对比。
- 没有整树导出，路径转 id 只有 `path_list`，大库同步靠逐目录翻页，cron 别设太密。

### 302 的路（2026-09-16）

- Cookie 模式的直链取文件必须带 Cookie + Referer + 同一 UA，所以原片不能 302，只能代理中转；转码流（`file/v2/play/project`）可以 302 但画质有损。
- TV 端接口的下载链接不带请求头，是唯一可能原片 302 的路，但要做扫码登录；未验证。开放平台 OAuth 那条路本地刷不了 token，不要选。

## OpenList

- 在 OpenList 之外建 / 改名的目录要先对父目录 `fs/list` 带 `refresh: true`，不然子目录「object not found」、`fs/put` 报「该目录名称已存在」。
- 容器 v4.1 之后不是 root 跑：`docker run … -e PUID=0 -e PGID=0`，bind 进去的 data / media 目录 `chmod 777`，不然起来就退出。
- `/d/` 直链免签名要把 `sign_all` 设成 false；guest 列目录仍 401，Emby 只需要 `/d/`。
- 上传测试文件 `PUT /api/fs/put`（`File-Path` 头要 URL 编码、`As-Task: false`）；删实验目录 `POST /api/fs/remove {dir, names}`（115 进回收站）。
- 容器的库里存着挂进去的网盘 cookie，用完 `docker rm -f` 连数据目录一起删。

## Emby 与播放

- `scripts/emby-lab.sh up|main|down` 起一次性 Emby 环境；本机常跑 8096 的话用 `EMBY_PORT=8097`。真 Emby 的响应形状（`MediaSource.Id` 的 `mediasource_` 前缀、strm 条目的 Container、PlaybackInfo 默认给 TranscodingUrl）假 Emby 验不出来。
- 用浏览器验播放前先查 `document.visibilityState`：后台 / 隐藏标签页里 Chrome 推迟加载媒体元素，播放器转圈、代理日志里没有流请求，不是代理的问题。hidden 时改用页面里 `fetch(url, {redirect: "manual"})` 看是否 302，再 `curl` 带浏览器 UA + Referer + `Sec-Fetch-Dest: video` 取直链。
- PlaybackInfo 要带 DeviceProfile 才能看出 `SupportsDirectPlay` / `DirectStreamUrl` 指向哪。

## 实验环境的通用做法

- 配置库只读拷贝：`sqlite3 "file:config/openstrm.db?mode=ro&immutable=1" ".backup <lab>/openstrm.db"`。
- 造超时：真网盘上等不来超时，可以给 lab 后端 `tsx --import` 一个预加载，往 axios 加拦截器按规则注入 `ECONNABORTED`，分「请求不发出去」和「请求照发但回话丢掉」两种（后者测「其实做成了」）。界面列目录会先把注入用掉；115 全量同步的导出树会调删除接口删临时文件，注入删除时别同时跑同步。
- 探测脚本错误只打 `name / code / message`；整个 axios 错误对象里有请求头，请求头里有 cookie。
- 磁盘：Docker 里删掉的文件要容器退了才释放；实验结束 `docker rm -f`，必要时 `docker system df` 看构建缓存。
- 只看界面、不碰真网盘：给 scratch 后端 `node --import tsx --import <预加载>` 一个预加载，里面 `setDriveProviderFactory` 把账号接到 `src/test/fake-drive.ts` 的 FakeDrive 上（树里预置好目录和文件），账号 cookie 随便填；同步、归档、清理、监控都能在假网盘上走（2026-10-28 清理归档的冒烟就是这么做的）。
