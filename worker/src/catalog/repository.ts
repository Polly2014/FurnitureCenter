import type {
  AuditEvent,
  Category,
  Furniture,
  FurnitureImage,
  InventoryPosition,
  QueryFilters,
  Site,
} from './models'

type D1Value = string | number | null

type FurnitureRow = {
  id: string
  sku: string
  name: string
  category_name: string
  description: string
  condition: string
  name_en: string
  main_category: string
  dimensions: string
  color: string
  material: string
  brand: string
  image_reference: string
  source_workbook: string
  source_sheet: string
  source_row: number | null
}

type ImageRow = {
  id: string
  furniture_id: string
  alt_text: string
  is_primary: number
}

type InventoryRow = {
  id: string
  furniture_id: string
  quantity_total: number
  quantity_available: number
  version: number
  site_id: string
  site_code: string
  site_name: string
  site_city: string
  site_latitude: number
  site_longitude: number
}

export type CreateFurnitureRecord = {
  sku: string
  name: string
  categoryId: string
  description: string
  condition: string
  siteId: string
  quantity: number
  nameEn: string
  mainCategory: string
  dimensions: string
  color: string
  material: string
  brand: string
}

export type UpdateFurnitureRecord = Omit<CreateFurnitureRecord, 'sku' | 'siteId' | 'quantity'>

function placeholders(count: number) {
  return Array.from({ length: count }, () => '?').join(', ')
}

function furnitureFromRow(row: FurnitureRow): Furniture {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category_name,
    description: row.description,
    condition: row.condition,
    name_en: row.name_en,
    main_category: row.main_category,
    dimensions: row.dimensions,
    color: row.color,
    material: row.material,
    brand: row.brand,
    image_reference: row.image_reference,
    source_workbook: row.source_workbook,
    source_sheet: row.source_sheet,
    source_row: row.source_row,
    quantity_available: 0,
    images: [],
    inventory: [],
  }
}

export class D1CatalogRepository {
  constructor(private readonly database: D1Database) {}

