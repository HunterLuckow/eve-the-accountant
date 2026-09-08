import { NextResponse, type NextRequest } from "next/server";

/**
 * Wakes the agent when an expense is submitted.
 *
 * Called by a Postgres trigger via pg_net (see the webhook migration). This is
 * the demo's cold open: one INSERT in the SQL editor and the agent starts
 * working, with nothing polling and no queue in between.
 *
 * WHY THIS ROUTE EXISTS AT ALL, RATHER THAN POSTGRES CALLING eve DIRECTLY
 *
 * Three reasons, and the third is the important one:
 *
 *   1. /eve/v1/session should not be exposed to arbitrary callers. This route
 *      is the only thing that speaks to it on the database's behalf.
 *   2. Postgres sends whatever the trigger builds; this validates the shape
 *      before a session is started, so a malformed row cannot burn model
 *      tokens.
 *   3. It forwards the shared secret to eve, which is what gives the resulting
 *      turn a `machine` principal — and THAT is what makes
 *      request_human_review pause for approval. Without this hop the agent
 *      would escalate expenses without asking anyone.
 *
 * The proxy allows /api/hooks through unauthenticated (see proxy.ts); the
 * secret below is the authentication.
 */

export const dynamic = "force-dynamic";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type WebhookPayload = {
  type?: "INSERT" | "UPDATE" | "DELETE";
  table?: string;
  record?: {
    id?: string;
    status?: string;
    description?: string;
  } | null;
  old_record?: { status?: string } | null;
};

export async function POST(request: NextRequest) {
  const secret = process.env.WEBHOOK_SECRET;
  const presented = request.headers.get("x-webhook-secret");

  if (!secret || !presented || !timingSafeEqual(presented, secret)) {
    // Deliberately unspecific. A caller who guessed the URL learns nothing
    // about whether the secret exists or how close they were.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = (await request.json()) as WebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const record = payload.record;
  if (!record?.id) {
    return NextResponse.json({ skipped: "no record id" });
  }

  // The trigger already filters, but a webhook is an untrusted-ish edge and
  // starting a session costs real money. Check again.
  if (record.status !== "submitted") {
    return NextResponse.json({ skipped: `status is ${record.status}` });
  }

  // An expense that was already submitted and got edited should not start a
  // second review.
  if (payload.type === "UPDATE" && payload.old_record?.status === "submitted") {
    return NextResponse.json({ skipped: "already submitted" });
  }

  const origin = request.nextUrl.origin;
  const response = await fetch(`${origin}/eve/v1/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Forwarded, not merely checked. This is what makes the turn `machine`.
      "x-webhook-secret": secret,
    },
    body: JSON.stringify({
      message: `Review expense ${record.id}.`,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("[expense-submitted] session start failed", response.status, detail);
    // 502 rather than 500: the failure is downstream, and pg_net records the
    // status in net._http_response where it can be found later.
    return NextResponse.json(
      { error: "could not start session", status: response.status },
      { status: 502 },
    );
  }

  return NextResponse.json({
    started: true,
    expenseId: record.id,
    sessionId: response.headers.get("x-eve-session-id"),
  });
}
