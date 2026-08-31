import {
  applyD1Migrations,
  createExecutionContext,
  env,
  SELF,
} from 'cloudflare:test'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AuthVariables } from '../src/auth/middleware'
import {
  requireBearerRole,
  requireCsrf,
  requireRole,
} from '../src/auth/middleware'
import type { Env } from '../src/env'

const origin = 'https://fc.test'
const viewerToken = 'fc_test_viewer_0123456789abcdefghijklmnopqrstuvwxyz'
const adminToken = 'fc_test_admin_0123456789abcdefghijklmnopqrstuvwxyz'
const revokedToken = 'fc_test_revoked_0123456789abcdefghijklmnopqrstuvwxyz'
const expiredToken = 'fc_test_expired_0123456789abcdefghijklmnopqrstuvwxyz'

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function insertToken(options: {
  id: string
  raw: string
  role: 'viewer' | 'admin'
  label: string
  expiresAt?: string | null
  revokedAt?: string | null
}) {
  await env.DB.prepare(
    `INSERT INTO access_tokens
      (id, token_hash, role, scopes_json, label, expires_at, revoked_at)
     VALUES (?, ?, ?, '[]', ?, ?, ?)`,
  )
    .bind(
      options.id,
      await sha256(options.raw),
      options.role,
      options.label,
      options.expiresAt ?? null,
      options.revokedAt ?? null,
    )
    .run()
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM access_tokens'),
  ])
  await insertToken({
    id: 'token-viewer',
    raw: viewerToken,
    role: 'viewer',
    label: 'Viewer test',
  })
  await insertToken({
    id: 'token-admin',
    raw: adminToken,
    role: 'admin',
    label: 'Admin test',
  })
  await insertToken({
    id: 'token-revoked',
    raw: revokedToken,
    role: 'viewer',
    label: 'Revoked test',
    revokedAt: '2026-08-30T00:00:00.000Z',
  })
  await insertToken({
    id: 'token-expired',
    raw: expiredToken,
    role: 'viewer',
    label: 'Expired test',
    expiresAt: '2026-08-30T00:00:00.000Z',
  })
})

async function login(token: string) {
  return SELF.fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ token }),
  })
}

