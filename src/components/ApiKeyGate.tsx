"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  getApiKey,
  clearApiKey,
  registerUnauthorizedHandler,
  apiLogin,
  apiSetup,
  apiSetupSubmit,
} from "@/lib/client/api-client";
import MobileTabBar from "./MobileTabBar";
import PublicStatusView from "./PublicStatusView";

// 登录后预览公开 Status 面板的切换开关（Dashboard / MobileTabBar 消费）
interface PublicPreviewContextValue {
  previewPublic: boolean;
  togglePreview: () => void;
}

export const PublicPreviewContext = createContext<PublicPreviewContextValue>({
  previewPublic: false,
  togglePreview: () => {},
});

export function usePublicPreview() {
  return useContext(PublicPreviewContext);
}

export default function ApiKeyGate({ children }: { children: React.ReactNode }) {
  // 初始 null = 未知（SSR/首帧不渲染登录表单，避免浏览器密码自动填充弹窗）；
  // 挂载后读取 localStorage 再决定渲染登录表单还是内容
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [inputKey, setInputKey] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [showTotp, setShowTotp] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [setupKey, setSetupKey] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [settingUp, setSettingUp] = useState(false);
  // 未登录视图：public = 公开面板（status_page_config 启用时），login = 登录表单
  const [gateView, setGateView] = useState<"public" | "login">("public");
  const [statusEnabled, setStatusEnabled] = useState(true);
  // 登录后预览公开面板（替代 children 渲染 PublicStatusView）
  const [previewPublic, setPreviewPublic] = useState(false);

  const previewContextValue = useMemo(
    () => ({
      previewPublic,
      togglePreview: () => setPreviewPublic((v) => !v),
    }),
    [previewPublic]
  );

  const handleUnauthorized = useCallback(() => {
    setError("Invalid or missing session");
    setHasKey(false);
    setGateView("public");
    setPreviewPublic(false);
  }, []);

  useEffect(() => {
    setHasKey(getApiKey() !== null);
    apiSetup().then(({ setupRequired }) => setSetupRequired(setupRequired));
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
        setHasKey(true);
        return;
      }
      setError(result.error || "Invalid credentials");
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = () => {
    clearApiKey();
    setInputKey("");
    setTotpCode("");
    setShowTotp(false);
    setError(null);
    setHasKey(false);
    setGateView("public");
    setPreviewPublic(false);
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (setupKey.length < 16 || settingUp) return;
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
              placeholder="Admin API Key (min 16 characters)"
              autoFocus
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
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
              disabled={settingUp || setupKey.length < 16}
              className="w-full rounded bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-50"
            >
              {settingUp ? "Setting up..." : "Create & Continue"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (!hasKey && gateView === "public") {
    return (
      <PublicStatusView
        onDisabled={() => {
          setStatusEnabled(false);
          setGateView("login");
        }}
        onLoginRequest={() => setGateView("login")}
      />
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
                ? "Enter your TOTP code or recovery code (leave empty if not enabled)"
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
            {showTotp && (
              <input
                type="text"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="6-digit code or recovery code"
                autoFocus
                className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
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
                  setError(null);
                }}
                className="w-full text-center text-xs text-gray-400 hover:text-gray-600"
              >
                ← Back
              </button>
            )}
          </form>
          {statusEnabled && (
            <button
              type="button"
              onClick={() => setGateView("public")}
              className="mt-4 w-full text-center text-xs text-gray-400 hover:text-gray-600 min-h-[40px]"
            >
              ← Back to status
            </button>
          )}
        </div>
      </main>
    );
  }

  return (
    <PublicPreviewContext.Provider value={previewContextValue}>
      {previewPublic ? (
        <PublicStatusView
          preview
          onExit={() => setPreviewPublic(false)}
          onDisabled={() => setGateView("login")}
          onLoginRequest={() => setGateView("login")}
        />
      ) : (
        children
      )}
      <MobileTabBar
        onLogout={handleLogout}
        previewActive={previewPublic}
        onPreviewToggle={() => setPreviewPublic((v) => !v)}
      />
      <button
        type="button"
        onClick={handleLogout}
        className="hidden md:block fixed bottom-4 right-4 z-50 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-500 shadow-sm hover:bg-gray-50 hover:text-red-600 transition-colors"
        title="Logout"
      >
        Logout
      </button>
    </PublicPreviewContext.Provider>
  );
}
