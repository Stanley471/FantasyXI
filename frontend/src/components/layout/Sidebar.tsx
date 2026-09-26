"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import {
  FootballIcon,
  PitchIcon,
  TrophyIcon,
  CalendarIcon,
  UsersIcon,
  UserIcon,
  LogOutIcon,
  ShieldIcon,
  ChartIcon,
} from "@/components/ui/Icons";

export const Sidebar: React.FC = () => {
  const pathname = usePathname();
  const { user, isAuthenticated, logout } = useAuth();

  const navItems = [
    { label: "Home", href: "/", icon: FootballIcon },
    { label: "My Team", href: "/team", icon: PitchIcon },
    { label: "Leagues", href: "/leagues", icon: TrophyIcon },
    { label: "Fixtures", href: "/fixtures", icon: CalendarIcon },
    { label: "Players", href: "/players", icon: UsersIcon },
    { label: "Analytics", href: "/analytics", icon: ChartIcon },
    { label: "Profile", href: "/profile", icon: UserIcon },
  ];

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <aside className="hidden md:flex flex-col w-64 bg-slate-950 border-r border-slate-800/80 p-5 shrink-0 select-none justify-between h-screen sticky top-0">
      <div>
        {/* Logo */}
        <Link href="/" className="flex items-center gap-3 px-2 py-2 mb-8 group">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-700 flex items-center justify-center text-white shadow-lg shadow-emerald-900/30 group-hover:scale-105 transition-transform duration-150">
            <FootballIcon size={22} className="text-white" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-black text-lg tracking-tight text-white">Fantasy</span>
              <span className="font-black text-lg tracking-tight text-emerald-400">XI</span>
            </div>
            <span className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
              Premier League
            </span>
          </div>
        </Link>

        {/* Navigation Links */}
        <nav className="space-y-1.5" aria-label="Main Navigation">
          {navItems.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-semibold transition-all duration-150 ${
                  active
                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/80 border border-transparent"
                }`}
              >
                <Icon size={18} className={active ? "text-emerald-400" : "text-slate-400"} />
                <span>{item.label}</span>
                {item.href === "/leagues" && (
                  <span className="ml-auto text-[10px] uppercase font-mono font-bold text-amber-400/90 tracking-wider">
                    USDC
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Footer / User Profile Area */}
      <div className="pt-4 border-t border-slate-800/80">
        {isAuthenticated && user ? (
          <div className="flex items-center justify-between p-2 rounded-xl bg-slate-900/70 border border-slate-800/80">
            <Link href="/profile" className="flex items-center gap-2.5 min-w-0 flex-1 hover:opacity-90">
              <div className="w-8 h-8 rounded-full bg-emerald-700/50 border border-emerald-500/30 flex items-center justify-center font-bold text-xs text-emerald-300 shrink-0">
                {user.username.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-slate-200 truncate">{user.username}</p>
                <p className="text-[11px] text-slate-400 truncate">{user.email}</p>
              </div>
            </Link>
            <button
              onClick={logout}
              title="Sign Out"
              aria-label="Sign Out"
              className="p-1.5 text-slate-400 hover:text-rose-400 rounded-md hover:bg-slate-800/80 transition-colors ml-1 cursor-pointer"
            >
              <LogOutIcon size={16} />
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <Link
              href="/login"
              className="flex items-center justify-center w-full py-2.5 px-3 rounded-lg text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors text-center"
            >
              Sign In
            </Link>
            <Link
              href="/register"
              className="flex items-center justify-center w-full py-2 px-3 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-900 text-center transition-colors"
            >
              Create Account
            </Link>
          </div>
        )}
      </div>
    </aside>
  );
};
