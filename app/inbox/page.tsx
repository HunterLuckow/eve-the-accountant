import { createServerSupabase } from "@/lib/supabase/server";
import { AppNav } from "@/components/app-nav";
import { ExpenseTable } from "@/components/expense-table";
import { dollars } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Every expense the signed-in user can see.
 *
 * There is no `.eq("submitter_id", user.id)` here and no role branch. The
 * query is `select * from expenses`; RLS decides what that means for whoever
 * is asking. Employees get their own, managers add their reports', finance
 * gets the org.
 */
export default async function InboxPage() {
  const supabase = await createServerSupabase();

  const { data: rows } = await supabase
    .from("expenses")
    .select("id, spent_at, description, amount_cents, status, submitter:profiles!expenses_submitter_id_fkey(full_name)")
    .order("spent_at", { ascending: false })
    .limit(200);

  const expenses = (rows ?? []).map((r) => ({
    ...r,
    submitter: Array.isArray(r.submitter) ? r.submitter[0] : r.submitter,
  }));

  const drafts = expenses.filter((e) => e.status === "draft");
  const total = expenses.reduce((s, e) => s + e.amount_cents, 0);

  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold">My expenses</h1>
            <p className="mt-1 text-sm text-gray-500">
              {expenses.length} visible · {dollars(total)} total
            </p>
          </div>
          {drafts.length > 0 && (
            <p className="text-sm text-amber-700">
              {drafts.length} draft{drafts.length > 1 ? "s" : ""} not yet submitted
            </p>
          )}
        </header>

        <ExpenseTable
          rows={expenses}
          showSubmitter
          empty="No expenses are visible to you."
        />
      </main>
    </>
  );
}
