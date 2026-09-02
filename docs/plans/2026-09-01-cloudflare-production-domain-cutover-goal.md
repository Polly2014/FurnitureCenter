# FurnitureCenter Cloudflare Production 与 `fc.polly.wang` 切换 Goal

**日期：** 2026-09-01

**状态：** 已完成；Production 上线、稳定观察与 Preview 退役均通过（2026-09-02）

**目标域名：** `https://fc.polly.wang`

**执行原则：** Preview 与 Production 的环境资源和凭据隔离；先完成生产预检，再绑定域名；Token 清理作为独立变更。

## 1. Goal objective

在不影响现有 Preview、`polly-chat-proxy`、`daitianjun.com` 和 `loiter`
Tunnel 的前提下，为家具共享平台建立独立的 Cloudflare Production 环境资源，部署已经在
Preview 验证过的 Worker，绑定 Custom Domain `fc.polly.wang`，并完成 Web、Chat、
图片、管理端和 MCP 的生产验收。

这里的“隔离”指 Worker、D1、R2、应用访问凭据和 Worker Secrets 不跨环境复用；两个
环境仍共享 Cloudflare Account、Zone、套餐额度和部署身份，不能把它们误解为账户级隔离。

这个 Goal 不应只停留在计划或资源创建。完成状态必须包括生产验证证据、回滚点和一份
脱敏的上线记录。

## 2. 已核实的 Cloudflare 基线

以下状态在 2026-09-01 通过 Cloudflare Dashboard、Wrangler、DNS 查询和本地配置只读
核实：

### 2.1 应用与域名

| 类型 | 名称 | 当前入口 | 说明 |
| --- | --- | --- | --- |
| Worker | `furniture-center-preview` | `furniture-center-preview.26716201.workers.dev` | Preview，已通过 V2 验收 |
| Worker | `polly-chat-proxy` | `chat.polly.wang` | 使用 Custom Domain，无 Workers Route |
| Pages | `daitianjun-com` | `daitianjun.com`、`daitianjun-com.pages.dev` | GitHub 连接的静态站点 |

`fc.polly.wang` 当前没有 A、AAAA 或 CNAME 记录，可用于新的 Worker Custom Domain。
Production Worker `furniture-center` 尚未部署，Production D1、R2、Secrets 和访问凭据也
尚未创建。

`polly.wang` 当前 SSL/TLS 模式为 `Full`。绑定 Worker Custom Domain 不需要修改该
Zone 的全局 SSL 模式，也不应为了本次上线改动现有源站的 TLS 行为。

### 2.2 数据与存储

当前 D1：

- `furniture-center-preview`
- `polly-chat`

当前 R2：

- `furniture-center-images-preview`
- `polly-blog-audio`
- `polly-blog-media`

FurnitureCenter Production 不得复用任何 Preview D1、R2、访问 Token 记录或 Worker
Secret。

### 2.3 User API Token 审计

当前有 8 个 User API Tokens。前 5 个由两个重复组构成：

- 3 个同名的 `polly.wang` Cloudflare Tunnel API Token，其中 2 个从未使用；
- 2 个同名的 `baoli.wang` Cloudflare Tunnel API Token，其中 1 个从未使用；
- 两个显示使用记录的 Token 最后使用时间均为 2026-05-30。

账户中只发现一个活动 Tunnel：`loiter`，创建于 2026-05-30，当前通过
`20.51.201.85` 保持多个连接。因此前三个从未使用的 Token 是明确的清理候选，但仅凭
名称和 `Last used` 不能证明它们没有脚本、CI 或人工工作流消费者。

Dashboard 中的这 5 个对象是 **User API Tokens**。`cloudflared` Tunnel connector token
是另一类凭据；除非通过 Token ID、服务配置或审计日志建立了精确映射，否则不得假设它们
是同一个 Secret，也不得用一次 Tunnel 重连作为删除 User API Token 的唯一证据。

另外两个现有 Token 权限过宽：

- `daitianjun-com build token` 覆盖全账户、所有 Zone，并有 24 项权限；
- `Edit Cloudflare Workers` 覆盖全账户、所有 Zone，并有 14 项权限。

Cloudflare Dashboard 建议服务凭据优先使用不绑定个人用户的 Account API Token。Token
治理应另立审批和回滚步骤，不能与 `fc.polly.wang` 首次上线同时执行。

