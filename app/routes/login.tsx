import { useState } from "react";
import {
  Form,
  useActionData,
  useNavigation,
  useSearchParams,
  redirect,
  Link,
} from "react-router";
import type { Route } from "./+types/login";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/db.server";
import { createUserSession, getUserId, safeRedirect } from "../lib/auth.server";
import { Lock, Mail, Eye, EyeOff, Building2, AlertCircle } from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getUserId(request);
  if (userId) {
    return redirect("/");
  }
  return null;
}

// Compared against when the email doesn't exist, so a missing account and a
// wrong password cost the same time (no user enumeration via response timing).
const DUMMY_HASH =
  "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const email = formData.get("email")?.toString().trim().toLowerCase();
  const password = formData.get("password")?.toString();
  const redirectTo = safeRedirect(formData.get("redirectTo"), "/");

  if (!email || !password) {
    return { error: "ইমেইল এবং পাসওয়ার্ড উভয়ই আবশ্যক।" };
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Always run a compare, even when the user is missing.
  const isValid = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);

  if (!user || !isValid) {
    return { error: "ইমেইল বা পাসওয়ার্ড ভুল হয়েছে।" };
  }

  return createUserSession({
    request,
    userId: user.id,
    sessionVersion: user.sessionVersion,
    redirectTo,
  });
}

export default function Login() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [searchParams] = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
            পরিবারের ব্যক্তিগত আয়-ব্যয় ও আর্থিক ম্যানেজমেন্ট
          </p>
        </div>

        {/* Login Card */}
        <div className="glass-panel p-8 rounded-2xl shadow-2xl border border-slate-800">
          <h2 className="text-xl font-bold text-slate-100 mb-6 text-center">
            সিস্টেমে লগইন করুন
          </h2>

          {actionData?.error && (
            <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-3">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span>{actionData.error}</span>
            </div>
          )}

          <Form method="post" className="space-y-5">
            <input type="hidden" name="redirectTo" value={redirectTo} />
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                ইমেইল এড্রেস
              </label>
              <div className="relative">
                <Mail className="w-5 h-5 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type="email"
                  name="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                  className="w-full pl-11 pr-4 py-2.5 rounded-xl bg-slate-900 border border-slate-700/70 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition duration-150 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                পাসওয়ার্ড
              </label>
              <div className="relative">
                <Lock className="w-5 h-5 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type={showPassword ? "text" : "password"}
                  name="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="w-full pl-11 pr-11 py-2.5 rounded-xl bg-slate-900 border border-slate-700/70 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition duration-150 text-sm"
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

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold shadow-lg shadow-emerald-950/50 transition duration-200 disabled:opacity-50 text-sm flex items-center justify-center gap-2"
            >
              {isSubmitting ? "প্রসেসিং হচ্ছে..." : "লগইন করুন"}
            </button>
          </Form>

          {/* Registration Link */}
          <div className="mt-6 pt-4 border-t border-slate-800 text-center space-y-3">
            <p className="text-xs text-slate-300 font-medium">
              নতুন ব্যবহারকারী?{" "}
              <Link to="/register" className="text-emerald-400 font-bold hover:underline">
                এখানে রেজিস্ট্রেশন করুন
              </Link>
            </p>

          </div>
        </div>
      </div>
    </div>
  );
}
