# eve-the-accountant — Design

**Date:** 2026-09-05
**Status:** Approved for implementation planning
**Purpose:** Personal learning project + conference demo (5–10 min stage slot)

---

## 1. Thesis

> **Supabase is what the product is built on. eve is what the agent is built on. They share the same Postgres.**

The agent is not a chatbot bolted onto the side of an app. It is another actor in the data model — it reads and writes the same rows humans do, through the same RLS policies, and its changes reach every open browser through the same Realtime channel.

The corollary, and the line the talk is built around:

> **Soft rules live in eve. Hard rules live in Postgres.**

`agent/skills/expense-policy.md` is markdown the agent *reads* — it guides behavior, and a determined prompt can talk the model out of it. The RLS policy is four lines of SQL that *constrain* behavior — the model cannot reach it. One is advice. The other is physics.

The demo proves this literally: **the agent has no RLS policy permitting `UPDATE` on `expenses.status`.** It can investigate, it can flag, it can recommend. It cannot approve. Not because we asked it nicely in the system prompt, but because Postgres will refuse.

---

## 2. The product

**eve-the-accountant** is a small multi-tenant expense-and-approvals app. Employees submit expenses with receipts. Managers and finance review them. An eve agent works the review queue alongside the humans: it reads receipts, checks each expense against the written policy, flags problems, and escalates what it cannot resolve.

### Roles

| Role | Can see | Can do |
|---|---|---|
| `employee` | Own expenses | Submit, edit while `draft` |
| `manager` | Own + direct reports' expenses | Approve up to org threshold |
| `finance` | All expenses in org | Approve any amount, override |
| **`agent`** | All expenses in org | Flag, annotate, recommend — **never** change status |

That last row is the whole demo.

### The scenario

Three receipts. Same vendor. Same afternoon. **$3,940, $3,875, $3,990** — each comfortably under the $4,000 threshold that triggers VP sign-off.

Reviewed one at a time in a queue, a human approves all three. The agent joins across rows, recognizes the pattern as structuring, flags all three as a single finding, and escalates to finance.

The agent's contribution is something the human workflow *structurally cannot* produce — not because humans are careless, but because the queue shows one row at a time.

---

## 3. Architecture

```
┌─ Supabase ────────────────────┐      ┌─ Vercel (single project) ─────┐
│                               │      │                               │
│  Postgres                     │      │  Next.js 15 (App Router)      │
│   ├─ expenses, flags, …       │      │   ├─ /inbox    employee       │
│   └─ RLS: employee|manager|   │      │   ├─ /review   queue + Realtime│
│           finance|agent       │      │   ├─ /expense/[id]            │
│                               │      │   └─ /api/hooks/expense-*     │
│  Auth (JWT, ES256/JWKS) ──────┼─────▶│        │                      │
│                               │      │  withEve() — same origin      │
│  Storage (receipts, private) ─┼─────▶│        │                      │
│                               │      │  agent/                       │
│  Database Webhook ────────────┼─────▶│   ├─ tools/    (4)            │
│    on INSERT expenses         │      │   ├─ skills/   (2 .md)        │
│                               │      │   ├─ hooks/steps.ts           │
│  Realtime ◀───────────────────┼──────┼───┴─ channels/eve.ts          │
│    on agent_steps, expenses   │      │                               │
└───────────────────────────────┘      └───────────────────────────────┘
```

**One Vercel project.** `withEve(nextConfig)` compiles the agent alongside the Next.js app, same origin, no CORS. `useEveAgent()` in the browser passes the logged-in user's Supabase access token via its `headers` callback.

**One Supabase project.** Postgres, Auth, Storage, Realtime, Database Webhooks.

### Data flow

1. **Submit.** Employee uploads a receipt to Storage and inserts an `expenses` row (as themselves, RLS-enforced).
2. **Trigger.** A Database Webhook on `INSERT INTO expenses WHERE status = 'submitted'` POSTs to `/api/hooks/expense-submitted` with a shared secret header. That route starts an eve session with a machine principal. `/eve/v1/session` is never publicly exposed.
3. **Investigate.** Agent tools query Postgres **as the agent identity**, under RLS.
4. **Narrate.** An eve hook mirrors every runtime event into `agent_steps`. Realtime pushes those rows to every open browser. The model is never asked to "log a step" — it happens automatically.
5. **Escalate.** The agent calls `request_human_review`, which is approval-gated (see §5). The session parks at `session.waiting`, durably, burning zero compute.
6. **Resolve.** A finance user reviews in the app and approves. **The app performs the status write under the finance user's own identity** — not the agent's. The approval is then resolved back to eve, and the agent resumes to write its audit note and close out.

