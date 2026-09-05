/**
 * Seeds the demo dataset.
 *
 * THIS IS THE ONE PLACE THE SERVICE ROLE KEY BELONGS.
 *
 * Seeding has to create auth users and write rows on behalf of people who are
 * not signed in, which means bypassing RLS. That is legitimate here and
 * nowhere else in this project — in particular, never in agent/. The agent's
 * whole premise is that it is an ordinary RLS principal (see docs/specs/).
 *
 * Idempotent: safe to run repeatedly. Users and orgs are adopted if they
 * already exist; expenses are cleared and rebuilt so the dataset is
 * deterministic every time.
 *
 *   pnpm seed
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const agentEmail = process.env.AGENT_EMAIL;
const agentPassword = process.env.AGENT_PASSWORD;

if (!url || !serviceKey) throw new Error("Missing Supabase env vars. Did you source .env.local?");
if (!agentEmail || !agentPassword) throw new Error("Missing AGENT_EMAIL / AGENT_PASSWORD");

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const DEMO_PASSWORD = "demo-password-1234";
const RECEIPT_DIR = join(process.cwd(), "scripts/fixtures/receipts");

// ---------------------------------------------------------------------------
// Cast
//
// Northwind Labs is where the demo happens. Acme Freight exists solely so
// there is a second tenant to prove isolation against — on stage, signing in
// as Kit and seeing nothing is the RLS punchline.
// ---------------------------------------------------------------------------
const ORGS = [
  { name: "Northwind Labs", threshold_cents: 400_000 },
  { name: "Acme Freight", threshold_cents: 250_000 },
];

type Person = {
  email: string;
  name: string;
  role: "employee" | "manager" | "finance" | "agent";
  org: string;
  reportsTo?: string;
};

const PEOPLE: Person[] = [
  { email: "dana@northwind.demo", name: "Dana Reyes", role: "finance", org: "Northwind Labs" },
  { email: "marcus@northwind.demo", name: "Marcus Vale", role: "manager", org: "Northwind Labs" },
  { email: "priya@northwind.demo", name: "Priya Raman", role: "employee", org: "Northwind Labs", reportsTo: "marcus@northwind.demo" },
  { email: "sam@northwind.demo", name: "Sam Okafor", role: "employee", org: "Northwind Labs", reportsTo: "marcus@northwind.demo" },
  { email: agentEmail, name: "eve (agent)", role: "agent", org: "Northwind Labs" },
  { email: "lee@acme.demo", name: "Lee Zhang", role: "finance", org: "Acme Freight" },
  { email: "kit@acme.demo", name: "Kit Alvarez", role: "employee", org: "Acme Freight", reportsTo: "lee@acme.demo" },
];

const VENDORS = [
  { name: "Meridian Consulting", category: "professional_services" },
  { name: "Bluepeak Travel", category: "travel" },
  { name: "Orchard Catering", category: "meals" },
  { name: "Halcyon Software", category: "software" },
  { name: "Ridgeline Logistics", category: "shipping" },
];

// ---------------------------------------------------------------------------
// The demo rows.
//
// One consulting engagement, invoiced in three parts on the same day, each
// comfortably under Northwind's $4,000 manager-approval threshold. Together
// they are $11,805 — which would have required finance and a VP.
//
// Seeded as `draft` so a submission can be made live on stage; that INSERT is
// what the Database Webhook fires on.
// ---------------------------------------------------------------------------
const STRUCTURED = [
  { amount_cents: 394_000, phase: "Phase 1 — Discovery", invoice: "MC-2291", receipt: "receipt-1.png" },
  { amount_cents: 387_500, phase: "Phase 2 — Architecture", invoice: "MC-2292", receipt: "receipt-2.png" },
  { amount_cents: 399_000, phase: "Phase 3 — Handover", invoice: "MC-2293", receipt: "receipt-3.png" },
];

const usd = (c: number) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

/** Create the auth user, or adopt and re-key an existing one. */
async function upsertAuthUser(email: string, password: string): Promise<string> {
  let page = 1;
  for (;;) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data.users.find((u) => u.email === email);
    if (found) {
      await db.auth.admin.updateUserById(found.id, { password });
      return found.id;
    }
    if (data.users.length < 200) break;
    page += 1;
  }
  const { data, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  return data.user.id;
}

