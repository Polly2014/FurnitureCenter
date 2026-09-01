export type RoleAwareStatus = 404 | 409 | 413 | 422

export class ApplicationError extends Error {
  constructor(
    readonly status: RoleAwareStatus,
    message: string,
  ) {
    super(message)
    this.name = 'ApplicationError'
  }
}

export type Category = {
  id: string
  name: string
}

export type Site = {
  id: string
  code: string
  name: string
  city: string
  latitude: number
  longitude: number
  is_active: boolean
  version: number
  created_at: string
  updated_at: string
}

export type FurnitureImage = {
  id: string
  url: string
  alt_text: string
  is_primary: boolean
}

export type InventoryPosition = {
  id: string
  site: Site
  quantity_total: number
  quantity_available: number
  version: number
  status: 'active' | 'allocated' | 'withdrawn'
  closed_at: string | null
  closed_reason: string | null
}

export type Furniture = {
  id: string
  sku: string
  name: string
  category: string
  description: string
  condition: string
  name_en: string
  main_category: string
  dimensions: string
  color: string
  material: string
  brand: string
  image_reference: string
  source_workbook: string
  source_sheet: string
  source_row: number | null
  quantity_available: number
  images: FurnitureImage[]
  inventory: InventoryPosition[]
}

export type MapFeature = {
  site_id: string
  site_name: string
  latitude: number
  longitude: number
  quantity_available: number
  furniture_ids: string[]
}

export type QueryFilters = {
  category: string | null
  siteId: string | null
  availableOnly: boolean
}

export type QueryResult = {
  items: Furniture[]
  map_features: MapFeature[]
  total: number
  applied_query: string | null
  applied_filters: Record<string, string | boolean>
  answer: null
}

export type AuditEvent = {
  id: string
  entity_type: string
  entity_id: string
  action: string
  actor: string
  details_json: string
  created_at: string
}
