import type { Route } from "./+types/settings-export";
import { prisma } from "../lib/db.server";
import { requireUser } from "../lib/auth.server";

/**
 * Backup download, split out of /settings so that route's loader returns a
 * single plain object instead of a `{ user } | Response` union (which forced
 * an `as any` cast in the component).
 *
 * Everything here is scoped to the signed-in user.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const userId = user.id;

  const [
    incomes,
    expenses,
    bills,
    bankAccounts,
    categories,
    ledgerEntries,
    transfers,
  ] = await Promise.all([
      prisma.income.findMany({
        where: { userId },
        include: { donations: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.expense.findMany({ where: { userId }, orderBy: { date: "asc" } }),
      prisma.bill.findMany({ where: { userId }, orderBy: { dueDate: "asc" } }),
      prisma.bankAccount.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
      }),
      // Own categories only. Shared (userId: null) rows belong to no one and
      // are recreated per-user on import.
      prisma.category.findMany({ where: { userId }, orderBy: { name: "asc" } }),
      // The ledger is the record of how each balance came to be, so a backup
      // without it could only ever restore a snapshot, not the history.
      prisma.ledgerEntry.findMany({
        where: { userId },
        orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
      }),
      // Ledger entries carry a `transferId`, so without the transfers
      // themselves a restored backup has entries referring to rows that don't
      // exist — and those entries can then never be reversed.
      prisma.transfer.findMany({
        where: { userId },
        orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
      }),
    ]);

  const backupData = {
    version: "3.1",
    exportedAt: new Date().toISOString(),
    user: { name: user.name, email: user.email },
    categories,
    bankAccounts,
    incomes,
    expenses,
    bills,
    transfers,
    ledgerEntries,
  };

  const filename = `poribar_finance_backup_${
    new Date().toISOString().split("T")[0]
  }.json`;

  return new Response(JSON.stringify(backupData, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
