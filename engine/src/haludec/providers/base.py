"""Provider interface and the request/response types shared by every provider."""

from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class GenRequest(_Frozen):
    """One generation request.

    sample_index is never sent to the model. It exists so that independent samples of
    the same prompt (needed by the dual-generation mitigation) get distinct cache keys.
    """

    model: str = Field(min_length=1)
    prompt: str = Field(min_length=1)
    system: str | None = None
    temperature: float = Field(default=1.0, ge=0.0, le=2.0)
    max_tokens: int = Field(default=1024, gt=0)
    sample_index: int = Field(default=0, ge=0)


class GenResponse(_Frozen):
    text: str
    model: str
    tokens_in: int = Field(ge=0)
    tokens_out: int = Field(ge=0)
    latency_ms: float = Field(ge=0)
    cost_usd: float = Field(ge=0)  # what producing this response cost originally
    cached: bool = False  # True when served from the cache (no new spend)


class ProviderError(Exception):
    """Non-retryable failure: bad request, auth problem, malformed response."""


class TransientError(ProviderError):
    """Retryable failure: network problem or 5xx."""


class RateLimitError(TransientError):
    """HTTP 429. retry_after is the server's requested wait in seconds, if given."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class BudgetExceededError(Exception):
    """The spending cap was reached. Deliberately not a ProviderError: never retried."""


class Provider(Protocol):
    async def generate(self, req: GenRequest) -> GenResponse: ...
