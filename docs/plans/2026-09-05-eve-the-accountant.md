# eve-the-accountant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A multi-tenant expense-approvals app where an eve agent works the review queue as a first-class Supabase RLS principal — able to investigate and flag, structurally unable to approve.

**Architecture:** One Vercel project (Next.js App Router + `withEve()`), one Supabase project. The agent authenticates as a real Supabase user whose JWT carries `org_id` and `user_role: 'agent'` claims, so every query it makes is RLS-enforced exactly like a human's. A Database Webhook on `expenses` starts sessions; an eve hook mirrors runtime events into `agent_steps`, which Realtime broadcasts to the UI.

**Tech Stack:** Next.js 15 (App Router, TypeScript), pnpm, eve, Supabase (Postgres, Auth, Storage, Realtime, Database Webhooks), `@supabase/ssr`, `@supabase/supabase-js`, pgTAP, Vercel AI Gateway.

## Global Constraints

- Package manager: **pnpm**. Never `npm install`.
- Model string: **`anthropic/claude-opus-5`**, resolved through Vercel AI Gateway. Do not add a date suffix.
- The agent **never** uses the Supabase service role key. Service role bypasses RLS and voids the project's entire thesis. The only service-role usage permitted anywhere is the seed script (`scripts/seed.ts`) and creating auth users.
- Every table with tenant data carries `org_id uuid not null`.
- Every table has `alter table ... enable row level security;` in the same migration that creates it. No exceptions.
- Migrations live in `supabase/migrations/` and are applied with `supabase db push`. Never edit an applied migration — add a new one.
- All money is `integer` cents. Never floats.
- Commit after every task.
- eve is beta. Where this plan's eve API usage disagrees with the installed package's types, **the installed package wins** — Task 1 Step 6 establishes how to check.

### Spec refinement (supersedes spec §4)

The spec proposed a `current_profile()` `security definer` helper for RLS. This plan instead injects `org_id` and `user_role` into the JWT via a **Supabase custom access token hook**. Reason: policies that read `auth.jwt()` are a constant-time claim lookup, while policies that subquery `profiles` run per-row and need a `security definer` escape hatch to avoid recursive RLS. The claims approach is the pattern Supabase recommends for RBAC, it is faster, and the policies are shorter on a slide. `profiles` remains the source of truth; the hook reads from it at token-issue time.

---

## File Structure

```
eve-the-accountant/
├── agent/
│   ├── agent.ts                     defineAgent config
│   ├── instructions.md              system prompt
│   ├── channels/eve.ts              auth policy (Supabase JWT + machine token)
│   ├── connections/supabase.ts      Supabase MCP (shown on stage, not hot path)
│   ├── hooks/steps.ts               runtime events → agent_steps
│   ├── skills/
│   │   ├── expense-policy.md        the money slide
│   │   └── structuring-detection.md
│   ├── tools/
│   │   ├── get_expense.ts
│   │   ├── find_related_expenses.ts
│   │   ├── read_receipt.ts
│   │   ├── flag_expense.ts
│   │   └── request_human_review.ts  approval-gated
│   └── lib/agent-db.ts              agent's RLS-bound Supabase client
├── app/
│   ├── layout.tsx, globals.css
│   ├── login/page.tsx, actions.ts
│   ├── inbox/page.tsx
│   ├── review/page.tsx
│   ├── expense/[id]/page.tsx
│   ├── api/hooks/expense-submitted/route.ts
│   └── api/approvals/[requestId]/route.ts
├── components/
│   ├── expense-table.tsx
│   ├── receipt-viewer.tsx
│   ├── agent-timeline.tsx           Realtime on agent_steps
│   └── approval-panel.tsx
├── lib/
│   ├── supabase/client.ts           browser client
│   ├── supabase/server.ts           server client (cookies)
│   └── types.ts                     shared row types
├── scripts/
│   ├── seed.ts
│   └── reset.ts
├── supabase/
│   ├── migrations/*.sql
│   └── tests/rls.test.sql           pgTAP
└── docs/{specs,plans}/
```

---

## Task 1: Scaffold project and verify eve's API surface

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `.env.local.example`, `app/layout.tsx`, `app/globals.css`, `agent/agent.ts`, `agent/instructions.md`
- Create: `docs/eve-api-notes.md`

**Interfaces:**
- Produces: a running dev server on `:3000` with `/eve/v1/session` reachable; `docs/eve-api-notes.md` recording the installed eve version and the exact names of the APIs later tasks depend on.

- [ ] **Step 1: Scaffold Next.js into the existing repo**

```bash
cd ~/Desktop/eve-the-accountant
pnpm create next-app@latest . --typescript --app --tailwind --eslint --src-dir=false --import-alias="@/*" --use-pnpm --turbopack --yes
```

If it refuses because the directory is non-empty, scaffold to a temp dir and move files in:

```bash
pnpm create next-app@latest /tmp/eta --typescript --app --tailwind --eslint --src-dir=false --import-alias="@/*" --use-pnpm --turbopack --yes
rsync -a --exclude .git /tmp/eta/ ~/Desktop/eve-the-accountant/ && rm -rf /tmp/eta
```

- [ ] **Step 2: Add eve and Supabase dependencies**

```bash
pnpm add eve @supabase/supabase-js @supabase/ssr
pnpm add -D supabase tsx
```

- [ ] **Step 3: Wire `withEve` into the Next.js config**

`next.config.ts`:

```ts
import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {};

export default withEve(nextConfig);
```

- [ ] **Step 4: Create the minimal agent**

`agent/agent.ts`:

```ts
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5",
  reasoning: "medium",
  limits: {
    maxTokenCostUsdPerSession: 1.5,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1000,
  },
});
```

`agent/instructions.md`:

```md
You are an expense review assistant. You investigate submitted expenses and
report what you find. You do not approve or reject anything — a human does that.
Be concise and factual.
```

- [ ] **Step 5: Verify the dev server boots and a session runs**

```bash
pnpm dev
```

In a second terminal:

```bash
curl -sS -X POST http://127.0.0.1:3000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Say the word ready and nothing else."}'
```

Expected: JSON containing a `continuationToken`, and an `x-eve-session-id` response header. If this fails with an auth error, note it — Task 13 configures the channel auth policy properly and local dev may need `localDev()`.

- [ ] **Step 6: Record the installed API surface**

This plan was written against eve's public docs during beta. Confirm the names before later tasks depend on them.

```bash
pnpm list eve
ls node_modules/eve/dist/*.d.ts 2>/dev/null || ls node_modules/eve
grep -rn "approval\|needsApproval" node_modules/eve/tools*.d.ts node_modules/eve/dist/tools*.d.ts 2>/dev/null | head -30
grep -rn "export declare" node_modules/eve/hooks*.d.ts node_modules/eve/dist/hooks*.d.ts 2>/dev/null | head -30
```

Write `docs/eve-api-notes.md` recording, verbatim from the installed types:

```md
# eve API notes

Installed version: <output of `pnpm list eve`>
Verified: 2026-09-05

| What this plan assumes | Actual in installed package |
|---|---|
| `defineTool` from `eve/tools` | |
| `approval: always()` from `eve/tools/approval` | |
| `ctx.session.auth.current` in tool execute | |
| `defineHook` from `eve/hooks`, `events` map | |
| `eveChannel` + auth helpers from `eve/channels/auth` | |
| `useEveAgent` from the React entrypoint | |
| Approval resolution shape (`inputResponses` keyed by `requestId`) | |

Deviations found and how this plan changed:
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: scaffold Next.js + eve, verify API surface"
```

---

## Task 2: Create the Supabase project and migration workflow

**Files:**
- Create: `supabase/config.toml` (via CLI), `.env.local`, `.env.local.example`

**Interfaces:**
- Produces: a linked Supabase project; `.env.local` holding `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; a working `supabase db push`.

- [ ] **Step 1: Create the project** *(manual — you do this in the dashboard)*

Go to https://supabase.com/dashboard, create a new project named `eve-the-accountant`. Pick a region near where you'll present. Save the database password in your password manager.

- [ ] **Step 2: Initialize and link the CLI**

```bash
cd ~/Desktop/eve-the-accountant
pnpm supabase init
pnpm supabase login
pnpm supabase link --project-ref <your-project-ref>
```

The project ref is in the dashboard URL: `supabase.com/dashboard/project/<ref>`.

- [ ] **Step 3: Write the env template**

`.env.local.example`:

```bash
# Supabase — from Dashboard → Project Settings → API
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=          # seed script + auth admin ONLY. Never in agent code.

# The agent's own Supabase login (created in Task 13)
AGENT_EMAIL=agent@eve-the-accountant.demo
AGENT_PASSWORD=

# Shared secret for the Database Webhook → session bootstrap route
WEBHOOK_SECRET=

# Vercel AI Gateway (local dev only; OIDC handles this on Vercel)
AI_GATEWAY_API_KEY=
```

- [ ] **Step 4: Fill in `.env.local`**

```bash
cp .env.local.example .env.local
openssl rand -hex 32   # paste as WEBHOOK_SECRET
openssl rand -hex 24   # paste as AGENT_PASSWORD
```

Copy the URL and keys from Dashboard → Project Settings → API into `.env.local`.

- [ ] **Step 5: Confirm `.env.local` is ignored**

```bash
git check-ignore -v .env.local
```

Expected: a line naming `.gitignore`. If it prints nothing, **stop** and add `.env.local` to `.gitignore` before continuing.

- [ ] **Step 6: Verify the connection**

```bash
pnpm supabase db push
```

Expected: "Remote database is up to date." (No migrations yet — this proves the link works.)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: link Supabase project, add env template"
```

---

## Task 3: Core schema

**Files:**
- Create: `supabase/migrations/20260905000100_core_schema.sql`
- Create: `lib/types.ts`

**Interfaces:**
- Produces: tables `orgs`, `profiles`, `vendors`, `expenses`; enums `user_role`, `expense_status`. Consumed by every later task.

- [ ] **Step 1: Write the migration**

`supabase/migrations/20260905000100_core_schema.sql`:

