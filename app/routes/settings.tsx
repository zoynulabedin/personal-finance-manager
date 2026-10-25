import { useState } from "react";
import {
  Form,
  useLoaderData,
  useActionData,
  useNavigation,
  useOutletContext,
  redirect,
} from "react-router";
import type { Route } from "./+types/settings";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/db.server";
import {
  requireUser,
  requireUserId,
  getSession,
  sessionStorage,
} from "../lib/auth.server";
import { parseText } from "../lib/validation.server";
import {
  backupDayKey,
  createManualSnapshot,
  deleteSnapshot,
  listSnapshots,
  restoreBackup,
  restoreSnapshot,
  type RestoreCounts,
  type SnapshotKind,
  type SnapshotListItem,
} from "../lib/backup.server";
import { toBengaliDigits } from "../utils/bengali";
import type { LayoutContextType } from "./layout";
import {
  Settings,
  User,
  Lock,
  Download,
  Upload,
  DatabaseBackup,
  ArchiveRestore,
  Trash2,
  CircleCheck,
  TriangleAlert,
} from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const snapshots = await listSnapshots(user.id);
  const today = backupDayKey();
  return {
    user,
    passwordChanged: url.searchParams.get("passwordChanged") === "1",
    snapshots,
    todaySnapshot: snapshots.find((s) => s.autoDay === today) ?? null,
  };
}

const MIN_PASSWORD_LENGTH = 8;

/**
 * One shape for every branch. Without this the inferred union has members that
 * lack the other branches' keys, so `actionData?.passError` fails to compile.
 */
type SettingsActionData = {
  profileError?: string;
  profileSuccess?: string;
  passError?: string;
  passSuccess?: string;
  backupError?: string;
  backupSuccess?: string;
  snapshotError?: string;
  snapshotSuccess?: string;
};

function describeRestore(counts: RestoreCounts): string {
  return `${counts.categories}টি ক্যাটাগরি, ${counts.banks}টি একাউন্ট, ${counts.incomes}টি আয়, ${counts.expenses}টি খরচ, ${counts.bills}টি বিল, ${counts.transfers}টি ট্রান্সফার`;
}

