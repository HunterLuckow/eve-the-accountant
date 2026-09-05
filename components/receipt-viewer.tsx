import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Renders a receipt from the private `receipts` bucket.
 *
 * The bucket is private, so there is no public URL. A signed URL is minted per
 * request, AS THE SIGNED-IN USER — which means the Storage RLS policy runs
 * before any URL exists. A user from another org gets no URL at all, because
 * the policy compares the object's first path segment against their org_id
 * claim and finds no match.
 *
 * So the authorization decision happens in Postgres, before the image is
 * addressable. The app never checks who is allowed to see what.
 */
export async function ReceiptViewer({ path }: { path: string | null }) {
  if (!path) {
    return (
      <div className="flex h-64 items-center justify-center rounded border border-dashed border-gray-300 text-sm text-gray-400">
        No receipt attached
      </div>
    );
  }

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.storage
    .from("receipts")
    .createSignedUrl(path, 60 * 10);

  if (error || !data?.signedUrl) {
    return (
      <div className="flex h-64 items-center justify-center rounded border border-dashed border-gray-300 text-sm text-gray-400">
        Receipt not accessible
      </div>
    );
  }

  return (
    <figure className="space-y-2">
      {/* eslint-disable-next-line @next/next/no-img-element -- signed URLs are
          short-lived and host-specific; next/image would need remotePatterns
          and would cache a URL that expires in ten minutes. */}
      <img
        src={data.signedUrl}
        alt="Receipt"
        className="w-full rounded border border-gray-200"
      />
      <figcaption className="text-xs text-gray-400">
        Private bucket · signed URL, expires in 10 minutes
      </figcaption>
    </figure>
  );
}
