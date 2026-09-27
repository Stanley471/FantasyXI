"use client";

import React from "react";
import Link from "next/link";
import { Sidebar } from "./Sidebar";
import { MobileNav } from "./MobileNav";
import { GameweekBanner } from "./GameweekBanner";
import { OfflineIndicator } from "./OfflineIndicator";
import { FootballIcon } from "@/components/ui/Icons";

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100 font-sans">
      {/* Desktop Sidebar */}
      <Sidebar />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 pb-20 md:pb-8">
        {/* Offline Indicator Banner */}
        <OfflineIndicator />

        {/* Top Header Bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between px-4 sm:px-8 py-3 bg-slate-950/80 backdrop-blur-md border-b border-slate-800/80">
          {/* Mobile Logo */}
          <div className="flex items-center gap-2 md:hidden">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center text-white">
                <FootballIcon size={18} className="text-white" />
              </div>
              <span className="font-extrabold text-base tracking-tight text-white">
                Fantasy<span className="text-emerald-400">XI</span>
              </span>
            </Link>
          </div>

          {/* Desktop Left / Gameweek Status */}
          <div className="flex items-center gap-3">
            <GameweekBanner />
          </div>

          {/* Top Right Quick Actions */}
          <div className="flex items-center gap-2.5">
            <Link
              href="/team"
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-700 hover:bg-emerald-800 text-white transition-colors"
            >
              My Pitch
            </Link>
          </div>
        </header>

        {/* Page Body Container */}
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-8 py-6">
          {children}
        </main>
      </div>

      {/* Mobile Bottom Navigation */}
      <MobileNav />
    </div>
  );
};
