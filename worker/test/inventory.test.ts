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

  it('atomically closes the whole shared listing, leaves the destination unchanged and records 10/3/7', async () => {
    const admin = await browserAuth('admin')
    await env.DB.prepare(
      `UPDATE inventory
       SET quantity_total = 10, quantity_available = 10
       WHERE id = 'inventory-arc-bj'`,
    ).run()
    const destinationBefore = await env.DB.prepare(
      `SELECT id, quantity_total, quantity_available, version, status
       FROM inventory WHERE id = 'inventory-arc-sh'`,
    ).first()
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
          quantity: 3,
          reason: '上海园区会议室领取',
          expected_source_version: 1,
        }),
      },
    )

    expect(response.status).toBe(200)
    const payload = await response.json<{
      transfer: Record<string, unknown>
      source: Record<string, unknown>
    }>()
    expect(payload.source).toEqual({
      inventory_id: 'inventory-arc-bj',
      quantity_total: 10,
      quantity_available: 0,
      version: 2,
      status: 'allocated',
      closed_at: expect.any(String),
      closed_reason: 'transferred',
    })
    expect(payload.transfer).toMatchObject({
      furniture_id: 'furniture-arc-chair',
      source_inventory_id: 'inventory-arc-bj',
      source_site_id: 'site-beijing',
      source_site_code_snapshot: 'BJ',
      source_site_name_snapshot: '北京园区',
      destination_site_id: 'site-shanghai',
      destination_site_code_snapshot: 'SH',
      destination_site_name_snapshot: '上海园区',
      listed_quantity_before: 10,
      transferred_quantity: 3,
      unlisted_remainder: 7,
      reason: '上海园区会议室领取',
      actor_token_id: 'token-admin',
      actor_label_snapshot: 'admin contract',
      created_at: expect.any(String),
    })
    expect(
      await env.DB.prepare(
        `SELECT id, quantity_total, quantity_available, version, status
         FROM inventory WHERE id = 'inventory-arc-sh'`,
      ).first(),
    ).toEqual(destinationBefore)

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
          quantity: 3,
          reason: '上海园区会议室领取',
          expected_source_version: 1,
        }),
      },
    )
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(payload)
    const adjustment = await env.DB.prepare(
      `SELECT kind, delta_total, delta_available, quantity_total_before,
              quantity_total_after, quantity_available_before,
              quantity_available_after, transfer_id
       FROM inventory_adjustments`,
    ).first()
    expect(adjustment).toEqual({
      kind: 'allocation_close',
      delta_total: 0,
      delta_available: -10,
      quantity_total_before: 10,
      quantity_total_after: 10,
      quantity_available_before: 10,
      quantity_available_after: 0,
      transfer_id: payload.transfer.id,
    })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM transfer_records').first())
      .toEqual({ count: 1 })
  })

  it('never creates a missing destination listing and rolls back every invalid transfer', async () => {
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
        }),
      },
    )
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({
      source: {
        quantity_total: 18,
        quantity_available: 0,
        version: 2,
        status: 'allocated',
      },
    })
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM inventory
         WHERE furniture_id = 'furniture-arc-chair' AND site_id = 'site-shenzhen'`,
      ).first(),
    ).toEqual({ count: 0 })
  })

  it('rejects inactive destinations and closed source listings without partial writes', async () => {
    const admin = await browserAuth('admin')
    await env.DB.prepare(
      `UPDATE sites SET is_active = 0 WHERE id = 'site-shenzhen'`,
    ).run()
    const inactive = await SELF.fetch(
      'https://fc.test/api/admin/inventory/inventory-arc-bj/transfers',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'transfer-inactive-0001',
          ...admin.headers,
        },
        body: JSON.stringify({
          destination_site_id: 'site-shenzhen',
          quantity: 2,
          reason: '停用园区不应接收',
          expected_source_version: 1,
        }),
      },
    )
    expect(inactive.status).toBe(422)

    await env.DB.prepare(
      `UPDATE inventory
       SET quantity_available = 0, status = 'allocated', closed_reason = 'transferred'
       WHERE id = 'inventory-arc-bj'`,
    ).run()
    const closed = await SELF.fetch(
      'https://fc.test/api/admin/inventory/inventory-arc-bj/transfers',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'transfer-closed-0001',
          ...admin.headers,
        },
        body: JSON.stringify({
          destination_site_id: 'site-shanghai',
          quantity: 1,
          reason: '重复领取已关闭批次',
          expected_source_version: 1,
        }),
      },
    )
    expect(closed.status).toBe(409)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM transfer_records').first())
      .toEqual({ count: 0 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM inventory_adjustments').first())
      .toEqual({ count: 0 })
  })

  it('lists immutable transfer records with admin-only filters and cursor pagination', async () => {
    const admin = await browserAuth('admin')
    const transfer = (sourceId: string, destinationSiteId: string, key: string) =>
      SELF.fetch(`https://fc.test/api/admin/inventory/${sourceId}/transfers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...admin.headers,
        },
        body: JSON.stringify({
          destination_site_id: destinationSiteId,
          quantity: 1,
          reason: `领取 ${key}`,
          expected_source_version: 1,
        }),
      })
    expect((await transfer('inventory-arc-bj', 'site-shanghai', 'history-arc-0001')).status)
      .toBe(200)
    expect((await transfer('inventory-oak-sh', 'site-shenzhen', 'history-oak-0001')).status)
      .toBe(200)

    const firstPage = await SELF.fetch('https://fc.test/api/admin/transfers?limit=1', {
      headers: { Cookie: admin.cookie },
    })
    expect(firstPage.status).toBe(200)
    const firstPayload = await firstPage.json<{
      items: Array<{ id: string }>
      next_cursor: string | null
    }>()
    expect(firstPayload.items).toHaveLength(1)
    expect(firstPayload.next_cursor).toEqual(expect.any(String))

    const secondPage = await SELF.fetch(
      `https://fc.test/api/admin/transfers?limit=1&cursor=${encodeURIComponent(firstPayload.next_cursor!)}`,
      { headers: { Cookie: admin.cookie } },
    )
    const secondPayload = await secondPage.json<{
      items: Array<{ id: string }>
      next_cursor: string | null
    }>()
    expect(secondPayload.items).toHaveLength(1)
    expect(secondPayload.items[0].id).not.toBe(firstPayload.items[0].id)

    const filtered = await SELF.fetch(
      'https://fc.test/api/admin/transfers?source_site_id=site-beijing&destination_site_id=site-shanghai',
      { headers: { Cookie: admin.cookie } },
    )
    const filteredPayload = await filtered.json<{ items: Array<{ furniture_id: string }> }>()
    expect(filteredPayload.items).toEqual([
      expect.objectContaining({ furniture_id: 'furniture-arc-chair' }),
    ])

    const viewer = await browserAuth('viewer')
    expect((await SELF.fetch('https://fc.test/api/admin/transfers', {
      headers: { Cookie: viewer.cookie },
    })).status).toBe(403)

    const recordId = firstPayload.items[0].id
    await expect(
      env.DB.prepare('UPDATE transfer_records SET reason = ? WHERE id = ?')
        .bind('试图篡改', recordId)
        .run(),
    ).rejects.toThrow('transfer records are immutable')
    await expect(
      env.DB.prepare('DELETE FROM transfer_records WHERE id = ?').bind(recordId).run(),
    ).rejects.toThrow('transfer records are immutable')
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

  it('rolls back all transfer facts when the source changes after service preflight', async () => {
    const repository = new D1InventoryRepository(env.DB)
    const source = await repository.position('inventory-arc-bj')
    expect(source).not.toBeNull()
    await env.DB.prepare(
      `UPDATE inventory SET quantity_total = 19, quantity_available = 13, version = 2
       WHERE id = 'inventory-arc-bj'`,
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
        },
        source!,
      ),
    ).rejects.toThrow()

    expect(
      await env.DB.prepare(
        `SELECT id, quantity_total, quantity_available, version, status FROM inventory
         WHERE id = 'inventory-arc-bj'`,
      ).all(),
    ).toMatchObject({
      results: [
        {
          id: 'inventory-arc-bj',
          quantity_total: 19,
          quantity_available: 13,
          version: 2,
          status: 'active',
        },
      ],
    })
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM inventory_adjustments').first(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM idempotency_records').first(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM transfer_records').first(),
    ).toEqual({ count: 0 })
  })
})
