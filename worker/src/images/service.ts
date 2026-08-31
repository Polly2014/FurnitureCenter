import type { Env } from '../env'
import { authenticateSession } from '../auth/sessions'
import { sha256Hex } from '../auth/tokens'
import { ApplicationError, type FurnitureImage } from '../catalog/models'

const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 6000
const MAX_JSON_BYTES = 16 * 1024
const UPLOAD_TTL_MS = 30 * 60 * 1000
const THUMBNAIL_VARIANT = 'thumbnail'
const THUMBNAIL_WIDTH = 320
const THUMBNAIL_HEIGHT = 320
const THUMBNAIL_MIME_TYPE = 'image/webp'

type PendingUpload = {
  id: string
  furniture_id: string
  token_id: string
  idempotency_key_hash: string
  object_key: string
  mime_type: string
  byte_size: number
  width: number
  height: number
  sha256: string
  expires_at: string
}

type StoredImage = {
  id: string
  furniture_id: string
  object_key: string
  mime_type: string
  byte_size: number
  width: number
  height: number
  sha256: string
  alt_text: string
  sort_order: number
  is_primary: number
}

type StoredDerivative = {
  object_key: string
  mime_type: string
  byte_size: number
  width: number
  height: number
}

type CleanupJob = {
  id: string
  image_id: string
  object_key: string
}

export type UploadedImage = {
  upload_id: string
  byte_size: number
  width: number
  height: number
  mime_type: string
  sha256: string
  expires_at: string
}

function bodySizeError(kind: 'image' | 'request') {
  const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_JSON_BYTES
  return new ApplicationError(413, `${kind} must not exceed ${maxBytes} bytes`)
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  tooLarge: () => ApplicationError,
) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel()
        throw tooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readLimitedBytes(request: Request, maxBytes: number, kind: 'image' | 'request') {
  const declaredLength = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw bodySizeError(kind)
  if (!request.body) return new Uint8Array()
  return readBoundedStream(request.body, maxBytes, () => bodySizeError(kind))
}

export async function readLimitedJson(request: Request) {
  const bytes = await readLimitedBytes(request, MAX_JSON_BYTES, 'request')
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  } catch {
    throw new ApplicationError(422, 'request body must be valid JSON')
  }
}

function uploadResponse(row: PendingUpload): UploadedImage {
  return {
    upload_id: row.id,
    byte_size: row.byte_size,
    width: row.width,
    height: row.height,
    mime_type: row.mime_type,
    sha256: row.sha256,
    expires_at: row.expires_at,
  }
}

async function sha256Bytes(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function readPngDimensions(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { mimeType: 'image/png', width: view.getUint32(16), height: view.getUint32(20) }
}

function readJpegDimensions(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2
      continue
    }
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (segmentLength < 2 || offset + segmentLength + 2 > bytes.length) return null
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        mimeType: 'image/jpeg',
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      }
    }
    offset += segmentLength + 2
  }
  return null
}

function inspectImage(bytes: Uint8Array, declaredMimeType: string) {
  const metadata = readPngDimensions(bytes) ?? readJpegDimensions(bytes)
  if (!metadata || metadata.mimeType !== declaredMimeType) {
    throw new ApplicationError(422, 'image bytes do not match an allowed PNG or JPEG MIME type')
  }
  if (
    metadata.width < 1
    || metadata.height < 1
    || metadata.width > MAX_IMAGE_DIMENSION
    || metadata.height > MAX_IMAGE_DIMENSION
  ) {
    throw new ApplicationError(422, `image dimensions must be between 1 and ${MAX_IMAGE_DIMENSION}`)
  }
  return metadata
}

