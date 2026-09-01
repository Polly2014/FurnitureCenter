# 家具共享平台 V2：园区、调拨下架与品牌统一

> 状态：下一次 Goal 的需求与设计输入。本文件只定义目标、业务语义和验收标准，不代表功能已经实现。

## 1. Goal

将现有以“跨园区库存搬运”为核心的 FurnitureCenter，调整为真正的“闲置家具共享平台”：各园区发布可共享物品，其他园区领取后形成不可篡改的调拨记录，原共享批次随即下架，目标园区不会自动形成新的共享库存。

本 Goal 同时完成三项配套能力：

1. 管理员可以新增、编辑园区（Site）。
2. 管理员可以查询每次调拨的来源、去向、数量、操作人、原因和时间。
3. 全系统面向用户的产品名称统一为“家具共享平台”。

## 2. 当前实现与需求差异

当前 Worker 的 `InventoryService.transfer` 和 `D1InventoryRepository.transfer` 实现的是传统库存搬运：调拨数量从来源库存扣减，并在目标园区新增或累加同等数量。调拨痕迹只分散在 `inventory_adjustments` 和 `audit_events`，Web 管理端没有独立的调拨记录页面。园区来自只读 metadata，当前没有园区管理 API 或 UI。

新需求要求替换这套业务语义，而不是在现有算法上增加一个显示页面。

## 3. 核心业务语义

### 3.1 “调拨”代表领取共享物品并下架

示例：北京园区 A 当前发布 10 件家具，上海园区 B 领取其中 3 件。

| 项目 | 操作前 | 操作后 |
| --- | ---: | ---: |
| A 在共享目录中的可用量 | 10 | 0 |
| B 在共享目录中的可用量 | 原值 | 原值，不新增 |
| 本次实际调拨量 | - | 3 |
| 未继续共享的余量 | - | 7 |

因此该操作的准确含义是“一次性关闭来源共享批次”：

- 记录实际调拨数量 `3`。
- 将来源批次全部 `10` 件从共享目录下架。
- 明确记录剩余未继续共享数量 `7`，保证审计可解释。
- 不创建或更新 B 的共享库存；B 若以后希望再次共享，必须主动发布一个新的共享批次。

调拨数量必须是正整数且不能超过来源批次当前可用量。来源园区和目标园区不能相同。一次成功调拨后，同一来源批次不能再次调拨。

### 3.2 目录数量不是组织资产总账

系统中的数量应被定义为“当前公开共享的数量”，而不是园区真实资产总量。调拨后归零表示该批物品不再公开共享，并不表示所有未领取物品在物理世界中消失。

所有目录、地图、Chat 和 MCP 查询默认只返回仍处于共享状态且可用量大于 0 的批次。

## 4. 推荐数据模型

### 4.1 园区 `sites`

在现有字段基础上增加生命周期和并发字段：

- `id`：稳定主键，不随名称或编码修改。
- `code`：园区短编码，全局唯一。
- `name`：园区名称。
- `city`：城市。
- `latitude`、`longitude`：地图坐标。
- `is_active`：是否允许新建共享批次和作为调拨目标。
- `version`：乐观并发版本。
- `created_at`、`updated_at`。

园区一旦被家具、库存或调拨记录引用，不允许物理删除。停用园区只会阻止新业务，不影响历史查询。编辑园区后，旧调拨记录仍使用操作发生时保存的名称和编码快照。

### 4.2 共享批次

为降低迁移风险，下一 Goal 可以继续使用现有 `inventory` 表，但必须将其明确解释为“园区共享批次”，并增加：

- `status`：`active`、`allocated`、`withdrawn`。
- `closed_at`、`closed_reason`。

推荐保留 `quantity_total` 作为该批次最初发布数量，`quantity_available` 表示当前仍公开共享的数量。新语义调拨完成后：

- `quantity_total` 保留原始值 10，便于追溯。
- `quantity_available` 原子更新为 0。
- `status` 更新为 `allocated`。

未来若进一步重构，可将表名改为 `share_listings`；本 Goal 不需要为了命名而进行高风险全量重写。

### 4.3 一等调拨记录 `transfer_records`

新增不可变业务表，不再依赖通用审计 JSON 拼装历史：

