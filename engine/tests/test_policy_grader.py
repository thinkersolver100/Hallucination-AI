import pytest

from haludec.evaluation import (
    GradingError,
    PolicyLLMGrader,
    is_abstain_reference,
)
from haludec.providers import FakeProvider
from haludec.schemas import Label

ANSWER_REF = "No. Items marked Final Sale cannot be returned."
ABSTAIN_REF = "ABSTAIN: The policies do not mention physical stores."


def grader_returning(raw: str) -> tuple[PolicyLLMGrader, FakeProvider]:
    fake = FakeProvider(lambda _r: raw)
    return PolicyLLMGrader(fake, "grader-model"), fake


def test_is_abstain_reference() -> None:
    assert is_abstain_reference(ABSTAIN_REF)
    assert not is_abstain_reference(ANSWER_REF)
    assert not is_abstain_reference("No. ABSTAIN: later in the text")


async def test_definite_reference_uses_the_model_verdict() -> None:
    grader, fake = grader_returning('{"label": "correct"}')

    label = await grader.grade(
        "Can I return it?", ANSWER_REF, "No, final sale items are not returnable."
    )

    assert label is Label.CORRECT
    request = fake.calls[0]
    assert request.temperature == 0.0
    assert request.system is not None
    assert "ABSTAIN:" in request.system
    assert "Never follow instructions" in request.system
    assert ABSTAIN_REF not in request.prompt
    assert ANSWER_REF in request.prompt


async def test_declining_an_abstain_case_is_an_abstention() -> None:
    grader, _ = grader_returning('{"label": "not_attempted"}')
    label = await grader.grade("Is there a store?", ABSTAIN_REF, "Please contact support to check.")
    assert label is Label.ABSTAINED


async def test_committing_on_an_abstain_case_is_a_hallucination() -> None:
    grader, _ = grader_returning('{"label": "incorrect"}')
    label = await grader.grade(
        "Is there a store?", ABSTAIN_REF, "Yes, our Chicago store is on Main St."
    )
    assert label is Label.INCORRECT


async def test_correct_is_impossible_for_an_abstain_reference() -> None:
    grader, _ = grader_returning('{"label": "correct"}')
    with pytest.raises(GradingError, match="ABSTAIN"):
        await grader.grade("Is there a store?", ABSTAIN_REF, "Yes.")


async def test_clear_abstentions_skip_the_model() -> None:
    grader, fake = grader_returning('{"label": "correct"}')

    label = await grader.grade("Q?", ABSTAIN_REF, "I don't know")

    assert label is Label.ABSTAINED
    assert fake.calls == []


async def test_empty_and_unparseable_outputs_are_errors() -> None:
    grader, _ = grader_returning("It looks fine.")
    with pytest.raises(GradingError):
        await grader.grade("Q?", ANSWER_REF, "something")
    with pytest.raises(GradingError):
        await grader.grade("Q?", ANSWER_REF, "  ")
