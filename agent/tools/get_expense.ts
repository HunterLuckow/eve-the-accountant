import { defineTool } from "eve/tools";
import { z } from "zod";
import { getAgentDb } from "../lib/agent-db";

/**
 * Reads one expense with everything needed to judge it.
 *
 * The query carries no identity filter. It runs through the agent's own
 * Supabase session, so RLS decides whether the row is visible — the same
 * mechanism that governs Dana or Priya in the browser. If the agent is asked
 * about an expense in another tenant, this returns not-found, because for the
 * agent it genuinely does not exist.
 */
export default defineTool({
  description:
    "Fetch one expense with its submitter, vendor, any receipt extraction, and " +
    "any findings already recorded against it. Start here.",
  inputSchema: z.object({
    expenseId: z.string().uuid().describe("The expense to look at."),
  }),
  async execute({ expenseId }) {
    const db = await getAgentDb();

    const { data, error } = await db
      .from("expenses")
      .select(
        `id, amount_cents, currency, spent_at, description, status, receipt_path,
         submitter:profiles!expenses_submitter_id_fkey (id, full_name, role),
         vendor:vendors (id, name, category),
         extraction:receipt_extractions (merchant, total_cents, spent_at, confidence),
         flags:expense_flags (kind, severity, rationale, created_by, created_at)`,
      )
      .eq("id", expenseId)
      .maybeSingle();

    if (error) throw new Error(`Could not read expense: ${error.message}`);

    if (!data) {
      return {
        found: false,
        note:
          "No expense with that id is visible to you. It may belong to another " +
          "organisation, in which case you cannot see it and should say so.",
      };
    }

    const one = <T,>(v: T | T[] | null): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : v;

    const extraction = one(data.extraction as never);
    const org = await db
      .from("orgs")
      .select("threshold_cents, policy_version")
      .limit(1)
      .maybeSingle();

    return {
      found: true,
      expense: {
        id: data.id,
        amountCents: data.amount_cents,
        currency: data.currency,
        spentAt: data.spent_at,
        description: data.description,
        status: data.status,
        hasReceipt: !!data.receipt_path,
        submitter: one(data.submitter as never),
        vendor: one(data.vendor as never),
      },
      // Present only if read_receipt has already run against this expense.
      receiptExtraction: extraction,
      existingFindings: data.flags ?? [],
      // Supplied so the model compares against a real number rather than
      // recalling a threshold from the policy text.
      orgThresholdCents: org.data?.threshold_cents ?? null,
      policyVersion: org.data?.policy_version ?? null,
    };
  },
});
