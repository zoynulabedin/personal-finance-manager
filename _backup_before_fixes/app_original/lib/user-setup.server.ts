import { prisma } from "./db.server";

export async function provisionNewUserDefaults(userId: string) {
  // 1. Create Default Expense Categories for new user
  const categoriesData = [
    { name: "🍚 বাজার", icon: "shopping-bag", color: "#10b981" },
    { name: "🏠 বাসা ভাড়া", icon: "home", color: "#3b82f6" },
    { name: "⚡ বিদ্যুৎ বিল", icon: "zap", color: "#f59e0b" },
    { name: "💧 পানির বিল", icon: "droplet", color: "#06b6d4" },
    { name: "🔥 গ্যাস বিল", icon: "flame", color: "#ef4444" },
    { name: "📶 ইন্টারনেট", icon: "wifi", color: "#6366f1" },
    { name: "📱 মোবাইল রিচার্জ", icon: "smartphone", color: "#8b5cf6" },
    { name: "🚗 যাতায়াত", icon: "car", color: "#ec4899" },
    { name: "🍔 খাবার", icon: "utensils", color: "#f97316" },
    { name: "🏥 চিকিৎসা", icon: "activity", color: "#14b8a6" },
    { name: "🎓 শিক্ষা", icon: "book-open", color: "#3b82f6" },
    { name: "👕 পোশাক", icon: "shirt", color: "#a855f7" },
    { name: "🎁 উপহার", icon: "gift", color: "#f43f5e" },
    { name: "💰 দান", icon: "heart", color: "#10b981" },
    { name: "👶 সন্তান", icon: "baby", color: "#06b6d4" },
    { name: "🛠 মেরামত", icon: "wrench", color: "#64748b" },
    { name: "🛒 শপিং", icon: "shopping-cart", color: "#d946ef" },
    { name: "📦 অন্যান্য", icon: "box", color: "#94a3b8" },
  ];

  await Promise.all(
    categoriesData.map((cat) =>
      prisma.category.create({
        data: {
          ...cat,
          userId,
        },
      })
    )
  );

  // 2. Create Default Cash Wallet for new user
  await prisma.bankAccount.create({
    data: {
      userId,
      bankName: "Cash",
      accountName: "নগদ টাকা (Wallet)",
      accountNumber: "CASH-001",
      currentBalance: 0,
      note: "Physical cash in wallet",
    },
  });
}
