import { createPublicKey } from "node:crypto";

/**
 * Fetches this Supabase project's JWT signing key and converts it to the PEM
 * form eve's `verifyJwtEcdsa` expects.
 *
 * Supabase signs user access tokens with ES256 and publishes the public half
 * at /auth/v1/.well-known/jwks.json. Verifying against that is what lets eve
 * trust a token it did not issue.
 *
 * Note this is a DIFFERENT credential from the anon key. The anon key is a
 * static HS256 API key that carries no user identity; user access tokens are
 * ES256 and carry `sub`, plus the org_id / user_role claims our access token
 * hook adds. Confusing the two is easy — see docs/eve-api-notes.md.
 */

type Jwk = {
  kid: string;
  alg: string;
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
};

let cache: { pem: string; kid: string; fetchedAt: number } | null = null;

/** Keys rotate rarely; an hour is plenty and avoids a fetch per request. */
const TTL_MS = 60 * 60 * 1000;

export function supabaseIssuer(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  return `${url.replace(/\/$/, "")}/auth/v1`;
}

export async function supabaseSigningKeyPem(): Promise<string> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.pem;

  const res = await fetch(`${supabaseIssuer()}/.well-known/jwks.json`, {
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "" },
  });
  if (!res.ok) {
    throw new Error(`Could not fetch Supabase JWKS: ${res.status}`);
  }

  const { keys } = (await res.json()) as { keys?: Jwk[] };
  const key = keys?.find((k) => k.alg === "ES256" && k.kty === "EC");

  if (!key) {
    // A project still on the legacy shared-secret scheme publishes no
    // asymmetric keys. That needs jwtHmac() and the JWT secret instead.
    throw new Error(
      "No ES256 key in the Supabase JWKS. This project may be using legacy " +
        "HS256 JWT signing, which needs jwtHmac() rather than jwtEcdsa().",
    );
  }

  const pem = createPublicKey({ key: key as never, format: "jwk" })
    .export({ type: "spki", format: "pem" })
    .toString();

  cache = { pem, kid: key.kid, fetchedAt: Date.now() };
  return pem;
}

/** Claims we care about, once a token has been cryptographically verified. */
export type SupabaseClaims = {
  sub: string;
  org_id?: string;
  user_role?: string;
  email?: string;
};

/**
 * Decodes a token's payload WITHOUT verifying it.
 *
 * Only ever call this on a token that verifyJwtEcdsa has already accepted.
 * Naming it loudly so it cannot be mistaken for a verification step.
 */
export function decodeVerifiedClaims(token: string): SupabaseClaims {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}
