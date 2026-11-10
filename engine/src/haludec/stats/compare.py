"""Compare two configurations on the same questions.

Each question's score is the average over its samples (the paper averages two generations).
The comparison is paired: both sides must cover exactly the same set of questions, and both
must be scored at the same threshold.
"""

import math
from collections import defaultdict
from collections.abc import Mapping, Sequence

from pydantic import BaseModel, ConfigDict

from haludec.metrics import uniform_threshold
from haludec.rubric import penalized_score, score
from haludec.schemas import RunRecord
from haludec.stats.resampling import paired_bootstrap_ci, paired_permutation_test


class Comparison(BaseModel):
    """a versus b. mean_diff = mean_a - mean_b, so a positive value means a scored higher."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    threshold: float
    penalized: bool
    n_questions: int
    mean_a: float
    mean_b: float
    mean_diff: float
    ci_low: float
    ci_high: float
    ci_level: float
    p_value: float
    n_resamples: int
    n_permutations: int
    seed: int


def per_question_scores(
    records: Sequence[RunRecord], *, penalized: bool = True
) -> dict[str, float]:
    """Mean score per test case (averaged over samples) at the records' threshold."""
    t = uniform_threshold(records)
    scorer = penalized_score if penalized else score
    buckets: dict[str, list[float]] = defaultdict(list)
    for record in records:
        buckets[record.test_case_id].append(scorer(record.label, t))
    return {case_id: sum(v) / len(v) for case_id, v in buckets.items()}


def align_scores(
    a: Mapping[str, float], b: Mapping[str, float]
) -> tuple[list[str], list[float], list[float]]:
    """Return aligned score lists, or ValueError if the question sets differ."""
    only_a = sorted(a.keys() - b.keys())
    only_b = sorted(b.keys() - a.keys())
    if only_a or only_b:
        raise ValueError(
            "configs must cover the same questions; "
            f"only in a: {only_a[:5]}, only in b: {only_b[:5]}"
        )
    ids = sorted(a)
    return ids, [a[i] for i in ids], [b[i] for i in ids]


def compare_configs(
    a: Sequence[RunRecord],
    b: Sequence[RunRecord],
    *,
    penalized: bool = True,
    n_resamples: int = 10_000,
    n_permutations: int = 200_000,
    level: float = 0.95,
    seed: int = 0,
) -> Comparison:
    t_a = uniform_threshold(a)
    t_b = uniform_threshold(b)
    if not math.isclose(t_a, t_b):
        raise ValueError(f"configs are scored at different thresholds ({t_a} vs {t_b})")

    ids, xa, xb = align_scores(
        per_question_scores(a, penalized=penalized),
        per_question_scores(b, penalized=penalized),
    )
    ci = paired_bootstrap_ci(xa, xb, n_resamples=n_resamples, level=level, seed=seed)
    p_value = paired_permutation_test(xa, xb, n_permutations=n_permutations, seed=seed)
    return Comparison(
        threshold=t_a,
        penalized=penalized,
        n_questions=len(ids),
        mean_a=sum(xa) / len(xa),
        mean_b=sum(xb) / len(xb),
        mean_diff=ci.estimate,
        ci_low=ci.low,
        ci_high=ci.high,
        ci_level=ci.level,
        p_value=p_value,
        n_resamples=n_resamples,
        n_permutations=n_permutations,
        seed=seed,
    )
