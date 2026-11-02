-- 0003_deferred_cleanup.sql · durable retries for external side effects that outlive a database transaction.
-- Keys are opaque Blob paths (area/workspace uuid/file uuid), never user-supplied file names or content.
create table deferred_cleanup (
  kind            text not null check (kind in ('blob')),
  workspace_id    uuid not null references workspace(id),
  key             text not null,
  attempts        int not null default 0 check (attempts >= 0),
  created_at      timestamptz not null default now(),
  available_at    timestamptz not null default now(),
  last_attempt_at timestamptz,
  lease_token     uuid,
  primary key (kind, key),
  check (
    key ~ '^(attachments|imports)/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and split_part(key, '/', 2) = workspace_id::text
  )
);

create index deferred_cleanup_ready on deferred_cleanup (kind, available_at);

grant select, insert, update, delete on deferred_cleanup to lt_app;
