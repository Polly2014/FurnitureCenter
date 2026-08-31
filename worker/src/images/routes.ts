import type { Context, Hono } from 'hono'
import { requireCsrf, requireRole, type AuthEnvironment } from '../auth/middleware'
import { ApplicationError } from '../catalog/models'
import { ImageService, parseByteRange } from './service'

function service(context: Context<AuthEnvironment>) {
  return new ImageService(context.env)
}

function errorResponse(context: Context<AuthEnvironment>, error: unknown) {
  if (error instanceof ApplicationError) return context.json({ detail: error.message }, error.status)
  return context.json({ detail: '服务器处理图片请求失败' }, 500)
}

function idempotencyKey(context: Context<AuthEnvironment>) {
  const key = context.req.header('Idempotency-Key')?.trim() ?? ''
  if (!key) throw new ApplicationError(422, 'Idempotency-Key is required')
  return key
}

export function registerImageRoutes(app: Hono<AuthEnvironment>) {
  app.post(
    '/api/admin/furniture/:furnitureId/images/uploads',
    requireRole('admin'),
    requireCsrf(),
    async (context) => {
      try {
        const result = await service(context).upload(
          context.req.param('furnitureId'),
          context.get('auth').tokenId,
          idempotencyKey(context),
          context.req.raw,
        )
        return context.json(result, 201)
      } catch (error) {
        return errorResponse(context, error)
      }
    },
  )

  app.post(
    '/api/admin/furniture/:furnitureId/images/uploads/:uploadId/finalize',
    requireRole('admin'),
    requireCsrf(),
    async (context) => {
      try {
        const payload = await context.req.json<Record<string, unknown>>().catch(() => null)
        if (!payload) throw new ApplicationError(422, 'request body must be valid JSON')
        const image = await service(context).finalize(
          context.req.param('furnitureId'),
          context.req.param('uploadId'),
          context.get('auth').tokenId,
          typeof payload.alt_text === 'string' ? payload.alt_text : '',
          payload.is_primary === true,
        )
        return context.json(image, 201)
      } catch (error) {
        return errorResponse(context, error)
      }
    },
  )

  app.put(
    '/api/admin/furniture/:furnitureId/images/order',
    requireRole('admin'),
    requireCsrf(),
    async (context) => {
      try {
        const payload = await context.req.json<Record<string, unknown>>().catch(() => null)
        if (!payload) throw new ApplicationError(422, 'request body must be valid JSON')
        await service(context).reorder(
          context.req.param('furnitureId'),
          payload.image_ids,
          context.get('auth').tokenId,
        )
        return context.body(null, 204)
      } catch (error) {
        return errorResponse(context, error)
      }
    },
  )

  app.post(
    '/api/admin/furniture/:furnitureId/images/:imageId/primary',
    requireRole('admin'),
    requireCsrf(),
    async (context) => {
      try {
        await service(context).setPrimary(
          context.req.param('furnitureId'),
          context.req.param('imageId'),
          context.get('auth').tokenId,
        )
        return context.body(null, 204)
      } catch (error) {
        return errorResponse(context, error)
      }
    },
  )

  app.delete(
    '/api/admin/furniture/:furnitureId/images/:imageId',
    requireRole('admin'),
    requireCsrf(),
    async (context) => {
      try {
        await service(context).remove(
          context.req.param('furnitureId'),
          context.req.param('imageId'),
          context.get('auth').tokenId,
        )
        return context.body(null, 204)
      } catch (error) {
        return errorResponse(context, error)
      }
    },
  )

  app.get('/images/:imageId', async (context) => {
    try {
      const imageId = context.req.param('imageId')
      const imageService = service(context)
      if (!(await imageService.authorizeDelivery(context.req.raw, imageId))) {
        return context.json({ detail: '未认证或图片签名已失效' }, 401)
      }
      const image = await imageService.imageById(imageId)
      if (!image) throw new ApplicationError(404, `Image not found: ${imageId}`)
      const range = parseByteRange(context.req.header('Range') ?? null, image.byte_size)
      const object = await context.env.IMAGES.get(
        image.object_key,
        range ? { range: { offset: range.offset, length: range.length } } : undefined,
      )
      if (!object) throw new ApplicationError(404, `Image object not found: ${imageId}`)
      const headers = new Headers()
      object.writeHttpMetadata(headers)
      headers.set('Content-Type', image.mime_type)
      headers.set('Content-Length', String(range?.length ?? image.byte_size))
      headers.set('ETag', object.httpEtag)
      headers.set('Accept-Ranges', 'bytes')
      headers.set('Cache-Control', 'private, no-store')
      headers.set('X-Content-Type-Options', 'nosniff')
      if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.end}/${image.byte_size}`)
      return new Response(object.body, { status: range ? 206 : 200, headers })
    } catch (error) {
      return errorResponse(context, error)
    }
  })
}