- `id`
- `furniture_id`
- `source_inventory_id`
- `source_site_id`、`source_site_code_snapshot`、`source_site_name_snapshot`
- `destination_site_id`、`destination_site_code_snapshot`、`destination_site_name_snapshot`
- `listed_quantity_before`
- `transferred_quantity`
- `unlisted_remainder`，计算为 `listed_quantity_before - transferred_quantity`
- `reason`
- `actor_token_id` 或可展示的操作人标签快照
- `created_at`

调拨记录只允许新增和查询，不允许编辑或删除。需要纠错时应另建冲正记录，而不是覆盖历史。

`inventory_adjustments` 仍保留底层数量审计，写入一条 `allocation_close`：`delta_total = 0`、`delta_available = -10`，并通过 `transfer_id` 关联一等调拨记录。目标园区不再写入 `transfer_in`，也不再创建目标库存行。

## 5. 后端与 API

### 5.1 园区管理

新增 Admin + CSRF 保护的接口：

- `GET /api/admin/sites`：包含启用和停用园区。
- `POST /api/admin/sites`：新增园区。
- `PATCH /api/admin/sites/:id`：编辑名称、编码、城市、坐标、启停状态，并校验 `version`。

公开 `GET /api/metadata` 默认只返回启用园区，确保筛选器和调拨目标不会出现已停用园区。

校验要求：编码和名称非空、编码唯一、纬度范围 `[-90, 90]`、经度范围 `[-180, 180]`，并发修改返回 `409`。

### 5.2 调拨并下架

保留现有入口 `POST /api/admin/inventory/:id/transfers`，但改变语义和请求体：

```json
{
  "destination_site_id": "site-shanghai",
  "quantity": 3,
  "reason": "上海园区会议室领取",
  "expected_source_version": 4
}
```

删除 `expected_destination_version`，因为目标共享库存不再变化。响应应返回完整调拨记录、来源批次的新状态以及目录下架结果。

整个操作必须在同一个 D1 batch/事务边界中完成：校验来源版本、创建 `transfer_records`、关闭来源批次、写数量审计和通用审计、保存幂等响应。重复的 `Idempotency-Key` 只能重放同一结果；并发领取只能有一个成功，其余返回 `409`。

新增查询接口：

- `GET /api/admin/transfers`
- 支持按家具、来源园区、目标园区和时间范围筛选，并使用游标分页。
- 默认按 `created_at DESC, id DESC` 排序。

## 6. Web 端交互

### 6.1 数据管理导航

将数据管理区分为三个清晰入口：

1. **共享物品**：现有家具、图片和共享批次管理。
2. **园区管理**：新增和编辑园区，展示启用状态与坐标。
3. **调拨记录**：独立历史列表与筛选器。

园区编辑表单应提供编码、名称、城市、纬度、经度和启用状态。保存后刷新 metadata、目录筛选器和地图，不要求重新登录。

### 6.2 调拨确认

现有“调拨”表单应改为二次确认式操作，提交前明确展示：

> 当前共享 10 件，本次调拨 3 件。确认后，该共享批次将全部下架；目标园区不会自动入库，剩余 7 件也不会继续出现在共享目录中。

主按钮文案使用“确认调拨并下架”，避免管理员误认为只是移动部分库存。成功后关闭编辑面板、刷新目录，并提供“查看调拨记录”入口。

### 6.3 调拨记录页面

列表至少展示：时间、家具名称/编号、来源园区、目标园区、实际调拨数量、下架前共享数量、未继续共享数量、操作人和原因。点击一条记录可查看不可编辑的完整详情。

## 7. 品牌与文案统一

所有面向用户的产品称谓统一为“家具共享平台”，包括：

- 登录页品牌、副标题和进入按钮。
- 顶部品牌、浏览器标题和页面 metadata。
- Chat 标题、消息发送者和加载状态。
- Chat 系统提示词中的身份描述。
- MCP server 的展示名称和错误文案。
- README 与部署文档中新增加的用户可见说明。

英文展示统一建议使用 `FURNITURE SHARING PLATFORM`。代码包名、仓库名、Worker 名、数据库名和历史文档中的 `FurnitureCenter` 不要求迁移，以免产生没有业务价值的部署风险。

