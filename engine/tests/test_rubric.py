import math

import pytest

from haludec.rubric import (
    STANDARD_THRESHOLDS,
    RubricStyle,
    always_abstain_score,
    mean_score,
    penalized_score,
    penalty_from_t,
    rubric_text,
    score,
    t_from_penalty,
    validate_threshold,
    with_rubric,
)
from haludec.schemas import Label

# ---- thresholds -------------------------------------------------------------


@pytest.mark.parametrize(
    ("t", "expected_penalty"),
    [(0.0, 0.0), (0.5, 1.0), (0.75, 3.0), (0.9, 9.0)],
)
def test_paper_thresholds_map_to_paper_penalties(t: float, expected_penalty: float) -> None:
    assert penalty_from_t(t) == pytest.approx(expected_penalty)
    assert t_from_penalty(expected_penalty) == pytest.approx(t)


def test_standard_thresholds_are_the_papers_four() -> None:
    assert STANDARD_THRESHOLDS == (0.0, 0.5, 0.75, 0.9)


@pytest.mark.parametrize("t", [0.0, 0.1, 0.33, 0.5, 0.75, 0.9])
def test_round_trip(t: float) -> None:
    assert t_from_penalty(penalty_from_t(t)) == pytest.approx(t)


@pytest.mark.parametrize("t", [-0.01, 0.91, 1.0, 2.0, math.nan, math.inf, -math.inf])
def test_invalid_thresholds_rejected(t: float) -> None:
    with pytest.raises(ValueError):
        validate_threshold(t)
    with pytest.raises(ValueError):
        penalty_from_t(t)


@pytest.mark.parametrize("penalty", [-1.0, 10.0, 1000.0, math.nan, math.inf])
def test_invalid_penalties_rejected(penalty: float) -> None:
    with pytest.raises(ValueError):
        t_from_penalty(penalty)


# ---- rubric text ------------------------------------------------------------


def test_reward_rubric_for_075() -> None:
    text = rubric_text(0.75)
    assert "< 75%" in text
    assert "scored at 75% correct" in text


def test_penalty_rubric_for_075() -> None:
    text = rubric_text(0.75, RubricStyle.PENALTY)
    assert "incorrect = -3" in text
    assert "at least 75%" in text


def test_penalty_rubric_for_09_has_no_float_noise() -> None:
    text = rubric_text(0.9, RubricStyle.PENALTY)
    assert "incorrect = -9," in text
    assert "at least 90%" in text


@pytest.mark.parametrize("style", list(RubricStyle))
def test_zero_threshold_never_mentions_a_reward_for_abstaining(style: RubricStyle) -> None:
    text = rubric_text(0.0, style)
    assert "best guess" in text
    assert "%" not in text


def test_zero_threshold_reward_style_says_never_abstain() -> None:
    assert "Never abstain" in rubric_text(0.0)


def test_rubric_text_rejects_invalid_threshold() -> None:
    with pytest.raises(ValueError):
        rubric_text(1.0)


def test_with_rubric_appends_to_question() -> None:
    prompt = with_rubric("What is 2+2?", 0.5)
    assert prompt.startswith("What is 2+2?\n\n[")
    assert prompt.endswith("]")


# ---- scoring ----------------------------------------------------------------


@pytest.mark.parametrize("t", STANDARD_THRESHOLDS)
def test_reward_scores(t: float) -> None:
    assert score(Label.CORRECT, t) == 1.0
    assert score(Label.ABSTAINED, t) == t
    assert score(Label.INCORRECT, t) == 0.0


@pytest.mark.parametrize("t", STANDARD_THRESHOLDS)
def test_penalized_scores_match_error_penalty_form(t: float) -> None:
    assert penalized_score(Label.CORRECT, t) == pytest.approx(1.0)
    assert penalized_score(Label.ABSTAINED, t) == pytest.approx(0.0)
    assert penalized_score(Label.INCORRECT, t) == pytest.approx(-penalty_from_t(t))


def test_paper_example_075_gives_minus_three_for_an_error() -> None:
    assert penalized_score(Label.INCORRECT, 0.75) == pytest.approx(-3.0)


@pytest.mark.parametrize("t", STANDARD_THRESHOLDS)
@pytest.mark.parametrize("p", [0.0, 0.2, 0.5, 0.8, 1.0])
def test_answering_beats_abstaining_exactly_when_p_exceeds_t(p: float, t: float) -> None:
    """The incentive property the whole project rests on."""
    answer = p * score(Label.CORRECT, t) + (1 - p) * score(Label.INCORRECT, t)
    abstain = score(Label.ABSTAINED, t)
    if p > t:
        assert answer > abstain
    elif p < t:
        assert answer < abstain
    else:
        assert answer == pytest.approx(abstain)


def test_at_zero_threshold_abstaining_is_never_better_than_guessing() -> None:
    assert score(Label.ABSTAINED, 0.0) == score(Label.INCORRECT, 0.0) == 0.0


def test_mean_score_reward_form() -> None:
    labels = [Label.CORRECT, Label.ABSTAINED, Label.INCORRECT, Label.INCORRECT]
    assert mean_score(labels, 0.75) == pytest.approx((1 + 0.75 + 0 + 0) / 4)


def test_mean_score_penalized_form() -> None:
    labels = [Label.CORRECT, Label.ABSTAINED, Label.INCORRECT, Label.INCORRECT]
    assert mean_score(labels, 0.75, penalized=True) == pytest.approx((1 + 0 - 3 - 3) / 4)


def test_mean_score_rejects_empty_input() -> None:
    with pytest.raises(ValueError):
        mean_score([], 0.5)


def test_always_abstain_baselines() -> None:
    assert always_abstain_score(0.75) == 0.75
    assert always_abstain_score(0.75, penalized=True) == pytest.approx(0.0)


def test_overconfidence_detection() -> None:
    """A guesser that is right 40% of the time at L = 3 does worse than abstaining."""
    labels = [Label.CORRECT] * 4 + [Label.INCORRECT] * 6
    assert mean_score(labels, 0.75, penalized=True) < always_abstain_score(0.75, penalized=True)
