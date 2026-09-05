/**
 * Proves what the agent's Postgres identity can and cannot do.
 *
 * This is the demo's central claim, checked against the live database with no
 * model involved. Run it after any migration that touches policies.
 *
 *   pnpm check:agent
 */
import { getAgentDb, getAgentOrgId, getAgentUserId } from "../agent/lib/agent-db";

let failures = 0;

function report(ok: boolean, label: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
}

async function main() {
  const db = await getAgentDb();
  const orgId = await getAgentOrgId();
  const userId = await getAgentUserId();

  console.log(`agent user  ${userId}`);
  console.log(`agent org   ${orgId}\n`);

  // -- CAN READ --------------------------------------------------------------
  const { count: visible } = await db
    .from("expenses")
    .select("*", { count: "exact", head: true });
  report((visible ?? 0) > 0, "can read expenses", `${visible} visible`);

  const { count: otherOrg } = await db
    .from("expenses")
    .select("*", { count: "exact", head: true })
    .neq("org_id", orgId);
  report(otherOrg === 0, "cannot see other tenants", `${otherOrg} rows`);

  // -- CANNOT APPROVE --------------------------------------------------------
  const { data: approved, error: approveErr } = await db
    .from("expenses")
    .update({ status: "approved" })
    .eq("org_id", orgId)
    .select("id");
  report(
    (approved?.length ?? 0) === 0,
    "CANNOT approve any expense",
    `${approved?.length ?? 0} rows changed${approveErr ? ` (${approveErr.code})` : ""}`,
  );

  // -- CAN ESCALATE, NARROWLY ------------------------------------------------
  // Find a submitted expense to escalate, or make one via the seed's drafts.
  const { data: submitted } = await db
    .from("expenses")
    .select("id, amount_cents")
    .eq("org_id", orgId)
    .eq("status", "submitted")
    .limit(1)
    .maybeSingle();

  if (submitted) {
    // ORDER MATTERS. The collateral-write attack has to run while the row is
    // still `submitted`, because the escalate policy's USING clause only
    // matches that status. Run it after a successful escalation and the
    // statement matches zero rows, the trigger never fires, and the test
    // passes or fails for reasons unrelated to what it claims to check.
    const { error: sneakyErr } = await db
      .from("expenses")
      .update({ status: "needs_review", amount_cents: 1 })
      .eq("id", submitted.id);
    report(
      !!sneakyErr,
      "CANNOT change amount while escalating",
      sneakyErr?.message?.slice(0, 55) ?? "UPDATE SUCCEEDED — trigger regression",
    );

    const { data: unchanged } = await db
      .from("expenses")
      .select("amount_cents, status")
      .eq("id", submitted.id)
      .maybeSingle();
    report(
      unchanged?.amount_cents === submitted.amount_cents &&
        unchanged?.status === "submitted",
      "row is untouched after the attempt",
      `${unchanged?.amount_cents} / ${unchanged?.status}`,
    );

    const { data: escalated } = await db
      .from("expenses")
      .update({ status: "needs_review" })
      .eq("id", submitted.id)
      .select("id");
    report((escalated?.length ?? 0) === 1, "CAN escalate submitted -> needs_review");

    // Put it back so the demo dataset is unchanged.
    const { data: reverted } = await db
      .from("expenses")
      .update({ status: "submitted" })
      .eq("id", submitted.id)
      .select("id");
    // needs_review -> submitted is NOT a permitted agent transition, so this
    // should fail. Confirms the grant is one-directional.
    report(
      (reverted?.length ?? 0) === 0,
      "CANNOT un-escalate (needs_review -> submitted)",
      `${reverted?.length ?? 0} rows changed`,
    );
  } else {
    console.log("  (no submitted expense to escalate — skipping escalation checks)");
  }

  // Approving is still refused, from any starting status.
  const { data: stillCannot } = await db
    .from("expenses")
    .update({ status: "approved" })
    .eq("org_id", orgId)
    .select("id");
  report(
    (stillCannot?.length ?? 0) === 0,
    "CANNOT approve, from any status",
    `${stillCannot?.length ?? 0} rows changed`,
  );

  // -- CAN RECORD FINDINGS ---------------------------------------------------
  const { data: target } = await db
    .from("expenses")
    .select("id")
    .eq("org_id", orgId)
    .limit(1)
    .maybeSingle();

  const { data: flag, error: flagErr } = await db
    .from("expense_flags")
    .insert({
      expense_id: target!.id,
      org_id: orgId,
      kind: "policy_violation",
      severity: "info",
      rationale: "check-agent.ts probe — safe to delete",
      created_by: "agent",
    })
    .select("id")
    .maybeSingle();
  report(!!flag, "CAN record a finding", flagErr?.message ?? "");

  // -- CANNOT APPROVE, PART TWO ----------------------------------------------
  const { error: apprErr } = await db.from("approvals").insert({
    expense_id: target!.id,
    org_id: orgId,
    approver_id: userId,
    decision: "approved",
  });
  report(
    apprErr?.code === "42501",
    "CANNOT write an approval record",
    apprErr ? `${apprErr.code}` : "INSERT SUCCEEDED — policy regression",
  );

  // -- STORAGE ---------------------------------------------------------------
  const { data: withReceipt } = await db
    .from("expenses")
    .select("receipt_path")
    .not("receipt_path", "is", null)
    .limit(1)
    .maybeSingle();

  if (withReceipt?.receipt_path) {
    const { data: signed } = await db.storage
      .from("receipts")
      .createSignedUrl(withReceipt.receipt_path, 60);
    report(!!signed?.signedUrl, "CAN read a receipt (signed URL)");
  }

  const { error: uploadErr } = await db.storage
    .from("receipts")
    .upload(`${orgId}/forged-${Date.now()}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      contentType: "image/png",
    });
  report(!!uploadErr, "CANNOT upload a receipt", uploadErr?.message ?? "UPLOAD SUCCEEDED");

  // -- cleanup ---------------------------------------------------------------
  if (flag) {
    // The agent has no DELETE policy on expense_flags, so it cannot remove its
    // own probe row. That is itself correct: findings are an audit trail.
    console.log(`\n  (probe flag ${flag.id} left in place — agent has no DELETE policy)`);
  }

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All checks passed. The agent is a constrained principal.");
}

main().catch((e) => {
  console.error("\ncheck-agent failed:", e.message ?? e);
  process.exit(1);
});
