# Furniture Sharing Platform V2 Implementation Plan

> **Status (2026-09-01):** Implemented on `codex/cloudflare-production` and verified in the isolated Cloudflare Preview. The checkboxes below preserve the original test-first execution sequence; authoritative live evidence is recorded in `docs/deployment/cloudflare-runbook.md`. Production deployment and the `fc.polly.wang` binding remain separately gated.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver site administration, immutable allocation history, whole-listing close semantics, and consistent “家具共享平台” branding across the deployed Web, Chat, map, and MCP surfaces.

**Architecture:** Extend the existing Cloudflare D1 schema with site lifecycle fields, inventory listing status, and a first-class `transfer_records` table. Keep write logic behind application services and repositories, expose authenticated Hono routes, then add typed React API clients and focused admin views. Catalog, Chat, map, and MCP continue sharing `CatalogService`, so filtering active listings there establishes one public truth.

**Tech Stack:** Cloudflare Workers, Hono, D1/SQLite migrations, TypeScript, Vitest Workers pool, React 19, Testing Library, Vite, MCP SDK 2.0.

**Spec:** `docs/plans/2026-09-01-furniture-sharing-platform-v2-goal-design.md`

## Global Constraints

- A transfer closes the entire source shared listing: preserve `quantity_total`, set `quantity_available` to `0`, and set `status` to `allocated`.
- The destination site's inventory row must never be created, incremented, or otherwise changed by a transfer.
- Every successful transfer must atomically persist an immutable record with source/destination snapshots, listed quantity, transferred quantity, unlisted remainder, reason, actor, and time.
- Public catalog, Chat, map, and MCP results include only `status = active`, `quantity_available > 0` listings; public metadata includes only active sites.
- All writes require admin session, CSRF protection, and idempotency where the existing route family requires it.
- User-facing product naming is “家具共享平台”; internal repository, package, Worker, and database names remain stable.
- Preview must pass before any production D1/R2/domain change; production deployment requires separate authorization.

---

### Task 1: D1 Schema and Site Administration

**Files:**
- Create: `worker/migrations/0007_sharing_platform_v2.sql`
- Create: `worker/src/sites/repository.ts`
- Create: `worker/src/sites/service.ts`
- Create: `worker/src/sites/routes.ts`
- Modify: `worker/src/catalog/models.ts`
- Modify: `worker/src/catalog/repository.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/test/helpers.ts`
- Modify: `worker/test/schema.test.ts`
- Create: `worker/test/sites.test.ts`

**Interfaces:**
- Produces `Site` with `is_active`, `version`, `created_at`, and `updated_at`.
- Produces `GET /api/admin/sites`, `POST /api/admin/sites`, and `PATCH /api/admin/sites/:id`.
- `SiteService.create(input, actor)` and `SiteService.update(id, input, actor)` validate code/name/city, coordinate ranges, uniqueness, lifecycle, and optimistic version.

- [ ] **Step 1: Write failing migration and route tests**

```ts
expect(tableNames).toContain('transfer_records')
expect(siteColumns).toEqual(expect.arrayContaining(['is_active', 'version', 'created_at', 'updated_at']))
expect(inventoryColumns).toEqual(expect.arrayContaining(['status', 'closed_at', 'closed_reason']))

expect(await createResponse.json()).toMatchObject({
  code: 'GZ', name: '广州园区', is_active: true, version: 1,
})
expect(updateResponse.status).toBe(200)
expect(staleUpdateResponse.status).toBe(409)
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd worker && npm test -- test/schema.test.ts test/sites.test.ts`

Expected: failures because migration 0007 and site routes do not exist.

- [ ] **Step 3: Add migration and minimal site service/repository/routes**

```ts
export type SaveSiteInput = {
  code: string; name: string; city: string
  latitude: number; longitude: number; isActive: boolean
}

app.get('/api/admin/sites', requireRole('admin'), listSites)
app.post('/api/admin/sites', requireRole('admin'), requireCsrf(), createSite)
app.patch('/api/admin/sites/:id', requireRole('admin'), requireCsrf(), updateSite)
```

Migration 0007 adds site lifecycle fields, listing status fields, `transfer_records`, foreign keys, and transfer query indexes without modifying old migrations.

- [ ] **Step 4: Run focused Worker tests and typecheck**

Run: `cd worker && npm test -- test/schema.test.ts test/sites.test.ts && npm run typecheck`

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit this independently testable slice**

```bash
git add worker/migrations/0007_sharing_platform_v2.sql worker/src/sites worker/src/catalog/models.ts worker/src/catalog/repository.ts worker/src/index.ts worker/test/helpers.ts worker/test/schema.test.ts worker/test/sites.test.ts
git commit -m "feat: add site administration lifecycle"
```

