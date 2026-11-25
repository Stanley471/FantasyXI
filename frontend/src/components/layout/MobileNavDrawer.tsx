"use client";

import React, { useEffect, useRef } from "react";
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
  IconClose,
} from "@/components/ui/Icons";
import { getFocusableElements, createFocusTrapHandler } from "@/lib/focusTrap";

export interface MobileNavDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Toggle button to return focus to once the drawer closes. */
  toggleButtonRef: React.RefObject<HTMLButtonElement | null>;
}

/**
 * Slide-in mobile navigation drawer. While open, Tab/Shift+Tab cycle only
 * through its own focusable elements and Escape closes it, returning focus
 * to the toggle button that opened it (issue #489).
 */
export const MobileNavDrawer: React.FC<MobileNavDrawerProps> = ({
  isOpen,
  onClose,
  toggleButtonRef,
}) => {
  const pathname = usePathname();
  const { user, isAuthenticated, logout } = useAuth();
  const drawerRef = useRef<HTMLDivElement>(null);

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

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  useEffect(() => {
    if (!isOpen) return;
    const drawer = drawerRef.current;
    if (!drawer) return;

    const focusables = getFocusableElements(drawer);
    (focusables[0] ?? drawer).focus();

    const handleKeyDown = createFocusTrapHandler(drawer, onClose);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      toggleButtonRef.current?.focus();
    };
  }, [isOpen, onClose, toggleButtonRef]);

  if (!isOpen) return null;

  return (
    <div className="md:hidden fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm animate-fadeIn"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Mobile navigation menu"
        tabIndex={-1}
        className="absolute inset-y-0 left-0 w-72 max-w-[80%] bg-white shadow-2xl flex flex-col focus:outline-hidden"
      >
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <FantasyXILogo size={28} showText={true} variant="light" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation menu"
            className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <IconClose className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1" aria-label="Mobile Navigation Drawer">
          {navItems.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                  active
                    ? "bg-[#37003c] text-white shadow-md shadow-[#37003c]/20"
                    : "text-slate-600 hover:text-[#37003c] hover:bg-slate-100/80"
                }`}
              >
                <Icon size={19} className={active ? "text-[#00ff87]" : "text-slate-400"} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {isAuthenticated && user && (
          <div className="p-3 border-t border-slate-100">
            <button
              type="button"
              onClick={() => {
                logout();
                onClose();
              }}
              className="flex w-full items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold text-slate-600 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
            >
              <IconLogOut size={19} className="text-slate-400" />
              <span>Sign Out</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default MobileNavDrawer;
