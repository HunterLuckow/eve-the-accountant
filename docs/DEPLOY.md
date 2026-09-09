# Deploying

Local development is fully working before any of this. The deploy exists for
one reason the demo genuinely needs: **`pg_net` runs inside Supabase's cloud
and cannot reach your laptop**, so the Database Webhook has to call a public
URL.

The alternative for local work is a tunnel — see the end.

---

## 1 · Link the project

Interactive; run these yourself.

```bash
pnpm dlx vercel login
pnpm dlx vercel link
```

Accept the defaults. It will detect Next.js.

---

## 2 · Environment variables

Everything except the AI Gateway key, which Vercel supplies itself.

```bash
pnpm dlx vercel env add NEXT_PUBLIC_SUPABASE_URL production
pnpm dlx vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
pnpm dlx vercel env add SUPABASE_SERVICE_ROLE_KEY production
pnpm dlx vercel env add AGENT_EMAIL production
pnpm dlx vercel env add AGENT_PASSWORD production
pnpm dlx vercel env add WEBHOOK_SECRET production
```

Paste each value from `.env.local` when prompted.

**`AI_GATEWAY_API_KEY` — set it only if OIDC fails.** On Vercel, eve
authenticates to AI Gateway with OIDC and no key is needed. That is the better
setup: one fewer credential to rotate.

But OIDC still bills to the account, and an account with no payment method on
file is refused:

```
statusCode: 403   upstreamType: 'customer_verification_required'
'AI Gateway requires a valid credit card on file to service requests.'
```

The failure is quiet from the outside — the app works, `/eve/v1/info` reports
`connected: true`, sessions start and return a session id, and then no step
after `session.started` ever appears. Look in the runtime logs, where eve says
plainly:

```
[eve:harness.tool-loop] model call failed — parking session for retry by the user
```

Either add a payment method to the deploying account, or set the key:

```bash
pnpm dlx vercel env add AI_GATEWAY_API_KEY production
```

`/eve/v1/info` will then report `credential: "api-key"` instead of `"oidc"`.

Worth noticing in that log line: eve did not lose the session. It parked it
durably for retry. A model outage does not destroy in-flight work.

Note what `SUPABASE_SERVICE_ROLE_KEY` is for here: `scripts/seed.ts` and
`scripts/reset.ts` only. Nothing in `agent/` or in a rendered page touches it,
and that is enforced by review rather than by tooling — worth checking if you
extend this.

---

## 3 · Deploy

```bash
pnpm dlx vercel deploy --prod
```

Note the URL it prints.

---

## 4 · Point the webhook at production

```bash
set -a && source .env.local && set +a
pnpm webhook:target https://your-app.vercel.app
```

This updates the `app_base_url` secret in Supabase Vault, which the trigger
reads at call time. No migration, no redeploy.

Confirm:

```bash
pnpm webhook:target        # prints the current target and whether the secret is set
```

---

## 5 · Verify end to end

```bash
pnpm reset                 # prints the demo expense ids
```

Open `https://your-app.vercel.app/expense/<MC-2291 id>`, signed in as
`dana@northwind.demo`. Then, in the Supabase SQL editor:

```sql
update expenses set status = 'submitted' where id = '<MC-2291 id>';
```

Steps should appear in the browser within a few seconds, and the approval
panel a minute or so later.

If nothing happens:

```sql
select id, status_code, error_msg, created
from net._http_response order by created desc limit 5;
```

- `Couldn't connect to server` — wrong URL in Vault, or the deploy is not live
- `401` — `WEBHOOK_SECRET` in Vercel does not match the one in Vault
- no rows at all — the trigger did not fire; check the expense actually moved
  to `submitted`, and that it was not already `submitted`

---

## Working locally instead

`pg_net` cannot reach `localhost`, so expose the dev server:

```bash
cloudflared tunnel --url http://localhost:3000
# or: ngrok http 3000

pnpm webhook:target https://whatever.trycloudflare.com
```

Remember to point it back at production before the talk. `pnpm webhook:target`
with no argument tells you where it currently points, and the runbook's
pre-flight checklist includes it for exactly this reason.

---

## Cost

Two things bill per demo run:

- **AI Gateway** — a review is a handful of model calls plus one image.
  `agent/agent.ts` caps a session at `maxTokenCostUsdPerSession: 1.5`.
- **Vercel Sandbox** — provisioned by eve for the default `bash` tool. This
  project overrides that tool, so no sandbox is provisioned during a review.

Supabase usage for this dataset is inside the free tier.
