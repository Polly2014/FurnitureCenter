from sqlalchemy import Select, or_, select
from sqlalchemy.orm import Session, selectinload

from backend.application.catalog import QueryFilters
from backend.domain.catalog import (
    Furniture,
    FurnitureCondition,
    ImageRef,
    InventoryPosition,
    Site,
)
from backend.infrastructure.models import FurnitureRecord, InventoryRecord


class SqlAlchemyCatalogRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def search(
        self,
        *,
        query: str | None,
        filters: QueryFilters,
        limit: int,
    ) -> list[Furniture]:
        statement: Select[tuple[FurnitureRecord]] = select(FurnitureRecord).options(
            selectinload(FurnitureRecord.category),
            selectinload(FurnitureRecord.images),
            selectinload(FurnitureRecord.inventory).selectinload(InventoryRecord.site),
        )
        if query:
            pattern = f"%{query}%"
            statement = statement.where(
                or_(
                    FurnitureRecord.name.ilike(pattern),
                    FurnitureRecord.name_en.ilike(pattern),
                    FurnitureRecord.description.ilike(pattern),
                    FurnitureRecord.sku.ilike(pattern),
                    FurnitureRecord.brand.ilike(pattern),
                    FurnitureRecord.color.ilike(pattern),
                    FurnitureRecord.material.ilike(pattern),
                )
            )
        if filters.category:
            statement = statement.where(FurnitureRecord.category.has(name=filters.category))
        if filters.site_id:
            statement = statement.where(
                FurnitureRecord.inventory.any(InventoryRecord.site_id == filters.site_id)
            )
        if filters.available_only:
            statement = statement.where(
                FurnitureRecord.inventory.any(InventoryRecord.quantity_available > 0)
            )

        records = self._session.scalars(statement.order_by(FurnitureRecord.name).limit(limit))
        return [self._to_domain(record, filters.site_id) for record in records]

    @staticmethod
    def _to_domain(record: FurnitureRecord, site_id: str | None) -> Furniture:
        inventory = (
            position
            for position in record.inventory
            if site_id is None or position.site_id == site_id
        )
        return Furniture(
            id=record.id,
            sku=record.sku,
            name=record.name,
            category=record.category.name,
            description=record.description,
            condition=FurnitureCondition(record.condition),
            name_en=record.name_en,
            main_category=record.main_category,
            dimensions=record.dimensions,
            color=record.color,
            material=record.material,
            brand=record.brand,
            image_reference=record.image_reference,
            source_workbook=record.source_workbook,
            source_sheet=record.source_sheet,
            source_row=record.source_row,
            images=tuple(
                ImageRef(image.id, image.url, image.alt_text, image.is_primary)
                for image in sorted(record.images, key=lambda image: not image.is_primary)
            ),
            inventory=tuple(
                InventoryPosition(
                    position.id,
                    Site(
                        position.site.id,
                        position.site.code,
                        position.site.name,
                        position.site.city,
                        position.site.latitude,
                        position.site.longitude,
                    ),
                    position.quantity_total,
                    position.quantity_available,
                    position.version,
                )
                for position in inventory
            ),
        )
