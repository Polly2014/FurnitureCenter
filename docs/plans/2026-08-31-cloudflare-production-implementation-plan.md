# FurnitureCenter Cloudflare Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the authenticated FurnitureCenter application at `https://fc.polly.wang`, backed by D1 and private R2, with correct multi-site inventory and a read-only remote MCP endpoint.

**Architecture:** Keep React as the UI and introduce a TypeScript Cloudflare Worker that owns REST, result-first Chat streaming, token/session authorization, R2 image delivery, and stateless Streamable HTTP MCP. REST and MCP call shared application services over D1/R2 repositories; the Python implementation remains the local reference until contract parity and production migration are verified.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Cloudflare Workers, Hono, D1, R2, Cloudflare MCP SDK, Vitest Workers pool, Python 3.10+, FastAPI, SQLAlchemy, pytest, Playwright.

**Spec:** `docs/plans/2026-08-31-cloudflare-production-auth-mcp-design.md`

## Global Constraints

- Production hostname is exactly `fc.polly.wang`.
- Production has two external roles, `viewer` and `admin`; credentials are individually revocable and only hashes are stored.
- `COPILOTX_API_KEY` is a Worker Secret and must never enter browser assets, logs, fixtures, or commits.
- D1 is the production system of record; image bytes are stored in a private R2 bucket.
- Every inventory mutation targets an explicit `(furniture_id, site_id)` position and is audited.
- Site-to-site transfers are atomic and reject stale versions or negative quantities.
- Production MCP is remote Streamable HTTP, authenticated per client, and read-only.
- Existing real workbook data and images are never committed.
- Every code behavior is developed red-green-refactor and every deployment is verified through a preview environment before production cutover.

---

## File map

Python reference/local application:

- `backend/application/administration.py`: inventory commands and validation.
- `backend/infrastructure/models.py`: inventory constraints, versions, transfers, audit persistence.
- `backend/infrastructure/administration_repository.py`: transactional inventory operations.
- `backend/api/schemas.py`, `backend/api/main.py`: explicit inventory-position REST contracts.
- `tests/test_api.py`, `tests/test_inventory_administration.py`: reference contract and transaction tests.

React application:

- `frontend/src/features/admin/AdminView.tsx`: separated furniture and site-inventory editing.
- `frontend/src/features/auth/AuthGate.tsx`: token exchange and session states.
- `frontend/src/features/admin/ImageManager.tsx`: upload, ordering, primary image, removal.
- `frontend/src/api.ts`, `frontend/src/types.ts`, `frontend/src/App.tsx`: typed API/session integration.
- `frontend/src/App.css`: existing editorial/industrial visual language extended to auth and inventory.

Cloudflare production application:

- `worker/package.json`, `worker/tsconfig.json`, `worker/vitest.config.ts`: Worker build/test setup.
- `worker/wrangler.jsonc`: preview/production D1, R2, assets, rate-limit, service and secret bindings.
- `worker/migrations/*.sql`: D1 schema and migrations.
- `worker/src/env.ts`: typed bindings.
- `worker/src/auth/tokens.ts`, `worker/src/auth/sessions.ts`, `worker/src/auth/middleware.ts`: token hashing, sessions, scopes and CSRF.
- `worker/src/catalog/service.ts`, `worker/src/catalog/repository.ts`: shared catalog use cases.
- `worker/src/inventory/service.ts`, `worker/src/inventory/repository.ts`: adjustment and atomic transfer rules.
- `worker/src/images/service.ts`: R2 upload/finalize/delivery/removal.
- `worker/src/chat/service.ts`: CopilotX plan/result/answer stream.
- `worker/src/mcp/server.ts`: read-only MCP tools over shared catalog service.
- `worker/src/index.ts`: Hono route composition and assets fallback.
- `worker/test/*.test.ts`: Worker integration and contract coverage.
- `scripts/export_sqlite_for_d1.py`, `scripts/verify_cloudflare_migration.py`: deterministic export and reconciliation.

## Task 1: Lock the current baseline and implementation branch

**Files:**
- Create: `docs/plans/2026-08-31-cloudflare-production-implementation-plan.md`

**Interfaces:**
- Consumes: validated production design.
- Produces: `codex/cloudflare-production` implementation branch and green baseline evidence.

