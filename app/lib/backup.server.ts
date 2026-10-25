import { gunzipSync, gzipSync } from "node:zlib";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "./db.server";
import {
  parseAmount,
  parseBalance,
  parseIntParam,
  parsePaymentMethod,
  parseText,
  roundMoney,
} from "./validation.server";
import { postLedgerEntry } from "./ledger.server";
import { isDonationCategory } from "./donation-balance.server";
import { BENGALI_MONTHS } from "../utils/bengali";

/**
 * Backup and restore.
 *
 * One payload format serves both the downloadable JSON file and the snapshots
 * stored in `BackupSnapshot`, and one restore routine reads both, so a stored
 * snapshot can be downloaded and later imported as a file with nothing lost.
 *
 * Snapshots come in three kinds:
 *  - AUTO: taken by the layout middleware before the first request of each
 *    day touches anything. Data only changes through requests, so this holds
 *    the state as it stood at the end of the last day the app was used.
 *  - MANUAL: the "back up now" button.
 *  - PRE_RESTORE: taken inside every restore's transaction, so restoring the
 *    wrong file or the wrong day can itself be rolled back.
 */

/** Works with either the base client or a `$transaction` client. */
type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

export type SnapshotKind = "AUTO" | "MANUAL" | "PRE_RESTORE";

/**
 * How many of each kind to keep. Manual snapshots are kept until deleted —
 * the user asked for each one.
 */
const RETENTION: Partial<Record<SnapshotKind, number>> = {
  AUTO: 30,
  PRE_RESTORE: 10,
};

/**
 * A restore recreates every row one at a time. Prisma's default 5s
 * interactive-transaction timeout is fine for a month of data but not for
 * years of it, and a restore that times out is a backup that can't be used.
 */
const RESTORE_TRANSACTION = { maxWait: 10_000, timeout: 120_000 };

/** Bumped when the payload shape changes; read by nothing yet. */
const BACKUP_FORMAT_VERSION = "3.1";

/* ------------------------------------------------------------------------- */
/* Time zone                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * "Daily" means the family's day, not the server's. The Docker image runs in
 * UTC, where a new day starts at 06:00 in Dhaka.
 */
const APP_TIME_ZONE = resolveTimeZone(process.env.APP_TIMEZONE);

function resolveTimeZone(configured: string | undefined): string {
  const fallback = "Asia/Dhaka";
  if (!configured) return fallback;
  try {
    new Intl.DateTimeFormat("en", { timeZone: configured });
    return configured;
  } catch {
    console.warn(
      `APP_TIMEZONE "${configured}" is not a valid IANA time zone; using ${fallback}.`
    );
    return fallback;
  }
}

const zonedFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function zonedParts(date: Date) {
  const parts: Record<string, string> = {};
  for (const part of zonedFormatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return parts as Record<"year" | "month" | "day" | "hour" | "minute", string>;
}

/** YYYY-MM-DD for `date` in the app's time zone. */
export function backupDayKey(date: Date = new Date()): string {
  const { year, month, day } = zonedParts(date);
  return `${year}-${month}-${day}`;
}

/**
 * "25 অক্টোবর 2026, 09:15" in the app's time zone. Formatted here rather than
 * in the component: the server and the browser can sit in different zones,
 * and rendering a time on both sides would mismatch on hydration. Digits are
 * left Latin so the component can apply the user's digit preference.
 */
function formatSnapshotTime(date: Date): string {
  const { year, month, day, hour, minute } = zonedParts(date);
  return `${Number(day)} ${BENGALI_MONTHS[Number(month) - 1]} ${year}, ${hour}:${minute}`;
}

/* ------------------------------------------------------------------------- */
/* Payload                                                                    */
/* ------------------------------------------------------------------------- */

/** Everything the user owns, in the shape the backup file has always had. */
export async function buildBackupPayload(db: Db, userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  if (!user) throw new Error(`Cannot back up missing user ${userId}`);

  const [
    incomes,
    expenses,
    bills,
    bankAccounts,
    categories,
    ledgerEntries,
    transfers,
  ] = await Promise.all([
    db.income.findMany({
      where: { userId },
      include: { donations: true },
      orderBy: { createdAt: "asc" },
    }),
    db.expense.findMany({ where: { userId }, orderBy: { date: "asc" } }),
    db.bill.findMany({ where: { userId }, orderBy: { dueDate: "asc" } }),
    db.bankAccount.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    }),
    // Own categories only. Shared (userId: null) rows belong to no one and
    // are recreated per-user on import.
    db.category.findMany({ where: { userId }, orderBy: { name: "asc" } }),
    // The ledger is the record of how each balance came to be, so a backup
    // without it could only ever restore a snapshot, not the history.
    db.ledgerEntry.findMany({
      where: { userId },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
    }),
    // Ledger entries carry a `transferId`, so without the transfers
    // themselves a restored backup has entries referring to rows that don't
    // exist — and those entries can then never be reversed.
    db.transfer.findMany({
      where: { userId },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  return {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    user,
    categories,
    bankAccounts,
    incomes,
    expenses,
    bills,
    transfers,
    ledgerEntries,
  };
}

type BackupPayload = Awaited<ReturnType<typeof buildBackupPayload>>;

export type SnapshotSummary = {
  categories: number;
  bankAccounts: number;
  incomes: number;
  expenses: number;
  bills: number;
  transfers: number;
  ledgerEntries: number;
};

function summarize(payload: BackupPayload): SnapshotSummary {
  return {
    categories: payload.categories.length,
    bankAccounts: payload.bankAccounts.length,
    incomes: payload.incomes.length,
    expenses: payload.expenses.length,
    bills: payload.bills.length,
    transfers: payload.transfers.length,
    ledgerEntries: payload.ledgerEntries.length,
  };
}

export function backupFilename(day: string, suffix?: string): string {
  return `poribar_finance_backup_${day}${suffix ? `_${suffix}` : ""}.json`;
}

/* ------------------------------------------------------------------------- */
/* Snapshots                                                                  */
/* ------------------------------------------------------------------------- */

async function createSnapshot(
  db: Db,
  userId: string,
  kind: SnapshotKind,
  autoDay: string | null = null
) {
  const payload = await buildBackupPayload(db, userId);
  const json = JSON.stringify(payload);
  return db.backupSnapshot.create({
    data: {
      userId,
      kind,
      autoDay,
      data: gzipSync(json),
      sizeBytes: Buffer.byteLength(json),
      summary: summarize(payload),
    },
    select: { id: true },
  });
}

/** Drop the oldest snapshots of `kind` beyond its retention limit. */
async function pruneSnapshots(userId: string, kind: SnapshotKind) {
  const keep = RETENTION[kind];
  if (keep === undefined) return;

  const stale = await prisma.backupSnapshot.findMany({
    where: { userId, kind },
    orderBy: { createdAt: "desc" },
    skip: keep,
    select: { id: true },
  });
  if (stale.length === 0) return;

  await prisma.backupSnapshot.deleteMany({
    where: { id: { in: stale.map((row) => row.id) } },
  });
}

export async function createManualSnapshot(userId: string) {
  return createSnapshot(prisma, userId, "MANUAL");
}

export async function listSnapshots(userId: string) {
  const rows = await prisma.backupSnapshot.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    // Never `data`: the list must not decompress, or even load, every backup.
    select: {
      id: true,
      kind: true,
      autoDay: true,
      sizeBytes: true,
      summary: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as SnapshotKind,
    autoDay: row.autoDay,
    sizeBytes: row.sizeBytes,
    summary: row.summary as SnapshotSummary,
    createdAtLabel: formatSnapshotTime(row.createdAt),
  }));
}

export type SnapshotListItem = Awaited<ReturnType<typeof listSnapshots>>[number];

/** The stored payload, or null when the snapshot isn't the user's. */
export async function readSnapshot(userId: string, snapshotId: string) {
  const row = await prisma.backupSnapshot.findFirst({
    where: { id: snapshotId, userId },
    select: { kind: true, data: true, createdAt: true },
  });
  if (!row) return null;

  return {
    kind: row.kind as SnapshotKind,
    day: backupDayKey(row.createdAt),
    payload: JSON.parse(gunzipSync(row.data).toString("utf8")) as unknown,
  };
}

/** Returns false when there was nothing of the user's to delete. */
export async function deleteSnapshot(userId: string, snapshotId: string) {
  const { count } = await prisma.backupSnapshot.deleteMany({
    where: { id: snapshotId, userId },
  });
  return count > 0;
}

/* ------------------------------------------------------------------------- */
/* Daily backup                                                               */
/* ------------------------------------------------------------------------- */

/**
 * userId → the day this process last confirmed an AUTO snapshot exists. Lets
 * every request after the first of the day skip the database entirely. Lost
 * on restart or HMR, which only costs one indexed lookup.
 */
const confirmedDay = new Map<string, string>();
/** userId → in-flight check, so concurrent first requests share one backup. */
const inFlight = new Map<string, Promise<void>>();
/** userId → epoch ms before which a failed backup isn't retried. */
const retryAfter = new Map<string, number>();
const RETRY_DELAY_MS = 10 * 60 * 1000;

/**
 * Make sure today's automatic snapshot exists, taking it if not.
 *
 * Never throws: a broken backup must not take the rest of the app down with
 * it. A failure is logged and retried after RETRY_DELAY_MS, and shows up on
 * the settings page as today's backup being missing.
 */
export async function ensureDailyBackup(userId: string): Promise<void> {
  const today = backupDayKey();
  if (confirmedDay.get(userId) === today) return;
  if ((retryAfter.get(userId) ?? 0) > Date.now()) return;

  let pending = inFlight.get(userId);
  if (!pending) {
    pending = takeDailyBackup(userId, today).finally(() =>
      inFlight.delete(userId)
    );
    inFlight.set(userId, pending);
  }
  await pending;
}

async function takeDailyBackup(userId: string, today: string) {
  try {
    const existing = await prisma.backupSnapshot.findUnique({
      where: { userId_autoDay: { userId, autoDay: today } },
      select: { id: true },
    });
    if (!existing) {
      await createSnapshot(prisma, userId, "AUTO", today);
      await pruneSnapshots(userId, "AUTO");
    }
    confirmedDay.set(userId, today);
    retryAfter.delete(userId);
  } catch (error) {
    // Another process (or a request this one didn't see) took it first.
    if (isUniqueViolation(error)) {
      confirmedDay.set(userId, today);
      return;
    }
    console.error("Daily backup failed:", error);
    retryAfter.set(userId, Date.now() + RETRY_DELAY_MS);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/* ------------------------------------------------------------------------- */
/* Restore                                                                    */
/* ------------------------------------------------------------------------- */

export type RestoreCounts = {
  categories: number;
  banks: number;
  incomes: number;
  expenses: number;
  bills: number;
  transfers: number;
};

/**
 * Restore a parsed backup payload for the user.
 *
 * Takes a PRE_RESTORE snapshot first, inside the same transaction, so it holds
 * exactly the data the restore is about to change — and disappears with the
 * rest of the transaction if the restore fails and nothing changes.
 */
export async function restoreBackup(
  userId: string,
  parsed: any,
  { replaceExisting }: { replaceExisting: boolean }
): Promise<RestoreCounts> {
  const counts = await prisma.$transaction(async (tx) => {
    await createSnapshot(tx, userId, "PRE_RESTORE");
    return applyBackup(tx, userId, parsed, replaceExisting);
  }, RESTORE_TRANSACTION);

  await pruneSnapshots(userId, "PRE_RESTORE");
  // A replace-restore rewrites today's data, but today's AUTO snapshot still
  // holds the state from before it, which is what it should hold.
  return counts;
}

/** Restore a stored snapshot, replacing everything the user has now. */
export async function restoreSnapshot(userId: string, snapshotId: string) {
  const snapshot = await readSnapshot(userId, snapshotId);
  if (!snapshot) return null;
  // Always a replace: the snapshot is a copy of this same account, so merging
  // it into the current data would duplicate every row the two share.
  return restoreBackup(userId, snapshot.payload, { replaceExisting: true });
}

/** Shapes we accept from a backup file, validated before anything is written. */
function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

async function applyBackup(
  tx: Tx,
  userId: string,
  parsed: any,
  replaceExisting: boolean
): Promise<RestoreCounts> {
  if (replaceExisting) {
    // Scoped to this user only. Expenses first (they reference
    // categories and bank accounts), then donations via income cascade.
    await tx.ledgerEntry.deleteMany({ where: { userId } });
    await tx.transfer.deleteMany({ where: { userId } });
    await tx.bill.deleteMany({ where: { userId } });
    await tx.expense.deleteMany({ where: { userId } });
    await tx.income.deleteMany({ where: { userId } });
    await tx.bankAccount.deleteMany({ where: { userId } });
    await tx.category.deleteMany({ where: { userId } });
    // The donation tracker is a cache over rows that no longer exist.
    // It is rebuilt from the restored data at the end of this import.
    await tx.donationBalance.deleteMany({ where: { userId } });
  }

  /**
   * Ids from the file are never reused. The old code upserted on the
   * incoming id, which meant a crafted backup could overwrite another
   * user's rows and reassign them to the importer. Fresh rows are
   * created instead and old ids are remapped through these tables.
   */
  const categoryIdMap = new Map<string, string>();
  const bankIdMap = new Map<string, string>();
  const incomeIdMap = new Map<string, string>();
  const expenseIdMap = new Map<string, string>();
  const donationIdMap = new Map<string, string>();
  const transferIdMap = new Map<string, string>();
  // A reversal entry points at the original it undid. Restoring that
  // link matters: `reverseLedgerFor` treats an entry with no
  // `reversalOfId` as an original, so a reversal imported without it
  // gets reversed a second time on the next edit and money vanishes.
  const ledgerIdMap = new Map<string, string>();

  // The donation tracker is rebuilt from the rows actually restored,
  // rather than trusting a figure in the file that may not match them.
  const donationCategoryIds = new Set<string>();
  let allocatedTotal = 0;
  let spentTotal = 0;

  for (const cat of asArray(parsed.categories)) {
    const name = parseText(cat?.name);
    if (!name) continue;
    const created = await tx.category.create({
      data: {
        userId,
        name,
        icon: typeof cat.icon === "string" ? cat.icon : null,
        color: typeof cat.color === "string" ? cat.color : null,
        type: typeof cat.type === "string" ? cat.type : "EXPENSE",
      },
    });
    if (typeof cat.id === "string") categoryIdMap.set(cat.id, created.id);
    if (isDonationCategory(created)) donationCategoryIds.add(created.id);
  }

  for (const bank of asArray(parsed.bankAccounts)) {
    const bankName = parseText(bank?.bankName);
    const accountName = parseText(bank?.accountName);
    if (!bankName || !accountName) continue;
    const created = await tx.bankAccount.create({
      data: {
        userId,
        bankName,
        accountName,
        accountNumber: parseText(bank?.accountNumber) ?? "N/A",
        // Starts empty — the ledger entries below (or a synthetic
        // opening entry) put the money back, so the restored balance is
        // always the sum of its history rather than a bare number.
        currentBalance: 0,
        isCash:
          typeof bank.isCash === "boolean"
            ? bank.isCash
            : bankName.toLowerCase() === "cash",
        note: parseText(bank?.note),
      },
    });
    if (typeof bank.id === "string") bankIdMap.set(bank.id, created.id);
  }

  let incomeCount = 0;
  for (const inc of asArray(parsed.incomes)) {
    const title = parseText(inc?.title);
    const amount = parseAmount(inc?.amount);
    const month = parseIntParam(String(inc?.month), {
      min: 1,
      max: 12,
      fallback: 0,
    });
    const year = parseIntParam(String(inc?.year), {
      min: 1970,
      max: 9999,
      fallback: 0,
    });
    if (!title || amount === null || month === 0 || year === 0) continue;

    const createdIncome = await tx.income.create({
      data: {
        userId,
        title,
        amount,
        month,
        year,
        note: parseText(inc?.note),
        bankAccountId:
          typeof inc?.bankAccountId === "string"
            ? bankIdMap.get(inc.bankAccountId) ?? null
            : null,
        receivedAt: inc?.receivedAt ? new Date(inc.receivedAt) : undefined,
      },
    });
    incomeCount += 1;
    if (typeof inc.id === "string") incomeIdMap.set(inc.id, createdIncome.id);

    // Donations were exported but never restored by the old importer,
    // so every export/restore round trip silently lost them.
    const donations = asArray(inc?.donations);
    if (donations.length > 0) {
      for (const don of donations) {
        const donAmount = parseAmount(don?.amount);
        if (donAmount === null) continue;
        const mappedBank =
          typeof don?.bankAccountId === "string"
            ? bankIdMap.get(don.bankAccountId) ?? null
            : null;
        const createdDonation = await tx.donation.create({
          data: {
            incomeId: createdIncome.id,
            percentage:
              typeof don?.percentage === "number" &&
              Number.isFinite(don.percentage)
                ? don.percentage
                : 1.0,
            amount: donAmount,
            paid: don?.paid === true,
            paidDate: don?.paidDate ? new Date(don.paidDate) : null,
            bankAccountId: mappedBank,
          },
        });
        if (typeof don?.id === "string") {
          donationIdMap.set(don.id, createdDonation.id);
        }
        allocatedTotal += createdDonation.amount;
        if (createdDonation.paid) spentTotal += createdDonation.amount;
      }
    } else {
      // Older backups have no donations array — regenerate the 1% row.
      const regenerated = roundMoney(amount * 0.01);
      await tx.donation.create({
        data: {
          incomeId: createdIncome.id,
          percentage: 1.0,
          amount: regenerated,
          paid: false,
        },
      });
      allocatedTotal += regenerated;
    }
  }

  let expenseCount = 0;
  for (const exp of asArray(parsed.expenses)) {
    const title = parseText(exp?.title);
    const amount = parseAmount(exp?.amount);
    const date = exp?.date ? new Date(exp.date) : null;
    const mappedCategory =
      typeof exp?.categoryId === "string"
        ? categoryIdMap.get(exp.categoryId)
        : undefined;

    // Without a category the row can't be created at all — skip it
    // rather than aborting the whole import with an FK error.
    if (!title || amount === null || !mappedCategory) continue;
    if (!date || Number.isNaN(date.getTime())) continue;

    const createdExpense = await tx.expense.create({
      data: {
        userId,
        title,
        amount,
        date,
        categoryId: mappedCategory,
        paymentMethod: parsePaymentMethod(exp?.paymentMethod),
        bankAccountId:
          typeof exp?.bankAccountId === "string"
            ? bankIdMap.get(exp.bankAccountId) ?? null
            : null,
        note: parseText(exp?.note),
      },
    });
    expenseCount += 1;
    if (typeof exp.id === "string") expenseIdMap.set(exp.id, createdExpense.id);
    if (donationCategoryIds.has(mappedCategory)) {
      spentTotal += createdExpense.amount;
    }
  }

  let billCount = 0;
  for (const bill of asArray(parsed.bills)) {
    const title = parseText(bill?.title);
    const amount = parseAmount(bill?.amount);
    const dueDate = bill?.dueDate ? new Date(bill.dueDate) : null;
    if (!title || amount === null) continue;
    if (!dueDate || Number.isNaN(dueDate.getTime())) continue;

    // Without the expense link a restored paid bill can't be unpaid:
    // `unpay_bill` would flip the flag but leave the expense and its
    // ledger debit in place, and the bill could then be paid a second
    // time. The expense loop above has already run, so the id maps.
    const linkedExpenseId =
      typeof bill?.expenseId === "string"
        ? expenseIdMap.get(bill.expenseId) ?? null
        : null;

    await tx.bill.create({
      data: {
        userId,
        title,
        amount,
        dueDate,
        paid: bill?.paid === true,
        paidDate: bill?.paidDate ? new Date(bill.paidDate) : null,
        note: parseText(bill?.note),
        expenseId: linkedExpenseId,
      },
    });
    billCount += 1;
  }

  // Transfers were exported by neither the old backup nor restored by
  // the old importer, so every round trip lost them — and the ledger
  // entries they produced were left pointing at nothing, which made them
  // impossible to reverse.
  let transferCount = 0;
  for (const tr of asArray(parsed.transfers)) {
    const fromAccountId =
      typeof tr?.fromAccountId === "string"
        ? bankIdMap.get(tr.fromAccountId)
        : undefined;
    const toAccountId =
      typeof tr?.toAccountId === "string"
        ? bankIdMap.get(tr.toAccountId)
        : undefined;
    const trAmount = parseAmount(tr?.amount);
    if (!fromAccountId || !toAccountId || trAmount === null) continue;
    if (fromAccountId === toAccountId) continue;

    const createdTransfer = await tx.transfer.create({
      data: {
        userId,
        fromAccountId,
        toAccountId,
        amount: trAmount,
        note: parseText(tr?.note),
        occurredAt: tr?.occurredAt ? new Date(tr.occurredAt) : undefined,
      },
    });
    transferCount += 1;
    if (typeof tr?.id === "string") {
      transferIdMap.set(tr.id, createdTransfer.id);
    }
  }

  const ledgerRows = asArray(parsed.ledgerEntries);

  if (ledgerRows.length > 0) {
    // Originals before reversals, so `reversalOfId` can be remapped as
    // we go. The export is ordered by occurredAt, and a reversal always
    // occurs at or after its original, but sorting explicitly means the
    // import doesn't depend on that.
    const orderedRows = [...ledgerRows].sort((a, b) => {
      const aIsReversal = typeof a?.reversalOfId === "string" ? 1 : 0;
      const bIsReversal = typeof b?.reversalOfId === "string" ? 1 : 0;
      return aIsReversal - bIsReversal;
    });

    for (const entry of orderedRows) {
      const bankAccountId =
        typeof entry?.bankAccountId === "string"
          ? bankIdMap.get(entry.bankAccountId)
          : undefined;
      const entryAmount = parseBalance(entry?.amount);
      if (!bankAccountId || entryAmount === null || entryAmount === 0) {
        continue;
      }

      // Goes through the ledger rather than writing `currentBalance`
      // directly, so the one place that is allowed to move a balance
      // stays the only place that does.
      const created = await postLedgerEntry(tx, {
        userId,
        bankAccountId,
        amount: entryAmount,
        type: typeof entry.type === "string" ? entry.type : "ADJUSTMENT",
        description: parseText(entry?.description) ?? "পুনরুদ্ধারকৃত এন্ট্রি",
        occurredAt: entry?.occurredAt ? new Date(entry.occurredAt) : new Date(),
        source: {
          incomeId:
            typeof entry?.incomeId === "string"
              ? incomeIdMap.get(entry.incomeId) ?? null
              : null,
          expenseId:
            typeof entry?.expenseId === "string"
              ? expenseIdMap.get(entry.expenseId) ?? null
              : null,
          donationId:
            typeof entry?.donationId === "string"
              ? donationIdMap.get(entry.donationId) ?? null
              : null,
          transferId:
            typeof entry?.transferId === "string"
              ? transferIdMap.get(entry.transferId) ?? null
              : null,
        },
        reversalOfId:
          typeof entry?.reversalOfId === "string"
            ? ledgerIdMap.get(entry.reversalOfId) ?? null
            : null,
      });

      if (created) {
        if (typeof entry?.id === "string") {
          ledgerIdMap.set(entry.id, created.id);
        }
        // `postLedgerEntry` never sets this — a reversal is posted
        // against a live entry, so the flag is applied afterwards.
        if (entry?.reversedAt) {
          await tx.ledgerEntry.update({
            where: { id: created.id },
            data: { reversedAt: new Date(entry.reversedAt) },
          });
        }
      }
    }
  } else {
    // Backups written before the ledger existed only carry a closing
    // balance. Restore it as an opening entry so the statement still
    // adds up to the right figure.
    for (const bank of asArray(parsed.bankAccounts)) {
      const mapped =
        typeof bank?.id === "string" ? bankIdMap.get(bank.id) : undefined;
      const openingBalance = parseBalance(bank?.currentBalance);
      if (!mapped || openingBalance === null || openingBalance === 0) {
        continue;
      }
      await postLedgerEntry(tx, {
        userId,
        bankAccountId: mapped,
        amount: openingBalance,
        type: "OPENING",
        description: "ব্যাকআপ থেকে পুনরুদ্ধারকৃত ব্যালেন্স",
      });
    }
  }

  // Rebuilt from the rows actually restored. Incremented rather than
  // assigned, because a restore without "replace existing" adds to what
  // is already there — and when it does replace, the row was deleted
  // above so the increment starts from zero either way.
  allocatedTotal = roundMoney(allocatedTotal);
  spentTotal = roundMoney(spentTotal);
  if (allocatedTotal > 0 || spentTotal > 0) {
    await tx.donationBalance.upsert({
      where: { userId },
      create: { userId, allocated: allocatedTotal, spent: spentTotal },
      update: {
        allocated: { increment: allocatedTotal },
        spent: { increment: spentTotal },
      },
    });
  }

  return {
    categories: categoryIdMap.size,
    banks: bankIdMap.size,
    incomes: incomeCount,
    expenses: expenseCount,
    bills: billCount,
    transfers: transferCount,
  };
}
