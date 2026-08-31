import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { D1CatalogRepository } from '../catalog/repository'
import { CatalogService } from '../catalog/service'
import type { Env } from '../env'
import { createSignedImagePath } from '../images/service'

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const errorSchema = z.object({
  code: z.enum(['invalid_cursor', 'not_found', 'internal_error']),
  message: z.string().max(500),
}).strict()

const siteSchema = z.object({
  id: z.string().max(200),
  code: z.string().max(50),
  name: z.string().max(200),
  city: z.string().max(200),
  latitude: z.number(),
  longitude: z.number(),
}).strict()

const categorySchema = z.object({
  id: z.string().max(200),
  name: z.string().max(200),
}).strict()

const inventorySchema = z.object({
  site_id: z.string().max(200),
  site_code: z.string().max(50),
  site_name: z.string().max(200),
  quantity_total: z.number().int().nonnegative(),
  quantity_available: z.number().int().nonnegative(),
}).strict()

const imageSchema = z.object({
  id: z.string().max(200),
  alt_text: z.string().max(1_000),
  is_primary: z.boolean(),
  url: z.string().max(2_048).url(),
  expires_at: z.string().max(32),
}).strict()

const furnitureSchema = z.object({
  id: z.string().max(200),
  sku: z.string().max(200),
  name: z.string().max(500),
  name_en: z.string().max(500),
  category: z.string().max(200),
  main_category: z.string().max(500),
  description: z.string().max(5_000),
  condition: z.string().max(100),
  dimensions: z.string().max(500),
  color: z.string().max(500),
  material: z.string().max(500),
  brand: z.string().max(500),
  quantity_available: z.number().int().nonnegative(),
  images: z.array(imageSchema).max(100),
  inventory: z.array(inventorySchema).max(100),
}).strict()

const toolErrorOutputSchema = z.object({
  ok: z.literal(false),
  error: errorSchema,
}).strict()

const searchSuccessSchema = z.object({
  ok: z.literal(true),
  items: z.array(furnitureSchema).max(50),
  count: z.number().int().nonnegative().max(50),
  next_cursor: z.string().max(512).nullable(),
}).strict()
const searchOutputSchema = z.discriminatedUnion('ok', [searchSuccessSchema, toolErrorOutputSchema])

const getSuccessSchema = z.object({
  ok: z.literal(true),
  item: furnitureSchema,
}).strict()
const getOutputSchema = z.discriminatedUnion('ok', [getSuccessSchema, toolErrorOutputSchema])

const sitesSuccessSchema = z.object({
  ok: z.literal(true),
  sites: z.array(siteSchema).max(100),
}).strict()
const sitesOutputSchema = z.discriminatedUnion('ok', [sitesSuccessSchema, toolErrorOutputSchema])

const categoriesSuccessSchema = z.object({
  ok: z.literal(true),
  categories: z.array(categorySchema).max(100),
}).strict()
const categoriesOutputSchema = z.discriminatedUnion('ok', [categoriesSuccessSchema, toolErrorOutputSchema])

type CursorContext = {
  query: string | null
  category: string | null
  siteId: string | null
  availableOnly: boolean
  limit: number
}

const cursorClaimsSchema = z.object({
  v: z.literal(2),
  filter_digest: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/u),
  limit: z.number().int().min(1).max(50),
  offset: z.number().int().min(0).max(100_000),
}).strict()

const cursorEnvelopeSchema = z.object({
  claims: cursorClaimsSchema,
  signature: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
}).strict()

function encodeBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value: string) {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

async function cursorKey(signingKey: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )
}

async function cursorClaims(context: CursorContext, offset: number) {
  const filterBytes = new TextEncoder().encode(JSON.stringify({
    query: context.query,
    category: context.category,
    site_id: context.siteId,
    available_only: context.availableOnly,
  }))
  const filterDigest = await crypto.subtle.digest('SHA-256', filterBytes)
  return {
    v: 2 as const,
    filter_digest: encodeBase64Url(new Uint8Array(filterDigest)),
    limit: context.limit,
    offset,
  }
}

async function encodeCursor(context: CursorContext, offset: number, signingKey: string) {
  const claims = await cursorClaims(context, offset)
  const signature = await crypto.subtle.sign(
    'HMAC',
    await cursorKey(signingKey, 'sign'),
    new TextEncoder().encode(JSON.stringify(claims)),
  )
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify({
    claims,
    signature: encodeBase64Url(new Uint8Array(signature)),
  })))
}

async function decodeCursor(
  cursor: string | undefined,
  context: CursorContext,
  signingKey: string,
) {
  if (!cursor) return 0
  try {
    const envelopeBytes = decodeBase64Url(cursor)
    if (!envelopeBytes) return null
    const parsed = cursorEnvelopeSchema.safeParse(
      JSON.parse(new TextDecoder().decode(envelopeBytes)),
    )
    if (!parsed.success) return null
    const signature = decodeBase64Url(parsed.data.signature)
    if (!signature) return null
    const valid = await crypto.subtle.verify(
      'HMAC',
      await cursorKey(signingKey, 'verify'),
      signature,
      new TextEncoder().encode(JSON.stringify(parsed.data.claims)),
    )
    if (!valid) return null
    const expected = await cursorClaims(context, parsed.data.claims.offset)
    if (JSON.stringify(parsed.data.claims) !== JSON.stringify(expected)) return null
    return parsed.data.claims.offset
  } catch {
    return null
  }
}

function errorResult(code: 'invalid_cursor' | 'not_found' | 'internal_error', message: string) {
  const structuredContent = toolErrorOutputSchema.parse({ ok: false, error: { code, message } })
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: message }],
    structuredContent,
  }
}

