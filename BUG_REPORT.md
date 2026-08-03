# Bug Report — Personal Family Finance Manager

**Scope:** full read of `app/` (routes, lib, components, utils), `prisma/schema.prisma`, `prisma/seed.ts`, `Dockerfile`, `package.json`, `.gitignore`, `.dockerignore`.
**Stack as built:** React Router v8 (framework mode) + Prisma 6 + SQLite + bcryptjs.
**Date:** 03 Aug 2026

Severity key: **P0** = data loss / cross-user exposure / won't deploy · **P1** = wrong money · **P2** = broken feature or crash · **P3** = quality

---

## P0 — Security & data integrity

### 1. Expense create/update accepts any `categoryId` / `bankAccountId` (cross-user IDOR)
`app/routes/expenses.tsx:113-138` (create), `:162-184` (update)

`categoryId` and `bankAccountId` come straight off the form and are written to the row with no ownership check. Everything else in the file is correctly scoped by `userId`, so this stands out as an oversight rather than intent.

The deduction path *does* check ownership (`:142`), but the **stored foreign key does not** — so the check only protects the balance, not the reference.

**Failure:** User A posts to `/expenses` with User B's `bankAccountId`. The row saves. The loader (`:75-79`) does `include: { category: true, bankAccount: true }`, and the table renders `item.bankAccount.bankName` (`:371`) and `item.category.name` (`:363`). A now reads B's private account and category names. Same via `categoryId`.

**Fix:** validate before write.

```ts
const cat = await prisma.category.findFirst({
  where: { id: categoryId, OR: [{ userId }, { userId: null }] },
  select: { id: true },
});
if (!cat) return { error: "অবৈধ ক্যাটাগরি।" };

let safeBankId: string | null = null;
if (bankAccountId) {
  const bank = await prisma.bankAccount.findFirst({
    where: { id: bankAccountId, userId }, select: { id: true },
  });
  if (!bank) return { error: "অবৈধ ব্যাংক একাউন্ট।" };
  safeBankId = bank.id;
}
```

### 2. Backup import can steal (or destroy) another user's records
`app/routes/settings.tsx:112-246`

Every restore is `prisma.<model>.upsert({ where: { id }, update: { ..., userId }, create: { ... } })` with **no check that the id belongs to the caller**. The `update` branch fires whenever the id already exists — for *any* user.

**Failure:** craft a backup JSON containing `{"incomes":[{"id":"<victim-uuid>","title":"x","amount":0,...}]}` and import it. The victim's income row is rewritten and reassigned to your `userId`. It vanishes from their account and appears in yours. UUIDs make this hard to guess blind, but ids leak through the bug in #1, through shared exports, and through anyone who has ever seen a backup file.

Three more problems in the same block:

- **Donations are silently dropped.** Export includes them (`:21-24`, `include: { donations: true }`); import never restores them. Export → wipe → restore loses the entire donation ledger, including paid/unpaid state.
- **Not atomic.** No `prisma.$transaction`. A failure halfway through leaves categories restored and expenses missing.
- **FK failures are swallowed.** An expense whose `categoryId` no longer exists throws P2003, caught at `:243`, reported to the user as "select a valid backup JSON file" — a misleading message for a valid file.

**Fix:** ignore incoming ids entirely (generate fresh ones, remap FKs through an old-id → new-id map), or filter each upsert with a preflight `findFirst({ where: { id, userId } })`. Wrap the whole thing in `$transaction`. Restore donations.

### 3. Session secret falls back to a hardcoded constant
`app/lib/auth.server.ts:4`

```ts
const sessionSecret = process.env.SESSION_SECRET || "default-secret-key-12345";
```

If `SESSION_SECRET` is unset in production the app boots happily and signs cookies with a value that is in the repo. Anyone can then mint `{userId: "<any uuid>"}` and log in as any user. Silent fallbacks like this are exactly the kind that survive to production.

