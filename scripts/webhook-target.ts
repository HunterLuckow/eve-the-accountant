/**
 * Points the Database Webhook at a URL.
 *
 *   pnpm webhook:target                          show where it points now
 *   pnpm webhook:target https://x.trycloudflare.com   local dev via a tunnel
 *   pnpm webhook:target https://app.vercel.app        production
 *
 * pg_net runs inside Supabase's cloud, so it cannot reach a laptop —
 * http://localhost:3000 will always fail with "Couldn't connect to server".
 * For local development, expose the dev server first:
 *
 *   cloudflared tunnel --url http://localhost:3000
 *   ngrok http 3000
 *
 * The secret itself is set by the seed/deploy flow and is not touched here.
 */
import { createClient } from "@supabase/supabase-js";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function sql(query: string) {
  // vault.decrypted_secrets is not exposed through PostgREST, so this goes
  // through an RPC the migration below installs.
  const { data, error } = await db.rpc("webhook_target", { new_url: query || null });
  if (error) throw new Error(error.message);
  return data as { url: string | null; secret_set: boolean };
}

async function main() {
  const url = process.argv[2];

  if (url && !/^https:\/\//.test(url)) {
    console.error("Refusing a non-https URL. pg_net calls out from the public");
    console.error("internet; anything else either will not resolve or would");
    console.error("send expense data in the clear.");
    process.exit(1);
  }

  if (url && /localhost|127\.0\.0\.1/.test(url)) {
    console.error("pg_net runs in Supabase's cloud and cannot reach your laptop.");
    console.error("Use a tunnel: cloudflared tunnel --url http://localhost:3000");
    process.exit(1);
  }

  const before = await sql("");
  if (!url) {
    console.log(`webhook target : ${before.url ?? "(not set)"}`);
    console.log(`secret set     : ${before.secret_set ? "yes" : "NO — the trigger will not fire"}`);
    return;
  }

  const after = await sql(url);
  console.log(`webhook target : ${before.url ?? "(not set)"}`);
  console.log(`             -> ${after.url}`);
  console.log(`secret set     : ${after.secret_set ? "yes" : "NO — the trigger will not fire"}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
