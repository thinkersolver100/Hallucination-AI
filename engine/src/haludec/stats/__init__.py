"""Paired statistics for comparing configurations."""

from haludec.stats.compare import Comparison, align_scores, compare_configs, per_question_scores
from haludec.stats.resampling import (
    EXACT_MAX_N,
    ConfidenceInterval,
    bootstrap_ci,
    paired_bootstrap_ci,
    paired_permutation_test,
)

__all__ = [
    "EXACT_MAX_N",
    "Comparison",
    "ConfidenceInterval",
    "align_scores",
    "bootstrap_ci",
    "compare_configs",
    "paired_bootstrap_ci",
    "paired_permutation_test",
    "per_question_scores",
]
