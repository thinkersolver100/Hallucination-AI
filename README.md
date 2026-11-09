# HaluDec

Audit tool that measures how abstention rubrics and mitigations change the
accuracy, hallucination rate, coverage, latency and cost of LLM answers.
Based on Kalai et al., "Evaluating large language models for accuracy
incentivizes hallucinations" (Nature, 2026).

## Layout
- `engine/`   Python library: rubric, providers, mitigation, evaluation, stats
- `api/`      Express API (Phase 6)
- `web/`      React dashboard (Phase 7)
- `datasets/` Question sets and reference documents
- `runs/`     Experiment outputs (gitignored)
- `docs/`     Design notes

## Develop the engine
    cd engine
    uv sync
    uv run pytest
    uv run ruff check . && uv run ruff format --check .
    uv run mypy src
