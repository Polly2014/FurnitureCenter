from datetime import datetime, timezone

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.infrastructure.database import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class CategoryRecord(Base):
    __tablename__ = "categories"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True, index=True)


class SiteRecord(Base):
    __tablename__ = "sites"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    code: Mapped[str] = mapped_column(String(24), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    city: Mapped[str] = mapped_column(String(80))
    latitude: Mapped[float]
    longitude: Mapped[float]


class FurnitureRecord(Base):
    __tablename__ = "furniture"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    sku: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    name_en: Mapped[str] = mapped_column(String(160), default="")
    main_category: Mapped[str] = mapped_column(String(100), default="", index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    condition: Mapped[str] = mapped_column(String(24))
    dimensions: Mapped[str] = mapped_column(String(80), default="")
    color: Mapped[str] = mapped_column(String(80), default="")
    material: Mapped[str] = mapped_column(String(120), default="")
    brand: Mapped[str] = mapped_column(String(100), default="")
    image_reference: Mapped[str] = mapped_column(Text, default="")
    source_workbook: Mapped[str] = mapped_column(String(255), default="")
    source_sheet: Mapped[str] = mapped_column(String(100), default="")
    source_row: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_metadata: Mapped[str] = mapped_column(Text, default="{}")
    category_id: Mapped[str] = mapped_column(ForeignKey("categories.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    category: Mapped[CategoryRecord] = relationship()
    images: Mapped[list["ImageRecord"]] = relationship(
        back_populates="furniture", cascade="all, delete-orphan"
    )
    inventory: Mapped[list["InventoryRecord"]] = relationship(
        back_populates="furniture", cascade="all, delete-orphan"
    )


class ImageRecord(Base):
    __tablename__ = "furniture_images"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    furniture_id: Mapped[str] = mapped_column(ForeignKey("furniture.id"), index=True)
    url: Mapped[str] = mapped_column(Text)
    alt_text: Mapped[str] = mapped_column(String(240))
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)

    furniture: Mapped[FurnitureRecord] = relationship(back_populates="images")


class InventoryRecord(Base):
    __tablename__ = "inventory"
    __table_args__ = (
        CheckConstraint("quantity_total >= 0", name="ck_inventory_total_nonnegative"),
        CheckConstraint("quantity_available >= 0", name="ck_inventory_available_nonnegative"),
        CheckConstraint(
            "quantity_available <= quantity_total", name="ck_inventory_available_within_total"
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    furniture_id: Mapped[str] = mapped_column(ForeignKey("furniture.id"), index=True)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    quantity_total: Mapped[int] = mapped_column(Integer)
    quantity_available: Mapped[int] = mapped_column(Integer)

    furniture: Mapped[FurnitureRecord] = relationship(back_populates="inventory")
    site: Mapped[SiteRecord] = relationship()


class InventoryAdjustmentRecord(Base):
    __tablename__ = "inventory_adjustments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    inventory_id: Mapped[str] = mapped_column(ForeignKey("inventory.id"), index=True)
    delta: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(240))
    actor: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class AuditEventRecord(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(60), index=True)
    entity_id: Mapped[str] = mapped_column(String(36), index=True)
    action: Mapped[str] = mapped_column(String(40))
    actor: Mapped[str] = mapped_column(String(120))
    details_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)