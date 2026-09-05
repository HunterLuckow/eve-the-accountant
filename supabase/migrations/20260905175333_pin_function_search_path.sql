-- Pin search_path on all three functions.
--
-- Found by `supabase db advisors --linked --type security`
-- (lint 0011_function_search_path_mutable).
--
-- Without an explicit search_path, a function resolves unqualified names using
-- whatever search path the CALLER happens to have. Anyone who can create an
-- object in an earlier schema can then shadow a real one and change what the
-- function executes.
--
-- That is general hygiene, and an acute problem for custom_access_token_hook:
-- it runs as supabase_auth_admin and decides the claims every RLS policy in
-- this app reads. It is the last function here you would want hijackable.
--
-- `set search_path = ''` is the strictest form — it forces every reference to
-- be schema-qualified, which is why the bodies below spell out public.profiles
-- and auth.jwt() in full.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims       jsonb;
  profile_org  uuid;
  profile_role text;
begin
  select p.org_id, p.role::text
    into profile_org, profile_role
  from public.profiles p
  where p.id = (event->>'user_id')::uuid;

  claims := coalesce(event->'claims', '{}'::jsonb);

  if profile_org is not null then
    claims := jsonb_set(claims, '{org_id}',    to_jsonb(profile_org::text));
    claims := jsonb_set(claims, '{user_role}', to_jsonb(profile_role));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

create or replace function public.jwt_org_id()
returns uuid language sql stable
set search_path = ''
as $$ select nullif(auth.jwt() ->> 'org_id', '')::uuid $$;

create or replace function public.jwt_role()
returns text language sql stable
set search_path = ''
as $$ select auth.jwt() ->> 'user_role' $$;

-- CREATE OR REPLACE resets privileges on the function, so re-apply them.
grant  execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
