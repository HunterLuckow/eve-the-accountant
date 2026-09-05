-- Manager approval limit.
--
-- WHY THIS IS A TRIGGER AND NOT A POLICY
--
-- RLS answers "may this principal write this row?" It is about identity and
-- ownership, and its vocabulary is visibility: a row either is or is not in
-- your set. It is deliberately silent — a policy that rejects a write reports
-- zero rows affected, with no reason.
--
-- "Is $4,000 too much for a manager to approve?" is a different question. It
-- is about the value, not the principal, and the answer needs to be *spoken*:
-- the reviewer has to learn that this one routes to finance, not just watch a
-- button do nothing.
--
-- So: RLS decides who may write. A trigger decides what value is acceptable
-- and says so out loud. Cramming the limit into expenses_update_approver would
-- have worked and produced a UI that fails in silence.

create or replace function public.enforce_approval_threshold()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  limit_cents integer;
  actor_role  text;
begin
  -- Only guard the moment of approval. Any other edit passes through.
  if new.status <> 'approved' or old.status is not distinct from 'approved' then
    return new;
  end if;

  actor_role := public.jwt_role();

  -- Finance approves at any amount. So does anything running outside a user
  -- session (the seed script, a migration), where jwt_role() is null.
  if actor_role is distinct from 'manager' then
    return new;
  end if;

  select o.threshold_cents into limit_cents
  from public.orgs o
  where o.id = new.org_id;

  -- FAIL CLOSED.
  --
  -- This SELECT runs as the calling user, so RLS applies to it. If the org row
  -- is unreadable for any reason, limit_cents is NULL — and the naive form of
  -- the check below, `new.amount_cents > limit_cents`, would evaluate to NULL,
  -- which is not TRUE, so the IF would not fire and the approval would be
  -- allowed. A permission problem would silently become an unlimited approval
  -- limit. Refuse instead.
  if limit_cents is null then
    raise exception
      'Cannot verify the approval limit for this organization. Approval refused.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.amount_cents > limit_cents then
    raise exception
      'Manager approval limit is $%, this expense is $%. Route it to finance.',
      to_char(limit_cents   / 100.0, 'FM999,999,990.00'),
      to_char(new.amount_cents / 100.0, 'FM999,999,990.00')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger enforce_approval_threshold
  before update on public.expenses
  for each row execute function public.enforce_approval_threshold();
