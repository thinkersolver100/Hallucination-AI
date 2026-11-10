import numpy as np
import pytest

from factories import make_record
from haludec.schemas import ConfigId, Label
from haludec.stats import (
    align_scores,
    bootstrap_ci,
    compare_configs,
    paired_bootstrap_ci,
    paired_permutation_test,
    per_question_scores,
)

# ---- bootstrap --------------------------------------------------------------


def test_bootstrap_of_constant_data_is_a_point() -> None:
    ci = bootstrap_ci([0.5] * 20, n_resamples=500)
    assert ci.estimate == pytest.approx(0.5)
    assert ci.low == pytest.approx(0.5)
    assert ci.high == pytest.approx(0.5)


def test_bootstrap_brackets_the_mean_with_a_plausible_width() -> None:
    ci = bootstrap_ci([0.0, 1.0] * 50, n_resamples=5000, seed=1)
    assert ci.estimate == pytest.approx(0.5)
    assert 0.36 < ci.low < 0.46
    assert 0.54 < ci.high < 0.64
    assert ci.level == 0.95


def test_bootstrap_is_reproducible_by_seed() -> None:
    data = list(np.random.default_rng(3).normal(size=60))
    assert bootstrap_ci(data, seed=7) == bootstrap_ci(data, seed=7)


def test_paired_bootstrap_uses_the_differences() -> None:
    ci = paired_bootstrap_ci([1.0] * 30, [0.0] * 30, n_resamples=300)
    assert ci.estimate == pytest.approx(1.0)
    assert ci.low == pytest.approx(1.0)


@pytest.mark.parametrize("level", [0.0, 1.0, -0.5, 1.5])
def test_bootstrap_rejects_bad_levels(level: float) -> None:
    with pytest.raises(ValueError):
        bootstrap_ci([1.0, 2.0], level=level)


def test_inputs_are_validated() -> None:
    with pytest.raises(ValueError):
        bootstrap_ci([])
    with pytest.raises(ValueError):
        bootstrap_ci([1.0, float("nan")])
    with pytest.raises(ValueError):
        paired_bootstrap_ci([1.0, 2.0], [1.0])
    with pytest.raises(ValueError):
        bootstrap_ci([1.0], n_resamples=0)


# ---- permutation test -------------------------------------------------------


def test_exact_permutation_known_values() -> None:
    assert paired_permutation_test([1, 1, 1], [0, 0, 0]) == pytest.approx(0.25)
    assert paired_permutation_test([1, 1], [0, 0]) == pytest.approx(0.5)
    assert paired_permutation_test([1], [0]) == pytest.approx(1.0)


def test_no_difference_gives_p_one_in_both_modes() -> None:
    same = [0.2, 0.9, 0.4, 0.4, 0.7, 0.1]
    assert paired_permutation_test(same, same) == pytest.approx(1.0)
    many = [0.1 * i for i in range(40)]
    assert paired_permutation_test(many, many, n_permutations=500) == pytest.approx(1.0)


def test_p_value_is_symmetric_in_its_arguments() -> None:
    a = [0.5, 0.3, 0.8, -0.1, 0.4, 0.6]
    b = [0.0] * 6
    assert paired_permutation_test(a, b) == pytest.approx(paired_permutation_test(b, a))


def test_sampled_p_value_is_never_zero() -> None:
    p = paired_permutation_test([1.0] * 40, [0.0] * 40, n_permutations=1000)
    assert p == pytest.approx(1 / 1001)


def test_sampling_agrees_with_exact_enumeration() -> None:
    a = [0.5, 0.3, 0.8, -0.1, 0.4, 0.6, 0.2, -0.3, 0.7, 0.1, 0.5, 0.9]
    b = [0.0] * 12
    exact = paired_permutation_test(a, b)
    sampled = paired_permutation_test(a, b, n_permutations=40_000, exact_max_n=0, seed=5)
    assert sampled == pytest.approx(exact, abs=0.02)


def test_clear_effect_is_significant_and_noise_is_not() -> None:
    rng = np.random.default_rng(11)
    effect = list(0.5 + rng.normal(0, 0.1, size=40))
    noise = list(rng.normal(0, 1.0, size=40))
    zeros = [0.0] * 40
    assert paired_permutation_test(effect, zeros, n_permutations=5000) < 0.01
    assert paired_permutation_test(noise, zeros, n_permutations=5000) > 0.05


def test_permutation_rejects_bad_arguments() -> None:
    with pytest.raises(ValueError):
        paired_permutation_test([1.0, 2.0], [1.0])
    with pytest.raises(ValueError):
        paired_permutation_test([1.0], [0.0], n_permutations=0)


# ---- comparing configurations -----------------------------------------------


def records_for(config: ConfigId, labels: list[Label], threshold: float = 0.5) -> list:
    return [
        make_record(label, case_id=f"q{i:02d}", config=config, threshold=threshold)
        for i, label in enumerate(labels)
    ]


def test_per_question_scores_average_over_samples() -> None:
    records = [
        make_record(Label.CORRECT, case_id="q1", sample_index=0, threshold=0.5),
        make_record(Label.INCORRECT, case_id="q1", sample_index=1, threshold=0.5),
        make_record(Label.ABSTAINED, case_id="q2", threshold=0.5),
    ]
    scores = per_question_scores(records, penalized=True)
    assert scores == {"q1": pytest.approx((1.0 - 1.0) / 2), "q2": pytest.approx(0.0)}


def test_align_scores_requires_identical_question_sets() -> None:
    with pytest.raises(ValueError, match="same questions"):
        align_scores({"a": 1.0, "b": 2.0}, {"a": 1.0})


def test_compare_detects_a_clear_improvement() -> None:
    better = records_for(ConfigId.D_COMBINED, [Label.CORRECT] * 40)
    worse = records_for(ConfigId.A_BASELINE, [Label.INCORRECT] * 40)

    result = compare_configs(better, worse, n_resamples=500, n_permutations=1000)

    assert result.n_questions == 40
    assert result.mean_a == pytest.approx(1.0)
    assert result.mean_b == pytest.approx(-1.0)  # penalized: error costs L = 1 at t = 0.5
    assert result.mean_diff == pytest.approx(2.0)
    assert result.ci_low == pytest.approx(2.0)
    assert result.p_value == pytest.approx(1 / 1001)


def test_compare_identical_configs_is_not_significant() -> None:
    labels = [Label.CORRECT, Label.INCORRECT, Label.ABSTAINED, Label.CORRECT] * 10
    a = records_for(ConfigId.A_BASELINE, labels)
    b = records_for(ConfigId.D_COMBINED, labels)

    result = compare_configs(a, b, n_resamples=300, n_permutations=500)

    assert result.mean_diff == pytest.approx(0.0)
    assert result.p_value == pytest.approx(1.0)
    assert result.ci_low <= 0.0 <= result.ci_high


def test_compare_rejects_different_thresholds_and_question_sets() -> None:
    a = records_for(ConfigId.A_BASELINE, [Label.CORRECT] * 5, threshold=0.5)
    b = records_for(ConfigId.D_COMBINED, [Label.CORRECT] * 5, threshold=0.75)
    with pytest.raises(ValueError, match="different thresholds"):
        compare_configs(a, b)

    shorter = records_for(ConfigId.D_COMBINED, [Label.CORRECT] * 4, threshold=0.5)
    with pytest.raises(ValueError, match="same questions"):
        compare_configs(a, shorter)
