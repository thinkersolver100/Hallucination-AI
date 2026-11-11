"""Evaluate one question under one rubric condition.

rubric_t is None for the closed rubric (plain question) or a threshold for the open rubric.

Closed rubric -> configs A (baseline) and C (consistency mitigation). Records carry
threshold 0.0 and are rescored at every threshold later (see report.rescore).
Open rubric   -> configs B (baseline) and D (consistency mitigation) at threshold rubric_t.

Both responses of a question are generated once and shared by the baseline and the
mitigation, as in the paper. The mitigation's cost includes both generations plus the judge.
Grading cost is not included in record costs; the CostTracker has the true total.
"""

import asyncio
from datetime import UTC, datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from haludec.evaluation import ABSTAIN_TEXT, GRADER_PROMPT_VERSION, Grader, GradingError
from haludec.mitigation import (
    CONSISTENCY_PROMPT_VERSION,
    SELECTION_PROMPT_VERSION,
    JudgeError,
    judge_consistency,
    select_better,
)
from haludec.providers import GenRequest, GenResponse, Provider, ProviderError
from haludec.rubric import RUBRIC_VERSION, STANDARD_THRESHOLDS, validate_threshold, with_rubric
from haludec.schemas import ConfigId, Label, RunRecord, TestCase

N_SAMPLES = 2
CLOSED_RUBRIC_VERSION = "closed"
PROMPT_VERSIONS = f"{CONSISTENCY_PROMPT_VERSION}+{SELECTION_PROMPT_VERSION}+{GRADER_PROMPT_VERSION}"


