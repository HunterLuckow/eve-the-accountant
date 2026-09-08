import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Builds a tool that replaces one of eve's built-ins with a refusal.
 *
 * An authored tool whose filename matches a framework tool replaces it, so
 * each file under agent/tools/ that uses this removes a capability from the
 * model-facing tool set.
 *
 * WHY REMOVE ANYTHING
 *
 * Two different reasons, worth keeping distinct:
 *
 *   Egress (web_fetch, web_search) is a SECURITY boundary. This agent reads
 *   receipt images, which are untrusted input; injection plus egress is a
 *   breach. Those two have their own files with the full argument.
 *
 *   The sandbox tools (bash, read_file, write_file) are a BEHAVIOUR problem.
 *   They are genuinely sandboxed — verified: bash runs as vercel-sandbox in an
 *   empty container and cannot see the host. But leaving them available meant
 *   that when load_skill failed, the agent ran `find / -iname "*expense*polic*"`
 *   looking for the policy, burning a turn and provisioning a sandbox to
 *   search an empty filesystem.
 *
 *   An unnecessary tool is not free even when it is safe. It is a suggestion
 *   to the model about what kind of problem this is, and the wrong suggestion
 *   costs turns and produces confusing output.
 *
 * Refusals return a structured result rather than throwing, so the model can
 * recover and explain, and agent/hooks/steps.ts records the attempt.
 */
export function disabledTool(options: {
  /** What the model sees. Say plainly that it is unavailable and what to do instead. */
  description: string;
  /** Why, in the tool result, addressed to the model. */
  reason: string;
}) {
  return defineTool({
    description: options.description,
    // Permissive on purpose: the point is to refuse gracefully whatever the
    // model passes, not to reject on a schema mismatch it cannot interpret.
    inputSchema: z.object({}).passthrough(),
    async execute(input) {
      return {
        refused: true,
        reason: options.reason,
        attemptedInput: input ?? null,
      };
    },
  });
}
