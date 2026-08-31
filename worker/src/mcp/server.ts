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
  message: z.string(),
}).strict()

const siteSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  city: z.string(),
  latitude: z.number(),
  longitude: z.number(),
}).strict()

const categorySchema = z.object({ id: z.string(), name: z.string() }).strict()

const inventorySchema = z.object({
  site_id: z.string(),
  site_code: z.string(),
  site_name: z.string(),
  quantity_total: z.number().int().nonnegative(),
  quantity_available: z.number().int().nonnegative(),
}).strict()

const imageSchema = z.object({
  id: z.string(),
  alt_text: z.string(),
  is_primary: z.boolean(),
  url: z.string().url(),
  expires_at: z.string(),
}).strict()

const furnitureSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  name_en: z.string(),
  category: z.string(),
  main_category: z.string(),
  description: z.string(),
  condition: z.string(),
  dimensions: z.string(),
  color: z.string(),
  material: z.string(),
  brand: z.string(),
  quantity_available: z.number().int().nonnegative(),
  images: z.array(imageSchema),
  inventory: z.array(inventorySchema),
}).strict()

const searchOutputSchema = z.object({
  ok: z.boolean(),
  items: z.array(furnitureSchema).optional(),
  count: z.number().int().nonnegative().optional(),
  next_cursor: z.string().nullable().optional(),
  error: errorSchema.optional(),
}).strict()

const getOutputSchema = z.object({
  ok: z.boolean(),
  item: furnitureSchema.optional(),
  error: errorSchema.optional(),
}).strict()

const sitesOutputSchema = z.object({
  ok: z.boolean(),
  sites: z.array(siteSchema).max(100).optional(),
  error: errorSchema.optional(),
}).strict()

const categoriesOutputSchema = z.object({
  ok: z.boolean(),
  categories: z.array(categorySchema).max(100).optional(),
  error: errorSchema.optional(),
}).strict()

function encodeCursor(offset: number) {
  return btoa(`v1:${offset}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeCursor(cursor: string | undefined) {
  if (!cursor) return 0
  try {
    const normalized = cursor.replaceAll('-', '+').replaceAll('_', '/')
    const decoded = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
    const match = decoded.match(/^v1:(\d{1,6})$/u)
    if (!match) return null
    const offset = Number(match[1])
    return offset <= 100_000 ? offset : null
  } catch {
    return null
  }
}

function errorResult(code: 'invalid_cursor' | 'not_found' | 'internal_error', message: string) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: message }],
    structuredContent: { ok: false, error: { code, message } },
  }
}

async function mcpFurniture(
  item: Awaited<ReturnType<CatalogService['get']>> extends infer Item ? NonNullable<Item> : never,
  publicOrigin: string,
  signingKey: string,
) {
  const expires = Math.floor(Date.now() / 1000) + 5 * 60
  const expiresAt = new Date(expires * 1000)
  return {
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
  }
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
        cursor: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u).optional(),
      }).strict(),
      outputSchema: searchOutputSchema,
      annotations,
    },
    async ({ text, category, site_id: siteId, available_only: availableOnly, limit, cursor }) => {
      const offset = decodeCursor(cursor)
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
        const structuredContent = {
          ok: true,
          items,
          count: items.length,
          next_cursor: hasNext ? encodeCursor(offset + limit) : null,
        }
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
        const structuredContent = {
          ok: true,
          item: await mcpFurniture(item, publicOrigin, env.SESSION_SIGNING_KEY),
        }
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
        const structuredContent = { ok: true, sites: metadata.sites.slice(0, 100) }
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
        const structuredContent = { ok: true, categories: metadata.categories.slice(0, 100) }
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
