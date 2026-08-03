import { useState } from "react";
import {
  Form,
  Link,
  useLoaderData,
  useOutletContext,
  useActionData,
  redirect,
} from "react-router";
import type { Route } from "./+types/bills";
import { prisma } from "../lib/db.server";
import { requireUserId } from "../lib/auth.server";
import {
  assertOwnedAccount,
  debit,
  reverseLedgerFor,
} from "../lib/ledger.server";
import {
  monthRange,
  parseAmount,
  parsePaymentMethod,
  parseDateInput,
  parseMonthParam,
  parseOptionalText,
  parseText,
  parseYearParam,
  roundMoney,
  selectableYears,
} from "../lib/validation.server";
import type { LayoutContextType } from "./layout";
import { formatBDT, BENGALI_MONTHS, toBengaliDigits, formatBengaliDate } from "../utils/bengali";
import { toDateInputValue, todayInputValue } from "../utils/date";
import { PAYMENT_METHODS } from "../utils/constants";
import { CreditCard, Plus, CheckCircle2, Clock, Trash2, Edit, X } from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);

  const selectedMonth = parseMonthParam(url.searchParams.get("month"));
  const selectedYear = parseYearParam(url.searchParams.get("year"));
  const showAll = url.searchParams.get("scope") === "all";

  const range = monthRange(selectedYear, selectedMonth);

  const [bills, categories, bankAccounts] = await Promise.all([
    prisma.bill.findMany({
      where: showAll
        ? { userId }
        : { userId, dueDate: { gte: range.start, lte: range.end } },
      include: { expense: { include: { bankAccount: true, category: true } } },
      orderBy: [{ paid: "asc" }, { dueDate: "asc" }],
    }),
    prisma.category.findMany({
      where: { OR: [{ userId }, { userId: null }] },
      orderBy: { name: "asc" },
    }),
    prisma.bankAccount.findMany({
      where: { userId },
      orderBy: [{ isCash: "asc" }, { bankName: "asc" }],
    }),
  ]);

  const totalAmount = roundMoney(bills.reduce((sum, b) => sum + b.amount, 0));
  const paidAmount = roundMoney(
    bills.filter((b) => b.paid).reduce((sum, b) => sum + b.amount, 0)
  );
  const pendingAmount = roundMoney(
    bills.filter((b) => !b.paid).reduce((sum, b) => sum + b.amount, 0)
  );

  return {
    bills,
    categories,
    bankAccounts,
    totalAmount,
    paidAmount,
    pendingAmount,
    selectedMonth,
    selectedYear,
    showAll,
    years: selectableYears(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("_intent")?.toString();

  if (intent === "create") {
    const title = parseText(formData.get("title"));
    const amount = parseAmount(formData.get("amount"));
    const dueDate = parseDateInput(formData.get("dueDate"));
    const note = parseOptionalText(formData.get("note"));

    if (!title || amount === null) {
      return { error: "শিরোনাম এবং সঠিক বিলের পরিমাণ আবশ্যক।" };
    }
    if (!dueDate) {
      return { error: "সঠিক শেষ তারিখ নির্বাচন করুন।" };
    }

    await prisma.bill.create({
      data: { userId, title, amount, dueDate, paid: false, note },
    });

    return redirect("/bills");
  }

  /**
   * Paying a bill is a real payment now.
   *
   * A paid bill *is* an expense, so one is created and linked, and the money
   * leaves the chosen account through the ledger. Previously this flipped a
   * boolean and nothing else — the balance never moved and the spend never
   * appeared in any report.
   */
  if (intent === "pay_bill") {
    const id = formData.get("id")?.toString();
    const accountId = formData.get("bankAccountId")?.toString() || null;
    const categoryId = formData.get("categoryId")?.toString() || null;
    const paidDate = parseDateInput(formData.get("paidDate")) ?? new Date();

    if (!id) return { error: "অবৈধ অনুরোধ।" };
    if (!accountId) return { error: "কোন অ্যাকাউন্ট থেকে পরিশোধ করবেন তা নির্বাচন করুন।" };
    if (!categoryId) return { error: "খরচের ক্যাটাগরি নির্বাচন করুন।" };

    const result = await prisma.$transaction(async (tx) => {
      const bill = await tx.bill.findFirst({ where: { id, userId } });
      if (!bill) return { error: "বিলটি পাওয়া যায়নি।" };
      if (bill.paid) return { error: "এই বিলটি ইতোমধ্যে পরিশোধিত।" };

      const bankAccountId = await assertOwnedAccount(tx, userId, accountId);
      if (!bankAccountId) return { error: "নির্বাচিত অ্যাকাউন্টটি বৈধ নয়।" };

      const category = await tx.category.findFirst({
        where: { id: categoryId, OR: [{ userId }, { userId: null }] },
        select: { id: true },
      });
      if (!category) return { error: "নির্বাচিত ক্যাটাগরিটি বৈধ নয়।" };

      const expense = await tx.expense.create({
        data: {
          userId,
          title: bill.title,
          amount: bill.amount,
          categoryId: category.id,
          paymentMethod: parsePaymentMethod(formData.get("paymentMethod")),
          bankAccountId,
          date: paidDate,
          note: bill.note,
        },
      });

      await debit(tx, {
        userId,
        bankAccountId,
        amount: bill.amount,
        type: "EXPENSE",
        description: `বিল পরিশোধ: ${bill.title}`,
        occurredAt: paidDate,
        source: { expenseId: expense.id },
      });

      const marked = await tx.bill.updateMany({
        where: { id: bill.id, paid: false },
        data: { paid: true, paidDate, expenseId: expense.id },
      });
      if (marked.count === 0) {
        // Lost a race with another submit — abort so nothing is double-paid.
        throw new Error("BILL_ALREADY_PAID");
      }

      return { ok: true as const };
    });

    if ("error" in result) return result;
    return redirect("/bills");
  }

  if (intent === "unpay_bill") {
    const id = formData.get("id")?.toString();
    if (!id) return { error: "অবৈধ অনুরোধ।" };

    const result = await prisma.$transaction(async (tx) => {
      const bill = await tx.bill.findFirst({ where: { id, userId } });
      if (!bill) return { error: "বিলটি পাওয়া যায়নি।" };
      if (!bill.paid) return { error: "এই বিলটি এখনও পরিশোধিত হয়নি।" };

      if (bill.expenseId) {
        // Refund the account, then remove the expense the payment created.
        await reverseLedgerFor(
          tx,
          userId,
          { expenseId: bill.expenseId },
          `বিল পরিশোধ বাতিল: ${bill.title}`
        );
        await tx.bill.update({
          where: { id: bill.id },
          data: { paid: false, paidDate: null, expenseId: null },
        });
        await tx.expense.deleteMany({ where: { id: bill.expenseId, userId } });
      } else {
        await tx.bill.update({
          where: { id: bill.id },
          data: { paid: false, paidDate: null },
        });
      }

      return { ok: true as const };
    });

    if ("error" in result) return result;
    return redirect("/bills");
  }

  if (intent === "delete") {
    const id = formData.get("id")?.toString();
    if (!id) return { error: "অবৈধ অনুরোধ।" };

    const result = await prisma.$transaction(async (tx) => {
      const bill = await tx.bill.findFirst({ where: { id, userId } });
      if (!bill) return { ok: true as const };

      if (bill.paid) {
        return {
          error:
            "পরিশোধিত বিল সরাসরি মুছে ফেলা যায় না। আগে পরিশোধ বাতিল করুন, তারপর মুছুন।",
        };
      }

      await tx.bill.delete({ where: { id: bill.id } });
      return { ok: true as const };
    });

    if ("error" in result) return result;
    return redirect("/bills");
  }

  if (intent === "update") {
    const id = formData.get("id")?.toString();
    const title = parseText(formData.get("title"));
    const amount = parseAmount(formData.get("amount"));
    const dueDate = parseDateInput(formData.get("dueDate"));
    const note = parseOptionalText(formData.get("note"));

    if (!id) return { error: "অবৈধ অনুরোধ।" };
    if (!title || amount === null) {
      return { error: "শিরোনাম এবং সঠিক বিলের পরিমাণ আবশ্যক।" };
    }
    if (!dueDate) {
      return { error: "সঠিক শেষ তারিখ নির্বাচন করুন।" };
    }

    const bill = await prisma.bill.findFirst({
      where: { id, userId },
      select: { id: true, paid: true },
    });
    if (!bill) return { error: "বিলটি পাওয়া যায়নি।" };

    // Editing the amount of an already-paid bill would put it out of step with
    // the expense and the ledger entry it produced.
    if (bill.paid) {
      return {
        error: "পরিশোধিত বিল সম্পাদনা করা যায় না। আগে পরিশোধ বাতিল করুন।",
      };
    }

    await prisma.bill.update({
      where: { id: bill.id },
      data: { title, amount, dueDate, note },
    });

    return redirect("/bills");
  }

  return null;
}

export default function BillsPage() {
  const { useBengaliDigits } = useOutletContext<LayoutContextType>();
  const {
    bills,
    categories,
    bankAccounts,
    totalAmount,
    paidAmount,
    pendingAmount,
    selectedMonth,
    selectedYear,
    showAll,
    years,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);

  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(todayInputValue());
  const [note, setNote] = useState("");
  const [payBill, setPayBill] = useState<any>(null);
  const [payAccountId, setPayAccountId] = useState("");
  const [payCategoryId, setPayCategoryId] = useState("");
  const [paidDate, setPaidDate] = useState(todayInputValue());

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <CreditCard className="w-6 h-6 text-amber-400" />
            <span>মাসিক বিল ও ইউটিলিটি (Monthly Bills)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            বাসা ভাড়া, বিদ্যুৎ, পানি, গ্যাস, ইন্টারনেট ও স্কুল ফি ট্র্যাকিং
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
        <Form method="get" className="flex items-center gap-2">
          <input type="hidden" name="scope" value={showAll ? "all" : "month"} />
          <select
            name="month"
            disabled={showAll}
            defaultValue={selectedMonth}
            onChange={(e) => e.target.form?.submit()}
            className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs font-semibold focus:outline-none focus:border-amber-500 disabled:opacity-50"
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
            className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs font-semibold focus:outline-none focus:border-amber-500 disabled:opacity-50"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {useBengaliDigits ? toBengaliDigits(y) : y}
              </option>
            ))}
          </select>
          <Link
            to={
              showAll
                ? `?month=${selectedMonth}&year=${selectedYear}`
                : `?month=${selectedMonth}&year=${selectedYear}&scope=all`
            }
            className={`px-3 py-2 rounded-xl text-xs font-semibold border transition ${
              showAll
                ? "bg-amber-600 text-white border-amber-500"
                : "bg-slate-900 text-slate-300 border-slate-700 hover:text-white"
            }`}
          >
            সব সময়ের
          </Link>
        </Form>

        <button
          onClick={() => {
            setTitle("");
            setAmount("");
            setNote("");
            setDueDate(todayInputValue());
            setIsAddOpen(true);
          }}
          className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-medium text-xs sm:text-sm flex items-center gap-2 shadow-md shadow-amber-950/40"
        >
          <Plus className="w-4 h-4" />
          <span>নতুন বিল যোগ করুন</span>
        </button>
        </div>
      </div>

      {actionData?.error && (
        <div className="p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          {actionData.error}
        </div>
      )}

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="glass-card p-5 rounded-2xl border border-slate-800 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              মোট বিলের পরিমাণ
            </p>
            <h3 className="text-2xl font-extrabold text-slate-100 mt-1">
              {formatBDT(totalAmount, useBengaliDigits)}
            </h3>
          </div>
          <div className="w-10 h-10 rounded-xl bg-slate-800 text-slate-400 flex items-center justify-center font-bold">
            {useBengaliDigits ? toBengaliDigits(bills.length) : bills.length}
          </div>
        </div>

        <div className="glass-card p-5 rounded-2xl border border-slate-800 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              পরিশোধিত বিল
            </p>
            <h3 className="text-2xl font-extrabold text-emerald-400 mt-1">
              {formatBDT(paidAmount, useBengaliDigits)}
            </h3>
          </div>
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5" />
          </div>
        </div>

        <div className="glass-card p-5 rounded-2xl border border-slate-800 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              বকেয়া বিল
            </p>
            <h3 className="text-2xl font-extrabold text-rose-400 mt-1">
              {formatBDT(pendingAmount, useBengaliDigits)}
            </h3>
          </div>
          <div className="w-10 h-10 rounded-xl bg-rose-500/10 text-rose-400 flex items-center justify-center">
            <Clock className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Bills Grid / Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {bills.map((bill) => (
          <div
            key={bill.id}
            className={`glass-card p-5 rounded-2xl border transition-all duration-200 flex flex-col justify-between ${
              bill.paid
                ? "border-emerald-500/30 bg-slate-900/60"
                : "border-rose-500/40 bg-slate-900/90 shadow-lg shadow-rose-950/20"
            }`}
          >
            <div>
              <div className="flex items-start justify-between gap-2 mb-2">
                <h3 className="font-bold text-slate-100 text-base leading-snug">
                  {bill.title}
                </h3>
                <span
                  className={`text-[11px] px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                    bill.paid
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                  }`}
                >
                  {bill.paid ? "পরিশোধিত" : "অপরিশোধিত"}
                </span>
              </div>

              <div className="text-2xl font-extrabold text-slate-100 my-3">
                {formatBDT(bill.amount, useBengaliDigits)}
              </div>

              <div className="text-xs text-slate-400 space-y-1">
                <p className="flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                  <span>শেষ তারিখ: {formatBengaliDate(bill.dueDate, useBengaliDigits)}</span>
                </p>
                {bill.paid && bill.paidDate && (
                  <p className="flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>
                      পরিশোধের তারিখ: {formatBengaliDate(bill.paidDate, useBengaliDigits)}
                    </span>
                  </p>
                )}
                {bill.note && <p className="text-slate-400 pt-1">{bill.note}</p>}
              </div>
            </div>

            <div className="pt-4 mt-4 border-t border-slate-800 flex items-center justify-between">
              {bill.paid ? (
                <Form method="post">
                  <input type="hidden" name="_intent" value="unpay_bill" />
                  <input type="hidden" name="id" value={bill.id} />
                  <button
                    type="submit"
                    className="px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 bg-slate-800 text-slate-300 hover:bg-slate-700"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>পরিশোধ বাতিল</span>
                  </button>
                </Form>
              ) : (
                <button
                  onClick={() => {
                    setPayBill(bill);
                    setPayAccountId(bankAccounts[0]?.id || "");
                    setPayCategoryId(
                      categories.find((c) => c.name.includes("বিল"))?.id ||
                        categories[0]?.id ||
                        ""
                    );
                    setPaidDate(todayInputValue());
                  }}
                  className="px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white shadow-md"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>পে করা হয়েছে</span>
                </button>
              )}

              <div className="flex items-center gap-1">
                <button
                  disabled={bill.paid}
                  onClick={() => {
                    setEditItem(bill);
                    setTitle(bill.title);
                    setAmount(String(bill.amount));
                    setDueDate(toDateInputValue(bill.dueDate));
                    setNote(bill.note || "");
                  }}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-slate-800 disabled:opacity-30"
                  title="সম্পাদনা"
                >
                  <Edit className="w-4 h-4" />
                </button>
                <Form method="post" onSubmit={(e) => !confirm("মুছে ফেলতে চান?") && e.preventDefault()}>
                  <input type="hidden" name="_intent" value="delete" />
                  <input type="hidden" name="id" value={bill.id} />
                  <button
                    type="submit"
                    disabled={bill.paid}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 disabled:opacity-30"
                    title="মুছে ফেলুন"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </Form>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Bill Payment Modal — a paid bill becomes a real expense */}
      {payBill && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="glass-panel w-full max-w-md p-6 rounded-2xl border border-slate-800 shadow-2xl relative">
            <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                <span>বিল পরিশোধ করুন</span>
              </h3>
              <button
                onClick={() => setPayBill(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <Form
              method="post"
              onSubmit={() => setPayBill(null)}
              className="space-y-4"
            >
              <input type="hidden" name="_intent" value="pay_bill" />
              <input type="hidden" name="id" value={payBill.id} />

              <div className="p-3.5 rounded-xl bg-slate-900 border border-slate-800 space-y-1">
                <p className="text-xs text-slate-400">
                  বিল: <strong className="text-slate-200">{payBill.title}</strong>
                </p>
                <p className="text-sm font-bold text-amber-400">
                  পরিমাণ: {formatBDT(payBill.amount, useBengaliDigits)}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  কোন অ্যাকাউন্ট থেকে পরিশোধ *
                </label>
                <select
                  name="bankAccountId"
                  value={payAccountId}
                  onChange={(e) => setPayAccountId(e.target.value)}
                  required
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500"
                >
                  {bankAccounts.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.bankName} ({b.accountName}) —{" "}
                      {formatBDT(b.currentBalance, useBengaliDigits)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    খরচের ক্যাটাগরি *
                  </label>
                  <select
                    name="categoryId"
                    value={payCategoryId}
                    onChange={(e) => setPayCategoryId(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    পরিশোধের তারিখ *
                  </label>
                  <input
                    type="date"
                    name="paidDate"
                    value={paidDate}
                    onChange={(e) => setPaidDate(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  পেমেন্ট মেথড
                </label>
                <select
                  name="paymentMethod"
                  defaultValue="Bank"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500"
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300">
                এই বিলটি একটি খরচ হিসেবে যুক্ত হবে এবং নির্বাচিত অ্যাকাউন্ট থেকে
                টাকা কেটে নেওয়া হবে।
              </div>

              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setPayBill(null)}
                  className="w-1/2 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-sm"
                >
                  বাতিল
                </button>
                <button
                  type="submit"
                  className="w-1/2 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm shadow-md"
                >
                  পরিশোধ নিশ্চিত করুন
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Add / Edit Modal */}
      {(isAddOpen || editItem) && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="glass-panel w-full max-w-md p-6 rounded-2xl border border-slate-800 shadow-2xl relative">
            <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-slate-100">
                {editItem ? "বিল সম্পাদনা করুন" : "নতুন বিল যোগ করুন"}
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
                  বিলের শিরোনাম / বিবরণ *
                </label>
                <input
                  type="text"
                  name="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  placeholder="যেমন: বাসা ভাড়া, বিদ্যুৎ বিল, ইন্টারনেট"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-amber-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    বিলের পরিমাণ (টাকা) *
                  </label>
                  <input
                    type="number"
                    name="amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                    step="any"
                    placeholder="0.00"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    পরিশোধের শেষ তারিখ *
                  </label>
                  <input
                    type="date"
                    name="dueDate"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-amber-500"
                  />
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
                  placeholder="অতিরিক্ত কোনো নোট..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-amber-500"
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
                  className="w-1/2 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold text-sm shadow-md"
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
