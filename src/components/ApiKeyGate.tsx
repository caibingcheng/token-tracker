"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  checkSession,
  apiLogout,
  registerUnauthorizedHandler,
  apiLogin,
  apiSetup,
  apiSetupSubmit,
} from "@/lib/client/api-client";
import AppSidebar, { SidebarActionsContext } from "./AppSidebar";
import MobileTabBar from "./MobileTabBar";
import OtpInput from "./OtpInput";
import { NumberFormatProvider } from "./NumberFormatContext";
import {
  getLoginKeyStrength,
  LOGIN_KEY_STRENGTH_META,
} from "@/lib/login-key-strength";

// 侧栏收起偏好（localStorage）：true = 仅图标 16px 宽，false = 完整 56px（14rem）
const SIDEBAR_COLLAPSED_KEY = "tt:sidebar-collapsed";

export default function ApiKeyGate({ children }: { children: React.ReactNode }) {
  // 初始 null = 未知（SSR/首帧不渲染登录表单，避免浏览器密码自动填充弹窗）；
  // 挂载后读取 localStorage 再决定渲染登录表单还是内容
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [inputKey, setInputKey] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [showTotp, setShowTotp] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [setupKey, setSetupKey] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [settingUp, setSettingUp] = useState(false);
  // Dashboard 注册到桌面侧栏底部的操作组节点（仅 Dashboard 页存在）
  const [sidebarActions, setSidebarActions] = useState<ReactNode>(null);
  // 桌面侧栏收起：纯本地 UI 偏好，存 localStorage（设备级，不进 DB）
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    try {
      setSidebarCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
    } catch {
      // 隐私模式等读不到 localStorage 时保持展开
    }
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // 写失败不影响本次状态
      }
      return next;
    });
  }, []);
  // 本地免密码直通（服务端 LOCAL_ADMIN_BYPASS + loopback Host 生效）：直接获得 admin，
  // 此模式下 logout / 401 跳转均为 no-op（用 ref 避免 callback 依赖问题）
  const localBypassRef = useRef(false);

  const handleUnauthorized = useCallback(() => {
    if (localBypassRef.current) return;
    setError("Invalid or missing session");
    setHasKey(false);
  }, []);

  useEffect(() => {
    // 先探测 setup 状态，再探登录态（httpOnly cookie 前端不可读，只能问 /api/auth/session）
    apiSetup().then(({ setupRequired, authDisabled }) => {
      setSetupRequired(setupRequired);
      if (authDisabled) {
        localBypassRef.current = true;
        setHasKey(true);
        return;
      }
      checkSession().then((authenticated) => {
        // 探测返回前可能已判定本地直通，以 bypass 为准
        if (localBypassRef.current) return;
        setHasKey(authenticated);
      });
    });
  }, []);

  useEffect(() => {
    return registerUnauthorizedHandler(handleUnauthorized);
  }, [handleUnauthorized]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputKey.trim();
    if (!trimmed || loggingIn) return;
    setLoggingIn(true);
    setError(null);
    try {
      if (!showTotp) {
        // 第一步：仅收集 key，不触网（服务端统一 401 文案，前端本地切到 TOTP 步骤）
        setShowTotp(true);
        return;
      }
      const result = await apiLogin(trimmed, totpCode.trim() || undefined);
      if (result.ok) {
        if (result.viaRecoveryCode) {
          alert(
            "You logged in with a recovery code. Please review your authenticator app and regenerate your recovery codes in Security settings."
          );
        }
        setInputKey("");
        setTotpCode("");
        setShowTotp(false);
        setUseRecovery(false);
        setHasKey(true);
        return;
      }
      setError(result.error || "Invalid credentials");
    } finally {
      setLoggingIn(false);
    }
  };

  // 登出须 await 服务端响应再切 UI：httpOnly cookie 前端清不掉，若 fire-and-forget，
  // 登出响应晚于紧接的登录回来会把新 cookie 清掉（竞态）
  const handleLogout = async () => {
    if (localBypassRef.current || loggingOut) return;
    setLoggingOut(true);
    try {
      await apiLogout();
    } finally {
      setLoggingOut(false);
      setInputKey("");
      setTotpCode("");
      setShowTotp(false);
      setUseRecovery(false);
      setError(null);
      setHasKey(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!setupKey.trim() || settingUp) return;
    if (setupKey !== setupConfirm) {
      setError("The two keys do not match");
      return;
    }
    setSettingUp(true);
    setError(null);
    try {
      const result = await apiSetupSubmit(setupKey.trim());
      if (result.ok) {
        setSetupRequired(false);
        setSetupKey("");
        setSetupConfirm("");
        setHasKey(true);
        return;
      }
      setError(result.error || "Setup failed");
    } finally {
      setSettingUp(false);
    }
  };

  if (hasKey === null) {
    return <main className="min-h-screen bg-gray-50" />;
  }

  if (!hasKey && setupRequired) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow">
          <div className="mb-6 text-center">
            <h1 className="text-xl font-bold text-gray-900">Token Tracker</h1>
            <p className="mt-1 text-sm text-gray-500">
              First-time setup: create your admin API Key to continue
            </p>
          </div>
          <form onSubmit={handleSetup} className="space-y-4">
            <input
              type="password"
              autoComplete="new-password"
              value={setupKey}
              onChange={(e) => setSetupKey(e.target.value)}
              placeholder="Admin API Key"
              autoFocus
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {setupKey.trim() && (
              <p className={`text-xs ${LOGIN_KEY_STRENGTH_META[getLoginKeyStrength(setupKey)].className}`}>
                Strength: {LOGIN_KEY_STRENGTH_META[getLoginKeyStrength(setupKey)].label}
                {getLoginKeyStrength(setupKey) !== "strong" &&
                  " — longer keys with mixed cases, digits or symbols are safer"}
              </p>
            )}
            <input
              type="password"
              autoComplete="new-password"
              value={setupConfirm}
              onChange={(e) => setSetupConfirm(e.target.value)}
              placeholder="Confirm Admin API Key"
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {error && (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={settingUp || !setupKey.trim()}
              className="w-full rounded bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-50"
            >
              {settingUp ? "Setting up..." : "Create & Continue"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (!hasKey) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow">
          <div className="mb-6 text-center">
            <h1 className="text-xl font-bold text-gray-900">Token Tracker</h1>
            <p className="mt-1 text-sm text-gray-500">
              {showTotp
                ? useRecovery
                  ? "Enter a recovery code"
                  : "Enter your 6-digit TOTP code (leave empty if not enabled)"
                : "Please enter your API Key to continue"}
            </p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            {!showTotp && (
              <input
                type="password"
                autoComplete="off"
                value={inputKey}
                onChange={(e) => setInputKey(e.target.value)}
                placeholder="API Key..."
                autoFocus
                className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            )}
            {showTotp && !useRecovery && (
              <OtpInput value={totpCode} onChange={setTotpCode} autoFocus />
            )}
            {showTotp && useRecovery && (
              <input
                type="text"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="Recovery code (XXXX-XXXX-XXXX-XXXX)"
                autoFocus
                className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            )}
            {showTotp && (
              <button
                type="button"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setTotpCode("");
                  setError(null);
                }}
                className="w-full text-center text-xs text-gray-400 hover:text-gray-600 min-h-[40px]"
              >
                {useRecovery ? "← Use TOTP code instead" : "Use a recovery code instead"}
              </button>
            )}
            {error && (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={loggingIn}
              className="w-full rounded bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-50"
            >
              {loggingIn ? "Signing in..." : showTotp ? "Verify" : "Continue"}
            </button>
            {showTotp && (
              <button
                type="button"
                onClick={() => {
                  setShowTotp(false);
                  setUseRecovery(false);
                  setTotpCode("");
                  setError(null);
                }}
                className="w-full text-center text-xs text-gray-400 hover:text-gray-600"
              >
                ← Back
              </button>
            )}
          </form>
        </div>
      </main>
    );
  }

  return (
    <NumberFormatProvider>
      <SidebarActionsContext.Provider value={{ setSidebarActions }}>
        {/* 桌面端内容区左移让出侧栏宽度 */}
        <div className={sidebarCollapsed ? "md:pl-16" : "md:pl-56"}>{children}</div>
        <AppSidebar
          actions={sidebarActions}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebarCollapsed}
        />
        <MobileTabBar onLogout={handleLogout} />
        <button
          type="button"
          onClick={() => void handleLogout()}
          disabled={loggingOut}
          className="hidden md:block fixed bottom-4 right-4 z-50 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-500 shadow-sm hover:bg-gray-50 hover:text-red-600 transition-colors disabled:opacity-50"
          title="Logout"
        >
          {loggingOut ? "Logging out..." : "Logout"}
        </button>
      </SidebarActionsContext.Provider>
    </NumberFormatProvider>
  );
}
