---
name: structuring-detection
description: How to recognise split transactions. Load when find_related_expenses returns more than one row.
---

# Recognising split transactions

## The shape

- Two or more charges to the **same vendor** by the **same person**
- Within a **short window** — usually the same day, at most a few days
- Each individually **below** an approval threshold
- **Together above** it

Any single charge looks unremarkable. That is not incidental — it is the
point. A reviewer working a queue one row at a time cannot see this, which is
why it works and why a join catches it.

## How to check

1. Call `find_related_expenses`. Do this on every expense, not only suspicious
   ones — you cannot tell from a single row whether siblings exist.
2. Read the `analysis` block it returns. It gives you three facts already
   computed:
   - `everySingleChargeUnderThreshold`
   - `combinedExceedsThreshold`
   - `multipleCharges`
3. All three true is the signature. Do not recompute the sums yourself; the
   tool has done it exactly.

## Corroborating evidence

Strengthens the case, but never required:

- **Sequential invoice numbers** — MC-2291, MC-2292, MC-2293
- **Phase or part labels** — "Phase 1 of 3", "deposit", "balance"
- **Identical dates** across all charges
- **Amounts clustered just under the line** — $3,940 / $3,875 / $3,990 against
  a $4,000 threshold is a much stronger signal than $400 / $900 / $2,700

## What this is not

- **Recurring charges spread over weeks.** A monthly subscription to one vendor
  is not splitting. Look at the spacing.
- **Different people expensing the same vendor.** Two colleagues at the same
  conference is a coincidence, not a scheme.
- **Charges that are each individually over the threshold.** Those are just
  large, and they route through normal approval anyway.

Note that siblings still in `draft` count. An expense reviewed today may have
siblings that have not been submitted yet — that is precisely when flagging is
most useful, because the pattern is still preventable.

## What to do

Flag **all** the expenses in the pattern with a single `structuring` finding,
severity `critical`, listing every sibling id in `expenseIds`.

Describe the pattern in the rationale — same vendor, same day, sequential
invoices, each under the threshold. **Do not write a combined total or a sum.**
`flag_expense` computes the arithmetic exactly and appends it to whatever you
write, so a total you work out yourself ends up printed next to the real one,
disagreeing with it. Observed in a real run: a rationale claiming $11,847.00
directly above a computed $11,805.00.

Name individual amounts where they help a reader. Leave the adding to Postgres.

Then escalate. You are not deciding whether this was deliberate — splitting can
be innocent, and a vendor's own invoicing practice can produce the same shape.
You are making sure a person sees the charges together, which is the thing the
workflow otherwise prevents.
