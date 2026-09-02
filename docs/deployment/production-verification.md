# 家具共享平台 Production 上线验证记录

**目标域名：** `https://fc.polly.wang`

**状态：** Phase 6 生产 smoke 已完成；Phase 7 连续稳定观察执行中

**证据规则：** 仅记录资源名、非敏感 ID、版本、计数和结果；不记录 Secret、访问凭据、
Cookie、Authorization Header 或任何 Token 摘要。

## 1. Phase 0 基线（2026-09-01）

### 1.1 Cloudflare 只读状态

| 检查 | 结果 |
| --- | --- |
| Production Worker `furniture-center` | 不存在 |
| Production D1 `furniture-center` | 不存在 |
| Production R2 `furniture-center-images` | 不存在 |
| `fc.polly.wang` A / AAAA / CNAME | 均不存在 |
| Preview pending migrations | 0 |
| Preview Worker Secret names | `COPILOTX_API_KEY`、`SESSION_SIGNING_KEY` |
| Production Worker Secret lookup | Worker 尚不存在，因此无 Production Secret |
| Preview 当前版本 | 已记录于 runbook |
| Preview 已知回滚版本 | 已记录于 runbook |

本地配置仍缺少 Production D1/R2 bindings 和
`MCP_ALLOWED_HOSTS=fc.polly.wang`。Production Worker 和 Custom Domain 尚未创建，符合
Phase 0 的零外部写入边界。

Preview `/health` 本轮未能从当前执行环境独立复验：命令行 TLS 连接被中途重置，内置浏览器
将 `workers.dev` 健康端点标记为客户端阻止。Cloudflare 部署列表与无 pending migration
状态可读取，但这不能替代 HTTP 健康证明。该项标为“执行环境不可达”，不得据此声称
Preview 运行时已通过；Phase 4/6 必须从可访问网络重新验证 Production 与 Preview。

### 1.2 本地验证

| 验证面 | 结果 |
| --- | --- |
| Python | 47 passed（含应用关闭时释放共享 engine 的回归测试） |
| Python lint | 已修复 18 个纯格式问题；Ruff 全量通过 |
| Frontend | Node 24.20 下 25 passed；build 与 lint 通过；仅有大 chunk 建议性警告 |
| Worker | Node 24.20 下 77 passed；typecheck 通过 |
| MCP evaluator unit | 1 passed |
| MCP authenticated integration | 缺少受保护的 Preview MCP 凭据，因此未连接；不是绿灯 |
| Production Wrangler dry-run | Node 24.20 下通过；仅编译/检查，无上传；确认 D1/R2 不继承 |
| Node toolchain | 已使用声明支持的 Node 24.20 / npm 11.19 完成全量前端和 Worker 验证 |
| V2 数据迁移本地对账 | 通过；8 表计数一致、5 库存一致、4 图片一致、外键违规 0 |

认证 MCP 集成测试推迟到持有独立受保护凭据的 Phase 6。实际 Production 部署仍必须固定
使用声明支持的 Node 22 或 24+，不能回落到系统默认的 Node 23。

数据来源、清洗规则、园区库存分布和图片对象见
[Production 数据清单](production-data-manifest.md)。

## 2. Phase 1–5 外部写操作与回滚边界

以下每一行都需要该阶段的单独授权。Phase 0 没有执行其中任何操作。

| Phase | 外部写操作 | 精确目标 | 切换前回滚/停止边界 |
| --- | --- | --- | --- |
| 1 | 创建 Production D1、R2；应用 schema migrations | D1 `furniture-center`；私有 R2 `furniture-center-images` | 未导入业务数据前可停止并保留空资源；不删除 Preview；资源 ID 仅写入 Production bindings |
| 2 | 写入 Worker Secrets；创建 3 条访问凭据摘要记录 | Worker `furniture-center`；labels `production-browser-viewer`、`production-admin`、`production-mcp-client` | Secret 不可导出；失败时停止并重新签发，不能复用 Preview 值；凭据明文仅保存在本机 `0600` 忽略文件 |
| 3 | 导入 D1 业务数据；上传 R2 图片；执行恢复演练 | 上述 Production D1/R2；另建的一次性恢复测试资源（如需要） | 不覆盖现库、不删除首批 R2 对象；用预上线导出恢复到新 D1、对账后切换 binding；R2 从权威包重建到新桶 |
| 4 | 打开受控 `workers.dev` 预检入口并部署已验证版本，暂不绑定正式域名 | Worker `furniture-center` 的受控 `workers.dev` 入口 | 保留 Phase 2 密封版本为回滚点；代码/binding 故障使用 Worker rollback；Worker 回滚不回退 D1 数据 |
| 5 | 写入 Custom Domain route 并部署同一代码 | `fc.polly.wang` → Worker `furniture-center` Custom Domain | DNS/证书失败时暂停或解除公开入口；不创建临时 A/CNAME、不修改 Zone 全局 SSL |

