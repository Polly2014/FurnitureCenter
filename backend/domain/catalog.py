from dataclasses import dataclass, field
from enum import Enum


class FurnitureCondition(str, Enum):
    EXCELLENT = "excellent"
    GOOD = "good"
    FAIR = "fair"
    REPAIR = "repair"


@dataclass(frozen=True)
class ImageRef:
    id: str
    url: str
    alt_text: str
    is_primary: bool = False


@dataclass(frozen=True)
class Site:
    id: str
    code: str
    name: str
    city: str
    latitude: float
    longitude: float


@dataclass(frozen=True)
class InventoryPosition:
    id: str
    site: Site
    quantity_total: int
    quantity_available: int

    def __post_init__(self) -> None:
        if self.quantity_total < 0:
            raise ValueError("quantity_total cannot be negative")
        if not 0 <= self.quantity_available <= self.quantity_total:
            raise ValueError("quantity_available must be between zero and quantity_total")


@dataclass(frozen=True)
class Furniture:
    id: str
    sku: str
    name: str
    category: str
    description: str
    condition: FurnitureCondition
    name_en: str = ""
    main_category: str = ""
    dimensions: str = ""
    color: str = ""
    material: str = ""
    brand: str = ""
    image_reference: str = ""
    source_workbook: str = ""
    source_sheet: str = ""
    source_row: int | None = None
    images: tuple[ImageRef, ...] = field(default_factory=tuple)
    inventory: tuple[InventoryPosition, ...] = field(default_factory=tuple)

    @property
    def quantity_available(self) -> int:
        return sum(position.quantity_available for position in self.inventory)


@dataclass(frozen=True)
class MapFeature:
    site_id: str
    site_name: str
    latitude: float
    longitude: float
    quantity_available: int
    furniture_ids: tuple[str, ...]


@dataclass(frozen=True)
class QueryResult:
    items: tuple[Furniture, ...]
    map_features: tuple[MapFeature, ...]
    total: int
    applied_query: str | None
    applied_filters: dict[str, str | bool]
    answer: str | None = None