from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from backend.infrastructure.config import get_settings


class Base(DeclarativeBase):
    pass


def build_engine(database_url: str):
    connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
    return create_engine(database_url, connect_args=connect_args)


engine = build_engine(get_settings().database_url)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def upgrade_local_sqlite_schema(database_engine: Engine) -> None:
    """Upgrade pre-versioned local SQLite databases without discarding catalog data."""
    if database_engine.dialect.name != "sqlite":
        return

    inspector = inspect(database_engine)
    if not inspector.has_table("inventory"):
        return

    inventory_columns = {column["name"] for column in inspector.get_columns("inventory")}
    site_table_exists = inspector.has_table("sites")
    site_columns = (
        {column["name"] for column in inspector.get_columns("sites")}
        if site_table_exists
        else set()
    )
    adjustment_table_exists = inspector.has_table("inventory_adjustments")
    adjustment_columns = (
        {
            column["name"]
            for column in inspector.get_columns("inventory_adjustments")
        }
        if adjustment_table_exists
        else set()
    )
    backfill_legacy_adjustments = (
        adjustment_table_exists and "delta_total" not in adjustment_columns
    )

    with database_engine.begin() as connection:
        if "version" not in inventory_columns:
            connection.execute(
                text("ALTER TABLE inventory ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
            )
        inventory_additions = {
            "status": "VARCHAR(20) NOT NULL DEFAULT 'active'",
            "closed_at": "DATETIME",
            "closed_reason": "VARCHAR(80)",
        }
        added_status = "status" not in inventory_columns
        for column_name, definition in inventory_additions.items():
            if column_name not in inventory_columns:
                connection.execute(
                    text(f"ALTER TABLE inventory ADD COLUMN {column_name} {definition}")
                )
        if added_status:
            connection.execute(
                text(
                    "UPDATE inventory SET status = 'withdrawn', "
                    "closed_at = CURRENT_TIMESTAMP, closed_reason = 'migration' "
                    "WHERE quantity_available <= 0"
                )
            )
        connection.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_furniture_site "
                "ON inventory (furniture_id, site_id)"
            )
        )

        if site_table_exists:
            site_additions = {
                "is_active": "BOOLEAN NOT NULL DEFAULT 1",
                "version": "INTEGER NOT NULL DEFAULT 1",
                "created_at": "DATETIME NOT NULL DEFAULT '1970-01-01T00:00:00Z'",
                "updated_at": "DATETIME NOT NULL DEFAULT '1970-01-01T00:00:00Z'",
            }
            for column_name, definition in site_additions.items():
                if column_name not in site_columns:
                    connection.execute(
                        text(f"ALTER TABLE sites ADD COLUMN {column_name} {definition}")
                    )

        connection.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS transfer_records (
                    id VARCHAR(36) PRIMARY KEY,
                    furniture_id VARCHAR(36) NOT NULL,
                    source_inventory_id VARCHAR(36) NOT NULL,
                    source_site_id VARCHAR(36) NOT NULL,
                    source_site_code_snapshot VARCHAR(50) NOT NULL,
                    source_site_name_snapshot VARCHAR(200) NOT NULL,
                    destination_site_id VARCHAR(36) NOT NULL,
                    destination_site_code_snapshot VARCHAR(50) NOT NULL,
                    destination_site_name_snapshot VARCHAR(200) NOT NULL,
                    listed_quantity_before INTEGER NOT NULL,
                    transferred_quantity INTEGER NOT NULL,
                    unlisted_remainder INTEGER NOT NULL,
                    reason VARCHAR(240) NOT NULL,
                    actor_token_id VARCHAR(120) NOT NULL,
                    actor_label_snapshot VARCHAR(200) NOT NULL,
                    created_at DATETIME NOT NULL,
                    FOREIGN KEY(furniture_id) REFERENCES furniture (id),
                    FOREIGN KEY(source_inventory_id) REFERENCES inventory (id),
                    FOREIGN KEY(source_site_id) REFERENCES sites (id),
                    FOREIGN KEY(destination_site_id) REFERENCES sites (id),
                    CHECK(listed_quantity_before > 0),
                    CHECK(transferred_quantity > 0),
                    CHECK(transferred_quantity <= listed_quantity_before),
                    CHECK(unlisted_remainder = listed_quantity_before - transferred_quantity)
                )
                """
            )
        )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_transfer_records_created "
                "ON transfer_records (created_at DESC, id DESC)"
            )
        )
        connection.execute(
            text(
                """
                CREATE TRIGGER IF NOT EXISTS transfer_records_immutable_update
                BEFORE UPDATE ON transfer_records
                BEGIN
                    SELECT RAISE(ABORT, 'transfer records are immutable');
                END
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE TRIGGER IF NOT EXISTS transfer_records_immutable_delete
                BEFORE DELETE ON transfer_records
                BEGIN
                    SELECT RAISE(ABORT, 'transfer records are immutable');
                END
                """
            )
        )

        if not adjustment_table_exists:
            return

        additions = {
            "kind": "VARCHAR(40) NOT NULL DEFAULT 'legacy_correction'",
            "delta_total": "INTEGER NOT NULL DEFAULT 0",
            "delta_available": "INTEGER NOT NULL DEFAULT 0",
            "quantity_total_before": "INTEGER NOT NULL DEFAULT 0",
            "quantity_total_after": "INTEGER NOT NULL DEFAULT 0",
            "quantity_available_before": "INTEGER NOT NULL DEFAULT 0",
            "quantity_available_after": "INTEGER NOT NULL DEFAULT 0",
            "transfer_id": "VARCHAR(36)",
        }
        for column_name, definition in additions.items():
            if column_name not in adjustment_columns:
                connection.execute(
                    text(
                        f"ALTER TABLE inventory_adjustments "
                        f"ADD COLUMN {column_name} {definition}"
                    )
                )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_inventory_adjustments_transfer_id "
                "ON inventory_adjustments (transfer_id)"
            )
        )

        if not backfill_legacy_adjustments:
            return

        inventory_rows = connection.execute(
            text("SELECT id, quantity_total, quantity_available FROM inventory")
        ).mappings()
        for inventory_row in inventory_rows:
            total_after = int(inventory_row["quantity_total"])
            available_after = int(inventory_row["quantity_available"])
            adjustments = connection.execute(
                text(
                    "SELECT id, delta FROM inventory_adjustments "
                    "WHERE inventory_id = :inventory_id "
                    "ORDER BY created_at DESC, id DESC"
                ),
                {"inventory_id": inventory_row["id"]},
            ).mappings()
            for adjustment in adjustments:
                delta = int(adjustment["delta"])
                total_before = total_after - delta
                available_before = available_after - delta
                connection.execute(
                    text(
                        "UPDATE inventory_adjustments SET "
                        "kind = 'legacy_correction', "
                        "delta_total = :delta, delta_available = :delta, "
                        "quantity_total_before = :total_before, "
                        "quantity_total_after = :total_after, "
                        "quantity_available_before = :available_before, "
                        "quantity_available_after = :available_after "
                        "WHERE id = :adjustment_id"
                    ),
                    {
                        "delta": delta,
                        "total_before": total_before,
                        "total_after": total_after,
                        "available_before": available_before,
                        "available_after": available_after,
                        "adjustment_id": adjustment["id"],
                    },
                )
                total_after = total_before
                available_after = available_before


def get_session() -> Generator[Session, None, None]:
    with SessionLocal() as session:
        yield session
