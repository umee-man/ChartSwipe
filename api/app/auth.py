"""Authentication: Supabase JWT (JWKS, optional HS256 fallback) and X-API-Key (architecture §7)."""

from __future__ import annotations

import asyncio
import hashlib
import secrets
import time
from typing import Annotated, Any
from uuid import UUID

import httpx
import jwt
from fastapi import Depends, Header, HTTPException, Request, status

from app.config import Settings
from app.models import ApiKey
from app.repo import Repository

API_KEY_PREFIX = "cs_"
# Minimum interval between JWKS refetches triggered by an unknown `kid`.
JWKS_MISS_REFETCH_SECONDS = 30.0


class AuthError(Exception):
    pass


def hash_api_key(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def generate_api_key() -> str:
    return API_KEY_PREFIX + secrets.token_urlsafe(32)


class JwksCache:
    """Caches the project's JWKS; refetches on TTL expiry or (throttled) unknown kid."""

    def __init__(self, url: str, ttl: float, client_factory: Any = None, clock: Any = time.monotonic) -> None:
        self.url = url
        self.ttl = ttl
        self.clock = clock
        self._client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=5.0))
        self._keys: dict[str, jwt.PyJWK] = {}
        self._fetched_at: float | None = None
        self._lock = asyncio.Lock()

    async def _fetch(self) -> None:
        async with self._client_factory() as client:
            resp = await client.get(self.url)
            resp.raise_for_status()
            data = resp.json()
        keys: dict[str, jwt.PyJWK] = {}
        for jwk in data.get("keys", []):
            try:
                key = jwt.PyJWK.from_dict(jwk)
            except jwt.PyJWTError:
                continue  # skip unsupported key types instead of failing the whole set
            keys[jwk.get("kid", "")] = key
        self._keys = keys
        self._fetched_at = self.clock()

    async def get(self, kid: str) -> jwt.PyJWK:
        async with self._lock:
            now = self.clock()
            expired = self._fetched_at is None or now - self._fetched_at > self.ttl
            miss_refetch = (
                kid not in self._keys
                and self._fetched_at is not None
                and now - self._fetched_at > JWKS_MISS_REFETCH_SECONDS
            )
            if expired or miss_refetch:
                try:
                    await self._fetch()
                except (httpx.HTTPError, ValueError) as exc:
                    if not self._keys:
                        raise AuthError("JWKS unavailable") from exc
            key = self._keys.get(kid)
            if key is None:
                raise AuthError("unknown signing key")
            return key


class JwtVerifier:
    def __init__(self, settings: Settings, jwks: JwksCache | None = None) -> None:
        self.settings = settings
        self.jwks = jwks
        if self.jwks is None and settings.supabase_jwks_url:
            self.jwks = JwksCache(settings.supabase_jwks_url, settings.jwks_cache_ttl_seconds)

    async def verify(self, token: str) -> UUID:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise AuthError("malformed token") from exc
        alg = header.get("alg")
        if alg == "HS256":
            if not self.settings.supabase_jwt_secret:
                raise AuthError("HS256 not enabled")
            key: Any = self.settings.supabase_jwt_secret
        elif alg in self.settings.jwt_algorithms:
            if self.jwks is None:
                raise AuthError("JWKS not configured")
            key = (await self.jwks.get(header.get("kid", ""))).key
        else:
            raise AuthError("unsupported algorithm")

        options = {"require": ["exp", "sub"], "verify_aud": self.settings.supabase_jwt_audience is not None}
        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=[alg],
                audience=self.settings.supabase_jwt_audience,
                issuer=self.settings.supabase_jwt_issuer,
                options=options,
                leeway=10,
            )
        except jwt.PyJWTError as exc:
            raise AuthError(str(exc)) from exc
        try:
            return UUID(str(claims["sub"]))
        except ValueError as exc:
            raise AuthError("sub is not a uuid") from exc


# ---------------------------------------------------------------- FastAPI dependencies


def get_repo(request: Request) -> Repository:
    return request.app.state.repo


RepoDep = Annotated[Repository, Depends(get_repo)]

_UNAUTHORIZED = "Требуется авторизация"


def _bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


async def _user_from_jwt(request: Request, authorization: str | None) -> UUID:
    token = _bearer(authorization)
    if token is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED, headers={"WWW-Authenticate": "Bearer"})
    verifier: JwtVerifier = request.app.state.jwt_verifier
    try:
        return await verifier.verify(token)
    except AuthError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Недействительный или просроченный токен",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


async def _api_key(repo: Repository, x_api_key: str | None) -> ApiKey:
    if not x_api_key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Нужен заголовок X-API-Key")
    key = await repo.find_active_api_key(hash_api_key(x_api_key.strip()))
    if key is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный или отозванный API-ключ")
    return key


async def current_user(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> UUID:
    """JWT-only principal (app endpoints)."""
    return await _user_from_jwt(request, authorization)


async def current_user_jwt_or_key(
    request: Request,
    repo: RepoDep,
    authorization: Annotated[str | None, Header()] = None,
    x_api_key: Annotated[str | None, Header()] = None,
) -> UUID:
    """Either principal; JWT wins when both are present (used by /export/pine)."""
    if authorization:
        return await _user_from_jwt(request, authorization)
    if x_api_key:
        return (await _api_key(repo, x_api_key)).user_id
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, _UNAUTHORIZED, headers={"WWW-Authenticate": "Bearer"})


def _take_token(limiter: Any, bucket: Any) -> None:
    allowed, retry_after = limiter.acquire(bucket)
    if not allowed:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Слишком много запросов, попробуйте позже",
            headers={"Retry-After": str(retry_after)},
        )


async def sync_rate_limit(
    request: Request,
    repo: RepoDep,
    x_api_key: Annotated[str | None, Header()] = None,
) -> ApiKey:
    """Rate limit /sync/* (architecture §7) BEFORE the DB key lookup.

    1. Coarse per-client-IP bucket: caps DB round-trips from one host even with random keys.
    2. Per-key bucket keyed by sha256 of the presented key. The hash is unique per stored key
       (api_keys_key_hash_idx), so for a valid key this is exactly the 30/min per-key limit;
       it also throttles an EA looping with a wrong or revoked key.
    """
    state = request.app.state
    _take_token(state.sync_ip_limiter, request.client.host if request.client else "unknown")
    if x_api_key and x_api_key.strip():
        _take_token(state.sync_limiter, hash_api_key(x_api_key.strip()))
    return await _api_key(repo, x_api_key)


UserDep = Annotated[UUID, Depends(current_user)]
SyncKeyDep = Annotated[ApiKey, Depends(sync_rate_limit)]
AnyUserDep = Annotated[UUID, Depends(current_user_jwt_or_key)]