**Fix:**
```ts
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) throw new Error("SESSION_SECRET must be set");
```

### 4. `.env` and `prisma/dev.db` get baked into the Docker image
`.dockerignore` (contents: `.react-router`, `build`, `node_modules`, `README.md`) · `Dockerfile:2` and `:12` (`COPY . /app`)

`.env` is correctly in `.gitignore` but **not** in `.dockerignore`, so `COPY . /app` writes your real `SESSION_SECRET` and `DATABASE_URL` into an image layer. `prisma/dev.db` rides along too — every user row, every bcrypt hash, every transaction. Layers persist even if a later step deletes the file.

**Fix:** add `.env`, `.env.*`, `*.db`, `prisma/*.db`, `.git` to `.dockerignore`.

### 5. `/logout` responds to GET — cross-site logout
`app/routes/logout.tsx:8-10`

The route exports a `loader` as well as an `action`, so a plain GET destroys the session. Any third-party page can embed `<img src="https://yourapp/logout">` and log the user out. State change on GET also means a link prefetcher or scanner can do it accidentally.

**Fix:** drop the loader (or have it `redirect("/")`); keep logout POST-only, as the Sidebar form already does (`Sidebar.tsx:126`).

### 6. Seeding wipes every user's data
`prisma/seed.ts:25-30`

```ts
await prisma.expense.deleteMany({});
await prisma.donation.deleteMany({});
await prisma.income.deleteMany({});
await prisma.bill.deleteMany({});
await prisma.bankAccount.deleteMany({});
await prisma.category.deleteMany({});
```

Unscoped deletes, while the user above is a non-destructive `upsert`. The app is now multi-user (`/register` is open), so one `npm run seed` against a live DB destroys everyone's records, not just the demo account's.

**Fix:** scope every delete to the seed user's id, or guard the whole script on `NODE_ENV !== "production"`.

### 7. Demo admin credentials hardcoded as the login form's initial state
`app/routes/login.tsx:48-49`

```ts
const [email, setEmail] = useState("admin@family.com");
const [password, setPassword] = useState("password123");
```

Not just a placeholder — these are the seeded credentials (`prisma/seed.ts:10,18`), pre-filled in a real password input on every page load, and printed again at `:162`.

### 8. Password change is weaker than registration
`app/routes/settings.tsx:82-110`

Register enforces ≥6 characters (`register.tsx:33`); the change-password path enforces nothing, so `"a"` is accepted. It also doesn't invalidate other sessions — after a "my account was compromised" password reset, the attacker's 30-day cookie still works.

---

## P1 — Money is wrong

### 9. Editing or deleting an expense never adjusts the bank balance
`app/routes/expenses.tsx:154-160` (delete), `:162-187` (update) vs `:141-149` (create)

Create optionally deducts from the account. Nothing reverses it.

**Failure:** add a ৳5,000 expense on the Cash wallet with deduct checked → balance 10,000 → 5,000. Fix the typo to ৳500 → balance stays 5,000; it should be 9,500. Delete the expense entirely → balance still 5,000. Every correction permanently desyncs the ledger, and the dashboard's bank/cash cards inherit the drift.

Changing `bankAccountId` on edit has the same hole — money is deducted from the old account and never moved.

**Fix:** in a transaction, reverse the old effect and apply the new one. Store an explicit `balanceApplied: Boolean` (or a small ledger table) on `Expense` so you know whether a deduction ever happened.

### 10. Income edit/delete leaves paid donations' deductions stranded
`app/routes/income.tsx:86-99` (update), `:72` (delete) · `app/routes/donations.tsx:81-92`

`pay_donation` debits the chosen account by `donation.amount`. Then:

- **Edit income upward:** `:92-98` overwrites the donation amount unconditionally, even when `paid: true`. Income 10,000 → donation 100 paid, account debited 100. Edit income to 50,000 → donation row now says 500, account was only ever debited 100. The Donations page shows ৳500 "paid" that was never paid.
- **Delete income:** `deleteMany` at `:72` cascades the donation away (`schema.prisma:42`). If it was paid, the 100 stays debited with no record explaining it.

