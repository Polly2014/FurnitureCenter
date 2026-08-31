import { env, SELF } from 'cloudflare:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AuthEnvironment } from '../src/auth/middleware'
import type { Env } from '../src/env'
import { registerMcpRoutes } from '../src/mcp/routes'
import { resetDatabase, seedContractCatalog } from './helpers'

const viewerToken = 'fc_test_mcp_viewer_0123456789abcdefghijklmnopqrstuvwxyz'

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function issueViewerToken(options: { revoked?: boolean; quota?: number } = {}) {
  await env.DB.prepare(
    `INSERT INTO access_tokens
      (id, token_hash, role, scopes_json, label, daily_quota, revoked_at)
     VALUES ('token-mcp-viewer', ?, 'viewer', '["catalog:read"]', 'MCP test viewer', ?, ?)`,
  )
    .bind(
      await sha256(viewerToken),
      options.quota ?? 100,
      options.revoked ? new Date().toISOString() : null,
    )
    .run()
}

type RpcResponse = {
  jsonrpc?: string
  id?: number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

async function mcpRequest(
  body: Record<string, unknown>,
  options: {
    token?: string
    origin?: string
    host?: string
    method?: string
    protocolVersion?: string
    cookie?: string
  } = {},
) {
  const headers = new Headers({
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    Host: options.host ?? 'localhost',
    'MCP-Protocol-Version': options.protocolVersion ?? '2025-11-25',
  })
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`)
  if (options.origin) headers.set('Origin', options.origin)
  if (options.cookie) headers.set('Cookie', options.cookie)
  return SELF.fetch('http://localhost/mcp', {
    method: options.method ?? 'POST',
    headers,
    body: options.method && options.method !== 'POST' ? undefined : JSON.stringify(body),
  })
}

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  options: Parameters<typeof mcpRequest>[1] = {},
) {
  const response = await mcpRequest({ jsonrpc: '2.0', id: 1, method, params }, {
    token: viewerToken,
    ...options,
  })
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  if (contentType.includes('text/event-stream')) {
    const data = text.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
    return { response, body: data ? JSON.parse(data) as RpcResponse : {} }
  }
  return { response, body: JSON.parse(text) as RpcResponse }
}

function toolResult(body: RpcResponse) {
  expect(body.error).toBeUndefined()
  return body.result as {
    isError?: boolean
    content: Array<{ type: string; text?: string }>
    structuredContent: Record<string, unknown>
  }
}

beforeEach(async () => {
  await resetDatabase()
  await seedContractCatalog()
  await issueViewerToken()
})

describe('authenticated stateless MCP transport', () => {
  it('supports modern 2026-07-28 discovery and calls through the official v2 client', async () => {
    const client = new Client(
      { name: 'official-v2-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    )
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      authProvider: { token: async () => viewerToken },
      fetch: (input, init) => {
        const request = new Request(input, init)
        const headers = new Headers(request.headers)
        headers.set('Host', 'localhost')
        return SELF.fetch(new Request(request, { headers }))
      },
    })
    await client.connect(transport)
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'search_furniture',
      'get_furniture',
      'list_sites',
      'list_categories',
    ])
    expect((await client.callTool({ name: 'list_sites', arguments: {} })).structuredContent).toMatchObject({
      ok: true,
      sites: [{ id: 'site-shanghai' }, { id: 'site-beijing' }, { id: 'site-shenzhen' }],
    })
    await client.close()
  })

  it.each(['2025-11-25', '2025-06-18'])(
    'initializes and discovers tools for protocol %s',
    async (protocolVersion) => {
      const initialized = await rpc('initialize', {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'furniture-center-test', version: '1.0.0' },
      }, { protocolVersion })
      expect(initialized.response.status).toBe(200)
      expect(initialized.body.result).toMatchObject({
        protocolVersion,
        serverInfo: { name: 'FurnitureCenter', version: '1.0.0' },
        capabilities: { tools: {} },
      })

      const listed = await rpc('tools/list', {}, { protocolVersion })
      expect(listed.response.status).toBe(200)
      const tools = (listed.body.result?.tools ?? []) as Array<Record<string, unknown>>
      expect(tools.map((tool) => tool.name)).toEqual([
        'search_furniture',
        'get_furniture',
        'list_sites',
        'list_categories',
      ])
      for (const tool of tools) {
        expect(tool.description).toEqual(expect.any(String))
        expect(String(tool.description).length).toBeGreaterThan(20)
        expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
        expect(tool.outputSchema).toMatchObject({ type: 'object', additionalProperties: false })
        expect(tool.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        })
      }
      expect(tools.map((tool) => tool.name)).not.toContain('create_furniture')
      expect(tools.map((tool) => tool.name)).not.toContain('adjust_inventory')
      expect(Object.keys((tools[0].inputSchema as { properties: object }).properties)).toEqual([
        'text', 'category', 'site_id', 'available_only', 'limit', 'cursor',
      ])
      expect(tools[0].inputSchema).toMatchObject({
        properties: { limit: { minimum: 1, maximum: 50 } },
      })
      expect(Object.keys((tools[1].inputSchema as { properties: object }).properties)).toEqual([
        'furniture_id',
      ])
      expect((tools[2].inputSchema as { properties: object }).properties).toEqual({})
      expect((tools[3].inputSchema as { properties: object }).properties).toEqual({})
    },
  )

  it('rejects non-POST methods, missing Bearer credentials, cookies, and malformed tokens', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
    expect((await mcpRequest(body, { method: 'GET', token: viewerToken })).status).toBe(405)
    expect((await mcpRequest(body)).status).toBe(401)
    expect((await mcpRequest(body, { cookie: 'fc_session=browser-only' })).status).toBe(401)
    expect((await mcpRequest(body, { token: 'not valid whitespace' })).status).toBe(401)
    expect((await mcpRequest(body, { token: 'x'.repeat(40) })).status).toBe(401)
  })

  it('rejects a credential immediately after revocation', async () => {
    expect((await rpc('tools/list')).response.status).toBe(200)
    await env.DB.prepare("UPDATE access_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = 'token-mcp-viewer'").run()
    expect((await rpc('tools/list')).response.status).toBe(401)
  })

  it('rejects expired credentials', async () => {
    await env.DB.prepare(
      "UPDATE access_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = 'token-mcp-viewer'",
    ).run()
    expect((await rpc('tools/list')).response.status).toBe(401)
  })

  it('validates every explicit Host and Origin without requiring Origin', async () => {
    expect((await rpc('tools/list')).response.status).toBe(200)
    expect((await rpc('tools/list', {}, { origin: 'http://localhost:5173' })).response.status).toBe(200)
    expect((await rpc('tools/list', {}, { host: 'attacker.example' })).response.status).toBe(403)
    expect((await rpc('tools/list', {}, { origin: 'https://attacker.example' })).response.status).toBe(403)
    expect((await rpc('tools/list', {}, { origin: 'not a url' })).response.status).toBe(403)
  })

  it('pins production to fc.polly.wang and requires an explicit workers.dev preview host', async () => {
    const app = new Hono<AuthEnvironment>()
    registerMcpRoutes(app)
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const bindings = (environment: Env['ENVIRONMENT'], allowed?: string) => ({
      DB: env.DB,
      SESSION_SIGNING_KEY: 'test-only-session-signing-key-not-for-production',
      ENVIRONMENT: environment,
      MCP_ALLOWED_HOSTS: allowed,
    }) as Env
    const request = (origin: string, host: string) => new Request(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${viewerToken}`,
        'Content-Type': 'application/json',
        Host: host,
        Origin: origin,
      },
      body,
    })

    expect((await app.fetch(
      request('https://fc.polly.wang', 'fc.polly.wang'),
      bindings('production'),
    )).status).toBe(200)
    expect((await app.fetch(
      request('https://furniture-center-preview.example.workers.dev', 'furniture-center-preview.example.workers.dev'),
      bindings('preview'),
    )).status).toBe(403)
    expect((await app.fetch(
      request('https://furniture-center-preview.example.workers.dev', 'furniture-center-preview.example.workers.dev'),
      bindings('preview', 'furniture-center-preview.example.workers.dev'),
    )).status).toBe(200)
    expect((await app.fetch(
      request('https://attacker.example', 'attacker.example'),
      bindings('production', 'attacker.example'),
    )).status).toBe(403)
  })
})

