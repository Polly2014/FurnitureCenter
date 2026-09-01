# 家具共享平台 Cloudflare deployment runbook

This runbook keeps preview and production physically separate.  Never bind an
environment to the other's D1 database, R2 bucket, token records, or secrets.
All token plaintext and Worker Secret values stay out of source, terminal
history, command arguments, logs, reports, and commits. The sole authorized
exception is the local, ignored preview credential file described below.

## Current preview checkpoint

| Item | Value |
| --- | --- |
| Cloudflare account | `0ed9b0fadf26325ec58d8b58ef3bc4ff` |
| Worker | `furniture-center-preview` |
| URL | `https://furniture-center-preview.26716201.workers.dev` |
| D1 database | `furniture-center-preview` (`12e00396-5823-4167-ad07-575b6ae977ce`) |
| R2 bucket | `furniture-center-images-preview` |
| deployed version | `5cc10639-7683-40dd-8cd0-cade753d042c` |
| previous rollback version | `bd70ba5e-da75-404e-a562-959ee00f6e75` |
| MCP host allow-list | `furniture-center-preview.26716201.workers.dev` |
| Worker Secrets (names only) | `COPILOTX_API_KEY`, `SESSION_SIGNING_KEY` |

The reconciled pre-V2 catalog contained 3 categories, 3 sites, 4 furniture
records, 5 inventory positions, 4 image metadata records, and zero
audit/adjustment records. Four JPEG objects were uploaded to the private R2
bucket and SHA-256 reconciled. Migration `0007_sharing_platform_v2.sql` was
applied to Preview on 2026-09-01 before version
`5cc10639-7683-40dd-8cd0-cade753d042c` was deployed. Wrangler currently reports
no pending Preview migration.

Before applying migration 0007, a private mode-`0600` rollback export was saved
at `.migration/preview-v2-pre-migration-20260901-1901.sql`. It is ignored by Git
and its contents must never be printed or committed. Worker rollback does not
reverse migration 0007 or the authenticated E2E rows described below.

The authenticated V2 smoke gate passed on 2026-09-01 with the separately issued
admin, viewer, and MCP credentials. Production remains intentionally untouched;
passing Preview does not itself authorize production resources or the
`fc.polly.wang` binding.

## Preview provisioning and deployment

Run from `worker/` after `npm install` and a fresh frontend build:

```sh
npx wrangler d1 create furniture-center-preview
npx wrangler r2 bucket create furniture-center-images-preview
npx wrangler d1 migrations apply furniture-center-preview --remote --env preview
npx wrangler d1 execute furniture-center-preview --remote --env preview \
  --file=../.migration/real-export-20260901-controller/d1-import.sql
npx wrangler r2 object put furniture-center-images-preview/furniture/<id>/images/<image>.jpg \
  --remote --file=../.migration/real-export-20260901-controller/r2/furniture/<id>/images/<image>.jpg \
  --content-type=image/jpeg
npm --prefix ../frontend run build
npx wrangler deploy --env preview
```

Apply migrations in filename order and confirm 0007 is listed before importing any
V2 SQLite export. The exporter includes `sites.is_active/version/timestamps`,
`inventory.status/closed_at/closed_reason`, and immutable `transfer_records`; it never
exports access-token rows. If imported transfer records reference actor token IDs,
create the matching target D1 token records from separately issued hashes before the
import. Never weaken the foreign key or copy plaintext credentials to satisfy an import.

After the first deploy, copy the printed `workers.dev` host exactly into
`env.preview.vars.MCP_ALLOWED_HOSTS` in `worker/wrangler.jsonc`, then deploy
again.  It must be a concrete host, never a wildcard.

Set Worker Secrets only through stdin.  The deployed secret values cannot be
retrieved.  For the CopilotX credential, obtain a dedicated value and feed it
without echoing or persisting it; generate the session value directly into the
second command:

```sh
printf '%s' "$FURNITURE_CENTER_OPENAI_API_KEY" | npx wrangler secret put COPILOTX_API_KEY --env preview
openssl rand -base64 48 | npx wrangler secret put SESSION_SIGNING_KEY --env preview
```

Do not use `wrangler deploy --temporary`.

## Authorized local preview credentials

There is deliberately no bootstrap credential or token-creation endpoint. The
user-authorized helper below creates three unique `ms-fc-` credentials with at
least 256 bits of entropy: a browser viewer, a browser admin, and a dedicated
MCP client. It writes raw values only to the exact repository-root file
`.env.preview-credentials.local`, refuses to overwrite it, sets mode `0600`,
and prints only its path. The CLI deliberately has no output-path override.
It writes and fsyncs a private same-directory temporary file, then publishes it
with a no-replacement atomic link; handled failures before publication remove
the temporary artifact and never create or replace the final file. Successful
runs remove that exact temporary file in `finally`. The generator never scans
or deletes existing sibling files; an abrupt interruption or failed unlink can
leave a `0600`, root-ignored `.env.preview-credentials.local.tmp-*` file for a
trusted operator to remove after confirming its name. Both that private
temporary-file family and the exact final filename are Git-ignored and must
remain untracked; never copy either into the main `.env`, a shell command,
chat, a report, or a commit.

```sh
python scripts/generate_preview_credentials.py
chmod 600 .env.preview-credentials.local
git check-ignore -v .env.preview-credentials.local
```

Insert **only SHA-256 hashes** into preview D1 through an in-process reader of
the local file. Use the role/label pairs `viewer` / `preview-browser-viewer`,
`admin` / `preview-admin`, and `viewer` / `preview-mcp-client`; preserve an
individual D1 ID for each record. The raw values must be unset or discarded
before Wrangler is called, and neither values nor hashes should be printed.

