# FurnitureCenter Cloudflare Production, Authentication, and MCP Design

**Date:** 2026-08-31  
**Status:** Validated direction, ready for implementation planning  
**Recommended public hostname:** `furni.polly.wang`

## 1. Goals and decisions

FurnitureCenter will be reachable from the public Internet but will not be an
anonymous public catalog. Users must authenticate before viewing inventory or using
Chat. The administration surface requires a stronger permission level. The production
system should use Cloudflare for the Web application, API, database, image storage, and
remote MCP endpoint.

The agreed direction is:

- Cloudflare Worker Assets or Pages for the React application.
- Cloudflare Worker for REST, Chat streaming, authentication, image delivery, and MCP.
- Cloudflare D1 as the system-of-record database.
- A private Cloudflare R2 bucket for furniture image bytes.
- Two external authorization roles: `viewer` and `admin`.
- Multiple independently revocable credentials may exist for each role; the design does
  not hard-code exactly two shared secret strings.
- CopilotX credentials remain server-side Worker Secrets and are never sent to browsers
  or MCP clients.
- The first production MCP surface remains read-only.
- Furniture attributes and per-site inventory are managed separately.

## 2. Hostname

### Recommendation: `furni.polly.wang`

`furni` is short, readable, furniture-specific, and does not constrain the product to
only reused inventory. It is easier to understand than the shortest alternative,
`fc.polly.wang`.

Alternatives:

| Hostname | Strength | Trade-off |
| --- | --- | --- |
| `furni.polly.wang` | Short and still recognizable | Slightly coined abbreviation |
| `reuse.polly.wang` | Memorable and aligned with circular reuse | Too narrow if the catalog later includes new furniture |
| `fc.polly.wang` | Shortest | Ambiguous outside the project team |
| `furniture.polly.wang` | Immediately clear | Longer than the other candidates |

Cloudflare DNS had no records for these four names when checked on 2026-08-31. No DNS
record was created by this design task, so availability must be checked again at deploy
time.

Recommended routes:

```text
https://furni.polly.wang/             Web application
https://furni.polly.wang/api/*        REST and Chat API
https://furni.polly.wang/images/*     Authenticated or signed R2 image delivery
https://furni.polly.wang/mcp          Remote MCP over Streamable HTTP
```

Keeping one hostname avoids unnecessary CORS and cookie complexity. The `/mcp` route
still has independent authentication and rate limits.

## 3. Target architecture

```text
Browser -- session cookie ------+                         +--> D1
                                |                         |    catalog, sites,
MCP client -- Bearer token -----+--> Cloudflare Worker ---+    inventory, auth, audit
                                |                         |
                                |                         +--> private R2 images
                                |
                                +--> CopilotX Responses API
                                     Worker Secret only
```

The Worker codebase should retain transport-neutral boundaries:

```text
Web handlers -----+
Chat orchestrator +--> application services --> D1/R2 repositories
MCP tools --------+
```

REST and MCP must not implement separate catalog or inventory rules. A query from the
Web UI and the equivalent MCP tool call should use the same application service and
return the same transport-neutral result model.

The current FastAPI and SQLAlchemy implementation cannot point at D1 as if it were a
normal database URL. The all-Cloudflare implementation therefore ports the API,
application adapters, and thin MCP adapter to TypeScript. Hono is suitable for REST,
while Cloudflare's Agents/MCP SDK provides the Streamable HTTP handler. Domain behavior
is preserved through shared contract fixtures and tests rather than by maintaining two
production backends.

## 4. Authentication and authorization

### 4.1 Two external permission roles

`viewer` may:

- view the catalog, map, furniture details, and permitted images;
- use structured search and Chat;
- invoke read-only MCP tools.

`admin` includes viewer permissions and may additionally:

- create and edit furniture, categories, and sites;
- upload, reorder, replace, and remove images;
- create inventory positions and perform adjustments or transfers;
- inspect audit records and manage access credentials.

The upstream `COPILOTX_API_KEY` is a third technical secret, but it is not an external
authorization role. It is available only to the Worker runtime.

### 4.2 Credential storage

Use a D1 `access_tokens` table rather than a Worker filesystem or two hard-coded values:

```text
id, token_hash, role, scopes_json, label,
daily_quota, expires_at, revoked_at, last_used_at, created_at
```

- Generate high-entropy random tokens.
- Show the plaintext only once at creation.
- Store only a keyed hash or cryptographic digest suitable for high-entropy tokens.
- Compare values without timing-dependent early exit.
- Allow individual expiry and revocation.
- Never place a viewer token, admin token, or CopilotX key in the frontend bundle.

This preserves the XHS Extractor idea of individually attributable invite codes while
making it compatible with Workers, which have no mutable local filesystem. D1 gives
immediate revocation semantics; KV may be added only as a cache if authentication load
later justifies it.

### 4.3 Browser authentication

1. The unauthenticated page shows a token entry gate.
2. `POST /api/auth/login` verifies the submitted token with strict IP rate limiting.
3. The Worker issues a signed, opaque session in an `HttpOnly`, `Secure`,
   `SameSite=Strict` cookie and no longer needs the raw token in the browser.
