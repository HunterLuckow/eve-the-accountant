-- SECURITY FIX: privilege escalation through a permissive WITH CHECK.
--
-- Introduced in 20260905173424_auth_hook_and_policies.sql. Found by
-- scripts/check-agent.ts, which reported "CANNOT approve any expense —
-- 1 rows changed".
--
-- THE BUG
--
-- expenses_update_approver was written as:
--
--     using      (jwt_role() in ('manager','finance') and org_id = jwt_org_id())
--     with check (org_id = jwt_org_id())      -- <- no role check
--
-- On its own that looks harmless: only managers and finance can reach a row
-- through the USING clause, so who else could the WITH CHECK apply to?
--
-- The answer is everyone, because Postgres evaluates the USING clauses of all
-- applicable policies as one OR, and the WITH CHECK clauses as a SEPARATE OR.
-- They are not paired. A caller who reaches a row through ANY policy's USING
-- may write it into any shape permitted by ANY policy's WITH CHECK.
--
-- So an employee reaching their own draft via expenses_update_own_draft could
-- satisfy expenses_update_approver's WITH CHECK — which only asked about
-- org_id — and set status to 'approved'. Verified against the live database:
-- an employee self-approved their own expense.
--
-- The same hole let the agent approve, once 20260905193457_agent_escalation.sql
-- gave it a USING clause matching submitted rows. Before that migration the
-- bug was unreachable for the agent, which is why it went unnoticed.
--
-- THE RULE
--
-- Every policy's WITH CHECK must be independently sufficient. Never rely on a
-- sibling policy's USING clause to constrain who reaches it. Write each WITH
-- CHECK as though it were the only one on the table.

drop policy expenses_update_approver on expenses;

create policy expenses_update_approver on expenses
  for update to authenticated
  using (
    (select public.jwt_role()) in ('manager', 'finance')
    and org_id = (select public.jwt_org_id())
  )
  with check (
    -- The role assertion this policy was missing.
    (select public.jwt_role()) in ('manager', 'finance')
    and org_id = (select public.jwt_org_id())
  );

-- Repair rows approved through the hole while it was open. Anything approved
-- with no corresponding `approvals` audit row was not approved by a human.
update expenses e
   set status = 'submitted'
 where e.status = 'approved'
   and not exists (select 1 from approvals a where a.expense_id = e.id)
   and e.description like 'Meridian Consulting — Phase%';
