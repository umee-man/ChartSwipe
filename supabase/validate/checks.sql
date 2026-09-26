-- Behavioural checks for the init migration (run after stubs + migration).
\set ON_ERROR_STOP on
-- No GRANTs here on purpose: the checks must run on the migration's own
-- privilege set, exactly as on a Supabase project.

insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-00000000000b');

-- RLS enabled on all 5 tables; 4 policies each except levels (no delete) = 19
do $$ begin
  assert (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind='r' and c.relrowsecurity) = 5, 'RLS not on 5 tables';
  assert (select count(*) from pg_policies where schemaname='public') = 19, 'expected 19 policies';
  assert not exists (select 1 from pg_policies where tablename='levels' and cmd='DELETE'), 'levels delete policy exists';
  assert not has_table_privilege('authenticated', 'public.levels', 'DELETE'), 'authenticated can DELETE levels';
  assert not has_column_privilege('authenticated', 'public.api_keys', 'key_hash', 'UPDATE'), 'key_hash updatable';
  assert has_column_privilege('authenticated', 'public.api_keys', 'revoked_at', 'UPDATE'), 'revoked_at not updatable';
end $$;

-- anon role gets nothing on any table
set role anon;
do $$
declare t text; n int;
begin
  foreach t in array array['watchlists','levels','symbol_map','api_keys','push_subscriptions'] loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      raise exception 'SHOULD HAVE FAILED: anon select %', t;
    exception when insufficient_privilege then raise notice 'ok rejected: anon select % (42501)', t;
    end;
    begin
      execute format('delete from public.%I', t);
      raise exception 'SHOULD HAVE FAILED: anon delete %', t;
    exception when insufficient_privilege then raise notice 'ok rejected: anon delete % (42501)', t;
    end;
  end loop;
end $$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);

-- insert with default user_id
insert into public.levels (symbol, kind, price) values ('BTCUSDT', 'support', 64200);
do $$ begin
  assert (select user_id from public.levels limit 1) = '00000000-0000-0000-0000-00000000000a', 'default user_id';
end $$;

-- constraint + RLS negatives: each must fail
do $$
declare stmts text[] := array[
  $q$insert into public.levels (symbol, kind, price) values ('BTCUSDT','zone',1)$q$,
  $q$insert into public.levels (symbol, kind, price, price_to) values ('BTCUSDT','support',1,2)$q$,
  $q$insert into public.levels (symbol, kind, price, price_to) values ('BTCUSDT','resistance',1,2)$q$,
  $q$insert into public.levels (symbol, kind, price, price_to) values ('BTCUSDT','zone',5,5)$q$,
  $q$insert into public.levels (symbol, kind, price, price_to) values ('BTCUSDT','zone',5,4)$q$,
  $q$insert into public.watchlists (name, symbols) values ('Big', array_fill('BTCUSDT'::text, array[501]))$q$,
  $q$insert into public.levels (symbol, kind, price) values ('BTCUSDT','support',0)$q$,
  $q$insert into public.levels (symbol, kind, price) values ('BTCUSDT','support',-5)$q$,
  $q$insert into public.levels (symbol, kind, price, note) values ('BTCUSDT','support',1, repeat('я',141))$q$,
  $q$insert into public.levels (symbol, kind, price, tf) values ('BTCUSDT','support',1,'4h')$q$,
  $q$insert into public.levels (symbol, kind, price) values ('BTCUSDT','line',1)$q$,
  $q$insert into public.symbol_map (symbol, target, target_symbol) values ('BTCUSDT','ctrader','BTCUSD')$q$,
  $q$insert into public.api_keys (key_hash) values ('nothex')$q$,
  $q$insert into public.levels (user_id, symbol, kind, price) values ('00000000-0000-0000-0000-00000000000b','BTCUSDT','support',1)$q$
];
s text;
begin
  foreach s in array stmts loop
    begin
      execute s;
      raise exception 'SHOULD HAVE FAILED: %', s;
    exception when check_violation or insufficient_privilege or invalid_text_representation then
      raise notice 'ok rejected: % (%)', left(s, 70), sqlstate;
    end;
  end loop;
end $$;

-- positives
insert into public.levels (symbol, kind, price, price_to, note) values ('BTCUSDT','zone',63000,63400, repeat('я',140));
insert into public.symbol_map (symbol, target, target_symbol) values ('BTCUSDT','mt5','BTCUSD');
insert into public.api_keys (key_hash) values (repeat('ab',32));
insert into public.watchlists (name, symbols) values ('Основной', array['BTCUSDT']);
insert into public.watchlists (name, symbols) values ('Избранное', array_fill('ETHUSDT'::text, array[500]));
-- duplicate list name for the same user is rejected; upsert on the natural key works
do $$ begin
  begin
    insert into public.watchlists (name) values ('Избранное');
    raise exception 'SHOULD HAVE FAILED: duplicate watchlist name';
  exception when unique_violation then raise notice 'ok rejected: duplicate watchlist name (23505)';
  end;
end $$;
insert into public.watchlists (name, symbols) values ('Избранное', array['SOLUSDT'])
  on conflict (user_id, name) do update set symbols = excluded.symbols;
do $$ begin
  assert (select symbols from public.watchlists where name='Избранное') = array['SOLUSDT'], 'watchlist upsert';
end $$;

