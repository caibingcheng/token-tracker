"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { findAdminSection } from "./sections";

function ChevronLeftIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" aria-hidden="true" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

export default function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const pathname = usePathname();
  const section = findAdminSection(pathname);

  return (
    <main className="min-h-screen bg-gray-50 p-4 pb-20 md:p-8 md:pb-8">
      <div className="max-w-7xl mx-auto">
        {/* 移动端二级导航：子页只显示「← Admin + 当前分区」，分区切换走 /admin 列表页；
            桌面端导航在左侧 AppSidebar（/admin 下展开子导航）。不吸顶，避免与面板自身的 sticky 筛选栏打架 */}
        {section && (
          <div className="md:hidden mb-4 flex items-center gap-2">
            <Link
              href="/admin"
              className="inline-flex min-h-[40px] shrink-0 items-center gap-0.5 rounded-lg border border-gray-300 bg-white pl-1.5 pr-2.5 text-sm font-medium text-gray-700 shadow-sm active:bg-gray-50"
            >
              <ChevronLeftIcon />
              Admin
            </Link>
            <h1 className="min-w-0 truncate text-base font-semibold text-gray-900">
              {section.label}
            </h1>
          </div>
        )}

        {children}
      </div>
    </main>
  );
}
