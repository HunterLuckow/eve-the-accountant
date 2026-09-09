import { defineTool } from "eve/tools";
import { z } from "zod";
import { getAgentDb, getAgentOrgId } from "../lib/agent-db";
import { dollars } from "../lib/money";

/**
 * Records a finding.
 *
 * This is the agent's entire output. It cannot approve, reject, or change an
 * amount; what it can do is write down what it noticed, attributably, in the
 * same table a human reviewer writes to. `created_by` distinguishes them —
 * findings live together rather than in a separate "AI" ghetto, because a
 * finding is a finding regardless of who noticed it.
 *
 * ONE FINDING, MANY EXPENSES
 *
 * A structuring pattern is a statement about a SET of charges, not about any
 * one of them. Passing several ids writes one row per expense sharing the same
 * rationale and evidence, so the finding shows up on every expense involved —
 * including siblings still in draft, which is exactly when it is most useful.
 */
export default defineTool({
  description:
    "Record a finding against one or more expenses. Use ONE call per finding, " +
    "listing every expense it covers. A split-transaction pattern is a single " +
    "finding across several expenses, not several separate findings.",
  inputSchema: z.object({
    expenseIds: z
      .array(z.string().uuid())
      .min(1)
      .describe("Every expense this finding covers."),
    kind: z.enum([
      "over_threshold",
      "structuring",
      "duplicate",
      "missing_receipt",
      "policy_violation",
    ]),
    severity: z.enum(["info", "warn", "critical"]).default("warn"),
    rationale: z
      .string()
      .min(20)
      .describe(
        "What you found, in one or two sentences, for a busy reviewer who has " +
          "not seen the other expenses. Describe the PATTERN — same vendor, " +
          "same day, sequential invoices, each under the threshold — and name " +
          "individual amounts where they help. Do not state a combined total: " +
          "one is computed from the expenses you pass here and appended below " +
          "your text, so any total you quote from elsewhere describes a " +
          "different set and will disagree with it.",
      ),
    evidence: z
      .record(z.string(), z.unknown())
      .default({})
      .describe("Supporting figures: totals, thresholds, invoice numbers."),
  }),

  async execute({ expenseIds, kind, severity, rationale, evidence }) {
    const db = await getAgentDb();
    const orgId = await getAgentOrgId();

    // Only flag what is actually visible. RLS would reject the rest anyway,
    // but failing the whole call because one id was out of scope would be
    // worse than flagging what we can and saying so.
    const { data: visible, error: readErr } = await db
      .from("expenses")
      .select("id, amount_cents, description")
      .in("id", expenseIds);

    if (readErr) throw new Error(`Could not read expenses: ${readErr.message}`);
    if (!visible?.length) {
      throw new Error("None of those expenses are visible to you.");
    }

    const missing = expenseIds.filter((id) => !visible.some((e) => e.id === id));

    const combinedCents = visible.reduce((sum, e) => sum + e.amount_cents, 0);

    /**
     * Append the arithmetic rather than trusting the prose.
     *
     * A finding is evidence a human acts on, so its numbers are computed from
     * exactly the rows being flagged, here, and appended. The model explains;
     * Postgres counts.
     *
     * This exists because of a real failure, and the failure was not the one it
     * looked like. A production run produced a rationale reading "Combined
     * $11,847.00" three lines above "Computed: … = $11,805.00". The obvious
     * reading — the model cannot add — was wrong. $11,847.00 was
     * find_related_expenses' own `combinedCents`, which summed everything in a
     * 14-day window including an unrelated $42.00 charge; $11,805.00 was the
     * three expenses actually flagged. Two correct numbers for two different
     * sets, and the tools were the ones disagreeing.
     *
     * find_related_expenses now returns `windowTotalCents` and
     * `sameDayTotalCents` instead of one ambiguous "combined". A number a model
     * will quote has to be unambiguous about what it counts — and when output
     * looks like a model error, check what the tools actually handed it first.
     */
    const arithmetic =
      visible.length > 1
        ? `\n\nComputed: ${visible
            .map((e) => dollars(e.amount_cents))
            .join(" + ")} = ${dollars(combinedCents)} across ${visible.length} expenses.`
        : "";

    const { data: written, error } = await db
      .from("expense_flags")
      .insert(
        visible.map((e) => ({
          expense_id: e.id,
          org_id: orgId,
          kind,
          severity,
          rationale: rationale.trim() + arithmetic,
          evidence: {
            ...evidence,
            coversExpenseIds: visible.map((v) => v.id),
            combinedCents,
          },
          created_by: "agent" as const,
        })),
      )
      .select("id, expense_id");

    if (error) throw new Error(`Could not record finding: ${error.message}`);

    return {
      recorded: written.length,
      expenseIds: visible.map((e) => e.id),
      kind,
      severity,
      coveredExpenses: visible.map((e) => ({
        id: e.id,
        description: e.description,
        amount: dollars(e.amount_cents),
      })),
      combinedAmount: dollars(combinedCents),
      notVisible: missing.length ? missing : undefined,
      note:
        "The finding is now visible to every human who can see these expenses. " +
        "It does not change any expense's status — call request_human_review if " +
        "a decision is needed.",
    };
  },
});