```sql
create type user_role as enum ('employee', 'manager', 'finance', 'agent');
create type expense_status as enum ('draft', 'submitted', 'needs_review', 'approved', 'rejected');

create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  threshold_cents integer not null default 400000,
  policy_version text not null default 'v1',
  created_at timestamptz not null default now()
);

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  org_id uuid not null references orgs on delete cascade,
  full_name text not null,
  role user_role not null default 'employee',
  manager_id uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);
create index on profiles (org_id);
create index on profiles (manager_id);

create table vendors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  name text not null,
  category text not null default 'general'
);
create index on vendors (org_id);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  submitter_id uuid not null references profiles on delete cascade,
  vendor_id uuid references vendors on delete set null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USD',
  spent_at date not null,
  description text not null default '',
  status expense_status not null default 'draft',
  receipt_path text,
  created_at timestamptz not null default now()
);
create index on expenses (org_id, status);
create index on expenses (submitter_id);
create index on expenses (org_id, vendor_id, spent_at);

alter table orgs     enable row level security;
alter table profiles enable row level security;
alter table vendors  enable row level security;
alter table expenses enable row level security;
```

Note there are no policies yet. RLS is on, so **everything is denied** until Task 4. That is the correct intermediate state.

- [ ] **Step 2: Apply it**

```bash
pnpm supabase db push
```

Expected: `Applying migration 20260905000100_core_schema.sql...` then success.

- [ ] **Step 3: Verify RLS is on for all four tables**

```bash
pnpm supabase db execute --query "select relname, relrowsecurity from pg_class where relname in ('orgs','profiles','vendors','expenses') order by relname;"
```

Expected: four rows, `relrowsecurity` = `t` for each.

- [ ] **Step 4: Write shared types**

`lib/types.ts`:

```ts
export type UserRole = "employee" | "manager" | "finance" | "agent";

export type ExpenseStatus =
  | "draft"
  | "submitted"
  | "needs_review"
  | "approved"
  | "rejected";

export type Expense = {
  id: string;
  org_id: string;
  submitter_id: string;
  vendor_id: string | null;
  amount_cents: number;
  currency: string;
  spent_at: string;
  description: string;
  status: ExpenseStatus;
  receipt_path: string | null;
  created_at: string;
};

export type Profile = {
  id: string;
  org_id: string;
  full_name: string;
  role: UserRole;
  manager_id: string | null;
};

export const dollars = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: core schema with RLS enabled"
```

---

## Task 4: JWT claims hook and expense RLS policies

This is the task the whole demo rests on. Take your time here.

**Files:**
- Create: `supabase/migrations/20260905000200_auth_hook_and_policies.sql`

**Interfaces:**
- Produces: `public.custom_access_token_hook(jsonb) returns jsonb` injecting `org_id` and `user_role` claims; SELECT/UPDATE policies on `expenses`; SELECT policies on `orgs`, `profiles`, `vendors`.
- Consumed by: every query in the app and the agent.

- [ ] **Step 1: Write the migration**

`supabase/migrations/20260905000200_auth_hook_and_policies.sql`:

```sql
-- ---------------------------------------------------------------
-- Custom access token hook: stamp org_id and user_role into the JWT.
-- Supabase calls this at token issue and refresh.
-- ---------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  p record;
begin
  select org_id, role into p
  from public.profiles
  where id = (event->>'user_id')::uuid;

  claims := coalesce(event->'claims', '{}'::jsonb);

  if p.org_id is not null then
    claims := jsonb_set(claims, '{org_id}',   to_jsonb(p.org_id::text));
    claims := jsonb_set(claims, '{user_role}', to_jsonb(p.role::text));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
grant select on table public.profiles to supabase_auth_admin;

-- Convenience accessors. STABLE so the planner hoists them out of row loops.
create or replace function public.jwt_org_id() returns uuid
language sql stable as $$ select nullif(auth.jwt() ->> 'org_id', '')::uuid $$;

create or replace function public.jwt_role() returns text
language sql stable as $$ select auth.jwt() ->> 'user_role' $$;

-- ---------------------------------------------------------------
-- Reference tables: anyone authenticated may read their own org.
-- ---------------------------------------------------------------
create policy orgs_select_own on orgs for select to authenticated
  using (id = public.jwt_org_id());

create policy profiles_select_org on profiles for select to authenticated
  using (org_id = public.jwt_org_id());

create policy vendors_select_org on vendors for select to authenticated
  using (org_id = public.jwt_org_id());

-- ---------------------------------------------------------------
-- expenses: SELECT
-- ---------------------------------------------------------------
create policy expenses_select_own on expenses for select to authenticated
  using (submitter_id = auth.uid());

create policy expenses_select_reports on expenses for select to authenticated
  using (
    public.jwt_role() = 'manager'
    and exists (
      select 1 from profiles p
      where p.id = expenses.submitter_id
        and p.manager_id = auth.uid()
    )
  );

create policy expenses_select_finance on expenses for select to authenticated
  using (public.jwt_role() = 'finance' and org_id = public.jwt_org_id());

-- The agent reads the whole org. Read-only, scoped by claim.
create policy expenses_select_agent on expenses for select to authenticated
  using (public.jwt_role() = 'agent' and org_id = public.jwt_org_id());

-- ---------------------------------------------------------------
-- expenses: INSERT / UPDATE
-- ---------------------------------------------------------------
create policy expenses_insert_own on expenses for insert to authenticated
  with check (
    submitter_id = auth.uid()
    and org_id = public.jwt_org_id()
  );

-- Submitters may edit only while the expense is still a draft.
create policy expenses_update_own_draft on expenses for update to authenticated
  using (submitter_id = auth.uid() and status = 'draft')
  with check (submitter_id = auth.uid());

-- Only human approvers may move status.
create policy expenses_update_approver on expenses for update to authenticated
  using (
    public.jwt_role() in ('manager', 'finance')
    and org_id = public.jwt_org_id()
  )
  with check (org_id = public.jwt_org_id());

-- ---------------------------------------------------------------
-- NOTE THE ABSENCE.
-- There is no UPDATE policy whose USING clause admits jwt_role() = 'agent'.
-- The agent can read every expense in its org and cannot change any of them.
-- This is not a prompt instruction. It is the absence of a grant.
-- ---------------------------------------------------------------
```

- [ ] **Step 2: Apply it**

```bash
pnpm supabase db push
```

- [ ] **Step 3: Enable the auth hook** *(manual — dashboard)*

Dashboard → Authentication → Hooks → **Customize Access Token (JWT) Claims**. Enable it and select the Postgres function `public.custom_access_token_hook`. Save.

This step is easy to forget and everything downstream silently breaks without it — the claims will be absent and every policy will evaluate false.

- [ ] **Step 4: Verify the policies landed**

```bash
pnpm supabase db execute --query "select tablename, policyname, cmd from pg_policies where schemaname='public' order by tablename, policyname;"
```

Expected: 10 rows. Confirm by eye that **no policy on `expenses` with `cmd = 'UPDATE'` mentions `agent`.**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: JWT claims hook and expense RLS policies

The agent principal has SELECT but deliberately no UPDATE on expenses."
```

---

## Task 5: Supporting tables

**Files:**
- Create: `supabase/migrations/20260905000300_supporting_tables.sql`
- Modify: `lib/types.ts`

**Interfaces:**
- Produces: `receipt_extractions`, `expense_flags`, `approvals`, `agent_steps` with policies. `agent_steps` and `expenses` are added to the Realtime publication.

- [ ] **Step 1: Write the migration**

`supabase/migrations/20260905000300_supporting_tables.sql`:

```sql
create type flag_kind as enum
  ('over_threshold','structuring','duplicate','missing_receipt','policy_violation');
create type flag_severity as enum ('info','warn','critical');
create type actor_kind as enum ('agent','human');

create table receipt_extractions (
  expense_id uuid primary key references expenses on delete cascade,
  org_id uuid not null references orgs on delete cascade,
  merchant text,
  total_cents integer,
  spent_at date,
  line_items jsonb not null default '[]'::jsonb,
  confidence numeric(3,2),
  extracted_at timestamptz not null default now()
);

create table expense_flags (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references expenses on delete cascade,
  org_id uuid not null references orgs on delete cascade,
  kind flag_kind not null,
  severity flag_severity not null default 'warn',
  rationale text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_by actor_kind not null default 'agent',
  created_at timestamptz not null default now()
);
create index on expense_flags (expense_id);
create index on expense_flags (org_id, created_at desc);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references expenses on delete cascade,
  org_id uuid not null references orgs on delete cascade,
  approver_id uuid not null references profiles on delete cascade,
  decision expense_status not null,
  note text not null default '',
  decided_at timestamptz not null default now()
);
create index on approvals (expense_id);

