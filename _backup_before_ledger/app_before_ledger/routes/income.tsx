import { useState } from "react";
import { Form, useLoaderData, useOutletContext, useActionData, redirect } from "react-router";
import type { Route } from "./+types/income";
import { prisma } from "../lib/db.server";
import { requireUserId } from "../lib/auth.server";
import {
  parseAmount,
  parseMonthParam,
  parseOptionalText,
  parseText,
  parseYearParam,
  roundMoney,
  selectableYears,
} from "../lib/validation.server";
import type { LayoutContextType } from "./layout";
import { formatBDT, BENGALI_MONTHS, toBengaliDigits } from "../utils/bengali";
import { Plus, Trash2, Edit, Wallet, HeartHandshake, X } from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);
  // Bounded parsing: `?month=abc` used to become NaN and reach Prisma, and
  // `?month=99` rendered an undefined month name.
  const selectedMonth = parseMonthParam(url.searchParams.get("month"));
  const selectedYear = parseYearParam(url.searchParams.get("year"));

  const incomes = await prisma.income.findMany({
    where: { userId, month: selectedMonth, year: selectedYear },
    include: { donations: true },
    orderBy: { createdAt: "desc" },
  });

  const totalIncome = roundMoney(
    incomes.reduce((sum, item) => sum + item.amount, 0)
  );
  const totalDonation = roundMoney(
    incomes.reduce(
      (sum, item) => sum + item.donations.reduce((s, d) => s + d.amount, 0),
      0
    )
  );

  return {
    incomes,
    totalIncome,
    totalDonation,
    selectedMonth,
    selectedYear,
    years: selectableYears(),
    donationWasReset: url.searchParams.get("donationReset") === "1",
  };
}

const DEFAULT_DONATION_PERCENTAGE = 1.0;

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("_intent")?.toString();

  if (intent === "create") {
    const title = parseText(formData.get("title"));
    const amount = parseAmount(formData.get("amount"));
    const month = parseMonthParam(formData.get("month")?.toString());
    const year = parseYearParam(formData.get("year")?.toString());
    const note = parseOptionalText(formData.get("note"));

    if (!title || amount === null) {
      return { error: "সঠিক শিরোনাম এবং পরিমাণ প্রদান করুন।" };
    }

    await prisma.income.create({
      data: {
        userId,
        title,
        amount,
        month,
        year,
        note,
        donations: {
          create: {
            percentage: DEFAULT_DONATION_PERCENTAGE,
            amount: roundMoney(amount * (DEFAULT_DONATION_PERCENTAGE / 100)),
            paid: false,
          },
        },
      },
    });

    return redirect(`/income?month=${month}&year=${year}`);
  }

  if (intent === "delete") {
    const id = formData.get("id")?.toString();
    if (!id) return { error: "অবৈধ অনুরোধ।" };

    await prisma.$transaction(async (tx) => {
      const income = await tx.income.findFirst({
        where: { id, userId },
        include: { donations: true },
      });
      if (!income) return;

      // Donations cascade away with the income. Any that were already paid
      // had money taken out of an account, so give it back first — otherwise
      // the deduction survives with nothing left to explain it.
      for (const donation of income.donations) {
        if (donation.paid && donation.bankAccountId) {
          await tx.bankAccount.updateMany({
            where: { id: donation.bankAccountId, userId },
            data: { currentBalance: { increment: donation.amount } },
          });
        }
      }

      await tx.income.delete({ where: { id: income.id } });
    });

    return { success: true };
  }

  if (intent === "update") {
    const id = formData.get("id")?.toString();
    const title = parseText(formData.get("title"));
    const amount = parseAmount(formData.get("amount"));
    const month = parseMonthParam(formData.get("month")?.toString());
    const year = parseYearParam(formData.get("year")?.toString());
    const note = parseOptionalText(formData.get("note"));

    if (!id) return { error: "অবৈধ অনুরোধ।" };
    if (!title || amount === null) {
      return { error: "সঠিক শিরোনাম এবং পরিমাণ প্রদান করুন।" };
    }

    const donationWasReset = await prisma.$transaction(async (tx) => {
      const income = await tx.income.findFirst({
        where: { id, userId },
        include: { donations: { orderBy: { createdAt: "asc" } } },
      });
      if (!income) return false;

      await tx.income.update({
        where: { id: income.id },
        data: { title, amount, month, year, note },
      });

      let reset = false;

      for (const donation of income.donations) {
        const newAmount = roundMoney(amount * (donation.percentage / 100));
        if (newAmount === donation.amount) continue;

        if (donation.paid) {
          // The old amount was already transferred out. Refund it, then put
          // the donation back to unpaid at the corrected figure so the user
          // pays the real number. Previously the row was silently rewritten
          // and the account was left short (or over) by the difference.
          if (donation.bankAccountId) {
            await tx.bankAccount.updateMany({
              where: { id: donation.bankAccountId, userId },
              data: { currentBalance: { increment: donation.amount } },
            });
          }
          await tx.donation.update({
            where: { id: donation.id },
            data: {
              amount: newAmount,
              paid: false,
              paidDate: null,
              bankAccountId: null,
            },
          });
          reset = true;
        } else {
          await tx.donation.update({
            where: { id: donation.id },
            data: { amount: newAmount },
          });
        }
      }

      // Income created before this field existed may have no donation row.
      if (income.donations.length === 0) {
        await tx.donation.create({
          data: {
            incomeId: income.id,
            percentage: DEFAULT_DONATION_PERCENTAGE,
            amount: roundMoney(amount * (DEFAULT_DONATION_PERCENTAGE / 100)),
            paid: false,
          },
        });
      }

      return reset;
    });

    const params = new URLSearchParams({
      month: String(month),
      year: String(year),
    });
    if (donationWasReset) params.set("donationReset", "1");

    return redirect(`/income?${params.toString()}`);
  }

  return null;
}

