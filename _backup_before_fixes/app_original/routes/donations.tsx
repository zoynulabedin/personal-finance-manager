import { useState } from "react";
import { Form, useLoaderData, useOutletContext, redirect } from "react-router";
import type { Route } from "./+types/donations";
import { prisma } from "../lib/db.server";
import { requireUserId } from "../lib/auth.server";
import type { LayoutContextType } from "./layout";
import { formatBDT, toBengaliDigits, formatBengaliDate, BENGALI_MONTHS } from "../utils/bengali";
import { HeartHandshake, CheckCircle2, Clock, Wallet, Info, Landmark, X, ArrowDownRight, Sparkles } from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);

  const now = new Date();
  const selectedMonth = parseInt(url.searchParams.get("month") || String(now.getMonth() + 1));
  const selectedYear = parseInt(url.searchParams.get("year") || String(now.getFullYear()));

  // 1. Total Monthly Incomes (Scoped to userId)
  const monthlyIncomes = await prisma.income.findMany({
    where: { userId, month: selectedMonth, year: selectedYear },
  });
  const totalMonthlyIncome = monthlyIncomes.reduce((sum, item) => sum + item.amount, 0);

  // 2. Total 1% Donation Obligation for Selected Month
  const auto1PercentMonthlyDonation = totalMonthlyIncome * 0.01;

  // 3. All Donations List (Scoped to user via income relation)
  const donations = await prisma.donation.findMany({
    where: { income: { userId } },
    include: { income: true, bankAccount: true },
    orderBy: [{ paid: "asc" }, { createdAt: "desc" }],
  });

  // 4. Available Bank Accounts (Scoped to userId)
  const bankAccounts = await prisma.bankAccount.findMany({
    where: { userId },
    orderBy: { bankName: "asc" },
  });

  const totalAllDonations = donations.reduce((sum, d) => sum + d.amount, 0);
  const paidDonations = donations.filter((d) => d.paid).reduce((sum, d) => sum + d.amount, 0);
  const pendingDonations = donations.filter((d) => !d.paid).reduce((sum, d) => sum + d.amount, 0);

  return {
    donations,
    bankAccounts,
    totalMonthlyIncome,
    auto1PercentMonthlyDonation,
    totalAllDonations,
    paidDonations,
    pendingDonations,
    selectedMonth,
    selectedYear,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("_intent")?.toString();

  if (intent === "pay_donation") {
    const id = formData.get("id")?.toString();
    const bankAccountId = formData.get("bankAccountId")?.toString();

    if (id && bankAccountId) {
      const donation = await prisma.donation.findFirst({
        where: { id, income: { userId } },
      });
      if (donation && !donation.paid) {
        // 1. Mark donation as paid
        await prisma.donation.update({
          where: { id },
          data: {
            paid: true,
            paidDate: new Date(),
            bankAccountId,
          },
        });

        // 2. Deduct donation amount from user's bank account
        const bank = await prisma.bankAccount.findFirst({
          where: { id: bankAccountId, userId },
        });
        if (bank) {
          await prisma.bankAccount.update({
            where: { id: bankAccountId },
            data: {
              currentBalance: bank.currentBalance - donation.amount,
            },
          });
        }
      }
    }
    return redirect("/donations");
  }

  if (intent === "revert_donation") {
    const id = formData.get("id")?.toString();

    if (id) {
      const donation = await prisma.donation.findFirst({
        where: { id, income: { userId } },
      });
      if (donation && donation.paid) {
        // Restore bank balance if a bankAccount was attached
        if (donation.bankAccountId) {
          const bank = await prisma.bankAccount.findFirst({
            where: { id: donation.bankAccountId, userId },
          });
          if (bank) {
            await prisma.bankAccount.update({
              where: { id: donation.bankAccountId },
              data: {
                currentBalance: bank.currentBalance + donation.amount,
              },
            });
          }
        }

        // Unmark donation
        await prisma.donation.update({
          where: { id },
          data: {
            paid: false,
            paidDate: null,
            bankAccountId: null,
          },
        });
      }
    }
    return redirect("/donations");
  }

  return null;
}

