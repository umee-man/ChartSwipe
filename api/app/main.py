"""FastAPI application factory. Run: uvicorn app.main:create_app --factory"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg
from fastapi import APIRouter, FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.auth import JwtVerifier
from app.config import Settings, get_settings
from app.ratelimit import TokenBucketLimiter
from app.repo import Repository, build_repository
from app.routers import export, keys, levels, sync, watchlists

log = logging.getLogger("chartswipe.api")

# Russian details for DB constraints the API can hit (supabase/migrations/*_init.sql).
_CONSTRAINT_DETAILS: dict[str, str] = {
    "watchlists_user_name_key": "Названия вотчлистов должны быть уникальными",
    "watchlists_symbols_max": "Слишком много тикеров в вотчлисте",
    "levels_zone_nonempty": "Верхняя граница зоны должна быть больше нижней",
    "levels_price_to_iff_zone": "price_to допустим только для зоны и обязателен для неё",
    "levels_price_positive": "Цена должна быть больше нуля",
    "levels_price_to_positive": "Цена должна быть больше нуля",
    "levels_pkey": "Уровень с таким id уже существует",
}
_DEFAULT_422 = "Данные не прошли проверку базы данных"
_DEFAULT_409 = "Конфликт с существующими данными"


def _db_detail(exc: asyncpg.PostgresError, default: str) -> str:
    name = getattr(exc, "constraint_name", None)
    if name in _CONSTRAINT_DETAILS:
        return _CONSTRAINT_DETAILS[name]
    if name is None and getattr(exc, "sqlstate", None) == "23514":
        # RAISE ... USING errcode = 'check_violation' from our own triggers (e.g. api_keys_guard):
        # the message is authored in Russian in the migration.
        return str(getattr(exc, "message", "") or default)
    return default


def _install_db_error_handlers(app: FastAPI) -> None:
    """Integrity / check errors from Postgres become 409/422 with a Russian detail instead of 500."""

    async def unprocessable(request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, asyncpg.PostgresError)
        log.warning("db constraint rejected %s %s: %s", request.method, request.url.path, exc.__class__.__name__)
        return JSONResponse({"detail": _db_detail(exc, _DEFAULT_422)}, status.HTTP_422_UNPROCESSABLE_CONTENT)

    async def conflict(request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, asyncpg.PostgresError)
        log.warning("db conflict %s %s: %s", request.method, request.url.path, exc.__class__.__name__)
        return JSONResponse({"detail": _db_detail(exc, _DEFAULT_409)}, status.HTTP_409_CONFLICT)

    for exc_type in (asyncpg.CheckViolationError, asyncpg.NotNullViolationError):
        app.add_exception_handler(exc_type, unprocessable)
    for exc_type in (asyncpg.UniqueViolationError, asyncpg.ForeignKeyViolationError):
        app.add_exception_handler(exc_type, conflict)


def _init_sentry(settings: Settings) -> None:
    if not settings.sentry_dsn:
        return
    import sentry_sdk  # FastAPI/Starlette integrations are enabled automatically

    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.sentry_environment,
        traces_sample_rate=settings.sentry_traces_sample_rate,
        send_default_pii=False,  # no tokens / API keys / IPs in events
    )


def create_app(
    settings: Settings | None = None,
    repo: Repository | None = None,
    jwt_verifier: JwtVerifier | None = None,
    sync_limiter: TokenBucketLimiter | None = None,
    sync_ip_limiter: TokenBucketLimiter | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    if (
        jwt_verifier is None
        and settings.repository == "postgres"
        and not (settings.supabase_jwks_url or settings.supabase_jwt_secret)
    ):
        # Otherwise every JWT request would silently get 401.
        raise RuntimeError("Set SUPABASE_JWKS_URL (or SUPABASE_JWT_SECRET) when REPOSITORY=postgres")
    _init_sentry(settings)
    repo = repo or build_repository(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await repo.startup()
        try:
            yield
        finally:
            await repo.shutdown()

    app = FastAPI(title="ChartSwipe API", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.repo = repo
    app.state.jwt_verifier = jwt_verifier or JwtVerifier(settings)
    app.state.sync_limiter = sync_limiter or TokenBucketLimiter(settings.sync_rate_limit_per_minute, 60.0)
    app.state.sync_ip_limiter = sync_ip_limiter or TokenBucketLimiter(settings.sync_ip_rate_limit_per_minute, 60.0)
    _install_db_error_handlers(app)

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "X-API-Key"],
        )

    v1 = APIRouter(prefix="/v1")
    for module in (levels, watchlists, keys, sync, export):
        v1.include_router(module.router)
    app.include_router(v1)

    @app.get("/health", include_in_schema=False)
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
