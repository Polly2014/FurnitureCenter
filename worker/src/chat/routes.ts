import type { Context, Hono } from 'hono'
import { requireCsrf, requireRole, type AuthEnvironment } from '../auth/middleware'
import { D1CatalogRepository } from '../catalog/repository'
import { CatalogService } from '../catalog/service'
import { CopilotXClient, CopilotXError, DEFAULT_BASE_URL, DEFAULT_MODEL } from './copilotx'
import { PlannerError, validateQueryPlan } from './planner'

type ChatRouteOptions = {
  fetch?: typeof globalThis.fetch
  apiKey?: string
  baseUrl?: string
  model?: string
}

const encoder = new TextEncoder()

function event(name: string, data: unknown) {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function message(context: Context<AuthEnvironment>) {
  const length = Number(context.req.header('Content-Length') ?? '0')
  if (!Number.isFinite(length) || length > 4_096) throw new Error('invalid request body')
  const payload = await context.req.json<unknown>().catch(() => null)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid request body')
  const value = (payload as Record<string, unknown>).message
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 500) throw new Error('invalid message')
  return value.trim()
}

async function reserveDailyQuota(database: D1Database, tokenId: string, now = new Date()) {
  const token = await database.prepare('SELECT daily_quota FROM access_tokens WHERE id = ? AND revoked_at IS NULL').bind(tokenId).first<{ daily_quota: number | null }>()
  if (!token) return false
  if (token.daily_quota === null) return true
  const usageDate = now.toISOString().slice(0, 10)
  const result = await database.prepare(
    `INSERT INTO chat_daily_usage (token_id, usage_date, used) VALUES (?, ?, 1)
     ON CONFLICT(token_id, usage_date) DO UPDATE SET used = used + 1
     WHERE used < ?`,
  ).bind(tokenId, usageDate, token.daily_quota).run()
  return result.meta.changes === 1
}

function client(context: Context<AuthEnvironment>, options: ChatRouteOptions) {
  const apiKey = options.apiKey ?? context.env.COPILOTX_API_KEY
  if (!apiKey) throw new CopilotXError('CopilotX is not configured')
  return new CopilotXClient({
    apiKey,
    fetch: options.fetch,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    model: options.model ?? DEFAULT_MODEL,
  })
}

export function registerChatRoutes(app: Hono<AuthEnvironment>, options: ChatRouteOptions = {}) {
  app.get('/api/agent/status', requireRole('viewer'), (context) => context.json({
    mode: 'copilotx',
    provider: 'CopilotX',
    model: options.model ?? DEFAULT_MODEL,
    base_url: options.baseUrl ?? DEFAULT_BASE_URL,
    configured: Boolean(options.apiKey ?? context.env.COPILOTX_API_KEY),
  }))

  app.post('/api/agent/query/stream', requireRole('viewer'), requireCsrf(), async (context) => {
    let query: string
    try {
      query = await message(context)
    } catch {
      return context.json({ detail: '请求内容无效' }, 422)
    }
    if (!(await reserveDailyQuota(context.env.DB, context.get('auth').tokenId))) {
      return context.json({ detail: '今日智能查询额度已用完，请明天再试。' }, 429)
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(event('status', { phase: 'planning' }))
        try {
          const catalog = new CatalogService(new D1CatalogRepository(context.env.DB))
          const metadata = await catalog.metadata()
          const plan = validateQueryPlan(
            await client(context, options).plan(query, metadata.categories.map((category) => category.name), metadata.sites),
            metadata.categories.map((category) => category.name),
            metadata.sites.map((site) => site.id),
          )
          const result = await catalog.search({
            query: plan.query,
            category: plan.category,
            siteId: plan.siteId,
            availableOnly: plan.availableOnly,
            limit: 50,
          })
          controller.enqueue(event('result', result))
          controller.enqueue(event('status', { phase: 'answering' }))
          await client(context, options).streamAnswer(query, result, (delta) => controller.enqueue(event('text_delta', delta)))
          controller.enqueue(event('done', { ok: true }))
        } catch (error) {
          const code = error instanceof PlannerError ? 'planner' : error instanceof CopilotXError ? 'upstream' : 'server'
          const message = code === 'planner' ? '智能查询计划无效，请稍后重试。' : '智能查询暂时不可用，请稍后重试。'
          controller.enqueue(event('error', { code, message }))
        } finally {
          controller.close()
        }
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })
}
