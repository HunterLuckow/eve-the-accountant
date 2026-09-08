# eve API notes

**Installed version:** `eve@0.51.1`
**Next.js:** `16.3.4`
**Verified:** 2026-09-05, by reading `node_modules/eve/dist/src/**/*.d.ts`

Everything below was read off the installed package's type definitions, not the
public docs. Where the two disagree, this file wins.

## Import paths — all confirmed present

| Path | Used for |
|---|---|
| `eve` | `defineAgent` |
| `eve/next` | `withEve` |
| `eve/react` | `useEveAgent` |
| `eve/tools` | `defineTool` |
| `eve/tools/approval` | `always`, `never`, `once` |
| `eve/hooks` | `defineHook` |
| `eve/connections` | MCP / OpenAPI connections |
| `eve/channels/eve` | `eveChannel` |
| `eve/channels/auth` | auth strategies + `AuthFn` |

## Approval — richer than the plan assumed

`approval` accepts **either** a bare policy function **or** a configuration object
with separate request- and response-time policies:

```ts
type Approval<TInput> = ApprovalPolicy<TInput> | {
  readonly request: ApprovalPolicy<TInput>;
  readonly response?: ApprovalResponsePolicy<TInput>;
};
```

### Request policy

```ts
type ApprovalPolicy<TInput> =
  (ctx: ApprovalContext<TInput>) => ApprovalStatus | Promise<ApprovalStatus>;
```

`ApprovalContext` **extends `SessionContext`**, so `ctx.session.auth.current` is
available — which is what the principal-conditional gate depends on. It also
carries `approvedTools`, `callId`, `toolName`, `toolInput`.

Valid `ApprovalStatus` returns:
`undefined | boolean | "not-applicable" | "approved" | "denied" | "user-approval"`,
or the object form `{ type: "...", reason?: string }`.

The plan's `"user-approval"` / `"not-applicable"` strings are correct.

### Response policy — this resolves spec §9

```ts
type ApprovalResponsePolicy<TInput> = (ctx: {
  readonly auth: { getToken(...): Promise<TokenResult>; requireAuth(...): never };
  readonly request: { callId; requestId; toolName; toolInput? };
  readonly response: { readonly decision: "approve" };
  readonly responder: SessionAuthContext;   // ← the authenticated human
  readonly session: { id; initiator; parent?; turn };
}) => { status: "allowed" } | { status: "rejected"; reason: string };
```

**Spec §9 asked whether the approval could carry the approver's identity. It can —
better than proposed.** eve authenticates the responder itself and hands the tool
a `SessionAuthContext` for them. A rejected response *keeps the request pending*,
so an unauthorized click does not consume the gate.

This means the approval gate can enforce "only finance may resolve this" **in eve**,
on top of RLS enforcing "only finance may write the row" in Postgres. Two
independent layers, neither of which is a prompt instruction.

Adopt in Task 17.

## Auth — `attributes` is required

```ts
interface SessionAuthContext {
  readonly attributes: Readonly<Record<string, string | readonly string[]>>;  // REQUIRED
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly issuer?: string;
  readonly subject?: string;
}

type AuthFn<TEvent = Request> =
  (event: TEvent) => SessionAuthContext | null | undefined | Promise<...>;
```

**Plan correction:** Task 13's `machineToken` omits `attributes`. It is not
optional — add `attributes: {}`.

`attributes` is the right home for the Supabase `org_id` and `user_role` claims,
because the approval response policy reads `ctx.responder.attributes`.

### Built-in strategies

`localDev()`, `none()`, `placeholderAuth()`, `httpBasic()`, `jwtHmac()`,
`jwtEcdsa()`, `oidc()`, `vercelOidc()`.

Lower-level verifiers are also exported: `verifyJwtHmac`, `verifyJwtEcdsa`,
`verifyOidc`, `extractBearerToken`, plus `UnauthenticatedError` / `ForbiddenError`
for structured 401/403 rejection.

