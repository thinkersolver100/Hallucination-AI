"""A free, deterministic stand-in for the paper's experiment.

The simulated model knows 40% of the answers. On the rest it guesses among four options
(25% right), picking independently for each sample. When the open rubric's threshold is above
its 25% guess odds it abstains instead. From these rules the expected outcomes are:

  closed rubric  baseline  : accuracy ~0.55, incorrect ~0.45
                 mitigation: accuracy ~0.44, incorrect ~0.11, abstains ~0.45
  open rubric t>=0.5       : accuracy ~0.40, incorrect 0, abstains ~0.60

which reproduces the qualitative findings of Kalai et al. (Nature, 2026).
"""
import json
import random
import re

import pytest
import pytest_asyncio

from haludec.evaluation import ExactMatchGrader
from haludec.experiments import ExperimentSettings, build_report, run_experiment
from haludec.providers import FakeProvider, GenRequest
from haludec.schemas import ConfigId, RiskLevel, TestCase

N_QUESTIONS = 600
KNOW_RATE = 0.4
GUESS_ODDS = 0.25


def question_number(prompt: str) -> int:
    match = re.search(r"Question number (\d+)\?", prompt)
    assert match is not None
    return int(match.group(1))


def knows(number: int) -> bool:
    return random.Random(f"know-{number}").random() < KNOW_RATE


def generate(req: GenRequest) -> str:
    number = question_number(req.prompt)
    if knows(number):
        return f"answer-{number}"
    rubric = re.search(r"Abstain if probability of being correct is < ([\d.]+)%", req.prompt)
    if rubric and float(rubric.group(1)) / 100 > GUESS_ODDS:
        return "I don't know"
    pick = random.Random(f"guess-{number}-{req.sample_index}").randrange(4)
    return f"answer-{number}" if pick == 0 else f"wrong-{number}-{pick}"


def judge(prompt: str) -> str:
    first = re.search(r"<response1>\n(.*?)\n</response1>", prompt, re.DOTALL)
    second = re.search(r"<response2>\n(.*?)\n</response2>", prompt, re.DOTALL)
    assert first is not None
    assert second is not None
    return json.dumps({"consistent": first.group(1).strip() == second.group(1).strip()})


def simulated_model(req: GenRequest) -> str:
    if req.system is None:
        return generate(req)
    if "consistent" in req.system:
        return judge(req.prompt)
    return '{"choice": 1}'


@pytest_asyncio.fixture(scope="function")
async def report():
    cases = [
        TestCase(
            id=f"Q{i:04d}",
            question=f"Question number {i}?",
            expected_answer=f"answer-{i}",
            abstention_allowed=True,
            risk_level=RiskLevel.MEDIUM,
            category="sim",
        )
        for i in range(N_QUESTIONS)
    ]
    settings = ExperimentSettings(experiment_id="SIM", model="sim-model")
    result = await run_experiment(
        cases, FakeProvider(simulated_model), ExactMatchGrader(), settings
    )
    assert result.failures == []
    return build_report(
        result.records, result.failures, settings.thresholds, n_resamples=2000, n_permutations=5000
    )


def metrics_of(report, config: ConfigId, t: float):
    return next(r.metrics for r in report.rows if r.config is config and r.threshold == t)


def comparison_of(report, mitigation: ConfigId, t: float):
    return next(
        c.comparison
        for c in report.comparisons
        if c.mitigation is mitigation and c.comparison.threshold == t
    )


async def test_closed_rubric_baseline_guesses(report) -> None:
    baseline = metrics_of(report, ConfigId.A_BASELINE, 0.0)
    assert baseline.accuracy == pytest.approx(0.55, abs=0.08)
    assert baseline.abstention_rate == 0.0


async def test_mitigation_trades_accuracy_for_fewer_errors(report) -> None:
    baseline = metrics_of(report, ConfigId.A_BASELINE, 0.0)
    mitigated = metrics_of(report, ConfigId.C_CONSISTENCY, 0.0)

    assert mitigated.accuracy < baseline.accuracy
    assert mitigated.incorrect_rate < baseline.incorrect_rate / 2
    assert mitigated.abstention_rate > 0.3
    assert comparison_of(report, ConfigId.C_CONSISTENCY, 0.0).mean_diff < 0


@pytest.mark.parametrize("t", [0.5, 0.75, 0.9])
async def test_closed_rubric_mitigation_wins_once_errors_are_penalized(report, t: float) -> None:
    comparison = comparison_of(report, ConfigId.C_CONSISTENCY, t)
    assert comparison.mean_diff > 0
    assert comparison.ci_low > 0
    assert comparison.p_value < 0.01


async def test_unmitigated_guessing_is_flagged_as_overconfident(report) -> None:
    assert metrics_of(report, ConfigId.A_BASELINE, 0.75).overconfident is True
    assert metrics_of(report, ConfigId.A_BASELINE, 0.9).overconfident is True


@pytest.mark.parametrize("config", [ConfigId.B_OPEN_RUBRIC, ConfigId.D_COMBINED])
@pytest.mark.parametrize("t", [0.5, 0.75, 0.9])
async def test_open_rubric_makes_the_model_abstain_instead_of_guess(
    report, config: ConfigId, t: float
) -> None:
    m = metrics_of(report, config, t)
    assert m.incorrect_rate == 0.0
    assert 0.5 < m.abstention_rate < 0.7
    assert m.overconfident is False


@pytest.mark.parametrize("config", [ConfigId.B_OPEN_RUBRIC, ConfigId.D_COMBINED])
async def test_open_rubric_at_zero_threshold_never_abstains(report, config: ConfigId) -> None:
    assert metrics_of(report, config, 0.0).abstention_rate == 0.0
