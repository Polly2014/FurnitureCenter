from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from backend.infrastructure.models import Base, FurnitureRecord
from backend.infrastructure.seed import seed_demo_data

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_arc_chair_seed_uses_a_semantically_matching_local_image() -> None:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)

    with Session(engine) as session:
        seed_demo_data(session)
        chair = session.scalar(
            select(FurnitureRecord).where(FurnitureRecord.id == "furniture-arc-chair")
        )

        assert chair is not None
        assert chair.images[0].url == "/media/furniture/generated/arc-back-meeting-chair.jpg"
        assert chair.images[0].alt_text == "灰色弧背会议椅"
        image_path = (
            PROJECT_ROOT
            / "frontend/public/media/furniture/generated/arc-back-meeting-chair.jpg"
        )
        assert image_path.is_file()
        assert image_path.stat().st_size < 500_000


def test_query_workspace_defaults_prioritize_chat_and_visible_product_details() -> None:
    app_source = (PROJECT_ROOT / "frontend/src/App.tsx").read_text()
    stylesheet = (PROJECT_ROOT / "frontend/src/App.css").read_text()

    assert "useState(250)" in app_source
    assert "useState(390)" in app_source
    assert "height: clamp(180px, 22vh, 210px)" in stylesheet
    assert "--muted: #596460" in stylesheet
    assert "--line: #cfd6d0" in stylesheet
