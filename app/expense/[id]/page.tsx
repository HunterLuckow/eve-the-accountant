import { notFound } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { AppNav } from "@/components/app-nav";
import { ReceiptViewer } from "@/components/receipt-viewer";
import {
  dollars,
  STATUS_STYLE,
  SEVERITY_STYLE,
  type ExpenseFlag,
  type ExpenseStatus,
} from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ExpensePage({
  params,
}: {
  // params is a Promise in Next.js 16.
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabase();

  const { data: expense } = await supabase
    .from("expenses")
    .select(
      "*, submitter:profiles!expenses_submitter_id_fkey(full_name, role), vendor:vendors(name, category)",
    )
    .eq("id", id)
    .maybeSingle();

  /**
   * A user from another org lands here.
   *
   * RLS returned no row, so this is a 404 — the expense does not exist as far
   * as they are concerned. Note it is NOT a 403: a 403 would confirm the
   * record is real and merely off-limits. Invisibility leaks less than
   * refusal.
   */
  if (!expense) notFound();

  const [{ data: flags }, { data: extraction }] = await Promise.all([
    supabase
      .from("expense_flags")
      .select("*")
      .eq("expense_id", id)
      .order("created_at"),
    supabase
      .from("receipt_extractions")
      .select("*")
      .eq("expense_id", id)
      .maybeSingle(),
  ]);

  const submitter = Array.isArray(expense.submitter)
    ? expense.submitter[0]
    : expense.submitter;
  const vendor = Array.isArray(expense.vendor) ? expense.vendor[0] : expense.vendor;

  // A receipt total that disagrees with the claimed amount is a policy issue,
  // and worth surfacing even before the agent writes a flag about it.
  const mismatch =
    extraction?.total_cents != null &&
    Math.abs(extraction.total_cents - expense.amount_cents) > 500;

  return (
    <>
      <AppNav />
      <main className="mx-auto grid max-w-5xl gap-10 px-6 py-10 md:grid-cols-[1fr_minmax(0,380px)]">
        <section className="space-y-8">
          <header>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold">
                {expense.description || "Expense"}
              </h1>
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${
                  STATUS_STYLE[expense.status as ExpenseStatus]
                }`}
              >
                {String(expense.status).replace("_", " ")}
              </span>
            </div>
            <p className="mt-3 text-3xl font-semibold tabular-nums">
              {dollars(expense.amount_cents)}
            </p>
          </header>

          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
            <Field label="Date" value={expense.spent_at} />
            <Field label="Vendor" value={vendor?.name ?? "—"} />
            <Field label="Submitted by" value={submitter?.full_name ?? "—"} />
            <Field label="Category" value={vendor?.category ?? "—"} />
          </dl>

          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
              Findings
            </h2>
            {(flags ?? []).length === 0 ? (
              <p className="text-sm text-gray-400">
                No findings recorded.
              </p>
            ) : (
              <ul className="space-y-2">
                {(flags as ExpenseFlag[]).map((f) => (
                  <li
                    key={f.id}
                    className={`rounded border-l-4 p-3 text-sm ${SEVERITY_STYLE[f.severity]}`}
                  >
                    <div className="flex items-center justify-between">
                      <strong className="font-medium">
                        {f.kind.replace(/_/g, " ")}
                      </strong>
                      <span className="text-xs text-gray-500">
                        recorded by {f.created_by}
                      </span>
                    </div>
                    <p className="mt-1 text-gray-700">{f.rationale}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {extraction && (
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                Read from the receipt
              </h2>
              <dl className="grid grid-cols-3 gap-4 text-sm">
                <Field label="Merchant" value={extraction.merchant ?? "—"} />
                <Field
                  label="Total"
                  value={
                    extraction.total_cents != null
                      ? dollars(extraction.total_cents)
                      : "—"
                  }
                  highlight={mismatch}
                />
                <Field label="Date" value={extraction.spent_at ?? "—"} />
              </dl>
              {mismatch && (
                <p className="mt-2 text-sm text-red-700">
                  Receipt total disagrees with the claimed amount.
                </p>
              )}
            </section>
          )}
        </section>

        <aside>
          <ReceiptViewer path={expense.receipt_path} />
        </aside>
      </main>
    </>
  );
}

function Field({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-gray-400">{label}</dt>
      <dd className={highlight ? "font-medium text-red-700" : ""}>{value}</dd>
    </div>
  );
}
