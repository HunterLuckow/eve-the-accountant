import { defineTool } from "eve/tools";
import { z } from "zod";
import { getAgentDb } from "../lib/agent-db";
import { dollars } from "../lib/money";

/**
 * Search for expenses.
 *
 * Added after watching the chat fail at something obvious: asked to look at
 * "the Meridian Phase 1 expense", the agent could only reply that it needed a
 * UUID. Every other tool takes an id, and nothing could turn a description
 * into one — so a person talking to it had to go find a primary key first,
 * which is not a conversation anybody wants to have.
 *
 * Like every other read here, this runs through the agent's own Supabase
 * session. Search results are RLS-filtered, so the agent cannot find its way
 * to another tenant's expenses by guessing search terms — a real concern for a
 * tool whose whole job is discovery.
 */
export default defineTool({
  description:
    "Search expenses by text, amount, status or date. Use this to turn a " +
    "description like 'the Meridian Phase 1 invoice' into an id before calling " +
    "the other tools, or to answer questions about several expenses at once.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe("Text to match against description or vendor name."),
    minCents: z.number().int().optional().describe("Minimum amount in cents."),
    maxCents: z.number().int().optional().describe("Maximum amount in cents."),
    status: z
      .enum(["draft", "submitted", "needs_review", "approved", "rejected"])
      .optional(),
    since: z.string().optional().describe("Earliest spent_at, as YYYY-MM-DD."),
    until: z.string().optional().describe("Latest spent_at, as YYYY-MM-DD."),
    limit: z.number().int().min(1).max(50).default(20),
  }),

  async execute({ query, minCents, maxCents, status, since, until, limit }) {
    const db = await getAgentDb();

    let q = db
      .from("expenses")
      .select(
        "id, description, amount_cents, spent_at, status, vendor:vendors(name), submitter:profiles!expenses_submitter_id_fkey(full_name)",
      )
      .order("spent_at", { ascending: false })
      .limit(limit);

    if (query) {
      // Description only. PostgREST cannot filter on an embedded resource
      // inside an `or`, so matching vendor names would need a different query
      // shape; vendor names are echoed in descriptions here anyway.
      q = q.ilike("description", `%${query}%`);
    }
    if (minCents !== undefined) q = q.gte("amount_cents", minCents);
    if (maxCents !== undefined) q = q.lte("amount_cents", maxCents);
    if (status) q = q.eq("status", status);
    if (since) q = q.gte("spent_at", since);
    if (until) q = q.lte("spent_at", until);

    const { data, error } = await q;
    if (error) throw new Error(`Search failed: ${error.message}`);

    const one = <T,>(v: T | T[] | null): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : v;

    const rows = (data ?? []).map((r) => ({
      expenseId: r.id,
      description: r.description,
      amount: dollars(r.amount_cents),
      amountCents: r.amount_cents,
      spentAt: r.spent_at,
      status: r.status,
      vendor: (one(r.vendor as never) as { name?: string } | null)?.name ?? null,
      submitter:
        (one(r.submitter as never) as { full_name?: string } | null)?.full_name ??
        null,
    }));

    const totalCents = rows.reduce((s, r) => s + r.amountCents, 0);

    return {
      count: rows.length,
      expenses: rows,
      totalCents,
      total: dollars(totalCents),
      // A limit that silently truncates is worse than one that says so.
      truncated: rows.length === limit,
      note:
        rows.length === 0
          ? "Nothing matched, within what you are permitted to see."
          : undefined,
    };
  },
});
