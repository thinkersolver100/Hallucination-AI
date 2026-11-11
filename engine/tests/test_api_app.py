from typing import Any

from fastapi.testclient import TestClient

from factories import make_record
from haludec.api.app import create_app
from haludec.api.settings import EngineSettings
from haludec.providers import FakeProvider, GenRequest, Pricing
from haludec.schemas import ConfigId, Label

KEY = "k" * 40
HEADERS = {"X-Service-Key": KEY}
CHEAP = Pricing(input_per_mtok=1.0, output_per_mtok=1.0)
ONE_DOLLAR_PER_TOKEN = Pricing(input_per_mtok=1_000_000.0, output_per_mtok=1_000_000.0)
PRICING = {"gen": CHEAP, "judge": CHEAP, "grader": CHEAP}


def responder(req: GenRequest) -> str:
    system = req.system or ""
    if "You compare two responses" in system:
        return '{"consistent": true}'
    if "You choose between" in system:
        return '{"choice": 1}'
    if "You are grading" in system:
        return '{"label": "correct"}'
    return "Paris"


def make_client(
    fake: FakeProvider | None = None, *, max_budget: float = 5.0
) -> tuple[TestClient, FakeProvider]:
    provider = fake or FakeProvider(responder)
    settings = EngineSettings(service_key=KEY, pricing=PRICING, max_request_budget_usd=max_budget)
    return TestClient(create_app(settings, provider)), provider


def case_payload(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": "Q1",
        "question": "Capital of France?",
        "expected_answer": "Paris",
        "reference_doc_ids": [],
        "abstention_allowed": False,
        "risk_level": "low",
        "category": "geo",
    }
    data.update(overrides)
    return data


def eval_payload(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "experiment_id": "EXP",
        "case": case_payload(),
        "rubric_t": None,
        "model": "gen",
        "grader_model": "grader",
        "grader": "llm",
        "budget_usd": 100.0,
    }
    data.update(overrides)
    return data


# ---- authentication ---------------------------------------------------------


def test_healthz_is_open() -> None:
    client, _ = make_client()
    assert client.get("/healthz").json() == {"status": "ok"}


def test_v1_endpoints_require_the_service_key() -> None:
    client, _ = make_client()

    assert client.get("/v1/models").status_code == 401
    assert client.get("/v1/models", headers={"X-Service-Key": "wrong"}).status_code == 401
    assert client.post("/v1/evaluate-case", json=eval_payload()).status_code == 401
    assert client.post("/v1/report", json={}).status_code == 401


def test_docs_are_hidden_by_default() -> None:
    client, _ = make_client()
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_models_are_listed_sorted() -> None:
    client, _ = make_client()
    response = client.get("/v1/models", headers=HEADERS)
    assert response.json() == {"models": ["gen", "grader", "judge"]}


# ---- evaluate-case ----------------------------------------------------------


def test_closed_rubric_evaluation() -> None:
    client, fake = make_client()

    response = client.post("/v1/evaluate-case", json=eval_payload(), headers=HEADERS)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert [r["config"] for r in body["records"]] == ["A", "A", "C"]
    assert [r["label"] for r in body["records"]] == ["correct"] * 3
    assert body["paid_calls"] == len(fake.calls)
    generations = [c for c in fake.calls if c.system is None]
    assert len(generations) == 2  # no policies, so no agent context


def test_open_rubric_with_policies_and_company_name() -> None:
    client, fake = make_client()
    payload = eval_payload(
        rubric_t=0.75,
        policies={"returns-v1": "Returns take 30 days."},
        company_name="Acme Co",
    )

    body = client.post("/v1/evaluate-case", json=payload, headers=HEADERS).json()

    assert body["status"] == "ok"
    assert [r["config"] for r in body["records"]] == ["B", "B", "D"]
    assert all(r["threshold"] == 0.75 for r in body["records"])
    agent_calls = [c for c in fake.calls if c.system and "customer support assistant" in c.system]
    assert len(agent_calls) == 2
    assert all("Acme Co" in (c.system or "") for c in agent_calls)
    assert all("Returns take 30 days." in (c.system or "") for c in agent_calls)


def test_a_question_that_cannot_be_graded_is_reported_as_failed() -> None:
    fake = FakeProvider(lambda r: "" if r.system is None else responder(r))
    client, _ = make_client(fake)

    body = client.post("/v1/evaluate-case", json=eval_payload(), headers=HEADERS).json()

    assert body["status"] == "failed"
    assert body["stage"] == "grade"
    assert body["records"] == []


