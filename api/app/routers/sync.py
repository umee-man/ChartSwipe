"""/v1/sync/mt5 — CSV feed for the MT5 EA with a server-side cursor (ADR A6, A7)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Request, Response

from app.auth import RepoDep, SyncKeyDep
from app.formatting import render_sync_csv, unix_seconds

router = APIRouter(prefix="/sync", tags=["sync"])


@router.get("/mt5", response_class=Response)
async def sync_mt5(
    request: Request,
    key: SyncKeyDep,
    repo: RepoDep,
    since: Annotated[int, Query(ge=0)] = 0,
) -> Response:
    user_id = key.user_id
    rows = await repo.levels_changed_since(user_id, since)
    max_updated = await repo.max_level_updated_at(user_id)
    lag = request.app.state.settings.sync_cursor_lag_seconds

    # Cursor = max(updated_at) in unix seconds, clamped to now - lag: a row written later in
    # the same (or a just-committing) second would otherwise be skipped by `> since`.
    # Rows inside the lag window are re-sent once; the EA handles them idempotently.
    cursor = since
    if max_updated is not None:
        safe_now = unix_seconds(await repo.now()) - lag
        cursor = max(since, min(unix_seconds(max_updated), safe_now))

    mt5_symbols = await repo.symbol_map(user_id, "mt5")
    body = render_sync_csv(rows, cursor, mt5_symbols)
    return Response(content=body, media_type="text/csv; charset=utf-8", headers={"Cache-Control": "no-store"})
