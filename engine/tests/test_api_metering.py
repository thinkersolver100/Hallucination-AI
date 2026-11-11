import pytest

from haludec.api.metering import RequestMeter
from haludec.providers import (
    BudgetExceededError,
    CachingProvider,
    FakeProvider,
    GenRequest,
    Pricing,
)

ONE_DOLLAR_PER_TOKEN = Pricing(input_per_mtok=1_000_000.0, output_per_mtok=1_000_000.0)


def req(prompt: str = "a b c") -> GenRequest:
    return GenRequest(model="m", prompt=prompt)


async def test_only_paid_calls_count_towards_spend() -> None:
    cache = CachingProvider(FakeProvider(pricing=ONE_DOLLAR_PER_TOKEN))
    meter = RequestMeter(cache, budget_usd=1000.0)

    await meter.generate(req())
    await meter.generate(req())  # identical request: served from the cache

    assert (meter.paid_calls, meter.cached_calls) == (1, 1)
    assert meter.spent_usd == pytest.approx(5.0)  # 3 words in + 2 words out
    cache.close()


async def test_budget_blocks_the_next_call_once_reached() -> None:
    fake = FakeProvider(pricing=ONE_DOLLAR_PER_TOKEN)
    meter = RequestMeter(fake, budget_usd=5.0)

    await meter.generate(req("a b c"))  # costs exactly 5

    with pytest.raises(BudgetExceededError):
        await meter.generate(req("d e f"))
    assert len(fake.calls) == 1


async def test_a_call_that_starts_under_budget_may_overshoot_it() -> None:
    meter = RequestMeter(FakeProvider(pricing=ONE_DOLLAR_PER_TOKEN), budget_usd=1.0)
    await meter.generate(req())
    assert meter.spent_usd > meter.budget_usd


def test_budget_must_be_positive() -> None:
    for bad in (0.0, -1.0):
        with pytest.raises(ValueError):
            RequestMeter(FakeProvider(), budget_usd=bad)
