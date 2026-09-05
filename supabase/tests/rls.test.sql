-- RLS test suite.
--
-- Every assertion here is a claim the conference demo makes out loud. Tests 5
-- and 6 are the ones the whole talk rests on: the agent cannot approve an
-- expense. If they ever pass when they should fail, the demo is a lie.
--
--   pnpm test:rls
--
-- The whole file runs in one transaction and rolls back, so it is safe against
-- the live project and leaves nothing behind — including pgTAP itself, which
-- is created inside the transaction and disappears with it.
--
-- TWO IMPLEMENTATION CONSTRAINTS, both learned the hard way:
--
-- 1. Role switching is INLINE, never wrapped in a helper function. `SET LOCAL
--    ROLE` inside a plpgsql function is reverted when that function exits, so
--    a helper would appear to work and silently run every assertion as the
--    table owner — who bypasses RLS. The tests would all pass and prove
--    nothing.
--
-- 2. Results accumulate in a temp table and are selected once at the end,
--    because `supabase db query` returns only the LAST result set. One
--    `select is(...)` per statement would discard all but the final assertion.
--
-- Fixtures use fixed UUIDs rather than reading seeded data, so this suite is
-- independent of whatever `pnpm seed` produced.

begin;

create extension if not exists pgtap;

create temp table tap (seq int primary key, line text);
grant all on tap to public;

-- Postgres requires a data-modifying CTE to sit at the TOP level of a
-- statement — it cannot be nested inside a subquery, which is exactly what
-- `select is((with attempt as (update ...) ...))` would do. So the UPDATEs run
-- as top-level statements that stash their row count here, and the assertion
-- reads it back.
create temp table probe (name text primary key, n int);
grant all on probe to public;

-- ===========================================================================
-- Fixtures — two tenants, five principals, four expenses.
-- Inserted as the table owner, before any role switching.
-- ===========================================================================
insert into orgs (id, name, threshold_cents) values
  ('11111111-1111-1111-1111-111111111111', 'TEST Org A', 400000),
  ('22222222-2222-2222-2222-222222222222', 'TEST Org B', 400000);

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'test-emp-a@example.test'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'test-mgr-a@example.test'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'test-fin-a@example.test'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'test-agent-a@example.test'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'test-emp-b@example.test');

insert into profiles (id, org_id, full_name, role, manager_id) values
  ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Mgr A','manager', null),
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Emp A','employee','aaaaaaaa-0000-0000-0000-000000000002'),
  ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Fin A','finance', null),
  ('aaaaaaaa-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','Agent','agent',   null),
  ('bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Emp B','employee',null);

insert into expenses (id, org_id, submitter_id, amount_cents, spent_at, status, description) values
  ('cccccccc-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001', 50000, current_date,'submitted','A/emp one'),
  ('cccccccc-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001', 90000, current_date,'submitted','A/emp two'),
  ('cccccccc-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000003', 70000, current_date,'submitted','A/fin'),
  -- A DRAFT owned by the employee. Required by the self-approval regression
  -- test: expenses_update_own_draft's USING clause only matches `draft`, so
  -- without this row the escalation path is unreachable and the test would
  -- pass vacuously.
  ('cccccccc-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001', 30000, current_date,'draft','A/emp draft'),
  ('dddddddd-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','bbbbbbbb-0000-0000-0000-000000000001', 90000, current_date,'submitted','B/emp');

insert into tap values (0, (select plan(16)));

-- ===========================================================================
-- EMPLOYEE — sees only their own
--
-- set_config(..., true) publishes the claims exactly as PostgREST does after
-- verifying a JWT, and `set local role authenticated` is the SET ROLE it
-- performs. Together they reproduce a real request.
-- ===========================================================================
select set_config('request.jwt.claims', json_build_object(
  'sub','aaaaaaaa-0000-0000-0000-000000000001','role','authenticated',
  'org_id','11111111-1111-1111-1111-111111111111','user_role','employee')::text, true);
set local role authenticated;

insert into tap values (1, (select is(
  (select count(*) from expenses)::int, 3,
  'employee sees only their own expenses')));

insert into tap values (2, (select is(
  (select count(*) from expenses where submitter_id <> 'aaaaaaaa-0000-0000-0000-000000000001')::int, 0,
  'employee sees nobody else''s, even in their own org')));

-- REGRESSION TEST for the privilege escalation fixed in
-- 20260905193814_fix_with_check_privilege_escalation.sql.
--
-- An employee reaches their own row through expenses_update_own_draft's USING
-- clause. Before the fix they could then satisfy expenses_update_approver's
-- WITH CHECK — which only asked about org_id — and set status to 'approved'.
-- Two policies, neither wrong alone, combining into a self-approval grant.
--
-- This suite had 12 green assertions and did not catch it, because none of
-- them asked whether a NON-approver could approve. Absence of a test is not
-- evidence of absence of a hole.
insert into tap values (14, (select throws_ok($$
  update expenses set status = 'approved'
  where id = 'cccccccc-0000-0000-0000-000000000004'
$$, '42501', null,
  'employee CANNOT self-approve (WITH CHECK escalation)')));

reset role;

-- ===========================================================================
-- MANAGER — sees direct reports
-- ===========================================================================
select set_config('request.jwt.claims', json_build_object(
  'sub','aaaaaaaa-0000-0000-0000-000000000002','role','authenticated',
  'org_id','11111111-1111-1111-1111-111111111111','user_role','manager')::text, true);
set local role authenticated;

insert into tap values (3, (select is(
  (select count(*) from expenses)::int, 3,
  'manager sees their direct reports'' expenses')));

