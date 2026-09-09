import { defineTool } from "eve/tools";
import { z } from "zod";
import { getAgentDb } from "../lib/agent-db";

/**
 * The tool the whole demo turns on.
 *
 * A reviewer working a queue sees one expense at a time. Three charges of
 * $3,940, $3,875 and $3,990 each look unremarkable in isolation and each sits
 * comfortably under a $4,000 approval threshold. The pattern only exists
 * ACROSS rows, which is why a human reviewing them one by one approves all
 * three and a join catches it in one query.
 *
 * That is the honest version of what an agent adds here. Not "smarter than a
 * person" — able to ask a question the workflow does not put in front of one.
 *
 * The comparison is returned pre-computed (combinedCents vs thresholdCents)
 * so the model reasons about a fact rather than performing arithmetic it might
 * get wrong.
 */
export default defineTool({
  description:
    "Find other expenses from the same submitter and vendor within a date " +
    "window. Always call this, even when an expense looks fine on its own: " +
    "split-transaction patterns are invisible from a single row.",
  inputSchema: z.object({
    expenseId: z.string().uuid(),
    windowDays: z
      .number()
      .int()
      .min(0)
      .max(90)
      .default(3)
      .describe("Days either side of the expense date. Default 3."),
  }),
  async execute({ expenseId, windowDays }) {
    const db = await getAgentDb();

    const { data: base, error: baseErr } = await db
      .from("expenses")
      .select("id, org_id, submitter_id, vendor_id, spent_at, amount_cents")
      .eq("id", expenseId)
      .maybeSingle();

    if (baseErr) throw new Error(`Could not read expense: ${baseErr.message}`);
    if (!base) return { found: false, note: "That expense is not visible to you." };

    if (!base.vendor_id) {
      return {
        found: true,
        note: "This expense has no vendor, so sibling charges cannot be matched.",
        siblings: [],
      };
    }

    const shift = (days: number) => {
      const d = new Date(base.spent_at);
      d.setDate(d.getDate() + days);
      return d.toISOString().slice(0, 10);
    };

    const { data: siblings, error } = await db
      .from("expenses")
      .select("id, amount_cents, spent_at, description, status")
      .eq("submitter_id", base.submitter_id)
      .eq("vendor_id", base.vendor_id)
      .gte("spent_at", shift(-windowDays))
      .lte("spent_at", shift(windowDays))
      .order("spent_at")
      .order("amount_cents");

    if (error) throw new Error(`Could not search related expenses: ${error.message}`);

    const { data: org } = await db
      .from("orgs")
      .select("threshold_cents")
      .eq("id", base.org_id)
      .maybeSingle();

    const rows = siblings ?? [];
    const thresholdCents = org?.threshold_cents ?? null;
    const sum = (xs: typeof rows) => xs.reduce((t, r) => t + r.amount_cents, 0);

    /**
     * TWO TOTALS, BOTH NAMED FOR THEIR SCOPE.
     *
     * An earlier version returned a single `combinedCents` over the whole
     * window and put it next to `thresholdCents`. That is a trap: on a 14-day
     * window around the Meridian invoices it summed the three same-day phase
     * charges AND an unrelated $42.00 charge from the week before, producing
     * $11,847.00 — while flag_expense, summing only the three expenses the
     * model chose to flag, produced $11,805.00.
     *
     * Both numbers were correct. They described different sets. The model
     * reported the tool's figure faithfully and looked like it had failed at
     * arithmetic, when in fact the tool had handed it a total for a set nobody
     * was talking about.
     *
     * A number a model will quote must be unambiguous about what it counts.
     * Neither of these is called "combined".
     */
    const sameDay = rows.filter((r) => r.spent_at === base.spent_at);

    const windowTotalCents = sum(rows);
    const sameDayTotalCents = sum(sameDay);
    const largestSameDayCents = sameDay.reduce(
      (m, r) => Math.max(m, r.amount_cents),
      0,
    );

    return {
      found: true,
      expenseId,
      windowDays,
      baseSpentAt: base.spent_at,

      // Everything the query matched, for context.
      count: rows.length,
      siblings: rows,
      windowTotalCents,

      /**
       * The same-day cluster: the set structuring actually describes. This is
       * the one to quote when reporting a split-transaction pattern, and the
       * one flag_expense will recompute from the ids you pass it.
       */
      sameDayCount: sameDay.length,
      sameDayExpenseIds: sameDay.map((r) => r.id),
      sameDayTotalCents,

      thresholdCents,

      // Computed here so the model reads conclusions rather than doing
      // arithmetic. Deliberately scoped to the same-day cluster.
      analysis:
        thresholdCents === null
          ? null
          : {
              scope: "same-day charges only",
              multipleCharges: sameDay.length > 1,
              everySingleChargeUnderThreshold:
                sameDay.length > 0 && largestSameDayCents < thresholdCents,
              sameDayTotalExceedsThreshold: sameDayTotalCents > thresholdCents,
              othersInWindowNotCounted: rows.length - sameDay.length,
            },
    };
  },
});
