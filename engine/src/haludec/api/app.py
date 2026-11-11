"""FastAPI service exposing the engine to the Express API.

Stateless: each request carries everything it needs, and nothing is stored apart from the shared
response cache. It must run on a private network, and every /v1 call requires the service key.
Run a single worker: the response cache is one SQLite file.
"""

import hmac
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException

from haludec import __version__
from haludec.api.metering import RequestMeter
from haludec.api.models import (
    EvaluateCaseRequest,
    EvaluateCaseResponse,
    ModelsResponse,
    ReportRequest,
    ReportResponse,
)
from haludec.api.settings import EngineSettings
from haludec.benchmark import build_agent_system_prompt
from haludec.evaluation import (
    GRADER_PROMPT_VERSION,
    POLICY_GRADER_PROMPT_VERSION,
    Grader,
    LLMGrader,
    PolicyLLMGrader,
)
from haludec.experiments import (
    CaseFailureError,
    ExperimentSettings,
    breakdown_by,
    build_report,
    evaluate_case,
)
from haludec.providers import BudgetExceededError, Provider


def create_app(
    settings: EngineSettings,
    provider: Provider,
    *,
    close: Callable[[], Awaitable[None]] | None = None,
) -> FastAPI:
    """Build the service. provider is the shared stack (retry and cache around the real one)."""

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield
        if close is not None:
            await close()

    app = FastAPI(
        title="HaluDec engine",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs" if settings.expose_docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.expose_docs else None,
    )

    def require_service_key(x_service_key: Annotated[str | None, Header()] = None) -> None:
        supplied = (x_service_key or "").encode("utf-8")
        if not hmac.compare_digest(supplied, settings.service_key.encode("utf-8")):
            raise HTTPException(status_code=401, detail="invalid service key")

    auth = Depends(require_service_key)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/models", dependencies=[auth])
    def list_models() -> ModelsResponse:
        return ModelsResponse(models=sorted(settings.pricing))

    @app.post("/v1/evaluate-case", dependencies=[auth])
    async def evaluate_case_endpoint(req: EvaluateCaseRequest) -> EvaluateCaseResponse:
        used = {req.model, req.judge_model or req.model, req.grader_model}
        unknown = sorted(used - settings.pricing.keys())
        if unknown:
            raise HTTPException(status_code=422, detail=f"model not allowed: {unknown}")

        budget = min(req.budget_usd, settings.max_request_budget_usd)
        meter = RequestMeter(provider, budget)

        grader: Grader
        if req.grader == "policy":
            grader = PolicyLLMGrader(meter, req.grader_model)
            grader_version = POLICY_GRADER_PROMPT_VERSION
        else:
            grader = LLMGrader(meter, req.grader_model)
            grader_version = GRADER_PROMPT_VERSION

        system_prompt = (
            build_agent_system_prompt(req.policies, req.company_name) if req.policies else None
        )
        run_settings = ExperimentSettings(
            experiment_id=req.experiment_id,
            model=req.model,
            judge_model=req.judge_model,
            temperature=req.temperature,
            max_tokens=req.max_tokens,
            judge_max_tokens=req.judge_max_tokens,
            system_prompt=system_prompt,
            grader_version=grader_version,
        )

        try:
            records = await evaluate_case(
                req.case, req.rubric_t, provider=meter, grader=grader, settings=run_settings
            )
        except CaseFailureError as exc:
            return EvaluateCaseResponse(
                status="failed",
                stage=exc.stage,
                error=str(exc),
                spend_usd=meter.spent_usd,
                paid_calls=meter.paid_calls,
                cached_calls=meter.cached_calls,
            )
        except BudgetExceededError:
            return EvaluateCaseResponse(
                status="budget_exceeded",
                spend_usd=meter.spent_usd,
                paid_calls=meter.paid_calls,
                cached_calls=meter.cached_calls,
            )
        return EvaluateCaseResponse(
            status="ok",
            records=records,
            spend_usd=meter.spent_usd,
            paid_calls=meter.paid_calls,
            cached_calls=meter.cached_calls,
        )

    @app.post("/v1/report", dependencies=[auth])
    def build_report_endpoint(req: ReportRequest) -> ReportResponse:
        # A plain def: FastAPI runs it in a worker thread, so the resampling statistics do not
        # block the event loop that serves model calls.
        thresholds = tuple(req.thresholds)
        try:
            report = build_report(
                req.records,
                req.failures,
                thresholds,
                abstention_allowed={c.id: c.abstention_allowed for c in req.cases},
                seed=req.seed,
            )
            by_category = breakdown_by(req.records, req.cases, thresholds, "category")
            by_risk = breakdown_by(req.records, req.cases, thresholds, "risk_level")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return ReportResponse(report=report, by_category=by_category, by_risk_level=by_risk)

    return app