Step 6 is the important one. The human's authority is what moves the row. The agent never borrows it.

---

## 4. Schema

Eight tables. `org_id` on everything that RLS touches.

```sql
orgs              (id, name, threshold_cents, policy_version)
profiles          (id → auth.users, org_id, full_name, role, manager_id)
vendors           (id, org_id, name, category)
expenses          (id, org_id, submitter_id, vendor_id, amount_cents, currency,
                   spent_at, description, status, receipt_path, created_at)
receipt_extractions (expense_id, merchant, total_cents, spent_at, line_items jsonb,
                   confidence, extracted_at)
expense_flags     (id, expense_id, org_id, kind, severity, rationale,
                   evidence jsonb, created_by, created_at)
approvals         (id, expense_id, approver_id, decision, note, decided_at)
agent_steps       (id, session_id, org_id, expense_id, event_type, title,
                   detail jsonb, created_at)
```

`expenses.status` ∈ `draft | submitted | needs_review | approved | rejected`

`expense_flags.kind` ∈ `over_threshold | structuring | duplicate | missing_receipt | policy_violation`

`expense_flags.created_by` ∈ `agent | human` — so the UI can attribute findings, and so you can show the agent's rows sitting in the same table as everyone else's.

### Identity helper

Standard Supabase pattern — a `security definer` function to read the caller's role without recursive RLS on `profiles`:

```sql
create function public.current_profile()
returns profiles language sql stable security definer
set search_path = public
as $$ select * from profiles where id = auth.uid() $$;
```

### The policies that matter

```sql
-- Employees see their own.
create policy expenses_select_own on expenses for select
  using (submitter_id = auth.uid());

-- Managers see their reports'.
create policy expenses_select_reports on expenses for select
  using (exists (select 1 from profiles p
                 where p.id = expenses.submitter_id
                   and p.manager_id = auth.uid()));

-- Finance sees the whole org.
create policy expenses_select_finance on expenses for select
  using (org_id = (select org_id from current_profile())
     and (select role from current_profile()) = 'finance');

-- The agent sees the whole org, read-only.
create policy expenses_select_agent on expenses for select
  using (org_id = (auth.jwt() ->> 'org_id')::uuid
     and  auth.jwt() ->> 'principal_type' = 'agent');

-- Only humans with an approver role may move an expense's status.
create policy expenses_update_approver on expenses for update
  using ((select role from current_profile()) in ('manager','finance'));

-- Note the absence. There is no UPDATE policy for the agent principal.
-- This is the demo.
```

The manager-vs-finance threshold from §2 is **not** an RLS policy — RLS decides visibility and verb access, not business limits. A `before update` trigger enforces "managers may not approve above `orgs.threshold_cents`," which keeps the policies readable and puts the business rule where it can produce a useful error message.

### Agent identity

The agent authenticates with a JWT carrying `principal_type: 'agent'` and an `org_id` claim, verified by eve's `jwtEcdsa()` / `oidc()` helper against Supabase's JWKS. It is a first-class principal in the database — **not** the service role. Service role bypasses RLS entirely and would destroy the entire argument.

---

## 5. Agent layout

```
agent/
  instructions.md                 role, tone, escalation posture
  agent.ts                        defineAgent({ model, reasoning, limits })
  skills/
    expense-policy.md             ← the money slide
    structuring-detection.md      what a split-transaction pattern looks like
  tools/
    get_expense.ts                one expense + submitter + vendor
    read_receipt.ts               signed URL → vision extraction → receipt_extractions
    find_related_expenses.ts      same vendor/submitter/window — the structuring join
    flag_expense.ts               writes expense_flags
    request_human_review.ts       approval-gated  ← the gate
  hooks/
    steps.ts                      mirrors runtime events → agent_steps
  channels/
    eve.ts                        auth: [supabaseJwt(), machineToken(), localDev()]
  connections/
    supabase.ts                   Supabase MCP — shown in the interlude
```

### Approval policy

Approval is conditional on the caller, using `session.auth.current`:

```ts
approval: ({ session }) =>
  session.auth.current?.principalType === 'agent'
    ? 'user-approval'
    : 'not-applicable',
```

