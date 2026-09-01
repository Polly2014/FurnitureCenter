import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { browserAuth, resetDatabase, seedContractCatalog } from './helpers'

beforeEach(async () => {
  await resetDatabase()
  await seedContractCatalog()
})

describe('site administration', () => {
  it('allows admins to create, list, edit and deactivate a site with immutable audit facts', async () => {
    const admin = await browserAuth('admin')
    const created = await SELF.fetch('https://fc.test/api/admin/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin.headers },
      body: JSON.stringify({
        code: 'GZ',
        name: '广州园区',
        city: '广州',
        latitude: 23.1291,
        longitude: 113.2644,
        is_active: true,
      }),
    })

    expect(created.status).toBe(201)
    const site = await created.json<{
      id: string
      code: string
      name: string
      city: string
      latitude: number
      longitude: number
      is_active: boolean
      version: number
      created_at: string
      updated_at: string
    }>()
    expect(site).toMatchObject({
      code: 'GZ',
      name: '广州园区',
      city: '广州',
      latitude: 23.1291,
      longitude: 113.2644,
      is_active: true,
      version: 1,
    })
    expect(site.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(Number.isNaN(Date.parse(site.created_at))).toBe(false)
    expect(Number.isNaN(Date.parse(site.updated_at))).toBe(false)

    const updated = await SELF.fetch(`https://fc.test/api/admin/sites/${site.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...admin.headers },
      body: JSON.stringify({
        code: 'GZ-CN',
        name: '广州创新园区',
        city: '广州',
        latitude: 23.1305,
        longitude: 113.2601,
        is_active: false,
        expected_version: 1,
      }),
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      id: site.id,
      code: 'GZ-CN',
      name: '广州创新园区',
      is_active: false,
      version: 2,
    })

    const list = await SELF.fetch('https://fc.test/api/admin/sites', {
      headers: { Cookie: admin.cookie },
    })
    expect(list.status).toBe(200)
    expect(await list.json<Array<{ id: string; is_active: boolean }>>()).toContainEqual(
      expect.objectContaining({ id: site.id, is_active: false }),
    )

    const metadata = await SELF.fetch('https://fc.test/api/catalog/metadata', {
      headers: { Cookie: admin.cookie },
    })
    expect(await metadata.json<{ sites: Array<{ id: string }> }>()).not.toMatchObject({
      sites: expect.arrayContaining([expect.objectContaining({ id: site.id })]),
    })

    const audit = await env.DB.prepare(
      `SELECT action, actor, details_json FROM audit_events
       WHERE entity_type = 'site' AND entity_id = ? ORDER BY created_at, action`,
    ).bind(site.id).all()
    expect(audit.results).toHaveLength(2)
    expect(audit.results.map((event) => event.action)).toEqual(['created', 'updated'])
    expect(audit.results.every((event) => event.actor === 'token-admin')).toBe(true)
    expect(JSON.parse(String(audit.results[1].details_json))).toMatchObject({
      before: { code: 'GZ', is_active: true },
      after: { code: 'GZ-CN', is_active: false },
    })
  })

  it('rejects unauthorized access, invalid fields, duplicate codes and stale edits', async () => {
    const viewer = await browserAuth('viewer')
    const viewerList = await SELF.fetch('https://fc.test/api/admin/sites', {
      headers: { Cookie: viewer.cookie },
    })
    expect(viewerList.status).toBe(403)

    const admin = await browserAuth('admin')
    const invalid = await SELF.fetch('https://fc.test/api/admin/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin.headers },
      body: JSON.stringify({
        code: 'BAD',
        name: '无效园区',
        city: '未知',
        latitude: 91,
        longitude: 181,
        is_active: true,
      }),
    })
    expect(invalid.status).toBe(422)

    const duplicate = await SELF.fetch('https://fc.test/api/admin/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...admin.headers },
      body: JSON.stringify({
        code: 'BJ',
        name: '另一个北京园区',
        city: '北京',
        latitude: 39.9,
        longitude: 116.4,
        is_active: true,
      }),
    })
    expect(duplicate.status).toBe(409)

    const stale = await SELF.fetch('https://fc.test/api/admin/sites/site-beijing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...admin.headers },
      body: JSON.stringify({
        code: 'BJ',
        name: '北京园区（旧页面）',
        city: '北京',
        latitude: 39.9042,
        longitude: 116.4074,
        is_active: true,
        expected_version: 9,
      }),
    })
    expect(stale.status).toBe(409)
  })
})
