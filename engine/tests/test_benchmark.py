from pathlib import Path
from typing import Any

import pytest

from haludec.benchmark import (
    build_agent_system_prompt,
    category_counts,
    format_mix,
    load_policies,
    validate_benchmark,
)
from haludec.schemas import RiskLevel, TestCase

POLICIES = ("returns", "faq")


def make_case(**overrides: Any) -> TestCase:
    data: dict[str, Any] = {
        "id": "ECOM-001",
        "question": "Can I return a vase after 20 days?",
        "expected_answer": "Yes. Most items can be returned within 30 days of delivery.",
        "reference_doc_ids": ["returns"],
        "abstention_allowed": False,
        "risk_level": RiskLevel.LOW,
        "category": "answerable",
    }
    data.update(overrides)
    return TestCase(**data)


def abstain_case(category: str, **overrides: Any) -> TestCase:
    data: dict[str, Any] = {
        "id": "ECOM-002",
        "question": "Where is your warehouse?",
        "expected_answer": "ABSTAIN: The policies do not say where the warehouse is.",
        "reference_doc_ids": [],
        "abstention_allowed": True,
        "risk_level": RiskLevel.MEDIUM,
        "category": category,
    }
    data.update(overrides)
    return make_case(**data)


def errors(cases: list[TestCase]) -> list[str]:
    issues = validate_benchmark(cases, POLICIES)
    return [i.message for i in issues if i.severity == "error"]


def has_error(cases: list[TestCase], fragment: str) -> bool:
    return any(fragment in message for message in errors(cases))


# ---- policies and the agent prompt ------------------------------------------


def test_load_policies_uses_file_stems_as_ids(tmp_path: Path) -> None:
    (tmp_path / "returns-v1.md").write_text("30 days.\n", encoding="utf-8")
    (tmp_path / "shipping-v1.md").write_text("5 days.\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("ignored", encoding="utf-8")

    assert load_policies(tmp_path) == {"returns-v1": "30 days.", "shipping-v1": "5 days."}


def test_load_policies_rejects_empty_directories_and_files(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="no policy documents"):
        load_policies(tmp_path)
    (tmp_path / "blank.md").write_text("  \n", encoding="utf-8")
    with pytest.raises(ValueError, match="empty"):
        load_policies(tmp_path)


def test_agent_prompt_contains_every_document_and_stays_neutral() -> None:
    prompt = build_agent_system_prompt({"b-doc": "Second text.", "a-doc": "First text."})

    assert "First text." in prompt
    assert "Second text." in prompt
    assert prompt.index("a-doc") < prompt.index("b-doc")
    assert "don't know" not in prompt.lower()
    assert "uncertain" not in prompt.lower()


# ---- validation rules -------------------------------------------------------


def test_a_well_formed_dataset_has_no_errors() -> None:
    cases = [
        make_case(),
        abstain_case("unanswerable"),
        abstain_case(
            "conflicting",
            id="ECOM-003",
            question="How long is the speaker return window?",
            expected_answer="ABSTAIN: The two documents disagree and none says which applies.",
            reference_doc_ids=["returns", "faq"],
        ),
    ]
    assert errors(cases) == []


def test_duplicate_ids_and_bad_id_format() -> None:
    assert has_error([make_case(), make_case(question="Another question?")], "duplicate id")
    assert has_error([make_case(id="Q1")], "id must look like")


def test_duplicate_questions_are_caught_regardless_of_case_and_spacing() -> None:
    cases = [make_case(), make_case(id="ECOM-002", question="can I  RETURN a vase after 20 days?")]
    assert has_error(cases, "same question as ECOM-001")


def test_unknown_category() -> None:
    assert has_error([make_case(category="whatever")], "unknown category")


def test_reference_documents_must_exist_and_be_present() -> None:
    assert has_error([make_case(reference_doc_ids=["ghost"])], "not found")
    assert has_error([make_case(reference_doc_ids=[])], "at least one reference")


def test_unanswerable_cases_may_cite_nothing() -> None:
    assert errors([abstain_case("unanswerable")]) == []


def test_conflicting_cases_need_two_documents() -> None:
    case = abstain_case("conflicting", reference_doc_ids=["returns"])
    assert has_error([case], "at least two documents")


def test_categories_that_must_abstain() -> None:
    for category in ("unanswerable", "ambiguous", "conflicting"):
        case = make_case(category=category)
        assert has_error([case], "must have an ABSTAIN")


def test_categories_that_must_not_abstain() -> None:
    for category in ("answerable", "adversarial"):
        case = abstain_case(category, reference_doc_ids=["returns"])
        assert has_error([case], "must not have an ABSTAIN")


def test_abstention_flag_must_match_the_expected_answer() -> None:
    assert has_error([abstain_case("unanswerable", abstention_allowed=False)], "exactly when")
    assert has_error([make_case(abstention_allowed=True)], "exactly when")


def test_abstain_prefix_needs_a_reason() -> None:
    case = abstain_case("unanswerable", expected_answer="ABSTAIN:")
    assert has_error([case], "followed by the reason")


def test_high_risk_financial_must_be_high_risk() -> None:
    case = make_case(category="high_risk_financial", risk_level=RiskLevel.LOW)
    assert has_error([case], "risk_level high")
    ok = make_case(category="high_risk_financial", risk_level=RiskLevel.HIGH)
    assert errors([ok]) == []


def test_mix_shortfalls_are_warnings_not_errors() -> None:
    issues = validate_benchmark([make_case()], POLICIES)
    warnings = [i.message for i in issues if i.severity == "warning"]

    assert any("unanswerable: 0 cases, target 20" in w for w in warnings)
    assert [i for i in issues if i.severity == "error"] == []


def test_counts_and_mix_table() -> None:
    cases = [make_case(), abstain_case("unanswerable")]
    assert category_counts(cases) == {"answerable": 1, "unanswerable": 1}
    table = format_mix(cases)
    assert "answerable" in table
    assert "total" in table