create table agent_steps (
  id text primary key,                 -- event.meta.id, for idempotency
  session_id text not null,
  org_id uuid not null references orgs on delete cascade,
  expense_id uuid references expenses on delete cascade,
  event_type text not null,
  title text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on agent_steps (expense_id, created_at);
create index on agent_steps (session_id, created_at);

alter table receipt_extractions enable row level security;
alter table expense_flags       enable row level security;
alter table approvals           enable row level security;
alter table agent_steps         enable row level security;

-- Visibility follows the parent expense. If you can see the expense,
-- you can see what the agent found on it.
create policy extractions_select on receipt_extractions for select to authenticated
  using (exists (select 1 from expenses e where e.id = expense_id));

create policy flags_select on expense_flags for select to authenticated
  using (exists (select 1 from expenses e where e.id = expense_id));

create policy approvals_select on approvals for select to authenticated
  using (exists (select 1 from expenses e where e.id = expense_id));

create policy steps_select on agent_steps for select to authenticated
  using (org_id = public.jwt_org_id());

-- The agent's write surface: findings and narration. Nothing else.
create policy flags_insert_agent on expense_flags for insert to authenticated
  with check (public.jwt_role() = 'agent' and org_id = public.jwt_org_id());

create policy extractions_upsert_agent on receipt_extractions for insert to authenticated
  with check (public.jwt_role() = 'agent' and org_id = public.jwt_org_id());

create policy extractions_update_agent on receipt_extractions for update to authenticated
  using (public.jwt_role() = 'agent' and org_id = public.jwt_org_id());

create policy steps_insert_agent on agent_steps for insert to authenticated
  with check (public.jwt_role() = 'agent' and org_id = public.jwt_org_id());

-- Humans record their own decisions.
create policy approvals_insert_approver on approvals for insert to authenticated
  with check (
    public.jwt_role() in ('manager','finance')
    and approver_id = auth.uid()
    and org_id = public.jwt_org_id()
  );

-- Realtime.
alter publication supabase_realtime add table agent_steps;
alter publication supabase_realtime add table expenses;
```

- [ ] **Step 2: Apply and verify**

```bash
pnpm supabase db push
pnpm supabase db execute --query "select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename;"
```

Expected: includes `agent_steps` and `expenses`.

- [ ] **Step 3: Extend shared types**

Append to `lib/types.ts`:

```ts
export type FlagKind =
  | "over_threshold"
  | "structuring"
  | "duplicate"
  | "missing_receipt"
  | "policy_violation";

export type ExpenseFlag = {
  id: string;
  expense_id: string;
  org_id: string;
  kind: FlagKind;
  severity: "info" | "warn" | "critical";
  rationale: string;
  evidence: Record<string, unknown>;
  created_by: "agent" | "human";
  created_at: string;
};

export type AgentStep = {
  id: string;
  session_id: string;
  org_id: string;
  expense_id: string | null;
  event_type: string;
  title: string;
  detail: Record<string, unknown>;
  created_at: string;
};
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: flags, extractions, approvals, agent_steps + Realtime"
```

---

## Task 6: Threshold trigger

Business limits belong in a trigger, not a policy — RLS decides *whether you may write*, not *what value is acceptable*. A trigger also gives a readable error message.

**Files:**
- Create: `supabase/migrations/20260905000400_threshold_trigger.sql`

**Interfaces:**
- Produces: trigger `enforce_approval_threshold` on `expenses`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/20260905000400_threshold_trigger.sql`:

```sql
create or replace function public.enforce_approval_threshold()
returns trigger
language plpgsql
as $$
declare
  limit_cents integer;
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    if public.jwt_role() = 'manager' then
      select threshold_cents into limit_cents from orgs where id = new.org_id;
      if new.amount_cents > limit_cents then
        raise exception
          'Manager approval limit is %, this expense is %. Route to finance.',
          limit_cents, new.amount_cents
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger enforce_approval_threshold
  before update on expenses
  for each row execute function public.enforce_approval_threshold();
```

- [ ] **Step 2: Apply**

```bash
pnpm supabase db push
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: manager approval threshold trigger"
```

---

## Task 7: Storage bucket for receipts

**Files:**
- Create: `supabase/migrations/20260905000500_storage.sql`

**Interfaces:**
- Produces: a private `receipts` bucket. Object paths are `{org_id}/{expense_id}.{ext}` — the leading path segment is what policies key on.

- [ ] **Step 1: Write the migration**

`supabase/migrations/20260905000500_storage.sql`:

```sql
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- Path convention: {org_id}/{expense_id}.{ext}
-- storage.foldername(name) returns the path segments; [1] is the org.

create policy "receipts read own org" on storage.objects for select to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = public.jwt_org_id()::text
  );

create policy "receipts upload own org" on storage.objects for insert to authenticated
  using (true)
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = public.jwt_org_id()::text
    and public.jwt_role() <> 'agent'
  );
```

The agent can **read** receipts and cannot **upload** them. Same shape as the expenses table: read broadly, write narrowly.

- [ ] **Step 2: Apply and verify**

```bash
pnpm supabase db push
pnpm supabase db execute --query "select id, public from storage.buckets where id='receipts';"
```

Expected: one row, `public` = `f`.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: private receipts bucket with org-scoped policies"
```

---

## Task 8: Seed data

**Files:**
- Create: `scripts/seed.ts`, `scripts/fixtures/receipts/` (3 images)
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces: 2 orgs, 7 users with known passwords, ~120 historical expenses, and the three structuring rows staged as `draft` so the demo can submit one live.
- Consumed by: every manual verification from here on.

- [ ] **Step 1: Add scripts to `package.json`**

```json
{
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "start": "next start",
    "seed": "tsx scripts/seed.ts",
    "reset": "tsx scripts/reset.ts",
    "test:rls": "supabase test db"
  }
}
```

- [ ] **Step 2: Write the seed script**

`scripts/seed.ts`:

```ts
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !serviceKey) throw new Error("Missing Supabase env vars");

// Service role is permitted HERE ONLY. Seeding creates auth users and
// bypasses RLS by design. It must never appear in app or agent code.
const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PASSWORD = "demo-password-1234";

const PEOPLE = [
  { email: "dana@northwind.demo",  name: "Dana Reyes",   role: "finance"  },
  { email: "marcus@northwind.demo", name: "Marcus Vale",  role: "manager"  },
  { email: "priya@northwind.demo",  name: "Priya Raman",  role: "employee" },
  { email: "sam@northwind.demo",    name: "Sam Okafor",   role: "employee" },
  { email: "lee@acme.demo",         name: "Lee Zhang",    role: "finance"  },
  { email: "kit@acme.demo",         name: "Kit Alvarez",  role: "employee" },
] as const;

const VENDORS = [
  "Meridian Consulting", "Bluepeak Travel", "Orchard Catering",
  "Halcyon Software", "Ridgeline Logistics",
];

async function upsertUser(email: string) {
  const { data: existing } = await db.auth.admin.listUsers();
  const found = existing.users.find((u) => u.email === email);
  if (found) return found.id;
  const { data, error } = await db.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error) throw error;
  return data.user.id;
}

