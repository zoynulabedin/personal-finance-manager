import { Form, Link, useLoaderData, useOutletContext } from "react-router";
import type { Route } from "./+types/transactions";
import { prisma } from "../lib/db.server";
import { requireUserId } from "../lib/auth.server";
import { reconcileBalances } from "../lib/ledger.server";
import type { LayoutContextType } from "./layout";
import { formatBDT, toBengaliDigits, formatBengaliDate } from "../utils/bengali";
import {
  monthRange,
  parseMonthParam,
  parseYearParam,
  roundMoney,
  selectableYears,
} from "../lib/validation.server";
import { BENGALI_MONTHS } from "../utils/bengali";
import {
  ScrollText,
  ArrowDownRight,
  ArrowUpRight,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";

const TYPE_LABELS: Record<string, string> = {
  OPENING: "প্রারম্ভিক",
  INCOME: "আয়",
  EXPENSE: "খরচ",
  DONATION: "দান",
  ADJUSTMENT: "সমন্বয়",
};

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);

  const accountId = url.searchParams.get("account") || "";
  const selectedMonth = parseMonthParam(url.searchParams.get("month"));
  const selectedYear = parseYearParam(url.searchParams.get("year"));
  const showAll = url.searchParams.get("scope") === "all";

  const range = monthRange(selectedYear, selectedMonth);

  const accounts = await prisma.bankAccount.findMany({
    where: { userId },
    orderBy: [{ isCash: "asc" }, { bankName: "asc" }],
  });

  // An account id from the query string is only honoured if it's the user's.
  const activeAccount = accountId
    ? accounts.find((a) => a.id === accountId) ?? null
    : null;

  const where: any = { userId };
  if (activeAccount) where.bankAccountId = activeAccount.id;
  if (!showAll) where.occurredAt = { gte: range.start, lte: range.end };

  const entries = await prisma.ledgerEntry.findMany({
    where,
    include: { bankAccount: { select: { bankName: true, accountName: true } } },
    orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
  });

  /**
   * Running balance only means something for a single account, and only if we
   * know where it stood before this window. Work backwards from the account's
   * current balance instead of forwards from an unknown starting point.
   */
  let runningBalances: number[] = [];
  if (activeAccount) {
    const laterSum = await prisma.ledgerEntry.aggregate({
      where: {
        userId,
        bankAccountId: activeAccount.id,
        ...(showAll
          ? {}
          : { occurredAt: { gt: range.end } }),
      },
      _sum: { amount: true },
    });

    let balance = roundMoney(
      activeAccount.currentBalance - (showAll ? 0 : laterSum._sum.amount ?? 0)
    );

    // Fill from the last row upwards so each row shows the balance after it.
    const reversed: number[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      reversed[i] = balance;
      balance = roundMoney(balance - entries[i].amount);
    }
    runningBalances = reversed;
  }

  const credits = roundMoney(
    entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0)
  );
  const debits = roundMoney(
    entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0)
  );

  // Cheap safety net: if a cached balance ever disagreed with its entries,
  // this page says so instead of quietly showing a wrong number.
  const mismatches = await reconcileBalances(prisma, userId);

  return {
    entries: entries.map((entry, index) => ({
      ...entry,
      runningBalance: activeAccount ? runningBalances[index] : null,
    })),
    accounts,
    activeAccountId: activeAccount?.id ?? "",
    credits,
    debits,
    net: roundMoney(credits + debits),
    selectedMonth,
    selectedYear,
    showAll,
    years: selectableYears(),
    mismatches,
  };
}

