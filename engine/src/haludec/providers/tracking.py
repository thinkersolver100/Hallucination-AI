"""Spend tracking with an optional hard budget.

Place this directly around the paid provider so cache hits never reach it.
Calls already in flight when the budget is reached still finish, so the final
spend can overshoot the cap by at most the cost of those concurrent calls.
"""

from haludec.providers.base import BudgetExceededError, GenRequest, GenResponse, Provider


class CostTracker:
    def __init__(self, budget_usd: float | None = None) -> None:
        if budget_usd is not None and budget_usd < 0:
            raise ValueError("budget_usd must be >= 0")
        self.budget_usd = budget_usd
        self.spent_usd = 0.0
        self.calls = 0
        self.tokens_in = 0
        self.tokens_out = 0

    def ensure_within_budget(self) -> None:
        if self.budget_usd is not None and self.spent_usd >= self.budget_usd:
            raise BudgetExceededError(
                f"budget of ${self.budget_usd:.2f} reached (spent ${self.spent_usd:.4f})"
            )

    def record(self, resp: GenResponse) -> None:
        self.spent_usd += resp.cost_usd
        self.calls += 1
        self.tokens_in += resp.tokens_in
        self.tokens_out += resp.tokens_out


class TrackingProvider:
    def __init__(self, inner: Provider, tracker: CostTracker) -> None:
        self._inner = inner
        self.tracker = tracker

    async def generate(self, req: GenRequest) -> GenResponse:
        self.tracker.ensure_within_budget()
        resp = await self._inner.generate(req)
        self.tracker.record(resp)
        return resp
