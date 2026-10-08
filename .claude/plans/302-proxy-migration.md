# 用 TS 重建 302 代理层 —— 状态记录

> 原计划已执行完毕并超出原范围。本文档现在是**状态记录**，不是待办计划。
> 最后更新：2026-10-07（P0 两条规则 + /System/Info/Public 已做，见文末）

## Context

V2 重构删掉了 nginx/njs（`81cb062`），但没有把 nginx 干的活接过来：

- `routes/proxy/index.ts` 只注册了 catch-all，:8091 是纯透传，播放全流量过 Node
- `services/proxy/` 那 3890 行 njs 从未被任何文件 import，而且 import 即崩（`njs` 全局未定义、`r` 对象没 shim）
- UI 上的 302 开关空转：只往 `settings.mediaMountPath` 写值，而这个值只有死代码读

**一处需要更正的判断**：最初我认为"这条回调链路一次都没跑通过"。**这是错的**——main 的 `docker-entrypoint.sh` 在启动时用 `sed` 把生成的 internalToken 注入 `constant-mount.js`，且 main 上后端确实监听 8000，所以 **302 在 main 上是通的**。是 v2 重写 entrypoint 时丢了这步、后端又挪到 4000 才断的。

---

## 已完成

三个提交，都在 `v2` 分支：

| 提交 | 内容 |
|---|---|
| `86a1352` | 用 TS 重建 302 层，删除 3890 行未接线的 njs，拆出独立代理进程 |
| `9a51382` | 修 A/B 对照发现的 11 项回归 |
| `3486f94` | 补 `/Sync/JobItems/*/File` 路由；直链缓存跨进程失效 |

### 交付物

```
services/resolve/direct-link.ts   路径映射 + 115 直链解析（/api/fs/get 复用同一份）
services/emby/api.ts              条目查询（/Items 与 /Sync/JobItems 两种）
services/settings-safe.ts         代理侧容错读配置，库不可用时真降级
services/config-revision.ts       配置指纹，让直链缓存跨进程失效
routes/proxy/redirect.ts          302 核心 + LRU 缓存
routes/proxy/playback-info.ts     标直连、关转码、改写 DirectStreamUrl
routes/proxy/system-info.ts       端口改写 + web 播放器 crossorigin 补丁
routes/proxy/upstream.ts          转发头、逐跳头剥离、响应中继
proxy.ts                          独立进程入口
scripts/emby-lab.sh               一键重建验证环境（up / main / down）
```

### 验证方式

**关键做法：拿真 Emby 和 main 的 nginx 做 A/B。** 官方 `nginx:1.27.1` 镜像自带 `ngx_http_js_module.so`，所以 main 的 emby2Alist 栈能原样跑起来。同一个 Emby（`amilys/embyserver`，amd64 模拟，中文名 strm 库）前面分别挂两套代理，通过**同一个 `/api/fs/get` 桩**解析直链，逐项比对。

首轮 12 项对照 **9 项有差异，全是 v2 的缺陷**。修完后：

- `proxy.e2e.ts` 20 项通过（含 7 项与 main 的直接对照）
- `proxy.itest.ts` 26 项、`direct-link.test.ts` 18 项
- `pnpm test` 全套通过，`pnpm typecheck` 干净

### A/B 查出的问题（都已修）

最严重的是我自己引入的：`safeLocation` 用 `encodeURI` 兜底，而它把 `%` 转成 `%25`、**不幂等**，115 直链本来就是转义过的 → 中文文件名的条目 302 出去全是坏地址。**而当时的测试用未转义的桩数据算期望值，把 bug 断言成了正确行为。**

其余：PlaybackInfo 对空 body/表单 content-type 返回 400/415；`Keep-Alive`/`Expect` 头让所有路径 500（v2 遗留，非本次引入，但相对 main 是回归）；`SupportsTranscoding` 没关；`DirectStreamUrl` 用了 `mediasource_11` 而非条目 id；拦截路径丢响应头（304 导致给浏览器未打补丁的播放器）；`swapPorts` 子串替换污染主机名；超时没覆盖 body 读取；任务反查非最长匹配；账号兜底串盘；`X-Real-IP` 可伪造；降级路径不降级。

---

## 迁移完整度：**未完整迁移**

### 拦截点 7/17

已覆盖：`basehtmlplayer.js`、`PlaybackInfo`、`system/info`、`videos/(stream|original)`、`Audio/(universal|stream)`、`Items/Download`、`Sync/JobItems/File`

