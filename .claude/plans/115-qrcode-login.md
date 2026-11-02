# 115 扫码登录（网页版 cookie 跑不了任务）

## 起因

- 2026-10-16 用户反馈「添加任务能看到 115 目录，运行任务报读取网盘目录失败 请重新登录」。查明是 115 的 cookie 和登录端绑定（`drive-notes.md` 115 一节）：浏览目录走 `webapi.115.com`，网页 cookie 能用；运行任务发起导出目录树走 `proapi.115.com/android/2.0/ufile/export_dir`（`cloud-115/client.ts` 的 `fsExportDir`），取直链走 `android/2.0/ufile/download`（`getDownloadUrlWeb`），网页 cookie（`UID=` 中段 A1）打这两个接口回 `{"state":false,"error":"请重新登录","errno":99}`。
- README 只写「115 填 Cookie」，账户页也不校验 UID 中段；作者本机的 cookie 是 iOS 端（D1），所以自己从没撞上。
- 2026-11-02 定下做扫码登录：用户在账户页选一个登录端、拿 115 手机 App 扫一下，拿到的 cookie 天然就是 App 端的；不走「改接口兼容网页 cookie」那条路（原因见「不做」）。

## 方案

### 115 的扫码流程

接口来自 p115client（`login_qrcode_token` / `login_qrcode_scan_status` / `login_qrcode_scan_result` / `login_qrcode`）和 115driver（`QRCodeStart` / `QRCodeStatus` / `QRCodeLoginWithApp`），2026-11-02 对照过两边源码，真机前没验过：

| 步骤 | 请求 | 回来的东西 |
|---|---|---|
| 1 拿二维码 | `GET https://qrcodeapi.115.com/api/1.0/{app}/1.0/token/` | `data: { uid, time, sign, qrcode }`，`qrcode` 是二维码内容 |
| 2 取图 | `GET https://qrcodeapi.115.com/api/1.0/{app}/1.0/qrcode?uid=<uid>` | PNG |
| 3 查状态 | `GET https://qrcodeapi.115.com/get/status/?uid=&time=&sign=&_=<毫秒>` | `data.status`：0 等扫、1 已扫、2 已确认、-1 过期、-2 手机上取消 |
| 4 换 cookie | `POST https://passportapi.115.com/app/1.0/{app}/1.0/login/qrcode/`，表单 `app=<app>&account=<uid>` | `data.cookie: { UID, CID, SEID, KID }`，另有 `user_id` / `user_name` |

- 115driver 第 1 步固定用 `web`、第 4 步才带选的端；p115client 两步都带 `{app}`。先按 p115client 的对称写法，真机上第 1 步不认非 web 的端就改成固定 `web`。
- 第 4 步 p115client 的文档写的是 qrcodeapi 这个主机，它的登录主机列表里 qrcodeapi / passportapi 都有；115driver 用 passportapi。先用 passportapi，不行换另一个。
- 第 3 步 115 可能把请求挂住一阵再回（网页端就是这么轮询的），后端这一步超时用 `DEFAULT_TIMEOUT_MS`（30 秒）。
- p115client 提醒：结果接口回「IP登录异常」时封到第二天零点。真机别反复试，一次测几个场景就够。
- cookie 拼法：`UID=…; CID=…; SEID=…; KID=…`（KID 可能没有，没有就不写），和用户手填的一样交给 `request115`。

### 登录端

115 每个登录端同时只能有一个会话，再登一次就把前一个顶下线。UID 中段就是登录端的标识（p115client `const.py` 的 `APP_TO_SSOENT`）：

| app | UID 中段 | 界面文案 |
|---|---|---|
| alipaymini | R2 | 支付宝小程序（默认） |
| wechatmini | R1 | 微信小程序 |
| tv | I1 | 电视端 |
| android | F1 | 安卓 App |
| ios | D1 | iOS App |
| web | A1 | 不提供：就是这次要解决的那种 cookie |
| windows / mac / linux | P1 / P2 / P3 | 不提供：115driver 标了 disabled，drive-notes 也记过已不能用 |