Token 删除/撤销/轮换、Zone 全局 SSL、WAF、Access 和缓存策略不属于上述授权，必须另行审批。

## 3. Phase 1 存储与 schema（2026-09-02 完成）

- [x] D1 `furniture-center` 创建完成；ID
  `7640704c-3622-496a-bd00-861c1a9fe735`
- [x] 私有 R2 桶 `furniture-center-images` 创建完成；无 Custom Domain，且
  `r2.dev` 公共访问已禁用
- [x] dry-run 核对 `DB`、`IMAGES`、`IMAGES_TRANSFORM`、`ASSETS` bindings
- [x] dry-run 核对 `ENVIRONMENT=production`
- [x] dry-run 核对 `MCP_ALLOWED_HOSTS=fc.polly.wang`
- [x] `0001`–`0007` 按文件名顺序应用；随后 Wrangler 返回
  `No migrations to apply`

Production D1/R2 与 Preview 资源同时列出且名称、D1 ID 均不交叉。本阶段没有部署
Worker、绑定域名、设置 Secret、创建访问凭据、导入业务数据或删除 Preview 资源。

## 4. Phase 2 Secrets、访问凭据与密封部署（2026-09-02 完成）

- [x] 两个 Worker Secret 已经通过私有、Git 忽略、mode-`0600` 临时文件随首次
  `deploy --secrets-file` 原子设置；临时文件已删除
- [x] 三个 Production 凭据分别生成且不复用 Preview
- [x] 本机 `.env.production-credentials.local` 被 Git 忽略且权限为 `0600`
- [x] D1 只保存摘要、role 和 label
- [x] 近一小时 Wrangler 日志、本阶段输出、命令参数和 Git diff 均未发现明文或摘要

| label | role | D1 record ID | 状态 |
| --- | --- | --- | --- |
| `production-browser-viewer` | `viewer` | `0191d038-973b-4d5c-aad1-609f63beae8b` | 有效 |
| `production-admin` | `admin` | `8db76bfa-2044-4edf-8113-63a4ee344426` | 有效 |
| `production-mcp-client` | `viewer` | `eb7f5fea-d695-465a-b5b9-ec2d0d1dc89d` | 有效 |

凭据由固定路径生成器原子写入，三者均为带 `ms-fc-` 前缀、至少 256-bit 随机性的唯一值。
写入 D1 时使用 mode-`0600` 的忽略临时 SQL 文件，Wrangler 输出被抑制，文件在同一进程
的 `finally` 中删除。验证只查询上述非敏感字段，未读取或回显 `token_hash`。

Secret 配置不是因为缺少权限而失败，而是 Cloudflare 不允许在 Worker 首次部署前用
`secret put` 单独预置。Wrangler 4.127.1 的 `versions upload --secrets-file` Node 24 dry-run
能够通过，bindings 完整且输出隐藏两个 Secret；但 2026-09-02 的真实上传被 Wrangler
拒绝，明确要求先运行 `deploy` 创建 Worker。因此原先“首次上传未部署版本”的假设已被
实证推翻。

该次尝试先创建了 CopilotX `furniture-center` user（`role=user`、300 次/日），其一次性 Key
经 `/v1/models` HTTP 200 验证。上传失败后同一受控进程软删除了该用户并删除 mode-`0600`
临时 Secret 文件。随后刷新证明：CopilotX 活跃用户为 0；Production Worker、version、
deployment 均不存在；临时 Secret 文件数为 0；Wrangler 日志未包含 CopilotX Key 或两个
Secret 名称。

用户于 2026-09-02 明确授权该零入口首次部署。重新创建的专用 CopilotX
`furniture-center` user 使用 `role=user` 和 300 次/日配额；一次性 Key 经 `/v1/models`
HTTP 200 验证后只进入 Worker Secret。首次密封 deployment 已成功创建：