async function main() {
  console.log("Seeding…");

  const { data: orgs, error: orgErr } = await db
    .from("orgs")
    .upsert(
      [
        { name: "Northwind Labs", threshold_cents: 400_000 },
        { name: "Acme Freight",   threshold_cents: 250_000 },
      ],
      { onConflict: "name" },
    )
    .select();
  if (orgErr) throw orgErr;

  const northwind = orgs.find((o) => o.name === "Northwind Labs")!;
  const acme = orgs.find((o) => o.name === "Acme Freight")!;

  const ids: Record<string, string> = {};
  for (const p of PEOPLE) {
    ids[p.email] = await upsertUser(p.email);
  }

  const orgFor = (email: string) =>
    email.endsWith("@acme.demo") ? acme.id : northwind.id;

  await db.from("profiles").upsert(
    PEOPLE.map((p) => ({
      id: ids[p.email],
      org_id: orgFor(p.email),
      full_name: p.name,
      role: p.role,
    })),
  );

  // Employees report to Marcus (Northwind) / Lee (Acme).
  await db.from("profiles").update({ manager_id: ids["marcus@northwind.demo"] })
    .in("id", [ids["priya@northwind.demo"], ids["sam@northwind.demo"]]);
  await db.from("profiles").update({ manager_id: ids["lee@acme.demo"] })
    .eq("id", ids["kit@acme.demo"]);

  const { data: vendors } = await db.from("vendors").upsert(
    [northwind.id, acme.id].flatMap((org_id) =>
      VENDORS.map((name) => ({ org_id, name })),
    ),
    { onConflict: "org_id,name" },
  ).select();

  const nwVendors = vendors!.filter((v) => v.org_id === northwind.id);
  const meridian = nwVendors.find((v) => v.name === "Meridian Consulting")!;

  // ---- Historical noise: 120 approved expenses over the last 6 months ----
  const history = Array.from({ length: 120 }, (_, i) => {
    const submitters = [ids["priya@northwind.demo"], ids["sam@northwind.demo"]];
    const d = new Date();
    d.setDate(d.getDate() - (7 + (i * 43) % 170));
    return {
      org_id: northwind.id,
      submitter_id: submitters[i % 2],
      vendor_id: nwVendors[i % nwVendors.length].id,
      amount_cents: 4_200 + ((i * 7919) % 180_000),
      spent_at: d.toISOString().slice(0, 10),
      description: `${nwVendors[i % nwVendors.length].name} — routine`,
      status: "approved" as const,
    };
  });
  await db.from("expenses").insert(history);

  // ---- The demo rows: three charges just under the $4,000 threshold ----
  const today = new Date().toISOString().slice(0, 10);
  const demo = [3_94000, 3_87500, 3_99000].map((amount_cents, i) => ({
    org_id: northwind.id,
    submitter_id: ids["priya@northwind.demo"],
    vendor_id: meridian.id,
    amount_cents,
    spent_at: today,
    description: `Meridian Consulting — engagement phase ${i + 1}`,
    status: "draft" as const,   // submitted live on stage
  }));
  const { data: demoRows } = await db.from("expenses").insert(demo).select();

  console.log("Demo expense ids (submit these on stage):");
  demoRows!.forEach((r) => console.log(`  ${r.id}  $${r.amount_cents / 100}`));

  // ---- Receipts ----
  for (const [i, row] of demoRows!.entries()) {
    const file = readFileSync(
      join(process.cwd(), "scripts/fixtures/receipts", `receipt-${i + 1}.png`),
    );
    const path = `${northwind.id}/${row.id}.png`;
    const { error } = await db.storage.from("receipts")
      .upload(path, file, { contentType: "image/png", upsert: true });
    if (error) throw error;
    await db.from("expenses").update({ receipt_path: path }).eq("id", row.id);
  }

  console.log(`\nDone. All demo logins use password: ${PASSWORD}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Create three receipt images**

Make three PNGs at `scripts/fixtures/receipts/receipt-{1,2,3}.png`. Each should legibly show **Meridian Consulting**, today's date, and the matching total ($3,940.00 / $3,875.00 / $3,990.00). Photograph real printed receipts, or mock them up — they must be readable enough for the model's vision to extract, and readable from the back of a room.

- [ ] **Step 4: Run the seed**

```bash
set -a && source .env.local && set +a && pnpm seed
```

Expected: prints three expense ids and the shared password.

- [ ] **Step 5: Verify the row counts**

```bash
pnpm supabase db execute --query "select status, count(*) from expenses group by status order by status;"
```

Expected: `approved` = 120, `draft` = 3.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: seed script with orgs, users, history, and demo rows"
```

---

## Task 9: RLS test suite

Prove the policies before building on them. These tests are also what makes the stage claim "the agent cannot approve" a **demonstrated fact** rather than an assertion.

**Files:**
- Create: `supabase/tests/rls.test.sql`

**Interfaces:**
- Produces: `pnpm test:rls` — a pgTAP suite asserting per-role visibility and the agent's write ceiling.

- [ ] **Step 1: Write the test suite**

`supabase/tests/rls.test.sql`:

```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

-- Helper: impersonate a role with the claims the auth hook would issue.
create or replace function tests.act_as(uid uuid, org uuid, role text)
returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid::text, 'role', 'authenticated',
                      'org_id', org::text, 'user_role', role)::text, true);
end; $$;

create or replace function tests.reset() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end; $$;

-- Fixtures
select tests.reset();
insert into orgs (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'TestOrg A'),
  ('22222222-2222-2222-2222-222222222222', 'TestOrg B');

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'emp-a@test'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'fin-a@test'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'agent-a@test'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'emp-b@test');

insert into profiles (id, org_id, full_name, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Emp A','employee'),
  ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Fin A','finance'),
  ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Agent A','agent'),
  ('bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Emp B','employee');

insert into expenses (id, org_id, submitter_id, amount_cents, spent_at, status) values
  ('cccccccc-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001', 5000, current_date, 'submitted'),
  ('cccccccc-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','bbbbbbbb-0000-0000-0000-000000000001', 9000, current_date, 'submitted');

-- 1. Employee sees only their own.
select tests.act_as('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','employee');
select is((select count(*) from expenses)::int, 1, 'employee sees only their own expense');

-- 2. Finance sees the whole org, and nothing outside it.
select tests.reset();
select tests.act_as('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','finance');
select is((select count(*) from expenses)::int, 1, 'finance sees their org only');

-- 3. The agent sees the whole org.
select tests.reset();
select tests.act_as('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','agent');
select is((select count(*) from expenses)::int, 1, 'agent sees its org');

-- 4. The agent cannot see another org.
select is(
  (select count(*) from expenses where org_id='22222222-2222-2222-2222-222222222222')::int,
  0, 'agent cannot see another org');

-- 5. THE DEMO: the agent cannot approve.
select is(
  (with attempt as (
     update expenses set status='approved'
     where id='cccccccc-0000-0000-0000-000000000001' returning 1)
   select count(*) from attempt)::int,
  0, 'agent UPDATE on expenses.status affects zero rows');

-- 6. The agent CAN record a finding.
select lives_ok($$
  insert into expense_flags (expense_id, org_id, kind, rationale)
  values ('cccccccc-0000-0000-0000-000000000001',
          '11111111-1111-1111-1111-111111111111','structuring','test')
$$, 'agent can insert a flag');

-- 7. Finance CAN approve.
select tests.reset();
select tests.act_as('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','finance');
select is(
  (with attempt as (
     update expenses set status='approved'
     where id='cccccccc-0000-0000-0000-000000000001' returning 1)
   select count(*) from attempt)::int,
  1, 'finance UPDATE on expenses.status succeeds');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it**

```bash
pnpm test:rls
```

Expected: `All 7 subtests passed`.

If test 5 **fails** (i.e. the update affected a row), stop everything and fix the policies — the demo's central claim is false until this passes.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test: pgTAP suite proving per-role RLS and the agent's write ceiling"
```

---

## Task 10: Supabase auth in Next.js

**Files:**
- Create: `lib/supabase/client.ts`, `lib/supabase/server.ts`, `middleware.ts`, `app/login/page.tsx`, `app/login/actions.ts`

**Interfaces:**
- Produces: `createBrowserSupabase()`, `createServerSupabase()`, a working login at `/login`, and session refresh in middleware.
- Consumed by: Tasks 11, 12, 20.

- [ ] **Step 1: Browser client**

`lib/supabase/client.ts`:

```ts
import { createBrowserClient } from "@supabase/ssr";

export const createBrowserSupabase = () =>
  createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
```

- [ ] **Step 2: Server client**

`lib/supabase/server.ts`:

```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (list) => {
          try {
            list.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component; middleware handles refresh.
          }
        },
      },
    },
  );
}
```

- [ ] **Step 3: Middleware**

`middleware.ts`:

```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;

  if (!user && !pathname.startsWith("/login") && !pathname.startsWith("/api")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|eve/).*)"],
};
```

The `eve/` exclusion matters — eve's own routes authenticate through its channel policy, not this middleware.

- [ ] **Step 4: Login action**

`app/login/actions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";

export async function signIn(formData: FormData) {
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(formData.get("email")),
    password: String(formData.get("password")),
  });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/", "layout");
  redirect("/inbox");
}

export async function signOut() {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
```

- [ ] **Step 5: Login page**

`app/login/page.tsx`:

```tsx
import { signIn } from "./actions";

const DEMO_USERS = [
  { email: "priya@northwind.demo", label: "Priya — employee" },
  { email: "marcus@northwind.demo", label: "Marcus — manager" },
  { email: "dana@northwind.demo", label: "Dana — finance" },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto mt-24 max-w-sm space-y-6 p-6">
      <h1 className="text-2xl font-semibold">eve-the-accountant</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <form action={signIn} className="space-y-3">
        <input name="email" type="email" required placeholder="email"
          className="w-full rounded border p-2" defaultValue={DEMO_USERS[0].email} />
        <input name="password" type="password" required placeholder="password"
          className="w-full rounded border p-2" defaultValue="demo-password-1234" />
        <button className="w-full rounded bg-black p-2 text-white">Sign in</button>
      </form>
      <ul className="space-y-1 text-sm text-gray-500">
        {DEMO_USERS.map((u) => <li key={u.email}>{u.label} — {u.email}</li>)}
      </ul>
    </main>
  );
}
```

- [ ] **Step 6: Verify login works and the claims land**

```bash
pnpm dev
```

Sign in at http://localhost:3000/login as `priya@northwind.demo`. You should be redirected to `/inbox` (a 404 for now — that's Task 11).

Then confirm the auth hook fired: open the browser devtools console and run

```js
JSON.parse(atob(JSON.parse(localStorage.getItem(
  Object.keys(localStorage).find(k => k.startsWith("sb-"))
)).access_token.split(".")[1]))
```

Expected: the decoded payload contains `org_id` and `user_role: "employee"`. **If those claims are missing, the auth hook from Task 4 Step 3 is not enabled** — go back and enable it before continuing.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: Supabase auth, login page, session middleware"
```

---

## Task 11: Inbox, review queue, and expense detail

**Files:**
- Create: `app/inbox/page.tsx`, `app/review/page.tsx`, `app/expense/[id]/page.tsx`
- Create: `components/expense-table.tsx`, `components/receipt-viewer.tsx`

**Interfaces:**
- Consumes: `createServerSupabase()`.
- Produces: three pages rendering RLS-filtered data. No role checks in application code — the queries are identical for every user and RLS does the filtering. That is the point, and it is worth a sentence on stage.

- [ ] **Step 1: Expense table component**

`components/expense-table.tsx`:

```tsx
import Link from "next/link";
import { dollars, type Expense } from "@/lib/types";

export function ExpenseTable({ rows }: { rows: Expense[] }) {
  if (rows.length === 0)
    return <p className="text-sm text-gray-500">Nothing here.</p>;

  return (
    <table className="w-full text-sm">
      <thead className="border-b text-left text-gray-500">
        <tr>
          <th className="py-2">Date</th>
          <th>Description</th>
          <th className="text-right">Amount</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={e.id} className="border-b hover:bg-gray-50">
            <td className="py-2">{e.spent_at}</td>
            <td>
              <Link href={`/expense/${e.id}`} className="underline">
                {e.description || "—"}
              </Link>
            </td>
            <td className="text-right tabular-nums">{dollars(e.amount_cents)}</td>
            <td>{e.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Inbox page**

`app/inbox/page.tsx`:

```tsx
import { createServerSupabase } from "@/lib/supabase/server";
import { ExpenseTable } from "@/components/expense-table";
import { signOut } from "@/app/login/actions";
import Link from "next/link";

export default async function InboxPage() {
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("expenses")
    .select("*")
    .order("spent_at", { ascending: false })
    .limit(50);

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Expenses</h1>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/review" className="underline">Review queue</Link>
          <form action={signOut}><button className="underline">Sign out</button></form>
        </nav>
      </header>
      <ExpenseTable rows={data ?? []} />
    </main>
  );
}
```

- [ ] **Step 3: Review queue**

`app/review/page.tsx`:

```tsx
import { createServerSupabase } from "@/lib/supabase/server";
import { ExpenseTable } from "@/components/expense-table";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("expenses")
    .select("*")
    .in("status", ["submitted", "needs_review"])
    .order("created_at", { ascending: false });

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Review queue</h1>
        <Link href="/inbox" className="text-sm underline">All expenses</Link>
      </header>
      <ExpenseTable rows={data ?? []} />
    </main>
  );
}
```

- [ ] **Step 4: Receipt viewer**

`components/receipt-viewer.tsx`:

```tsx
import { createServerSupabase } from "@/lib/supabase/server";

export async function ReceiptViewer({ path }: { path: string | null }) {
  if (!path) return <p className="text-sm text-gray-500">No receipt attached.</p>;

  const supabase = await createServerSupabase();
  const { data } = await supabase.storage
    .from("receipts")
    .createSignedUrl(path, 60 * 10);

  if (!data?.signedUrl)
    return <p className="text-sm text-red-600">Receipt not accessible.</p>;

  return (
    <img src={data.signedUrl} alt="Receipt"
      className="w-full rounded border" />
  );
}
```

The signed URL is minted **as the logged-in user**. A user from another org gets no URL, because the Storage policy from Task 7 rejects the path.

- [ ] **Step 5: Expense detail page**

`app/expense/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { ReceiptViewer } from "@/components/receipt-viewer";
import { dollars, type ExpenseFlag } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ExpensePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabase();

  const { data: expense } = await supabase
    .from("expenses").select("*").eq("id", id).maybeSingle();
  if (!expense) notFound();

  const { data: flags } = await supabase
    .from("expense_flags").select("*")
    .eq("expense_id", id).order("created_at");

  return (
    <main className="mx-auto grid max-w-5xl gap-8 p-8 md:grid-cols-2">
      <section className="space-y-4">
        <h1 className="text-xl font-semibold">{expense.description || "Expense"}</h1>
        <dl className="space-y-1 text-sm">
          <div><dt className="inline text-gray-500">Amount: </dt>
            <dd className="inline tabular-nums">{dollars(expense.amount_cents)}</dd></div>
          <div><dt className="inline text-gray-500">Date: </dt>
            <dd className="inline">{expense.spent_at}</dd></div>
          <div><dt className="inline text-gray-500">Status: </dt>
            <dd className="inline">{expense.status}</dd></div>
        </dl>

        <h2 className="pt-4 text-sm font-semibold uppercase text-gray-500">Findings</h2>
        {(flags ?? []).length === 0
          ? <p className="text-sm text-gray-500">None yet.</p>
          : <ul className="space-y-2">
              {(flags as ExpenseFlag[]).map((f) => (
                <li key={f.id} className="rounded border-l-4 border-amber-500 bg-amber-50 p-3 text-sm">
                  <strong>{f.kind}</strong> — {f.rationale}
                  <span className="ml-2 text-xs text-gray-500">by {f.created_by}</span>
                </li>
              ))}
            </ul>}
      </section>
      <section>
        <ReceiptViewer path={expense.receipt_path} />
      </section>
    </main>
  );
}
```

- [ ] **Step 6: Verify RLS end-to-end through the UI**

With `pnpm dev` running:
1. Sign in as `priya@northwind.demo` → `/inbox` shows only Priya's expenses.
2. Sign out, sign in as `dana@northwind.demo` (finance) → `/inbox` shows the whole Northwind org (~120 rows).
3. Sign in as `kit@acme.demo` → shows only Acme rows. Paste a Northwind expense id into `/expense/<id>` → **404**.

Step 3 is beat 8 of the talk, working, with zero role-checking code in the app.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: inbox, review queue, expense detail with signed receipt URLs"
```

---

## Task 12: SPIKE — approval round trip

**Do this task before any other agent work.** It is the least-documented path in the stack and it gates the demo's climax. If it does not work, you need Sunday morning to find that out, not Sunday night.

**Files:**
- Create: `agent/tools/spike_confirm.ts`
- Create: `docs/eve-api-notes.md` (append findings)

**Interfaces:**
- Produces: a documented, working sequence for pausing on approval and resolving it from a custom client. Consumed by Tasks 17 and 20.

- [ ] **Step 1: Write a throwaway approval-gated tool**

`agent/tools/spike_confirm.ts`:

```ts
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Confirm a number with a human. Used only to test approvals.",
  inputSchema: z.object({ value: z.number() }),
  approval: always(),
  async execute({ value }) {
    return { confirmed: value };
  },
});
```

- [ ] **Step 2: Trigger it and capture the pause event**

```bash
pnpm dev
```

```bash
curl -sS -N -X POST http://127.0.0.1:3000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Call spike_confirm with value 42."}' | tee /tmp/spike-session.json
```

Note the `x-eve-session-id`, then attach to the stream:

```bash
curl -sS -N http://127.0.0.1:3000/eve/v1/session/<sessionId>/stream | tee /tmp/spike-stream.ndjson
```

Expected: an event of type `input.requested` carrying a `requestId`.

- [ ] **Step 3: Record the exact event shape**

```bash
grep -o '"type":"[^"]*"' /tmp/spike-stream.ndjson | sort -u
python3 -m json.tool <<< "$(grep input.requested /tmp/spike-stream.ndjson | head -1)"
```

Append the full pretty-printed `input.requested` event to `docs/eve-api-notes.md` under a heading `## Approval event shape`.

- [ ] **Step 4: Resolve the approval**

Try the documented structured form first:

```bash
curl -sS -X POST http://127.0.0.1:3000/eve/v1/session/<sessionId>/message \
  -H 'content-type: application/json' \
  -d '{"inputResponses":{"<requestId>":{"decision":"approve"}}}'
```

If that route or shape is rejected, fall back to the documented text form:

```bash
curl -sS -X POST http://127.0.0.1:3000/eve/v1/session/<sessionId>/message \
  -H 'content-type: application/json' -d '{"message":"approve"}'
```

Expected: the stream resumes and `spike_confirm` executes, returning `{confirmed: 42}`.

- [ ] **Step 5: Write down what actually worked**

Append to `docs/eve-api-notes.md`:

```md
## Approval resolution — VERIFIED

Endpoint: <exact URL and method that worked>
Body:     <exact JSON that worked>
Event to watch for: <type> with requestId at <json path>

Tasks 17 and 20 depend on this. If eve is upgraded, re-run this spike.
```

- [ ] **Step 6: Delete the spike tool and commit the findings**

```bash
rm agent/tools/spike_confirm.ts
git add -A && git commit -m "docs: verify eve approval round trip (spike)"
```

**Checkpoint:** if you could not resolve an approval from an HTTP client, stop and reconsider beat 6 before building further. The fallback is to gate approval in the app's own UI (write `needs_review`, have finance approve, then send the agent a follow-up message) — a weaker story, but a working demo.

---

## Task 13: Agent identity and channel auth

**Files:**
- Create: `agent/lib/agent-db.ts`, `agent/channels/eve.ts`
- Modify: `scripts/seed.ts` (create the agent user)

**Interfaces:**
- Produces: `getAgentDb(orgId)` returning a Supabase client authenticated **as the agent user**, RLS-bound. Consumed by every tool in Tasks 14–18.

- [ ] **Step 1: Add the agent user to the seed script**

In `scripts/seed.ts`, add to the `PEOPLE` array:

```ts
  { email: process.env.AGENT_EMAIL ?? "agent@eve-the-accountant.demo",
    name: "eve (agent)", role: "agent" },
```

and change `upsertUser` to take a password:

```ts
async function upsertUser(email: string, password = PASSWORD) {
  const { data: existing } = await db.auth.admin.listUsers();
  const found = existing.users.find((u) => u.email === email);
  if (found) {
    await db.auth.admin.updateUserById(found.id, { password });
    return found.id;
  }
  const { data, error } = await db.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error) throw error;
  return data.user.id;
}
```

and in the loop:

```ts
  for (const p of PEOPLE) {
    const pw = p.role === "agent" ? process.env.AGENT_PASSWORD! : PASSWORD;
    ids[p.email] = await upsertUser(p.email, pw);
  }
```

Note `orgFor()` puts the agent in Northwind, which is correct — the agent is scoped to one org, exactly like an employee.

- [ ] **Step 2: Re-seed**

```bash
set -a && source .env.local && set +a && pnpm seed
```

- [ ] **Step 3: Verify the agent's claims**

```bash
set -a && source .env.local && set +a
curl -sS -X POST "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" -H 'content-type: application/json' \
  -d "{\"email\":\"$AGENT_EMAIL\",\"password\":\"$AGENT_PASSWORD\"}" \
  | python3 -c "import sys,json,base64; t=json.load(sys.stdin)['access_token']; p=t.split('.')[1]; print(json.dumps(json.loads(base64.urlsafe_b64decode(p+'==')), indent=2))"
```

Expected: the payload contains `"user_role": "agent"` and an `org_id`. If not, the auth hook is not enabled.

- [ ] **Step 4: Write the agent's database client**

`agent/lib/agent-db.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: { client: SupabaseClient; expiresAt: number } | null = null;

/**
 * The agent's Supabase client, authenticated as the `agent` user.
 *
 * This deliberately signs in with a password rather than using the service
 * role key. The whole premise of this project is that the agent is an
 * ordinary RLS principal — service role would bypass every policy and make
 * the security story a lie.
 */
export async function getAgentDb(): Promise<SupabaseClient> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.client;

  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data, error } = await client.auth.signInWithPassword({
    email: process.env.AGENT_EMAIL!,
    password: process.env.AGENT_PASSWORD!,
  });
  if (error) throw new Error(`Agent sign-in failed: ${error.message}`);

  cached = {
    client,
    expiresAt: (data.session!.expires_at ?? 0) * 1000,
  };
  return client;
}

/** The agent's own org, read from its JWT claims. */
export async function getAgentOrgId(): Promise<string> {
  const db = await getAgentDb();
  const { data } = await db.auth.getSession();
  const claims = JSON.parse(
    Buffer.from(data.session!.access_token.split(".")[1], "base64").toString(),
  );
  return claims.org_id as string;
}
```

- [ ] **Step 5: Configure the channel auth policy**

`agent/channels/eve.ts`:

```ts
import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";
import type { AuthFn } from "eve/channels/auth";

/**
 * The Database Webhook route calls eve with a shared secret. That turn is
 * machine-initiated, which is what makes its writes require approval
 * (see agent/tools/request_human_review.ts).
 */
const machineToken: AuthFn = async (request) => {
  const header = request.headers.get("x-webhook-secret");
  if (!header || header !== process.env.WEBHOOK_SECRET) return null;
  return {
    principalId: "expense-webhook",
    principalType: "machine",
    authenticator: "webhook-secret",
  };
};

export default eveChannel({
  auth: [machineToken, localDev()],
});
```

**Verify the import names against `docs/eve-api-notes.md` (Task 1 Step 6) before running.** If `AuthFn` or `localDev` are named differently in the installed package, use the installed names.

- [ ] **Step 6: Verify the agent can read but not write**

```bash
cat > /tmp/agent-check.ts <<'EOF'
import { getAgentDb } from "./agent/lib/agent-db";
const db = await getAgentDb();
const { count } = await db.from("expenses").select("*", { count: "exact", head: true });
console.log("agent can see", count, "expenses");
const { data, error } = await db.from("expenses")
  .update({ status: "approved" }).eq("status", "draft").select();
console.log("rows the agent changed:", data?.length ?? 0, "error:", error?.message ?? "none");
EOF
set -a && source .env.local && set +a && pnpm tsx /tmp/agent-check.ts
```

Expected: `agent can see 123 expenses` and `rows the agent changed: 0`.

That second line is the demo. Save this output.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: agent Supabase identity and channel auth

Agent signs in as an ordinary user; RLS applies. Never service role."
```

---

## Task 14: Read tools

**Files:**
- Create: `agent/tools/get_expense.ts`, `agent/tools/find_related_expenses.ts`

**Interfaces:**
- Consumes: `getAgentDb()` from Task 13.
- Produces: tools `get_expense` and `find_related_expenses`.

- [ ] **Step 1: `get_expense`**

`agent/tools/get_expense.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { getAgentDb } from "../lib/agent-db";

export default defineTool({
  description:
    "Fetch one expense with its submitter, vendor, and any receipt extraction.",
  inputSchema: z.object({
    expenseId: z.string().uuid(),
  }),
  async execute({ expenseId }) {
    const db = await getAgentDb();
    const { data, error } = await db
      .from("expenses")
      .select(
        `id, amount_cents, currency, spent_at, description, status, receipt_path,
         submitter:profiles!expenses_submitter_id_fkey (id, full_name, role),
         vendor:vendors (id, name, category),
         extraction:receipt_extractions (merchant, total_cents, spent_at, confidence)`,
      )
      .eq("id", expenseId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      return { found: false, note: "No expense with that id is visible to you." };
    }
    return { found: true, expense: data };
  },
});
```

- [ ] **Step 2: `find_related_expenses` — the structuring join**

`agent/tools/find_related_expenses.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { getAgentDb } from "../lib/agent-db";

export default defineTool({
  description:
    "Find other expenses from the same submitter and vendor within a date " +
    "window. Use this to detect charges that were split to stay under an " +
    "approval threshold.",
  inputSchema: z.object({
    expenseId: z.string().uuid(),
    windowDays: z.number().int().min(0).max(90).default(3),
  }),
  async execute({ expenseId, windowDays }) {
    const db = await getAgentDb();

    const { data: base, error: baseErr } = await db
      .from("expenses")
      .select("id, submitter_id, vendor_id, spent_at, org_id")
      .eq("id", expenseId)
      .maybeSingle();
    if (baseErr) throw new Error(baseErr.message);
    if (!base) return { found: false, related: [] };

    const from = new Date(base.spent_at);
    from.setDate(from.getDate() - windowDays);
    const to = new Date(base.spent_at);
    to.setDate(to.getDate() + windowDays);

    const { data, error } = await db
      .from("expenses")
      .select("id, amount_cents, spent_at, description, status")
      .eq("submitter_id", base.submitter_id)
      .eq("vendor_id", base.vendor_id)
      .gte("spent_at", from.toISOString().slice(0, 10))
      .lte("spent_at", to.toISOString().slice(0, 10))
      .order("spent_at");
    if (error) throw new Error(error.message);

    const { data: org } = await db
      .from("orgs").select("threshold_cents").eq("id", base.org_id).maybeSingle();

    const totalCents = (data ?? []).reduce((s, r) => s + r.amount_cents, 0);

    return {
      found: true,
      thresholdCents: org?.threshold_cents ?? null,
      count: data?.length ?? 0,
      totalCents,
      related: data ?? [],
    };
  },
});
```

Returning `thresholdCents` and `totalCents` alongside the rows lets the model reason about the pattern without doing arithmetic in its head — the comparison it needs is right there in the tool output.

- [ ] **Step 3: Verify the tools run**

```bash
pnpm dev
```

```bash
curl -sS -X POST http://127.0.0.1:3000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Use get_expense on <one of the demo ids from the seed output>, then find_related_expenses on it. Report what you see."}'
```

Attach to the stream and confirm both tools were called and returned data.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: get_expense and find_related_expenses tools"
```

---

## Task 15: Receipt reading tool

**Files:**
- Create: `agent/tools/read_receipt.ts`

**Interfaces:**
- Consumes: `getAgentDb()`.
- Produces: tool `read_receipt`, which writes a `receipt_extractions` row.

- [ ] **Step 1: Write the tool**

`agent/tools/read_receipt.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { getAgentDb } from "../lib/agent-db";

export default defineTool({
  description:
    "Read the receipt attached to an expense and return what it says. " +
    "Returns a signed image URL the model can look at directly.",
  inputSchema: z.object({
    expenseId: z.string().uuid(),
  }),
  async execute({ expenseId }) {
    const db = await getAgentDb();

    const { data: expense, error } = await db
      .from("expenses")
      .select("id, org_id, receipt_path, amount_cents")
      .eq("id", expenseId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!expense) return { hasReceipt: false, note: "Expense not visible." };
    if (!expense.receipt_path) return { hasReceipt: false };

    const { data: signed, error: signErr } = await db.storage
      .from("receipts")
      .createSignedUrl(expense.receipt_path, 60 * 10);
    if (signErr) throw new Error(signErr.message);

    return {
      hasReceipt: true,
      imageUrl: signed.signedUrl,
      claimedAmountCents: expense.amount_cents,
      note:
        "Look at the image and compare the merchant, date, and total against " +
        "the claimed amount. Then call record_extraction with what you read.",
    };
  },
});
```

- [ ] **Step 2: Add the extraction-recording tool**

`agent/tools/record_extraction.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { getAgentDb } from "../lib/agent-db";

export default defineTool({
  description:
    "Record what you read off a receipt image. Call this after read_receipt.",
  inputSchema: z.object({
    expenseId: z.string().uuid(),
    merchant: z.string(),
    totalCents: z.number().int(),
    spentAt: z.string().describe("ISO date, YYYY-MM-DD"),
    confidence: z.number().min(0).max(1),
  }),
  async execute({ expenseId, merchant, totalCents, spentAt, confidence }) {
    const db = await getAgentDb();

    const { data: expense } = await db
      .from("expenses").select("org_id").eq("id", expenseId).maybeSingle();
    if (!expense) throw new Error("Expense not visible.");

    const { error } = await db.from("receipt_extractions").upsert({
      expense_id: expenseId,
      org_id: expense.org_id,
      merchant,
      total_cents: totalCents,
      spent_at: spentAt,
      confidence,
    });
    if (error) throw new Error(error.message);

    return { recorded: true };
  },
});
```

- [ ] **Step 3: Verify**

```bash
curl -sS -X POST http://127.0.0.1:3000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Read the receipt on expense <demo id> and record what it says."}'
```

Then:

```bash
pnpm supabase db execute --query "select merchant, total_cents, confidence from receipt_extractions;"
```

Expected: a row whose `merchant` reads `Meridian Consulting` and whose `total_cents` matches the receipt image.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: read_receipt and record_extraction tools"
```

---

## Task 16: Skills and the flag tool

**Files:**
- Create: `agent/skills/expense-policy.md`, `agent/skills/structuring-detection.md`, `agent/tools/flag_expense.ts`
- Modify: `agent/instructions.md`

**Interfaces:**
- Produces: tool `flag_expense`; two skills the agent loads contextually.

- [ ] **Step 1: The expense policy skill — this is the slide**

`agent/skills/expense-policy.md`:

```md
---
name: expense-policy
description: Northwind Labs expense policy. Load when reviewing any expense.
---

# Northwind Labs — Expense Policy v1

## Approval thresholds

| Amount | Approver |
|---|---|
| Under $500 | Auto-approved if a receipt is attached |
| $500 – $4,000 | Direct manager |
| Over $4,000 | Finance, with VP sign-off |

## Receipts

Every expense over $75 requires an itemized receipt. The merchant, date, and
total on the receipt must match the submitted expense. A mismatch over $5 is a
policy violation, not a rounding error.

## Splitting

Deliberately dividing a single purchase into smaller charges to stay under an
approval threshold is prohibited. Treat several charges to the same vendor by
the same person within a few days as a single purchase for threshold purposes.

## What you may and may not do

You may investigate, extract receipt data, and record findings.

You may **not** approve, reject, or otherwise change an expense's status. If an
expense needs a decision, escalate it to a human and stop.
```

That last section is worth reading aloud on stage — and then showing that even if you delete it, the database still refuses.

- [ ] **Step 2: The structuring skill**

`agent/skills/structuring-detection.md`:

```md
---
name: structuring-detection
description: How to recognize split transactions. Load when several expenses share a vendor and submitter.
---

# Recognizing split transactions

A split (or "structured") purchase looks like this:

- Two or more charges to the **same vendor** by the **same person**
- Within a **short window** — usually the same day, at most a few days
- Each individually **below** an approval threshold
- **Together above** it

Any single charge looks unremarkable. The pattern only appears when you compare
them, which is why a reviewer working a queue one row at a time will miss it.

## What to do

1. Call `find_related_expenses` to gather the sibling charges.
2. Compare the **sum** against `thresholdCents` from that tool's output.
3. If the sum crosses the threshold and no single charge does, flag **all** of
   them as one `structuring` finding with severity `critical`. Put the sibling
   ids and the total in the evidence.
4. Escalate. Do not attempt to resolve it yourself.

## What is not structuring

- Recurring charges spread over weeks (a monthly subscription)
- Different people expensing the same vendor independently
- Charges that are each individually over the threshold — those are just large
```

- [ ] **Step 3: The flag tool**

`agent/tools/flag_expense.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { getAgentDb } from "../lib/agent-db";

export default defineTool({
  description:
    "Record a finding against one or more expenses. Use one call per finding, " +
    "listing every expense the finding covers.",
  inputSchema: z.object({
    expenseIds: z.array(z.string().uuid()).min(1),
    kind: z.enum([
      "over_threshold", "structuring", "duplicate",
      "missing_receipt", "policy_violation",
    ]),
    severity: z.enum(["info", "warn", "critical"]).default("warn"),
    rationale: z.string().min(10),
    evidence: z.record(z.unknown()).default({}),
  }),
  async execute({ expenseIds, kind, severity, rationale, evidence }) {
    const db = await getAgentDb();

    const { data: expenses, error: readErr } = await db
      .from("expenses").select("id, org_id").in("id", expenseIds);
    if (readErr) throw new Error(readErr.message);
    if (!expenses?.length) throw new Error("None of those expenses are visible.");

    const { data, error } = await db.from("expense_flags").insert(
      expenses.map((e) => ({
        expense_id: e.id,
        org_id: e.org_id,
        kind, severity, rationale,
        evidence: { ...evidence, siblingIds: expenseIds },
        created_by: "agent" as const,
      })),
    ).select("id");
    if (error) throw new Error(error.message);

    return { flagged: data.length, flagIds: data.map((f) => f.id) };
  },
});
```

- [ ] **Step 4: Rewrite the instructions**

`agent/instructions.md`:

```md
You review submitted expenses for Northwind Labs.

When you are given an expense to review:

1. Call `get_expense` to see it.
2. If it has a receipt, call `read_receipt`, look at the image, and call
   `record_extraction` with what you read.
3. Call `find_related_expenses` — always, even when the expense looks fine.
   Patterns only appear across rows.
4. Record any findings with `flag_expense`.
5. If anything needs a human decision, call `request_human_review` and stop.

Read the `expense-policy` skill before judging anything. Read
`structuring-detection` whenever `find_related_expenses` returns more than one
row.

You cannot approve or reject expenses. Do not try. If asked to, explain that a
human approver has to make that call, and escalate instead.

Be concise. Report what you found, not what you did.
```

- [ ] **Step 5: Verify the full investigation runs**

First submit a demo expense:

```bash
pnpm supabase db execute --query "update expenses set status='submitted' where status='draft' returning id, amount_cents;"
```

```bash
curl -sS -X POST http://127.0.0.1:3000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Review expense <first demo id>."}'
```

Then:

```bash
pnpm supabase db execute --query "select kind, severity, rationale from expense_flags order by created_at desc limit 5;"
```

Expected: a `structuring` flag at `critical` severity covering all three expenses.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: expense policy + structuring skills, flag_expense tool"
```

---

## Task 17: The approval gate

**Files:**
- Create: `agent/tools/request_human_review.ts`

**Interfaces:**
- Consumes: the verified approval shape from `docs/eve-api-notes.md` (Task 12).
- Produces: tool `request_human_review`, approval-gated for machine-initiated turns.

- [ ] **Step 1: Write the tool**

`agent/tools/request_human_review.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { getAgentDb } from "../lib/agent-db";

export default defineTool({
  description:
    "Escalate one or more expenses to a human approver. Call this when an " +
    "expense needs a decision you are not permitted to make.",
  inputSchema: z.object({
    expenseIds: z.array(z.string().uuid()).min(1),
    summary: z.string().min(20).describe(
      "What the human needs to know, in two sentences.",
    ),
    recommendation: z.enum(["approve", "reject", "investigate"]),
  }),

  /**
   * Turns started by the Database Webhook carry a machine principal, and those
   * pause for a human. A human talking to the agent directly does not get
   * prompted — they are already the human in the loop.
   */
  approval: ({ session }) =>
    session.auth?.current?.principalType === "machine"
      ? "user-approval"
      : "not-applicable",

  async execute({ expenseIds, summary, recommendation }) {
    const db = await getAgentDb();

    // Moving to needs_review is the only status change the agent is involved
    // in, and it is not an approval decision. If RLS refuses this too, the
    // agent still cannot proceed — which is the correct failure mode.
    const { data, error } = await db
      .from("expenses")
      .update({ status: "needs_review" })
      .in("id", expenseIds)
      .select("id");

    return {
      escalated: expenseIds.length,
      statusUpdated: data?.length ?? 0,
      blockedByPolicy: error ? error.message : null,
      summary,
      recommendation,
    };
  },
});
```

**Note the honesty in that return value.** The agent has no UPDATE policy, so `statusUpdated` will be `0` and `blockedByPolicy` may be set. That is not a bug to paper over — it is the demo, surfaced in the tool's own output. If you decide the agent *should* be able to set `needs_review`, add a narrow policy for exactly that transition in a new migration; do **not** widen the approval policy.

- [ ] **Step 2: Verify the gate fires for machine turns**

```bash
curl -sS -X POST http://127.0.0.1:3000/eve/v1/session \
  -H 'content-type: application/json' \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"message":"Review expense <demo id> and escalate it."}'
```

Attach to the stream. Expected: an `input.requested` event, and the session parked.

- [ ] **Step 3: Verify it does NOT fire for a human turn**

Repeat without the `x-webhook-secret` header (using `localDev()` auth). Expected: no approval prompt; the tool runs straight through.

- [ ] **Step 4: Resolve the approval using the verified shape**

Use exactly what you recorded in `docs/eve-api-notes.md`. Expected: the session resumes.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: request_human_review with principal-conditional approval gate"
```

---

## Task 18: The narration hook

**Files:**
- Create: `agent/hooks/steps.ts`

**Interfaces:**
- Produces: `agent_steps` rows for every runtime event. Consumed by Task 20's Realtime timeline.

- [ ] **Step 1: Write the hook**

`agent/hooks/steps.ts`:

```ts
import { defineHook } from "eve/hooks";
import { getAgentDb, getAgentOrgId } from "../lib/agent-db";

/** Human-readable one-liner per event type. */
function titleFor(event: { type: string; data?: unknown }): string {
  const data = (event.data ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "session.started":   return "Started reviewing";
    case "action.result":     return `Ran ${String(data.toolName ?? "a tool")}`;
    case "input.requested":   return "Waiting for a human";
    case "message.completed": return "Wrote a summary";
    case "turn.completed":    return "Finished";
    default:                  return event.type;
  }
}

/** Pull an expense id out of an event payload if one is present. */
function expenseIdFrom(event: { data?: unknown }): string | null {
  const json = JSON.stringify(event.data ?? {});
  const match = json.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return match ? match[0] : null;
}

export default defineHook({
  events: {
    async "*"(event, ctx) {
      const db = await getAgentDb();
      const orgId = await getAgentOrgId();

      // Retried turns emit fresh events with new ids, so key on meta.id and
      // let conflicts fall through rather than duplicating the timeline.
      await db.from("agent_steps").upsert(
        {
          id: event.meta.id,
          session_id: ctx.session.id,
          org_id: orgId,
          expense_id: expenseIdFrom(event),
          event_type: event.type,
          title: titleFor(event),
          detail: (event as { data?: unknown }).data ?? {},
        },
        { onConflict: "id", ignoreDuplicates: true },
      );
    },
  },
});
```

**Verify `event.meta.id` and `ctx.session.id` against `docs/eve-api-notes.md`.** If the hook payload differs, adjust — the shape matters more than the names.

- [ ] **Step 2: Verify steps are written**

Run any session, then:

```bash
pnpm supabase db execute --query "select event_type, title, created_at from agent_steps order by created_at limit 20;"
```

Expected: a chronological list starting with `session.started`.

- [ ] **Step 3: Verify idempotency**

Run the same session again and confirm the row count grows by the number of *new* events, with no duplicate ids:

```bash
pnpm supabase db execute --query "select count(*) total, count(distinct id) distinct_ids from agent_steps;"
```

Expected: `total` = `distinct_ids`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: hook mirroring runtime events into agent_steps"
```

---

## Task 19: Database Webhook → session bootstrap

**Files:**
- Create: `app/api/hooks/expense-submitted/route.ts`
- Create: `supabase/migrations/20260905000600_webhook.sql`

**Interfaces:**
- Consumes: `WEBHOOK_SECRET`, the `machineToken` AuthFn from Task 13.
- Produces: an `INSERT`/`UPDATE` on `expenses` to `submitted` starting an eve session.

- [ ] **Step 1: Write the bootstrap route**

`app/api/hooks/expense-submitted/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  if (request.headers.get("x-webhook-secret") !== process.env.WEBHOOK_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json();
  const record = payload?.record;
  if (!record?.id || record.status !== "submitted") {
    return NextResponse.json({ skipped: true });
  }

  const origin = request.nextUrl.origin;
  const response = await fetch(`${origin}/eve/v1/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": process.env.WEBHOOK_SECRET!,
    },
    body: JSON.stringify({
      message: `Review expense ${record.id}.`,
    }),
  });

  if (!response.ok) {
    return NextResponse.json(
      { error: "session start failed", detail: await response.text() },
      { status: 502 },
    );
  }

  return NextResponse.json({
    started: true,
    sessionId: response.headers.get("x-eve-session-id"),
  });
}
```

The secret is checked on the way in **and** forwarded on the way out — that second use is what gives the eve turn its `machine` principal, which is what makes the approval gate fire.

- [ ] **Step 2: Create the Database Webhook** *(manual — dashboard)*

Dashboard → Database → Webhooks → Create a new hook:

- Name: `expense-submitted`
- Table: `public.expenses`
- Events: `INSERT`, `UPDATE`
- Type: HTTP Request, `POST`
- URL: your deployed URL + `/api/hooks/expense-submitted` (see the note below)
- HTTP Headers: `x-webhook-secret` = your `WEBHOOK_SECRET`

**`pg_net` cannot reach `localhost`.** For local testing, expose your dev server with a tunnel (`ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`) and point the webhook at the tunnel URL. For the actual demo, point it at the Vercel deployment.

- [ ] **Step 3: Record the webhook in a migration for reproducibility**

`supabase/migrations/20260905000600_webhook.sql`:

```sql
-- Documents the Database Webhook created in the dashboard so the project can
-- be rebuilt from migrations. Reads its configuration from Vault so no secret
-- or environment-specific URL is committed.
--
-- Before applying, store both values:
--   select vault.create_secret('https://<your-app>.vercel.app', 'app_base_url');
--   select vault.create_secret('<your WEBHOOK_SECRET>',          'webhook_secret');