**Fix:** refuse to mutate a paid donation (or reverse the balance first, then recompute and re-mark unpaid). On income delete, restore the balance for any paid donation before the cascade.

### 11. Balance updates are read-modify-write, not atomic
`app/routes/donations.tsx:82-92` and `:107-118` · `app/routes/expenses.tsx:142-148`

```ts
const bank = await prisma.bankAccount.findFirst(...);
await prisma.bankAccount.update({
  data: { currentBalance: bank.currentBalance - donation.amount },
});
```

Two concurrent submits both read 10,000 and both write 9,500 — one deduction is lost. Two tabs, or a double-click, is enough.

**Fix:** `data: { currentBalance: { decrement: amount } }` inside `prisma.$transaction`.

Related: `pay_donation` re-checks `!donation.paid` (`:70`) but the check and the update aren't in a transaction, so a double-submit can double-debit.

### 12. Dashboard splits cash from bank by string comparison
`app/routes/dashboard.tsx:82-87`

```ts
.filter((b) => b.bankName !== "Cash")     // bank total
const cashAccount = bankAccounts.find((b) => b.bankName === "Cash");  // cash total
```

`find` returns **one** account. Two cash wallets → the second one's balance appears in neither card. Money silently disappears from the dashboard while `/bank-accounts` shows the correct total.

The add-account form actively encourages this: its placeholder is `"যেমন: Dutch Bangla, bKash, Nagad, Cash"` (`bank-accounts.tsx:331`). A real bank named "Cash" is also misclassified.

**Fix:** add `type: "CASH" | "BANK"` (or `isCash: Boolean`) to `BankAccount` and filter on that; sum with `reduce`, not `find`.

### 13. Reports compute donations from income instead of reading donation rows
`app/routes/reports.tsx:30`, `:64`, `:80`

```ts
const totalMonthlyDonation = totalMonthlyIncome * 0.01;
```

Reports never query the `Donation` table. So they ignore `percentage`, ignore paid/unpaid, and ignore any manual correction — and disagree with `/donations`, which sums the real rows (`donations.tsx:40-42`). Two screens, two numbers, no way to tell which is right.

**Fix:** `prisma.donation.aggregate({ _sum: { amount: true }, where: { income: { userId, month, year } } })`.

### 14. `Donation.percentage` is stored but never read
`schema.prisma:43` · `income.tsx:56`, `:92` · `reports.tsx:30`

Written as `1.0`, then every consumer hardcodes `* 0.01`. Change the percentage in the DB and nothing moves. Either use it (`amount * (d.percentage / 100)`) or drop the column.

### 15. Dashboard mixes month-scoped and lifetime figures in one row
`app/routes/dashboard.tsx:90-96`

Cards 1-3 are current-month (`:50-66`). Card 4, sitting in the same grid, shows `totalDonationAmount` and `pendingDonationAmount` for **all time**. Reads as "this month's donation" and isn't. `agent.md:340` specifies current-month.

### 16. `Float` for currency
`schema.prisma:31, 44, 59, 85, 98`

Binary floats can't represent 0.1 exactly; 1% donations produce long tails and sums drift over thousands of rows. Money should be `Decimal`, or integer paisa. On SQLite `Decimal` maps to a real, so integer paisa is the safer choice here.

---

## P2 — Broken features & crashes

### 17. The Donations month/year filter does nothing
`app/routes/donations.tsx:28-42`

The filter form (`:170-195`) drives `selectedMonth`/`selectedYear`, which are used **only** for the auto-1% summary card. The list query at `:28` has no month/year filter, and `paidDonations`/`pendingDonations` (`:41-42`) are lifetime totals — yet they render immediately beside the month-labeled card (`:213-226`). Change the month and only one number on the page moves.

