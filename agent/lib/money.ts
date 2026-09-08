/**
 * Amounts are integer cents everywhere — in the schema, in tool inputs, in
 * tool outputs. Never construct one from a float.
 *
 * Duplicated from lib/types.ts rather than imported because files under
 * agent/ sit behind eve's authored-package boundary and should not reach into
 * the Next.js app's module graph.
 */
export const dollars = (cents: number) =>
  (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
