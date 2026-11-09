"""Token pricing. Prices are supplied by the caller and never hardcoded."""

from pydantic import BaseModel, ConfigDict, Field


class Pricing(BaseModel):
    """Dollars per million tokens, as listed on the provider's pricing page."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    input_per_mtok: float = Field(ge=0.0)
    output_per_mtok: float = Field(ge=0.0)


def compute_cost(tokens_in: int, tokens_out: int, pricing: Pricing) -> float:
    return (tokens_in * pricing.input_per_mtok + tokens_out * pricing.output_per_mtok) / 1_000_000
