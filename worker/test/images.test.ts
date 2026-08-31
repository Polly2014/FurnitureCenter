import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { browserAuth, resetDatabase, seedContractCatalog } from './helpers'
import worker from '../src/index'
import { ImageService } from '../src/images/service'

const pngBytes = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='),
  (character) => character.charCodeAt(0),
)

beforeEach(async () => {
  await resetDatabase()
  await seedContractCatalog()
})

async function upload(
  auth: Awaited<ReturnType<typeof browserAuth>>,
  options: { body?: BodyInit; contentType?: string; key?: string } = {},
) {
  return SELF.fetch(
    'https://fc.test/api/admin/furniture/furniture-arc-chair/images/uploads',
    {
      method: 'POST',
      headers: {
        'Content-Type': options.contentType ?? 'image/png',
        'Idempotency-Key': options.key ?? crypto.randomUUID(),
        ...auth.headers,
      },
      body: options.body ?? pngBytes,
    },
  )
}

async function uploadAndFinalize(
  auth: Awaited<ReturnType<typeof browserAuth>>,
  options: { altText: string; primary?: boolean; key?: string },
) {
  const uploaded = await upload(auth, { key: options.key })
  expect(uploaded.status).toBe(201)
  const uploadResult = await uploaded.json<{ upload_id: string }>()
  const finalized = await SELF.fetch(
    `https://fc.test/api/admin/furniture/furniture-arc-chair/images/uploads/${uploadResult.upload_id}/finalize`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth.headers },
      body: JSON.stringify({
        alt_text: options.altText,
        is_primary: options.primary ?? false,
      }),
    },
  )
  expect(finalized.status).toBe(201)
  return finalized.json<{
    id: string
    url: string
    alt_text: string
    is_primary: boolean
  }>()
}

