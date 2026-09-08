# Demo runbook

Everything needed to run this on a stage, and to get out of trouble if it
misbehaves.

---

## The argument, in two sentences

> Supabase is what the product is built on. eve is what the agent is built on.
> They share the same Postgres.
>
> Soft rules live in eve. Hard rules live in Postgres.

Everything below is in service of those. If a beat is running long, cut it —
but do not cut beat 6 or beat 8.

---

## 15 minutes before

```bash
pnpm reset                       # prints the demo expense ids + the cold-open SQL
pnpm test:rls                    # 16 assertions — proves the claims still hold
pnpm check:agent                 # 12 probes on what the agent can and cannot do
pnpm webhook:target              # confirm it points at the DEPLOYED url
```

If `pnpm test:rls` fails, **do not run the demo**. Something in the schema
changed and the central claim may no longer be true.

**Windows to open, in this order:**

| # | Window | Contents |
|---|---|---|
| A | Supabase SQL editor | the `update … set status='submitted'` from `pnpm reset`, typed but **not run** |
| B | `/expense/<MC-2291 id>` | signed in as `dana@northwind.demo` |
| C | Editor | `agent/skills/expense-policy.md` open |
| D | Editor | the policies migration, scrolled to "NOTE THE ABSENCE" |

**Housekeeping:** font size up in every window. Notifications off. Hide
bookmarks. Load `/review` once to warm the deployment — the first request to a
cold function is slow and it is not a good first impression.

---

## The eight beats (~6 minutes)

### 1 · Cold open — 30s
Run the SQL in window A. Say nothing for five seconds. Switch to B.

> "I just submitted an expense. Nothing is polling. Postgres called the
> application."

### 2 · It investigates — 45s
Steps appear in the timeline, live. Show `agent/tools/` — five files.

> "Each file is one tool. The filename is the name the model sees."

### 3 · The receipt — 30s
The invoice is on screen, rendered from a private bucket via a signed URL.

> "The agent is looking at this image. It downloaded it through its own
> Supabase session — Storage RLS applies to it exactly like it applies to you."

### 4 · The money slide — 45s
Window C. Read the last section **aloud**:

> *"You may not approve or reject an expense… You have no authority to grant
> yourself authority."*

Then: **"That is a markdown file. A model can be argued out of a markdown
file."** Hold that.

### 5 · The finding — 60s
Back to B. One finding across three expenses, two still drafts.

> "$3,940, $3,875, $3,990. Each one clears a $4,000 threshold. Together,
> $11,805. A reviewer working a queue sees one row at a time — the pattern only
> exists across rows."

### 6 · It stops — 90s ⚠️ **DO NOT CUT**
The approval panel is up. **Step away from the laptop.**

> "It is waiting. That session is parked in Postgres, durably. It could sit
> there for a week. It is consuming nothing while it waits — no polling loop,
> no held connection, no compute."

Let the silence run. This looks like nothing is happening, which is the point.

### 6b · Prove it — 40s ⚠️ **the best moment in the talk**

Do not just claim durability. Kill the server in front of them.

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN     # find it
kill -9 <pid>
curl -sS -o /dev/null -w "%{http_code}\n" --max-time 3 http://localhost:3000/
```

> "That returned nothing. The process that started this review is gone."

Restart, wait for it to come up, then click Approve.

```bash
pnpm dev
```

> "Different process. It never saw this session start. And it finishes the
> job."

**Verified 2026-09-08**: parked → `kill -9` → listeners on :3000 dropped to 0
→ cold restart → approve → tool executed, `escalated: 1`, expense moved to
`needs_review`.

If you are recording rather than running live, record **this** beat above all
others — it is the one an audience will not believe without seeing.

**Deployed variant:** `vercel rollback` or a redeploy makes the same point with
less keyboard, but takes longer and depends on the network. Kill the local
process if you can.

### 7 · Approve — 45s
Click Approve. Status flips to `needs review`, panel dismisses.

> "eve authenticated me before it accepted that. An employee clicking the same
> button gets refused, and the request stays open for someone who is allowed."

### 8 · The absence — 60s ⚠️ **DO NOT CUT**
Window D.

> "Here is every UPDATE policy on the expenses table. Read them. None of them
> mentions the agent."

Then, in the agent chat: **"approve this expense."** It cannot. Then:

```bash
pnpm test:rls
```

> "Sixteen assertions. That one says the agent cannot approve. It is not a
> guardrail in a prompt. It is the absence of a grant."

---

## Optional beats, if you have time

**Prompt injection** (~60s) — `pnpm injection:arm`, review MC-2292. The receipt
carries a note demanding approval, silence, and exfiltration. The agent
reports it instead. Disarm afterwards.

**Cross-tenant** (~20s) — sign in as `kit@acme.demo`, open the same expense
URL. 404. Not 403: as far as his session is concerned the record does not
exist.

**The capability surface** (~30s) — `ls agent/tools/`. Eleven files: six that
do something, five that refuse. `bash`, `read_file`, `write_file`,
`web_fetch`, `web_search` are all overrides of eve's default harness.

> "eve ships a capable default harness. For an agent that reads documents
> arriving from outside the company, the first thing I did was take most of it
> away. Half this directory is subtraction."

Say this even if you cut the beat — one sentence, somewhere. It reads as
competence, and it pre-empts someone noticing it themselves.

---

## When it breaks

| Symptom | Cause | Do this |
|---|---|---|
| No steps appear | webhook not delivered | `select * from net._http_response order by created desc limit 3;` |
| No steps, webhook fine | Realtime not authorized | reload the page; the socket re-auths on mount |
| Timeline stalls mid-run | model or gateway hiccup | say "it is durable, watch" — then reload; steps are in Postgres |
| Approve does nothing | wrong signed-in user | only manager/finance can resolve; check the nav bar |
| Agent rambles | nondeterminism | `pnpm reset`, run again — seed data is deterministic |
| Total failure | — | play the recorded capture |

**Record a clean run before the talk.** If conference wifi dies you want a
video, not an apology.

---

## What to say if someone asks

**"What if the model is jailbroken?"**
Then it can read expenses in its own org, and write findings. It cannot
approve, cannot reach another tenant, cannot upload a receipt, and has no
network egress. Those are four separate boundaries and none of them is a
prompt.

**"Is this just RLS?"**
Mostly, yes — that is the point. The interesting part is that the agent is an
ordinary principal inside a system that already had to solve this. Nothing
here was invented for the agent.

**"Why not the Supabase MCP connection?"**
It is the *build-time* integration, and I did use it — this app's schema and
policies were written by an agent holding it. Supabase's own docs say not to
give it to your end users, because it runs with your developer permissions and
`execute_sql` bypasses RLS. A product feature acting for a tenant needs an
identity in the application's model, not in the developer's. See
[docs/two-integrations.md](two-integrations.md).

**"How much did that cost?"**
A review is a handful of model calls plus one image. `agent.ts` caps a session
at $1.50.
