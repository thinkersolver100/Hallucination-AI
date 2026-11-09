import random

import pytest

from haludec.providers import (
    FakeProvider,
    GenRequest,
    ProviderError,
    RateLimitError,
    RetryingProvider,
    RetryPolicy,
    TransientError,
)

NO_JITTER = RetryPolicy(max_attempts=5, base_delay_s=1.0, max_delay_s=30.0, jitter=0.0)


class Sleeps:
    """Records requested delays instead of actually sleeping."""

    def __init__(self) -> None:
        self.values: list[float] = []

    async def __call__(self, delay: float) -> None:
        self.values.append(delay)


def make_req() -> GenRequest:
    return GenRequest(model="m", prompt="hello")


async def test_succeeds_after_transient_errors_with_exponential_delays() -> None:
    fake = FakeProvider(errors=[TransientError("a"), RateLimitError("b")])
    sleeps = Sleeps()
    provider = RetryingProvider(fake, NO_JITTER, sleep=sleeps)

    resp = await provider.generate(make_req())

    assert resp.text == "fake answer"
    assert len(fake.calls) == 3
    assert sleeps.values == [1.0, 2.0]


async def test_gives_up_after_max_attempts() -> None:
    fake = FakeProvider(errors=[TransientError("x")] * 3)
    sleeps = Sleeps()
    policy = RetryPolicy(max_attempts=3, base_delay_s=1.0, max_delay_s=30.0, jitter=0.0)
    provider = RetryingProvider(fake, policy, sleep=sleeps)

    with pytest.raises(TransientError):
        await provider.generate(make_req())

    assert len(fake.calls) == 3
    assert len(sleeps.values) == 2  # no sleep after the final failure


async def test_non_transient_errors_are_not_retried() -> None:
    fake = FakeProvider(errors=[ProviderError("bad request")])
    sleeps = Sleeps()
    provider = RetryingProvider(fake, NO_JITTER, sleep=sleeps)

    with pytest.raises(ProviderError):
        await provider.generate(make_req())

    assert len(fake.calls) == 1
    assert sleeps.values == []


async def test_retry_after_is_honoured() -> None:
    fake = FakeProvider(errors=[RateLimitError("slow", retry_after=7.0)])
    sleeps = Sleeps()
    provider = RetryingProvider(fake, NO_JITTER, sleep=sleeps)

    await provider.generate(make_req())

    assert sleeps.values == [7.0]


async def test_retry_after_is_capped_by_max_delay() -> None:
    fake = FakeProvider(errors=[RateLimitError("slow", retry_after=100.0)])
    sleeps = Sleeps()
    provider = RetryingProvider(fake, NO_JITTER, sleep=sleeps)

    await provider.generate(make_req())

    assert sleeps.values == [30.0]


async def test_jitter_stays_within_bounds() -> None:
    fake = FakeProvider(errors=[TransientError("x")])
    sleeps = Sleeps()
    policy = RetryPolicy(max_attempts=2, base_delay_s=1.0, max_delay_s=30.0, jitter=0.5)
    provider = RetryingProvider(fake, policy, sleep=sleeps, rng=random.Random(0))

    await provider.generate(make_req())

    assert 1.0 <= sleeps.values[0] <= 1.5


async def test_first_try_success_never_sleeps() -> None:
    fake = FakeProvider()
    sleeps = Sleeps()
    provider = RetryingProvider(fake, NO_JITTER, sleep=sleeps)

    await provider.generate(make_req())

    assert sleeps.values == []
