"""Paired resampling statistics: bootstrap confidence intervals and a permutation test.

"Paired" means position i in both inputs is the same question, so we work on per-question
differences. Results are reproducible through the seed argument. Large resampling jobs are
processed in chunks so memory use stays small even for thousands of questions.
"""

from dataclasses import dataclass

import numpy as np
from numpy.typing import ArrayLike, NDArray

FloatArray = NDArray[np.float64]

# At or below this many questions every sign pattern is enumerated exactly (2^n <= 65,536).
EXACT_MAX_N = 16

_CHUNK_ELEMENTS = 2_000_000  # cap on the size of one resampling matrix
_EQUALITY_TOLERANCE = 1e-12


@dataclass(frozen=True)
class ConfidenceInterval:
    estimate: float
    low: float
    high: float
    level: float


def _as_array(values: ArrayLike, name: str) -> FloatArray:
    arr = np.asarray(values, dtype=np.float64)
    if arr.ndim != 1 or arr.size == 0:
        raise ValueError(f"{name} must be a non-empty 1-D sequence")
    if not np.all(np.isfinite(arr)):
        raise ValueError(f"{name} must contain only finite numbers")
    return arr


def _differences(a: ArrayLike, b: ArrayLike) -> FloatArray:
    x = _as_array(a, "a")
    y = _as_array(b, "b")
    if x.shape != y.shape:
        raise ValueError("paired samples must have the same length")
    return x - y


def _chunk_rows(n: int) -> int:
    return max(1, _CHUNK_ELEMENTS // n)


def bootstrap_ci(
    values: ArrayLike,
    *,
    n_resamples: int = 10_000,
    level: float = 0.95,
    seed: int = 0,
) -> ConfidenceInterval:
    """Percentile bootstrap confidence interval for the mean of values."""
    x = _as_array(values, "values")
    if n_resamples < 1:
        raise ValueError("n_resamples must be >= 1")
    if not 0.0 < level < 1.0:
        raise ValueError("level must be strictly between 0 and 1")

    n = x.size
    rng = np.random.default_rng(seed)
    means = np.empty(n_resamples, dtype=np.float64)
    rows = _chunk_rows(n)
    done = 0
    while done < n_resamples:
        m = min(rows, n_resamples - done)
        idx = rng.integers(0, n, size=(m, n))
        means[done : done + m] = x[idx].mean(axis=1)
        done += m

    alpha = (1.0 - level) / 2.0
    return ConfidenceInterval(
        estimate=float(x.mean()),
        low=float(np.quantile(means, alpha)),
        high=float(np.quantile(means, 1.0 - alpha)),
        level=level,
    )


def paired_bootstrap_ci(
    a: ArrayLike,
    b: ArrayLike,
    *,
    n_resamples: int = 10_000,
    level: float = 0.95,
    seed: int = 0,
) -> ConfidenceInterval:
    """Confidence interval for mean(a - b) over paired questions."""
    return bootstrap_ci(_differences(a, b), n_resamples=n_resamples, level=level, seed=seed)


def paired_permutation_test(
    a: ArrayLike,
    b: ArrayLike,
    *,
    n_permutations: int = 200_000,
    seed: int = 0,
    exact_max_n: int = EXACT_MAX_N,
) -> float:
    """Two-sided paired permutation (sign-flip) test on the mean difference.

    Under the null hypothesis the sign of each per-question difference is arbitrary.
    Small inputs are enumerated exactly; larger ones are sampled and the p-value is
    (hits + 1) / (n_permutations + 1), which can never be exactly zero.
    """
    d = _differences(a, b)
    if n_permutations < 1:
        raise ValueError("n_permutations must be >= 1")

    n = d.size
    observed = abs(float(d.mean()))
    threshold = observed - _EQUALITY_TOLERANCE * max(1.0, float(np.max(np.abs(d))))

    if n <= exact_max_n:
        patterns = (np.arange(2**n)[:, None] >> np.arange(n)) & 1
        signs = 1.0 - 2.0 * patterns
        stats = np.abs(signs @ d) / n
        return float(np.mean(stats >= threshold))

    rng = np.random.default_rng(seed)
    rows = _chunk_rows(n)
    hits = 0
    done = 0
    while done < n_permutations:
        m = min(rows, n_permutations - done)
        signs = rng.integers(0, 2, size=(m, n)).astype(np.float64) * 2.0 - 1.0
        stats = np.abs(signs @ d) / n
        hits += int(np.count_nonzero(stats >= threshold))
        done += m
    return (hits + 1) / (n_permutations + 1)
