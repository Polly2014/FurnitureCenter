import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from backend.api.main import app
from backend.infrastructure.database import Base, get_session
from backend.infrastructure.models import (
    CategoryRecord,
    FurnitureRecord,
    ImageRecord,
    InventoryRecord,
    SiteRecord,
)

CONTRACT_PATH = Path(__file__).parent / "fixtures" / "catalog-contract.json"


def load_contract() -> dict:
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def seed_contract(session: Session, contract: dict) -> None:
    categories = {
        row["id"]: CategoryRecord(id=row["id"], name=row["name"])
        for row in contract["categories"]
    }
    sites = {
        row["id"]: SiteRecord(**row)
        for row in contract["sites"]
    }
    session.add_all([*categories.values(), *sites.values()])
    for row in contract["furniture"]:
        furniture_fields = {
            key: value
            for key, value in row.items()
            if key not in {"category_id", "images", "inventory"}
        }
        session.add(
            FurnitureRecord(
                **furniture_fields,
                category=categories[row["category_id"]],
                images=[
                    ImageRecord(
                        id=image["id"],
                        url=image["url"],
                        alt_text=image["alt_text"],
                        is_primary=image["is_primary"],
                    )
                    for image in row["images"]
                ],
                inventory=[
                    InventoryRecord(
                        id=position["id"],
                        site=sites[position["site_id"]],
                        quantity_total=position["quantity_total"],
                        quantity_available=position["quantity_available"],
                        version=position["version"],
                    )
                    for position in row["inventory"]
                ],
            )
        )
    session.commit()


@pytest.fixture
def contract_client(tmp_path: Path) -> Iterator[TestClient]:
    contract = load_contract()
    database_path = tmp_path / "catalog-contract.db"
    engine = create_engine(
        f"sqlite:///{database_path.as_posix()}", connect_args={"check_same_thread": False}
    )
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    Base.metadata.create_all(engine)
    with session_factory() as session:
        seed_contract(session, contract)

    def override_session() -> Iterator[Session]:
        with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def normalize_result(payload: dict) -> dict:
    return {
        "item_ids": [item["id"] for item in payload["items"]],
        "inventory": {
            item["id"]: sorted(
                [
                    position["site"]["id"],
                    position["quantity_total"],
                    position["quantity_available"],
                    position["version"],
                ]
                for position in item["inventory"]
            )
            for item in payload["items"]
        },
        "map": {
            feature["site_id"]: [
                feature["quantity_available"],
                feature["furniture_ids"],
            ]
            for feature in sorted(payload["map_features"], key=lambda row: row["site_id"])
        },
        "applied_query": payload["applied_query"],
        "applied_filters": payload["applied_filters"],
    }


def test_python_catalog_matches_the_shared_adapter_contract(contract_client: TestClient) -> None:
    contract = load_contract()

    for case in contract["cases"]:
        response = contract_client.get("/api/catalog/furniture", params=case["params"])

        assert response.status_code == 200, case["name"]
        payload = response.json()
        assert normalize_result(payload) == case["expected"], case["name"]
        assert payload["total"] == len(payload["items"])
        assert payload["answer"] is None


def test_python_metadata_matches_the_shared_adapter_contract(contract_client: TestClient) -> None:
    contract = load_contract()

    response = contract_client.get("/api/catalog/metadata")

    assert response.status_code == 200
    payload = response.json()
    assert payload["categories"] == sorted(contract["categories"], key=lambda row: row["name"])
    assert payload["sites"] == sorted(contract["sites"], key=lambda row: row["name"])
