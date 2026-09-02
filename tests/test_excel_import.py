from pathlib import Path

from openpyxl import Workbook
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from backend.infrastructure.database import Base
from backend.infrastructure.excel_import import import_workbook
from backend.infrastructure.models import FurnitureRecord, InventoryRecord


def make_workbook(path: Path) -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "BJW"
    sheet.append(["复用家具台账"])
    sheet.append(["类别", "家具类别（中/英）", "尺寸", "颜色", "材质", "图片", "品牌", " 数量"])
    sheet.append(
        [
            "扶手椅和沙发",
            "工位椅-Zody",
            "700*700*1000",
            "黑色",
            "布艺 / 金属",
            "#VALUE!",
            "Haworth",
            40,
        ]
    )
    sheet.append(
        [
            None,
            "会议椅 / Conference Chair",
            "600*600*750",
            "黑色",
            "布艺 / 金属",
            "有图片",
            "-",
            4,
        ]
    )
    workbook.save(path)


def test_excel_import_preserves_attributes_provenance_and_image_status(tmp_path: Path) -> None:
    workbook_path = tmp_path / "inventory.xlsx"
    make_workbook(workbook_path)
    engine = create_engine(f"sqlite:///{tmp_path / 'import.db'}")
    try:
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False)

        with session_factory() as session:
            preview = import_workbook(session, workbook_path)
            assert preview.rows_seen == 2
            assert preview.quantity_imported == 44
            assert preview.images_embedded == 0
            assert session.scalar(select(func.count(FurnitureRecord.id))) == 0

            report = import_workbook(session, workbook_path, dry_run=False, replace_catalog=True)
            assert report.rows_imported == 2
            assert report.categories_imported == 1
            assert session.scalar(select(func.sum(InventoryRecord.quantity_available))) == 44
            chair = session.scalar(
                select(FurnitureRecord).where(FurnitureRecord.name == "工位椅-Zody")
            )
            assert chair is not None
            assert chair.name_en == "Zody Task Chair"
            assert chair.dimensions == "700*700*1000"
            assert chair.color == "黑色"
            assert chair.material == "布艺 / 金属"
            assert chair.brand == "Haworth"
            assert chair.source_workbook == "inventory.xlsx"
            assert chair.source_sheet == "BJW"
            assert chair.source_row == 3
            assert chair.image_reference == "源文件图片引用失效"
            assert '"数量": "40"' in chair.source_metadata
    finally:
        engine.dispose()


def test_manifest_import_attaches_recovered_image(tmp_path: Path) -> None:
        manifest = tmp_path / "catalog.json"
        manifest.write_text(
                """{
                    "schema_version": 1,
                    "source_workbook": "protected.xlsx",
                    "source_sheet": "BJW",
                    "sites": [
                        {"source_name": "BJW"},
                        {"source_name": "Shang Hai"},
                        {"source_name": "Shenzhen"}
                    ],
                    "rows": [{
                        "row": 3,
                        "category": "扶手椅和沙发",
                        "name": "工位椅-Zody",
                        "dimensions": "700*700*1000",
                        "color": "黑色",
                        "material": "布艺 / 金属",
                        "brand": "Haworth",
                        "quantity": 40,
                        "image_url": "/media/furniture/imported/bjw-row-003.png",
                        "image_reference": "已从受保护工作簿恢复",
                        "metadata": {"数量": "40"}
                    }]
                }""",
                encoding="utf-8",
        )
        engine = create_engine(f"sqlite:///{tmp_path / 'manifest.db'}")
        try:
                Base.metadata.create_all(engine)
                session_factory = sessionmaker(bind=engine, expire_on_commit=False)

                with session_factory() as session:
                        report = import_workbook(
                                session, manifest, dry_run=False, replace_catalog=True
                        )
                        chair = session.scalar(select(FurnitureRecord))
                        assert report.images_recovered == 1
                        assert report.sites_seen == 3
                        assert report.sites_imported == 3
                        assert chair is not None
                        assert chair.images[0].url == "/media/furniture/imported/bjw-row-003.png"
        finally:
                engine.dispose()
