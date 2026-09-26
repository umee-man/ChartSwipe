from __future__ import annotations

import json
import time
from uuid import uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi.testclient import TestClient

from app.auth import JwksCache, JwtVerifier
from app.main import create_app
from app.repo import MemoryRepository
from conftest import JWT_SECRET, make_settings, make_token

JWKS_URL = "https://project.supabase.co/auth/v1/.well-known/jwks.json"


# ---------------------------------------------------------------- HS256 path


@pytest.mark.parametrize(
    "header",
    [
        "Bearer",
        "Bearer ",
        "Basic dXNlcjpwYXNz",
        "Bearer not.a.jwt",
        "Token abc",
    ],
)
def test_malformed_authorization(client, header):
    resp = client.get("/v1/levels", headers={"Authorization": header})
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"] == "Bearer"


def test_missing_authorization_message(client):
    resp = client.get("/v1/levels")
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Требуется авторизация"


def test_expired_token(client, user_a):
    token = make_token(user_a, exp=int(time.time()) - 3600)
    resp = client.get("/v1/levels", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Недействительный или просроченный токен"


def test_wrong_secret(client, user_a):
    token = make_token(user_a, secret="another-secret-another-secret-32")
    assert client.get("/v1/levels", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_wrong_audience(client, user_a):
    token = make_token(user_a, aud="anon")
    assert client.get("/v1/levels", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_sub_not_uuid(client):
    token = make_token("not-a-uuid")
    assert client.get("/v1/levels", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_missing_exp(client, user_a):
    token = jwt.encode({"sub": str(user_a), "aud": "authenticated"}, JWT_SECRET, algorithm="HS256")
    assert client.get("/v1/levels", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_alg_none_rejected(client, user_a):
    token = jwt.encode(
        {"sub": str(user_a), "aud": "authenticated", "exp": int(time.time()) + 60}, None, algorithm="none"
    )
    assert client.get("/v1/levels", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_hs256_disabled_without_secret(user_a):
    settings = make_settings(supabase_jwt_secret=None)
    app = create_app(settings=settings, repo=MemoryRepository())
    with TestClient(app) as c:
        token = make_token(user_a)
        assert c.get("/v1/levels", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_valid_hs256(client, auth_a):
    assert client.get("/v1/levels", headers=auth_a).status_code == 200


# ---------------------------------------------------------------- JWKS path


def _jwks_client_factory(jwks: dict, calls: list[int]):
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == JWKS_URL
        calls.append(1)
        return httpx.Response(200, json=jwks)

    return lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _jwk(public_key, kid: str, alg: str) -> dict:
    algo = jwt.algorithms.RSAAlgorithm if alg == "RS256" else jwt.algorithms.ECAlgorithm
    data = json.loads(algo.to_jwk(public_key))
    data.update({"kid": kid, "alg": alg, "use": "sig"})
    return data


@pytest.fixture
def rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def ec_key():
    return ec.generate_private_key(ec.SECP256R1())


def _jwks_app(jwks: dict, calls: list[int], clock=time.monotonic, **overrides):
    settings = make_settings(supabase_jwks_url=JWKS_URL, supabase_jwt_secret=None, **overrides)
    cache = JwksCache(JWKS_URL, ttl=600, client_factory=_jwks_client_factory(jwks, calls), clock=clock)
    return create_app(settings=settings, repo=MemoryRepository(), jwt_verifier=JwtVerifier(settings, jwks=cache))


def _signed(private_key, kid: str, alg: str, **claims) -> str:
    payload = {"sub": str(uuid4()), "aud": "authenticated", "exp": int(time.time()) + 600} | claims
    return jwt.encode(payload, private_key, algorithm=alg, headers={"kid": kid})


def test_jwks_rs256_and_es256(rsa_key, ec_key):
    calls: list[int] = []
    jwks = {"keys": [_jwk(rsa_key.public_key(), "rsa1", "RS256"), _jwk(ec_key.public_key(), "ec1", "ES256")]}
    with TestClient(_jwks_app(jwks, calls)) as c:
        for token in (_signed(rsa_key, "rsa1", "RS256"), _signed(ec_key, "ec1", "ES256")):
            assert c.get("/v1/levels", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert len(calls) == 1  # cached


def test_jwks_rejects_unknown_kid_and_wrong_key(rsa_key):
    calls: list[int] = []
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwks = {"keys": [_jwk(rsa_key.public_key(), "rsa1", "RS256")]}
    with TestClient(_jwks_app(jwks, calls)) as c:
        unknown = _signed(rsa_key, "nope", "RS256")
        forged = _signed(other, "rsa1", "RS256")
        for token in (unknown, forged):
            assert c.get("/v1/levels", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_jwks_hs256_token_rejected_when_only_jwks(rsa_key, user_a):
    calls: list[int] = []
    jwks = {"keys": [_jwk(rsa_key.public_key(), "rsa1", "RS256")]}
    with TestClient(_jwks_app(jwks, calls)) as c:
        token = make_token(user_a)
        assert c.get("/v1/levels", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_jwks_issuer_enforced(rsa_key):
    calls: list[int] = []
    jwks = {"keys": [_jwk(rsa_key.public_key(), "rsa1", "RS256")]}
    iss = "https://project.supabase.co/auth/v1"
    with TestClient(_jwks_app(jwks, calls, supabase_jwt_issuer=iss)) as c:
        good = _signed(rsa_key, "rsa1", "RS256", iss=iss)
        bad = _signed(rsa_key, "rsa1", "RS256", iss="https://evil.example/auth/v1")
        assert c.get("/v1/levels", headers={"Authorization": f"Bearer {good}"}).status_code == 200
        assert c.get("/v1/levels", headers={"Authorization": f"Bearer {bad}"}).status_code == 401


async def test_jwks_refetch_on_rotation_is_throttled(rsa_key):
    t = [0.0]
    calls: list[int] = []
    new_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwks = {"keys": [_jwk(rsa_key.public_key(), "k1", "RS256")]}
    cache = JwksCache(JWKS_URL, ttl=600, client_factory=_jwks_client_factory(jwks, calls), clock=lambda: t[0])
    await cache.get("k1")
    assert len(calls) == 1
    jwks["keys"].append(_jwk(new_key.public_key(), "k2", "RS256"))  # key rotation upstream
    with pytest.raises(Exception):
        await cache.get("k2")  # within 30 s: no refetch storm
    assert len(calls) == 1
    t[0] += 31
    assert (await cache.get("k2")) is not None
    assert len(calls) == 2


async def test_jwks_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    cache = JwksCache(JWKS_URL, ttl=600, client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    from app.auth import AuthError

    with pytest.raises(AuthError):
        await cache.get("k1")


def test_empty_env_values_mean_unset():
    s = make_settings(supabase_jwt_issuer="", supabase_jwt_secret="  ", supabase_jwks_url="")
    assert s.supabase_jwt_issuer is None and s.supabase_jwt_secret is None and s.supabase_jwks_url is None
