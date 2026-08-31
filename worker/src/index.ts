import { Hono } from 'hono'
import { registerAuthRoutes } from './auth/routes'
import type { AuthEnvironment } from './auth/middleware'
import type { Env } from './env'

const app = new Hono<AuthEnvironment>()

registerAuthRoutes(app)

app.get('/health', async (context) => {
  try {
    const row = await context.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
    if (row?.ok !== 1) {
      return context.json({ status: 'error', database: 'error' }, 503)
    }
    return context.json({ status: 'ok', database: 'ok' })
  } catch {
    return context.json({ status: 'error', database: 'error' }, 503)
  }
})

app.all('/api/*', (context) => context.json({ detail: '接口不存在' }, 404))
app.all('/images/*', (context) => context.json({ detail: '图片不存在' }, 404))
app.all('/mcp', (context) => context.json({ detail: 'MCP 端点尚未启用' }, 404))
app.all('*', (context) => context.env.ASSETS.fetch(context.req.raw))

export default app
