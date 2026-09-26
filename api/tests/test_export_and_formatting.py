from __future__ import annotations

from decimal import Decimal

import pytest

from app.formatting import KIND_RGB, format_number, kind_bgr, rgb_to_bgr
from app.models import LevelKind


@pytest.mark.parametrize(
    ("rgb", "bgr"),
    [("#2E7D32", "0x327D2E"), ("#C62828", "0x2828C6"), ("#1565C0", "0xC06515"), ("#aabbcc", "0xCCBBAA")],
)
def test_rgb_to_bgr(rgb, bgr):
    assert rgb_to_bgr(rgb) == bgr


def test_kind_colors_match_client_palette():
    assert KIND_RGB[LevelKind.support] == "#2E7D32"
    assert kind_bgr(LevelKind.support) == "0x327D2E"
    assert kind_bgr(LevelKind.resistance) == "0x2828C6"
    assert kind_bgr(LevelKind.zone) == "0xC06515"


def test_rgb_to_bgr_rejects_garbage():
    with pytest.raises(ValueError):
        rgb_to_bgr("#123")


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (Decimal("64200"), "64200"),
        (Decimal("64200.000"), "64200"),
        (Decimal("6.42E+4"), "64200"),
        (Decimal("0.50"), "0.5"),
        (Decimal("0.00001234"), "0.00001234"),
        (Decimal("1E-8"), "0.00000001"),
        (Decimal("3120.10"), "3120.1"),
        (Decimal("0"), "0"),
        (64200.0, "64200"),
        (None, ""),
    ],
)
def test_format_number(value, text):
    assert format_number(value) == text


def test_pine_export_format(client, auth_a, add_level, clock):
    add_level(auth_a, symbol="BTCUSDT", price="64200.00")
    clock.advance(1)
    add_level(auth_a, symbol="ETHUSDT", price=3120)
    clock.advance(1)
    add_level(auth_a, symbol="BTCUSDT", kind="resistance", price=65800)
    clock.advance(1)
    add_level(auth_a, symbol="BTCUSDT", kind="zone", price="63000.0", price_to=63400)
    clock.advance(1)
    gone = add_level(auth_a, symbol="BTCUSDT", price=1)
    client.delete(f"/v1/levels/{gone['id']}", headers=auth_a)

    resp = client.get("/v1/export/pine", headers=auth_a)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    assert resp.text == "BTCUSDT:64200s,65800r,63000-63400z;ETHUSDT:3120s"


def test_pine_small_prices(client, auth_a, add_level):
    add_level(auth_a, symbol="1000PEPEUSDT", kind="zone", price="0.012340", price_to="0.0125")
    assert client.get("/v1/export/pine", headers=auth_a).text == "1000PEPEUSDT:0.01234-0.0125z"


def test_pine_empty(client, auth_a):
    resp = client.get("/v1/export/pine", headers=auth_a)
    assert resp.status_code == 200 and resp.text == ""


def test_pine_accepts_api_key_and_isolates_users(client, auth_a, auth_b, add_level, issue_key):
    add_level(auth_a, symbol="BTCUSDT")
    add_level(auth_b, symbol="ETHUSDT", price=3120)
    key_a = issue_key(auth_a)["key"]
    assert client.get("/v1/export/pine", headers={"X-API-Key": key_a}).text == "BTCUSDT:64200s"
    assert client.get("/v1/export/pine", headers=auth_b).text == "ETHUSDT:3120s"


def test_pine_tv_symbol_map(client, auth_a, user_a, add_level, repo):
    add_level(auth_a, symbol="BTCUSDT")
    repo.symbol_maps[(user_a, "tv")] = {"BTCUSDT": "BTCUSDT"}
    repo.symbol_maps[(user_a, "mt5")] = {"BTCUSDT": "BTCUSD"}
    assert client.get("/v1/export/pine", headers=auth_a).text == "BTCUSDT:64200s"


def test_pine_auth_failures(client):
    assert client.get("/v1/export/pine").status_code == 401
    assert client.get("/v1/export/pine", headers={"X-API-Key": "cs_nope"}).status_code == 401
    assert client.get("/v1/export/pine", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_stored_prices_with_many_decimals_do_not_break_reads():
    from datetime import UTC, datetime
    from uuid import uuid4

    from app.formatting import render_pine
    from app.models import Level

    now = datetime.now(UTC)
    lv = Level(
        id=uuid4(), user_id=uuid4(), symbol="SHIBUSDT", kind="support",
        price=Decimal("0.000012345678901234"), tf="1h", created_at=now, updated_at=now,
    )
    assert render_pine([lv]) == "SHIBUSDT:0.000012345678901234s"
