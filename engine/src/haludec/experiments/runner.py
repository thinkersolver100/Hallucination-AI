"""Run an experiment: every question under the closed rubric and each open-rubric threshold.

Results are appended to records.jsonl and failures.jsonl as they complete, so a run stopped
by the budget cap keeps everything finished so far. Rerunning with the same response cache
makes the finished work free.
"""

import asyncio
from pathlib import Path

from pydantic import BaseModel, ConfigDict

from haludec.evaluation import Grader
from haludec.experiments.pipeline import CaseFailureError, ExperimentSettings, evaluate_case
from haludec.providers import BudgetExceededError, Provider
from haludec.schemas import RunRecord, TestCase


class Failure(BaseModel):
    """A question-condition that could not be evaluated. rubric_t None means closed rubric."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    test_case_id: str
    rubric_t: float | None
    stage: str
    error: str


class ExperimentResult(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    records: list[RunRecord]
    failures: list[Failure]


def _append(path: Path | None, line: str) -> None:
    if path is None:
        return
    with path.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def read_records(path: Path) -> list[RunRecord]:
    lines = path.read_text(encoding="utf-8").splitlines()
    return [RunRecord.model_validate_json(line) for line in lines if line.strip()]


async def run_experiment(
    cases: list[TestCase],
    provider: Provider,
    grader: Grader,
    settings: ExperimentSettings,
    *,
    out_dir: Path | None = None,
) -> ExperimentResult:
    records_path: Path | None = None
    failures_path: Path | None = None
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        records_path = out_dir / "records.jsonl"
        failures_path = out_dir / "failures.jsonl"
        records_path.write_text("", encoding="utf-8")
        failures_path.write_text("", encoding="utf-8")

    conditions: list[float | None] = [None, *settings.thresholds]
    semaphore = asyncio.Semaphore(settings.concurrency)
    records: list[RunRecord] = []
    failures: list[Failure] = []

    async def worker(case: TestCase, rubric_t: float | None) -> None:
        async with semaphore:
            try:
                produced = await evaluate_case(
                    case, rubric_t, provider=provider, grader=grader, settings=settings
                )
            except CaseFailureError as exc:
                failure = Failure(
                    test_case_id=case.id, rubric_t=rubric_t, stage=exc.stage, error=str(exc)
                )
                failures.append(failure)
                _append(failures_path, failure.model_dump_json())
                return
        records.extend(produced)
        for record in produced:
            _append(records_path, record.model_dump_json())

    try:
        async with asyncio.TaskGroup() as group:
            for case in cases:
                for rubric_t in conditions:
                    group.create_task(worker(case, rubric_t))
    except* BudgetExceededError as budget_group:
        raise budget_group.exceptions[0] from None

    records.sort(key=lambda r: (r.test_case_id, r.config.value, r.threshold, r.sample_index))
    failures.sort(key=lambda f: (f.test_case_id, -1.0 if f.rubric_t is None else f.rubric_t))
    return ExperimentResult(records=records, failures=failures)
