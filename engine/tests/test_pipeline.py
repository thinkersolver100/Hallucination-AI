import pytest

from haludec.evaluation import ABSTAIN_TEXT, ExactMatchGrader
from haludec.experiments import CaseFailureError, ExperimentSettings, evaluate_case
from haludec.providers import (
    BudgetExceededError,
    FakeProvider,
    GenRequest,
    Pricing,
    ProviderError,
)
from haludec.schemas import ConfigId, Label, RiskLevel, TestCase

CASE = TestCase(
    id="Q1",
    question="Capital of France?",
    expected_answer="Paris",
    abstention_allowed=True,
    risk_level=RiskLevel.MEDIUM,
    category="geo",
)
SETTINGS = ExperimentSettings(experiment_id="EXP", model="gen-model", judge_model="judge-model")
CONSISTENT = '{"consistent": true}'
INCONSISTENT = '{"consistent": false}'


def scripted(texts: tuple[str, str], verdict: str = CONSISTENT):
    def responder(req: GenRequest) -> str:
        if req.system is None:
            return texts[req.sample_index]
        return verdict

    return responder


async def run(fake: FakeProvider, rubric_t: float | None):
    return await evaluate_case(
        CASE, rubric_t, provider=fake, grader=ExactMatchGrader(), settings=SETTINGS
    )


async def test_closed_rubric_consistent_and_correct() -> None:
    fake = FakeProvider(scripted(("Paris", "It is Paris")))

    records = await run(fake, None)

    assert [r.config for r in records] == [ConfigId.A_BASELINE] * 2 + [ConfigId.C_CONSISTENCY]
    assert [r.sample_index for r in records] == [0, 1, 0]
    assert [r.label for r in records] == [Label.CORRECT] * 3
    mitigated = records[2]
    assert mitigated.judge_decision is True
    assert mitigated.response_text == "Paris"
    assert all(r.threshold == 0.0 for r in records)
    assert all(r.rubric_version == "closed" for r in records)
    assert len({r.run_id for r in records}) == 3


async def test_closed_rubric_inconsistent_responses_abstain() -> None:
    fake = FakeProvider(scripted(("Paris", "Lyon"), INCONSISTENT))

    records = await run(fake, None)

    assert [r.label for r in records[:2]] == [Label.CORRECT, Label.INCORRECT]
    mitigated = records[2]
    assert mitigated.label is Label.ABSTAINED
    assert mitigated.response_text == ABSTAIN_TEXT
    assert mitigated.judge_decision is False


async def test_open_rubric_sends_the_rubric_to_generation_and_judge() -> None:
    fake = FakeProvider(scripted(("Paris", "Paris")))

    records = await run(fake, 0.75)

    assert [r.config for r in records] == [ConfigId.B_OPEN_RUBRIC] * 2 + [ConfigId.D_COMBINED]
    assert all(r.threshold == 0.75 for r in records)
    assert all(r.rubric_version != "closed" for r in records)
    generation_prompts = [c.prompt for c in fake.calls if c.system is None]
    judge_prompts = [c.prompt for c in fake.calls if c.system is not None]
    assert all("scored at 75% correct" in p for p in generation_prompts)
    assert all("scored at 75% correct" in p for p in judge_prompts)


async def test_zero_threshold_uses_the_selector_and_never_abstains() -> None:
    fake = FakeProvider(scripted(("Lyon", "Paris"), '{"choice": 2}'))

    records = await run(fake, 0.0)

    mitigated = records[2]
    assert mitigated.config is ConfigId.D_COMBINED
    assert mitigated.judge_decision is None
    assert mitigated.response_text == "Paris"
    assert mitigated.label is Label.CORRECT


async def test_mitigated_cost_is_both_generations_plus_the_judge() -> None:
    priced = Pricing(input_per_mtok=1_000_000.0, output_per_mtok=1_000_000.0)
    fake = FakeProvider(scripted(("Paris", "Paris")), pricing=priced)

    records = await run(fake, None)

    base_cost = records[0].cost_usd + records[1].cost_usd
    assert records[2].cost_usd > base_cost
    assert records[2].tokens_in > records[0].tokens_in + records[1].tokens_in
    assert records[2].latency_ms >= max(records[0].latency_ms, records[1].latency_ms)


async def test_empty_generation_is_a_grade_failure_not_an_abstention() -> None:
    fake = FakeProvider(scripted(("", "Paris")))
    with pytest.raises(CaseFailureError) as exc_info:
        await run(fake, None)
    assert exc_info.value.stage == "grade"
    assert all(c.system is None for c in fake.calls)  # no judge call was spent


async def test_generation_error_is_a_generate_failure() -> None:
    fake = FakeProvider(errors=[ProviderError("a"), ProviderError("b")])
    with pytest.raises(CaseFailureError) as exc_info:
        await run(fake, None)
    assert exc_info.value.stage == "generate"


async def test_unreadable_judge_output_is_a_judge_failure() -> None:
    fake = FakeProvider(scripted(("Paris", "Paris"), "I think they match."))
    with pytest.raises(CaseFailureError) as exc_info:
        await run(fake, None)
    assert exc_info.value.stage == "judge"


async def test_budget_errors_propagate_instead_of_becoming_failures() -> None:
    fake = FakeProvider(errors=[BudgetExceededError("cap reached")])
    with pytest.raises(BudgetExceededError):
        await run(fake, None)


def test_settings_validation() -> None:
    with pytest.raises(ValueError):
        ExperimentSettings(experiment_id="E", model="m", thresholds=())
    with pytest.raises(ValueError):
        ExperimentSettings(experiment_id="E", model="m", thresholds=(0.5, 0.5))
    with pytest.raises(ValueError):
        ExperimentSettings(experiment_id="E", model="m", thresholds=(1.0,))
    assert SETTINGS.effective_judge_model == "judge-model"
    assert ExperimentSettings(experiment_id="E", model="m").effective_judge_model == "m"
