-- ChartSwipe — initial schema (architecture.md §6).
-- Tables: watchlists, levels, symbol_map, api_keys, push_subscriptions.
-- Every table is owned by a Supabase Auth user and protected by RLS
-- (user_id = auth.uid()). The backend uses the service role ONLY in sync
-- endpoints (API-key auth); everything else runs with the user's JWT.
-- Target: Postgres 15 (Supabase).


-- ---------------------------------------------------------------------------
-- Shared trigger function: server-controlled timestamps on INSERT and UPDATE.
-- updated_at is ALWAYS overwritten with now() (transaction start time), so a
-- client-supplied value (e.g. levels uploaded from IndexedDB on sign-in, A10)
-- can never land behind the MT5 sync cursor (ADR A6: server clock only).
-- created_at: immutable on UPDATE; on INSERT a client value is kept (local
-- creation time) but clamped to now(), NULL falls back to now().
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  else
    new.created_at := least(coalesce(new.created_at, now()), now());
  end if;
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE INSERT OR UPDATE trigger: updated_at = now() always (sync cursor source, ADR A6); created_at immutable.';

-- ---------------------------------------------------------------------------
-- watchlists (F6). Symbols are Binance USDⓈ-M futures tickers, e.g. BTCUSDT.
-- API: GET/PUT /v1/watchlists (PUT replaces the whole list).
-- ---------------------------------------------------------------------------
create table public.watchlists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid()
              references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 64),
  symbols     text[] not null default '{}',
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Natural key: one list per name (the synced 'Избранное' list, §5.7/A10),
  -- enables idempotent `on conflict (user_id, name)` upserts.
  constraint watchlists_user_name_key unique (user_id, name),
  constraint watchlists_symbols_max check (cardinality(symbols) <= 500)
);

create index watchlists_user_position_idx on public.watchlists (user_id, position);

create trigger watchlists_set_updated_at
  before insert or update on public.watchlists
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- levels (F4/F5). Deletion is soft only: deleted_at = now(), updated_at = now()
-- (the trigger guarantees updated_at), so MT5 sync can emit deleted=1 rows.
-- Hard DELETE is not granted to end users (see privileges/RLS below); only
-- the auth.users ON DELETE CASCADE and the service role remove rows.
-- ---------------------------------------------------------------------------
create table public.levels (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid()
              references auth.users (id) on delete cascade,
  symbol      text not null check (char_length(symbol) between 1 and 32),
  tf          text not null default '1d' check (tf in ('5m', '1h', '1d')),
  kind        text not null check (kind in ('support', 'resistance', 'zone')),
  price       numeric not null,
  price_to    numeric,
  color       text check (color ~ '^#[0-9A-Fa-f]{6}$'),
  note        text check (char_length(note) <= 140),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint levels_price_positive   check (price > 0),
  constraint levels_price_to_positive check (price_to is null or price_to > 0),
  -- §6: zone needs price_to; stricter: price_to only for zones (MT5 CSV has an
  -- empty price_to for s/r, Pine emits a-b only for z) and the zone is non-empty
  -- with price < price_to (same invariant as api/app/models.py check_level_shape).
  constraint levels_price_to_iff_zone check ((kind = 'zone') = (price_to is not null)),
  constraint levels_zone_nonempty     check (kind <> 'zone' or price_to > price)
);

comment on column public.levels.tf    is 'Timeframe the level was placed on: 5m | 1h | 1d.';
comment on column public.levels.color is 'RGB hex #RRGGBB; API converts to BGR for MT5 (ADR A7). NULL = default color by kind.';
comment on column public.levels.deleted_at is 'Soft delete marker; hard DELETE is not granted to anon/authenticated.';

-- Sync cursor scans: WHERE user_id = ? AND updated_at > ?
create index levels_user_updated_idx on public.levels (user_id, updated_at);
-- Chart rendering: live levels of one symbol.
create index levels_user_symbol_live_idx on public.levels (user_id, symbol)
  where deleted_at is null;

create trigger levels_set_updated_at
  before insert or update on public.levels
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- symbol_map: source symbol -> target platform symbol (e.g. BTCUSDT -> BTCUSD
-- for MT5). Broker suffix is appended by the EA, not stored here.
-- ---------------------------------------------------------------------------
create table public.symbol_map (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid()
                 references auth.users (id) on delete cascade,
  symbol         text not null check (char_length(symbol) between 1 and 32),
  target         text not null check (target in ('mt5', 'tv')),
  target_symbol  text not null check (char_length(target_symbol) between 1 and 64),
  created_at     timestamptz not null default now(),
  constraint symbol_map_user_symbol_target_key unique (user_id, symbol, target)
);

