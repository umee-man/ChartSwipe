"""Postgres (Supabase) repository on asyncpg.

User-scoped calls (JWT context) run inside a transaction that switches to role
`authenticated` and sets `request.jwt.claims`, so Supabase RLS policies apply in
addition to the explicit `user_id = $1` filters (architecture §6). Sync / API-key
calls run as the connection owner (service context) and still filter by user_id.

DB constraint / trigger errors (asyncpg IntegrityConstraintViolationError subclasses)
are mapped to HTTP 409/422 by the exception handlers in app/main.py.

Assumed columns are listed in api/README.md ("Database contract").
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any
from uuid import UUID

import asyncpg

from app.models import ApiKey, Level, LevelCreate, LevelPatch, Watchlist, WatchlistIn, apply_patch
from app.repo.base import ConflictError, MapTarget, Repository

LEVEL_COLS = "id, user_id, symbol, kind, price, price_to, tf, note, color, created_at, updated_at, deleted_at"
WATCHLIST_COLS = "id, name, symbols, position, updated_at"
API_KEY_COLS = "id, user_id, name, key_hash, key_prefix, created_at, last_used_at, revoked_at"
# Only these columns may be written through update_level (guards the dynamic SET clause).
LEVEL_PATCHABLE = frozenset({"kind", "price", "price_to", "tf", "note", "color"})


def _level(row: asyncpg.Record) -> Level:
    return Level.model_validate(dict(row))


def _api_key(row: asyncpg.Record) -> ApiKey:
    return ApiKey.model_validate(dict(row))


class PostgresRepository(Repository):
    def __init__(self, dsn: str, *, min_size: int = 1, max_size: int = 10, enforce_rls: bool = True) -> None:
        self.dsn = dsn
        self.min_size = min_size
        self.max_size = max_size
        self.enforce_rls = enforce_rls
        self._pool: asyncpg.Pool | None = None

    async def startup(self) -> None:
        # statement_cache_size=0 keeps us compatible with Supabase's transaction pooler (pgbouncer).
        self._pool = await asyncpg.create_pool(
            self.dsn, min_size=self.min_size, max_size=self.max_size, statement_cache_size=0
        )

    async def shutdown(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("PostgresRepository.startup() was not called")
        return self._pool

    @asynccontextmanager
    async def _user_tx(self, user_id: UUID) -> AsyncIterator[asyncpg.Connection]:
        async with self.pool.acquire() as conn, conn.transaction():
            if self.enforce_rls:
                claims = json.dumps({"sub": str(user_id), "role": "authenticated"})
                await conn.execute("set local role authenticated")
                # Supabase's auth.uid() reads request.jwt.claims (current) or request.jwt.claim.sub
                # (legacy, also used by supabase/validate/stubs.sql) - set both, transaction-local.
                await conn.execute(
                    """select set_config('request.jwt.claims', $1, true),
                              set_config('request.jwt.claim.sub', $2, true),
                              set_config('request.jwt.claim.role', 'authenticated', true)""",
                    claims,
                    str(user_id),
                )
            yield conn

    # ---- levels
    async def list_levels(self, user_id: UUID, symbol: str | None = None) -> list[Level]:
        async with self._user_tx(user_id) as conn:
            rows = await conn.fetch(
                f"""select {LEVEL_COLS} from levels
                    where user_id = $1 and deleted_at is null and ($2::text is null or symbol = $2)
                    order by symbol, created_at, id""",
                user_id,
                symbol,
            )
        return [_level(r) for r in rows]

    async def get_level(self, user_id: UUID, level_id: UUID) -> Level | None:
        async with self._user_tx(user_id) as conn:
            row = await conn.fetchrow(
                f"select {LEVEL_COLS} from levels where user_id = $1 and id = $2 and deleted_at is null",
                user_id,
                level_id,
            )
        return _level(row) if row else None

    async def create_level(self, user_id: UUID, data: LevelCreate) -> Level:
        try:
            async with self._user_tx(user_id) as conn:
                row = await conn.fetchrow(
                    f"""insert into levels (id, user_id, symbol, kind, price, price_to, tf, note, color)
                        values (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9)
                        returning {LEVEL_COLS}""",
                    data.id,
                    user_id,
                    data.symbol,
                    data.kind.value,
                    data.price,
                    data.price_to,
                    data.tf.value,
                    data.note,
                    data.color,
                )
        except asyncpg.UniqueViolationError as exc:
            raise ConflictError(data.id) from exc
        return _level(row)

    @staticmethod
    async def _update_level(
        conn: asyncpg.Connection, user_id: UUID, level_id: UUID, changes: dict[str, Any]
    ) -> asyncpg.Record | None:
        unknown = set(changes) - LEVEL_PATCHABLE
        if unknown:
            raise ValueError(f"non-patchable columns: {sorted(unknown)}")
        cols = sorted(changes)
        values = [getattr(changes[c], "value", changes[c]) for c in cols]  # enums -> str
        sets = ", ".join(f"{c} = ${i}" for i, c in enumerate(cols, start=3))
        sets = f"{sets}, updated_at = now()" if sets else "updated_at = now()"
        return await conn.fetchrow(
            f"""update levels set {sets}
                where user_id = $1 and id = $2 and deleted_at is null
                returning {LEVEL_COLS}""",
            user_id,
            level_id,
            *values,
        )

    async def update_level(self, user_id: UUID, level_id: UUID, changes: dict[str, Any]) -> Level | None:
        async with self._user_tx(user_id) as conn:
            row = await self._update_level(conn, user_id, level_id, changes)
        return _level(row) if row else None

    async def patch_level(self, user_id: UUID, level_id: UUID, patch: LevelPatch) -> Level | None:
        # One transaction with a row lock: a concurrent PATCH cannot change kind/price between
        # our read and write, so the merged row always satisfies the zone constraints.
        async with self._user_tx(user_id) as conn:
            row = await conn.fetchrow(
                f"""select {LEVEL_COLS} from levels
                    where user_id = $1 and id = $2 and deleted_at is null
                    for update""",
                user_id,
                level_id,
            )
            if row is None:
                return None
            changes = apply_patch(_level(row), patch)  # ValueError -> rollback, 422 in the router
            updated = await self._update_level(conn, user_id, level_id, changes)
        return _level(updated) if updated else None

    async def soft_delete_level(self, user_id: UUID, level_id: UUID) -> bool:
        async with self._user_tx(user_id) as conn:
            result = await conn.execute(
                """update levels set deleted_at = now(), updated_at = now()
                   where user_id = $1 and id = $2 and deleted_at is null""",
                user_id,
                level_id,
            )
        return result.endswith(" 1")

    # ---- sync (service context, explicit user filter)
    async def levels_changed_since(self, user_id: UUID, since: int) -> list[Level]:
        if since == 0:
            sql = f"""select {LEVEL_COLS} from levels
                      where user_id = $1 and deleted_at is null
                      order by updated_at, id"""
            rows = await self.pool.fetch(sql, user_id)
        else:
            # floor(epoch(updated_at)) > since  <=>  updated_at >= to_timestamp(since + 1)
            sql = f"""select {LEVEL_COLS} from levels
                      where user_id = $1 and updated_at >= to_timestamp($2::bigint + 1)
                      order by updated_at, id"""
            rows = await self.pool.fetch(sql, user_id, since)
        return [_level(r) for r in rows]

    async def max_level_updated_at(self, user_id: UUID) -> datetime | None:
        return await self.pool.fetchval("select max(updated_at) from levels where user_id = $1", user_id)

    async def symbol_map(self, user_id: UUID, target: MapTarget, *, scoped: bool = False) -> dict[str, str]:
        sql = "select symbol, target_symbol from symbol_map where user_id = $1 and target = $2"
        if scoped:
            async with self._user_tx(user_id) as conn:
                rows = await conn.fetch(sql, user_id, target)
        else:
            rows = await self.pool.fetch(sql, user_id, target)
        return {r["symbol"]: r["target_symbol"] for r in rows}

    # ---- watchlists
    async def list_watchlists(self, user_id: UUID) -> list[Watchlist]:
        async with self._user_tx(user_id) as conn:
            rows = await conn.fetch(
                f"select {WATCHLIST_COLS} from watchlists where user_id = $1 order by position, name",
                user_id,
            )
        return [Watchlist.model_validate(dict(r)) for r in rows]

    async def replace_watchlists(self, user_id: UUID, items: list[WatchlistIn]) -> list[Watchlist]:
        result: list[Watchlist] = []
        async with self._user_tx(user_id) as conn:
            await conn.execute("delete from watchlists where user_id = $1", user_id)
            for pos, item in enumerate(items):
                row = None
                if item.id is not None:
                    # A conflicting id here can only belong to another user: fall back to a new id.
                    row = await conn.fetchrow(
                        f"""insert into watchlists (id, user_id, name, symbols, position)
                            values ($1, $2, $3, $4, $5) on conflict (id) do nothing
                            returning {WATCHLIST_COLS}""",
                        item.id,
                        user_id,
                        item.name,
                        item.symbols,
                        pos,
                    )
                if row is None:
                    row = await conn.fetchrow(
                        f"""insert into watchlists (id, user_id, name, symbols, position)
                            values (gen_random_uuid(), $1, $2, $3, $4)
                            returning {WATCHLIST_COLS}""",
                        user_id,
                        item.name,
                        item.symbols,
                        pos,
                    )
                result.append(Watchlist.model_validate(dict(row)))
        return result

    # ---- api keys
    async def create_api_key(self, user_id: UUID, name: str, key_hash: str, key_prefix: str) -> ApiKey:
        async with self._user_tx(user_id) as conn:
            row = await conn.fetchrow(
                f"""insert into api_keys (user_id, name, key_hash, key_prefix) values ($1, $2, $3, $4)
                    returning {API_KEY_COLS}""",
                user_id,
                name,
                key_hash,
                key_prefix,
            )
        return _api_key(row)

    async def revoke_api_key(self, user_id: UUID, key_id: UUID) -> bool:
        async with self._user_tx(user_id) as conn:
            result = await conn.execute(
                "update api_keys set revoked_at = now() where user_id = $1 and id = $2 and revoked_at is null",
                user_id,
                key_id,
            )
        return result.endswith(" 1")

    async def find_active_api_key(self, key_hash: str) -> ApiKey | None:
        row = await self.pool.fetchrow(
            f"""update api_keys set last_used_at = now()
                where key_hash = $1 and revoked_at is null
                returning {API_KEY_COLS}""",
            key_hash,
        )
        return _api_key(row) if row else None

    async def now(self) -> datetime:
        return await self.pool.fetchval("select now()")
