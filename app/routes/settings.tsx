import { useState } from "react";
import {
  Form,
  useLoaderData,
  useActionData,
  useOutletContext,
  redirect,
} from "react-router";
import type { Route } from "./+types/settings";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/db.server";
import {
  requireUser,
  requireUserId,
  getSession,
  sessionStorage,
} from "../lib/auth.server";
import {
  parseAmount,
  parseBalance,
  parseIntParam,
  parsePaymentMethod,
  parseText,
  roundMoney,
} from "../lib/validation.server";
import { postLedgerEntry } from "../lib/ledger.server";
import { isDonationCategory } from "../lib/donation-balance.server";
import type { LayoutContextType } from "./layout";
import { Settings, User, Lock, Download, Upload } from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  return { user, passwordChanged: url.searchParams.get("passwordChanged") === "1" };
}

const MIN_PASSWORD_LENGTH = 8;

/**
 * One shape for every branch. Without this the inferred union has members that
 * lack the other branches' keys, so `actionData?.passError` fails to compile.
 */
type SettingsActionData = {
  profileError?: string;
  profileSuccess?: string;
  passError?: string;
  passSuccess?: string;
  backupError?: string;
  backupSuccess?: string;
};

/** Shapes we accept from a backup file, validated before anything is written. */
function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

export async function action({
  request,
}: Route.ActionArgs): Promise<SettingsActionData | Response | null> {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("_intent")?.toString();

  if (intent === "update_profile") {
    const name = parseText(formData.get("name"));
    const email = parseText(formData.get("email"))?.toLowerCase() ?? null;

    if (!name || !email) {
      return { profileError: "নাম এবং ইমেইল দুটোই প্রয়োজন।" };
    }

    try {
      await prisma.user.update({
        where: { id: userId },
        data: { name, email },
      });
      return { profileSuccess: "প্রোফাইল তথ্য সফলভাবে আপডেট হয়েছে!" };
    } catch (error) {
      // Let the unique index decide, instead of a read-then-write check that
      // two concurrent requests can both pass.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "P2002"
      ) {
        return { profileError: "এই ইমেইল এড্রেস দিয়ে অন্য একাউন্ট রয়েছে।" };
      }
      return { profileError: "প্রোফাইল আপডেট করা সম্ভব হয়নি।" };
    }
  }

  if (intent === "update_password") {
    const currentPassword = formData.get("currentPassword")?.toString();
    const newPassword = formData.get("newPassword")?.toString();
    const confirmPassword = formData.get("confirmPassword")?.toString();

    if (!currentPassword || !newPassword || !confirmPassword) {
      return { passError: "সমস্ত ঘর পূরণ করা আবশ্যক।" };
    }

    if (newPassword !== confirmPassword) {
      return { passError: "নতুন পাসওয়ার্ড ও নিশ্চিতকরণ মিলছে না।" };
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return {
        passError: `নতুন পাসওয়ার্ড অন্তত ${MIN_PASSWORD_LENGTH} অক্ষরের হতে হবে।`,
      };
    }

    if (newPassword === currentPassword) {
      return { passError: "নতুন পাসওয়ার্ড আগেরটির থেকে ভিন্ন হতে হবে।" };
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { passError: "ব্যবহারকারী পাওয়া যায়নি।" };

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return { passError: "বর্তমান পাসওয়ার্ড ভুল দেওয়া হয়েছে।" };
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Bumping sessionVersion invalidates every cookie issued before now, so a
    // stolen 30-day session dies the moment the password is changed.
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        sessionVersion: { increment: 1 },
      },
      select: { id: true, sessionVersion: true },
    });

    // ...including this browser's, so re-issue the current session with the
    // new version to keep the user signed in here.
    //
    // This has to be a redirect rather than plain action data: on a data
    // response React Router revalidates the loaders inside the same request,
    // and those still see the *old* cookie, so requireUser would immediately
    // bounce the user to /login. A redirect ships the new cookie first and the
    // follow-up GET carries it.
    const session = await getSession(request);
    session.set("userId", updated.id);
    session.set("sessionVersion", updated.sessionVersion);

    return redirect("/settings?passwordChanged=1", {
      headers: { "Set-Cookie": await sessionStorage.commitSession(session) },
    });
  }

  if (intent === "import_data") {
    const jsonString = formData.get("jsonString")?.toString();
    const replaceExisting = formData.get("replaceExisting") === "true";

    if (!jsonString) {
      return { backupError: "কোনো ডেটা ফাইল পাওয়া যায়নি।" };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonString);
    } catch {
      return { backupError: "ফাইলটি বৈধ JSON নয়। সঠিক ব্যাকআপ ফাইল নির্বাচন করুন।" };
    }

    if (!parsed || typeof parsed !== "object") {
      return { backupError: "সঠিক ব্যাকআপ JSON ফাইল নির্বাচন করুন।" };
    }

    try {
      const counts = await prisma.$transaction(async (tx) => {
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
              description:
                parseText(entry?.description) ?? "পুনরুদ্ধারকৃত এন্ট্রি",
              occurredAt: entry?.occurredAt
                ? new Date(entry.occurredAt)
                : new Date(),
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
      });

      return {
        backupSuccess: `ডেটা সফলভাবে রিস্টোর হয়েছে — ${counts.categories}টি ক্যাটাগরি, ${counts.banks}টি একাউন্ট, ${counts.incomes}টি আয়, ${counts.expenses}টি খরচ, ${counts.bills}টি বিল, ${counts.transfers}টি ট্রান্সফার।`,
      };
    } catch (error) {
      console.error("Backup import failed:", error);
      return {
        backupError:
          "ইম্পোর্ট করা যায়নি। কোনো পরিবর্তন সংরক্ষণ হয়নি — ফাইলটি পরীক্ষা করে আবার চেষ্টা করুন।",
      };
    }
  }

  return null;
}

