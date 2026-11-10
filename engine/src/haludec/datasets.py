"""Loading and sampling question sets.

SimpleQA (Wei et al., 2024; MIT licence) is a CSV with columns metadata, problem, answer.
Cases are stored as JSON Lines, one TestCase per line.
"""

import csv
import random
from collections.abc import Sequence
from pathlib import Path

from haludec.schemas import RiskLevel, TestCase


def load_simpleqa_csv(path: Path | str) -> list[TestCase]:
    with Path(path).open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        missing = {"problem", "answer"} - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"CSV is missing columns: {sorted(missing)}")
        cases: list[TestCase] = []
        for index, row in enumerate(reader):
            question = (row["problem"] or "").strip()
            answer = (row["answer"] or "").strip()
            if not question or not answer:
                raise ValueError(f"row {index}: empty problem or answer")
            cases.append(
                TestCase(
                    id=f"SQA-{index:04d}",
                    question=question,
                    expected_answer=answer,
                    abstention_allowed=True,  # SimpleQA has a "not attempted" outcome
                    risk_level=RiskLevel.MEDIUM,
                    category="simpleqa",
                )
            )
    return cases


def sample_cases(cases: Sequence[TestCase], n: int, seed: int = 0) -> list[TestCase]:
    """A seeded random sample, returned in id order so the same seed gives the same file."""
    if n < 1 or n > len(cases):
        raise ValueError(f"n must be between 1 and {len(cases)}, got {n}")
    return sorted(random.Random(seed).sample(list(cases), n), key=lambda c: c.id)


def save_cases_jsonl(cases: Sequence[TestCase], path: Path | str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("".join(case.model_dump_json() + "\n" for case in cases), encoding="utf-8")


def load_cases_jsonl(path: Path | str) -> list[TestCase]:
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    return [TestCase.model_validate_json(line) for line in lines if line.strip()]
