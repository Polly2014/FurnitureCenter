# 家具共享平台 Cloudflare deployment runbook

> Production 资源创建、Cloudflare 配置审计、`fc.polly.wang` Custom Domain
> 切换、独立 Token 治理和 Definition of Done 见
> [Cloudflare Production 与域名切换 Goal](../plans/2026-09-01-cloudflare-production-domain-cutover-goal.md)。

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
admin, viewer, and MCP credentials. At that checkpoint Production was still
intentionally untouched; passing Preview did not itself authorize production
resources or the `fc.polly.wang` binding. The later authorized cutover is recorded
in the Production checkpoints below.

The production candidate is now regenerated from the clean V2 local database and
documented in [Production data manifest](production-data-manifest.md). Do not use the
historical `real-export-20260901-controller` package for Production: it predates the V2
export contract even though migration defaults made it sufficient for the original
Preview bootstrap.

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
new V2 SQLite export. The current exporter includes `sites.is_active/version/timestamps`,
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

## Authorized local Production credentials

Production uses the same fixed-path, atomic-write safety contract as Preview but
has distinct variable names and a distinct ignored file. The generator refuses
an output override or overwrite, creates three unique `ms-fc-` values with at
least 256 bits of entropy, and prints only the destination path:

```sh
python scripts/generate_production_credentials.py
chmod 600 .env.production-credentials.local
git check-ignore -v .env.production-credentials.local
```

The variables are `FC_PRODUCTION_VIEWER_TOKEN`, `FC_PRODUCTION_ADMIN_TOKEN`, and
`FC_PRODUCTION_MCP_TOKEN`. Insert only their SHA-256 digests with labels
`production-browser-viewer`, `production-admin`, and `production-mcp-client`;
never reuse the Preview file, token records, IDs, or digests. If the file already
exists, the generator must fail rather than rotate or replace it.

Wrangler 4.127.1 cannot use `secret put` before the Worker exists, and a real
`versions upload` cannot create the first Worker version even though its dry-run
succeeds. The first version therefore requires `deploy`; keep that deployment
unreachable instead of silently opening an ingress:

1. create a dedicated CopilotX `user` key for `furniture-center` and capture its
   one-time plaintext only in the trusted provisioning process;
2. generate a fresh session-signing value and place both values in a private,
   ignored, mode-`0600` temporary secrets file;
3. set both `workers_dev=false` and `preview_urls=false` in `env.production`,
   keep Production routes empty, and set `triggers.crons=[]` so the inheritable
   top-level schedule cannot invoke the sealed Worker;
4. run `wrangler deploy --secrets-file <private-file> --env production` only in a
   separately authorized window to create the initial zero-ingress deployment;
5. remove the exact temporary file in `finally`, then verify only the two Secret
   names, version ID, bindings, absence of public URLs/routes, and absence of
   Cron schedules;
6. do not expose `workers.dev` or bind the Custom Domain until the separately
   authorized public-entry phase.

Use CopilotX role `user` with an explicit finite daily quota (the initial
Production recommendation is 300 requests/day). If CopilotX user creation
succeeds but the Worker version upload fails, immediately soft-delete only the
new `furniture-center` user; do not retain its plaintext Key or fall back to the
global admin Key. Retry later with a newly issued dedicated Key.

