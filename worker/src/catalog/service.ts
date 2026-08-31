import { D1CatalogRepository, type CreateFurnitureRecord, type UpdateFurnitureRecord } from './repository'
import { ApplicationError, type Furniture, type MapFeature, type QueryFilters } from './models'

const conditions = new Set(['excellent', 'good', 'fair', 'repair'])

export class CatalogService {
  constructor(private readonly repository: D1CatalogRepository) {}

  async search(options: {
    query?: string | null
    category?: string | null
    siteId?: string | null
    availableOnly?: boolean
    limit?: number
    offset?: number
  }) {
    const limit = options.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApplicationError(422, 'limit must be between 1 and 100')
    }
    const offset = options.offset ?? 0
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
      throw new ApplicationError(422, 'offset must be between 0 and 100000')
    }
    const query = options.query?.trim() || null
    const filters: QueryFilters = {
      category: options.category?.trim() || null,
      siteId: options.siteId?.trim() || null,
      availableOnly: options.availableOnly ?? true,
    }
    const items = await this.repository.search(query, filters, limit, offset)
    return {
      items,
      map_features: this.mapFeatures(items),
      total: items.length,
      applied_query: query,
      applied_filters: {
        category: filters.category ?? '',
        site_id: filters.siteId ?? '',
        available_only: filters.availableOnly,
      },
      answer: null,
    }
  }

  metadata() {
    return this.repository.metadata()
  }

  get(id: string) {
    return this.repository.get(id)
  }

  private mapFeatures(items: Furniture[]): MapFeature[] {
    const bySite = new Map<string, MapFeature>()
    for (const item of items) {
      for (const position of item.inventory) {
        if (position.quantity_available === 0) continue
        const current = bySite.get(position.site.id)
        if (current) {
          current.quantity_available += position.quantity_available
          current.furniture_ids.push(item.id)
        } else {
          bySite.set(position.site.id, {
            site_id: position.site.id,
            site_name: position.site.name,
            latitude: position.site.latitude,
            longitude: position.site.longitude,
            quantity_available: position.quantity_available,
            furniture_ids: [item.id],
          })
        }
      }
    }
    return [...bySite.values()]
  }
}

export class CatalogAdministrationService {
  constructor(private readonly repository: D1CatalogRepository) {}

  async create(input: CreateFurnitureRecord, actor: string) {
    if (!input.sku || !input.name) throw new ApplicationError(422, 'SKU and name are required')
    this.validateCondition(input.condition)
    if (!Number.isInteger(input.quantity) || input.quantity < 0) {
      throw new ApplicationError(422, 'initial quantity cannot be negative')
    }
    if (await this.repository.skuExists(input.sku)) {
      throw new ApplicationError(409, `SKU already exists: ${input.sku}`)
    }
    await this.requireCategoryAndSite(input.categoryId, input.siteId)
    try {
      return await this.repository.createFurniture(input, actor)
    } catch {
      throw new ApplicationError(409, `SKU already exists: ${input.sku}`)
    }
  }

  async update(id: string, input: UpdateFurnitureRecord, actor: string) {
    if (!input.name) throw new ApplicationError(422, 'name is required')
    this.validateCondition(input.condition)
    if (!(await this.repository.furnitureIdentity(id))) {
      throw new ApplicationError(404, `Furniture not found: ${id}`)
    }
    if (!(await this.repository.categoryExists(input.categoryId))) {
      throw new ApplicationError(404, `Category not found: ${input.categoryId}`)
    }
    await this.repository.updateFurniture(id, input, actor)
  }

  async delete(id: string, actor: string) {
    const identity = await this.repository.furnitureIdentity(id)
    if (!identity) throw new ApplicationError(404, `Furniture not found: ${id}`)
    try {
      await this.repository.deleteFurniture(id, identity.sku, actor)
    } catch {
      throw new ApplicationError(409, 'furniture with inventory history cannot be deleted')
    }
  }

  listAudit(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ApplicationError(422, 'limit must be between 1 and 200')
    }
    return this.repository.listAudit(limit)
  }

  private async requireCategoryAndSite(categoryId: string, siteId: string) {
    if (!(await this.repository.categoryExists(categoryId))) {
      throw new ApplicationError(404, `Category not found: ${categoryId}`)
    }
    if (!(await this.repository.siteExists(siteId))) {
      throw new ApplicationError(404, `Site not found: ${siteId}`)
    }
  }

  private validateCondition(condition: string) {
    if (!conditions.has(condition)) {
      throw new ApplicationError(422, 'condition must be excellent, good, fair or repair')
    }
  }
}
