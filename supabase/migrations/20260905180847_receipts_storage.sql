-- Private receipts bucket.
--
-- Supabase Storage is not a separate system bolted onto Postgres. Buckets are
-- rows in storage.buckets; files are rows in storage.objects; and both have
-- RLS. So the same jwt_org_id() helper that scopes expense ROWS scopes receipt
-- FILES, with the same claims out of the same token.
--
-- That is why the path convention matters. Object keys are
--   {org_id}/{expense_id}.{ext}
-- and the policies below key on the first path segment. The tenant boundary is
-- encoded in the filename, so an authorization decision about a file is the
-- same shape as one about a row.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,                                        -- private: reads require a signed URL
  5242880,                                      -- 5 MB; a receipt photo is not a video
  array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- READ — anyone in the org, including the agent.
--
-- storage.foldername(name) splits an object key into its path segments, so
-- for '2fc05801-.../abc-123.png' it returns {'2fc05801-...'} and [1] is the
-- org. Comparing that against the caller's org_id claim is the whole rule.
--
-- The bucket is private, so this policy does not make files public. It governs
-- who may mint a signed URL for them; the URL itself is short-lived and is
-- generated per request in components/receipt-viewer.tsx and in the agent's
-- read_receipt tool.
-- ---------------------------------------------------------------------------
create policy "receipts read own org"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select public.jwt_org_id())::text
  );

-- ---------------------------------------------------------------------------
-- WRITE — humans in the org. Not the agent.
--
-- FOR INSERT policies take WITH CHECK only. There is no USING clause, because
-- there is no pre-existing row to filter — the check runs against the row as
-- it will exist.
--
-- Same read-broad / write-narrow shape as expenses: the agent may look at
-- every receipt in its org and cannot introduce one. An agent that could
-- upload receipts could manufacture the evidence it then reasons about.
--
-- Note jwt_role() <> 'agent' also excludes a caller with no role claim, since
-- NULL <> 'agent' is NULL, which is not TRUE. Fails closed, which is correct.
-- ---------------------------------------------------------------------------
create policy "receipts upload own org"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select public.jwt_org_id())::text
    and (select public.jwt_role()) <> 'agent'
  );

-- Replacing a receipt (re-upload after a bad photo) is an UPDATE on the object.
create policy "receipts replace own org"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select public.jwt_org_id())::text
    and (select public.jwt_role()) <> 'agent'
  )
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select public.jwt_org_id())::text
  );

-- No DELETE policy for anyone. Receipts are evidence attached to an approval
-- decision; nothing in this app has a reason to destroy one.
