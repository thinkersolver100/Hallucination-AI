import pytest
from pydantic import ValidationError

from haludec.providers import (
    BudgetExceededError,
    CostTracker,
    FakeProvider,
    GenRequest,
    Pricing,
    ProviderError,
    TrackingProvider,
    compute_cost,
)

# $1 per token, so a call's cost in dollars equals its word count.
ONE_DOLLAR_PER_TOKEN = Pricing(input_per_mtok=1_000_000.0, output_per_mtok=1_000_000.0)


def make_req(prompt: str = "a b c") -> GenRequest:
    return GenRequest(model="m", prompt=prompt)


def test_compute_cost() -> None:
    pricing = Pricing(input_per_mtok=2.0, output_per_mtok=10.0)
    assert compute_cost(1000, 500, pricing) == pytest.approx(0.007)


def test_negative_price_rejected() -> None:
    with pytest.raises(ValidationError):
        Pricing(input_per_mtok=-1.0, output_per_mtok=1.0)


def test_request_validation() -> None:
    with pytest.raises(ValidationError):
        GenRequest(model="m", prompt="")
    with pytest.raises(ValidationError):
        GenRequest(model="m", prompt="x", temperature=3.0)
    with pytest.raises(ValidationError):
        GenRequest(model="m", prompt="x", max_tokens=0)


async def test_fake_returns_scripted_text_and_records_calls() -> None:
    fake = FakeProvider(lambda _r: "Paris")
    resp = await fake.generate(make_req("capital of France"))
    assert resp.text == "Paris"
    assert resp.tokens_in == 3
    assert resp.tokens_out == 1
    assert resp.cached is False
    assert [c.prompt for c in fake.calls] == ["capital of France"]


async def test_fake_raises_queued_errors_then_succeeds() -> None:
    fake = FakeProvider(errors=[ProviderError("boom")])
    with pytest.raises(ProviderError):
        await fake.generate(make_req())
    resp = await fake.generate(make_req())
    assert resp.text == "fake answer"


async def test_fake_cost_uses_pricing() -> None:
    fake = FakeProvider(lambda _r: "x", pricing=ONE_DOLLAR_PER_TOKEN)
    resp = await fake.generate(make_req("a b c"))
    assert resp.cost_usd == pytest.approx(4.0)  # 3 in + 1 out


async def test_tracker_accumulates_and_enforces_budget() -> None:
    fake = FakeProvider(lambda _r: "x", pricing=ONE_DOLLAR_PER_TOKEN)  # $4 per call
    tracker = CostTracker(budget_usd=5.0)
    stack = TrackingProvider(fake, tracker)

    await stack.generate(make_req())
    await stack.generate(make_req())
    assert tracker.spent_usd == pytest.approx(8.0)
    assert tracker.calls == 2
    assert tracker.tokens_in == 6
    assert tracker.tokens_out == 2

    with pytest.raises(BudgetExceededError):
        await stack.generate(make_req())
    assert len(fake.calls) == 2  # the blocked call never reached the provider


async def test_tracker_without_budget_never_blocks() -> None:
    fake = FakeProvider(lambda _r: "x", pricing=ONE_DOLLAR_PER_TOKEN)
    stack = TrackingProvider(fake, CostTracker())
    for _ in range(5):
        await stack.generate(make_req())
    assert len(fake.calls) == 5


def test_negative_budget_rejected() -> None:
    with pytest.raises(ValueError):
        CostTracker(budget_usd=-1.0)


async def test_budget_error_is_not_a_provider_error() -> None:
    """So the retry layer can never swallow it."""
    assert not issubclass(BudgetExceededError, ProviderError)
