import pytest

from factories import make_record
from haludec.metrics import compute_metrics, group_records, uniform_threshold
from haludec.schemas import ConfigId, Label


def sample_records() -> list:  # 6 correct, 2 abstained, 2 incorrect
    labels = [Label.CORRECT] * 6 + [Label.ABSTAINED] * 2 + [Label.INCORRECT] * 2
    return [
        make_record(label, case_id=f"q{i}", threshold=0.5, cost=0.01, latency=10.0 * (i + 1))
        for i, label in enumerate(labels)
    ]


def test_counts_and_ratios_with_denominators() -> None:
    m = compute_metrics(sample_records())

    assert (m.n_total, m.n_correct, m.n_abstained, m.n_incorrect) == (10, 6, 2, 2)
    assert m.accuracy == pytest.approx(0.6)
    assert m.incorrect_rate == pytest.approx(0.2)
    assert m.abstention_rate == pytest.approx(0.2)
    assert m.coverage == pytest.approx(0.8)
    assert m.answered_accuracy == pytest.approx(0.75)
    assert m.selective_risk == pytest.approx(0.25)


def test_ratios_over_all_questions_sum_to_one() -> None:
    m = compute_metrics(sample_records())
    assert m.accuracy + m.incorrect_rate + m.abstention_rate == pytest.approx(1.0)


def test_scores_at_threshold_half() -> None:
    m = compute_metrics(sample_records())
    assert m.mean_score == pytest.approx((6 * 1 + 2 * 0.5 + 2 * 0) / 10)
    assert m.mean_penalized_score == pytest.approx((6 * 1 + 2 * 0 + 2 * -1) / 10)
    assert m.overconfident is False


def test_cost_and_latency() -> None:
    m = compute_metrics(sample_records())
    assert m.total_cost_usd == pytest.approx(0.10)
    assert m.mean_cost_usd == pytest.approx(0.01)
    assert m.mean_latency_ms == pytest.approx(55.0)
    assert m.p95_latency_ms == pytest.approx(100.0)


def test_nothing_answered_gives_none_not_a_misleading_number() -> None:
    records = [make_record(Label.ABSTAINED, case_id=f"q{i}") for i in range(5)]
    m = compute_metrics(records)

    assert m.coverage == 0.0
    assert m.accuracy == 0.0
    assert m.answered_accuracy is None
    assert m.selective_risk is None
    assert m.overconfident is False


def test_overconfidence_flagged_when_guessing_loses_to_abstaining() -> None:
    labels = [Label.CORRECT] * 4 + [Label.INCORRECT] * 6
    records = [
        make_record(label, case_id=f"q{i}", threshold=0.75) for i, label in enumerate(labels)
    ]
    m = compute_metrics(records)

    assert m.mean_penalized_score == pytest.approx((4 - 6 * 3) / 10)
    assert m.overconfident is True


def test_break_even_is_not_flagged_despite_float_noise() -> None:
    labels = [Label.CORRECT] * 9 + [Label.INCORRECT]
    records = [make_record(label, case_id=f"q{i}", threshold=0.9) for i, label in enumerate(labels)]
    assert compute_metrics(records).overconfident is False


def test_overconfidence_is_impossible_at_zero_threshold() -> None:
    records = [make_record(Label.INCORRECT, case_id=f"q{i}", threshold=0.0) for i in range(5)]
    assert compute_metrics(records).overconfident is False


def test_false_abstention_rate() -> None:
    records = [
        make_record(Label.ABSTAINED, case_id="a"),  # abstained where not allowed: counts
        make_record(Label.CORRECT, case_id="b"),
        make_record(Label.ABSTAINED, case_id="c"),  # abstention was allowed: does not count
        make_record(Label.INCORRECT, case_id="d"),
    ]
    allowed = {"a": False, "b": False, "c": True, "d": False}

    m = compute_metrics(records, abstention_allowed=allowed)

    assert m.n_abstention_not_allowed == 3
    assert m.false_abstention_rate == pytest.approx(1 / 3)


def test_false_abstention_is_none_without_the_map() -> None:
    m = compute_metrics(sample_records())
    assert m.false_abstention_rate is None
    assert m.n_abstention_not_allowed is None


def test_false_abstention_requires_every_case_in_the_map() -> None:
    with pytest.raises(ValueError, match="no entry"):
        compute_metrics([make_record(case_id="zzz")], abstention_allowed={"a": False})


def test_mixed_thresholds_and_empty_input_are_rejected() -> None:
    mixed = [make_record(threshold=0.5), make_record(threshold=0.75, case_id="q2")]
    with pytest.raises(ValueError, match="different thresholds"):
        compute_metrics(mixed)
    with pytest.raises(ValueError):
        compute_metrics([])
    with pytest.raises(ValueError):
        uniform_threshold([])


def test_group_records_by_config() -> None:
    records = [
        make_record(config=ConfigId.A_BASELINE, case_id="q1"),
        make_record(config=ConfigId.D_COMBINED, case_id="q1"),
        make_record(config=ConfigId.A_BASELINE, case_id="q2"),
    ]
    groups = group_records(records, lambda r: r.config)

    assert len(groups[ConfigId.A_BASELINE]) == 2
    assert len(groups[ConfigId.D_COMBINED]) == 1
