"""Conversion and validation of the abstention threshold t and error penalty L.

Relationship (Kalai et al., Nature 2026):  t = L / (1 + L)  and  L = t / (1 - t).
t is an *incentive setting*: answer only if you believe P(correct) > t.
It is not a measured confidence of the model.
"""

import math

from haludec.schemas import MAX_THRESHOLD

# The thresholds tested in the paper, with penalties L = 0, 1, 3, 9.
STANDARD_THRESHOLDS: tuple[float, ...] = (0.0, 0.5, 0.75, 0.9)

# Float round-trips (t -> L -> t) can overshoot the cap by a hair.
_TOLERANCE = 1e-9


def validate_threshold(t: float) -> float:
    """Return t unchanged if it lies in [0, MAX_THRESHOLD], else raise ValueError.

    t = 1 is refused because the equivalent penalty L would be infinite.
    NaN and infinity are refused too.
    """
    if not math.isfinite(t) or t < 0.0 or t > MAX_THRESHOLD:
        raise ValueError(f"threshold must be in [0, {MAX_THRESHOLD}], got {t!r}")
    return t


def penalty_from_t(t: float) -> float:
    """Error penalty L = t / (1 - t) for an abstention reward t."""
    validate_threshold(t)
    return t / (1.0 - t)


def t_from_penalty(penalty: float) -> float:
    """Abstention reward t = L / (1 + L) for an error penalty L >= 0."""
    if not math.isfinite(penalty) or penalty < 0.0:
        raise ValueError(f"penalty must be a finite number >= 0, got {penalty!r}")
    t = penalty / (1.0 + penalty)
    if t > MAX_THRESHOLD and math.isclose(t, MAX_THRESHOLD, abs_tol=_TOLERANCE):
        t = MAX_THRESHOLD
    return validate_threshold(t)
