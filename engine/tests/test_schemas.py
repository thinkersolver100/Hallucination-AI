from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import ValidationError

from haludec.schemas import (
    MAX_THRESHOLD,
    ConfigId,
    Label,
    RiskLevel,
    RunRecord,
    TestCase,
)


def make_case(**overrides: Any) -> TestCase:
    data: dict[str, Any] = {
        "id": "ECOM-001",
        "question": "Can I return an item after 45 days?",
        "expected_answer": "No",
        "reference_doc_ids": ["return-policy-v1"],
        "abstention_allowed": False,
        "risk_level": RiskLevel.HIGH,
        "category": "refunds",
    }
    data.update(overrides)
    return TestCase(**data)


def make_record(**overrides: Any) -> RunRecord:
    data: dict[str, Any] = {
        "run_id": "r1",
        "experiment_id": "EXP-001",
        "test_case_id": "ECOM-001",
        "config": ConfigId.A_BASELINE,
        "threshold": 0.75,
        "sample_index": 0,
        "model_id": "test-model",
        "prompt_version": "p1",
        "rubric_version": "r1",
        "response_text": "No.",
        "label": Label.CORRECT,
        "latency_ms": 120.5,
        "tokens_in": 40,
        "tokens_out": 3,
        "cost_usd": 0.0001,
        "timestamp": datetime(2026, 11, 8, 12, 0, tzinfo=UTC),
    }
    data.update(overrides)
    return RunRecord(**data)


def test_valid_test_case() -> None:
    assert make_case().id == "ECOM-001"


def test_test_case_rejects_empty_id() -> None:
    with pytest.raises(ValidationError):
        make_case(id="")


def test_unknown_fields_are_rejected() -> None:
    with pytest.raises(ValidationError):
        make_case(surprise="x")


@pytest.mark.parametrize("t", [0.0, 0.5, 0.75, MAX_THRESHOLD])
def test_valid_thresholds_accepted(t: float) -> None:
    assert make_record(threshold=t).threshold == t


@pytest.mark.parametrize("t", [-0.1, 0.95, 1.0])
def test_invalid_thresholds_rejected(t: float) -> None:
    with pytest.raises(ValidationError):
        make_record(threshold=t)


def test_negative_cost_rejected() -> None:
    with pytest.raises(ValidationError):
        make_record(cost_usd=-0.01)


def test_naive_timestamp_rejected() -> None:
    with pytest.raises(ValidationError):
        make_record(timestamp=datetime(2026, 11, 8, 12, 0))


def test_records_are_immutable() -> None:
    rec = make_record()
    with pytest.raises(ValidationError):
        rec.label = Label.INCORRECT  # type: ignore[misc]


def test_json_round_trip() -> None:
    rec = make_record(judge_decision=True)
    assert RunRecord.model_validate_json(rec.model_dump_json()) == rec


def test_config_ids() -> None:
    assert [c.value for c in ConfigId] == ["A", "B", "C", "D"]
