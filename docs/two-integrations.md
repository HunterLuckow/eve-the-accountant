# Two ways to connect an agent to Supabase

There are two, they are for different things, and conflating them is how an
agent demo quietly becomes untrue.

This project uses both — one to *build* the app, one to *run* it.

---

## Build time — the Supabase MCP server

This is the official integration, and it is one command:

```bash
eve add connection/supabase
```

which writes:

```ts
// agent/connections/supabase.ts
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.supabase.com/mcp",
  description: "Manage databases, authentication, and storage.",
});
```

```bash
vercel link
vercel connect create supabase   # OAuth, brokered by Vercel Connect
vercel env pull
```

It exposes the **management** surface: list tables, apply migrations, execute
SQL, read logs, run the security advisor, generate types, deploy edge
functions, fetch API keys.

**This is how this app was built.** The schema, the RLS policies, the
migrations, the `search_path` fix the advisor caught — all of it came from a
coding agent holding developer credentials against this project. That is the
integration working exactly as designed.

---

## Why it cannot be the runtime path

From [Supabase's own MCP documentation](https://supabase.com/docs/guides/getting-started/mcp):

> The MCP server operates under the context of your **developer permissions**,
> so you should **not give it to your customers or end users**. Instead, use it
> internally as a developer tool to help you build and test your applications.

That is not a caveat. It is the boundary.

An expense-review agent is not a developer assistant — it is a feature inside a
product, acting on behalf of one tenant, triggered by that tenant's data. It
needs an identity *in the application's model*, not in the developer's.

|  | Supabase MCP | This app's agent |
|---|---|---|
| Identity | your developer account | one org's `agent` principal |
| Tenancy | every project you own | one org, enforced |
| RLS | bypassed — `execute_sql` runs elevated | applies |
| Blast radius | your entire account | 123 rows |

Route expense review through MCP and
`execute_sql("update expenses set status='approved'")` succeeds. Every security
claim this repository makes would then be decoration.

---

## Run time — an ordinary Supabase principal

`agent/lib/agent-db.ts`. The agent signs in with an email and password against
the public anon key, exactly like a person:

```ts
const { data } = await client.auth.signInWithPassword({ email, password });
```

Supabase's custom access token hook stamps `org_id` and `user_role: 'agent'`
into the resulting JWT, and from there Postgres treats it like any other user.
It can read its org's expenses. It cannot approve one, because no policy
permits it.

There is no connector for this. It is fifty lines, and the fifty lines are the
point: **the question is not whether an agent can reach Supabase, but as whom.**

---

## Why this file is not in `agent/`

An earlier version of this project kept `agent/connections/supabase.ts` in
place, unauthenticated, with a long comment explaining that it was deliberately
unused.

That was a mistake. The file contributed no tools only because
`vercel connect create supabase` had never been run. Anyone running it — to do
some schema work, reasonably — would have silently handed the review agent
`execute_sql`, and with it the ability to bypass every policy in this repo.
Nothing would have looked different. No test would have failed.

A safety property that depends on someone not running a setup command is not a
safety property. The connection lives here, as documentation, where it cannot
be armed by accident.

If you do want the management surface in a production system, keep it on a
**separate agent** with its own credentials, and assert at startup that the
user-facing agent's tool list contains no `supabase__*` entries.
