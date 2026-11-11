"""Engine service configuration, read from environment variables.

Nothing is hardcoded: prices change and secrets must never live in code. The pricing file
doubles as the allowlist of models the service will call.
"""

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import ValidationError

from haludec.providers import Pricing

MIN_SERVICE_KEY_CHARS = 32
MAX_BUDGET_LIMIT_USD = 1000.0
DEFAULT_MAX_REQUEST_BUDGET_USD = 5.0


class SettingsError(ValueError):
    """The service is misconfigured. Raised at startup so problems are loud and early."""


@dataclass(frozen=True)
class EngineSettings:
    # Secrets are excluded from repr so they cannot leak through logging.
    service_key: str = field(repr=False)
    pricing: dict[str, Pricing]
    max_request_budget_usd: float = DEFAULT_MAX_REQUEST_BUDGET_USD
    expose_docs: bool = False
    openrouter_api_key: str = field(default="", repr=False)
    groq_api_key: str = field(default="", repr=False)
    provider: str = "openrouter"
    cache_path: Path = Path("../runs/cache.db")


def load_pricing(path: Path) -> dict[str, Pricing]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SettingsError(f"cannot read pricing file {path}: {exc}") from exc
    if not isinstance(raw, dict) or not raw:
        raise SettingsError("pricing file must be a non-empty JSON object")
    try:
        return {str(model): Pricing.model_validate(entry) for model, entry in raw.items()}
    except ValidationError as exc:
        raise SettingsError(f"invalid pricing entry: {exc}") from exc


def load_settings(env: Mapping[str, str] | None = None) -> EngineSettings:
    source: Mapping[str, str] = os.environ if env is None else env

    def required(name: str) -> str:
        value = source.get(name, "").strip()
        if not value:
            raise SettingsError(f"{name} is required")
        return value

    service_key = required("HALUDEC_SERVICE_KEY")
    if len(service_key) < MIN_SERVICE_KEY_CHARS:
        raise SettingsError(
            f"HALUDEC_SERVICE_KEY must be at least {MIN_SERVICE_KEY_CHARS} characters"
        )
    pricing = load_pricing(Path(required("HALUDEC_PRICING_FILE")))

    raw_budget = source.get("HALUDEC_MAX_REQUEST_BUDGET_USD", "").strip()
    try:
        max_budget = float(raw_budget) if raw_budget else DEFAULT_MAX_REQUEST_BUDGET_USD
    except ValueError as exc:
        raise SettingsError("HALUDEC_MAX_REQUEST_BUDGET_USD must be a number") from exc
    if not 0 < max_budget <= MAX_BUDGET_LIMIT_USD:
        raise SettingsError(
            f"HALUDEC_MAX_REQUEST_BUDGET_USD must be above 0 and at most {MAX_BUDGET_LIMIT_USD:g}"
        )

    provider = source.get("HALUDEC_PROVIDER", "openrouter").strip().lower()

    if provider not in {"groq", "openrouter"}:
        raise SettingsError("HALUDEC_PROVIDER must be either 'groq' or 'openrouter'")

    return EngineSettings(
        service_key=service_key,
        pricing=pricing,
        max_request_budget_usd=max_budget,
        expose_docs=source.get("HALUDEC_EXPOSE_DOCS", "") == "1",
        openrouter_api_key=source.get("OPENROUTER_API_KEY", "").strip(),
        groq_api_key=source.get("GROQ_API_KEY", "").strip(),
        provider=provider,
        cache_path=Path(source.get("HALUDEC_CACHE_PATH", "../runs/cache.db")),
    )
