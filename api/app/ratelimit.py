"""In-memory token bucket (single replica in MVP, architecture §7)."""

from __future__ import annotations

import math
import threading
import time
from collections.abc import Callable, Hashable
from dataclasses import dataclass


@dataclass
class _Bucket:
    tokens: float
    updated: float


class TokenBucketLimiter:
    def __init__(
        self,
        capacity: int,
        per_seconds: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        idle_ttl: float = 600.0,
    ) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self.capacity = float(capacity)
        self.rate = capacity / per_seconds  # tokens per second
        self.clock = clock
        self.idle_ttl = idle_ttl
        self._buckets: dict[Hashable, _Bucket] = {}
        self._lock = threading.Lock()
        self._last_prune = clock()

    def acquire(self, key: Hashable) -> tuple[bool, int]:
        """Take one token. Returns (allowed, retry_after_seconds)."""
        now = self.clock()
        with self._lock:
            self._maybe_prune(now)
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = self._buckets[key] = _Bucket(tokens=self.capacity, updated=now)
            else:
                elapsed = max(0.0, now - bucket.updated)
                bucket.tokens = min(self.capacity, bucket.tokens + elapsed * self.rate)
                bucket.updated = now
            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                return True, 0
            return False, max(1, math.ceil((1.0 - bucket.tokens) / self.rate))

    def _maybe_prune(self, now: float) -> None:
        if now - self._last_prune < self.idle_ttl:
            return
        self._last_prune = now
        stale = [k for k, b in self._buckets.items() if now - b.updated > self.idle_ttl]
        for k in stale:
            del self._buckets[k]