create or replace function public.notify_expense_submitted()
returns trigger language plpgsql security definer as $$
declare
  base_url text;
  secret   text;
begin
  if new.status <> 'submitted' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'submitted' then return new; end if;

  select decrypted_secret into base_url
    from vault.decrypted_secrets where name = 'app_base_url';
  select decrypted_secret into secret
    from vault.decrypted_secrets where name = 'webhook_secret';

  if base_url is null or secret is null then return new; end if;

  perform net.http_post(
    url     := base_url || '/api/hooks/expense-submitted',
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'x-webhook-secret', secret),
    body    := jsonb_build_object('record', to_jsonb(new))
  );
  return new;
end;
$$;

create trigger notify_expense_submitted
  after insert or update on expenses
  for each row execute function public.notify_expense_submitted();
```

If you create this trigger, **delete the dashboard webhook** — otherwise every submission starts two sessions.

- [ ] **Step 4: Verify end to end**

With the tunnel running and the webhook pointed at it:

```bash
pnpm supabase db execute --query "update expenses set status='submitted' where id='<a draft demo id>';"
```

Then:

```bash
pnpm supabase db execute --query "select session_id, title, created_at from agent_steps order by created_at desc limit 10;"
```

Expected: fresh rows within a few seconds. If nothing appears, check `select * from net._http_response order by created desc limit 5;` for the delivery status.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: Database Webhook bootstraps an eve session on submit"
```