| 项目 | 结果 |
| --- | --- |
| Worker | `furniture-center` |
| Version | `c486019a-1e3a-4ee9-ab51-632bc0d56598` |
| Deployment | `e49c71df-3406-44ab-be26-46f871eac6cb`，100% allocation |
| Worker Secret names | `COPILOTX_API_KEY`、`SESSION_SIGNING_KEY` |
| Bindings | Production `DB`、`IMAGES`、`IMAGES_TRANSFORM`、`ASSETS` |
| Vars | `ENVIRONMENT=production`、`MCP_ALLOWED_HOSTS=fc.polly.wang` |

100% allocation 仅描述该 Worker 的内部 production deployment；以下独立远端检查证明它
没有入口：

- script 与 `production` environment 均返回 `enabled=false`、`previews_enabled=false`；
- Cron schedules、Workers Routes、Custom Domains 均为 0；
- `fc.polly.wang` A、AAAA、CNAME 均为空；
- 基础 workers.dev URL 与 `c486019a` 版本化 Preview URL 均无法建立 HTTP 连接；
- 私有临时 Secret 文件残留数为 0。

Phase 2 收尾时再次只读查询 Production D1：三条上述 label 均为 active，`categories`、
`sites`、`furniture`、`furniture_images`、`inventory`、`transfer_records` 六张业务表仍均为
0 行，证明本阶段没有提前执行 Phase 3 导入。

版本 API 同时返回 `metadata.has_preview=true`。这表示该版本具备生成 Preview 的能力，不是
公开路由状态；Cloudflare 文档明确说明只有启用 Preview URLs 后版本 URL 才可公开，并且
禁用 Preview URLs 会禁用版本和 alias 两种路由。本 Worker 的远端实际开关是
`previews_enabled=false`，因此该字段不构成暴露。配置安全测试此前已完成红绿验证：移除
Production Cron 空覆盖时失败，恢复后通过。

## 5. Phase 3 数据与恢复（2026-09-02 完成）

- [x] 用户已于 2026-09-02 确认 `production-data-manifest.md` 的 3 园区、4 家具、5 库存、
  4 图片基线、Preview E2E 排除范围及零真实调拨历史
- [x] D1 8 表计数、5 条园区库存分布、外键逐项核对
- [x] R2 4 个对象的 key、MIME、大小和 SHA-256 逐项核对
- [x] R2 无公开桶入口，图片只经授权 Worker 路径访问
- [x] 预上线 D1 导出与 R2 manifest 已保存在 Git 忽略、`0600` 本地位置
- [x] D1 恢复演练通过并记录当次精确目标和结果
- [x] R2 重建演练通过并记录当次精确目标和结果

### 5.1 本地预检（2026-09-02，无远端写入）

- 候选包实际位于主 checkout 的 Git 忽略目录；linked worktree 不共享未跟踪文件，并非包
  丢失。
- 候选包仍为 3 个园区、4 个家具、5 条库存位置和 4 个图片对象；不包含调拨、审计、库存
  调整、访问凭据或会话数据。
- 候选包 11 个目录均已收紧为 `0700`，6 个文件均无 group/other 权限；权限违规为 0。
- 使用当前 `0001`–`0007` migrations 新建 mode-`0600` 本地目标库、导入候选 SQL并重新运行
  verifier，结果为 `ok=true`、差异 0、图片校验 4/4、外键违规 0。
- 新的忽略证据位于 `.migration/production-phase3-preflight-20260902.sqlite` 和
  `.migration/production-phase3-preflight-20260902.json`，两者权限均为 `0600`。
- Production D1 的只读 `time-travel info` 查询成功并返回当前 bookmark，证明该数据库支持
  Time Travel 信息查询；真正 restore 仍必须在一次性测试资源上演练后才能勾选恢复门。

### 5.2 D1 远端导入与恢复证据

- 导入前 Production 六张目录/库存/调拨表均为 0，三条 Production 凭据均为 active；完整
  D1 导出保存在 `.migration/production-phase3-preimport-20260902T030446Z.sql`，Git 忽略且
  权限为 `0600`。
- 首次导入被 Cloudflare D1 拒绝，根因是导出器包含显式事务包装；自动 Time Travel 回滚
  成功，随后只读核实 Production 仍为 0 条业务数据且三条凭据仍有效。
- TDD 回归测试
  `test_export_omits_transaction_wrappers_rejected_by_remote_d1` 在旧实现上失败，移除包装后通过；
  修复包与已确认包的 manifest 和四个图片对象完全一致。
- 一次性 D1 `furniture-center-d1-restore-test-20260902-0310`
  (`3043d544-91f6-4c92-ad3b-006df2f560cb`) 完成 `0001`–`0007`、首次导入、Time Travel
  恢复为空库、再次导入和外键核对，随后删除并确认资源列表中不存在。
