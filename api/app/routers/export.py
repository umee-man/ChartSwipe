"""/v1/export/pine — compact level string for the TradingView indicator (architecture §9)."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from app.auth import AnyUserDep, RepoDep
from app.formatting import render_pine

router = APIRouter(prefix="/export", tags=["export"])


@router.get("/pine", response_class=PlainTextResponse)
async def export_pine(user_id: AnyUserDep, repo: RepoDep) -> PlainTextResponse:
    levels = await repo.list_levels(user_id)  # live levels, ordered by (symbol, created_at)
    # User context (RLS) even for the API-key principal: service context is reserved for /sync (§6).
    tv_symbols = await repo.symbol_map(user_id, "tv", scoped=True)
    return PlainTextResponse(render_pine(levels, tv_symbols), headers={"Cache-Control": "no-store"})
