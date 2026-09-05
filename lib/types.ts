/**
 * Row shapes, mirroring supabase/migrations/.
 *
 * Hand-written rather than generated so the comments can explain intent. If
 * this drifts from the schema, regenerate with:
 *   pnpm exec supabase gen types typescript --linked
 */

export type UserRole = "employee" | "manager" | "finance" | "agent";

export type ExpenseStatus =
  | "draft"
  | "submitted"
  | "needs_review"
  | "approved"
  | "rejected";

export type FlagKind =
  | "over_threshold"
  | "structuring"
  | "duplicate"
  | "missing_receipt"
  | "policy_violation";

export type FlagSeverity = "info" | "warn" | "critical";

export type Expense = {
  id: string;
  org_id: string;
  submitter_id: string;
  vendor_id: string | null;
  amount_cents: number;
  currency: string;
  spent_at: string;
  description: string;
  status: ExpenseStatus;
  receipt_path: string | null;
  created_at: string;
};

export type Profile = {
  id: string;
  org_id: string;
  full_name: string;
  role: UserRole;
  manager_id: string | null;
};

export type ExpenseFlag = {
  id: string;
  expense_id: string;
  org_id: string;
  kind: FlagKind;
  severity: FlagSeverity;
  rationale: string;
  evidence: Record<string, unknown>;
  created_by: "agent" | "human";
  created_at: string;
};

export type AgentStep = {
  id: string;
  session_id: string;
  org_id: string;
  expense_id: string | null;
  event_type: string;
  title: string;
  detail: Record<string, unknown>;
  created_at: string;
};

export type ReceiptExtraction = {
  expense_id: string;
  org_id: string;
  merchant: string | null;
  total_cents: number | null;
  spent_at: string | null;
  confidence: number | null;
  extracted_at: string;
};

/** Amounts are integer cents everywhere. Never construct one from a float. */
export const dollars = (cents: number) =>
  (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });

export const STATUS_STYLE: Record<ExpenseStatus, string> = {
  draft: "bg-gray-100 text-gray-600",
  submitted: "bg-blue-50 text-blue-700",
  needs_review: "bg-amber-100 text-amber-800",
  approved: "bg-green-50 text-green-700",
  rejected: "bg-red-50 text-red-700",
};

export const SEVERITY_STYLE: Record<FlagSeverity, string> = {
  info: "border-gray-300 bg-gray-50",
  warn: "border-amber-400 bg-amber-50",
  critical: "border-red-500 bg-red-50",
};