- 默认支付宝小程序。界面上要说清楚「每个端同时只能登一个：选了手机 App 会把手机顶下线，别的工具（比如 OpenList）正在用的端也别选」。
- 登录端不另存字段：从 UID 中段随时能推出来。
- 真机要验的事：小程序端的 cookie 能不能过现在用的 `android/2.0` 导出目录树和取直链。作者的 D1 能过，说明不是严格按端匹配；验一次，不行就把默认换成 android。

### 后端

- `services/cloud-115/cookie.ts`（新）：`cookieSsoent(cookie)` 从 `UID=<用户id>_<中段>_<时间戳>` 里取中段，没有 UID 或形状不对回 `null`；`WEB_SSOENT = "A1"`。纯函数。
- `services/cloud-115/qrcode.ts`（新）：
  - `startQrcodeLogin(app)`：第 1、2 步，返回 `{ uid, image, expiresAt }`，`image` 是 `data:image/png;base64,…`。图由后端取、内联回去：前端不用二维码库，浏览器也不用直连 115，也没有外链图片的安全头问题。
  - `pollQrcodeLogin(uid)`：第 3 步；状态 2 时紧接着做第 4 步，把 cookie 拼好交出去。换到的 cookie 在会话里再留两分钟（评审改的：交出去那次响应可能没送到，再问还能拿到，不用重扫），到点才删。
  - 会话放内存 `Map<uid, { app, time, sign, createdAt, pending, last, result }>`，10 分钟没用完就清（每次 start 顺手扫一遍），同时最多留 4 个、老的先淘汰。同一个 uid 的查状态并发时共用一个进行中的请求（`pending`），两个标签页也不会往 115 叠着发。
  - 不经 `scheduleForAccount`（这时还没有账号），直接 axios，超时 `DEFAULT_TIMEOUT_MS`，UA 和其它 115 请求一样取设置里的 `user-agent`。`setQrcodeApiBase(base | null)` 仅供测试，把两个主机都指到本地假服务。
  - 错误：115 壳子 `state` 为假 → `upstreamError("115：<message>", { code })`；网络层用 `networkErrorText`。日志 `moduleLogger("cloud-115-qrcode")`，只记 uid 的末几位和状态，不记 sign / cookie。
- `routes/account/qrcode.ts`（新）：
  - `POST /api/account/115/qrcode`，body `{ app }`（zod enum，五个端）→ 201 `{ uid, image, expiresAt }`。
  - `GET /api/account/115/qrcode/:uid` → `{ status, cookie?, userName? }`，`status` 是 `waiting | scanned | confirmed | expired | cancelled`；`confirmed` 带 `cookie` 和 `userName`（有就给，不存），确认后两分钟内再问还是同一份。uid 不在会话里 → 404「二维码已失效，重新生成一个」。
  - 都只挂 `fastify.authenticate`，不声明 `agentScope`：账号接口永远不对令牌开放。
  - 路由直接 import `cloud-115/qrcode`，文件头注释说明：登录不是网盘操作，没有 Provider 可走，夸克也没有扫码这回事。
- `routes/account/index.ts`：POST / PUT 在 `unmaskAccountPatch` 之后，cookie 是这次新给的（不是掩码沿用的）就交给 `services/drive/credentials.ts` 的 `credentialProblem` 查（评审后挪过去的：按网盘分叉的规则放 drive 层，路由不认具体网盘）；115 的 A1 → 400：「这是网页版登录的 cookie（UID 里的 A1），能看目录但跑不了同步任务。用「扫码登录」，或者填 115 App 端的 cookie」。只拦 A1，没有 UID 的照旧放过（以前就没要求过形状）。
- `packages/shared/src/types/account.ts`：加 `Qrcode115App`、`Qrcode115Start`、`Qrcode115Status` 三个类型，前后端共用。
- 没有数据库改动、没有迁移、没有设置项。

**cookie 回到浏览器的取舍**：扫码确认后 cookie 要进表单再保存，走的是用户手填 cookie 的同一条路。掩码规则（只给末 4 位）管的是库里已有的凭据不要被例行读出来；这一次是用户刚用自己的手机登的、给自己的管理界面用，和手填一个信任级别。另一种做法是后端留着 cookie、表单只交一个票据，省不了多少暴露，却要在账号 schema 上多一个字段，不值。

