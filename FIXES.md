# Fixes Applied

All 31 findings from `BUG_REPORT.md` are resolved. Verified with `tsc --noEmit`,
a production `react-router build`, 32 end-to-end behavioural checks against a
running server, and a page-render pass over every route — plus a rehearsal of
the database migration on a copy of your real `dev.db`.

**Do this first:** run `npx prisma generate` in the project, then restart the
dev server. The Prisma client in `node_modules` still describes the old schema.

---

## What changed on your machine

- 27 source files updated or added (checksums verified byte-for-byte against
  the versions that passed the test suite).
- `prisma/dev.db` migrated in place. Row counts and money totals unchanged:
  6 accounts / ৳266,000, 5 expenses / ৳8,750, 2 incomes, 2 donations,
  36 categories, 5 bills.
- Original files and the pre-migration database saved to
  `_backup_before_fixes/`.
- Two throwaway files are in `_to_delete/` — delete that folder when you like.

## Two things that will look different

**Everyone has to log in again.** Session cookies now carry a version number,
which is what makes "change password → sign out other devices" work. Existing
cookies don't have it, so they're treated as stale. Passwords are unchanged.

**Old expenses won't refund on delete.** `balanceApplied` defaults to `false`
for the 5 existing expenses, so deleting one won't credit the account back. I
didn't guess which historical rows had actually been deducted — that's your
money, not a default I should pick. Every expense created from now on tracks it
correctly. If you know some old ones were deducted, set the flag in Prisma
Studio (`npm run db:studio`).

---

## New files

| File | Why |
|---|---|
| `app/lib/validation.server.ts` | Input parsing that fails closed — no more NaN or Invalid Date reaching Prisma |
| `app/utils/date.ts` | Local-calendar date formatting (`toISOString` was shifting days) |
| `app/utils/constants.ts` | Payment methods, shared by client and server |
| `app/routes/settings-export.tsx` | Backup download as its own resource route |
| `prisma/migrations/…_init_with_balance_tracking/` | Real migration history, baselined against your existing database |
| `.env.example` | Documents the now-required `SESSION_SECRET` |

## Schema additions

```prisma
User.sessionVersion    Int     @default(0)      // password change invalidates other devices
BankAccount.isCash     Boolean @default(false)  // replaces bankName == "Cash"
Expense.balanceApplied Boolean @default(false)  // records whether a deduction happened
```

Plus 12 indexes and `onDelete: Restrict` made explicit on `Expense.category`.
Existing accounts named "Cash" were backfilled to `isCash = true` — both of
yours, which is exactly the bug where the second one was invisible.

---

## Findings → fixes

### Security

**1. Expense FK injection.** `resolveReferences()` in `expenses.tsx` verifies
the category is yours or shared, and the bank account is yours, before either
id is written. Rejected with a field error otherwise.

**2. Backup import hijack.** Incoming ids are now discarded entirely. Rows are
created fresh and old ids remapped through in-memory tables, so a crafted
backup cannot touch another account. The whole import runs in one
`$transaction` — it either lands completely or not at all. Donations are
restored (they were exported but never imported, so every round trip lost
them). A "delete my existing data first" checkbox covers restore-over-existing;
without it the import is additive.

**3. Session secret.** `auth.server.ts` throws at boot if `SESSION_SECRET` is
missing, and requires ≥32 characters in production. Yours is 44 — fine.

**4. Secrets in the Docker image.** `.dockerignore` now excludes `.env`, `*.db`,
and `.git`.

**5. GET logout.** The loader redirects to `/` instead of destroying the
session. Sign-out is POST-only.

**6. Seed wiped every user.** All deletes scoped to the demo user's id, and the
script refuses to run with `NODE_ENV=production` unless `ALLOW_PROD_SEED=true`.

**7. Demo credentials.** Removed from the login form's initial state, the
placeholder, and the visible hint.