export default function IncomePage() {
  const { useBengaliDigits } = useOutletContext<LayoutContextType>();
  const {
    incomes,
    totalIncome,
    totalDonation,
    selectedMonth,
    selectedYear,
    years,
    donationWasReset,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);

  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [month, setMonth] = useState(selectedMonth);
  const [year, setYear] = useState(selectedYear);
  const [note, setNote] = useState("");

  return (
    <div className="space-y-6">
      {donationWasReset && (
        <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs flex items-start gap-3">
          <HeartHandshake className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <strong>দান পুনরায় হিসাব করা হয়েছে:</strong> আয়ের পরিমাণ বদলানোয়
            সংশ্লিষ্ট ১% দান আবার বকেয়া হিসেবে চিহ্নিত হয়েছে এবং আগে কেটে নেওয়া
            টাকা ব্যাংক ব্যালেন্সে ফেরত দেওয়া হয়েছে। সংশোধিত পরিমাণে আবার দান
            সম্পন্ন করুন।
          </div>
        </div>
      )}

      {actionData?.error && (
        <div className="p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          {actionData.error}
        </div>
      )}

      {/* Top Banner & Filter */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Wallet className="w-6 h-6 text-emerald-400" />
            <span>আয় সমাহার (Monthly Income)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            মাসের সমস্ত আয়ের হিসাব এবং ১% দান রসিদ স্বয়ংক্রিয় গণনা
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Month & Year Filter Form */}
          <Form method="get" className="flex items-center gap-2">
            <select
              name="month"
              defaultValue={selectedMonth}
              onChange={(e) => e.target.form?.submit()}
              className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs font-semibold focus:outline-none focus:border-emerald-500"
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
              className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs font-semibold focus:outline-none focus:border-emerald-500"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {useBengaliDigits ? toBengaliDigits(y) : y}
                </option>
              ))}
            </select>
          </Form>

          <button
            onClick={() => {
              setTitle("");
              setAmount("");
              setNote("");
              setIsAddOpen(true);
            }}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs sm:text-sm flex items-center gap-2 shadow-md shadow-emerald-950/40"
          >
            <Plus className="w-4 h-4" />
            <span>নতুন আয় যুক্ত করুন</span>
          </button>
        </div>
      </div>

      {/* Total Income Summary Card */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 bg-gradient-to-r from-slate-900 to-slate-900/90 flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            {BENGALI_MONTHS[selectedMonth - 1]} {useBengaliDigits ? toBengaliDigits(selectedYear) : selectedYear} এর মোট আয়
          </span>
          <div className="text-3xl font-extrabold text-emerald-400 mt-1">
            {formatBDT(totalIncome, useBengaliDigits)}
          </div>
        </div>
        <div className="text-right">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            ১% দান জমা (গড়)
          </span>
          <div className="text-xl font-bold text-teal-400 mt-1 flex items-center justify-end gap-1">
            <HeartHandshake className="w-5 h-5" />
            <span>{formatBDT(totalDonation, useBengaliDigits)}</span>
          </div>
        </div>
      </div>

      {/* Incomes Table */}
      <div className="glass-card rounded-2xl border border-slate-800 overflow-hidden">
        <div className="p-4 border-b border-slate-800 font-bold text-slate-200 text-sm">
          আয়ের তালিকা ({useBengaliDigits ? toBengaliDigits(incomes.length) : incomes.length}টি এন্ট্রি)
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400 uppercase tracking-wider bg-slate-900/60">
                <th className="py-3 px-4">আয়ের বিবরণ</th>
                <th className="py-3 px-4">মাস ও বছর</th>
                <th className="py-3 px-4 text-right">আয়ের পরিমাণ</th>
                <th className="py-3 px-4 text-right">১% দান (Auto)</th>
                <th className="py-3 px-4 text-center">অ্যাকশন</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {incomes.map((item) => (
                <tr key={item.id} className="hover:bg-slate-800/40 transition">
                  <td className="py-3.5 px-4">
                    <div className="font-semibold text-slate-100">{item.title}</div>
                    {item.note && (
                      <div className="text-xs text-slate-400 mt-0.5">{item.note}</div>
                    )}
                  </td>
                  <td className="py-3.5 px-4 text-xs text-slate-300">
                    {BENGALI_MONTHS[item.month - 1]} {useBengaliDigits ? toBengaliDigits(item.year) : item.year}
                  </td>
                  <td className="py-3.5 px-4 text-right font-bold text-emerald-400">
                    {formatBDT(item.amount, useBengaliDigits)}
                  </td>
                  <td className="py-3.5 px-4 text-right font-semibold text-teal-400 text-xs">
                    {formatBDT(
                      item.donations.reduce((s, d) => s + d.amount, 0),
                      useBengaliDigits
                    )}
                  </td>
                  <td className="py-3.5 px-4 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => {
                          setEditItem(item);
                          setTitle(item.title);
                          setAmount(String(item.amount));
                          setMonth(item.month);
                          setYear(item.year);
                          setNote(item.note || "");
                        }}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-slate-800"
                        title="সম্পাদনা"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <Form method="post" onSubmit={(e) => !confirm("মুছে ফেলতে চান?") && e.preventDefault()}>
                        <input type="hidden" name="_intent" value="delete" />
                        <input type="hidden" name="id" value={item.id} />
                        <button
                          type="submit"
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10"
                          title="মুছে ফেলুন"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </Form>
                    </div>
                  </td>
                </tr>
              ))}
              {incomes.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500 text-xs">
                    এই মাসে কোনো আয়ের এন্ট্রি পাওয়া যায়নি
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / Edit Modal */}
      {(isAddOpen || editItem) && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="glass-panel w-full max-w-md p-6 rounded-2xl border border-slate-800 shadow-2xl relative">
            <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-slate-100">
                {editItem ? "আয় সম্পাদনা করুন" : "নতুন আয় যোগ করুন"}
              </h3>
              <button
                onClick={() => {
                  setIsAddOpen(false);
                  setEditItem(null);
                }}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <Form
              method="post"
              onSubmit={() => {
                setIsAddOpen(false);
                setEditItem(null);
              }}
              className="space-y-4"
            >
              <input type="hidden" name="_intent" value={editItem ? "update" : "create"} />
              {editItem && <input type="hidden" name="id" value={editItem.id} />}

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  আয়ের উৎস / বিবরণ *
                </label>
                <input
                  type="text"
                  name="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  placeholder="যেমন: বেতন, ফ্রিল্যান্সিং, ব্যবসা"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  আয়ের পরিমাণ (টাকা) *
                </label>
                <input
                  type="number"
                  name="amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                  step="any"
                  placeholder="0.00"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              {/* Automatic 1% Donation Preview */}
              {parseFloat(amount || "0") > 0 && (
                <div className="p-3 rounded-xl bg-teal-500/10 border border-teal-500/20 text-xs text-teal-300 flex items-center justify-between">
                  <span>স্বয়ংক্রিয় ১% দান হিসাব:</span>
                  <strong className="text-teal-400 font-bold">
                    {formatBDT(parseFloat(amount) * 0.01, useBengaliDigits)}
                  </strong>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    মাস
                  </label>
                  <select
                    name="month"
                    value={month}
                    onChange={(e) => setMonth(parseInt(e.target.value))}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500"
                  >
                    {BENGALI_MONTHS.map((m, idx) => (
                      <option key={idx} value={idx + 1}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    বছর
                  </label>
                  <select
                    name="year"
                    value={year}
                    onChange={(e) => setYear(parseInt(e.target.value))}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500"
                  >
                    {years.map((y) => (
                      <option key={y} value={y}>
                        {useBengaliDigits ? toBengaliDigits(y) : y}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  নোট / মন্তব্য (ঐচ্ছিক)
                </label>
                <input
                  type="text"
                  name="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="অতিরিক্ত তথ্য..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setIsAddOpen(false);
                    setEditItem(null);
                  }}
                  className="w-1/2 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-sm"
                >
                  বাতিল
                </button>
                <button
                  type="submit"
                  className="w-1/2 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm shadow-md"
                >
                  {editItem ? "আপডেট করুন" : "সংরক্ষণ করুন"}
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </div>
  );
}
