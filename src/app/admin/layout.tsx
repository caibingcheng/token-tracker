"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const TABS = [
  ["upstreams", "Upstreams"],
  ["models", "Models"],
  ["virtual-keys", "Virtual Keys"],
  ["security", "Security"],
  ["display", "Display"],
  ["sync", "Sync"],
  ["audit", "Audit"],
] as const;

// 16px stroke 图标（lucide 风格），与 MobileTabBar/AppSidebar 的 SVG 写法一致
function IconUpstreams() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}
function IconModels() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}
function IconVirtualKeys() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}
function IconSecurity() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}
function IconDisplay() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}
function IconSync() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}
function IconAudit() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </svg>
  );
}

const TAB_ICONS: Record<(typeof TABS)[number][0], React.ComponentType> = {
  upstreams: IconUpstreams,
  models: IconModels,
  "virtual-keys": IconVirtualKeys,
  security: IconSecurity,
  display: IconDisplay,
  sync: IconSync,
  audit: IconAudit,
};

export default function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const pathname = usePathname();
  const activeRef = useRef<HTMLAnchorElement>(null);

  // 横向滚动条加载后把激活项滚入可视区（如直接打开 /admin/audit）
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [pathname]);

  return (
    <main className="min-h-screen bg-gray-50 p-4 pb-20 md:p-8 md:pb-8">
      <div className="max-w-7xl mx-auto">
        {/* 移动端横向滑动 pill 导航；桌面端导航在左侧 AppSidebar（/admin 下展开子导航） */}
        <div className="md:hidden -mx-4 mb-4 px-4">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {TABS.map(([id, label]) => {
              const active = pathname === `/admin/${id}`;
              const Icon = TAB_ICONS[id];
              return (
                <Link
                  key={id}
                  href={`/admin/${id}`}
                  ref={active ? activeRef : undefined}
                  className={`flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors ${
                    active
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  <Icon />
                  {label}
                </Link>
              );
            })}
          </div>
        </div>

        {children}
      </div>
    </main>
  );
}
