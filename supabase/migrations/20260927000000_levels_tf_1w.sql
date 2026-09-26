-- levels.tf: add the weekly timeframe '1w' (TF bar button "Н", architecture §5.6 / §6).
-- The init migration declared an inline column check, which Postgres named
-- levels_tf_check. Replace it with the extended list; existing values are kept,
-- so no row can violate the new constraint (validation is cheap and immediate).
-- Keep this list in sync with api/app/models.py Timeframe and
-- web/lib/detector/types.ts DetectorTf (api/tests/test_cross_stream_contracts.py
-- takes the LAST tf in-list check across supabase/migrations/*.sql as effective).

alter table public.levels drop constraint if exists levels_tf_check;
alter table public.levels
  add constraint levels_tf_check check (tf in ('5m', '1h', '1d', '1w'));

comment on column public.levels.tf is 'Timeframe the level was placed on: 5m | 1h | 1d | 1w.';
