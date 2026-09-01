# 家具共享平台 Production 上线验证记录

**目标域名：** `https://fc.polly.wang`

**状态：** Phase 0 已完成，等待 Phase 1 授权

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
| Python | 46 passed |
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
| 4 | 首次部署 Production Worker，暂不绑定正式域名 | Worker `furniture-center` 的受控 `workers.dev` 入口 | 记录新旧 version；代码/binding 故障使用 Worker rollback；Worker 回滚不回退 D1 数据 |
| 5 | 写入 Custom Domain route 并部署同一代码 | `fc.polly.wang` → Worker `furniture-center` Custom Domain | DNS/证书失败时暂停或解除公开入口；不创建临时 A/CNAME、不修改 Zone 全局 SSL |

Token 删除/撤销/轮换、Zone 全局 SSL、WAF、Access 和缓存策略不属于上述授权，必须另行审批。

## 3. Phase 1 存储与 schema（待执行）

- [ ] D1 创建完成并记录非敏感 ID
- [ ] R2 私有桶创建完成
- [ ] `DB`、`IMAGES`、`IMAGES_TRANSFORM` bindings 核对
- [ ] `ENVIRONMENT=production`
- [ ] `MCP_ALLOWED_HOSTS=fc.polly.wang`
- [ ] `0001`–`0007` 按顺序应用且 pending 为 0

## 4. Phase 2 Secrets 与访问凭据（待执行）

- [ ] 仅核对两个 Worker Secret 名称存在，不读取值
- [ ] 三个 Production 凭据分别生成且不复用 Preview
- [ ] 本机凭据文件被 Git 忽略且权限为 `0600`
- [ ] D1 只保存摘要、role 和 label
- [ ] 输出、日志和 Git diff 无敏感值

## 5. Phase 3 数据与恢复（待执行）

- [ ] 用户已确认 `production-data-manifest.md`
- [ ] D1 8 表计数、5 条园区库存分布、外键逐项核对
- [ ] R2 4 个对象的 key、MIME、大小和 SHA-256 逐项核对
- [ ] R2 无公开桶入口，图片只经授权 Worker 路径访问
- [ ] 预上线 D1 导出与 R2 manifest 已保存在 Git 忽略、`0600` 本地位置
- [ ] D1 恢复演练通过并记录当次精确命令/目标
- [ ] R2 重建演练通过并记录当次精确命令/目标

## 6. 切换前回滚记录（Phase 5 硬门，待填写）

| 对象 | 已验证恢复目标 | 精确命令/操作 | 验证结果 |
| --- | --- | --- | --- |
| Worker | 待填写 | 待填写 | 待填写 |
| D1 | 待填写 | 待填写 | 待填写 |
| R2 | 待填写 | 待填写 | 待填写 |

任一行未填写并实际演练，禁止绑定 `fc.polly.wang`。

## 7. Phase 4 Worker 预检（待执行）

- [ ] 使用支持的 Node 版本完成 build、tests、typecheck 和 dry-run
- [ ] 首次 Production 部署版本和上一版本已记录
- [ ] `workers.dev` 上 `/health`、静态资源、登录和授权边界通过
- [ ] Dashboard 逐项核对 Assets、D1、R2、Images、Cron、compatibility、vars、Secret names
- [ ] Production 与 Preview 的 D1/R2 绑定没有交叉

## 8. Phase 5 Custom Domain（待执行）

- [ ] 切换前再次确认 DNS、Custom Domain 和 Workers Route 无冲突
- [ ] `fc.polly.wang` 显示为 Custom Domain，不是 Workers Route
- [ ] Cloudflare 管理的 DNS 和边缘证书可用
- [ ] HTTP 跳转与 HTTPS 正常
- [ ] 未修改 Zone 全局 SSL/TLS 模式

## 9. Phase 6 生产 smoke（待执行）

- [ ] 未登录保护、Viewer、Admin、Chat SSE、图片、MCP、CSRF/Token/Cookie/Origin/rate limit
- [ ] Viewer 对管理接口均为 `403`
- [ ] MCP 仅暴露约定的只读工具并严格校验 Host
- [ ] 桌面与窄窗口旅程通过，控制台无应用错误
- [ ] Preview 入口和 Preview 数据保持不变

## 10. Phase 7 观察与结论（待执行）

- [ ] smoke 后连续观察至少 30 分钟
- [ ] 错误率、CPU、请求量、D1/R2 使用和 Chat 上游错误无阻断项
- [ ] 日志/Trace 不含敏感数据并记录采样与保留策略
- [ ] Worker、D1、R2 回滚材料仍可用
- [ ] Definition of Done 全部通过后再标记 Goal complete

## 11. Phase 8 Preview 退役（Production 稳定后，已获条件授权）

- [ ] Production smoke 全通过并连续稳定观察至少 30 分钟
- [ ] 新的 Preview D1 导出已生成、权限 `0600`、Git 忽略并完成恢复核验
- [ ] Preview R2 完整对象包和 manifest 已生成并完成大小/SHA-256 核验
- [ ] Production Worker/D1/R2 bindings 与 `fc.polly.wang` 均不引用 Preview 资源
- [ ] 删除 Worker `furniture-center-preview`，随后复验 Production
- [ ] 删除 D1 `furniture-center-preview`，随后复验 Production
- [ ] 删除 R2 `furniture-center-images-preview`，随后完成最终 Production 回归
- [ ] 未删除任何 Cloudflare API Token、Tunnel、其他 Worker/Pages 或本地凭据
