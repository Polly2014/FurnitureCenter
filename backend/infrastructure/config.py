from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "sqlite:///./furniture-center.db"
    agent_mode: str = "copilotx"
    openai_api_key: str | None = None
    openai_base_url: str = "https://api.polly.wang/v1"
    openai_model: str = "gpt-5.6-terra"
    openai_timeout_seconds: float = 30
    openai_max_retries: int = 1
    cors_origins: str = "http://localhost:5173"

    model_config = SettingsConfigDict(env_file=".env", env_prefix="FURNITURE_CENTER_")


@lru_cache
def get_settings() -> Settings:
    return Settings()
