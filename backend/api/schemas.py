from pydantic import BaseModel, ConfigDict


class SiteDto(BaseModel):
    id: str
    code: str
    name: str
    city: str
    latitude: float
    longitude: float

    model_config = ConfigDict(from_attributes=True)


class InventoryDto(BaseModel):
    id: str
    site: SiteDto
    quantity_total: int
    quantity_available: int

    model_config = ConfigDict(from_attributes=True)


class ImageDto(BaseModel):
    id: str
    url: str
    alt_text: str
    is_primary: bool

    model_config = ConfigDict(from_attributes=True)


class FurnitureDto(BaseModel):
    id: str
    sku: str
    name: str
    category: str
    description: str
    condition: str
    name_en: str
    main_category: str
    dimensions: str
    color: str
    material: str
    brand: str
    image_reference: str
    source_workbook: str
    source_sheet: str
    source_row: int | None
    quantity_available: int
    images: list[ImageDto]
    inventory: list[InventoryDto]

    model_config = ConfigDict(from_attributes=True)


class MapFeatureDto(BaseModel):
    site_id: str
    site_name: str
    latitude: float
    longitude: float
    quantity_available: int
    furniture_ids: list[str]

    model_config = ConfigDict(from_attributes=True)


class QueryResultDto(BaseModel):
    items: list[FurnitureDto]
    map_features: list[MapFeatureDto]
    total: int
    applied_query: str | None
    applied_filters: dict[str, str | bool]
    answer: str | None

    model_config = ConfigDict(from_attributes=True)


class CategoryDto(BaseModel):
    id: str
    name: str


class CatalogMetadataDto(BaseModel):
    categories: list[CategoryDto]
    sites: list[SiteDto]


class AgentQueryRequest(BaseModel):
    message: str
    session_id: str | None = None


class AgentStatusDto(BaseModel):
    mode: str
    provider: str
    model: str
    base_url: str
    configured: bool


class CreateFurnitureRequest(BaseModel):
    sku: str
    name: str
    category_id: str
    description: str = ""
    condition: str = "good"
    site_id: str
    quantity: int
    image_url: str | None = None
    actor: str = "furniture-center-admin"
    name_en: str = ""
    main_category: str = ""
    dimensions: str = ""
    color: str = ""
    material: str = ""
    brand: str = ""


class UpdateFurnitureRequest(BaseModel):
    name: str
    category_id: str
    description: str = ""
    condition: str = "good"
    image_url: str | None = None
    actor: str = "furniture-center-admin"
    name_en: str = ""
    main_category: str = ""
    dimensions: str = ""
    color: str = ""
    material: str = ""
    brand: str = ""


class InventoryAdjustmentRequest(BaseModel):
    delta: int
    reason: str
    actor: str = "furniture-center-admin"


class InventoryAdjustmentResponse(BaseModel):
    inventory_id: str
    quantity_available: int


class AuditEventDto(BaseModel):
    id: str
    entity_type: str
    entity_id: str
    action: str
    actor: str
    details_json: str
    created_at: str