- Production D1 最终为 categories 3、sites 3、furniture 4、furniture_images 4、inventory
  5、transfer/adjustment/audit 0；五条园区库存逐条一致，外键违规 0，Preview E2E site/SKU
  均为 0，三条 Production 凭据仍有效。

### 5.3 R2 上传、隐私与重建证据

- Production `furniture-center-images` 的四个对象经 Cloudflare API 逐个回读，HTTP 200、
  MIME `image/jpeg`、字节数和 SHA-256 均与权威 manifest 一致，4/4 通过。
- Production R2 的 `r2.dev` 公共访问为 disabled，Custom Domains 为 0。
- 一次性桶 `furniture-center-r2-restore-test-20260902-0320` 从权威包重建 4/4 对象并完成同样
  的 MIME、大小和 SHA-256 回读核验；随后逐对象删除并删除桶，最终确认桶不存在。
- Phase 3 后 Worker 仍为 `workers_dev=false`、`previews_enabled=false`，Cron、Workers
  Routes、Custom Domains 均为 0；`fc.polly.wang` 仍无 A、AAAA、CNAME。

## 6. 切换前回滚记录（Phase 5 硬门，已完成）

| 对象 | 已验证恢复目标 | 精确命令/操作 | 验证结果 |
| --- | --- | --- | --- |
| Worker | Phase 2 密封 version `c486019a-1e3a-4ee9-ab51-632bc0d56598` | `wrangler rollback c486019a-1e3a-4ee9-ab51-632bc0d56598 --env production` | 从 Phase 4 预检 version `7e067725-fbac-47f6-8123-fcca9e5e43ea` 实际回滚到密封版本成功；随后部署恢复 version `c73e33c5-6e71-44bc-a6f8-110c8bed1db6` 并复验 `/health`、bindings 与业务计数 |
| D1 | 导入前 Time Travel 点与 mode-`0600` 完整导出 | `wrangler d1 time-travel restore furniture-center --timestamp 2026-09-02T03:04:46Z --env production`；长期恢复使用导出到新 D1 后对账并切换 binding | Production 失败路径恢复成功；一次性 D1 完成导入 → 恢复 → 重导入，计数与外键通过 |
| R2 | Git 忽略、mode-`0600` 权威 manifest 与四个对象包 | 创建新私有桶，按 manifest 逐对象上传，核对 MIME、大小、SHA-256 后切换 binding | 一次性桶重建 4/4 通过并已清理；Production 原对象未删除 |

D1、R2 和 Worker 三种恢复路径均已实际演练；绑定正式域名前的回滚硬门通过。

## 7. Phase 4 Worker 预检（2026-09-02 完成）

- [x] 使用支持的 Node 版本完成 build、tests、typecheck 和 dry-run
- [x] Phase 2 首次密封 Production version 已记录，可作为 Phase 4 前回滚点
- [x] `workers.dev` 上 `/health`、静态资源、登录和授权边界通过
- [x] 远端逐项核对 Assets、D1、R2、Images、Cron、compatibility、vars、Secret names
- [x] Production 与 Preview 的 D1/R2 绑定没有交叉

Production `workers.dev` 受控预检 version 为
`7e067725-fbac-47f6-8123-fcca9e5e43ea`。通过 Viewer/Admin 登录、目录、图片、Chat 与未授权
边界后，实际回滚至密封 version，再恢复为
`c73e33c5-6e71-44bc-a6f8-110c8bed1db6`；三次部署均保持 Production D1/R2 bindings、两个
Secret 名称和空 Cron 不变。Worker 回滚没有改变 D1/R2 数据。

## 8. Phase 5 Custom Domain（2026-09-02 完成）

- [x] 切换前再次确认 DNS、Custom Domain 和 Workers Route 无冲突
- [x] `fc.polly.wang` 显示为 Custom Domain，不是 Workers Route
- [x] Cloudflare 管理的 DNS 和边缘证书可用
- [x] HTTP 跳转与 HTTPS 正常
- [x] 未修改 Zone 全局 SSL/TLS 模式

Custom Domain 首次绑定 version 为 `e7bb1305-f822-4d1d-a722-5b8fcde16427`。HTTPS
`/health` 返回 200，HTTP 自动 301 到 HTTPS；边缘证书 SAN 包含 `polly.wang`、
`fc.polly.wang` 和 `*.fc.polly.wang`。Production
`workers.dev` 和 version Preview URLs 均已关闭，未创建 Workers Route、手工 A/CNAME 或
Cron，也未修改 Zone 的 `Full` SSL/TLS 模式。

