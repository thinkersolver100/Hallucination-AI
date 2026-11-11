"""Metrics per question category or risk level.

Small groups produce noisy numbers, so every row carries its run count. In categories whose
expected answer is ABSTAIN, accuracy is zero by construction: read abstention_rate and
incorrect_rate there instead.
"""

from collections.abc import Sequence
from typing import Literal

from pydantic import BaseModel, ConfigDict

from haludec.experiments.report import Rubric, rubric_of, scoring_views
from haludec.metrics import Metrics, compute_metrics, group_records
from haludec.schemas import ConfigId, RunRecord, TestCase

Attribute = Literal["category", "risk_level"]


class BreakdownRow(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    attribute: Attribute
    group: str
    config: ConfigId
    threshold: float
    rubric: Rubric
    metrics: Metrics


def breakdown_by(
    records: Sequence[RunRecord],
    cases: Sequence[TestCase],
    thresholds: Sequence[float],
    attribute: Attribute,
) -> list[BreakdownRow]:
    lookup = {case.id: str(getattr(case, attribute)) for case in cases}
    unknown = sorted({r.test_case_id for r in records} - lookup.keys())
    if unknown:
        raise ValueError(f"records refer to unknown test cases: {unknown[:5]}")

    views = scoring_views(records, thresholds)
    rows: list[BreakdownRow] = []
    for (config, t), view in sorted(
        views.items(), key=lambda kv: (rubric_of(kv[0][0]), kv[0][0].value, kv[0][1])
    ):
        for group, subset in sorted(group_records(view, lambda r: lookup[r.test_case_id]).items()):
            rows.append(
                BreakdownRow(
                    attribute=attribute,
                    group=group,
                    config=config,
                    threshold=t,
                    rubric=rubric_of(config),
                    metrics=compute_metrics(subset),
                )
            )
    return rows


def format_breakdown(rows: Sequence[BreakdownRow], threshold: float) -> str:
    selected = [r for r in rows if r.threshold == threshold]
    if not selected:
        return f"no rows at threshold {threshold:g}"
    lines = [
        f"by {selected[0].attribute} at t={threshold:g}",
        "",
        f"{'group':<22}{'rubric':<8}{'cfg':<5}{'runs':>6}{'acc':>8}{'cover':>8}"
        f"{'incorr':>8}{'pen_score':>11}",
    ]
    for row in sorted(selected, key=lambda r: (r.group, r.rubric, r.config.value)):
        m = row.metrics
        lines.append(
            f"{row.group:<22}{row.rubric:<8}{row.config.value:<5}{m.n_total:>6}"
            f"{m.accuracy:>8.3f}{m.coverage:>8.3f}{m.incorrect_rate:>8.3f}"
            f"{m.mean_penalized_score:>11.3f}"
        )
    return "\n".join(lines)