class ExperimentSettings(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    experiment_id: str = Field(min_length=1)
    model: str = Field(min_length=1)
    judge_model: str | None = None  # defaults to the model under test, as in the paper
    thresholds: tuple[float, ...] = STANDARD_THRESHOLDS
    temperature: float = Field(default=1.0, ge=0.0, le=2.0)
    max_tokens: int = Field(default=1024, gt=0)
    judge_max_tokens: int = Field(default=256, gt=0)
    concurrency: int = Field(default=8, ge=1)
    system_prompt: str | None = None  # agent context, e.g. policies
    grader_version: str = GRADER_PROMPT_VERSION

    @field_validator("thresholds")
    @classmethod
    def _check_thresholds(cls, v: tuple[float, ...]) -> tuple[float, ...]:
        if not v:
            raise ValueError("at least one threshold is required")
        if len(set(v)) != len(v):
            raise ValueError("thresholds must be unique")
        for t in v:
            validate_threshold(t)
        return v

    @property
    def effective_judge_model(self) -> str:
        return self.judge_model or self.model


class CaseFailureError(Exception):
    """One question could not be evaluated. stage is generate, grade or judge."""

    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage


def _prompt_versions(settings: ExperimentSettings) -> str:
    return f"{CONSISTENCY_PROMPT_VERSION}+{SELECTION_PROMPT_VERSION}+{settings.grader_version}"


async def _generate_pair(
    provider: Provider, settings: ExperimentSettings, prompt: str
) -> list[GenResponse]:
    requests = [
        GenRequest(
            model=settings.model,
            prompt=prompt,
            system=settings.system_prompt,
            temperature=settings.temperature,
            max_tokens=settings.max_tokens,
            sample_index=k,
        )
        for k in range(N_SAMPLES)
    ]
    try:
        return list(await asyncio.gather(*(provider.generate(r) for r in requests)))
    except ProviderError as exc:
        raise CaseFailureError("generate", str(exc)) from exc


async def _grade_pair(grader: Grader, case: TestCase, responses: list[GenResponse]) -> list[Label]:
    try:
        return list(
            await asyncio.gather(
                *(grader.grade(case.question, case.expected_answer, r.text) for r in responses)
            )
        )
    except (GradingError, ProviderError) as exc:
        raise CaseFailureError("grade", str(exc)) from exc


def _record(
    *,
    settings: ExperimentSettings,
    case: TestCase,
    rubric_t: float | None,
    config: ConfigId,
    threshold: float,
    rubric_version: str,
    sample_index: int,
    text: str,
    label: Label,
    judge_decision: bool | None,
    latency_ms: float,
    tokens_in: int,
    tokens_out: int,
    cost_usd: float,
) -> RunRecord:
    tag = "closed" if rubric_t is None else f"t{rubric_t:g}"
    return RunRecord(
        run_id=f"{settings.experiment_id}:{case.id}:{config.value}:{tag}:s{sample_index}",
        experiment_id=settings.experiment_id,
        test_case_id=case.id,
        config=config,
        threshold=threshold,
        sample_index=sample_index,
        model_id=settings.model,
        prompt_version=_prompt_versions(settings),
        rubric_version=rubric_version,
        response_text=text,
        label=label,
        judge_decision=judge_decision,
        latency_ms=latency_ms,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=cost_usd,
        timestamp=datetime.now(UTC),
    )


async def evaluate_case(
    case: TestCase,
    rubric_t: float | None,
    *,
    provider: Provider,
    grader: Grader,
    settings: ExperimentSettings,
) -> list[RunRecord]:
    """Return two baseline records (one per sample) and one mitigated record.

    Raises CaseFailureError for per-question problems. BudgetExceededError propagates untouched.
    """
    if rubric_t is None:
        prompt = case.question
        base_config, mit_config = ConfigId.A_BASELINE, ConfigId.C_CONSISTENCY
        threshold, rubric_version = 0.0, CLOSED_RUBRIC_VERSION
    else:
        prompt = with_rubric(case.question, rubric_t)
        base_config, mit_config = ConfigId.B_OPEN_RUBRIC, ConfigId.D_COMBINED
        threshold, rubric_version = rubric_t, RUBRIC_VERSION

    responses = await _generate_pair(provider, settings, prompt)
    labels = await _grade_pair(grader, case, responses)

    judge_model = settings.effective_judge_model
    r0, r1 = responses[0].text, responses[1].text
    try:
        if rubric_t == 0.0:
            # Abstaining cannot help when the rubric forbids it, so pick the better response.
            choice, usage = await select_better(
                provider, judge_model, prompt, r0, r1, max_tokens=settings.judge_max_tokens
            )
            decision: bool | None = None
            label = labels[choice]
            text = responses[choice].text
        else:
            consistent, usage = await judge_consistency(
                provider, judge_model, prompt, r0, r1, max_tokens=settings.judge_max_tokens
            )
            decision = consistent
            label = labels[0] if consistent else Label.ABSTAINED
            # label = label[0]
            text = r0 if consistent else ABSTAIN_TEXT
    except (JudgeError, ProviderError) as exc:
        raise CaseFailureError("judge", str(exc)) from exc

    records = [
        _record(
            settings=settings,
            case=case,
            rubric_t=rubric_t,
            config=base_config,
            threshold=threshold,
            rubric_version=rubric_version,
            sample_index=k,
            text=resp.text,
            label=labels[k],
            judge_decision=None,
            latency_ms=resp.latency_ms,
            tokens_in=resp.tokens_in,
            tokens_out=resp.tokens_out,
            cost_usd=resp.cost_usd,
        )
        for k, resp in enumerate(responses)
    ]
    records.append(
        _record(
            settings=settings,
            case=case,
            rubric_t=rubric_t,
            config=mit_config,
            threshold=threshold,
            rubric_version=rubric_version,
            sample_index=0,
            text=text,
            label=label,
            judge_decision=decision,
            latency_ms=max(r.latency_ms for r in responses) + usage.latency_ms,
            tokens_in=sum(r.tokens_in for r in responses) + usage.tokens_in,
            tokens_out=sum(r.tokens_out for r in responses) + usage.tokens_out,
            cost_usd=sum(r.cost_usd for r in responses) + usage.cost_usd,
        )
    )
    return records
