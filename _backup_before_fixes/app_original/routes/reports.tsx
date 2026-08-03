import { useState } from "react";
import { Form, useLoaderData, useOutletContext } from "react-router";
import type { Route } from "./+types/reports";
import { prisma } from "../lib/db.server";
import { requireUserId } from "../lib/auth.server";
import type { LayoutContextType } from "./layout";
import { formatBDT, BENGALI_MONTHS, toBengaliDigits } from "../utils/bengali";
import { BarChart3, Printer } from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);
  const selectedYear = parseInt(url.searchParams.get("year") || String(new Date().getFullYear()));
  const selectedMonth = parseInt(url.searchParams.get("month") || String(new Date().getMonth() + 1));

  // 1. Monthly Data (Scoped to userId)
  const mStart = new Date(selectedYear, selectedMonth - 1, 1);
  const mEnd = new Date(selectedYear, selectedMonth, 0, 23, 59, 59);

  const monthlyIncomes = await prisma.income.findMany({
    where: { userId, month: selectedMonth, year: selectedYear },
  });
  const monthlyExpenses = await prisma.expense.findMany({
    where: { userId, date: { gte: mStart, lte: mEnd } },
    include: { category: true },
  });

  const totalMonthlyIncome = monthlyIncomes.reduce((s, item) => s + item.amount, 0);
  const totalMonthlyExpense = monthlyExpenses.reduce((s, item) => s + item.amount, 0);
  const totalMonthlyDonation = totalMonthlyIncome * 0.01;
  const totalMonthlySavings = totalMonthlyIncome - totalMonthlyExpense;

  // Category breakdown for selected month (Scoped to userId)
  const categorySummary: { [key: string]: { name: string; amount: number; color: string; count: number } } = {};
  monthlyExpenses.forEach((exp) => {
    const name = exp.category.name;
    const color = exp.category.color || "#10b981";
    if (!categorySummary[name]) {
      categorySummary[name] = { name, amount: 0, color, count: 0 };
    }
    categorySummary[name].amount += exp.amount;
    categorySummary[name].count += 1;
  });
  const categoryReport = Object.values(categorySummary).sort((a, b) => b.amount - a.amount);

  // 2. Yearly Breakdown (12 Months) (Scoped to userId)
  const yearlyMonthsData = [];
  let totalYearlyIncome = 0;
  let totalYearlyExpense = 0;

  for (let m = 1; m <= 12; m++) {
    const start = new Date(selectedYear, m - 1, 1);
    const end = new Date(selectedYear, m, 0, 23, 59, 59);

    const incs = await prisma.income.findMany({
      where: { userId, month: m, year: selectedYear },
    });
    const exps = await prisma.expense.findMany({
      where: { userId, date: { gte: start, lte: end } },
    });

    const incSum = incs.reduce((s, i) => s + i.amount, 0);
    const expSum = exps.reduce((s, e) => s + e.amount, 0);
    const donation = incSum * 0.01;
    const savings = incSum - expSum;

    totalYearlyIncome += incSum;
    totalYearlyExpense += expSum;

    yearlyMonthsData.push({
      monthNumber: m,
      monthName: BENGALI_MONTHS[m - 1],
      income: incSum,
      expense: expSum,
      donation,
      savings,
    });
  }

  const totalYearlyDonation = totalYearlyIncome * 0.01;
  const totalYearlySavings = totalYearlyIncome - totalYearlyExpense;

  return {
    selectedYear,
    selectedMonth,
    totalMonthlyIncome,
    totalMonthlyExpense,
    totalMonthlyDonation,
    totalMonthlySavings,
    categoryReport,
    yearlyMonthsData,
    totalYearlyIncome,
    totalYearlyExpense,
    totalYearlyDonation,
    totalYearlySavings,
  };
}

