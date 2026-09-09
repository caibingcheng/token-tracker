"use client";

import { createContext, useContext, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useNumberFormat } from "./NumberFormatContext";

const ADMIN_TABS = [
  ["upstreams", "Upstreams"],
  ["models", "Models"],
  ["virtual-keys", "Virtual Keys"],
  ["security", "Security"],
  ["display", "Display"],
  ["sync", "Sync"],
  ["audit", "Audit"],
] as const;

// Dashboard 专属操作节点注册到侧栏底部：
// Dashboard 挂载时 setSidebarActions(操作组 JSX)，卸载时置 null → Admin 页操作组自动消失。
// 注意：注册的 JSX 渲染在侧栏（Dashboard 组件树之外），必须由 ApiKeyGate 层级的
// NumberFormatProvider 包裹才能消费 useNumberFormat。
interface SidebarActionsContextValue {
  setSidebarActions: (actions: ReactNode | null) => void;
}

export const SidebarActionsContext = createContext<SidebarActionsContextValue>({
  setSidebarActions: () => {},
});

export function useSidebarActions() {
  return useContext(SidebarActionsContext);
}

export function NumberFormatToggle() {
  const { compact, setCompact } = useNumberFormat();

  return (
    <div
      className="inline-flex items-center rounded-md overflow-hidden border border-gray-300 bg-white w-full"
      role="group"
      aria-label="Number format"
    >
      <button
        type="button"
        onClick={() => setCompact(false)}
        aria-pressed={!compact}
        className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
          !compact
            ? "bg-blue-600 text-white"
            : "text-gray-600 hover:bg-gray-50"
        }`}
      >
        123
      </button>
      <button
        type="button"
        onClick={() => setCompact(true)}
        aria-pressed={compact}
        className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
          compact
            ? "bg-blue-600 text-white"
            : "text-gray-600 hover:bg-gray-50"
        }`}
      >
        K/M/B
      </button>
    </div>
  );
}

interface AppSidebarProps {
  actions: ReactNode;
  onPreviewToggle: () => void;
}

export default function AppSidebar({
  actions,
  onPreviewToggle,
}: AppSidebarProps) {
  const pathname = usePathname();
  const isAdmin = pathname?.startsWith("/admin") ?? false;

  const navItemClass = (active: boolean) =>
    `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
      active
        ? "bg-blue-600 text-white"
        : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
    }`;

  return (
    <aside className="hidden md:flex fixed inset-y-0 left-0 z-40 w-56 flex-col border-r border-gray-200 bg-white">
      <div className="px-4 pt-5 pb-3">
        <Link href="/" className="text-lg font-bold text-gray-900">
          Token Tracker
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-1" aria-label="Main navigation">
        <Link
          href="/"
          className={navItemClass(!isAdmin)}
          aria-current={!isAdmin ? "page" : undefined}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="9" rx="1" />
            <rect x="14" y="3" width="7" height="5" rx="1" />
            <rect x="14" y="12" width="7" height="9" rx="1" />
            <rect x="3" y="16" width="7" height="5" rx="1" />
          </svg>
          Dashboard
        </Link>
        <Link
          href="/admin"
          className={navItemClass(isAdmin)}
          aria-current={isAdmin ? "page" : undefined}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
          Admin
        </Link>

        {isAdmin && (
          <div className="ml-4 mt-1 space-y-0.5 border-l border-gray-200 pl-3 pb-1">
            {ADMIN_TABS.map(([id, label]) => {
              const active = pathname === `/admin/${id}`;
              return (
                <Link
                  key={id}
                  href={`/admin/${id}`}
                  className={`block rounded px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "bg-blue-50 font-medium text-blue-700"
                      : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
                  }`}
                  aria-current={active ? "location" : undefined}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        )}
      </nav>

      <div className="border-t border-gray-200 p-3 flex flex-col gap-2">
        {actions}
        <button
          type="button"
          onClick={onPreviewToggle}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          title="Preview the public status page"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          Public View
        </button>
      </div>
    </aside>
  );
}
