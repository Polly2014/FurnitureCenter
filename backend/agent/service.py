import json
from dataclasses import dataclass
from typing import Iterator, Protocol

from openai import OpenAI, OpenAIError

from backend.application.catalog import CatalogService, QueryFilters
from backend.domain.catalog import QueryResult
from backend.infrastructure.config import Settings


@dataclass(frozen=True)
class QueryPlan:
    query: str | None = None
    category: str | None = None
    site_id: str | None = None
    available_only: bool = True


class QueryPlanner(Protocol):
    def plan(self, message: str, *, categories: list[str], sites: dict[str, str]) -> QueryPlan: ...


class AgentConfigurationError(RuntimeError):
    pass


class AgentServiceError(RuntimeError):
    pass


class AnswerStreamer(Protocol):
    def stream(self, message: str, result: QueryResult) -> Iterator[str]: ...


class RuleBasedQueryPlanner:
    def plan(self, message: str, *, categories: list[str], sites: dict[str, str]) -> QueryPlan:
        category = next((candidate for candidate in categories if candidate in message), None)
        category_hints = (
            (("椅", "座位", "沙发", "凳"), ("扶手椅和沙发", "座椅")),
            (("桌", "工作台", "工位"), ("桌类", "桌台")),
            (("柜", "收纳", "储物"), ("储物家具", "收纳")),
            (("显示器支架", "演讲台"), ("其他",)),
        )
        if category is None:
            for keywords, preferred_categories in category_hints:
                if any(keyword in message for keyword in keywords):
                    category = next(
                        (
                            candidate
                            for candidate in preferred_categories
                            if candidate in categories
                        ),
                        None,
                    )
                    break

        query_terms = (
            "会议椅",
            "工位椅",
            "会议桌",
            "升降桌",
            "办公桌",
            "沙发",
            "高脚凳",
            "吧台凳",
            "文件柜",
            "矮柜",
            "显示器支架",
            "演讲台",
        )
        query = next((term for term in query_terms if term in message), None)
        if query is None:
            query = next(
                (
                    token
                    for token in message.replace("？", " ").replace("?", " ").split()
                    if any(character.isascii() and character.isalpha() for character in token)
                ),
                None,
            )

        site_id = next(
            (
                candidate_id
                for label, candidate_id in sites.items()
                if label in message or label.replace("园区", "") in message
            ),
            None,
        )
        unavailable_requested = any(word in message for word in ("全部", "无库存", "缺货"))
        return QueryPlan(
            query=query,
            category=category,
            site_id=site_id,
            available_only=not unavailable_requested,
        )


class OpenAIQueryPlanner:
    def __init__(self, settings: Settings) -> None:
        self._client = OpenAI(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
            timeout=settings.openai_timeout_seconds,
            max_retries=settings.openai_max_retries,
        )
        self._model = settings.openai_model

    def plan(self, message: str, *, categories: list[str], sites: dict[str, str]) -> QueryPlan:
        try:
            response = self._client.responses.create(
                model=self._model,
                instructions=(
                    "你是家具目录查询规划器。只返回一个 JSON 对象，不要 Markdown。"
                    "字段为 query、category、site_id、available_only。"
                    "category 只能使用提供的分类，site_id 只能使用提供的站点 ID；"
                    "无法确定的字段返回 null。分类语义：椅、座位、沙发和凳属于‘扶手椅和沙发’；"
                    "桌、工作台和工位属于‘桌类’；柜、收纳和储物属于‘储物家具’；"
                    "显示器支架和演讲台属于‘其他’。query 保留具体家具名或品牌，例如‘会议椅’"
                    "或‘Haworth’，不要把地点和泛化问句放入 query。available_only 默认 true；"
                    "只有用户明确要求无库存、缺货或包含不可用记录时才设为 false。"
                ),
                input=json.dumps(
                    {"message": message, "categories": categories, "sites": sites},
                    ensure_ascii=False,
                ),
            )
        except OpenAIError as error:
            raise AgentServiceError(f"CopilotX request failed: {error}") from error
        content = response.output_text
        if not content:
            raise AgentServiceError("CopilotX returned an empty query plan.")
        try:
            normalized = content.strip()
            if normalized.startswith("```"):
                normalized = normalized.removeprefix("```json").removeprefix("```")
                normalized = normalized.removesuffix("```").strip()
            payload = json.loads(normalized)
        except (json.JSONDecodeError, AttributeError) as error:
            raise AgentServiceError("CopilotX returned an invalid JSON query plan.") from error

        category = payload.get("category")
        site_id = payload.get("site_id")
        if category is not None and category not in categories:
            raise AgentServiceError(f"CopilotX returned an unknown category: {category}")
        if site_id is not None and site_id not in sites.values():
            raise AgentServiceError(f"CopilotX returned an unknown site ID: {site_id}")
        return QueryPlan(
            query=payload.get("query"),
            category=category,
            site_id=site_id,
            available_only=bool(payload.get("available_only", True)),
        )