## 8. MCP 边界

MCP 继续保持只读：

- `list_sites` 只返回启用园区。
- 家具查询只返回 `status = active` 且 `quantity_available > 0` 的共享批次。
- 调拨下架后，MCP 查询结果应与 Web 目录同步消失。
- 本 Goal 不向普通 MCP viewer token 暴露调拨历史，也不增加园区或调拨写工具。若未来需要，应新增独立 scope，而不是复用当前 viewer 权限。

## 9. 迁移与兼容

新增 D1 migration，禁止直接修改旧 migration：

1. 扩展 `sites` 和 `inventory`。
2. 创建 `transfer_records`、唯一约束和查询索引。
3. 将 `quantity_available > 0` 的现有行回填为 `active`；其余回填为 `withdrawn`，关闭原因标记为 migration。
4. 现有旧语义 `transfer_out/transfer_in` 记录不可伪装成新语义。若需要展示，回填为带 `legacy_stock_move` 标识的历史记录；Preview 测试数据也可以在保留导出证据后重建。
5. Preview 验证通过前不触碰生产 D1/R2 或 `fc.polly.wang`。

## 10. 错误处理与安全

- 所有写接口仅限 admin session，要求 CSRF 和 `Idempotency-Key`。
- 同园区调拨、停用园区、零或负数、数量超过来源共享量均返回 `422`。
- 来源批次不存在返回 `404`；来源已关闭或版本变化返回 `409`。
- 任一步骤失败时不能留下“已下架但无调拨记录”或“有记录但仍在目录”的部分状态。
- 审计响应不得返回访问凭据、token hash 或 Worker Secret。

## 11. 测试要求

### Worker

- 先写失败测试证明当前 A 减 3、B 加 3 的旧行为不满足新语义。
- 覆盖 A=10、调拨=3 后 A 可用量=0、B 不变、记录量=3、余量=7。
- 覆盖目标没有库存行和已有库存行两种情况，均不得创建或更新目标库存。
- 覆盖幂等重放、并发版本冲突、停用园区、非法坐标和园区编码冲突。
- 覆盖调拨记录筛选、排序、分页及 admin/viewer 权限。

### Frontend

- 园区新增、编辑、停用后的 metadata 刷新。
- 调拨风险提示中的四个关键数值和“目标不入库”文案。
- 调拨成功后的目录下架与历史入口。
- 调拨记录列表、筛选和空状态。
- 对用户可见字符串进行有范围的品牌回归检查。

### 端到端 Preview

- 新建一个测试园区并编辑坐标，地图位置同步更新。
- 建立 A=10 的共享批次，调拨 3 到 B，验证目录、详情、地图、Chat 和 MCP 均不再显示该来源批次。
- 验证 B 的原有数量完全不变。
- 验证调拨记录显示 A、B、3、10、7、原因、操作人和时间。
- 验证无权限用户无法访问园区管理和调拨记录。

## 12. Definition of Done

- 园区可新增、编辑和停用，引用历史不被破坏。
- 调拨语义符合“领取后整批下架”，目标园区不自动入库。
- 每次调拨形成可检索、不可编辑的一等记录。
- Web、Chat、地图和 MCP 对共享可用量保持一致。
- 所有用户可见产品称谓统一为“家具共享平台”。
- Worker、Frontend 和迁移测试全部通过，无新增 lint/typecheck 错误。
- 独立 Cloudflare Preview 完成真实登录和端到端验收，并保留回滚版本。
- 更新 README、API/数据模型文档和 Cloudflare runbook。
- 未经单独授权，不部署生产环境、不绑定 `fc.polly.wang`。

## 13. 下一次 Goal 建议提示词

> 按 `docs/plans/2026-09-01-furniture-sharing-platform-v2-goal-design.md` 完成家具共享平台 V2。严格使用测试优先方式，将调拨改为“来源共享批次整批下架、目标园区不入库、保留一等调拨记录”，实现园区新增/编辑/停用、调拨历史页面、全系统品牌统一以及 Web/Chat/地图/MCP 一致性。完成全部测试、迁移和独立 Cloudflare Preview 端到端验证；未经授权不要部署生产或修改 `fc.polly.wang`。