### Task 2: Whole-Listing Transfer and Immutable History

**Files:**
- Modify: `worker/src/inventory/repository.ts`
- Modify: `worker/src/inventory/service.ts`
- Modify: `worker/src/inventory/routes.ts`
- Modify: `worker/test/inventory.test.ts`

**Interfaces:**
- `TransferInventoryCommand` removes `expectedDestinationVersion`.
- `InventoryService.transfer(command)` returns `{ transfer, source }`.
- `D1InventoryRepository.listTransfers(filters)` returns cursor-paginated immutable records.
- Produces `GET /api/admin/transfers?furniture_id=&source_site_id=&destination_site_id=&from=&to=&limit=&cursor=`.

- [ ] **Step 1: Replace legacy transfer expectations with failing V2 behavior tests**

```ts
expect(sourceAfter).toMatchObject({
  quantity_total: 18, quantity_available: 0, status: 'allocated', version: 2,
})
expect(destinationAfter).toEqual(destinationBefore)
expect(record).toMatchObject({
  listed_quantity_before: 12,
  transferred_quantity: 3,
  unlisted_remainder: 9,
})
```

Also cover missing destination inventory, inactive destination, same-site/zero/excess transfer, stale source version, idempotent replay, concurrent close, history permissions, filters, order, and cursor pagination.

- [ ] **Step 2: Run inventory tests and verify RED**

Run: `cd worker && npm test -- test/inventory.test.ts`

Expected: old source decrement/destination increment response contradicts V2 assertions.

- [ ] **Step 3: Implement atomic close and transfer record persistence**

```ts
const response = {
  transfer: {
    id: transferId,
    listed_quantity_before: source.quantity_available,
    transferred_quantity: command.quantity,
    unlisted_remainder: source.quantity_available - command.quantity,
  },
  source: {
    inventory_id: source.id,
    quantity_total: source.quantity_total,
    quantity_available: 0,
    status: 'allocated',
    version: source.version + 1,
  },
}
```

The D1 batch must insert the idempotency response, close the version-matched source row, insert `transfer_records`, write one `allocation_close` adjustment with `delta_total=0` and `delta_available=-listed_quantity_before`, and create the audit event. No destination inventory statement is permitted.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `cd worker && npm test -- test/inventory.test.ts && npm run typecheck`

Expected: all V2 inventory and transfer-history tests pass.

- [ ] **Step 5: Commit transfer semantics**

```bash
git add worker/src/inventory worker/test/inventory.test.ts
git commit -m "feat: close shared listings on transfer"
```

### Task 3: Public Catalog, Chat, Map, and MCP Consistency

**Files:**
- Modify: `worker/src/catalog/repository.ts`
- Modify: `worker/src/catalog/service.ts`
- Modify: `worker/src/mcp/server.ts`
- Modify: `worker/test/catalog-contract.test.ts`
- Modify: `worker/test/chat.test.ts`
- Modify: `worker/test/mcp.test.ts`

**Interfaces:**
- `D1CatalogRepository.search()` and `.get()` hydrate only active listings with positive availability.
- `D1CatalogRepository.metadata()` returns only active sites.
- MCP `list_sites`, `search_furniture`, and `get_furniture` expose the same filtered application result.

- [ ] **Step 1: Add failing cross-surface visibility tests**

```ts
await env.DB.prepare(
  "UPDATE inventory SET status='allocated', quantity_available=0 WHERE id=?",
).bind('inventory-arc-bj').run()
expect(catalogItem.inventory).not.toContainEqual(expect.objectContaining({ id: 'inventory-arc-bj' }))
expect(mcpItem.inventory).not.toContainEqual(expect.objectContaining({ site_id: 'site-beijing' }))
expect((await metadata.json()).sites).not.toContainEqual(expect.objectContaining({ is_active: false }))
```

- [ ] **Step 2: Run focused contract tests and verify RED**

Run: `cd worker && npm test -- test/catalog-contract.test.ts test/chat.test.ts test/mcp.test.ts`

Expected: closed inventory or inactive sites remain visible before implementation.

- [ ] **Step 3: Apply filtering in the shared repository and update MCP identity**

```sql
AND inventory.status = 'active'
AND inventory.quantity_available > 0
```

Use MCP display name `家具共享平台` and sanitize user-visible error messages to the new product name.

- [ ] **Step 4: Run focused tests and full Worker suite**

Run: `cd worker && npm test -- test/catalog-contract.test.ts test/chat.test.ts test/mcp.test.ts && npm test && npm run typecheck`

Expected: all Worker tests pass.