未覆盖：虚拟字幕（`vSubtitlesAdepter`）、媒体库过滤（`itemsFilter` ×2）、搜索增强（`searchHandle`）、`Users/Items/Latest` 过滤、直播直连（`directLive` ×2）、转码均衡（`transcodeBalance`）、`ActiveEncodings`、`Sessions/Playing`

### 配置面 3/38

v2 只读 `emby.url`、`emby.apiKey`、`mediaMountPath`。其余 35 项无对应物。另有三项被写死而非可配：`fallbackUseOriginal` 恒 true、路由缓存恒开 15 分钟、`redirectCheckEnable` 未实现。

### nginx 层能力

`proxy_cache`（图片 10G / 字幕 1G）、`gzip`、`client_max_body_size 20M`、`Referrer-Policy`、TLS 均未迁移。

---

## 剩余工作（按优先级）

### P0 — 影响老用户升级

规则引擎的骨架，默认配置下不影响，但改过 emby2Alist 配置的用户升级后设置会被**静默忽略**，表现为"某些客户端/某些盘突然不 302 了"，日志只有一句 `not-mounted`：

1. ~~**`mediaPathMapping`** — 路径映射规则。挂载结构不是"一个前缀直接对应盘内路径"的用户，v2 直接失配~~ **已做（2026-10-07）**：`emby.pathMappings`，设置页「Emby」一节
2. ~~**`routeRule`** — 按客户端/路径决定走 302 还是中转~~ **已做（2026-10-07）**：`emby.routeRules`，动作只有 redirect / relay

### P1 — 具体场景缺失

3. ~~**`clientSelfAlistRule`** — main 注释明确写着 Infuse 拖进度条依赖它~~ **已做（2026-08-28）**：真机复现是 Infuse 拖动时到代理的 UA 和到 CDN 的 UA 不一致，而 115 直链和换链 UA 严格绑定（实测：A 换的链接用 B 取直接 403，并发/复用都没问题），拿着缓存直链反复 403 把那个文件打到临时限流。`redirect.ts` 对 UA 含 Infuse 的请求先 302 回代理自己同一路径（`_hop=2`，令牌补进 query），第二跳按跟随时的 UA 换链——和 v1 转到 Alist `/d/` 再跳一次是同一个原理，不需要 Alist。
4. **`redirectCheckEnable`** — 回源前校验直链有效性（对应删掉的 `link-validator.js`）
5. **`itemHiddenRule`** 媒体库过滤 / **`searchConfig`** 搜索增强 —— 与 302 正交的独立功能

### P2 — 已知但影响有限

6. ~~`/System/Info/Public` 未拦截，登录前仍暴露 Emby 真实地址（**main 同样如此，不算回归**）~~ **已做（2026-10-07）**
7. 代理进程未启用 gzip
8. 图片/字幕磁盘缓存未迁移（Emby 自身有图片缓存，影响待观察）
9. 直播电视 `directLive` 未移植（115 strm 库不产生这类条目，透传给 Emby 仍能播）

---

## 复现验证环境

```bash
./scripts/emby-lab.sh up      # Emby + strm 库 + 直链桩，打印环境变量
./scripts/emby-lab.sh main    # 额外起 main 的 nginx/njs 栈做 A/B
. /tmp/openstrm-emby-lab/env.sh
cd apps/backend && CONFIG_DIR=/tmp/x/config DATA_DIR=/tmp/x/data pnpm test:e2e
./scripts/emby-lab.sh down
```

注意：两个代理测试**不指定 `CONFIG_DIR` 会拒绝运行**——它们写 settings 表，在真实库上跑会把 Emby 地址改成死端口。

## 未做的真机验证

115 那一段全部用桩替代（`setLinkResolver` / `/api/fs/get` 桩）。真账号下仍需人工确认：真直链 302 能否播放、拖进度条的缓存命中、web 端 CORS。

---

## 2026-10-07：补 P0 两条规则 + `/System/Info/Public`

上面「剩余工作」里 P0 的 `mediaPathMapping` / `routeRule` 和 P2 的 `/System/Info/Public` 这次一起做；
直链校验（每次换链多一跳 CDN 请求、拖慢起播，而且 115 直链和 UA 绑定、校验请求本身就可能把文件打到限流）
和媒体库过滤 / 搜索增强（与 302 无关，Emby 自己有媒体库权限）**不做**。

### 设计

v1 的两条规则都是 njs 里的通用表达式引擎（任意 `r.*` 变量 + 比较符 + 分组），v2 不照搬：
按这个产品的实际用法收成两张表，放在 `settings.emby` 下面，设置页「Emby」一节编辑。

