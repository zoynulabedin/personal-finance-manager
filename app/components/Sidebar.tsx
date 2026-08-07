import { Link, useLocation } from "react-router";
import {
  LayoutDashboard,
  Wallet,
  Receipt,
  HeartHandshake,
  Landmark,
  Tags,
  BarChart3,
  Settings,
  LogOut,
  X,
  CreditCard,
  Building2,
  ScrollText,
  ArrowRightLeft,
} from "lucide-react";

interface SidebarProps {
  user?: { name: string; email: string } | null;
  isOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ user, isOpen, onClose }: SidebarProps) {
  const location = useLocation();

  const navItems = [
    { label: "à¦¡à§à¦¯à¦¾à¦¶à¦¬à§‹à¦°à§à¦¡", path: "/", icon: LayoutDashboard },
    { label: "à¦†à§Ÿ (Income)", path: "/income", icon: Wallet },
    { label: "à¦¦à§ˆà¦¨à¦¨à§à¦¦à¦¿à¦¨ à¦–à¦°à¦š", path: "/expenses", icon: Receipt },
    { label: "à¦®à¦¾à¦¸à¦¿à¦• à¦¬à¦¿à¦²", path: "/bills", icon: CreditCard },
    { label: "à§§% à¦¦à¦¾à¦¨ (Donation)", path: "/donations", icon: HeartHandshake },
    { label: "à¦¬à§à¦¯à¦¾à¦‚à¦• à¦“ à¦“à§Ÿà¦¾à¦²à§‡à¦Ÿ", path: "/bank-accounts", icon: Landmark },
    { label: "à¦²à§‡à¦¨à¦¦à§‡à¦¨à§‡à¦° à¦–à¦¤à¦¿à¦¯à¦¼à¦¾à¦¨", path: "/transactions", icon: ScrollText },
    { label: "à¦•à§à¦¯à¦¾à¦Ÿà¦¾à¦—à¦°à¦¿", path: "/categories", icon: Tags },
    { label: "à¦°à¦¿à¦ªà§‹à¦°à§à¦Ÿ à¦“ à¦…à§à¦¯à¦¾à¦¨à¦¾à¦²à¦¿à¦Ÿà¦¿à¦•à§à¦¸", path: "/reports", icon: BarChart3 },
    { label: "à¦¸à§‡à¦Ÿà¦¿à¦‚à¦¸", path: "/settings", icon: Settings },
  ];

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed top-0 bottom-0 left-0 z-50 w-64 bg-slate-900/95 border-r border-slate-800 backdrop-blur-xl flex flex-col transition-transform duration-300 ease-in-out lg:translate-x-0 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Logo & Header */}
        <div className="h-16 px-6 flex items-center justify-between border-b border-slate-800/80">
          <Link to="/" className="flex items-center gap-3 group">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center text-white shadow-lg shadow-emerald-600/20 group-hover:scale-105 transition duration-200">
              <Building2 className="w-5.5 h-5.5" />
            </div>
            <div>
              <h1 className="font-bold text-slate-100 text-lg leading-tight tracking-tight">
                à¦†à¦®à¦¾à¦° à¦¹à¦¿à¦¸à¦¾à¦¬
              </h1>
              <span className="text-[11px] text-emerald-400 font-medium tracking-wide">
                Poribar Finance
              </span>
            </div>
          </Link>

          {/* Close button for mobile */}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 lg:hidden"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Items */}
        <div className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              item.path === "/"
                ? location.pathname === "/"
                : location.pathname.startsWith(item.path);

            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={onClose}
                className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl font-medium text-sm transition-all duration-150 ${
                  isActive
                    ? "bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-md shadow-emerald-950/50"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
                }`}
              >
                <Icon
                  className={`w-4.5 h-4.5 transition-colors ${
                    isActive ? "text-white" : "text-slate-400"
                  }`}
                />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>

        {/* User Profile & Logout */}
        <div className="p-4 border-t border-slate-800/80 bg-slate-900/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 overflow-hidden">
              <div className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-emerald-400 shrink-0">
                {user?.name?.[0] || "à¦ª"}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-200 truncate">
                  {user?.name || "à¦ªà¦°à¦¿à¦¬à¦¾à¦° à¦ªà§à¦°à¦§à¦¾à¦¨"}
                </p>
                <p className="text-xs text-slate-400 truncate">
                  {user?.email || "admin@family.com"}
                </p>
              </div>
            </div>

            <form action="/logout" method="post">
              <button
                type="submit"
                title="à¦²à¦—à¦†à¦‰à¦Ÿ"
                className="p-2 rounded-xl text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <LogOut className="w-4.5 h-4.5" />
              </button>
            </form>
          </div>
        </div>
      </aside>
    </>
  );
}