async function mcpFurniture(
  item: Awaited<ReturnType<CatalogService['get']>> extends infer Item ? NonNullable<Item> : never,
  publicOrigin: string,
  signingKey: string,
) {
  const expires = Math.floor(Date.now() / 1000) + 5 * 60
  const expiresAt = new Date(expires * 1000)
  return furnitureSchema.parse({
    id: item.id,
    sku: item.sku,
    name: item.name,
    name_en: item.name_en,
    category: item.category,
    main_category: item.main_category,
    description: item.description,
    condition: item.condition,
    dimensions: item.dimensions,
    color: item.color,
    material: item.material,
    brand: item.brand,
    quantity_available: item.quantity_available,
    images: await Promise.all(item.images.map(async (image) => ({
      id: image.id,
      alt_text: image.alt_text,
      is_primary: image.is_primary,
      url: new URL(
        await createSignedImagePath(image.id, signingKey, expiresAt),
        publicOrigin,
      ).toString(),
      expires_at: expiresAt.toISOString(),
    }))),
    inventory: item.inventory.map((position) => ({
      site_id: position.site.id,
      site_code: position.site.code,
      site_name: position.site.name,
      quantity_total: position.quantity_total,
      quantity_available: position.quantity_available,
    })),
  })
}

export function createFurnitureMcpServer(env: Env, publicOrigin: string) {
  const server = new McpServer({ name: 'FurnitureCenter', version: '1.0.0' })
  const catalog = new CatalogService(new D1CatalogRepository(env.DB))

  server.registerTool(
    'search_furniture',
    {
      description: 'Search furniture by text, category, site, and availability with per-site inventory.',
      inputSchema: z.object({
        text: z.string().trim().min(1).max(200).optional(),
        category: z.string().trim().min(1).max(100).optional(),
        site_id: z.string().trim().min(1).max(100).optional(),
        available_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u).optional(),
      }).strict(),
      outputSchema: searchOutputSchema,
      annotations,
    },
    async ({ text, category, site_id: siteId, available_only: availableOnly, limit, cursor }) => {
      const cursorContext = {
        query: text ?? null,
        category: category ?? null,
        siteId: siteId ?? null,
        availableOnly,
        limit,
      }
      const offset = await decodeCursor(cursor, cursorContext, env.SESSION_SIGNING_KEY)
      if (offset === null) return errorResult('invalid_cursor', 'The search cursor is invalid or expired.')
      try {
        const result = await catalog.search({
          query: text,
          category,
          siteId,
          availableOnly,
          limit: limit + 1,
          offset,
        })
        const hasNext = result.items.length > limit
        const items = await Promise.all(
          result.items.slice(0, limit).map((item) => mcpFurniture(item, publicOrigin, env.SESSION_SIGNING_KEY)),
        )
        const structuredContent = searchSuccessSchema.parse({
          ok: true,
          items,
          count: items.length,
          next_cursor: hasNext
            ? await encodeCursor(cursorContext, offset + limit, env.SESSION_SIGNING_KEY)
            : null,
        })
        return {
          content: [{
            type: 'text' as const,
            text: `${items.length} furniture record${items.length === 1 ? '' : 's'} matched.`,
          }],
          structuredContent,
        }
      } catch {
        return errorResult('internal_error', 'FurnitureCenter could not complete the request.')
      }
    },
  )

  server.registerTool(
    'get_furniture',
    {
      description: 'Get one furniture record with metadata, per-site inventory, and short-lived image URLs.',
      inputSchema: z.object({
        furniture_id: z.string().trim().min(1).max(200),
      }).strict(),
      outputSchema: getOutputSchema,
      annotations,
    },
    async ({ furniture_id: furnitureId }) => {
      try {
        const item = await catalog.get(furnitureId)
        if (!item) return errorResult('not_found', 'Furniture was not found.')
        const structuredContent = getSuccessSchema.parse({
          ok: true,
          item: await mcpFurniture(item, publicOrigin, env.SESSION_SIGNING_KEY),
        })
        return {
          content: [{ type: 'text' as const, text: `Found ${item.name} (${item.sku}).` }],
          structuredContent,
        }
      } catch {
        return errorResult('internal_error', 'FurnitureCenter could not complete the request.')
      }
    },
  )

  server.registerTool(
    'list_sites',
    {
      description: 'List the stable site identifiers accepted by furniture search filters.',
      inputSchema: z.object({}).strict(),
      outputSchema: sitesOutputSchema,
      annotations,
    },
    async () => {
      try {
        const metadata = await catalog.metadata()
        const structuredContent = sitesSuccessSchema.parse({
          ok: true,
          sites: metadata.sites,
        })
        return {
          content: [{ type: 'text' as const, text: `${structuredContent.sites.length} sites are registered.` }],
          structuredContent,
        }
      } catch {
        return errorResult('internal_error', 'FurnitureCenter could not complete the request.')
      }
    },
  )

  server.registerTool(
    'list_categories',
    {
      description: 'List the stable category identifiers and names accepted by furniture search.',
      inputSchema: z.object({}).strict(),
      outputSchema: categoriesOutputSchema,
      annotations,
    },
    async () => {
      try {
        const metadata = await catalog.metadata()
        const structuredContent = categoriesSuccessSchema.parse({
          ok: true,
          categories: metadata.categories,
        })
        return {
          content: [{ type: 'text' as const, text: `${structuredContent.categories.length} categories are registered.` }],
          structuredContent,
        }
      } catch {
        return errorResult('internal_error', 'FurnitureCenter could not complete the request.')
      }
    },
  )

  return server
}
