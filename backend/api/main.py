from collections.abc import Iterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Query, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.sse import EventSourceResponse, ServerSentEvent
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.agent.service import (
    AgentConfigurationError,
    AgentServiceError,
    FurnitureQueryAgent,
    build_answer_streamer,
    build_query_planner,
)
from backend.api.schemas import (
    AgentQueryRequest,
    AgentStatusDto,
    AuditEventDto,
    CatalogMetadataDto,
    CategoryDto,
    CreateFurnitureRequest,
    CreateInventoryPositionRequest,
    InventoryAdjustmentRequest,
    InventoryAdjustmentResponse,
    InventoryTransferRequest,
    InventoryTransferResponse,
    QueryResultDto,
    SiteDto,
    UpdateFurnitureRequest,
)
from backend.application.administration import (
    AdjustInventoryCommand,
    AdministrationService,
    CreateFurnitureCommand,
    CreateInventoryPositionCommand,
    InventorySnapshot,
    TransferInventoryCommand,
    UpdateFurnitureCommand,
)
from backend.application.catalog import CatalogService, QueryFilters
from backend.infrastructure.administration_repository import (
    ConcurrentModificationError,
    DuplicateEntityError,
    EntityNotFoundError,
    SqlAlchemyAdministrationRepository,
)
from backend.infrastructure.catalog_repository import SqlAlchemyCatalogRepository
from backend.infrastructure.config import get_settings
from backend.infrastructure.database import (
    Base,
    SessionLocal,
    engine,
    get_session,
    upgrade_local_sqlite_schema,
)
from backend.infrastructure.models import AuditEventRecord, CategoryRecord, SiteRecord
from backend.infrastructure.seed import seed_demo_data


@asynccontextmanager
async def lifespan(_: FastAPI):
    upgrade_local_sqlite_schema(engine)
    Base.metadata.create_all(engine)
    with SessionLocal() as session:
        seed_demo_data(session)
    yield


settings = get_settings()
app = FastAPI(title="家具共享平台 API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_origins.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/catalog/furniture", response_model=QueryResultDto)
def search_furniture(
    query: str | None = None,
    category: str | None = None,
    site_id: str | None = None,
    available_only: bool = True,
    limit: int = Query(default=50, ge=1, le=100),
    session: Session = Depends(get_session),
) -> QueryResultDto:
    service = CatalogService(SqlAlchemyCatalogRepository(session))
    result = service.search(
        query=query,
        filters=QueryFilters(category=category, site_id=site_id, available_only=available_only),
        limit=limit,
    )
    return QueryResultDto.model_validate(result)


@app.get("/api/catalog/metadata", response_model=CatalogMetadataDto)
def get_catalog_metadata(session: Session = Depends(get_session)) -> CatalogMetadataDto:
    categories = list(session.scalars(select(CategoryRecord).order_by(CategoryRecord.name)))
    sites = list(
        session.scalars(
            select(SiteRecord).where(SiteRecord.is_active.is_(True)).order_by(SiteRecord.name)
        )
    )
    return CatalogMetadataDto(
        categories=[CategoryDto(id=category.id, name=category.name) for category in categories],
        sites=[SiteDto.model_validate(site, from_attributes=True) for site in sites],
    )


@app.get("/api/agent/status", response_model=AgentStatusDto)
def agent_status() -> AgentStatusDto:
    return AgentStatusDto(
        mode=settings.agent_mode,
        provider="CopilotX" if settings.agent_mode == "copilotx" else "Local rules",
        model=settings.openai_model if settings.agent_mode == "copilotx" else "rules",
        base_url=settings.openai_base_url if settings.agent_mode == "copilotx" else "local",
        configured=settings.agent_mode == "rules" or bool(settings.openai_api_key),
    )


@app.post("/api/agent/query", response_model=QueryResultDto)
def agent_query(
    request: AgentQueryRequest,
    session: Session = Depends(get_session),
) -> QueryResultDto:
    categories = list(session.scalars(select(CategoryRecord.name).order_by(CategoryRecord.name)))
    site_records = list(
        session.scalars(
            select(SiteRecord).where(SiteRecord.is_active.is_(True)).order_by(SiteRecord.name)
        )
    )
    try:
        planner = build_query_planner(settings)
    except AgentConfigurationError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(error),
        ) from error
    agent = FurnitureQueryAgent(CatalogService(SqlAlchemyCatalogRepository(session)), planner)
    try:
        result = agent.query(
            request.message,
            categories=categories,
            sites={site.name: site.id for site in site_records}
            | {site.city: site.id for site in site_records},
        )
    except AgentServiceError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(error)) from error
    return QueryResultDto.model_validate(result)


@app.post("/api/agent/query/stream", response_class=EventSourceResponse)
def agent_query_stream(
    request: AgentQueryRequest,
    session: Session = Depends(get_session),
) -> Iterator[ServerSentEvent]:
    yield ServerSentEvent(event="status", data={"phase": "planning"})
    categories = list(session.scalars(select(CategoryRecord.name).order_by(CategoryRecord.name)))
    site_records = list(
        session.scalars(
            select(SiteRecord).where(SiteRecord.is_active.is_(True)).order_by(SiteRecord.name)
        )
    )
    try:
        planner = build_query_planner(settings)
        answer_streamer = build_answer_streamer(settings)
        agent = FurnitureQueryAgent(CatalogService(SqlAlchemyCatalogRepository(session)), planner)
        result = agent.query(
            request.message,
            categories=categories,
            sites={site.name: site.id for site in site_records}
            | {site.city: site.id for site in site_records},
        )
        yield ServerSentEvent(
            event="result",
            data=QueryResultDto.model_validate(result).model_dump(mode="json"),
        )
        yield ServerSentEvent(event="status", data={"phase": "answering"})
        for delta in answer_streamer.stream(request.message, result):
            yield ServerSentEvent(event="text_delta", data=delta)
        yield ServerSentEvent(event="done", data={"ok": True})
    except AgentConfigurationError as error:
        yield ServerSentEvent(event="error", data={"message": str(error), "code": "configuration"})
    except AgentServiceError as error:
        yield ServerSentEvent(event="error", data={"message": str(error), "code": "upstream"})


