-- The custom access token hook, and every RLS policy in the app.
--
-- This migration is the security model. Read it as a whole: what it grants is
-- less interesting than what it withholds. See the note at the bottom.

-- ===========================================================================
-- PART 1 — The seam between Supabase Auth and Postgres RLS
--
-- GoTrue calls this function every time it mints or refreshes an access token.
-- It receives the pending token as jsonb, and whatever it returns is what gets
-- signed. We look the user up in `profiles` and stamp their org and role into
-- the claims.
--
-- Why bother, instead of having policies query `profiles` directly?
--   * Speed. A policy that subqueries `profiles` runs that subquery against
--     every candidate row. Reading a claim is a constant-time lookup on data
--     already in memory.
--   * Recursion. `profiles` itself has RLS. A policy on `expenses` that reads
--     `profiles` triggers `profiles`' own policies, which is how people end up
--     writing SECURITY DEFINER escape hatches.
--   * Legibility. `jwt_role() = 'finance'` fits on a slide.
--
-- The tradeoff, and it is a real one: claims are baked in at token-issue time.
-- Promote someone to finance and their existing token still says 'employee'
-- until it refreshes (Supabase refreshes hourly by default). For an expense
-- app that is fine. For something where instant revocation matters, you would
-- want the live lookup and would pay for it.
-- ===========================================================================
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims       jsonb;
  profile_org  uuid;
  profile_role text;
begin
  select p.org_id, p.role::text
    into profile_org, profile_role
  from public.profiles p
  where p.id = (event->>'user_id')::uuid;

  claims := coalesce(event->'claims', '{}'::jsonb);

  -- A signed-in auth.users row with no profile gets no claims. Every policy
  -- below then evaluates false and they see nothing. Failing closed is the
  -- correct behavior for an unprovisioned account.
  if profile_org is not null then
    claims := jsonb_set(claims, '{org_id}',    to_jsonb(profile_org::text));
    claims := jsonb_set(claims, '{user_role}', to_jsonb(profile_role));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- GoTrue runs as supabase_auth_admin, so it needs to execute the hook and read
-- the table the hook reads. Nobody else should be able to call it.
grant  execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
grant  select  on table    public.profiles                 to supabase_auth_admin;

-- supabase_auth_admin reads profiles from outside a user session, so it needs
-- its own policy — RLS applies to it like anyone else.
create policy profiles_select_auth_admin on public.profiles
  for select to supabase_auth_admin using (true);

-- ===========================================================================
-- PART 2 — Claim accessors
--
-- Marked STABLE so the planner can hoist them out of per-row evaluation, and
-- always called as `(select ...)` in the policies below, which forces Postgres
-- to evaluate them once per statement as an InitPlan rather than once per row.
-- On a large table that is the difference between one call and thousands.
-- ===========================================================================
create or replace function public.jwt_org_id()
returns uuid language sql stable
as $$ select nullif(auth.jwt() ->> 'org_id', '')::uuid $$;

create or replace function public.jwt_role()
returns text language sql stable
as $$ select auth.jwt() ->> 'user_role' $$;

-- ===========================================================================
-- PART 3 — Reference tables
-- ===========================================================================
create policy orgs_select_own on orgs
  for select to authenticated
  using (id = (select public.jwt_org_id()));

create policy profiles_select_org on profiles
  for select to authenticated
  using (org_id = (select public.jwt_org_id()));

create policy vendors_select_org on vendors
  for select to authenticated
  using (org_id = (select public.jwt_org_id()));

-- ===========================================================================
-- PART 4 — expenses: who can SEE what
--
-- Multiple SELECT policies are OR'd together. Each describes one way to be
-- allowed to see a row; a row is visible if any of them matches.
-- ===========================================================================

-- Everyone sees their own expenses.
create policy expenses_select_own on expenses
  for select to authenticated
  using (submitter_id = (select auth.uid()));

-- Managers see their direct reports'. This one does need a subquery, because
-- the reporting line lives in `profiles` and cannot be a claim — it is about
-- other people, not the token holder.
create policy expenses_select_reports on expenses
  for select to authenticated
  using (
    (select public.jwt_role()) = 'manager'
    and exists (
      select 1 from profiles p
      where p.id = expenses.submitter_id
        and p.manager_id = (select auth.uid())
    )
  );

-- Finance sees the whole org.
create policy expenses_select_finance on expenses
  for select to authenticated
  using (
    (select public.jwt_role()) = 'finance'
    and org_id = (select public.jwt_org_id())
  );

-- The agent sees the whole org. Identical in shape to the finance policy:
-- the agent is a peer principal, not a privileged one.
create policy expenses_select_agent on expenses
  for select to authenticated
  using (
    (select public.jwt_role()) = 'agent'
    and org_id = (select public.jwt_org_id())
  );

-- ===========================================================================
-- PART 5 — expenses: who can WRITE what
--
-- USING filters which existing rows a statement may touch.
-- WITH CHECK validates the row as it will exist afterward.
-- An UPDATE policy needs both, or you can read a row you may not write, or
-- write it into a shape you would not have been allowed to create.
-- ===========================================================================

create policy expenses_insert_own on expenses
  for insert to authenticated
  with check (
    submitter_id = (select auth.uid())
    and org_id   = (select public.jwt_org_id())
  );

-- Submitters may edit only while the expense is still a draft, and WITH CHECK
-- keeps them from editing it into someone else's name. Draft -> submitted is
-- permitted: that is how an expense enters the queue.
create policy expenses_update_own_draft on expenses
  for update to authenticated
  using      (submitter_id = (select auth.uid()) and status = 'draft')
  with check (submitter_id = (select auth.uid()) and status in ('draft', 'submitted'));

-- Only human approvers may move an expense's status.
create policy expenses_update_approver on expenses
  for update to authenticated
  using (
    (select public.jwt_role()) in ('manager', 'finance')
    and org_id = (select public.jwt_org_id())
  )
  with check (org_id = (select public.jwt_org_id()));

-- ===========================================================================
-- NOTE THE ABSENCE.
--
-- Scan every FOR UPDATE policy above. None of them admits jwt_role() = 'agent'.
--
-- The agent can read every expense in its org and cannot change a single one.
-- Not because the system prompt asks it not to. Not because a tool refuses.
-- Because there is no grant, and Postgres does not need to be persuaded.
--
-- If a future migration adds an UPDATE policy covering the agent, this demo
-- stops being true. supabase/tests/rls.test.sql asserts it stays false.
-- ===========================================================================
