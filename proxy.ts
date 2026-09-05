import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Runs before every matched request.
 *
 * NOTE: this file is `proxy.ts`, not `middleware.ts`. Next.js 16 renamed the
 * convention; `middleware.ts` still works but is deprecated.
 *
 * Two jobs:
 *
 * 1. REFRESH THE SESSION. Supabase access tokens are short-lived (one hour).
 *    Only a Route Handler or a proxy can write cookies — a Server Component
 *    cannot — so this is the one place a refreshed token can be persisted.
 *    Remove this and the app logs everyone out an hour after they sign in.
 *
 *    Refreshing also re-runs our custom_access_token_hook, which is how a role
 *    change in `profiles` eventually reaches a user's claims.
 *
 * 2. GATE UNAUTHENTICATED TRAFFIC. Note this is a redirect for UX, not a
 *    security boundary. The actual boundary is RLS: an unauthenticated request
 *    that skipped this would still see zero rows. That is the point of the
 *    design — losing the proxy would be a broken app, not a data breach.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          // Written twice on purpose: onto the request so the rest of this
          // pass sees the fresh token, and onto the response so the browser
          // stores it.
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser(), not getSession(). getSession() reads the cookie without
  // verifying it; getUser() validates the token against the auth server. Never
  // trust a session you have not verified server-side.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = pathname.startsWith("/login") || pathname.startsWith("/api/hooks");

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = "/inbox";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    /**
     * Everything except:
     *   _next/static, _next/image, favicon, image files — no session needed
     *   eve/          — eve's routes authenticate through their own channel
     *                   auth policy (agent/channels/eve.ts). Running this
     *                   proxy over them would redirect the agent to /login.
     */
    "/((?!_next/static|_next/image|favicon.ico|eve/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
