import { defineTool } from "eve/tools";
import { z } from "zod";
import { getAgentDb } from "../lib/agent-db";
import { dollars } from "../lib/money";

/**
 * Escalates expenses to a human, and pauses until one answers.
 *
 * This is the beat the whole demo is built around, so it is worth being
 * precise about what is actually being approved.
 *
 * Escalation is not free. Moving an expense to `needs_review` takes it off the
 * routine manager-approval path and freezes it pending finance. If the agent
 * is wrong, it has manufactured work and delayed a legitimate payment. That is
 * a consequential enough action to be worth a person's assent — and it is the
 * MOST consequential thing this agent can do, because approving is not
 * available to it at all.
 *
 * TWO GATES, BOTH ENFORCED OUTSIDE THE MODEL
 *
 *   request:  pause only when the turn was started by a machine. A human
 *             talking to the agent directly is already the human in the loop
 *             and should not be asked to approve their own request.
 *
 *   response: only a manager or finance may answer. eve authenticates the
 *             responder itself and hands us their SessionAuthContext, so this
 *             checks a verified identity rather than a claim in a message.
 *             A rejection leaves the request PENDING — an unauthorised click
 *             does not consume the gate.
 *
 * And underneath both, RLS: the escalation itself is the single state
 * transition the agent is permitted (submitted -> needs_review), granted in
 * 20260905193457_agent_escalation.sql. Everything else about an expense is
 * beyond it.
 */
export default defineTool({
  description:
    "Escalate one or more expenses to a human reviewer, with a summary of what " +
    "you found. Use this when an expense needs a decision. You cannot make " +
    "that decision yourself.",
  inputSchema: z.object({
    expenseIds: z.array(z.string().uuid()).min(1),
    summary: z
      .string()
      .min(20)
      .describe("Two sentences telling the reviewer what they need to know."),
    recommendation: z
      .enum(["approve", "reject", "investigate"])
      .describe("What you would do. The human decides; this is advice."),
  }),

  approval: {
    /**
     * `ctx` extends SessionContext, so the caller of the current turn is at
     * ctx.session.auth.current — populated by agent/channels/eve.ts.
     */
    request: ({ session }) =>
      session.auth.current?.principalType === "machine"
        ? "user-approval"
        : "not-applicable",

    /**
     * `responder` is whoever authenticated when answering — verified by eve,
     * not asserted by the client. `attributes.user_role` is carried through
     * from their Supabase JWT claims by the supabaseUser AuthFn.
     */
    response: ({ responder }) => {
      const one = (v: string | readonly string[] | undefined) =>
        Array.isArray(v) ? v[0] : (v as string | undefined);

      const roleName = one(responder.attributes?.user_role);

      if (roleName === "manager" || roleName === "finance") {
        return { status: "allowed" as const };
      }

      // Name the person, not their primary key. principalId is a UUID, and
      // this string is rendered to whoever was refused — telling somebody
      // "186cfa41-... is employee" is not a message, it is a database row.
      const who = one(responder.attributes?.email) ?? responder.principalId;

      return {
        status: "rejected" as const,
        reason:
          `Only a manager or finance may resolve an escalation. ` +
          `${who} is ${roleName ? `an ${roleName}` : "not recognised"}. ` +
          `The request stays open for someone who is.`,
      };
    },
  },

  async execute({ expenseIds, summary, recommendation }) {
    const db = await getAgentDb();

    const { data: before, error: readErr } = await db
      .from("expenses")
      .select("id, description, amount_cents, status")
      .in("id", expenseIds);
    if (readErr) throw new Error(`Could not read expenses: ${readErr.message}`);
    if (!before?.length) throw new Error("None of those expenses are visible to you.");

    // The agent's one permitted transition. Drafts are excluded by the policy's
    // USING clause — they have not been submitted, so there is nothing to
    // escalate yet.
    const { data: escalated, error } = await db
      .from("expenses")
      .update({ status: "needs_review" })
      .in("id", expenseIds)
      .select("id, description, amount_cents");

    const stillDraft = before.filter((e) => e.status === "draft");

    return {
      expenseIds: before.map((e) => e.id),
      escalated: escalated?.length ?? 0,
      escalatedExpenses: (escalated ?? []).map((e) => ({
        id: e.id,
        description: e.description,
        amount: dollars(e.amount_cents),
      })),
      // Honest about what could not be moved, and why.
      notEscalated: stillDraft.length
        ? {
            count: stillDraft.length,
            reason:
              "Still in draft. An expense must be submitted before it can be " +
              "escalated; the finding is recorded against them and will be " +
              "visible when they are.",
            expenses: stillDraft.map((e) => e.description),
          }
        : undefined,
      blockedByPolicy: error ? error.message : undefined,
      combinedAmount: dollars(before.reduce((s, e) => s + e.amount_cents, 0)),
      summary,
      recommendation,
      note:
        "A human now has to decide. You cannot approve or reject, and should " +
        "not imply that the matter is settled.",
    };
  },
});
