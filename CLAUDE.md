# 给 AI 助手的规则

完整流程在 `CONTRIBUTING.md`，这里只列硬规矩。改某个模块之前先读 `.claude/plans/` 里对应的方案文件，末尾的实施记录和真机记录最有用；网盘和 Emby 的已知坑在 `.claude/plans/drive-notes.md`。

## 仓库

- 开发分支是 `v2`。不往 `main` 提交，它只在发正式版时快进。历史没有 merge 提交，只 rebase。
- 用户没有叫提交 / 推送就不提交 / 推送。发版只有维护者做，步骤在 CONTRIBUTING 第 9 节。
- 提交信息 `type(scope): 英文祈使句`，正文英文；不加 Co-Authored-By 等尾注。
- 交错的改动合成一个提交；方案文件更新单独 `docs(plans):` 提交。
- 不动三个 `package.json` 里的版本号。

## 写代码

- 后端：入参 `parse(schema, body)`；错误 `throw new HttpError(...)`，上游出错 `upstreamError(...)`，不回 502 / 504；成功直接返回 payload；日志用 `moduleLogger`，不用 `console`；网盘只经 `services/drive/` 的 Provider，路由里不写按账号类型的分叉。
- 前端：API 集中在 `lib/api.ts`；错误用 `apiErrorMessage`；轮询用 `usePolling`；表单 react-hook-form；颜色用 token。
- 数据库改动：改 `db/schema.ts` 后 `pnpm db:generate`，迁移顺序编号；已发布的迁移不改。
- 不把 cookie / 令牌 / 口令写进代码、测试、方案、提交。
- 新建文件前先 `git ls-files` 或 `ls` 确认不存在；已存在就追加，别覆盖。
- 往文件里写反斜杠 u 转义、特殊空白、控制字符时，写完用脚本扫一遍改过的文件：工具参数里的转义会直接落成真字符。

## 测试

- 提交前 `pnpm typecheck && pnpm lint && pnpm test`。单文件 `pnpm test:file <path>`，`CONFIG_DIR` / `DATA_DIR` 必须指到临时目录。
- 后端全量约 4 分多钟；跑的时候别改 `apps/backend/src` 和 `packages/shared`。
- 网盘用 `src/test/fake-drive.ts` 注入；修 bug 先写复现用例。
- 界面改动做浏览器冒烟；改全局样式要带着海报墙页面看。

## 方案与记录

- 非琐碎改动先写 `.claude/plans/<topic>.md`（复制 `_template.md`）。实施记录、评审修补、真机记录、发布记录都追加到同一份文件末尾，带日期。
- 方案只放仓库里：不发布成共享页面，不贴到外部文档工具。
- 方案里可以写分享码和测试目录，不能写凭据。

## 评审

- 收尾顺序：先真机走一遍用户会走的路，再评审，再发 rc。
- 评审发现的项全部修完；只有缺凭据或要产品决策的才单列说明。

## 真机

- 永远不对着用户真实的 `config/openstrm.db` 跑：只读拷到 lab 目录、另开端口、口令换临时的、关掉 Telegram / 监控 / Emby / HDHive / cron、删生产任务，只建 lab 任务指向专用网盘目录。
- 任何会改动真实网盘内容的操作（转存 / 删除 / 移动 / 整理执行 / 复制）先说清存什么、存到哪、会连带触发什么，等用户批准；一次批准只管这一次。
- 整理：只读预览 → 执行 → 撤销，三步都验。
- 别人给的令牌只进 lab 库、验完删。探测脚本的错误只打 name / code / message，别把带 cookie 的请求对象打出来。
- 复制大文件前先看磁盘余量；实验结束 `docker rm -f`。
- 做完报告网盘上留下的路径和 lab 库位置，删不删由用户定。
- 记录按 CONTRIBUTING 第 8.4 节写进方案文件；踩到新坑追加到 `drive-notes.md`。
