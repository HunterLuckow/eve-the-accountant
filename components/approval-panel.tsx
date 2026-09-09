"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";

/**
 * The button that unblocks a parked agent.
 *
 * WHY THIS TALKS TO eve DIRECTLY AND NOT THROUGH AN APP ROUTE
 *
 * The obvious design proxies through /api/approvals so the server can check
 * the user's role first. That would be worse, because it would mean the
 * APPLICATION decides who may approve — one more place to get authorization
 * wrong, and a place a reviewer of this codebase would have to audit.
 *
 * Instead the browser posts straight to eve's session route, same origin,
 * carrying the user's Supabase access token. eve verifies that token itself
 * (agent/channels/eve.ts) and hands the verified identity to the tool's
 * approval RESPONSE policy (agent/tools/request_human_review.ts), which is
 * what decides whether a manager or finance is answering.
 *
 * So this component sends a decision and renders the answer. It contains no
 * authorization logic at all — the same posture as the rest of the app, where
 * RLS decides what a page shows.
 *
 * An employee clicking Approve gets a rejection, and the request stays open
 * for someone who is authorized. Worth trying on stage.
 */
export function ApprovalPanel({
  sessionId,
  requestId,
  prompt,
  summary,
  recommendation,
  refusal,
}: {
  sessionId: string;
  requestId: string;
  prompt: string;
  summary?: string;
  recommendation?: string;
  /**
   * A previous attempt that eve refused, if any.
   *
   * Comes from the approval RESPONSE policy, not from this component. eve
   * returns 202 for the POST and only afterwards decides whether the responder
   * is allowed — so a refusal cannot be reported from the fetch result and has
   * to be read back from what the runtime recorded.
   */
  refusal?: string | null;
}) {
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function decide(optionId: "approve" | "cancel") {
    setBusy(optionId);
    setError(null);

    const supabase = createBrowserSupabase();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      setError("Your session expired. Reload and sign in again.");
      setBusy(null);
      return;
    }

    // Shape verified against the running runtime in Task 12. The published
    // docs describe an object keyed by requestId with a `decision` field;
    // both are rejected with HTTP 400. See docs/eve-api-notes.md.
    const res = await fetch(`/eve/v1/session/${sessionId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        inputResponses: [{ requestId, optionId }],
      }),
    });

    if (!res.ok) {
      setError(`eve refused the response (HTTP ${res.status}).`);
      setBusy(null);
      return;
    }

    /**
     * A 202 means eve accepted the message, NOT that the approval succeeded.
     *
     * The response policy runs afterwards and may reject an unauthorised
     * responder. That outcome reaches us only once the hook has written the
     * approval.candidate event, so refresh a few times over several seconds
     * rather than once — a single refresh usually lands before the verdict
     * exists and shows the user nothing at all.
     */
    for (const delay of [1200, 2600, 4500]) {
      setTimeout(() => router.refresh(), delay);
    }
    setTimeout(() => setBusy(null), 4600);
  }

  return (
    <div className="rounded border-2 border-amber-400 bg-amber-50 p-4">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
        <h3 className="text-sm font-semibold text-amber-900">
          The agent is waiting for you
        </h3>
      </div>

      <p className="mt-2 text-sm text-amber-900/90">{summary ?? prompt}</p>

      {recommendation && (
        <p className="mt-2 text-xs text-amber-800">
          Agent recommends: <strong>{recommendation}</strong> — you decide.
        </p>
      )}

      {refusal && (
        <div className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2">
          <p className="text-sm font-semibold text-red-800">
            That was refused.
          </p>
          <p className="mt-0.5 text-sm text-red-700">{refusal}</p>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button
          disabled={busy !== null}
          onClick={() => decide("approve")}
          className="rounded bg-amber-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy === "approve" ? "Sending…" : "Approve"}
        </button>
        <button
          disabled={busy !== null}
          onClick={() => decide("cancel")}
          className="rounded border border-amber-400 px-4 py-2 text-sm disabled:opacity-50"
        >
          {busy === "cancel" ? "Sending…" : "Cancel"}
        </button>
      </div>

      <p className="mt-3 text-xs text-amber-700">
        Only a manager or finance can answer this. eve verifies who you are
        before the agent continues.
      </p>
    </div>
  );
}
