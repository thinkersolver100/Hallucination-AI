"""OpenRouter chat-completions provider (the paper's experiments used OpenRouter).

One API key reaches many models. Pricing must be configured per model: an unpriced
model is refused before any request is sent, so spend is never untracked.
The API key is never logged and never included in error messages.
"""

import time
from collections.abc import Mapping
from typing import Any

import httpx

from haludec.providers.base import (
    GenRequest,
    GenResponse,
    ProviderError,
    RateLimitError,
    TransientError,
)
from haludec.providers.cost import Pricing, compute_cost

API_URL = "https://openrouter.ai/api/v1/chat/completions"
_ERROR_SNIPPET_CHARS = 200


def _parse_retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None
    return seconds if seconds >= 0 else None


class OpenRouterProvider:
    def __init__(
        self,
        api_key: str,
        pricing: Mapping[str, Pricing],
        *,
        client: httpx.AsyncClient | None = None,
        timeout_s: float = 120.0,
    ) -> None:
        if not api_key:
            raise ValueError("api_key must not be empty")
        self._api_key = api_key
        self._pricing = dict(pricing)
        self._owns_client = client is None
        self._client = httpx.AsyncClient(timeout=timeout_s) if client is None else client

    async def generate(self, req: GenRequest) -> GenResponse:
        pricing = self._pricing.get(req.model)
        if pricing is None:
            raise ProviderError(f"no pricing configured for model {req.model!r}")

        messages: list[dict[str, str]] = []
        if req.system is not None:
            messages.append({"role": "system", "content": req.system})
        messages.append({"role": "user", "content": req.prompt})
        body: dict[str, Any] = {
            "model": req.model,
            "messages": messages,
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
        }
        headers = {"Authorization": f"Bearer {self._api_key}"}

        start = time.perf_counter()
        try:
            http_resp = await self._client.post(API_URL, json=body, headers=headers)
        except httpx.TransportError as exc:
            raise TransientError(f"network error: {type(exc).__name__}: {exc}") from exc
        latency_ms = (time.perf_counter() - start) * 1000.0

        self._raise_for_status(http_resp)
        text, tokens_in, tokens_out = self._parse(http_resp)
        return GenResponse(
            text=text,
            model=req.model,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            latency_ms=latency_ms,
            cost_usd=compute_cost(tokens_in, tokens_out, pricing),
        )

    @staticmethod
    def _raise_for_status(resp: httpx.Response) -> None:
        status = resp.status_code
        if status == 429:
            retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
            raise RateLimitError("rate limited (HTTP 429)", retry_after=retry_after)
        if status >= 500:
            raise TransientError(f"provider error (HTTP {status})")
        if status >= 400:
            snippet = resp.text[:_ERROR_SNIPPET_CHARS]
            raise ProviderError(f"request rejected (HTTP {status}): {snippet}")

    @staticmethod
    def _parse(resp: httpx.Response) -> tuple[str, int, int]:
        try:
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            tokens_in = int(data["usage"]["prompt_tokens"])
            tokens_out = int(data["usage"]["completion_tokens"])
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError("malformed response from provider") from exc
        if not isinstance(text, str):
            raise ProviderError("provider returned no text content")
        return text, tokens_in, tokens_out

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()
