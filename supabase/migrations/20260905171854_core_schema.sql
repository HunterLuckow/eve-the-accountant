-- Core schema: orgs, profiles, vendors, expenses.
--
-- Deliberately contains NO policies. The final block turns RLS on for all four
-- tables, which makes them deny-by-default: every query from every user returns
-- zero rows until the policies migration grants access. That locked state is
-- the security model's starting point, and it is worth observing before it is
-- opened up.

-- ---------------------------------------------------------------------------
-- Enums
--
-- 'agent' is a peer of the human roles, not a special case. The eve agent signs
-- in as an ordinary Supabase user carrying this role, and RLS constrains it the
-- same way it constrains anyone else.
-- ---------------------------------------------------------------------------
create type user_role as enum ('employee', 'manager', 'finance', 'agent');

create type expense_status as enum (
  'draft',         -- submitter is still editing
  'submitted',     -- entered the queue; this transition wakes the agent
  'needs_review',  -- escalated, awaiting a human decision
  'approved',
  'rejected'
);

-- ---------------------------------------------------------------------------
-- orgs — the tenant boundary
--
-- Every other table carries org_id so RLS can scope by a single JWT claim
-- rather than walking joins on every row.
-- ---------------------------------------------------------------------------
create table orgs (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  -- Above this amount a manager may not self-approve; it routes to finance.
  -- Enforced by a trigger, not a policy: RLS decides who may write, business
  -- limits decide what value is acceptable.
  threshold_cents integer not null default 400000,
  policy_version  text not null default 'v1',
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- profiles — application identity, keyed to Supabase Auth identity
--
-- auth.users is managed by GoTrue and we don't own its shape. profiles is the
-- app-side extension: which org you belong to, what you may do, who you report
-- to. The custom access token hook reads THIS table to stamp org_id and
-- user_role into every JWT, which is what makes the policies in the next
-- migration a constant-time claim lookup instead of a per-row subquery.
-- ---------------------------------------------------------------------------
create table profiles (
  id         uuid primary key references auth.users on delete cascade,
  org_id     uuid not null references orgs on delete cascade,
  full_name  text not null,
  role       user_role not null default 'employee',
  -- Self-reference: managers see their direct reports' expenses.
  manager_id uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);
create index profiles_org_id_idx     on profiles (org_id);
create index profiles_manager_id_idx on profiles (manager_id);

-- ---------------------------------------------------------------------------
-- vendors
-- ---------------------------------------------------------------------------
create table vendors (
  id       uuid primary key default gen_random_uuid(),
  org_id   uuid not null references orgs on delete cascade,
  name     text not null,
  category text not null default 'general',
  -- Needed by the seed script's upsert, and a real invariant besides.
  unique (org_id, name)
);
create index vendors_org_id_idx on vendors (org_id);

-- ---------------------------------------------------------------------------
-- expenses — the table the entire demo turns on
--
-- Money is integer cents. Never float: 0.1 + 0.2 <> 0.3 is not a property you
-- want anywhere near an approval threshold.
-- ---------------------------------------------------------------------------
create table expenses (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs on delete cascade,
  submitter_id uuid not null references profiles on delete cascade,
  vendor_id    uuid references vendors on delete set null,
  amount_cents integer not null check (amount_cents > 0),
  currency     text not null default 'USD',
  spent_at     date not null,
  description  text not null default '',
  status       expense_status not null default 'draft',
  -- Path in the private `receipts` storage bucket: {org_id}/{expense_id}.{ext}
  receipt_path text,
  created_at   timestamptz not null default now()
);
create index expenses_org_status_idx  on expenses (org_id, status);
create index expenses_submitter_idx   on expenses (submitter_id);
-- Supports the structuring query: same submitter + vendor within a date window.
create index expenses_structuring_idx on expenses (org_id, vendor_id, submitter_id, spent_at);

-- ---------------------------------------------------------------------------
-- Row Level Security: ON, with no policies.
--
-- In Postgres, enabling RLS without policies denies everything to non-owner
-- roles. Queries succeed and return zero rows rather than erroring, which is
-- exactly the failure mode you want in a multi-tenant app: a missing policy
-- leaks nothing, it just shows nothing.
--
-- The table owner (postgres) and anything using the service_role key bypass
-- RLS entirely. That is why the service_role key never appears in agent code.
-- ---------------------------------------------------------------------------
alter table orgs     enable row level security;
alter table profiles enable row level security;
alter table vendors  enable row level security;
alter table expenses enable row level security;
