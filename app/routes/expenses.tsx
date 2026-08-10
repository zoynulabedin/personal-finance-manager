import { useState } from "react";
import {
  Form,
  Link,
  useLoaderData,
  useOutletContext,
  useSearchParams,
  useActionData,
  redirect,
} from "react-router";
import type { Route } from "./+types/expenses";
import { prisma } from "../lib/db.server";
import { requireUserId } from "../lib/auth.server";
import { debit, reverseLedgerFor } from "../lib/ledger.server";
import {
  dayRange,
  monthRange,
  parseAmount,
  parseDateInput,
  parseOptionalText,
  parsePaymentMethod,
  parseText,
  roundMoney,
} from "../lib/validation.server";
import type { LayoutContextType } from "./layout";
import { formatBDT, toBengaliDigits, formatBengaliDate } from "../utils/bengali";
import { toDateInputValue, todayInputValue } from "../utils/date";
import { PAYMENT_METHODS } from "../utils/constants";
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

const FILTER_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "this_month",
  "last_month",
  "this_year",
  "all",
] as const;

type FilterPreset = (typeof FILTER_PRESETS)[number];

function parsePreset(value: string | null): FilterPreset {
  return FILTER_PRESETS.includes(value as FilterPreset)
    ? (value as FilterPreset)
    : "this_month";
}

/**
 * All boundaries are built in local time from date parts, matching how
 * `parseDateInput` stores expense dates. Mixing local boundaries with
 * UTC-parsed dates used to drop entries on either side of a day boundary.
 */
function resolveRange(preset: FilterPreset) {
  const now = new Date();

  if (preset === "today") return dayRange(now);

  if (preset === "yesterday") {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    return dayRange(yesterday);
  }

  if (preset === "last_7_days") {
    const from = new Date(now);
    from.setDate(now.getDate() - 6); // 7 calendar days, today included
    return { start: dayRange(from).start, end: dayRange(now).end };
  }

  if (preset === "this_month") {
    return monthRange(now.getFullYear(), now.getMonth() + 1);
  }

  if (preset === "last_month") {
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return monthRange(prev.getFullYear(), prev.getMonth() + 1);
  }

  if (preset === "this_year") {
    return {
      start: new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0),
      end: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
    };
  }

  return null; // "all"
}

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);
  const filterPreset = parsePreset(url.searchParams.get("preset"));
  const search = url.searchParams.get("search") || "";
  const categoryId = url.searchParams.get("categoryId") || "";
  const paymentMethod = url.searchParams.get("paymentMethod") || "";
  const actionParam = url.searchParams.get("action") || "";

  const range = resolveRange(filterPreset);

  const whereClause: any = { userId };
  if (range) {
    whereClause.date = { gte: range.start, lte: range.end };
  }
  if (categoryId) {
    whereClause.categoryId = categoryId;
  }
  if (paymentMethod && PAYMENT_METHODS.includes(paymentMethod as any)) {
    whereClause.paymentMethod = paymentMethod;
  }
  if (search) {
    whereClause.OR = [
      { title: { contains: search } },
      { note: { contains: search } },
    ];
  }

  const [expenses, categories, bankAccounts] = await Promise.all([
    prisma.expense.findMany({
      where: whereClause,
      include: { category: true, bankAccount: true },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    }),
    prisma.category.findMany({
      where: { OR: [{ userId }, { userId: null }] },
      orderBy: { name: "asc" },
    }),
    prisma.bankAccount.findMany({
      where: { userId },
      orderBy: { bankName: "asc" },
    }),
  ]);

  const totalExpense = roundMoney(
    expenses.reduce((sum, e) => sum + e.amount, 0)
  );

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

/**
 * Confirms the category is either the user's own or a shared one, and that the
 * bank account belongs to the user.
 *
 * Without this, both ids were written straight from the form, so a crafted POST
 * could attach another user's account to your expense — and the list view
 * (which includes `bankAccount` and `category`) would then render their names.
 */
