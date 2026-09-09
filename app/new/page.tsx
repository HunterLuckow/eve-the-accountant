import { createServerSupabase } from "@/lib/supabase/server";
import { AppNav } from "@/components/app-nav";
import { NewExpenseForm } from "@/components/new-expense-form";

export const dynamic = "force-dynamic";

/**
 * The app's front door.
 *
 * Before this existed, an expense could only enter the queue by running SQL,
 * which made the demo's opening beat look like a database tutorial. Now it
 * looks like a person expensing something — and the Database Webhook fires
 * from an ordinary product action, which is the point.
 *
 * The vendor list comes back RLS-filtered: `vendors_select_org` means you only
 * ever see your own org's, so the dropdown cannot offer a vendor that would
 * fail the insert.
 */
export default async function NewExpensePage() {
  const supabase = await createServerSupabase();

  const { data: vendors } = await supabase
    .from("vendors")
    .select("id, name, category")
    .order("name");

  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-xl px-6 py-10">
        <header className="mb-8">
          <h1 className="text-xl font-semibold">New expense</h1>
          <p className="mt-1 text-sm text-gray-500">
            Submitting sends it to the review queue.
          </p>
        </header>
        <NewExpenseForm vendors={vendors ?? []} />
      </main>
    </>
  );
}
