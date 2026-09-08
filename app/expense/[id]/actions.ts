"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * A human decides an expense.
 *
 * DELIBERATELY SEPARATE FROM THE eve APPROVAL PANEL. Two different things get
 * conflated otherwise:
 *
 *   The approval panel answers "may the agent escalate this?" — a question
 *   about the agent's action, resolved inside eve.
 *
 *   This answers "is this expense approved?" — a question about the business,
 *   resolved in Postgres, by a person, under their own identity.
 *
 * Note there is no role check below. The UPDATE runs as the signed-in user, so
 * expenses_update_approver decides whether it touches anything, and the
 * threshold trigger decides whether the amount is within their authority. An
 * employee calling this gets zero rows back; a manager over their limit gets a
 * sentence explaining why.
 *
 * This is also the action the agent structurally cannot perform. Same table,
 * same statement — different principal, different outcome.
 */
export async function decideExpense(
  expenseId: string,
  decision: "approved" | "rejected",
  note = "",
) {
  const supabase = await createServerSupabase();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  const { data: updated, error } = await supabase
    .from("expenses")
    .update({ status: decision })
    .eq("id", expenseId)
    .select("id, org_id");

  if (error) {
    // The threshold trigger raises with a readable message; surface it rather
    // than a generic failure. This is the difference between "nothing
    // happened" and "route it to finance".
    return { ok: false as const, error: error.message };
  }

  if (!updated?.length) {
    // RLS matched nothing. Silent by design — see the Task 3 notes.
    return {
      ok: false as const,
      error: "Your role does not permit deciding this expense.",
    };
  }

  const { error: auditError } = await supabase.from("approvals").insert({
    expense_id: expenseId,
    org_id: updated[0].org_id,
    approver_id: user.id,
    decision,
    note,
  });

  revalidatePath(`/expense/${expenseId}`);
  revalidatePath("/review");

  return {
    ok: true as const,
    // The status changed even if the audit insert failed; say so rather than
    // reporting clean success.
    auditWarning: auditError?.message,
  };
}
