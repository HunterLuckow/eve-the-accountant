-- Wake the agent when an expense is submitted.
--
-- The demo's cold open: one INSERT in the SQL editor and the agent starts
-- working. Nothing polls, and there is no queue in between — Postgres calls
-- the application directly.
--
-- WHY A MIGRATION AND NOT THE DASHBOARD
--
-- Supabase's Database Webhooks UI creates exactly this: a trigger calling
-- net.http_post. Doing it here means the webhook is version-controlled and
-- rebuildable from a clean checkout, rather than a click somebody has to
-- remember. Configuration that lives only in a dashboard is the most common
-- way a Supabase project drifts from its migrations.
--
-- CONFIGURATION LIVES IN VAULT, NOT IN THIS FILE
--
-- The target URL is environment-specific and the secret must not be committed,
-- so both are read from Vault at call time. Set them before this matters:
--
--   select vault.create_secret('https://your-app.vercel.app', 'app_base_url');
--   select vault.create_secret('<WEBHOOK_SECRET from .env.local>', 'webhook_secret');
--
-- To retarget later (local tunnel <-> production), update the secret rather
-- than editing a migration:
--
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'app_base_url'),
--     'https://something-else.example');
--
-- If either secret is missing the trigger returns quietly. A submission that
-- does not wake the agent is a demo that looks broken; a submission that
-- ERRORS is an app where nobody can submit an expense at all. Fail quiet here.
--
-- LOCAL DEVELOPMENT
--
-- pg_net runs inside Supabase's cloud, so it cannot reach a laptop. Point
-- app_base_url at a tunnel (`cloudflared tunnel --url http://localhost:3000`
-- or `ngrok http 3000`) while developing, and at the Vercel deployment for
-- the real thing.

create extension if not exists pg_net with schema extensions;

create or replace function public.notify_expense_submitted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_url text;
  secret   text;
begin
  -- Only the submitted transition, and only once. An expense that was already
  -- submitted and then edited must not start a second review.
  if new.status <> 'submitted' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'submitted' then
    return new;
  end if;

  select decrypted_secret into base_url
    from vault.decrypted_secrets where name = 'app_base_url';
  select decrypted_secret into secret
    from vault.decrypted_secrets where name = 'webhook_secret';

  if base_url is null or secret is null then
    raise warning 'notify_expense_submitted: app_base_url or webhook_secret missing from Vault; not calling out';
    return new;
  end if;

  -- Fire and forget. pg_net queues the request and returns immediately, so the
  -- INSERT does not wait on the agent — which matters, because a review takes
  -- the better part of a minute and no user should sit through that to submit
  -- an expense. Delivery status lands in net._http_response.
  perform extensions.net_http_post(
    url     := base_url || '/api/hooks/expense-submitted',
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'x-webhook-secret', secret
               ),
    body    := jsonb_build_object(
                 'type', tg_op,
                 'table', 'expenses',
                 'record', to_jsonb(new),
                 'old_record', case when tg_op = 'UPDATE' then to_jsonb(old) else null end
               )
  );

  return new;
end;
$$;

-- AFTER, not BEFORE: the row must exist before the agent is told to look at
-- it, or get_expense races the transaction and finds nothing.
create trigger notify_expense_submitted
  after insert or update on public.expenses
  for each row execute function public.notify_expense_submitted();
