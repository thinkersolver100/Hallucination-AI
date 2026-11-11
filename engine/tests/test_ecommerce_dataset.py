"""Checks on the dataset that ships with the repo."""

from pathlib import Path

from haludec.benchmark import (
    CATEGORY_TARGETS,
    build_agent_system_prompt,
    category_counts,
    load_policies,
    validate_benchmark,
)
from haludec.datasets import load_cases_jsonl

DATASET = Path(__file__).resolve().parents[2] / "datasets" / "ecommerce_v1"


def test_shipped_dataset_has_no_errors() -> None:
    cases = load_cases_jsonl(DATASET / "cases.jsonl")
    policies = load_policies(DATASET / "policies")

    problems = [i for i in validate_benchmark(cases, policies.keys()) if i.severity == "error"]

    assert problems == []


def test_shipped_dataset_covers_every_category() -> None:
    counts = category_counts(load_cases_jsonl(DATASET / "cases.jsonl"))
    assert set(counts) == set(CATEGORY_TARGETS)


def test_agent_prompt_contains_every_shipped_policy() -> None:
    policies = load_policies(DATASET / "policies")
    prompt = build_agent_system_prompt(policies)
    assert all(doc_id in prompt for doc_id in policies)