**路径映射 `emby.pathMappings`**：`{ from, account, to? }`，Emby 看到的路径前缀 → 网盘账号 + 网盘目录。

- 任务推得出来的映射（开了 302 的任务的 `strmPrefix` + `originPath`）照旧自动算，不用填；这张表是给任务推不出来的：
  别的工具生成的 strm、挂载结构不是「一个前缀对一个目录」的。
- 解析顺序：先查手填映射（最长前缀、目录边界），命中就只认它指向的账号，账号不在 / 不是 115 报 `no-account` 回源，
  不落到别的账号；没命中再走原来的任务反查。
- `from` 同时算进挂载集合（`effectiveMountPaths`），PlaybackInfo 才会把这些源标成可直连。
- 校验：`from` 以 `/` 或 `http(s)://` 开头、不重复，最多 100 条；账号存不存在只在界面上提示，
  不在保存时拒——不然删了一个账号，无关的设置都保存不了。

**路由规则 `emby.routeRules`**：`{ action, userAgent?, client?, deviceName?, deviceId?, path?, remote?, note? }`。

- 动作只有两个：`redirect`（302，默认）和 `relay`（PlaybackInfo 原样、流请求回源，Emby 自己中转或转码）。
  v1 的 `proxy` / `transcode` 在 v2 里是同一回事（都是「交给 Emby」），`block*` 不做。
- 条件之间是与；一个条件都不填 = 全部命中（等于 v1 的 `redirectConfig.enable=false`）；从上到下第一条命中的生效。
  `userAgent` / `client` / `deviceName` 是不分大小写的包含，`deviceId` 是相等，`path` 按目录边界的前缀，
  `remote` 按 `lib/ip.ts` 的 `isInternalAddress` 分内外网。
- 生效点两处：`redirect.ts` 在换链**之前**裁决（命中 relay 的连 Infuse 第二跳都不走）；`playback-info.ts` 逐个媒体源裁决，
  relay 的源不改写。看路径的规则要先查条目，查询结果进一个 15 分钟的 LRU（Infuse 每个分片都来一次）。
- 代理进程也开始认 `TRUST_PROXY`（和 API 进程同一个 `trustProxyOption`），`remote` 在反代后面才有意义；
  顺手把回源的 `X-Forwarded-For` 改成追加真实对端、`X-Real-IP` 用 `request.ip`。
- 两张表都进 `configRevision` 的指纹，改完规则旧直链缓存立刻失效。

**`/System/Info/Public`**：和 `/System/Info` 同一个 handler。Public 版没有端口字段，Emby 自己的端口按配置的上游地址推。

### 进度

见文件末尾「实施记录」。

### 实施记录（2026-10-07）

**改动**

| 文件 | 内容 |
|---|---|
| `packages/shared/src/types/settings.ts` | `ProxyPathMapping` / `ProxyRouteRule` / `ProxyRouteAction`，挂在 `emby.pathMappings` / `emby.routeRules` |
| `services/resolve/direct-link.ts` | `matchPathMapping`（最长前缀、目录边界、没填完的不算）、`joinPanPath`；`effectiveMountPaths` 把映射的 from 算进挂载集合；`resolveEmbyPath` 先查手填映射 |
| `services/resolve/route-rules.ts`（新） | `decideRoute` / `clientContext` / `rulesNeedPath` / `pathStartsWith`，纯函数 |
| `routes/proxy/redirect.ts` | 凭据闸门之后、第二跳之前裁决路由；看路径的规则先查条目，查询结果进 `lookupCache`（15 分钟）；缓存 key 加了 `item` / `sync` 名字空间（同步任务项 id 和条目 id 以前会串） |
| `routes/proxy/playback-info.ts` | `rewritePlaybackInfo` 多一个 `relay(path)` 回调，relay 的媒体源原样不动 |
| `routes/proxy/system-info.ts` | 拦 `/System/Info/Public`（四种大小写 × 两种前缀）；Public 版没端口字段，Emby 端口按上游地址推 |
| `routes/proxy/upstream.ts` | `X-Forwarded-For` 追加真实对端（socket.remoteAddress），`X-Real-IP` 用 `request.ip` |
| `proxy.ts` | `trustProxy: trustProxyOption(process.env.TRUST_PROXY)`，和 API 进程同一套 |
| `services/config-revision.ts` | 两张表进指纹 |
| `schemas/entities.ts` | 校验：from 以 `/` 或 `http(s)://` 开头、不重复、各最多 100 条；action 只认两个值；remote 只认 lan / wan |
| 前端 `settings/components/EmbyProxyRules.tsx`（新） | `PathMappingsEditor` / `RouteRulesEditor`，账号下拉只列 115、不存在的标红；规则能上下移 |
| 前端 `settings/page.tsx` | 表单 schema（行里的错误挂整张表上）、`fromSettings` / `toSettings`（空条件不带给后端）、Emby 一节渲染两块 |
| README | 「Emby 302 直链」加两张表的说明、升级提示改口、设置页 Emby 一行、反代 / TRUST_PROXY 两处 |

