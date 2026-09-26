"""Integration tests for PostgresRepository against the REAL Supabase migration.

The database is built from supabase/validate/stubs.sql (roles, auth schema, auth.users, auth.uid())
followed by supabase/migrations/*.sql in order, exactly like supabase/validate/validate.sh.
Every test starts from a freshly rebuilt public + auth schema.

Uses TEST_DATABASE_URL if set (DESTRUCTIVE: drops and recreates schemas `public` and `auth`; point it at a
throwaway plain Postgres >= 15, never at a Supabase instance), otherwise an embedded server from the
optional `pgserver` package. Skipped when neither is available.
"""

from __future__ import annotations

import asyncio
import csv
import io
import os
import re
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path
from uuid import UUID, uuid4

import asyncpg
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models import LevelCreate, LevelPatch
from app.repo.postgres import PostgresRepository
from conftest import make_settings, make_token

SUPABASE = Path(__file__).resolve().parents[2] / "supabase"
STUBS = SUPABASE / "validate" / "stubs.sql"
MIGRATIONS = sorted((SUPABASE / "migrations").glob("*.sql"))

pytestmark = pytest.mark.skipif(
    not STUBS.exists() or not MIGRATIONS, reason="supabase/validate/stubs.sql or supabase/migrations missing"
)

_CREATE_ROLE = re.compile(r"^create role (\w+)([^;]*);", re.IGNORECASE | re.MULTILINE)


def _idempotent_stubs(sql: str) -> str:
    # Roles are cluster-wide and survive the schema reset: create them only once.
    return _CREATE_ROLE.sub(
        lambda m: (
            f"do $$ begin if not exists (select 1 from pg_roles where rolname = '{m[1]}') "
            f"then create role {m[1]}{m[2]}; end if; end $$;"
        ),
        sql,
    )


def _schema_sql() -> list[str]:
    reset = """
        drop schema if exists auth cascade;
        drop schema if exists public cascade;
        create schema public;
        grant usage, create on schema public to public;
    """
    return [reset, _idempotent_stubs(STUBS.read_text(encoding="utf-8"))] + [
        f.read_text(encoding="utf-8") for f in MIGRATIONS
    ]


async def _run(url: str, *statements: tuple[str, tuple]) -> None:
    conn = await asyncpg.connect(url)
    try:
        for sql, args in statements:
            await conn.execute(sql, *args)
    finally:
        await conn.close()


@pytest.fixture(scope="module")
def pg_url() -> Iterator[str]:
    url = os.environ.get("TEST_DATABASE_URL")
    if url:
        yield url
        return
    pgserver = pytest.importorskip("pgserver", reason="set TEST_DATABASE_URL or install pgserver")
    srv = pgserver.get_server(tempfile.mkdtemp(prefix="cs-pg-"), cleanup_mode="stop")
    yield srv.get_uri()


@pytest.fixture
def pg_schema(pg_url: str) -> str:
    asyncio.run(_run(pg_url, *[(sql, ()) for sql in _schema_sql()]))
    return pg_url


@pytest.fixture
def new_user(pg_schema: str) -> Callable[[], UUID]:
    """Creates a row in auth.users (levels/watchlists/api_keys reference it)."""

    def _make() -> UUID:
        uid = uuid4()
        asyncio.run(_run(pg_schema, ("insert into auth.users (id) values ($1)", (uid,))))
        return uid

    return _make


@pytest.fixture
def pg_client(pg_schema: str) -> Iterator[TestClient]:
    settings = make_settings(repository="postgres", database_url=pg_schema, sync_cursor_lag_seconds=0)
    with TestClient(create_app(settings=settings)) as c:
        yield c


def _auth(user) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(user)}"}


def _rows(text: str) -> tuple[int, list[dict[str, str]]]:
    first, rest = text.split("\n", 1)
    return int(first.split(",")[1]), list(csv.DictReader(io.StringIO(rest)))


