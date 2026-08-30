from dataclasses import dataclass
from typing import Protocol, Sequence

from backend.domain.catalog import Furniture, MapFeature, QueryResult


@dataclass(frozen=True)
class QueryFilters:
    category: str | None = None
    site_id: str | None = None
    available_only: bool = True


class CatalogRepository(Protocol):
    def search(
        self,
        *,
        query: str | None,
        filters: QueryFilters,
        limit: int,
    ) -> Sequence[Furniture]: ...


class CatalogService:
    def __init__(self, repository: CatalogRepository) -> None:
        self._repository = repository

    def search(
        self,
        *,
        query: str | None = None,
        filters: QueryFilters | None = None,
        limit: int = 50,
    ) -> QueryResult:
        if not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")

        normalized_query = query.strip() if query and query.strip() else None
        normalized_filters = filters or QueryFilters()
        items = tuple(
            self._repository.search(
                query=normalized_query,
                filters=normalized_filters,
                limit=limit,
            )
        )

        return QueryResult(
            items=items,
            map_features=self._build_map_features(items),
            total=len(items),
            applied_query=normalized_query,
            applied_filters={
                "category": normalized_filters.category or "",
                "site_id": normalized_filters.site_id or "",
                "available_only": normalized_filters.available_only,
            },
        )

    @staticmethod
    def _build_map_features(items: Sequence[Furniture]) -> tuple[MapFeature, ...]:
        by_site: dict[str, dict[str, object]] = {}
        for item in items:
            for position in item.inventory:
                if position.quantity_available == 0:
                    continue
                feature = by_site.setdefault(
                    position.site.id,
                    {
                        "site": position.site,
                        "quantity_available": 0,
                        "furniture_ids": [],
                    },
                )
                feature["quantity_available"] = (
                    int(feature["quantity_available"]) + position.quantity_available
                )
                furniture_ids = feature["furniture_ids"]
                assert isinstance(furniture_ids, list)
                furniture_ids.append(item.id)

        return tuple(
            MapFeature(
                site_id=site_id,
                site_name=feature["site"].name,
                latitude=feature["site"].latitude,
                longitude=feature["site"].longitude,
                quantity_available=int(feature["quantity_available"]),
                furniture_ids=tuple(feature["furniture_ids"]),
            )
            for site_id, feature in by_site.items()
        )