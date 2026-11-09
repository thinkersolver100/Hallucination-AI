"""Core data contracts shared by every engine module.

These models are the single source of truth. The API layer will generate its
TypeScript types from them (Phase 6), so keep them small and explicit.
"""

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator

# The paper tests t in {0, 0.5, 0.75, 0.9}. At t = 1 the equivalent error
# penalty L = t / (1 - t) is infinite, so we refuse it.
MAX_THRESHOLD = 0.9


class Label(StrEnum):
    """Outcome of grading one response."""

    CORRECT = "correct"
    ABSTAINED = "abstained"
    INCORRECT = "incorrect"


class ConfigId(StrEnum):
    """The four experimental configurations."""

    A_BASELINE = "A"  # original model, no mitigation
    B_OPEN_RUBRIC = "B"  # open-rubric prompt only
    C_CONSISTENCY = "C"  # dual-generation consistency only
    D_COMBINED = "D"  # open rubric + consistency + evidence verification


class RiskLevel(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class _Frozen(BaseModel):
    """Immutable, strict base: unknown fields are errors, not silently dropped."""

    model_config = ConfigDict(frozen=True, extra="forbid")


class TestCase(_Frozen):
    """One question with a verified answer. Expected answers are never invented."""

    __test__ = False  # stop pytest from trying to collect this class

    id: str = Field(min_length=1)
    question: str = Field(min_length=1)
    expected_answer: str = Field(min_length=1)
    reference_doc_ids: list[str] = Field(default_factory=list)
    abstention_allowed: bool
    risk_level: RiskLevel
    category: str = Field(min_length=1)


class RunRecord(_Frozen):
    """One response for one (question, config, threshold, sample).

    Written once and never edited, so experiments stay auditable.
    """

    run_id: str = Field(min_length=1)
    experiment_id: str = Field(min_length=1)
    test_case_id: str = Field(min_length=1)
    config: ConfigId
    threshold: float = Field(ge=0.0, le=MAX_THRESHOLD)
    sample_index: int = Field(ge=0)
    model_id: str = Field(min_length=1)
    prompt_version: str = Field(min_length=1)
    rubric_version: str = Field(min_length=1)
    response_text: str
    label: Label
    judge_decision: bool | None = None  # None when no consistency judge was used
    latency_ms: float = Field(ge=0)
    tokens_in: int = Field(ge=0)
    tokens_out: int = Field(ge=0)
    cost_usd: float = Field(ge=0)
    timestamp: datetime

    @field_validator("timestamp")
    @classmethod
    def _require_timezone(cls, v: datetime) -> datetime:
        if v.tzinfo is None or v.utcoffset() is None:
            raise ValueError("timestamp must be timezone-aware")
        return v
