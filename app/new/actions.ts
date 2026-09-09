"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";

export type NewExpenseResult = { error: string } | undefined;

/**
 * Create an expense, optionally with a receipt, and optionally submit it.
 *
 * Everything here runs as the signed-in user. Three separate policies have to
 * agree for this to work, and none of them is checked in this file:
 *
 *   expenses_insert_own       submitter_id must be you, org must be yours
 *   "receipts upload own org" the object path must start with your org id
 *   expenses_update_own_draft only if `submit` was ticked
 *
 * Note the ORDER. The expense row is created first so its id can name the
 * receipt file, then the receipt is uploaded, then the row is updated to point
 * at it — and only then is it submitted. Submitting first would fire the
 * Database Webhook before the receipt existed, and the agent would open an
 * expense with nothing to read.
 */
export async function createExpense(
  _prev: NewExpenseResult,
  formData: FormData,
): Promise<NewExpenseResult> {
  const supabase = await createServerSupabase();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return { error: "No profile found for this account." };

  const description = String(formData.get("description") ?? "").trim();
  const vendorId = String(formData.get("vendor_id") ?? "");
  const spentAt = String(formData.get("spent_at") ?? "");
  const amountRaw = String(formData.get("amount") ?? "").replace(/[$,\s]/g, "");
  const submit = formData.get("submit") === "on";
  const receipt = formData.get("receipt");

  if (!description) return { error: "Give it a description." };
  if (!spentAt) return { error: "Pick a date." };

  // Parse to cents via string manipulation, not parseFloat * 100 — 19.99 * 100
  // is 1998.9999999999998, and this is an expenses app.
  const amountMatch = amountRaw.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!amountMatch) return { error: "Amount should look like 1234.56" };
  const amountCents =
    Number(amountMatch[1]) * 100 + Number((amountMatch[2] ?? "0").padEnd(2, "0"));
  if (amountCents <= 0) return { error: "Amount must be more than zero." };

  const { data: created, error: insertError } = await supabase
    .from("expenses")
    .insert({
      org_id: profile.org_id,
      submitter_id: user.id,
      vendor_id: vendorId || null,
      amount_cents: amountCents,
      spent_at: spentAt,
      description,
      status: "draft",
    })
    .select("id")
    .maybeSingle();

  if (insertError) return { error: insertError.message };
  if (!created) return { error: "Could not create the expense." };

  if (receipt instanceof File && receipt.size > 0) {
    const ext = receipt.type === "application/pdf" ? "pdf" : "png";
    const path = `${profile.org_id}/${created.id}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("receipts")
      .upload(path, receipt, { contentType: receipt.type, upsert: true });

    if (uploadError) {
      // The expense exists but has no receipt. Say so rather than pretending,
      // and leave it as a draft so it can be fixed.
      return { error: `Expense saved as a draft, but the receipt failed: ${uploadError.message}` };
    }

    await supabase.from("expenses").update({ receipt_path: path }).eq("id", created.id);
  }

  if (submit) {
    const { error: submitError } = await supabase
      .from("expenses")
      .update({ status: "submitted" })
      .eq("id", created.id);
    if (submitError) {
      return { error: `Saved as a draft — could not submit: ${submitError.message}` };
    }
  }

  revalidatePath("/inbox");
  revalidatePath("/review");
  redirect(`/expense/${created.id}`);
}
