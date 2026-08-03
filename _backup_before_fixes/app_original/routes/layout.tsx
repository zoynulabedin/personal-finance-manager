import { useState, useEffect } from "react";
import { Outlet, useLoaderData, useMatches } from "react-router";
import type { Route } from "./+types/layout";
import { requireUserId, getUser } from "../lib/auth.server";
import { Sidebar } from "../components/Sidebar";
import { Header } from "../components/Header";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const user = await getUser(request);
  return { user };
}

export interface LayoutContextType {
  user: { id: string; name: string; email: string } | null;
  useBengaliDigits: boolean;
  setUseBengaliDigits: (val: boolean) => void;
}

export default function AppLayout() {
  const { user } = useLoaderData<typeof loader>();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [useBengaliDigits, setUseBengaliDigits] = useState(true);

  // Load saved digit preference from localStorage if available
  useEffect(() => {
    const saved = localStorage.getItem("useBengaliDigits");
    if (saved !== null) {
      setUseBengaliDigits(saved === "true");
    }
  }, []);

  const handleToggleDigits = () => {
    const nextVal = !useBengaliDigits;
    setUseBengaliDigits(nextVal);
    localStorage.setItem("useBengaliDigits", String(nextVal));
  };

  // Determine current page title from route path
  const matches = useMatches();
  const currentPath = matches[matches.length - 1]?.pathname || "/";
  
  let pageTitle = "ড্যাশবোর্ড";
  if (currentPath.startsWith("/income")) pageTitle = "আয় ম্যানেজমেন্ট";
  else if (currentPath.startsWith("/expenses")) pageTitle = "দৈনন্দিন হিসাব ও খরচ";
  else if (currentPath.startsWith("/bills")) pageTitle = "মাসিক ইউটিলিটি ও বিল";
  else if (currentPath.startsWith("/donations")) pageTitle = "১% দান হিসাব (Donations)";
  else if (currentPath.startsWith("/bank-accounts")) pageTitle = "ব্যাংক ও ডিজিটাল ওয়ালেট";
  else if (currentPath.startsWith("/categories")) pageTitle = "খরচের ক্যাটাগরি";
  else if (currentPath.startsWith("/reports")) pageTitle = "আর্থিক রিপোর্ট ও সামারি";
  else if (currentPath.startsWith("/settings")) pageTitle = "সিস্টেম সেটিংস";

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col lg:flex-row text-slate-100">
      <Sidebar
        user={user}
        isOpen={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        <Header
          title={pageTitle}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
          useBengaliDigits={useBengaliDigits}
          onToggleDigits={handleToggleDigits}
        />

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          <Outlet context={{ user, useBengaliDigits, setUseBengaliDigits }} />
        </main>
      </div>
    </div>
  );
}
