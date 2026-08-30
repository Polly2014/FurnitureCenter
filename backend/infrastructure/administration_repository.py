import json
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.application.administration import (
    AdjustInventoryCommand,
    CreateFurnitureCommand,
    UpdateFurnitureCommand,
)
from backend.infrastructure.models import (
    AuditEventRecord,
    CategoryRecord,
    FurnitureRecord,
    ImageRecord,
    InventoryAdjustmentRecord,
    InventoryRecord,
    SiteRecord,
)


class EntityNotFoundError(ValueError):
    pass


class DuplicateEntityError(ValueError):
    pass


class SqlAlchemyAdministrationRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def create_furniture(self, command: CreateFurnitureCommand) -> str:
        if self._session.scalar(select(FurnitureRecord.id).where(FurnitureRecord.sku == command.sku)):
            raise DuplicateEntityError(f"SKU already exists: {command.sku}")
        category = self._session.get(CategoryRecord, command.category_id)
        site = self._session.get(SiteRecord, command.site_id)
        if category is None:
            raise EntityNotFoundError(f"Category not found: {command.category_id}")
        if site is None:
            raise EntityNotFoundError(f"Site not found: {command.site_id}")

        furniture_id = str(uuid4())
        record = FurnitureRecord(
            id=furniture_id,
            sku=command.sku.strip(),
            name=command.name.strip(),
            name_en=command.name_en.strip(),
            main_category=command.main_category.strip(),
            category=category,
            description=command.description.strip(),
            condition=command.condition,
            dimensions=command.dimensions.strip(),
            color=command.color.strip(),
            material=command.material.strip(),
            brand=command.brand.strip(),
            images=(
                [
                    ImageRecord(
                        id=str(uuid4()),
                        url=command.image_url.strip(),
                        alt_text=command.name.strip(),
                        is_primary=True,
                    )
                ]
                if command.image_url and command.image_url.strip()
                else []
            ),
            inventory=[
                InventoryRecord(
                    id=str(uuid4()),
                    site=site,
                    quantity_total=command.quantity,
                    quantity_available=command.quantity,
                )
            ],
        )
        self._session.add(record)
        self._audit("furniture", furniture_id, "created", command.actor, {"sku": command.sku})
        self._session.commit()
        return furniture_id

    def update_furniture(self, furniture_id: str, command: UpdateFurnitureCommand) -> None:
        record = self._session.get(FurnitureRecord, furniture_id)
        category = self._session.get(CategoryRecord, command.category_id)
        if record is None:
            raise EntityNotFoundError(f"Furniture not found: {furniture_id}")
        if category is None:
            raise EntityNotFoundError(f"Category not found: {command.category_id}")
        record.name = command.name.strip()
        record.name_en = command.name_en.strip()
        record.main_category = command.main_category.strip()
        record.category = category
        record.description = command.description.strip()
        record.condition = command.condition
        record.dimensions = command.dimensions.strip()
        record.color = command.color.strip()
        record.material = command.material.strip()
        record.brand = command.brand.strip()
        if command.image_url and command.image_url.strip():
            primary = next((image for image in record.images if image.is_primary), None)
            if primary:
                primary.url = command.image_url.strip()
                primary.alt_text = command.name.strip()
            else:
                record.images.append(
                    ImageRecord(
                        id=str(uuid4()),
                        url=command.image_url.strip(),
                        alt_text=command.name.strip(),
                        is_primary=True,
                    )
                )
        self._audit("furniture", furniture_id, "updated", command.actor, {"name": record.name})
        self._session.commit()

    def delete_furniture(self, furniture_id: str, actor: str) -> None:
        record = self._session.get(FurnitureRecord, furniture_id)
        if record is None:
            raise EntityNotFoundError(f"Furniture not found: {furniture_id}")
        self._session.delete(record)
        self._audit("furniture", furniture_id, "deleted", actor, {"sku": record.sku})
        self._session.commit()

    def adjust_inventory(self, command: AdjustInventoryCommand) -> int:
        record = self._session.get(InventoryRecord, command.inventory_id)
        if record is None:
            raise EntityNotFoundError(f"Inventory position not found: {command.inventory_id}")
        new_quantity = record.quantity_available + command.delta
        new_total = record.quantity_total + command.delta
        if new_quantity < 0 or new_total < 0:
            raise ValueError("inventory adjustment would make quantity negative")
        record.quantity_available = new_quantity
        record.quantity_total = new_total
        adjustment = InventoryAdjustmentRecord(
            id=str(uuid4()),
            inventory_id=record.id,
            delta=command.delta,
            reason=command.reason.strip(),
            actor=command.actor,
        )
        self._session.add(adjustment)
        self._audit(
            "inventory",
            record.id,
            "adjusted",
            command.actor,
            {"delta": command.delta, "reason": command.reason, "quantity": new_quantity},
        )
        self._session.commit()
        return new_quantity

    def _audit(
        self,
        entity_type: str,
        entity_id: str,
        action: str,
        actor: str,
        details: dict,
    ) -> None:
        self._session.add(
            AuditEventRecord(
                id=str(uuid4()),
                entity_type=entity_type,
                entity_id=entity_id,
                action=action,
                actor=actor,
                details_json=json.dumps(details, ensure_ascii=False),
            )
        )