### 前端

- `lib/api.ts`：`accounts.qrcode115.start(app)`、`accounts.qrcode115.status(uid)`。
- `app/account/components/Qrcode115Panel.tsx`（新）：内嵌在 `AddAccountDialog` 的 115 表单里、Cookie 字段下面，不另开弹框：
  - 收起时是一行：按钮「扫码登录」（编辑已有账号时叫「重新扫码」）+ 一句说明。
  - 展开后：登录端下拉（`SelectTrigger size="sm"`，`onValueChange={(v) => v && setApp(v)}`）+ 端的说明；二维码 192px，永远白底（二维码要对比度，深色主题也白底）；下面一行状态：「用 115 手机 App 扫一扫」/「已扫码，在手机上点确认」/「二维码已过期」/「手机上取消了」；按钮「刷新二维码」「收起」。
  - 轮询用 `usePolling(fn, 1500, { enabled: 展开且未结束 })`：上一轮没回不叠发，正好配合后端那一步可能挂 30 秒的查询。
  - `confirmed` → `form.setValue("cookie", cookie, { shouldDirty: true })`，收起面板，toast「已拿到 cookie，保存后生效」。用户还是要点保存，和手填一样。
  - 弹框关掉面板随之卸载，轮询停。换账户类型也卸载。
- Cookie 字段的说明改成：「推荐扫码：用 115 手机 App 扫一下就行。手动填的话必须是 App 端登录的 cookie，网页版（UID 里带 A1）能看目录但跑不了任务。」
- 窄屏（390px）下拉和二维码上下排；浅色 / 深色都看。

### 文案与文档

- README「第一次用」第 2 步：115 推荐扫码；手填 cookie 要 App 端的。
- `services/download/failure.ts` 的 `AUTH.advice`：改成「到「账户」页重新扫码或更新 cookie，再重新同步」（页面叫「账户」，现在写的是「账号」）。
- `notify.ts` 的账号告警文案实施时看一眼，带建议的话也加上「可重新扫码」。

**行为变化（要用户点头）**

1. 保存 115 账号时网页版 cookie（A1）会被拒掉。以前能存进去，只是跑任务时才报「请重新登录」。
2. 账户弹框里多一个「扫码登录 / 重新扫码」。

### 不做

- 不改导出目录树 / 取直链接口去兼容网页 cookie（`webapi.115.com/files/export_dir` + `app/chrome/downurl`）：多一套 115 调用路径要养，chrome/downurl 2024 年底被风控过；有扫码之后没必要。
- 不做后台自动续期、cookie 失效后自动重扫：必须有人拿手机扫。
- 不做夸克扫码：夸克 Cookie 模式另一套，也没有端绑定的问题。
- 不存登录端字段：UID 能推出来。
- 不做 115 开放平台（115_open）那套 OAuth：接口面不同，不在这次范围。
- 不做「检测 cookie 是否有效」按钮：和扫码无关，要做另开主题。
- 不拦桌面端（P1 / P2 / P3）cookie：115driver 标了 disabled，但我们没验过它打我们用的接口是什么样，先不拦；真机有空顺手试一个。
- 扫码拿到的 cookie 不直接写库：仍经表单保存，新建账号要先有名字。

## 测试

单元（`*.test.ts`）

- `services/cloud-115/cookie.test.ts`：有空格 / 无空格 / UID 在中间 / 没有 UID / 形状不对；A1 认出来，D1 / R2 不算。夹具要避开 `scripts/check-hygiene.sh` 的形状 `UID=[0-9]{3,}_[A-Z][0-9]_[0-9]{6,}`，写成 `UID=12_A1_123` 这种。

集成（`*.itest.ts`，本地假 115，照 `quark/client.itest.ts` 的写法）

