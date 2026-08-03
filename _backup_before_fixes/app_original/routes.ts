import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  route("login", "routes/login.tsx"),
  route("register", "routes/register.tsx"),
  route("logout", "routes/logout.tsx"),
  layout("routes/layout.tsx", [
    index("routes/dashboard.tsx"),
    route("income", "routes/income.tsx"),
    route("expenses", "routes/expenses.tsx"),
    route("bills", "routes/bills.tsx"),
    route("donations", "routes/donations.tsx"),
    route("bank-accounts", "routes/bank-accounts.tsx"),
    route("categories", "routes/categories.tsx"),
    route("reports", "routes/reports.tsx"),
    route("settings", "routes/settings.tsx"),
  ]),
] satisfies RouteConfig;