**Do not use `oidc()` for Supabase user tokens.** It hardcodes
`principalType: "service"`, which would collapse the human/machine distinction the
approval gate depends on. Write a custom `AuthFn` using `verifyJwtEcdsa` so we
control `principalType` and can populate `attributes`.

### Verified against this project (2026-09-05)

`eve-demo-1` (`mxpbapqeksbfchiklwzg`) publishes an asymmetric signing key:

```
GET /auth/v1/.well-known/jwks.json
kid: d2561070-174d-4ac2-8b2b-de33cb04d942   alg: ES256   kty: EC
```

Two distinct token types exist in one project — do not confuse them:

| Token | Signing | Role |
|---|---|---|
| `anon` / `service_role` API key | HS256, static, 10y expiry | Legacy API key. Carries `role`, no user identity. |
| GoTrue user access token | **ES256**, rotatable, JWKS | Real sign-in identity. Carries `sub`, and our `org_id` / `user_role` claims. |

Task 13 therefore uses **`jwtEcdsa`**, fetching the PEM from that JWKS endpoint.
`VerifyJwtEcdsaConfig` wants a PEM-encoded public key, so the JWK has to be
converted (Node's `crypto.createPublicKey({ key: jwk, format: "jwk" })` then
`.export({ type: "spki", format: "pem" })`).

Issuer will be `https://mxpbapqeksbfchiklwzg.supabase.co/auth/v1`, audience
`authenticated`.

**`localDev()` only authenticates when `EVE_DEV=1` or `vercel dev`.** It is a
property of the deployment, never of the request — no header can flip it. It
authenticates nothing in production, so it is safe to leave in the array.

Auth resolution walks the array in order: first entry returning a context wins,
`null`/`undefined` skips, exhaustion returns 401.

## Session context — available in tools, hooks, and approval policies

```ts
interface SessionContext {
  readonly session: {
    readonly id: string;
    readonly auth: { readonly current: SessionAuthContext | null;
                     readonly initiator: SessionAuthContext | null };
    readonly turn: SessionTurn;
    readonly parent?: SessionParent;
  };
  getSandbox(): Promise<RuntimeSandboxSession>;
  getSkill(identifier: string): SkillHandle;
}
```

`ctx.session.id` (not `sessionId`) in authored code. `ctx.session.auth.current` is
the caller of the most recent request; `.initiator` is who created the session.
For a webhook-started session later resolved by a human, those differ — `initiator`
is the machine, `current` is whoever spoke last.

## Client — `respond()` answers approvals directly

`useEveAgent()` from `eve/react` returns, among others:

```ts
readonly send:    (message, options?) => Promise<void>;
readonly respond: (inputResponses, options?) => Promise<void>;  // "Answers pending HITL input requests"
readonly cancel:  () => Promise<CancelSessionResult>;
readonly resume:  () => Promise<void>;
readonly reset:   () => void;
```

Options include `auth`, `headers` (both accept **functions**, resolved before each
request — so a refreshed Supabase token needs no remount), `host`, `agent`,
`initialSession`, `initialEvents`.

Related exported types: `EveMessageInputRequest`, `ClientInputRespondedEvent`.

**Plan simplification:** Task 20's hand-rolled `/api/approvals/[requestId]` route is
not needed for the eve half — `respond()` does it. The route still has a job:
performing the Postgres write under the human's identity. Split it accordingly.

## Approval round trip — VERIFIED against eve 0.51.1 (Task 12 spike)

The public docs describe this incorrectly. What follows was captured from a
running server.

### The pause

A tool with `approval: always()` produces this event sequence:

```
step.completed
input.requested        <- the pause
turn.completed
session.waiting        <- parked, durably
```

`input.requested` payload:

