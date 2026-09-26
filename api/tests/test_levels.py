from __future__ import annotations

from uuid import uuid4

import pytest


def test_create_and_list(client, auth_a, add_level):
    lv = add_level(auth_a, note="  PDH  ")
    assert lv["symbol"] == "BTCUSDT"
    assert lv["kind"] == "support"
    assert lv["price"] == 64200
    assert lv["price_to"] is None
    assert lv["tf"] == "1h"
    assert lv["note"] == "PDH"
    assert "user_id" not in lv and "deleted_at" not in lv

    resp = client.get("/v1/levels", headers=auth_a)
    assert resp.status_code == 200
    assert [x["id"] for x in resp.json()] == [lv["id"]]


def test_symbol_normalized_and_filter(client, auth_a, add_level):
    add_level(auth_a, symbol="btcusdt")
    add_level(auth_a, symbol="ETHUSDT", price=3120)
    resp = client.get("/v1/levels", params={"symbol": "ethusdt"}, headers=auth_a)
    assert resp.status_code == 200
    assert [x["symbol"] for x in resp.json()] == ["ETHUSDT"]
    assert client.get("/v1/levels", params={"symbol": "BTC,USDT"}, headers=auth_a).status_code == 422


def test_zone_create(client, auth_a, add_level):
    lv = add_level(auth_a, kind="zone", price=63000, price_to=63400.5)
    assert lv["price_to"] == 63400.5


def test_client_supplied_id_and_conflict(client, auth_a, auth_b, add_level):
    level_id = str(uuid4())
    lv = add_level(auth_a, id=level_id)
    assert lv["id"] == level_id
    body = {"id": level_id, "symbol": "BTCUSDT", "kind": "support", "price": 1, "tf": "1h"}
    assert client.post("/v1/levels", json=body, headers=auth_a).status_code == 409
    # Another user cannot claim (or overwrite) the same id either.
    assert client.post("/v1/levels", json=body, headers=auth_b).status_code == 409


@pytest.mark.parametrize(
    "patch",
    [
        {"note": "x" * 141},
        {"kind": "zone"},  # no price_to
        {"kind": "zone", "price_to": 64000},  # price_to < price
        {"kind": "zone", "price_to": 64200},  # price_to == price
        {"kind": "support", "price_to": 65000},  # price_to on non-zone
        {"kind": "trendline"},
        {"tf": "2h"},
        {"price": 0},
        {"price": -5},
        {"symbol": "BTC USDT"},
        {"symbol": "BTC,USDT"},
        {"symbol": "BTC;USDT"},
        {"symbol": "BTC:USDT"},
        {"symbol": 'BTC"USDT'},
        {"symbol": "X" * 33},
        {"symbol": "   "},
        {"tf": "15m"},
        {"tf": "4h"},
        {"tf": "1M"},
        {"tf": "1W"},  # case-sensitive: Binance/DB value is "1w"
        {"color": "red"},
        {"color": "#12345"},
        {"unexpected": 1},
    ],
)
def test_create_validation(client, auth_a, patch):
    body = {"symbol": "BTCUSDT", "kind": "support", "price": 64200, "tf": "1h"} | patch
    resp = client.post("/v1/levels", json=body, headers=auth_a)
    assert resp.status_code == 422, resp.text


@pytest.mark.parametrize("tf", ["5m", "1h", "1d", "1w"])
def test_all_timeframes_accepted(add_level, auth_a, tf):
    # Exactly the TF-bar timeframes (F3, §5.6) == last levels.tf check across supabase/migrations.
    assert add_level(auth_a, tf=tf)["tf"] == tf


def test_weekly_level_patch_and_exports_unchanged(client, auth_a, add_level, issue_key):
    # '1w' round-trips through PATCH/GET; Pine export and MT5 sync carry no tf, so a weekly
    # level is exported exactly like any other.
    key = issue_key(auth_a)["key"]
    lv = add_level(auth_a, tf="1d", price=64200)
    add_level(auth_a, tf="1w", kind="zone", price=60000, price_to=61000)
    patched = client.patch(f"/v1/levels/{lv['id']}", json={"tf": "1w"}, headers=auth_a)
    assert patched.status_code == 200, patched.text
    assert patched.json()["tf"] == "1w"
    assert {x["tf"] for x in client.get("/v1/levels", headers=auth_a).json()} == {"1w"}
    assert client.get("/v1/export/pine", headers=auth_a).text == "BTCUSDT:64200s,60000-61000z"
    csv_lines = client.get("/v1/sync/mt5", params={"since": 0}, headers={"X-API-Key": key}).text.split("\n")
    assert csv_lines[1] == "id,symbol,kind,price,price_to,color,deleted,updated_at"
    assert len([ln for ln in csv_lines[2:] if ln]) == 2