export async function action({
  request,
}: Route.ActionArgs): Promise<SettingsActionData | Response | null> {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("_intent")?.toString();

  if (intent === "update_profile") {
    const name = parseText(formData.get("name"));
    const email = parseText(formData.get("email"))?.toLowerCase() ?? null;

    if (!name || !email) {
      return { profileError: "নাম এবং ইমেইল দুটোই প্রয়োজন।" };
    }

    try {
      await prisma.user.update({
        where: { id: userId },
        data: { name, email },
      });
      return { profileSuccess: "প্রোফাইল তথ্য সফলভাবে আপডেট হয়েছে!" };
    } catch (error) {
      // Let the unique index decide, instead of a read-then-write check that
      // two concurrent requests can both pass.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "P2002"
      ) {
        return { profileError: "এই ইমেইল এড্রেস দিয়ে অন্য একাউন্ট রয়েছে।" };
      }
      return { profileError: "প্রোফাইল আপডেট করা সম্ভব হয়নি।" };
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
      return { passError: "নতুন পাসওয়ার্ড ও নিশ্চিতকরণ মিলছে না।" };
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return {
        passError: `নতুন পাসওয়ার্ড অন্তত ${MIN_PASSWORD_LENGTH} অক্ষরের হতে হবে।`,
      };
    }

    if (newPassword === currentPassword) {
      return { passError: "নতুন পাসওয়ার্ড আগেরটির থেকে ভিন্ন হতে হবে।" };
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { passError: "ব্যবহারকারী পাওয়া যায়নি।" };

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return { passError: "বর্তমান পাসওয়ার্ড ভুল দেওয়া হয়েছে।" };
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Bumping sessionVersion invalidates every cookie issued before now, so a
    // stolen 30-day session dies the moment the password is changed.
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        sessionVersion: { increment: 1 },
      },
      select: { id: true, sessionVersion: true },
    });

    // ...including this browser's, so re-issue the current session with the
    // new version to keep the user signed in here.
    //
    // This has to be a redirect rather than plain action data: on a data
    // response React Router revalidates the loaders inside the same request,
    // and those still see the *old* cookie, so requireUser would immediately
    // bounce the user to /login. A redirect ships the new cookie first and the
    // follow-up GET carries it.
    const session = await getSession(request);
    session.set("userId", updated.id);
    session.set("sessionVersion", updated.sessionVersion);

    return redirect("/settings?passwordChanged=1", {
      headers: { "Set-Cookie": await sessionStorage.commitSession(session) },
    });
  }

  if (intent === "import_data") {
    const jsonString = formData.get("jsonString")?.toString();
    const replaceExisting = formData.get("replaceExisting") === "true";

    if (!jsonString) {
      return { backupError: "কোনো ডেটা ফাইল পাওয়া যায়নি।" };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonString);
    } catch {
      return { backupError: "ফাইলটি বৈধ JSON নয়। সঠিক ব্যাকআপ ফাইল নির্বাচন করুন।" };
    }

    if (!parsed || typeof parsed !== "object") {
      return { backupError: "সঠিক ব্যাকআপ JSON ফাইল নির্বাচন করুন।" };
    }

    try {
      const counts = await restoreBackup(userId, parsed, { replaceExisting });
      return { backupSuccess: `ডেটা সফলভাবে রিস্টোর হয়েছে — ${describeRestore(counts)}।` };
    } catch (error) {
      console.error("Backup import failed:", error);
      return {
        backupError:
          "ইম্পোর্ট করা যায়নি। কোনো পরিবর্তন সংরক্ষণ হয়নি — ফাইলটি পরীক্ষা করে আবার চেষ্টা করুন।",
      };
    }
  }

  if (intent === "create_snapshot") {
    try {
      await createManualSnapshot(userId);
      return { snapshotSuccess: "বর্তমান সব ডেটার ব্যাকআপ নেওয়া হয়েছে।" };
    } catch (error) {
      console.error("Manual backup failed:", error);
      return { snapshotError: "ব্যাকআপ নেওয়া সম্ভব হয়নি। আবার চেষ্টা করুন।" };
    }
  }

  if (intent === "restore_snapshot") {
    const snapshotId = parseText(formData.get("snapshotId"));
    if (!snapshotId) return { snapshotError: "কোনো ব্যাকআপ নির্বাচন করা হয়নি।" };

    try {
      const counts = await restoreSnapshot(userId, snapshotId);
      if (!counts) return { snapshotError: "ব্যাকআপটি পাওয়া যায়নি।" };
      return {
        snapshotSuccess: `ব্যাকআপ থেকে ডেটা ফিরিয়ে আনা হয়েছে — ${describeRestore(counts)}। আগের অবস্থার একটি ব্যাকআপ "রিস্টোরের আগে" নামে রাখা হয়েছে।`,
      };
    } catch (error) {
      console.error("Snapshot restore failed:", error);
      return {
        snapshotError:
          "রিস্টোর করা যায়নি। কোনো পরিবর্তন সংরক্ষণ হয়নি — আপনার বর্তমান ডেটা অপরিবর্তিত আছে।",
      };
    }
  }

  if (intent === "delete_snapshot") {
    const snapshotId = parseText(formData.get("snapshotId"));
    if (!snapshotId || !(await deleteSnapshot(userId, snapshotId))) {
      return { snapshotError: "ব্যাকআপটি পাওয়া যায়নি।" };
    }
    return { snapshotSuccess: "ব্যাকআপটি মুছে ফেলা হয়েছে।" };
  }

  return null;
}