### 2.4 可观测性

`furniture-center-preview` 和 `polly-chat-proxy` 的 Workers Logs 与 Workers Traces 当前
均为 Disabled。生产上线应评估免费额度和数据敏感性后，至少启用适量的错误日志或采样，
但不得记录访问凭据、Cookie、Authorization Header、CopilotX Key 或图片内容。

## 3. 架构决策

### 3.1 FurnitureCenter 继续使用全栈 Worker

FurnitureCenter 同时包含 React 静态资源、REST API、登录会话、CSRF、Chat SSE、MCP、
D1、R2、Images binding 和 Cron。Worker Static Assets 可以在同一 Origin 下提供前端，
避免拆分到 Pages 后新增跨域、Cookie、发布同步和回滚协调成本。

`daitianjun.com` 保持 Pages 是合理的，因为它是 GitHub 连接的静态站点。管理风格一致
不等于强制所有项目使用同一种产品；应统一的是命名、安全边界、凭据权限、域名方式、
验证证据和回滚流程。

### 3.2 域名使用 Worker Custom Domain

沿用 `chat.polly.wang` 的模式，将 `fc.polly.wang` 配置为 `furniture-center` Worker 的
Custom Domain：

- 不手工创建任意 A、AAAA 或 CNAME；
- 不使用 `fc.polly.wang/*` Workers Route；
- 由 Cloudflare 创建和管理所需 DNS 记录与边缘证书；
- Web、API、Images、Chat 和 MCP 共用同一 Origin。

为了让域名状态可由代码审查和重复部署，最终应在 `env.production` 中版本化等价配置：

```jsonc
"routes": [
  { "pattern": "fc.polly.wang", "custom_domain": true }
]
```

只有在 Production Worker、D1、R2、Secrets、凭据和数据已经完成预检后，才允许带该配置
执行生产部署。

## 4. 统一管理规范

### 4.1 资源命名

| 环境 | Worker | D1 | R2 |
| --- | --- | --- | --- |
| Production | `furniture-center` | `furniture-center` | `furniture-center-images` |
| Preview | `furniture-center-preview` | `furniture-center-preview` | `furniture-center-images-preview` |

Production 使用基础名称，非生产环境使用明确后缀。内部 binding 名保持 `DB`、`IMAGES`、
`IMAGES_TRANSFORM` 和 `ASSETS`，避免应用代码出现环境分支。

### 4.2 凭据命名和范围

生产浏览器和 MCP 凭据使用独立 Token 记录：

- `production-browser-viewer`
- `production-admin`
- `production-mcp-client`

明文只写入本机、Git 忽略、权限为 `0600` 的
`.env.production-credentials.local`；D1 仅保存摘要。不得复用
`.env.preview-credentials.local` 或 Preview 的 Token hashes/IDs。

自动部署凭据采用项目级、环境级、最小权限的 Account API Token，例如：

- `furniture-center-deploy-production`
- `furniture-center-deploy-preview`

在没有 CI 的情况下，本机 Wrangler OAuth 可以继续用于人工部署；不要仅为了“统一”而
创建新的长期高权限 Token。

## 5. 执行阶段

### Phase 0：只读预检与逐阶段授权准备

- [x] 只读列出 Phase 1–5 将发生的外部写操作、目标资源名和回滚边界。
- [x] Phase 0 报告通过后，只获取 Phase 1 的明确授权；完成每个阶段后再请求下一阶段授权。
- [x] 重新查询 `fc.polly.wang`，确认没有新 DNS 记录、Custom Domain 或冲突路由。
- [x] 确认本地工作树、目标 commit、Preview 当前版本和已知回滚版本。
- [x] 运行完整自动化测试、前端 build、Worker typecheck/tests 和迁移检查。
- [x] 确认正式数据来源；不得直接复制包含 E2E 测试园区、测试 SKU 或测试调拨记录的
  Preview 数据库。候选来源只能是“已核对的 pre-V2 基线 + 用户明确确认保留的 V2 业务
  变更”，或“从 Preview 导出的逐表清理包”。
- [x] 生成一份脱敏 `production-data-manifest`，列明来源快照、清洗规则、保留/排除范围、
  行数、图片清单和生成时间；用户确认它后，Phase 3 才可执行。
