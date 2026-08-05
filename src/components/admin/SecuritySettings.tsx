"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import { QRCodeSVG } from "qrcode.react";

interface TotpStatus {
  totpEnabled: boolean;
  pendingSecret: boolean;
}

interface PendingTotp {
  secret: string;
  otpauthUri: string;
}

export default function SecuritySettings() {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [pending, setPending] = useState<PendingTotp | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [unbindCode, setUnbindCode] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [newApiKeyConfirm, setNewApiKeyConfirm] = useState("");
  const [apiKeyCode, setApiKeyCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    const res = await apiFetch("/api/admin/auth/totp");
    const json = await res.json();
    if (json.success) {
      setStatus(json.data as TotpStatus);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleGenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/auth/totp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (json.success) {
        setPending(json.data as PendingTotp);
      } else {
        setError(json.error || "Failed to generate TOTP secret");
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmEnable = async () => {
    if (!confirmCode.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/auth/totp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: confirmCode.trim() }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Failed to enable TOTP");
        return;
      }
      setPending(null);
      setConfirmCode("");
      loadStatus();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    if (!unbindCode.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/auth/totp", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: unbindCode.trim() }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Failed to disable TOTP");
        return;
      }
      setUnbindCode("");
      loadStatus();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  const handleChangeApiKey = async () => {
    if (newApiKey.length < 8 || busy) {
      setError("New key must be at least 8 characters");
      return;
    }
    if (newApiKey !== newApiKeyConfirm) {
      setError("New key confirmation does not match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/auth/api-key", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          newApiKey,
          totpCode: status?.totpEnabled ? apiKeyCode.trim() : undefined,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Failed to change API key");
        return;
      }
      setNewApiKey("");
      setNewApiKeyConfirm("");
      setApiKeyCode("");
      alert("API key changed. All existing sessions have been revoked — log in again with the new key.");
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg bg-white p-6 shadow">
      <h2 className="mb-4 text-lg font-semibold">Security</h2>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {/* TOTP */}
      <div className="mb-6">
        <h3 className="mb-2 text-sm font-medium text-gray-700">
          Two-Factor Authentication (TOTP)
          {status?.totpEnabled && (
            <span className="ml-2 rounded bg-green-50 px-2 py-0.5 text-xs text-green-600">
              enabled
            </span>
          )}
        </h3>

        {!status?.totpEnabled && !pending && (
          <button
            type="button"
            onClick={handleGenerate}
            disabled={busy}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "Generating..." : "Enable 2FA"}
          </button>
        )}

        {pending && pending.otpauthUri && (
          <div className="mt-3 space-y-3 rounded border border-gray-200 bg-gray-50 p-4">
            <p className="text-sm text-gray-600">
              Scan this QR code with your authenticator app, then enter the 6-digit code to confirm:
            </p>
            <div className="rounded bg-white p-3 inline-block">
              <QRCodeSVG value={pending.otpauthUri} size={180} />
            </div>
            <div className="text-xs text-gray-500">
              <p className="mb-1">Or enter manually:</p>
              <code className="break-all rounded bg-gray-100 px-2 py-1">{pending.secret}</code>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
                placeholder="6-digit code"
                inputMode="numeric"
                maxLength={6}
                className="w-32 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={handleConfirmEnable}
                disabled={busy}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Confirm & Enable
              </button>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {status?.totpEnabled && (
          <div className="mt-2 flex items-center gap-2">
            <input
              value={unbindCode}
              onChange={(e) => setUnbindCode(e.target.value)}
              placeholder="Current 6-digit code"
              inputMode="numeric"
              maxLength={6}
              className="w-36 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="button"
              onClick={handleDisable}
              disabled={busy}
              className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Disable 2FA
            </button>
          </div>
        )}
      </div>

      {/* 修改登录 key */}
      <div>
        <h3 className="mb-2 text-sm font-medium text-gray-700">Change Login API Key</h3>
        <p className="mb-3 text-xs text-gray-400">
          Changing the key revokes all existing sessions immediately.{" "}
          {status?.totpEnabled && "TOTP code required."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            autoComplete="new-password"
            value={newApiKey}
            onChange={(e) => setNewApiKey(e.target.value)}
            placeholder="New API key (min 8 chars)"
            className="w-56 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <input
            type="password"
            autoComplete="new-password"
            value={newApiKeyConfirm}
            onChange={(e) => setNewApiKeyConfirm(e.target.value)}
            placeholder="Confirm new key"
            className="w-56 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {status?.totpEnabled && (
            <input
              value={apiKeyCode}
              onChange={(e) => setApiKeyCode(e.target.value)}
              placeholder="TOTP code"
              inputMode="numeric"
              maxLength={6}
              className="w-28 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          )}
          <button
            type="button"
            onClick={handleChangeApiKey}
            disabled={busy}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Change Key
          </button>
        </div>
      </div>
    </div>
  );
}
