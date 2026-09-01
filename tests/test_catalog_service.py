from backend.application.catalog import CatalogService, QueryFilters
from backend.domain.catalog import (
    Furniture,
    FurnitureCondition,
    ImageRef,
    InventoryPosition,
    Site,
)


class InMemoryCatalogRepository:
    def __init__(self, furniture: list[Furniture]) -> None:
        self._furniture = furniture

    def search(
        self,
        *,
        query: str | None,
        filters: QueryFilters,
        limit: int,
    ) -> list[Furniture]:
        matches = self._furniture
        if query:
            needle = query.casefold()
            matches = [
                item
                for item in matches
                if needle in f"{item.name} {item.description} {item.sku}".casefold()
            ]
        if filters.category:
            matches = [item for item in matches if item.category == filters.category]
        if filters.site_id:
            matches = [
                item
                for item in matches
                if any(position.site.id == filters.site_id for position in item.inventory)
            ]
        if filters.available_only:
            matches = [item for item in matches if item.quantity_available > 0]
        return matches[:limit]


def test_search_returns_items_images_and_grouped_map_features() -> None:
    beijing = Site("site-bj", "BJ", "北京园区", "北京", 39.9042, 116.4074)
    chair = Furniture(
        id="f-chair",
        sku="CHR-001",
        name="弧背会议椅",
        category="座椅",
        description="适合会议室与协作空间",
        condition=FurnitureCondition.GOOD,
        dimensions="600*600*750",
        color="黑色",
        material="布艺 / 金属",
        brand="Haworth",
        images=(ImageRef("img-chair", "/media/chair.jpg", "灰色弧背会议椅", True),),
        inventory=(InventoryPosition("lot-chair", beijing, 12, 8),),
    )
    table = Furniture(
        id="f-table",
        sku="TBL-001",
        name="模块化会议桌",
        category="桌台",
        description="六人模块化桌面",
        condition=FurnitureCondition.EXCELLENT,
        inventory=(InventoryPosition("lot-table", beijing, 3, 2),),
    )
    service = CatalogService(InMemoryCatalogRepository([chair, table]))

    result = service.search(query="会议", filters=QueryFilters(available_only=True))

    assert result.total == 2
    assert result.items[0].images[0].is_primary is True
    assert result.items[0].dimensions == "600*600*750"
    assert result.items[0].brand == "Haworth"
    assert result.map_features[0].site_id == "site-bj"
    assert result.map_features[0].quantity_available == 10
    assert result.map_features[0].furniture_ids == ("f-chair", "f-table")


def test_inventory_position_rejects_invalid_available_quantity() -> None:
    site = Site("site-sh", "SH", "上海园区", "上海", 31.2304, 121.4737)

    try:
        InventoryPosition("lot-invalid", site, 2, 3)
    except ValueError as error:
        assert "between zero and quantity_total" in str(error)
    else:
        raise AssertionError("Expected invalid inventory quantity to be rejected")
