/**
 * Exercises the eve channel's auth policy directly.
 *
 * These AuthFns decide whether a turn is human- or machine-initiated, which is
 * what makes the approval gate fire (or not). Testing them in isolation means
 * no model, no session, no AI Gateway credential.
 *
 *   pnpm check:auth
 */
import { supabaseUser, webhookMachine } from "../agent/channels/eve";

let failures = 0;

function report(ok: boolean, label: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
}

const req = (headers: Record<string, string>) =>
  new Request("https://example.test/eve/v1/session", { headers });

async function supabaseToken(email: string, password: string): Promise<string> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    },
  );
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!json.access_token) throw new Error(`Login failed for ${email}: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function main() {
  // -- a real signed-in human ------------------------------------------------
  const danaToken = await supabaseToken("dana@northwind.demo", "demo-password-1234");
  const dana = await supabaseUser(req({ authorization: `Bearer ${danaToken}` }));

  report(!!dana, "finance token authenticates");
  report(dana?.principalType === "user", "principalType is 'user'", String(dana?.principalType));
  report(
    dana?.attributes?.user_role === "finance",
    "user_role carried into attributes",
    String(dana?.attributes?.user_role),
  );
  report(!!dana?.attributes?.org_id, "org_id carried into attributes");
  report(dana?.authenticator === "supabase", "authenticator tagged");

  // -- the agent's own token is still a 'user' principal ---------------------
  const agentToken = await supabaseToken(
    process.env.AGENT_EMAIL!,
    process.env.AGENT_PASSWORD!,
  );
  const agent = await supabaseUser(req({ authorization: `Bearer ${agentToken}` }));
  report(
    agent?.attributes?.user_role === "agent",
    "agent token carries user_role=agent",
    String(agent?.attributes?.user_role),
  );

  // -- rejections -----------------------------------------------------------
  report(
    (await supabaseUser(req({}))) === null,
    "no Authorization header -> skip",
  );
  report(
    (await supabaseUser(req({ authorization: "Bearer not.a.token" }))) === null,
    "malformed token -> skip",
  );

  // The anon key is a valid JWT, but HS256 and issued for a different purpose.
  // It must not authenticate a user.
  report(
    (await supabaseUser(
      req({ authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}` }),
    )) === null,
    "anon key is NOT accepted as a user token",
  );

  // A token whose signature has been tampered with.
  const tampered = danaToken.slice(0, -4) + "AAAA";
  report(
    (await supabaseUser(req({ authorization: `Bearer ${tampered}` }))) === null,
    "tampered signature -> skip",
  );

  // -- the machine principal ------------------------------------------------
  const machine = await webhookMachine(
    req({ "x-webhook-secret": process.env.WEBHOOK_SECRET! }),
  );
  report(machine?.principalType === "machine", "webhook secret -> 'machine'", String(machine?.principalType));
  report(machine?.principalId === "expense-webhook", "machine principalId set");

  report(
    (await webhookMachine(req({ "x-webhook-secret": "wrong" }))) === null,
    "wrong webhook secret -> skip",
  );
  report((await webhookMachine(req({}))) === null, "no webhook header -> skip");

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All checks passed. Human and machine callers are distinguishable.");
}

main().catch((e) => {
  console.error("\ncheck-channel-auth failed:", e.message ?? e);
  process.exit(1);
});
