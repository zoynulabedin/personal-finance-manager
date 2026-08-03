import { useState } from "react";
import { Menu, Plus, Calendar } from "lucide-react";
import { formatBengaliDate } from "../utils/bengali";
import { Link } from "react-router";

interface HeaderProps {
  title: string;
  onOpenMobileMenu?: () => void;
  useBengaliDigits: boolean;
  onToggleDigits: () => void;
}

export function Header({
  title,
  onOpenMobileMenu,
  useBengaliDigits,
  onToggleDigits,
}: HeaderProps) {
  const currentDateFormatted = formatBengaliDate(new Date(), useBengaliDigits);

  return (
    <header className="h-16 border-b border-slate-800 bg-slate-900/80 backdrop-blur-md sticky top-0 z-30 px-4 lg:px-8 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <button
          onClick={onOpenMobileMenu}
          className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 lg:hidden"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-100">{title}</h2>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {/* Date Display */}
        <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-800/60 border border-slate-700/50 text-xs text-slate-300 font-medium">
          <Calendar className="w-3.5 h-3.5 text-emerald-400" />
          <span>{currentDateFormatted}</span>
        </div>

        {/* Bengali / English Digits Toggle */}
        <button
          onClick={onToggleDigits}
          title="সংখ্যা পরিবর্তন (১২৩ / 123)"
          className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-300 hover:text-white hover:border-emerald-500/50 transition-all flex items-center gap-1.5"
        >
          <span>অঙ্ক:</span>
          <span className="text-emerald-400 font-bold">
            {useBengaliDigits ? "১২৩" : "123"}
          </span>
        </button>

        {/* Quick Add Expense Button */}
        <Link
          to="/expenses?action=new"
          className="px-3 py-1.5 sm:px-4 sm:py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs sm:text-sm flex items-center gap-1.5 shadow-md shadow-emerald-950/40 transition duration-200"
        >
          <Plus className="w-4 h-4" />
          <span className="hidden xs:inline">নতুন খরচ</span>
        </Link>
      </div>
    </header>
  );
}