def test_budget_exhaustion_is_reported_with_the_spend_so_far() -> None:
    client, _ = make_client(FakeProvider(responder, pricing=ONE_DOLLAR_PER_TOKEN))

    body = client.post(
        "/v1/evaluate-case", json=eval_payload(budget_usd=0.5), headers=HEADERS
    ).json()

    assert body["status"] == "budget_exceeded"
    assert body["spend_usd"] > 0
    assert body["records"] == []


def test_the_server_side_budget_cap_overrides_the_request() -> None:
    client, _ = make_client(FakeProvider(responder, pricing=ONE_DOLLAR_PER_TOKEN), max_budget=0.5)

    body = client.post(
        "/v1/evaluate-case", json=eval_payload(budget_usd=1000.0), headers=HEADERS
    ).json()

    assert body["status"] == "budget_exceeded"


def test_models_outside_the_allowlist_are_refused_before_any_call() -> None:
    client, fake = make_client()

    for field in ("model", "grader_model", "judge_model"):
        response = client.post(
            "/v1/evaluate-case", json=eval_payload(**{field: "unlisted"}), headers=HEADERS
        )
        assert response.status_code == 422
        assert "not allowed" in response.json()["detail"]
    assert fake.calls == []


def test_invalid_requests_are_rejected() -> None:
    client, _ = make_client()

    bad_payloads = [
        eval_payload(rubric_t=0.95),
        eval_payload(budget_usd=0),
        eval_payload(surprise="x"),
        eval_payload(policies={"bad id!": "text"}),
        eval_payload(policies={"ok": "  "}),
        eval_payload(company_name="two\nlines"),
        eval_payload(max_tokens=100_000),
    ]
    for payload in bad_payloads:
        assert client.post("/v1/evaluate-case", json=payload, headers=HEADERS).status_code == 422

    missing_budget = eval_payload()
    del missing_budget["budget_usd"]
    assert client.post("/v1/evaluate-case", json=missing_budget, headers=HEADERS).status_code == 422


# ---- report -----------------------------------------------------------------


def report_payload(case_ids: tuple[str, ...] = ("Q1", "Q2")) -> dict[str, Any]:
    records = []
    for case_id in case_ids:
        records += [
            make_record(Label.CORRECT, case_id=case_id, config=ConfigId.A_BASELINE, threshold=0.0),
            make_record(
                Label.INCORRECT,
                case_id=case_id,
                config=ConfigId.A_BASELINE,
                threshold=0.0,
                sample_index=1,
            ),
            make_record(
                Label.ABSTAINED, case_id=case_id, config=ConfigId.C_CONSISTENCY, threshold=0.0
            ),
        ]
    return {
        "cases": [case_payload(id="Q1"), case_payload(id="Q2")],
        "records": [r.model_dump(mode="json") for r in records],
        "failures": [],
        "thresholds": [0.5],
    }


def test_report_includes_rows_comparisons_and_breakdowns() -> None:
    client, _ = make_client()

    response = client.post("/v1/report", json=report_payload(), headers=HEADERS)

    assert response.status_code == 200
    body = response.json()
    assert body["report"]["n_questions"] == 2
    assert len(body["report"]["rows"]) == 2  # configs A and C at t = 0.5
    assert len(body["report"]["comparisons"]) == 1
    assert {row["group"] for row in body["by_category"]} == {"geo"}
    assert {row["group"] for row in body["by_risk_level"]} == {"low"}


def test_report_rejects_records_for_unknown_cases() -> None:
    client, _ = make_client()
    payload = report_payload(case_ids=("Q1", "Q2"))
    payload["cases"] = [case_payload(id="Q1")]

    response = client.post("/v1/report", json=payload, headers=HEADERS)

    assert response.status_code == 422


def test_report_rejects_bad_inputs() -> None:
    client, _ = make_client()

    duplicate_cases = report_payload()
    duplicate_cases["cases"] = [case_payload(id="Q1"), case_payload(id="Q1")]
    bad_threshold = report_payload()
    bad_threshold["thresholds"] = [1.0]
    no_records = report_payload()
    no_records["records"] = []

    for payload in (duplicate_cases, bad_threshold, no_records):
        assert client.post("/v1/report", json=payload, headers=HEADERS).status_code == 422