async function main() {
  console.log("Seeding eve-the-accountant\n");

  // -- orgs -----------------------------------------------------------------
  const { data: orgs, error: orgErr } = await db
    .from("orgs")
    .upsert(ORGS, { onConflict: "name" })
    .select();
  if (orgErr) throw orgErr;
  const orgId = Object.fromEntries(orgs.map((o) => [o.name, o.id as string]));
  console.log(`orgs      ${orgs.length}`);

  // -- people ---------------------------------------------------------------
  const userId: Record<string, string> = {};
  for (const p of PEOPLE) {
    userId[p.email] = await upsertAuthUser(
      p.email,
      p.role === "agent" ? agentPassword! : DEMO_PASSWORD,
    );
  }

  const { error: profErr } = await db.from("profiles").upsert(
    PEOPLE.map((p) => ({
      id: userId[p.email],
      org_id: orgId[p.org],
      full_name: p.name,
      role: p.role,
    })),
  );
  if (profErr) throw profErr;

  // Reporting lines need every profile to exist first, hence a second pass.
  for (const p of PEOPLE.filter((x) => x.reportsTo)) {
    const { error } = await db
      .from("profiles")
      .update({ manager_id: userId[p.reportsTo!] })
      .eq("id", userId[p.email]);
    if (error) throw error;
  }
  console.log(`people    ${PEOPLE.length}`);

  // -- vendors --------------------------------------------------------------
  const { data: vendors, error: venErr } = await db
    .from("vendors")
    .upsert(
      Object.values(orgId).flatMap((org_id) => VENDORS.map((v) => ({ org_id, ...v }))),
      { onConflict: "org_id,name" },
    )
    .select();
  if (venErr) throw venErr;
  console.log(`vendors   ${vendors.length}`);

  // -- expenses -------------------------------------------------------------
  // Cleared and rebuilt so the dataset is identical on every run. Cascades to
  // flags, extractions, approvals and agent_steps, which is what we want.
  const { error: delErr } = await db
    .from("expenses")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  if (delErr) throw delErr;

  const nw = orgId["Northwind Labs"];
  const nwVendors = vendors.filter((v) => v.org_id === nw);
  const meridian = nwVendors.find((v) => v.name === "Meridian Consulting")!;
  const submitters = [userId["priya@northwind.demo"], userId["sam@northwind.demo"]];

  // Deterministic pseudo-random history: same numbers on every seed, so a
  // rehearsal and the real run show identical data.
  const history = Array.from({ length: 120 }, (_, i) => {
    const vendor = nwVendors[i % nwVendors.length];
    const d = new Date();
    d.setDate(d.getDate() - (7 + ((i * 43) % 170)));
    return {
      org_id: nw,
      submitter_id: submitters[i % 2],
      vendor_id: vendor.id,
      amount_cents: 4_200 + ((i * 7919) % 180_000),
      spent_at: d.toISOString().slice(0, 10),
      description: `${vendor.name} — ${vendor.category.replace(/_/g, " ")}`,
      status: "approved" as const,
    };
  });

  const { error: histErr } = await db.from("expenses").insert(history);
  if (histErr) throw histErr;
  console.log(`history   ${history.length} approved expenses`);

  // A little activity in the other tenant, so Acme is not conspicuously empty.
  const acme = orgId["Acme Freight"];
  const acmeVendors = vendors.filter((v) => v.org_id === acme);
  await db.from("expenses").insert(
    Array.from({ length: 8 }, (_, i) => {
      const v = acmeVendors[i % acmeVendors.length];
      const d = new Date();
      d.setDate(d.getDate() - (3 + i * 9));
      return {
        org_id: acme,
        submitter_id: userId["kit@acme.demo"],
        vendor_id: v.id,
        amount_cents: 12_000 + i * 9_400,
        spent_at: d.toISOString().slice(0, 10),
        description: `${v.name} — ${v.category.replace(/_/g, " ")}`,
        status: "approved" as const,
      };
    }),
  );

  // -- the demo rows --------------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const { data: demoRows, error: demoErr } = await db
    .from("expenses")
    .insert(
      STRUCTURED.map((s) => ({
        org_id: nw,
        submitter_id: userId["priya@northwind.demo"],
        vendor_id: meridian.id,
        amount_cents: s.amount_cents,
        spent_at: today,
        description: `Meridian Consulting — ${s.phase} (${s.invoice})`,
        status: "draft" as const,
      })),
    )
    .select();
  if (demoErr) throw demoErr;

  // -- receipts -------------------------------------------------------------
  let uploaded = 0;
  for (const [i, row] of demoRows.entries()) {
    const file = join(RECEIPT_DIR, STRUCTURED[i].receipt);
    if (!existsSync(file)) {
      console.log(`\n  ! missing ${STRUCTURED[i].receipt} — run 'pnpm receipts' first`);
      continue;
    }
    const path = `${nw}/${row.id}.png`;
    const { error: upErr } = await db.storage
      .from("receipts")
      .upload(path, readFileSync(file), { contentType: "image/png", upsert: true });
    if (upErr) throw upErr;

    const { error: pathErr } = await db
      .from("expenses")
      .update({ receipt_path: path })
      .eq("id", row.id);
    if (pathErr) throw pathErr;
    uploaded += 1;
  }
  console.log(`receipts  ${uploaded} uploaded`);

  // -- summary --------------------------------------------------------------
  const total = STRUCTURED.reduce((s, x) => s + x.amount_cents, 0);
  console.log("\nDemo expenses (draft — submit one of these on stage):");
  for (const [i, row] of demoRows.entries()) {
    console.log(`  ${row.id}  ${usd(STRUCTURED[i].amount_cents)}  ${STRUCTURED[i].invoice}`);
  }
  console.log(`\n  combined ${usd(total)} vs a ${usd(400_000)} approval threshold`);

  console.log("\nLogins (password: " + DEMO_PASSWORD + ")");
  for (const p of PEOPLE.filter((x) => x.role !== "agent")) {
    console.log(`  ${p.email.padEnd(26)} ${p.role.padEnd(9)} ${p.org}`);
  }
  console.log(`  ${agentEmail!.padEnd(26)} agent     Northwind Labs  (password in .env.local)`);
}

main().catch((e) => {
  console.error("\nSeed failed:", e.message ?? e);
  process.exit(1);
});
