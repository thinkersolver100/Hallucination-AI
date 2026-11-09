import json

import httpx
import pytest

from haludec.providers import (
    GenRequest,
    OpenRouterProvider,
    Pricing,
    ProviderError,
    RateLimitError,
    TransientError,
)

PRICING = {"test/model": Pricing(input_per_mtok=2.0, output_per_mtok=10.0)}
OK_BODY = {
    "choices": [{"message": {"content": "Paris"}}],
    "usage": {"prompt_tokens": 1000, "completion_tokens": 500},
}


def make_req(**overrides: object) -> GenRequest:
    data: dict[str, object] = {"model": "test/model", "prompt": "Capital of France?"}
    data.update(overrides)
    return GenRequest(**data)  # type: ignore[arg-type]


def make_provider(handler: httpx.MockTransport | object) -> OpenRouterProvider:
    transport = (
        handler if isinstance(handler, httpx.MockTransport) else httpx.MockTransport(handler)
    )  # type: ignore[arg-type]
    client = httpx.AsyncClient(transport=transport)
    return OpenRouterProvider("test-key", PRICING, client=client)


async def test_successful_call_parses_text_tokens_and_cost() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=OK_BODY)

    resp = await make_provider(handler).generate(make_req(temperature=0.0, max_tokens=50))

    assert resp.text == "Paris"
    assert (resp.tokens_in, resp.tokens_out) == (1000, 500)
    assert resp.cost_usd == pytest.approx(0.007)
    assert resp.latency_ms >= 0
    assert seen["auth"] == "Bearer test-key"
    body = seen["body"]
    assert isinstance(body, dict)
    assert body["model"] == "test/model"
    assert body["temperature"] == 0.0
    assert body["max_tokens"] == 50
    assert body["messages"] == [{"role": "user", "content": "Capital of France?"}]


async def test_system_prompt_is_sent_first() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=OK_BODY)

    await make_provider(handler).generate(make_req(system="Be brief."))

    body = seen["body"]
    assert isinstance(body, dict)
    assert body["messages"][0] == {"role": "system", "content": "Be brief."}


async def test_429_becomes_rate_limit_error_with_retry_after() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": "3"}, text="slow down")

    with pytest.raises(RateLimitError) as exc_info:
        await make_provider(handler).generate(make_req())
    assert exc_info.value.retry_after == 3.0


async def test_429_without_header_has_no_retry_after() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="slow down")

    with pytest.raises(RateLimitError) as exc_info:
        await make_provider(handler).generate(make_req())
    assert exc_info.value.retry_after is None


async def test_5xx_is_transient() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    with pytest.raises(TransientError):
        await make_provider(handler).generate(make_req())


async def test_4xx_is_not_transient_and_never_leaks_the_key() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="invalid credentials")

    with pytest.raises(ProviderError) as exc_info:
        await make_provider(handler).generate(make_req())
    assert not isinstance(exc_info.value, TransientError)
    assert "test-key" not in str(exc_info.value)


async def test_network_failure_is_transient() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    with pytest.raises(TransientError):
        await make_provider(handler).generate(make_req())


@pytest.mark.parametrize(
    "body",
    [
        {"nope": 1},
        {"choices": [], "usage": {"prompt_tokens": 1, "completion_tokens": 1}},
        {
            "choices": [{"message": {"content": None}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        },
        {"choices": [{"message": {"content": "x"}}]},
    ],
)
async def test_malformed_200_responses_are_provider_errors(body: dict[str, object]) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=body)

    with pytest.raises(ProviderError):
        await make_provider(handler).generate(make_req())


async def test_non_json_200_is_a_provider_error() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>not json</html>")

    with pytest.raises(ProviderError):
        await make_provider(handler).generate(make_req())


async def test_unpriced_model_is_refused_before_any_request() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=OK_BODY)

    with pytest.raises(ProviderError, match="no pricing"):
        await make_provider(handler).generate(make_req(model="unpriced/model"))
    assert calls == []


def test_empty_api_key_rejected() -> None:
    with pytest.raises(ValueError):
        OpenRouterProvider("", PRICING)