**8. Password policy.** 8-character minimum on both register and change (was 6
on one, unenforced on the other). Changing it bumps `sessionVersion`, killing
every other session while keeping the current browser signed in.

Also fixed along the way: `?redirectTo=https://evil.test` is now rejected by
`safeRedirect`; login runs a bcrypt compare even for unknown emails so response
timing doesn't leak which addresses exist; email uniqueness relies on the
database constraint rather than a check-then-insert race; bcrypt cost 10 → 12.

### Money

**9. Expense edit/delete ignored the balance.** Both now run in a transaction
that reverses whatever the old row applied, then applies the new figures.
Verified: ৳10,000 → add ৳5,000 → 5,000 → edit to ৳500 → 9,500 → delete →
10,000.

**10. Income edits stranded paid donations.** Changing an income amount now
refunds any paid donation to its account and marks it unpaid at the corrected
figure, with a banner explaining why. Deleting income refunds paid donations
before the cascade.

**11. Lost updates.** Every balance change is `{ increment }` / `{ decrement }`
inside a transaction. Donation pay/revert use a guarded `updateMany` on the
`paid` flag, so a double submit can only take effect once — tested.

**12. Cash detection.** Driven by `isCash`, summed with `reduce`. Both your cash
wallets now appear.

**13. Reports invented donation figures.** They read the `Donation` table now,
and show paid vs pending.

**14. `percentage` was dead.** Used in the calculation.

**15. Dashboard mixed scopes.** The donation card is current-month like the
cards beside it, and is labelled as such.

**16. Float drift.** Every amount is rounded to 2 decimals on write
(`roundMoney`). Integer paisa would be stricter but needs a data migration —
your call if you want it later.

### Broken features

**17.** Donations list filters by the selected month; totals describe the rows
on screen. A "সব সময়ের" toggle shows everything.

**18.** Expense presets are links carrying the other filters, and the form has
a hidden `preset` field — changing category no longer resets the date range.

**19.** `?month=abc` and `?month=99` fall back to sane defaults instead of
sending NaN to Prisma.

**20.** `Number.isFinite` guards replace `amount <= 0` (which `NaN` passes).

**21.** Invalid dates are rejected with a field error.

**22.** Shared categories show a "ডিফল্ট" badge instead of dead buttons.

**23.** Date inputs are parsed as local midnight and all range boundaries are
local, so nothing falls through a day boundary. `last_7_days` is 7 calendar
days ending tonight.

**24.** Bills are scoped to a month with the same all-time toggle.

**25.** The category delete guard counts expenses across all users, so the
`Restrict` constraint can't surface as a 500.

### Performance and deployment

**26.** Dockerfile rewritten: `prisma generate` runs explicitly, `prisma/` is
copied into the runtime stage, migrations apply on start, plus a non-root user,
`tini`, and `EXPOSE 3000`.

**27.** Reports went from 24 serial queries to 4 parallel ones; the dashboard
from ~15 to 9. Both bucket in memory.

**28.** 12 indexes added.

**29.** `$connect()` is caught and logged.

**30.** Docs vs code — noted below, not silently "fixed".

**31.** Small items: deterministic donation ordering, the bill paid-toggle
derives its next state from the database rather than a hidden field, deleting a
bank account with history is blocked instead of orphaning rows, unused imports
dropped, the `as any` cast in settings gone.

---

## Left for you

- **`agent.md` still says PostgreSQL, single-user, no registration.** The code
  is SQLite and multi-user with open sign-up. I didn't rewrite your spec —
  decide which is the intent. If the app should be single-user, remove the
  `/register` route.
- **Rate limiting on login.** There's none. Fine for a family app on a LAN,
  worth adding before it faces the internet.
- **Integer paisa** if you want currency correct by construction.
- **`npm run db:seed` will reset the demo account's data.** Its password is now
  `DemoPassword123` (override with `SEED_PASSWORD`).