Machine-initiated turns require a human. Human-initiated turns don't. This is a genuine production pattern, not a demo contrivance.

On stage we flash the one-line form, `approval: always()`, because it reads instantly from the back row; the conditional above is what actually ships in the repo.

### The hook

`agent/hooks/steps.ts` subscribes to `"*"` and writes each event to `agent_steps`, keyed on `event.meta.id` with `on conflict do nothing` — retried turns emit fresh events, so idempotency matters.

This is why the dashboard is trustworthy: it reflects what the runtime *actually did*, not what the model claims it did.

### Why not the MCP connection for the hot path

The Supabase MCP server authenticates with a management token that bypasses RLS. Using it for the agent's queries would silently void the entire security story, and it adds round-trip latency on stage. We include `agent/connections/supabase.ts` as one file and show it during the talk — it's the officially blessed integration and belongs in the repo — but the investigation path uses purpose-built tools bound to the agent's RLS identity.

---

## 6. The stage cut

Eight beats, ~6 minutes, every snippet under ten lines.

| # | On screen | Snippet | ~Time |
|---|---|---|---|
| 1 | SQL editor: one `INSERT` | Database Webhook config | 30s |
| 2 | Review queue: row starts moving on its own | `agent/tools/` tree | 30s |
| 3 | The receipt image | Storage policy + signed URL | 30s |
| 4 | — | **`agent/skills/expense-policy.md`** | 45s |
| 5 | Three rows highlighted as one finding | the structuring join | 60s |
| 6 | "Awaiting human review" — **you walk away from the laptop** | `approval: always()` | 90s |
| 7 | Approve; amount flips state; second screen updates live | Realtime subscription | 45s |
| 8 | Three logins, three result sets — then tell the agent to approve it anyway, and watch Postgres refuse | the RLS policy | 60s |

Beat 6 is the strongest moment available in this stack: nothing happens on screen, deliberately, while you explain that the session is parked durably and costing nothing. Beat 8 is the thesis landing.

**Stage safety.** Database Webhooks run through `pg_net` and cannot reach `localhost` — rehearse against a deployed preview URL or a tunnel. Model output is pinned (fixed model, low reasoning effort, tight instructions, rehearsed seed row). `pnpm demo:reset` restores seed state between runs. A pre-recorded session capture is the fallback if the network dies.

---

## 7. Scope

### In (weekend)

- Schema, RLS across four roles, seed fixtures (~400 historical expenses, 3 orgs)
- Supabase Auth, three demo logins
- Storage: private receipt bucket, signed URLs, upload from the app
- Next.js: login, inbox, review queue, expense detail, approve action
- Realtime on `agent_steps` and `expenses`
- Database Webhook → session bootstrap route
- eve agent: 5 tools, 2 skills, 1 hook, 1 channel, 1 connection
- Approval gate, conditional on principal type
- **RLS policy tests** — the learning payoff, and they make beat 8 provable rather than asserted

### Out

- **pgvector** — "find similar past expenses" is nice, but it's the beat that least earns its runtime. Cut unless a day is left over.
- Presence, multi-currency, email/Slack notifications, receipt OCR training (model vision is enough), mobile layouts, real payment rails, org self-signup, tests beyond the RLS suite.

### Deliberately not attempted

- A custom Workflow world on Postgres (multi-day, high breakage risk, and the approval pause already wins the durability argument for free)
- Supabase branching (a CI story with no home in this narrative)

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| eve is in beta; APIs may drift from these docs | Pin the version at scaffold; verify `approval` vs `needsApproval` against the installed package before writing tools |
| Resolving approvals from a custom UI is the least-documented path | Build beat 7 against the documented `inputResponses` shape early, day 2 morning — it gates the climax |
| `pg_net` can't reach localhost | Rehearse against a deployed preview URL |
| Model nondeterminism on stage | Pinned model, tight instructions, rehearsed seed, recorded fallback |
| Weekend scope optimism | Beats 1–7 are the demo; beat 8 and the RLS test suite are the stretch. Cut pgvector first, then seed volume. |

---

## 9. Open question, deferred

The most elegant version of beat 7 is that the approval response *carries the approver's credential*, so the agent is momentarily lent authority it does not otherwise possess. That is a better story than having the app perform the write.

It depends on whether `inputResponses` can carry an arbitrary payload, which the docs do not confirm. **The app-performs-the-write design above is the committed path.** The credential-passing variant is a stretch goal to explore only if the primary path is working and time remains.
