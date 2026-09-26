"""/v1/levels — CRUD with soft delete (architecture §6, §7)."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Response, status
from pydantic import ValidationError

from app.auth import RepoDep, UserDep
from app.models import SYMBOL_MAX_LEN, LevelCreate, LevelOut, LevelPatch, normalize_symbol
from app.repo import ConflictError

router = APIRouter(prefix="/levels", tags=["levels"])

_NOT_FOUND = "Уровень не найден"


@router.get("", response_model=list[LevelOut])
async def list_levels(
    user_id: UserDep,
    repo: RepoDep,
    symbol: Annotated[str | None, Query(max_length=SYMBOL_MAX_LEN + 8)] = None,  # slack for whitespace
) -> list[LevelOut]:
    if symbol is not None:
        try:
            symbol = normalize_symbol(symbol)
        except ValueError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    return [LevelOut.from_level(lv) for lv in await repo.list_levels(user_id, symbol)]


@router.post("", response_model=LevelOut, status_code=status.HTTP_201_CREATED)
async def create_level(body: LevelCreate, user_id: UserDep, repo: RepoDep) -> LevelOut:
    try:
        level = await repo.create_level(user_id, body)
    except ConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, "Уровень с таким id уже существует") from exc
    return LevelOut.from_level(level)


@router.patch("/{level_id}", response_model=LevelOut)
async def update_level(level_id: UUID, body: LevelPatch, user_id: UserDep, repo: RepoDep) -> LevelOut:
    # Read, merge, validate and write happen atomically inside the repository (row lock in Postgres).
    try:
        updated = await repo.patch_level(user_id, level_id, body)
    except (ValueError, ValidationError) as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    if updated is None:  # missing, foreign or deleted
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NOT_FOUND)
    return LevelOut.from_level(updated)


@router.delete("/{level_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_level(level_id: UUID, user_id: UserDep, repo: RepoDep) -> Response:
    if not await repo.soft_delete_level(user_id, level_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NOT_FOUND)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
