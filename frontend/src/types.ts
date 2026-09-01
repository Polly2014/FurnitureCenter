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

export type ManagedSite = Site & {
  is_active: boolean
  version: number
  created_at: string
  updated_at: string
}

export type CreateSiteInput = {
  code: string
  name: string
  city: string
  latitude: number
  longitude: number
  is_active: boolean
}

export type UpdateSiteInput = Partial<CreateSiteInput> & {
  expected_version: number
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
}

export type TransferRecord = {
  id: string
  furniture_id: string
  furniture_sku: string
  furniture_name: string
  source_inventory_id: string
  source_site_id: string
  source_site_code_snapshot: string
  source_site_name_snapshot: string
  destination_site_id: string
  destination_site_code_snapshot: string
  destination_site_name_snapshot: string
  listed_quantity_before: number
  transferred_quantity: number
  unlisted_remainder: number
  reason: string
  actor_token_id: string
  actor_label_snapshot: string
  created_at: string
}

export type TransferFilters = {
  furniture_id?: string
  source_site_id?: string
  destination_site_id?: string
  from?: string
  to?: string
  limit?: number
  cursor?: string
}

export type TransferPage = {
  items: TransferRecord[]
  next_cursor: string | null
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

export type ImageUploadInput = {
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

export type AuthSession = {
  role: 'viewer' | 'admin'
  label: string
  expires_at: string
}
