import { useOutletContext, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/dashboard";
import { prisma } from "../lib/db.server";
import { requireUserId } from "../lib/auth.server";
import { dayRange, monthRange, roundMoney } from "../lib/validation.server";
import type { LayoutContextType } from "./layout";
import { formatBDT, toBengaliDigits, formatBengaliDate } from "../utils/bengali";
import {
  Wallet,
  Receipt,
  PiggyBank,
  HeartHandshake,
  Landmark,
  Banknote,
  AlertCircle,
  TrendingDown,
  TrendingUp,
  ArrowUpRight,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  CartesianGrid,
} from "recharts";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const today = dayRange(now);
  const thisMonth = monthRange(currentYear, currentMonth);

  // The trend chart covers the last 6 months; fetch that whole window once
  // instead of issuing two queries per month inside a loop (12 serial
  // round-trips on every dashboard load).
  const windowStart = new Date(currentYear, currentMonth - 6, 1, 0, 0, 0, 0);

  const [
    incomeAgg,
    monthlyExpenses,
    todayAgg,
    bankAccounts,
    donationRows,
    donationBalance,
    pendingBills,
    recentExpenses,
    windowIncomes,
    windowExpenses,
  ] = await Promise.all([
    prisma.income.aggregate({
      where: { userId, month: currentMonth, year: currentYear },
      _sum: { amount: true },
    }),
    prisma.expense.findMany({
      where: { userId, date: { gte: thisMonth.start, lte: thisMonth.end } },
      include: { category: true },
    }),
    prisma.expense.aggregate({
      where: { userId, date: { gte: today.start, lte: today.end } },
      _sum: { amount: true },
    }),
    prisma.bankAccount.findMany({ where: { userId } }),
    // Scoped to the current month so this card matches the income and expense
    // cards beside it; the old query summed every donation ever recorded.
    prisma.donation.findMany({
      where: {
        income: { userId, month: currentMonth, year: currentYear },
      },
      select: { amount: true, paid: true },
    }),
    prisma.donationBalance.findUnique({
      where: { userId },
      select: { allocated: true, spent: true },
    }),
    prisma.bill.findMany({
      where: { userId, paid: false },
      orderBy: { dueDate: "asc" },
      take: 10,
    }),
    prisma.expense.findMany({
      where: { userId },
      take: 5,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      include: { category: true, bankAccount: true },
    }),
    prisma.income.findMany({
      where: {
        userId,
        OR: Array.from({ length: 6 }, (_, i) => {
          const d = new Date(currentYear, currentMonth - 1 - (5 - i), 1);
          return { month: d.getMonth() + 1, year: d.getFullYear() };
        }),
      },
      select: { amount: true, month: true, year: true },
    }),
    prisma.expense.findMany({
      where: { userId, date: { gte: windowStart, lte: thisMonth.end } },
      select: { amount: true, date: true },
    }),
  ]);

  const currentMonthIncome = roundMoney(incomeAgg._sum.amount ?? 0);
  const currentMonthExpense = roundMoney(
    monthlyExpenses.reduce((sum, item) => sum + item.amount, 0)
  );
  const todayExpenseTotal = roundMoney(todayAgg._sum.amount ?? 0);

  // Cash vs bank is driven by an explicit flag. Matching on `bankName ===
  // "Cash"` with `find` returned a single account, so a second cash wallet
  // vanished from both totals.
  const totalBankBalance = roundMoney(
    bankAccounts.filter((b) => !b.isCash).reduce((s, b) => s + b.currentBalance, 0)
  );
  const cashBalance = roundMoney(
    bankAccounts.filter((b) => b.isCash).reduce((s, b) => s + b.currentBalance, 0)
  );

  const totalDonationAmount = roundMoney(
    donationRows.reduce((sum, d) => sum + d.amount, 0)
  );
  const pendingDonationAmount = roundMoney(
    donationRows.filter((d) => !d.paid).reduce((sum, d) => sum + d.amount, 0)
  );

  const totalPendingBillsAmount = roundMoney(
    pendingBills.reduce((sum, b) => sum + b.amount, 0)
  );

  // Category breakdown for the current month.
  const categoryMap = new Map<string, { name: string; amount: number; color: string }>();
  for (const exp of monthlyExpenses) {
    const key = exp.category.name;
    const existing = categoryMap.get(key);
    if (existing) {
      existing.amount = roundMoney(existing.amount + exp.amount);
    } else {
      categoryMap.set(key, {
        name: key,
        amount: exp.amount,
        color: exp.category.color || "#10b981",
      });
    }
  }
  const categoryChartData = Array.from(categoryMap.values()).sort(
    (a, b) => b.amount - a.amount
  );

  // Bucket the pre-fetched window rows in memory.
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  const last6MonthsData = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(currentYear, currentMonth - 1 - (5 - i), 1);
    const m = d.getMonth() + 1;
    const y = d.getFullYear();

    const incSum = windowIncomes
      .filter((inc) => inc.month === m && inc.year === y)
      .reduce((s, inc) => s + inc.amount, 0);

    const expSum = windowExpenses
      .filter(
        (exp) =>
          exp.date.getFullYear() === y && exp.date.getMonth() + 1 === m
      )
      .reduce((s, exp) => s + exp.amount, 0);

    return {
      month: monthNames[m - 1],
      আয়: roundMoney(incSum),
      খরচ: roundMoney(expSum),
    };
  });

  const donationAllocated = donationBalance?.allocated ?? 0;
  const donationSpent = donationBalance?.spent ?? 0;
  const donationRemaining = roundMoney(donationAllocated - donationSpent);

  return {
    currentMonthIncome,
    currentMonthExpense,
    remainingSavings: roundMoney(currentMonthIncome - currentMonthExpense),
    todayExpenseTotal,
    totalBankBalance,
    cashBalance,
    totalDonationAmount,
    pendingDonationAmount,
    donationAllocated,
    donationSpent,
    donationRemaining,
    pendingBills,
    totalPendingBillsAmount,
    recentExpenses,
    categoryChartData,
    last6MonthsData,
  };
}

