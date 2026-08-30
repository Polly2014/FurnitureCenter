from types import SimpleNamespace

import pytest

from backend.agent.service import (
    AgentConfigurationError,
    FurnitureQueryAgent,
    OpenAIQueryPlanner,
    QueryPlan,
    RuleBasedQueryPlanner,
    build_query_planner,
)
from backend.application.catalog import CatalogService, QueryFilters
from backend.domain.catalog import Furniture, FurnitureCondition, InventoryPosition, Site
from backend.infrastructure.config import Settings


class RecordingRepository:
    def __init__(self, furniture: Furniture) -> None:
        self.furniture = furniture
        self.filters: QueryFilters | None = None

    def search(self, *, query, filters, limit):
        self.filters = filters
        return [self.furniture]


def test_agent_plans_chinese_site_and_category_into_catalog_query() -> None:
    site = Site("site-beijing", "BJ", "北京园区", "北京", 39.9042, 116.4074)
    furniture = Furniture(
        id="chair",
        sku="CHAIR-1",
        name="会议椅",
        category="座椅",
        description="",
        condition=FurnitureCondition.GOOD,
        inventory=(InventoryPosition("lot", site, 5, 4),),
    )
    repository = RecordingRepository(furniture)
    agent = FurnitureQueryAgent(CatalogService(repository), RuleBasedQueryPlanner())

    result = agent.query(
        "北京还有什么会议椅？",
        categories=["座椅", "桌台"],
        sites={"北京": "site-beijing"},
    )

    assert repository.filters == QueryFilters(category="座椅", site_id="site-beijing")
    assert result.answer == "找到 1 类家具，共有 4 件可用。已在地图和图片列表中标出。"


def test_planner_uses_imported_taxonomy_and_specific_search_term() -> None:
    planner = RuleBasedQueryPlanner()

    plan = planner.plan(
        "北京有哪些会议椅？",
        categories=["扶手椅和沙发", "桌类", "储物家具", "其他"],
        sites={"北京": "site-beijing"},
    )

    assert plan == QueryPlan(
        query="会议椅",
        category="扶手椅和沙发",
        site_id="site-beijing",
        available_only=True,
    )


def test_copilotx_requires_an_api_key() -> None:
    settings = Settings(agent_mode="copilotx", openai_api_key=None)

    with pytest.raises(AgentConfigurationError, match="FURNITURE_CENTER_OPENAI_API_KEY"):
        build_query_planner(settings)


def test_copilotx_planner_uses_configured_endpoint_and_model(monkeypatch) -> None:
    captured: dict = {}

    class FakeResponses:
        def create(self, **kwargs):
            captured["request"] = kwargs
            return SimpleNamespace(
                output_text='{"query":"会议椅","category":"扶手椅和沙发",'
                '"site_id":"site-beijing","available_only":true}'
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured["client"] = kwargs
            self.responses = FakeResponses()

    monkeypatch.setattr("backend.agent.service.OpenAI", FakeOpenAI)
    settings = Settings(
        openai_api_key="test-key",
        openai_base_url="https://api.polly.wang/v1",
        openai_model="gpt-5.6-terra",
    )

    plan = OpenAIQueryPlanner(settings).plan(
        "北京有哪些会议椅？",
        categories=["扶手椅和沙发"],
        sites={"北京": "site-beijing"},
    )

    assert captured["client"] == {
        "api_key": "test-key",
        "base_url": "https://api.polly.wang/v1",
        "timeout": 30,
        "max_retries": 1,
    }
    assert captured["request"]["model"] == "gpt-5.6-terra"
    assert plan == QueryPlan(
        query="会议椅",
        category="扶手椅和沙发",
        site_id="site-beijing",
        available_only=True,
    )