def administration_service(session: Session) -> AdministrationService:
    return AdministrationService(SqlAlchemyAdministrationRepository(session))


def admin_error(error: ValueError) -> HTTPException:
    status_code = (
        status.HTTP_404_NOT_FOUND
        if isinstance(error, EntityNotFoundError)
        else status.HTTP_409_CONFLICT
        if isinstance(error, (DuplicateEntityError, ConcurrentModificationError))
        else status.HTTP_422_UNPROCESSABLE_CONTENT
    )
    return HTTPException(status_code=status_code, detail=str(error))


@app.post("/api/admin/furniture", status_code=status.HTTP_201_CREATED)
def create_furniture(
    request: CreateFurnitureRequest,
    session: Session = Depends(get_session),
) -> dict[str, str]:
    try:
        furniture_id = administration_service(session).create_furniture(
            CreateFurnitureCommand(**request.model_dump())
        )
    except ValueError as error:
        raise admin_error(error) from error
    return {"id": furniture_id}


@app.put("/api/admin/furniture/{furniture_id}", status_code=status.HTTP_204_NO_CONTENT)
def update_furniture(
    furniture_id: str,
    request: UpdateFurnitureRequest,
    session: Session = Depends(get_session),
) -> Response:
    try:
        administration_service(session).update_furniture(
            furniture_id, UpdateFurnitureCommand(**request.model_dump())
        )
    except ValueError as error:
        raise admin_error(error) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def inventory_response(snapshot: InventorySnapshot) -> InventoryAdjustmentResponse:
    return InventoryAdjustmentResponse(
        inventory_id=snapshot.inventory_id,
        quantity_total=snapshot.quantity_total,
        quantity_available=snapshot.quantity_available,
        version=snapshot.version,
    )


@app.post(
    "/api/admin/furniture/{furniture_id}/inventory",
    response_model=InventoryAdjustmentResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_inventory_position(
    furniture_id: str,
    request: CreateInventoryPositionRequest,
    session: Session = Depends(get_session),
) -> InventoryAdjustmentResponse:
    try:
        snapshot = administration_service(session).create_inventory_position(
            CreateInventoryPositionCommand(furniture_id=furniture_id, **request.model_dump())
        )
    except ValueError as error:
        raise admin_error(error) from error
    return inventory_response(snapshot)


@app.delete("/api/admin/furniture/{furniture_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_furniture(
    furniture_id: str,
    actor: str = "furniture-center-admin",
    session: Session = Depends(get_session),
) -> Response:
    try:
        administration_service(session).delete_furniture(furniture_id, actor)
    except ValueError as error:
        raise admin_error(error) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post(
    "/api/admin/inventory/{inventory_id}/adjustments",
    response_model=InventoryAdjustmentResponse,
)
def adjust_inventory(
    inventory_id: str,
    request: InventoryAdjustmentRequest,
    session: Session = Depends(get_session),
) -> InventoryAdjustmentResponse:
    delta_total = request.delta_total
    delta_available = request.delta_available
    if request.delta is not None and delta_total is None and delta_available is None:
        delta_total = request.delta
        delta_available = request.delta
    try:
        snapshot = administration_service(session).adjust_inventory(
            AdjustInventoryCommand(
                inventory_id=inventory_id,
                delta_total=delta_total or 0,
                delta_available=delta_available or 0,
                kind=request.kind,
                reason=request.reason,
                actor=request.actor,
                expected_version=request.expected_version,
            )
        )
    except ValueError as error:
        raise admin_error(error) from error
    return inventory_response(snapshot)


@app.post(
    "/api/admin/inventory/{inventory_id}/transfers",
    response_model=InventoryTransferResponse,
)
def transfer_inventory(
    inventory_id: str,
    request: InventoryTransferRequest,
    session: Session = Depends(get_session),
) -> InventoryTransferResponse:
    try:
        result = administration_service(session).transfer_inventory(
            TransferInventoryCommand(
                source_inventory_id=inventory_id,
                **request.model_dump(),
            )
        )
    except ValueError as error:
        raise admin_error(error) from error
    return InventoryTransferResponse(
        transfer_id=result.transfer_id,
        source=inventory_response(result.source),
        destination=inventory_response(result.destination),
    )


@app.get("/api/admin/audit", response_model=list[AuditEventDto])
def list_audit_events(
    limit: int = Query(default=50, ge=1, le=200),
    session: Session = Depends(get_session),
) -> list[AuditEventDto]:
    events = session.scalars(
        select(AuditEventRecord).order_by(AuditEventRecord.created_at.desc()).limit(limit)
    )
    return [
        AuditEventDto(
            id=event.id,
            entity_type=event.entity_type,
            entity_id=event.entity_id,
            action=event.action,
            actor=event.actor,
            details_json=event.details_json,
            created_at=event.created_at.isoformat(),
        )
        for event in events
    ]