export default function Dashboard() {
  const { useBengaliDigits } = useOutletContext<LayoutContextType>();
  const data = useLoaderData<typeof loader>();

  return (
    <div className="space-y-8 pb-12">
      {/* Overview Metric Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        {/* Card 1: Total Income */}
        <div className="glass-card p-5 rounded-2xl border border-slate-800 flex flex-col justify-between relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              চলতি মাসের আয়
            </span>
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
              <Wallet className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-4">
            <div className="text-2xl sm:text-3xl font-extrabold text-slate-100 tracking-tight">
              {formatBDT(data.currentMonthIncome, useBengaliDigits)}
            </div>
            <p className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>মাসিক আয় সমাহার</span>
            </p>
          </div>
        </div>

        {/* Card 2: Total Expense */}
        <div className="glass-card p-5 rounded-2xl border border-slate-800 flex flex-col justify-between relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              চলতি মাসের খরচ
            </span>
            <div className="w-10 h-10 rounded-xl bg-rose-500/10 text-rose-400 flex items-center justify-center">
              <Receipt className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-4">
            <div className="text-2xl sm:text-3xl font-extrabold text-rose-400 tracking-tight">
              {formatBDT(data.currentMonthExpense, useBengaliDigits)}
            </div>
            <p className="text-xs text-slate-400 mt-1 flex items-center gap-1">
              <span>আজকের খরচ:</span>
              <strong className="text-slate-200">
                {formatBDT(data.todayExpenseTotal, useBengaliDigits)}
              </strong>
            </p>
          </div>
        </div>

        {/* Card 3: Remaining Balance / Savings */}
        <div className="glass-card p-5 rounded-2xl border border-slate-800 flex flex-col justify-between relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              অবশিষ্ট আয় / সঞ্চয়
            </span>
            <div className="w-10 h-10 rounded-xl bg-sky-500/10 text-sky-400 flex items-center justify-center">
              <PiggyBank className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-4">
            <div
              className={`text-2xl sm:text-3xl font-extrabold tracking-tight ${
                data.remainingSavings >= 0 ? "text-sky-400" : "text-amber-400"
              }`}
            >
              {formatBDT(data.remainingSavings, useBengaliDigits)}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              আয় থেকে খরচ বাদ দিয়ে অবশিষ্ট
            </p>
          </div>
        </div>

        {/* Card 4: 1% Donation */}
        <div className="glass-card p-5 rounded-2xl border border-slate-800 flex flex-col justify-between relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              চলতি মাসের ১% দান
            </span>
            <div className="w-10 h-10 rounded-xl bg-teal-500/10 text-teal-400 flex items-center justify-center">
              <HeartHandshake className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-4">
            <div className="text-2xl sm:text-3xl font-extrabold text-teal-400 tracking-tight">
              {formatBDT(data.totalDonationAmount, useBengaliDigits)}
            </div>
            <p className="text-xs text-amber-400 mt-1">
              বকেয়া দান: {formatBDT(data.pendingDonationAmount, useBengaliDigits)}
            </p>
          </div>
        </div>
      </div>

      {/* Secondary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="glass-card p-5 rounded-2xl border border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
              <Landmark className="w-6 h-6" />
            </div>
            <div>
              <p className="text-xs font-medium text-slate-400">মোট ব্যাংক ব্যালেন্স</p>
              <h3 className="text-xl font-bold text-slate-100">
                {formatBDT(data.totalBankBalance, useBengaliDigits)}
              </h3>
            </div>
          </div>
          <Link
            to="/bank-accounts"
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <ArrowUpRight className="w-5 h-5" />
          </Link>
        </div>

        <div className="glass-card p-5 rounded-2xl border border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center">
              <Banknote className="w-6 h-6" />
            </div>
            <div>
              <p className="text-xs font-medium text-slate-400">নগদ টাকা (Wallet)</p>
              <h3 className="text-xl font-bold text-slate-100">
                {formatBDT(data.cashBalance, useBengaliDigits)}
              </h3>
            </div>
          </div>
          <Link
            to="/bank-accounts"
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <ArrowUpRight className="w-5 h-5" />
          </Link>
        </div>

        <div className="glass-card p-5 rounded-2xl border border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-rose-500/10 text-rose-400 flex items-center justify-center">
              <AlertCircle className="w-6 h-6" />
            </div>
            <div>
              <p className="text-xs font-medium text-slate-400">বকেয়া মাসিক বিল ({useBengaliDigits ? toBengaliDigits(data.pendingBills.length) : data.pendingBills.length}টি)</p>
              <h3 className="text-xl font-bold text-rose-400">
                {formatBDT(data.totalPendingBillsAmount, useBengaliDigits)}
              </h3>
            </div>
          </div>
          <Link
            to="/bills"
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <ArrowUpRight className="w-5 h-5" />
          </Link>
        </div>
      </div>

      {/* Analytics Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Income vs Expense Bar Chart */}
        <div className="glass-card p-6 rounded-2xl border border-slate-800 lg:col-span-2">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="font-bold text-slate-100 text-lg">
                আয় ও খরচ ট্রেন্ড (বিগত ৬ মাস)
              </h3>
              <p className="text-xs text-slate-400">
                মাসিক মোট আয় এবং খরচের তুলনামূলক চিত্র
              </p>
            </div>
          </div>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.last6MonthsData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="month" stroke="#64748b" />
                <YAxis stroke="#64748b" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#0f172a",
                    borderColor: "#334155",
                    borderRadius: "12px",
                    color: "#f8fafc",
                  }}
                />
                <Bar dataKey="আয়" fill="#10b981" radius={[6, 6, 0, 0]} />
                <Bar dataKey="খরচ" fill="#f43f5e" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Category Expense Pie Chart */}
        <div className="glass-card p-6 rounded-2xl border border-slate-800">
          <div className="mb-4">
            <h3 className="font-bold text-slate-100 text-lg">
              খাতভিত্তিক খরচ
            </h3>
            <p className="text-xs text-slate-400">
              চলতি মাসের খরচের ক্যাটাগরি ডিস্ট্রিবিউশন
            </p>
          </div>
          {data.categoryChartData.length > 0 ? (
            <div className="h-60 w-full relative">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.categoryChartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={80}
                    paddingAngle={4}
                    dataKey="amount"
                  >
                    {data.categoryChartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: any) => formatBDT(Number(value), useBengaliDigits)}
                    contentStyle={{
                      backgroundColor: "#0f172a",
                      borderColor: "#334155",
                      borderRadius: "12px",
                      color: "#f8fafc",
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-60 flex items-center justify-center text-slate-500 text-sm">
              এই মাসে এখনও কোনো খরচের ডেটা নেই
            </div>
          )}

          {/* Top 3 categories legend */}
          <div className="space-y-2 mt-2">
            {data.categoryChartData.slice(0, 3).map((cat, idx) => (
              <div key={idx} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: cat.color }}
                  />
                  <span className="text-slate-300 truncate max-w-[120px]">
                    {cat.name}
                  </span>
                </div>
                <span className="font-semibold text-slate-200">
                  {formatBDT(cat.amount, useBengaliDigits)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent Expenses Table & Pending Bills Sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Expenses */}
        <div className="glass-card p-6 rounded-2xl border border-slate-800 lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-bold text-slate-100 text-lg">
                সাম্প্রতিক খরচসমূহ
              </h3>
              <p className="text-xs text-slate-400">সর্বশেষ ৫টি দৈনিক খরচের এন্ট্রি</p>
            </div>
            <Link
              to="/expenses"
              className="text-xs text-emerald-400 hover:text-emerald-300 font-semibold flex items-center gap-1"
            >
              <span>সকল খরচ দেখুন</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400 uppercase tracking-wider">
                  <th className="py-3 px-2">বিবরণ</th>
                  <th className="py-3 px-2">ক্যাটাগরি</th>
                  <th className="py-3 px-2">পেমেন্ট</th>
                  <th className="py-3 px-2 text-right">পরিমাণ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {data.recentExpenses.map((exp) => (
                  <tr key={exp.id} className="hover:bg-slate-800/40 transition">
                    <td className="py-3 px-2">
                      <div className="font-medium text-slate-200">{exp.title}</div>
                      <div className="text-[11px] text-slate-400">
                        {formatBengaliDate(exp.date, useBengaliDigits)}
                      </div>
                    </td>
                    <td className="py-3 px-2">
                      <span className="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 text-xs border border-slate-700">
                        {exp.category.name}
                      </span>
                    </td>
                    <td className="py-3 px-2 text-xs text-slate-400">
                      {exp.paymentMethod}{" "}
                      {exp.bankAccount ? `(${exp.bankAccount.bankName})` : ""}
                    </td>
                    <td className="py-3 px-2 text-right font-bold text-rose-400">
                      {formatBDT(exp.amount, useBengaliDigits)}
                    </td>
                  </tr>
                ))}
                {data.recentExpenses.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-slate-500 text-xs">
                      কোনো খরচের এন্ট্রি পাওয়া যায়নি
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pending Bills List */}
        <div className="glass-card p-6 rounded-2xl border border-slate-800 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-slate-100 text-lg">
              বকেয়া ইউটিলিটি বিল
            </h3>
            <Link
              to="/bills"
              className="text-xs text-emerald-400 hover:text-emerald-300 font-semibold"
            >
              ম্যানেজ করুন
            </Link>
          </div>

          <div className="space-y-3">
            {data.pendingBills.map((bill) => (
              <div
                key={bill.id}
                className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center justify-between"
              >
                <div>
                  <h4 className="font-semibold text-slate-200 text-sm">
                    {bill.title}
                  </h4>
                  <p className="text-xs text-rose-400 mt-0.5">
                    শেষ তারিখ: {formatBengaliDate(bill.dueDate, useBengaliDigits)}
                  </p>
                </div>
                <div className="text-right">
                  <div className="font-bold text-slate-100 text-sm">
                    {formatBDT(bill.amount, useBengaliDigits)}
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20 font-medium">
                    অপরিশোধিত
                  </span>
                </div>
              </div>
            ))}

            {data.pendingBills.length === 0 && (
              <div className="p-6 text-center text-slate-400 text-xs flex flex-col items-center gap-2">
                <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                <span>সব ইউটিলিটি বিল পরিশোধ করা হয়েছে!</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
