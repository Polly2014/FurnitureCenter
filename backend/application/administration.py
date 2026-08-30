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
    delta: int
    reason: str
    actor: str


class AdministrationRepository(Protocol):
    def create_furniture(self, command: CreateFurnitureCommand) -> str: ...

    def update_furniture(self, furniture_id: str, command: UpdateFurnitureCommand) -> None: ...

    def delete_furniture(self, furniture_id: str, actor: str) -> None: ...

    def adjust_inventory(self, command: AdjustInventoryCommand) -> int: ...


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

    def adjust_inventory(self, command: AdjustInventoryCommand) -> int:
        if command.delta == 0:
            raise ValueError("inventory adjustment delta cannot be zero")
        if not command.reason.strip():
            raise ValueError("inventory adjustment reason is required")
        return self._repository.adjust_inventory(command)