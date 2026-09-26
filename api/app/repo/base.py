"""Repository contract. Every user-scoped method takes user_id and MUST filter by it."""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from app.models import ApiKey, Level, LevelCreate, LevelPatch, Watchlist, WatchlistIn, apply_patch

MapTarget = Literal["mt5", "tv"]


class ConflictError(Exception):
    """Raised when a client-supplied id already exists."""


class Repository(ABC):
    async def startup(self) -> None:  # pragma: no cover - default no-op
        return None

    async def shutdown(self) -> None:  # pragma: no cover - default no-op
        return None

    # ---- levels
    @abstractmethod
    async def list_levels(self, user_id: UUID, symbol: str | None = None) -> list[Level]:
        """Live (not deleted) levels ordered by (symbol, created_at)."""

    @abstractmethod
    async def get_level(self, user_id: UUID, level_id: UUID) -> Level | None:
        """Live level or None (deleted levels are treated as missing)."""

    @abstractmethod
    async def create_level(self, user_id: UUID, data: LevelCreate) -> Level: ...

    @abstractmethod
    async def update_level(self, user_id: UUID, level_id: UUID, changes: dict[str, Any]) -> Level | None: ...

    async def patch_level(self, user_id: UUID, level_id: UUID, patch: LevelPatch) -> Level | None:
        """Read-merge-validate-write a partial update. None if the level is missing/deleted.

        Raises ValueError when the merged level breaks the shape invariant (apply_patch).
        Backends with real concurrency override this to do it atomically (row lock).
        """
        current = await self.get_level(user_id, level_id)
        if current is None:
            return None
        return await self.update_level(user_id, level_id, apply_patch(current, patch))

    @abstractmethod
    async def soft_delete_level(self, user_id: UUID, level_id: UUID) -> bool: ...

    # ---- sync (API-key context)
    @abstractmethod
    async def levels_changed_since(self, user_id: UUID, since: int) -> list[Level]:
        """since == 0: live levels only (snapshot). Otherwise levels whose
        floor(epoch(updated_at)) > since, including soft-deleted ones. Ordered by updated_at."""

    @abstractmethod
    async def max_level_updated_at(self, user_id: UUID) -> datetime | None:
        """max(updated_at) over all of the user's levels, deleted included."""

    @abstractmethod
    async def symbol_map(self, user_id: UUID, target: MapTarget, *, scoped: bool = False) -> dict[str, str]:
        """source symbol -> target symbol.

        scoped=True: read in the user context (RLS applies) — for JWT / non-sync callers.
        scoped=False: service context — allowed only in sync endpoints (architecture §6).
        """

    # ---- watchlists
    @abstractmethod
    async def list_watchlists(self, user_id: UUID) -> list[Watchlist]: ...

    @abstractmethod
    async def replace_watchlists(self, user_id: UUID, items: list[WatchlistIn]) -> list[Watchlist]: ...

    # ---- api keys
    @abstractmethod
    async def create_api_key(self, user_id: UUID, name: str, key_hash: str, key_prefix: str) -> ApiKey: ...

    @abstractmethod
    async def revoke_api_key(self, user_id: UUID, key_id: UUID) -> bool:
        """Sets revoked_at; False if no active key with that id belongs to the user."""

    @abstractmethod
    async def find_active_api_key(self, key_hash: str) -> ApiKey | None:
        """Lookup by sha256 among keys with revoked_at IS NULL; updates last_used_at."""

    # ---- clock
    @abstractmethod
    async def now(self) -> datetime:
        """Server time (DB clock for Postgres), used to clamp the sync cursor."""
