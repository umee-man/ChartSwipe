"""Pydantic v2 models: request/response contracts and domain records."""

from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Annotated, Any
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PlainSerializer,
    field_validator,
    model_validator,
)

NOTE_MAX_LEN = 140
SYMBOL_MAX_LEN = 32  # matches levels.symbol / symbol_map.symbol check (1..32) in supabase/migrations
# Any non-blank text without the CSV / Pine separators (`,` `;` `:`), quotes or control characters.
# Binance USDⓈ-M lists perps with non-ASCII names (e.g. CJK tickers), so no ASCII-only class here.
SYMBOL_RE = re.compile(rf'^[^\s\x00-\x1f\x7f,;:"]{{1,{SYMBOL_MAX_LEN}}}$')
COLOR_RE = r"^#[0-9A-Fa-f]{6}$"  # levels.color: RGB hex, NULL = default colour by kind (ADR A7)
WATCHLIST_MAX_SYMBOLS = 500


class LevelKind(StrEnum):
    support = "support"
    resistance = "resistance"
    zone = "zone"


class Timeframe(StrEnum):
    """The three timeframes of the MVP (F3, detector table §5.6; levels.tf check in the migration)."""

    m5 = "5m"
    h1 = "1h"
    d1 = "1d"


# Prices travel as JSON numbers but are kept as Decimal internally (numeric in Postgres)
# so CSV / Pine output never shows float artefacts.
_as_json_number = PlainSerializer(lambda v: float(v), return_type=float, when_used="json")
# Input prices: validated. Stored prices (read back from numeric columns): accepted as-is.
Price = Annotated[Decimal, Field(gt=0, max_digits=30, decimal_places=12), _as_json_number]
StoredPrice = Annotated[Decimal, _as_json_number]
Color = Annotated[str, Field(pattern=COLOR_RE)]


def normalize_symbol(value: str) -> str:
    symbol = value.strip().upper()
    if not SYMBOL_RE.match(symbol):
        raise ValueError(f"Недопустимый символ: 1–{SYMBOL_MAX_LEN} знаков без пробелов, запятых, точек с запятой, двоеточий и кавычек")
    return symbol


def _normalize_note(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if len(value) > NOTE_MAX_LEN:
        raise ValueError(f"Заметка длиннее {NOTE_MAX_LEN} символов")
    return value or None


def check_level_shape(kind: LevelKind, price: Decimal, price_to: Decimal | None) -> None:
    """Invariant shared by create and patch: zone needs price_to > price; others have none."""
    if kind == LevelKind.zone:
        if price_to is None:
            raise ValueError("Для зоны нужна верхняя граница price_to")
        if price_to <= price:
            raise ValueError("Верхняя граница зоны должна быть больше нижней")
    elif price_to is not None:
        raise ValueError("price_to допустим только для зоны")


# ---------------------------------------------------------------- levels


class LevelCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID | None = None  # client may pre-generate the id for optimistic updates
    symbol: str
    kind: LevelKind
    price: Price
    price_to: Price | None = None
    tf: Timeframe
    note: str | None = None
    color: Color | None = None  # '#RRGGBB'; None = default colour of the kind

    @field_validator("symbol")
    @classmethod
    def _symbol(cls, v: str) -> str:
        return normalize_symbol(v)

    @field_validator("note")
    @classmethod
    def _note(cls, v: str | None) -> str | None:
        return _normalize_note(v)

    @model_validator(mode="after")
    def _shape(self) -> LevelCreate:
        check_level_shape(self.kind, self.price, self.price_to)
        return self


class LevelPatch(BaseModel):
    """Partial update. Only fields present in the body are changed."""

    model_config = ConfigDict(extra="forbid")

    kind: LevelKind | None = None
    price: Price | None = None
    price_to: Price | None = None
    tf: Timeframe | None = None
    note: str | None = None
    color: Color | None = None  # explicit null resets to the default colour of the kind

    @field_validator("note")
    @classmethod
    def _note(cls, v: str | None) -> str | None:
        return _normalize_note(v)

    @model_validator(mode="after")
    def _non_null(self) -> LevelPatch:
        for name in ("kind", "price", "tf"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"Поле {name} не может быть пустым")
        return self


class Level(BaseModel):
    id: UUID
    user_id: UUID
    symbol: str
    kind: LevelKind
    price: StoredPrice
    price_to: StoredPrice | None = None
    tf: Timeframe
    note: str | None = None
    color: str | None = None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None


class LevelOut(BaseModel):
    id: UUID
    symbol: str
    kind: LevelKind
    price: StoredPrice
    price_to: StoredPrice | None = None
    tf: Timeframe
    note: str | None = None
    color: str | None = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_level(cls, level: Level) -> LevelOut:
        return cls.model_validate(level.model_dump(exclude={"user_id", "deleted_at"}))


def apply_patch(level: Level, patch: LevelPatch) -> dict[str, Any]:
    """Merge a patch into a level, validate the result and return the changed columns."""
    changes: dict[str, Any] = {k: getattr(patch, k) for k in patch.model_fields_set}
    kind = changes.get("kind", level.kind)
    # Switching away from zone drops the upper bound unless the client sent one explicitly.
    if kind != LevelKind.zone and "price_to" not in changes and level.price_to is not None:
        changes["price_to"] = None
    check_level_shape(kind, changes.get("price", level.price), changes.get("price_to", level.price_to))
    return changes


# ---------------------------------------------------------------- watchlists


class WatchlistIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID | None = None
    name: str = Field(min_length=1, max_length=64)
    symbols: list[str] = Field(default_factory=list, max_length=WATCHLIST_MAX_SYMBOLS)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Название вотчлиста не может быть пустым")
        return v

    @field_validator("symbols")
    @classmethod
    def _symbols(cls, v: list[str]) -> list[str]:
        seen: dict[str, None] = {}
        for raw in v:
            seen.setdefault(normalize_symbol(raw), None)  # dedupe, keep order
        return list(seen)


def check_unique_watchlist_names(items: list[WatchlistIn]) -> list[WatchlistIn]:
    """Mirrors `unique (user_id, name)` on public.watchlists (names are already stripped)."""
    seen: set[str] = set()
    for item in items:
        if item.name in seen:
            raise ValueError("Названия вотчлистов должны быть уникальными")
        seen.add(item.name)
    return items


class Watchlist(BaseModel):
    id: UUID
    name: str
    symbols: list[str]
    position: int
    updated_at: datetime


# ---------------------------------------------------------------- api keys


class ApiKeyCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(default="MT5", min_length=1, max_length=64)


KEY_PREFIX_LEN = 8  # e.g. 'cs_AbCdE' — shown in the UI to tell keys apart (api_keys.key_prefix)


class ApiKey(BaseModel):
    id: UUID
    user_id: UUID
    name: str | None = None
    key_hash: str
    key_prefix: str | None = None
    created_at: datetime
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None


class ApiKeyCreated(BaseModel):
    """Returned exactly once: the plaintext key is never stored or shown again."""

    id: UUID
    name: str | None = None
    key: str
    key_prefix: str | None = None
    created_at: datetime
