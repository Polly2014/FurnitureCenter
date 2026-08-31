import { Hono } from 'hono'
import type { Env } from './env'

const app = new Hono<{ Bindings: Env }>()

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

app.all('*', (context) => context.env.ASSETS.fetch(context.req.raw))

export default app
