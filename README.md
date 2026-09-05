# eve-the-accountant

A small multi-tenant expense-and-approvals app where an AI agent works the review queue alongside the humans.

Built to demonstrate the integration between [Supabase](https://supabase.com) and [Vercel eve](https://eve.dev).

> **Supabase is what the product is built on. eve is what the agent is built on. They share the same Postgres.**

The agent isn't a chatbot bolted onto the side. It reads and writes the same rows humans do, through the same Row Level Security policies, and its changes reach every open browser through the same Realtime channel.

## The point

> **Soft rules live in eve. Hard rules live in Postgres.**

`agent/skills/expense-policy.md` is markdown the agent *reads*. It guides behavior — and a determined prompt can talk a model out of guidance.

The RLS policy is four lines of SQL that *constrain* behavior. The model cannot reach it.

The agent has **no RLS policy permitting `UPDATE` on `expenses.status`**. It can investigate, flag, and recommend. It cannot approve. Not because we asked it nicely in a system prompt — because Postgres will refuse.

## Status

🚧 In development. See [the design spec](docs/specs/2026-09-05-eve-the-accountant-design.md) for architecture, schema, RLS policies, and scope.

## Stack

| | |
|---|---|
| Database, Auth, Storage, Realtime | Supabase |
| Agent runtime | Vercel eve |
| App | Next.js (App Router) |
| Hosting | Vercel — one project, `withEve()` |

## License

MIT