Production sets `preview_urls=false`, so the uploaded version has no version
Preview URL, and `workers_dev=false`, so the initial deployment has no
workers.dev ingress. It also overrides the otherwise inherited Cron list with
an empty list. Cloudflare still records the first version as the deployment's
100% allocation, but no public or scheduled trigger can invoke it. The first
upload requirement is documented by Cloudflare under
[Deployment management / First upload](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/#first-upload).
Never persist the CopilotX user Key in the repository credential file; that
file contains only the three FurnitureCenter client credentials.

### Sealed Production checkpoint (2026-09-02)

The separately authorized first Production deployment completed with version
`c486019a-1e3a-4ee9-ab51-632bc0d56598` and deployment
`e49c71df-3406-44ab-be26-46f871eac6cb`. It has the Production D1/R2/Images/
Assets bindings, `ENVIRONMENT=production`, `MCP_ALLOWED_HOSTS=fc.polly.wang`,
and the two expected Worker Secret names. The dedicated CopilotX user has role
`user` and a 300-request daily quota; its one-time Key was verified before being
placed only in the Worker Secret. No Secret value is retained in the repository
or the local client credential file, and the temporary secrets file was removed.

Cloudflare's remote script and Production-environment subdomain APIs both report
`enabled=false` and `previews_enabled=false`. Cron schedules, Workers Routes,
and Custom Domains each have count zero. The base workers.dev URL and the
versioned Preview URL are unreachable, while `fc.polly.wang` still has no A,
AAAA, or CNAME record. A version may report `metadata.has_preview=true` even
when it is sealed: that is version capability metadata. Public availability is
controlled by `previews_enabled`; Cloudflare's
[Preview URLs documentation](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)
states that disabling Preview URLs disables both versioned and aliased Preview
routing.

At checkpoint close, all three Production client credential labels were active,
while the six catalog/inventory/transfer business tables were still empty. No
Phase 3 data import occurred during this deployment step.

The user separately confirmed the 3-site, 4-furniture, 5-inventory-position,
4-image Production data manifest and the exclusion of all Preview E2E rows.
This checkpoint did not itself authorize Phase 3. The user later authorized the
separate data/recovery phase described below. It still did not authorize
workers.dev exposure, Custom Domain binding, Preview retirement, or push.

### Production data and recovery checkpoint (2026-09-02)

Before import, export the complete Production D1 to an ignored mode-`0600` file
and capture a Time Travel point. Wrangler prints a one-hour signed download URL
during `d1 export`; redirect that command's complete output to a private
mode-`0600` operator log and never paste the URL into chat, documentation, CI
output, or a commit. The SQL export can contain access-token digests even though
it cannot contain Worker Secrets.

The first authorized Production import revealed that the exporter wrapped its
statements in an explicit transaction, which remote D1 rejects. The automatic
rollback restored the zero-business-row state. A regression test now requires
the generated D1 package to omit explicit transaction wrappers. The regenerated
package at `.migration/production-baseline-v2-d1safe-20260902/` has the same
manifest and image bytes as the user-approved package; only the rejected SQL
wrapper was removed.

Before retrying Production, the package was proven against disposable D1
`furniture-center-d1-restore-test-20260902-0310`: all migrations and the import
passed, Time Travel restored the database to its empty post-migration state, and
a second import reconciled again. The disposable database was then deleted.
Production now contains 3 categories, 3 sites, 4 furniture records, 4 image
metadata rows, 5 inventory positions, and no transfer/adjustment/audit rows.
Foreign-key violations and Preview E2E rows are both zero, while all three
Production client credential labels remain active.

All four JPEGs were uploaded to private Production R2 and read back through the
Cloudflare object API. Their keys, MIME types, byte sizes, and SHA-256 values
matched the ignored manifest without recording digest values here. A disposable
R2 bucket rebuilt and verified the same four objects and was then emptied and
deleted. Production `r2.dev` remains disabled and has no R2 Custom Domain.

The Phase 3 D1 pre-import export is
`.migration/production-phase3-preimport-20260902T030446Z.sql`; keep it mode
`0600` and Git-ignored. Keep the D1-safe package and its R2 bytes under the same
permissions. Do not delete or overwrite the current Production R2 objects during
the first cutover window.

### Production cutover checkpoint (2026-09-02)

The controlled `workers.dev` preflight used version
`7e067725-fbac-47f6-8123-fcca9e5e43ea`. After the authenticated preflight, an
actual Worker recovery drill rolled back to the sealed version
`c486019a-1e3a-4ee9-ab51-632bc0d56598`, then restored the verified application as
version `c73e33c5-6e71-44bc-a6f8-110c8bed1db6`. Health, bindings, Secret names,
and Production data counts remained intact throughout; Worker rollback did not
change D1 or R2.

`fc.polly.wang` was then attached as a Worker Custom Domain with version
`e7bb1305-f822-4d1d-a722-5b8fcde16427`. Do not add a manual A/AAAA/CNAME or a
Workers Route for this hostname. HTTPS `/health` returned 200, HTTP redirected
to HTTPS, and the Cloudflare-managed certificate SAN explicitly included
`fc.polly.wang`.
The Production workers.dev and version Preview URL switches were disabled after
the cutover.

Production smoke exposed one Chat planner defect: a generic catalog phrase such
as `可共享家具` was incorrectly retained as a full-text query even after the
planner had resolved the Shanghai site. The regression test failed before the
fix and passed after generic-only catalog terms were normalized to no text
query. Version `28f6317c-9ce8-4e4e-93af-0ef59d1741c6` returned the two expected
Shanghai listings on the formal domain. The complete Viewer, Admin, Chat,
image/lightbox, map, MCP, CSRF, Origin/Host, Token lifecycle, rate-limit, desktop,
and 760px browser journeys are recorded in
[Production verification](production-verification.md).

Production observability is intentionally privacy-minimized. Version
`94e283de-4531-41dd-a6e7-2c0d3140ec5c` persists a 5% sample of custom/error logs
with invocation logs disabled. It explicitly disables persistent traces because
Cloudflare automatic traces include `url.query` and `db.query.text`, while the
current catalog API can place user-entered search text in a query string. The
Free-plan retention recorded at cutover is three days. Reconsider tracing only
after sensitive URL fields are removed or a proven field-redaction control is
available.

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

## Preview retirement after Production acceptance

The user conditionally authorized retirement of exactly the Preview Worker
`furniture-center-preview`, D1 `furniture-center-preview`, and R2
`furniture-center-images-preview`. Do not delete them merely because Phase 1 storage or
schema checks pass. Retirement is allowed only after the complete Production smoke gate,
the minimum 30-minute stable observation, and verified Worker/D1/R2 recovery evidence.

Immediately before deletion, create and verify a fresh ignored mode-`0600` Preview D1
export plus a complete local R2 object package/manifest. Prove Production bindings and
`fc.polly.wang` have no reference to the Preview resource IDs. Delete in the order Worker,
D1, then R2, rerunning Production health checks after each step. Stop on the first failure.
This authorization does not cover any User/Account API Token, Tunnel, other Worker,
Pages project, token record, or local credential file.

### Retirement result (2026-09-02)

The Production gate passed and the three exact Preview resources were retired in the
required Worker → D1 → R2 order. The recovery package is stored locally under the ignored,
mode-`0600` directory
`.migration/preview-retirement-backup-20260902T044056Z/`.

The D1 export contains all 17 application tables. It was imported into a disposable remote
D1, reconciled table by table with zero foreign-key violations, and re-exported byte-for-byte
identically before the disposable database was deleted. The R2 package contains all four
objects reported by the remote bucket; each key, MIME type, byte size, dimensions, and
SHA-256 matches D1 metadata and the private manifest.

After each deletion, `https://fc.polly.wang/health` and the relevant Production bindings or
data were rechecked. The final Production regression authenticated as Viewer, returned four
available catalog items and four image references, fetched a real JPEG from the Production
R2 binding, and logged out successfully. The old unauthenticated Preview commands in the
historical verification section above are no longer expected to succeed.

No Cloudflare API Token, Tunnel, other Worker/Pages project, local credential file, or
Production resource was deleted. Recreating Preview now requires a new Worker/D1/R2 set and
an explicit restore from the private package; the deleted resources cannot be restored in
place.
