"""Application settings (pydantic-settings, read from environment / .env)."""

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Storage backend: "postgres" in production, "memory" for local hacking / tests.
    repository: Literal["postgres", "memory"] = "postgres"
    database_url: str | None = None
    db_pool_min: int = 1
    db_pool_max: int = 10
    # Run user-scoped queries as role `authenticated` with request.jwt.claims set,
    # so Supabase RLS applies on top of explicit user_id filters (architecture §6).
    db_enforce_rls: bool = True

    # Supabase JWT verification. JWKS is preferred; HS256 secret is an optional fallback
    # (legacy Supabase projects sign with a shared secret).
    supabase_jwks_url: str | None = None
    supabase_jwt_secret: str | None = None
    supabase_jwt_audience: str | None = "authenticated"
    supabase_jwt_issuer: str | None = None
    jwks_cache_ttl_seconds: int = 600
    jwt_algorithms: list[str] = Field(default_factory=lambda: ["RS256", "ES256", "EdDSA"])

    # /v1/sync/* rate limit per API key (in-memory token bucket, single replica in MVP).
    sync_rate_limit_per_minute: int = 30
    # Coarse per-client-IP cap on /v1/sync/*, applied before the API-key DB lookup (several EAs
    # on one VPS share an IP: 120/min covers ~10 terminals polling every 5 s).
    sync_ip_rate_limit_per_minute: int = 120
    # Cursor is clamped to now() - lag so rows committed within the same second are not lost.
    sync_cursor_lag_seconds: int = 2

    cors_origins: list[str] = Field(default_factory=list)

    # Sentry (architecture §11). Disabled when SENTRY_DSN is empty.
    sentry_dsn: str | None = None
    sentry_environment: str = "production"
    sentry_traces_sample_rate: float = 0.0

    @field_validator(
        "database_url", "supabase_jwks_url", "supabase_jwt_secret", "supabase_jwt_audience", "supabase_jwt_issuer",
        "sentry_dsn",
        mode="before",
    )
    @classmethod
    def _empty_to_none(cls, v: object) -> object:
        # `FOO=` in .env means "unset", not "match the empty string".
        return None if isinstance(v, str) and not v.strip() else v


@lru_cache
def get_settings() -> Settings:
    return Settings()
