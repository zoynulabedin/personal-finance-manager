import { useState } from "react";
import { Form, useLoaderData, useOutletContext, useActionData, redirect } from "react-router";
import type { Route } from "./+types/transfers";
import { toDateInputValue, todayInputValue } from "../utils/date";
import type { LayoutContextType } from "./layout";
import { formatBDT, toBengaliDigits, formatBengaliDate } from "../utils/bengali";
import { Plus, Trash2, Edit, ArrowRightLeft, X } from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const { requireUserId } = await import("../lib/auth.server");
  const { prisma } = await import("../lib/db.server");
  const userId = await requireUserId(request);

  const [transfers, bankAccounts] = await Promise.all([
    prisma.transfer.findMany({
      where: { userId },
      include: { fromAccount: true, toAccount: true },
      orderBy: { occurredAt: "desc" },
    }),
    prisma.bankAccount.findMany({
      where: { userId },
      orderBy: [{ isCash: "asc" }, { bankName: "asc" }],
    }),
  ]);

  return {
    transfers,
    bankAccounts,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { requireUserId } = await import("../lib/auth.server");
  const { prisma } = await import("../lib/db.server");
  const {
    parseAmount,
    parseDateInput,
    parseOptionalText,
  } = await import("../lib/validation.server");
  const {
    assertOwnedAccount,
    credit,
    debit,
    reverseLedgerFor,
  } = await import("../lib/ledger.server");

  const userId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("_intent")?.toString();

  if (intent === "create") {
    const fromAccountId = formData.get("fromAccountId")?.toString();
    const toAccountId = formData.get("toAccountId")?.toString();
    const amount = parseAmount(formData.get("amount"));
    const note = parseOptionalText(formData.get("note"));
    const occurredAt = parseDateInput(formData.get("occurredAt")) ?? new Date();

    if (!fromAccountId || !toAccountId || amount === null) {
      return { error: "সব তথ্য প্রদান করুন।" };
    }

    if (fromAccountId === toAccountId) {
      return { error: "একই অ্যাকাউন্টের মধ্যে ট্রান্সফার করা যায় না।" };
    }

    const result = await prisma.$transaction(async (tx) => {
      const from = await assertOwnedAccount(tx, userId, fromAccountId);
      const to = await assertOwnedAccount(tx, userId, toAccountId);

      if (!from || !to) {
        return { error: "নির্বাচিত অ্যাকাউন্ট বৈধ নয়।" };
      }

      const account = await tx.bankAccount.findUnique({
        where: { id: from },
        select: { currentBalance: true },
      });

      if (!account || account.currentBalance < amount) {
        return { error: "অ্যাকাউন্টে পর্যাপ্ত ব্যালেন্স নেই।" };
      }

      const transfer = await tx.transfer.create({
        data: {
          userId,
          fromAccountId: from,
          toAccountId: to,
          amount,
          note,
          occurredAt,
        },
      });

      // Each leg names the *other* account. The single shared string this
      // replaces was built from the destination and used on both entries, so
      // the source account's statement claimed the money came from the
      // destination, and the destination's claimed it came from itself.
      const names = await tx.bankAccount.findMany({
        where: { id: { in: [from, to] } },
        select: { id: true, bankName: true, accountName: true },
      });
      const label = (id: string) => {
        const account = names.find((a) => a.id === id);
        return account
          ? `${account.bankName} — ${account.accountName}`
          : "অন্য অ্যাকাউন্ট";
      };

      await debit(tx, {
        userId,
        bankAccountId: from,
        amount,
        type: "TRANSFER",
        description: `ট্রান্সফার → ${label(to)}`,
        occurredAt,
        source: { transferId: transfer.id },
      });

      await credit(tx, {
        userId,
        bankAccountId: to,
        amount,
        type: "TRANSFER",
        description: `ট্রান্সফার ← ${label(from)}`,
        occurredAt,
        source: { transferId: transfer.id },
      });

      return transfer;
    });

    if ("error" in result) {
      return result;
    }

    return redirect("/transfers");
  }

  if (intent === "delete") {
    const transferId = formData.get("transferId")?.toString();

    if (!transferId) {
      return { error: "ট্রান্সফার খুঁজে পাওয়া যায়নি।" };
    }

    const transfer = await prisma.transfer.findFirst({
      where: { id: transferId, userId },
    });

    if (!transfer) {
      return { error: "ট্রান্সফার খুঁজে পাওয়া যায়নি।" };
    }

    await prisma.$transaction(async (tx) => {
      await reverseLedgerFor(tx, userId, { transferId }, "ট্রান্সফার বাতিল");
      await tx.transfer.delete({ where: { id: transferId } });
    });

    return redirect("/transfers");
  }

  return null;
}

