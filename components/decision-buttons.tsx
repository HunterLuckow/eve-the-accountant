"use client";

import { useState, useTransition } from "react";
import { decideExpense } from "@/app/expense/[id]/actions";
import type { ExpenseStatus } from "@/lib/types";

/**
 * Approve / reject, shown to everyone.
 *
 * Not hidden from employees on purpose. An employee who clicks Approve gets
 * "Your role does not permit deciding this expense" — from RLS returning zero
 * rows, not from a conditional in this component. A manager over their limit
 * gets the threshold trigger's sentence.
 *
 * Hiding the button would be a nicer product and a worse demo: the point is
 * that the boundary holds without the UI's help.
 */
export function DecisionButtons({
  expenseId,
  status,
}: {
  expenseId: string;
  status: ExpenseStatus;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  if (status === "approved" || status === "rejected") {
    return (
      <p className="text-sm text-gray-500">
        Already {status}. Decisions are recorded in the audit trail.
      </p>
    );
  }

  function decide(decision: "approved" | "rejected") {
    setMessage(null);
    startTransition(async () => {
      const result = await decideExpense(expenseId, decision);
      setOk(result.ok);
      setMessage(
        result.ok
          ? result.auditWarning
            ? `Marked ${decision}, but the audit record failed: ${result.auditWarning}`
            : `Marked ${decision}.`
          : result.error,
      );
    });
  }

  return (
    <div>
      <div className="flex gap-2">
        <button
          disabled={pending}
          onClick={() => decide("approved")}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {pending ? "…" : "Approve"}
        </button>
        <button
          disabled={pending}
          onClick={() => decide("rejected")}
          className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      {message && (
        <p className={`mt-2 text-sm ${ok ? "text-green-700" : "text-red-700"}`}>
          {message}
        </p>
      )}
    </div>
  );
}
