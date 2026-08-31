import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('GET /health', () => {
  it('proves the Worker can query its D1 binding', async () => {
    const response = await SELF.fetch('https://fc.test/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', database: 'ok' })
  })

  it('does not disguise unknown API routes as the single-page application', async () => {
    const response = await SELF.fetch('https://fc.test/api/not-implemented')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ detail: '接口不存在' })
  })
})
