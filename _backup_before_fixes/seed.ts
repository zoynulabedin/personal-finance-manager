import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding multi-user database...");

  // 1. Create Default Admin User
  const hashedPassword = await bcrypt.hash("password123", 10);
  const user = await prisma.user.upsert({
    where: { email: "admin@family.com" },
    update: {
      password: hashedPassword,
    },
    create: {
      name: "পরিবার প্রধান",
      email: "admin@family.com",
      password: hashedPassword,
    },
  });
  console.log("Admin user ready:", user.email);

  // Clear existing records
  await prisma.expense.deleteMany({});
  await prisma.donation.deleteMany({});
  await prisma.income.deleteMany({});
  await prisma.bill.deleteMany({});
  await prisma.bankAccount.deleteMany({});
  await prisma.category.deleteMany({});

  // 2. Default Expense Categories
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

  const categories = await Promise.all(
    categoriesData.map((cat) =>
      prisma.category.create({
        data: {
          ...cat,
          userId: user.id,
        },
      })
    )
  );
  console.log(`Created ${categories.length} categories.`);

  // 3. Default Bank Accounts
  const dbbl = await prisma.bankAccount.create({
    data: {
      userId: user.id,
      bankName: "Dutch Bangla Bank",
      accountName: "Main Savings Account",
      accountNumber: "123.456.7890",
      currentBalance: 145000,
      note: "Primary salary account",
    },
  });

  const islamiBank = await prisma.bankAccount.create({
    data: {
      userId: user.id,
      bankName: "Islami Bank",
      accountName: "Family Reserve Account",
      accountNumber: "2050-11223344",
      currentBalance: 85000,
      note: "Emergency fund",
    },
  });

  const bkash = await prisma.bankAccount.create({
    data: {
      userId: user.id,
      bankName: "bKash",
      accountName: "Personal bKash",
      accountNumber: "01700000000",
      currentBalance: 12500,
      note: "Mobile wallet",
    },
  });

  const nagad = await prisma.bankAccount.create({
    data: {
      userId: user.id,
      bankName: "Nagad",
      accountName: "Personal Nagad",
      accountNumber: "01800000000",
      currentBalance: 8500,
      note: "Mobile wallet",
    },
  });

  const cash = await prisma.bankAccount.create({
    data: {
      userId: user.id,
      bankName: "Cash",
      accountName: "নগদ টাকা (Wallet)",
      accountNumber: "CASH-001",
      currentBalance: 15000,
      note: "Physical cash in wallet/home drawer",
    },
  });
  console.log("Created Bank Accounts.");

  // 4. Sample Incomes & Auto 1% Donations
  const salary = await prisma.income.create({
    data: {
      userId: user.id,
      title: "মাসিক বেতন (Aug 2026)",
      amount: 120000,
      month: 8,
      year: 2026,
      note: "Company monthly salary transfer",
      donations: {
        create: {
          percentage: 1.0,
          amount: 1200,
          paid: true,
          paidDate: new Date("2026-08-02"),
          bankAccountId: dbbl.id,
        },
      },
    },
  });

  const freelance = await prisma.income.create({
    data: {
      userId: user.id,
      title: "ফ্রিল্যান্স সার্ভিস ফি",
      amount: 35000,
      month: 8,
      year: 2026,
      note: "Web design consulting project",
      donations: {
        create: {
          percentage: 1.0,
          amount: 350,
          paid: false,
        },
      },
    },
  });
  console.log("Created Incomes and 1% Donations.");

  // 5. Monthly Bills
  await prisma.bill.createMany({
    data: [
      {
        userId: user.id,
        title: "বাসা ভাড়া (August)",
        amount: 25000,
        dueDate: new Date("2026-08-10"),
        paid: false,
        note: "Landlord BKash / DBBL",
      },
      {
        userId: user.id,
        title: "বিদ্যুৎ বিল (DESCO)",
        amount: 3450,
        dueDate: new Date("2026-08-15"),
        paid: false,
        note: "Prepaid card / Postpaid bill",
      },
      {
        userId: user.id,
        title: "ইন্টারনেট বিল (Carnival)",
        amount: 1200,
        dueDate: new Date("2026-08-05"),
        paid: true,
        paidDate: new Date("2026-08-01"),
        note: "Optic fiber connection",
      },
      {
        userId: user.id,
        title: "গ্যাস বিল",
        amount: 1080,
        dueDate: new Date("2026-08-20"),
        paid: false,
      },
      {
        userId: user.id,
        title: "স্কুল ফি (বাচ্চা)",
        amount: 5500,
        dueDate: new Date("2026-08-12"),
        paid: false,
      },
    ],
  });
  console.log("Created Monthly Bills.");

  // 6. Sample Expenses
  const bazarCat = categories.find((c) => c.name.includes("বাজার"));
  const foodCat = categories.find((c) => c.name.includes("খাবার"));
  const mobileCat = categories.find((c) => c.name.includes("মোবাইল"));
  const transportCat = categories.find((c) => c.name.includes("যাতায়াত"));
  const medicalCat = categories.find((c) => c.name.includes("চিকিৎসা"));

  await prisma.expense.createMany({
    data: [
      {
        userId: user.id,
        title: "সাপ্তাহিক কাঁচা বাজার ও মাছ",
        amount: 3450,
        date: new Date("2026-08-01"),
        categoryId: bazarCat?.id || categories[0].id,
        paymentMethod: "Cash",
        bankAccountId: cash.id,
        note: "মাছ, মাংস, শাক-সবজি",
      },
      {
        userId: user.id,
        title: "রেস্টুরেন্ট ডিনার (পরিবার সহ)",
        amount: 2200,
        date: new Date("2026-08-02"),
        categoryId: foodCat?.id || categories[8].id,
        paymentMethod: "bKash",
        bankAccountId: bkash.id,
      },
      {
        userId: user.id,
        title: "মোবাইল রিচার্জ (রবি ও জিপি)",
        amount: 800,
        date: new Date("2026-08-02"),
        categoryId: mobileCat?.id || categories[6].id,
        paymentMethod: "bKash",
        bankAccountId: bkash.id,
      },
      {
        userId: user.id,
        title: "উবার ভাড়া (অফিস যাতায়াত)",
        amount: 550,
        date: new Date("2026-08-03"),
        categoryId: transportCat?.id || categories[7].id,
        paymentMethod: "Nagad",
        bankAccountId: nagad.id,
      },
      {
        userId: user.id,
        title: "ডাক্তারের ফি ও ওষুধ",
        amount: 1750,
        date: new Date("2026-08-03"),
        categoryId: medicalCat?.id || categories[9].id,
        paymentMethod: "Bank",
        bankAccountId: dbbl.id,
      },
    ],
  });
  console.log("Created Sample Expenses.");

  console.log("Multi-user seeding finished successfully!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
