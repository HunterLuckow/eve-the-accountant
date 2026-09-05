"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Server Actions can write cookies (unlike Server Components), so this is a
 * legitimate place for supabase-js to persist the new session.
 *
 * On success GoTrue mints an access token, our custom_access_token_hook stamps
 * org_id and user_role into it, and every subsequent query in the app is
 * scoped by RLS reading those claims. No role check appears anywhere in this
 * codebase.
 */
export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/", "layout");
  redirect("/inbox");
}

export async function signOut() {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
