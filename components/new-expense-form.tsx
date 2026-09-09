"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { createExpense, type NewExpenseResult } from "@/app/new/actions";

type Vendor = { id: string; name: string; category: string };

function SubmitButton() {
  // useFormStatus reads the parent form's pending state, which is why this is
  // a separate component — a hook cannot observe a form it is rendered by.
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded bg-black px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "Saving…" : "Save expense"}
    </button>
  );
}

export function NewExpenseForm({ vendors }: { vendors: Vendor[] }) {
  const [state, formAction] = useActionState<NewExpenseResult, FormData>(
    createExpense,
    undefined,
  );
  const [fileName, setFileName] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={formAction} className="space-y-5">
      {state?.error && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}

      <Field label="Description">
        <input
          name="description"
          required
          placeholder="Meridian Consulting — Phase 4"
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Amount">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">
              $
            </span>
            <input
              name="amount"
              required
              inputMode="decimal"
              placeholder="3940.00"
              className="w-full rounded border border-gray-300 py-2 pl-7 pr-3 text-sm tabular-nums"
            />
          </div>
        </Field>

        <Field label="Date">
          <input
            name="spent_at"
            type="date"
            required
            defaultValue={today}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
      </div>

      <Field label="Vendor">
        <select
          name="vendor_id"
          className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">— none —</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Receipt">
        <label className="flex cursor-pointer items-center justify-between rounded border border-dashed border-gray-300 px-3 py-3 text-sm hover:border-gray-400">
          <span className={fileName ? "text-gray-900" : "text-gray-400"}>
            {fileName ?? "Attach an image or PDF"}
          </span>
          <span className="text-xs text-gray-500 underline">Choose file</span>
          <input
            type="file"
            name="receipt"
            accept="image/png,image/jpeg,image/webp,application/pdf"
            className="hidden"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          />
        </label>
        <p className="mt-1 text-xs text-gray-400">
          Required over $75. The agent reads it.
        </p>
      </Field>

      <label className="flex items-start gap-2.5 rounded border border-gray-200 bg-gray-50 px-3 py-3">
        <input
          type="checkbox"
          name="submit"
          defaultChecked
          className="mt-0.5"
        />
        <span className="text-sm">
          <span className="font-medium">Submit for review</span>
          <span className="mt-0.5 block text-xs text-gray-500">
            Leave this on and it enters the review queue immediately. That is
            what wakes the agent.
          </span>
        </span>
      </label>

      <SubmitButton />
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-gray-500">
        {label}
      </span>
      {children}
    </div>
  );
}
