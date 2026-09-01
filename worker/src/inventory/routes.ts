import type { Context, Hono } from 'hono'
import { requireCsrf, requireRole, type AuthEnvironment } from '../auth/middleware'
import { ApplicationError } from '../catalog/models'
import { D1InventoryRepository } from './repository'
import { InventoryService } from './service'

type JsonObject = Record<string, unknown>

function bodyObject(context: Context<AuthEnvironment>) {
  return context.req.json<JsonObject>().catch(() => {
    throw new ApplicationError(422, 'request body must be valid JSON')
  })
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function integer(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApplicationError(422, `${name} must be an integer`)
  }
  return value
}

function optionalInteger(value: unknown, name: string) {
  if (value === undefined || value === null) return null
  return integer(value, name)
}

function optionalQueryInteger(value: string | undefined, name: string) {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new ApplicationError(422, `${name} must be an integer`)
  return parsed
}

function idempotencyKey(context: Context<AuthEnvironment>) {
  const key = context.req.header('Idempotency-Key')?.trim() ?? ''
  if (!key) throw new ApplicationError(422, 'Idempotency-Key is required')
  return key
}

function errorResponse(context: Context<AuthEnvironment>, error: unknown) {
  if (error instanceof ApplicationError) return context.json({ detail: error.message }, error.status)
  return context.json({ detail: '服务器处理请求失败' }, 500)
}

function service(context: Context<AuthEnvironment>) {
  return new InventoryService(new D1InventoryRepository(context.env.DB))
}

export function registerInventoryRoutes(app: Hono<AuthEnvironment>) {
  app.post(
    '/api/admin/furniture/:id/inventory',
    requireRole('admin'),
    requireCsrf(),
    async (context) => {
      try {
        const payload = await bodyObject(context)
        const result = await service(context).createPosition({
          furnitureId: context.req.param('id'),
          siteId: text(payload.site_id),
          quantityTotal: integer(payload.quantity_total, 'quantity_total'),
          quantityAvailable: integer(payload.quantity_available, 'quantity_available'),
          actor: context.get('auth').tokenId,
        })
        return context.json(result, 201)
      } catch (error) {
        return errorResponse(context, error)
      }
    },
  )

  app.post(
    '/api/admin/inventory/:id/adjustments',
    requireRole('admin'),
    requireCsrf(),
    async (context) => {
      try {
        const payload = await bodyObject(context)
        const legacyDelta = optionalInteger(payload.delta, 'delta')
        const hasExplicitDeltas = payload.delta_total !== undefined || payload.delta_available !== undefined
        const deltaTotal = hasExplicitDeltas
          ? integer(payload.delta_total ?? 0, 'delta_total')
          : legacyDelta ?? 0
        const deltaAvailable = hasExplicitDeltas
          ? integer(payload.delta_available ?? 0, 'delta_available')
          : legacyDelta ?? 0
        return context.json(
          await service(context).adjust({
            inventoryId: context.req.param('id'),
            deltaTotal,
            deltaAvailable,
            kind: text(payload.kind) || 'correction',
            reason: text(payload.reason),
            actor: context.get('auth').tokenId,
            tokenId: context.get('auth').tokenId,
            idempotencyKey: idempotencyKey(context),
            expectedVersion: optionalInteger(payload.expected_version, 'expected_version'),
          }),
        )
      } catch (error) {
        return errorResponse(context, error)
      }
    },
  )

  app.post(
    '/api/admin/inventory/:id/transfers',
    requireRole('admin'),
    requireCsrf(),
    async (context) => {
      try {
        const payload = await bodyObject(context)
        return context.json(
          await service(context).transfer({
            sourceInventoryId: context.req.param('id'),
            destinationSiteId: text(payload.destination_site_id),
            quantity: integer(payload.quantity, 'quantity'),
            reason: text(payload.reason),
            actor: context.get('auth').tokenId,
            tokenId: context.get('auth').tokenId,
            idempotencyKey: idempotencyKey(context),
            expectedSourceVersion: integer(
              payload.expected_source_version,
              'expected_source_version',
            ),
          }),
        )
      } catch (error) {
        return errorResponse(context, error)
      }
    },
  )

  app.get('/api/admin/transfers', requireRole('admin'), async (context) => {
    try {
      return context.json(
        await service(context).listTransfers({
          furnitureId: context.req.query('furniture_id'),
          sourceSiteId: context.req.query('source_site_id'),
          destinationSiteId: context.req.query('destination_site_id'),
          from: context.req.query('from'),
          to: context.req.query('to'),
          cursor: context.req.query('cursor'),
          limit: optionalQueryInteger(context.req.query('limit'), 'limit'),
        }),
      )
    } catch (error) {
      return errorResponse(context, error)
    }
  })
}