**Fix:** filter through the relation — `where: { income: { userId, month: selectedMonth, year: selectedYear } }` — and derive the totals from the filtered set.

### 18. Expense filters reset each other
`app/routes/expenses.tsx:251-320`

The preset lives on submit buttons (`:263-276`), so `preset` is only in the query string when a preset button is the submitter. The category and payment-method selects call `e.target.form?.submit()` (`:295`, `:310`), which submits without a submitter — `preset` drops out, the loader falls back to `"this_month"` (`:24`), and the user's "This year" selection silently reverts.

**Fix:** add `<input type="hidden" name="preset" value={filterPreset} />` to the form and drive presets by setting that value.

### 19. `?month=abc` sends NaN into a Prisma Int filter
`income.tsx:13-14` · `donations.tsx:15-16` · `reports.tsx:13-14`

```ts
parseInt(url.searchParams.get("month") || String(new Date().getMonth() + 1))
```

The `||` only catches a *missing* param. `?month=abc` → `parseInt("abc")` → `NaN`, straight into `where: { month }`. Out-of-range values are just as bad: `?month=99` renders `BENGALI_MONTHS[98]` → `undefined` in the heading (`income.tsx:182`, `reports.tsx:171`).

**Fix:**
```ts
const raw = Number(url.searchParams.get("month"));
const selectedMonth = Number.isInteger(raw) && raw >= 1 && raw <= 12
  ? raw : new Date().getMonth() + 1;
```

### 20. NaN slips past every amount guard
`income.tsx:34,39` · `expenses.tsx:112,120` · `bills.tsx:32,36` · `bank-accounts.tsx:32,79`

`parseFloat("abc")` is `NaN`, and **`NaN <= 0` is `false`** — so `if (!title || amount <= 0)` lets it through. Likewise `amount > 0` is `false`, so the update branches silently no-op instead of reporting an error. `<input type="number">` blocks this in the browser; a direct POST doesn't.

**Fix:** `if (!Number.isFinite(amount) || amount <= 0) return { error: ... }`.

### 21. Invalid dates reach Prisma
`bills.tsx:45`, `:91` · `expenses.tsx:124`, `:181`

`new Date(dateInput)` with junk input yields `Invalid Date`, which Prisma rejects at write time — a 500 rendered through the generic ErrorBoundary rather than a field-level message. Validate with `Number.isNaN(d.getTime())`.

### 22. Category edit/delete silently no-ops on shared categories
`app/routes/categories.tsx:13-21`, `:59`, `:70`

The loader deliberately includes global categories (`userId: null`), but `updateMany`/`deleteMany` filter on `{ id, userId }` — so those rows match nothing. The card still renders enabled edit and delete buttons (`:154-176`); clicking either redirects with no change and no message. (Provisioning creates per-user categories, so this bites on seeded/legacy `userId: null` rows.)

**Fix:** either hide the controls when `cat.userId === null`, or return an explicit error.

### 23. `last_7_days` excludes today until 06:00 local
`app/routes/expenses.tsx:42-46`

The date input produces `"2026-08-03"`, and `new Date("2026-08-03")` parses as **UTC** midnight — which in Asia/Dhaka (UTC+6) is 06:00 on the 3rd. But `endDate = now`. So between 00:00 and 06:00 local, an expense you just dated today sits *after* the range's upper bound and doesn't appear.

The other presets build boundaries in local time (`new Date(y, m, d)`), so the app mixes two time bases. In a negative-offset timezone the same mismatch shifts entries a full day backward and breaks the month-boundary presets.

Also: `startDate` for this preset keeps the current clock time, making it a rolling 7×24h window while every neighbouring preset is calendar-day based.

**Fix:** parse date inputs as local (`new Date(y, m-1, d)` from split parts) or normalize everything to UTC; set `endDate` to end-of-today, not `now`.

