-- 0001_init.sql · Launch Tracker
create extension if not exists citext;

create sequence change_seq;

create or replace function touch_row() returns trigger language plpgsql as $$
begin
  new.change_seq := nextval('change_seq');
  new.updated_at := now();
  return new;
end $$;

-- ---------- tenancy and people (gr8r: workspace, members, teams) ----------
create table workspace (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  name         text not null check (length(name) between 1 and 120),
  colour       text not null default '#5A67D8',
  settings     jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  -- settings.marginAccess = {"roles":[...app roles], "teams":[...team keys]}; settings.contactAccess likewise
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table app_user (
  id           uuid primary key default gen_random_uuid(),
  entra_oid    uuid unique,                       -- null only for a pending invite
  tenant_id    uuid,
  email        citext not null unique,
  name         text not null,
  title        text,
  colour       text not null default '#6B7280',
  time_zone    text,
  prefs        jsonb not null default '{}'::jsonb check (jsonb_typeof(prefs) = 'object'),
                                                   -- gr8r prefs, notifPrefs, recentSearches
  app_roles    text[] not null default '{}',      -- last seen `roles` claim, refreshed each sign-in
  status       text not null default 'active' check (status in ('active','invited','disabled')),
  last_seen_at timestamptz,
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table workspace_member (
  workspace_id uuid not null references workspace(id),
  user_id      uuid not null references app_user(id),
  gr8r_role    text not null default 'Member' check (gr8r_role in ('Owner','Admin','Member','Guest')),
  invited_by   uuid references app_user(id),
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (workspace_id, user_id)
);

create table team (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  key          text not null check (key ~ '^[a-z0-9_]{1,40}$'),   -- brand, supply, vm, comms, commercial, registration, marketing
  name         text not null,
  icon         text not null default 'users',
  colour       text not null default '#8A867E',
  description  text not null default '',
  app_role     text,               -- when set, membership comes from this Entra app role at sign-in
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (workspace_id, key)
);

create table team_member (
  team_id      uuid not null references team(id),
  user_id      uuid not null references app_user(id),
  source       text not null check (source in ('entra','manual')),
  created_at   timestamptz not null default now(),
  primary key (team_id, user_id)
);

-- ---------- reference data ----------
create table market (
  code         text primary key check (code ~ '^[A-Z]{3}$'),   -- QAT, KSA, UAE, KWT, BHR, OMN
  name         text not null
);
insert into market values ('QAT','Qatar'),('KSA','Saudi Arabia'),('UAE','United Arab Emirates'),
                          ('KWT','Kuwait'),('BHR','Bahrain'),('OMN','Oman');

-- ---------- templates, vocabularies, fields and gates ----------
create table template (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  key          text not null,                    -- gcc_store_launch, us_npd, market_visit, general
  name         text not null,
  kind         text not null check (kind in ('launch','npd','visit','general')),
  status_list_id uuid,                           -- value_list of task statuses; null = gr8r's five
  rules        jsonb not null default '[]'::jsonb check (jsonb_typeof(rules) = 'array'),
  archived     boolean not null default false,
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (workspace_id, key)
);

create table value_list (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  key          text not null check (key ~ '^[a-z0-9_]{1,40}$'),   -- listing, comms, brand_code, brand_team …
  name         text not null,
  validation   text not null default 'block' check (validation in ('block','warn')),
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (workspace_id, key)
);
alter table template add foreign key (status_list_id) references value_list(id);

create table list_option (
  id           uuid primary key default gen_random_uuid(),
  list_id      uuid not null references value_list(id),
  key          text not null check (key ~ '^[a-z0-9_]{1,60}$'),   -- immutable once created
  label        text not null check (length(label) between 1 and 80),
  colour       text,                              -- '#E4D2F7'; the brand_code list carries the legend (hue)
  excel_fill   text,                              -- fill used in exports when it differs from colour ('#D9D2E9')
  is_done      boolean not null default false,    -- counts as done for readiness and dashboards
  closes       text check (closes in ('store','line')),  -- 'No' listing closes the store's gates; Grey closes the line
  position     int not null,
  archived     boolean not null default false,    -- hidden from dropdowns, still valid on old rows
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (list_id, key)
);

create table field_def (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspace(id),
  template_id   uuid references template(id),     -- null = workspace-wide (brand, brand_market fields)
  scope         text not null check (scope in ('line','line_store','brand','brand_market','install')),
  key           text not null check (key ~ '^[a-z0-9_]{1,60}$'),
  label         text not null,
  type          text not null check (type in ('select','multiselect','text','number','integer','date',
                                              'boolean','store_ref','store_or_market_ref','member_ref','fixture')),
  list_id       uuid references value_list(id),    -- required for select, multiselect, fixture
  column_group  text,                               -- grid column group: Classification, Store, Brand × market …
  position      int not null,
  is_gate       boolean not null default false,
  owner_team_id uuid references team(id),           -- gates: the team that edits it (spec section 8)
  due_offset_days int,                              -- gates: days relative to store opening (−120 … 0)
  applies_when  jsonb,                              -- optional rule, same shape as template.rules[].when
  version       int not null default 1,
  change_seq    bigint not null default nextval('change_seq'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  check (type not in ('select','multiselect','fixture') or list_id is not null),
  check (not is_gate or owner_team_id is not null)
);
create unique index field_def_key on field_def (workspace_id, coalesce(template_id, '00000000-0000-0000-0000-000000000000'::uuid), scope, key)
  where deleted_at is null;

-- ---------- stores ----------
create table store (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  code         text not null check (code ~ '^[A-Z0-9]{2,8}$'),   -- DFC, VLG, AVE, HILLS
  name         text not null,
  mall         text,
  city         text,
  market_code  text not null references market(code),
  role         text not null default 'launching' check (role in ('launching','reference')),
  opening_date date,
  opening_note text,                                -- 'November' when no exact date
  status       text not null default 'planned' check (status in ('planned','open','closed')),
  aliases      text[] not null default '{}',
  archived     boolean not null default false,
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (workspace_id, code)
);

create table store_capacity (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  store_id     uuid not null references store(id),
  category     text not null,                     -- category or zone as on FIXTURE COUNTS
  fixture_type text not null,                     -- option key of list fixture_type
  count        int check (count >= 0),            -- null when the sheet had '-'
  source       text,
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (store_id, category, fixture_type)
);

-- ---------- projects = launches (gr8r project kept whole) ----------
create table project (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  template_id  uuid references template(id),
  kind         text not null default 'general' check (kind in ('launch','npd','visit','general')),
  key          text not null check (key ~ '^[A-Z]{2,6}$'),     -- task key prefix: QAT, AVE
  name         text not null,
  description  text not null default '',          -- gr8r desc; tblLaunches Description
  launch_code  text,                              -- tblLaunches Launch: 'QAT 2026'
  market_code  text references market(code),      -- required when kind = 'launch'
  icon         text not null default 'folder',
  colour       text not null default 'indigo',
  status       text not null default 'planning' check (status in ('planning','active','risk','hold','complete')),
  team_id      uuid references team(id),
  lead_id      uuid references app_user(id),
  start_date   date,
  due_date     date,
  private      boolean not null default false,
  archived     boolean not null default false,
  next_task_no int not null default 1,            -- allocates QAT-001 … ; never reused
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_by   uuid references app_user(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (workspace_id, key),
  check (kind <> 'launch' or market_code is not null)
);

create table project_member (
  project_id   uuid not null references project(id),
  user_id      uuid not null references app_user(id),
  created_at   timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table launch_store (
  project_id   uuid not null references project(id),
  store_id     uuid not null references store(id),
  slot         smallint not null check (slot between 1 and 20), -- workbook S1, S2 = slots 1, 2
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (project_id, store_id),
  unique (project_id, slot)
);

create table launch_reference (
  project_id   uuid not null references project(id),
  reference_id uuid not null references project(id),
  primary key (project_id, reference_id),
  check (project_id <> reference_id)
);

create table milestone (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project(id),
  name         text not null,
  date         date not null,
  store_id     uuid references store(id),          -- store-opening milestones
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

-- ---------- brands, vendors, contacts ----------
create table brand (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspace(id),
  name                 text not null,
  name_norm            text not null,               -- lower, trimmed, spaces collapsed: one row per brand
  host_group           text,
  new_brand            boolean not null default false,
  new_brand_category   text,
  new_brand_as_written text,
  values               jsonb not null default '{}'::jsonb check (jsonb_typeof(values) = 'object'),
  source               text,
  version              int not null default 1,
  change_seq           bigint not null default nextval('change_seq'),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  unique (workspace_id, name_norm)
);

create table vendor (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  name         text not null,
  name_norm    text not null,                       -- letters and digits only, upper
  aliases      text[] not null default '{}',        -- every spelling found
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (workspace_id, name_norm)
);

-- restricted: contact details (API: contacts permission)
create table contact (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  vendor_id    uuid not null references vendor(id),
  market_code  text references market(code),
  name         text,
  role         text,
  emails       text[] not null default '{}',
  phones       text[] not null default '{}',
  as_written   text,
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create table brand_market (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references workspace(id),
  brand_id               uuid not null references brand(id),
  market_code            text not null references market(code),
  distribution_status    text,                      -- option key, list dist_status
  distributor_id         uuid references vendor(id),
  distributor_as_written text,
  exclusive              text,                      -- option key, list exclusivity
  exclusive_months       int check (exclusive_months between 1 and 120),
  registration_route     text,                      -- option key, list reg_route
  values                 jsonb not null default '{}'::jsonb check (jsonb_typeof(values) = 'object'),
  notes                  text,
  source                 text,
  version                int not null default 1,
  change_seq             bigint not null default nextval('change_seq'),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  unique (brand_id, market_code)
);

-- restricted: margins (API: margins permission). 1:1 with brand_market.
create table brand_market_margin (
  brand_market_id uuid primary key references brand_market(id),
  workspace_id    uuid not null references workspace(id),
  margin          numeric(6,4) check (margin between 0 and 1),
  extra_margin    numeric(6,4) check (extra_margin between 0 and 1),
  terms           text,
  as_written      text,
  version         int not null default 1,
  change_seq      bigint not null default nextval('change_seq'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- restricted: contacts as written per brand × market (API: contacts permission). 1:1 with brand_market.
create table brand_market_contacts (
  brand_market_id    uuid primary key references brand_market(id),
  workspace_id       uuid not null references workspace(id),
  contacts_as_written text,
  contact_ids        uuid[] not null default '{}',
  version            int not null default 1,
  change_seq         bigint not null default nextval('change_seq'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------- tasks = launch lines (gr8r task kept whole) ----------
create table task (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  project_id   uuid not null references project(id),
  kind         text not null default 'task' check (kind in ('task','line','follow_up','visit','meeting','npd')),
  key          text not null,                       -- QAT-001; never reused
  title        text not null check (length(title) between 1 and 500),
  description  text not null default '',            -- sanitised HTML (gr8r desc)
  status       text not null default 'todo',        -- option key of the template's status list, or gr8r's five
  priority     text not null default 'none' check (priority in ('urgent','high','medium','low','none')),
  assignee_id  uuid references app_user(id),
  start_date   date,
  due_date     date,
  labels       text[] not null default '{}',
  estimate     text,
  recur        jsonb,                               -- gr8r recurring rule, as gr8r stores it
  sort_order   double precision not null,           -- drag and drop; midpoint inserts
  archived     boolean not null default false,
  brand_id     uuid references brand(id),
  double_of_id uuid references task(id),            -- DOUBLE: the primary line
  follows_up_id uuid references task(id),           -- kind follow_up: the line it chases
  follows_up_gate text,                             -- field_def.key of the gate it chases (null = the line)
  follows_up_store_id uuid references store(id),    -- store, for a line x store gate
  external_key text,                                -- 'Zone Brand' (old MYRA CONCATENATE)
  values       jsonb not null default '{}'::jsonb check (jsonb_typeof(values) = 'object'),
  readiness    numeric(5,4),                         -- done applicable gates / applicable gates; app-maintained
  notes        text,
  source       text,                                 -- old sheet and row
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_by   uuid references app_user(id),
  created_at   timestamptz not null default now(),
  updated_by   uuid references app_user(id),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (project_id, key)
);
create unique index task_external_key on task (project_id, external_key) where external_key is not null and deleted_at is null;
create index task_project on task (project_id) where deleted_at is null;
create index task_assignee on task (assignee_id) where deleted_at is null and not archived;
create index task_brand on task (brand_id);
create index task_values on task using gin (values jsonb_path_ops);
create index task_due on task (due_date) where deleted_at is null;
create index task_follows_up on task (follows_up_id) where deleted_at is null and kind = 'follow_up';

create table line_store (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  task_id      uuid not null references task(id),
  store_id     uuid not null references store(id),
  values       jsonb not null default '{}'::jsonb check (jsonb_typeof(values) = 'object'),
  source       text,
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  updated_by   uuid references app_user(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (task_id, store_id)
);
create index line_store_store on line_store (store_id);
create index line_store_values on line_store using gin (values jsonb_path_ops);

create table subtask (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references task(id),
  title        text not null,
  done         boolean not null default false,
  position     int not null,
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create table task_dependency (
  task_id      uuid not null references task(id),
  depends_on_id uuid not null references task(id),
  created_at   timestamptz not null default now(),
  primary key (task_id, depends_on_id),
  check (task_id <> depends_on_id)
);

-- ---------- workbook blocks without a gr8r concept ----------
create table install (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspace(id),
  project_id           uuid not null references project(id),
  task_id              uuid references task(id),     -- when the install belongs to one line
  store_id             uuid not null references store(id),
  host_group           text,
  vendor_id            uuid references vendor(id),
  vendor_as_written    text,
  brand                text,
  zone_as_written      text,
  fixture_as_written   text,
  same_fixture_as      jsonb,                        -- store_or_market_ref shape
  vendor_pack          text,
  install_start        date,
  install_end          date check (install_end is null or install_start is null or install_end >= install_start),
  install_status       text,                         -- option key, list install_status (gate VM install)
  contractor           text,
  delivery_date        date,
  delivery_status      text,                         -- option key, list delivery_status (gate Delivery)
  vm_status            text,                         -- option key, list vm_status
  wall_perimeter       boolean,
  email_sent           date,
  email_sent_by        text,
  values               jsonb not null default '{}'::jsonb check (jsonb_typeof(values) = 'object'),
  notes                text,
  source               text,
  version              int not null default 1,
  change_seq           bigint not null default nextval('change_seq'),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create table vendor_pack (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspace(id),
  project_id        uuid not null references project(id),
  vendor_id         uuid references vendor(id),
  vendor_as_written text,
  brand_as_written  text,
  category          text,
  store1_fixture    text,
  store2_fixture    text,
  pack_ref          text,
  fixture_ref       text,
  shelves_note      text,
  source            text,
  version           int not null default 1,
  change_seq        bigint not null default nextval('change_seq'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create table brand_list_entry (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  project_id   uuid not null references project(id),
  list         text not null,
  entry        text not null,
  vendor       text,
  category     text,
  fixture      text,
  source       text,
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

-- gr8r calendar events; market-visit agenda rows are events of a visit project
create table event (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspace(id),
  project_id     uuid references project(id),
  title          text not null,                    -- tblAgenda Activity
  date           date not null,
  time_text      text,                             -- gr8r '10:00' or the agenda's slot as written
  person         text,                             -- tblAgenda Person
  day_as_written text,
  source         text,
  version        int not null default 1,
  change_seq     bigint not null default nextval('change_seq'),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create table visit_brand (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspace(id),
  project_id        uuid not null references project(id),
  vendor_id         uuid references vendor(id),
  vendor_as_written text,
  brand_id          uuid references brand(id),
  brand_as_written  text,
  category          text,
  source            text,
  version           int not null default 1,
  change_seq        bigint not null default nextval('change_seq'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

-- ---------- collaboration (gr8r) ----------
create table file (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspace(id),
  project_id    uuid references project(id),
  task_id       uuid references task(id),
  comment_id    uuid,                               -- fk added below
  name          text not null check (length(name) between 1 and 255),
  content_type  text not null,
  size_bytes    bigint not null check (size_bytes between 0 and 26214400),   -- 25 MiB
  sha256        text not null,
  blob_container text not null check (blob_container in ('attachments','imports')),
  blob_name     text not null unique,               -- '{workspaceId}/{fileId}'; no names or PII
  uploaded_by   uuid not null references app_user(id),
  version       int not null default 1,
  change_seq    bigint not null default nextval('change_seq'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table comment (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  task_id      uuid not null references task(id),
  author_id    uuid not null references app_user(id),
  body         text not null check (length(body) between 1 and 20000),   -- sanitised HTML
  edited_at    timestamptz,
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
alter table file add foreign key (comment_id) references comment(id);
create index comment_task on comment (task_id);

create table comment_reaction (
  comment_id   uuid not null references comment(id),
  user_id      uuid not null references app_user(id),
  emoji        text not null check (length(emoji) between 1 and 16),
  created_at   timestamptz not null default now(),
  primary key (comment_id, user_id, emoji)
);

create table comment_mention (
  comment_id   uuid not null references comment(id),
  user_id      uuid not null references app_user(id),
  primary key (comment_id, user_id)
);

create table activity (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references workspace(id),
  project_id   uuid references project(id),
  task_id      uuid references task(id),
  actor_id     uuid references app_user(id),       -- null for system (import commit is attributed to its user)
  verb         text not null,                      -- created, updated, moved, completed, commented, uploaded, imported, exported, deleted, signed_in …
  entity_kind  text not null,
  entity_id    uuid,
  entity_version int,
  changes      jsonb,                              -- [{"field":"values.icf","from":"pending","to":"received"}]
  extra        text,
  sensitivity  text not null default 'normal' check (sensitivity in ('normal','margin','contact')),
  request_id   text,
  at           timestamptz not null default now()
);
create index activity_task on activity (task_id, id desc);
create index activity_project on activity (project_id, id desc);
create index activity_ws on activity (workspace_id, id desc);

create table notification (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  user_id      uuid not null references app_user(id),
  type         text not null check (type in ('mention','assign','comment','due','follow_up','status','import')),
  actor_id     uuid references app_user(id),
  task_id      uuid references task(id),
  comment_id   uuid references comment(id),
  text         text not null,
  read_at      timestamptz,
  archived     boolean not null default false,
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index notification_user on notification (user_id, created_at desc);

create table saved_view (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  project_id   uuid references project(id),        -- null = cross-project (My tasks, "New to market")
  owner_id     uuid references app_user(id),       -- null = shared with the workspace
  name         text not null,
  type         text not null check (type in ('list','board','table','calendar','timeline','files','overview')),
  config       jsonb not null default '{}'::jsonb, -- {filters,sort,group,columns,collapsedGroups}, gr8r shape
  version      int not null default 1,
  change_seq   bigint not null default nextval('change_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create table favourite (
  user_id      uuid not null references app_user(id),
  entity_kind  text not null check (entity_kind in ('project','task','saved_view')),
  entity_id    uuid not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, entity_kind, entity_id)
);

-- ---------- sign-in sessions (also the Settings → Sessions list) ----------
create table user_session (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app_user(id),
  token_hash    bytea not null unique,              -- sha256 of the cookie value
  user_agent    text,
  ip            inet,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,               -- absolute: created + 12 h
  revoked_at    timestamptz
);
create index user_session_user on user_session (user_id);

-- ---------- import ----------
create table import_job (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspace(id),
  project_id    uuid references project(id),        -- target launch; null until chosen
  file_id       uuid not null references file(id),
  sheet         text,
  layout        text check (layout in ('launch_tracker','avenues','organised','fixture_counts','custom')),
  mapping       jsonb not null default '{}'::jsonb, -- {"<column letter>": "<target field path>"}
  status        text not null default 'uploaded' check (status in ('uploaded','mapped','previewed','committing','committed','failed','cancelled')),
  summary       jsonb,                              -- {"created":n,"updated":n,"unchanged":n,"exceptions":n}
  created_by    uuid not null references app_user(id),
  committed_at  timestamptz,
  expires_at    timestamptz not null default now() + interval '24 hours',  -- uncommitted drafts are discarded after this
  version       int not null default 1,
  change_seq    bigint not null default nextval('change_seq'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table import_exception (
  id            bigint generated always as identity primary key,
  import_id     uuid not null references import_job(id),
  sheet         text not null,
  row_no        int not null,
  field         text,
  kind          text not null check (kind in ('unknown_value','duplicate','double_linked','cleared_error','conflict','unknown_brand','unknown_vendor','unknown_store')),
  value         text,
  message       text not null,
  resolution    jsonb                               -- the user's choice in step 3
);

create table import_normalisation (
  id            uuid not null default gen_random_uuid() unique,
  import_id     uuid not null references import_job(id),
  field         text not null,
  original      text not null,
  stored_as     text not null,                      -- '(empty)' or '(moved to Notes)' as in tblNormalised; the user may change it in step 3
  cells         int not null,
  primary key (import_id, field, original)
);

-- ---------- retry safety for client writes ----------
create table idempotency_key (
  user_id       uuid not null references app_user(id),
  key           text not null check (length(key) between 8 and 80),
  request_hash  bytea not null,
  status        int not null,
  response      jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (user_id, key)
);   -- rows older than 24 h are deleted on startup and hourly

-- ---------- change-seq triggers on every table with change_seq ----------
do $$
declare t text;
begin
  for t in select table_name from information_schema.columns
           where table_schema = 'public' and column_name = 'change_seq' loop
    execute format('create trigger %I_touch before update on %I for each row execute function touch_row()', t, t);
  end loop;
end $$;

-- ---------- database roles (names are the managed identities' Entra principal names) ----------
-- Created by the deploy script as the Entra admin, not by this migration:
--   lt_migrate  = user-assigned identity id-lt-migrate: owns the schema, runs migrations (Container Apps job)
--   lt_app      = user-assigned identity id-lt-app: the running API
-- This migration grants:
grant usage on schema public to lt_app;
grant select, insert, update, delete on all tables in schema public to lt_app;
revoke update, delete on activity from lt_app;              -- append-only
revoke insert, update, delete on market from lt_app;
grant usage, select on all sequences in schema public to lt_app;
