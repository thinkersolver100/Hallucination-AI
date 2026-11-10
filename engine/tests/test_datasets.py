from pathlib import Path

import pytest

from haludec.datasets import (
    load_cases_jsonl,
    load_simpleqa_csv,
    sample_cases,
    save_cases_jsonl,
)


def write_csv(path: Path, rows: list[tuple[str, str]]) -> Path:
    lines = ["metadata,problem,answer"]
    lines += [f'"{{}}","{problem}","{answer}"' for problem, answer in rows]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_load_simpleqa_csv(tmp_path: Path) -> None:
    csv_path = write_csv(tmp_path / "s.csv", [("Who?", "Ada"), ("When?", "1969")])

    cases = load_simpleqa_csv(csv_path)

    assert [c.id for c in cases] == ["SQA-0000", "SQA-0001"]
    assert cases[0].question == "Who?"
    assert cases[0].expected_answer == "Ada"
    assert all(c.abstention_allowed for c in cases)


def test_missing_columns_and_empty_values_are_rejected(tmp_path: Path) -> None:
    bad_header = tmp_path / "a.csv"
    bad_header.write_text("question,answer\nQ,A\n", encoding="utf-8")
    with pytest.raises(ValueError, match="missing columns"):
        load_simpleqa_csv(bad_header)

    empty_answer = write_csv(tmp_path / "b.csv", [("Who?", "")])
    with pytest.raises(ValueError, match="empty"):
        load_simpleqa_csv(empty_answer)


def test_sampling_is_seeded_sorted_and_bounded(tmp_path: Path) -> None:
    rows = [(f"Q{i}?", f"A{i}") for i in range(50)]
    cases = load_simpleqa_csv(write_csv(tmp_path / "s.csv", rows))

    first = sample_cases(cases, 10, seed=1)
    again = sample_cases(cases, 10, seed=1)
    other = sample_cases(cases, 10, seed=2)

    assert first == again
    assert first != other
    assert [c.id for c in first] == sorted(c.id for c in first)
    with pytest.raises(ValueError):
        sample_cases(cases, 51)
    with pytest.raises(ValueError):
        sample_cases(cases, 0)


def test_jsonl_round_trip(tmp_path: Path) -> None:
    cases = load_simpleqa_csv(write_csv(tmp_path / "s.csv", [("Who?", "Ada")]))
    target = tmp_path / "nested" / "cases.jsonl"

    save_cases_jsonl(cases, target)

    assert load_cases_jsonl(target) == cases
