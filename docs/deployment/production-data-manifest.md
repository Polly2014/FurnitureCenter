# 家具共享平台 Production 数据清单

**生成时间：** 2026-09-01T15:42:23Z

**状态：** 用户已确认，Phase 3 已按本清单导入并完成远端对账

**目标环境：** Cloudflare Production（D1 `furniture-center`、R2 `furniture-center-images`）

## 1. 权威来源

生产候选数据来自本地、Git 忽略的 `furniture-center.db`。该数据库已经完成 V2
本地 schema 升级，包含园区启停、库存批次关闭状态和不可变调拨记录结构；它保留的是
Preview E2E 操作之前的干净业务基线，不从当前 Preview 数据库整库复制。

实际导入包位于 linked worktree 的
`.migration/production-baseline-v2-d1safe-20260902/`。目录权限为 `0700`，文件权限为
`0600`，全部被 Git 忽略。它与用户确认的
`.migration/production-baseline-v2-20260901/` manifest 和 4 个图片对象完全一致；唯一变化
是移除了 Cloudflare D1 远端导入不接受的显式事务包装。两个包均不提交到仓库。

## 2. 保留与排除规则

保留：

- 三个正式园区：北京、上海、深圳，均为启用状态；
- 三个分类、四个家具记录、五条园区库存分布；
- 四条图片元数据以及四个对应的 JPEG 对象；
- V2 的园区、库存状态和调拨表结构。

排除：

- Preview E2E 园区、`E2E-TRANSFER-20260901` 测试家具及测试调拨记录；
- Preview 的审计事件和库存调整测试记录；
- Preview/Production 的访问凭据、会话、用量计数、幂等记录和 Worker Secrets；
- 任何未经过本清单确认的 Preview 后续业务变更。

本候选基线没有调拨历史。如果用户确认 Preview 中存在必须进入 Production 的真实 V2
业务变更，需要先逐条列入本文件并重新生成候选包，不能直接复制 Preview 全库。

## 3. 表级计数

| 表 | 行数 |
| --- | ---: |
| `categories` | 3 |
| `sites` | 3 |
| `furniture` | 4 |
| `furniture_images` | 4 |
| `inventory` | 5 |
| `transfer_records` | 0 |
| `inventory_adjustments` | 0 |
| `audit_events` | 0 |

## 4. 园区与库存分布

| SKU | 家具 | 园区 | 总量 | 可共享量 | 状态 |
| --- | --- | --- | ---: | ---: | --- |
| `CHR-ARC-01` | 弧背会议椅 | 北京 | 18 | 12 | active |
| `CHR-ARC-01` | 弧背会议椅 | 上海 | 8 | 4 | active |
| `CHR-LNG-04` | 低背休闲椅 | 深圳 | 10 | 7 | active |
| `STG-SHL-02` | 开放式矮柜 | 北京 | 6 | 2 | active |
| `TBL-OAK-06` | 橡木协作桌 | 上海 | 5 | 3 | active |

总计 47 件，其中 28 件当前可共享。这里保留园区维度，不把同一家具在不同园区的数量
合并成一条不可编辑的总数。

## 5. 图片对象清单

| 图片 ID | R2 object key | MIME | 字节数 | 尺寸 |
| --- | --- | --- | ---: | ---: |
| `image-arc-chair` | `furniture/furniture-arc-chair/images/image-arc-chair.jpg` | image/jpeg | 208301 | 1024×1024 |
| `image-lounge-chair` | `furniture/furniture-lounge-chair/images/image-lounge-chair.jpg` | image/jpeg | 96210 | 1200×1802 |
| `image-oak-table` | `furniture/furniture-oak-table/images/image-oak-table.jpg` | image/jpeg | 81012 | 1200×800 |
| `image-shelf` | `furniture/furniture-shelf/images/image-shelf.jpg` | image/jpeg | 206051 | 1200×830 |

四个对象的本地文件大小和内容摘要均与候选 manifest 一致。本文档不记录摘要值；Phase 3
已从 Production R2 逐个回读对象并重新核验 MIME、字节数和 SHA-256，4/4 通过。

## 6. V2 兼容性与本地对账

候选包由当前 `scripts/export_sqlite_for_d1.py` 重新生成，而不是复用旧的 pre-V2
`real-export-20260901-controller` 包。已完成以下只读/本地验证：

- 新建空白本地 SQLite 目标并依次应用 `0001` 至 `0007`；
- 导入新候选 SQL；
- 源数据库、manifest 和目标数据库的八张业务表计数完全一致；
- 园区 4 个 V2 字段、库存 3 个 V2 状态字段和 `transfer_records` 表均存在；
- 五条库存的家具/园区/总量/可共享量/版本逐条一致；
- 外键违规为 0；
- 四张图片的元数据、字节数和内容摘要逐项一致；
- 对账结果 `ok=true`，差异数为 0。

首次远端导入发现旧导出器的显式事务包装与 Cloudflare D1 不兼容。新增回归测试先在旧实现
上失败，移除包装后通过；全部迁移测试通过。修复包随后在一次性 D1 完成 migrations、首次
导入、Time Travel 恢复为空库和重新导入，最终 Production D1 的八张业务表、五条库存和
外键再次与本清单一致。

本地脱敏对账结果位于
`.migration/production-reconciliation-v2-20260901.json`，同样被 Git 忽略。

## 7. 用户确认记录

用户已于 2026-09-02 确认：

1. Production 就从上述 3 园区、4 家具、5 库存位置、4 图片的干净基线开始；
2. Preview 中现有的 E2E 园区、测试家具、测试调拨和审计记录全部不进入 Production；
3. 当前没有必须追加到 Production 的真实调拨历史。

用户随后单独批准了 Phase 3，Production D1/R2 已按本清单导入。本次授权和完成结果仍不
包括开放 workers.dev、绑定域名、删除 Preview 或 push；这些操作继续按 Goal 的阶段门执行。
