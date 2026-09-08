import { disabledTool } from "../lib/disabled-tool";

/**
 * Overrides eve's built-in write_file.
 *
 * Worth removing on its own merits: the agent's outputs belong in Postgres as
 * expense_flags and receipt_extractions rows, where they are attributable,
 * queryable, and subject to the same policies as everyone else's writes. A
 * file in a sandbox is none of those things and disappears with the session.
 */
export default disabledTool({
  description:
    "Unavailable. Record findings with flag_expense rather than writing files.",
  reason:
    "There is no filesystem, and findings written to one would be lost. Record " +
    "what you find with flag_expense so it is attributable and auditable.",
});
