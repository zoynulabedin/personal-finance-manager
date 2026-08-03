import { useState } from "react";
import { Form, useLoaderData, useOutletContext, useNavigation, redirect } from "react-router";
import type { Route } from "./+types/expenses";
import { prisma } from "../lib/db.server";
import { requireUserId } from "../lib/auth.server";
import type { LayoutContextType } from "./layout";
import { formatBDT, toBengaliDigits, formatBengaliDate } from "../utils/bengali";
import {
  Plus,
  Trash2,
  Edit,
  Receipt,
  Search,
  Filter,
  X,
  CreditCard,
  Banknote,
  Calendar,
} from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);
  const filterPreset = url.searchParams.get("preset") || "this_month";
  const search = url.searchParams.get("search") || "";
  const categoryId = url.searchParams.get("categoryId") || "";
  const paymentMethod = url.searchParams.get("paymentMethod") || "";
  const actionParam = url.searchParams.get("action") || "";

  const now = new Date();
  let startDate: Date | undefined;
  let endDate: Date | undefined;

  if (filterPreset === "today") {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  } else if (filterPreset === "yesterday") {
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    startDate = new Date(yest.getFullYear(), yest.getMonth(), yest.getDate());
    endDate = new Date(yest.getFullYear(), yest.getMonth(), yest.getDate(), 23, 59, 59);
  } else if (filterPreset === "last_7_days") {
    const past7 = new Date(now);
    past7.setDate(now.getDate() - 7);
    startDate = past7;
    endDate = now;
  } else if (filterPreset === "this_month") {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  } else if (filterPreset === "last_month") {
    startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  } else if (filterPreset === "this_year") {
    startDate = new Date(now.getFullYear(), 0, 1);
    endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
  }

  const whereClause: any = { userId };
  if (startDate && endDate) {
    whereClause.date = { gte: startDate, lte: endDate };
  }
  if (categoryId) {
    whereClause.categoryId = categoryId;
  }
  if (paymentMethod) {
    whereClause.paymentMethod = paymentMethod;
  }
  if (search) {
    whereClause.OR = [
      { title: { contains: search } },
      { note: { contains: search } },
    ];
  }

  const expenses = await prisma.expense.findMany({
    where: whereClause,
    include: { category: true, bankAccount: true },
    orderBy: { date: "desc" },
  });

  const categories = await prisma.category.findMany({
    where: { OR: [{ userId }, { userId: null }] },
    orderBy: { name: "asc" },
  });
  const bankAccounts = await prisma.bankAccount.findMany({
    where: { userId },
    orderBy: { bankName: "asc" },
  });

  const totalExpense = expenses.reduce((sum, e) => sum + e.amount, 0);

  return {
    expenses,
    totalExpense,
    categories,
    bankAccounts,
    filterPreset,
    search,
    categoryId,
    paymentMethod,
    autoOpenNew: actionParam === "new",
  };
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("_intent")?.toString();

  if (intent === "create") {
    const title = formData.get("title")?.toString().trim();
    const amount = parseFloat(formData.get("amount")?.toString() || "0");
    const categoryId = formData.get("categoryId")?.toString();
    const paymentMethod = formData.get("paymentMethod")?.toString() || "Cash";
    const bankAccountId = formData.get("bankAccountId")?.toString() || null;
    const dateInput = formData.get("date")?.toString();
    const note = formData.get("note")?.toString().trim();
    const deductBalance = formData.get("deductBalance") === "true";

    if (!title || !categoryId || amount <= 0) {
      return { error: "শিরোনাম, পরিমাণ এবং ক্যাটাগরি আবশ্যক।" };
    }

    const expenseDate = dateInput ? new Date(dateInput) : new Date();

    // 1. Create Expense with userId
    await prisma.expense.create({
      data: {
        userId,
        title,
        amount,
        categoryId,
        paymentMethod,
        bankAccountId: bankAccountId || undefined,
        date: expenseDate,
        note,
      },
    });

    // 2. Optionally deduct from user-owned Bank/Cash Balance
    if (deductBalance && bankAccountId) {
      const bank = await prisma.bankAccount.findFirst({ where: { id: bankAccountId, userId } });
      if (bank) {
        await prisma.bankAccount.update({
          where: { id: bankAccountId },
          data: { currentBalance: bank.currentBalance - amount },
        });
      }
    }

    return redirect("/expenses");
  }

  if (intent === "delete") {
    const id = formData.get("id")?.toString();
    if (id) {
      await prisma.expense.deleteMany({ where: { id, userId } });
    }
    return { success: true };
  }

  if (intent === "update") {
    const id = formData.get("id")?.toString();
    const title = formData.get("title")?.toString().trim();
    const amount = parseFloat(formData.get("amount")?.toString() || "0");
    const categoryId = formData.get("categoryId")?.toString();
    const paymentMethod = formData.get("paymentMethod")?.toString() || "Cash";
    const bankAccountId = formData.get("bankAccountId")?.toString() || null;
    const dateInput = formData.get("date")?.toString();
    const note = formData.get("note")?.toString().trim();

    if (id && title && categoryId && amount > 0) {
      await prisma.expense.updateMany({
        where: { id, userId },
        data: {
          title,
          amount,
          categoryId,
          paymentMethod,
          bankAccountId: bankAccountId || null,
          date: dateInput ? new Date(dateInput) : new Date(),
          note,
        },
      });
    }
    return redirect("/expenses");
  }

  return null;
}