- [x] **Step 1: Run the Python baseline**

  Run: `source .venv/bin/activate && pytest -q -W error`  
  Expected: `11 passed`.

- [x] **Step 2: Run the frontend baseline**

  Run: `cd frontend && npm run build && npm run lint`  
  Expected: build succeeds and oxlint reports no errors.

- [x] **Step 3: Preserve the validated overview UI separately**

  Commit only `frontend/src/App.tsx` and `frontend/src/App.css` as
  `feat: show inventory overview before selection`.

- [x] **Step 4: Create the implementation branch**

  Run: `git switch -c codex/cloudflare-production`.

## Task 2: Implement correct multi-site inventory transactions in Python

**Files:**
- Modify: `backend/application/administration.py`
- Modify: `backend/infrastructure/models.py`
- Modify: `backend/infrastructure/administration_repository.py`
- Modify: `backend/api/schemas.py`
- Modify: `backend/api/main.py`
- Create: `tests/test_inventory_administration.py`

**Interfaces:**
- Produces: `create_inventory_position(furniture_id, site_id, quantity_total, quantity_available, actor)`, `adjust_inventory(inventory_id, delta_total, delta_available, kind, reason, actor, expected_version)`, and `transfer_inventory(source_inventory_id, destination_site_id, quantity, reason, actor, expected_source_version)`.
- Produces REST endpoints `POST /api/admin/furniture/{id}/inventory`, `POST /api/admin/inventory/{id}/adjustments`, and `POST /api/admin/inventory/{id}/transfers`.

- [x] **Step 1: Write failing repository/API tests**

  Cover duplicate `(furniture_id, site_id)`, independent total/available deltas, stale versions, negative results, destination creation, atomic transfer, and immutable before/after audit values. Assert the seeded arc chair moves from Beijing `12/18` and Shanghai `4/8` to Beijing `10/16` and Shanghai `6/10` after transferring two available physical items.

- [x] **Step 2: Verify tests fail for missing contracts**

  Run: `source .venv/bin/activate && pytest tests/test_inventory_administration.py -q`  
  Expected: failures identify missing commands/endpoints, not test setup errors.

- [x] **Step 3: Add schema constraints and commands**

  Add a unique constraint for `(furniture_id, site_id)`, `version INTEGER NOT NULL DEFAULT 1`, adjustment kind, total/available before and after values, and a transfer identifier shared by the paired audit facts.

- [x] **Step 4: Implement transactional operations**

  Adjustment validates `0 <= available <= total`; transfer uses one transaction, checks the expected source version, creates or updates the destination, and commits only after both sides and audit events are staged.

- [x] **Step 5: Run focused and full Python tests**

  Run: `source .venv/bin/activate && pytest tests/test_inventory_administration.py -q && pytest -q -W error`.

- [x] **Step 6: Commit the transaction slice**

  Commit: `feat: add auditable multi-site inventory transactions`.

## Task 3: Replace aggregate Admin editing with per-site inventory UI

**Files:**
- Modify: `frontend/src/features/admin/AdminView.tsx`
- Create: `frontend/src/features/admin/InventoryPositions.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/App.css`
- Modify: `tests/test_frontend_presentation.py`

**Interfaces:**
- Consumes: Task 2 endpoints and inventory `version`.
- Produces: explicit site rows with `available / total`, adjustment-type dialog, add-site flow, and atomic transfer flow.

- [ ] **Step 1: Write a failing presentation contract test**

  Assert `AdminView.tsx` no longer contains `item.inventory[0]`; assert `InventoryPositions.tsx` renders every position and sends the selected position ID and version.

- [ ] **Step 2: Verify the test fails against the aggregate UI**

  Run: `source .venv/bin/activate && pytest tests/test_frontend_presentation.py -q`.

- [ ] **Step 3: Implement explicit inventory rows**

  Keep furniture metadata in the left form. Render site rows in a dedicated section, label aggregate stock as summary only, and require operation kind plus reason before adjustment or transfer.

- [ ] **Step 4: Verify build, lint, Python presentation tests and browser behavior**

  Run: `cd frontend && npm run build && npm run lint`; then run the focused pytest file and a Playwright flow that edits Beijing without changing Shanghai.

- [ ] **Step 5: Commit the Admin slice**

  Commit: `feat: manage inventory by site`.

