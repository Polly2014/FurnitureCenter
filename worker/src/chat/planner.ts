export type QueryPlan = {
  query: string | null
  category: string | null
  siteId: string | null
  availableOnly: boolean
}

export class PlannerError extends Error {}

const genericCatalogQueries = new Set([
  '家具',
  '共享家具',
  '可共享家具',
  '可共享的家具',
  '可用家具',
  '可用的家具',
  '物品',
  '共享物品',
  '可共享物品',
  '可共享的物品',
  '可用物品',
  '可用的物品',
  'furniture',
  'availablefurniture',
  'shareablefurniture',
  'sharedfurniture',
  'items',
  'availableitems',
  'shareableitems',
  'shareditems',
])

function normalizedQuery(value: string) {
  const trimmed = value.trim()
  const genericKey = trimmed.toLocaleLowerCase().replace(/\s+/gu, '')
  return genericCatalogQueries.has(genericKey) ? null : trimmed
}

export function validateQueryPlan(
  value: unknown,
  categories: string[],
  siteIds: string[],
): QueryPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlannerError('planner response is not an object')
  }
  const plan = value as Record<string, unknown>
  const keys = Object.keys(plan)
  if (keys.some((key) => !['query', 'category', 'site_id', 'available_only'].includes(key))) {
    throw new PlannerError('planner response contains an unsupported field')
  }
  const query = plan.query
  const category = plan.category
  const siteId = plan.site_id
  const availableOnly = plan.available_only
  if (query !== null && (typeof query !== 'string' || query.trim().length === 0 || query.length > 160)) {
    throw new PlannerError('planner query is invalid')
  }
  if (category !== null && (typeof category !== 'string' || !categories.includes(category))) {
    throw new PlannerError('planner category is invalid')
  }
  if (siteId !== null && (typeof siteId !== 'string' || !siteIds.includes(siteId))) {
    throw new PlannerError('planner site is invalid')
  }
  if (typeof availableOnly !== 'boolean') throw new PlannerError('planner availability is invalid')
  return {
    query: typeof query === 'string' ? normalizedQuery(query) : null,
    category: typeof category === 'string' ? category : null,
    siteId: typeof siteId === 'string' ? siteId : null,
    availableOnly,
  }
}
