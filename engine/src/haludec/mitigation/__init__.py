"""The consistency-based hallucination mitigation."""

from haludec.mitigation.judges import (
    CONSISTENCY_PROMPT_VERSION,
    SELECTION_PROMPT_VERSION,
    JudgeError,
    Usage,
    build_judge_prompt,
    judge_consistency,
    select_better,
)

__all__ = [
    "CONSISTENCY_PROMPT_VERSION",
    "SELECTION_PROMPT_VERSION",
    "JudgeError",
    "Usage",
    "build_judge_prompt",
    "judge_consistency",
    "select_better",
]
