import type { Env } from '../env'
import { roleAllows, sha256Hex, type AccessTokenIdentity, type Role } from './tokens'

const SESSION_COOKIE = 'fc_session'
const CSRF_COOKIE = 'fc_csrf'
const SESSION_TTL_SECONDS = 12 * 60 * 60

type SessionRow = {
  session_id: string
  csrf_hash: string
  session_expires_at: string
  session_revoked_at: string | null
  token_id: string
  role: Role
  label: string
  scopes_json: string
  token_expires_at: string | null
  token_revoked_at: string | null
}

export type SessionIdentity = AccessTokenIdentity & {
  sessionId: string
  csrfHash: string
  sessionExpiresAt: string
}

export type CreatedSession = {
  sessionCookie: string
  csrfCookie: string
  csrfToken: string
  expiresAt: string
}

function randomToken(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlToBytes(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    const binary = atob(normalized + padding)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

async function hmacKey(signingKey: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )
}

async function signSession(rawSession: string, signingKey: string) {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(signingKey, 'sign'),
    new TextEncoder().encode(rawSession),
  )
  let binary = ''
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

async function verifySessionSignature(rawSession: string, signature: string, signingKey: string) {
  const signatureBytes = base64UrlToBytes(signature)
  if (!signatureBytes) return false
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(signingKey, 'verify'),
    signatureBytes,
    new TextEncoder().encode(rawSession),
  )
}

export function readCookie(request: Request, name: string) {
  const cookieHeader = request.headers.get('Cookie')
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [cookieName, ...valueParts] = part.trim().split('=')
    if (cookieName === name) return valueParts.join('=')
  }
  return null
}

function validDate(value: string | null, now: Date) {
  if (!value) return true
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > now.getTime()
}

function parseScopes(scopesJson: string) {
  try {
    const value: unknown = JSON.parse(scopesJson)
    return Array.isArray(value) && value.every((scope) => typeof scope === 'string')
      ? value
      : []
  } catch {
    return []
  }
}

export async function createSession(
  env: Env,
  identity: AccessTokenIdentity,
  now = new Date(),
): Promise<CreatedSession> {
  const rawSession = randomToken()
  const csrfToken = randomToken()
  const signature = await signSession(rawSession, env.SESSION_SIGNING_KEY)
  const defaultExpiry = now.getTime() + SESSION_TTL_SECONDS * 1000
  const tokenExpiry = identity.expiresAt ? Date.parse(identity.expiresAt) : Number.POSITIVE_INFINITY
  const expiresAt = new Date(Math.min(defaultExpiry, tokenExpiry)).toISOString()
  await env.DB.prepare(
    `INSERT INTO sessions
      (id, session_hash, token_id, csrf_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      await sha256Hex(rawSession),
      identity.tokenId,
      await sha256Hex(csrfToken),
      expiresAt,
    )
    .run()
  return {
    sessionCookie: `${SESSION_COOKIE}=${rawSession}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`,
    csrfCookie: `${CSRF_COOKIE}=${csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`,
    csrfToken,
    expiresAt,
  }
}

export async function authenticateSession(
  request: Request,
  env: Env,
  now = new Date(),
): Promise<SessionIdentity | null> {
  const signedSession = readCookie(request, SESSION_COOKIE)
  if (!signedSession) return null
  const separator = signedSession.lastIndexOf('.')
  if (separator <= 0) return null
  const rawSession = signedSession.slice(0, separator)
  const signature = signedSession.slice(separator + 1)
  if (!(await verifySessionSignature(rawSession, signature, env.SESSION_SIGNING_KEY))) return null

  const row = await env.DB.prepare(
    `SELECT
       sessions.id AS session_id,
       sessions.csrf_hash,
       sessions.expires_at AS session_expires_at,
       sessions.revoked_at AS session_revoked_at,
       access_tokens.id AS token_id,
       access_tokens.role,
       access_tokens.label,
       access_tokens.scopes_json,
       access_tokens.expires_at AS token_expires_at,
       access_tokens.revoked_at AS token_revoked_at
     FROM sessions
     JOIN access_tokens ON access_tokens.id = sessions.token_id
     WHERE sessions.session_hash = ?
     LIMIT 1`,
  )
    .bind(await sha256Hex(rawSession))
    .first<SessionRow>()
  if (
    !row ||
    row.session_revoked_at ||
    row.token_revoked_at ||
    !validDate(row.session_expires_at, now) ||
    !validDate(row.token_expires_at, now) ||
    !roleAllows(row.role, 'viewer')
  ) {
    return null
  }
  return {
    sessionId: row.session_id,
    csrfHash: row.csrf_hash,
    sessionExpiresAt: row.session_expires_at,
    tokenId: row.token_id,
    role: row.role,
    label: row.label,
    scopes: parseScopes(row.scopes_json),
    expiresAt: row.token_expires_at,
  }
}

export async function revokeSession(database: D1Database, sessionId: string, now = new Date()) {
  await database
    .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(now.toISOString(), sessionId)
    .run()
}

export async function verifyCsrf(request: Request, identity: SessionIdentity) {
  const headerToken = request.headers.get('X-CSRF-Token')
  const cookieToken = readCookie(request, CSRF_COOKIE)
  if (!headerToken || !cookieToken || headerToken !== cookieToken) return false
  return (await sha256Hex(headerToken)) === identity.csrfHash
}

export function clearSessionCookies() {
  return [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    `${CSRF_COOKIE}=; Path=/; Secure; SameSite=Strict; Max-Age=0`,
  ]
}
