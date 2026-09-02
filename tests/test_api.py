import json
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.api.main import app
from backend.api.main import settings as app_settings
from backend.infrastructure.database import Base, get_session
from backend.infrastructure.database import engine as app_engine
from backend.infrastructure.seed import seed_demo_data


def test_app_lifespan_disposes_the_shared_engine() -> None:
    with TestClient(app):
        active_pool = app_engine.pool

    try:
        assert app_engine.pool is not active_pool
    finally:
        app_engine.dispose()


def test_catalog_api_returns_seeded_spatial_result(tmp_path: Path) -> None:
    database_path = tmp_path / "furniture-center-test.db"
    engine = create_engine(
        f"sqlite:///{database_path.as_posix()}", connect_args={"check_same_thread": False}
    )
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    Base.metadata.create_all(engine)
    with session_factory() as session:
        seed_demo_data(session)

    def override_session():
        with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    original_agent_mode = app_settings.agent_mode
    try:
        with TestClient(app) as client:
            agent_status = client.get("/api/agent/status")
            assert agent_status.status_code == 200
            assert agent_status.json() == {
                "mode": app_settings.agent_mode,
                "provider": "CopilotX",
                "model": app_settings.openai_model,
                "base_url": app_settings.openai_base_url,
                "configured": bool(app_settings.openai_api_key),
            }
            response = client.get("/api/catalog/furniture", params={"category": "座椅"})
            assert response.status_code == 200
            payload = response.json()
            assert payload["total"] == 2
            assert payload["items"][0]["images"][0]["url"].startswith(
                "https://images.unsplash.com/"
            )
            assert {feature["site_name"] for feature in payload["map_features"]} == {
                "北京园区",
                "上海园区",
                "深圳园区",
            }

            metadata = client.get("/api/catalog/metadata").json()
            created = client.post(
                "/api/admin/furniture",
                json={
                    "sku": "CHR-NEW-01",
                    "name": "可堆叠访客椅",
                    "category_id": "category-seating",
                    "description": "适合培训和访客区域",
                    "condition": "excellent",
                    "site_id": metadata["sites"][0]["id"],
                    "quantity": 6,
                    "image_url": "https://images.unsplash.com/photo-1549497538-303791108f95",
                },
            )
            assert created.status_code == 201

            new_item = client.get("/api/catalog/furniture", params={"query": "可堆叠"}).json()[
                "items"
            ][0]
            inventory_id = new_item["inventory"][0]["id"]
            adjusted = client.post(
                f"/api/admin/inventory/{inventory_id}/adjustments",
                json={"delta": -2, "reason": "现场盘点修正"},
            )
            assert adjusted.json()["quantity_available"] == 4

            rejected = client.post(
                f"/api/admin/inventory/{inventory_id}/adjustments",
                json={"delta": -10, "reason": "错误修正"},
            )
            assert rejected.status_code == 422

            furniture_id = created.json()["id"]
            updated = client.put(
                f"/api/admin/furniture/{furniture_id}",
                json={
                    "name": "可堆叠培训椅",
                    "category_id": "category-seating",
                    "description": "适合培训区域",
                    "condition": "good",
                    "image_url": "https://images.unsplash.com/photo-1549497538-303791108f95",
                },
            )
            assert updated.status_code == 204
            assert (
                client.get("/api/catalog/furniture", params={"query": "培训椅"}).json()["total"]
                == 1
            )

            deleted = client.delete(f"/api/admin/furniture/{furniture_id}")
            assert deleted.status_code == 204
            assert (
                client.get("/api/catalog/furniture", params={"query": "培训椅"}).json()["total"]
                == 0
            )
            assert len(client.get("/api/admin/audit").json()) == 4

            app_settings.agent_mode = "rules"
            with client.stream(
                "POST",
                "/api/agent/query/stream",
                json={"message": "北京有哪些会议椅？"},
            ) as stream_response:
                assert stream_response.status_code == 200
                stream_body = "\n".join(stream_response.iter_lines())
            event_order = [
                stream_body.index("event: status"),
                stream_body.index("event: result"),
                stream_body.index("event: text_delta"),
                stream_body.index("event: done"),
            ]
            assert event_order == sorted(event_order)
            stream_lines = stream_body.splitlines()
            result_event_index = stream_lines.index("event: result")
            result_payload = json.loads(stream_lines[result_event_index + 1].removeprefix("data: "))
            assert result_payload["total"] == 1
    finally:
        app_settings.agent_mode = original_agent_mode
        app.dependency_overrides.clear()
        engine.dispose()
