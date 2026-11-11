"""Run the four-configuration experiment on the e-commerce benchmark."""

import argparse
import asyncio
import json
import os
from datetime import datetime
from pathlib import Path

from haludec.benchmark import build_agent_system_prompt, load_policies, validate_benchmark
from haludec.datasets import load_cases_jsonl
from haludec.evaluation import POLICY_GRADER_PROMPT_VERSION, PolicyLLMGrader
from haludec.experiments import (
    ExperimentSettings,
    breakdown_by,
    build_report,
    format_breakdown,
    format_report,
    run_experiment,
)
from haludec.providers import (
    CachingProvider,
    CostTracker,
    OpenRouterProvider,
    Pricing,
    RetryingProvider,
    TrackingProvider,
)

ROOT = Path(__file__).resolve().parents[2]
CALLS_PER_QUESTION_PER_CONDITION = 5  # 2 generations, 2 gradings, 1 judge


def parse_price(text: str) -> tuple[str, Pricing]:
    model, sep, prices = text.rpartition("=")
    if not sep or "," not in prices:
        raise SystemExit(f"--price must look like MODEL=IN,OUT (got {text!r})")
    price_in, price_out = prices.split(",", 1)
    return model, Pricing(input_per_mtok=float(price_in), output_per_mtok=float(price_out))


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", type=Path, default=ROOT / "datasets" / "ecommerce_v1")
    parser.add_argument("--model", required=True)
    parser.add_argument("--judge-model", help="defaults to --model, as in the paper")
    parser.add_argument("--grader-model", required=True)
    parser.add_argument("--price", action="append", default=[], help="MODEL=IN,OUT per 1M tokens")
    parser.add_argument("--thresholds", default="0,0.5,0.75,0.9")
    parser.add_argument("--limit", type=int, help="evenly spaced subset, for a cheap pilot")
    parser.add_argument("--budget", type=float, required=True, help="hard spending cap in $")
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--max-tokens", type=int, default=1024)
    parser.add_argument("--breakdown-t", type=float, default=0.75)
    parser.add_argument("--experiment-id")
    parser.add_argument("--yes", action="store_true")
    args = parser.parse_args()

    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise SystemExit("Set OPENROUTER_API_KEY first")

    cases = load_cases_jsonl(args.dir / "cases.jsonl")
    policies = load_policies(args.dir / "policies")
    problems = [i for i in validate_benchmark(cases, policies.keys()) if i.severity == "error"]
    if problems:
        for issue in problems:
            print(f"ERROR {issue.case_id}: {issue.message}")
        raise SystemExit("fix the dataset first (scripts/validate_benchmark.py)")

    if args.limit and args.limit < len(cases):
        step = len(cases) / args.limit
        cases = [cases[int(i * step)] for i in range(args.limit)]

    experiment_id = args.experiment_id or datetime.now().strftime("bench-%Y%m%d-%H%M%S")
    settings = ExperimentSettings(
        experiment_id=experiment_id,
        model=args.model,
        judge_model=args.judge_model,
        thresholds=tuple(float(x) for x in args.thresholds.split(",")),
        max_tokens=args.max_tokens,
        concurrency=args.concurrency,
        system_prompt=build_agent_system_prompt(policies),
        grader_version=POLICY_GRADER_PROMPT_VERSION,
    )

    pricing = dict(parse_price(p) for p in args.price)
    needed = {settings.model, settings.effective_judge_model, args.grader_model}
    missing = sorted(needed - pricing.keys())
    if missing:
        raise SystemExit(f"missing --price for: {missing}")

    conditions = 1 + len(settings.thresholds)
    calls = len(cases) * conditions * CALLS_PER_QUESTION_PER_CONDITION
    print(f"{len(cases)} questions x {conditions} conditions -> up to {calls} model calls")
    print("every generation call also carries the policy documents as context")
    print(f"budget cap: ${args.budget:.2f}   experiment id: {experiment_id}")
    if not args.yes and input("Continue? [y/N] ").strip().lower() != "y":
        raise SystemExit("cancelled")

    out_dir = ROOT / "runs" / experiment_id
    out_dir.mkdir(parents=True, exist_ok=True)

    real = OpenRouterProvider(key, pricing)
    tracker = CostTracker(budget_usd=args.budget)
    stack = CachingProvider(
        TrackingProvider(RetryingProvider(real), tracker), ROOT / "runs" / "cache.db"
    )
    grader = PolicyLLMGrader(stack, args.grader_model)
    try:
        result = await run_experiment(cases, stack, grader, settings, out_dir=out_dir)
    finally:
        await real.aclose()
        stack.close()

    report = build_report(
        result.records,
        result.failures,
        settings.thresholds,
        abstention_allowed={c.id: c.abstention_allowed for c in cases},
    )
    by_category = breakdown_by(result.records, cases, settings.thresholds, "category")
    by_risk = breakdown_by(result.records, cases, settings.thresholds, "risk_level")
    (out_dir / "report.json").write_text(report.model_dump_json(indent=2), encoding="utf-8")
    (out_dir / "breakdown.json").write_text(
        json.dumps(
            {
                "category": [r.model_dump(mode="json") for r in by_category],
                "risk_level": [r.model_dump(mode="json") for r in by_risk],
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print()
    print(format_report(report))
    print()
    print(format_breakdown(by_category, args.breakdown_t))
    print()
    print(format_breakdown(by_risk, args.breakdown_t))
    print()
    print(f"spent ${tracker.spent_usd:.4f} over {tracker.calls} paid calls")
    print(f"cache hits {stack.hits}, misses {stack.misses}")
    print(f"results in {out_dir}")


asyncio.run(main())
