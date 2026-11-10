"""Turn run records into metric tables and paired baseline-versus-mitigation comparisons.

Closed-rubric records (configs A and C) do not depend on t, so they are rescored at every
threshold. Open-rubric records (B and D) keep the threshold they were generated for.
Comparisons are mitigation minus baseline: a positive difference means the mitigation scored
higher. At t = 0 the penalized score equals plain accuracy.
"""

from collections.abc import Mapping, Sequence
from typing import Literal

from pydantic import BaseModel, ConfigDict

from haludec.experiments.runner import Failure
from haludec.metrics import Metrics, compute_metrics, group_records
from haludec.rubric import validate_threshold
from haludec.schemas import ConfigId, RunRecord
from haludec.stats import Comparison, compare_configs

Rubric = Literal["closed", "open"]

CLOSED_CONFIGS = frozenset({ConfigId.A_BASELINE, ConfigId.C_CONSISTENCY})

_PAIRS: tuple[tuple[Rubric, ConfigId, ConfigId], ...] = (
    ("closed", ConfigId.A_BASELINE, ConfigId.C_CONSISTENCY),
    ("open", ConfigId.B_OPEN_RUBRIC, ConfigId.D_COMBINED),
)


class MetricsRow(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    config: ConfigId
    threshold: float
    rubric: Rubric
    metrics: Metrics


class ComparisonRow(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    rubric: Rubric
    baseline: ConfigId
    mitigation: ConfigId
    comparison: Comparison


class Report(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    n_questions: int
    n_failures: int
    rows: list[MetricsRow]
    comparisons: list[ComparisonRow]


def rubric_of(config: ConfigId) -> Rubric:
    return "closed" if config in CLOSED_CONFIGS else "open"


def rescore(records: Sequence[RunRecord], t: float) -> list[RunRecord]:
    """Copies of the records scored at threshold t, with distinct run ids."""
    validate_threshold(t)
    return [r.model_copy(update={"threshold": t, "run_id": f"{r.run_id}@t{t:g}"}) for r in records]
    # return [r.model_copy(update={ "run_id": f"{r.run_id}@t{t:g}"}) for r in records]


def scoring_views(
    records: Sequence[RunRecord], thresholds: Sequence[float]
) -> dict[tuple[ConfigId, float], list[RunRecord]]:
    """Records grouped by (config, scoring threshold)."""
    views: dict[tuple[ConfigId, float], list[RunRecord]] = {}
    for config, group in group_records(records, lambda r: r.config).items():
        if config in CLOSED_CONFIGS:
            for t in thresholds:
                views[(config, t)] = rescore(group, t)
        else:
            for t, same_t in group_records(group, lambda r: r.threshold).items():
                if t in thresholds:
                    views[(config, t)] = same_t
    return views


def build_report(
    records: Sequence[RunRecord],
    failures: Sequence[Failure],
    thresholds: Sequence[float],
    *,
    abstention_allowed: Mapping[str, bool] | None = None,
    seed: int = 0,
    n_resamples: int = 10_000,
    n_permutations: int = 100_000,
) -> Report:
    views = scoring_views(records, thresholds)

    rows = [
        MetricsRow(
            config=config,
            threshold=t,
            rubric=rubric_of(config),
            metrics=compute_metrics(recs, abstention_allowed=abstention_allowed),
        )
        for (config, t), recs in sorted(
            views.items(), key=lambda kv: (rubric_of(kv[0][0]), kv[0][0].value, kv[0][1])
        )
    ]

    comparisons: list[ComparisonRow] = []
    for rubric, baseline, mitigation in _PAIRS:
        for t in sorted(thresholds):
            mitigated = views.get((mitigation, t))
            base = views.get((baseline, t))
            if mitigated and base:
                comparison = compare_configs(
                    mitigated,
                    base,
                    n_resamples=n_resamples,
                    n_permutations=n_permutations,
                    seed=seed,
                )
                comparisons.append(
                    ComparisonRow(
                        rubric=rubric,
                        baseline=baseline,
                        mitigation=mitigation,
                        comparison=comparison,
                    )
                )

    return Report(
        n_questions=len({r.test_case_id for r in records}),
        n_failures=len(failures),
        rows=rows,
        comparisons=comparisons,
    )


def format_report(report: Report) -> str:
    lines = [
        f"questions evaluated: {report.n_questions}    failed items: {report.n_failures}",
        "",
        f"{'rubric':<8}{'cfg':<5}{'t':>5}{'runs':>7}{'acc':>8}{'cover':>8}"
        f"{'incorr':>8}{'ans_acc':>9}{'pen_score':>11}  overconfident",
    ]

    for metrics_row in report.rows:
        m = metrics_row.metrics
        ans = "-" if m.answered_accuracy is None else f"{m.answered_accuracy:.3f}"
        lines.append(
            f"{metrics_row.rubric:<8}{metrics_row.config.value:<5}{metrics_row.threshold:>5g}{m.n_total:>7}"
            f"{m.accuracy:>8.3f}{m.coverage:>8.3f}{m.incorrect_rate:>8.3f}{ans:>9}"
            f"{m.mean_penalized_score:>11.3f}  {'YES' if m.overconfident else 'no'}"
        )

    lines += ["", "mitigation minus baseline (penalized score; at t=0 this is accuracy):"]

    for comparison_row in report.comparisons:
        c = comparison_row.comparison
        lines.append(
            f"{comparison_row.rubric:<8}"
            f"{comparison_row.mitigation.value} vs "
            f"{comparison_row.baseline.value}  t={c.threshold:<5g}"
            f" diff={c.mean_diff:+.3f}  {c.ci_level:.0%} CI"
            f" [{c.ci_low:+.3f}, {c.ci_high:+.3f}]"
            f"  p={c.p_value:.4f}  n={c.n_questions}"
        )

    return "\n".join(lines)
