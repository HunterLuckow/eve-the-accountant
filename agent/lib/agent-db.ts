import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The agent's connection to Postgres.
 *
 * This file is the whole thesis of the project, so it is worth being explicit
 * about what it does NOT do:
 *
 *   It does not use SUPABASE_SERVICE_ROLE_KEY.
 *
 * Service role bypasses RLS entirely. An agent holding it could approve every
 * expense in the database, and every security claim in this repo would be
 * theatre — a system prompt asking a model nicely not to do something it is
 * fully capable of doing.
 *
 * Instead the agent signs in like a person: email and password, against the
 * public anon key, receiving an ordinary GoTrue access token. Our
 * custom_access_token_hook stamps org_id and user_role: 'agent' into that
 * token, and from that point on Postgres treats the agent exactly as it treats
 * Dana or Priya. It can read its org's expenses. It cannot change one, because
 * no UPDATE policy admits an agent principal.
 *
 * The agent is not trusted. It is constrained.
 */

type Cached = {
  client: SupabaseClient;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  orgId: string;
  userId: string;
};

let cached: Cached | null = null;

/** Refresh this long before actual expiry, so no call races the boundary. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function decodeClaims(accessToken: string): Record<string, unknown> {
  const payload = accessToken.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}

async function signIn(): Promise<Cached> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const email = process.env.AGENT_EMAIL;
  const password = process.env.AGENT_PASSWORD;

  if (!url || !anonKey) throw new Error("Missing Supabase URL or anon key");
  if (!email || !password) throw new Error("Missing AGENT_EMAIL / AGENT_PASSWORD");

  const client = createClient(url, anonKey, {
    auth: {
      // The agent is not a browser. Nothing to persist, and token lifetime is
      // managed here rather than by a background timer that would keep a
      // serverless function alive.
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Agent sign-in failed: ${error.message}`);

  const session = data.session;
  if (!session) throw new Error("Agent sign-in returned no session");

  const claims = decodeClaims(session.access_token);
  const orgId = claims.org_id as string | undefined;
  const userRole = claims.user_role as string | undefined;

  // Fail loudly rather than silently operating with no claims. Without these,
  // every policy evaluates false and the agent would simply "see nothing" —
  // which looks identical to "there is nothing to see."
  if (!orgId || userRole !== "agent") {
    throw new Error(
      `Agent token is missing expected claims (org_id=${orgId}, user_role=${userRole}). ` +
        `Is the custom access token hook enabled, and does this user's profile have role 'agent'?`,
    );
  }

  return {
    client,
    expiresAt: (session.expires_at ?? 0) * 1000,
    orgId,
    userId: session.user.id,
  };
}

async function connection(): Promise<Cached> {
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached;
  cached = await signIn();
  return cached;
}

/** RLS-bound Supabase client, authenticated as the agent user. */
export async function getAgentDb(): Promise<SupabaseClient> {
  return (await connection()).client;
}

/** The agent's org, read from its own JWT claims rather than passed in. */
export async function getAgentOrgId(): Promise<string> {
  return (await connection()).orgId;
}

/** The agent's auth.users id — its identity in the audit trail. */
export async function getAgentUserId(): Promise<string> {
  return (await connection()).userId;
}

/** Testing helper: drop the cached session so the next call re-authenticates. */
export function resetAgentDb(): void {
  cached = null;
}