- `services/cloud-115/qrcode.itest.ts`：
  - start：token 和图两步的路径里带选的 app、图回来是 data URL、返回 uid。
  - 状态 0 → 1 → 2 → 拿到 cookie（四个字段拼对、KID 缺了不写），第二次再问同一个 uid 是 404 类错误（交出去就删）。
  - 状态 -1 → expired、-2 → cancelled；壳子 `state: 0` 带 message → upstreamError 的 message 是 115 原话。
  - 查状态带 `uid / time / sign / _`；换 cookie 是表单 `app` + `account`。
  - 并发两次查状态，假服务只收到一次。
  - 会话 10 分钟过期（把 createdAt 拨旧）。
- `routes/account/qrcode.itest.ts`：没登录 401；令牌调用 403 `TOKEN_NOT_ALLOWED`；start → 201；不存在的 uid → 404；confirmed 那次带 cookie。
- `routes/crud.itest.ts` 追加：POST 115 账号 A1 cookie → 400 且 message 带「扫码」；PUT 新给 A1 → 400；PUT 原样提交掩码值 → 200 不动；POST D1 / R2 → 201。

前端

- 浏览器冒烟：scratch 库起后端，`--import` 一个预加载用 `setQrcodeApiBase` 指到本地假 115（查状态每问三次往前推一档：0 → 1 → 2，再回假 cookie），不用手机就能把面板走完：展开 / 换端 / 过期 / 取消 / 刷新 / 确认后 cookie 进表单、保存；浅色 / 深色、宽屏 / 390px。

真机（用户拿手机扫；一次登录就够，别反复登）

| 场景 | 看什么 |
|---|---|
| 新建 115 账号，默认端扫码 | 手机 App 出现确认提示；确认后表单里有 cookie，UID 中段是 R2；保存成功 |
| 用这个账号建 lab 任务跑一个小目录 | 导出目录树（`android/2.0/ufile/export_dir`）过了，strm 生成 |
| 这个账号取一个文件的直链 | `android/2.0/ufile/download` 过了（代理起播或媒体探测） |
| 二维码放到过期 | 面板显示过期，刷新能再来 |
| 手机上点取消 | 面板显示取消 |
| 编辑已有账号点「重新扫码」 | 新 cookie 覆盖旧的；原来那个端若有别的会话被顶掉要记下 |
| 手填一个 A1 形状的 cookie 保存 | 被拒，提示指向扫码 |
| （有空）换 android 端再扫一次 | 看是否顶掉手机 App；两个端的 cookie 都能过导出 |

真机按 CONTRIBUTING 8.2 做：config 库拷到 lab 目录、另开端口、临时口令、关掉 Telegram / 监控 / Emby / HDHive / cron、删生产任务；扫出来的 cookie 只进 lab 库，验完删。

## 进度

- [x] `cookie.ts` + 账号保存时拦 A1（含用例）（2026-11-02）
- [x] `qrcode.ts` + 假 115 用例（2026-11-02）
- [x] 路由 + 用例，shared 类型（2026-11-02）
- [x] 前端面板 + `api.ts` + 假 115 浏览器冒烟（2026-11-02）
- [x] README / 失败提示文案（2026-11-02）
- [x] 真机（用户扫码，2026-11-02，撞到长轮询超时已修）
- [x] 评审（2026-11-02，8 条全修，复验过）
- [ ] rc（维护者发）

## 实施记录（2026-11-02）

按方案做完，没有提交。改动：

- 新增 `services/cloud-115/cookie.ts`（`cookieSsoent` / `isWebCookie` / `cookieFromParts`）、`services/cloud-115/qrcode.ts`（`startQrcodeLogin` / `pollQrcodeLogin` / `setQrcodeApiBase` / `resetQrcodeSessions`，会话内存 Map、10 分钟 TTL、并发合并、cookie 只交一次）、`routes/account/qrcode.ts`（`POST /api/account/115/qrcode`、`GET /api/account/115/qrcode/:uid`，在 `index.ts` 里挂在 accountRoute 后面）、`src/test/fake-115-qrcode.ts`（假 115：四条路径、状态队列 / 自动推进、调用记录、按端给 UID 中段、自带一张棋盘格 PNG）。
- `routes/account/index.ts`：POST / PUT 过完必填校验再 `rejectWebCookie`，只看这次新给的 cookie（掩码沿用的不查），PUT 没带 accountType 按库里的类型算；400 `code: WEB_COOKIE`。
- `packages/shared/src/types/account.ts`：`Qrcode115App` / `Qrcode115Start` / `Qrcode115Status`，index.ts 一并导出。`cloud-115/client.ts` 的 `defaultUA` 改成导出给 qrcode.ts 用。
- 前端：`lib/api.ts` 加 `accounts.qrcode115.start / status`；新增 `app/account/components/Qrcode115Panel.tsx`；`AddAccountDialog.tsx` 的 115 表单在 Cookie 字段下面挂面板，占位文案改成「填 115 App 端的 Cookie，或用下面的扫码登录」。
- 文案：README「第一次用」第 2 步；`download/failure.ts` 的 AUTH / BLOCKED 建议改成「账户」页并提到重新扫码；`telegram/notify.ts` 的 cookie 失效通知加「115 可以直接重新扫码」。

