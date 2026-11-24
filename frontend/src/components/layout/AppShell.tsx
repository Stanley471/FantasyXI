"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useWallet } from "@/context/WalletContext";
import { Sidebar } from "./Sidebar";
import { MobileNav } from "./MobileNav";
import { OfflineIndicator } from "./OfflineIndicator";
import { PushNotificationPrompt } from "./PushNotificationPrompt";
import {
  StellarNetworkBadge,
  StellarNetworkBanner,
  useStellarNetworkStatus,
} from "@/components/stellar/StellarNetworkStatus";
import { FantasyXILogo } from "@/components/ui/FantasyXILogo";
import { IconSearch, IconBell, IconSun, IconWallet } from "@/components/ui/Icons";

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [searchQuery, setSearchQuery] = useState("");
  const networkStatus = useStellarNetworkStatus();
  const { publicKey, openConnectModal } = useWallet();

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
          {/* Mobile Logo */}
          <div className="flex items-center gap-2 md:hidden">
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
            <StellarNetworkBadge snapshot={networkStatus} />

            {/* Notification Bell */}
            <button
              title="Notifications"
              className="relative p-2 rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
            >
              <IconBell className="w-4 h-4" />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-rose-500" />
            </button>

            {/* Connect Wallet Button */}
            <button
              type="button"
              onClick={openConnectModal}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-[#37003c] text-white hover:bg-[#28002c] shadow-sm transition-all"
            >
              <IconWallet className="w-3.5 h-3.5 text-[#00ff87]" />
              <span>{publicKey ? `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}` : "Connect Wallet"}</span>
            </button>
          </div>
        </header>

        <StellarNetworkBanner snapshot={networkStatus} />

        {/* Page Content Container */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {children}
        </main>
      </div>

      {/* Mobile Bottom Navigation */}
      <MobileNav />
    </div>
  );
};

export default AppShell;
