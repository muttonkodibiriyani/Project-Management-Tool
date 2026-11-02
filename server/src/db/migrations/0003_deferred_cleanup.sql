-- 0003_deferred_cleanup.sql · durable retries for external side effects that outlive a database transaction.
-- Keys are opaque Blob paths (area/workspace uuid/file uuid), never user-supplied file names or content.
create table deferred_cleanup (
  kind            text not null check (kind in ('blob')),
  key             text not null,
  attempts        int not null default 0 check (attempts >= 0),
  created_at      timestamptz not null default now(),
  last_attempt_at timestamptz,
  primary key (kind, key)
);

grant select, insert, update, delete on deferred_cleanup to lt_app;
