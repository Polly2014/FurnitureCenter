from contextlib import contextmanager
from typing import Iterator

from backend.application.catalog import CatalogService
from backend.infrastructure.catalog_repository import SqlAlchemyCatalogRepository
from backend.infrastructure.database import Base, SessionLocal, engine
from backend.infrastructure.seed import seed_demo_data


@contextmanager
def catalog_service() -> Iterator[CatalogService]:
    Base.metadata.create_all(engine)
    with SessionLocal() as session:
        seed_demo_data(session)
        yield CatalogService(SqlAlchemyCatalogRepository(session))