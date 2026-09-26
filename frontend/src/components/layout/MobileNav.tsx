"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FootballIcon,
  PitchIcon,
  TrophyIcon,
  CalendarIcon,
  UsersIcon,
  UserIcon,
} from "@/components/ui/Icons";

export const MobileNav: React.FC = () => {
  const pathname = usePathname();

  const navItems = [
    { label: "Home", href: "/", icon: FootballIcon },
    { label: "My Team", href: "/team", icon: PitchIcon },
    { label: "Leagues", href: "/leagues", icon: TrophyIcon },
    { label: "Fixtures", href: "/fixtures", icon: CalendarIcon },
    { label: "Players", href: "/players", icon: UsersIcon },
  ];

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-slate-950/95 backdrop-blur-md border-t border-slate-800/80 px-2 py-1.5 flex items-center justify-around shadow-2xl"
      aria-label="Mobile Bottom Navigation"
    >
      {navItems.map((item) => {
        const active = isActive(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex flex-1 min-w-0 flex-col items-center justify-center min-h-[48px] py-1 px-1 rounded-lg transition-colors ${
              active ? "text-emerald-400 font-bold" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Icon size={20} className={active ? "text-emerald-400" : "text-slate-400"} />
            <span className="text-[10px] mt-1 tracking-tight">{item.label}</span>
          </Link>
        );
      })}
      <Link
        href="/profile"
        className={`flex flex-1 min-w-0 flex-col items-center justify-center min-h-[48px] py-1 px-1 rounded-lg transition-colors ${
          pathname.startsWith("/profile") ? "text-emerald-400 font-bold" : "text-slate-400 hover:text-slate-200"
        }`}
      >
        <UserIcon size={20} className={pathname.startsWith("/profile") ? "text-emerald-400" : "text-slate-400"} />
        <span className="text-[10px] mt-1 tracking-tight">Profile</span>
      </Link>
    </nav>
  );
};
