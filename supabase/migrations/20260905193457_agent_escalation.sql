-- Let the agent escalate — and only escalate.
--
-- Until now the agent had no UPDATE policy on expenses at all, which was too
-- blunt. Flagging an expense for human attention is the agent's job;
-- *deciding* it is not. This grants exactly one state transition:
--
--     submitted  ->  needs_review
--
-- and nothing else. The demo's central claim is untouched: no policy here
-- permits 'approved', and supabase/tests/rls.test.sql still asserts that the
-- agent cannot approve.
--
-- TWO MECHANISMS, TWO QUESTIONS
--
-- The policy answers "who, and which transition". Its USING clause restricts
-- which rows may be touched (only ones currently `submitted`); its WITH CHECK
-- restricts what they may become (only `needs_review`).
--
-- But WITH CHECK only constrains what it mentions. A policy alone would allow
--     update expenses set status='needs_review', amount_cents = 1 where ...
-- because the resulting row still satisfies the status predicate. So the
-- trigger answers the second question — "what may change" — by rejecting any
-- agent update that alters a column other than status.
--
-- Same division of labour as the approval threshold in
-- 20260905180028_threshold_trigger.sql: RLS decides access, triggers decide
-- values, and triggers can explain themselves.

create policy expenses_escalate_agent on expenses
  for update to authenticated
  using (
    (select public.jwt_role()) = 'agent'
    and org_id = (select public.jwt_org_id())
    and status = 'submitted'
  )
  with check (
    (select public.jwt_role()) = 'agent'
    and org_id = (select public.jwt_org_id())
    and status = 'needs_review'
  );

create or replace function public.restrict_agent_expense_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.jwt_role() is distinct from 'agent' then
    return new;
  end if;

  -- Columns are enumerated explicitly rather than compared as whole rows, so
  -- that adding a column to `expenses` later fails loudly here instead of
  -- silently widening what the agent may rewrite.
  if new.org_id        is distinct from old.org_id
     or new.submitter_id is distinct from old.submitter_id
     or new.vendor_id    is distinct from old.vendor_id
     or new.amount_cents is distinct from old.amount_cents
     or new.currency     is distinct from old.currency
     or new.spent_at     is distinct from old.spent_at
     or new.description  is distinct from old.description
     or new.receipt_path is distinct from old.receipt_path
     or new.created_at   is distinct from old.created_at
  then
    raise exception
      'The agent may change an expense''s status and nothing else.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger restrict_agent_expense_writes
  before update on public.expenses
  for each row execute function public.restrict_agent_expense_writes();
