# eve-the-accountant

A multi-tenant expense-approvals app where an AI agent works the review queue
alongside the humans — and **cannot approve anything**.

Built to demonstrate the seam between [Supabase](https://supabase.com) and
[Vercel eve](https://eve.dev).

> **Supabase is what the product is built on. eve is what the agent is built
> on. They share the same Postgres.**

---

## The idea

> **Soft rules live in eve. Hard rules live in Postgres.**

`agent/skills/expense-policy.md` is markdown the agent reads. It says the agent
must not approve expenses. That is *advice* — a determined prompt can talk a
model out of advice.

The agent also has **no RLS policy permitting `UPDATE` on `expenses.status`**.
That is not advice. Asked to approve an expense, in plain English, by an
authenticated user, it produces:

```
PATCH /rest/v1/expenses?status=eq.draft  {"status":"approved"}  →  []
```

`200 OK`. Zero rows. No error, no guardrail, no refusal — just an absent grant.

`pnpm test:rls` asserts it, and a mutation test confirms the assertion fails
when the grant is added back.

---

## What the agent does

An expense is submitted. A Database Webhook wakes the agent, which reads the
receipt, checks the policy, looks for related charges, and finds this:

| Invoice | Amount | Status |
|---|---|---|
| MC-2291 Phase 1 — Discovery | $3,940.00 | submitted |
| MC-2292 Phase 2 — Architecture | $3,875.00 | draft |
| MC-2293 Phase 3 — Handover | $3,990.00 | draft |

Three same-day charges to one vendor, each just under a $4,000 approval
threshold. **$11,805 combined.** A reviewer working a queue sees one row at a
time, so the pattern only exists across rows.

The agent records one finding across all three — including the two still in
draft, which is when it is still preventable — escalates to a human, and
**stops**, parked durably in Postgres until someone answers.

---

## What constrains it

Four boundaries, none of which is a prompt:

| Boundary | Mechanism |
|---|---|
| Cannot approve or reject | no RLS `UPDATE` policy admits the agent |
| Cannot see other tenants | RLS, keyed on a JWT claim |
| Cannot reach the network | `web_fetch` / `web_search` overridden to refuse |
| Cannot upload a receipt | Storage RLS — it reads evidence, never writes it |

It authenticates as an **ordinary Supabase user** with `user_role: 'agent'` in
its JWT. Never the service role, which would bypass RLS and make every claim
above theatre.

---

## Stack

| | |
|---|---|
| Database, Auth, Storage, Realtime, Webhooks | Supabase |
| Agent runtime | Vercel eve |
| App | Next.js 16 (App Router) |
| Hosting | Vercel — one project, `withEve()` |

---

## Running it

```bash
pnpm install
cp .env.local.example .env.local     # fill in from your Supabase project
pnpm supabase link --project-ref <ref>
pnpm supabase db push
pnpm receipts                        # generate the demo invoices
pnpm seed                            # 2 orgs, 7 people, 128 expenses
pnpm dev
```

Sign in as `dana@northwind.demo` / `demo-password-1234`.

The Database Webhook needs a public URL — see [docs/DEPLOY.md](docs/DEPLOY.md).

### Checks

```bash
pnpm test:rls        # 16 pgTAP assertions, run against the linked project
pnpm check:agent     # 12 probes: what the agent can and cannot do to Postgres
pnpm check:auth      # 14 assertions on who may talk to the agent
pnpm check:tools     # 10 assertions that the tool surface is what it should be
```

`check:*` are model-free and run in seconds. `test:rls` wraps in a transaction
and rolls back, including the pgTAP extension itself.

---

## Documentation

| | |
|---|---|
| [docs/specs/](docs/specs/) | the design, and why the demo is shaped this way |
| [docs/plans/](docs/plans/) | the 21-task implementation plan |
| [docs/two-integrations.md](docs/two-integrations.md) | why the official Supabase MCP connection builds this app but cannot run it |
| [docs/eve-api-notes.md](docs/eve-api-notes.md) | eve 0.51.1 API surface, verified against the installed package — including two places the published docs are wrong |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | the eight stage beats, and what to do when they break |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Vercel + webhook wiring |

Migrations under `supabase/migrations/` are commented at length; several
record traps worth knowing about, including a privilege escalation found and
fixed during the build.

## License

MIT
