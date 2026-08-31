import type { MiddlewareHandler } from 'hono'
import type { Env } from '../env'
import { authenticateSession, verifyCsrf, type SessionIdentity } from './sessions'
import { roleAllows, verifyAccessToken, type AccessTokenIdentity, type Role } from './tokens'

export type AuthContext = AccessTokenIdentity & {
  sessionId?: string
  csrfHash?: string
  sessionExpiresAt?: string
}

export type AuthVariables = {
  auth: AuthContext
}

export type AuthEnvironment = {
  Bindings: Env
  Variables: AuthVariables
}

function unauthorized() {
  return new Response(JSON.stringify({ detail: '未认证或凭据已失效' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

function forbidden(detail = '权限不足') {
  return new Response(JSON.stringify({ detail }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function requireRole(required: Role): MiddlewareHandler<AuthEnvironment> {
  return async (context, next) => {
    const identity = await authenticateSession(context.req.raw, context.env)
    if (!identity) return unauthorized()
    if (!roleAllows(identity.role, required)) return forbidden()
    context.set('auth', identity)
    await next()
  }
}

export function requireCsrf(): MiddlewareHandler<AuthEnvironment> {
  return async (context, next) => {
    const identity = context.get('auth') as SessionIdentity | undefined
    if (!identity?.sessionId || !identity.csrfHash) return forbidden('CSRF 验证失败')
    const requestOrigin = context.req.header('Origin')
    if (!requestOrigin || requestOrigin !== new URL(context.req.url).origin) {
      return forbidden('来源验证失败')
    }
    if (!(await verifyCsrf(context.req.raw, identity))) return forbidden('CSRF 验证失败')
    await next()
  }
}

export function requireBearerRole(required: Role): MiddlewareHandler<AuthEnvironment> {
  return async (context, next) => {
    const authorization = context.req.header('Authorization')
    const match = authorization?.match(/^Bearer ([^\s]+)$/u)
    if (!match) return unauthorized()
    const identity = await verifyAccessToken(context.env.DB, match[1])
    if (!identity) return unauthorized()
    if (!roleAllows(identity.role, required)) return forbidden()
    context.set('auth', identity)
    await next()
  }
}
