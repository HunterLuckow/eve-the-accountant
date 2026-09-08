/**
 * Proves the agent has no network egress.
 *
 * WHY THIS IS A SEPARATE, MODEL-FREE CHECK
 *
 * Asked to fetch a URL, the model declines — it reads the tool descriptions
 * and refuses before calling anything. That is the soft layer, and it is worth
 * having, but it is not a guarantee: a more persuasive injection might get the
 * call made. What has to be true is that calling the tool ACHIEVES nothing.
 *
 * So this invokes execute() directly, bypassing the model entirely, and
 * asserts the refusal holds at the only layer that cannot be talked out of it.
 *
 * Same shape as the RLS argument. The description is advice; the
 * implementation is physics.
 *
 *   pnpm check:egress
 */
import webFetchModule from "../agent/tools/web_fetch";
import webSearchModule from "../agent/tools/web_search";

type Tool = {
  description: string;
  execute: (input: unknown, ctx?: unknown) => Promise<unknown>;
};

/** tsx resolves these through CJS interop, so unwrap a nested default. */
function unwrap(mod: unknown): Tool {
  const m = mod as { default?: unknown };
  return ((m.default ?? m) as Tool);
}

let failures = 0;
function report(ok: boolean, label: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
}

async function main() {
  const webFetch = unwrap(webFetchModule);
  const webSearch = unwrap(webSearchModule);

  const fetched = (await webFetch.execute({ url: "https://example.com" })) as {
    refused?: boolean;
    attemptedUrl?: string;
  };
  report(fetched.refused === true, "web_fetch.execute refuses");
  report(
    fetched.attemptedUrl === "https://example.com",
    "web_fetch records the attempted URL for the audit trail",
  );

  const searched = (await webSearch.execute({ query: "price of gold" })) as {
    refused?: boolean;
    attemptedQuery?: string;
  };
  report(searched.refused === true, "web_search.execute refuses");
  report(
    searched.attemptedQuery === "price of gold",
    "web_search records the attempted query",
  );

  report(
    /disabled/i.test(webFetch.description) && /disabled/i.test(webSearch.description),
    "descriptions tell the model the tools are disabled",
  );

  // Nothing in these modules may import a network client. A regression here
  // would mean someone reintroduced egress while leaving the refusal text.
  const { readFileSync } = await import("node:fs");
  for (const file of ["agent/tools/web_fetch.ts", "agent/tools/web_search.ts"]) {
    const src = readFileSync(file, "utf8");
    const hasNetwork = /\bfetch\s*\(|node:https?|axios|undici/.test(
      src.replace(/web_fetch/g, ""),
    );
    report(!hasNetwork, `${file} contains no network call`);
  }

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All checks passed. The agent cannot reach the network.");
}

main().catch((e) => {
  console.error("\ncheck-egress failed:", e.message ?? e);
  process.exit(1);
});
