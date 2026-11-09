"""Scoring functions from the paper.

Reward form  s_t :  correct = 1,  abstain = t,  error = 0.
Penalty form s'_t = (s_t - t) / (1 - t):  correct = 1,  abstain = 0,  error = -L.

Both rank responses identically. The penalty form is what Extended Data Table 3
reports, and it makes overconfidence visible: a negative mean score means that
always abstaining (score 0) would have done better.
"""

from collections.abc import Iterable

from haludec.rubric.thresholds import validate_threshold
from haludec.schemas import Label


def score(label: Label, t: float) -> float:
    """Reward-form score s_t of one graded response."""
    validate_threshold(t)
    if label is Label.CORRECT:
        return 1.0
    if label is Label.ABSTAINED:
        return t
    return 0.0


def penalized_score(label: Label, t: float) -> float:
    """Penalty-form score s'_t of one graded response."""
    validate_threshold(t)
    return (score(label, t) - t) / (1.0 - t)


def mean_score(labels: Iterable[Label], t: float, *, penalized: bool = False) -> float:
    """Average score over graded responses. Raises ValueError on an empty input."""
    items = list(labels)
    if not items:
        raise ValueError("cannot average an empty list of labels")
    fn = penalized_score if penalized else score
    return sum(fn(label, t) for label in items) / len(items)


def always_abstain_score(t: float, *, penalized: bool = False) -> float:
    """Score of the policy that abstains on every question.

    Penalty form: always 0. Reward form: t. A model whose mean penalized score is
    below this is overconfident at threshold t.
    """
    if penalized:
        return penalized_score(Label.ABSTAINED, t)
    return score(Label.ABSTAINED, t)
