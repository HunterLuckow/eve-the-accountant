import { createServerSupabase } from "@/lib/supabase/server";
import { AppNav } from "@/components/app-nav";
import { ExpenseTable } from "@/components/expense-table";
import { dollars } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The review queue — expenses waiting on a human.
 *
 * This is the screen the agent works alongside. When the agent flags an
 * expense, the flag count appears here for every reviewer at once (Realtime
 * lands in Task 20).
 *
 * An employee who opens this page sees an empty queue. Not because the route
 * is guarded, but because RLS shows them only their own expenses and their
 * own expenses are not pending anyone else's approval.
 */
export default async function ReviewPage() {
  const supabase = await createServerSupabase();

  const { data: rows } = await supabase
    .from("expenses")
    .select(
      "id, spent_at, description, amount_cents, status, submitter:profiles!expenses_submitter_id_fkey(full_name), expense_flags(id)",
    )
    .in("status", ["submitted", "needs_review"])
    .order("created_at", { ascending: false });

  const queue = (rows ?? []).map((r) => ({
    ...r,
    submitter: Array.isArray(r.submitter) ? r.submitter[0] : r.submitter,
    flag_count: (r.expense_flags as unknown[] | null)?.length ?? 0,
  }));

  const flagged = queue.filter((e) => e.flag_count > 0);
  const pendingTotal = queue.reduce((s, e) => s + e.amount_cents, 0);

  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold">Review queue</h1>
            <p className="mt-1 text-sm text-gray-500">
              {queue.length} awaiting a decision · {dollars(pendingTotal)}
            </p>
          </div>
          {flagged.length > 0 && (
            <p className="rounded bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700">
              {flagged.length} flagged by the agent
            </p>
          )}
        </header>

        <ExpenseTable
          rows={queue}
          showSubmitter
          empty="Nothing is waiting on you."
        />
      </main>
    </>
  );
}