export default function ReportsPage() {
  const { useBengaliDigits } = useOutletContext<LayoutContextType>();
  const data = useLoaderData<typeof loader>();
  const [activeTab, setActiveTab] = useState<"monthly" | "yearly" | "category">("monthly");

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-sky-400" />
            <span>আর্থিক রিপোর্ট ও অ্যানালিটিক্স (Financial Reports)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            মাসিক, বার্ষিক ও খাতভিত্তিক আয়ে-ব্যয়ের পূর্ণাঙ্গ সমীকরণ
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Year/Month Selector */}
          <Form method="get" className="flex items-center gap-2">
            <select
              name="month"
              defaultValue={data.selectedMonth}
              onChange={(e) => e.target.form?.submit()}
              className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs font-semibold focus:outline-none focus:border-sky-500"
            >
              {BENGALI_MONTHS.map((m, idx) => (
                <option key={idx} value={idx + 1}>
                  {m}
                </option>
              ))}
            </select>
            <select
              name="year"
              defaultValue={data.selectedYear}
              onChange={(e) => e.target.form?.submit()}
              className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs font-semibold focus:outline-none focus:border-sky-500"
            >
              {[2025, 2026, 2027].map((y) => (
                <option key={y} value={y}>
                  {useBengaliDigits ? toBengaliDigits(y) : y}
                </option>
              ))}
            </select>
          </Form>

          <button
            onClick={handlePrint}
            className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-xs flex items-center gap-2 border border-slate-700 transition"
          >
            <Printer className="w-4 h-4" />
            <span>প্রিন্ট/PDF</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setActiveTab("monthly")}
          className={`px-4 py-2 rounded-xl font-bold text-xs transition ${
            activeTab === "monthly"
              ? "bg-sky-600 text-white shadow-md"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
          }`}
        >
          মাসিক রিপোর্ট ({BENGALI_MONTHS[data.selectedMonth - 1]})
        </button>
        <button
          onClick={() => setActiveTab("category")}
          className={`px-4 py-2 rounded-xl font-bold text-xs transition ${
            activeTab === "category"
              ? "bg-sky-600 text-white shadow-md"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
          }`}
        >
          খাতভিত্তিক খরচ (Category Report)
        </button>
        <button
          onClick={() => setActiveTab("yearly")}
          className={`px-4 py-2 rounded-xl font-bold text-xs transition ${
            activeTab === "yearly"
              ? "bg-sky-600 text-white shadow-md"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
          }`}
        >
          বার্ষিক সামারি ({useBengaliDigits ? toBengaliDigits(data.selectedYear) : data.selectedYear})
        </button>
      </div>

      {/* TAB 1: Monthly Report */}
      {activeTab === "monthly" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="glass-card p-5 rounded-2xl border border-slate-800">
              <span className="text-xs text-slate-400 uppercase font-semibold">মোট আয়</span>
              <div className="text-2xl font-extrabold text-emerald-400 mt-1">
                {formatBDT(data.totalMonthlyIncome, useBengaliDigits)}
              </div>
            </div>

            <div className="glass-card p-5 rounded-2xl border border-slate-800">
              <span className="text-xs text-slate-400 uppercase font-semibold">মোট খরচ</span>
              <div className="text-2xl font-extrabold text-rose-400 mt-1">
                {formatBDT(data.totalMonthlyExpense, useBengaliDigits)}
              </div>
            </div>

            <div className="glass-card p-5 rounded-2xl border border-slate-800">
              <span className="text-xs text-slate-400 uppercase font-semibold">১% দান বরাদ্দ</span>
              <div className="text-2xl font-extrabold text-teal-400 mt-1">
                {formatBDT(data.totalMonthlyDonation, useBengaliDigits)}
              </div>
            </div>

            <div className="glass-card p-5 rounded-2xl border border-slate-800">
              <span className="text-xs text-slate-400 uppercase font-semibold">মোট সঞ্চয়/অবশিষ্ট</span>
              <div className="text-2xl font-extrabold text-sky-400 mt-1">
                {formatBDT(data.totalMonthlySavings, useBengaliDigits)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Category Report */}
      {activeTab === "category" && (
        <div className="glass-card rounded-2xl border border-slate-800 overflow-hidden">
          <div className="p-4 border-b border-slate-800 font-bold text-slate-200 text-sm">
            {BENGALI_MONTHS[data.selectedMonth - 1]} {useBengaliDigits ? toBengaliDigits(data.selectedYear) : data.selectedYear} খরচের খাতভিত্তিক বিবরণ
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400 uppercase tracking-wider bg-slate-900/60">
                  <th className="py-3 px-4">ক্যাটাগরির নাম</th>
                  <th className="py-3 px-4 text-center">লেনদেন সংখ্যা</th>
                  <th className="py-3 px-4 text-right">মোট খরচের পরিমাণ</th>
                  <th className="py-3 px-4 text-right">শতকরা হার (%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {data.categoryReport.map((cat, idx) => {
                  const percentage = data.totalMonthlyExpense > 0
                    ? ((cat.amount / data.totalMonthlyExpense) * 100).toFixed(1)
                    : "0";
                  return (
                    <tr key={idx} className="hover:bg-slate-800/40 transition">
                      <td className="py-3.5 px-4 font-semibold text-slate-100 flex items-center gap-2">
                        <span
                          className="w-3 h-3 rounded-full"
                          style={{ backgroundColor: cat.color }}
                        />
                        <span>{cat.name}</span>
                      </td>
                      <td className="py-3.5 px-4 text-center text-slate-300">
                        {useBengaliDigits ? toBengaliDigits(cat.count) : cat.count}টি
                      </td>
                      <td className="py-3.5 px-4 text-right font-bold text-rose-400">
                        {formatBDT(cat.amount, useBengaliDigits)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-semibold text-sky-400 text-xs">
                        {useBengaliDigits ? toBengaliDigits(percentage) : percentage}%
                      </td>
                    </tr>
                  );
                })}
                {data.categoryReport.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-slate-500 text-xs">
                      কোনো ক্যাটাগরি ডেটা পাওয়া যায়নি
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: Yearly Report */}
      {activeTab === "yearly" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="glass-card p-5 rounded-2xl border border-slate-800">
              <span className="text-xs text-slate-400 uppercase font-semibold">বার্ষিক মোট আয়</span>
              <div className="text-2xl font-extrabold text-emerald-400 mt-1">
                {formatBDT(data.totalYearlyIncome, useBengaliDigits)}
              </div>
            </div>
            <div className="glass-card p-5 rounded-2xl border border-slate-800">
              <span className="text-xs text-slate-400 uppercase font-semibold">বার্ষিক মোট খরচ</span>
              <div className="text-2xl font-extrabold text-rose-400 mt-1">
                {formatBDT(data.totalYearlyExpense, useBengaliDigits)}
              </div>
            </div>
            <div className="glass-card p-5 rounded-2xl border border-slate-800">
              <span className="text-xs text-slate-400 uppercase font-semibold">বার্ষিক ১% দান</span>
              <div className="text-2xl font-extrabold text-teal-400 mt-1">
                {formatBDT(data.totalYearlyDonation, useBengaliDigits)}
              </div>
            </div>
            <div className="glass-card p-5 rounded-2xl border border-slate-800">
              <span className="text-xs text-slate-400 uppercase font-semibold">বার্ষিক সঞ্চয়</span>
              <div className="text-2xl font-extrabold text-sky-400 mt-1">
                {formatBDT(data.totalYearlySavings, useBengaliDigits)}
              </div>
            </div>
          </div>

          <div className="glass-card rounded-2xl border border-slate-800 overflow-hidden">
            <div className="p-4 border-b border-slate-800 font-bold text-slate-200 text-sm">
              {useBengaliDigits ? toBengaliDigits(data.selectedYear) : data.selectedYear} সালের মাসভিত্তিক হিসাব
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-xs text-slate-400 uppercase tracking-wider bg-slate-900/60">
                    <th className="py-3 px-4">মাস</th>
                    <th className="py-3 px-4 text-right">আয়</th>
                    <th className="py-3 px-4 text-right">খরচ</th>
                    <th className="py-3 px-4 text-right">১% দান</th>
                    <th className="py-3 px-4 text-right">সঞ্চয় / অবশিষ্ট</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {data.yearlyMonthsData.map((m, idx) => (
                    <tr key={idx} className="hover:bg-slate-800/40 transition">
                      <td className="py-3.5 px-4 font-semibold text-slate-100">
                        {m.monthName}
                      </td>
                      <td className="py-3.5 px-4 text-right font-medium text-emerald-400">
                        {formatBDT(m.income, useBengaliDigits)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-medium text-rose-400">
                        {formatBDT(m.expense, useBengaliDigits)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-medium text-teal-400">
                        {formatBDT(m.donation, useBengaliDigits)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-bold text-sky-400">
                        {formatBDT(m.savings, useBengaliDigits)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