- [ ] **Step 5: Commit consistency slice**

```bash
git add worker/src/catalog worker/src/mcp/server.ts worker/test/catalog-contract.test.ts worker/test/chat.test.ts worker/test/mcp.test.ts
git commit -m "feat: hide closed listings across query surfaces"
```

### Task 4: Typed Frontend API and Admin Navigation

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/api.test.ts`
- Create: `frontend/src/features/admin/SiteManager.tsx`
- Create: `frontend/src/features/admin/TransferHistory.tsx`
- Modify: `frontend/src/features/admin/AdminView.tsx`
- Modify: `frontend/src/features/admin/AdminView.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`

**Interfaces:**
- `getAdminSites()`, `createSite(input)`, `updateSite(id, input)`.
- `getTransfers(filters)` returns `{ items: TransferRecord[]; next_cursor: string | null }`.
- Admin navigation exposes “共享物品”, “园区管理”, and “调拨记录”.
- Successful site writes refresh metadata without requiring re-login.

- [ ] **Step 1: Add failing API and component behavior tests**

```ts
expect(fetchMock).toHaveBeenCalledWith('/api/admin/sites/site-beijing',
  expect.objectContaining({ method: 'PATCH' }))
expect(screen.getByRole('button', { name: '园区管理' })).toBeInTheDocument()
expect(screen.getByRole('button', { name: '调拨记录' })).toBeInTheDocument()
```

The component tests create a site, edit its coordinates/state with `expected_version`, refresh metadata, filter transfer history, and render the 10/3/7 quantities distinctly.

- [ ] **Step 2: Run frontend tests and verify RED**

Run: `cd frontend && npm test -- src/api.test.ts src/features/admin/AdminView.test.tsx src/App.test.tsx`

Expected: missing functions, types, and navigation cause failures.

- [ ] **Step 3: Implement typed clients and focused admin components**

```ts
export type TransferRecord = {
  id: string
  furniture_id: string
  furniture_name: string
  source_site_name: string
  destination_site_name: string
  listed_quantity_before: number
  transferred_quantity: number
  unlisted_remainder: number
  reason: string
  actor_label: string
  created_at: string
}
```

Use the existing refined, low-radius visual language. Make site state, coordinate fields, irreversible transfer history, filters, loading, error, and empty states clear and accessible.

- [ ] **Step 4: Run focused tests, lint, and build**

Run: `cd frontend && npm test -- src/api.test.ts src/features/admin/AdminView.test.tsx src/App.test.tsx && npm run lint && npm run build`

Expected: tests, lint, TypeScript, and Vite build exit 0.

- [ ] **Step 5: Commit admin navigation slice**

```bash
git add frontend/src/types.ts frontend/src/api.ts frontend/src/api.test.ts frontend/src/features/admin/SiteManager.tsx frontend/src/features/admin/TransferHistory.tsx frontend/src/features/admin/AdminView.tsx frontend/src/features/admin/AdminView.test.tsx frontend/src/App.tsx frontend/src/App.test.tsx
git commit -m "feat: manage sites and transfer history"
```

### Task 5: Explicit Transfer-and-Unlist Confirmation

**Files:**
- Modify: `frontend/src/features/admin/InventoryPositions.tsx`
- Modify: `frontend/src/features/admin/AdminView.test.tsx`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/api.test.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- `InventoryTransferInput` contains destination, quantity, reason, and source version only.
- Confirmation copy derives listed, transferred, and unlisted values from the currently selected source listing.
- Primary action is “确认调拨并下架”; on success the listing disappears and a “查看调拨记录” entry is available.

- [ ] **Step 1: Write failing confirmation and payload tests**

```ts
expect(within(form).getByText(/当前共享 10 件/)).toBeInTheDocument()
expect(within(form).getByText(/剩余 7 件也不会继续/)).toBeInTheDocument()
expect(onTransfer).toHaveBeenCalledWith('inventory-a', {
  destination_site_id: 'site-b', quantity: 3, reason: '会议室领取', expected_source_version: 4,
})
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd frontend && npm test -- src/features/admin/AdminView.test.tsx src/api.test.ts`

Expected: legacy destination version and generic confirmation contradict V2.

- [ ] **Step 3: Implement the exact irreversible-action interaction**

The form shows source site, destination, current shared quantity, requested quantity, computed remainder, and explicit destination-no-inventory copy. Disable submission until the quantity is positive and within the current availability.

- [ ] **Step 4: Run focused and full frontend verification**

Run: `cd frontend && npm test && npm run lint && npm run build`

Expected: all frontend checks exit 0.

- [ ] **Step 5: Commit interaction slice without unrelated responsive drawer files unless they are now required and verified**

```bash
git add frontend/src/features/admin/InventoryPositions.tsx frontend/src/features/admin/AdminView.test.tsx frontend/src/types.ts frontend/src/api.ts frontend/src/api.test.ts frontend/src/App.tsx frontend/src/App.css
git commit -m "feat: confirm transfer and listing closure"
```

### Task 6: Product Branding and Durable Operations Documentation

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/src/features/auth/AuthGate.tsx`
- Modify: `frontend/src/features/auth/AuthGate.test.tsx`
- Modify: `frontend/src/features/query/ChatWorkspace.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`
- Modify: `mcp_server/server.py`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/deployment/cloudflare-runbook.md`
- Modify: `scripts/export_sqlite_for_d1.py`
- Modify: `tests/test_cloudflare_migration.py`
- Modify: `tests/test_local_schema_migration.py`

**Interfaces:**
- User-visible title and product identity are `家具共享平台` / `FURNITURE SHARING PLATFORM`.
- Offline SQLite-to-D1 export carries the new site/listing fields and transfer records without leaking credentials.
- Runbook documents migration order, preview verification, rollback, and production prohibition without separate approval.

- [ ] **Step 1: Add failing behavior/contract tests for branding and migration export**

```ts
expect(screen.getByText('家具共享平台')).toBeInTheDocument()
expect(screen.getByRole('button', { name: '进入家具共享平台' })).toBeInTheDocument()
```

Python migration tests execute the exporter on a controlled V2 SQLite fixture and assert the resulting SQL rows and manifest counts for sites, inventory state, and transfer records.

- [ ] **Step 2: Run tests and verify RED**

Run: `cd frontend && npm test -- src/features/auth/AuthGate.test.tsx src/App.test.tsx`

Run: `.venv/bin/python -m pytest tests/test_cloudflare_migration.py tests/test_local_schema_migration.py -q -W error`

Expected: old name and legacy export schema fail the new assertions.

- [ ] **Step 3: Update user-visible copy, migration tooling, and runbook**

Keep internal identifiers such as package names, repository name, environment variables, and Worker resource names unchanged.

- [ ] **Step 4: Run frontend and Python validation**

Run: `cd frontend && npm test && npm run lint && npm run build`

Run: `.venv/bin/python -m pytest tests -q -W error && .venv/bin/ruff check . --exclude .venv`

Expected: all checks exit 0.

- [ ] **Step 5: Commit branding and operational documentation**

```bash
git add frontend/index.html frontend/src/features/auth frontend/src/features/query/ChatWorkspace.tsx frontend/src/App.tsx frontend/src/App.test.tsx mcp_server/server.py README.md CLAUDE.md docs/deployment/cloudflare-runbook.md scripts/export_sqlite_for_d1.py tests/test_cloudflare_migration.py tests/test_local_schema_migration.py
git commit -m "refactor: adopt furniture sharing platform identity"
```

### Task 7: Full Verification and Cloudflare Preview

**Files:**
- Modify only if evidence reveals a covered defect.
- Record validation evidence in: `docs/deployment/cloudflare-runbook.md` or a dated validation note linked from it.

**Interfaces:**
- Preview evidence proves site create/edit, A=10 transfer 3 to B, A hidden, B unchanged, 10/3/7 history, and catalog/Chat/map/MCP synchronization.

- [ ] **Step 1: Run complete local verification from fresh commands**

```bash
cd worker && npm test && npm run typecheck
cd ../frontend && npm test && npm run lint && npm run build
cd .. && .venv/bin/python -m pytest tests -q -W error
.venv/bin/ruff check . --exclude .venv
git diff --check
```

- [ ] **Step 2: Review every requirement against authoritative evidence**

Verify each numbered design section, API, permission boundary, migration, UI state, query surface, and Definition of Done item. Treat missing evidence as incomplete work.

- [ ] **Step 3: Deploy only the isolated preview environment**

Run from `worker/`: `npm run deploy:preview` after verifying `wrangler.jsonc` preview bindings and the runbook's resource IDs. Do not run `deploy:production` and do not bind `fc.polly.wang`.

- [ ] **Step 4: Perform authenticated browser and MCP end-to-end checks**

Create/edit one preview-only site, create an A=10 listing, transfer 3 to B, verify A becomes unavailable everywhere, B remains unchanged, and the history record shows source, destination, 10, 3, 7, reason, actor, and timestamp. Verify viewer cannot open admin site/history APIs.

- [ ] **Step 5: Record preview URL, deployment version, migration evidence, and rollback point**

Commit only durable non-secret evidence. Never store viewer/admin/MCP/CopilotX/session credentials.
