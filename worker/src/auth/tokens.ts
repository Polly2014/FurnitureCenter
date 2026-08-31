export type Role = 'viewer' | 'admin'

export type AccessTokenIdentity = {
  tokenId: string
  role: Role
  label: string
  scopes: string[]
  expiresAt: string | null
}

type AccessTokenRow = {
  id: string
  role: Role
  label: string
  scopes_json: string
  expires_at: string | null
  revoked_at: string | null
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isExpired(expiresAt: string | null, now: Date) {
  if (!expiresAt) return false
  const timestamp = Date.parse(expiresAt)
  return !Number.isFinite(timestamp) || timestamp <= now.getTime()
}

function parseScopes(scopesJson: string) {
  try {
    const scopes: unknown = JSON.parse(scopesJson)
    return Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string')
      ? scopes
      : []
  } catch {
    return []
  }
}

export async function verifyAccessToken(
  database: D1Database,
  rawToken: string,
  now = new Date(),
): Promise<AccessTokenIdentity | null> {
  if (rawToken.length < 32 || rawToken.length > 512) return null
  const row = await database
    .prepare(
      `SELECT id, role, label, scopes_json, expires_at, revoked_at
       FROM access_tokens WHERE token_hash = ? LIMIT 1`,
    )
    .bind(await sha256Hex(rawToken))
    .first<AccessTokenRow>()
  if (!row || row.revoked_at || isExpired(row.expires_at, now)) return null
  if (row.role !== 'viewer' && row.role !== 'admin') return null
  return {
    tokenId: row.id,
    role: row.role,
    label: row.label,
    scopes: parseScopes(row.scopes_json),
    expiresAt: row.expires_at,
  }
}

export async function markTokenUsed(database: D1Database, tokenId: string, now = new Date()) {
  await database
    .prepare('UPDATE access_tokens SET last_used_at = ? WHERE id = ?')
    .bind(now.toISOString(), tokenId)
    .run()
}

export function roleAllows(actual: Role, required: Role) {
  return actual === 'admin' || required === 'viewer'
}
