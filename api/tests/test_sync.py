from __future__ import annotations

import csv
import io

from conftest import T0

T0_UNIX = int(T0.timestamp())
HEADER = "id,symbol,kind,price,price_to,color,deleted,updated_at"


def parse(text: str) -> tuple[int, list[dict[str, str]]]:
    lines = text.split("\n")
    assert lines[0].startswith("#cursor,")
    cursor = int(lines[0].split(",")[1])
    assert lines[1] == HEADER
    rows = list(csv.DictReader(io.StringIO("\n".join(lines[1:]))))
    return cursor, rows


def sync(client, key: str, since: int | None = None):
    params = {} if since is None else {"since": since}
    return client.get("/v1/sync/mt5", params=params, headers={"X-API-Key": key})


def test_snapshot_format(client, auth_a, add_level, issue_key, clock):
    key = issue_key(auth_a)["key"]
    s = add_level(auth_a, price=64200)
    r = add_level(auth_a, kind="resistance", price="65800.50")
    z = add_level(auth_a, kind="zone", price=63000, price_to=63400, symbol="ETHUSDT")
    clock.advance(10)

    resp = sync(client, key, 0)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    assert resp.headers["cache-control"] == "no-store"
    cursor, rows = parse(resp.text)
    assert cursor == T0_UNIX
    by_id = {row["id"]: row for row in rows}
    assert by_id[s["id"]] == {
        "id": s["id"],
        "symbol": "BTCUSDT",
        "kind": "support",
        "price": "64200",
        "price_to": "",
        "color": "0x327D2E",
        "deleted": "0",
        "updated_at": str(T0_UNIX),
    }
    assert by_id[r["id"]]["price"] == "65800.5"
    assert by_id[r["id"]]["color"] == "0x2828C6"
    assert by_id[z["id"]]["price_to"] == "63400"
    assert by_id[z["id"]]["color"] == "0xC06515"
    assert resp.text.endswith("\n")


def test_since_defaults_to_zero(client, auth_a, add_level, issue_key):
    key = issue_key(auth_a)["key"]
    add_level(auth_a)
    _, rows = parse(sync(client, key).text)
    assert len(rows) == 1


def test_cursor_semantics_with_deletes(client, auth_a, add_level, issue_key, clock):
    key = issue_key(auth_a)["key"]
    a = add_level(auth_a, price=100)
    b = add_level(auth_a, price=200)
    clock.advance(10)
    cursor0, rows = parse(sync(client, key, 0).text)
    assert cursor0 == T0_UNIX
    assert {r["id"] for r in rows} == {a["id"], b["id"]}

    # Nothing changed: no rows, cursor stays.
    cursor1, rows = parse(sync(client, key, cursor0).text)
    assert rows == [] and cursor1 == cursor0

    # Delete a, move b; both come back as changes, a flagged deleted=1.
    client.delete(f"/v1/levels/{a['id']}", headers=auth_a)
    client.patch(f"/v1/levels/{b['id']}", json={"price": 250}, headers=auth_a)
    t1 = T0_UNIX + 10
    clock.advance(10)
    cursor2, rows = parse(sync(client, key, cursor1).text)
    assert cursor2 == t1
    by_id = {r["id"]: r for r in rows}
    assert by_id[a["id"]]["deleted"] == "1"
    assert by_id[a["id"]]["updated_at"] == str(t1)
    assert by_id[b["id"]]["deleted"] == "0"
    assert by_id[b["id"]]["price"] == "250"

    # Full snapshot never includes deleted rows, but its cursor still covers the deletion.
    cursor3, rows = parse(sync(client, key, 0).text)
    assert [r["id"] for r in rows] == [b["id"]]
    assert cursor3 == t1

    # Old cursor replays nothing new after the next poll.
    cursor4, rows = parse(sync(client, key, cursor2).text)
    assert rows == [] and cursor4 == cursor2


def test_cursor_clamped_by_lag_to_avoid_same_second_loss(client, auth_a, add_level, issue_key, clock):
    key = issue_key(auth_a)["key"]
    lv = add_level(auth_a)
    # Poll in the same second the level was written: cursor must lag behind now.
    cursor, rows = parse(sync(client, key, 0).text)
    assert cursor == T0_UNIX - 2
    assert [r["id"] for r in rows] == [lv["id"]]
    # A level written right after the poll, still within the same second, is not lost.
    clock.advance(0.5)
    late = add_level(auth_a, price=1)
    clock.advance(5)
    cursor2, rows = parse(sync(client, key, cursor).text)
    assert late["id"] in {r["id"] for r in rows}
    assert cursor2 == T0_UNIX


def test_since_in_future_keeps_cursor(client, auth_a, add_level, issue_key, clock):
    key = issue_key(auth_a)["key"]
    add_level(auth_a)
    clock.advance(10)
    cursor, rows = parse(sync(client, key, T0_UNIX + 1000).text)
    assert rows == [] and cursor == T0_UNIX + 1000


def test_empty_account(client, auth_a, issue_key):
    key = issue_key(auth_a)["key"]
    resp = sync(client, key, 0)
    assert resp.text == f"#cursor,0\n{HEADER}\n"


def test_symbol_map_mt5(client, auth_a, user_a, add_level, issue_key, repo, clock):
    key = issue_key(auth_a)["key"]
    add_level(auth_a, symbol="BTCUSDT")
    add_level(auth_a, symbol="SOLUSDT", price=150)
    repo.symbol_maps[(user_a, "mt5")] = {"BTCUSDT": "BTCUSD"}
    repo.symbol_maps[(user_a, "tv")] = {"SOLUSDT": "SOLUSDT.P"}  # tv mapping must not leak into mt5
    clock.advance(10)
    _, rows = parse(sync(client, key, 0).text)
    assert sorted(r["symbol"] for r in rows) == ["BTCUSD", "SOLUSDT"]


def test_sync_only_own_levels(client, auth_a, auth_b, add_level, issue_key, clock):
    key_a = issue_key(auth_a)["key"]
    add_level(auth_b)
    clock.advance(10)
    _, rows = parse(sync(client, key_a, 0).text)
    assert rows == []


def test_sync_auth_failures(client, auth_a, issue_key):
    assert client.get("/v1/sync/mt5").status_code == 401
    assert sync(client, "cs_wrong").status_code == 401
    # JWT is not accepted on sync endpoints.
    assert client.get("/v1/sync/mt5", headers=auth_a).status_code == 401
    key = issue_key(auth_a)
    assert sync(client, key["key"]).status_code == 200
    assert client.delete(f"/v1/keys/{key['id']}", headers=auth_a).status_code == 204
    resp = sync(client, key["key"])
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Неверный или отозванный API-ключ"


def test_sync_negative_since_rejected(client, auth_a, issue_key):
    key = issue_key(auth_a)["key"]
    assert sync(client, key, -1).status_code == 422
    assert client.get("/v1/sync/mt5", params={"since": "abc"}, headers={"X-API-Key": key}).status_code == 422


def test_last_used_at_updated(client, auth_a, issue_key, repo, clock):
    key = issue_key(auth_a)
    stored = next(iter(repo.api_keys.values()))
    assert stored.last_used_at is None
    clock.advance(3)
    sync(client, key["key"])
    stored = next(iter(repo.api_keys.values()))
    assert stored.last_used_at == clock()