和方案不一样的地方：

- 第 1 步拿二维码按 p115client 带 `{app}`，第 4 步按 115driver 走 passportapi，方案里写的两个备选都留着等真机定。
- 壳子 `state` 为假时文案里带「过期 / 失效」「取消」也分别认成 expired / cancelled（p115client 只按 data.status 认），真机看到哪种都能接住。
- 换 cookie 失败（IP 异常、网络）不删会话：下一次查状态 115 仍回 2，还能再换一次。
- 假 115 顺手做成冒烟也能用的：预加载里 `setQrcodeApiBase` 指过去，再开一个 127.0.0.1:4199 的控制口往状态队列里塞结局、让某条路径回 500。

用例（都过）：`cloud-115/cookie.test.ts` 4 条；`cloud-115/qrcode.itest.ts` 11 条（start 两步路径与 data URL、0 → 1 → 2 → cookie 只给一次、安卓端 F1、KID 缺省 / SEID 缺失留会话、-1 / -2、state:0 的过期文案与原话透传、认不出的状态、IP登录异常提示、并发合并、TTL 与 prune、HTTP 500 / 数据不完整 / 系统繁忙）；`routes/account/qrcode.itest.ts` 4 条（401 / 令牌 403 TOKEN_NOT_ALLOWED 且没碰 115、app 校验、生成 → 轮询 → 确认 → 404、115 出错 500 带原话）；`routes/crud.itest.ts` 追加 1 条（A1 新建 / 改都 400 带「扫码」、不带 accountType 按库里算、掩码沿用、R2 能存、夸克不看 UID）。`pnpm typecheck && pnpm lint` 前后端都干净；后端全量 1704 条全过（4 分 51 秒，2026-11-02）。

浏览器冒烟（2026-11-02，scratch 库 + 假 115，后端 4100 / 前端 dev 3223，都只听 127.0.0.1）：

| 场景 | 结果 |
|---|---|
| 新增账户 → 115 → 扫码登录 | 面板展开、二维码（棋盘格）出来、「打开 115 手机 App，扫这个二维码」 |
| 假 115 推到已扫 | 二维码上盖「已扫码」，右边「已扫码，在手机上点「确认登录」」 |
| 推到确认 | 面板收起，Cookie 字段变成新值（遮住 + 眼睛），toast「已拿到「fake user」的 cookie，保存后生效」 |
| 填名字保存 | 列表出现 lab-115，认证信息 `••••mini`；库里 cookie 是 `UID=12_R2_123; CID=…; SEID=…; KID=…` |
| 编辑 → 重新扫码，队列塞 -1 | 「已过期」+「二维码过期了，重新生成一个」+ 重新生成按钮 |
| 重新生成，队列塞 -2 | 「已取消」+「手机上取消了登录」 |
| 让 token 路径回 500 再重新生成 | 「出错了」+「没成功」+ 红字「115 二维码接口返回 500」+ 重新生成 |
| 手填 `UID=12_A1_123; …` 保存 | 400，toast 原话「这是网页版登录的 cookie（UID 里的 A1），能看目录但跑不了同步任务。用「扫码登录」，或者填 115 App 端的 cookie」 |
| 浅色 + 390px（iframe） | 登录端一行、刷新 / 收起换到下一行、二维码居中白底、状态文案在下面；没有横向滚动 |

