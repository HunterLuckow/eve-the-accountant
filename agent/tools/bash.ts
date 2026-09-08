import { disabledTool } from "../lib/disabled-tool";

/**
 * Overrides eve's built-in bash. See agent/lib/disabled-tool.ts.
 *
 * Removed for behaviour, not danger: it is sandboxed and cannot reach the
 * host. But when load_skill failed once, the agent ran
 * `find / -iname "*expense*polic*"` hunting for the policy file — a wasted
 * turn searching an empty container. This agent's world is Postgres.
 */
export default disabledTool({
  description:
    "Unavailable. This agent has no shell. Expense data lives in Postgres and " +
    "is reached through the expense tools; policy lives in skills.",
  reason:
    "There is no shell and no filesystem to search. Everything you need is in " +
    "the expense tools (get_expense, find_related_expenses, read_receipt) and " +
    "the loaded skills. If a tool failed, say so rather than looking elsewhere.",
});