- [x] 创建 `docs/deployment/production-verification.md` 脱敏证据框架并从 Phase 0 起增量
  填写，但不要写入任何 Secret 或 Token 内容/摘要。

### Phase 1：创建独立 Production 存储

- [x] 创建 D1 `furniture-center`，将 ID 写入 `worker/wrangler.jsonc` 的
  `env.production.d1_databases`。
- [x] 创建私有 R2 `furniture-center-images`，写入
  `env.production.r2_buckets`。
- [x] 保持 Images binding `IMAGES_TRANSFORM`。
- [x] 设置 `ENVIRONMENT=production` 和
  `MCP_ALLOWED_HOSTS=fc.polly.wang`；禁止通配符。
- [x] 按文件顺序应用全部 D1 migrations，并确认没有 pending migration。

### Phase 2：配置生产 Secrets 和访问凭据

- [x] 通过私有、Git 忽略且权限为 `0600` 的临时 secrets 文件设置
  `COPILOTX_API_KEY` 和 `SESSION_SIGNING_KEY` Worker Secrets；文件已删除。
- [x] 使用 FurnitureCenter 专用 CopilotX Key；Cloudflare 无法导出现有 Worker
  Secret。如本地没有可用值，暂停并请用户在可信终端输入，不能在聊天中发送。
- [x] 生成独立的 Production viewer、admin、MCP 凭据，只将摘要及 role/label 写入
  Production D1。
- [x] 验证本地凭据文件被 Git 忽略且权限为 `0600`。
- [x] 验证本阶段输出、命令参数、Git diff 和 Wrangler 日志均不含明文或摘要。

Wrangler 4.127.1 已实测拒绝向尚不存在的 Worker 单独写入 Secret。2026-09-02 的真实
尝试进一步确认：`wrangler versions upload --secrets-file` 的 dry-run 虽能通过，但真实上传
会被 Wrangler 拒绝，错误为“不能为尚不存在的 Worker 上传新版本，必须先运行 deploy”。
这意味着“首次创建 Worker 但完全没有 deployment”的路径不可行。

第一次尝试中，CopilotX `furniture-center` 专用 user 已创建为 `role=user`、300 次/日，Key 经
`/v1/models` 返回 HTTP 200 验证；版本上传失败后，同一受控进程立即软删除该用户并删除
临时 Secret 文件。刷新后 CopilotX 活跃用户为 0，Production Worker、version、deployment
仍均不存在，没有残留外部资源。

安全替代路径是在 Production 配置中同时设置 `workers_dev=false` 和
`preview_urls=false`，保持 `routes` 为空，并显式用 `triggers.crons=[]` 覆盖顶层可继承的
定时任务，再用 `wrangler deploy --secrets-file` 原子创建初始 deployment。Cloudflare 会把
首个版本记为 100% deployment allocation，但没有 workers.dev、版本 Preview URL、Route、
Custom Domain 或 Cron 调用入口，因此不会产生公开或定时请求。

用户于 2026-09-02 明确授权该零入口首次部署。执行时重新创建专用 CopilotX
`furniture-center` user（`role=user`、300 次/日），Key 经 `/v1/models` HTTP 200 验证后只
进入 Worker Secret，没有持久化到仓库或本地客户端凭据文件。首次密封 deployment 已成功：
Worker version 为 `c486019a-1e3a-4ee9-ab51-632bc0d56598`，deployment 为
`e49c71df-3406-44ab-be26-46f871eac6cb`。私有临时 Secret 文件已删除。

Cloudflare 远端状态随后逐项核验：`workers.dev` 和 Preview URLs 均为 disabled；Cron
schedule、Workers Route、Custom Domain 均为 0；`fc.polly.wang` 仍无 A、AAAA、CNAME；
基础 workers.dev URL 和该版本的版本化 Preview URL 均不可访问。版本元数据中的
`has_preview=true` 只表示该版本具备 Preview 能力，不代表已公开；Cloudflare 的实际公开
开关 `previews_enabled=false`。Phase 5 之前仍不得绑定 Custom Domain。

