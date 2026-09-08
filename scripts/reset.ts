/**
 * Puts the demo back to its opening position.
 *
 * Run this between rehearsals and immediately before going on stage. It is
 * idempotent and safe to run repeatedly.
 *
 *   pnpm reset
 *
 * Deliberately does NOT re-seed. `pnpm seed` rebuilds users, vendors and 128
 * historical expenses, which takes a while and regenerates the demo expense
 * ids — and the ids are what you have typed into your SQL editor. This only
 * rewinds the parts a demo run changes.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Missing Supabase env vars. Did you source .env.local?");

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const NIL = "00000000-0000-0000-0000-000000000000";
const usd = (c: number) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

async function main() {
  // --- what the agent produced ---------------------------------------------
  // agent_steps.id is text, so the "not equal to a nil uuid" trick used for
  // the others would be a type error.
  await db.from("agent_steps").delete().neq("id", "");
  await db.from("expense_flags").delete().neq("id", NIL);
  await db.from("approvals").delete().neq("id", NIL);
  await db.from("receipt_extractions").delete().neq("expense_id", NIL);

  // --- the demo expenses ----------------------------------------------------
  const { data: demo, error } = await db
    .from("expenses")
    .update({ status: "draft" })
    .like("description", "Meridian Consulting — Phase%")
    .select("id, org_id, amount_cents, description")
    .order("description");
  if (error) throw error;

  // --- receipts -------------------------------------------------------------
  // pnpm injection:arm replaces MC-2292's receipt with a malicious one. If a
  // rehearsal ended mid-injection-demo, restore the real invoices.
  let restored = 0;
  for (const [i, row] of (demo ?? []).entries()) {
    const file = join(process.cwd(), `scripts/fixtures/receipts/receipt-${i + 1}.png`);
    if (!existsSync(file)) continue;
    const path = `${row.org_id}/${row.id}.png`;
    const { error: upErr } = await db.storage
      .from("receipts")
      .upload(path, readFileSync(file), { contentType: "image/png", upsert: true });
    if (!upErr) restored += 1;
  }

  // --- stray objects --------------------------------------------------------
  // Task 7's policy grants no DELETE on receipts to anyone, so probe files
  // left by earlier testing can only be removed with the service role, which
  // bypasses RLS. This is the one place that is appropriate.
  const orgIds = [...new Set((demo ?? []).map((r) => r.org_id))];
  let removed = 0;
  for (const orgId of orgIds) {
    const { data: objects } = await db.storage.from("receipts").list(orgId);
    const strays = (objects ?? [])
      .filter((o) => !(demo ?? []).some((d) => o.name === `${d.id}.png`))
      .map((o) => `${orgId}/${o.name}`);
    if (strays.length) {
      const { error: delErr } = await db.storage.from("receipts").remove(strays);
      if (!delErr) removed += strays.length;
    }
  }

  // --- report ---------------------------------------------------------------
  const { count: expenses } = await db
    .from("expenses")
    .select("*", { count: "exact", head: true });

  console.log("Reset complete.\n");
  console.log(`  expenses in total   ${expenses}`);
  console.log(`  receipts restored   ${restored}`);
  console.log(`  stray files removed ${removed}`);
  console.log(`  findings, steps, extractions, approvals: cleared\n`);

  console.log("Demo expenses, back to draft:\n");
  for (const row of demo ?? []) {
    console.log(`  ${row.id}  ${usd(row.amount_cents).padStart(10)}  ${row.description}`);
  }

  const first = demo?.[0];
  if (first) {
    console.log("\nCold open — paste this into the SQL editor:\n");
    console.log(`  update expenses set status = 'submitted' where id = '${first.id}';`);
  }
}

main().catch((e) => {
  console.error("\nReset failed:", e.message ?? e);
  process.exit(1);
});