export default function TransactionsPage() {
  const { useBengaliDigits } = useOutletContext<LayoutContextType>();
  const {
    entries,
    accounts,
    activeAccountId,
    credits,
    debits,
    net,
    selectedMonth,
    selectedYear,
    showAll,
    years,
    mismatches,
  } = useLoaderData<typeof loader>();

  const digits = (value: number | string) =>
    useBengaliDigits ? toBengaliDigits(value) : value;

  return (
    <div className="space-y-6">
      {/* Header & filters */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <ScrollText className="w-6 h-6 text-sky-400" />
            <span>লেনদেনের খতিয়ান (Account Statement)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            প্রতিটি টাকার নড়াচড়ার স্থায়ী রেকর্ড — ব্যালেন্স কীভাবে হলো তার পূর্ণ হিসাব
          </p>
        </div>

        <Form method="get" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="scope" value={showAll ? "all" : "month"} />
          <select
            name="account"
            defaultValue={activeAccountId}
            onChange={(e) => e.target.form?.submit()}
            className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs font-semibold focus:outline-none focus:border-sky-500"
          >
            <option value="">সব অ্যাকাউন্ট</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.bankName} ({a.accountName})
              </option>
            ))}
          </select>

          <select
            name="month"
            disabled={showAll}
            defaultValue={selectedMonth}
            onChange={(e) => e.target.form?.submit()}
            className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs font-semibold focus:outline-none focus:border-sky-500 disabled:opacity-50"
          >
            {BENGALI_MONTHS.map((m, idx) => (
              <option key={idx} value={idx + 1}>
                {m}
              </option>
            ))}
          </select>

          <select
            name="year"
            disabled={showAll}
            defaultValue={selectedYear}
            onChange={(e) => e.target.form?.submit()}
            className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs font-semibold focus:outline-none focus:border-sky-500 disabled:opacity-50"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {digits(y)}
              </option>
            ))}
          </select>

          <Link
            to={
              showAll
                ? `?account=${activeAccountId}&month=${selectedMonth}&year=${selectedYear}`
                : `?account=${activeAccountId}&month=${selectedMonth}&year=${selectedYear}&scope=all`
            }
            className={`px-3 py-2 rounded-xl text-xs font-semibold border transition ${
              showAll
                ? "bg-sky-600 text-white border-sky-500"
                : "bg-slate-900 text-slate-300 border-slate-700 hover:text-white"
            }`}
          >
            সব সময়ের
          </Link>
        </Form>
      </div>

      {/* Reconciliation status */}
      {mismatches.length > 0 ? (
        <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <strong>ব্যালেন্স মিলছে না:</strong> {digits(mismatches.length)}টি
            অ্যাকাউন্টের সঞ্চিত ব্যালেন্স খতিয়ানের যোগফলের সাথে মিলছে না। এটি একটি
            বাগ — অনুগ্রহ করে জানান।
          </div>
        </div>
      ) : (
        <div className="p-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>সব অ্যাকাউন্টের ব্যালেন্স খতিয়ানের যোগফলের সাথে মিলে গেছে।</span>
        </div>
      )}

      {/* Totals */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="glass-card p-5 rounded-2xl border border-slate-800">
          <span className="text-xs text-slate-400 uppercase font-semibold">
            মোট জমা
          </span>
          <div className="text-2xl font-extrabold text-emerald-400 mt-1">
            {formatBDT(credits, useBengaliDigits)}
          </div>
        </div>
        <div className="glass-card p-5 rounded-2xl border border-slate-800">
          <span className="text-xs text-slate-400 uppercase font-semibold">
            মোট উত্তোলন
          </span>
          <div className="text-2xl font-extrabold text-rose-400 mt-1">
            {formatBDT(Math.abs(debits), useBengaliDigits)}
          </div>
        </div>
        <div className="glass-card p-5 rounded-2xl border border-slate-800">
          <span className="text-xs text-slate-400 uppercase font-semibold">
            নিট পরিবর্তন
          </span>
          <div
            className={`text-2xl font-extrabold mt-1 ${
              net >= 0 ? "text-sky-400" : "text-amber-400"
            }`}
          >
            {formatBDT(net, useBengaliDigits)}
          </div>
        </div>
      </div>

      {/* Entries */}
      <div className="glass-card rounded-2xl border border-slate-800 overflow-hidden">
        <div className="p-4 border-b border-slate-800 font-bold text-slate-200 text-sm">
          {digits(entries.length)}টি এন্ট্রি
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400 uppercase tracking-wider bg-slate-900/60">
                <th className="py-3 px-4">তারিখ</th>
                <th className="py-3 px-4">বিবরণ</th>
                <th className="py-3 px-4">ধরন</th>
                <th className="py-3 px-4">অ্যাকাউন্ট</th>
                <th className="py-3 px-4 text-right">পরিমাণ</th>
                {activeAccountId && (
                  <th className="py-3 px-4 text-right">ব্যালেন্স</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {entries.map((entry) => (
                <tr
                  key={entry.id}
                  className={`hover:bg-slate-800/40 transition ${
                    entry.reversedAt || entry.reversalOfId ? "opacity-60" : ""
                  }`}
                >
                  <td className="py-3.5 px-4 text-xs text-slate-300 whitespace-nowrap">
                    {formatBengaliDate(entry.occurredAt, useBengaliDigits)}
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="font-medium text-slate-100">
                      {entry.description}
                    </div>
                    {entry.reversedAt && (
                      <span className="text-[10px] text-amber-400">
                        পরে বাতিল করা হয়েছে
                      </span>
                    )}
                    {entry.reversalOfId && (
                      <span className="text-[10px] text-slate-400">
                        বাতিলকরণ এন্ট্রি
                      </span>
                    )}
                  </td>
                  <td className="py-3.5 px-4">
                    <span className="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 text-xs border border-slate-700">
                      {TYPE_LABELS[entry.type] ?? entry.type}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-xs text-slate-400">
                    {entry.bankAccount.bankName}
                  </td>
                  <td
                    className={`py-3.5 px-4 text-right font-bold whitespace-nowrap ${
                      entry.amount >= 0 ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    <span className="inline-flex items-center gap-1 justify-end">
                      {entry.amount >= 0 ? (
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      ) : (
                        <ArrowDownRight className="w-3.5 h-3.5" />
                      )}
                      {formatBDT(Math.abs(entry.amount), useBengaliDigits)}
                    </span>
                  </td>
                  {activeAccountId && (
                    <td className="py-3.5 px-4 text-right font-semibold text-slate-200 whitespace-nowrap">
                      {entry.runningBalance === null
                        ? "-"
                        : formatBDT(entry.runningBalance, useBengaliDigits)}
                    </td>
                  )}
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td
                    colSpan={activeAccountId ? 6 : 5}
                    className="py-8 text-center text-slate-500 text-xs"
                  >
                    এই সময়ে কোনো লেনদেন পাওয়া যায়নি
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