Wrangler 4.127.1 源码在 Worker service lookup 返回 not-found 时主动阻止首次
`versions upload`；Cloudflare 官方的
[Deployment management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/#first-upload)
也明确说明首次上传必须使用 C3 或 `wrangler deploy`。不得通过直接调用底层 API 绕过该
首次部署约束。

### Phase 3：导入和核对正式数据

- [x] 从权威源生成新的、经过清理的 Production 导入包，不复用 Preview E2E 行；用户已于
  2026-09-02 确认 3 园区、4 家具、5 库存、4 图片的清单和排除范围。
- [x] 导入分类、园区、家具、库存、图片元数据和需要保留的业务历史。
- [x] 上传 R2 图片并验证 MIME、大小、对象键和 SHA-256。
- [x] 验证 D1 foreign keys、行数、每家具的园区分布和汇总数量。
- [x] 确认 R2 不公开，图片只能通过经过授权的 Worker 路径访问。
- [x] 保存一份本地 Git 忽略、`0600` 的预上线 D1 导出和校验清单。
- [x] 在一次性测试资源上演练 D1 恢复：当前 Wrangler 支持 Time Travel/bookmark，并完成
  “导入 → 恢复为空库 → 重新导入 → 对账”流程。备用方案仍是
  Time Travel/bookmark；如不可用，则验证“导出到新 D1、核对、切换 binding、重新部署”
  流程。把当时可用的精确命令和结果写入脱敏验证记录。
- [x] 为 R2 生成完整对象 manifest，并验证从本地权威图片包重新上传到一次性测试桶后，
  object key、MIME、大小和 SHA-256 全部一致。首次上线窗口不得删除原 R2 对象。
- [x] 在进入 Phase 5 前完成 `production-verification.md` 的“切换前回滚”章节。D1/R2
  已实际演练并填写；Worker 必须等 Phase 4 产生新版本后再执行回滚演练。

首次 Production D1 导入暴露出导出器生成了远端 D1 拒绝的显式事务包装。自动回滚已成功，
Production 回到 0 条业务数据。随后按 TDD 新增回归测试、移除事务包装，并证明新包与用户
确认的 manifest 及 4 个图片对象完全一致，仅 SQL 包装不同。修复包先在一次性 D1 完成真实
远端导入、Time Travel 恢复和重新导入，之后才用于 Production。

Phase 3 收尾结果：Production D1 为 3 分类、3 园区、4 家具、4 图片元数据、5 库存、0
调拨/调整/审计，外键违规为 0，Preview E2E 行为 0；三条访问凭据仍有效。Production R2
四个 JPEG 的 key、MIME、大小和 SHA-256 均通过 API 回读核验，`r2.dev` 关闭且无 Custom
Domain。一次性 D1/R2 资源均已删除；Worker 仍无公网、Preview、Route、Cron 或 Custom
Domain 入口。

### Phase 4：先部署 Production Worker，不绑定正式域名

- [x] 重新构建并核验前端/Worker；启用受控 `workers.dev` 预检入口并部署或继续使用已验证
  的 Production version。
- [x] 将 Phase 2 密封版本记为明确回滚点，并记录 Phase 4 完整 version ID。
- [x] 明确启用并记录 Production `workers.dev` 预检入口；通过它验证 `/health`、静态资源、
  登录/API 鉴权和绑定存在性。Production MCP 的 Host 校验只接受 `fc.polly.wang`，因此
  MCP 验收明确推迟到 Phase 6，不临时放宽 allow-list。
- [x] 执行 `wrangler deploy --dry-run --env production`，并在首次部署后从 Dashboard
  逐项核对 Assets、D1、R2、Images、Cron、compatibility date/flags、vars 和 Secret names；
  不假设所有顶层配置都会被环境自动继承。
- [x] 确认 Production 使用 Production D1/R2，而 Preview 仍指向 Preview D1/R2。
- [x] 验证任何未授权的 API、图片和 MCP 请求均被拒绝。

如果 Production Worker 首次部署没有安全的受控入口，可在同一次受控切换窗口内完成
Phase 4 和 Phase 5，但必须先完成所有静态检查、数据检查和 Secret/Binding 检查。

### Phase 5：绑定 `fc.polly.wang`

- [x] 再次确认 DNS 和 Worker Custom Domain 无冲突。
- [x] 在 `env.production.routes` 加入
  `{ "pattern": "fc.polly.wang", "custom_domain": true }`。
- [x] 部署经过 Phase 4 验证的同一代码版本。
- [x] 在 Dashboard 确认它显示在 `Custom domains`，而不是 `Routes`。
- [x] 确认 Cloudflare 自动生成域名所需 DNS 状态和边缘证书。
- [x] 验证 HTTP 跳转与 HTTPS；不得修改 Zone 全局 SSL/TLS 模式。
- [x] 最多等待 30 分钟让 Custom Domain 状态、DNS 和证书进入可用状态；超时则暂停切换并
  核查域名状态和证书错误，不重复部署、不创建临时 A/CNAME，也不改全局 SSL。

### Phase 6：生产 smoke gate

- [x] 未登录访问显示凭据登录页，且不会泄漏目录数据。
- [x] Viewer 可浏览、搜索、查看地图/详情/图片、使用 Chat、退出登录。
- [x] Viewer 对 Site、Inventory、Transfer 等管理接口收到 `403`。
- [x] Admin 可管理园区与家具，并完成一次可回退或明确标记的生产验收操作。
- [x] Chat SSE 首包和完整响应正常，CopilotX 错误经过脱敏。
- [x] 图片原图、缩略图、弹窗大图、授权边界和 R2 隐私正确。
- [x] MCP 通过独立 Bearer Token 初始化，仅暴露约定的只读工具；Host allow-list 接受
  `fc.polly.wang` 并拒绝伪造 Host。
- [x] 验证 CSRF、无效/过期/撤销 Token、Cookie flags、Origin/CORS 和 rate limit。
- [x] 在桌面和窄窗口分别完成浏览器旅程，控制台无应用错误。
- [x] Preview URL 继续可用，且 Preview 数据没有因生产操作改变。
- [x] 继续完成 `docs/deployment/production-verification.md` 的生产 smoke 章节，仅记录
  时间、版本、资源名、脱敏 ID、计数和测试结果。

### Phase 7：稳定观察和收尾

- [x] smoke gate 后至少连续观察 30 分钟，检查错误率、CPU、请求量、D1/R2 使用量和
  Chat 上游错误。`/health` 非 2xx、核心旅程失败、持续 5xx、数据核对失败或任何敏感信息
  泄漏都阻止完成；数据损坏或泄漏触发立即隔离公开入口。
- [x] 根据免费额度配置不含敏感数据的 Workers Logs/Trace 策略并记录保留边界；启用 5%
  错误/自定义日志采样且关闭 invocation logs，因 Trace 会记录 `url.query` 与
  `db.query.text` 而显式禁用其持久化。
- [x] 确认上一 Worker 版本、预上线 D1 导出和 R2 校验清单仍可用于回滚。
- [x] 保存 `wrangler.jsonc`、Runbook 和脱敏验证记录；可在已授权范围内创建本地 commit，
  但未经明确授权不得 push；不提交任何本地凭据文件。
- [x] 只有所有 Definition of Done 项通过后，才将 Goal 标记为 complete。

最终观察窗口为 `2026-09-02T04:07:48Z`–`04:39:30Z`：32 个每分钟 `/health`
样本全部 HTTP 200。Cloudflare Analytics 在对应窗口记录 78 success、0 errors、8
subrequests，成功请求 CPU p50 为 3.088ms、p99 为 57.833ms；实时错误监听未记录错误事件。
Production D1 保持 3 分类、3 园区、4 家具、5 库存、0 调拨、4 审计且外键无违规，R2
保持 4 个对象、约 592kB。Worker version、D1 Time Travel bookmark 与私有 R2 重建包均
重新核验可用。

### Phase 8：Production 稳定后退役 Preview（已获条件授权）

用户已于 2026-09-01 授权：只有 Production 全量 smoke gate、至少 30 分钟稳定观察以及
Worker/D1/R2 回滚核验全部成功后，才可删除 Preview 资源。这里的 Preview 资源精确限定为：

- Worker `furniture-center-preview`；
- D1 `furniture-center-preview`；
- R2 `furniture-center-images-preview`。

删除前必须生成新的 Preview D1 导出和 R2 完整对象清单/本地恢复包，验证计数、对象大小与
SHA-256，并放在 Git 忽略、权限 `0600` 的本地目录；还要证明 Production bindings 和
`fc.polly.wang` 不引用以上三个 Preview 资源。删除顺序为 Worker → D1 → R2，每一步后重新
检查 Production 健康和资源引用；任一步失败立即停止后续删除。

此授权不包括删除 Preview 本地凭据文件、访问 Token 记录、Cloudflare User/Account API
Token、Tunnel、`polly-chat-proxy`、Pages 项目或其他 Cloudflare 资源。Token 治理仍需独立
授权。删除后的 Preview 云端资源不能原地恢复，只能根据已验证的本地导出和对象包重新创建。

执行结果：新的 Preview 恢复包保存在 Git 忽略、mode-`0600` 的
`.migration/preview-retirement-backup-20260902T044056Z/`。D1 全量导出包含 17 张表，导入
一次性远端 D1 后逐表计数和外键核对通过，再导出与原文件字节完全一致；测试 D1 随后删除。
R2 远端 `object_count=4`，4 个互异对象键与 D1 元数据一一对应，本地文件的 MIME、大小和
SHA-256 全部匹配。证明 `fc.polly.wang` 和 Production version 不引用 Preview 后，已按
Worker → D1 → R2 顺序删除三个精确目标，每一步后的 Production health 与数据检查均通过。
Cloudflare API Token、Tunnel、其他 Worker/Pages、本地凭据均未删除。

## 6. 独立的 Token 治理阶段

这一阶段不得与域名首次切换并行执行，需在 Production 稳定后单独获得删除或轮换授权。

1. 导出只含 User API Token ID、名称、权限、资源范围、创建时间、最后使用时间和状态的
   清单；不读取或记录 Secret。
2. 通过 Token 详情、Cloudflare Audit Logs、本地脚本、CI secrets 名称和部署记录，逐个
   建立 User API Token 的消费者映射；没有证据时标记为 `unknown`，不能猜测。
3. 单独查清 `loiter` 的 connector 安装方式、connector token、服务配置、重启行为和恢复
   路径。除非证明 connector 使用了某个具体 User API Token，否则 Tunnel 重连只证明
   connector 自身可用，不证明 User API Token 可删除。
4. 对需要替换的 User API Token，先创建名称明确、最小权限的新 Account API Token；旧
   Token 保持有效，直到目标脚本/CI/人工工作流使用新 Token 验证通过。
5. 三个从未使用的重复 User API Token 只有在消费者映射确认无依赖后才能撤销或删除；
   两个曾使用的 Token 还必须完成替代工作流验证。
6. 为 `daitianjun-com build token` 和 `Edit Cloudflare Workers` 建立最小权限的 Account
   API Token 替代方案，逐个验证工作流后再撤销旧 Token。
7. `GitHub Actions - Purge Cache` 若仍未找到消费者，作为另一个独立清理候选。

任何撤销失败、Tunnel 断连或部署认证失败都应立即停止后续清理。在旧 Token 尚未撤销时
回切旧配置；Token 一旦撤销或删除，原 Secret 通常不能恢复，只能创建新 Token 并重新
配置消费者，因此不能把“恢复已删除凭据”写入回滚方案，也不进行批量重试。

### 2026-09-02 执行记录

经用户单独确认后，已在 Cloudflare User API Tokens 页面完成本阶段中重复 Tunnel Token
的治理，过程中未读取或记录任何 Token Secret：

- 将仍在使用的两条 Token 分别重命名为
  `cloudflared-admin-polly.wang-local` 和
  `cloudflared-admin-baoli.wang-local`，原有四项权限、Account 范围和对应 Zone 范围均保持
  不变；
- 在删除前、重命名后及删除后，分别使用本机 `cert.pem` 与 `cert.baoli.pem` 执行只读
  `cloudflared tunnel list`，两者均能列出既有 `loiter` Tunnel；
- 逐条删除两条 `polly.wang`、一条 `baoli.wang` 且 `Last used` 为 `-` 的重复 Token；
  每次删除后都重新读取列表，最终 User API Token 数量从 8 条降为 5 条；
- 未修改 `daitianjun-com build token`、`Edit Cloudflare Workers`、
  `GitHub Actions - Purge Cache`、任何 Account API Token、Global API Key、Tunnel、Worker、
  Pages 项目或本地凭据文件；
- 清理后 `fc.polly.wang`、`loiter.polly.wang`、`daitianjun.com` 与
  `daitianjun-com.pages.dev` 均返回 HTTP 200；`chat.polly.wang/v1/messages` 在无凭据请求下
  返回 HTTP 403，证明 `polly-chat-proxy` 路由仍在且鉴权仍生效。

剩余三个 User API Token 的最小权限替换与可能的后续治理仍是独立任务，不能依据本次授权
继续删除或轮换。

## 7. 回滚边界

- Worker rollback 只回退代码版本，不回退 D1 migrations 或业务写入。
- 代码、binding 或运行时故障使用已记录的 Worker version 回退；DNS、证书或 Custom
  Domain 状态故障不通过回退代码处理，应保持数据不变并暂停/解除公开入口后排查域名状态。
- 不通过创建临时 A/CNAME 绕过 Custom Domain 故障。
- 数据故障必须使用 Phase 3 已演练的方案：如果当前 D1 Time Travel/bookmark 已验证，按
  记录的精确命令恢复；否则从预上线导出恢复到新 D1，完成外键/行数核对后切换 binding
  并部署。不能全库删除或对现库执行未经核对的覆盖导入。
- R2 对象删除不是普通回滚步骤；先隔离错误元数据并保留对象。需要恢复时从权威图片包
  写入新桶或缺失对象，按 manifest 核对后切换 R2 binding；不得凭文件名猜测对象。
- Production 绑定域名前，`production-verification.md` 必须记录当次可执行的 Worker
  version rollback、D1 恢复和 R2 重建/切换命令、目标 ID 及验证结果。缺少其中任一项即
  阻止切换。
- Preview 是验证环境，不是 Production 的自动故障转移目标。

## 8. Definition of Done

只有同时满足以下条件，Goal 才算完成：

- `https://fc.polly.wang` 由 `furniture-center` Worker Custom Domain 提供服务，证书有效；
- Production 和 Preview 的 Worker、D1、R2、Secrets 和访问凭据不交叉复用；
- 正式数据和图片完成计数、外键、园区分布及 SHA-256 核对；
- Viewer、Admin、Chat、Images、MCP、安全边界和窄屏布局全部通过生产 smoke gate；
- 未发现凭据、Cookie、Authorization、CopilotX Key 或 Token 摘要泄漏；
- `polly-chat-proxy`、`daitianjun-com`、`loiter` 和现有 Zone TLS 行为未受影响；
- 已在非生产数据上演练并记录可执行的 Worker、D1 和 R2 回滚步骤；
- `docs/deployment/production-verification.md` 含脱敏证据并与实际 Worker version 对应；
- Token 清理没有被误报为本次域名上线的完成条件，且未经独立授权没有删除任何 Token。
- 若已执行 Preview 退役，三个精确目标均已完成可恢复备份、引用隔离、逐项删除和
  Production 回归验证；不得把 Preview 删除作为 Production smoke 的前置条件。

## 9. 审批门

执行代理必须在以下外部写操作前确认用户授权范围；一次授权不能自动扩展到下一阶段：

1. 创建 Production D1/R2；
2. 写入 Production Secrets 和访问凭据；
3. 导入正式数据或上传图片；
4. 首次部署 Production Worker；
5. 创建 `fc.polly.wang` Custom Domain；
6. 删除、撤销或轮换任何 Cloudflare Token；
7. 修改 Zone 全局 SSL、DNS、WAF、Access 或缓存策略。

如果用户只授权“部署和绑定 `fc.polly.wang`”，不得据此删除旧 Token 或修改其他应用。

## 10. 建议的 Goal 启动语句

```text
请执行 docs/plans/2026-09-01-cloudflare-production-domain-cutover-goal.md，
持续推进到 Definition of Done。严格隔离 Preview 与 Production；任何 Secret 不得输出或
提交。先完成 Phase 0 并报告生产数据来源和外部写操作清单，获得我的明确授权后再创建
Cloudflare Production 资源、部署或绑定 fc.polly.wang。Token 治理作为独立阶段，未经
单独授权不得删除或轮换任何 Token。
```

## 11. 关联文档

- `docs/plans/2026-08-31-cloudflare-production-auth-mcp-design.md`
- `docs/plans/2026-08-31-cloudflare-production-implementation-plan.md`
- `docs/plans/2026-09-01-furniture-sharing-platform-v2-goal-design.md`
- `docs/deployment/cloudflare-runbook.md`
- `docs/deployment/production-data-manifest.md`
- `docs/deployment/production-verification.md`
