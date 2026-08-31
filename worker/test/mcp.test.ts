import { env, SELF } from 'cloudflare:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function localMcpApp() {
  const app = new Hono<AuthEnvironment>()
  registerMcpRoutes(app)
  return app
}

function localBindings() {
  return {
    ...env,
    SESSION_SIGNING_KEY: 'test-only-session-signing-key-not-for-production',
    ENVIRONMENT: 'local',
  } as Env
}

function streamedMcpRequest(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
) {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${viewerToken}`,
      'Content-Type': 'application/json',
      Host: 'localhost',
      ...headers,
    },
    body,
  })
}

function oversizedHangingBody() {
  let pulls = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      if (pulls === 1) controller.enqueue(new Uint8Array(32 * 1024))
      else if (pulls === 2) controller.enqueue(new Uint8Array(32 * 1024 + 1))
      else return new Promise<void>(() => undefined)
    },
    cancel() {
      cancelled = true
    },
  })
  return { stream, wasCancelled: () => cancelled }
}

function toolResult(body: RpcResponse) {
  expect(body.error).toBeUndefined()
  return body.result as {
    isError?: boolean
    content: Array<{ type: string; text?: string }>
    structuredContent: Record<string, unknown>
  }
}

function schemaNodes(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(schemaNodes)
  const record = value as Record<string, unknown>
  return [record, ...Object.values(record).flatMap(schemaNodes)]
}

beforeEach(async () => {
  await resetDatabase()
  await seedContractCatalog()
  await issueViewerToken()
})

afterEach(() => {
  vi.useRealTimers()
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
        expect(tool.outputSchema).toMatchObject({ type: 'object' })
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

  it('rejects oversized bodies without relying on Content-Length', async () => {
    const response = await localMcpApp().fetch(
      streamedMcpRequest(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(64 * 1024 + 1))
          controller.close()
        },
      })),
      localBindings(),
    )
    expect(response.status).toBe(400)
  })

  it('cancels a forged-length body immediately when streamed bytes exceed 64 KiB', async () => {
    const body = oversizedHangingBody()
    const result = await Promise.race([
      localMcpApp().fetch(
        streamedMcpRequest(body.stream, { 'Content-Length': '1' }),
        localBindings(),
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ])
    expect(result).not.toBe('timeout')
    expect((result as Response).status).toBe(400)
    expect(body.wasCancelled()).toBe(true)
  })

  it('cancels an oversized chunked body with no Content-Length', async () => {
    const body = oversizedHangingBody()
    const result = await Promise.race([
      localMcpApp().fetch(streamedMcpRequest(body.stream), localBindings()),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ])
    expect(result).not.toBe('timeout')
    expect((result as Response).status).toBe(400)
    expect(body.wasCancelled()).toBe(true)
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

  it('requires availability at the selected site rather than at another site', async () => {
    await env.DB.prepare(
      `INSERT INTO inventory
        (id, furniture_id, site_id, quantity_total, quantity_available, version)
       VALUES ('inventory-oak-bj-empty', 'furniture-oak-table', 'site-beijing', 2, 0, 1)`,
    ).run()

    const available = toolResult((await rpc('tools/call', {
      name: 'search_furniture',
      arguments: { site_id: 'site-beijing', available_only: true, limit: 20 },
    })).body)
    expect((available.structuredContent.items as Array<{ id: string }>).map((item) => item.id)).toEqual([
      'furniture-shelf',
      'furniture-arc-chair',
    ])

    const includingUnavailable = toolResult((await rpc('tools/call', {
      name: 'search_furniture',
      arguments: { site_id: 'site-beijing', available_only: false, limit: 20 },
    })).body)
    expect((includingUnavailable.structuredContent.items as Array<{ id: string }>).map((item) => item.id)).toEqual([
      'furniture-shelf',
      'furniture-arc-chair',
      'furniture-oak-table',
    ])
  })

  it('signs cursors and binds them to normalized filters and page size', async () => {
    const first = toolResult((await rpc('tools/call', {
      name: 'search_furniture',
      arguments: { text: '  木质  ', available_only: true, limit: 1 },
    })).body)
    expect(first.structuredContent).toMatchObject({
      ok: true,
      items: [{ id: 'furniture-shelf' }],
      next_cursor: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
    })
    const cursor = first.structuredContent.next_cursor as string

    const second = toolResult((await rpc('tools/call', {
      name: 'search_furniture',
      arguments: { text: '木质', available_only: true, limit: 1, cursor },
    })).body)
    expect(second.structuredContent).toMatchObject({
      ok: true,
      items: [{ id: 'furniture-oak-table' }],
      next_cursor: null,
    })

    const replacement = cursor.endsWith('A') ? 'B' : 'A'
    const tampered = toolResult((await rpc('tools/call', {
      name: 'search_furniture',
      arguments: { text: '木质', available_only: true, limit: 1, cursor: cursor.slice(0, -1) + replacement },
    })).body)
    expect(tampered).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: 'invalid_cursor' } },
    })

    const filterMismatch = toolResult((await rpc('tools/call', {
      name: 'search_furniture',
      arguments: { text: '木质', site_id: 'site-shanghai', available_only: true, limit: 1, cursor },
    })).body)
    expect(filterMismatch).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: 'invalid_cursor' } },
    })

    const limitMismatch = toolResult((await rpc('tools/call', {
      name: 'search_furniture',
      arguments: { text: '木质', available_only: true, limit: 2, cursor },
    })).body)
    expect(limitMismatch).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: 'invalid_cursor' } },
    })
  })

  it('round-trips a next-page cursor with maximum-length filters', async () => {
    const text = 'x'.repeat(200)
    const category = 'c'.repeat(100)
    const siteId = `site-${'s'.repeat(95)}`
    await env.DB.batch([
      env.DB.prepare('INSERT INTO categories (id, name) VALUES (?, ?)')
        .bind('category-maximum-filter', category),
      env.DB.prepare(
        'INSERT INTO sites (id, code, name, city, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(siteId, 'MAX', 'Maximum filter site', 'Test City', 0, 0),
      env.DB.prepare(
        `INSERT INTO furniture (id, sku, name, category_id, condition)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind('furniture-maximum-a', 'MAX-A', `${text} A`, 'category-maximum-filter', 'good'),
      env.DB.prepare(
        `INSERT INTO furniture (id, sku, name, category_id, condition)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind('furniture-maximum-b', 'MAX-B', `${text} B`, 'category-maximum-filter', 'good'),
      env.DB.prepare(
        `INSERT INTO inventory
          (id, furniture_id, site_id, quantity_total, quantity_available, version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind('inventory-maximum-a', 'furniture-maximum-a', siteId, 1, 1, 1),
      env.DB.prepare(
        `INSERT INTO inventory
          (id, furniture_id, site_id, quantity_total, quantity_available, version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind('inventory-maximum-b', 'furniture-maximum-b', siteId, 1, 1, 1),
    ])

    const first = toolResult((await rpc('tools/call', {
      name: 'search_furniture',
      arguments: { text, category, site_id: siteId, available_only: true, limit: 1 },
    })).body)
    expect(first.isError).toBeFalsy()
    expect(first.structuredContent).toMatchObject({
      ok: true,
      items: [{ id: 'furniture-maximum-a' }],
      next_cursor: expect.any(String),
    })
    const cursor = first.structuredContent.next_cursor as string
    expect(cursor.length).toBeLessThanOrEqual(512)

    const second = toolResult((await rpc('tools/call', {
      name: 'search_furniture',
      arguments: { text, category, site_id: siteId, available_only: true, limit: 1, cursor },
    })).body)
    expect(second.isError).toBeFalsy()
    expect(second.structuredContent).toMatchObject({
      ok: true,
      items: [{ id: 'furniture-maximum-b' }],
      next_cursor: null,
    })
  })

  it('publishes bounded discriminated output contracts for every tool', async () => {
    const listed = await rpc('tools/list')
    const tools = (listed.body.result?.tools ?? []) as Array<{ name: string; outputSchema: unknown }>
    expect(tools).toHaveLength(4)
    for (const tool of tools) {
      const nodes = schemaNodes(tool.outputSchema)
      const externalStrings = nodes.filter((node) => node.type === 'string' && !Array.isArray(node.enum))
      const arrays = nodes.filter((node) => node.type === 'array')
      expect(externalStrings.length, `${tool.name} string schemas`).toBeGreaterThan(0)
      expect(arrays.length, `${tool.name} array schemas`).toBeGreaterThan(0)
      expect(externalStrings.every((node) => Number.isInteger(node.maxLength)), tool.name).toBe(true)
      expect(arrays.every((node) => Number.isInteger(node.maxItems)), tool.name).toBe(true)

      const success = nodes.find((node) => {
        const properties = node.properties as Record<string, Record<string, unknown>> | undefined
        return properties?.ok?.const === true
      })
      const failure = nodes.find((node) => {
        const properties = node.properties as Record<string, Record<string, unknown>> | undefined
        return properties?.ok?.const === false
      })
      expect(success, `${tool.name} success branch`).toBeDefined()
      expect(failure, `${tool.name} failure branch`).toMatchObject({
        additionalProperties: false,
        required: expect.arrayContaining(['ok', 'error']),
      })
    }
  })

  it('fails closed when an external furniture string exceeds the output contract', async () => {
    await env.DB.prepare("UPDATE furniture SET description = ? WHERE id = 'furniture-arc-chair'")
      .bind('x'.repeat(5_001))
      .run()
    const result = toolResult((await rpc('tools/call', {
      name: 'get_furniture', arguments: { furniture_id: 'furniture-arc-chair' },
    })).body)
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: 'internal_error' } },
    })
    expect(JSON.stringify(result)).not.toContain('x'.repeat(1_000))
  })

  it('fails closed when an external result array exceeds the output contract', async () => {
    await env.DB.batch(Array.from({ length: 100 }, (_, index) => env.DB.prepare(
      `INSERT INTO furniture_images
        (id, furniture_id, object_key, mime_type, byte_size, width, height, sha256,
         alt_text, sort_order, is_primary)
       VALUES (?, 'furniture-arc-chair', ?, 'image/jpeg', 1, 1, 1, ?, ?, ?, 0)`,
    ).bind(
      `image-overflow-${index.toString().padStart(3, '0')}`,
      `fixtures/overflow-${index.toString().padStart(3, '0')}.jpg`,
      `overflow-${index}`,
      `overflow ${index}`,
      index + 1,
    )))
    const result = toolResult((await rpc('tools/call', {
      name: 'get_furniture', arguments: { furniture_id: 'furniture-arc-chair' },
    })).body)
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: 'internal_error' } },
    })
  })

  it('uses unique ID tie-breakers for furniture pages and metadata', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO furniture (id, sku, name, category_id, condition)
         VALUES ('furniture-equal-z', 'EQ-Z', '同名家具', 'category-seating', 'good')`,
      ),
      env.DB.prepare(
        `INSERT INTO furniture (id, sku, name, category_id, condition)
         VALUES ('furniture-equal-a', 'EQ-A', '同名家具', 'category-seating', 'good')`,
      ),
      env.DB.prepare(
        `INSERT INTO inventory
          (id, furniture_id, site_id, quantity_total, quantity_available, version)
         VALUES ('inventory-equal-z', 'furniture-equal-z', 'site-beijing', 1, 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO inventory
          (id, furniture_id, site_id, quantity_total, quantity_available, version)
         VALUES ('inventory-equal-a', 'furniture-equal-a', 'site-beijing', 1, 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO sites (id, code, name, city, latitude, longitude)
         VALUES ('site-equal-z', 'EZ', '同名园区', '测试', 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO sites (id, code, name, city, latitude, longitude)
         VALUES ('site-equal-a', 'EA', '同名园区', '测试', 1, 1)`,
      ),
    ])

    const first = toolResult((await rpc('tools/call', {
      name: 'search_furniture',
      arguments: { text: '同名家具', available_only: false, limit: 1 },
    })).body)
    expect(first.structuredContent).toMatchObject({
      items: [{ id: 'furniture-equal-a' }],
      next_cursor: expect.any(String),
    })
    const second = toolResult((await rpc('tools/call', {
      name: 'search_furniture',
      arguments: {
        text: '同名家具',
        available_only: false,
        limit: 1,
        cursor: first.structuredContent.next_cursor,
      },
    })).body)
    expect(second.structuredContent).toMatchObject({
      items: [{ id: 'furniture-equal-z' }],
      next_cursor: null,
    })

    const sites = toolResult((await rpc('tools/call', {
      name: 'list_sites', arguments: {},
    })).body)
    expect((sites.structuredContent.sites as Array<{ id: string; name: string }>)
      .filter((site) => site.name === '同名园区')
      .map((site) => site.id)).toEqual(['site-equal-a', 'site-equal-z'])
  })

  it('gets one furniture item with short-lived signed Worker image URLs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'))
    const imageBytes = new Uint8Array(1_024).fill(7)
    await env.IMAGES.put('fixtures/arc-chair.jpg', imageBytes, {
      httpMetadata: { contentType: 'image/jpeg' },
    })
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

    const delivered = await SELF.fetch(imageUrl.toString())
    expect(delivered.status).toBe(200)
    expect(new Uint8Array(await delivered.arrayBuffer())).toEqual(imageBytes)

    vi.setSystemTime(new Date((expiry + 1) * 1_000))
    const expired = await SELF.fetch(imageUrl.toString())
    expect(expired.status).toBe(401)
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

  it('fails closed when site metadata exceeds the output bound', async () => {
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 98
       )
       INSERT INTO sites (id, code, name, city, latitude, longitude)
       SELECT printf('overflow-site-%03d', value), printf('O%03d', value),
              printf('Overflow site %03d', value), 'Test City', 0, 0
       FROM sequence`,
    ).run()

    const result = toolResult((await rpc('tools/call', {
      name: 'list_sites', arguments: {},
    })).body)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'FurnitureCenter could not complete the request.' },
    })
  })

  it('fails closed when category metadata exceeds the output bound', async () => {
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 98
       )
       INSERT INTO categories (id, name)
       SELECT printf('overflow-category-%03d', value), printf('Overflow category %03d', value)
       FROM sequence`,
    ).run()

    const result = toolResult((await rpc('tools/call', {
      name: 'list_categories', arguments: {},
    })).body)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'FurnitureCenter could not complete the request.' },
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
