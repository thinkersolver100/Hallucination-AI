from datetime import UTC, datetime

from haludec.schemas import ConfigId, Label, RunRecord


def make_record(
    label: Label = Label.CORRECT,
    *,
    case_id: str = "q1",
    config: ConfigId = ConfigId.A_BASELINE,
    threshold: float = 0.5,
    sample_index: int = 0,
    cost: float = 0.0,
    latency: float = 100.0,
) -> RunRecord:
    return RunRecord(
        run_id=f"{config.value}-{case_id}-{sample_index}",
        experiment_id="EXP-TEST",
        test_case_id=case_id,
        config=config,
        threshold=threshold,
        sample_index=sample_index,
        model_id="test-model",
        prompt_version="p1",
        rubric_version="r1",
        response_text="x",
        label=label,
        latency_ms=latency,
        tokens_in=1,
        tokens_out=1,
        cost_usd=cost,
        timestamp=datetime(2026, 11, 10, 12, 0, tzinfo=UTC),
    )
