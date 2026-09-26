"""/v1/keys — issue (plaintext shown once, sha256 stored) and revoke API keys."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, Response, status

from app.auth import RepoDep, UserDep, generate_api_key, hash_api_key
from app.models import KEY_PREFIX_LEN, ApiKeyCreate, ApiKeyCreated

router = APIRouter(prefix="/keys", tags=["keys"])


@router.post("", response_model=ApiKeyCreated, status_code=status.HTTP_201_CREATED)
async def create_key(user_id: UserDep, repo: RepoDep, body: ApiKeyCreate | None = None) -> ApiKeyCreated:
    body = body or ApiKeyCreate()
    plaintext = generate_api_key()
    key = await repo.create_api_key(user_id, body.name, hash_api_key(plaintext), plaintext[:KEY_PREFIX_LEN])
    return ApiKeyCreated(
        id=key.id, name=key.name, key=plaintext, key_prefix=key.key_prefix, created_at=key.created_at
    )


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_key(key_id: UUID, user_id: UserDep, repo: RepoDep) -> Response:
    if not await repo.revoke_api_key(user_id, key_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ключ не найден")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
