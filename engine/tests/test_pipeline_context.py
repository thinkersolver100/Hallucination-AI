from haludec.evaluation import ExactMatchGrader
from haludec.experiments import ExperimentSettings, evaluate_case
from haludec.providers import FakeProvider, GenRequest
from haludec.schemas import RiskLevel, TestCase

CASE = TestCase(
    id="Q1",
    question="Capital of France?",
    expected_answer="Paris",
    abstention_allowed=False,
    risk_level=RiskLevel.LOW,
    category="geo",
)


def responder(req: GenRequest) -> str:
    if req.system == "AGENT-SYSTEM":
        return "Paris"
    return '{"consistent": true}'


async def test_agent_context_reaches_the_generations_and_nothing_else() -> None:
    settings = ExperimentSettings(
        experiment_id="EXP",
        model="gen",
        system_prompt="AGENT-SYSTEM",
        grader_version="policy-grader-v1",
    )
    fake = FakeProvider(responder)

    records = await evaluate_case(
        CASE, None, provider=fake, grader=ExactMatchGrader(), settings=settings
    )

    generations = [c for c in fake.calls if c.system == "AGENT-SYSTEM"]
    others = [c for c in fake.calls if c.system != "AGENT-SYSTEM"]
    assert len(generations) == 2
    assert len(others) == 1  # the consistency judge keeps its own instructions
    assert all(r.prompt_version.endswith("policy-grader-v1") for r in records)


async def test_without_a_system_prompt_generations_carry_none() -> None:
    settings = ExperimentSettings(experiment_id="EXP", model="gen")
    fake = FakeProvider(lambda req: "Paris" if req.system is None else '{"consistent": true}')

    await evaluate_case(CASE, None, provider=fake, grader=ExactMatchGrader(), settings=settings)

    assert sum(1 for c in fake.calls if c.system is None) == 2
