from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class CreateFurnitureCommand:
    sku: str
    name: str
    category_id: str
    description: str
    condition: str
    site_id: str
    quantity: int
    image_url: str | None
    actor: str
    name_en: str = ""
    main_category: str = ""
    dimensions: str = ""
    color: str = ""
    material: str = ""
    brand: str = ""


@dataclass(frozen=True)
class UpdateFurnitureCommand:
    name: str
    category_id: str
    description: str
    condition: str
    image_url: str | None
    actor: str
    name_en: str = ""
    main_category: str = ""
    dimensions: str = ""
    color: str = ""
    material: str = ""
    brand: str = ""


@dataclass(frozen=True)
class AdjustInventoryCommand:
    inventory_id: str
    delta_total: int
    delta_available: int
    kind: str
    reason: str
    actor: str
    expected_version: int | None


@dataclass(frozen=True)
class CreateInventoryPositionCommand:
    furniture_id: str
    site_id: str
    quantity_total: int
    quantity_available: int
    actor: str


@dataclass(frozen=True)
class TransferInventoryCommand:
    source_inventory_id: str
    destination_site_id: str
    quantity: int
    reason: str
    actor: str
    expected_source_version: int
    expected_destination_version: int | None


@dataclass(frozen=True)
class InventorySnapshot:
    inventory_id: str
    quantity_total: int
    quantity_available: int
    version: int


@dataclass(frozen=True)
class InventoryTransferResult:
    transfer_id: str
    source: InventorySnapshot
    destination: InventorySnapshot


class AdministrationRepository(Protocol):
    def create_furniture(self, command: CreateFurnitureCommand) -> str: ...

    def update_furniture(self, furniture_id: str, command: UpdateFurnitureCommand) -> None: ...

    def delete_furniture(self, furniture_id: str, actor: str) -> None: ...

    def create_inventory_position(
        self, command: CreateInventoryPositionCommand
    ) -> InventorySnapshot: ...

    def adjust_inventory(self, command: AdjustInventoryCommand) -> InventorySnapshot: ...

    def transfer_inventory(self, command: TransferInventoryCommand) -> InventoryTransferResult: ...


class AdministrationService:
    def __init__(self, repository: AdministrationRepository) -> None:
        self._repository = repository

    def create_furniture(self, command: CreateFurnitureCommand) -> str:
        if command.quantity < 0:
            raise ValueError("initial quantity cannot be negative")
        if not command.sku.strip() or not command.name.strip():
            raise ValueError("SKU and name are required")
        return self._repository.create_furniture(command)

    def update_furniture(self, furniture_id: str, command: UpdateFurnitureCommand) -> None:
        if not command.name.strip():
            raise ValueError("name is required")
        self._repository.update_furniture(furniture_id, command)

    def delete_furniture(self, furniture_id: str, actor: str) -> None:
        self._repository.delete_furniture(furniture_id, actor)

    def create_inventory_position(
        self, command: CreateInventoryPositionCommand
    ) -> InventorySnapshot:
        if command.quantity_total < 0:
            raise ValueError("inventory total cannot be negative")
        if not 0 <= command.quantity_available <= command.quantity_total:
            raise ValueError("available quantity must be between zero and total")
        return self._repository.create_inventory_position(command)

    def adjust_inventory(self, command: AdjustInventoryCommand) -> InventorySnapshot:
        if command.delta_total == 0 and command.delta_available == 0:
            raise ValueError("inventory adjustment cannot leave both quantities unchanged")
        if not command.kind.strip():
            raise ValueError("inventory adjustment kind is required")
        if not command.reason.strip():
            raise ValueError("inventory adjustment reason is required")
        return self._repository.adjust_inventory(command)

    def transfer_inventory(self, command: TransferInventoryCommand) -> InventoryTransferResult:
        if command.quantity <= 0:
            raise ValueError("transfer quantity must be positive")
        if not command.reason.strip():
            raise ValueError("inventory transfer reason is required")
        if command.expected_source_version < 1:
            raise ValueError("expected source version must be positive")
        if (
            command.expected_destination_version is not None
            and command.expected_destination_version < 1
        ):
            raise ValueError("expected destination version must be positive")
        return self._repository.transfer_inventory(command)
