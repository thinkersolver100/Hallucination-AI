"""On-disk response cache (SQLite) so reruns of an experiment are free.

The key covers every field of the request, including sample_index, so the two
independent generations the mitigation needs are cached separately. Two identical
requests in flight at the same moment can both miss; the later write wins.
"""

import hashlib
import sqlite3
from pathlib import Path

from haludec.providers.base import GenRequest, GenResponse, Provider

_KEY_VERSION = "v1"  # bump to invalidate every old entry


class CachingProvider:
    def __init__(self, inner: Provider, path: Path | str = ":memory:") -> None:
        self._inner = inner
        self._db = sqlite3.connect(str(path))
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        self._db.commit()
        self.hits = 0
        self.misses = 0

    @staticmethod
    def key_for(req: GenRequest) -> str:
        payload = f"{_KEY_VERSION}:{req.model_dump_json()}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    async def generate(self, req: GenRequest) -> GenResponse:
        key = self.key_for(req)
        row = self._db.execute("SELECT value FROM cache WHERE key = ?", (key,)).fetchone()
        if row is not None:
            self.hits += 1
            stored = GenResponse.model_validate_json(row[0])
            return stored.model_copy(update={"cached": True})

        self.misses += 1
        resp = await self._inner.generate(req)
        self._db.execute(
            "INSERT OR REPLACE INTO cache (key, value) VALUES (?, ?)",
            (key, resp.model_dump_json()),
        )
        self._db.commit()
        return resp

    def close(self) -> None:
        self._db.close()
