import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { browserAuth, contract, resetDatabase, seedContractCatalog } from './helpers'

type QueryPayload = {
  items: Array<Record<string, unknown> & {
    id: string
    inventory: Array<{
      site: { id: string }
      quantity_total: number
      quantity_available: number
      version: number
    }>
  }>
  map_features: Array<{
    site_id: string
    quantity_available: number
    furniture_ids: string[]
  }>
  total: number
  applied_query: string | null
  applied_filters: Record<string, string | boolean>
  answer: string | null
}

function normalizeResult(payload: QueryPayload) {
  return {
    item_ids: payload.items.map((item) => item.id),
    inventory: Object.fromEntries(
      payload.items.map((item) => [
        item.id,
        item.inventory
          .map((position) => [
            position.site.id,
            position.quantity_total,
            position.quantity_available,
            position.version,
          ])
          .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
      ]),
    ),
    map: Object.fromEntries(
      [...payload.map_features]
        .sort((left, right) => left.site_id.localeCompare(right.site_id))
        .map((feature) => [
          feature.site_id,
          [feature.quantity_available, feature.furniture_ids],
        ]),
    ),
    applied_query: payload.applied_query,
    applied_filters: payload.applied_filters,
  }
}

beforeEach(async () => {
  await resetDatabase()
  await seedContractCatalog()
})

describe('D1 catalog adapter contract', () => {
  it('matches every shared text, category, site and availability query case', async () => {
    const auth = await browserAuth('viewer')
    for (const testCase of contract.cases) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(testCase.params)) params.set(key, String(value))

      const response = await SELF.fetch(
        `https://fc.test/api/catalog/furniture?${params}`,
        { headers: { Cookie: auth.cookie } },
      )

      expect(response.status, testCase.name).toBe(200)
      const payload = await response.json<QueryPayload>()
      expect(normalizeResult(payload), testCase.name).toEqual(testCase.expected)
      expect(payload.total).toBe(payload.items.length)
      expect(payload.answer).toBeNull()
      for (const item of payload.items) {
        expect(Object.keys(item).sort()).toEqual([
          'brand',
          'category',
          'color',
          'condition',
          'description',
          'dimensions',
          'id',
          'image_reference',
          'images',
          'inventory',
          'main_category',
          'material',
          'name',
          'name_en',
          'quantity_available',
          'sku',
          'source_row',
          'source_sheet',
          'source_workbook',
        ])
      }
    }
  })

  it('returns sorted shared metadata and rejects invalid bounds', async () => {
    const auth = await browserAuth('viewer')
    const response = await SELF.fetch('https://fc.test/api/catalog/metadata', {
      headers: { Cookie: auth.cookie },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      categories: [...contract.categories].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      ),
      sites: [...contract.sites].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      ),
    })
    const invalid = await SELF.fetch('https://fc.test/api/catalog/furniture?limit=101', {
      headers: { Cookie: auth.cookie },
    })
    expect(invalid.status).toBe(422)
  })

  it('treats SQL metacharacters as search text rather than executable input', async () => {
    const auth = await browserAuth('viewer')
    const query = encodeURIComponent("%' OR 1=1 --")

    const response = await SELF.fetch(`https://fc.test/api/catalog/furniture?query=${query}`, {
      headers: { Cookie: auth.cookie },
    })

    expect(response.status).toBe(200)
    expect((await response.json<QueryPayload>()).total).toBe(0)
  })

  it('creates, updates and deletes furniture through admin routes only', async () => {
    const viewer = await browserAuth('viewer')
    const viewerAttempt = await SELF.fetch('https://fc.test/api/admin/furniture', {
      method: 'POST',
      headers: viewer.headers,
      body: JSON.stringify({}),
    })
    expect(viewerAttempt.status).toBe(403)

    const admin = await browserAuth('admin')
    const created = await SELF.fetch('https://fc.test/api/admin/furniture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin.headers },
      body: JSON.stringify({
        sku: 'CHR-NEW-01',
        name: '可堆叠访客椅',
        category_id: 'category-seating',
        description: '适合培训和访客区域',
        condition: 'excellent',
        site_id: 'site-beijing',
        quantity: 6,
        image_url: null,
      }),
    })
    expect(created.status).toBe(201)
    const { id } = await created.json<{ id: string }>()

    const found = await SELF.fetch('https://fc.test/api/catalog/furniture?query=可堆叠', {
      headers: { Cookie: admin.cookie },
    })
    expect((await found.json<QueryPayload>()).items).toHaveLength(1)

    const updated = await SELF.fetch(`https://fc.test/api/admin/furniture/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...admin.headers },
      body: JSON.stringify({
        name: '可堆叠培训椅',
        category_id: 'category-seating',
        description: '适合培训区域',
        condition: 'good',
      }),
    })
    expect(updated.status).toBe(204)

    const removed = await SELF.fetch(`https://fc.test/api/admin/furniture/${id}`, {
      method: 'DELETE',
      headers: admin.headers,
    })
    expect(removed.status).toBe(204)
    const audit = await SELF.fetch('https://fc.test/api/admin/audit', {
      headers: { Cookie: admin.cookie },
    })
    const auditEvents = await audit.json<Array<{ actor: string }>>()
    expect(auditEvents).toHaveLength(3)
    expect(new Set(auditEvents.map((event) => event.actor))).toEqual(new Set(['token-admin']))
  })
})
