import pytest

from factories import make_record
from haludec.experiments import breakdown_by, format_breakdown
from haludec.schemas import ConfigId, Label, RiskLevel, TestCase


def make_cases() -> list[TestCase]:
    def case(case_id: str, category: str, risk: RiskLevel) -> TestCase:
        return TestCase(
            id=case_id,
            question=f"Question {case_id}?",
            expected_answer="x",
            abstention_allowed=False,
            risk_level=risk,
            category=category,
        )

    return [
        case("q1", "answerable", RiskLevel.LOW),
        case("q2", "answerable", RiskLevel.LOW),
        case("q3", "conflicting", RiskLevel.HIGH),
    ]


def make_records() -> list:
    labels = {"q1": Label.CORRECT, "q2": Label.INCORRECT, "q3": Label.ABSTAINED}
    return [
        make_record(label, case_id=case_id, config=ConfigId.A_BASELINE, threshold=0.0)
        for case_id, label in labels.items()
    ]


def test_breakdown_by_category() -> None:
    rows = breakdown_by(make_records(), make_cases(), (0.5,), "category")

    by_group = {row.group: row.metrics for row in rows}
    assert set(by_group) == {"answerable", "conflicting"}
    assert by_group["answerable"].n_total == 2
    assert by_group["answerable"].accuracy == pytest.approx(0.5)
    assert by_group["conflicting"].abstention_rate == pytest.approx(1.0)
    assert all(row.attribute == "category" for row in rows)
    assert all(row.threshold == 0.5 for row in rows)


def test_breakdown_by_risk_level() -> None:
    rows = breakdown_by(make_records(), make_cases(), (0.5,), "risk_level")
    assert {row.group for row in rows} == {"low", "high"}


def test_closed_records_are_rescored_at_every_requested_threshold() -> None:
    rows = breakdown_by(make_records(), make_cases(), (0.5, 0.9), "category")

    answerable = [r for r in rows if r.group == "answerable"]
    assert {r.threshold for r in answerable} == {0.5, 0.9}
    penalties = {r.threshold: r.metrics.mean_penalized_score for r in answerable}
    assert penalties[0.5] == pytest.approx((1 - 1) / 2)
    assert penalties[0.9] == pytest.approx((1 - 9) / 2)


def test_unknown_test_cases_are_rejected() -> None:
    records = [make_record(Label.CORRECT, case_id="zzz", threshold=0.0)]
    with pytest.raises(ValueError, match="unknown test cases"):
        breakdown_by(records, make_cases(), (0.5,), "category")


def test_format_breakdown() -> None:
    rows = breakdown_by(make_records(), make_cases(), (0.5,), "category")
    text = format_breakdown(rows, 0.5)
    assert "by category at t=0.5" in text
    assert "conflicting" in text
    assert "no rows" in format_breakdown(rows, 0.75)
