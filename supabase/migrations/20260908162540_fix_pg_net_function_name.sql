-- Fix: the pg_net function is net.http_post, not extensions.net_http_post.
--
-- Worth recording how this got shipped, because it is a general Postgres trap:
--
--   plpgsql does not resolve function names when a function is CREATEd. The
--   body is parsed for syntax, but identifier resolution happens at EXECUTION.
--   So the previous migration applied cleanly, `supabase db push` reported
--   success, and the error would have surfaced the first time somebody
--   submitted an expense — which, for this project, is on stage.
--
-- `create extension pg_net` makes its own `net` schema regardless of the
-- WITH SCHEMA clause, so the qualified name is always net.http_post.
--
-- Because the function is `set search_path = ''`, every name has to be
-- schema-qualified; there is no fallback that would have found it.
--
-- Verified against the live catalog before writing this:
--   select n.nspname||'.'||p.proname from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where p.proname ilike '%http_post%';
--   -> net.http_post

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

  perform net.http_post(
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
