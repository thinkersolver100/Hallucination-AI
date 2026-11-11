import json
from pathlib import Path

import pytest

from haludec.api.settings import SettingsError, load_pricing, load_settings

KEY = "k" * 40
ONE = {"m/one": {"input_per_mtok": 1.0, "output_per_mtok": 2.0}}


def write_pricing(tmp_path: Path, data: object = ONE) -> Path:
    path = tmp_path / "pricing.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def env_for(tmp_path: Path, **overrides: str) -> dict[str, str]:
    env = {"HALUDEC_SERVICE_KEY": KEY, "HALUDEC_PRICING_FILE": str(write_pricing(tmp_path))}
    env.update(overrides)
    return env


def test_valid_settings_and_defaults(tmp_path: Path) -> None:
    settings = load_settings(env_for(tmp_path))

    assert settings.service_key == KEY
    assert settings.pricing["m/one"].output_per_mtok == 2.0
    assert settings.max_request_budget_usd == 5.0
    assert settings.expose_docs is False
    assert settings.openrouter_api_key == ""
    assert settings.provider == "openrouter"
    assert settings.groq_api_key == ""


def test_overrides(tmp_path: Path) -> None:
    env = env_for(
        tmp_path,
        HALUDEC_MAX_REQUEST_BUDGET_USD="2.5",
        HALUDEC_EXPOSE_DOCS="1",
        OPENROUTER_API_KEY="or-key",
        HALUDEC_CACHE_PATH="/tmp/c.db",
        HALUDEC_PROVIDER="groq",
        GROQ_API_KEY="groq-test-key",
    )
    settings = load_settings(env)

    assert settings.max_request_budget_usd == 2.5
    assert settings.expose_docs is True
    assert settings.openrouter_api_key == "or-key"
    assert str(settings.cache_path) == "/tmp/c.db"
    assert settings.provider == "groq"
    assert settings.groq_api_key == "groq-test-key"


def test_secrets_never_appear_in_repr(tmp_path: Path) -> None:
    settings = load_settings(env_for(tmp_path, OPENROUTER_API_KEY="or-secret"))
    text = repr(settings)
    assert KEY not in text
    assert "or-secret" not in text


def test_service_key_is_required_and_long_enough(tmp_path: Path) -> None:
    env = env_for(tmp_path)
    del env["HALUDEC_SERVICE_KEY"]
    with pytest.raises(SettingsError, match="HALUDEC_SERVICE_KEY is required"):
        load_settings(env)
    with pytest.raises(SettingsError, match="at least 32"):
        load_settings(env_for(tmp_path, HALUDEC_SERVICE_KEY="short"))


def test_pricing_file_is_required(tmp_path: Path) -> None:
    env = env_for(tmp_path)
    del env["HALUDEC_PRICING_FILE"]
    with pytest.raises(SettingsError, match="HALUDEC_PRICING_FILE is required"):
        load_settings(env)


@pytest.mark.parametrize("bad", ["abc", "0", "-1", "5000", "nan"])
def test_invalid_budgets_are_rejected(tmp_path: Path, bad: str) -> None:
    with pytest.raises(SettingsError):
        load_settings(env_for(tmp_path, HALUDEC_MAX_REQUEST_BUDGET_USD=bad))


def test_bad_pricing_files_are_rejected(tmp_path: Path) -> None:
    with pytest.raises(SettingsError, match="cannot read"):
        load_pricing(tmp_path / "missing.json")

    broken = tmp_path / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    with pytest.raises(SettingsError, match="cannot read"):
        load_pricing(broken)

    with pytest.raises(SettingsError, match="non-empty"):
        load_pricing(write_pricing(tmp_path, {}))
    with pytest.raises(SettingsError, match="invalid pricing"):
        load_pricing(write_pricing(tmp_path, {"m": {"input_per_mtok": -1, "output_per_mtok": 1}}))
    with pytest.raises(SettingsError, match="invalid pricing"):
        load_pricing(write_pricing(tmp_path, {"m": {"input_per_mtok": 1}}))

    def test_invalid_provider_is_rejected(tmp_path: Path) -> None:
        with pytest.raises(SettingsError, match="HALUDEC_PROVIDER"):
            load_settings(env_for(tmp_path, HALUDEC_PROVIDER="groqq"))
