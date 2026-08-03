import { useState } from "react";
import {
  Form,
  useLoaderData,
  useOutletContext,
  useActionData,
  redirect,
} from "react-router";
import type { Route } from "./+types/bank-accounts";
import { prisma } from "../lib/db.server";
import { requireUserId } from "../lib/auth.server";
import {
  parseBalance,
  parseOptionalText,
  parseText,
  roundMoney,
} from "../lib/validation.server";
import type { LayoutContextType } from "./layout";
import { formatBDT, toBengaliDigits } from "../utils/bengali";
import { Landmark, Plus, Edit, Trash2, X } from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);

  const bankAccounts = await prisma.bankAccount.findMany({
    where: { userId },
    orderBy: [{ isCash: "asc" }, { createdAt: "asc" }],
  });

  const totalBalance = roundMoney(
    bankAccounts.reduce((sum, b) => sum + b.currentBalance, 0)
  );
  const cashBalance = roundMoney(
    bankAccounts.filter((b) => b.isCash).reduce((s, b) => s + b.currentBalance, 0)
  );

  return {
    bankAccounts,
    totalBalance,
    cashBalance,
    bankBalance: roundMoney(totalBalance - cashBalance),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("_intent")?.toString();

  if (intent === "create") {
    const bankName = parseText(formData.get("bankName"));
    const accountName = parseText(formData.get("accountName"));
    const accountNumber = parseText(formData.get("accountNumber"));
    const currentBalance = parseBalance(formData.get("currentBalance"));
    const isCash = formData.get("isCash") === "true";
    const note = parseOptionalText(formData.get("note"));

    if (!bankName || !accountName) {
      return { error: "ব্যাংকের নাম এবং একাউন্টের নাম আবশ্যক।" };
    }
    if (currentBalance === null) {
      return { error: "সঠিক ব্যালেন্স লিখুন।" };
    }

    await prisma.bankAccount.create({
      data: {
        userId,
        bankName,
        accountName,
        accountNumber: accountNumber ?? "N/A",
        currentBalance,
        isCash,
        note,
      },
    });

    return redirect("/bank-accounts");
  }

  if (intent === "update_balance") {
    const id = formData.get("id")?.toString();
    const currentBalance = parseBalance(formData.get("currentBalance"));

    if (!id) return { error: "অবৈধ অনুরোধ।" };
    if (currentBalance === null) {
      return { error: "সঠিক ব্যালেন্স লিখুন।" };
    }

    await prisma.bankAccount.updateMany({
      where: { id, userId },
      data: { currentBalance },
    });

    return redirect("/bank-accounts");
  }

  if (intent === "delete") {
    const id = formData.get("id")?.toString();
    if (!id) return { error: "অবৈধ অনুরোধ।" };

    // Expenses and donations keep pointing at a deleted account via SetNull,
    // which loses the audit trail. Block the delete while anything references
    // it and tell the user why, instead of silently orphaning rows.
    const [expenseCount, donationCount] = await Promise.all([
      prisma.expense.count({ where: { bankAccountId: id, userId } }),
      prisma.donation.count({
        where: { bankAccountId: id, income: { userId } },
      }),
    ]);

    if (expenseCount > 0 || donationCount > 0) {
      return {
        error:
          "এই একাউন্টের সাথে খরচ বা দানের রেকর্ড যুক্ত রয়েছে, তাই মুছে ফেলা সম্ভব নয়।",
      };
    }

    await prisma.bankAccount.deleteMany({ where: { id, userId } });
    return redirect("/bank-accounts");
  }

  if (intent === "update") {
    const id = formData.get("id")?.toString();
    const bankName = parseText(formData.get("bankName"));
    const accountName = parseText(formData.get("accountName"));
    const accountNumber = parseText(formData.get("accountNumber"));
    const currentBalance = parseBalance(formData.get("currentBalance"));
    const isCash = formData.get("isCash") === "true";
    const note = parseOptionalText(formData.get("note"));

    if (!id) return { error: "অবৈধ অনুরোধ।" };
    if (!bankName || !accountName) {
      return { error: "ব্যাংকের নাম এবং একাউন্টের নাম আবশ্যক।" };
    }
    if (currentBalance === null) {
      return { error: "সঠিক ব্যালেন্স লিখুন।" };
    }

    await prisma.bankAccount.updateMany({
      where: { id, userId },
      data: {
        bankName,
        accountName,
        accountNumber: accountNumber ?? "N/A",
        currentBalance,
        isCash,
        note,
      },
    });

    return redirect("/bank-accounts");
  }

  return null;
}