def test_levels_crud_and_isolation(pg_client, new_user):
    a, b = new_user(), new_user()
    body = {"symbol": "btcusdt", "kind": "zone", "price": 63000, "price_to": "63400.50", "tf": "1d", "note": "зона"}
    created = pg_client.post("/v1/levels", json=body, headers=_auth(a))
    assert created.status_code == 201, created.text
    lv = created.json()
    assert lv["symbol"] == "BTCUSDT" and lv["price_to"] == 63400.5 and lv["color"] is None

    assert pg_client.get("/v1/levels", headers=_auth(b)).json() == []
    assert pg_client.patch(f"/v1/levels/{lv['id']}", json={"price": 1}, headers=_auth(b)).status_code == 404
    assert pg_client.delete(f"/v1/levels/{lv['id']}", headers=_auth(b)).status_code == 404

    patched = pg_client.patch(
        f"/v1/levels/{lv['id']}", json={"kind": "support", "price": 63100, "color": "#AABBCC"}, headers=_auth(a)
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["price_to"] is None and patched.json()["kind"] == "support"
    assert patched.json()["color"] == "#AABBCC"
    assert patched.json()["updated_at"] >= lv["updated_at"]

    dup = pg_client.post("/v1/levels", json=body | {"id": lv["id"]}, headers=_auth(b))
    assert dup.status_code == 409

    assert pg_client.get("/v1/levels", params={"symbol": "BTCUSDT"}, headers=_auth(a)).json()[0]["id"] == lv["id"]
    assert pg_client.delete(f"/v1/levels/{lv['id']}", headers=_auth(a)).status_code == 204
    assert pg_client.get("/v1/levels", headers=_auth(a)).json() == []
    assert pg_client.delete(f"/v1/levels/{lv['id']}", headers=_auth(a)).status_code == 404


def test_only_mvp_timeframes_and_non_ascii_symbol(pg_client, new_user):
    a = new_user()
    for tf in ("5m", "1h", "1d"):
        body = {"symbol": "币安人生USDT", "kind": "support", "price": 1, "tf": tf}
        assert pg_client.post("/v1/levels", json=body, headers=_auth(a)).status_code == 201
    for tf in ("15m", "4h", "1w"):
        body = {"symbol": "BTCUSDT", "kind": "support", "price": 1, "tf": tf}
        assert pg_client.post("/v1/levels", json=body, headers=_auth(a)).status_code == 422


def test_unknown_user_is_409_not_500(pg_client):
    # Valid JWT for a user missing from auth.users (e.g. deleted account): FK violation -> 409.
    body = {"symbol": "BTCUSDT", "kind": "support", "price": 1, "tf": "1h"}
    resp = pg_client.post("/v1/levels", json=body, headers=_auth(uuid4()))
    assert resp.status_code == 409, resp.text


def test_watchlists_roundtrip(pg_client, new_user):
    a, b = new_user(), new_user()
    out = pg_client.put(
        "/v1/watchlists", json=[{"name": "A", "symbols": ["btcusdt", "ETHUSDT"]}, {"name": "B"}], headers=_auth(a)
    ).json()
    assert [w["position"] for w in out] == [0, 1] and out[0]["symbols"] == ["BTCUSDT", "ETHUSDT"]
    assert pg_client.get("/v1/watchlists", headers=_auth(a)).json() == out
    # Foreign id reuse gets a fresh id and does not touch A's data.
    other = pg_client.put("/v1/watchlists", json=[{"id": out[0]["id"], "name": "X"}], headers=_auth(b)).json()
    assert other[0]["id"] != out[0]["id"]
    assert pg_client.get("/v1/watchlists", headers=_auth(a)).json() == out
    kept = pg_client.put("/v1/watchlists", json=[{"id": out[1]["id"], "name": "B2"}], headers=_auth(a)).json()
    assert kept[0]["id"] == out[1]["id"] and len(pg_client.get("/v1/watchlists", headers=_auth(a)).json()) == 1
    # Same name twice (unique (user_id, name)) -> 422, previous data intact.
    dup = pg_client.put("/v1/watchlists", json=[{"name": "Избранное"}, {"name": "Избранное "}], headers=_auth(a))
    assert dup.status_code == 422 and dup.json()["detail"] == "Названия вотчлистов должны быть уникальными"
    assert pg_client.get("/v1/watchlists", headers=_auth(a)).json() == kept
    # Re-PUT of the same names (delete + insert in one tx) does not trip the unique constraint.
    again = pg_client.put("/v1/watchlists", json=[{"name": "B2"}, {"name": "C"}], headers=_auth(a))
    assert again.status_code == 200, again.text


def test_keys_sync_and_pine(pg_client, pg_schema, new_user):
    a = new_user()
    key = pg_client.post("/v1/keys", json={"name": "VPS"}, headers=_auth(a)).json()
    assert key["key_prefix"] == key["key"][:8]
    x = {"X-API-Key": key["key"]}
    s = pg_client.post(
        "/v1/levels", json={"symbol": "BTCUSDT", "kind": "support", "price": "64200.00", "tf": "1h"}, headers=_auth(a)
    ).json()
    pg_client.post(
        "/v1/levels",
        json={"symbol": "ETHUSDT", "kind": "resistance", "price": 3120, "tf": "1d", "color": "#102030"},
        headers=_auth(a),
    )
    asyncio.run(
        _run(
            pg_schema,
            (
                "insert into symbol_map (user_id, symbol, target, target_symbol) values ($1, 'BTCUSDT', 'mt5', 'BTCUSD')",
                (a,),
            ),
            (
                "insert into symbol_map (user_id, symbol, target, target_symbol) values ($1, 'ETHUSDT', 'tv', 'ETHUSDT.P')",
                (a,),
            ),
        )
    )

    resp = pg_client.get("/v1/sync/mt5", params={"since": 0}, headers=x)
    assert resp.status_code == 200, resp.text
    cursor, rows = _rows(resp.text)
    by_symbol = {r["symbol"]: r for r in rows}
    assert set(by_symbol) == {"BTCUSD", "ETHUSDT"}
    assert by_symbol["BTCUSD"]["price"] == "64200" and by_symbol["BTCUSD"]["color"] == "0x327D2E"
    assert by_symbol["ETHUSDT"]["color"] == "0x302010"  # per-level colour, BGR
    assert cursor >= int(by_symbol["BTCUSD"]["updated_at"])

    before_delete = cursor - 1
    assert pg_client.delete(f"/v1/levels/{s['id']}", headers=_auth(a)).status_code == 204
    _, rows = _rows(pg_client.get("/v1/sync/mt5", params={"since": before_delete}, headers=x).text)
    deleted = [r for r in rows if r["id"] == s["id"]]
    assert deleted and deleted[0]["deleted"] == "1"
    _, snapshot = _rows(pg_client.get("/v1/sync/mt5", params={"since": 0}, headers=x).text)
    assert [r["symbol"] for r in snapshot] == ["ETHUSDT"]

    # tv symbol_map is read in the user context (RLS) for both principals.
    assert pg_client.get("/v1/export/pine", headers=_auth(a)).text == "ETHUSDT.P:3120r"
    assert pg_client.get("/v1/export/pine", headers=x).text == "ETHUSDT.P:3120r"

    assert pg_client.delete(f"/v1/keys/{key['id']}", headers=_auth(new_user())).status_code == 404
    assert pg_client.delete(f"/v1/keys/{key['id']}", headers=_auth(a)).status_code == 204
    assert pg_client.get("/v1/sync/mt5", headers=x).status_code == 401


async def test_user_tx_runs_under_rls(pg_schema):
    repo = PostgresRepository(pg_schema, enforce_rls=True)
    await repo.startup()
    try:
        user = uuid4()
        async with repo._user_tx(user) as conn:
            assert await conn.fetchval("select current_user") == "authenticated"
            assert await conn.fetchval("select auth.uid()") == user
            # RLS rejects rows for another user even if our own filter were missing.
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await conn.execute(
                    "insert into levels (user_id, symbol, kind, price, tf) values ($1, 'BTCUSDT', 'support', 1, '1h')",
                    uuid4(),
                )
        async with repo._user_tx(user) as conn:
            # Hard DELETE on levels is not granted (soft delete only, §6).
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await conn.execute("delete from levels where user_id = $1", user)
        async with repo.pool.acquire() as conn:
            assert await conn.fetchval("select current_user") != "authenticated"  # role reset after tx
    finally:
        await repo.shutdown()


async def test_concurrent_patches_never_break_zone_constraint(pg_schema):
    user = uuid4()
    await _run(pg_schema, ("insert into auth.users (id) values ($1)", (user,)))
    repo = PostgresRepository(pg_schema, enforce_rls=True, max_size=4)
    await repo.startup()
    try:
        lv = await repo.create_level(user, LevelCreate(symbol="BTCUSDT", kind="support", price=100, tf="1h"))
        to_zone = LevelPatch(kind="zone", price_to=110)
        raise_price = LevelPatch(price=120)
        results = await asyncio.gather(
            repo.patch_level(user, lv.id, to_zone), repo.patch_level(user, lv.id, raise_price), return_exceptions=True
        )
        # Serialized by the row lock: whichever runs second sees the other's result and fails
        # apply_patch validation (ValueError -> 422), never a DB CheckViolation (-> was 500).
        assert not any(isinstance(r, asyncpg.PostgresError) for r in results), results
        assert sum(isinstance(r, ValueError) for r in results) == 1, results
    finally:
        await repo.shutdown()


async def test_db_constraints_surface_as_asyncpg_errors(pg_schema):
    """The handlers in app.main rely on these exception classes / constraint names."""
    user = uuid4()
    await _run(pg_schema, ("insert into auth.users (id) values ($1)", (user,)))
    repo = PostgresRepository(pg_schema, enforce_rls=True)
    await repo.startup()
    try:
        lv = await repo.create_level(user, LevelCreate(symbol="BTCUSDT", kind="support", price=100, tf="1h"))
        with pytest.raises(asyncpg.CheckViolationError) as info:
            await repo.update_level(user, lv.id, {"price_to": 5})
        assert info.value.constraint_name == "levels_price_to_iff_zone"
        key = await repo.create_api_key(user, "k", "a" * 64, "cs_abcde")
        assert key.key_prefix == "cs_abcde"
        assert await repo.revoke_api_key(user, key.id)
        async with repo._user_tx(user) as conn:
            with pytest.raises(asyncpg.CheckViolationError):  # api_keys_guard: revocation is final
                await conn.execute("update api_keys set revoked_at = null where id = $1", key.id)
    finally:
        await repo.shutdown()
