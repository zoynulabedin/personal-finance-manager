import type { Prisma } from "@prisma/client";
import { roundMoney } from "./validation.server";

/**
 * The donation tracker: `allocated` is how much the 1% rule has obliged the
 * user to give away, `spent` is how much has actually left an account for that
 * purpose. The card on /donations and /dashboard shows `allocated - spent`.
 *
 * Both numbers are caches over rows that live elsewhere (Donation for the
 * obligation, Expense for free-form giving), so every place that creates,
 * edits or removes one of those rows has to move the cache by the same amount.
 * That symmetry used to be hand-written at each call site and was missing from
 * half of them, which let the tracker drift — and go negative. Everything now
 * goes through this one function.
 */

type Tx = Prisma.TransactionClient;

/**
 * Move `allocated` and/or `spent` by a signed delta.
 *
 * Uses upsert rather than update: a user who predates the tracker (or who
 * arrived via a restored backup) has no row, and `update` would throw P2025
 * and roll back the whole surrounding transaction.
 */
export async function adjustDonationBalance(
  tx: Tx,
  userId: string,
  delta: { allocated?: number; spent?: number }
) {
  const allocated = roundMoney(delta.allocated ?? 0);
  const spent = roundMoney(delta.spent ?? 0);
  if (allocated === 0 && spent === 0) return;

  await tx.donationBalance.upsert({
    where: { userId },
    // A missing row starts from zero, so the delta *is* the opening value.
    // Negative deltas clamp at zero rather than creating a nonsense debt.
    create: {
      userId,
      allocated: Math.max(0, allocated),
      spent: Math.max(0, spent),
    },
    update: {
      allocated: { increment: allocated },
      spent: { increment: spent },
    },
  });
}

/**
 * Whether an expense in this category counts as giving.
 *
 * `type` is authoritative; the name check is the fallback for the default
 * "💰 দান" category and for categories created before `type` was used.
 */
export function isDonationCategory(
  category: { name?: string | null; type?: string | null } | null | undefined
): boolean {
  if (!category) return false;
  if (category.type === "DONATION") return true;
  return (category.name ?? "").includes("দান");
}
