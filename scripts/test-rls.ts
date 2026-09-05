/**
 * Runs supabase/tests/rls.test.sql against the LINKED cloud project.
 *
 * `supabase test db` only targets a local Docker database. The claims this
 * suite makes are claims about the database that will be on stage, so it runs
 * against the real one. The whole file is wrapped in begin/rollback — nothing
 * it creates survives, including pgTAP itself.
 *
 *   pnpm test:rls
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const SQL_PATH = join(process.cwd(), "supabase/tests/rls.test.sql");

function run(): string {
  // Use -f rather than passing SQL as an argument. The test file begins with a
  // `--` comment, which the CLI's flag parser consumes as an option: it prints
  // its help text and exits non-zero, with the SQL echoed back and no error
  // message. -f also avoids sending ~9KB through argv.
  try {
    return execFileSync(
      "pnpm",
      ["exec", "supabase", "db", "query", "--linked", "-f", SQL_PATH],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return (err.stdout ?? "") + (err.stderr ?? "") + err.message;
  }
}

const raw = run();

// The CLI wraps results in JSON; pull out every TAP line wherever it sits.
const tap: string[] = [];
for (const m of raw.matchAll(/"[^"]*?((?:not )?ok \d+[^"]*)"/g)) tap.push(m[1]);
if (tap.length === 0) {
  for (const line of raw.split("\n")) {
    if (/^\s*(not )?ok \d+/.test(line) || /^\s*# /.test(line)) tap.push(line.trim());
  }
}

if (tap.length === 0) {
  console.error("No TAP output. Raw response:\n");
  console.error(raw.slice(0, 4000));
  process.exit(1);
}

let failed = 0;
for (const line of tap) {
  const isFail = line.startsWith("not ok");
  if (isFail) failed += 1;
  console.log(`${isFail ? "✗" : "✓"} ${line.replace(/^(not )?ok \d+ - ?/, "")}`);
}

console.log("");
if (failed > 0) {
  console.error(`${failed} of ${tap.length} assertions FAILED`);
  process.exit(1);
}
console.log(`All ${tap.length} assertions passed.`);