### 24. Bills page ignores dates entirely
`app/routes/bills.tsx:13-22`

Called "মাসিক বিল" and specced for upcoming/monthly (`agent.md:279-293`), but the query has no date filter and the three summary cards are lifetime totals. Every bill ever created accumulates on one screen.

### 25. `Expense.category` has no `onDelete`, so category deletes can 500
`schema.prisma:82-83`

A required relation defaults to `Restrict`. The delete guard at `categories.tsx:55` only counts **the current user's** expenses, so a category referenced by someone else's expense passes the guard and then throws P2003 — an unhandled 500. Reachable on legacy shared categories.

---

## P3 — Deployment, performance, consistency

### 26. The Docker image cannot start
`Dockerfile`

Three separate breaks:

1. `npm ci` never triggers `prisma generate` — `package.json` has no `postinstall`. `@prisma/client` stays an un-generated stub, so `npm run build` (`:15`) fails or produces a runtime-broken bundle.
2. The final stage (`:17-22`) copies `package.json`, `node_modules`, and `build` — but **not** `prisma/`. No schema, no SQLite file at runtime.
3. Nothing runs migrations, and `prisma/migrations/` doesn't exist at all (the DB was made with `db push`). There's no reproducible path from empty database to working schema.

Also missing: `EXPOSE`, a non-root `USER`, and any `DATABASE_URL` default.

### 27. Sequential N+1 loops in the two heaviest pages
`reports.tsx:51-78` · `dashboard.tsx:126-164`

Reports awaits 12 iterations × 2 `findMany` calls = **24 serial round-trips** per page load, then sums in JS. Dashboard does 12. Both should be single `groupBy` queries:

```ts
await prisma.expense.groupBy({
  by: ["categoryId"], where: { userId, date: { gte, lte } }, _sum: { amount: true },
});
```

### 28. No indexes anywhere
`schema.prisma`

Every query filters on `userId` plus a date or month/year, and there isn't a single `@@index`. SQLite will table-scan.

```prisma
@@index([userId, date])              // Expense
@@index([userId, year, month])       // Income
@@index([userId, paid, dueDate])     // Bill
```

### 29. Floating promise on connect
`app/lib/db.server.ts:16` — `prisma.$connect()` is never awaited and has no `.catch()`. A connection failure surfaces as an unhandled rejection instead of a startup error.

### 30. Docs contradict the code
- `README.md:3,45` and `agent.md` say **PostgreSQL**; `schema.prisma:8` is **SQLite**.
- `agent.md:11,50-56` says **single user, no registration**; `/register` is a public open sign-up (`routes.ts:5`).
- `agent.md:633` claims **CSRF protection**; there is none (see #5).
- `agent.md:35` lists **Shadcn UI**; not installed.

### 31. Smaller items
- `income.tsx:93` uses `findFirst` for the donation with no `orderBy` — non-deterministic if an income ever has more than one.
- `settings.tsx:66` checks email uniqueness with a read-then-write; two concurrent updates can race past it. Catch P2002 instead.
- `revert_donation` (`donations.tsx:107-118`) silently drops the refund if the account was deleted (`onDelete: SetNull`, `schema.prisma:48`).
- `expenses.tsx:2` and `income.tsx:2` import `useNavigation` without using it.
- `bank-accounts.tsx:212` and `expenses.tsx:395` use `confirm()` inside `onSubmit` — blocking, unstyled, and suppressed by some browsers after repeated use.
- `settings.tsx:255` casts loader data with `as any` to work around the union return type (`{user}` vs `Response`). Splitting export onto its own resource route would restore type safety.

---

## Suggested order

1. **#1, #2, #3, #4** — cross-user exposure and leaked secrets.
2. **#9, #10, #11** — the ledger is currently unreliable after any edit or delete.
3. **#26** — nothing ships until the image builds.
4. **#17, #18, #19, #20** — visibly broken UI paths.
5. Everything else.