export default function TransfersPage() {
  const { useBengaliDigits } = useOutletContext<LayoutContextType>();
  const { transfers, bankAccounts } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const [showForm, setShowForm] = useState(false);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <ArrowRightLeft className="w-6 h-6 text-purple-400" />
            <span>অ্যাকাউন্ট ট্রান্সফার</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            এক অ্যাকাউন্ট থেকে অন্য অ্যাকাউন্টে টাকা স্থানান্তর
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-semibold text-sm transition"
        >
          <Plus className="w-4 h-4" />
          নতুন ট্রান্সফার
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <div className="glass-card p-6 rounded-2xl border border-slate-800">
          <h3 className="text-lg font-bold text-slate-100 mb-4">নতুন ট্রান্সফার</h3>

          {actionData?.error && (
            <div className="mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm flex items-start gap-3">
              <X className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{actionData.error}</span>
            </div>
          )}

          <Form method="post" className="space-y-4">
            <input type="hidden" name="_intent" value="create" />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-2">
                  যেখান থেকে *
                </label>
                <select
                  name="fromAccountId"
                  required
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-purple-500"
                >
                  <option value="">অ্যাকাউন্ট নির্বাচন করুন</option>
                  {bankAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.bankName} ({a.accountName})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-2">
                  যেখানে *
                </label>
                <select
                  name="toAccountId"
                  required
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-purple-500"
                >
                  <option value="">অ্যাকাউন্ট নির্বাচন করুন</option>
                  {bankAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.bankName} ({a.accountName})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-2">
                  পরিমাণ *
                </label>
                <input
                  type="number"
                  step="0.01"
                  name="amount"
                  placeholder="১০০০"
                  required
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-purple-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-2">
                  তারিখ
                </label>
                <input
                  type="date"
                  name="occurredAt"
                  defaultValue={todayInputValue()}
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-2">
                নোট
              </label>
              <input
                type="text"
                name="note"
                placeholder="কেন ট্রান্সফার করছেন?"
                className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-purple-500"
              />
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white font-semibold text-sm transition"
              >
                ট্রান্সফার করুন
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-sm transition"
              >
                বাতিল
              </button>
            </div>
          </Form>
        </div>
      )}

      {/* Transfers List */}
      <div className="glass-card rounded-2xl border border-slate-800 overflow-hidden">
        <div className="p-4 border-b border-slate-800 font-bold text-slate-200 text-sm">
          {transfers.length}টি ট্রান্সফার
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400 uppercase tracking-wider bg-slate-900/60">
                <th className="py-3 px-4">তারিখ</th>
                <th className="py-3 px-4">থেকে</th>
                <th className="py-3 px-4">যেখানে</th>
                <th className="py-3 px-4 text-right">পরিমাণ</th>
                <th className="py-3 px-4">নোট</th>
                <th className="py-3 px-4 text-right">অ্যাকশন</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {transfers.map((transfer) => (
                <tr key={transfer.id} className="hover:bg-slate-800/40 transition">
                  <td className="py-3.5 px-4 text-xs text-slate-300 whitespace-nowrap">
                    {formatBengaliDate(transfer.occurredAt, useBengaliDigits)}
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="font-medium text-slate-100">
                      {transfer.fromAccount.bankName}
                    </div>
                    <div className="text-xs text-slate-400">
                      {transfer.fromAccount.accountName}
                    </div>
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="font-medium text-slate-100">
                      {transfer.toAccount.bankName}
                    </div>
                    <div className="text-xs text-slate-400">
                      {transfer.toAccount.accountName}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 text-right font-bold text-purple-400">
                    {formatBDT(transfer.amount, useBengaliDigits)}
                  </td>
                  <td className="py-3.5 px-4 text-xs text-slate-400">
                    {transfer.note || "-"}
                  </td>
                  <td className="py-3.5 px-4 text-right">
                    <Form method="post" className="inline">
                      <input type="hidden" name="_intent" value="delete" />
                      <input type="hidden" name="transferId" value={transfer.id} />
                      <button
                        type="submit"
                        className="text-rose-400 hover:text-rose-300 transition"
                        title="বাতিল করুন"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </Form>
                  </td>
                </tr>
              ))}
              {transfers.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500 text-xs">
                    কোনো ট্রান্সফার নেই
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
