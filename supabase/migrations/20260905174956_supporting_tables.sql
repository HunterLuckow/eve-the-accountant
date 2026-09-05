-- Supporting tables: what the agent produces, and what humans decide.
--
-- The previous migration defined what the agent may READ. This one defines
-- what it may WRITE, and the answer is deliberately narrow: findings and
-- narration. Not decisions.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type flag_kind as enum (
  'over_threshold',
  'structuring',       -- the demo: charges split to stay under a limit
  'duplicate',
  'missing_receipt',
  'policy_violation'
);

create type flag_severity as enum ('info', 'warn', 'critical');

-- Findings are attributed. The agent's rows sit in the same table as a human
-- reviewer's, distinguished by a column rather than by living somewhere else.
create type actor_kind as enum ('agent', 'human');

-- ---------------------------------------------------------------------------
-- receipt_extractions — what the model read off a receipt image
--
-- Separate from `expenses` because it is a claim about the world made by a
-- fallible reader, not a fact about the expense. Keeping it apart means you
-- can compare `expenses.amount_cents` against `receipt_extractions.total_cents`
-- and notice they disagree.
-- ---------------------------------------------------------------------------
create table receipt_extractions (
  expense_id   uuid primary key references expenses on delete cascade,
  org_id       uuid not null references orgs on delete cascade,
  merchant     text,
  total_cents  integer,
  spent_at     date,
  line_items   jsonb not null default '[]'::jsonb,
  confidence   numeric(3,2),
  extracted_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- expense_flags — findings
--
-- One finding can cover several expenses: a structuring pattern is a statement
-- about a *set* of charges, so flag_expense writes one row per expense sharing
-- the same rationale and evidence.
-- ---------------------------------------------------------------------------
create table expense_flags (
  id         uuid primary key default gen_random_uuid(),
  expense_id uuid not null references expenses on delete cascade,
  org_id     uuid not null references orgs on delete cascade,
  kind       flag_kind not null,
  severity   flag_severity not null default 'warn',
  rationale  text not null,
  evidence   jsonb not null default '{}'::jsonb,
  created_by actor_kind not null default 'agent',
  created_at timestamptz not null default now()
);
create index expense_flags_expense_idx on expense_flags (expense_id);
create index expense_flags_org_idx     on expense_flags (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- approvals — the audit trail of human decisions
--
-- The agent has no policy on this table at all. Not a narrow one. None.
-- ---------------------------------------------------------------------------
create table approvals (
  id          uuid primary key default gen_random_uuid(),
  expense_id  uuid not null references expenses on delete cascade,
  org_id      uuid not null references orgs on delete cascade,
  approver_id uuid not null references profiles on delete cascade,
  decision    expense_status not null,
  note        text not null default '',
  decided_at  timestamptz not null default now()
);
create index approvals_expense_idx on approvals (expense_id);

-- ---------------------------------------------------------------------------
-- agent_steps — the agent's work, narrated
--
-- Written by agent/hooks/steps.ts, which subscribes to eve's runtime event
-- stream. The model is never asked to "log a step" — the hook mirrors what the
-- runtime actually did, so this table cannot drift from reality the way a
-- model-authored log can.
--
-- id is TEXT, not uuid, because it stores eve's `event.meta.id` verbatim.
-- Using the runtime's own id as the primary key makes the insert idempotent:
-- a retried turn re-emits events, and ON CONFLICT DO NOTHING absorbs them.
-- ---------------------------------------------------------------------------
create table agent_steps (
  id         text primary key,
  session_id text not null,
  org_id     uuid not null references orgs on delete cascade,
  expense_id uuid references expenses on delete cascade,
  event_type text not null,
  title      text not null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index agent_steps_expense_idx on agent_steps (expense_id, created_at);
create index agent_steps_session_idx on agent_steps (session_id, created_at);

alter table receipt_extractions enable row level security;
alter table expense_flags       enable row level security;
alter table approvals           enable row level security;
alter table agent_steps         enable row level security;

-- ===========================================================================
-- READ policies — visibility is INHERITED from the parent expense
--
-- `exists (select 1 from expenses e where e.id = expense_id)` looks like it
-- checks existence. It does more than that: the subquery runs as the current
-- user, so `expenses`' own RLS applies inside it. If you cannot see the
-- expense, the subquery finds nothing and the flag is invisible too.
--
-- That means the four-way visibility rule — own / reports / finance / agent —
-- is written once, on `expenses`, and every child table inherits it. Change
-- who can see an expense and flag visibility follows automatically, with no
-- second place to forget.
--
-- The cost is a subquery per row rather than a claim comparison. At this scale
-- that is not worth optimizing; correctness in one place is worth more.
-- ===========================================================================
create policy extractions_select on receipt_extractions
  for select to authenticated
  using (exists (select 1 from expenses e where e.id = receipt_extractions.expense_id));

create policy flags_select on expense_flags
  for select to authenticated
  using (exists (select 1 from expenses e where e.id = expense_flags.expense_id));

create policy approvals_select on approvals
  for select to authenticated
  using (exists (select 1 from expenses e where e.id = approvals.expense_id));

-- agent_steps inherits too. An org-wide policy here would leak: an employee
-- would learn that the agent is investigating a colleague's expense even
-- though the expense itself is hidden from them. Steps with no expense_id are
-- session-level bookkeeping and stay org-scoped.
create policy steps_select on agent_steps
  for select to authenticated
  using (
    org_id = (select public.jwt_org_id())
    and (
      expense_id is null
      or exists (select 1 from expenses e where e.id = agent_steps.expense_id)
    )
  );

-- ===========================================================================
-- WRITE policies — the agent's entire write surface
--
-- Three tables, insert-only (plus an update on its own extractions so a
-- re-read can correct itself). Compare against what it CANNOT write:
--   expenses.status  — no policy
--   approvals        — no policy
--   profiles / orgs  — no policy
--
-- It can say "this looks like structuring." It cannot say "approved."
-- ===========================================================================
create policy flags_insert_agent on expense_flags
  for insert to authenticated
  with check (
    (select public.jwt_role()) = 'agent'
    and org_id = (select public.jwt_org_id())
  );

create policy extractions_insert_agent on receipt_extractions
  for insert to authenticated
  with check (
    (select public.jwt_role()) = 'agent'
    and org_id = (select public.jwt_org_id())
  );

create policy extractions_update_agent on receipt_extractions
  for update to authenticated
  using      ((select public.jwt_role()) = 'agent' and org_id = (select public.jwt_org_id()))
  with check ((select public.jwt_role()) = 'agent' and org_id = (select public.jwt_org_id()));

create policy steps_insert_agent on agent_steps
  for insert to authenticated
  with check (
    (select public.jwt_role()) = 'agent'
    and org_id = (select public.jwt_org_id())
  );

-- Humans record their own decisions, and only their own: approver_id must be
-- the caller, so nobody can log an approval in someone else's name.
create policy approvals_insert_approver on approvals
  for insert to authenticated
  with check (
    (select public.jwt_role()) in ('manager', 'finance')
    and approver_id = (select auth.uid())
    and org_id      = (select public.jwt_org_id())
  );

-- ===========================================================================
-- Realtime
--
-- Adding a table to this publication is what makes postgres_changes events
-- flow. Realtime applies the subscriber's RLS to each change before delivering
-- it, so the same policies above govern the websocket. A user cannot subscribe
-- their way around a policy.
--
-- agent_steps drives the live timeline; expenses drives the status flip when
-- an approval lands.
-- ===========================================================================
alter publication supabase_realtime add table agent_steps;
alter publication supabase_realtime add table expenses;