describe('read-only furniture tools', () => {
  it('returns bounded filtered search results with per-site inventory and pagination', async () => {
    const { body } = await rpc('tools/call', {
      name: 'search_furniture',
      arguments: { category: '座椅', available_only: false, limit: 1 },
    })
    const result = toolResult(body)
    expect(result.isError).toBeFalsy()
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('1') }])
    expect(result.structuredContent).toMatchObject({
      ok: true,
      items: [{ id: 'furniture-lounge-chair', inventory: [{ site_id: 'site-shenzhen', quantity_available: 0 }] }],
      count: 1,
      next_cursor: expect.any(String),
    })

    const invalid = await rpc('tools/call', {
      name: 'search_furniture',
      arguments: { limit: 51 },
    })
    const invalidResult = toolResult(invalid.body)
    expect(invalidResult.isError).toBe(true)
    expect(invalidResult.content[0]?.text).toContain('limit')
  })

  it('gets one furniture item with short-lived signed Worker image URLs', async () => {
    const before = Math.floor(Date.now() / 1000)
    const { body } = await rpc('tools/call', {
      name: 'get_furniture',
      arguments: { furniture_id: 'furniture-arc-chair' },
    })
    const result = toolResult(body)
    expect(result.structuredContent).toMatchObject({
      ok: true,
      item: {
        id: 'furniture-arc-chair',
        sku: 'CHR-ARC-01',
        quantity_available: 16,
        inventory: [
          { site_id: 'site-shanghai', quantity_available: 4 },
          { site_id: 'site-beijing', quantity_available: 12 },
        ],
        images: [{ id: 'image-arc-chair', url: expect.stringContaining('/images/image-arc-chair?') }],
      },
    })
    const item = result.structuredContent.item as { images: Array<{ url: string; expires_at: string }> }
    const imageUrl = new URL(item.images[0].url)
    expect(imageUrl.origin).toBe('http://localhost')
    expect(imageUrl.pathname).toBe('/images/image-arc-chair')
    expect(imageUrl.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]+$/u)
    const expiry = Number(imageUrl.searchParams.get('expires'))
    expect(expiry).toBeGreaterThan(before)
    expect(expiry).toBeLessThanOrEqual(before + 5 * 60)
    expect(Date.parse(item.images[0].expires_at) / 1000).toBe(expiry)
    expect(JSON.stringify(result)).not.toContain('fixtures/arc-chair.jpg')
  })

  it('returns stable bounded site and category metadata', async () => {
    const sites = toolResult((await rpc('tools/call', {
      name: 'list_sites', arguments: {},
    })).body)
    expect(sites.structuredContent).toEqual({
      ok: true,
      sites: [
        { id: 'site-shanghai', code: 'SH', name: '上海园区', city: '上海', latitude: 31.2304, longitude: 121.4737 },
        { id: 'site-beijing', code: 'BJ', name: '北京园区', city: '北京', latitude: 39.9042, longitude: 116.4074 },
        { id: 'site-shenzhen', code: 'SZ', name: '深圳园区', city: '深圳', latitude: 22.5431, longitude: 114.0579 },
      ],
    })
    const categories = toolResult((await rpc('tools/call', {
      name: 'list_categories', arguments: {},
    })).body)
    expect(categories.structuredContent).toEqual({
      ok: true,
      categories: [
        { id: 'category-seating', name: '座椅' },
        { id: 'category-storage', name: '收纳' },
        { id: 'category-tables', name: '桌台' },
      ],
    })
  })

  it('returns isError tool results for misses and sanitizes internal failures', async () => {
    const missing = toolResult((await rpc('tools/call', {
      name: 'get_furniture', arguments: { furniture_id: 'missing' },
    })).body)
    expect(missing.isError).toBe(true)
    expect(missing.structuredContent).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'Furniture was not found.' },
    })

    await env.DB.prepare('ALTER TABLE categories RENAME TO categories_unavailable').run()
    const failed = toolResult((await rpc('tools/call', {
      name: 'list_categories', arguments: {},
    })).body)
    await env.DB.prepare('ALTER TABLE categories_unavailable RENAME TO categories').run()
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'FurnitureCenter could not complete the request.' },
    })
    expect(JSON.stringify(failed)).not.toMatch(/SQL|categories|D1_ERROR|no such table/iu)
  })

  it('enforces an independent per-token MCP daily quota atomically', async () => {
    await env.DB.prepare("UPDATE access_tokens SET daily_quota = 1 WHERE id = 'token-mcp-viewer'").run()
    expect((await rpc('tools/call', { name: 'list_sites', arguments: {} })).response.status).toBe(200)
    const exhausted = await rpc('tools/call', { name: 'list_categories', arguments: {} })
    expect(exhausted.response.status).toBe(429)
    expect(JSON.stringify(exhausted.body)).not.toContain(viewerToken)
    const chatUsage = await env.DB.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_daily_usage'",
    ).first()
    expect(chatUsage).toBeTruthy()
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM chat_daily_usage').first()).toEqual({ count: 0 })
  })
})
