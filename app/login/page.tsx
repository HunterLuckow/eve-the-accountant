import { signIn } from "./actions";

/**
 * The demo cast, as one-click sign-ins.
 *
 * On stage, switching between these is the RLS proof: the same page, the same
 * query, different rows — decided entirely by Postgres.
 */
const CAST = [
  { email: "priya@northwind.demo", name: "Priya Raman", role: "employee", org: "Northwind Labs", note: "submitted the Meridian invoices" },
  { email: "marcus@northwind.demo", name: "Marcus Vale", role: "manager", org: "Northwind Labs", note: "approves up to $4,000" },
  { email: "dana@northwind.demo", name: "Dana Reyes", role: "finance", org: "Northwind Labs", note: "approves anything" },
  { email: "kit@acme.demo", name: "Kit Alvarez", role: "employee", org: "Acme Freight", note: "different tenant entirely" },
];

const DEMO_PASSWORD = "demo-password-1234";

export default async function LoginPage({
  searchParams,
}: {
  // searchParams is a Promise in Next.js 16 — synchronous access was removed.
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="mb-10">
        <h1 className="text-2xl font-semibold tracking-tight">eve the accountant</h1>
        <p className="mt-2 text-sm text-gray-500">
          Expense review, where the agent is a Postgres principal like everyone else.
        </p>
      </header>

      {error && (
        <p className="mb-6 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
          Sign in as
        </h2>
        {CAST.map((p) => (
          <form key={p.email} action={signIn}>
            <input type="hidden" name="email" value={p.email} />
            <input type="hidden" name="password" value={DEMO_PASSWORD} />
            <button
              type="submit"
              className="flex w-full items-center justify-between rounded border border-gray-200 px-4 py-3 text-left transition hover:border-gray-400 hover:bg-gray-50"
            >
              <span>
                <span className="font-medium">{p.name}</span>
                <span className="ml-2 text-sm text-gray-500">{p.note}</span>
              </span>
              <span className="shrink-0 text-xs text-gray-400">
                {p.role} · {p.org}
              </span>
            </button>
          </form>
        ))}
      </section>

      <details className="mt-10">
        <summary className="cursor-pointer text-xs text-gray-400">
          Sign in manually
        </summary>
        <form action={signIn} className="mt-4 space-y-2">
          <input
            name="email"
            type="email"
            required
            placeholder="email"
            className="w-full rounded border border-gray-200 px-3 py-2 text-sm"
          />
          <input
            name="password"
            type="password"
            required
            placeholder="password"
            defaultValue={DEMO_PASSWORD}
            className="w-full rounded border border-gray-200 px-3 py-2 text-sm"
          />
          <button className="rounded bg-black px-4 py-2 text-sm text-white">
            Sign in
          </button>
        </form>
      </details>
    </main>
  );
}
