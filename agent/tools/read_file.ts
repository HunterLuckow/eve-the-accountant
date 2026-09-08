import { disabledTool } from "../lib/disabled-tool";

/** Overrides eve's built-in read_file. See agent/lib/disabled-tool.ts. */
export default disabledTool({
  description:
    "Unavailable. This agent has no filesystem. Use the expense tools instead.",
  reason:
    "There is no filesystem. Expense records, receipts and findings are all " +
    "reached through the expense tools, under row-level security.",
});