## Task 4: Scaffold the tested Cloudflare Worker and D1 schema

**Files:**
- Create: `worker/package.json`, `worker/package-lock.json`, `worker/tsconfig.json`, `worker/vitest.config.ts`, `worker/wrangler.jsonc`
- Create: `worker/migrations/0001_initial.sql`
- Create: `worker/src/env.ts`, `worker/src/index.ts`
- Create: `worker/test/health.test.ts`, `worker/test/schema.test.ts`

**Interfaces:**
- Produces bindings `DB: D1Database`, `IMAGES: R2Bucket`, `ASSETS: Fetcher`, `COPILOTX_API_KEY: string`, `SESSION_SIGNING_KEY: string`.
- Produces `GET /health` with `{status:"ok", database:"ok"}` after a real D1 query.

- [ ] **Step 1: Write failing Worker health and migration tests**

  Assert `/health` checks D1 and the migration creates categories, sites, furniture, furniture_images, inventory, inventory_adjustments, audit_events, access_tokens and sessions.

- [ ] **Step 2: Run tests and observe missing Worker failures**

  Run: `cd worker && npm test`.

- [ ] **Step 3: Implement minimal Worker and schema**

  Use Hono for routing and Wrangler migrations for all schema creation. Do not seed production from Worker startup.

- [ ] **Step 4: Verify typecheck and Workers tests**

  Run: `cd worker && npm run typecheck && npm test`.

- [ ] **Step 5: Commit the scaffold**

  Commit: `feat: scaffold Cloudflare Worker and D1 schema`.

## Task 5: Implement viewer/admin credentials and browser sessions

**Files:**
- Create: `worker/src/auth/tokens.ts`, `worker/src/auth/sessions.ts`, `worker/src/auth/middleware.ts`, `worker/src/auth/routes.ts`
- Create: `worker/test/auth.test.ts`
- Create: `frontend/src/features/auth/AuthGate.tsx`
- Modify: `frontend/src/api.ts`, `frontend/src/App.tsx`, `frontend/src/App.css`

**Interfaces:**
- Produces `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`.
- Produces `requireRole("viewer" | "admin")` and Bearer-token verification for `/mcp`.

- [ ] **Step 1: Write failing auth tests**

  Assert unknown/revoked/expired credentials fail, viewer cannot mutate Admin routes, admin can, cookie flags are `HttpOnly; Secure; SameSite=Strict`, CSRF is enforced, and raw credentials never appear in D1 or responses.

- [ ] **Step 2: Verify tests fail for absent auth routes**

  Run: `cd worker && npm test -- auth.test.ts`.

- [ ] **Step 3: Implement token hashes and opaque sessions**

  Derive a lookup digest from a high-entropy credential, store only the digest, issue expiring opaque session IDs, and bind each session to the token record so revocation is immediate.

- [ ] **Step 4: Add the React login gate**

  Exchange a token once, rely on `credentials: "include"`, present non-secret identity state, and keep Admin navigation hidden for viewers while retaining server-side enforcement.

- [ ] **Step 5: Verify Worker tests and browser login flows**

  Test viewer, admin, invalid, revoked and logout flows in a local Worker preview.

- [ ] **Step 6: Commit the auth slice**

  Commit: `feat: add scoped token and session authentication`.

## Task 6: Port catalog and inventory services to D1

**Files:**
- Create: `worker/src/catalog/models.ts`, `worker/src/catalog/repository.ts`, `worker/src/catalog/service.ts`, `worker/src/catalog/routes.ts`
- Create: `worker/src/inventory/service.ts`, `worker/src/inventory/repository.ts`, `worker/src/inventory/routes.ts`
- Create: `worker/test/catalog-contract.test.ts`, `worker/test/inventory.test.ts`
- Create: `tests/fixtures/catalog-contract.json`

**Interfaces:**
- Produces the current REST catalog result shape plus inventory `version`.
- Consumes the Task 2 operation semantics exactly.

- [ ] **Step 1: Write failing cross-adapter contract fixtures**

  Exercise text/category/site/availability queries and the Beijing/Shanghai inventory distribution through Python and Worker adapters.

- [ ] **Step 2: Verify the Worker contract fails before implementation**

  Run: `cd worker && npm test -- catalog-contract.test.ts inventory.test.ts`.

