"use client";

import { useState, useTransition } from "react";
import { submitExpense } from "@/app/expense/[id]/actions";

/**
 * Sends a draft into the review queue.
 *
 * This is the demo's cold open. Clicking it flips one column in Postgres; a
 * trigger notices, calls the app over the public internet, and the agent wakes
 * up. Nothing in this component knows any of that — which is the nice part.
 */
export function SubmitDraft({ expenseId }: { expenseId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded border border-blue-200 bg-blue-50 p-4">
      <h3 className="text-sm font-semibold text-blue-900">Draft</h3>
      <p className="mt-1 text-sm text-blue-900/80">
        Not yet in the review queue. Submitting notifies the reviewers — and the
        agent.
      </p>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      <button
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await submitExpense(expenseId);
            if (!result.ok) setError(result.error);
          });
        }}
        className="mt-3 rounded bg-blue-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Submitting…" : "Submit for review"}
      </button>
    </div>
  );
}
