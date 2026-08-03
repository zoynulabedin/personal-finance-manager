import { useState } from "react";
import { Form, useLoaderData, useActionData, useOutletContext, redirect } from "react-router";
import type { Route } from "./+types/settings";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/db.server";
import { requireUserId, getUser, logout } from "../lib/auth.server";
import type { LayoutContextType } from "./layout";
import { Settings, User, Lock, Download, Upload } from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const user = await getUser(request);

  if (!user) {
    throw await logout(request);
  }

  // Fetch full backup JSON data scoped to current user
  const url = new URL(request.url);
  if (url.searchParams.get("export") === "true") {
    const incomes = await prisma.income.findMany({
      where: { userId },
      include: { donations: true },
    });
    const expenses = await prisma.expense.findMany({ where: { userId } });
    const bills = await prisma.bill.findMany({ where: { userId } });
    const bankAccounts = await prisma.bankAccount.findMany({ where: { userId } });
    const categories = await prisma.category.findMany({ where: { OR: [{ userId }, { userId: null }] } });

    const backupData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      user: { name: user?.name, email: user?.email },
      incomes,
      expenses,
      bills,
      bankAccounts,
      categories,
    };

    return new Response(JSON.stringify(backupData, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="poribar_finance_backup_${new Date().toISOString().split("T")[0]}.json"`,
      },
    });
  }

  return { user };
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("_intent")?.toString();

  if (intent === "update_profile") {
    const name = formData.get("name")?.toString().trim();
    const email = formData.get("email")?.toString().trim();

    if (!name || !email) {
      return { profileError: "নাম এবং ইমেইল দুটোই প্রয়োজন।" };
    }

    // Ensure email is unique if changed
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.id !== userId) {
      return { profileError: "এই ইমেইল এড্রেস দিয়ে অন্য একাউন্ট রয়েছে।" };
    }

    try {
      await prisma.user.update({
        where: { id: userId },
        data: { name, email },
      });
      return { profileSuccess: "প্রোফাইল তথ্য সফলভাবে আপডেট হয়েছে!" };
    } catch (e) {
      return { profileError: "প্রোফাইল আপডেট করা সম্ভব হয়নি। ইউজার খুঁজে পাওয়া যায়নি।" };
    }
  }

  if (intent === "update_password") {
    const currentPassword = formData.get("currentPassword")?.toString();
    const newPassword = formData.get("newPassword")?.toString();
    const confirmPassword = formData.get("confirmPassword")?.toString();

    if (!currentPassword || !newPassword || !confirmPassword) {
      return { passError: "সমস্ত ঘর পূরণ করা আবশ্যক।" };
    }

    if (newPassword !== confirmPassword) {
      return { passError: "নতুন পাসওয়ার্ড ও নিশ্চিতকরণ মিলছে না।" };
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { passError: "ব্যবহারকারী পাওয়া যায়নি।" };

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return { passError: "বর্তমান পাসওয়ার্ড ভুল দেওয়া হয়েছে।" };
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    return { passSuccess: "পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে!" };
  }

  if (intent === "import_data") {
    const jsonString = formData.get("jsonString")?.toString();
    if (!jsonString) {
      return { backupError: "কোনো ডেটা ফাইল পাওয়া যায়নি।" };
    }

    try {
      const data = JSON.parse(jsonString);

      // Restore categories scoped to userId
      if (Array.isArray(data.categories)) {
        for (const cat of data.categories) {
          await prisma.category.upsert({
            where: { id: cat.id },
            update: { name: cat.name, icon: cat.icon, color: cat.color, userId },
            create: { id: cat.id, name: cat.name, icon: cat.icon, color: cat.color, userId },
          });
        }
      }

      // Restore Bank Accounts scoped to userId
      if (Array.isArray(data.bankAccounts)) {
        for (const bank of data.bankAccounts) {
          await prisma.bankAccount.upsert({
            where: { id: bank.id },
            update: {
              bankName: bank.bankName,
              accountName: bank.accountName,
              accountNumber: bank.accountNumber,
              currentBalance: bank.currentBalance,
              note: bank.note,
              userId,
            },
            create: {
              id: bank.id,
              bankName: bank.bankName,
              accountName: bank.accountName,
              accountNumber: bank.accountNumber,
              currentBalance: bank.currentBalance,
              note: bank.note,
              userId,
            },
          });
        }
      }

      // Restore Incomes scoped to userId
      if (Array.isArray(data.incomes)) {
        for (const inc of data.incomes) {
          await prisma.income.upsert({
            where: { id: inc.id },
            update: {
              title: inc.title,
              amount: inc.amount,
              month: inc.month,
              year: inc.year,
              note: inc.note,
              userId,
            },
            create: {
              id: inc.id,
              title: inc.title,
              amount: inc.amount,
              month: inc.month,
              year: inc.year,
              note: inc.note,
              userId,
            },
          });
        }
      }

      // Restore Expenses scoped to userId
      if (Array.isArray(data.expenses)) {
        for (const exp of data.expenses) {
          await prisma.expense.upsert({
            where: { id: exp.id },
            update: {
              title: exp.title,
              amount: exp.amount,
              date: new Date(exp.date),
              categoryId: exp.categoryId,
              paymentMethod: exp.paymentMethod,
              bankAccountId: exp.bankAccountId,
              note: exp.note,
              userId,
            },
            create: {
              id: exp.id,
              title: exp.title,
              amount: exp.amount,
              date: new Date(exp.date),
              categoryId: exp.categoryId,
              paymentMethod: exp.paymentMethod,
              bankAccountId: exp.bankAccountId,
              note: exp.note,
              userId,
            },
          });
        }
      }

      // Restore Bills scoped to userId
      if (Array.isArray(data.bills)) {
        for (const bill of data.bills) {
          await prisma.bill.upsert({
            where: { id: bill.id },
            update: {
              title: bill.title,
              amount: bill.amount,
              dueDate: new Date(bill.dueDate),
              paid: bill.paid,
              paidDate: bill.paidDate ? new Date(bill.paidDate) : null,
              note: bill.note,
              userId,
            },
            create: {
              id: bill.id,
              title: bill.title,
              amount: bill.amount,
              dueDate: new Date(bill.dueDate),
              paid: bill.paid,
              paidDate: bill.paidDate ? new Date(bill.paidDate) : null,
              note: bill.note,
              userId,
            },
          });
        }
      }

      return { backupSuccess: "ডেটা সফলভাবে রিস্টোর/ইম্পোর্ট করা হয়েছে!" };
    } catch (e: any) {
      return { backupError: "সঠিক ব্যাকআপ JSON ফাইল নির্বাচন করুন।" };
    }
  }

  return null;
}

export default function SettingsPage() {
  const { useBengaliDigits, setUseBengaliDigits } = useOutletContext<LayoutContextType>();
  const loaderData = useLoaderData<typeof loader>();

  const user = (loaderData as any)?.user;
  const actionData = useActionData<typeof action>();

  const [importJsonText, setImportJsonText] = useState("");

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setImportJsonText(event.target?.result as string || "");
      };
      reader.readAsText(file);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Top Banner */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Settings className="w-6 h-6 text-slate-400" />
            <span>সিস্টেম সেটিংস (Settings & Backup)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            প্রোফাইল তথ্য, সিকিউরিটি এবং ব্যাকআপ রিস্টোর অপশন
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Profile Card */}
        <div className="glass-card p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="font-bold text-slate-100 text-base flex items-center gap-2 border-b border-slate-800 pb-3">
            <User className="w-5 h-5 text-emerald-400" />
            <span>প্রোফাইল সেটিংস</span>
          </h3>

          {actionData?.profileError && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
              {actionData.profileError}
            </div>
          )}
          {actionData?.profileSuccess && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
              {actionData.profileSuccess}
            </div>
          )}

          <Form method="post" className="space-y-4">
            <input type="hidden" name="_intent" value="update_profile" />
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                ব্যবহারকারীর নাম
              </label>
              <input
                type="text"
                name="name"
                defaultValue={user?.name}
                required
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                ইমেইল এড্রেস
              </label>
              <input
                type="email"
                name="email"
                defaultValue={user?.email}
                required
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition shadow-md"
            >
              প্রোফাইল সংরক্ষণ করুন
            </button>
          </Form>
        </div>

        {/* Password Card */}
        <div className="glass-card p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 className="font-bold text-slate-100 text-base flex items-center gap-2 border-b border-slate-800 pb-3">
            <Lock className="w-5 h-5 text-amber-400" />
            <span>পাসওয়ার্ড পরিবর্তন</span>
          </h3>

          {actionData?.passError && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
              {actionData.passError}
            </div>
          )}
          {actionData?.passSuccess && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
              {actionData.passSuccess}
            </div>
          )}

          <Form method="post" className="space-y-4">
            <input type="hidden" name="_intent" value="update_password" />
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                বর্তমান পাসওয়ার্ড
              </label>
              <input
                type="password"
                name="currentPassword"
                required
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                নতুন পাসওয়ার্ড
              </label>
              <input
                type="password"
                name="newPassword"
                required
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                পাসওয়ার্ড নিশ্চিত করুন
              </label>
              <input
                type="password"
                name="confirmPassword"
                required
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-amber-500"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs transition shadow-md"
            >
              পাসওয়ার্ড আপডেট করুন
            </button>
          </Form>
        </div>
      </div>

      {/* Backup & Restore Section */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 space-y-6">
        <h3 className="font-bold text-slate-100 text-base flex items-center gap-2 border-b border-slate-800 pb-3">
          <Download className="w-5 h-5 text-sky-400" />
          <span>ডেটা ব্যাকআপ ও ইম্পোর্ট (Data Backup & Restore)</span>
        </h3>

        {actionData?.backupError && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
            {actionData.backupError}
          </div>
        )}
        {actionData?.backupSuccess && (
          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
            {actionData.backupSuccess}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Export JSON */}
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
            <h4 className="font-semibold text-slate-200 text-sm">
              ১. ব্যাকআপ ডেটা ডাউনলোড করুন
            </h4>
            <p className="text-xs text-slate-400">
              আপনার সমস্ত আয়, খরচ, বিল এবং ব্যাংক একাউন্টের একটি পূর্ণাঙ্গ JSON ফাইল হিসেবে সংরক্ষণ করে রাখুন।
            </p>
            <a
              href="/settings?export=true"
              download
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs shadow-md transition"
            >
              <Download className="w-4 h-4" />
              <span>ব্যাকআপ JSON ডাউনলোড</span>
            </a>
          </div>

          {/* Import JSON */}
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
            <h4 className="font-semibold text-slate-200 text-sm">
              ২. ব্যাকআপ ফাইল রিস্টোর করুন
            </h4>
            <p className="text-xs text-slate-400">
              আগের ডাউনলোডকৃত JSON ব্যাকআপ ফাইল নির্বাচন করে ডেটা রিস্টোর করুন।
            </p>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="_intent" value="import_data" />
              <input type="hidden" name="jsonString" value={importJsonText} />

              <input
                type="file"
                accept=".json"
                onChange={handleFileUpload}
                className="block w-full text-xs text-slate-400 file:mr-4 file:py-2 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-slate-200 hover:file:bg-slate-700"
              />

              <button
                type="submit"
                disabled={!importJsonText}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-semibold text-xs shadow-md transition"
              >
                <Upload className="w-4 h-4" />
                <span>ডেটা ইম্পোর্ট করুন</span>
              </button>
            </Form>
          </div>
        </div>
      </div>
    </div>
  );
}