- [ ] **Step 3: Implement D1 repositories and application services**

  Use parameterized statements, bounded limits, explicit field mapping, conditional version updates, and D1 batch/transaction semantics for transfers.

- [ ] **Step 4: Verify all contracts and invariants**

  Run both Worker and Python suites and compare normalized fixture output.

- [ ] **Step 5: Commit D1 catalog/inventory**

  Commit: `feat: port catalog and inventory services to D1`.

## Task 7: Implement private R2 image management

**Files:**
- Create: `worker/src/images/service.ts`, `worker/src/images/routes.ts`
- Create: `worker/test/images.test.ts`
- Create: `frontend/src/features/admin/ImageManager.tsx`
- Modify: `frontend/src/api.ts`, `frontend/src/types.ts`, `frontend/src/features/admin/AdminView.tsx`, `frontend/src/App.css`

**Interfaces:**
- Produces Admin upload/finalize/reorder/primary/delete endpoints and authenticated/signed `GET /images/:id`.
- Persists `object_key`, MIME, bytes, dimensions, SHA-256, alt text, sort order and primary flag.

- [ ] **Step 1: Write failing R2 tests**

  Assert viewer cannot upload, MIME/size validation rejects unsafe input, finalize verifies the object, signed URLs expire, primary ordering is stable, and deletion removes metadata plus object idempotently.

- [ ] **Step 2: Verify tests fail before image routes exist**

  Run: `cd worker && npm test -- images.test.ts`.

- [ ] **Step 3: Implement the R2 service and Admin UI**

  Use generated object keys independent of filenames, browser previews, accessible alt text, upload progress and explicit primary-image actions.

- [ ] **Step 4: Verify tests, build, lint and browser upload/lightbox**

  Run the Worker image tests and frontend checks, then upload and remove a real small fixture in preview.

- [ ] **Step 5: Commit image management**

  Commit: `feat: manage furniture images in private R2`.

## Task 8: Port result-first Chat streaming securely

**Files:**
- Create: `worker/src/chat/copilotx.ts`, `worker/src/chat/planner.ts`, `worker/src/chat/routes.ts`
- Create: `worker/test/chat.test.ts`
- Modify: `frontend/src/api.ts`

**Interfaces:**
- Produces authenticated `POST /api/agent/query/stream` with `status`, `result`, `text_delta`, `done`, and sanitized `error` events.
- Consumes `env.COPILOTX_API_KEY` only inside the Worker.

- [ ] **Step 1: Write failing mocked-upstream stream tests**

  Assert catalog result precedes answer deltas, unsupported client model/tools are discarded, upstream errors are sanitized, viewer quota applies, and no key appears in logs or output.

- [ ] **Step 2: Verify the tests fail before the route exists**

  Run: `cd worker && npm test -- chat.test.ts`.

- [ ] **Step 3: Implement planner, query and grounded answer streaming**

  Pin the model server-side, validate all planner output, run the shared catalog service, and stream the answer without buffering the full upstream response.

- [ ] **Step 4: Verify automated and browser Chat behavior**

  Use a fake upstream in tests and the configured CopilotX Secret only in deployed preview.

- [ ] **Step 5: Commit Chat**

  Commit: `feat: port authenticated result-first chat`.

## Task 9: Implement the read-only remote MCP endpoint

**Files:**
- Create: `worker/src/mcp/server.ts`, `worker/src/mcp/routes.ts`
- Create: `worker/test/mcp.test.ts`
- Create: `worker/evals/furniture-center.xml`

**Interfaces:**
- Produces authenticated `/mcp` Streamable HTTP tools `search_furniture`, `get_furniture`, `list_sites`, `list_categories`.
- Consumes Bearer viewer credentials and Task 6 catalog service.

- [ ] **Step 1: Write failing MCP protocol and authorization tests**

  Assert discovery/tool schemas, structured content, annotations, missing/invalid/revoked Bearer rejection, bounded search results, short-lived image URLs, and absence of mutation tools.

- [ ] **Step 2: Verify failures before MCP handler registration**

  Run: `cd worker && npm test -- mcp.test.ts`.

- [ ] **Step 3: Implement stateless Streamable HTTP MCP**

  Use Cloudflare's supported MCP handler, explicit Host/Origin validation, Zod input/output schemas, actionable non-secret errors, and shared catalog application services.

