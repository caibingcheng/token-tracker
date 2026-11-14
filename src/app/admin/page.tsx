"use client";

import Link from "next/link";
import { ADMIN_SECTIONS } from "./sections";
import { useConfirmLogout } from "@/components/LogoutContext";

function ChevronRightIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" aria-hidden="true" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// Admin 分区列表页：移动端是主要入口（子页顶部只留「← Admin」，分区切换回这里）；
// 桌面端侧栏也有同一份子导航，列表页作为落地页同样可用。
// 移动端登出入口：列表底部一行（二次点击确认，与桌面端侧栏登出同款 3s 窗口）。
export default function AdminPage() {
  const { confirming, loggingOut, triggerLogout } = useConfirmLogout();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-4 text-lg font-semibold text-gray-900">Admin</h1>
      <ul className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-100">
        {ADMIN_SECTIONS.map(({ id, label, description, Icon }) => (
          <li key={id} className="border-b border-gray-100">
            <Link
              href={`/admin/${id}`}
              className="flex min-h-[56px] items-center gap-3 px-4 py-3 transition-colors active:bg-gray-50 md:hover:bg-gray-50"
            >
              <span className="text-gray-400">
                <Icon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900">{label}</span>
                <span className="block truncate text-xs text-gray-500">{description}</span>
              </span>
              <span className="shrink-0 text-gray-300">
                <ChevronRightIcon />
              </span>
            </Link>
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={triggerLogout}
            disabled={loggingOut}
            aria-label={confirming ? "Confirm logout" : "Logout"}
            className={`flex min-h-[56px] w-full items-center justify-center text-sm font-medium transition-colors disabled:opacity-50 ${
              confirming
                ? "bg-red-50 text-red-700"
                : "text-red-600 active:bg-red-50 md:hover:bg-red-50"
            }`}
          >
            {loggingOut ? "Logging out..." : confirming ? "Tap again to log out" : "Logout"}
          </button>
        </li>
      </ul>
    </div>
  );
}
