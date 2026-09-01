from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

import backend.infrastructure.database as database_module


def test_legacy_sqlite_inventory_schema_is_upgraded_without_losing_history(
    tmp_path: Path,
) -> None:
    engine = create_engine(f"sqlite:///{(tmp_path / 'legacy.db').as_posix()}")
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE sites (
                    id VARCHAR(36) PRIMARY KEY,
                    code VARCHAR(24) NOT NULL,
                    name VARCHAR(120) NOT NULL,
                    city VARCHAR(80) NOT NULL,
                    latitude FLOAT NOT NULL,
                    longitude FLOAT NOT NULL
                )
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE TABLE inventory (
                    id VARCHAR(36) PRIMARY KEY,
                    furniture_id VARCHAR(36) NOT NULL,
                    site_id VARCHAR(36) NOT NULL,
                    quantity_total INTEGER NOT NULL,
                    quantity_available INTEGER NOT NULL
                )
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE TABLE inventory_adjustments (
                    id VARCHAR(36) PRIMARY KEY,
                    inventory_id VARCHAR(36) NOT NULL,
                    delta INTEGER NOT NULL,
                    reason VARCHAR(240) NOT NULL,
                    actor VARCHAR(120) NOT NULL,
                    created_at DATETIME NOT NULL
                )
                """
            )
        )
        connection.execute(
            text(
                """
                INSERT INTO inventory
                    (id, furniture_id, site_id, quantity_total, quantity_available)
                VALUES ('inv-1', 'furniture-1', 'site-1', 10, 8)
                """
            )
        )
        connection.execute(
            text(
                """
                INSERT INTO inventory_adjustments
                    (id, inventory_id, delta, reason, actor, created_at)
                VALUES
                    ('adj-1', 'inv-1', 3, 'legacy add', 'admin', '2026-01-01T00:00:00'),
                    ('adj-2', 'inv-1', -1, 'legacy remove', 'admin', '2026-01-02T00:00:00')
                """
            )
        )

    migrate = getattr(database_module, "upgrade_local_sqlite_schema", None)
    assert migrate is not None, "local SQLite upgrade function is missing"
    migrate(engine)

    inventory_columns = {column["name"] for column in inspect(engine).get_columns("inventory")}
    site_columns = {column["name"] for column in inspect(engine).get_columns("sites")}
    adjustment_columns = {
        column["name"] for column in inspect(engine).get_columns("inventory_adjustments")
    }
    assert "version" in inventory_columns
    assert {"status", "closed_at", "closed_reason"} <= inventory_columns
    assert {"is_active", "version", "created_at", "updated_at"} <= site_columns
    assert inspect(engine).has_table("transfer_records")
    assert {
        "kind",
        "delta_total",
        "delta_available",
        "quantity_total_before",
        "quantity_total_after",
        "quantity_available_before",
        "quantity_available_after",
        "transfer_id",
    } <= adjustment_columns

    with engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT id, kind, delta_total, delta_available,
                       quantity_total_before, quantity_total_after,
                       quantity_available_before, quantity_available_after
                FROM inventory_adjustments
                ORDER BY created_at
                """
            )
        ).mappings().all()
        assert [dict(row) for row in rows] == [
            {
                "id": "adj-1",
                "kind": "legacy_correction",
                "delta_total": 3,
                "delta_available": 3,
                "quantity_total_before": 8,
                "quantity_total_after": 11,
                "quantity_available_before": 6,
                "quantity_available_after": 9,
            },
            {
                "id": "adj-2",
                "kind": "legacy_correction",
                "delta_total": -1,
                "delta_available": -1,
                "quantity_total_before": 11,
                "quantity_total_after": 10,
                "quantity_available_before": 9,
                "quantity_available_after": 8,
            },
        ]

    with pytest.raises(IntegrityError):
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO inventory
                        (id, furniture_id, site_id, quantity_total, quantity_available)
                    VALUES ('inv-duplicate', 'furniture-1', 'site-1', 1, 1)
                    """
                )
            )

    engine.dispose()