```jsonc
{
  "type": "input.requested",
  "meta": { "at": "…", "id": "evt_01M20KKJRBCNC86A9RCE9728B2" },
  "data": {
    "requests": [                       // ARRAY — a turn can pause on several
      {
        "requestId": "aitxt-sw9FEDfuYF5jtdpWo0nZgrbG",
        "kind": "tool-approval",
        "display": "confirmation",
        "allowFreeform": false,
        "prompt": "Approve tool call: spike_confirm",
        "options": [
          { "id": "approve", "label": "Approve" },
          { "id": "cancel",  "label": "Cancel"  }
        ],
        "action": { "callId": "toolu_…", "toolName": "spike_confirm", "input": { … } }
      }
    ],
    "turnId": "turn_0", "stepIndex": 0, "sequence": 0
  }
}
```

Note `data.requests[0].requestId`, not a top-level field. The hook in Task 18
stores the whole event payload in `agent_steps.detail`, so the UI reads
`detail.requests[0].requestId`.

### The resolution

```
POST /eve/v1/session/:sessionId
content-type: application/json

{ "inputResponses": [ { "requestId": "aitxt-…", "optionId": "approve" } ] }

-> 202 { "ok": true, "sessionId": "wrun_…", "status": "accepted" }
```

**Two corrections to the published docs**, both of which return HTTP 400:

| Docs say | Actually |
|---|---|
| `inputResponses` is an object keyed by requestId | It is an **array** — `Expected 'inputResponses' to be a non-empty array.` |
| entries carry `{ decision: "approve" }` | entries carry **`{ requestId, optionId }`** — `Expected every 'inputResponses' entry to match the HITL response schema.` |

`optionId` must be one of the `options[].id` values from the request, i.e.
`"approve"` or `"cancel"`.

After a valid response the session resumes on a NEW turn (`turnId: "turn_1"`)
and emits `action.result` with the tool's output.

### The caller reaches the tool

`ctx.session.auth.current` inside `execute` reflects whichever channel AuthFn
won the walk. Verified:

| Request | principalType | principalId |
|---|---|---|
| no auth headers (dev) | `local-dev` | `local-dev` |
| `x-webhook-secret: …` | **`machine`** | `expense-webhook` |

This is what Task 17's approval gate keys on, and it works.

## Other findings

**`zod` must be a direct dependency.** eve's authored-package boundary refuses
to resolve it transitively:
`Cannot resolve package "zod" imported from ".../agent/tools/…"`. Files under
`agent/` may only import packages the project itself declares.

**New files under `agent/` need a dev-server restart.** They are not picked up
by the running watcher.

**eve ships a default tool harness.** `/eve/v1/info` lists these as
`owner: framework`, enabled with no configuration:

```
bash   read_file   write_file   todo   web_fetch   web_search
load_skill   ask_question   task_update   task_cancel   agent
connection_search
```

An expense-review agent does not need shell or filesystem access. See
`agent/agent.ts` for how this is narrowed.

## Deviations from the plan, to apply

1. **Task 13** — add `attributes: {}` to the `machineToken` AuthFn. Required field.
2. **Task 13** — write a custom Supabase `AuthFn` on `verifyJwtEcdsa` rather than
   `oidc()`, to control `principalType` and carry `org_id` / `user_role` in
   `attributes`.
3. **Task 17** — use the `{ request, response }` approval form. The response policy
   verifies the responder is `finance` via `ctx.responder.attributes.user_role`.
4. **Task 20** — use `respond()` from `useEveAgent` instead of proxying to
   `/eve/v1/session/:id/message`. Keep an app route only for the RLS-bound write.
5. **Task 12 (spike)** — still run it, but it is now lower risk. Confirm the
   `input.requested` payload shape and where `requestId` sits.

## Next.js 16 caveat

`create-next-app` wrote an `AGENTS.md` stating this Next.js version has breaking
changes versus older training data, and pointing at `node_modules/next/dist/docs/`.
Read those before writing App Router code in Tasks 10–11 — particularly around
`cookies()`, `params`, and middleware, which is exactly where `@supabase/ssr` binds.
