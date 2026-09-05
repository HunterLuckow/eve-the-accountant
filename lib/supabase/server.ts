import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Supabase client for Server Components, Server Actions, and Route Handlers.
 *
 * `cookies()` is async in Next.js 16 — synchronous access was removed, not
 * merely deprecated.
 *
 * The try/catch around setAll is load-bearing, not defensive noise. Server
 * Components cannot write cookies: by the time one renders, headers are
 * already committed. If supabase-js decides mid-render that the access token
 * needs refreshing, it will call setAll and Next will throw.
 *
 * Swallowing that is safe ONLY because proxy.ts refreshes the session on every
 * request before any component renders. Delete the proxy and this catch turns
 * into a silent logout after one hour.
 */
export async function createServerSupabase() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Component render — proxy.ts already refreshed the session.
          }
        },
      },
    },
  );
}
