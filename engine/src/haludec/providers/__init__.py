"""Provider layer: interface, fake, retry, cache, cost tracking and OpenRouter."""

from haludec.providers.base import (
    BudgetExceededError,
    GenRequest,
    GenResponse,
    Provider,
    ProviderError,
    RateLimitError,
    TransientError,
)
from haludec.providers.cache import CachingProvider
from haludec.providers.cost import Pricing, compute_cost
from haludec.providers.fake import FakeProvider
from haludec.providers.groq import GroqProvider
from haludec.providers.openrouter import OpenRouterProvider
from haludec.providers.retry import RetryingProvider, RetryPolicy
from haludec.providers.tracking import CostTracker, TrackingProvider

__all__ = [
    "BudgetExceededError",
    "CachingProvider",
    "CostTracker",
    "FakeProvider",
    "GenRequest",
    "GenResponse",
    "GroqProvider",
    "OpenRouterProvider",
    "Pricing",
    "Provider",
    "ProviderError",
    "RateLimitError",
    "RetryPolicy",
    "RetryingProvider",
    "TrackingProvider",
    "TransientError",
    "compute_cost",
]
