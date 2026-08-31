import json
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from backend.application.administration import (
    AdjustInventoryCommand,
    CreateFurnitureCommand,
    CreateInventoryPositionCommand,
    InventorySnapshot,
    InventoryTransferResult,
    TransferInventoryCommand,
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


class ConcurrentModificationError(ValueError):
    pass


class SqlAlchemyAdministrationRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def create_furniture(self, command: CreateFurnitureCommand) -> str:
        if self._session.scalar(
            select(FurnitureRecord.id).where(FurnitureRecord.sku == command.sku)
        ):
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

    def create_inventory_position(
        self, command: CreateInventoryPositionCommand
    ) -> InventorySnapshot:
        furniture = self._session.get(FurnitureRecord, command.furniture_id)
        site = self._session.get(SiteRecord, command.site_id)
        if furniture is None:
            raise EntityNotFoundError(f"Furniture not found: {command.furniture_id}")
        if site is None:
            raise EntityNotFoundError(f"Site not found: {command.site_id}")
        existing = self._session.scalar(
            select(InventoryRecord.id).where(
                InventoryRecord.furniture_id == command.furniture_id,
                InventoryRecord.site_id == command.site_id,
            )
        )
        if existing is not None:
            raise DuplicateEntityError("inventory position already exists for this site")

        record = InventoryRecord(
            id=str(uuid4()),
            furniture=furniture,
            site=site,
            quantity_total=command.quantity_total,
            quantity_available=command.quantity_available,
        )
        self._session.add(record)
        self._audit(
            "inventory",
            record.id,
            "created",
            command.actor,
            {
                "furniture_id": command.furniture_id,
                "site_id": command.site_id,
                "quantity_total": command.quantity_total,
                "quantity_available": command.quantity_available,
            },
        )
        try:
            self._session.commit()
        except IntegrityError as error:
            self._session.rollback()
            raise DuplicateEntityError(
                "inventory position already exists for this site"
            ) from error
        return self._snapshot(record)

    def adjust_inventory(self, command: AdjustInventoryCommand) -> InventorySnapshot:
        record = self._session.get(InventoryRecord, command.inventory_id)
        if record is None:
            raise EntityNotFoundError(f"Inventory position not found: {command.inventory_id}")
        if command.expected_version is not None and record.version != command.expected_version:
            raise ConcurrentModificationError("inventory position changed; refresh and retry")

        total_before = record.quantity_total
        available_before = record.quantity_available
        total_after = total_before + command.delta_total
        available_after = available_before + command.delta_available
        if total_after < 0:
            raise ValueError("inventory adjustment would make total quantity negative")
        if not 0 <= available_after <= total_after:
            raise ValueError("available quantity must remain between zero and total")
        record.quantity_total = total_after
        record.quantity_available = available_after
        adjustment = InventoryAdjustmentRecord(
            id=str(uuid4()),
            inventory_id=record.id,
            delta=(
                command.delta_total
                if command.delta_total == command.delta_available
                else 0
            ),
            kind=command.kind.strip(),
            delta_total=command.delta_total,
            delta_available=command.delta_available,
            quantity_total_before=total_before,
            quantity_total_after=total_after,
            quantity_available_before=available_before,
            quantity_available_after=available_after,
            transfer_id=None,
            reason=command.reason.strip(),
            actor=command.actor,
        )
        self._session.add(adjustment)
        self._audit(
            "inventory",
            record.id,
            "adjusted",
            command.actor,
            {
                "kind": command.kind,
                "delta_total": command.delta_total,
                "delta_available": command.delta_available,
                "reason": command.reason,
                "quantity_total": total_after,
                "quantity_available": available_after,
            },
        )
        try:
            self._session.commit()
        except StaleDataError as error:
            self._session.rollback()
            raise ConcurrentModificationError(
                "inventory position changed; refresh and retry"
            ) from error
        return self._snapshot(record)

    def transfer_inventory(self, command: TransferInventoryCommand) -> InventoryTransferResult:
        source = self._session.get(InventoryRecord, command.source_inventory_id)
        destination_site = self._session.get(SiteRecord, command.destination_site_id)
        if source is None:
            raise EntityNotFoundError(
                f"Inventory position not found: {command.source_inventory_id}"
            )
        if destination_site is None:
            raise EntityNotFoundError(f"Site not found: {command.destination_site_id}")
        if source.site_id == command.destination_site_id:
            raise ValueError("source and destination sites must be different")
        if source.version != command.expected_source_version:
            raise ConcurrentModificationError("inventory position changed; refresh and retry")
        if source.quantity_total < command.quantity or source.quantity_available < command.quantity:
            raise ValueError("transfer quantity exceeds available physical stock")

        destination = self._session.scalar(
            select(InventoryRecord).where(
                InventoryRecord.furniture_id == source.furniture_id,
                InventoryRecord.site_id == command.destination_site_id,
            )
        )
        if destination is not None:
            if (
                command.expected_destination_version is not None
                and destination.version != command.expected_destination_version
            ):
                raise ConcurrentModificationError("inventory position changed; refresh and retry")
        elif command.expected_destination_version is not None:
            raise ConcurrentModificationError(
                "destination inventory position changed; refresh and retry"
            )
        else:
            destination = InventoryRecord(
                id=str(uuid4()),
                furniture_id=source.furniture_id,
                site=destination_site,
                quantity_total=0,
                quantity_available=0,
            )
            self._session.add(destination)

        source_total_before = source.quantity_total
        source_available_before = source.quantity_available
        destination_total_before = destination.quantity_total
        destination_available_before = destination.quantity_available

        source.quantity_total -= command.quantity
        source.quantity_available -= command.quantity
        destination.quantity_total += command.quantity
        destination.quantity_available += command.quantity

        transfer_id = str(uuid4())
        self._session.add_all(
            [
                InventoryAdjustmentRecord(
                    id=str(uuid4()),
                    inventory_id=source.id,
                    delta=-command.quantity,
                    kind="transfer_out",
                    delta_total=-command.quantity,
                    delta_available=-command.quantity,
                    quantity_total_before=source_total_before,
                    quantity_total_after=source.quantity_total,
                    quantity_available_before=source_available_before,
                    quantity_available_after=source.quantity_available,
                    transfer_id=transfer_id,
                    reason=command.reason.strip(),
                    actor=command.actor,
                ),
                InventoryAdjustmentRecord(
                    id=str(uuid4()),
                    inventory_id=destination.id,
                    delta=command.quantity,
                    kind="transfer_in",
                    delta_total=command.quantity,
                    delta_available=command.quantity,
                    quantity_total_before=destination_total_before,
                    quantity_total_after=destination.quantity_total,
                    quantity_available_before=destination_available_before,
                    quantity_available_after=destination.quantity_available,
                    transfer_id=transfer_id,
                    reason=command.reason.strip(),
                    actor=command.actor,
                ),
            ]
        )
        self._audit(
            "inventory_transfer",
            transfer_id,
            "created",
            command.actor,
            {
                "source_inventory_id": source.id,
                "destination_inventory_id": destination.id,
                "quantity": command.quantity,
                "reason": command.reason,
            },
        )
        try:
            self._session.commit()
        except (IntegrityError, StaleDataError) as error:
            self._session.rollback()
            raise ConcurrentModificationError(
                "inventory position changed; refresh and retry"
            ) from error

        return InventoryTransferResult(
            transfer_id=transfer_id,
            source=self._snapshot(source),
            destination=self._snapshot(destination),
        )

    @staticmethod
    def _snapshot(record: InventoryRecord) -> InventorySnapshot:
        return InventorySnapshot(
            inventory_id=record.id,
            quantity_total=record.quantity_total,
            quantity_available=record.quantity_available,
            version=record.version,
        )

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