-- ---------------------------------------------------------------------------
-- api_keys: only sha256 hex of the key is stored; plaintext is shown once.
-- Lookup on every sync request: WHERE key_hash = ? AND revoked_at IS NULL.
-- ---------------------------------------------------------------------------
create table public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
  name          text check (char_length(name) <= 64),
  key_hash      text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix    text check (char_length(key_prefix) <= 16),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

comment on column public.api_keys.key_hash   is 'Lowercase hex sha256 of the plaintext key.';
comment on column public.api_keys.key_prefix is 'First chars of the key for display in UI (not secret).';

-- Revocation is final and the hash is immutable: a leaked-and-revoked key can
-- never be re-activated or re-pointed by a user-context UPDATE.
create or replace function public.api_keys_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'API-ключ уже отозван' using errcode = 'check_violation';
  end if;
  if new.key_hash <> old.key_hash or new.user_id <> old.user_id
     or new.created_at <> old.created_at then
    raise exception 'Нельзя изменить ключ' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.api_keys_guard() is
  'BEFORE UPDATE trigger on api_keys: revoked_at is irreversible; key_hash/user_id/created_at immutable.';

create unique index api_keys_key_hash_idx on public.api_keys (key_hash);
create index api_keys_user_idx on public.api_keys (user_id);

create trigger api_keys_guard
  before update on public.api_keys
  for each row execute function public.api_keys_guard();

-- ---------------------------------------------------------------------------
-- push_subscriptions (F8, v1): Web Push endpoints. Table exists from MVP so
-- the schema matches the spec; not used by MVP code.
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid()
              references auth.users (id) on delete cascade,
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  constraint push_subscriptions_endpoint_key unique (endpoint)
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: per-operation policies, user_id = auth.uid().
-- (select auth.uid()) is evaluated once per statement (initPlan), not per row.
-- ---------------------------------------------------------------------------
alter table public.watchlists         enable row level security;
alter table public.levels             enable row level security;
alter table public.symbol_map         enable row level security;
alter table public.api_keys           enable row level security;
alter table public.push_subscriptions enable row level security;

-- watchlists
create policy watchlists_select on public.watchlists
  for select to authenticated using (user_id = (select auth.uid()));
create policy watchlists_insert on public.watchlists
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy watchlists_update on public.watchlists
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy watchlists_delete on public.watchlists
  for delete to authenticated using (user_id = (select auth.uid()));

-- levels
create policy levels_select on public.levels
  for select to authenticated using (user_id = (select auth.uid()));
create policy levels_insert on public.levels
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy levels_update on public.levels
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- No levels_delete policy: deletion is soft only (§6). Also revoked below.

-- symbol_map
create policy symbol_map_select on public.symbol_map
  for select to authenticated using (user_id = (select auth.uid()));
create policy symbol_map_insert on public.symbol_map
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy symbol_map_update on public.symbol_map
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy symbol_map_delete on public.symbol_map
  for delete to authenticated using (user_id = (select auth.uid()));

-- api_keys
create policy api_keys_select on public.api_keys
  for select to authenticated using (user_id = (select auth.uid()));
create policy api_keys_insert on public.api_keys
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy api_keys_update on public.api_keys
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy api_keys_delete on public.api_keys
  for delete to authenticated using (user_id = (select auth.uid()));

-- push_subscriptions
create policy push_subscriptions_select on public.push_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
create policy push_subscriptions_insert on public.push_subscriptions
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy push_subscriptions_update on public.push_subscriptions
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy push_subscriptions_delete on public.push_subscriptions
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Privileges: explicit, not reliant on Supabase default grants. anon gets
-- nothing (all app data requires sign-in, A10 keeps guest data local).
-- authenticated: no hard DELETE on levels (soft delete only, §6); api_keys
-- writes limited to what the API does under the user's JWT: INSERT of a
-- server-generated sha256 (keys POST) and UPDATE of name/revoked_at (revoke).
-- last_used_at is written only by the sync path (connection owner / service).
-- ---------------------------------------------------------------------------
revoke all on public.watchlists, public.levels, public.symbol_map,
              public.api_keys, public.push_subscriptions
  from anon, authenticated;

grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on public.watchlists         to authenticated;
grant select, insert, update         on public.levels             to authenticated;
grant select, insert, update, delete on public.symbol_map         to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select, insert, delete         on public.api_keys           to authenticated;
grant update (name, revoked_at)      on public.api_keys           to authenticated;

grant all on public.watchlists, public.levels, public.symbol_map,
             public.api_keys, public.push_subscriptions
  to service_role;
