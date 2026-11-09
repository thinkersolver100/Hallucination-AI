"""A scripted provider for tests: no network, no cost, fully deterministic."""

from collections import deque
from collections.abc import Callable, Sequence

from haludec.providers.base import GenRequest, GenResponse
from haludec.providers.cost import Pricing, compute_cost


class FakeProvider:
    """Answers with responder(request). Queued errors are raised first, one per call.

    Token counts are word counts, which is crude but predictable for assertions.
    Every request is appended to .calls so tests can check what was (not) sent.
    """

    def __init__(
        self,
        responder: Callable[[GenRequest], str] | None = None,
        *,
        pricing: Pricing | None = None,
        errors: Sequence[Exception] = (),
    ) -> None:
        self._responder = responder or (lambda _req: "fake answer")
        self._pricing = pricing or Pricing(input_per_mtok=0.0, output_per_mtok=0.0)
        self._errors: deque[Exception] = deque(errors)
        self.calls: list[GenRequest] = []

    async def generate(self, req: GenRequest) -> GenResponse:
        self.calls.append(req)
        if self._errors:
            raise self._errors.popleft()
        text = self._responder(req)
        tokens_in = len(req.prompt.split())
        tokens_out = len(text.split())
        return GenResponse(
            text=text,
            model=req.model,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            latency_ms=0.0,
            cost_usd=compute_cost(tokens_in, tokens_out, self._pricing),
        )