function encodeSignature(bytes: ArrayBuffer) {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeSignature(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  try {
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

async function hmacKey(signingKey: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )
}

export async function createSignedImagePath(
  imageId: string,
  signingKey: string,
  expiresAt: Date,
  variant = 'original',
) {
  const expires = Math.floor(expiresAt.getTime() / 1000)
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(signingKey, 'sign'),
    new TextEncoder().encode(`${imageId}.${variant}.${expires}`),
  )
  return `/images/${encodeURIComponent(imageId)}?variant=${encodeURIComponent(variant)}&expires=${expires}&signature=${encodeSignature(signature)}`
}

async function validSignedRequest(request: Request, imageId: string, variant: string, signingKey: string) {
  const url = new URL(request.url)
  const expires = Number(url.searchParams.get('expires'))
  const signature = url.searchParams.get('signature') ?? ''
  if (!Number.isInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return false
  const signatureBytes = decodeSignature(signature)
  if (!signatureBytes) return false
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(signingKey, 'verify'),
    signatureBytes,
    new TextEncoder().encode(`${imageId}.${variant}.${expires}`),
  )
}

function audit(
  database: D1Database,
  entityType: string,
  entityId: string,
  action: string,
  actor: string,
  details: Record<string, unknown>,
) {
  return database
    .prepare(
      `INSERT INTO audit_events
        (id, entity_type, entity_id, action, actor, details_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      entityType,
      entityId,
      action,
      actor,
      JSON.stringify(details),
    )
}

export class ImageService {
  constructor(private readonly env: Env) {}

  async upload(
    furnitureId: string,
    tokenId: string,
    idempotencyKey: string,
    request: Request,
  ): Promise<UploadedImage> {
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200 || /\s/u.test(idempotencyKey)) {
      throw new ApplicationError(422, 'Idempotency-Key must contain 8 to 200 non-space characters')
    }
    if (!(await this.env.DB.prepare('SELECT 1 FROM furniture WHERE id = ?').bind(furnitureId).first())) {
      throw new ApplicationError(404, `Furniture not found: ${furnitureId}`)
    }
    const bytes = await readLimitedBytes(request, MAX_IMAGE_BYTES, 'image')
    if (bytes.byteLength === 0) throw new ApplicationError(422, 'image body is required')
    const declaredMimeType = request.headers.get('Content-Type')?.split(';', 1)[0].trim() ?? ''
    const metadata = inspectImage(bytes, declaredMimeType)
    const digest = await sha256Bytes(bytes)
    const keyHash = await sha256Hex(idempotencyKey)
    const existing = await this.env.DB.prepare(
      `SELECT id, furniture_id, token_id, idempotency_key_hash, object_key, mime_type,
              byte_size, width, height, sha256, expires_at
       FROM image_uploads
       WHERE token_id = ? AND furniture_id = ? AND idempotency_key_hash = ?`,
    )
      .bind(tokenId, furnitureId, keyHash)
      .first<PendingUpload>()
    if (existing) {
      if (existing.sha256 !== digest) {
        throw new ApplicationError(409, 'idempotency key was already used for a different image')
      }
      return uploadResponse(existing)
    }

    const uploadId = crypto.randomUUID()
    const objectKey = `furniture/${furnitureId}/${crypto.randomUUID()}`
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString()
    await this.env.IMAGES.put(objectKey, bytes, {
      httpMetadata: { contentType: metadata.mimeType },
      customMetadata: {
        sha256: digest,
        width: String(metadata.width),
        height: String(metadata.height),
      },
    })
    try {
      await this.env.DB.batch([
        this.env.DB
          .prepare(
            `INSERT INTO image_uploads
              (id, furniture_id, token_id, idempotency_key_hash, object_key, mime_type,
               byte_size, width, height, sha256, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            uploadId,
            furnitureId,
            tokenId,
            keyHash,
            objectKey,
            metadata.mimeType,
            bytes.byteLength,
            metadata.width,
            metadata.height,
            digest,
            expiresAt,
          ),
        audit(this.env.DB, 'image_upload', uploadId, 'uploaded', tokenId, {
          furniture_id: furnitureId,
          byte_size: bytes.byteLength,
          sha256: digest,
        }),
      ])
    } catch (error) {
      await this.env.IMAGES.delete(objectKey)
      const replay = await this.env.DB.prepare(
        `SELECT id, furniture_id, token_id, idempotency_key_hash, object_key, mime_type,
                byte_size, width, height, sha256, expires_at
         FROM image_uploads
         WHERE token_id = ? AND furniture_id = ? AND idempotency_key_hash = ?`,
      )
        .bind(tokenId, furnitureId, keyHash)
        .first<PendingUpload>()
      if (replay && replay.sha256 === digest) return uploadResponse(replay)
      throw error
    }
    return {
      upload_id: uploadId,
      byte_size: bytes.byteLength,
      width: metadata.width,
      height: metadata.height,
      mime_type: metadata.mimeType,
      sha256: digest,
      expires_at: expiresAt,
    }
  }

  async finalize(
    furnitureId: string,
    uploadId: string,
    tokenId: string,
    altText: string,
    requestedPrimary: boolean,
  ): Promise<FurnitureImage> {
    const normalizedAlt = altText.trim()
    if (!normalizedAlt || normalizedAlt.length > 240) {
      throw new ApplicationError(422, 'alt_text must contain 1 to 240 characters')
    }
    const finalized = await this.image(uploadId, furnitureId)
    if (finalized) return this.imageResponse(finalized)
    const pending = await this.env.DB.prepare(
      `SELECT id, furniture_id, token_id, idempotency_key_hash, object_key, mime_type,
              byte_size, width, height, sha256, expires_at
       FROM image_uploads WHERE id = ? AND furniture_id = ? AND token_id = ?`,
    )
      .bind(uploadId, furnitureId, tokenId)
      .first<PendingUpload>()
    if (!pending) throw new ApplicationError(404, `Image upload not found: ${uploadId}`)
    if (Date.parse(pending.expires_at) <= Date.now()) {
      throw new ApplicationError(409, 'image upload has expired')
    }
    const object = await this.env.IMAGES.head(pending.object_key)
    if (
      !object
      || object.size !== pending.byte_size
      || object.httpMetadata?.contentType !== pending.mime_type
      || object.customMetadata?.sha256 !== pending.sha256
      || object.customMetadata?.width !== String(pending.width)
      || object.customMetadata?.height !== String(pending.height)
    ) {
      throw new ApplicationError(409, 'uploaded object no longer matches verified image metadata')
    }
    const thumbnail = await this.createThumbnail(pending)
    const summary = await this.env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(MAX(sort_order), -1) AS max_sort
       FROM furniture_images WHERE furniture_id = ?`,
    )
      .bind(furnitureId)
      .first<{ count: number; max_sort: number }>()
    const isPrimary = requestedPrimary || (summary?.count ?? 0) === 0
    const sortOrder = (summary?.max_sort ?? -1) + 1
    const statements: D1PreparedStatement[] = []
    if (isPrimary) {
      statements.push(
        this.env.DB.prepare(
          'UPDATE furniture_images SET is_primary = 0 WHERE furniture_id = ?',
        ).bind(furnitureId),
      )
    }
    statements.push(
      this.env.DB
        .prepare(
          `INSERT INTO furniture_images
            (id, furniture_id, object_key, mime_type, byte_size, width, height, sha256,
             alt_text, sort_order, is_primary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          uploadId,
          furnitureId,
          pending.object_key,
          pending.mime_type,
          pending.byte_size,
          pending.width,
          pending.height,
          pending.sha256,
          normalizedAlt,
          sortOrder,
          isPrimary ? 1 : 0,
        ),
      this.env.DB
        .prepare(
          `INSERT INTO image_derivatives
            (image_id, variant, object_key, mime_type, byte_size, width, height)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          uploadId,
          THUMBNAIL_VARIANT,
          thumbnail.objectKey,
          thumbnail.mimeType,
          thumbnail.byteSize,
          THUMBNAIL_WIDTH,
          THUMBNAIL_HEIGHT,
        ),
      this.env.DB.prepare('DELETE FROM image_uploads WHERE id = ?').bind(uploadId),
      audit(this.env.DB, 'furniture_image', uploadId, 'finalized', tokenId, {
        furniture_id: furnitureId,
        sha256: pending.sha256,
        is_primary: isPrimary,
        thumbnail_key: thumbnail.objectKey,
      }),
    )
    try {
      await this.env.DB.batch(statements)
    } catch (error) {
      await this.env.IMAGES.delete(thumbnail.objectKey)
      throw error
    }
    return {
      id: uploadId,
      url: `/images/${encodeURIComponent(uploadId)}`,
      alt_text: normalizedAlt,
      is_primary: isPrimary,
    }
  }

  async reorder(furnitureId: string, imageIds: unknown, actor: string) {
    if (
      !Array.isArray(imageIds)
      || !imageIds.every((id) => typeof id === 'string')
      || new Set(imageIds).size !== imageIds.length
    ) {
      throw new ApplicationError(422, 'image_ids must be a unique string array')
    }
    const current = await this.env.DB.prepare(
      'SELECT id FROM furniture_images WHERE furniture_id = ? ORDER BY sort_order, id',
    )
      .bind(furnitureId)
      .all<{ id: string }>()
    const currentIds = current.results.map((row) => row.id)
    if (
      currentIds.length !== imageIds.length
      || currentIds.some((id) => !imageIds.includes(id))
    ) {
      throw new ApplicationError(409, 'image order does not match the current furniture images')
    }
    await this.env.DB.batch([
      ...imageIds.map((id, index) => this.env.DB
        .prepare('UPDATE furniture_images SET sort_order = ? WHERE id = ? AND furniture_id = ?')
        .bind(index, id, furnitureId)),
      audit(this.env.DB, 'furniture', furnitureId, 'images_reordered', actor, { image_ids: imageIds }),
    ])
  }

  async setPrimary(furnitureId: string, imageId: string, actor: string) {
    if (!(await this.image(imageId, furnitureId))) {
      throw new ApplicationError(404, `Image not found: ${imageId}`)
    }
    await this.env.DB.batch([
      this.env.DB.prepare(
        'UPDATE furniture_images SET is_primary = 0 WHERE furniture_id = ?',
      ).bind(furnitureId),
      this.env.DB.prepare(
        'UPDATE furniture_images SET is_primary = 1 WHERE id = ? AND furniture_id = ?',
      ).bind(imageId, furnitureId),
      audit(this.env.DB, 'furniture_image', imageId, 'made_primary', actor, {
        furniture_id: furnitureId,
      }),
    ])
  }

  async remove(furnitureId: string, imageId: string, actor: string) {
    const image = await this.image(imageId, furnitureId)
    if (!image) {
      await this.runCleanup(imageId)
      return
    }
    const replacement = image.is_primary === 1
      ? await this.env.DB.prepare(
          `SELECT id FROM furniture_images
           WHERE furniture_id = ? AND id <> ? ORDER BY sort_order, id LIMIT 1`,
        )
          .bind(furnitureId, imageId)
          .first<{ id: string }>()
      : null
    const derivatives = await this.env.DB.prepare(
      'SELECT object_key FROM image_derivatives WHERE image_id = ?',
    ).bind(imageId).all<{ object_key: string }>()
    const objectKeys = [image.object_key, ...derivatives.results.map((derivative) => derivative.object_key)]
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        'DELETE FROM furniture_images WHERE id = ? AND furniture_id = ?',
      ).bind(imageId, furnitureId),
    ]
    if (replacement) {
      statements.push(
        this.env.DB.prepare('UPDATE furniture_images SET is_primary = 1 WHERE id = ?')
          .bind(replacement.id),
      )
    }
    statements.push(
      ...objectKeys.map((objectKey) => this.env.DB
        .prepare(
          `INSERT INTO image_cleanup_jobs (id, image_id, object_key)
           VALUES (?, ?, ?) ON CONFLICT(object_key) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), imageId, objectKey)),
      audit(this.env.DB, 'furniture_image', imageId, 'deleted', actor, {
        furniture_id: furnitureId,
        object_keys: objectKeys,
      }),
    )
    await this.env.DB.batch(statements)
    await this.runCleanup(imageId, actor)
  }

  async authorizeDelivery(request: Request, imageId: string, variant: string) {
    if (await authenticateSession(request, this.env)) return true
    return validSignedRequest(request, imageId, variant, this.env.SESSION_SIGNING_KEY)
  }

  imageById(imageId: string) {
    return this.image(imageId)
  }

  async imageAssetById(imageId: string, variant: string) {
    if (variant === 'original') return this.image(imageId)
    if (variant !== THUMBNAIL_VARIANT) throw new ApplicationError(404, `Image variant not found: ${variant}`)
    return this.env.DB.prepare(
      `SELECT object_key, mime_type, byte_size, width, height
       FROM image_derivatives WHERE image_id = ? AND variant = ?`,
    ).bind(imageId, variant).first<StoredDerivative>()
  }

  async retryPendingCleanup() {
    const jobs = await this.env.DB.prepare(
      `SELECT DISTINCT image_id FROM image_cleanup_jobs
       WHERE status = 'pending' ORDER BY created_at LIMIT 100`,
    ).all<{ image_id: string }>()
    await Promise.all(jobs.results.map((job) => this.runCleanup(job.image_id, 'system:cron')))
  }

  private image(imageId: string, furnitureId?: string) {
    const furnitureClause = furnitureId ? 'AND furniture_id = ?' : ''
    const statement = this.env.DB.prepare(
      `SELECT id, furniture_id, object_key, mime_type, byte_size, width, height,
              sha256, alt_text, sort_order, is_primary
       FROM furniture_images WHERE id = ? ${furnitureClause}`,
    )
    return (furnitureId ? statement.bind(imageId, furnitureId) : statement.bind(imageId))
      .first<StoredImage>()
  }

  private imageResponse(image: StoredImage): FurnitureImage {
    return {
      id: image.id,
      url: `/images/${encodeURIComponent(image.id)}`,
      alt_text: image.alt_text,
      is_primary: image.is_primary === 1,
    }
  }

  private async createThumbnail(pending: PendingUpload) {
    const original = await this.env.IMAGES.get(pending.object_key)
    if (!original) throw new ApplicationError(409, 'uploaded object is missing before thumbnail generation')
    const output = await this.env.IMAGES_TRANSFORM
      .input(original.body.pipeThrough(new FixedLengthStream(pending.byte_size)))
      .transform({
        width: THUMBNAIL_WIDTH,
        height: THUMBNAIL_HEIGHT,
        fit: 'cover',
        gravity: 'center',
      })
      .output({ format: THUMBNAIL_MIME_TYPE, quality: 80 })
    if (output.contentType() !== THUMBNAIL_MIME_TYPE) {
      throw new ApplicationError(409, 'thumbnail transform returned an unexpected MIME type')
    }
    const objectKey = `furniture/${pending.furniture_id}/${pending.id}/${THUMBNAIL_VARIANT}.webp`
    const bytes = await readBoundedStream(
      output.image(),
      MAX_IMAGE_BYTES,
      () => new ApplicationError(409, 'thumbnail output exceeds the image size limit'),
    )
    await this.env.IMAGES.put(objectKey, bytes, {
      httpMetadata: { contentType: THUMBNAIL_MIME_TYPE },
      customMetadata: {
        source_sha256: pending.sha256,
        variant: THUMBNAIL_VARIANT,
        width: String(THUMBNAIL_WIDTH),
        height: String(THUMBNAIL_HEIGHT),
      },
    })
    const stored = await this.env.IMAGES.head(objectKey)
    if (!stored || stored.size < 1 || stored.httpMetadata?.contentType !== THUMBNAIL_MIME_TYPE) {
      throw new ApplicationError(409, 'thumbnail object could not be verified after generation')
    }
    return { objectKey, mimeType: THUMBNAIL_MIME_TYPE, byteSize: stored.size }
  }

  private async runCleanup(imageId: string, actor = 'system') {
    const jobs = await this.env.DB.prepare(
      `SELECT id, image_id, object_key FROM image_cleanup_jobs
       WHERE image_id = ? AND status = 'pending' ORDER BY created_at, id`,
    ).bind(imageId).all<CleanupJob>()
    for (const job of jobs.results) {
      try {
        await this.env.IMAGES.delete(job.object_key)
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE image_cleanup_jobs
             SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
                 last_attempt_at = CURRENT_TIMESTAMP, last_error = NULL
             WHERE id = ?`,
          ).bind(job.id),
          audit(this.env.DB, 'furniture_image', job.image_id, 'cleanup_completed', actor, {
            object_key: job.object_key,
          }),
        ])
      } catch {
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE image_cleanup_jobs
             SET attempts = attempts + 1, last_error = 'R2 deletion failed',
                 last_attempt_at = CURRENT_TIMESTAMP WHERE id = ?`,
          ).bind(job.id),
          audit(this.env.DB, 'furniture_image', job.image_id, 'cleanup_failed', actor, {
            object_key: job.object_key,
            error: 'R2 deletion failed',
          }),
        ])
      }
    }
  }
}

export function parseByteRange(header: string | null, size: number) {
  if (!header) return null
  const match = header.match(/^bytes=(\d*)-(\d*)$/u)
  if (!match || (!match[1] && !match[2])) throw new ApplicationError(422, 'invalid byte range')
  let offset: number
  let end: number
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isInteger(suffix) || suffix <= 0) throw new ApplicationError(422, 'invalid byte range')
    offset = Math.max(0, size - suffix)
    end = size - 1
  } else {
    offset = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  }
  if (!Number.isInteger(offset) || !Number.isInteger(end) || offset < 0 || end < offset || offset >= size) {
    throw new ApplicationError(422, 'invalid byte range')
  }
  end = Math.min(end, size - 1)
  return { offset, length: end - offset + 1, end }
}
