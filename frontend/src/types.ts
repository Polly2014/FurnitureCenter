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
}

export type InventoryPosition = {
  id: string
  site: Site
  quantity_total: number
  quantity_available: number
  version: number
}

export type InventoryAdjustmentInput = {
  kind: string
  delta_total: number
  delta_available: number
  reason: string
  expected_version: number
}

export type InventoryTransferInput = {
  destination_site_id: string
  quantity: number
  reason: string
  expected_source_version: number
  expected_destination_version: number | null
}

export type CreateInventoryPositionInput = {
  site_id: string
  quantity_total: number
  quantity_available: number
}

export type ImageRef = {
  id: string
  url: string
  alt_text: string
  is_primary: boolean
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
  images: ImageRef[]
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

export type QueryResult = {
  items: Furniture[]
  map_features: MapFeature[]
  total: number
  applied_query: string | null
  applied_filters: Record<string, string | boolean>
  answer: string | null
}

export type CatalogMetadata = {
  categories: Category[]
  sites: Site[]
}

export type AgentStatus = {
  mode: string
  provider: string
  model: string
  base_url: string
  configured: boolean
}