  async search(query: string | null, filters: QueryFilters, limit: number, offset = 0) {
    const where: string[] = []
    const bindings: D1Value[] = []
    if (query) {
      where.push(
        `(INSTR(LOWER(f.name), LOWER(?)) > 0 OR INSTR(LOWER(f.name_en), LOWER(?)) > 0
          OR INSTR(LOWER(f.description), LOWER(?)) > 0 OR INSTR(LOWER(f.sku), LOWER(?)) > 0
          OR INSTR(LOWER(f.brand), LOWER(?)) > 0 OR INSTR(LOWER(f.color), LOWER(?)) > 0
          OR INSTR(LOWER(f.material), LOWER(?)) > 0)`,
      )
      bindings.push(query, query, query, query, query, query, query)
    }
    if (filters.category) {
      where.push('c.name = ?')
      bindings.push(filters.category)
    }
    if (filters.siteId) {
      where.push(
        `EXISTS (
          SELECT 1 FROM inventory site_inventory
          WHERE site_inventory.furniture_id = f.id AND site_inventory.site_id = ?
            ${filters.availableOnly ? 'AND site_inventory.quantity_available > 0' : ''}
        )`,
      )
      bindings.push(filters.siteId)
    } else if (filters.availableOnly) {
      where.push(
        `EXISTS (
          SELECT 1 FROM inventory available_inventory
          WHERE available_inventory.furniture_id = f.id
            AND available_inventory.quantity_available > 0
        )`,
      )
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const furnitureRows = await this.database
      .prepare(
        `SELECT f.id, f.sku, f.name, c.name AS category_name, f.description,
                f.condition, f.name_en, f.main_category, f.dimensions, f.color,
                f.material, f.brand, f.image_reference, f.source_workbook,
                f.source_sheet, f.source_row
         FROM furniture f
         JOIN categories c ON c.id = f.category_id
         ${whereClause}
         ORDER BY f.name, f.id
         LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, limit, offset)
      .all<FurnitureRow>()
    return this.hydrate(furnitureRows.results, filters.siteId)
  }

  async get(id: string) {
    const row = await this.database
      .prepare(
        `SELECT f.id, f.sku, f.name, c.name AS category_name, f.description,
                f.condition, f.name_en, f.main_category, f.dimensions, f.color,
                f.material, f.brand, f.image_reference, f.source_workbook,
                f.source_sheet, f.source_row
         FROM furniture f
         JOIN categories c ON c.id = f.category_id
         WHERE f.id = ?
         LIMIT 1`,
      )
      .bind(id)
      .first<FurnitureRow>()
    const items = await this.hydrate(row ? [row] : [], null)
    return items[0] ?? null
  }

  private async hydrate(furnitureRows: FurnitureRow[], siteId: string | null) {
    if (furnitureRows.length === 0) return []

    const items = furnitureRows.map(furnitureFromRow)
    const itemsById = new Map(items.map((item) => [item.id, item]))
    const ids = items.map((item) => item.id)
    const imageStatement = this.database
      .prepare(
        `SELECT id, furniture_id, alt_text, is_primary
         FROM furniture_images
         WHERE furniture_id IN (${placeholders(ids.length)})
         ORDER BY furniture_id, is_primary DESC, sort_order, id`,
      )
      .bind(...ids)
    const inventoryBindings: D1Value[] = [...ids]
    const inventorySiteClause = siteId ? 'AND i.site_id = ?' : ''
    if (siteId) inventoryBindings.push(siteId)
    const inventoryStatement = this.database
      .prepare(
        `SELECT i.id, i.furniture_id, i.quantity_total, i.quantity_available,
                i.version, s.id AS site_id, s.code AS site_code, s.name AS site_name,
                s.city AS site_city, s.latitude AS site_latitude,
                s.longitude AS site_longitude
         FROM inventory i
         JOIN sites s ON s.id = i.site_id
         WHERE i.furniture_id IN (${placeholders(ids.length)}) ${inventorySiteClause}
         ORDER BY i.furniture_id, s.name, i.id`,
      )
      .bind(...inventoryBindings)
    const [images, inventory] = await this.database.batch<ImageRow | InventoryRow>([
      imageStatement,
      inventoryStatement,
    ])

    for (const row of images.results) {
      if (!('alt_text' in row)) continue
      const image: FurnitureImage = {
        id: row.id,
        url: `/images/${encodeURIComponent(row.id)}`,
        alt_text: row.alt_text,
        is_primary: row.is_primary === 1,
      }
      itemsById.get(row.furniture_id)?.images.push(image)
    }
    for (const row of inventory.results) {
      if (!('site_id' in row)) continue
      const position: InventoryPosition = {
        id: row.id,
        site: {
          id: row.site_id,
          code: row.site_code,
          name: row.site_name,
          city: row.site_city,
          latitude: row.site_latitude,
          longitude: row.site_longitude,
        },
        quantity_total: row.quantity_total,
        quantity_available: row.quantity_available,
        version: row.version,
      }
      const item = itemsById.get(row.furniture_id)
      if (item) {
        item.inventory.push(position)
        item.quantity_available += position.quantity_available
      }
    }
    return items
  }

  async metadata(): Promise<{ categories: Category[]; sites: Site[] }> {
    const [categories, sites] = await this.database.batch<Category | Site>([
      this.database.prepare('SELECT id, name FROM categories ORDER BY name, id'),
      this.database.prepare(
        'SELECT id, code, name, city, latitude, longitude FROM sites ORDER BY name, id',
      ),
    ])
    return {
      categories: categories.results.filter((row): row is Category => !('code' in row)),
      sites: sites.results.filter((row): row is Site => 'code' in row),
    }
  }

  async categoryExists(id: string) {
    return Boolean(
      await this.database.prepare('SELECT 1 FROM categories WHERE id = ?').bind(id).first(),
    )
  }

  async siteExists(id: string) {
    return Boolean(await this.database.prepare('SELECT 1 FROM sites WHERE id = ?').bind(id).first())
  }

  async furnitureIdentity(id: string) {
    return this.database
      .prepare('SELECT id, sku FROM furniture WHERE id = ?')
      .bind(id)
      .first<{ id: string; sku: string }>()
  }

  async skuExists(sku: string) {
    return Boolean(
      await this.database.prepare('SELECT 1 FROM furniture WHERE sku = ?').bind(sku).first(),
    )
  }

  async createFurniture(record: CreateFurnitureRecord, actor: string) {
    const furnitureId = crypto.randomUUID()
    const inventoryId = crypto.randomUUID()
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO furniture
            (id, sku, name, name_en, main_category, description, condition,
             dimensions, color, material, brand, category_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          furnitureId,
          record.sku,
          record.name,
          record.nameEn,
          record.mainCategory,
          record.description,
          record.condition,
          record.dimensions,
          record.color,
          record.material,
          record.brand,
          record.categoryId,
        ),
      this.database
        .prepare(
          `INSERT INTO inventory
            (id, furniture_id, site_id, quantity_total, quantity_available, version)
           VALUES (?, ?, ?, ?, ?, 1)`,
        )
        .bind(inventoryId, furnitureId, record.siteId, record.quantity, record.quantity),
      this.auditStatement(
        'furniture',
        furnitureId,
        'created',
        actor,
        JSON.stringify({ sku: record.sku }),
      ),
    ])
    return furnitureId
  }

  async updateFurniture(id: string, record: UpdateFurnitureRecord, actor: string) {
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE furniture
           SET name = ?, name_en = ?, main_category = ?, category_id = ?,
               description = ?, condition = ?, dimensions = ?, color = ?,
               material = ?, brand = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(
          record.name,
          record.nameEn,
          record.mainCategory,
          record.categoryId,
          record.description,
          record.condition,
          record.dimensions,
          record.color,
          record.material,
          record.brand,
          id,
        ),
      this.auditStatement(
        'furniture',
        id,
        'updated',
        actor,
        JSON.stringify({ name: record.name }),
      ),
    ])
  }

  async deleteFurniture(id: string, sku: string, actor: string) {
    await this.database.batch([
      this.database.prepare('DELETE FROM furniture WHERE id = ?').bind(id),
      this.auditStatement(
        'furniture',
        id,
        'deleted',
        actor,
        JSON.stringify({ sku }),
      ),
    ])
  }

  async listAudit(limit: number) {
    const rows = await this.database
      .prepare(
        `SELECT id, entity_type, entity_id, action, actor, details_json, created_at
         FROM audit_events ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(limit)
      .all<AuditEvent>()
    return rows.results
  }

  private auditStatement(
    entityType: string,
    entityId: string,
    action: string,
    actor: string,
    detailsJson: string,
  ) {
    return this.database
      .prepare(
        `INSERT INTO audit_events
          (id, entity_type, entity_id, action, actor, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), entityType, entityId, action, actor, detailsJson)
  }
}