4. `GET /api/auth/session` returns the non-secret role and label needed by the UI.
5. `POST /api/auth/logout` invalidates the session.
6. Every state-changing route performs server-side scope checks; hiding an Admin button
   is not authorization.

Sessions must have an expiry, bind to the token record so revocation takes effect, and
use CSRF protection for state-changing requests. Apply Cloudflare rate limiting to the
login and Chat routes and per-token quotas inside the application.

### 4.4 MCP authentication

The initial MCP endpoint accepts a separately issued viewer credential through:

```http
Authorization: Bearer <credential>
```

Each MCP host should receive its own token record even though all are `viewer` role.
This permits per-client revocation and audit attribution. Do not expose administration
tools through MCP in the first release.

Bearer authentication is the pragmatic first release for a personal, invite-only
service. Standard MCP OAuth is the future path if arbitrary external users or delegated
user identities are required. Browser session cookies are not accepted on `/mcp`.

## 5. Existing Cloudflare Secret finding

The Cloudflare account was inspected read-only on 2026-08-31:

- The account currently exposes one Worker script: `polly-chat-proxy`.
- That Worker has Secret bindings named `COPILOTX_API_KEY` and `ADMIN_TOKEN`.
- Cloudflare does not reveal Worker Secret values after creation.
- Worker Secrets are scoped to their Worker; the existing binding is not automatically
  available to a new FurnitureCenter Worker.

Do not couple FurnitureCenter to the blog proxy merely to reuse this secret. The blog
proxy currently exposes a product-specific `/v1/messages` route and origin policy,
whereas FurnitureCenter uses the Responses API and has different authentication and
quotas.

At deployment time, create a dedicated CopilotX credential for FurnitureCenter when
possible and store it as a Secret on the new Worker. If the existing credential must be
reused, Polly will need to provide its value again; it cannot be exported from
Cloudflare. No secret value is recorded in this document.

## 6. Remote MCP on Cloudflare

MCP remains viable in the all-Cloudflare design. Cloudflare supports remote MCP servers
over Streamable HTTP, including stateless handlers and stateful `McpAgent` instances
backed by Durable Objects.

FurnitureCenter's first MCP surface is a strong fit for a stateless handler because its
business state belongs in D1 rather than an MCP protocol session. The initial tool set
should stay small and goal-oriented:

- `search_furniture`: search by text and structured filters and return per-site stock.
- `get_furniture`: retrieve one furniture record, image metadata, and site distribution.
- `list_sites`: return valid site identifiers and names.
- `list_categories`: return valid category filters.

The current Python stdio server remains useful for local compatibility during the
migration. Production uses a TypeScript MCP adapter at `/mcp`. The same contract fixtures
should be executed against both adapters until the Worker endpoint is accepted; the
Python remote server can then be retired while optional local stdio support remains.

For protected images in MCP responses, return short-lived signed Worker URLs rather than
R2 object keys or browser-cookie-only URLs. Enforce allowed Host and Origin values on the
MCP handler in addition to Bearer authentication. CORS is not authentication.

## 7. Image storage and administration

Store image bytes in a private R2 bucket and metadata in D1. The image table should
contain at least:

```text
id, furniture_id, object_key, mime_type, byte_size,
width, height, sha256, alt_text, sort_order, is_primary, created_at
```

Upload flow:

1. Admin selects or drops an image and receives a local preview.
2. Worker validates role, filename-independent MIME type, size, and allowed dimensions.
3. The client uploads through the Worker or a short-lived signed R2 upload URL.
4. A finalize call verifies the object and commits metadata.
5. Thumbnail/derivative generation is stable and repeatable.
6. Deleting an image removes metadata and schedules object cleanup; orphan cleanup is
   idempotent and auditable.

Store `object_key`, not a permanent public URL. Delivery URLs can then change without a
database migration. Existing local catalog images need an explicit R2 migration with
byte count, content type, and SHA-256 verification.

## 8. Multi-site inventory design

The furniture edit experience separates descriptive attributes from inventory
positions. For example:

| Site | Available / total | Actions |
| --- | ---: | --- |
| Beijing | 12 / 18 | Adjust, transfer |
| Shanghai | 4 / 8 | Adjust, transfer |

The catalog list may show the aggregate `16 available`, but all edits must target an
explicit inventory position. Never select `inventory[0]` as the implicit target.

Required data rules and operations:

- Unique constraint on `(furniture_id, site_id)`.
- Create an inventory position for a site.
- Adjust a specified inventory position with actor and reason.
- Transfer between two sites atomically in one D1 transaction/batch operation.
- Prevent negative or internally inconsistent quantities.
- Close a zero-quantity position rather than destroying historical references.
- Record immutable adjustment/transfer events with actor, reason, timestamp, and before
  and after quantities.
- Use a version value or equivalent optimistic-concurrency condition to reject stale
  writes.

