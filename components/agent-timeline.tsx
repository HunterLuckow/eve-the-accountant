"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { AgentStep } from "@/lib/types";

/**
 * The agent's work, live.
 *
 * Subscribes to `agent_steps` over Realtime. Three things worth knowing, each
 * of which cost an hour to discover:
 *
 * 1. REALTIME APPLIES RLS. Postgres evaluates the same steps_select policy on
 *    every change before delivering it, so a subscriber cannot listen their
 *    way around a policy. An employee watching this receives nothing about an
 *    expense they cannot see.
 *
 * 2. THE TABLE NEEDS `REPLICA IDENTITY FULL`. The WAL carries only the primary
 *    key by default, so a policy reading org_id or expense_id cannot be
 *    evaluated and every message is silently dropped. See
 *    20260908165909_realtime_replica_identity.sql.
 *
 * 3. REALTIME AUTHENTICATES SEPARATELY. The websocket does not inherit the
 *    REST client's session — see the comment in the effect below.
 *
 * Failure mode for 2 and 3 is identical and maddening: the channel reports
 * SUBSCRIBED, the rows are demonstrably in the table, and nothing arrives. No
 * error anywhere, because from Postgres's side nothing went wrong.
 *
 * WHY GO THROUGH POSTGRES AT ALL, when eve streams its own events?
 *
 * eve's session stream is 1:1 — it goes to whoever opened the session. That is
 * the wrong shape for a review queue where several people watch the same
 * expense, and useless for a browser that opens the page after the agent has
 * started. Routing through Postgres makes the timeline durable and fan-out
 * free. On a stage, it is the difference between the laptop that started it
 * and every screen in the room.
 */
export function AgentTimeline({
  expenseId,
  initial,
}: {
  expenseId: string;
  initial: AgentStep[];
}) {
  const [steps, setSteps] = useState<AgentStep[]>(initial);
  const [live, setLive] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const supabase = createBrowserSupabase();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    async function connect() {
      /**
       * Realtime is a separate connection from PostgREST, with its own
       * authorization, and it does not inherit the REST client's session.
       *
       * Subscribing on mount opens the websocket with whatever token the
       * realtime client happens to hold — before the session is hydrated from
       * cookies, that is the anon key. The channel reports SUBSCRIBED, RLS
       * evaluates against `anon`, every change is filtered out, and nothing
       * ever arrives. Nothing errors, because an anonymous subscriber
       * legitimately cannot see these rows.
       *
       * So: read the session, hand its token to the realtime client, and only
       * then subscribe.
       */
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;

      if (session?.access_token) {
        await supabase.realtime.setAuth(session.access_token);
      }
      if (cancelled) return;

      channel = supabase
        .channel(`agent_steps:${expenseId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "agent_steps",
            filter: `expense_id=eq.${expenseId}`,
          },
          (payload) => {
            const step = payload.new as AgentStep;
            // Realtime can redeliver. The primary key is eve's own event id,
            // so de-duplicating on it is exact.
            setSteps((prev) =>
              prev.some((s) => s.id === step.id) ? prev : [...prev, step],
            );

            /**
             * Some of what the agent produces is rendered by the SERVER —
             * the findings list, the expense status, and the approval panel
             * itself. Realtime updates this component, but cannot update
             * those, so without this the agent visibly finishes while the
             * page still says "No findings recorded" and no approval panel
             * appears. On a stage there is no opportunity to say "now hit
             * refresh".
             *
             * Refreshing on every step would re-render ten times for one
             * review, so this fires only on the events that change
             * server-rendered state.
             *
             * NOT turn.completed, which would be the obvious end-of-run
             * trigger: it carries no expense_id, so this filtered subscription
             * never receives it. The run finishes and the panel stays on
             * screen. request_human_review's result is the reliable signal
             * that the pause is over.
             */
            const tool = (
              step.detail as { result?: { toolName?: string } } | undefined
            )?.result?.toolName;

            if (
              step.event_type === "input.requested" ||
              tool === "flag_expense" ||
              tool === "request_human_review"
            ) {
              router.refresh();
            }
          },
        )
        .subscribe((status) => {
          if (!cancelled) setLive(status === "SUBSCRIBED");
        });
    }

    void connect();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [expenseId, router]);

  const isWaiting =
    steps.length > 0 &&
    steps[steps.length - 1]?.event_type === "input.requested";

  return (
    <section>
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
          Agent activity
        </h2>
        <span className="flex items-center gap-1.5 text-xs text-gray-400">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              live ? "bg-green-500" : "bg-gray-300"
            }`}
          />
          {live ? "live" : "connecting"}
        </span>
      </header>

      {steps.length === 0 ? (
        <p className="text-sm text-gray-400">
          Nothing yet. Submitting this expense wakes the agent.
        </p>
      ) : (
        <ol>
          {steps.map((s, i) => {
            const last = i === steps.length - 1;
            const waiting = last && isWaiting;
            return (
              <li key={s.id} className="relative flex gap-3 pb-4 last:pb-0">
                {!last && (
                  <span className="absolute left-[5px] top-4 h-full w-px bg-gray-200" />
                )}
                <span
                  className={`relative z-10 mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                    waiting
                      ? "animate-pulse bg-amber-500"
                      : s.title.startsWith("Blocked")
                        ? "bg-red-500"
                        : "bg-gray-300"
                  }`}
                />
                <span className="flex-1 text-sm">
                  <span className={waiting ? "font-medium text-amber-800" : ""}>
                    {s.title}
                  </span>
                  <time className="ml-2 text-xs text-gray-400">
                    {new Date(s.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </time>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
