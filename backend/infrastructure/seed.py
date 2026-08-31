from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.infrastructure.models import (
    CategoryRecord,
    FurnitureRecord,
    ImageRecord,
    InventoryRecord,
    SiteRecord,
)


def seed_demo_data(session: Session) -> None:
    if session.scalar(select(func.count()).select_from(FurnitureRecord)):
        return

    seating = CategoryRecord(id="category-seating", name="座椅")
    tables = CategoryRecord(id="category-tables", name="桌台")
    storage = CategoryRecord(id="category-storage", name="收纳")
    beijing = SiteRecord(
        id="site-beijing", code="BJ", name="北京园区", city="北京", latitude=39.9042,
        longitude=116.4074,
    )
    shanghai = SiteRecord(
        id="site-shanghai", code="SH", name="上海园区", city="上海", latitude=31.2304,
        longitude=121.4737,
    )
    shenzhen = SiteRecord(
        id="site-shenzhen", code="SZ", name="深圳园区", city="深圳", latitude=22.5431,
        longitude=114.0579,
    )
    session.add_all([seating, tables, storage, beijing, shanghai, shenzhen])

    furniture = [
        FurnitureRecord(
            id="furniture-arc-chair", sku="CHR-ARC-01", name="弧背会议椅",
            category=seating, description="灰色织物坐面，适合会议室与协作空间。", condition="good",
            name_en="Arc-back Meeting Chair", main_category="扶手椅和沙发",
            dimensions="600*600*750", color="灰色", material="布艺 / 金属", brand="Haworth",
            images=[ImageRecord(
                id="image-arc-chair", url="/media/furniture/generated/arc-back-meeting-chair.jpg",
                alt_text="灰色弧背会议椅", is_primary=True,
            )],
            inventory=[
                InventoryRecord(id="inventory-arc-bj", site=beijing, quantity_total=18, quantity_available=12),
                InventoryRecord(id="inventory-arc-sh", site=shanghai, quantity_total=8, quantity_available=4),
            ],
        ),
        FurnitureRecord(
            id="furniture-oak-table", sku="TBL-OAK-06", name="橡木协作桌",
            category=tables, description="六人位实木桌面，可用于项目讨论与共享办公。", condition="excellent",
            name_en="Oak Collaboration Table", main_category="桌类",
            dimensions="1800*900*750", color="原木色", material="木质 / 金属", brand="",
            images=[ImageRecord(
                id="image-oak-table", url="https://images.unsplash.com/photo-1530018607912-eff2daa1bac4?auto=format&fit=crop&w=1200&q=85",
                alt_text="浅色橡木协作桌", is_primary=True,
            )],
            inventory=[InventoryRecord(
                id="inventory-oak-sh", site=shanghai, quantity_total=5, quantity_available=3,
            )],
        ),
        FurnitureRecord(
            id="furniture-lounge-chair", sku="CHR-LNG-04", name="低背休闲椅",
            category=seating, description="低背软包座椅，适合休息区和安静角落。", condition="good",
            name_en="Low-back Lounge Chair", main_category="扶手椅和沙发",
            dimensions="760*720*720", color="米灰色", material="布艺 / 木质", brand="",
            images=[ImageRecord(
                id="image-lounge-chair", url="https://images.unsplash.com/photo-1567538096630-e0c55bd6374c?auto=format&fit=crop&w=1200&q=85",
                alt_text="低背休闲椅", is_primary=True,
            )],
            inventory=[InventoryRecord(
                id="inventory-lounge-sz", site=shenzhen, quantity_total=10, quantity_available=7,
            )],
        ),
        FurnitureRecord(
            id="furniture-shelf", sku="STG-SHL-02", name="开放式矮柜",
            category=storage, description="双层开放收纳，可用作空间分隔。", condition="fair",
            name_en="Open Low Cabinet", main_category="储物家具",
            dimensions="1200*400*750", color="原木色", material="木质", brand="",
            images=[ImageRecord(
                id="image-shelf", url="https://images.unsplash.com/photo-1594620302200-9a762244a156?auto=format&fit=crop&w=1200&q=85",
                alt_text="木质开放式矮柜", is_primary=True,
            )],
            inventory=[InventoryRecord(
                id="inventory-shelf-bj", site=beijing, quantity_total=6, quantity_available=2,
            )],
        ),
    ]
    session.add_all(furniture)
    session.commit()