const SNAPSHOT_KINDS: Record<SnapshotKind, { label: string; className: string }> = {
  AUTO: {
    label: "দৈনিক",
    className: "bg-sky-500/10 border-sky-500/20 text-sky-400",
  },
  MANUAL: {
    label: "ম্যানুয়াল",
    className: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
  },
  PRE_RESTORE: {
    label: "রিস্টোরের আগে",
    className: "bg-amber-500/10 border-amber-500/20 text-amber-400",
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function BackupSnapshotsCard({
  snapshots,
  todaySnapshot,
  actionData,
  useBengaliDigits,
}: {
  snapshots: SnapshotListItem[];
  todaySnapshot: SnapshotListItem | null;
  actionData: SettingsActionData | undefined;
  useBengaliDigits: boolean;
}) {
  const navigation = useNavigation();
  const busyIntent =
    navigation.state === "submitting"
      ? navigation.formData?.get("_intent")?.toString()
      : undefined;
  const busy =
    busyIntent === "create_snapshot" ||
    busyIntent === "restore_snapshot" ||
    busyIntent === "delete_snapshot";

  const digits = (value: string | number) =>
    useBengaliDigits ? toBengaliDigits(value) : String(value);

  return (
    <div className="glass-card p-6 rounded-2xl border border-slate-800 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <h3 className="font-bold text-slate-100 text-base flex items-center gap-2">
          <DatabaseBackup className="w-5 h-5 text-sky-400" />
          <span>স্বয়ংক্রিয় দৈনিক ব্যাকআপ (Daily Backups)</span>
        </h3>
        <Form method="post">
          <input type="hidden" name="_intent" value="create_snapshot" />
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-semibold text-xs shadow-md transition"
          >
            <DatabaseBackup className="w-4 h-4" />
            <span>
              {busyIntent === "create_snapshot" ? "ব্যাকআপ নেওয়া হচ্ছে…" : "এখনই ব্যাকআপ নিন"}
            </span>
          </button>
        </Form>
      </div>

      <p className="text-xs text-slate-400">
        প্রতিদিন প্রথমবার অ্যাপ ব্যবহারের সময়, কোনো পরিবর্তনের আগেই, আপনার সব
        ডেটার একটি ব্যাকআপ স্বয়ংক্রিয়ভাবে সংরক্ষিত হয়। শেষ {digits(30)}টি দৈনিক
        ব্যাকআপ রাখা হয়। যেকোনো রিস্টোরের আগে বর্তমান ডেটার একটি ব্যাকআপও রাখা
        হয়, তাই ভুল রিস্টোরও ফিরিয়ে নেওয়া যায়।
      </p>

      {todaySnapshot ? (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
          <CircleCheck className="w-4 h-4 shrink-0" />
          <span>
            আজকের ব্যাকআপ নেওয়া হয়েছে — {digits(todaySnapshot.createdAtLabel)}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs">
          <TriangleAlert className="w-4 h-4 shrink-0" />
          <span>
            আজকের স্বয়ংক্রিয় ব্যাকআপ নেওয়া যায়নি। "এখনই ব্যাকআপ নিন" চাপুন, অথবা
            কিছুক্ষণ পর পাতাটি আবার খুলুন।
          </span>
        </div>
      )}

      {actionData?.snapshotError && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          {actionData.snapshotError}
        </div>
      )}
      {actionData?.snapshotSuccess && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
          {actionData.snapshotSuccess}
        </div>
      )}

      {snapshots.length === 0 ? (
        <p className="text-xs text-slate-500 text-center py-6">
          এখনো কোনো ব্যাকআপ নেই।
        </p>
      ) : (
        <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900">
          {snapshots.map((snapshot) => {
            const kind = SNAPSHOT_KINDS[snapshot.kind] ?? SNAPSHOT_KINDS.MANUAL;
            const { summary } = snapshot;
            return (
              <li
                key={snapshot.id}
                className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`px-2 py-0.5 rounded-lg border text-[11px] font-semibold ${kind.className}`}
                    >
                      {kind.label}
                    </span>
                    <span className="text-sm font-semibold text-slate-200">
                      {digits(snapshot.createdAtLabel)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {digits(summary.incomes)}টি আয় · {digits(summary.expenses)}টি খরচ ·{" "}
                    {digits(summary.bills)}টি বিল · {digits(summary.bankAccounts)}টি একাউন্ট ·{" "}
                    {digits(formatSize(snapshot.sizeBytes))}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={`/settings/backups/${snapshot.id}/download`}
                    download
                    title="ডাউনলোড"
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs transition"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>ডাউনলোড</span>
                  </a>

                  <Form
                    method="post"
                    onSubmit={(e) =>
                      !confirm(
                        "এই ব্যাকআপে ফিরে যেতে চান?\n\nবর্তমান সব ডেটা মুছে এই ব্যাকআপের ডেটা বসানো হবে। তার আগে বর্তমান অবস্থার একটি ব্যাকআপ স্বয়ংক্রিয়ভাবে রাখা হবে।"
                      ) && e.preventDefault()
                    }
                  >
                    <input type="hidden" name="_intent" value="restore_snapshot" />
                    <input type="hidden" name="snapshotId" value={snapshot.id} />
                    <button
                      type="submit"
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-semibold text-xs transition"
                    >
                      <ArchiveRestore className="w-3.5 h-3.5" />
                      <span>
                        {busyIntent === "restore_snapshot" &&
                        navigation.formData?.get("snapshotId") === snapshot.id
                          ? "রিস্টোর হচ্ছে…"
                          : "রিস্টোর"}
                      </span>
                    </button>
                  </Form>

                  <Form
                    method="post"
                    onSubmit={(e) => !confirm("মুছে ফেলতে চান?") && e.preventDefault()}
                  >
                    <input type="hidden" name="_intent" value="delete_snapshot" />
                    <input type="hidden" name="snapshotId" value={snapshot.id} />
                    <button
                      type="submit"
                      disabled={busy}
                      title="মুছে ফেলুন"
                      className="p-2 rounded-xl text-slate-500 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </Form>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const { useBengaliDigits, setUseBengaliDigits } = useOutletContext<LayoutContextType>();
  const { user, passwordChanged, snapshots, todaySnapshot } =
    useLoaderData<typeof loader>();
  const actionData = useActionData() as SettingsActionData | undefined;

  const [importJsonText, setImportJsonText] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);

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
          {passwordChanged && !actionData?.passError && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
              পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে! অন্য সব ডিভাইস থেকে লগআউট হয়ে
              গেছে।
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

      <BackupSnapshotsCard
        snapshots={snapshots}
        todaySnapshot={todaySnapshot}
        actionData={actionData}
        useBengaliDigits={useBengaliDigits}
      />

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
              href="/settings/export"
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
                type="hidden"
                name="replaceExisting"
                value={String(replaceExisting)}
              />

              <input
                type="file"
                accept=".json"
                onChange={handleFileUpload}
                className="block w-full text-xs text-slate-400 file:mr-4 file:py-2 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-slate-200 hover:file:bg-slate-700"
              />

              <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={replaceExisting}
                  onChange={(e) => setReplaceExisting(e.target.checked)}
                  className="mt-0.5 rounded text-purple-500 focus:ring-purple-500 bg-slate-800 border-slate-700"
                />
                <span>
                  ইম্পোর্টের আগে আমার বর্তমান সব ডেটা মুছে ফেলুন
                  <span className="block text-slate-500 mt-0.5">
                    টিক না দিলে ডেটা যুক্ত হবে (একই ব্যাকআপ দুইবার ইম্পোর্ট করলে
                    ডুপ্লিকেট তৈরি হবে)। ইম্পোর্টের আগে বর্তমান ডেটার একটি
                    ব্যাকআপ স্বয়ংক্রিয়ভাবে রাখা হয়।
                  </span>
                </span>
              </label>

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