- [ ] **Step 4: Add ten stable read-only evaluations**

  Store independently verifiable questions and answers in `worker/evals/furniture-center.xml`.

- [ ] **Step 5: Verify with tests and two MCP clients**

  Run the Worker suite, MCP Inspector, and one additional production-compatible MCP host against preview.

- [ ] **Step 6: Commit MCP**

  Commit: `feat: expose authenticated read-only remote MCP`.

## Task 10: Export and reconcile SQLite/R2 migration data

**Files:**
- Create: `scripts/export_sqlite_for_d1.py`
- Create: `scripts/verify_cloudflare_migration.py`
- Create: `tests/test_cloudflare_migration.py`
- Modify: `.gitignore`

**Interfaces:**
- Produces ignored SQL/JSON migration artifacts and a machine-readable reconciliation report.

- [ ] **Step 1: Write failing deterministic export and reconciliation tests**

  Assert stable table ordering, escaped SQL, no credentials, row counts, per-furniture/site totals, foreign keys, image byte counts and SHA-256 equality.

- [ ] **Step 2: Verify tests fail before scripts exist**

  Run: `source .venv/bin/activate && pytest tests/test_cloudflare_migration.py -q`.

- [ ] **Step 3: Implement export and verifier**

  Export from a read-only SQLite connection, write only to an ignored migration directory, and fail nonzero on every mismatch.

- [ ] **Step 4: Run against a temporary D1/R2 preview**

  Apply migrations, import catalog data, upload image bytes, and save the redacted reconciliation JSON outside Git.

- [ ] **Step 5: Commit migration tooling only**

  Commit: `feat: add verified Cloudflare migration tooling`.

## Task 11: Deploy preview and production

**Files:**
- Modify: `worker/wrangler.jsonc`
- Modify: `README.md`, `CLAUDE.md`
- Create: `docs/deployment/cloudflare-runbook.md`

**Interfaces:**
- Produces separate preview/production D1 databases, R2 buckets, secrets, token records, Worker versions, DNS route and rollback procedure.

- [ ] **Step 1: Create preview resources and apply migrations**

  Use explicit `preview` names and IDs; do not point preview at production bindings.

- [ ] **Step 2: Configure preview secrets interactively**

  Set a dedicated CopilotX key and session-signing key through Wrangler. Never put values in shell history, command output, files, or the plan.

- [ ] **Step 3: Deploy and verify preview**

  Check health, viewer/admin boundaries, Chat, images, inventory transactions, MCP, logs and rollback.

- [ ] **Step 4: Create production resources and `fc.polly.wang` route**

  Recheck DNS, apply production migrations, configure secrets, import reconciled data, then create the custom domain/route.

- [ ] **Step 5: Execute final cutover and smoke tests**

  Freeze old writes, reconcile the final delta, deploy the proven Worker version, verify HTTPS and all critical user journeys, and retain the previous version for rollback.

- [ ] **Step 6: Commit runbook and deployed configuration**

  Commit only IDs, names and non-secret configuration: `docs: add Cloudflare deployment runbook`.

## Task 12: Completion audit

**Files:**
- Modify: `README.md`, `CLAUDE.md`
- Create: `docs/deployment/production-verification.md`

**Interfaces:**
- Produces requirement-by-requirement production evidence for the design Definition of Done.

- [ ] **Step 1: Run every automated suite from a clean checkout**

  Run Python tests/Ruff, frontend build/lint, Worker typecheck/tests, migration verifier and MCP evaluations. Record exact versions and results.

- [ ] **Step 2: Run deployed browser journeys**

  Verify viewer login/query/Chat/detail/image/logout and admin metadata/image/Beijing/Shanghai adjustment/transfer/audit flows at desktop and mobile widths with no console errors.

- [ ] **Step 3: Run deployed security and operational checks**

  Verify invalid/revoked tokens, CSRF, CORS/Origin, rate limits, R2 privacy, sanitized failures, D1 backup/export, rollback and custom-domain TLS.

- [ ] **Step 4: Audit every design requirement**

  Link each requirement to a test, deployment output, reconciliation record, screenshot or runtime check. Any missing or indirect evidence keeps the goal open.

- [ ] **Step 5: Commit final verification records**

  Commit only redacted evidence: `docs: record FurnitureCenter production verification`.
