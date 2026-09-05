import { eveChannel } from "eve/channels/eve";
import {
  localDev,
  verifyJwtEcdsa,
  extractBearerToken,
  type AuthFn,
} from "eve/channels/auth";
import {
  supabaseIssuer,
  supabaseSigningKeyPem,
  decodeVerifiedClaims,
} from "../lib/supabase-jwt";

/**
 * Who may talk to this agent, and as whom.
 *
 * This is the second half of the identity story. agent/lib/agent-db.ts covers
 * how the agent authenticates TO Postgres; this covers how callers
 * authenticate TO the agent — and, crucially, whether the resulting turn is
 * human-initiated or machine-initiated.
 *
 * That distinction is not bookkeeping. agent/tools/request_human_review.ts
 * gates on it: a turn started by the Database Webhook pauses for approval,
 * while a human talking to the agent directly does not, because they are
 * already the human in the loop.
 *
 * eve walks this array in order. The first entry returning a
 * SessionAuthContext wins; entries returning null are skipped; if every entry
 * skips, the route returns 401.
 */

/**
 * A signed-in Supabase user.
 *
 * Deliberately NOT eve's built-in oidc() helper, which hardcodes
 * principalType: "service". We need "user", and we need the org_id and
 * user_role claims carried through into `attributes` so the approval response
 * policy can check that whoever clicked Approve is actually finance.
 *
 * verifyJwtEcdsa does the cryptography — signature, expiry, issuer, audience.
 * Only after it accepts do we decode the payload to build the principal.
 */
export const supabaseUser: AuthFn<Request> = async (request) => {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) return null;

  const result = await verifyJwtEcdsa(token, {
    algorithm: "ES256",
    issuer: supabaseIssuer(),
    audiences: ["authenticated"],
    publicKey: await supabaseSigningKeyPem(),
  });

  // Returning null rather than throwing lets the walk continue to the next
  // entry. A token that is present but invalid is not this authenticator's
  // problem to report on.
  if (!result.ok) return null;

  const claims = decodeVerifiedClaims(token);

  return {
    principalId: claims.sub,
    principalType: "user",
    authenticator: "supabase",
    subject: claims.sub,
    issuer: supabaseIssuer(),
    attributes: {
      ...(claims.org_id ? { org_id: claims.org_id } : {}),
      ...(claims.user_role ? { user_role: claims.user_role } : {}),
      ...(claims.email ? { email: claims.email } : {}),
    },
  };
};

/**
 * The Database Webhook, via app/api/hooks/expense-submitted.
 *
 * Constant-time comparison so a wrong secret cannot be recovered by timing the
 * response. The header is checked once by the route and forwarded here, and
 * this entry is what stamps the turn `machine` — which is what makes the
 * approval gate fire.
 */
export const webhookMachine: AuthFn<Request> = async (request) => {
  const presented = request.headers.get("x-webhook-secret");
  const expected = process.env.WEBHOOK_SECRET;
  if (!presented || !expected) return null;
  if (!timingSafeEqualStrings(presented, expected)) return null;

  return {
    principalId: "expense-webhook",
    principalType: "machine",
    authenticator: "webhook-secret",
    // Required by SessionAuthContext, even when empty.
    attributes: {},
  };
};

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default eveChannel({
  /**
   * Order matters.
   *
   * localDev() is last and is safe to leave in production: it authenticates
   * only when the process is `eve dev` or `vercel dev`, which is a property of
   * the deployment, never of the request. No header can flip it.
   */
  auth: [supabaseUser, webhookMachine, localDev()],
});
