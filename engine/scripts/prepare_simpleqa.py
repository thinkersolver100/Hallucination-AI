"""Draw a seeded sample from the SimpleQA CSV and save it as a cases file."""

import argparse
from pathlib import Path

from haludec.datasets import load_simpleqa_csv, sample_cases, save_cases_jsonl

parser = argparse.ArgumentParser()
parser.add_argument("--csv", required=True, type=Path)
parser.add_argument("--n", required=True, type=int)
parser.add_argument("--seed", type=int, default=0)
parser.add_argument("--out", required=True, type=Path)
args = parser.parse_args()

cases = load_simpleqa_csv(args.csv)
sample = sample_cases(cases, args.n, args.seed)
save_cases_jsonl(sample, args.out)
print(f"read {len(cases)} questions, wrote {len(sample)} to {args.out} (seed {args.seed})")
