# FurnitureCenter

## Status

Greenfield MVP implementation is active. The first vertical slice includes catalog
query, map and image synchronization, a Web query Agent, typed MCP search, furniture
administration, inventory adjustments, audit records, and a one-time protected Excel
migration. The local catalog currently contains 18 furniture kinds, 307 items, and 15
recovered source images. BJW, Shanghai, and Shenzhen are registered as sites; the current
workbook contains inventory only for BJW, while its regional sheets are empty templates.
Do not copy the FurnitureHub
implementation wholesale. Reuse only validated domain rules, import knowledge,
deterministic fixtures, and tests that still match this product.

An isolated Cloudflare preview Worker is deployed.  The active resource IDs,
authenticated-test gate, rollback instructions, and the explicit rule that
production remains untouched until preview passes are in
`docs/deployment/cloudflare-runbook.md`.  Never expose or commit a viewer,
admin, MCP, CopilotX, or session-signing credential.

## Product

FurnitureCenter is an internal furniture inventory discovery and management system
deployed at `fc.polly.wang`. It manages furniture only.

The primary experience is a spatial query workspace where users can combine natural
language questions with structured filters, inspect matching furniture on a map, and
view item images. A separate administration interface is the system of record after
the initial Excel migration.

The query workspace is conversation-first: catalog and structured filters occupy the
left column, chat occupies the center, and the right context column gives roughly two
thirds of its height to furniture details and one third to a subdued location map. The
map is an explanatory context surface, not the dominant canvas. On mobile, chat appears
before the catalog so the composer is visible on the first screen. On desktop, the
catalog and context columns are user-resizable; the catalog defaults to a compact 270px.
Interactive controls use restrained 6-8px corner radii.

Chinese is the default language. English localization may be added after the core
Chinese workflow is complete.

## Minimum Product

### Query workspace

- Natural-language furniture queries with multi-turn context
- Structured search and filters for category, site, availability, and condition
- Map synchronized with query results and current selection
- Furniture result list and image gallery/detail viewer
- Stable links to individual furniture records where practical

### Data administration

- CRUD for furniture, categories, sites, inventory, and images
- Explicit inventory adjustment operations instead of direct quantity overwrites
- Immutable audit history for administrative changes and inventory adjustments
- Excel used only for the initial migration, not as an ongoing transactional source

### MCP

- Official MCP SDK with stdio and Streamable HTTP transports
- Read/query tools backed by the same application use cases as the Web application
- Administration tools are excluded from the first MCP surface unless explicitly
  approved later
- MCP adapters remain thin and never access the database directly

## Explicit Non-Goals For The First Release

- Furniture transfer requests, reservations, approvals, or cancellation workflows
- 3D command generation or 3D model rendering
- Generic facilities, room, employee, or space-management features
- Spreadsheet-based ongoing editing
- General-purpose text-to-SQL
- Executive dashboards unrelated to the query workflow

## Architecture Direction

Use a headless application core with separate adapters:

```text
Web query UI --> Web Agent ---------+
Web filters ------------------------+--> application use cases --> repositories
Admin UI --> REST administration ---+                              |
MCP tools --------------------------+                              +--> database
                                                                  +--> image storage
```

The Web Agent is responsible only for natural-language interpretation and orchestration.
MCP does not embed an LLM: MCP clients provide their own model and invoke typed tools.
Both paths call the same application use cases.

The Web Agent defaults to CopilotX at `https://api.polly.wang/v1` using
`gpt-5.6-terra`. A missing API key is a configuration error; never silently fall back
to rules in production. Rule-based planning is available only through the explicit
`FURNITURE_CENTER_AGENT_MODE=rules` setting for deterministic offline tests.

The Web chat uses a result-first SSE flow. CopilotX first creates a structured query
plan, the backend emits the matching catalog result so the list, detail view, and map
update immediately, then a second CopilotX Responses API call streams a grounded final
answer as text deltas. Keep the non-streaming endpoint for tests and non-Web adapters.

All query paths return one transport-neutral result model containing:

- Natural-language answer where applicable
- Matching furniture records
- Map features and suggested viewport
- Image references
- Applied filters and result metadata

Do not place MapLibre-specific commands, React view state, MCP content blocks, or LLM
provider payloads in the application core.

## Proposed Project Boundaries

```text
backend/
  domain/          # Entities, value objects, domain rules
  application/     # Query and administration use cases
  infrastructure/  # Database, image storage, initial Excel migration
  api/             # FastAPI REST and streaming adapters
  agent/           # Web natural-language orchestration
mcp_server/        # Official MCP SDK adapter over application use cases
frontend/          # Query workspace and administration interface
  src/features/query/
  src/features/map/
  src/features/gallery/
  src/features/admin/
tests/             # Domain, application, adapter, and browser tests
docs/plans/        # Validated design and implementation plans
```

Keep new modules within these boundaries unless the design document is updated first.

## Engineering Rules

- Keep domain and application code independent from FastAPI, MCP, React, MapLibre, and
  the selected LLM provider.
- Use typed, task-specific query operations; do not make text-to-SQL a primary path.
- Treat inventory adjustments as auditable transactions and never allow available
  inventory to become negative.
- Store image metadata in the database and image bytes in configurable object storage
  or a local development adapter.
- Require provenance on records created by the initial Excel migration.
- Use deterministic fixtures and mock LLM responses in automated tests.
- Never commit credentials, real employee data, source workbooks, or non-approved
  furniture images.
- Test domain rules, application use cases, REST/MCP contracts, Agent tool selection,
  and interactive query/map/gallery/admin behavior.

## Confirmed Decisions

- Build this as a new project rather than rewriting FurnitureHub in place.
- Product scope is furniture only.
- Target domain is `fc.polly.wang`.
- Natural-language and structured queries coexist.
- The first administration scope includes furniture, categories, sites, inventory,
  images, inventory adjustment history, and an audit trail.
- MCP is mandatory.

## Commands

```powershell
# Backend setup and API
python -m venv .venv
.\.venv\Scripts\python -m pip install -e ".[dev]"
.\.venv\Scripts\python -m uvicorn backend.api.main:app --reload --port 8810

# Frontend
Set-Location frontend
npm install
npm run dev

# MCP
.\.venv\Scripts\python -m mcp_server
.\.venv\Scripts\python -m mcp_server --transport streamable-http --port 8820

# Initial protected workbook migration (Windows + authorized Microsoft 365 session)
.\scripts\prepare_excel_import.ps1 -Source ".\Furniture Reuse & Asset Sharing Platform.xlsx"
.\.venv\Scripts\python -m backend.import_excel .\data\import\furniture-catalog.json
.\.venv\Scripts\python -m backend.import_excel .\data\import\furniture-catalog.json --apply --replace-catalog

# Validation
.\.venv\Scripts\python -m pytest tests -q -W error
.\.venv\Scripts\python -m ruff check . --exclude .venv
Set-Location frontend
npm run build
npm run lint
```

## Next Implementation Phase

- Category and site administration UI and use cases
- Image upload/storage adapter instead of URL-only image administration
- Durable multi-turn Agent sessions and authenticated user identity
- Alembic baseline migration and PostgreSQL deployment configuration
- Authentication and role separation for query and administration surfaces
