# ChartSwipe API

FastAPI (Python 3.12) backend for ChartSwipe. The source of truth is `../architecture.md` §6–§7 (and ADR A6/A7).
This covers the MVP only: levels, watchlists, API keys, MT5 sync, Pine export. `feed`, `sync/tv` and `push` are v1.

## Endpoints (`/v1`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/levels?symbol=` | JWT | Live levels, ordered by `(symbol, created_at)` |
| POST | `/levels` | JWT | `201`. Optional client `id` (uuid) for optimistic UI, `409` if taken. Optional `color` `#RRGGBB` |
| PATCH | `/levels/{id}` | JWT | Partial: `kind, price, price_to, tf, note, color` (`color: null` = default of the kind). zone→support drops `price_to`. Read-merge-write is atomic (`select … for update`) |
| DELETE | `/levels/{id}` | JWT | Soft delete (`deleted_at = updated_at = now()`), `204` |
| GET | `/watchlists` | JWT | `[{id, name, symbols[], position, updated_at}]` |
| PUT | `/watchlists` | JWT | Replaces the whole ordered set: body `[{id?, name, symbols[]}]`; list index = `position`; names must be unique (`422`) |
| POST | `/keys` | JWT | `201 {id, name, key, key_prefix, created_at}` — plaintext `key` (`cs_…`) is shown **once**, only sha256 and the non-secret `key_prefix` (first 8 chars) are stored |
| DELETE | `/keys/{id}` | JWT | Revoke (`revoked_at = now()`), `204` |
| GET | `/sync/mt5?since=<unix>` | `X-API-Key` | `text/csv`, rate limited 30/min per key + 120/min per client IP, checked **before** the key lookup → `429` + `Retry-After` |
| GET | `/export/pine` | JWT or `X-API-Key` | `text/plain`, e.g. `BTCUSDT:64200s,65800r,63000-63400z;ETHUSDT:3120s` |

`GET /health` → `{"status":"ok"}`. Error `detail` strings are in Russian (user-facing).

### Validation
- `kind`: `support | resistance | zone`; `tf`: `5m | 1h | 1d` (the three MVP timeframes, F3 / §5.6 = `levels.tf` check).
- `price > 0`; zone requires `price_to > price`; non-zone must not have `price_to`.
- `note` ≤ 140 chars (trimmed, empty → null). `symbol`: trimmed + upper-cased, 1–32 chars, no whitespace, control
  chars, `,` `;` `:` or `"` (CSV / Pine separators). Non-ASCII tickers (Binance CJK perps) are allowed.
- `color` (optional): `#RRGGBB`; `null` → default colour of the kind (§5.5).
- Watchlist: name 1–64, unique within the PUT body after trimming, ≤ 500 symbols (upper-cased, de-duplicated),
  ≤ 50 watchlists.
- DB constraint / trigger errors never surface as `500`: check / not-null → `422`, unique / foreign key → `409`,
  with a Russian `detail` (handlers in `app/main.py`).

### MT5 CSV (`/sync/mt5`)
```
#cursor,1790380740
id,symbol,kind,price,price_to,color,deleted,updated_at
9f1c...,BTCUSD,support,64200,,0x327D2E,0,1790380712
```
- `since=0` (default): full snapshot of live levels (no deleted rows).
- `since>0`: every level with `floor(epoch(updated_at)) > since`, **including** deleted (`deleted=1`).
- `#cursor` = `max(updated_at)` over all of the user's levels (deleted included), in unix seconds, clamped to
  `now() - SYNC_CURSOR_LAG_SECONDS` (default 2) and never below `since`. The clamp prevents losing a row that
  commits in the same second as a poll; rows inside that window may be sent twice, which the EA handles
  idempotently (objects are keyed `CS_<id>`).
- `symbol`: `symbol_map(target='mt5')` if present, otherwise the source symbol (EA appends the broker suffix).
- `color`: BGR per ADR A7 of `levels.color` if set, otherwise the kind default — support `#2E7D32 → 0x327D2E`,
  resistance `#C62828 → 0x2828C6`, zone `#1565C0 → 0xC06515`.
- Numbers are plain decimals without trailing zeros (`64200`, `0.5`, `0.00001234`).

### Pine string (`/export/pine`)
Live levels only, grouped by symbol (alphabetical, then by creation time), codes `s`/`r`/`z`, zone as `low-high`.
`symbol_map(target='tv')` is applied when present.

