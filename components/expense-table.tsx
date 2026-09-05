import Link from "next/link";
import { dollars, STATUS_STYLE, type Expense, type ExpenseStatus } from "@/lib/types";

type Row = Pick<
  Expense,
  "id" | "spent_at" | "description" | "amount_cents" | "status"
> & {
  /** Present only when the caller can see other people's rows. */
  submitter?: { full_name: string } | null;
  flag_count?: number;
};

export function ExpenseTable({
  rows,
  showSubmitter = false,
  empty = "Nothing here.",
}: {
  rows: Row[];
  showSubmitter?: boolean;
  empty?: string;
}) {
  if (rows.length === 0) {
    return <p className="py-8 text-sm text-gray-500">{empty}</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wider text-gray-500">
          <th className="py-2 font-medium">Date</th>
          <th className="font-medium">Description</th>
          {showSubmitter && <th className="font-medium">Submitted by</th>}
          <th className="text-right font-medium">Amount</th>
          <th className="pl-4 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={e.id} className="border-b border-gray-100 hover:bg-gray-50">
            <td className="py-3 whitespace-nowrap text-gray-500">{e.spent_at}</td>
            <td className="py-3">
              <Link href={`/expense/${e.id}`} className="hover:underline">
                {e.description || "—"}
              </Link>
              {!!e.flag_count && (
                <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">
                  {e.flag_count} flag{e.flag_count > 1 ? "s" : ""}
                </span>
              )}
            </td>
            {showSubmitter && (
              <td className="py-3 text-gray-600">{e.submitter?.full_name ?? "—"}</td>
            )}
            <td className="py-3 text-right tabular-nums">{dollars(e.amount_cents)}</td>
            <td className="py-3 pl-4">
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${
                  STATUS_STYLE[e.status as ExpenseStatus]
                }`}
              >
                {e.status.replace("_", " ")}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