---

## Task 20: Agent timeline and approval UI

**Files:**
- Create: `components/agent-timeline.tsx`, `components/approval-panel.tsx`, `app/api/approvals/[requestId]/route.ts`
- Modify: `app/expense/[id]/page.tsx`

**Interfaces:**
- Consumes: `agent_steps` Realtime; the verified approval shape from Task 12.
- Produces: beats 2, 7, and the visible half of beat 6.

- [ ] **Step 1: The Realtime timeline**

`components/agent-timeline.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { AgentStep } from "@/lib/types";

export function AgentTimeline({
  expenseId,
  initial,
}: {
  expenseId: string;
  initial: AgentStep[];
}) {
  const [steps, setSteps] = useState<AgentStep[]>(initial);

  useEffect(() => {
    const supabase = createBrowserSupabase();
    const channel = supabase
      .channel(`agent_steps:${expenseId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "agent_steps",
          filter: `expense_id=eq.${expenseId}`,
        },
        (payload) => {
          setSteps((prev) =>
            prev.some((s) => s.id === (payload.new as AgentStep).id)
              ? prev
              : [...prev, payload.new as AgentStep],
          );
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [expenseId]);

  return (
    <ol className="space-y-2 border-l-2 border-gray-200 pl-4">
      {steps.map((s) => (
        <li key={s.id} className="text-sm">
          <span className="font-medium">{s.title}</span>
          <span className="ml-2 text-xs text-gray-400">
            {new Date(s.created_at).toLocaleTimeString()}
          </span>
        </li>
      ))}
      {steps.length === 0 && (
        <li className="text-sm text-gray-500">No agent activity yet.</li>
      )}
    </ol>
  );
}
```

- [ ] **Step 2: The approval resolution route**

`app/api/approvals/[requestId]/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Resolve a paused eve approval.
 *
 * The status write itself is NOT done here by the agent — the caller performs
 * it under their own Supabase identity, so RLS decides whether they may.
 * This route only tells eve the human answered.
 *
 * The endpoint and body shape below must match docs/eve-api-notes.md.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await params;
  const { sessionId, decision, expenseIds } = await request.json();

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (decision === "approve" && Array.isArray(expenseIds)) {
    // Performed as the signed-in human. If they lack the role, RLS returns
    // zero rows and the threshold trigger may raise — both are correct.
    const { data, error } = await supabase
      .from("expenses")
      .update({ status: "approved" })
      .in("id", expenseIds)
      .select("id");

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (!data?.length) {
      return NextResponse.json(
        { error: "Your role does not permit approving these expenses." },
        { status: 403 },
      );
    }

    const { data: profile } = await supabase
      .from("profiles").select("org_id").eq("id", user.id).maybeSingle();

    await supabase.from("approvals").insert(
      data.map((e) => ({
        expense_id: e.id,
        org_id: profile!.org_id,
        approver_id: user.id,
        decision: "approved" as const,
      })),
    );
  }

  const eve = await fetch(
    `${request.nextUrl.origin}/eve/v1/session/${sessionId}/message`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-secret": process.env.WEBHOOK_SECRET!,
      },
      body: JSON.stringify({
        inputResponses: { [requestId]: { decision } },
      }),
    },
  );

  return NextResponse.json({ ok: eve.ok, resumed: eve.ok });
}
```

- [ ] **Step 3: The approval panel**

`components/approval-panel.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ApprovalPanel({
  sessionId,
  requestId,
  expenseIds,
  summary,
}: {
  sessionId: string;
  requestId: string;
  expenseIds: string[];
  summary: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/approvals/${requestId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, decision, expenseIds }),
    });
    if (!res.ok) setError((await res.json()).error ?? "Failed");
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="rounded border-2 border-amber-500 bg-amber-50 p-4">
      <h3 className="font-semibold">Awaiting human review</h3>
      <p className="mt-1 text-sm">{summary}</p>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button disabled={busy} onClick={() => decide("approve")}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50">
          Approve
        </button>
        <button disabled={busy} onClick={() => decide("deny")}
          className="rounded border px-4 py-2 text-sm disabled:opacity-50">
          Deny
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire both into the expense page**