没改代码的观察：面板展开后弹框变高，宽屏下不用滚动；窄屏要滚一下才看到保存按钮，和别的长表单一样。

真机后补（2026-11-02）：查状态是长轮询，见「真机验证」。`qrcode.ts` 查状态改成单独 40 秒超时、超时当没变化回上一次状态（会话里记 `last`），`raw` / `http` 拆开以便认超时；假 115 加 `hangStatusMs`；`qrcode.itest.ts` 加「挂到超时回上一次状态」「连不上才算错」两条，共 13 条；`lib/api.ts` 的 status 请求超时 60 秒。

## 评审与修补（2026-11-02）

工具评审（high）8 条，全修：

- 前端：换码 / 收起时旧那次查状态还挂着，回来会把旧码的结局盖到新码头上 → 会话和中止器放 ref，换码、收起、卸载时 abort，回来的结果对 uid、对卸载标记，不对就丢；`Qrcode115Panel.tsx`，假 115 冒烟复验。
- 前端：面板卸载后（切了账户类型、关了弹框）confirmed 还会往表单塞 cookie → 同上的卸载标记挡住。
- 后端：换到 cookie 就删会话，那次响应没送到就得重扫，而前端 60 秒也盖不住 40 秒长轮询加 30 秒换 cookie → 会话里留 `result` 两分钟（`QRCODE_CONFIRMED_KEEP_MS`），再问直接回、不碰 115；前端那次请求超时 90 秒。回归：`qrcode.itest.ts`「换完再问还是同一份…两分钟后才清」、`routes/account/qrcode.itest.ts`「…再问还是同一份」。
- 后端：`isTimeout` 自己写了一份、漏了 `networkErrorText` 认的「文案里说 timeout」那种 → `lib/errors.ts` 抽 `isTimeoutError` 两边共用；回归 `errors.test.ts`「isTimeoutError…」。
- 后端：`cookieSsoent` 只认分号分隔，开发者工具表格复制出来的换行 / 制表符分隔的 A1 cookie 绕过检查 → 正则改成分号或空白都算；回归 `cookie.test.ts` 加换行 / 制表符夹具。
- 约定：路由里 `accountType !== "115"` 分叉、直接 import `cloud-115/cookie` 违反「路由不按账号类型分叉」 → 规则挪到 `services/drive/credentials.ts`（`credentialProblem`，drive 层本来就按类型分发），路由只调一个函数；扫码路由直接用 `cloud-115/qrcode` 这件事写进 CONTRIBUTING 第 4 节（登录不是网盘操作、没有 Provider）。加 `credentials.test.ts`。
- 后端：`poll()` 里又抄了一遍 message / error 的提取 → 抽 `shellMessage`，错误和过期 / 取消的判断共用。
- 后端：`startQrcodeLogin` 没有上限，狂点刷新每次两个请求、会话越积越多 → 同时最多 4 个会话（`QRCODE_MAX_SESSIONS`），超了淘汰最早的；回归 `qrcode.itest.ts`「同时最多留几个会话…」。每次 start 仍会去 115 拿一次码，没做节流（115 回「操作太频繁」时原话会带到界面上）。

修完复验：后端全量 1709 条全过（2026-11-02 第二轮）；假 115 浏览器冒烟三条都过——主流程（等扫 → 已扫 → 确认 → cookie 进表单）；面板轮询中途把账户类型切成夸克，夸克的 Cookie 框是空的、没有 toast、后端那边轮询就停了（队列里的确认没被消费）；开面板后连点两次刷新，第三个码照样走到确认、cookie 填进来、没有报错。

## 真机验证（2026-11-02）

**环境**：`config/openstrm.db` 用 sqlite `.backup` 只读拷到 scratchpad 的 `lab/cfg`，`DATA_DIR` 是 `lab/data`；后端 4100、前端 dev 3223，都只听 127.0.0.1；lifeMonitor / Telegram 轮询 / Emby / HDHive / 更新检查 / 智能体 / 收藏夹巡检全关，3 个生产任务、追更、收藏夹、媒体库索引、路径缓存、快照都清了；口令换成临时的，浏览器用注入的会话 token 操作。lab 任务：账号 lab-qr → `/tv/天桥上的魔术师 (2021) [tmdbid=101174]` → 本地 `lab-qr-tv`，前缀 `/mnt/115`。

