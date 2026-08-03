import { useState } from "react";
import {
  Form,
  useLoaderData,
  useOutletContext,
  useActionData,
  redirect,
} from "react-router";
import type { Route } from "./+types/categories";
import { prisma } from "../lib/db.server";
import { requireUserId } from "../lib/auth.server";
import { parseText } from "../lib/validation.server";
import type { LayoutContextType } from "./layout";
import { toBengaliDigits } from "../utils/bengali";
import { Tags, Plus, Edit, Trash2, X } from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);

  const categories = await prisma.category.findMany({
    where: { OR: [{ userId }, { userId: null }] },
    include: {
      _count: {
        select: { expenses: { where: { userId } } },
      },
    },
    orderBy: { name: "asc" },
  });

  return {
    // `isOwn` drives the UI: shared (userId: null) rows can't be edited or
    // deleted by anyone, and the buttons used to render anyway and no-op.
    categories: categories.map((cat) => ({ ...cat, isOwn: cat.userId === userId })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("_intent")?.toString();

  if (intent === "create") {
    const name = parseText(formData.get("name"));
    const color = parseText(formData.get("color")) ?? "#10b981";

    if (!name) {
      return { error: "ক্যাটাগরির নাম আবশ্যক।" };
    }

    await prisma.category.create({
      data: { userId, name, color, type: "EXPENSE" },
    });

    return redirect("/categories");
  }

  if (intent === "delete") {
    const id = formData.get("id")?.toString();
    if (!id) return { error: "অবৈধ অনুরোধ।" };

    const category = await prisma.category.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!category) {
      return {
        error: "শুধুমাত্র নিজের তৈরি করা ক্যাটাগরি মুছে ফেলা যায়।",
      };
    }

    // Count across all users: the relation is Restrict, so a row referenced by
    // anyone would otherwise throw a foreign-key error straight to the
    // error boundary.
    const count = await prisma.expense.count({ where: { categoryId: id } });
    if (count > 0) {
      return { error: "এই ক্যাটাগরিতে খরচ যুক্ত রয়েছে, তাই মুছে ফেলা সম্ভব নয়।" };
    }

    await prisma.category.delete({ where: { id: category.id } });
    return redirect("/categories");
  }

  if (intent === "update") {
    const id = formData.get("id")?.toString();
    const name = parseText(formData.get("name"));
    const color = parseText(formData.get("color")) ?? "#10b981";

    if (!id) return { error: "অবৈধ অনুরোধ।" };
    if (!name) return { error: "ক্যাটাগরির নাম আবশ্যক।" };

    const updated = await prisma.category.updateMany({
      where: { id, userId },
      data: { name, color },
    });

    if (updated.count === 0) {
      return {
        error: "শুধুমাত্র নিজের তৈরি করা ক্যাটাগরি সম্পাদনা করা যায়।",
      };
    }

    return redirect("/categories");
  }

  return null;
}

export default function CategoriesPage() {
  const { useBengaliDigits } = useOutletContext<LayoutContextType>();
  const { categories } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);

  const [name, setName] = useState("");
  const [color, setColor] = useState("#10b981");

  const colorOptions = [
    "#10b981", // Emerald
    "#3b82f6", // Blue
    "#f59e0b", // Amber
    "#ef4444", // Red
    "#8b5cf6", // Purple
    "#ec4899", // Pink
    "#06b6d4", // Cyan
    "#f97316", // Orange
    "#14b8a6", // Teal
    "#64748b", // Slate
  ];

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="glass-card p-6 rounded-2xl border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Tags className="w-6 h-6 text-purple-400" />
            <span>খরচের ক্যাটাগরি (Expense Categories)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            আপনার খরচের খাতসমূহ সংগঠিত করুন এবং নতুন ক্যাটাগরি তৈরি করুন
          </p>
        </div>

        <button
          onClick={() => {
            setName("");
            setColor("#10b981");
            setIsAddOpen(true);
          }}
          className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-medium text-xs sm:text-sm flex items-center gap-2 shadow-md shadow-purple-950/40"
        >
          <Plus className="w-4 h-4" />
          <span>নতুন ক্যাটাগরি যোগ করুন</span>
        </button>
      </div>

      {actionData?.error && (
        <div className="p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          {actionData.error}
        </div>
      )}

      {/* Categories Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {categories.map((cat) => (
          <div
            key={cat.id}
            className="glass-card p-4 rounded-2xl border border-slate-800 flex items-center justify-between hover:border-purple-500/40 transition"
          >
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-white shadow-sm shrink-0"
                style={{ backgroundColor: cat.color || "#10b981" }}
              >
                {cat.name.slice(0, 2)}
              </div>
              <div>
                <h3 className="font-bold text-slate-100 text-sm">{cat.name}</h3>
                <span className="text-[11px] text-slate-400">
                  {useBengaliDigits ? toBengaliDigits(cat._count.expenses) : cat._count.expenses}টি খরচ অন্তর্ভুক্ত
                </span>
              </div>
            </div>

            {cat.isOwn ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  setEditItem(cat);
                  setName(cat.name);
                  setColor(cat.color || "#10b981");
                }}
                className="p-1.5 rounded-lg text-slate-400 hover:text-purple-400 hover:bg-slate-800"
                title="সম্পাদনা"
              >
                <Edit className="w-4 h-4" />
              </button>
              <Form method="post" onSubmit={(e) => !confirm("মুছে ফেলতে চান?") && e.preventDefault()}>
                <input type="hidden" name="_intent" value="delete" />
                <input type="hidden" name="id" value={cat.id} />
                <button
                  type="submit"
                  disabled={cat._count.expenses > 0}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 disabled:opacity-30 disabled:hover:text-slate-400"
                  title={cat._count.expenses > 0 ? "খরচ যুক্ত থাকায় মোছা যাবে না" : "মুছে ফেলুন"}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </Form>
            </div>
            ) : (
              <span className="text-[10px] text-slate-500 px-2 py-1 rounded-lg bg-slate-800/60 border border-slate-700">
                ডিফল্ট
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Add / Edit Modal */}
      {(isAddOpen || editItem) && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="glass-panel w-full max-w-sm p-6 rounded-2xl border border-slate-800 shadow-2xl relative">
            <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-slate-100">
                {editItem ? "ক্যাটাগরি সম্পাদনা" : "নতুন ক্যাটাগরি"}
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
                  ক্যাটাগরির নাম (ইমোজি সহ) *
                </label>
                <input
                  type="text"
                  name="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="যেমন: 🍎 স্ন্যাকস, 🚕 ট্যাক্সি"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-purple-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  কালার নির্বাচন করুন
                </label>
                <div className="flex flex-wrap gap-2 pt-1">
                  {colorOptions.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      className={`w-7 h-7 rounded-full border-2 transition ${
                        color === c ? "scale-110 border-white shadow-md" : "border-transparent"
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                <input type="hidden" name="color" value={color} />
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
                  className="w-1/2 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold text-sm shadow-md"
                >
                  {editItem ? "আপডেট" : "সংরক্ষণ"}
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </div>
  );
}
