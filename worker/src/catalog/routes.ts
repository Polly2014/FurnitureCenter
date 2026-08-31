import type { Context, Hono } from 'hono'
import { requireCsrf, requireRole, type AuthEnvironment } from '../auth/middleware'
import { ApplicationError } from './models'
import { D1CatalogRepository, type CreateFurnitureRecord, type UpdateFurnitureRecord } from './repository'
import { CatalogAdministrationService, CatalogService } from './service'

type JsonObject = Record<string, unknown>

function bodyObject(context: Context<AuthEnvironment>) {
  return context.req.json<JsonObject>().catch(() => {
    throw new ApplicationError(422, 'request body must be valid JSON')
  })
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function integer(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApplicationError(422, `${name} must be an integer`)
  }
  return value
}

function errorResponse(context: Context<AuthEnvironment>, error: unknown) {
  if (error instanceof ApplicationError) return context.json({ detail: error.message }, error.status)
  return context.json({ detail: '服务器处理请求失败' }, 500)
}

function catalog(context: Context<AuthEnvironment>) {
  return new CatalogService(new D1CatalogRepository(context.env.DB))
}

function administration(context: Context<AuthEnvironment>) {
  return new CatalogAdministrationService(new D1CatalogRepository(context.env.DB))
}

function createRecord(payload: JsonObject): CreateFurnitureRecord {
  return {
    sku: text(payload.sku),
    name: text(payload.name),
    categoryId: text(payload.category_id),
    description: text(payload.description),
    condition: text(payload.condition, 'good'),
    siteId: text(payload.site_id),
    quantity: integer(payload.quantity, 'quantity'),
    nameEn: text(payload.name_en),
    mainCategory: text(payload.main_category),
    dimensions: text(payload.dimensions),
    color: text(payload.color),
    material: text(payload.material),
    brand: text(payload.brand),
  }
}

function updateRecord(payload: JsonObject): UpdateFurnitureRecord {
  return {
    name: text(payload.name),
    categoryId: text(payload.category_id),
    description: text(payload.description),
    condition: text(payload.condition, 'good'),
    nameEn: text(payload.name_en),
    mainCategory: text(payload.main_category),
    dimensions: text(payload.dimensions),
    color: text(payload.color),
    material: text(payload.material),
    brand: text(payload.brand),
  }
}

export function registerCatalogRoutes(app: Hono<AuthEnvironment>) {
  app.get('/api/catalog/furniture', requireRole('viewer'), async (context) => {
    try {
      const rawAvailable = context.req.query('available_only')
      if (rawAvailable !== undefined && rawAvailable !== 'true' && rawAvailable !== 'false') {
        throw new ApplicationError(422, 'available_only must be true or false')
      }
      const rawLimit = context.req.query('limit')
      const limit = rawLimit === undefined ? 50 : Number(rawLimit)
      return context.json(
        await catalog(context).search({
          query: context.req.query('query'),
          category: context.req.query('category'),
          siteId: context.req.query('site_id'),
          availableOnly: rawAvailable === undefined ? true : rawAvailable === 'true',
          limit,
        }),
      )
    } catch (error) {
      return errorResponse(context, error)
    }
  })

  app.get('/api/catalog/metadata', requireRole('viewer'), async (context) => {
    try {
      return context.json(await catalog(context).metadata())
    } catch (error) {
      return errorResponse(context, error)
    }
  })

  app.post(
    '/api/admin/furniture',
    requireRole('admin'),
    requireCsrf(),
    async (context) => {
      try {
        const id = await administration(context).create(
          createRecord(await bodyObject(context)),
          context.get('auth').tokenId,
        )
        return context.json({ id }, 201)
      } catch (error) {
        return errorResponse(context, error)
      }
    },
  )

  app.put(
    '/api/admin/furniture/:id',
    requireRole('admin'),
    requireCsrf(),
    async (context) => {
      try {
        await administration(context).update(
          context.req.param('id'),
          updateRecord(await bodyObject(context)),
          context.get('auth').tokenId,
        )
        return context.body(null, 204)
      } catch (error) {
        return errorResponse(context, error)
      }
    },
  )

  app.delete(
    '/api/admin/furniture/:id',
    requireRole('admin'),
    requireCsrf(),
    async (context) => {
      try {
        await administration(context).delete(context.req.param('id'), context.get('auth').tokenId)
        return context.body(null, 204)
      } catch (error) {
        return errorResponse(context, error)
      }
    },
  )

  app.get('/api/admin/audit', requireRole('admin'), async (context) => {
    try {
      const rawLimit = context.req.query('limit')
      return context.json(
        await administration(context).listAudit(rawLimit === undefined ? 50 : Number(rawLimit)),
      )
    } catch (error) {
      return errorResponse(context, error)
    }
  })
}
