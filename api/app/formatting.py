"""Pure output formatters: MT5 CSV (architecture §7, ADR A6/A7) and the Pine string (§7, §9)."""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable, Mapping
from datetime import datetime
from decimal import Decimal

from app.models import Level, LevelKind

# Level colours on the client (architecture §5.5), RGB.
KIND_RGB: dict[LevelKind, str] = {
    LevelKind.support: "#2E7D32",
    LevelKind.resistance: "#C62828",
    LevelKind.zone: "#1565C0",
}

PINE_CODES: dict[LevelKind, str] = {
    LevelKind.support: "s",
    LevelKind.resistance: "r",
    LevelKind.zone: "z",
}

CSV_HEADER = ["id", "symbol", "kind", "price", "price_to", "color", "deleted", "updated_at"]


def rgb_to_bgr(rgb: str) -> str:
    """'#RRGGBB' -> '0xBBGGRR' (MQL5 `color` layout, ADR A7)."""
    value = rgb.lstrip("#")
    if len(value) != 6:
        raise ValueError(f"expected #RRGGBB, got {rgb!r}")
    r, g, b = value[0:2], value[2:4], value[4:6]
    return "0x" + (b + g + r).upper()


def kind_bgr(kind: LevelKind) -> str:
    return rgb_to_bgr(KIND_RGB[kind])


def level_bgr(level: Level) -> str:
    """Per-level colour (levels.color, '#RRGGBB') or the default of its kind, as BGR (ADR A7)."""
    return rgb_to_bgr(level.color or KIND_RGB[level.kind])


def format_number(value: Decimal | int | float | None) -> str:
    """Plain decimal without exponent or trailing zeros: 64200.000 -> '64200', 0.50 -> '0.5'."""
    if value is None:
        return ""
    d = value if isinstance(value, Decimal) else Decimal(str(value))
    text = format(d.normalize(), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def unix_seconds(ts: datetime) -> int:
    return int(ts.timestamp())


def render_sync_csv(
    levels: Iterable[Level],
    cursor: int,
    mt5_symbols: Mapping[str, str],
) -> str:
    buf = io.StringIO()
    buf.write(f"#cursor,{cursor}\n")
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(CSV_HEADER)
    for lv in levels:
        writer.writerow(
            [
                str(lv.id),
                mt5_symbols.get(lv.symbol, lv.symbol),
                lv.kind.value,
                format_number(lv.price),
                format_number(lv.price_to),
                level_bgr(lv),
                1 if lv.deleted_at is not None else 0,
                unix_seconds(lv.updated_at),
            ]
        )
    return buf.getvalue()


def render_pine(levels: Iterable[Level], tv_symbols: Mapping[str, str] | None = None) -> str:
    """'BTCUSDT:64200s,65800r,63000-63400z;ETHUSDT:3120s'. Deleted levels are skipped.

    Symbols keep the order of first appearance in `levels`; callers pass levels sorted
    by (symbol, created_at).
    """
    tv_symbols = tv_symbols or {}
    groups: dict[str, list[str]] = {}
    for lv in levels:
        if lv.deleted_at is not None:
            continue
        if lv.kind == LevelKind.zone and lv.price_to is not None:
            token = f"{format_number(lv.price)}-{format_number(lv.price_to)}"
        else:
            token = format_number(lv.price)
        symbol = tv_symbols.get(lv.symbol, lv.symbol)
        groups.setdefault(symbol, []).append(token + PINE_CODES[lv.kind])
    return ";".join(f"{sym}:{','.join(items)}" for sym, items in groups.items())
