"""Detection of explicit abstentions.

Deliberately conservative: only a whole-response match of a few canonical phrases counts.
Anything longer ("I can't be sure, but I'd guess Paris") goes to the grader, which decides
whether an answer was actually given. Wrongly claiming an abstention would hide a possible
hallucination, so we claim it only when it is unambiguous.
"""

import re

# What the mitigation (Phase 4) emits when it abstains.
ABSTAIN_TEXT = "I don't know"

_CANONICAL = frozenset(
    {
        "i don't know",
        "i do not know",
        "i dont know",
        "idk",
        "i'm not sure",
        "i am not sure",
        "not sure",
        "unknown",
        "no answer",
        "i don't know the answer",
        "i do not know the answer",
        "i cannot answer",
        "i can't answer",
        "i cannot answer that",
        "i can't answer that",
    }
)

_SPACES = re.compile(r"\s+")


def _normalize(text: str) -> str:
    lowered = text.lower().replace("\u2019", "'").replace("\u2018", "'")
    collapsed = _SPACES.sub(" ", lowered).strip()
    return collapsed.rstrip(".! ").strip()


def is_abstention(text: str) -> bool:
    """True only when the whole response is a canonical "I don't know" style phrase."""
    return _normalize(text) in _CANONICAL