export default function DonationsPage() {
  const { useBengaliDigits } = useOutletContext<LayoutContextType>();
  const {
    donations,
    bankAccounts,
    totalMonthlyIncome,
    auto1PercentMonthlyDonation,
    totalAllDonations,
    paidDonations,
    pendingDonations,
    selectedMonth,
    selectedYear,
  } = useLoaderData<typeof loader>();

  const [payModalDonation, setPayModalDonation] = useState<any>(null);
  const [selectedBankId, setSelectedBankId] = useState(bankAccounts[0]?.id || "");

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <HeartHandshake className="w-6 h-6 text-teal-400" />
            <span>১% দান ম্যানেজমেন্ট (Donation Tracker)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            মোট আয় থেকে স্বয়ংক্রিয় ১% দান হিসাব এবং হস্তান্তরের সাথে সাথে ব্যাংকের মোট ব্যালেন্স থেকে কর্তন
          </p>
        </div>

        {/* Month & Year Filter */}
        <Form method="get" className="flex items-center gap-2">
          <select
            name="month"
            defaultValue={selectedMonth}
            onChange={(e) => e.target.form?.submit()}
            className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs font-semibold focus:outline-none focus:border-teal-500"
          >
            {BENGALI_MONTHS.map((m, idx) => (
              <option key={idx} value={idx + 1}>
                {m}
              </option>
            ))}
          </select>
          <select
            name="year"
            defaultValue={selectedYear}
            onChange={(e) => e.target.form?.submit()}
            className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs font-semibold focus:outline-none focus:border-teal-500"
          >
            {[2025, 2026, 2027].map((y) => (
              <option key={y} value={y}>
                {useBengaliDigits ? toBengaliDigits(y) : y}
              </option>
            ))}
          </select>
        </Form>
      </div>

      {/* Auto 1% Calculation Summary Card */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 bg-gradient-to-r from-teal-950/40 via-slate-900 to-slate-900 grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-teal-400 uppercase tracking-wider mb-1">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span>স্বয়ংক্রিয় ১% দান ক্যালকুলেশন ({BENGALI_MONTHS[selectedMonth - 1]})</span>
          </div>
          <h3 className="text-3xl font-extrabold text-slate-100">
            {formatBDT(auto1PercentMonthlyDonation, useBengaliDigits)}
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            মোট মাসিক আয় {formatBDT(totalMonthlyIncome, useBengaliDigits)} এর ১% সমপরিমাণ
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4 border-t md:border-t-0 md:border-l border-slate-800 pt-4 md:pt-0 md:pl-6">
          <div>
            <span className="text-[11px] font-medium text-slate-400 uppercase">পরিশোধিত দান</span>
            <div className="text-xl font-extrabold text-emerald-400 mt-0.5">
              {formatBDT(paidDonations, useBengaliDigits)}
            </div>
          </div>
          <div>
            <span className="text-[11px] font-medium text-slate-400 uppercase">বকেয়া দান</span>
            <div className="text-xl font-extrabold text-amber-400 mt-0.5">
              {formatBDT(pendingDonations, useBengaliDigits)}
            </div>
          </div>
        </div>
      </div>

      {/* Rule Notice */}
      <div className="p-4 rounded-2xl bg-teal-500/10 border border-teal-500/20 text-xs text-teal-300 flex items-start gap-3">
        <Info className="w-5 h-5 text-teal-400 shrink-0 mt-0.5" />
        <div>
          <strong>ব্যালেন্স কর্তন নিয়ম:</strong> আপনি যখনই <strong>"দান সম্পন্ন করুন"</strong> বাটনে ক্লিক করে নির্দিষ্ট ব্যাংক/ওয়ালেট (যেমন Cash, bKash, DBBL) থেকে টাকা দান করবেন, সাথে সাথে আপনার মূল <strong>মোট ব্যাংক ব্যালেন্স থেকে ১% দানের পরিমাণ মাইনাস</strong> হয়ে যাবে।
        </div>
      </div>

      {/* Donations List */}
      <div className="glass-card rounded-2xl border border-slate-800 overflow-hidden">
        <div className="p-4 border-b border-slate-800 font-bold text-slate-200 text-sm">
          ১% দানের বিস্তারিত তালিকা ({useBengaliDigits ? toBengaliDigits(donations.length) : donations.length}টি রেকর্ড)
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400 uppercase tracking-wider bg-slate-900/60">
                <th className="py-3 px-4">আয়ের বিবরণ (উৎস)</th>
                <th className="py-3 px-4 text-right">মূল আয়</th>
                <th className="py-3 px-4 text-right">১% দান</th>
                <th className="py-3 px-4">পরিশোধের উৎস/একাউন্ট</th>
                <th className="py-3 px-4 text-center">স্ট্যাটাস</th>
                <th className="py-3 px-4 text-center">অ্যাকশন</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {donations.map((d) => (
                <tr key={d.id} className="hover:bg-slate-800/40 transition">
                  <td className="py-3.5 px-4">
                    <div className="font-semibold text-slate-100">{d.income.title}</div>
                    <div className="text-xs text-slate-400">
                      মাস: {BENGALI_MONTHS[d.income.month - 1]} {useBengaliDigits ? toBengaliDigits(d.income.year) : d.income.year}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 text-right font-medium text-slate-300">
                    {formatBDT(d.income.amount, useBengaliDigits)}
                  </td>
                  <td className="py-3.5 px-4 text-right font-extrabold text-teal-400">
                    {formatBDT(d.amount, useBengaliDigits)}
                  </td>
                  <td className="py-3.5 px-4 text-xs text-slate-300">
                    {d.bankAccount ? (
                      <div className="flex items-center gap-1 text-emerald-400">
                        <Landmark className="w-3.5 h-3.5" />
                        <span>{d.bankAccount.bankName}</span>
                      </div>
                    ) : (
                      <span className="text-slate-500">-</span>
                    )}
                  </td>
                  <td className="py-3.5 px-4 text-center">
                    <span
                      className={`text-xs px-2.5 py-1 rounded-full font-bold uppercase tracking-wider ${
                        d.paid
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                          : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                      }`}
                    >
                      {d.paid ? "পরিশোধিত" : "বকেয়া"}
                    </span>
                    {d.paid && d.paidDate && (
                      <span className="text-[10px] text-slate-400 block mt-1">
                        {formatBengaliDate(d.paidDate, useBengaliDigits)}
                      </span>
                    )}
                  </td>
                  <td className="py-3.5 px-4 text-center">
                    {d.paid ? (
                      <Form method="post">
                        <input type="hidden" name="_intent" value="revert_donation" />
                        <input type="hidden" name="id" value={d.id} />
                        <button
                          type="submit"
                          className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
                        >
                          রিস্টোর / বকেয়া করুন
                        </button>
                      </Form>
                    ) : (
                      <button
                        onClick={() => {
                          setPayModalDonation(d);
                          setSelectedBankId(bankAccounts[0]?.id || "");
                        }}
                        className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-teal-600 hover:bg-teal-500 text-white shadow-md transition flex items-center gap-1 mx-auto"
                      >
                        <ArrowDownRight className="w-3.5 h-3.5" />
                        <span>দান সম্পন্ন করুন</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {donations.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500 text-xs">
                    কোনো দানের রেকর্ড পাওয়া যায়নি
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Donation Payment Modal (Select Bank Account to deduct balance) */}
      {payModalDonation && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="glass-panel w-full max-w-md p-6 rounded-2xl border border-slate-800 shadow-2xl relative">
            <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <HeartHandshake className="w-5 h-5 text-teal-400" />
                <span>দান পরিশোধ করুন</span>
              </h3>
              <button
                onClick={() => setPayModalDonation(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <Form
              method="post"
              onSubmit={() => setPayModalDonation(null)}
              className="space-y-4"
            >
              <input type="hidden" name="_intent" value="pay_donation" />
              <input type="hidden" name="id" value={payModalDonation.id} />

              <div className="p-3.5 rounded-xl bg-slate-900 border border-slate-800 space-y-1">
                <p className="text-xs text-slate-400">উৎস: <strong className="text-slate-200">{payModalDonation.income.title}</strong></p>
                <p className="text-sm font-bold text-teal-400">
                  দানের পরিমাণ: {formatBDT(payModalDonation.amount, useBengaliDigits)}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  কোন ব্যাংক/ওয়ালেট একাউন্ট থেকে টাকা মাইনাস হবে? *
                </label>
                <select
                  name="bankAccountId"
                  value={selectedBankId}
                  onChange={(e) => setSelectedBankId(e.target.value)}
                  required
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-teal-500"
                >
                  {bankAccounts.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.bankName} ({b.accountName}) - বর্তমান ব্যালেন্স: {formatBDT(b.currentBalance, useBengaliDigits)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 flex items-center justify-between">
                <span>দান করার পর নতুন ব্যালেন্স:</span>
                <strong className="text-slate-100 font-bold">
                  {(() => {
                    const selectedBank = bankAccounts.find((b) => b.id === selectedBankId);
                    if (!selectedBank) return "-";
                    return formatBDT(selectedBank.currentBalance - payModalDonation.amount, useBengaliDigits);
                  })()}
                </strong>
              </div>

              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setPayModalDonation(null)}
                  className="w-1/2 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-sm"
                >
                  বাতিল
                </button>
                <button
                  type="submit"
                  className="w-1/2 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-semibold text-sm shadow-md"
                >
                  দান নিশ্চিত করুন
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </div>
  );
}