function extractCookie(setCookie: string, name: string) {
  const match = setCookie.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`))
  if (!match) throw new Error(`Missing ${name} cookie`)
  return { header: `${name}=${match[1]}`, value: match[1] }
}

async function authenticatedCookies(token: string) {
  const response = await login(token)
  expect(response.status).toBe(200)
  const setCookie = response.headers.get('set-cookie') ?? ''
  const session = extractCookie(setCookie, 'fc_session')
  const csrf = extractCookie(setCookie, 'fc_csrf')
  return {
    response,
    cookie: `${session.header}; ${csrf.header}`,
    csrf: csrf.value,
    setCookie,
  }
}

describe('browser token exchange and sessions', () => {
  it.each([
    ['unknown', 'fc_test_unknown_0123456789abcdefghijklmnopqrstuvwxyz'],
    ['revoked', revokedToken],
    ['expired', expiredToken],
  ])('rejects %s credentials without creating a session', async (_label, token) => {
    const response = await login(token)

    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM sessions').first()).toEqual({
      count: 0,
    })
  })

  it('issues strict cookies and returns only non-secret viewer identity', async () => {
    const { response, setCookie } = await authenticatedCookies(viewerToken)
    const body = await response.json<{
      role: string
      label: string
      expires_at: string
    }>()

    expect(body.role).toBe('viewer')
    expect(body.label).toBe('Viewer test')
    expect(body.expires_at).toMatch(/Z$/)
    expect(JSON.stringify(body)).not.toContain(viewerToken)
    expect(setCookie).toMatch(
      /fc_session=[^;]+;[^,]*Path=\/;[^,]*HttpOnly;[^,]*Secure;[^,]*SameSite=Strict/i,
    )
    expect(setCookie).toMatch(
      /fc_csrf=[^;]+;[^,]*Path=\/;[^,]*Secure;[^,]*SameSite=Strict/i,
    )

    const storedToken = await env.DB.prepare(
      'SELECT token_hash FROM access_tokens WHERE id = ?',
    )
      .bind('token-viewer')
      .first<{ token_hash: string }>()
    const storedSession = await env.DB.prepare(
      'SELECT session_hash, csrf_hash FROM sessions',
    ).first<{ session_hash: string; csrf_hash: string }>()
    expect(storedToken?.token_hash).toBe(await sha256(viewerToken))
    expect(storedToken?.token_hash).not.toContain(viewerToken)
    expect(JSON.stringify(storedSession)).not.toContain(viewerToken)
    expect(JSON.stringify(storedSession)).not.toContain('fc_session=')
  })

  it('returns session identity and invalidates it immediately after token revocation', async () => {
    const { cookie } = await authenticatedCookies(viewerToken)
    const current = await SELF.fetch(`${origin}/api/auth/session`, {
      headers: { Cookie: cookie },
    })
    expect(current.status).toBe(200)
    expect(await current.json()).toMatchObject({ role: 'viewer', label: 'Viewer test' })

    await env.DB.prepare(
      "UPDATE access_tokens SET revoked_at = '2026-08-31T00:00:00.000Z' WHERE id = ?",
    )
      .bind('token-viewer')
      .run()
    const revoked = await SELF.fetch(`${origin}/api/auth/session`, {
      headers: { Cookie: cookie },
    })
    expect(revoked.status).toBe(401)
  })

  it('requires both admin role and CSRF for a state-changing route', async () => {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
    app.post('/admin-change', requireRole('admin'), requireCsrf(), (context) =>
      context.json({ changed: true }),
    )
    const viewer = await authenticatedCookies(viewerToken)
    const admin = await authenticatedCookies(adminToken)

    const viewerResponse = await app.fetch(
      new Request(`${origin}/admin-change`, {
        method: 'POST',
        headers: {
          Cookie: viewer.cookie,
          Origin: origin,
          'X-CSRF-Token': viewer.csrf,
        },
      }),
      env,
      createExecutionContext(),
    )
    expect(viewerResponse.status).toBe(403)

    const missingCsrf = await app.fetch(
      new Request(`${origin}/admin-change`, {
        method: 'POST',
        headers: { Cookie: admin.cookie, Origin: origin },
      }),
      env,
      createExecutionContext(),
    )
    expect(missingCsrf.status).toBe(403)

    const adminResponse = await app.fetch(
      new Request(`${origin}/admin-change`, {
        method: 'POST',
        headers: {
          Cookie: admin.cookie,
          Origin: origin,
          'X-CSRF-Token': admin.csrf,
        },
      }),
      env,
      createExecutionContext(),
    )
    expect(adminResponse.status).toBe(200)
    expect(await adminResponse.json()).toEqual({ changed: true })
  })

  it('requires CSRF to log out and rejects the session after logout', async () => {
    const { cookie, csrf } = await authenticatedCookies(viewerToken)
    const missingCsrf = await SELF.fetch(`${origin}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
    })
    expect(missingCsrf.status).toBe(403)

    const loggedOut = await SELF.fetch(`${origin}/api/auth/logout`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'X-CSRF-Token': csrf,
      },
    })
    expect(loggedOut.status).toBe(204)
    expect(loggedOut.headers.get('set-cookie')).toContain('Max-Age=0')

    const current = await SELF.fetch(`${origin}/api/auth/session`, {
      headers: { Cookie: cookie },
    })
    expect(current.status).toBe(401)
  })
})

describe('MCP bearer credentials', () => {
  it('accepts an active viewer token and rejects missing, invalid and revoked tokens', async () => {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
    app.get('/mcp', requireBearerRole('viewer'), (context) =>
      context.json({ role: context.get('auth').role }),
    )

    for (const authorization of [undefined, 'Bearer invalid', `Bearer ${revokedToken}`]) {
      const response = await app.fetch(
        new Request(`${origin}/mcp`, {
          headers: authorization ? { Authorization: authorization } : {},
        }),
        env,
        createExecutionContext(),
      )
      expect(response.status).toBe(401)
    }

    const response = await app.fetch(
      new Request(`${origin}/mcp`, {
        headers: { Authorization: `Bearer ${viewerToken}` },
      }),
      env,
      createExecutionContext(),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ role: 'viewer' })
  })
})
