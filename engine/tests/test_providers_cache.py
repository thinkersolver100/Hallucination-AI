import contextlib
import itertools
from pathlib import Path

from haludec.providers import CachingProvider, FakeProvider, GenRequest, ProviderError


def make_req(**overrides: object) -> GenRequest:
    data: dict[str, object] = {"model": "m", "prompt": "hello world"}
    data.update(overrides)
    return GenRequest(**data)  # type: ignore[arg-type]


async def test_second_identical_request_is_served_from_cache() -> None:
    fake = FakeProvider()
    cache = CachingProvider(fake)

    first = await cache.generate(make_req())
    second = await cache.generate(make_req())

    assert first.cached is False
    assert second.cached is True
    assert second.text == first.text
    assert len(fake.calls) == 1
    assert (cache.hits, cache.misses) == (1, 1)
    cache.close()


async def test_sample_index_gives_independent_samples() -> None:
    """The dual-generation mitigation depends on this."""
    counter = itertools.count()
    fake = FakeProvider(lambda _r: f"answer {next(counter)}")
    cache = CachingProvider(fake)

    a = await cache.generate(make_req(sample_index=0))
    b = await cache.generate(make_req(sample_index=1))

    assert a.text != b.text
    assert len(fake.calls) == 2
    cache.close()


async def test_different_models_and_parameters_do_not_collide() -> None:
    fake = FakeProvider()
    cache = CachingProvider(fake)

    await cache.generate(make_req())
    await cache.generate(make_req(model="other"))
    await cache.generate(make_req(temperature=0.0))
    await cache.generate(make_req(system="be brief"))

    assert len(fake.calls) == 4
    cache.close()


async def test_cache_persists_across_instances(tmp_path: Path) -> None:
    db = tmp_path / "cache.db"

    first = CachingProvider(FakeProvider(lambda _r: "Paris"), db)
    await first.generate(make_req())
    first.close()

    must_not_be_called = FakeProvider(errors=[ProviderError("should not be called")])
    second = CachingProvider(must_not_be_called, db)
    resp = await second.generate(make_req())

    assert resp.text == "Paris"
    assert resp.cached is True
    assert must_not_be_called.calls == []
    second.close()


async def test_errors_are_not_cached() -> None:
    fake = FakeProvider(errors=[ProviderError("boom")])
    cache = CachingProvider(fake)

    with contextlib.suppress(ProviderError):
        await cache.generate(make_req())
    resp = await cache.generate(make_req())

    assert resp.cached is False
    assert len(fake.calls) == 2
    cache.close()
