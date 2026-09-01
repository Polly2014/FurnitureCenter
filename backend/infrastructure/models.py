from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
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
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    __mapper_args__ = {"version_id_col": version}


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
        UniqueConstraint("furniture_id", "site_id", name="uq_inventory_furniture_site"),
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
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_reason: Mapped[str | None] = mapped_column(String(80), nullable=True)

    __mapper_args__ = {"version_id_col": version}

    furniture: Mapped[FurnitureRecord] = relationship(back_populates="inventory")
    site: Mapped[SiteRecord] = relationship()


class InventoryAdjustmentRecord(Base):
    __tablename__ = "inventory_adjustments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    inventory_id: Mapped[str] = mapped_column(ForeignKey("inventory.id"), index=True)
    delta: Mapped[int] = mapped_column(Integer, default=0)
    kind: Mapped[str] = mapped_column(String(40))
    delta_total: Mapped[int] = mapped_column(Integer)
    delta_available: Mapped[int] = mapped_column(Integer)
    quantity_total_before: Mapped[int] = mapped_column(Integer)
    quantity_total_after: Mapped[int] = mapped_column(Integer)
    quantity_available_before: Mapped[int] = mapped_column(Integer)
    quantity_available_after: Mapped[int] = mapped_column(Integer)
    transfer_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    reason: Mapped[str] = mapped_column(String(240))
    actor: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class TransferRecord(Base):
    __tablename__ = "transfer_records"
    __table_args__ = (
        CheckConstraint("listed_quantity_before > 0", name="ck_transfer_listed_positive"),
        CheckConstraint("transferred_quantity > 0", name="ck_transfer_quantity_positive"),
        CheckConstraint(
            "transferred_quantity <= listed_quantity_before",
            name="ck_transfer_quantity_within_listing",
        ),
        CheckConstraint(
            "unlisted_remainder = listed_quantity_before - transferred_quantity",
            name="ck_transfer_remainder",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    furniture_id: Mapped[str] = mapped_column(ForeignKey("furniture.id"), index=True)
    source_inventory_id: Mapped[str] = mapped_column(ForeignKey("inventory.id"), index=True)
    source_site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    source_site_code_snapshot: Mapped[str] = mapped_column(String(50))
    source_site_name_snapshot: Mapped[str] = mapped_column(String(200))
    destination_site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    destination_site_code_snapshot: Mapped[str] = mapped_column(String(50))
    destination_site_name_snapshot: Mapped[str] = mapped_column(String(200))
    listed_quantity_before: Mapped[int] = mapped_column(Integer)
    transferred_quantity: Mapped[int] = mapped_column(Integer)
    unlisted_remainder: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(240))
    actor_token_id: Mapped[str] = mapped_column(String(120))
    actor_label_snapshot: Mapped[str] = mapped_column(String(200))
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
