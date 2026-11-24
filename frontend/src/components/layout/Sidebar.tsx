"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { FantasyXILogo } from "@/components/ui/FantasyXILogo";
import {
  IconFootball,
  IconTrophy,
  IconCalendar,
  IconUsers,
  IconUser,
  IconLogOut,
  IconChart,
  IconMedal,
  IconPlus,
} from "@/components/ui/Icons";

export const Sidebar: React.FC = () => {
  const pathname = usePathname();
  const { user, isAuthenticated, logout } = useAuth();

  const navItems = [
    { label: "Dashboard", href: "/", icon: IconFootball },
    { label: "My Leagues", href: "/leagues", icon: IconTrophy },
    { label: "Create League", href: "/leagues/create", icon: IconPlus },
    { label: "My Team", href: "/team", icon: IconFootball },
    { label: "Leaderboard", href: "/leaderboard", icon: IconMedal },
    { label: "Fixtures", href: "/fixtures", icon: IconCalendar },
    { label: "Players", href: "/players", icon: IconUsers },
    { label: "Analytics", href: "/analytics", icon: IconChart },
    { label: "Profile", href: "/profile", icon: IconUser },
  ];

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <aside className="hidden md:flex flex-col w-64 bg-white border-r border-slate-200/80 p-5 shrink-0 select-none justify-between h-screen sticky top-0 shadow-sm z-30">
      <div className="flex flex-col gap-6">
        {/* Brand Logo */}
        <Link href="/" className="px-2 py-1 group">
          <FantasyXILogo size={38} showText={true} variant="light" />
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
                className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 ${
                  active
                    ? "bg-[#37003c] text-white shadow-md shadow-[#37003c]/20"
                    : "text-slate-600 hover:text-[#37003c] hover:bg-slate-100/80"
                }`}
              >
                <Icon
                  size={19}
                  className={active ? "text-[#00ff87]" : "text-slate-400 group-hover:text-[#37003c]"}
                />
                <span>{item.label}</span>
                {item.href === "/leagues" && (
                  <span
                    className={`ml-auto text-[10px] uppercase font-mono font-bold tracking-wider px-1.5 py-0.5 rounded-md ${
                      active
                        ? "bg-white/20 text-white"
                        : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                    }`}
                  >
                    USDC
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Play & Win Promotion Card */}
        <div className="relative rounded-2xl bg-gradient-to-br from-[#37003c] via-[#4d0c5a] to-[#25002b] p-4 text-white overflow-hidden shadow-lg shadow-[#37003c]/15">
          <div className="absolute -right-4 -bottom-4 w-20 h-20 bg-[#00ff87]/15 rounded-full blur-xl pointer-events-none" />
          <p className="text-xs font-black tracking-wide uppercase text-[#00ff87] mb-1">
            Play. Compete. Win.
          </p>
          <p className="text-xs text-slate-200 leading-relaxed mb-3">
            Join private leagues with instant finality, low fees, and Soroban smart escrow.
          </p>
          <Link
            href="/leagues/create"
            className="inline-flex items-center justify-center w-full py-2 px-3 rounded-lg text-xs font-bold bg-[#00ff87] text-[#24002e] hover:bg-[#00e575] transition-all shadow-sm"
          >
            Create League &rarr;
          </Link>
        </div>
      </div>

      {/* User Session Footer */}
      <div className="pt-4 border-t border-slate-100">
        {isAuthenticated && user ? (
          <div className="flex items-center justify-between p-2 rounded-xl bg-slate-50 border border-slate-200/80">
            <Link href="/profile" className="flex items-center gap-2.5 min-w-0 flex-1 hover:opacity-90">
              <div className="w-8 h-8 rounded-full bg-[#37003c] text-white flex items-center justify-center font-bold text-xs shrink-0 shadow-sm">
                {user.username.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-slate-900 truncate">{user.username}</p>
                <p className="text-[11px] text-slate-500 truncate">{user.email}</p>
              </div>
            </Link>
            <button
              onClick={() => logout()}
              title="Sign Out"
              aria-label="Sign Out"
              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
            >
              <IconLogOut size={16} />
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Link
              href="/login"
              className="w-full text-center py-2 px-3 rounded-xl text-xs font-bold bg-[#37003c] text-white hover:bg-[#28002c] transition-colors"
            >
              Sign In
            </Link>
            <Link
              href="/register"
              className="w-full text-center py-2 px-3 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
            >
              Create Account
            </Link>
          </div>
        )}
      </div>
    </aside>
  );
};

export default Sidebar;
