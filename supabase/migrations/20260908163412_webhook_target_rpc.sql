-- RPC for reading and retargeting the Database Webhook URL.
--
-- vault.decrypted_secrets is not exposed through PostgREST, and should not be:
-- a table of decrypted secrets behind an HTTP API is a bad idea regardless of
-- who can reach it.
--
-- This function is the narrow alternative. It returns the webhook URL — which
-- is configuration, not a secret — and only whether the shared secret EXISTS,
-- never its value. Setting the secret itself stays a deliberate, manual act.
--
-- Restricted to service_role, so it is reachable from scripts/webhook-target.ts
-- and from nowhere a browser can get to.
create or replace function public.webhook_target(new_url text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_id uuid;
  current_url text;
  has_secret  boolean;
begin
  if new_url is not null then
    select id into existing_id from vault.secrets where name = 'app_base_url';
    if existing_id is null then
      perform vault.create_secret(new_url, 'app_base_url');
    else
      perform vault.update_secret(existing_id, new_url);
    end if;
  end if;

  select decrypted_secret into current_url
    from vault.decrypted_secrets where name = 'app_base_url';

  select exists (select 1 from vault.decrypted_secrets where name = 'webhook_secret')
    into has_secret;

  return jsonb_build_object('url', current_url, 'secret_set', has_secret);
end;
$$;

revoke execute on function public.webhook_target(text) from public, anon, authenticated;
grant  execute on function public.webhook_target(text) to service_role;
