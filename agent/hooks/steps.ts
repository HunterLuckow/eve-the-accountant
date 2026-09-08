import { defineHook } from "eve/hooks";
import { getAgentDb, getAgentOrgId } from "../lib/agent-db";

/**
 * Mirrors the agent's runtime events into `agent_steps`, which Realtime
 * broadcasts to every open browser.
 *
 * WHY A HOOK AND NOT A TOOL
 *
 * The obvious alternative is a `log_step` tool the model calls as it works.
 * That produces a narration of what the model SAYS it did, which can drift
 * from what it did — a model that skips a step can still describe it.
 *
 * A hook subscribes to the runtime's own event stream, after each event is
 * durably recorded. It cannot flatter. If `find_related_expenses` never ran,
 * no row appears, regardless of what the summary claims. That is what makes
 * the timeline on screen evidence rather than decoration.
 *
 * Hooks are observe-only: they cannot inject context or change the turn.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO
 *
 * 1. It skips streaming deltas (`action.input.appended`, `message.appended`).
 *    Those fire many times per second while a tool call or message is being
 *    composed. Writing them would flood Postgres, flood Realtime, and produce
 *    a timeline nobody can read.
 *
 * 2. It strips keys beginning with `_`. read_receipt returns ~195KB of base64
 *    under `_imageBase64` so the model can see the image; persisting that
 *    would put a receipt into every timeline payload and push it out over
 *    websockets to every viewer. The convention is declared in
 *    agent/tools/read_receipt.ts.
 */

/**
 * What reaches the timeline.
 *
 * An allowlist rather than a denylist, because eve emits event types this
 * project has never seen — `reasoning.appended` turned up only when the hook
 * was first run against a real review. A denylist silently admits every new
 * event type into the UI; an allowlist silently ignores them, which is the
 * right failure direction for something on a projector.
 *
 * Deliberately excluded:
 *   actions.requested   duplicates action.result — the tool appears twice
 *   step.completed      runtime bookkeeping, means nothing to a reviewer
 *   reasoning.appended  streaming deltas, many per second
 *   message.completed   fires once per step, so "Wrote a summary" repeats
 *                       four times; the summary belongs in the conversation
 *                       pane, not the activity timeline
 *   session.waiting     redundant right after "Waiting for a human"
 */
const RECORD = new Set([
  "session.started",
  "action.result",
  "input.requested",
  "approval.candidate",
  "turn.completed",
]);

/** Recursively drop `_`-prefixed keys and clamp oversized strings. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}… [truncated]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("_")) {
        out[k] = "[omitted]";
        continue;
      }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pulls an expense id out of known fields only.
 *
 * A regex sweep over the whole payload would also match org_id, flag ids and
 * user ids — and agent_steps.expense_id is a foreign key, so a wrong guess
 * fails the insert and loses the step entirely.
 */
function expenseIdFrom(data: unknown): string | null {
  const seen: string[] = [];
  const walk = (v: unknown, depth = 0) => {
    if (depth > 6 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1));
      return;
    }
    for (const [k, val] of Object.entries(v)) {
      if (k === "expenseId" && typeof val === "string" && UUID.test(val)) seen.push(val);
      if (k === "expenseIds" && Array.isArray(val)) {
        for (const x of val) if (typeof x === "string" && UUID.test(x)) seen.push(x);
      }
      walk(val, depth + 1);
    }
  };
  walk(data);
  return seen[0] ?? null;
}

/** Human-readable, tool-specific where it helps. */
function titleFor(type: string, data: Record<string, unknown>): string {
  const toolTitles: Record<string, string> = {
    get_expense: "Looked up the expense",
    read_receipt: "Read the receipt",
    record_extraction: "Recorded what the receipt says",
    find_related_expenses: "Checked for related charges",
    flag_expense: "Recorded a finding",
    request_human_review: "Escalated to a human",
    web_fetch: "Blocked: attempted to fetch a URL",
    web_search: "Blocked: attempted a web search",
    bash: "Blocked: attempted a shell command",
  };

  switch (type) {
    case "session.started":
      return "Started reviewing";
    case "action.result": {
      const result = data.result as
        | { toolName?: string; output?: Record<string, unknown> }
        | undefined;
      const name = result?.toolName;
      if (!name) return "Tool finished";

      // load_skill is worth naming specifically: "Loaded Expense Policy v1"
      // tells a reviewer something, "Ran load_skill" does not.
      //
      // Its output is the skill's markdown, not a structured object, so the
      // name comes from the document's own first heading.
      if (name === "load_skill") {
        const markdown = typeof result?.output === "string" ? result.output : "";
        const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
        return heading ? `Loaded: ${heading}` : "Loaded a skill";
      }
      return toolTitles[name] ?? `Ran ${name}`;
    }
    case "input.requested":
      return "Waiting for a human";
    case "approval.candidate": {
      const outcome = String(data.outcome ?? "");
      if (outcome === "rejected") return "Approval refused — not authorised";
      if (outcome === "pending") return "Approval attempt received";
      return "Approval accepted";
    }
    case "message.completed":
      return "Wrote a summary";
    case "turn.completed":
      return "Finished";
    case "session.waiting":
      return "Waiting";
    default:
      return type;
  }
}

export default defineHook({
  events: {
    async "*"(event, ctx) {
      if (!RECORD.has(event.type)) return;

      const data = ((event as { data?: unknown }).data ?? {}) as Record<string, unknown>;

      try {
        const db = await getAgentDb();
        const orgId = await getAgentOrgId();

        await db.from("agent_steps").upsert(
          {
            // The runtime's own event id. Retried turns re-emit events with
            // fresh ids, so conflicts here mean a genuine duplicate delivery
            // rather than a retry — let them fall through silently.
            id: event.meta.id,
            session_id: ctx.session.id,
            org_id: orgId,
            expense_id: expenseIdFrom(data),
            event_type: event.type,
            title: titleFor(event.type, data),
            detail: redact(data) as Record<string, unknown>,
          },
          { onConflict: "id", ignoreDuplicates: true },
        );
      } catch (error) {
        // A hook must never take down a turn. Losing a timeline row is a
        // cosmetic failure; losing the review is not.
        console.error(
          `[steps hook] could not record ${event.type}:`,
          error instanceof Error ? error.message : error,
        );
      }
    },
  },
});
