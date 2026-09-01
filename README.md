# 家具共享平台

跨园区发布闲置家具、查询共享目录并追踪领取调拨记录的平台，计划部署于
`fc.polly.wang`。仓库和内部包名继续使用 `FurnitureCenter`。

## Current MVP

- Natural-language and structured furniture queries
- Synchronized catalog, MapLibre map, and furniture image viewer
- Furniture create/update/delete operations
- Site create/update/deactivate operations with map coordinates
- Transactional inventory adjustments with audit events
- Whole-listing allocation: the source listing closes, the destination is unchanged,
  and an immutable transfer record preserves the listed/transferred/unlisted quantities
- One-time protected Excel migration with complete attributes and recoverable images
- Official MCP Python SDK 2.x server with typed structured output
- Deterministic local demo catalog

## Local development

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -e ".[dev]"
.\.venv\Scripts\python -m uvicorn backend.api.main:app --reload --port 8810
```

In a second terminal:

```powershell
Set-Location frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## CopilotX Agent

The Web Agent uses CopilotX at `https://api.polly.wang/v1` with `gpt-5.6-terra`.
This model is called through the OpenAI Responses API, not Chat Completions. Copy
`.env.example` to `.env` and paste the access key after the equals sign:

```dotenv
FURNITURE_CENTER_OPENAI_API_KEY=
```

The local `.env` is ignored by Git. With no key, catalog browsing still works and the
Agent status reports `待配置`; Agent queries return an explicit configuration error.
Use `FURNITURE_CENTER_AGENT_MODE=rules` only for deterministic offline tests.

Web chat uses `POST /api/agent/query/stream`: a `result` SSE event first synchronizes
the catalog, furniture detail, and map, followed by CopilotX `text_delta` events for the
answer. `POST /api/agent/query` remains available as the non-streaming contract.

The Web Agent uses CopilotX at `https://api.polly.wang/v1` with
`gpt-5.6-terra`. Set `FURNITURE_CENTER_OPENAI_API_KEY` in the ignored local
`.env`; never commit the key. For deterministic offline tests only, explicitly set
`FURNITURE_CENTER_AGENT_MODE=rules`.

## Initial Excel migration

The source workbook is protected by Microsoft 365. On Windows with an authorized Office
session, export it to a local manifest and PNG files, then apply the manifest:

```powershell
.\scripts\prepare_excel_import.ps1 `
	-Source ".\Furniture Reuse & Asset Sharing Platform.xlsx"

# Preview only
.\.venv\Scripts\python -m backend.import_excel `
	.\data\import\furniture-catalog.json

# One-time catalog replacement
.\.venv\Scripts\python -m backend.import_excel `
	.\data\import\furniture-catalog.json --apply --replace-catalog
```

The protected workbook, generated manifest, extracted internal images, and local database
are ignored by Git. The current local import contains 18 furniture kinds, 307 available
items, 15 recovered images, and three registered sites. The current regional worksheets
contain no furniture rows, so all 307 inventory items truthfully remain assigned to BJW.

For Cloudflare migration, first upgrade the local SQLite schema, then use
`scripts/export_sqlite_for_d1.py`. The package preserves site lifecycle fields,
listing status/closure fields, and `transfer_records`, while deliberately excluding
access-token and session secrets. Any actor token IDs referenced by transfer history
must already exist in the target D1 as separately issued hash-only records.

## MCP

```powershell
# Local stdio server
.\.venv\Scripts\python -m mcp_server

# Remote-compatible Streamable HTTP server
.\.venv\Scripts\python -m mcp_server --transport streamable-http --port 8820
```

The included `.vscode/mcp.json` registers the stdio server when this repository is the
VS Code workspace root.

## Validation

```powershell
.\.venv\Scripts\python -m pytest tests -q -W error
.\.venv\Scripts\python -m ruff check . --exclude .venv
Set-Location frontend
npm run build
npm run lint

Set-Location ..\worker
npm test
npm run typecheck
```

See `CLAUDE.md` for product boundaries and
`docs/plans/2026-08-30-furniture-center-mvp-design.md` for the original architecture.
The current site/transfer semantics and Definition of Done are in
[`docs/plans/2026-09-01-furniture-sharing-platform-v2-goal-design.md`](docs/plans/2026-09-01-furniture-sharing-platform-v2-goal-design.md).

## Cloudflare deployment

The Worker has a separately bound preview environment.  Its active, non-secret
resource names and the credential, verification, rollback, and production
cutover gates are documented in
[`docs/deployment/cloudflare-runbook.md`](docs/deployment/cloudflare-runbook.md).
Do not reuse preview data, R2 objects, token records, or Worker Secrets for
`fc.polly.wang`.
