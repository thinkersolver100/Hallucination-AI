"""Per-request spend meter and budget cap.

Place it outermost, around the shared cache. It counts only responses that were actually paid
for, so a rerun served from the cache is reported as free. Once spend reaches the budget, no
further call starts (even a cache hit). Calls already in flight still finish, so spend can
exceed the budget by at most the cost of those calls.
"""

from haludec.providers import BudgetExceededError, GenRequest, GenResponse, Provider


class RequestMeter:
    def __init__(self, inner: Provider, budget_usd: float) -> None:
        if budget_usd <= 0:
            raise ValueError("budget_usd must be above 0")
        self._inner = inner
        self.budget_usd = budget_usd
        self.spent_usd = 0.0
        self.paid_calls = 0
        self.cached_calls = 0

    async def generate(self, req: GenRequest) -> GenResponse:
        if self.spent_usd >= self.budget_usd:
            raise BudgetExceededError(f"request budget of ${self.budget_usd:.4f} reached")
        resp = await self._inner.generate(req)
        if resp.cached:
            self.cached_calls += 1
        else:
            self.spent_usd += resp.cost_usd
            self.paid_calls += 1
        return resp