export default function ExpensesPage() {
  const { useBengaliDigits } = useOutletContext<LayoutContextType>();
  const {
    expenses,
    totalExpense,
    categories,
    bankAccounts,
    filterPreset,
    search,
    categoryId,
    paymentMethod,
    autoOpenNew,
  } = useLoaderData<typeof loader>();

  const [isAddOpen, setIsAddOpen] = useState(autoOpenNew);
  const [editItem, setEditItem] = useState<any>(null);

  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [selectedCatId, setSelectedCatId] = useState(categories[0]?.id || "");
  const [method, setMethod] = useState("Cash");
  const [bankId, setBankId] = useState("");
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().split("T")[0]);
  const [note, setNote] = useState("");
  const [deductBalance, setDeductBalance] = useState(true);

  const paymentMethods = ["Cash", "Bank", "bKash", "Nagad", "Rocket"];

  return (
    <div className="space-y-6">
      {/* Top Banner & Header */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Receipt className="w-6 h-6 text-rose-400" />
            <span>দৈনন্দিন খরচ (Expense Tracker)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            প্রতিদিনের সমস্ত খরচের তালিকা ও ফিল্টারিং ব্যবস্থা
          </p>
        </div>

        <button
          onClick={() => {
            setTitle("");
            setAmount("");
            setNote("");
            setExpenseDate(new Date().toISOString().split("T")[0]);
            setIsAddOpen(true);
          }}
          className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-medium text-xs sm:text-sm flex items-center gap-2 shadow-md shadow-rose-950/40"
        >
          <Plus className="w-4 h-4" />
          <span>নতুন খরচ যোগ করুন</span>
        </button>
      </div>

      {/* Filter Bar */}
      <div className="glass-card p-4 rounded-2xl border border-slate-800 space-y-3">
        <Form method="get" className="flex flex-wrap items-center gap-3">
          {/* Preset Buttons */}
          <div className="flex flex-wrap items-center gap-1.5 bg-slate-900/80 p-1 rounded-xl border border-slate-800">
            {[
              { id: "today", label: "আজ" },
              { id: "yesterday", label: "গতকাল" },
              { id: "last_7_days", label: "গত ৭ দিন" },
              { id: "this_month", label: "এই মাস" },
              { id: "last_month", label: "গত মাস" },
              { id: "this_year", label: "এই বছর" },
              { id: "all", label: "সকল" },
            ].map((preset) => (
              <button
                key={preset.id}
                type="submit"
                name="preset"
                value={preset.id}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  filterPreset === preset.id
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              name="search"
              defaultValue={search}
              placeholder="খরচ খুঁজুন..."
              className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-emerald-500"
            />
          </div>

          {/* Category Dropdown */}
          <select
            name="categoryId"
            defaultValue={categoryId}
            onChange={(e) => e.target.form?.submit()}
            className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-emerald-500"
          >
            <option value="">সকল ক্যাটাগরি</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          {/* Payment Method Dropdown */}
          <select
            name="paymentMethod"
            defaultValue={paymentMethod}
            onChange={(e) => e.target.form?.submit()}
            className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-emerald-500"
          >
            <option value="">সকল পেমেন্ট মেথড</option>
            {paymentMethods.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Form>
      </div>

      {/* Expenses Summary & Table */}
      <div className="glass-card rounded-2xl border border-slate-800 overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <span className="font-bold text-slate-200 text-sm">
            খরচের হিসাব ({useBengaliDigits ? toBengaliDigits(expenses.length) : expenses.length}টি তালিকাভুক্ত)
          </span>
          <div className="text-right">
            <span className="text-xs text-slate-400">মোট খরচ: </span>
            <strong className="text-lg text-rose-400 font-extrabold ml-1">
              {formatBDT(totalExpense, useBengaliDigits)}
            </strong>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400 uppercase tracking-wider bg-slate-900/60">
                <th className="py-3 px-4">তারিখ</th>
                <th className="py-3 px-4">বিবরণ</th>
                <th className="py-3 px-4">ক্যাটাগরি</th>
                <th className="py-3 px-4">পেমেন্ট মেথড</th>
                <th className="py-3 px-4 text-right">পরিমাণ</th>
                <th className="py-3 px-4 text-center">অ্যাকশন</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {expenses.map((item) => (
                <tr key={item.id} className="hover:bg-slate-800/40 transition">
                  <td className="py-3.5 px-4 text-xs text-slate-300 font-medium whitespace-nowrap">
                    {formatBengaliDate(item.date, useBengaliDigits)}
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="font-semibold text-slate-100">{item.title}</div>
                    {item.note && (
                      <div className="text-xs text-slate-400 mt-0.5">{item.note}</div>
                    )}
                  </td>
                  <td className="py-3.5 px-4">
                    <span className="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-200 text-xs border border-slate-700">
                      {item.category.name}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-xs text-slate-300">
                    <span className="font-medium">{item.paymentMethod}</span>
                    {item.bankAccount && (
                      <span className="text-slate-400 text-[11px] block">
                        ({item.bankAccount.bankName})
                      </span>
                    )}
                  </td>
                  <td className="py-3.5 px-4 text-right font-bold text-rose-400">
                    {formatBDT(item.amount, useBengaliDigits)}
                  </td>
                  <td className="py-3.5 px-4 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => {
                          setEditItem(item);
                          setTitle(item.title);
                          setAmount(String(item.amount));
                          setSelectedCatId(item.categoryId);
                          setMethod(item.paymentMethod);
                          setBankId(item.bankAccountId || "");
                          setExpenseDate(new Date(item.date).toISOString().split("T")[0]);
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
              {expenses.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500 text-xs">
                    কোনো খরচের হিসাব পাওয়া যায়নি
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
          <div className="glass-panel w-full max-w-md p-6 rounded-2xl border border-slate-800 shadow-2xl relative max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-slate-100">
                {editItem ? "খরচ সম্পাদনা করুন" : "নতুন খরচ যোগ করুন"}
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
                  খরচের শিরোনাম / বিবরণ *
                </label>
                <input
                  type="text"
                  name="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  placeholder="যেমন: আজ কাঁচা বাজার, ডাক্তারের ফি"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-rose-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    পরিমাণ (টাকা) *
                  </label>
                  <input
                    type="number"
                    name="amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                    step="any"
                    placeholder="0.00"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-rose-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    তারিখ *
                  </label>
                  <input
                    type="date"
                    name="date"
                    value={expenseDate}
                    onChange={(e) => setExpenseDate(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-rose-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  ক্যাটাগরি *
                </label>
                <select
                  name="categoryId"
                  value={selectedCatId}
                  onChange={(e) => setSelectedCatId(e.target.value)}
                  required
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-rose-500"
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    পেমেন্ট মেথড
                  </label>
                  <select
                    name="paymentMethod"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-rose-500"
                  >
                    {paymentMethods.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    ব্যাংক/ওয়ালেট একাউন্ট
                  </label>
                  <select
                    name="bankAccountId"
                    value={bankId}
                    onChange={(e) => setBankId(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-rose-500"
                  >
                    <option value="">নির্বাচন করুন (ঐচ্ছিক)</option>
                    {bankAccounts.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.bankName} ({formatBDT(b.currentBalance, useBengaliDigits)})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {!editItem && bankId && (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    id="deductBalance"
                    name="deductBalance"
                    value="true"
                    checked={deductBalance}
                    onChange={(e) => setDeductBalance(e.target.checked)}
                    className="rounded text-rose-500 focus:ring-rose-500 bg-slate-800 border-slate-700"
                  />
                  <label htmlFor="deductBalance" className="cursor-pointer">
                    ব্যাংক/ওয়ালেট ব্যালেন্স থেকে সরাসরি টাকা কেটে নিন
                  </label>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  নোট (ঐচ্ছিক)
                </label>
                <input
                  type="text"
                  name="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="অতিরিক্ত কোনো তথ্য..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-rose-500"
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
                  className="w-1/2 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-sm shadow-md"
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
