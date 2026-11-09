"""Retry transient failures with exponential backoff and jitter."""

import asyncio
import random
from collections.abc import Awaitable, Callable

from pydantic import BaseModel, ConfigDict, Field

from haludec.providers.base import (
    GenRequest,
    GenResponse,
    Provider,
    RateLimitError,
    TransientError,
)


class RetryPolicy(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    max_attempts: int = Field(default=5, ge=1)
    base_delay_s: float = Field(default=1.0, ge=0.0)
    max_delay_s: float = Field(default=30.0, ge=0.0)
    jitter: float = Field(default=0.1, ge=0.0, le=1.0)  # up to +10% random extra delay


async def _real_sleep(delay: float) -> None:
    await asyncio.sleep(delay)


class RetryingProvider:
    """Retries TransientError (including RateLimitError). Any other error propagates."""

    def __init__(
        self,
        inner: Provider,
        policy: RetryPolicy | None = None,
        *,
        sleep: Callable[[float], Awaitable[None]] = _real_sleep,
        rng: random.Random | None = None,
    ) -> None:
        self._inner = inner
        self._policy = policy or RetryPolicy()
        self._sleep = sleep
        self._rng = rng or random.Random()

    def _delay(self, attempt: int, exc: TransientError) -> float:
        policy = self._policy
        delay = policy.base_delay_s * (2 ** (attempt - 1))
        if isinstance(exc, RateLimitError) and exc.retry_after is not None:
            delay = max(delay, exc.retry_after)
        delay *= 1.0 + policy.jitter * self._rng.random()
        return float(min(delay, policy.max_delay_s))

    async def generate(self, req: GenRequest) -> GenResponse:
        for attempt in range(1, self._policy.max_attempts + 1):
            try:
                return await self._inner.generate(req)
            except TransientError as exc:
                if attempt == self._policy.max_attempts:
                    raise
                await self._sleep(self._delay(attempt, exc))
        raise AssertionError("unreachable: max_attempts >= 1")
