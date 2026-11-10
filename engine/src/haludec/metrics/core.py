"""Metrics over graded run records.

Every ratio travels with its raw counts so nobody can quote an accuracy without its
denominator. All records passed to compute_metrics must share one scoring threshold; use
group_records to split a mixed list first (for example by config).

Note on cost: record.cost_usd is what producing the response originally cost, even when a
cache served it later. The true cash spent is the CostTracker's number.
"""

import math
from collections import Counter
from collections.abc import Callable, Hashable, Mapping, Sequence

from pydantic import BaseModel, ConfigDict

from haludec.rubric import always_abstain_score, mean_score
from haludec.schemas import Label, RunRecord

# A model exactly at break-even must not be flagged because of float rounding.
_OVERCONFIDENCE_TOLERANCE = 1e-9
_P95 = 0.95


class Metrics(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    threshold: float

    # Raw counts (the denominators).
    n_total: int
    n_correct: int
    n_abstained: int
    n_incorrect: int

    # Ratios over ALL questions (the paper's definitions).
    accuracy: float  # correct / total
    incorrect_rate: float  # incorrect / total
    abstention_rate: float  # abstained / total
    coverage: float  # answered / total

    # Ratios over ANSWERED questions. None when nothing was answered.
    answered_accuracy: float | None  # correct / answered
    selective_risk: float | None  # incorrect / answered

    # Needs the abstention_allowed map. None when it was not provided or has no cases.
    n_abstention_not_allowed: int | None
    false_abstention_rate: float | None

    # Rubric scores (see haludec.rubric.scoring).
    mean_score: float  # correct 1, abstain t, incorrect 0
    mean_penalized_score: float  # correct 1, abstain 0, incorrect -L
    overconfident: bool  # penalized mean below the always-abstain score

    # Operations.
    total_cost_usd: float
    mean_cost_usd: float
    mean_latency_ms: float
    p95_latency_ms: float


def uniform_threshold(records: Sequence[RunRecord]) -> float:
    """The single scoring threshold shared by all records, or ValueError."""
    if not records:
        raise ValueError("no records")
    t = records[0].threshold
    if any(r.threshold != t for r in records):
        raise ValueError("records mix different thresholds; group them first")
    return t


def group_records[K: Hashable](
    records: Sequence[RunRecord], key: Callable[[RunRecord], K]
) -> dict[K, list[RunRecord]]:
    groups: dict[K, list[RunRecord]] = {}
    for record in records:
        groups.setdefault(key(record), []).append(record)
    return groups


def _nearest_rank(sorted_values: list[float], q: float) -> float:
    rank = math.ceil(q * len(sorted_values))
    return sorted_values[max(rank, 1) - 1]


def _false_abstention(
    records: Sequence[RunRecord], abstention_allowed: Mapping[str, bool]
) -> tuple[int | None, float | None]:
    missing = sorted({r.test_case_id for r in records} - abstention_allowed.keys())
    if missing:
        raise ValueError(f"abstention_allowed has no entry for: {missing[:5]}")
    strict = [r for r in records if not abstention_allowed[r.test_case_id]]
    if not strict:
        return 0, None
    abstained = sum(1 for r in strict if r.label is Label.ABSTAINED)
    return len(strict), abstained / len(strict)


def compute_metrics(
    records: Sequence[RunRecord],
    *,
    abstention_allowed: Mapping[str, bool] | None = None,
) -> Metrics:
    """Summarize graded records that share one scoring threshold.

    abstention_allowed maps test_case_id to TestCase.abstention_allowed. A "false
    abstention" is an abstention on a question where abstaining was not acceptable.
    """
    t = uniform_threshold(records)
    n = len(records)
    counts = Counter(r.label for r in records)
    n_correct = counts[Label.CORRECT]
    n_abstained = counts[Label.ABSTAINED]
    n_incorrect = counts[Label.INCORRECT]
    answered = n_correct + n_incorrect

    labels = [r.label for r in records]
    penalized_mean = mean_score(labels, t, penalized=True)
    baseline = always_abstain_score(t, penalized=True)

    n_not_allowed: int | None = None
    false_abstention_rate: float | None = None
    if abstention_allowed is not None:
        n_not_allowed, false_abstention_rate = _false_abstention(records, abstention_allowed)

    latencies = sorted(r.latency_ms for r in records)
    total_cost = sum(r.cost_usd for r in records)

    return Metrics(
        threshold=t,
        n_total=n,
        n_correct=n_correct,
        n_abstained=n_abstained,
        n_incorrect=n_incorrect,
        accuracy=n_correct / n,
        incorrect_rate=n_incorrect / n,
        abstention_rate=n_abstained / n,
        coverage=answered / n,
        answered_accuracy=n_correct / answered if answered else None,
        selective_risk=n_incorrect / answered if answered else None,
        n_abstention_not_allowed=n_not_allowed,
        false_abstention_rate=false_abstention_rate,
        mean_score=mean_score(labels, t),
        mean_penalized_score=penalized_mean,
        overconfident=penalized_mean < baseline - _OVERCONFIDENCE_TOLERANCE,
        total_cost_usd=total_cost,
        mean_cost_usd=total_cost / n,
        mean_latency_ms=sum(latencies) / n,
        p95_latency_ms=_nearest_rank(latencies, _P95),
    )
