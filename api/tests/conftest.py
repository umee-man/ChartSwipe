from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import jwt
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.ratelimit import TokenBucketLimiter
from app.repo import MemoryRepository

JWT_SECRET = "test-only-secret-not-used-anywhere-else-32b"
T0 = datetime(2026, 9, 26, 12, 0, 0, tzinfo=UTC)


class FakeClock:
    """Wall clock for the repository (updated_at / now())."""

    def __init__(self, start: datetime = T0) -> None:
        self.current = start

    def __call__(self) -> datetime:
        return self.current

    def advance(self, seconds: float) -> None:
        self.current += timedelta(seconds=seconds)


class FakeMonotonic:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def make_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "repository": "memory",
        "supabase_jwt_secret": JWT_SECRET,
        "supabase_jwks_url": None,
        "supabase_jwt_audience": "authenticated",
        "sync_rate_limit_per_minute": 30,
        "sync_cursor_lag_seconds": 2,
    }
    base.update(overrides)
    return Settings(_env_file=None, **base)


def make_token(sub: str | UUID, *, secret: str = JWT_SECRET, **claims: Any) -> str:
    payload: dict[str, Any] = {
        "sub": str(sub),
        "aud": "authenticated",
        "role": "authenticated",
        "exp": int(time.time()) + 3600,
    }
    payload.update(claims)
    return jwt.encode(payload, secret, algorithm="HS256")


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def mono() -> FakeMonotonic:
    return FakeMonotonic()


@pytest.fixture
def repo(clock: FakeClock) -> MemoryRepository:
    return MemoryRepository(clock=clock)


@pytest.fixture
def client(repo: MemoryRepository, mono: FakeMonotonic) -> Iterator[TestClient]:
    settings = make_settings()
    limiter = TokenBucketLimiter(settings.sync_rate_limit_per_minute, 60.0, clock=mono)
    ip_limiter = TokenBucketLimiter(settings.sync_ip_rate_limit_per_minute, 60.0, clock=mono)
    app = create_app(settings=settings, repo=repo, sync_limiter=limiter, sync_ip_limiter=ip_limiter)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def user_a() -> UUID:
    return uuid4()


@pytest.fixture
def user_b() -> UUID:
    return uuid4()


@pytest.fixture
def auth_a(user_a: UUID) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(user_a)}"}


@pytest.fixture
def auth_b(user_b: UUID) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(user_b)}"}


@pytest.fixture
def issue_key(client: TestClient) -> Callable[[dict[str, str]], dict[str, Any]]:
    def _issue(headers: dict[str, str]) -> dict[str, Any]:
        resp = client.post("/v1/keys", json={"name": "MT5"}, headers=headers)
        assert resp.status_code == 201, resp.text
        return resp.json()

    return _issue


@pytest.fixture
def add_level(client: TestClient) -> Callable[..., dict[str, Any]]:
    def _add(headers: dict[str, str], **fields: Any) -> dict[str, Any]:
        body = {"symbol": "BTCUSDT", "kind": "support", "price": 64200, "tf": "1h"} | fields
        resp = client.post("/v1/levels", json=body, headers=headers)
        assert resp.status_code == 201, resp.text
        return resp.json()

    return _add