class OpenAIAnswerStreamer:
    def __init__(self, settings: Settings) -> None:
        self._client = OpenAI(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
            timeout=settings.openai_timeout_seconds,
            max_retries=settings.openai_max_retries,
        )
        self._model = settings.openai_model

    def stream(self, message: str, result: QueryResult) -> Iterator[str]:
        context = {
            "question": message,
            "total_kinds": result.total,
            "items": [
                {
                    "name": item.name,
                    "name_en": item.name_en,
                    "category": item.category,
                    "brand": item.brand,
                    "dimensions": item.dimensions,
                    "color": item.color,
                    "material": item.material,
                    "quantity_available": item.quantity_available,
                    "sites": [position.site.name for position in item.inventory],
                }
                for item in result.items[:20]
            ],
        }
        try:
            with self._client.responses.stream(
                model=self._model,
                instructions=(
                    "你是家具共享平台的查询助手。根据提供的真实查询结果，用简洁自然的中文"
                    "直接回答用户。不得编造结果中不存在的家具、地点、库存或属性。优先概括命中"
                    "数量，再指出最相关的家具和位置；若没有结果，说明未找到并建议放宽条件。"
                    "不要描述内部查询过程，不要使用 Markdown 表格。"
                ),
                input=json.dumps(context, ensure_ascii=False),
            ) as stream:
                for event in stream:
                    if event.type == "response.output_text.delta" and event.delta:
                        yield event.delta
        except OpenAIError as error:
            raise AgentServiceError(f"CopilotX answer stream failed: {error}") from error


class RuleBasedAnswerStreamer:
    def stream(self, message: str, result: QueryResult) -> Iterator[str]:
        del message
        if result.answer:
            yield result.answer


class FurnitureQueryAgent:
    def __init__(self, catalog: CatalogService, planner: QueryPlanner) -> None:
        self._catalog = catalog
        self._planner = planner

    def query(
        self,
        message: str,
        *,
        categories: list[str],
        sites: dict[str, str],
    ) -> QueryResult:
        plan = self._planner.plan(message, categories=categories, sites=sites)
        result = self._catalog.search(
            query=plan.query,
            filters=QueryFilters(
                category=plan.category,
                site_id=plan.site_id,
                available_only=plan.available_only,
            ),
        )
        if result.total == 0:
            answer = "没有找到符合条件的家具，可以尝试放宽地点、分类或库存条件。"
        else:
            quantity = sum(item.quantity_available for item in result.items)
            answer = (
                f"找到 {result.total} 类家具，共有 {quantity} 件可用。"
                "已在地图和图片列表中标出。"
            )
        return QueryResult(
            items=result.items,
            map_features=result.map_features,
            total=result.total,
            applied_query=result.applied_query,
            applied_filters=result.applied_filters,
            answer=answer,
        )


def build_query_planner(settings: Settings) -> QueryPlanner:
    if settings.agent_mode == "rules":
        return RuleBasedQueryPlanner()
    if settings.agent_mode != "copilotx":
        raise AgentConfigurationError(
            "FURNITURE_CENTER_AGENT_MODE must be 'copilotx' or 'rules'."
        )
    if not settings.openai_api_key:
        raise AgentConfigurationError(
            "CopilotX is selected but FURNITURE_CENTER_OPENAI_API_KEY is not configured."
        )
    return OpenAIQueryPlanner(settings)


def build_answer_streamer(settings: Settings) -> AnswerStreamer:
    if settings.agent_mode == "rules":
        return RuleBasedAnswerStreamer()
    if settings.agent_mode != "copilotx":
        raise AgentConfigurationError(
            "FURNITURE_CENTER_AGENT_MODE must be 'copilotx' or 'rules'."
        )
    if not settings.openai_api_key:
        raise AgentConfigurationError(
            "CopilotX is selected but FURNITURE_CENTER_OPENAI_API_KEY is not configured."
        )
    return OpenAIAnswerStreamer(settings)
