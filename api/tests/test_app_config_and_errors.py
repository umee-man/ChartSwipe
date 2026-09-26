"""App factory checks, DB error -> HTTP mapping, per-level colour in the MT5 CSV."""

from __future__ import annotations

import asyncpg
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.repo import MemoryRepository
from conftest import make_settings


def test_postgres_without_jwt_config_fails_fast():
    settings = make_settings(
        repository="postgres", database_url="postgresql://u:p@localhost/db", supabase_jwt_secret=None
    )
    with pytest.raises(RuntimeError, match="SUPABASE_JWKS_URL"):
        create_app(settings=settings)


def test_postgres_with_jwks_only_is_accepted():
    settings = make_settings(
        repository="postgres",
        database_url="postgresql://u:p@localhost/db",
        supabase_jwt_secret=None,
        supabase_jwks_url="https://x.supabase.co/auth/v1/.well-known/jwks.json",
    )
    create_app(settings=settings)  # no startup: the pool is created lazily in lifespan


def test_sentry_init_only_with_dsn(monkeypatch):
    import sentry_sdk

    calls: list[dict] = []
    monkeypatch.setattr(sentry_sdk, "init", lambda **kw: calls.append(kw))
    create_app(settings=make_settings(), repo=MemoryRepository())
    assert calls == []
    create_app(settings=make_settings(sentry_dsn="https://public@o0.ingest.sentry.io/0"), repo=MemoryRepository())
    assert len(calls) == 1 and calls[0]["send_default_pii"] is False


def _exc(cls: type[asyncpg.PostgresError], constraint: str | None = None, message: str = "db") -> Exception:
    exc = cls(message)
    exc.constraint_name = constraint
    exc.message = message
    return exc


@pytest.mark.parametrize(
    ("exc", "status", "detail"),
    [
        (_exc(asyncpg.CheckViolationError, "levels_zone_nonempty"), 422, "Верхняя граница зоны должна быть больше нижней"),
        (_exc(asyncpg.CheckViolationError, None, "API-ключ уже отозван"), 422, "API-ключ уже отозван"),
        (_exc(asyncpg.CheckViolationError, "unknown_check"), 422, "Данные не прошли проверку базы данных"),
        (_exc(asyncpg.NotNullViolationError), 422, "Данные не прошли проверку базы данных"),
        (
            _exc(asyncpg.UniqueViolationError, "watchlists_user_name_key"),
            409,
            "Названия вотчлистов должны быть уникальными",
        ),
        (_exc(asyncpg.ForeignKeyViolationError, "levels_user_id_fkey"), 409, "Конфликт с существующими данными"),
    ],
)
def test_db_errors_are_mapped(exc, status, detail):
    app = create_app(settings=make_settings(), repo=MemoryRepository())

    async def boom() -> None:
        raise exc

    app.add_api_route("/boom", boom)
    with TestClient(app) as c:
        resp = c.get("/boom")
    assert resp.status_code == status
    assert resp.json() == {"detail": detail}


def test_csv_uses_level_color_as_bgr(client, auth_a, add_level, issue_key):
    key = issue_key(auth_a)["key"]
    custom = add_level(auth_a, color="#112233")
    default = add_level(auth_a, kind="resistance", price=65000)
    text = client.get("/v1/sync/mt5", params={"since": 0}, headers={"X-API-Key": key}).text
    colors = {line.split(",")[0]: line.split(",")[5] for line in text.splitlines()[2:]}
    assert colors[custom["id"]] == "0x332211"
    assert colors[default["id"]] == "0x2828C6"
