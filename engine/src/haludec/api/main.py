"""Production entry point.

uv run uvicorn haludec.api.main:create_default_app --factory --host 127.0.0.1 --port 8000
"""

from fastapi import FastAPI

from haludec.api.app import create_app
from haludec.api.settings import SettingsError, load_settings
from haludec.providers import (
    CachingProvider,
    GroqProvider,
    OpenRouterProvider,
    Provider,
    RetryingProvider,
)


def create_default_app() -> FastAPI:
    settings = load_settings()

    real: Provider

    if settings.provider == "groq":
        if not settings.groq_api_key:
            raise SettingsError("GROQ_API_KEY is required")
        real = GroqProvider(settings.groq_api_key, settings.pricing)
    else:
        if not settings.openrouter_api_key:
            raise SettingsError("OPENROUTER_API_KEY is required")
        real = OpenRouterProvider(settings.openrouter_api_key, settings.pricing)

    cached = CachingProvider(RetryingProvider(real), settings.cache_path)

    async def close() -> None:
        await real.aclose()
        cached.close()

    return create_app(settings, cached, close=close)
