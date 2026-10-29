"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
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
  collapsed: boolean;
  onToggleCollapse: () => void;
  onPreviewToggle: () => void;
}

interface SectionNavItem {
  id: string;
  label: string;
  children?: SectionNavItem[];
}

// Dashboard 页内容锚点（子菜单）：仅 / 路由时在 Dashboard 导航项下展开。
// 锚点元素由 Dashboard 内容区提供（section/卡片 id 保留），本组件只做滚动监听与点击滚动。
const DASHBOARD_SECTIONS: SectionNavItem[] = [
  { id: "heatmap-section", label: "Heatmap" },
  { id: "stats-section", label: "Stats" },
  { id: "today-section", label: "Today" },
  {
    id: "trends-section",
    label: "Trends",
    children: [
      { id: "trends-token", label: "Token" },
      { id: "trends-cost", label: "Cost" },
      { id: "trends-latency", label: "Latency" },
    ],
  },
];

// Admin 二级 tab 列表：inline 与 flyout 共用
function AdminTabsNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <>
      {ADMIN_TABS.map(([id, label]) => {
        const active = pathname === `/admin/${id}`;
        return (
          <Link
            key={id}
            href={`/admin/${id}`}
            onClick={onNavigate}
            className={`block rounded px-3 py-1.5 text-sm transition-colors ${
              active
                ? "bg-blue-50 font-medium text-blue-700"
                : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
            }`}
            aria-current={active ? "location" : undefined}
          >
            {label}
          </Link>
        );
      })}
    </>
  );
}

interface DashboardSectionsNavProps {
  // inline = 展开态侧栏内联子菜单；flyout = collapsed 图标 rail 的 hover 浮层
  variant?: "inline" | "flyout";
  onNavigate?: () => void;
}

