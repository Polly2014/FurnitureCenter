from typing import Annotated

from mcp.server import MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field

from backend.api.schemas import QueryResultDto
from backend.application.catalog import QueryFilters
from backend.application.factory import catalog_service

mcp = MCPServer("家具共享平台")


@mcp.tool(
    annotations=ToolAnnotations(
        title="Search furniture",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    )
)
def search_furniture(
    query: Annotated[
        str | None,
        Field(description="Optional name, SKU, or description text, for example '会议椅'."),
    ] = None,
    category: Annotated[
        str | None,
        Field(description="Exact furniture category returned by list_categories."),
    ] = None,
    site_id: Annotated[
        str | None,
        Field(description="Exact site ID returned by list_sites."),
    ] = None,
    available_only: Annotated[
        bool,
        Field(description="When true, omit furniture with no available inventory."),
    ] = True,
    limit: Annotated[int, Field(ge=1, le=100, description="Maximum result count.")] = 25,
) -> QueryResultDto:
    """Search the furniture catalog and return items, images, and map features."""
    with catalog_service() as service:
        result = service.search(
            query=query,
            filters=QueryFilters(
                category=category,
                site_id=site_id,
                available_only=available_only,
            ),
            limit=limit,
        )
    return QueryResultDto.model_validate(result)
