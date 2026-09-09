"use client";

import Link from "next/link";
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

export default function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const pathname = usePathname();

  return (
    <main className="min-h-screen bg-gray-50 p-4 pb-20 md:p-8 md:pb-8">
      <div className="max-w-7xl mx-auto">
        {/* 移动端横向 tab；桌面端导航在左侧 AppSidebar（/admin 下展开子导航） */}
        <div className="md:hidden flex flex-wrap rounded-md border border-gray-300 bg-white mb-6">
          {TABS.map(([id, label]) => {
            const active = pathname === `/admin/${id}`;
            return (
              <Link
                key={id}
                href={`/admin/${id}`}
                className={`shrink-0 whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors min-h-[40px] w-1/3 text-center ${
                  active
                    ? "border-blue-600 text-blue-700"
                    : "border-transparent text-gray-600 hover:bg-gray-50"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>

        {children}
      </div>
    </main>
  );
}
