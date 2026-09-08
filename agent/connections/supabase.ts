import { defineMcpClientConnection } from "eve/connections";

/**
 * The first-party Supabase MCP connection.
 *
 * DELIBERATELY NOT USED FOR EXPENSE REVIEW. This file is here to be read, and
 * the reason it is unused is the most important thing in the repository.
 *
 * `eve add connection/supabase` is the officially blessed way to give an agent
 * access to Supabase, and it works well — for what it is for. It authenticates
 * with a project management token brokered through Vercel Connect, and exposes
 * management operations: inspect schema, list migrations, read logs, run SQL.
 *
 * A management token bypasses Row Level Security.
 *
 * So an agent reviewing expenses through this connection could read every
 * tenant's data and approve anything it liked, and every security claim this
 * project makes would be theatre — a system prompt politely asking a model not
 * to do something it is entirely capable of doing.
 *
 * Instead, agent/lib/agent-db.ts signs the agent in as an ordinary Supabase
 * user with `user_role: 'agent'` in its JWT, and Postgres constrains it the
 * same way it constrains Dana or Priya. It can read its org's expenses. It
 * cannot approve one, because no policy permits it.
 *
 * THE POINT ON STAGE
 *
 * The question is not "can the agent reach Supabase" — this file answers that
 * in six lines. The question is "as whom", and that is the one worth asking of
 * any agent touching production data.
 *
 * Setup, if you do want the management surface for schema work:
 *
 *   vercel link
 *   vercel connect create supabase
 *   vercel env pull
 */
export default defineMcpClientConnection({
  url: "https://mcp.supabase.com/mcp",
  description:
    "Supabase project management: schema, migrations, logs. NOT used for " +
    "expense review — that goes through the agent's own RLS-bound session.",
});
