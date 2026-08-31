import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

describe('initial D1 migration', () => {
  it('creates every production data, authorization and audit table', async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>()

    expect(result.results.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'access_tokens',
        'audit_events',
        'categories',
        'furniture',
        'furniture_images',
        'inventory',
        'inventory_adjustments',
        'sessions',
        'sites',
      ]),
    )
  })

  it('enforces one inventory position per furniture and site', async () => {
    await env.DB.prepare('INSERT INTO categories (id, name) VALUES (?, ?)')
      .bind('category-seating', '座椅')
      .run()
    await env.DB.prepare(
      'INSERT INTO sites (id, code, name, city, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind('site-beijing', 'BJ', '北京园区', '北京', 39.9042, 116.4074)
      .run()
    await env.DB.prepare(
      'INSERT INTO furniture (id, sku, name, category_id, condition) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('furniture-chair', 'CHR-01', '会议椅', 'category-seating', 'good')
      .run()
    await env.DB.prepare(
      'INSERT INTO inventory (id, furniture_id, site_id, quantity_total, quantity_available) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('inventory-1', 'furniture-chair', 'site-beijing', 10, 8)
      .run()

    await expect(
      env.DB.prepare(
        'INSERT INTO inventory (id, furniture_id, site_id, quantity_total, quantity_available) VALUES (?, ?, ?, ?, ?)',
      )
        .bind('inventory-2', 'furniture-chair', 'site-beijing', 2, 2)
        .run(),
    ).rejects.toThrow()
  })
})
