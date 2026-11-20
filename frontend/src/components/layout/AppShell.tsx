"use client";

import React, { useRef, useState } from "react";
import Link from "next/link";
import { Sidebar } from "./Sidebar";
import { MobileNav } from "./MobileNav";
import { MobileNavDrawer } from "./MobileNavDrawer";
import { OfflineIndicator } from "./OfflineIndicator";
import { PushNotificationPrompt } from "./PushNotificationPrompt";
import { FantasyXILogo } from "@/components/ui/FantasyXILogo";
import { IconSearch, IconBell, IconSun, IconWallet, IconMenu } from "@/components/ui/Icons";

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex min-h-screen bg-[#f8fafc] text-slate-800 font-sans">
      {/* Desktop Sidebar */}
      <Sidebar />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 pb-20 md:pb-8">
        {/* Offline Indicator Banner */}
        <OfflineIndicator />

        {/* Push Notification Opt-in Prompt */}
        <PushNotificationPrompt />

        {/* Top Header Bar */}
        <header className="sticky top-0 z-20 flex items-center justify-between px-4 sm:px-8 py-3 bg-white/95 backdrop-blur-md border-b border-slate-200/80 shadow-xs">
          {/* Mobile Menu Toggle + Logo */}
          <div className="flex items-center gap-1 md:hidden">
            <button
              type="button"
              ref={menuButtonRef}
              onClick={() => setIsDrawerOpen(true)}
              aria-label="Open navigation menu"
              aria-haspopup="dialog"
              aria-expanded={isDrawerOpen}
              className="p-2 -ml-2 rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <IconMenu className="w-5 h-5" />
            </button>
            <Link href="/" className="flex items-center gap-2">
              <FantasyXILogo size={32} showText={true} />
            </Link>
          </div>

          {/* Desktop Search Bar */}
          <div className="hidden md:flex items-center relative w-72 lg:w-96">
            <IconSearch className="absolute left-3.5 w-4 h-4 text-slate-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search leagues, teams, or players..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-xs bg-slate-50 hover:bg-slate-100/80 focus:bg-white border border-slate-200 rounded-xl focus:outline-hidden focus:ring-1 focus:ring-[#37003c]/20 focus:border-[#37003c] transition-all text-slate-700 placeholder:text-slate-400"
            />
          </div>

          {/* Top Right Quick Actions & Connect Wallet */}
          <div className="flex items-center gap-3">
            {/* Notification Bell */}
            <button
              title="Notifications"
              className="relative p-2 rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
            >
              <IconBell className="w-4 h-4" />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-rose-500" />
            </button>

            {/* Connect Wallet Button */}
            <Link
              href="/profile"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-[#37003c] text-white hover:bg-[#28002c] shadow-sm transition-all"
            >
              <IconWallet className="w-3.5 h-3.5 text-[#00ff87]" />
              <span>Connect Wallet</span>
            </Link>
          </div>
        </header>

        {/* Page Content Container */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {children}
        </main>
      </div>

      {/* Mobile Bottom Navigation */}
      <MobileNav />

      {/* Mobile Navigation Drawer (hamburger menu) */}
      <MobileNavDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        toggleButtonRef={menuButtonRef}
      />
    </div>
  );
};

export default AppShell;
