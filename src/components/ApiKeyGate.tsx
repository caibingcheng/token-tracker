"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getApiKey,
  clearApiKey,
  registerUnauthorizedHandler,
  apiLogin,
  apiSetup,
  apiSetupSubmit,
} from "@/lib/client/api-client";
import MobileTabBar from "./MobileTabBar";

export default function ApiKeyGate({ children }: { children: React.ReactNode }) {
  // 初始一律未认证（SSR 无 localStorage，避免 hydration mismatch），挂载后读取
  const [hasKey, setHasKey] = useState<boolean>(false);
  const [inputKey, setInputKey] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpRequired, setTotpRequired] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [setupKey, setSetupKey] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [settingUp, setSettingUp] = useState(false);

  const handleUnauthorized = useCallback(() => {
    setError("Invalid or missing session");
    setHasKey(false);
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
      const result = await apiLogin(trimmed, totpRequired ? totpCode.trim() : undefined);
      if (result.ok) {
        setInputKey("");
        setTotpCode("");
        setTotpRequired(false);
        setHasKey(true);
        return;
      }
      if (result.totpRequired) {
        const wasTotpStep = totpRequired;
        setTotpRequired(true);
        // 刚从 API key 进入 TOTP 步骤时不弹错误；仅当动态码本身校验失败才提示
        setError(wasTotpStep ? result.error || "Invalid TOTP code" : null);
        return;
      }
      setError(result.error || "Login failed");
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = () => {
    clearApiKey();
    setInputKey("");
    setTotpCode("");
    setTotpRequired(false);
    setError(null);
    setHasKey(false);
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

  if (!hasKey) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow">
          <div className="mb-6 text-center">
            <h1 className="text-xl font-bold text-gray-900">Token Tracker</h1>
            <p className="mt-1 text-sm text-gray-500">
              {totpRequired ? "Enter your TOTP code" : "Please enter your API Key to continue"}
            </p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            {!totpRequired && (
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
            {totpRequired && (
              <input
                type="text"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="6-digit code"
                autoFocus
                inputMode="numeric"
                maxLength={6}
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
              {loggingIn ? "Signing in..." : totpRequired ? "Verify" : "Continue"}
            </button>
            {totpRequired && (
              <button
                type="button"
                onClick={() => {
                  setTotpRequired(false);
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
    <>
      {children}
      <MobileTabBar onLogout={handleLogout} />
      <button
        type="button"
        onClick={handleLogout}
        className="hidden md:block fixed bottom-4 right-4 z-50 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-500 shadow-sm hover:bg-gray-50 hover:text-red-600 transition-colors"
        title="Logout"
      >
        Logout
      </button>
    </>
  );
}