| 场景 | 结果 |
|---|---|
| 新增账户 → 115 → 扫码登录（默认支付宝小程序） | 真 115 的 token / qrcode 两步都认 `alipaymini`，二维码出来 |
| 用户用 115 App 扫码并确认 | 第一次撞到长轮询超时（见下），面板停在「查不到扫码状态」。会话还在：直接查状态回 confirmed，passportapi 的 `login/qrcode` 换到 cookie，UID 中段 R2、UID / CID / SEID / KID 齐，user_name 回来了 |
| 用 R2 cookie 列 `/tv` | 39 个目录 |
| lab 任务跑一部剧 | 导出目录树（`android/2.0/ufile/export_dir`）过，25 个文件（10 strm + nfo + 海报），0 失败，35 秒 |
| 取 S01E01 直链（`android/2.0/ufile/download`） | 拿到 115cdn 地址 |
| 修完长轮询后换微信小程序端再扫 | 面板一路走到 cookie 填进表单、保存成功；那次查状态挂了约 13.5 秒后直接回 confirmed；lab-qr-wx 的 UID 中段 R1 |
| 两个端同时登着 | 微信端登完，支付宝端那份 cookie 取直链照样成功：不同端不互相顶 |
| 手填 A1 cookie 被拒 | 只在假 115 上验过（纯形状校验，和真网盘无关） |
| 手机上取消 / 二维码过期 / 桌面端 cookie | 真机没验（取消和过期的代码路径靠假 115 的 -1 / -2 用例） |

**真机发现的问题（已修）**：查状态是长轮询。现象：第一次查立刻回 0，第二次 115 挂着超过 30 秒不回；后端按 `DEFAULT_TIMEOUT_MS` 30 秒超时回 500「网盘接口 30 秒没有回应」，前端 axios 默认也是 30 秒、先一步放弃，`apiErrorMessage` 拿不到后端文案，面板显示兜底的「查不到扫码状态」并停了轮询。原因：把长轮询的超时当成了错误。修法：`qrcode.ts` 查状态单独 40 秒超时，超时当「没变化」回会话里记的上一次状态（waiting / scanned），连不上、回错误码照旧抛；`lib/api.ts` 的 status 请求超时放宽到 60 秒。回归用例：`qrcode.itest.ts`「115 把查状态挂到超时（长轮询没变化）…」「连不上才算错…」。复跑：微信端那一次全程正常。

日志：lab 后端日志里除修前那一条 30 秒超时告警外没有告警和报错。

收尾：lab 库里 lab-qr / lab-qr-wx 两个账号、lab 任务和执行记录已删，cookie 不留；115 那边支付宝小程序端和微信小程序端各留着一个登录会话，可在 115 App 的设备管理里下线；网盘上没有留下东西（导出用的临时文件由同步流程删了）；lab 目录（scratchpad 的 `lab/`，库拷贝 + 生成的 strm）留着，删不删由用户定。

## 发布

- 2026-11-02 **v2.22.0-rc.1**：`ef2ed87`（chore(release)，= `6d70bdc` feat(account) + `c9ebeeb` docs(plans) + 三个 package.json 版本号），tag `v2.22.0-rc.1`，推了 v2 和 tag，main 没动。Release 四作业（Typecheck, lint and tests / Build amd64 / Build arm64 / Merge manifest and release）和 CI@v2 全绿（15:10 → 15:18）。Docker Hub `v2.22.0-rc.1` digest `sha256:d2f04083bc793c2eb58b68d0c6b6c6737d925f1a344183873ae797ba119f320c`（amd64 + arm64），`latest` 仍是 v2.21.0 的 2456e921409c。GitHub Release 是 prerelease。没有迁移、没有新设置项。升级说明要点交用户手动贴：账户弹框新增「扫码登录 / 重新扫码」（默认支付宝小程序端，每个端同时只能登一个会话）；保存 115 账号时网页版 cookie（UID 中段 A1）会被拒并指向扫码，已经存进去的不受影响。
