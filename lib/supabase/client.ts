import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for Client Components.
 *
 * Reads the session from cookies the browser already holds, so every query it
 * makes carries the signed-in user's JWT — including the org_id and user_role
 * claims our RLS policies read. There is no privileged key here: the anon key
 * is public and grants nothing on its own.
 *
 * Used by the Realtime subscriptions in components/agent-timeline.tsx.
 */
export const createBrowserSupabase = () =>
  createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
