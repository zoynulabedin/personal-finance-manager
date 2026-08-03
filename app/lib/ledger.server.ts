import type { Prisma } from "@prisma/client";
import { roundMoney } from "./validation.server";

/**
 * The ledger: the one and only place a balance is allowed to change.
 *
 * Every movement of money is an append-only `LedgerEntry` with a signed amount
 * (positive credits, negative debits). `BankAccount.currentBalance` is a cache
 * of the sum, written in the same transaction as the entry — so the two cannot
 * drift as long as nothing else touches `currentBalance` directly.
 *
 * Nothing here is ever edited or deleted. Correcting something posts an
 * opposite entry and marks the original reversed, which is why the account
 * statement can always explain how a balance came to be.
 */

export type LedgerType =
  | "OPENING"
  | "INCOME"
  | "EXPENSE"
  | "DONATION"
  | "ADJUSTMENT";

/** Identifies what caused an entry, so it can be found and reversed later. */
export type LedgerSource = {
  incomeId?: string | null;
  expenseId?: string | null;
  donationId?: string | null;
};

type Tx = Prisma.TransactionClient;

/**
 * Post one entry and move the cached balance by the same signed amount.
 *
 * `amount` is signed by the caller: credits are positive, debits negative.
 * Callers should use `credit()` / `debit()` rather than passing a sign by hand.
 */
export async function postLedgerEntry(
  tx: Tx,
  params: {
    userId: string;
    bankAccountId: string;
    amount: number;
    type: LedgerType;
    description: string;
    occurredAt?: Date;
    source?: LedgerSource;
    reversalOfId?: string | null;
  }
) {
  const amount = roundMoney(params.amount);
  if (amount === 0) return null;

  const entry = await tx.ledgerEntry.create({
    data: {
      userId: params.userId,
      bankAccountId: params.bankAccountId,
      amount,
      type: params.type,
      description: params.description,
      occurredAt: params.occurredAt ?? new Date(),
      incomeId: params.source?.incomeId ?? null,
      expenseId: params.source?.expenseId ?? null,
      donationId: params.source?.donationId ?? null,
      reversalOfId: params.reversalOfId ?? null,
    },
  });

  // Atomic increment rather than read-then-write: two concurrent posts can
  // never overwrite each other's result.
  await tx.bankAccount.update({
    where: { id: params.bankAccountId },
    data: { currentBalance: { increment: amount } },
  });

  return entry;
}

export function credit(
  tx: Tx,
  params: Omit<Parameters<typeof postLedgerEntry>[1], "amount"> & {
    amount: number;
  }
) {
  return postLedgerEntry(tx, { ...params, amount: Math.abs(params.amount) });
}

export function debit(
  tx: Tx,
  params: Omit<Parameters<typeof postLedgerEntry>[1], "amount"> & {
    amount: number;
  }
) {
  return postLedgerEntry(tx, { ...params, amount: -Math.abs(params.amount) });
}

/**
 * Undo every live entry belonging to a source.
 *
 * Used when an income, expense or donation is edited or deleted. Each original
 * gets an opposite entry against the *same* account it hit, so moving an
 * expense from one wallet to another returns the money to the first and takes
 * it from the second.
 *
 * Returns the number of entries reversed, which callers use to tell "this had
 * money attached" apart from "this never touched an account".
 */
export async function reverseLedgerFor(
  tx: Tx,
  userId: string,
  source: LedgerSource,
  reason: string
): Promise<number> {
  const filter: Prisma.LedgerEntryWhereInput = { userId, reversedAt: null };

  if (source.incomeId) filter.incomeId = source.incomeId;
  else if (source.expenseId) filter.expenseId = source.expenseId;
  else if (source.donationId) filter.donationId = source.donationId;
  else return 0;

  // Only reverse originals; a reversal entry is itself final.
  filter.reversalOfId = null;

  const originals = await tx.ledgerEntry.findMany({ where: filter });
  if (originals.length === 0) return 0;

  const now = new Date();

  for (const original of originals) {
    await postLedgerEntry(tx, {
      userId,
      bankAccountId: original.bankAccountId,
      amount: -original.amount,
      type: original.type as LedgerType,
      description: reason,
      occurredAt: now,
      source: {
        incomeId: original.incomeId,
        expenseId: original.expenseId,
        donationId: original.donationId,
      },
      reversalOfId: original.id,
    });

    await tx.ledgerEntry.update({
      where: { id: original.id },
      data: { reversedAt: now },
    });
  }

  return originals.length;
}

/**
 * Confirm the account this id refers to belongs to the user.
 * Returns null when it doesn't, so callers can reject the request.
 */
export async function assertOwnedAccount(
  tx: Tx,
  userId: string,
  bankAccountId: string | null | undefined
): Promise<string | null> {
  if (!bankAccountId) return null;
  const account = await tx.bankAccount.findFirst({
    where: { id: bankAccountId, userId },
    select: { id: true },
  });
  return account ? account.id : null;
}

/**
 * Recompute every balance from the ledger and report any that disagree with
 * the cached value.
 *
 * Should always come back empty. It exists so a drift bug is detectable rather
 * than silently wrong, and it is exercised by the test suite after each flow.
 */
export async function reconcileBalances(
  db: { ledgerEntry: any; bankAccount: any },
  userId: string
): Promise<
  Array<{ bankAccountId: string; stored: number; computed: number }>
> {
  const [accounts, sums] = await Promise.all([
    db.bankAccount.findMany({
      where: { userId },
      select: { id: true, currentBalance: true },
    }),
    db.ledgerEntry.groupBy({
      by: ["bankAccountId"],
      where: { userId },
      _sum: { amount: true },
    }),
  ]);

  const computedByAccount = new Map<string, number>(
    sums.map((row: any) => [row.bankAccountId, roundMoney(row._sum.amount ?? 0)])
  );

  const mismatches: Array<{
    bankAccountId: string;
    stored: number;
    computed: number;
  }> = [];

  for (const account of accounts) {
    const computed = computedByAccount.get(account.id) ?? 0;
    const stored = roundMoney(account.currentBalance);
    if (Math.abs(stored - computed) > 0.005) {
      mismatches.push({ bankAccountId: account.id, stored, computed });
    }
  }

  return mismatches;
}
