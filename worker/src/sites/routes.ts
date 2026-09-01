import type { Context, Hono } from 'hono'
import { requireCsrf, requireRole, type AuthEnvironment } from '../auth/middleware'
import { ApplicationError } from '../catalog/models'
import { D1SiteRepository } from './repository'
import { SiteService, type SaveSiteInput, type UpdateSiteInput } from './service'

type JsonObject = Record<string, unknown>

function bodyObject(context: Context<AuthEnvironment>) {
  return context.req.json<JsonObject>().catch(() => {
    throw new ApplicationError(422, 'request body must be valid JSON')
  })
}

function text(value: unknown, field: string) {
  if (typeof value !== 'string') throw new ApplicationError(422, `${field} must be a string`)
  return value
}

function numeric(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApplicationError(422, `${field} must be a finite number`)
  }
  return value
}

function boolean(value: unknown, field: string) {
  if (typeof value !== 'boolean') throw new ApplicationError(422, `${field} must be a boolean`)
  return value
}

function integer(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApplicationError(422, `${field} must be an integer`)
  }
  return value
}

function optional<T>(
  payload: JsonObject,
  field: string,
  parser: (value: unknown, field: string) => T,
) {
  return field in payload ? parser(payload[field], field) : undefined
}

function errorResponse(context: Context<AuthEnvironment>, error: unknown) {
  if (error instanceof ApplicationError) return context.json({ detail: error.message }, error.status)
  return context.json({ detail: '服务器处理请求失败' }, 500)
}

function service(context: Context<AuthEnvironment>) {
  return new SiteService(new D1SiteRepository(context.env.DB))
}

export function registerSiteRoutes(app: Hono<AuthEnvironment>) {
  app.get('/api/admin/sites', requireRole('admin'), async (context) => {
    try {
      return context.json(await service(context).list())
    } catch (error) {
      return errorResponse(context, error)
    }
  })

  app.post(
    '/api/admin/sites',
    requireRole('admin'),
    requireCsrf(),
    async (context) => {
      try {
        const payload = await bodyObject(context)
        const input: SaveSiteInput = {
          code: text(payload.code, 'code'),
          name: text(payload.name, 'name'),
          city: text(payload.city, 'city'),
          latitude: numeric(payload.latitude, 'latitude'),
          longitude: numeric(payload.longitude, 'longitude'),
          isActive: payload.is_active === undefined ? true : boolean(payload.is_active, 'is_active'),
        }
        return context.json(
          await service(context).create(input, context.get('auth').tokenId),
          201,
        )
      } catch (error) {
        return errorResponse(context, error)
      }
    },
  )

  app.patch(
    '/api/admin/sites/:id',
    requireRole('admin'),
    requireCsrf(),
    async (context) => {
      try {
        const payload = await bodyObject(context)
        const input: UpdateSiteInput = {
          code: optional(payload, 'code', text),
          name: optional(payload, 'name', text),
          city: optional(payload, 'city', text),
          latitude: optional(payload, 'latitude', numeric),
          longitude: optional(payload, 'longitude', numeric),
          isActive: optional(payload, 'is_active', boolean),
          expectedVersion: integer(payload.expected_version, 'expected_version'),
        }
        return context.json(
          await service(context).update(
            context.req.param('id'),
            input,
            context.get('auth').tokenId,
          ),
        )
      } catch (error) {
        return errorResponse(context, error)
      }
    },
  )
}
