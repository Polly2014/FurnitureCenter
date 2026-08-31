export type QueryPlan = {
  query: string | null
  category: string | null
  siteId: string | null
  availableOnly: boolean
}

export class PlannerError extends Error {}

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
    query: typeof query === 'string' ? query.trim() : null,
    category: typeof category === 'string' ? category : null,
    siteId: typeof siteId === 'string' ? siteId : null,
    availableOnly,
  }
}