In `app/expense/[id]/page.tsx`, fetch the steps and render the timeline. Add after the flags list:

```tsx
  const { data: steps } = await supabase
    .from("agent_steps").select("*")
    .eq("expense_id", id).order("created_at");

  const pending = (steps ?? []).find((s) => s.event_type === "input.requested");
```

and inside the first `<section>`, after the findings:

```tsx
        {pending && (
          <ApprovalPanel
            sessionId={pending.session_id}
            requestId={String((pending.detail as Record<string, unknown>).requestId)}
            expenseIds={[id]}
            summary={String(
              (pending.detail as Record<string, unknown>).summary ??
                "The agent needs a decision.",
            )}
          />
        )}

        <h2 className="pt-4 text-sm font-semibold uppercase text-gray-500">
          Agent activity
        </h2>
        <AgentTimeline expenseId={id} initial={steps ?? []} />
```

with the imports:

```tsx
import { AgentTimeline } from "@/components/agent-timeline";
import { ApprovalPanel } from "@/components/approval-panel";
```

**Adjust the `requestId` path** to match what you recorded in `docs/eve-api-notes.md` — the hook stores the raw event payload in `detail`, so the field may be nested.

- [ ] **Step 5: Verify the full loop in the browser**

1. Two browser windows: `dana@northwind.demo` (finance) in both, on the same expense page.
2. Submit a draft expense via SQL.
3. Watch timeline entries appear in **both** windows without a refresh.
4. When the approval panel appears, click Approve in one window.
5. Confirm the status flips to `approved` and the other window updates.

