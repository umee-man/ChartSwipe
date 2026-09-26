"""/v1/watchlists — GET all, PUT replaces the whole ordered set."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Body, HTTPException, status

from app.auth import RepoDep, UserDep
from app.models import Watchlist, WatchlistIn, check_unique_watchlist_names

router = APIRouter(prefix="/watchlists", tags=["watchlists"])

MAX_WATCHLISTS = 50


@router.get("", response_model=list[Watchlist])
async def list_watchlists(user_id: UserDep, repo: RepoDep) -> list[Watchlist]:
    return await repo.list_watchlists(user_id)


@router.put("", response_model=list[Watchlist])
async def replace_watchlists(
    user_id: UserDep,
    repo: RepoDep,
    body: Annotated[list[WatchlistIn], Body(max_length=MAX_WATCHLISTS)],
) -> list[Watchlist]:
    # Names are unique per user (watchlists_user_name_key); reject duplicates before touching the DB.
    try:
        check_unique_watchlist_names(body)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    # List order becomes `position`; ids of omitted watchlists are deleted.
    return await repo.replace_watchlists(user_id, body)
