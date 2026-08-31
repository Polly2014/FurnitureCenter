import type { Hono } from 'hono'
import type { AuthEnvironment } from './middleware'
import { requireCsrf, requireRole } from './middleware'
import {
  clearSessionCookies,
  createSession,
  revokeSession,
} from './sessions'
import { markTokenUsed, verifyAccessToken } from './tokens'

function sameOrigin(request: Request) {
  const origin = request.headers.get('Origin')
  return Boolean(origin && origin === new URL(request.url).origin)
}

export function registerAuthRoutes(app: Hono<AuthEnvironment>) {
  app.post('/api/auth/login', async (context) => {
    if (!sameOrigin(context.req.raw)) return context.json({ detail: '来源验证失败' }, 403)
    const payload = await context.req.json<{ token?: unknown }>().catch(() => null)
    const rawToken = typeof payload?.token === 'string' ? payload.token.trim() : ''
    const identity = await verifyAccessToken(context.env.DB, rawToken)
    if (!identity) return context.json({ detail: '凭据无效或已失效' }, 401)

    const session = await createSession(context.env, identity)
    await markTokenUsed(context.env.DB, identity.tokenId)
    context.header('Set-Cookie', session.sessionCookie, { append: true })
    context.header('Set-Cookie', session.csrfCookie, { append: true })
    return context.json({
      role: identity.role,
      label: identity.label,
      expires_at: session.expiresAt,
    })
  })

  app.get('/api/auth/session', requireRole('viewer'), (context) => {
    const identity = context.get('auth')
    return context.json({
      role: identity.role,
      label: identity.label,
      expires_at: identity.sessionExpiresAt,
    })
  })

  app.post(
    '/api/auth/logout',
    requireRole('viewer'),
    requireCsrf(),
    async (context) => {
      const identity = context.get('auth')
      if (identity.sessionId) await revokeSession(context.env.DB, identity.sessionId)
      for (const cookie of clearSessionCookies()) {
        context.header('Set-Cookie', cookie, { append: true })
      }
      return context.body(null, 204)
    },
  )
}
