"""Open-rubric engine: thresholds, rubric text and scoring."""

from haludec.rubric.rubric_text import RUBRIC_VERSION, RubricStyle, rubric_text, with_rubric
from haludec.rubric.scoring import always_abstain_score, mean_score, penalized_score, score
from haludec.rubric.thresholds import (
    STANDARD_THRESHOLDS,
    penalty_from_t,
    t_from_penalty,
    validate_threshold,
)

__all__ = [
    "RUBRIC_VERSION",
    "STANDARD_THRESHOLDS",
    "RubricStyle",
    "always_abstain_score",
    "mean_score",
    "penalized_score",
    "penalty_from_t",
    "rubric_text",
    "score",
    "t_from_penalty",
    "validate_threshold",
    "with_rubric",
]