async function resolveReferences(
  userId: string,
  categoryId: string | null,
  bankAccountId: string | null
): Promise<
  | { ok: true; categoryId: string; bankAccountId: string | null; categoryType: string }
  | { ok: false; error: string }
> {
  if (!categoryId) {
    return { ok: false, error: "ক্যাটাগরি নির্বাচন করুন।" };
  }

  const category = await prisma.category.findFirst({
    where: { id: categoryId, OR: [{ userId }, { userId: null }] },
    select: { id: true, type: true },
  });
  if (!category) {
    return { ok: false, error: "নির্বাচিত ক্যাটাগরিটি বৈধ নয়।" };
  }

  if (!bankAccountId) {
    return { ok: true, categoryId: category.id, bankAccountId: null, categoryType: category.type };
  }

  const bank = await prisma.bankAccount.findFirst({
    where: { id: bankAccountId, userId },
    select: { id: true },
  });
  if (!bank) {
    return { ok: false, error: "নির্বাচিত ব্যাংক একাউন্টটি বৈধ নয়।" };
  }

  return { ok: true, categoryId: category.id, bankAccountId: bank.id, categoryType: category.type };
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("_intent")?.toString();

  if (intent === "create") {
    const title = parseText(formData.get("title"));
    const amount = parseAmount(formData.get("amount"));
    const expenseDate = parseDateInput(formData.get("date")) ?? new Date();
    const note = parseOptionalText(formData.get("note"));

    if (!title || amount === null) {
      return { error: "শিরোনাম এবং সঠিক পরিমাণ আবশ্যক।" };
    }

    const refs = await resolveReferences(
      userId,
      formData.get("categoryId")?.toString() || null,
      formData.get("bankAccountId")?.toString() || null
    );
    if (!refs.ok) return { error: refs.error };

    await prisma.$transaction(async (tx) => {
      const expense = await tx.expense.create({
        data: {
          userId,
          title,
          amount,
          categoryId: refs.categoryId,
          paymentMethod: parsePaymentMethod(formData.get("paymentMethod")),
          bankAccountId: refs.bankAccountId,
          date: expenseDate,
          note,
        },
      });

      // Category check করে Donation category কিনা দেখি
      const category = await tx.category.findUnique({
        where: { id: refs.categoryId },
        select: { type: true, name: true },
      });

      const isDonationCategory = category?.type === "DONATION" ||
                                category?.name?.toLowerCase().includes("দান");

      // দান খরচ হলে DonationBalance এ spent যোগ হয়
      if (isDonationCategory) {
        await tx.donationBalance.upsert({
          where: { userId },
          create: {
            userId,
            allocated: 0,
            spent: amount,
          },
          update: {
            spent: { increment: amount },
          },
        });
      }

      // ব্যাংক অ্যাকাউন্ট সিলেক্ট করলে উভয় ক্ষেত্রেই সেখান থেকে কাটা হয়
      if (refs.bankAccountId) {
        await debit(tx, {
          userId,
          bankAccountId: refs.bankAccountId,
          amount,
          type: isDonationCategory ? "DONATION" : "EXPENSE",
          description: isDonationCategory ? `দান: ${title}` : `খরচ: ${title}`,
          occurredAt: expenseDate,
          source: { expenseId: expense.id },
        });
      }
    });

    return redirect("/expenses");
  }

  if (intent === "delete") {
    const id = formData.get("id")?.toString();
    if (!id) return { error: "অবৈধ অনুরোধ।" };

    await prisma.$transaction(async (tx) => {
      const existing = await tx.expense.findFirst({
        where: { id, userId },
        include: { category: true, bill: true },
      });
      if (!existing) return;

      // A bill's payment expense can't be deleted from here, or the bill would
      // still claim to be paid with nothing backing it.
      if (existing.bill) return;

      // দান খরচ মুছলে DonationBalance থেকে spent কমা
      const isDonation = existing.category?.type === "DONATION" ||
                        existing.category?.name?.toLowerCase().includes("দান");
      if (isDonation) {
        await tx.donationBalance.upsert({
          where: { userId },
          create: {
            userId,
            allocated: 0,
            spent: 0,
          },
          update: {
            spent: { decrement: existing.amount },
          },
        });
      }

      await reverseLedgerFor(
        tx,
        userId,
        { expenseId: existing.id },
        `খরচ মুছে ফেলা হয়েছে: ${existing.title}`
      );

      await tx.expense.delete({ where: { id: existing.id } });
    });

    return { success: true };
  }

  if (intent === "update") {
    const id = formData.get("id")?.toString();
    const title = parseText(formData.get("title"));
    const amount = parseAmount(formData.get("amount"));
    const expenseDate = parseDateInput(formData.get("date"));
    const note = parseOptionalText(formData.get("note"));

    if (!id) return { error: "অবৈধ অনুরোধ।" };
    if (!title || amount === null) {
      return { error: "শিরোনাম এবং সঠিক পরিমাণ আবশ্যক।" };
    }
    if (!expenseDate) {
      return { error: "সঠিক তারিখ নির্বাচন করুন।" };
    }

    const refs = await resolveReferences(
      userId,
      formData.get("categoryId")?.toString() || null,
      formData.get("bankAccountId")?.toString() || null
    );
    if (!refs.ok) return { error: refs.error };

    await prisma.$transaction(async (tx) => {
      const existing = await tx.expense.findFirst({
        where: { id, userId },
        select: { id: true, title: true, bill: { select: { id: true } } },
      });
      if (!existing || existing.bill) return;

      // Undo whatever the old row took out — from whichever account it took it
      // — then apply the corrected figures.
      await reverseLedgerFor(
        tx,
        userId,
        { expenseId: existing.id },
        `খরচ সংশোধন: ${existing.title}`
      );

      await tx.expense.update({
        where: { id: existing.id },
        data: {
          title,
          amount,
          categoryId: refs.categoryId,
          paymentMethod: parsePaymentMethod(formData.get("paymentMethod")),
          bankAccountId: refs.bankAccountId,
          date: expenseDate,
          note,
        },
      });

      if (refs.bankAccountId) {
        await debit(tx, {
          userId,
          bankAccountId: refs.bankAccountId,
          amount,
          type: "EXPENSE",
          description: `খরচ: ${title}`,
          occurredAt: expenseDate,
          source: { expenseId: existing.id },
        });
      }
    });

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

  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();

  // Preset links carry the other filters along, so switching the date range
  // no longer wipes the search box or the category selection.
  const presetHref = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("preset", id);
    next.delete("action");
    return `?${next.toString()}`;
  };

  const [isAddOpen, setIsAddOpen] = useState(autoOpenNew);
  const [editItem, setEditItem] = useState<any>(null);

  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [selectedCatId, setSelectedCatId] = useState(categories[0]?.id || "");
  const [method, setMethod] = useState("Cash");
  const [bankId, setBankId] = useState("");
  const [expenseDate, setExpenseDate] = useState(todayInputValue());
  const [note, setNote] = useState("");

  const paymentMethods = PAYMENT_METHODS;

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
            setExpenseDate(todayInputValue());
            setSelectedCatId(categories[0]?.id || "");
            setBankId("");
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
          {/* Without this the category/method selects submit without `preset`,
              silently resetting the date range to "this month". */}
          <input type="hidden" name="preset" value={filterPreset} />
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
              <Link
                key={preset.id}
                to={presetHref(preset.id)}
                preventScrollReset
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  filterPreset === preset.id
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {preset.label}
              </Link>
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
                          setExpenseDate(toDateInputValue(item.date));
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

              {actionData?.error && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                  {actionData.error}
                </div>
              )}

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

              {bankId && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300">
                  এই টাকা নির্বাচিত অ্যাকাউন্টের ব্যালান্স থেকে কেটে নেওয়া হবে।
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