`quantity_total` and `quantity_available` must not always change together. An acquisition
or disposal changes total stock; a reservation, loan, return, or repair state changes
availability. The Admin UI should therefore require an adjustment type instead of
treating every plus/minus click as the same business event.

## 9. Database migration

Replace runtime `create_all` and demo seeding in production with versioned Wrangler D1
migrations. Keep deterministic seed data only for local and preview environments.

Migration sequence:

1. Define D1 schemas and constraints.
2. Export the current SQLite data to a versioned, non-secret migration artifact.
3. Upload image bytes to R2 and rewrite image metadata to object keys.
4. Import catalog, sites, per-site inventory, adjustments, and audit history.
5. Verify row counts, per-furniture aggregate quantities, image hashes, and foreign-key
   integrity.
6. Freeze writes on the old backend for final cutover and run a final delta check.

Production, preview, and test environments must use separate D1 databases, R2 buckets,
token records, and secrets.

## 10. Error handling and security boundaries

- Return `401` for missing/invalid authentication and `403` for insufficient scope.
- Return `409` for stale inventory versions, duplicate site positions, or conflicting
  transfers.
- Use idempotency keys for uploads, adjustments, and transfers where retries could
  duplicate effects.
- Do not return raw upstream, SQL, filesystem, binding, or secret errors to clients.
- Redact credentials from logs and never include request authorization headers in audit
  payloads.
- Limit request bodies, image types and sizes, Chat frequency, and MCP tool-call rates.
- Audit every administration mutation and authentication-management action.
- Keep R2 private; use authenticated delivery or short-lived signed URLs.
- Back up D1 and define a tested restore/export procedure before production cutover.

## 11. Verification strategy

Automated checks must cover:

- viewer/admin route authorization and immediate token revocation;
- login rate limits, cookie flags, logout, expiry, and CSRF rejection;
- identical catalog results through REST and MCP contract fixtures;
- MCP discovery, tool calls, malformed Bearer tokens, quotas, and Streamable HTTP client
  compatibility;
- multi-site creation, adjustment, transfer atomicity, audit records, and stale-write
  conflicts;
- R2 upload validation, metadata finalization, signed delivery, and orphan cleanup;
- D1 migration row counts, aggregate inventory invariants, and image SHA-256 equality;
- Chat result-first streaming and safe behavior when CopilotX is unavailable;
- desktop and mobile browser flows for login, query, detail, images, and Admin inventory.

No completion claim should rely only on unit tests. The production candidate must be
validated through a real deployed preview Worker with separate preview bindings.

## 12. Recommended implementation phases

### Phase 1: Fix the domain and local product behavior

- Implement explicit multi-site inventory management and transactions.
- Separate furniture attributes, image management, and inventory positions.
- Add image-storage interfaces with a local adapter.
- Add role/scope concepts and contract tests without changing deployment yet.

### Phase 2: Build Cloudflare persistence and authentication

- Create Wrangler environments, D1 migrations, and private R2 bindings.
- Implement D1 repositories and R2 upload/delivery.
- Implement viewer/admin token records, browser sessions, CSRF, audit, and rate limits.

### Phase 3: Port Web API and Chat

- Port REST and result-first Chat streaming to the Worker application services.
- Store a dedicated CopilotX credential as a Worker Secret.
- Deploy and browser-test a protected preview environment.

### Phase 4: Deploy remote MCP

- Port the thin read-only MCP adapter to the Cloudflare MCP SDK.
- Authenticate per-client viewer Bearer tokens.
- Verify tools with at least two MCP hosts and preserve local stdio during transition.

### Phase 5: Migrate and cut over

- Migrate SQLite and local images to D1/R2 with reconciliation evidence.
- Create and verify `furni.polly.wang` DNS and Worker route.
- Perform security, rate-limit, browser, MCP, backup, and rollback checks.
- Freeze the old writer, complete final reconciliation, and switch production traffic.

## 13. Definition of Done for a future Goal

The future implementation Goal is complete only when:

- `furni.polly.wang` serves the authenticated production application over HTTPS.
- Viewer and admin credentials are separately enforced, individually revocable, and
  absent from source and frontend assets.
- Web Chat uses a server-side CopilotX Secret without exposing it.
- D1 is the verified system of record and production startup does not seed demo data.
- R2 stores image bytes; upload, display, deletion, and hash verification work.
- Beijing and Shanghai quantities are independently visible and editable, and transfers
  are atomic and audited.
- `/mcp` works through Streamable HTTP using a viewer credential and exposes no
  administration tools.
- REST/MCP contracts, automated tests, deployed browser flows, quotas, backup/restore,
  and rollback procedures have all been verified.
- Migration evidence records row counts, inventory reconciliation, and image hashes.

## References

- [Cloudflare Model Context Protocol](https://developers.cloudflare.com/agents/model-context-protocol/)
- [Cloudflare remote MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- Existing local architecture: `CLAUDE.md`
- Existing MVP design: `docs/plans/2026-08-30-furniture-center-mvp-design.md`

