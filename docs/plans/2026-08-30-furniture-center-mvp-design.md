# FurnitureCenter MVP Design

## Product boundary

FurnitureCenter manages furniture inventory only. The primary user experience combines natural-
language questions, structured filters, a synchronized map, and furniture photography.
The administration surface replaces spreadsheets after a one-time migration.

The first release excludes transfer requests, reservations, approvals, 3D generation,
generic facilities management, and general-purpose text-to-SQL.

The Web hierarchy is conversation-first. The catalog remains available for direct
filtering, while furniture details occupy the upper two thirds of the context column
and a low-contrast synchronized map occupies the lower third. The map explains where
results are located without competing with the conversation or furniture imagery. The
catalog and context widths are adjustable on desktop, with a compact 270px catalog
default; mobile puts conversation before the catalog.

## Architecture

The application core owns query and administration use cases. FastAPI, the Web Agent,
and MCP are adapters over that core. SQLAlchemy repositories implement persistence.
React and MapLibre consume a transport-neutral query result containing furniture,
image references, inventory positions, map features, applied filters, and an optional
answer.

The Web Agent translates natural language into typed query filters. It uses a local
deterministic planner when no model is configured and an OpenAI-compatible planner when
credentials are present. MCP does not contain an LLM; the MCP host supplies the model.

## Inventory model

A furniture record represents a browseable model or kind. Inventory positions associate
that furniture with a site and quantities. Optional individually tracked asset IDs can
be added later without changing the catalog query contract.

Inventory quantities cannot be overwritten through furniture editing. Every increase or
decrease is an explicit adjustment with actor, reason, timestamp, and matching audit
event. Negative quantities are rejected before commit.

## Delivery phases

1. Vertical MVP: catalog query, Web Agent, map, images, furniture CRUD, inventory
   adjustment, audit trail, and typed MCP search.
2. Migration: one-time protected Excel export/import with provenance and recoverable
   source images. Completed locally with 18 furniture kinds and 307 items.
3. Master data: category/site administration, image upload and object storage.
4. Production: Alembic/PostgreSQL, authentication, roles, durable Agent sessions,
   deployment, observability, and backups for `fc.polly.wang`.

## Validation

Domain tests cover inventory invariants and map aggregation. API tests exercise query,
CRUD, adjustment rejection, and audit creation. MCP is validated through the official
SDK client and structured output schema. The Web application is verified at desktop and
mobile widths for API health, image loading, nonblank map rendering, query synchronization,
administration operations, and horizontal overflow.