export default function BankAccountsPage() {
  const { useBengaliDigits } = useOutletContext<LayoutContextType>();
  const { bankAccounts, totalBalance, cashBalance, bankBalance } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [balanceModalItem, setBalanceModalItem] = useState<any>(null);

  const [bankName, setBankName] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [currentBalance, setCurrentBalance] = useState("");
  const [note, setNote] = useState("");
  const [isCash, setIsCash] = useState(false);

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Landmark className="w-6 h-6 text-indigo-400" />
            <span>ব্যাংক ও ওয়ালেট ব্যালেন্স (Bank Accounts & Mobile Banking)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            আপনার ব্যাংক একাউন্ট, মোবাইল ব্যালেন্স ও ক্যাশ টাকার সঠিক সমন্বয়
          </p>
        </div>

        <button
          onClick={() => {
            setBankName("");
            setAccountName("");
            setAccountNumber("");
            setCurrentBalance("");
            setNote("");
            setIsCash(false);
            setIsAddOpen(true);
          }}
          className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs sm:text-sm flex items-center gap-2 shadow-md shadow-indigo-950/40"
        >
          <Plus className="w-4 h-4" />
          <span>নতুন একাউন্ট যুক্ত করুন</span>
        </button>
      </div>

      {actionData?.error && (
        <div className="p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          {actionData.error}
        </div>
      )}

      {/* Total Balance Card */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 bg-gradient-to-r from-indigo-950/50 to-slate-900 flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            সর্বমোট লিকুইড ব্যালেন্স (Total Funds)
          </span>
          <div className="text-3xl font-extrabold text-indigo-400 mt-1">
            {formatBDT(totalBalance, useBengaliDigits)}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            ব্যাংক: {formatBDT(bankBalance, useBengaliDigits)} · নগদ:{" "}
            {formatBDT(cashBalance, useBengaliDigits)}
          </p>
        </div>
        <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center font-bold text-lg">
          {useBengaliDigits ? toBengaliDigits(bankAccounts.length) : bankAccounts.length}টি
        </div>
      </div>

      {/* Accounts Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {bankAccounts.map((account) => (
          <div
            key={account.id}
            className="glass-card p-5 rounded-2xl border border-slate-800 flex flex-col justify-between hover:border-indigo-500/40 transition duration-200"
          >
            <div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold border ${
                    account.isCash
                      ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                      : "bg-indigo-500/10 text-indigo-400 border-indigo-500/20"
                  }`}
                >
                  {account.bankName}
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  {account.accountNumber}
                </span>
              </div>

              <h3 className="font-bold text-slate-100 text-base mt-2">
                {account.accountName}
              </h3>

              <div className="text-2xl font-extrabold text-slate-100 my-3">
                {formatBDT(account.currentBalance, useBengaliDigits)}
              </div>

              {account.note && (
                <p className="text-xs text-slate-400 mt-1">{account.note}</p>
              )}
            </div>

            <div className="pt-4 mt-4 border-t border-slate-800 flex items-center justify-between">
              <button
                onClick={() => setBalanceModalItem(account)}
                className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-indigo-400 font-semibold text-xs transition"
              >
                ব্যালেন্স আপডেট
              </button>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setEditItem(account);
                    setBankName(account.bankName);
                    setAccountName(account.accountName);
                    setAccountNumber(account.accountNumber);
                    setCurrentBalance(String(account.currentBalance));
                    setNote(account.note || "");
                    setIsCash(account.isCash);
                  }}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-400 hover:bg-slate-800"
                  title="সম্পাদনা"
                >
                  <Edit className="w-4 h-4" />
                </button>
                <Form method="post" onSubmit={(e) => !confirm("মুছে ফেলতে চান?") && e.preventDefault()}>
                  <input type="hidden" name="_intent" value="delete" />
                  <input type="hidden" name="id" value={account.id} />
                  <button
                    type="submit"
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10"
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

      {/* Quick Balance Update Modal */}
      {balanceModalItem && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="glass-panel w-full max-w-sm p-6 rounded-2xl border border-slate-800 shadow-2xl relative">
            <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-slate-100">
                ব্যালেন্স আপডেট করুন
              </h3>
              <button
                onClick={() => setBalanceModalItem(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <Form
              method="post"
              onSubmit={() => setBalanceModalItem(null)}
              className="space-y-4"
            >
              <input type="hidden" name="_intent" value="update_balance" />
              <input type="hidden" name="id" value={balanceModalItem.id} />

              <div className="text-xs text-slate-400">
                ব্যাংক: <strong className="text-slate-200">{balanceModalItem.bankName}</strong> ({balanceModalItem.accountName})
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  নতুন ব্যালেন্স (টাকা) *
                </label>
                <input
                  type="number"
                  name="currentBalance"
                  defaultValue={balanceModalItem.currentBalance}
                  required
                  step="any"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setBalanceModalItem(null)}
                  className="w-1/2 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-sm"
                >
                  বাতিল
                </button>
                <button
                  type="submit"
                  className="w-1/2 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm shadow-md"
                >
                  আপডেট
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Add / Edit Account Modal */}
      {(isAddOpen || editItem) && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="glass-panel w-full max-w-md p-6 rounded-2xl border border-slate-800 shadow-2xl relative">
            <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-slate-100">
                {editItem ? "একাউন্ট সম্পাদনা করুন" : "নতুন একাউন্ট যোগ করুন"}
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
                  ব্যাংক / প্রতিষ্ঠানের নাম *
                </label>
                <input
                  type="text"
                  name="bankName"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  required
                  placeholder="যেমন: Dutch Bangla, bKash, Nagad, Cash"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  একাউন্টের লেবেল / নাম *
                </label>
                <input
                  type="text"
                  name="accountName"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  required
                  placeholder="যেমন: Salary Account, Wallet, Emergency"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    একাউন্ট নম্বর / মোবাইল
                  </label>
                  <input
                    type="text"
                    name="accountNumber"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value)}
                    placeholder="123.456.7890"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    বর্তমান ব্যালেন্স (টাকা)
                  </label>
                  <input
                    type="number"
                    name="currentBalance"
                    value={currentBalance}
                    onChange={(e) => setCurrentBalance(e.target.value)}
                    step="any"
                    placeholder="0.00"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  নোট (ঐচ্ছিক)
                </label>
                <input
                  type="text"
                  name="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="অতিরিক্ত তথ্য..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>

              <input type="hidden" name="isCash" value={String(isCash)} />
              <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer p-3 rounded-xl bg-slate-900 border border-slate-800">
                <input
                  type="checkbox"
                  checked={isCash}
                  onChange={(e) => setIsCash(e.target.checked)}
                  className="mt-0.5 rounded text-indigo-500 focus:ring-indigo-500 bg-slate-800 border-slate-700"
                />
                <span>
                  এটি নগদ টাকার ওয়ালেট
                  <span className="block text-slate-500 mt-0.5">
                    ড্যাশবোর্ডে ব্যাংক ব্যালেন্সের বদলে নগদ হিসেবে গণনা হবে।
                  </span>
                </span>
              </label>

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
                  className="w-1/2 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm shadow-md"
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