For a manual emergency issuance, run this once per credential from a trusted
terminal at `worker/`; the token is entered without echo and the raw value is
unset before Wrangler receives the SQL:

```sh
read -rs 'Preview token: ' FC_TOKEN; printf '\n'
FC_TOKEN_HASH=$(printf %s "$FC_TOKEN" | shasum -a 256 | awk '{print $1}')
unset FC_TOKEN
FC_TOKEN_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
# Replace ROLE and LABEL with viewer/preview-browser-viewer, admin/preview-admin,
# or viewer/preview-mcp-client. Do not paste the plaintext into this command.
npx wrangler d1 execute furniture-center-preview --remote --env preview --command \
  "INSERT INTO access_tokens (id, token_hash, role, scopes_json, label, daily_quota) VALUES ('$FC_TOKEN_ID', '$FC_TOKEN_HASH', 'ROLE', '[]', 'LABEL', 100);"
unset FC_TOKEN_HASH FC_TOKEN_ID
```

Enter the browser credentials directly into the deployed login page and the
MCP credential into a trusted Streamable HTTP client. Do not send any plaintext
value through chat. Test invalid/revoked credentials separately, CSRF logout,
viewer/admin route boundaries, Chat streaming, image reads, MCP discovery/tools,
and sanitized logs. For V2, create and edit one preview-only site, create an A=10
shared listing, allocate 3 to B, and prove A becomes unavailable, B is unchanged,
and the immutable history shows 10/3/7 plus reason, actor, and timestamp. Confirm
catalog, detail, map, Chat, and MCP all hide the closed source listing. Record only
IDs, role/labels, outcomes, row counts, and version IDs.

To rotate a preview credential, first revoke its D1 record, then remove the
local credential file on the trusted machine, regenerate a new file, and insert
a new hash/record. Revocation is immediate for sessions and Bearer validation:

```sh
npx wrangler d1 execute furniture-center-preview --remote --env preview --command \
  "UPDATE access_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE label = 'preview-browser-viewer' AND revoked_at IS NULL"
```

Preview credentials, hashes, D1 IDs, and Worker Secrets are never production
credentials. Future production issuance must use a separately generated,
separately stored local file and newly inserted production D1 records after the
preview gate passes.

## Verification and rollback

### V2 authenticated Preview evidence (2026-09-01)

The admin browser journey created site `E2E` as “Preview E2E 测试园区”, edited
it to “Preview E2E 验收园区” at `30.573, 104.067`, and then deactivated it after
the allocation test. Site version advanced from 1 to 3. Once inactive, it no
longer appeared in the new-listing site selector, public site filter, or MCP
`list_sites`; the admin site manager retained it as an inactive historical site.

The journey then published Preview-only listing `E2E-TRANSFER-20260901` with 10
available units at `E2E` and allocated 3 units to `SH`. The confirmation stated
that all 10 units would be removed from sharing, Shanghai would not receive
inventory, and the remaining 7 would not stay listed. Direct D1 verification
after the operation proved:

- the only inventory row for the test SKU remained at source `E2E` with
  `quantity_total=10`, `quantity_available=0`, `status=allocated`,
  `closed_reason=transferred`, and `version=2`;
- no destination inventory row was created or updated;
- one immutable record retained source `E2E`, destination `SH`, listed quantity
  10, transferred quantity 3, unlisted remainder 7, actor label
  `preview-admin`, the test reason, and its timestamp.

The closed SKU disappeared from the admin shared-item list and public catalog;
structured search returned zero results, the detail/map context stayed empty,
and Chat answered that the SKU was not found. The transfer-history UI retained
the exact `10 / 3 / 7` facts, route, actor, reason, and timestamp after the source
site was deactivated. Browser diagnostics reported no console log entries during
the final journey.

The viewer credential successfully created a viewer session but received `403`
from both `/api/admin/sites` and `/api/admin/transfers`. MCP initialized with
server name `家具共享平台`, negotiated protocol `2025-11-25`, and exposed only
`search_furniture`, `get_furniture`, `list_sites`, and `list_categories`; all
four declared read-only, non-destructive annotations. Searching the closed SKU
returned count 0 and direct lookup returned `not_found`. No write or transfer
history tool was exposed.

Unauthenticated checks that do not need a credential:

```sh
curl --fail-with-body https://furniture-center-preview.26716201.workers.dev/health
curl -o /dev/null -s -w '%{http_code}\n' https://furniture-center-preview.26716201.workers.dev/api/auth/session
npx wrangler d1 migrations list furniture-center-preview --remote --env preview
npx wrangler deployments list --env preview
```

Reconcile D1 row counts and every R2 object SHA-256 against the ignored
`real-export-20260901-controller/manifest.json`.  Use `--remote` for every R2
operation; without it Wrangler targets local emulator storage.

List a known-good preview version and preserve a redacted pre-migration D1 export before
any V2 migration or deployment. Worker rollback does not reverse additive D1 migration
0007 or restore changed test rows. If a smoke test fails, roll back only the preview
Worker, retain the pre-migration export plus D1/R2 evidence, and investigate before retrying:

```sh
npx wrangler deployments list --env preview
npx wrangler rollback <known-good-version-id> --env preview
```

## Production gate and cutover

Do not create production D1/R2 resources or configure `fc.polly.wang` until
the preview authenticated journey has passed.  Then recheck DNS ownership and
availability, create differently named production resources, add their IDs to
`env.production`, apply migrations, import a newly reconciled final package,
upload and hash-check private R2 objects, and install separately issued
production secrets and credentials.  Freeze old writes, re-run the final
delta/reconciliation, deploy the proven Worker version, attach
`fc.polly.wang`, verify HTTPS and all critical user journeys, and preserve the
previous production version for rollback.

Never reuse preview D1/R2 resources, token records, or secrets in production.