- [ ] **Step 6: Verify a non-approver is refused**

Sign in as `priya@northwind.demo` (employee) and click Approve. Expected: `Your role does not permit approving these expenses.` — from RLS, not from an `if` statement.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: Realtime agent timeline and RLS-enforced approval panel"
```

---

## Task 21: Reset script, MCP connection, deploy, rehearse

**Files:**
- Create: `scripts/reset.ts`, `agent/connections/supabase.ts`, `docs/RUNBOOK.md`

**Interfaces:**
- Produces: `pnpm reset`, a deployed Vercel project, and a rehearsal runbook.

- [ ] **Step 1: The reset script**

`scripts/reset.ts`:

```ts
import { createClient } from "@supabase/supabase-js";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function main() {
  await db.from("agent_steps").delete().neq("id", "");
  await db.from("expense_flags").delete().neq("id",
    "00000000-0000-0000-0000-000000000000");
  await db.from("approvals").delete().neq("id",
    "00000000-0000-0000-0000-000000000000");
  await db.from("receipt_extractions").delete().neq("expense_id",
    "00000000-0000-0000-0000-000000000000");

  const { data } = await db
    .from("expenses")
    .update({ status: "draft" })
    .in("status", ["submitted", "needs_review", "approved"])
    .ilike("description", "Meridian Consulting — engagement%")
    .select("id, amount_cents");

  console.log("Reset. Demo expenses back to draft:");
  data?.forEach((r) => console.log(`  ${r.id}  $${r.amount_cents / 100}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify reset**

```bash
set -a && source .env.local && set +a && pnpm reset
pnpm supabase db execute --query "select count(*) from agent_steps;"
```

Expected: three demo ids printed; `agent_steps` count = 0.

- [ ] **Step 3: Add the Supabase MCP connection**

`agent/connections/supabase.ts`:

```ts
import { defineMcpClientConnection } from "eve/connections";

/**
 * The first-party Supabase MCP connection.
 *
 * Deliberately NOT used for the review path. MCP authenticates with a
 * management token that bypasses RLS — which would make every security claim
 * in this repo false. The agent's own queries go through agent/lib/agent-db.ts
 * as an ordinary RLS principal.
 *
 * This is here for project-management work: inspecting schema, listing
 * migrations, checking logs.
 */
export default defineMcpClientConnection({
  url: "https://mcp.supabase.com/mcp",
  description: "Supabase project management. Not used for expense queries.",
});
```

That comment is the point of showing this file on stage.

- [ ] **Step 4: Deploy to Vercel**

```bash
pnpm dlx vercel link
pnpm dlx vercel env add NEXT_PUBLIC_SUPABASE_URL production
pnpm dlx vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
pnpm dlx vercel env add SUPABASE_SERVICE_ROLE_KEY production
pnpm dlx vercel env add AGENT_EMAIL production
pnpm dlx vercel env add AGENT_PASSWORD production
pnpm dlx vercel env add WEBHOOK_SECRET production
pnpm dlx vercel deploy --prod
```

- [ ] **Step 5: Repoint the Database Webhook at production**

Update the Vault secret so the trigger targets the deployed URL:

```bash
pnpm supabase db execute --query "select vault.update_secret((select id from vault.secrets where name='app_base_url'), 'https://<your-app>.vercel.app');"
```

- [ ] **Step 6: Write the runbook**

`docs/RUNBOOK.md`:

```md
# Demo runbook

## 15 minutes before

1. `pnpm reset`
2. Open two windows, both signed in as dana@northwind.demo:
   - Window A: SQL editor, `update expenses set status='submitted' where id='<id1>';` typed but NOT run
   - Window B: /expense/<id1>
3. Font size up. Hide bookmarks. Notifications off.
4. Warm the deployment — load /review once so the first function isn't cold.

## The eight beats

1. Run the INSERT in window A. Say nothing for five seconds.
2. Switch to window B. Steps appear. → show `agent/tools/`
3. Receipt renders. → show the Storage policy
4. → show `agent/skills/expense-policy.md`. Read the last section aloud.
5. Structuring flag covers all three rows. → show the join
6. "Awaiting human review." **Walk away from the laptop.** Talk about durable
   execution for two minutes. Nothing on screen changes. That is the point.
7. Approve. Amount flips. → show the Realtime subscription
8. Sign in as kit@acme.demo, open the same URL → 404.
   Then: "approve this expense" in the agent chat → it can't. → show the
   absent UPDATE policy and `pnpm test:rls` test 5.

## If it breaks

- No steps appear → check `select * from net._http_response order by created desc limit 5;`
- Approval never resolves → the fallback is to approve in the UI and send the
  agent a follow-up message
- Model wanders → `pnpm reset` and re-run; the seed is deterministic
- Total failure → play the recorded session capture
```

- [ ] **Step 7: Full rehearsal against production**

Run all eight beats end to end against the deployed URL. Time it. Then `pnpm reset` and do it again.

- [ ] **Step 8: Record a fallback capture**

Screen-record one clean run. If the conference network fails, this is the demo.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: reset script, MCP connection, deploy config, runbook"
```

---

## Self-review notes

**Spec coverage:** §3 architecture → Tasks 1, 2, 19; §4 schema → Tasks 3, 5, 6; §4 RLS → Tasks 4, 9; §5 agent layout → Tasks 13–18; §6 stage cut → Tasks 11, 20, 21; §7 in-scope → all; §7 out-of-scope (pgvector, presence, notifications) → correctly absent.

**Deliberate deviations from the spec:**
1. `current_profile()` replaced by JWT claims (documented at the top of this plan).
2. `read_receipt` split into `read_receipt` + `record_extraction` — one tool returning a URL for the model to look at, one recording the result. A single tool cannot both return an image for inspection and receive the model's reading of it.
3. `request_human_review` surfaces `blockedByPolicy` in its output instead of hiding the RLS refusal. Honest, and it is the demo.

**Spec §9 (approval carries the approver's credential):** still deferred. Task 20 implements the committed path — the app writes as the human. Revisit only if Tasks 12–20 are done early.
