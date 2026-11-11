"""Request and response contracts of the engine service.

Every size and format limit here is deliberate: the service is internal, but it spends money,
so it validates as if the caller could be wrong or compromised.
"""

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from haludec.experiments import BreakdownRow, Failure, Report
from haludec.rubric import validate_threshold
from haludec.schemas import RunRecord, TestCase

POLICY_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
MAX_POLICY_CHARS = 200_000


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EvaluateCaseRequest(_Request):
    experiment_id: str = Field(min_length=1, max_length=128)
    case: TestCase
    rubric_t: float | None = None  # None = closed rubric
    model: str = Field(min_length=1, max_length=200)
    judge_model: str | None = Field(default=None, min_length=1, max_length=200)
    grader_model: str = Field(min_length=1, max_length=200)
    grader: Literal["llm", "policy"] = "policy"
    temperature: float = Field(default=1.0, ge=0.0, le=2.0)
    max_tokens: int = Field(default=1024, gt=0, le=8192)
    judge_max_tokens: int = Field(default=256, gt=0, le=2048)
    policies: dict[str, str] = Field(default_factory=dict)
    company_name: str = Field(
        default="the company", min_length=1, max_length=120, pattern=r"^[^\r\n]+$"
    )
    budget_usd: float = Field(gt=0)

    @field_validator("rubric_t")
    @classmethod
    def _check_threshold(cls, v: float | None) -> float | None:
        if v is not None:
            validate_threshold(v)
        return v

    @field_validator("policies")
    @classmethod
    def _check_policies(cls, v: dict[str, str]) -> dict[str, str]:
        bad = [key for key in v if not POLICY_ID.match(key)]
        if bad:
            raise ValueError(f"invalid policy document ids: {bad[:3]}")
        if any(not text.strip() for text in v.values()):
            raise ValueError("policy documents must not be empty")
        if sum(len(text) for text in v.values()) > MAX_POLICY_CHARS:
            raise ValueError("policy documents are too large")
        return v


class EvaluateCaseResponse(BaseModel):
    status: Literal["ok", "failed", "budget_exceeded"]
    spend_usd: float
    paid_calls: int
    cached_calls: int
    records: list[RunRecord] = Field(default_factory=list)
    stage: str | None = None
    error: str | None = None


class ReportRequest(_Request):
    cases: list[TestCase] = Field(min_length=1, max_length=5000)
    records: list[RunRecord] = Field(min_length=1, max_length=50_000)
    failures: list[Failure] = Field(default_factory=list, max_length=50_000)
    thresholds: list[float] = Field(min_length=1, max_length=8)
    seed: int = 0

    @field_validator("thresholds")
    @classmethod
    def _check_thresholds(cls, v: list[float]) -> list[float]:
        for t in v:
            validate_threshold(t)
        if len(set(v)) != len(v):
            raise ValueError("thresholds must be unique")
        return v

    @field_validator("cases")
    @classmethod
    def _unique_case_ids(cls, v: list[TestCase]) -> list[TestCase]:
        ids = [case.id for case in v]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate case ids")
        return v


class ReportResponse(BaseModel):
    report: Report
    by_category: list[BreakdownRow]
    by_risk_level: list[BreakdownRow]


class ModelsResponse(BaseModel):
    models: list[str]
