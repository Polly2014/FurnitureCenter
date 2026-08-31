from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from backend.api.main import app
from backend.infrastructure.database import Base, get_session
from backend.infrastructure.models import InventoryAdjustmentRecord, InventoryRecord
from backend.infrastructure.seed import seed_demo_data


@pytest.fixture
def inventory_client(tmp_path: Path) -> Iterator[tuple[TestClient, sessionmaker[Session]]]:
    database_path = tmp_path / "inventory-test.db"
    engine = create_engine(
        f"sqlite:///{database_path.as_posix()}", connect_args={"check_same_thread": False}
    )
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    Base.metadata.create_all(engine)
    with session_factory() as session:
        seed_demo_data(session)

    def override_session() -> Iterator[Session]:
        with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    try:
        with TestClient(app) as client:
            yield client, session_factory
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def test_adjustment_changes_availability_without_changing_physical_total(
    inventory_client: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, _ = inventory_client

    response = client.post(
        "/api/admin/inventory/inventory-arc-bj/adjustments",
        json={
            "kind": "loan",
            "delta_total": 0,
            "delta_available": -2,
            "reason": "借给三层会议室",
            "expected_version": 1,
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "inventory_id": "inventory-arc-bj",
        "quantity_total": 18,
        "quantity_available": 10,
        "version": 2,
    }


def test_adjustment_rejects_a_stale_inventory_version(
    inventory_client: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, _ = inventory_client
    first = client.post(
        "/api/admin/inventory/inventory-arc-bj/adjustments",
        json={
            "kind": "loan",
            "delta_total": 0,
            "delta_available": -1,
            "reason": "首次借出",
            "expected_version": 1,
        },
    )
    assert first.status_code == 200

    stale = client.post(
        "/api/admin/inventory/inventory-arc-bj/adjustments",
        json={
            "kind": "loan",
            "delta_total": 0,
            "delta_available": -1,
            "reason": "使用过期页面再次借出",
            "expected_version": 1,
        },
    )

    assert stale.status_code == 409
    assert stale.json()["detail"] == "inventory position changed; refresh and retry"


def test_furniture_cannot_have_duplicate_inventory_positions_for_one_site(
    inventory_client: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, _ = inventory_client

    response = client.post(
        "/api/admin/furniture/furniture-arc-chair/inventory",
        json={
            "site_id": "site-beijing",
            "quantity_total": 3,
            "quantity_available": 3,
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "inventory position already exists for this site"


def test_transfer_atomically_moves_available_physical_stock_between_sites(
    inventory_client: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, session_factory = inventory_client

    response = client.post(
        "/api/admin/inventory/inventory-arc-bj/transfers",
        json={
            "destination_site_id": "site-shanghai",
            "quantity": 2,
            "reason": "上海培训活动调拨",
            "expected_source_version": 1,
            "expected_destination_version": 1,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["source"] == {
        "inventory_id": "inventory-arc-bj",
        "quantity_total": 16,
        "quantity_available": 10,
        "version": 2,
    }
    assert payload["destination"] == {
        "inventory_id": "inventory-arc-sh",
        "quantity_total": 10,
        "quantity_available": 6,
        "version": 2,
    }

    with session_factory() as session:
        adjustments = list(
            session.scalars(
                select(InventoryAdjustmentRecord).order_by(InventoryAdjustmentRecord.created_at)
            )
        )
        assert len(adjustments) == 2
        assert {adjustment.kind for adjustment in adjustments} == {
            "transfer_out",
            "transfer_in",
        }
        assert len({adjustment.transfer_id for adjustment in adjustments}) == 1
        assert adjustments[0].transfer_id == payload["transfer_id"]


def test_failed_transfer_rolls_back_both_inventory_positions(
    inventory_client: tuple[TestClient, sessionmaker[Session]],
) -> None:
    client, session_factory = inventory_client

    response = client.post(
        "/api/admin/inventory/inventory-arc-bj/transfers",
        json={
            "destination_site_id": "site-shanghai",
            "quantity": 13,
            "reason": "超过北京可用库存",
            "expected_source_version": 1,
            "expected_destination_version": 1,
        },
    )

    assert response.status_code == 422
    with session_factory() as session:
        beijing = session.get(InventoryRecord, "inventory-arc-bj")
        shanghai = session.get(InventoryRecord, "inventory-arc-sh")
        assert beijing is not None
        assert shanghai is not None
        assert (beijing.quantity_total, beijing.quantity_available, beijing.version) == (18, 12, 1)
        assert (shanghai.quantity_total, shanghai.quantity_available, shanghai.version) == (8, 4, 1)
        assert session.scalar(select(InventoryAdjustmentRecord)) is None