async function signedImagePath(
  imageId: string,
  signingKey: string,
  expires: Date,
  variant = 'original',
) {
  const expiresSeconds = Math.floor(expires.getTime() / 1000)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${imageId}.${variant}.${expiresSeconds}`),
  )
  let binary = ''
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte)
  const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  return `/images/${imageId}?variant=${variant}&expires=${expiresSeconds}&signature=${encoded}`
}

describe('private R2 image management', () => {
  it('allows only admins and validates actual bytes, dimensions and size', async () => {
    const viewer = await browserAuth('viewer')
    expect((await upload(viewer)).status).toBe(403)

    const admin = await browserAuth('admin')
    const disguised = await upload(admin, {
      body: '<svg onload="alert(1)"/>',
      contentType: 'image/png',
    })
    expect(disguised.status).toBe(422)

    const oversized = new Uint8Array(4 * 1024 * 1024 + 1)
    oversized.set(pngBytes)
    const tooLarge = await upload(admin, { body: oversized, contentType: 'image/png' })
    expect(tooLarge.status).toBe(413)
  })

  it('stops a misleading-length upload as soon as streamed bytes exceed the limit', async () => {
    const chunkLimit = 4 * 1024 * 1024
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) controller.enqueue(pngBytes)
        else if (pulls === 2) controller.enqueue(new Uint8Array(chunkLimit))
        else return new Promise<void>(() => undefined)
      },
    })
    const request = new Request('https://fc.test/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '1' },
      body,
    })

    const result = await Promise.race([
      new ImageService(env).upload(
        'furniture-arc-chair',
        'token-admin',
        'streamed-limit-0001',
        request,
      ).catch((error: unknown) => error),
      new Promise<Error>((resolve) => setTimeout(() => resolve(new Error('stream was not stopped')), 50)),
    ])
    expect(result).toMatchObject({ status: 413 })
    expect(pulls).toBeGreaterThanOrEqual(2)
  })

  it('uploads with filename-independent keys and replays the same idempotency key', async () => {
    const admin = await browserAuth('admin')
    const first = await upload(admin, { key: 'image-upload-retry-0001' })
    expect(first.status).toBe(201)
    const firstPayload = await first.json<{
      upload_id: string
      byte_size: number
      width: number
      height: number
      mime_type: string
      sha256: string
    }>()
    expect(firstPayload).toMatchObject({
      byte_size: pngBytes.byteLength,
      width: 1,
      height: 1,
      mime_type: 'image/png',
    })
    expect(firstPayload.sha256).toMatch(/^[0-9a-f]{64}$/)

    const replay = await upload(admin, { key: 'image-upload-retry-0001' })
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(firstPayload)
    const pending = await env.DB.prepare(
      'SELECT object_key FROM image_uploads WHERE id = ?',
    )
      .bind(firstPayload.upload_id)
      .first<{ object_key: string }>()
    expect(pending?.object_key).toMatch(/^furniture\/furniture-arc-chair\/[0-9a-f-]+$/)
    expect(await env.IMAGES.head(pending!.object_key)).not.toBeNull()
    expect((await env.IMAGES.list()).objects).toHaveLength(1)
  })

  it('re-verifies R2 metadata before finalizing a durable image record', async () => {
    const admin = await browserAuth('admin')
    const uploaded = await upload(admin)
    const { upload_id: uploadId } = await uploaded.json<{ upload_id: string }>()
    const pending = await env.DB.prepare(
      'SELECT object_key FROM image_uploads WHERE id = ?',
    )
      .bind(uploadId)
      .first<{ object_key: string }>()
    await env.IMAGES.put(pending!.object_key, 'tampered', {
      httpMetadata: { contentType: 'image/png' },
    })

    const response = await SELF.fetch(
      `https://fc.test/api/admin/furniture/furniture-arc-chair/images/uploads/${uploadId}/finalize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...admin.headers },
        body: JSON.stringify({ alt_text: '损坏的上传', is_primary: true }),
      },
    )

    expect(response.status).toBe(409)
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM furniture_images WHERE id = ?')
        .bind(uploadId)
        .first(),
    ).toEqual({ count: 0 })
  })

  it('rejects oversized JSON finalization bodies even when Content-Length lies', async () => {
    const admin = await browserAuth('admin')
    const uploaded = await upload(admin)
    const { upload_id: uploadId } = await uploaded.json<{ upload_id: string }>()
    const body = JSON.stringify({ alt_text: 'x'.repeat(16 * 1024), is_primary: false })

    const response = await SELF.fetch(
      `https://fc.test/api/admin/furniture/furniture-arc-chair/images/uploads/${uploadId}/finalize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '1', ...admin.headers },
        body,
      },
    )

    expect(response.status).toBe(413)
  })

  it('serves authenticated and expiring signed image URLs with byte ranges', async () => {
    const admin = await browserAuth('admin')
    const image = await uploadAndFinalize(admin, {
      altText: '新上传的弧背椅',
      primary: true,
    })
    expect((await SELF.fetch(`https://fc.test${image.url}`)).status).toBe(401)

    const authenticated = await SELF.fetch(`https://fc.test${image.url}`, {
      headers: { Cookie: admin.cookie },
    })
    expect(authenticated.status).toBe(200)
    expect(authenticated.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await authenticated.arrayBuffer())).toEqual(pngBytes)

    const ranged = await SELF.fetch(`https://fc.test${image.url}`, {
      headers: { Cookie: admin.cookie, Range: 'bytes=0-7' },
    })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-7/${pngBytes.byteLength}`)
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(pngBytes.slice(0, 8))

    const now = new Date()
    const signedPath = await signedImagePath(
      image.id,
      'test-only-session-signing-key-not-for-production',
      new Date(now.getTime() + 60_000),
    )
    const signed = await SELF.fetch(`https://fc.test${signedPath}`)
    expect(signed.status).toBe(200)
    const expiredPath = await signedImagePath(
      image.id,
      'test-only-session-signing-key-not-for-production',
      new Date(now.getTime() - 1_000),
    )
    const expired = await SELF.fetch(`https://fc.test${expiredPath}`)
    expect(expired.status).toBe(401)
  })

  it('persists a deterministic private thumbnail and only serves its signed variant', async () => {
    const admin = await browserAuth('admin')
    const image = await uploadAndFinalize(admin, { altText: '弧背椅缩略图', primary: true })
    const row = await env.DB.prepare(
      `SELECT object_key, mime_type, width, height
       FROM image_derivatives WHERE image_id = ? AND variant = 'thumbnail'`,
    )
      .bind(image.id)
      .first<{ object_key: string; mime_type: string; width: number; height: number }>()
    expect(row).toEqual({
      object_key: `furniture/furniture-arc-chair/${image.id}/thumbnail.webp`,
      mime_type: 'image/webp',
      width: 320,
      height: 320,
    })
    expect(await env.IMAGES.head(row!.object_key)).not.toBeNull()

    const unsigned = await SELF.fetch(`https://fc.test/images/${image.id}?variant=thumbnail`)
    expect(unsigned.status).toBe(401)
    const signedPath = await signedImagePath(
      image.id,
      'test-only-session-signing-key-not-for-production',
      new Date(Date.now() + 60_000),
      'thumbnail',
    )
    const signed = await SELF.fetch(`https://fc.test${signedPath}`)
    expect(signed.status).toBe(200)
    expect(signed.headers.get('content-type')).toBe('image/webp')
  })

  it('keeps one primary image, applies ordering and deletes bytes idempotently', async () => {
    const admin = await browserAuth('admin')
    const secondary = await uploadAndFinalize(admin, {
      altText: '弧背椅侧面',
      key: 'image-secondary-0001',
    })
    const primary = await uploadAndFinalize(admin, {
      altText: '弧背椅正面',
      primary: true,
      key: 'image-primary-0001',
    })

    const reorder = await SELF.fetch(
      'https://fc.test/api/admin/furniture/furniture-arc-chair/images/order',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...admin.headers },
        body: JSON.stringify({
          image_ids: [secondary.id, primary.id, 'image-arc-chair'],
        }),
      },
    )
    expect(reorder.status).toBe(204)
    const catalog = await SELF.fetch('https://fc.test/api/catalog/furniture?query=弧背', {
      headers: { Cookie: admin.cookie },
    })
    const item = (await catalog.json<{
      items: Array<{ images: Array<{ id: string; is_primary: boolean }> }>
    }>()).items[0]
    expect(item.images[0]).toMatchObject({ id: primary.id, is_primary: true })
    expect(item.images.slice(1).map((image) => image.id)).toEqual([
      secondary.id,
      'image-arc-chair',
    ])

    const pending = await env.DB.prepare(
      'SELECT object_key FROM furniture_images WHERE id = ?',
    )
      .bind(primary.id)
      .first<{ object_key: string }>()
    const remove = () => SELF.fetch(
      `https://fc.test/api/admin/furniture/furniture-arc-chair/images/${primary.id}`,
      { method: 'DELETE', headers: admin.headers },
    )
    expect((await remove()).status).toBe(204)
    expect((await remove()).status).toBe(204)
    expect(await env.IMAGES.head(pending!.object_key)).toBeNull()
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM furniture_images WHERE id = ?')
        .bind(primary.id)
        .first(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare(
        `SELECT id FROM furniture_images
         WHERE furniture_id = 'furniture-arc-chair' AND is_primary = 1`,
      ).first(),
    ).not.toBeNull()
  })

  it('retains failed cleanup jobs and retries every original and derivative object on cron', async () => {
    const objectKeys = ['furniture/cleanup/original', 'furniture/cleanup/thumbnail.webp']
    await Promise.all(objectKeys.map((objectKey) => env.IMAGES.put(objectKey, pngBytes)))
    await env.DB.batch(objectKeys.map((objectKey, index) => env.DB.prepare(
      `INSERT INTO image_cleanup_jobs (id, image_id, object_key)
       VALUES (?, 'image-cleanup', ?)`,
    ).bind(`cleanup-${index}`, objectKey)))
    const scheduled = (worker as unknown as {
      scheduled: (controller: ScheduledController, cleanupEnv: typeof env, context: ExecutionContext) => Promise<void>
    }).scheduled
    const firstContext = createExecutionContext()
    const unavailableBucket = {
      ...env,
      IMAGES: { delete: async () => { throw new Error('R2 unavailable') } },
    } as unknown as typeof env
    await scheduled(createScheduledController({ cron: '*/5 * * * *' }), unavailableBucket, firstContext)
    await waitOnExecutionContext(firstContext)
    expect(await env.DB.prepare(
      `SELECT attempts, status, last_error
       FROM image_cleanup_jobs WHERE id = 'cleanup-0'`,
    ).first()).toMatchObject({ attempts: 1, status: 'pending', last_error: 'R2 deletion failed' })
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE action = 'cleanup_failed' AND entity_id = 'image-cleanup'`,
    ).first()).toEqual({ count: 2 })

    const retryContext = createExecutionContext()
    await scheduled(createScheduledController({ cron: '*/5 * * * *' }), env, retryContext)
    await waitOnExecutionContext(retryContext)
    expect(await Promise.all(objectKeys.map((objectKey) => env.IMAGES.head(objectKey)))).toEqual([null, null])
    expect(await env.DB.prepare(
      `SELECT status, completed_at, attempts
       FROM image_cleanup_jobs WHERE id = 'cleanup-0'`,
    ).first()).toMatchObject({ status: 'completed', attempts: 1 })
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE action = 'cleanup_completed' AND entity_id = 'image-cleanup'`,
    ).first()).toEqual({ count: 2 })
  })
})
