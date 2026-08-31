import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { browserAuth, resetDatabase, seedContractCatalog } from './helpers'
import { D1InventoryRepository } from '../src/inventory/repository'

beforeEach(async () => {
  await resetDatabase()
  await seedContractCatalog()
})

describe('D1 inventory commands', () => {
  it('adjusts only the selected site and records immutable before/after values', async () => {
    const admin = await browserAuth('admin')
    const response = await SELF.fetch(
      'https://fc.test/api/admin/inventory/inventory-arc-bj/adjustments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'adjust-arc-bj-0001',
          ...admin.headers,
        },
        body: JSON.stringify({
          kind: 'loan',
          delta_total: 0,
          delta_available: -2,
          reason: '借给三层会议室',
          expected_version: 1,
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      inventory_id: 'inventory-arc-bj',
      quantity_total: 18,
      quantity_available: 10,
      version: 2,
    })
    expect(
      await env.DB.prepare(
        `SELECT quantity_total, quantity_available, version FROM inventory
         WHERE id = 'inventory-arc-sh'`,
      ).first(),
    ).toEqual({ quantity_total: 8, quantity_available: 4, version: 1 })
    expect(
      await env.DB.prepare(
        `SELECT kind, delta_total, delta_available, quantity_total_before,
                quantity_total_after, quantity_available_before,
                quantity_available_after, reason, actor
         FROM inventory_adjustments WHERE inventory_id = 'inventory-arc-bj'`,
      ).first(),
    ).toEqual({
      kind: 'loan',
      delta_total: 0,
      delta_available: -2,
      quantity_total_before: 18,
      quantity_total_after: 18,
      quantity_available_before: 12,
      quantity_available_after: 10,
      reason: '借给三层会议室',
      actor: 'token-admin',
    })
  })

  it('rejects stale and invalid adjustments without partial writes', async () => {
    const admin = await browserAuth('admin')
    const stale = await SELF.fetch(
      'https://fc.test/api/admin/inventory/inventory-arc-bj/adjustments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'adjust-stale-0001',
          ...admin.headers,
        },
        body: JSON.stringify({
          kind: 'loan',
          delta_total: 0,
          delta_available: -1,
          reason: '过期页面',
          expected_version: 0,
        }),
      },
    )
    expect(stale.status).toBe(409)

    const invalid = await SELF.fetch(
      'https://fc.test/api/admin/inventory/inventory-arc-bj/adjustments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'adjust-invalid-0001',
          ...admin.headers,
        },
        body: JSON.stringify({
          kind: 'loan',
          delta_total: 0,
          delta_available: -13,
          reason: '超过可用库存',
          expected_version: 1,
        }),
      },
    )
    expect(invalid.status).toBe(422)
    expect(
      await env.DB.prepare(
        `SELECT quantity_total, quantity_available, version FROM inventory
         WHERE id = 'inventory-arc-bj'`,
      ).first(),
    ).toEqual({ quantity_total: 18, quantity_available: 12, version: 1 })
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM inventory_adjustments').first(),
    ).toEqual({ count: 0 })
  })

  it('atomically transfers stock to an existing site with paired audit facts', async () => {
    const admin = await browserAuth('admin')
    const response = await SELF.fetch(
      'https://fc.test/api/admin/inventory/inventory-arc-bj/transfers',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'transfer-existing-0001',
          ...admin.headers,
        },
        body: JSON.stringify({
          destination_site_id: 'site-shanghai',
          quantity: 2,
          reason: '上海培训活动调拨',
          expected_source_version: 1,
          expected_destination_version: 1,
        }),
      },
    )

    expect(response.status).toBe(200)
    const payload = await response.json<{
      transfer_id: string
      source: Record<string, unknown>
      destination: Record<string, unknown>
    }>()
    expect(payload.source).toEqual({
      inventory_id: 'inventory-arc-bj',
      quantity_total: 16,
      quantity_available: 10,
      version: 2,
    })
    expect(payload.destination).toEqual({
      inventory_id: 'inventory-arc-sh',
      quantity_total: 10,
      quantity_available: 6,
      version: 2,
    })
    const replay = await SELF.fetch(
      'https://fc.test/api/admin/inventory/inventory-arc-bj/transfers',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'transfer-existing-0001',
          ...admin.headers,
        },
        body: JSON.stringify({
          destination_site_id: 'site-shanghai',
          quantity: 2,
          reason: '上海培训活动调拨',
          expected_source_version: 1,
          expected_destination_version: 1,
        }),
      },
    )
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(payload)
    const adjustments = await env.DB.prepare(
      `SELECT kind, delta_total, delta_available, quantity_total_before,
              quantity_total_after, quantity_available_before,
              quantity_available_after, transfer_id
       FROM inventory_adjustments ORDER BY kind`,
    ).all()
    expect(adjustments.results).toEqual([
      {
        kind: 'transfer_in',
        delta_total: 2,
        delta_available: 2,
        quantity_total_before: 8,
        quantity_total_after: 10,
        quantity_available_before: 4,
        quantity_available_after: 6,
        transfer_id: payload.transfer_id,
      },
      {
        kind: 'transfer_out',
        delta_total: -2,
        delta_available: -2,
        quantity_total_before: 18,
        quantity_total_after: 16,
        quantity_available_before: 12,
        quantity_available_after: 10,
        transfer_id: payload.transfer_id,
      },
    ])
  })

  it('creates a missing destination and rolls back every failed transfer', async () => {
    const admin = await browserAuth('admin')
    const rejected = await SELF.fetch(
      'https://fc.test/api/admin/inventory/inventory-arc-bj/transfers',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'transfer-invalid-0001',
          ...admin.headers,
        },
        body: JSON.stringify({
          destination_site_id: 'site-shanghai',
          quantity: 13,
          reason: '超过北京可用库存',
          expected_source_version: 1,
          expected_destination_version: 1,
        }),
      },
    )
    expect(rejected.status).toBe(422)
    expect(
      await env.DB.prepare(
        `SELECT id, quantity_total, quantity_available, version FROM inventory
         WHERE id IN ('inventory-arc-bj', 'inventory-arc-sh') ORDER BY id`,
      ).all(),
    ).toMatchObject({
      results: [
        { id: 'inventory-arc-bj', quantity_total: 18, quantity_available: 12, version: 1 },
        { id: 'inventory-arc-sh', quantity_total: 8, quantity_available: 4, version: 1 },
      ],
    })

    const created = await SELF.fetch(
      'https://fc.test/api/admin/inventory/inventory-arc-bj/transfers',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'transfer-new-site-0001',
          ...admin.headers,
        },
        body: JSON.stringify({
          destination_site_id: 'site-shenzhen',
          quantity: 2,
          reason: '深圳培训活动调拨',
          expected_source_version: 1,
          expected_destination_version: null,
        }),
      },
    )
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({
      source: { quantity_total: 16, quantity_available: 10, version: 2 },
      destination: { quantity_total: 2, quantity_available: 2, version: 1 },
    })
  })

  it('creates one site position and rejects duplicates', async () => {
    const admin = await browserAuth('admin')
    const request = () => SELF.fetch(
      'https://fc.test/api/admin/furniture/furniture-oak-table/inventory',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...admin.headers },
        body: JSON.stringify({
          site_id: 'site-beijing',
          quantity_total: 2,
          quantity_available: 2,
        }),
      },
    )

    const created = await request()
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      quantity_total: 2,
      quantity_available: 2,
      version: 1,
    })
    expect((await request()).status).toBe(409)
  })

  it('requires idempotency keys and replays one adjustment without applying it twice', async () => {
    const admin = await browserAuth('admin')
    const payload = JSON.stringify({
      kind: 'loan',
      delta_total: 0,
      delta_available: -2,
      reason: '网络重试测试',
      expected_version: 1,
    })
    const send = (body = payload, key = 'adjust-retry-0001') => SELF.fetch(
      'https://fc.test/api/admin/inventory/inventory-arc-bj/adjustments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...admin.headers,
        },
        body,
      },
    )

    const missing = await SELF.fetch(
      'https://fc.test/api/admin/inventory/inventory-arc-bj/adjustments',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...admin.headers },
        body: payload,
      },
    )
    expect(missing.status).toBe(422)

    const first = await send()
    const replay = await send()
    expect(first.status).toBe(200)
    expect(await replay.json()).toEqual(await first.json())
    expect(
      await env.DB.prepare(
        `SELECT quantity_available, version FROM inventory WHERE id = 'inventory-arc-bj'`,
      ).first(),
    ).toEqual({ quantity_available: 10, version: 2 })
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM inventory_adjustments').first(),
    ).toEqual({ count: 1 })

    const conflicting = await send(
      JSON.stringify({
        kind: 'loan',
        delta_total: 0,
        delta_available: -1,
        reason: '同键不同请求',
        expected_version: 2,
      }),
    )
    expect(conflicting.status).toBe(409)
  })

  it('rolls back the source when the destination changes after the service preflight', async () => {
    const repository = new D1InventoryRepository(env.DB)
    const source = await repository.position('inventory-arc-bj')
    const destination = await repository.position('inventory-arc-sh')
    expect(source).not.toBeNull()
    expect(destination).not.toBeNull()
    await env.DB.prepare(
      `UPDATE inventory SET quantity_total = 9, quantity_available = 5, version = 2
       WHERE id = 'inventory-arc-sh'`,
    ).run()

    await expect(
      repository.transfer(
        {
          sourceInventoryId: 'inventory-arc-bj',
          destinationSiteId: 'site-shanghai',
          quantity: 2,
          reason: '模拟并发调拨',
          actor: 'admin contract',
          tokenId: 'token-admin',
          idempotencyKey: 'concurrent-transfer-0001',
          operation: 'inventory-transfer:inventory-arc-bj',
          keyHash: 'concurrent-transfer-key-hash',
          requestHash: 'concurrent-transfer-hash',
          expectedSourceVersion: 1,
          expectedDestinationVersion: 1,
        },
        source!,
        destination!,
      ),
    ).rejects.toThrow()

    expect(
      await env.DB.prepare(
        `SELECT id, quantity_total, quantity_available, version FROM inventory
         WHERE id IN ('inventory-arc-bj', 'inventory-arc-sh') ORDER BY id`,
      ).all(),
    ).toMatchObject({
      results: [
        { id: 'inventory-arc-bj', quantity_total: 18, quantity_available: 12, version: 1 },
        { id: 'inventory-arc-sh', quantity_total: 9, quantity_available: 5, version: 2 },
      ],
    })
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM inventory_adjustments').first(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM idempotency_records').first(),
    ).toEqual({ count: 0 })
  })
})