## 9. Phase 6 生产 smoke（2026-09-02 完成）

- [x] 未登录保护、Viewer、Admin、Chat SSE、图片、MCP、CSRF/Token/Cookie/Origin/rate limit
- [x] Viewer 对管理接口均为 `403`
- [x] MCP 仅暴露约定的只读工具并严格校验 Host
- [x] 桌面与窄窗口旅程通过，控制台无应用错误
- [x] Preview 入口和 Preview 数据保持不变

未登录目录和图片返回 401，恶意 Origin 与伪造 Host 返回 403，Viewer 访问 Site、Inventory、
Transfer 管理接口返回 403。浏览器 Cookie 带 `Secure`、`SameSite=Strict`，session Cookie 另带
`HttpOnly`；CSRF、退出失效、无效/撤销/过期 Token 及 Chat/MCP 429 配额边界均通过。验收后
三个 Production 凭据均恢复 active、无过期时间、daily quota 100。

MCP 与 `fc.polly.wang` 完成独立 Bearer 初始化，协商协议 `2026-07-28`，仅暴露
`search_furniture`、`get_furniture`、`list_sites`、`list_categories` 四个只读工具；北京查询返回
2 条。Admin 曾将北京园区名称临时修改后恢复，site version 1 → 3，形成 2 条不可变审计；
随后正式 Admin UI 验收再次经界面临时修改并恢复，业务可见状态仍不变，审计总数为 4。
管理界面稳定加载 4 类家具、3 个园区和 0 条调拨，弧背会议椅可分别看到北京、上海库存且
管理图片完成加载。

Chat 验收发现“上海有哪些可共享家具？”被 Planner 错误解析为同时带
`site_id=site-shanghai` 和全文 `query=可共享家具`，导致 0 条。回归测试先复现失败，随后将纯
泛化目录词归一为 `query=null`；version `28f6317c-9ce8-4e4e-93af-0ef59d1741c6` 上正式域名
返回弧背会议椅 4、橡木协作桌 3，首段约 425ms、完整约 6.35s，控制台无错误。
观测配置 version `94e283de-4531-41dd-a6e7-2c0d3140ec5c` 上再次验证同一问题：SSE
`status` 约 0.47s、2 条目录 `result` 约 3.01s、首个文本约 4.20s、`done` 约 4.87s，共
77 个文本增量且没有 error；UI 在 15 秒快照中显示两条家具和 135 字回答，
`aria-busy=false`、无 typing indicator、toast、console 或 page error。

760×900 浏览器旅程中 `scrollWidth=760`，无横向溢出；详情为 760×700 底部浮层，主图
`naturalWidth=1024`、`naturalHeight=1024`，弹窗大图完成加载且可关闭，详情浮层也可关闭；
登录后 console/page error 均为 0。Preview HTTPS 通过内置浏览器继续可用，显示 4 个可用
目录结果和 3 个园区；Preview D1 仍为 3 分类、4 园区、5 家具、6 库存、1 调拨，符合 V2
验收后的独立状态。当前终端对 `workers.dev` 的 HTTPS 握手会重置，但 HTTP `/health` 200、
Cloudflare deployment 可读且浏览器 HTTPS 正常，判定为命令行网络路径限制而非 Preview
故障。

## 10. Phase 7 观察与结论（已完成）

- [x] smoke 后连续观察至少 30 分钟
- [x] 错误率、CPU、请求量、D1/R2 使用和 Chat 上游错误无阻断项
- [x] 日志/Trace 不含敏感数据并记录采样与保留策略
- [x] Worker、D1、R2 回滚材料仍可用
- [x] Definition of Done 全部通过后再标记 Goal complete

Phase 7 配置 version 为 `94e283de-4531-41dd-a6e7-2c0d3140ec5c`。Production 持久化
Workers Logs 使用 5% head sampling，显式 `invocation_logs=false`，因此不保存正常请求 URL；
当前 Worker 没有输出包含请求体、Header、Cookie、凭据或用户查询的自定义日志。Cloudflare
官方 2026-08-11 文档列出 Free 计划 200,000 log events/day、保留 3 天。

Trace 被显式关闭且不持久化：官方 spans 文档确认自动 Trace 会记录 `url.query` 和
`db.query.text`，而当前目录搜索允许用户查询出现在 URL 参数中，开启采样仍可能泄漏用户
输入。待查询迁移为无敏感 URL 或增加平台级字段脱敏后再单独评估 Trace。实时错误监听只
输出错误事件计数，不打印事件内容。

