import { createMcpHandler } from 'agents/mcp/server'
import {
  hostHeaderValidationResponse,
  originValidationResponse,
  type AuthInfo,
} from '@modelcontextprotocol/server'
import type { Hono } from 'hono'
import { markTokenUsed, roleAllows, verifyAccessToken } from '../auth/tokens'
import type { AuthEnvironment } from '../auth/middleware'
import type { Env } from '../env'
import { createFurnitureMcpServer } from './server'

const MAX_BODY_BYTES = 64 * 1024
const DEFAULT_MCP_DAILY_QUOTA = 100
const localHostnames = ['localhost', '127.0.0.1', '[::1]']

function json(detail: string, status: number, headers: HeadersInit = {}) {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function configuredPreviewHosts(env: Env) {
  return (env.MCP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev$/u.test(host))
}

function allowedHostnames(env: Env) {
  if (env.ENVIRONMENT === 'production') return ['fc.polly.wang']
  if (env.ENVIRONMENT === 'preview') return configuredPreviewHosts(env)
  return localHostnames
}

function validateRequestSource(request: Request, env: Env) {
  const hostnames = allowedHostnames(env)
  const hostRejection = hostHeaderValidationResponse(request, hostnames)
  if (hostRejection) return json('MCP Host is not allowed.', 403)
  const originRejection = originValidationResponse(request, hostnames)
  if (originRejection) return json('MCP Origin is not allowed.', 403)
  const origin = request.headers.get('Origin')
  if (origin) {
    try {
      const scheme = new URL(origin).protocol
      if (env.ENVIRONMENT !== 'local' && scheme !== 'https:') {
        return json('MCP Origin is not allowed.', 403)
      }
      if (scheme !== 'http:' && scheme !== 'https:') return json('MCP Origin is not allowed.', 403)
    } catch {
      return json('MCP Origin is not allowed.', 403)
    }
  }
  return null
}

async function readBody(request: Request) {
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim() !== 'application/json') return null
  const contentLength = request.headers.get('Content-Length')
  const declared = contentLength === null ? null : Number(contentLength)
  if (declared !== null && Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
}

async function authenticate(request: Request, env: Env) {
  const authorization = request.headers.get('Authorization')
  const match = authorization?.match(/^Bearer ([^\s]+)$/u)
  if (!match) return null
  const identity = await verifyAccessToken(env.DB, match[1])
  if (!identity || !roleAllows(identity.role, 'viewer')) return null
  await markTokenUsed(env.DB, identity.tokenId)
  const authInfo: AuthInfo = {
    token: identity.tokenId,
    clientId: identity.tokenId,
    scopes: identity.scopes,
    expiresAt: identity.expiresAt ? Math.floor(Date.parse(identity.expiresAt) / 1000) : undefined,
    extra: { role: identity.role, label: identity.label },
  }
  return { identity, authInfo }
}

async function reserveMcpQuota(env: Env, tokenId: string, now = new Date()) {
  const token = await env.DB.prepare(
    'SELECT daily_quota FROM access_tokens WHERE id = ? AND revoked_at IS NULL',
  ).bind(tokenId).first<{ daily_quota: number | null }>()
  if (!token) return false
  const quota = token.daily_quota ?? DEFAULT_MCP_DAILY_QUOTA
  const result = await env.DB.prepare(
    `INSERT INTO mcp_daily_usage (token_id, usage_date, used) VALUES (?, ?, 1)
     ON CONFLICT(token_id, usage_date) DO UPDATE SET used = used + 1
     WHERE used < ?`,
  ).bind(tokenId, now.toISOString().slice(0, 10), quota).run()
  return result.meta.changes === 1
}

function rpcMethod(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const method = (body as Record<string, unknown>).method
  return typeof method === 'string' ? method : null
}

export function registerMcpRoutes(app: Hono<AuthEnvironment>) {
  app.all('/mcp', async (context) => {
    if (context.req.method !== 'POST') {
      return json('MCP uses POST-only Streamable HTTP.', 405, { Allow: 'POST' })
    }
    const sourceRejection = validateRequestSource(context.req.raw, context.env)
    if (sourceRejection) return sourceRejection
    const auth = await authenticate(context.req.raw, context.env)
    if (!auth) return json('未认证或凭据已失效', 401)
    const parsedBody = await readBody(context.req.raw)
    if (parsedBody === null) return json('MCP request body must be bounded JSON.', 400)
    if (rpcMethod(parsedBody) === 'tools/call' && !(await reserveMcpQuota(context.env, auth.identity.tokenId))) {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: (parsedBody as Record<string, unknown>).id ?? null,
        error: { code: -32029, message: 'MCP daily quota exceeded.' },
      }), { status: 429, headers: { 'Content-Type': 'application/json' } })
    }

    const handler = createMcpHandler(
      () => createFurnitureMcpServer(context.env, new URL(context.req.url).origin),
      {
        route: '/mcp',
        legacy: 'stateless',
        responseMode: 'auto',
        corsOptions: false,
        allowedHostnames: allowedHostnames(context.env),
        allowedOriginHostnames: '*',
      },
    )
    return handler.fetch(context.req.raw, { authInfo: auth.authInfo, parsedBody })
  })
}
