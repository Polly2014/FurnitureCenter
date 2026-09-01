# FurnitureCenter Cloudflare deployment runbook

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
| deployed version | `2b57177b-076e-41a0-bf9e-602d7d68057b` |
| MCP host allow-list | `furniture-center-preview.26716201.workers.dev` |
| Worker Secrets (names only) | `COPILOTX_API_KEY`, `SESSION_SIGNING_KEY` |

The preview D1 database has all six migrations and the reconciled real catalog:
3 categories, 3 sites, 4 furniture records, 5 inventory positions, 4 image
metadata records, and zero audit/adjustment records.  Four JPEG objects were
uploaded to its private R2 bucket and SHA-256 reconciled.

Preview is not production-ready until a human securely issues separate viewer,
admin, and MCP credentials and completes the authenticated smoke tests.

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
and prints only its path. That exact filename is Git-ignored and must remain
untracked; never copy it into the main `.env`, a shell command, chat, a report,
or a commit.

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
viewer/admin route boundaries, Chat streaming, four image reads, an inventory
adjustment and transfer (with audit rows), MCP discovery/tools, and sanitized
logs. Record only IDs, role/labels, outcomes, and version IDs.

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

List a known-good preview version before any new deployment.  If a smoke test
fails after deployment, roll back only the preview Worker, retain its D1/R2
evidence, and investigate before retrying:

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
