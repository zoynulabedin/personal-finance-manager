import { useState } from "react";
import { Form, useActionData, useNavigation, redirect, Link } from "react-router";
import type { Route } from "./+types/register";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/db.server";
import { createUserSession, getUserId } from "../lib/auth.server";
import { provisionNewUserDefaults } from "../lib/user-setup.server";
import { Lock, Mail, Eye, EyeOff, User as UserIcon, Building2, AlertCircle } from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getUserId(request);
  if (userId) {
    return redirect("/");
  }
  return null;
}

export const MIN_PASSWORD_LENGTH = 8;

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const name = formData.get("name")?.toString().trim();
  const email = formData.get("email")?.toString().trim().toLowerCase();
  const password = formData.get("password")?.toString();
  const confirmPassword = formData.get("confirmPassword")?.toString();

  if (!name || !email || !password || !confirmPassword) {
    return { error: "সমস্ত প্রয়োজনীয় ঘর পূরণ করা আবশ্যক।" };
  }

  if (password !== confirmPassword) {
    return { error: "পাসওয়ার্ড ও নিশ্চিতকরণ পাসওয়ার্ড মিলছে না।" };
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `পাসওয়ার্ড অন্তত ${MIN_PASSWORD_LENGTH} অক্ষরের হতে হবে।` };
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  let user;
  try {
    // User creation and default provisioning happen together — a failure part
    // way through must not leave an account with no categories or wallet.
    user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { name, email, password: hashedPassword },
      });
      await provisionNewUserDefaults(created.id, tx);
      return created;
    });
  } catch (error) {
    // P2002 = unique constraint on email. Checking first and then inserting
    // leaves a race window between the two queries, so let the database decide.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return {
        error: "এই ইমেইল এড্রেস দিয়ে ইতোমধ্যে একটি একাউন্ট তৈরি করা আছে।",
      };
    }
    throw error;
  }

  return createUserSession({
    request,
    userId: user.id,
    sessionVersion: user.sessionVersion,
    redirectTo: "/",
  });
}

export default function Register() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 selection:bg-emerald-500 selection:text-white">
      <div className="w-full max-w-md">
        {/* Header Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center text-white mx-auto shadow-xl shadow-emerald-600/20 mb-3">
            <Building2 className="w-9 h-9" />
          </div>
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight">
            আমার হিসাব
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            নতুন একাউন্ট নিবন্ধন করুন (Public Sign-up)
          </p>
        </div>

        {/* Register Card */}
        <div className="glass-panel p-8 rounded-2xl shadow-2xl border border-slate-800">
          <h2 className="text-xl font-bold text-slate-100 mb-6 text-center">
            রেজিস্ট্রেশন করুন
          </h2>

          {actionData?.error && (
            <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-3">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span>{actionData.error}</span>
            </div>
          )}

          <Form method="post" className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                আপনার নাম *
              </label>
              <div className="relative">
                <UserIcon className="w-5 h-5 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type="text"
                  name="name"
                  required
                  placeholder="যেমন: আব্দুল্লাহ আল মামুন"
                  className="w-full pl-11 pr-4 py-2.5 rounded-xl bg-slate-900 border border-slate-700/70 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                ইমেইল এড্রেস *
              </label>
              <div className="relative">
                <Mail className="w-5 h-5 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type="email"
                  name="email"
                  required
                  placeholder="user@example.com"
                  className="w-full pl-11 pr-4 py-2.5 rounded-xl bg-slate-900 border border-slate-700/70 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                পাসওয়ার্ড *
              </label>
              <div className="relative">
                <Lock className="w-5 h-5 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type={showPassword ? "text" : "password"}
                  name="password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  placeholder={`অন্তত ${MIN_PASSWORD_LENGTH} অক্ষরের পাসওয়ার্ড`}
                  className="w-full pl-11 pr-11 py-2.5 rounded-xl bg-slate-900 border border-slate-700/70 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-3 text-slate-400 hover:text-slate-200"
                >
                  {showPassword ? (
                    <EyeOff className="w-4.5 h-4.5" />
                  ) : (
                    <Eye className="w-4.5 h-4.5" />
                  )}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                পাসওয়ার্ড নিশ্চিত করুন *
              </label>
              <div className="relative">
                <Lock className="w-5 h-5 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type={showPassword ? "text" : "password"}
                  name="confirmPassword"
                  required
                  placeholder="পাসওয়ার্ডটি আবার লিখুন"
                  className="w-full pl-11 pr-4 py-2.5 rounded-xl bg-slate-900 border border-slate-700/70 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition text-sm"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold shadow-lg shadow-emerald-950/50 transition duration-200 disabled:opacity-50 text-sm flex items-center justify-center gap-2 mt-2"
            >
              {isSubmitting ? "রেজিস্ট্রেশন হচ্ছে..." : "রেজিস্ট্রেশন করুন"}
            </button>
          </Form>

          {/* Link to Login */}
          <div className="mt-6 pt-6 border-t border-slate-800 text-center">
            <p className="text-xs text-slate-400">
              ইতোমধ্যে একাউন্ট আছে?{" "}
              <Link to="/login" className="text-emerald-400 font-bold hover:underline">
                লগইন করুন
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
