import Link from "next/link";
import { createServerSupabase } from "@/lib/supabase/server";
import { signOut } from "@/app/login/actions";

/**
 * Note what this does NOT do: hide the review queue from employees.
 *
 * Everyone gets the same links. An employee who clicks through to /review sees
 * an empty queue — not because the UI hid it, but because RLS returned nothing.
 * Hiding links is presentation; the security lives one layer down.
 */
export async function AppNav() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, org_id")
    .eq("id", user?.id ?? "")
    .maybeSingle();

  const { data: org } = await supabase
    .from("orgs")
    .select("name")
    .eq("id", profile?.org_id ?? "")
    .maybeSingle();

  return (
    <nav className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <Link href="/inbox" className="text-sm font-semibold tracking-tight">
            eve the accountant
          </Link>
          <div className="flex gap-4 text-sm text-gray-600">
            <Link href="/inbox" className="hover:text-black">My expenses</Link>
            <Link href="/review" className="hover:text-black">Review queue</Link>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-gray-600">
            {profile?.full_name}
            <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
              {profile?.role}
            </span>
            <span className="ml-2 text-xs text-gray-400">{org?.name}</span>
          </span>
          <form action={signOut}>
            <button className="text-gray-500 underline hover:text-black">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}