**测试**：`direct-link.test.ts` +7、`route-rules.test.ts`（新）9 条、`proxy.itest.ts` +8（按 UA / 按路径 + 查询缓存 / Infuse 命中 relay 不走第二跳 /
内外网 / 条件全空 / 映射进挂载集合 / 改规则缓存失效 / Public 换端口）。后端全量 1525 条全过；`pnpm typecheck`、两端 `lint` 干净。

**浏览器冒烟**（scratch 库起 4100 + dev 3223，没碰 config 库）：两块都渲染；加 / 删行、保存条计数正常；只填前缀不选账号 → 保存被拦、
表下红字「第 1 条路径映射：Emby 路径前缀和账号都要填」；填一条规则（relay + UA Infuse + 路径 + 外网 + 备注）保存成功，
`GET /api/settings` 回的就是这几个字段、空条件没带；用接口塞一条指向不存在账号的映射，刷新后下拉显示「主号（已不存在）」标红 + 提示。
后端对重复前缀 / 不以 `/` 开头 / `action: block` 都回 400，文案清楚。

**真机验证（2026-10-07 下午）**：`scripts/emby-lab.sh up`（Emby 4.10.1 容器，端口 8097）+ 代理进程 8092 读**配置库拷贝**（真 115 账号、
真任务，`TRUST_PROXY=true`）+ 本机 python http 服务当「OpenList」。夹具是三个 strm：真片（任务前缀 + 115 上真实存在的电影）、
映射测试（同一文件、前缀换成 `/mnt/other`）、网络片（http 地址指向本机的 ffmpeg 小片）。全部通过：

| 场景 | 结果 |
|---|---|
| 任务推出来的映射 | 302 到 115 CDN，同 UA Range 0-1023 回 206，总长 7.6 GB；本地文件 200 不 302 |
| 路径映射 `/mnt/other → 115:/` | 映射前 not-mounted 回源（Emby 404，容器里没这个路径）、PlaybackInfo 原样；映射后 302 + 206、PlaybackInfo 改写 |
| 规则 按 UA relay | RelayBox 回源 + PlaybackInfo 原样（Transcoding=true、带 TranscodingUrl）；Safari 照常 302 + 改写 |
| 规则 按路径 relay | `/mnt/other` 条目回源、任务条目 302 |
| 规则 按来源 wan relay | 本机 302；`X-Forwarded-For: 203.0.113.9` 回源；XFF 内网地址 302 |
| Infuse 两跳 | 第一跳 302 回代理自己（query 带 api_key / Static / _hop），第二跳 302 到 CDN，Infuse UA Range 回 206；规则 client=Infuse 后第一跳直接回源 |
| http 前缀换不到直链 | PlaybackInfo 只标 DirectStream；stream 回源，Emby 按 URL 拉流，拿到的字节 md5 和原片一致 |
| `/System/Info/Public` | 4.10 的 Public 没有地址字段（`LocalAddresses: []`），原样透传；`/System/Info` 端口 8096 → 8092 |
| Emby Web（Chrome 真客户端） | 登录、点播放：PlaybackInfo 被改写、页面 fetch 流地址拿到 302；加规则 client=Emby Web → 它的 PlaybackInfo 变回原样、流请求回源，另一个客户端身份不受影响 |

**没验到的**：Emby Web 真正起播——浏览器自动化那个标签页 `visibilityState=hidden`，Chrome 对后台标签页推迟加载 `<video>`，
播放器一直转圈但代理根本没收到流请求（页面里 `fetch` 同一个地址立刻拿到 302，CDN 对带 Referer / Sec-Fetch 的请求也回 206），
是环境不是代码；Infuse 真机还是只有用户的设备能验。

**发布**：功能合成一个提交 958fa66，`chore(release): v2.16.0-rc.1` = d856687，tag 已推（2026-10-07，main 未动）。Release 四作业与 CI@v2 全绿，GitHub Release 是 prerelease，Docker Hub rc 镜像 b470196f490c（amd64 / arm64），latest 仍是 v2.15.0 的 b06e1e4dba65。
