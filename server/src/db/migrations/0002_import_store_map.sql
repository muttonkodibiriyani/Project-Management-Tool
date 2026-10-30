-- 0002_import_store_map.sql · Launch Tracker
-- The import wizard's store map (API contract 6.17 step 2): the sheet's store groups to launch stores, {"S1": "<store id>"}.
alter table import_job add column store_map jsonb not null default '{}'::jsonb check (jsonb_typeof(store_map) = 'object');