@pytest.mark.parametrize("symbol", ["币安人生USDT", "1000PEPEUSDT", "X" * 32, "A"])
def test_non_ascii_and_edge_symbols_accepted(add_level, auth_a, symbol):
    # Binance USDⓈ-M lists perps with non-ASCII names; only separators/whitespace are rejected.
    assert add_level(auth_a, symbol=symbol)["symbol"] == symbol


def test_color_create_patch_reset(client, auth_a, add_level):
    lv = add_level(auth_a)
    assert lv["color"] is None
    lv = add_level(auth_a, color="#ff8800")
    assert lv["color"] == "#ff8800"
    patched = client.patch(f"/v1/levels/{lv['id']}", json={"color": "#00FF00"}, headers=auth_a).json()
    assert patched["color"] == "#00FF00"
    reset = client.patch(f"/v1/levels/{lv['id']}", json={"color": None}, headers=auth_a).json()
    assert reset["color"] is None
    assert client.patch(f"/v1/levels/{lv['id']}", json={"color": "green"}, headers=auth_a).status_code == 422


def test_note_boundary_140(add_level, auth_a):
    assert len(add_level(auth_a, note="я" * 140)["note"]) == 140


def test_patch_updates_and_bumps_updated_at(client, auth_a, add_level, clock):
    lv = add_level(auth_a)
    clock.advance(5)
    resp = client.patch(f"/v1/levels/{lv['id']}", json={"price": 64250.5, "note": "moved"}, headers=auth_a)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["price"] == 64250.5
    assert out["note"] == "moved"
    assert out["updated_at"] > lv["updated_at"]
    assert out["created_at"] == lv["created_at"]


def test_patch_zone_to_support_clears_price_to(client, auth_a, add_level):
    lv = add_level(auth_a, kind="zone", price=63000, price_to=63400)
    resp = client.patch(f"/v1/levels/{lv['id']}", json={"kind": "support"}, headers=auth_a)
    assert resp.status_code == 200, resp.text
    assert resp.json()["price_to"] is None


def test_patch_zone_price_must_stay_below_price_to(client, auth_a, add_level):
    lv = add_level(auth_a, kind="zone", price=63000, price_to=63400)
    resp = client.patch(f"/v1/levels/{lv['id']}", json={"price": 63500}, headers=auth_a)
    assert resp.status_code == 422


@pytest.mark.parametrize(
    "patch",
    [{"kind": "zone"}, {"kind": None}, {"price": None}, {"tf": None}, {"note": "x" * 141}, {"symbol": "ETHUSDT"}],
)
def test_patch_validation(client, auth_a, add_level, patch):
    lv = add_level(auth_a)
    assert client.patch(f"/v1/levels/{lv['id']}", json=patch, headers=auth_a).status_code == 422


def test_patch_clear_note(client, auth_a, add_level):
    lv = add_level(auth_a, note="hello")
    resp = client.patch(f"/v1/levels/{lv['id']}", json={"note": None}, headers=auth_a)
    assert resp.status_code == 200
    assert resp.json()["note"] is None


def test_soft_delete(client, auth_a, add_level, repo):
    lv = add_level(auth_a)
    assert client.delete(f"/v1/levels/{lv['id']}", headers=auth_a).status_code == 204
    assert client.get("/v1/levels", headers=auth_a).json() == []
    # Row is kept with deleted_at set (soft delete), and further ops see 404.
    stored = next(iter(repo.levels.values()))
    assert stored.deleted_at is not None
    assert stored.updated_at == stored.deleted_at
    assert client.delete(f"/v1/levels/{lv['id']}", headers=auth_a).status_code == 404
    assert client.patch(f"/v1/levels/{lv['id']}", json={"price": 1}, headers=auth_a).status_code == 404


def test_user_isolation(client, auth_a, auth_b, add_level):
    lv = add_level(auth_a)
    assert client.get("/v1/levels", headers=auth_b).json() == []
    assert client.patch(f"/v1/levels/{lv['id']}", json={"price": 1}, headers=auth_b).status_code == 404
    assert client.delete(f"/v1/levels/{lv['id']}", headers=auth_b).status_code == 404
    assert len(client.get("/v1/levels", headers=auth_a).json()) == 1


def test_unknown_level_and_bad_uuid(client, auth_a):
    assert client.patch(f"/v1/levels/{uuid4()}", json={"price": 1}, headers=auth_a).status_code == 404
    assert client.delete("/v1/levels/not-a-uuid", headers=auth_a).status_code == 422


def test_levels_require_auth(client):
    assert client.get("/v1/levels").status_code == 401
    assert client.post("/v1/levels", json={}).status_code == 401
    assert client.patch(f"/v1/levels/{uuid4()}", json={}).status_code == 401
    assert client.delete(f"/v1/levels/{uuid4()}").status_code == 401
