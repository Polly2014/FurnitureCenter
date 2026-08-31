import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('GET /health', () => {
  it('proves the Worker can query its D1 binding', async () => {
    const response = await SELF.fetch('https://fc.test/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', database: 'ok' })
  })
})
