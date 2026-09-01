import { applyD1Migrations, env, SELF } from 'cloudflare:test'
import contract from '../../tests/fixtures/catalog-contract.json'

export type Contract = typeof contract

const tokens = {
  viewer: 'fc_test_viewer_contract_0123456789abcdefghijklmnopqrstuvwxyz',
  admin: 'fc_test_admin_contract_0123456789abcdefghijklmnopqrstuvwxyz',
} as const

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function resetDatabase() {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare('DROP TRIGGER IF EXISTS transfer_records_immutable_update').run()
  await env.DB.prepare('DROP TRIGGER IF EXISTS transfer_records_immutable_delete').run()
  for (const table of [
    'mcp_daily_usage',
    'chat_daily_usage',
    'image_derivatives',
    'image_cleanup_jobs',
    'image_uploads',
    'idempotency_records',
    'transfer_records',
    'sessions',
    'access_tokens',
    'audit_events',
    'inventory_adjustments',
    'inventory',
    'furniture_images',
    'furniture',
    'sites',
    'categories',
  ]) {
    const exists = await env.DB.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
      .bind(table)
      .first()
    if (exists) await env.DB.prepare(`DELETE FROM ${table}`).run()
  }
  const objects = await env.IMAGES.list()
  if (objects.objects.length > 0) {
    await env.IMAGES.delete(objects.objects.map((object) => object.key))
  }
  await env.DB.prepare(
    `CREATE TRIGGER transfer_records_immutable_update
     BEFORE UPDATE ON transfer_records
     BEGIN
       SELECT RAISE(ABORT, 'transfer records are immutable');
     END`,
  ).run()
  await env.DB.prepare(
    `CREATE TRIGGER transfer_records_immutable_delete
     BEFORE DELETE ON transfer_records
     BEGIN
       SELECT RAISE(ABORT, 'transfer records are immutable');
     END`,
  ).run()
}

export async function seedContractCatalog() {
  for (const category of contract.categories) {
    await env.DB.prepare('INSERT INTO categories (id, name) VALUES (?, ?)')
      .bind(category.id, category.name)
      .run()
  }
  for (const site of contract.sites) {
    const timestamp = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO sites
        (id, code, name, city, latitude, longitude, is_active, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    )
      .bind(
        site.id,
        site.code,
        site.name,
        site.city,
        site.latitude,
        site.longitude,
        timestamp,
        timestamp,
      )
      .run()
  }
  for (const furniture of contract.furniture) {
    await env.DB.prepare(
      `INSERT INTO furniture
        (id, sku, name, name_en, category_id, main_category, description, condition,
         dimensions, color, material, brand, image_reference, source_workbook,
         source_sheet, source_row)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        furniture.id,
        furniture.sku,
        furniture.name,
        furniture.name_en,
        furniture.category_id,
        furniture.main_category,
        furniture.description,
        furniture.condition,
        furniture.dimensions,
        furniture.color,
        furniture.material,
        furniture.brand,
        furniture.image_reference,
        furniture.source_workbook,
        furniture.source_sheet,
        furniture.source_row,
      )
      .run()
    for (const image of furniture.images) {
      await env.DB.prepare(
        `INSERT INTO furniture_images
          (id, furniture_id, object_key, mime_type, byte_size, width, height, sha256,
           alt_text, sort_order, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          image.id,
          furniture.id,
          image.object_key,
          image.mime_type,
          image.byte_size,
          image.width,
          image.height,
          image.sha256,
          image.alt_text,
          image.sort_order,
          image.is_primary ? 1 : 0,
        )
        .run()
    }
    for (const position of furniture.inventory) {
      await env.DB.prepare(
        `INSERT INTO inventory
          (id, furniture_id, site_id, quantity_total, quantity_available, version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          position.id,
          furniture.id,
          position.site_id,
          position.quantity_total,
          position.quantity_available,
          position.version,
        )
        .run()
    }
  }
}

function extractCookie(setCookie: string, name: string) {
  const match = setCookie.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`))
  if (!match) throw new Error(`Missing ${name} cookie`)
  return { header: `${name}=${match[1]}`, value: match[1] }
}

export async function browserAuth(role: 'viewer' | 'admin') {
  const raw = tokens[role]
  await env.DB.prepare(
    `INSERT INTO access_tokens (id, token_hash, role, scopes_json, label)
     VALUES (?, ?, ?, '[]', ?)`,
  )
    .bind(`token-${role}`, await sha256(raw), role, `${role} contract`)
    .run()
  const origin = 'https://fc.test'
  const response = await SELF.fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ token: raw }),
  })
  if (response.status !== 200) throw new Error(`Unable to authenticate ${role}`)
  const setCookie = response.headers.get('set-cookie') ?? ''
  const session = extractCookie(setCookie, 'fc_session')
  const csrf = extractCookie(setCookie, 'fc_csrf')
  return {
    cookie: `${session.header}; ${csrf.header}`,
    csrf: csrf.value,
    origin,
    get headers() {
      return {
        Cookie: this.cookie,
        Origin: this.origin,
        'X-CSRF-Token': this.csrf,
      }
    },
  }
}

export { contract }
