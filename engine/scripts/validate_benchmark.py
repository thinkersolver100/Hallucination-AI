"""Check the benchmark dataset: mix of categories and every labeling rule."""

import argparse
import sys
from pathlib import Path

from haludec.benchmark import format_mix, load_policies, validate_benchmark
from haludec.datasets import load_cases_jsonl

ROOT = Path(__file__).resolve().parents[2]

parser = argparse.ArgumentParser()
parser.add_argument("--dir", type=Path, default=ROOT / "datasets" / "ecommerce_v1")
args = parser.parse_args()

cases = load_cases_jsonl(args.dir / "cases.jsonl")
policies = load_policies(args.dir / "policies")
issues = validate_benchmark(cases, policies.keys())

print(format_mix(cases))
print()
for issue in issues:
    where = issue.case_id or "dataset"
    print(f"{issue.severity.upper():<8}{where}: {issue.message}")
errors = [i for i in issues if i.severity == "error"]
print()
print(f"{len(errors)} error(s), {len(issues) - len(errors)} warning(s)")
sys.exit(1 if errors else 0)