## Auth
- **JWT (app):** `Authorization: Bearer <supabase access token>`. Verified against the project JWKS
  (`SUPABASE_JWKS_URL`, RS256/ES256/EdDSA, cached `JWKS_CACHE_TTL_SECONDS`, unknown `kid` triggers a refetch at most
  every 30 s). Optional HS256 fallback when `SUPABASE_JWT_SECRET` is set. `exp` and `sub` are required;
  `aud` (default `authenticated`) and optional `iss` are checked. `sub` → `user_id`.
- **API key (EA):** `X-API-Key` → sha256 → `api_keys` row with `revoked_at is null`; `last_used_at` is updated.

## Database contract
The schema itself is owned by `supabase/migrations`. The API assumes these columns
(`tests/test_postgres_repo.py` builds its database from `supabase/validate/stubs.sql` + `supabase/migrations/*.sql`):

| Table | Columns used |
|---|---|
| `levels` | `id uuid, user_id uuid, symbol text, kind text, price numeric, price_to numeric, tf text, note text, color text, created_at, updated_at, deleted_at` |
| `watchlists` | `id uuid, user_id uuid, name text, symbols text[], position int, updated_at` |
| `symbol_map` | `user_id uuid, symbol text, target text ('mt5'\|'tv'), target_symbol text` |
| `api_keys` | `id uuid, user_id uuid, name text, key_hash text, key_prefix text, created_at, last_used_at, revoked_at` |

`id` columns need `default gen_random_uuid()`; timestamps are `timestamptz` with `default now()`.

**RLS:** JWT-scoped queries run in a transaction with `set local role authenticated` and
`request.jwt.claims = {"sub": <user_id>, "role": "authenticated"}` (plus legacy `request.jwt.claim.sub`), so Supabase policies
`user_id = auth.uid()` apply on top of the explicit `user_id` filters. The `DATABASE_URL` role must be able to
`SET ROLE authenticated` (Supabase's `postgres` role can). Sync / API-key lookups run as the connection role
(service context, `/sync/*` only) and always filter by the key's `user_id`; `/export/pine` reads `symbol_map` in the user context. Disable with `DB_ENFORCE_RLS=false` if needed.
The pool uses `statement_cache_size=0`, so the Supabase transaction pooler also works.

## Layout
```
app/
  main.py          create_app() factory (uvicorn --factory)
  config.py        pydantic-settings
  models.py        Pydantic v2 models + validation
  auth.py          JWT (JWKS/HS256), X-API-Key, rate-limit dependency
  ratelimit.py     in-memory token bucket
  formatting.py    BGR colour, number formatting, CSV, Pine
  repo/            Repository ABC, MemoryRepository (tests), PostgresRepository (asyncpg)
  routers/         levels, watchlists, keys, sync, export
tests/             pytest suite (+ Postgres integration test)
```

## Develop
```bash
cd api
uv venv --python 3.12 .venv
uv pip install --python .venv/Scripts/python.exe -e ".[dev,pgtest]"   # Linux/macOS: .venv/bin/python
cp .env.example .env    # fill in
.venv/Scripts/python.exe -m uvicorn app.main:create_app --factory --reload --port 8000
```
Without uv: `python -m venv .venv && .venv/Scripts/pip install -e ".[dev,pgtest]"`.
For UI work without a database: `REPOSITORY=memory` (data is lost on restart).
With `REPOSITORY=postgres` the app refuses to start unless `SUPABASE_JWKS_URL` or `SUPABASE_JWT_SECRET` is set.
`DATABASE_URL`: use the Supavisor session pooler (`aws-0-<region>.pooler.supabase.com:5432`, IPv4); the direct
host `db.<ref>.supabase.co` is IPv6-only without the paid IPv4 add-on.
Sentry (§11): set `SENTRY_DSN` (optional `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`); no PII is sent.

## Test
```bash
.venv/Scripts/python.exe -m pytest -q
```
`tests/test_postgres_repo.py` runs against a real Postgres built from the **real** schema
(`supabase/validate/stubs.sql` + `supabase/migrations/*.sql`, rebuilt before every test): `TEST_DATABASE_URL` if set
(**destructive** — drops and recreates schemas `public` and `auth`; use a throwaway plain Postgres ≥ 15, never a
Supabase instance), otherwise an embedded server from `pgserver` (extra `pgtest`); skipped if neither.

## Docker
```bash
docker build -t chartswipe-api ./api
docker run --env-file api/.env -p 8000:8000 chartswipe-api
```
The image runs `uvicorn app.main:create_app --factory` as a non-root user with a `/health` healthcheck.
HTTPS is terminated by Dokploy (architecture §11). Keep a single replica: the rate limiter is in-memory.