export default function SettingsPage() {
  const { useBengaliDigits, setUseBengaliDigits } = useOutletContext<LayoutContextType>();
  const { user, passwordChanged } = useLoaderData<typeof loader>();
  const actionData = useActionData() as SettingsActionData | undefined;

  const [importJsonText, setImportJsonText] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setImportJsonText(event.target?.result as string || "");
      };
      reader.readAsText(file);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Top Banner */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Settings className="w-6 h-6 text-slate-400" />
            <span>সিস্টেম সেটিংস (Settings & Backup)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            প্রোফাইল তথ্য, সিকিউরিটি এবং ব্যাকআপ রিস্টোর অপশন
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Profile Card */}
        <div className="glass-card p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="font-bold text-slate-100 text-base flex items-center gap-2 border-b border-slate-800 pb-3">
            <User className="w-5 h-5 text-emerald-400" />
            <span>প্রোফাইল সেটিংস</span>
          </h3>

          {actionData?.profileError && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
              {actionData.profileError}
            </div>
          )}
          {actionData?.profileSuccess && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
              {actionData.profileSuccess}
            </div>
          )}

          <Form method="post" className="space-y-4">
            <input type="hidden" name="_intent" value="update_profile" />
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                ব্যবহারকারীর নাম
              </label>
              <input
                type="text"
                name="name"
                defaultValue={user?.name}
                required
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                ইমেইল এড্রেস
              </label>
              <input
                type="email"
                name="email"
                defaultValue={user?.email}
                required
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition shadow-md"
            >
              প্রোফাইল সংরক্ষণ করুন
            </button>
          </Form>
        </div>

        {/* Password Card */}
        <div className="glass-card p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="font-bold text-slate-100 text-base flex items-center gap-2 border-b border-slate-800 pb-3">
            <Lock className="w-5 h-5 text-amber-400" />
            <span>পাসওয়ার্ড পরিবর্তন</span>
          </h3>

          {actionData?.passError && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
              {actionData.passError}
            </div>
          )}
          {passwordChanged && !actionData?.passError && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
              পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে! অন্য সব ডিভাইস থেকে লগআউট হয়ে
              গেছে।
            </div>
          )}
          {actionData?.passSuccess && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
              {actionData.passSuccess}
            </div>
          )}

          <Form method="post" className="space-y-4">
            <input type="hidden" name="_intent" value="update_password" />
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                বর্তমান পাসওয়ার্ড
              </label>
              <input
                type="password"
                name="currentPassword"
                required
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                নতুন পাসওয়ার্ড
              </label>
              <input
                type="password"
                name="newPassword"
                required
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                পাসওয়ার্ড নিশ্চিত করুন
              </label>
              <input
                type="password"
                name="confirmPassword"
                required
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-amber-500"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs transition shadow-md"
            >
              পাসওয়ার্ড আপডেট করুন
            </button>
          </Form>
        </div>
      </div>

      {/* Backup & Restore Section */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 space-y-6">
        <h3 className="font-bold text-slate-100 text-base flex items-center gap-2 border-b border-slate-800 pb-3">
          <Download className="w-5 h-5 text-sky-400" />
          <span>ডেটা ব্যাকআপ ও ইম্পোর্ট (Data Backup & Restore)</span>
        </h3>

        {actionData?.backupError && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
            {actionData.backupError}
          </div>
        )}
        {actionData?.backupSuccess && (
          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
            {actionData.backupSuccess}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Export JSON */}
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
            <h4 className="font-semibold text-slate-200 text-sm">
              ১. ব্যাকআপ ডেটা ডাউনলোড করুন
            </h4>
            <p className="text-xs text-slate-400">
              আপনার সমস্ত আয়, খরচ, বিল এবং ব্যাংক একাউন্টের একটি পূর্ণাঙ্গ JSON ফাইল হিসেবে সংরক্ষণ করে রাখুন।
            </p>
            <a
              href="/settings/export"
              download
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs shadow-md transition"
            >
              <Download className="w-4 h-4" />
              <span>ব্যাকআপ JSON ডাউনলোড</span>
            </a>
          </div>

          {/* Import JSON */}
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
            <h4 className="font-semibold text-slate-200 text-sm">
              ২. ব্যাকআপ ফাইল রিস্টোর করুন
            </h4>
            <p className="text-xs text-slate-400">
              আগের ডাউনলোডকৃত JSON ব্যাকআপ ফাইল নির্বাচন করে ডেটা রিস্টোর করুন।
            </p>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="_intent" value="import_data" />
              <input type="hidden" name="jsonString" value={importJsonText} />
              <input
                type="hidden"
                name="replaceExisting"
                value={String(replaceExisting)}
              />

              <input
                type="file"
                accept=".json"
                onChange={handleFileUpload}
                className="block w-full text-xs text-slate-400 file:mr-4 file:py-2 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-slate-200 hover:file:bg-slate-700"
              />

              <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={replaceExisting}
                  onChange={(e) => setReplaceExisting(e.target.checked)}
                  className="mt-0.5 rounded text-purple-500 focus:ring-purple-500 bg-slate-800 border-slate-700"
                />
                <span>
                  ইম্পোর্টের আগে আমার বর্তমান সব ডেটা মুছে ফেলুন
                  <span className="block text-slate-500 mt-0.5">
                    টিক না দিলে ডেটা যুক্ত হবে (একই ব্যাকআপ দুইবার ইম্পোর্ট করলে
                    ডুপ্লিকেট তৈরি হবে)।
                  </span>
                </span>
              </label>

              <button
                type="submit"
                disabled={!importJsonText}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-semibold text-xs shadow-md transition"
              >
                <Upload className="w-4 h-4" />
                <span>ডেটা ইম্পোর্ট করুন</span>
              </button>
            </Form>
          </div>
        </div>
      </div>
    </div>
  );
}
