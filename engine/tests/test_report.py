import pytest

from factories import make_record
from haludec.experiments import Failure, build_report, format_report, rescore, scoring_views
from haludec.schemas import ConfigId, Label


def closed_records() -> list:
    records = []
    for i in range(6):
        case = f"q{i}"
        records += [
            make_record(Label.CORRECT, case_id=case, config=ConfigId.A_BASELINE, threshold=0.0),
            make_record(
                Label.INCORRECT,
                case_id=case,
                config=ConfigId.A_BASELINE,
                threshold=0.0,
                sample_index=1,
            ),
            make_record(
                Label.ABSTAINED, case_id=case, config=ConfigId.C_CONSISTENCY, threshold=0.0
            ),
        ]
    return records


def open_records(t: float) -> list:
    records = []
    for i in range(6):
        case = f"q{i}"
        records += [
            make_record(Label.CORRECT, case_id=case, config=ConfigId.B_OPEN_RUBRIC, threshold=t),
            make_record(Label.CORRECT, case_id=case, config=ConfigId.D_COMBINED, threshold=t),
        ]
    return records


def test_rescore_changes_the_threshold_without_touching_the_original() -> None:
    original = make_record(Label.INCORRECT, threshold=0.0)

    (copy,) = rescore([original], 0.75)

    assert copy.threshold == 0.75
    assert original.threshold == 0.0
    assert copy.run_id != original.run_id
    assert copy.label is original.label


def test_rescore_rejects_invalid_thresholds() -> None:
    with pytest.raises(ValueError):
        rescore([make_record()], 1.0)


def test_scoring_views_rescore_closed_configs_and_keep_open_ones() -> None:
    records = closed_records() + open_records(0.5)

    views = scoring_views(records, (0.5, 0.75))

    assert set(views) == {
        (ConfigId.A_BASELINE, 0.5),
        (ConfigId.A_BASELINE, 0.75),
        (ConfigId.C_CONSISTENCY, 0.5),
        (ConfigId.C_CONSISTENCY, 0.75),
        (ConfigId.B_OPEN_RUBRIC, 0.5),
        (ConfigId.D_COMBINED, 0.5),
    }
    assert all(r.threshold == 0.75 for r in views[(ConfigId.A_BASELINE, 0.75)])
    assert all(r.threshold == 0.5 for r in views[(ConfigId.D_COMBINED, 0.5)])


def test_build_report_rows_and_comparisons() -> None:
    report = build_report(
        closed_records() + open_records(0.5),
        [Failure(test_case_id="x", rubric_t=None, stage="grade", error="e")],
        (0.5, 0.75),
        n_resamples=200,
        n_permutations=500,
    )

    assert report.n_questions == 6
    assert report.n_failures == 1
    assert len(report.rows) == 6
    assert len(report.comparisons) == 3  # closed at two thresholds, open at one

    closed_half = next(
        c for c in report.comparisons if c.rubric == "closed" and c.comparison.threshold == 0.5
    )
    # baseline averages correct (+1) and incorrect (-1 at t=0.5) to 0; mitigation abstains: 0
    assert closed_half.comparison.mean_diff == pytest.approx(0.0)

    closed_high = next(
        c for c in report.comparisons if c.rubric == "closed" and c.comparison.threshold == 0.75
    )
    # at t=0.75 the baseline averages (1 - 3) / 2 = -1, so abstaining wins by 1
    assert closed_high.comparison.mean_diff == pytest.approx(1.0)


def test_format_report_mentions_the_key_columns() -> None:
    report = build_report(closed_records(), [], (0.5,), n_resamples=100, n_permutations=200)
    text = format_report(report)
    assert "overconfident" in text
    assert "mitigation minus baseline" in text
    assert "questions evaluated: 6" in text