-- client-supplied timestamps on INSERT are overridden (ADR A6)
insert into public.levels (symbol, kind, price, updated_at, created_at)
  values ('ETHUSDT', 'support', 3120, '2000-01-01', '2999-01-01');
insert into public.watchlists (name, updated_at) values ('Old', '2000-01-01');
do $$ begin
  assert (select updated_at >= transaction_timestamp() - interval '1 minute'
          from public.levels where symbol='ETHUSDT'), 'levels insert kept client updated_at';
  assert (select created_at <= now() from public.levels where symbol='ETHUSDT'), 'future created_at not clamped';
  assert (select updated_at > '2001-01-01' from public.watchlists where name='Old'), 'watchlists insert kept client updated_at';
end $$;
-- ...and on UPDATE, created_at is immutable, updated_at forced
update public.levels set created_at = '2000-01-01', updated_at = '2000-01-01' where symbol='ETHUSDT';
do $$ begin
  assert (select created_at > '2001-01-01' and updated_at > '2001-01-01'
          from public.levels where symbol='ETHUSDT'), 'update accepted client timestamps';
end $$;

-- hard DELETE of own levels is refused (soft delete only, §6)
do $$ declare n int; begin
  begin
    delete from public.levels where symbol='ETHUSDT';
    get diagnostics n = row_count;
    assert n = 0, 'hard delete removed rows';
  exception when insufficient_privilege then raise notice 'ok rejected: levels hard delete (42501)';
  end;
  assert (select count(*) from public.levels where symbol='ETHUSDT') = 1, 'level row gone after delete';
end $$;

-- api_keys: revoke works; un-revoke, key_hash/owner rewrite and last_used_at forging fail
update public.api_keys set name = 'MT5 VPS';
update public.api_keys set revoked_at = now();
do $$
declare stmts text[] := array[
  $q$update public.api_keys set revoked_at = null$q$,
  $q$update public.api_keys set revoked_at = now() - interval '1 day'$q$,
  $q$update public.api_keys set key_hash = repeat('cd',32)$q$,
  $q$update public.api_keys set last_used_at = now()$q$
];
s text;
begin
  foreach s in array stmts loop
    begin
      execute s;
      raise exception 'SHOULD HAVE FAILED: %', s;
    exception when check_violation or insufficient_privilege then
      raise notice 'ok rejected: % (%)', left(s, 70), sqlstate;
    end;
  end loop;
end $$;
do $$ begin
  assert (select revoked_at is not null and key_hash = repeat('ab',32) and name = 'MT5 VPS'
          from public.api_keys), 'api_keys state after negatives';
end $$;
insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://push.example/x','k','a');

-- trigger: soft delete in a later transaction bumps updated_at
create temp table t0 as select id, updated_at from public.levels where kind='support' and symbol='BTCUSDT';
-- The at-at marker lines below are transaction boundaries for non-psql runners.
-- @@
select pg_sleep(0.05);
-- @@
update public.levels set deleted_at = now() where kind='support' and symbol='BTCUSDT';
-- @@
do $$ begin
  assert (select l.updated_at > t.updated_at from public.levels l join t0 t using (id)), 'trigger did not bump updated_at';
end $$;

-- user b sees nothing of user a and cannot modify it
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
do $$ declare n int; begin
  assert (select count(*) from public.levels) = 0, 'b sees a levels';
  assert (select count(*) from public.api_keys) = 0, 'b sees a keys';
  assert (select count(*) from public.watchlists) = 0, 'b sees a watchlists';
  update public.levels set price = 1; get diagnostics n = row_count; assert n = 0, 'b updated a';
  delete from public.symbol_map;      get diagnostics n = row_count; assert n = 0, 'b deleted a';
end $$;

-- anonymous (no sub) sees nothing
select set_config('request.jwt.claim.sub', '', false);
do $$ begin assert (select count(*) from public.levels) = 0, 'anon-sub sees rows'; end $$;

-- user a cannot move a row to user b
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
do $$ begin
  begin
    update public.levels set user_id = '00000000-0000-0000-0000-00000000000b';
    raise exception 'SHOULD HAVE FAILED: owner change';
  exception when insufficient_privilege then raise notice 'ok rejected: owner change';
  end;
end $$;

-- index planned for sync query shape exists
reset role;
do $$ begin
  assert exists (select 1 from pg_indexes where indexname='levels_user_updated_idx'), 'missing levels idx';
  assert exists (select 1 from pg_indexes where indexname='api_keys_key_hash_idx'), 'missing key_hash idx';
end $$;

-- api_keys guard trigger holds even for privileged roles (column grants aside)
do $$ begin
  begin
    update public.api_keys set key_hash = repeat('cd',32);
    raise exception 'SHOULD HAVE FAILED: owner key_hash rewrite';
  exception when check_violation then raise notice 'ok rejected: owner key_hash rewrite (23514)';
  end;
  begin
    update public.api_keys set revoked_at = null;
    raise exception 'SHOULD HAVE FAILED: owner un-revoke';
  exception when check_violation then raise notice 'ok rejected: owner un-revoke (23514)';
  end;
  update public.api_keys set last_used_at = now();  -- sync path still allowed
end $$;

-- deleting the auth user still cascades (no levels delete grant needed)
delete from auth.users where id = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert (select count(*) from public.levels) = 0, 'cascade did not remove levels';
  assert (select count(*) from public.api_keys) = 0, 'cascade did not remove api_keys';
end $$;
select 'ALL CHECKS PASSED' as result;
