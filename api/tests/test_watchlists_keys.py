from __future__ import annotations

import hashlib
from uuid import uuid4


# ---------------------------------------------------------------- watchlists


def test_watchlists_empty(client, auth_a):
    resp = client.get("/v1/watchlists", headers=auth_a)
    assert resp.status_code == 200 and resp.json() == []


def test_watchlists_put_and_get(client, auth_a):
    body = [
        {"name": " Мой список ", "symbols": ["btcusdt", "ETHUSDT", "BTCUSDT"]},
        {"name": "Альты", "symbols": ["SOLUSDT"]},
    ]
    resp = client.put("/v1/watchlists", json=body, headers=auth_a)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert [w["name"] for w in out] == ["Мой список", "Альты"]
    assert [w["position"] for w in out] == [0, 1]
    assert out[0]["symbols"] == ["BTCUSDT", "ETHUSDT"]  # uppercased, deduped, order kept
    assert client.get("/v1/watchlists", headers=auth_a).json() == out


def test_watchlists_put_replaces_and_keeps_ids(client, auth_a):
    first = client.put("/v1/watchlists", json=[{"name": "A"}, {"name": "B"}], headers=auth_a).json()
    b_id = first[1]["id"]
    second = client.put(
        "/v1/watchlists", json=[{"id": b_id, "name": "B2", "symbols": ["XRPUSDT"]}], headers=auth_a
    ).json()
    assert len(second) == 1
    assert second[0]["id"] == b_id and second[0]["name"] == "B2" and second[0]["position"] == 0
    assert client.put("/v1/watchlists", json=[], headers=auth_a).json() == []
    assert client.get("/v1/watchlists", headers=auth_a).json() == []


def test_watchlists_isolation_and_foreign_id(client, auth_a, auth_b):
    a = client.put("/v1/watchlists", json=[{"name": "A", "symbols": ["BTCUSDT"]}], headers=auth_a).json()
    assert client.get("/v1/watchlists", headers=auth_b).json() == []
    # B tries to reuse A's id: gets a fresh id, A's list is untouched.
    b = client.put("/v1/watchlists", json=[{"id": a[0]["id"], "name": "B"}], headers=auth_b).json()
    assert b[0]["id"] != a[0]["id"]
    assert client.get("/v1/watchlists", headers=auth_a).json() == a


def test_watchlists_validation(client, auth_a):
    bad = [
        [{"name": ""}],
        [{"name": "   "}],
        [{"name": "x" * 65}],
        [{"name": "ok", "symbols": ["BTC:USDT"]}],
        [{"name": "ok", "symbols": ["BTCUSDT"] * 501}],
        [{"name": f"w{i}"} for i in range(51)],
        {"name": "not a list"},
    ]
    for body in bad:
        assert client.put("/v1/watchlists", json=body, headers=auth_a).status_code == 422, body


def test_watchlists_duplicate_names_rejected(client, auth_a):
    # watchlists_user_name_key unique (user_id, name): names compared after strip.
    body = [{"name": "Избранное", "symbols": ["BTCUSDT"]}, {"name": " Избранное ", "symbols": ["ETHUSDT"]}]
    resp = client.put("/v1/watchlists", json=body, headers=auth_a)
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Названия вотчлистов должны быть уникальными"
    assert client.get("/v1/watchlists", headers=auth_a).json() == []  # nothing written


def test_watchlists_require_auth(client):
    assert client.get("/v1/watchlists").status_code == 401
    assert client.put("/v1/watchlists", json=[]).status_code == 401


# ---------------------------------------------------------------- keys


def test_key_issue_returns_plaintext_once_and_stores_hash(client, auth_a, user_a, repo):
    resp = client.post("/v1/keys", json={"name": "VPS"}, headers=auth_a)
    assert resp.status_code == 201
    out = resp.json()
    assert out["key"].startswith("cs_") and len(out["key"]) > 40
    assert out["name"] == "VPS"
    stored = repo.api_keys[next(iter(repo.api_keys))]
    assert str(stored.id) == out["id"]
    assert stored.user_id == user_a
    assert stored.key_hash == hashlib.sha256(out["key"].encode()).hexdigest()
    assert out["key"] not in stored.model_dump_json()
    # Non-secret display prefix (api_keys.key_prefix) is stored and returned.
    assert out["key_prefix"] == out["key"][:8] == stored.key_prefix


def test_key_default_name_and_unique(client, auth_a):
    k1 = client.post("/v1/keys", headers=auth_a).json()
    k2 = client.post("/v1/keys", headers=auth_a).json()
    assert k1["name"] == "MT5"
    assert k1["key"] != k2["key"]


def test_key_validation(client, auth_a):
    assert client.post("/v1/keys", json={"name": ""}, headers=auth_a).status_code == 422
    assert client.post("/v1/keys", json={"name": "x" * 65}, headers=auth_a).status_code == 422


def test_key_revoke(client, auth_a, auth_b, issue_key):
    key = issue_key(auth_a)
    assert client.delete(f"/v1/keys/{key['id']}", headers=auth_b).status_code == 404  # not owner
    assert client.delete(f"/v1/keys/{key['id']}", headers=auth_a).status_code == 204
    assert client.delete(f"/v1/keys/{key['id']}", headers=auth_a).status_code == 404  # already revoked
    assert client.delete(f"/v1/keys/{uuid4()}", headers=auth_a).status_code == 404


def test_keys_require_jwt(client, auth_a, issue_key):
    key = issue_key(auth_a)
    assert client.post("/v1/keys").status_code == 401
    # An API key cannot mint or revoke keys.
    assert client.post("/v1/keys", headers={"X-API-Key": key["key"]}).status_code == 401
    assert client.delete(f"/v1/keys/{key['id']}", headers={"X-API-Key": key["key"]}).status_code == 401
