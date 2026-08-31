import { Hono } from 'hono'
import { registerAuthRoutes } from './auth/routes'
import type { AuthEnvironment } from './auth/middleware'
import { registerCatalogRoutes } from './catalog/routes'
import { registerChatRoutes } from './chat/routes'
import type { Env } from './env'
import { registerImageRoutes } from './images/routes'
import { ImageService } from './images/service'
import { registerInventoryRoutes } from './inventory/routes'
import { registerMcpRoutes } from './mcp/routes'

const app = new Hono<AuthEnvironment>()

registerAuthRoutes(app)
registerCatalogRoutes(app)
registerChatRoutes(app)
registerInventoryRoutes(app)
registerImageRoutes(app)
registerMcpRoutes(app)

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
app.all('*', (context) => context.env.ASSETS.fetch(context.req.raw))

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
    context.waitUntil(new ImageService(env).retryPendingCleanup())
  },
}