function DashboardSectionsNav({
  variant = "inline",
  onNavigate,
}: DashboardSectionsNavProps) {
  const [activeId, setActiveId] = useState<string | null>(
    DASHBOARD_SECTIONS[0]?.id ?? null
  );
  const [activeChildId, setActiveChildId] = useState<string | null>(null);
  const isClickScrollingRef = useRef(false);
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  const updateActiveFromScroll = useCallback(() => {
    if (isClickScrollingRef.current) return;

    // 以 viewport 顶部往下 25% 处作为当前栏目判定线
    const scrollOffset = window.innerHeight * 0.25;
    let currentId = DASHBOARD_SECTIONS[0]?.id ?? null;
    for (const { id } of DASHBOARD_SECTIONS) {
      const el = document.getElementById(id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top <= scrollOffset) {
        currentId = id;
      } else {
        break;
      }
    }
    setActiveId(currentId);

    // Trends 内部子锚点判定（卡片条件渲染，可能不存在）
    let currentChildId: string | null = null;
    if (currentId === "trends-section") {
      const trends = DASHBOARD_SECTIONS.find((s) => s.id === currentId);
      for (const child of trends?.children ?? []) {
        const el = document.getElementById(child.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top <= scrollOffset) {
          currentChildId = child.id;
        } else {
          break;
        }
      }
    }
    setActiveChildId(currentChildId);
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        updateActiveFromScroll();
        rafRef.current = null;
      });
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    updateActiveFromScroll();

    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [updateActiveFromScroll]);

  useEffect(() => {
    return () => {
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
      }
    };
  }, []);

  const scrollTo = (id: string) => {
    const isChild = DASHBOARD_SECTIONS.some((s) =>
      (s.children ?? []).some((c) => c.id === id)
    );
    const parentId = isChild ? "trends-section" : id;

    setActiveId(parentId);
    setActiveChildId(isChild ? id : null);
    isClickScrollingRef.current = true;
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
    }
    clickTimeoutRef.current = setTimeout(() => {
      isClickScrollingRef.current = false;
      updateActiveFromScroll();
    }, 600);

    // 子锚点对应卡片可能未渲染（条件显示），回退滚动到 Trends section
    const target =
      document.getElementById(id) ??
      (isChild ? document.getElementById("trends-section") : null);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    onNavigate?.();
  };

  // 行内容 inline / flyout 共用，仅外层包裹不同
  const rows = (
    <>
      {DASHBOARD_SECTIONS.map(({ id, label, children }) => {
        const isActive = activeId === id;
        return (
          <div key={id} className="flex flex-col">
            <button
              type="button"
              onClick={() => scrollTo(id)}
              className={`block w-full rounded px-3 py-1.5 text-left text-sm transition-colors ${
                isActive
                  ? "bg-blue-50 font-medium text-blue-700"
                  : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
              }`}
              aria-current={isActive ? "location" : undefined}
            >
              {label}
            </button>
            {children && (
              <div className="ml-3 mt-0.5 space-y-0.5 border-l border-gray-200 pl-2.5">
                {children.map((child) => {
                  const isChildActive =
                    isActive && activeChildId === child.id;
                  return (
                    <button
                      key={child.id}
                      type="button"
                      onClick={() => scrollTo(child.id)}
                      className={`block w-full rounded px-2.5 py-1 text-left text-xs transition-colors ${
                        isChildActive
                          ? "bg-blue-50 font-medium text-blue-700"
                          : "text-gray-400 hover:bg-gray-50 hover:text-gray-600"
                      }`}
                      aria-current={isChildActive ? "location" : undefined}
                    >
                      {child.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );

  if (variant === "flyout") {
    return <div className="space-y-0.5">{rows}</div>;
  }

  return (
    <div className="ml-4 mt-1 space-y-0.5 border-l border-gray-200 pl-3 pb-1">
      {rows}
    </div>
  );
}

// collapsed（16px 图标 rail）时二级菜单（Dashboard 锚点 / Admin tab）用浮层展示：
// rail 自身不展开（避免鼠标掠过侧栏就整条弹开），浮层用 position: fixed 挂 viewport，
// 不受 nav 的 overflow-y-auto 裁剪；移入浮层时取消待执行的收起定时器，作为过桥区。
const FLYOUT_OPEN_DELAY_MS = 120;
const FLYOUT_CLOSE_DELAY_MS = 200;

type FlyoutKey = "dashboard" | "admin";

export default function AppSidebar({
  actions,
  collapsed,
  onToggleCollapse,
  onPreviewToggle,
}: AppSidebarProps) {
  const pathname = usePathname();
  const isAdmin = pathname?.startsWith("/admin") ?? false;
  const isRecords = pathname === "/records" || pathname?.startsWith("/records/") === true;
  // 锚点只存在于 Dashboard 页，其他路由 hover 不弹浮层（弹了也点不动）
  const hasDashboardSections = !isAdmin && !isRecords;

  // 展开态 Admin 二级菜单改为点击切换（/admin 本身只是 redirect，没有落地页）
  const [adminMenuOpen, setAdminMenuOpen] = useState(isAdmin);
  const [flyout, setFlyout] = useState<{ key: FlyoutKey; top: number; left: number } | null>(null);
  const dashboardItemRef = useRef<HTMLDivElement | null>(null);
  const adminItemRef = useRef<HTMLDivElement | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const focusFlyoutOnOpenRef = useRef(false);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isAdmin) setAdminMenuOpen(true);
  }, [isAdmin]);

  const cancelCloseFlyout = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const placeFlyout = useCallback((key: FlyoutKey) => {
    const anchor = (key === "dashboard" ? dashboardItemRef : adminItemRef).current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    // left 取导航项右边缘，浮层自带 pl-3 作为鼠标过桥区（等于 nav 的 px-3）
    setFlyout({ key, top: rect.top, left: rect.right });
  }, []);

  const closeFlyout = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    cancelCloseFlyout();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setFlyout(null);
    }, FLYOUT_CLOSE_DELAY_MS);
  }, [cancelCloseFlyout]);

  const openFlyout = useCallback(
    (key: FlyoutKey) => {
      if (!collapsed) return;
      cancelCloseFlyout();
      if (openTimerRef.current) return;
      openTimerRef.current = setTimeout(() => {
        openTimerRef.current = null;
        placeFlyout(key);
      }, FLYOUT_OPEN_DELAY_MS);
    },
    [collapsed, cancelCloseFlyout, placeFlyout]
  );

  // 键盘（ArrowDown/ArrowRight）立即打开并把焦点移进浮层（浮层在 nav 外，Tab 到不了）
  const openFlyoutByKeyboard = useCallback(
    (key: FlyoutKey) => {
      if (!collapsed) return;
      if (openTimerRef.current) {
        clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
      }
      cancelCloseFlyout();
      focusFlyoutOnOpenRef.current = true;
      placeFlyout(key);
    },
    [collapsed, cancelCloseFlyout, placeFlyout]
  );

  useEffect(() => {
    if (!flyout || !focusFlyoutOnOpenRef.current) return;
    focusFlyoutOnOpenRef.current = false;
    flyoutRef.current?.querySelector<HTMLElement>("a,button")?.focus();
  }, [flyout]);

  // 焦点在导航项与浮层间移动时不收浮层；真正移出才收
  const handleItemBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (event.currentTarget.contains(next)) return;
    if (flyoutRef.current?.contains(next)) return;
    closeFlyout();
  };

  const handleItemKeyDown = (
    key: FlyoutKey,
    event: ReactKeyboardEvent<HTMLDivElement>
  ) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowRight") return;
    event.preventDefault();
    openFlyoutByKeyboard(key);
  };

  useEffect(() => {
    return () => {
      if (openTimerRef.current) clearTimeout(openTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  // 侧栏展开、路由切换时立即收起浮层
  useEffect(() => {
    setFlyout(null);
  }, [collapsed, pathname]);

  useEffect(() => {
    if (!flyout) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFlyout(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [flyout]);

  const navItemClass = (active: boolean) =>
    `flex items-center gap-2 rounded-md py-2 text-sm font-medium transition-colors ${
      collapsed ? "justify-center px-0" : "px-3"
    } ${
      active
        ? "bg-blue-600 text-white"
        : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
    }`;

  // collapsed 时在有二级菜单的导航项右侧提示「hover 可展开」（需父元素 relative）
  const collapsedChevronHint = (
    <span
      className="absolute right-0.5 top-1/2 -translate-y-1/2 opacity-60"
      aria-hidden="true"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </span>
  );

  const adminIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );

  return (
    <aside
      className={`hidden md:flex fixed inset-y-0 left-0 z-40 flex-col border-r border-gray-200 bg-white transition-[width] duration-150 ${
        collapsed ? "w-16" : "w-56"
      }`}
    >
      <div
        className={`flex gap-2 pt-5 pb-3 ${
          collapsed ? "flex-col items-center px-2" : "items-baseline px-4"
        }`}
      >
        {!collapsed && (
          <>
            <Link href="/" className="text-lg font-bold text-gray-900">
              Token Tracker
            </Link>
            <span className="text-[11px] leading-none text-gray-400 select-all">
              {process.env.NEXT_PUBLIC_APP_VERSION || "dev"}
            </span>
          </>
        )}
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={`inline-flex items-center justify-center rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 ${
            collapsed ? "" : "ml-auto"
          }`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {collapsed ? (
              <>
                <polyline points="9 18 15 12 9 6" />
              </>
            ) : (
              <>
                <polyline points="15 18 9 12 15 6" />
              </>
            )}
          </svg>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-1" aria-label="Main navigation">
        <div
          ref={dashboardItemRef}
          className="relative"
          onMouseEnter={() => hasDashboardSections && openFlyout("dashboard")}
          onMouseLeave={closeFlyout}
          onFocus={() => hasDashboardSections && openFlyout("dashboard")}
          onBlur={handleItemBlur}
          onKeyDown={(event) =>
            hasDashboardSections && handleItemKeyDown("dashboard", event)
          }
        >
          <Link
            href="/"
            className={navItemClass(!isAdmin && !isRecords)}
            aria-current={!isAdmin && !isRecords ? "page" : undefined}
            title={collapsed ? "Dashboard" : undefined}
            aria-haspopup={collapsed && hasDashboardSections ? "true" : undefined}
            aria-expanded={
              collapsed && hasDashboardSections ? flyout?.key === "dashboard" : undefined
            }
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="9" rx="1" />
              <rect x="14" y="3" width="7" height="5" rx="1" />
              <rect x="14" y="12" width="7" height="9" rx="1" />
              <rect x="3" y="16" width="7" height="5" rx="1" />
            </svg>
            {!collapsed && "Dashboard"}
            {collapsed && hasDashboardSections && collapsedChevronHint}
          </Link>
        </div>
        {hasDashboardSections && !collapsed && <DashboardSectionsNav />}
        <Link
          href="/records"
          className={navItemClass(isRecords)}
          aria-current={isRecords ? "page" : undefined}
          title={collapsed ? "Records" : undefined}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
          {!collapsed && "Records"}
        </Link>
        <div
          ref={adminItemRef}
          className="relative"
          onMouseEnter={() => openFlyout("admin")}
          onMouseLeave={closeFlyout}
          onFocus={() => openFlyout("admin")}
          onBlur={handleItemBlur}
          onKeyDown={(event) => handleItemKeyDown("admin", event)}
        >
          {collapsed ? (
            <Link
              href="/admin"
              className={navItemClass(isAdmin)}
              aria-current={isAdmin ? "page" : undefined}
              title="Admin"
              aria-haspopup="true"
              aria-expanded={flyout?.key === "admin"}
            >
              {adminIcon}
              {collapsedChevronHint}
            </Link>
          ) : (
            /* 展开态：点击 Admin 只切换二级菜单，不跳转（/admin 本身只是 redirect） */
            <button
              type="button"
              onClick={() => setAdminMenuOpen((open) => !open)}
              aria-expanded={adminMenuOpen}
              aria-controls="admin-subnav"
              className={`${navItemClass(isAdmin)} w-full text-left`}
            >
              {adminIcon}
              Admin
              <span
                className={`ml-auto transition-transform ${
                  adminMenuOpen ? "rotate-90" : ""
                }`}
                aria-hidden="true"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
            </button>
          )}
        </div>

        {adminMenuOpen && !collapsed && (
          <div
            id="admin-subnav"
            className="ml-4 mt-1 space-y-0.5 border-l border-gray-200 pl-3 pb-1"
          >
            <AdminTabsNav />
          </div>
        )}
      </nav>

      {/* 二级菜单浮层：position: fixed 避开 nav 的 overflow-y-auto 裁剪；
          自带 pl-3 作鼠标过桥区，移入后取消待执行的收起 */}
      {collapsed && flyout && (
        <div
          ref={flyoutRef}
          className="fixed z-50 pl-3"
          style={{ top: flyout.top, left: flyout.left }}
          onMouseEnter={cancelCloseFlyout}
          onMouseLeave={closeFlyout}
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setFlyout(null);
          }}
        >
          <div className="w-44 rounded-md border border-gray-200 bg-white p-1 shadow-lg">
            {flyout.key === "dashboard" ? (
              <DashboardSectionsNav
                variant="flyout"
                onNavigate={() => setFlyout(null)}
              />
            ) : (
              <AdminTabsNav onNavigate={() => setFlyout(null)} />
            )}
          </div>
        </div>
      )}

      <div className="border-t border-gray-200 p-3 flex flex-col gap-2">
        {!collapsed && actions}
        <button
          type="button"
          onClick={onPreviewToggle}
          className={`inline-flex items-center justify-center gap-2 rounded-md border border-gray-300 bg-white py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 ${
            collapsed ? "px-0 w-full" : "px-3"
          }`}
          title="Preview the public status page"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          {!collapsed && "Public View"}
        </button>
      </div>
    </aside>
  );
}
