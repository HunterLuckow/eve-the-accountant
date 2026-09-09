import { AppNav } from "@/components/app-nav";
import { AgentChat } from "@/components/agent-chat";

export const dynamic = "force-dynamic";

export default function AgentPage() {
  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-3xl px-6 py-8">
        <header className="mb-5">
          <h1 className="text-xl font-semibold">Ask the agent</h1>
          <p className="mt-1 text-sm text-gray-500">
            The same agent that reviews submitted expenses, with the same
            permissions. It can look things up and write findings. It cannot
            approve anything — not because it has been told not to, but because
            no database policy allows it.
          </p>
        </header>
        <AgentChat />
      </main>
    </>
  );
}
