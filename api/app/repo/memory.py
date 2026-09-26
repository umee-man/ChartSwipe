"""In-memory repository for tests and local development. Not for production."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from app.models import ApiKey, Level, LevelCreate, Watchlist, WatchlistIn, check_unique_watchlist_names
from app.repo.base import ConflictError, MapTarget, Repository


def _utcnow() -> datetime:
    return datetime.now(UTC)


class MemoryRepository(Repository):
    def __init__(self, clock: Callable[[], datetime] = _utcnow) -> None:
        self.clock = clock
        self.levels: dict[UUID, Level] = {}
        self.watchlists: dict[UUID, list[Watchlist]] = {}
        self.api_keys: dict[UUID, ApiKey] = {}
        # (user_id, target) -> {symbol: mapped}
        self.symbol_maps: dict[tuple[UUID, str], dict[str, str]] = {}

    # ---- levels
    async def list_levels(self, user_id: UUID, symbol: str | None = None) -> list[Level]:
        rows = [
            lv
            for lv in self.levels.values()
            if lv.user_id == user_id and lv.deleted_at is None and (symbol is None or lv.symbol == symbol)
        ]
        return sorted(rows, key=lambda lv: (lv.symbol, lv.created_at))

    async def get_level(self, user_id: UUID, level_id: UUID) -> Level | None:
        lv = self.levels.get(level_id)
        if lv is None or lv.user_id != user_id or lv.deleted_at is not None:
            return None
        return lv

    async def create_level(self, user_id: UUID, data: LevelCreate) -> Level:
        level_id = data.id or uuid4()
        if level_id in self.levels:
            raise ConflictError(level_id)
        now = self.clock()
        lv = Level(
            id=level_id,
            user_id=user_id,
            symbol=data.symbol,
            kind=data.kind,
            price=data.price,
            price_to=data.price_to,
            tf=data.tf,
            note=data.note,
            color=data.color,
            created_at=now,
            updated_at=now,
        )
        self.levels[level_id] = lv
        return lv

    async def update_level(self, user_id: UUID, level_id: UUID, changes: dict[str, Any]) -> Level | None:
        lv = await self.get_level(user_id, level_id)
        if lv is None:
            return None
        updated = lv.model_copy(update={**changes, "updated_at": self.clock()})
        self.levels[level_id] = updated
        return updated

    async def soft_delete_level(self, user_id: UUID, level_id: UUID) -> bool:
        lv = await self.get_level(user_id, level_id)
        if lv is None:
            return False
        now = self.clock()
        self.levels[level_id] = lv.model_copy(update={"deleted_at": now, "updated_at": now})
        return True

    # ---- sync
    async def levels_changed_since(self, user_id: UUID, since: int) -> list[Level]:
        mine = [lv for lv in self.levels.values() if lv.user_id == user_id]
        if since == 0:
            rows = [lv for lv in mine if lv.deleted_at is None]
        else:
            rows = [lv for lv in mine if int(lv.updated_at.timestamp()) > since]
        return sorted(rows, key=lambda lv: (lv.updated_at, str(lv.id)))

    async def max_level_updated_at(self, user_id: UUID) -> datetime | None:
        times = [lv.updated_at for lv in self.levels.values() if lv.user_id == user_id]
        return max(times) if times else None

    async def symbol_map(self, user_id: UUID, target: MapTarget, *, scoped: bool = False) -> dict[str, str]:
        return dict(self.symbol_maps.get((user_id, target), {}))

    # ---- watchlists
    async def list_watchlists(self, user_id: UUID) -> list[Watchlist]:
        return list(self.watchlists.get(user_id, []))

    async def replace_watchlists(self, user_id: UUID, items: list[WatchlistIn]) -> list[Watchlist]:
        check_unique_watchlist_names(items)  # mirrors unique (user_id, name) in the real schema
        now = self.clock()
        # A client-supplied id that belongs to another user must not be reused.
        foreign = {w.id for uid, ws in self.watchlists.items() if uid != user_id for w in ws}
        result = []
        for pos, item in enumerate(items):
            wid = item.id if item.id and item.id not in foreign else uuid4()
            result.append(Watchlist(id=wid, name=item.name, symbols=item.symbols, position=pos, updated_at=now))
        self.watchlists[user_id] = result
        return list(result)

    # ---- api keys
    async def create_api_key(self, user_id: UUID, name: str, key_hash: str, key_prefix: str) -> ApiKey:
        key = ApiKey(
            id=uuid4(), user_id=user_id, name=name, key_hash=key_hash, key_prefix=key_prefix, created_at=self.clock()
        )
        self.api_keys[key.id] = key
        return key

    async def revoke_api_key(self, user_id: UUID, key_id: UUID) -> bool:
        key = self.api_keys.get(key_id)
        if key is None or key.user_id != user_id or key.revoked_at is not None:
            return False
        self.api_keys[key_id] = key.model_copy(update={"revoked_at": self.clock()})
        return True

    async def find_active_api_key(self, key_hash: str) -> ApiKey | None:
        for key in self.api_keys.values():
            if key.key_hash == key_hash and key.revoked_at is None:
                touched = key.model_copy(update={"last_used_at": self.clock()})
                self.api_keys[key.id] = touched
                return touched
        return None

    async def now(self) -> datetime:
        return self.clock()
