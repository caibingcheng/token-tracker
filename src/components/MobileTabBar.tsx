"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface MobileTabBarProps {
  onLogout: () => void;
  previewActive: boolean;
  onPreviewToggle: () => void;
}

export default function MobileTabBar({
  onLogout,
  previewActive,
  onPreviewToggle,
}: MobileTabBarProps) {
  const pathname = usePathname();
  const isAdmin = pathname?.startsWith("/admin") ?? false;

  const tabs = [
    {
      href: "/",
      label: "Dashboard",
      active: !isAdmin && !previewActive,
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="9" rx="1" />
          <rect x="14" y="3" width="7" height="5" rx="1" />
          <rect x="14" y="12" width="7" height="9" rx="1" />
          <rect x="3" y="16" width="7" height="5" rx="1" />
        </svg>
      ),
    },
    {
      href: "/admin",
      label: "Admin",
      active: isAdmin && !previewActive,
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
        </svg>
      ),
    },
  ];

  const tabClass = (active: boolean) =>
    `flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 text-xs font-medium transition-colors ${
      active ? "text-blue-600" : "text-gray-500 hover:text-gray-700"
    }`;

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-50 md:hidden border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)]"
      aria-label="Mobile navigation"
    >
      <div className="flex">
        <Link
          href={tabs[0]!.href}
          onClick={previewActive ? onPreviewToggle : undefined}
          className={tabClass(tabs[0]!.active)}
        >
          {tabs[0]!.icon}
          {tabs[0]!.label}
        </Link>
        <button
          type="button"
          onClick={previewActive ? undefined : onPreviewToggle}
          className={tabClass(previewActive)}
          aria-current={previewActive ? "location" : undefined}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          Public View
        </button>
        <Link
          href={tabs[1]!.href}
          onClick={previewActive ? onPreviewToggle : undefined}
          className={tabClass(tabs[1]!.active)}
        >
          {tabs[1]!.icon}
          {tabs[1]!.label}
        </Link>
        <button
          type="button"
          onClick={onLogout}
          className="flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 text-xs font-medium text-gray-500 hover:text-red-600 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Logout
        </button>
      </div>
    </nav>
  );
}
