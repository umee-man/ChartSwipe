"""Cross-stream contract checks: api/ output vs the consumers in supabase/, mt5/, pine/, web/lib/detector/.

These read sibling directories of the monorepo; a test is skipped if its counterpart is absent
(e.g. when api/ is built alone inside Docker).
"""

from __future__ import annotations

import importlib.util
import re
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import pytest

from app.formatting import CSV_HEADER, PINE_CODES, render_pine, render_sync_csv
from app.models import Level, LevelKind, Timeframe

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "supabase" / "migrations"
MT5_CSV = ROOT / "mt5" / "ChartSwipeCsv.mqh"
PINE_SIM = ROOT / "pine" / "tests" / "pine_sim.py"
DETECTOR_TYPES = ROOT / "web" / "lib" / "detector" / "types.ts"

USER = uuid4()
TS = datetime(2026, 9, 26, 12, 0, 0, tzinfo=UTC)


def _need(path: Path) -> Path:
    if not path.exists():
        pytest.skip(f"{path.relative_to(ROOT)} not present")
    return path


def _level(symbol: str, kind: LevelKind, price: str, price_to: str | None = None, **kw) -> Level:
    return Level(
        id=uuid4(),
        user_id=USER,
        symbol=symbol,
        kind=kind,
        price=Decimal(price),
        price_to=Decimal(price_to) if price_to else None,
        tf=Timeframe.d1,
        created_at=TS,
        updated_at=TS,
        **kw,
    )


def _migration_sql() -> str:
    files = sorted(_need(MIGRATIONS).glob("*.sql"))
    if not files:
        pytest.skip("no migrations")
    return "\n".join(f.read_text(encoding="utf-8") for f in files)


def _last_in_list(sql: str, column: str) -> set[str] | None:
    found = re.findall(rf"check \({column} in \(([^)]*)\)\)", sql)
    return set(re.findall(r"'([^']+)'", found[-1])) if found else None


def _in_list(sql: str, column: str) -> set[str]:
    """Allowed values of the LAST `check (<column> in (...))` across migrations (sorted by name).

    Later migrations replace a check (e.g. 20260927000000_levels_tf_1w re-creates levels_tf_check),
    so the effective list is the most recent one, not the one in the init migration.
    """
    values = _last_in_list(sql, column)
    assert values is not None, f"no `check ({column} in (...))` in migrations"
    return values


# ---- enums: DB <-> API <-> detector


def test_enums_match_migration():
    sql = _migration_sql()
    assert _in_list(sql, "tf") == {t.value for t in Timeframe} == {"5m", "1h", "1d", "1w"}
    assert _in_list(sql, "kind") == {k.value for k in LevelKind}
    assert _in_list(sql, "target") == {"mt5", "tv"}


def test_tf_migration_extends_init_list():
    # Each later tf check must keep every earlier value (no existing row may start violating it).
    files = sorted(_need(MIGRATIONS).glob("*.sql"))
    lists = [v for f in files if (v := _last_in_list(f.read_text(encoding="utf-8"), "tf")) is not None]
    assert len(lists) >= 2, "expected the init tf check and the 1w migration"
    for earlier, later in zip(lists, lists[1:]):
        assert earlier <= later
    assert lists[-1] - lists[0] == {"1w"}


def test_detector_timeframes_match_api():
    text = _need(DETECTOR_TYPES).read_text(encoding="utf-8")
    m = re.search(r"export type DetectorTf\s*=\s*([^\n]+)", text)
    assert m
    assert set(re.findall(r"'([^']+)'", m.group(1))) == {t.value for t in Timeframe}


# ---- /v1/sync/mt5 CSV <-> mt5/ChartSwipeCsv.mqh


def test_mt5_parser_columns_are_emitted_by_api():
    text = _need(MT5_CSV).read_text(encoding="utf-8-sig")
    wanted = set(re.findall(r'CsColumnIndex\(header,\s*"([a-z_]+)"\)', text))
    assert {"id", "symbol", "kind", "price", "price_to", "color", "deleted"} <= wanted
    assert wanted <= set(CSV_HEADER)
    # The EA compares kinds against these literals.
    for kind in LevelKind:
        assert f'"{kind.value}"' in text


def test_sync_csv_shape_matches_ea_expectations():
    lv_s = _level("BTCUSDT", LevelKind.support, "64200")
    lv_z = _level("BTCUSDT", LevelKind.zone, "0.00000123", "0.0000015", color="#AbCdEf")
    lv_d = _level("ETHUSDT", LevelKind.resistance, "3120.50", deleted_at=TS)
    body = render_sync_csv([lv_s, lv_z, lv_d], 1790380740, {"BTCUSDT": "BTCUSD"})
    lines = body.split("\n")
    assert lines[0] == "#cursor,1790380740"
    assert lines[1].split(",") == CSV_HEADER
    rows = [dict(zip(CSV_HEADER, ln.split(","), strict=True)) for ln in lines[2:] if ln]
    assert [r["deleted"] for r in rows] == ["0", "0", "1"]
    assert rows[0]["symbol"] == "BTCUSD" and rows[0]["price_to"] == ""
    assert rows[0]["color"] == "0x327D2E"  # #2E7D32 as BGR (A7)
    assert rows[1]["price"] == "0.00000123" and rows[1]["price_to"] == "0.0000015"
    assert rows[1]["color"] == "0xEFCDAB"
    for r in rows:
        # EA: CsParseHex accepts at most 6 hex digits after 0x; plain decimal prices only.
        assert re.fullmatch(r"0x[0-9A-F]{6}", r["color"])
        assert "e" not in r["price"].lower() and '"' not in ",".join(r.values())
        assert r["updated_at"].isdigit()


# ---- /v1/export/pine <-> pine/chartswipe.pine (via pine/tests/pine_sim.py mirror)


def _pine_sim():
    spec = importlib.util.spec_from_file_location("pine_sim", _need(PINE_SIM))
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_pine_export_round_trips_through_indicator_parser():
    sim = _pine_sim()
    levels = [
        _level("BTCUSDT", LevelKind.support, "64200"),
        _level("BTCUSDT", LevelKind.resistance, "65800.5"),
        _level("BTCUSDT", LevelKind.zone, "63000", "63400"),
        _level("PEPEUSDT", LevelKind.zone, "0.0000003", "0.00000045"),  # would be 3e-07 via str()
        _level("PEPEUSDT", LevelKind.support, "0.00000012"),
        _level("ETHUSDT", LevelKind.support, "3120", deleted_at=TS),  # deleted -> not exported
    ]
    text = render_pine(levels)
    assert "e-" not in text

    got, bad = sim.run(text, "BINANCE:BTCUSDT.P")
    assert bad == 0
    assert got == [["s", 64200.0, None], ["r", 65800.5, None], ["z", 63000.0, 63400.0]]

    got, bad = sim.run(text, "PEPEUSDT.P")
    assert bad == 0
    assert got == [["z", 3e-07, 4.5e-07], ["s", 1.2e-07, None]]

    assert sim.run(text, "ETHUSDT.P") == ([], 0)
    assert set(PINE_CODES.values()) == {"s", "r", "z"}


def test_pine_vectors_file_still_passes():
    sim = _pine_sim()
    assert sim.main() == 0
