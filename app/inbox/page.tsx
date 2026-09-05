import { createServerSupabase } from "@/lib/supabase/server";
import { signOut } from "@/app/login/actions";

export const dynamic = "force-dynamic";

/**
 * Placeholder for Task 11. For now it exists to prove the whole auth chain
 * end to end: sign-in -> hook-stamped claims -> RLS-filtered query.
 *
 * Note there is no role check anywhere below. The same code runs for an
 * employee, a manager, and finance; the row count differs because Postgres
 * decided it did.
 */
export default async function InboxPage() {
  const supabase = await createServerSupabase();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const claims = session?.access_token
    ? (JSON.parse(
        Buffer.from(session.access_token.split(".")[1], "base64url").toString(),
      ) as Record<string, unknown>)
    : null;

  const { count } = await supabase
    .from("expenses")
    .select("*", { count: "exact", head: true });

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role")
    .eq("id", String(claims?.sub ?? ""))
    .maybeSingle();

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="mb-8 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">
          {profile?.full_name ?? "Signed in"}
        </h1>
        <form action={signOut}>
          <button className="text-sm text-gray-500 underline">Sign out</button>
        </form>
      </header>

      <section className="mb-8 rounded border border-gray-200 p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Claims in your access token
        </h2>
        <dl className="space-y-1 font-mono text-sm">
          {(["sub", "role", "org_id", "user_role"] as const).map((k) => (
            <div key={k}>
              <dt className="inline text-gray-500">{k}: </dt>
              <dd className="inline">{String(claims?.[k] ?? "—")}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-gray-500">
          <code>org_id</code> and <code>user_role</code> are written by
          <code> custom_access_token_hook</code>. Every RLS policy reads them.
        </p>
      </section>

      <section className="rounded border border-gray-200 p-4">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Expenses visible to you
        </h2>
        <p className="text-3xl font-semibold tabular-nums">{count ?? 0}</p>
        <p className="mt-2 text-xs text-gray-500">
          Same query for every role. The number changes because Postgres says so.
        </p>
      </section>
    </main>
  );
}
