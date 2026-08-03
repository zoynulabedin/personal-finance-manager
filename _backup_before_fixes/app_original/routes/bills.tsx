import { useState } from "react";
import { Form, useLoaderData, useOutletContext, redirect } from "react-router";
import type { Route } from "./+types/bills";
import { prisma } from "../lib/db.server";
import { requireUserId } from "../lib/auth.server";
import type { LayoutContextType } from "./layout";
import { formatBDT, toBengaliDigits, formatBengaliDate } from "../utils/bengali";
import { CreditCard, Plus, CheckCircle2, Clock, Trash2, Edit, X } from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);

  const bills = await prisma.bill.findMany({
    where: { userId },
    orderBy: [{ paid: "asc" }, { dueDate: "asc" }],
  });

  const totalAmount = bills.reduce((sum, b) => sum + b.amount, 0);
  const paidAmount = bills.filter((b) => b.paid).reduce((sum, b) => sum + b.amount, 0);
  const pendingAmount = bills.filter((b) => !b.paid).reduce((sum, b) => sum + b.amount, 0);

  return { bills, totalAmount, paidAmount, pendingAmount };
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("_intent")?.toString();

  if (intent === "create") {
    const title = formData.get("title")?.toString().trim();
    const amount = parseFloat(formData.get("amount")?.toString() || "0");
    const dueDateInput = formData.get("dueDate")?.toString();
    const note = formData.get("note")?.toString().trim();

    if (!title || !dueDateInput || amount <= 0) {
      return { error: "শিরোনাম, বিলের পরিমাণ এবং শেষ তারিখ আবশ্যক।" };
    }

    await prisma.bill.create({
      data: {
        userId,
        title,
        amount,
        dueDate: new Date(dueDateInput),
        paid: false,
        note,
      },
    });

    return redirect("/bills");
  }

  if (intent === "toggle_paid") {
    const id = formData.get("id")?.toString();
    const currentPaid = formData.get("currentPaid") === "true";

    if (id) {
      await prisma.bill.updateMany({
        where: { id, userId },
        data: {
          paid: !currentPaid,
          paidDate: !currentPaid ? new Date() : null,
        },
      });
    }
    return { success: true };
  }

  if (intent === "delete") {
    const id = formData.get("id")?.toString();
    if (id) {
      await prisma.bill.deleteMany({ where: { id, userId } });
    }
    return { success: true };
  }

  if (intent === "update") {
    const id = formData.get("id")?.toString();
    const title = formData.get("title")?.toString().trim();
    const amount = parseFloat(formData.get("amount")?.toString() || "0");
    const dueDateInput = formData.get("dueDate")?.toString();
    const note = formData.get("note")?.toString().trim();

    if (id && title && dueDateInput && amount > 0) {
      await prisma.bill.updateMany({
        where: { id, userId },
        data: {
          title,
          amount,
          dueDate: new Date(dueDateInput),
          note,
        },
      });
    }
    return redirect("/bills");
  }

  return null;
}

export default function BillsPage() {
  const { useBengaliDigits } = useOutletContext<LayoutContextType>();
  const { bills, totalAmount, paidAmount, pendingAmount } = useLoaderData<typeof loader>();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);

  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(new Date().toISOString().split("T")[0]);
  const [note, setNote] = useState("");

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

        <button
          onClick={() => {
            setTitle("");
            setAmount("");
            setNote("");
            setDueDate(new Date().toISOString().split("T")[0]);
            setIsAddOpen(true);
          }}
          className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-medium text-xs sm:text-sm flex items-center gap-2 shadow-md shadow-amber-950/40"
        >
          <Plus className="w-4 h-4" />
          <span>নতুন বিল যোগ করুন</span>
        </button>
      </div>

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
              <Form method="post">
                <input type="hidden" name="_intent" value="toggle_paid" />
                <input type="hidden" name="id" value={bill.id} />
                <input type="hidden" name="currentPaid" value={String(bill.paid)} />
                <button
                  type="submit"
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                    bill.paid
                      ? "bg-slate-800 text-slate-300 hover:bg-slate-700"
                      : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-md"
                  }`}
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{bill.paid ? "অপরিশোধিত করুন" : "পে করা হয়েছে"}</span>
                </button>
              </Form>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setEditItem(bill);
                    setTitle(bill.title);
                    setAmount(String(bill.amount));
                    setDueDate(new Date(bill.dueDate).toISOString().split("T")[0]);
                    setNote(bill.note || "");
                  }}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-slate-800"
                  title="সম্পাদনা"
                >
                  <Edit className="w-4 h-4" />
                </button>
                <Form method="post" onSubmit={(e) => !confirm("মুছে ফেলতে চান?") && e.preventDefault()}>
                  <input type="hidden" name="_intent" value="delete" />
                  <input type="hidden" name="id" value={bill.id} />
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
