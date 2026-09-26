from __future__ import annotations

import pytest

from app.ratelimit import TokenBucketLimiter


def test_sync_rate_limit_30_per_minute(client, auth_a, auth_b, issue_key, mono):
    key_a = issue_key(auth_a)["key"]
    key_b = issue_key(auth_b)["key"]
    for _ in range(30):
        assert client.get("/v1/sync/mt5", headers={"X-API-Key": key_a}).status_code == 200
    resp = client.get("/v1/sync/mt5", headers={"X-API-Key": key_a})
    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "2"
    assert resp.json()["detail"] == "Слишком много запросов, попробуйте позже"

    # Buckets are per key.
    assert client.get("/v1/sync/mt5", headers={"X-API-Key": key_b}).status_code == 200

    # Refill: 30/min = one token every 2 s.
    mono.advance(2)
    assert client.get("/v1/sync/mt5", headers={"X-API-Key": key_a}).status_code == 200
    assert client.get("/v1/sync/mt5", headers={"X-API-Key": key_a}).status_code == 429


def test_invalid_key_is_rate_limited_before_db_lookup(client, repo, monkeypatch):
    calls = 0
    real = repo.find_active_api_key

    async def counting(key_hash):
        nonlocal calls
        calls += 1
        return await real(key_hash)

    monkeypatch.setattr(repo, "find_active_api_key", counting)
    bad = {"X-API-Key": "cs_wrong"}
    for _ in range(30):
        assert client.get("/v1/sync/mt5", headers=bad).status_code == 401
    assert client.get("/v1/sync/mt5", headers=bad).status_code == 429
    assert calls == 30  # the 31st request never reached the repository


def test_per_ip_cap_with_random_keys(client, repo, mono):
    # Rotating random keys: per-key buckets never fill, the per-IP bucket (120/min) does.
    codes = [client.get("/v1/sync/mt5", headers={"X-API-Key": f"cs_rand{i}"}).status_code for i in range(121)]
    assert codes[:120] == [401] * 120 and codes[120] == 429
    mono.advance(1)  # 120/min = 2 tokens per second
    assert client.get("/v1/sync/mt5", headers={"X-API-Key": "cs_again"}).status_code == 401


def test_rate_limit_not_applied_to_other_endpoints(client, auth_a):
    for _ in range(40):
        assert client.get("/v1/levels", headers=auth_a).status_code == 200


def test_bucket_refills_to_capacity_only():
    t = [0.0]
    lim = TokenBucketLimiter(3, 60.0, clock=lambda: t[0])
    assert [lim.acquire("k")[0] for _ in range(4)] == [True, True, True, False]
    t[0] += 3600
    assert [lim.acquire("k")[0] for _ in range(4)] == [True, True, True, False]


def test_bucket_prunes_idle_keys():
    t = [0.0]
    lim = TokenBucketLimiter(3, 60.0, clock=lambda: t[0], idle_ttl=10)
    lim.acquire("a")
    t[0] += 11
    lim.acquire("b")
    assert set(lim._buckets) == {"b"}


def test_bucket_rejects_bad_capacity():
    with pytest.raises(ValueError):
        TokenBucketLimiter(0)
