# ecommerce_v1

Fictional store "Northwind Home Goods". `policies/` is what the agent under test sees;
`cases.jsonl` has the questions and verified expected answers.

## Target mix (100 cases)
answerable 25, unanswerable 20, ambiguous 15, conflicting 15, adversarial 15, high_risk_financial 10.
`scripts/validate_benchmark.py` reports the current mix and every rule violation.

## Rules for every new case
1. The expected answer comes from a specific sentence in a policy document. Never from memory,
   and never from a model's unchecked output.
2. Search ALL policy documents for the topic. An "answerable" case that another document
   contradicts is really a "conflicting" case.
3. `ABSTAIN: <reason>` marks cases where the correct behavior is to decline, ask for details or
   flag a conflict. The reason must say what is missing or which documents disagree.
4. `abstention_allowed` is true exactly when the expected answer starts with `ABSTAIN:`.
5. A second person confirms the expected answer before the case counts as verified.
6. If you change a policy document, re-check every case that cites it, and bump the document
   version in its filename (-v2) so old results stay interpretable.

## Case ids
ECOM-001, ECOM-002, ... never reused.
