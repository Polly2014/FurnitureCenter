import type { Site } from '../catalog/models'

type SiteRow = Omit<Site, 'is_active'> & { is_active: number }

export type SaveSiteRecord = {
  code: string
  name: string
  city: string
  latitude: number
  longitude: number
  isActive: boolean
}

function siteFromRow(row: SiteRow): Site {
  return { ...row, is_active: row.is_active === 1 }
}

export class D1SiteRepository {
  constructor(private readonly database: D1Database) {}

  async list() {
    const rows = await this.database.prepare(
      `SELECT id, code, name, city, latitude, longitude, is_active, version,
              created_at, updated_at
       FROM sites
       ORDER BY is_active DESC, name, id`,
    ).all<SiteRow>()
    return rows.results.map(siteFromRow)
  }

  async get(id: string) {
    const row = await this.database.prepare(
      `SELECT id, code, name, city, latitude, longitude, is_active, version,
              created_at, updated_at
       FROM sites WHERE id = ?`,
    ).bind(id).first<SiteRow>()
    return row ? siteFromRow(row) : null
  }

  async codeExists(code: string, exceptId?: string) {
    const query = exceptId
      ? 'SELECT 1 FROM sites WHERE code = ? AND id != ?'
      : 'SELECT 1 FROM sites WHERE code = ?'
    const statement = this.database.prepare(query)
    return Boolean(
      await (exceptId ? statement.bind(code, exceptId) : statement.bind(code)).first(),
    )
  }

  async create(record: SaveSiteRecord, actor: string) {
    const id = crypto.randomUUID()
    const timestamp = new Date().toISOString()
    const site: Site = {
      id,
      code: record.code,
      name: record.name,
      city: record.city,
      latitude: record.latitude,
      longitude: record.longitude,
      is_active: record.isActive,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }
    await this.database.batch([
      this.database.prepare(
        `INSERT INTO sites
          (id, code, name, city, latitude, longitude, is_active, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        id,
        record.code,
        record.name,
        record.city,
        record.latitude,
        record.longitude,
        record.isActive ? 1 : 0,
        timestamp,
        timestamp,
      ),
      this.audit(id, 'created', actor, { after: site }),
    ])
    return site
  }

  async update(current: Site, record: SaveSiteRecord, expectedVersion: number, actor: string) {
    const updatedAt = new Date().toISOString()
    const site: Site = {
      ...current,
      code: record.code,
      name: record.name,
      city: record.city,
      latitude: record.latitude,
      longitude: record.longitude,
      is_active: record.isActive,
      version: expectedVersion + 1,
      updated_at: updatedAt,
    }
    const results = await this.database.batch([
      this.database.prepare(
        `UPDATE sites
         SET code = ?, name = ?, city = ?, latitude = ?, longitude = ?,
             is_active = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      ).bind(
        record.code,
        record.name,
        record.city,
        record.latitude,
        record.longitude,
        record.isActive ? 1 : 0,
        updatedAt,
        current.id,
        expectedVersion,
      ),
      this.database.prepare(
        `INSERT INTO audit_events
          (id, entity_type, entity_id, action, actor, details_json)
         SELECT ?, 'site', ?, 'updated', ?, ?
         WHERE changes() = 1`,
      ).bind(
        crypto.randomUUID(),
        current.id,
        actor,
        JSON.stringify({ before: current, after: site }),
      ),
    ])
    return results[0]?.meta.changes === 1 ? site : null
  }

  private audit(
    entityId: string,
    action: string,
    actor: string,
    details: Record<string, unknown>,
  ) {
    return this.database.prepare(
      `INSERT INTO audit_events
        (id, entity_type, entity_id, action, actor, details_json)
       VALUES (?, 'site', ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), entityId, action, actor, JSON.stringify(details))
  }
}
