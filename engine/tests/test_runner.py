from pathlib import Path

import pytest

from haludec.evaluation import ExactMatchGrader
from haludec.experiments import ExperimentSettings, read_records, run_experiment
from haludec.providers import (
    BudgetExceededError,
    CostTracker,
    FakeProvider,
    GenRequest,
    Pricing,
    TrackingProvider,
)
from haludec.schemas import RiskLevel, TestCase


def make_cases(n: int) -> list[TestCase]:
    return [
        TestCase(
            id=f"Q{i}",
            question=f"Question number {i}?",
            expected_answer=f"answer-{i}",
            abstention_allowed=True,
            risk_level=RiskLevel.MEDIUM,
            category="t",
        )
        for i in range(n)
    ]


def answer_correctly(req: GenRequest) -> str:
    if req.system is None:
        number = req.prompt.split("Question number ")[1].split("?")[0]
        return f"answer-{number}"
    return '{"consistent": true}' if "consistent" in req.system else '{"choice": 1}'


SETTINGS = ExperimentSettings(experiment_id="EXP", model="m", thresholds=(0.0, 0.5))


async def test_every_question_runs_under_every_condition(tmp_path: Path) -> None:
    result = await run_experiment(
        make_cases(3),
        FakeProvider(answer_correctly),
        ExactMatchGrader(),
        SETTINGS,
        out_dir=tmp_path,
    )

    # 3 questions x (closed + 2 thresholds) x 3 records
    assert len(result.records) == 27
    assert result.failures == []
    assert read_records(tmp_path / "records.jsonl").__len__() == 27
    assert (tmp_path / "failures.jsonl").read_text(encoding="utf-8") == ""
    keys = [(r.test_case_id, r.config.value, r.threshold, r.sample_index) for r in result.records]
    assert keys == sorted(keys)
    assert len({r.run_id for r in result.records}) == 27


async def test_a_failing_question_is_excluded_and_reported(tmp_path: Path) -> None:
    def responder(req: GenRequest) -> str:
        if req.system is None and "Question number 1?" in req.prompt:
            return ""
        return answer_correctly(req)

    result = await run_experiment(
        make_cases(3), FakeProvider(responder), ExactMatchGrader(), SETTINGS, out_dir=tmp_path
    )

    assert {r.test_case_id for r in result.records} == {"Q0", "Q2"}
    assert len(result.failures) == 3  # closed + two thresholds
    assert {f.test_case_id for f in result.failures} == {"Q1"}
    assert {f.stage for f in result.failures} == {"grade"}
    assert {f.rubric_t for f in result.failures} == {None, 0.0, 0.5}
    assert len((tmp_path / "failures.jsonl").read_text(encoding="utf-8").splitlines()) == 3


async def test_budget_exhaustion_aborts_the_run(tmp_path: Path) -> None:
    priced = Pricing(input_per_mtok=1_000_000.0, output_per_mtok=1_000_000.0)
    fake = FakeProvider(answer_correctly, pricing=priced)
    provider = TrackingProvider(fake, CostTracker(budget_usd=1.0))

    with pytest.raises(BudgetExceededError):
        await run_experiment(
            make_cases(5), provider, ExactMatchGrader(), SETTINGS, out_dir=tmp_path
        )

    assert (tmp_path / "records.jsonl").exists()


async def test_without_an_output_directory_nothing_is_written() -> None:
    result = await run_experiment(
        make_cases(1), FakeProvider(answer_correctly), ExactMatchGrader(), SETTINGS
    )
    assert len(result.records) == 9