观察开始快照：近一小时 Cloudflare Analytics 为 194 success、11 clientDisconnected、
0 errors；成功请求 CPU p50 约 2.7ms、p99 约 24.7ms。R2 为 4 个对象、约 592KB；D1 为
327,680 bytes，业务计数仍为 3 / 3 / 4 / 5 / 0，审计 4。

最终观察窗口为 `2026-09-02T04:07:48Z`–`04:39:30Z`，32 个每分钟 `/health` 样本全部
HTTP 200。对应 Cloudflare Analytics 查询得到 78 success、0 errors、8 subrequests；成功
请求 CPU p50 为 3.088ms、p99 为 57.833ms。两段只计数的实时错误监听均为 0。结束时
`/health` 返回数据库正常，D1 为 335,872 bytes，3 分类、3 园区、4 家具、5 库存、0 调拨、
4 审计且外键无违规；Production R2 为 4 个对象、约 592kB。Chat 在 Phase 6 的最终版本上
已完成真实 SSE 和 UI 验收，观察窗口没有 Worker error 或上游错误事件。

Production 当前 version `94e283de-4531-41dd-a6e7-2c0d3140ec5c` 仍只绑定 D1
`furniture-center`、R2 `furniture-center-images` 和 Host `fc.polly.wang`。D1 Time Travel
bookmark 可读取；预上线 SQL、D1-safe 导入包、R2 四对象恢复包和 manifest 仍为 Git 忽略、
mode-`0600`，因此三类回滚材料均保持可用。

## 11. Phase 8 Preview 退役（Production 稳定后，已获条件授权）

- [x] Production smoke 全通过并连续稳定观察至少 30 分钟
- [x] 新的 Preview D1 导出已生成、权限 `0600`、Git 忽略并完成恢复核验
- [x] Preview R2 完整对象包和 manifest 已生成并完成大小/SHA-256 核验
- [x] Production Worker/D1/R2 bindings 与 `fc.polly.wang` 均不引用 Preview 资源
- [x] 删除 Worker `furniture-center-preview`，随后复验 Production
- [x] 删除 D1 `furniture-center-preview`，随后复验 Production
- [x] 删除 R2 `furniture-center-images-preview`，随后完成最终 Production 回归
- [x] 未删除任何 Cloudflare API Token、Tunnel、其他 Worker/Pages 或本地凭据

退役备份目录为 `.migration/preview-retirement-backup-20260902T044056Z/`，整目录 Git 忽略且
文件为 mode-`0600`。Preview D1 导出为 31,558 bytes，包含 17 张应用表；导入一次性远端
D1 后所有表行数与源库一致、外键违规为 0，再导出的 SQL 与原文件 SHA-256 和字节内容均
完全相同。一次性测试 D1 已删除。

Preview R2 删除前远端为 4 个对象、约 592kB。D1 图片元数据列出的 4 个互异 key 与桶对象
数相同；下载包中 4 个 JPEG 的 MIME、字节数、尺寸和 SHA-256 逐项匹配，私有 manifest 已
通过复算。Cloudflare Custom Domain 记录证明 `fc.polly.wang` 只指向 `furniture-center`，
Production version bindings 只指向 Production D1/R2。

退役顺序和回归结果：

1. 删除 Worker 后，部署查询返回 `Worker does not exist`；Production health、version
   bindings 和 Custom Domain 正常。
2. 删除 D1 后，D1 列表只保留 `furniture-center` 与 `polly-chat`；Production 业务计数和
   外键正常。
3. 删除 R2 四对象及桶后，桶列表只保留 Production 与两个原有博客桶；Production R2 仍为
   4 个对象、约 592kB，Viewer 登录、4 个目录结果、4 张图片、真实 JPEG 读取和退出均通过。

本次没有删除 Cloudflare API Token、Tunnel、`polly-chat-proxy`、Pages、本地 Preview/
Production 凭据或其他资源。Preview 若需恢复，必须根据上述私有 D1/R2 包重新创建，不能
原地恢复。

最终只读交叉检查确认 `polly-chat-proxy` 仍存在，Pages 项目 `daitianjun-com` 及其两个
域名仍在，Tunnel `loiter` 状态为 healthy。当前 Wrangler OAuth 对 User API Token 列表返回
403，因此不据此声明 Token 的实时数量；本次执行没有调用任何 Token 删除、撤销或轮换接口。