reset role;

-- ===========================================================================
-- FINANCE — sees the whole org
-- ===========================================================================
select set_config('request.jwt.claims', json_build_object(
  'sub','aaaaaaaa-0000-0000-0000-000000000003','role','authenticated',
  'org_id','11111111-1111-1111-1111-111111111111','user_role','finance')::text, true);
set local role authenticated;

insert into tap values (4, (select is(
  (select count(*) from expenses)::int, 4,
  'finance sees every expense in their org')));

insert into tap values (5, (select is(
  (select count(*) from expenses where org_id = '22222222-2222-2222-2222-222222222222')::int, 0,
  'finance in org A cannot see org B at all')));

reset role;

-- ===========================================================================
-- AGENT — the heart of the demo
-- ===========================================================================
select set_config('request.jwt.claims', json_build_object(
  'sub','aaaaaaaa-0000-0000-0000-000000000004','role','authenticated',
  'org_id','11111111-1111-1111-1111-111111111111','user_role','agent')::text, true);
set local role authenticated;

insert into tap values (6, (select is(
  (select count(*) from expenses)::int, 4,
  'agent sees every expense in its org, same as finance')));

-- THE ASSERTION THE TALK RESTS ON.
-- The agent can see all three. It tries to approve all three. No UPDATE policy
-- admits an agent principal, so the statement matches zero rows: no error,
-- nothing changed.
-- Note the shape of this assertion, and why it changed.
--
-- Before the agent had any UPDATE policy, this statement matched zero rows and
-- returned silently. Now that expenses_escalate_agent gives it a USING clause
-- matching `submitted` rows, the statement REACHES the WITH CHECK stage and is
-- refused outright with 42501.
--
-- Silence became an explicit refusal, which is the stronger outcome — but a
-- test written for the old shape (`is(count, 0)`) would now abort the whole
-- transaction rather than fail cleanly.
insert into tap values (7, (select throws_ok($$
  update expenses set status = 'approved'
  where org_id = '11111111-1111-1111-1111-111111111111'
$$, '42501', null,
  'AGENT CANNOT APPROVE — refused by WITH CHECK')));

insert into tap values (8, (select is(
  (select count(*) from expenses where status = 'approved')::int, 0,
  'AGENT CANNOT APPROVE — no expense actually changed status')));

-- Read broad, write narrow: it can record what it found.
insert into tap values (9, (select lives_ok($$
  insert into expense_flags (expense_id, org_id, kind, severity, rationale)
  values ('cccccccc-0000-0000-0000-000000000001',
          '11111111-1111-1111-1111-111111111111',
          'structuring', 'critical', 'three charges under the threshold')
$$, 'agent CAN record a finding')));

-- It has no policy on approvals at all.
insert into tap values (10, (select throws_ok($$
  insert into approvals (expense_id, org_id, approver_id, decision)
  values ('cccccccc-0000-0000-0000-000000000001',
          '11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-0000-0000-0000-000000000004', 'approved')
$$, '42501', null,
   'agent cannot write an approval record')));

-- ---------------------------------------------------------------------------
-- ESCALATION — the one write the agent has on expenses.
--
-- expenses_escalate_agent grants exactly submitted -> needs_review. The
-- trigger restrict_agent_expense_writes stops the agent riding that legitimate
-- transition to rewrite other columns, which the policy's WITH CHECK alone
-- would permit because it only constrains `status`.
-- ---------------------------------------------------------------------------
insert into tap values (15, (select throws_ok($$
  update expenses set status = 'needs_review', amount_cents = 1
  where id = 'cccccccc-0000-0000-0000-000000000002'
$$, '42501', null,
  'agent CANNOT alter amount while escalating')));

with attempt as (
  update expenses set status = 'needs_review'
  where id = 'cccccccc-0000-0000-0000-000000000002'
  returning 1
)
insert into probe select 'agent_escalate', count(*)::int from attempt;

insert into tap values (16, (select is(
  (select n from probe where name = 'agent_escalate'), 1,
  'agent CAN escalate submitted -> needs_review')));

with attempt as (
  update expenses set status = 'submitted'
  where id = 'cccccccc-0000-0000-0000-000000000002'
  returning 1
)
insert into probe select 'agent_unescalate', count(*)::int from attempt;

insert into tap values (17, (select is(
  (select n from probe where name = 'agent_unescalate'), 0,
  'agent CANNOT un-escalate — the grant is one-directional')));

reset role;

-- ===========================================================================
-- FINANCE CAN do what the agent cannot — the control for test 7
-- ===========================================================================
select set_config('request.jwt.claims', json_build_object(
  'sub','aaaaaaaa-0000-0000-0000-000000000003','role','authenticated',
  'org_id','11111111-1111-1111-1111-111111111111','user_role','finance')::text, true);
set local role authenticated;

with attempt as (
  update expenses set status = 'approved'
  where id = 'cccccccc-0000-0000-0000-000000000001'
  returning 1
)
insert into probe select 'finance_update', count(*)::int from attempt;

insert into tap values (11, (select is(
  (select n from probe where name = 'finance_update'), 1,
  'finance CAN approve — same statement, different principal')));

reset role;

-- ===========================================================================
-- ANON
-- ===========================================================================
select set_config('request.jwt.claims', '', true);
set local role anon;

insert into tap values (12, (select is(
  (select count(*) from expenses)::int, 0,
  'anon sees nothing')));

reset role;

insert into tap values (13, (select f from finish() f));

-- Only the LAST result set is returned by `supabase db query`, so this is it.
select line from tap where line is not null order by seq;

rollback;
