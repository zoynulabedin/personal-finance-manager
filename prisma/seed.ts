import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { DEFAULT_CATEGORIES } from "../app/lib/user-setup.server";

const prisma = new PrismaClient();

/** Parse YYYY-MM-DD as local midnight, matching how the app stores dates. */
function localDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function main() {
  // Every delete below is scoped to the demo account, but seeding a live
  // database is still almost never what you want.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PROD_SEED !== "true"
  ) {
    throw new Error(
      "Refusing to seed with NODE_ENV=production. Set ALLOW_PROD_SEED=true if you really mean it."
    );
  }

  console.log("Seeding demo account...");

  const hashedPassword = await bcrypt.hash(
    process.env.SEED_PASSWORD || "DemoPassword123",
    12
  );

  const user = await prisma.user.upsert({
    where: { email: "admin@family.com" },
    update: {
      password: hashedPassword,
      // Re-seeding changes the password, so old sessions must not survive.
      sessionVersion: { increment: 1 },
    },
    create: {
      name: "পরিবার প্রধান",
      email: "admin@family.com",
      password: hashedPassword,
    },
  });
  console.log("Admin user ready:", user.email);

  // Scoped to the demo user only. These used to be unscoped deleteMany({})
  // calls, so one seed run wiped every account's data.
  const scope = { where: { userId: user.id } };
  await prisma.ledgerEntry.deleteMany(scope);
  await prisma.bill.deleteMany(scope);
  await prisma.expense.deleteMany(scope);
  await prisma.income.deleteMany(scope); // cascades donations
  await prisma.bankAccount.deleteMany(scope);
  await prisma.category.deleteMany(scope);

  // --------------------------------------------------------------- categories
  await prisma.category.createMany({
    data: DEFAULT_CATEGORIES.map((cat) => ({ ...cat, userId: user.id })),
  });
  const categories = await prisma.category.findMany({
    where: { userId: user.id },
  });
  console.log(`Created ${categories.length} categories.`);

  const categoryNamed = (fragment: string) =>
    categories.find((c) => c.name.includes(fragment)) ?? categories[0];

  /** Mirrors app/lib/ledger.server.ts: entry and cached balance together. */
  async function post(params: {
    bankAccountId: string;
    amount: number;
    type: string;
    description: string;
    occurredAt: Date;
    incomeId?: string;
    expenseId?: string;
    donationId?: string;
  }) {
    const amount = round(params.amount);
    if (amount === 0) return;

    await prisma.ledgerEntry.create({
      data: {
        userId: user.id,
        bankAccountId: params.bankAccountId,
        amount,
        type: params.type,
        description: params.description,
        occurredAt: params.occurredAt,
        incomeId: params.incomeId ?? null,
        expenseId: params.expenseId ?? null,
        donationId: params.donationId ?? null,
      },
    });

    await prisma.bankAccount.update({
      where: { id: params.bankAccountId },
      data: { currentBalance: { increment: amount } },
    });
  }

  // ----------------------------------------------------------------- accounts
  //
  // Accounts open at zero and receive an OPENING ledger entry, so the running
  // balance on the statement page adds up from the very first row.
  async function createAccount(data: {
    bankName: string;
    accountName: string;
    accountNumber: string;
    opening: number;
    isCash?: boolean;
    note?: string;
  }) {
    const account = await prisma.bankAccount.create({
      data: {
        userId: user.id,
        bankName: data.bankName,
        accountName: data.accountName,
        accountNumber: data.accountNumber,
        currentBalance: 0,
        isCash: data.isCash ?? false,
        note: data.note,
      },
    });

    await post({
      bankAccountId: account.id,
      amount: data.opening,
      type: "OPENING",
      description: "প্রারম্ভিক ব্যালেন্স",
      occurredAt: localDate("2026-07-31"),
    });

    return account;
  }

  const dbbl = await createAccount({
    bankName: "Dutch Bangla Bank",
    accountName: "Main Savings Account",
    accountNumber: "123.456.7890",
    opening: 145000,
    note: "Primary salary account",
  });

  await createAccount({
    bankName: "Islami Bank",
    accountName: "Family Reserve Account",
    accountNumber: "2050-11223344",
    opening: 85000,
    note: "Emergency fund",
  });

  const bkash = await createAccount({
    bankName: "bKash",
    accountName: "Personal bKash",
    accountNumber: "01700000000",
    opening: 12500,
    note: "Mobile wallet",
  });

  const nagad = await createAccount({
    bankName: "Nagad",
    accountName: "Personal Nagad",
    accountNumber: "01800000000",
    opening: 8500,
    note: "Mobile wallet",
  });

  const cash = await createAccount({
    bankName: "Cash",
    accountName: "নগদ টাকা (Wallet)",
    accountNumber: "CASH-001",
    opening: 15000,
    isCash: true,
    note: "Physical cash in wallet/home drawer",
  });
  console.log("Created bank accounts with opening balances.");

  // ------------------------------------------------------- income + donations
  async function createIncome(data: {
    title: string;
    amount: number;
    month: number;
    year: number;
    receivedAt: Date;
    accountId: string;
    note?: string;
    donationPaidFrom?: string;
  }) {
    const income = await prisma.income.create({
      data: {
        userId: user.id,
        title: data.title,
        amount: data.amount,
        month: data.month,
        year: data.year,
        note: data.note,
        bankAccountId: data.accountId,
        receivedAt: data.receivedAt,
      },
    });

    await post({
      bankAccountId: data.accountId,
      amount: data.amount,
      type: "INCOME",
      description: `আয়: ${data.title}`,
      occurredAt: data.receivedAt,
      incomeId: income.id,
    });

    const donationAmount = round(data.amount * 0.01);
    const donation = await prisma.donation.create({
      data: {
        incomeId: income.id,
        percentage: 1.0,
        amount: donationAmount,
        paid: Boolean(data.donationPaidFrom),
        paidDate: data.donationPaidFrom ? localDate("2026-08-02") : null,
        bankAccountId: data.donationPaidFrom ?? null,
      },
    });

    if (data.donationPaidFrom) {
      await post({
        bankAccountId: data.donationPaidFrom,
        amount: -donationAmount,
        type: "DONATION",
        description: `১% দান: ${data.title}`,
        occurredAt: localDate("2026-08-02"),
        donationId: donation.id,
      });
    }

    return income;
  }

  await createIncome({
    title: "মাসিক বেতন (Aug 2026)",
    amount: 120000,
    month: 8,
    year: 2026,
    receivedAt: localDate("2026-08-01"),
    accountId: dbbl.id,
    note: "Company monthly salary transfer",
    donationPaidFrom: dbbl.id,
  });

  await createIncome({
    title: "ফ্রিল্যান্স সার্ভিস ফি",
    amount: 35000,
    month: 8,
    year: 2026,
    receivedAt: localDate("2026-08-02"),
    accountId: bkash.id,
    note: "Web design consulting project",
  });
  console.log("Created incomes and 1% donations.");

  // ----------------------------------------------------------------- expenses
  async function createExpense(data: {
    title: string;
    amount: number;
    date: Date;
    categoryId: string;
    paymentMethod: string;
    accountId: string;
    note?: string;
  }) {
    const expense = await prisma.expense.create({
      data: {
        userId: user.id,
        title: data.title,
        amount: data.amount,
        date: data.date,
        categoryId: data.categoryId,
        paymentMethod: data.paymentMethod,
        bankAccountId: data.accountId,
        note: data.note,
      },
    });

    await post({
      bankAccountId: data.accountId,
      amount: -data.amount,
      type: "EXPENSE",
      description: `খরচ: ${data.title}`,
      occurredAt: data.date,
      expenseId: expense.id,
    });

    return expense;
  }

  await createExpense({
    title: "সাপ্তাহিক কাঁচা বাজার ও মাছ",
    amount: 3450,
    date: localDate("2026-08-01"),
    categoryId: categoryNamed("বাজার").id,
    paymentMethod: "Cash",
    accountId: cash.id,
    note: "মাছ, মাংস, শাক-সবজি",
  });

  await createExpense({
    title: "রেস্টুরেন্ট ডিনার (পরিবার সহ)",
    amount: 2200,
    date: localDate("2026-08-02"),
    categoryId: categoryNamed("খাবার").id,
    paymentMethod: "bKash",
    accountId: bkash.id,
  });

  await createExpense({
    title: "মোবাইল রিচার্জ (রবি ও জিপি)",
    amount: 800,
    date: localDate("2026-08-02"),
    categoryId: categoryNamed("মোবাইল").id,
    paymentMethod: "bKash",
    accountId: bkash.id,
  });

  await createExpense({
    title: "উবার ভাড়া (অফিস যাতায়াত)",
    amount: 550,
    date: localDate("2026-08-03"),
    categoryId: categoryNamed("যাতায়াত").id,
    paymentMethod: "Nagad",
    accountId: nagad.id,
  });

  await createExpense({
    title: "ডাক্তারের ফি ও ওষুধ",
    amount: 1750,
    date: localDate("2026-08-03"),
    categoryId: categoryNamed("চিকিৎসা").id,
    paymentMethod: "Bank",
    accountId: dbbl.id,
  });
  console.log("Created sample expenses.");

  // -------------------------------------------------------------------- bills
  await prisma.bill.createMany({
    data: [
      {
        userId: user.id,
        title: "বাসা ভাড়া (August)",
        amount: 25000,
        dueDate: localDate("2026-08-10"),
        paid: false,
        note: "Landlord BKash / DBBL",
      },
      {
        userId: user.id,
        title: "বিদ্যুৎ বিল (DESCO)",
        amount: 3450,
        dueDate: localDate("2026-08-15"),
        paid: false,
        note: "Prepaid card / Postpaid bill",
      },
      {
        userId: user.id,
        title: "গ্যাস বিল",
        amount: 1080,
        dueDate: localDate("2026-08-20"),
        paid: false,
      },
      {
        userId: user.id,
        title: "স্কুল ফি (বাচ্চা)",
        amount: 5500,
        dueDate: localDate("2026-08-12"),
        paid: false,
      },
    ],
  });

  // A paid bill is an expense plus a ledger entry, linked back to the bill —
  // the same thing the app does when you press "পে করা হয়েছে".
  const internetBill = await prisma.bill.create({
    data: {
      userId: user.id,
      title: "ইন্টারনেট বিল (Carnival)",
      amount: 1200,
      dueDate: localDate("2026-08-05"),
      paid: false,
      note: "Optic fiber connection",
    },
  });

  const internetExpense = await createExpense({
    title: internetBill.title,
    amount: internetBill.amount,
    date: localDate("2026-08-01"),
    categoryId: categoryNamed("ইন্টারনেট").id,
    paymentMethod: "bKash",
    accountId: bkash.id,
    note: internetBill.note ?? undefined,
  });

  await prisma.bill.update({
    where: { id: internetBill.id },
    data: {
      paid: true,
      paidDate: localDate("2026-08-01"),
      expenseId: internetExpense.id,
    },
  });
  console.log("Created monthly bills.");

  // ------------------------------------------------------------------ verify
  const accounts = await prisma.bankAccount.findMany({
    where: { userId: user.id },
  });
  const sums = await prisma.ledgerEntry.groupBy({
    by: ["bankAccountId"],
    where: { userId: user.id },
    _sum: { amount: true },
  });
  const computed = new Map(
    sums.map((row) => [row.bankAccountId, round(row._sum.amount ?? 0)])
  );

  let allMatch = true;
  for (const account of accounts) {
    const expected = computed.get(account.id) ?? 0;
    const stored = round(account.currentBalance);
    const ok = Math.abs(expected - stored) < 0.005;
    if (!ok) allMatch = false;
    console.log(
      `  ${ok ? "OK " : "BAD"} ${account.bankName.padEnd(20)} ${stored}` +
        (ok ? "" : ` (ledger says ${expected})`)
    );
  }
  if (!allMatch) throw new Error("Seeded balances do not match the ledger.");

  console.log("Seeding finished — all balances reconcile with the ledger.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
