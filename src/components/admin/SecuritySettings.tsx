"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, notifyUnauthorized } from "@/lib/client/api-client";
import { QRCodeSVG } from "qrcode.react";
import { CopyableCode } from "./CopyableCode";

interface TotpStatus {
  totpEnabled: boolean;
  pendingSecret: boolean;
}

interface PendingTotp {
  secret: string;
  otpauthUri: string;
}

interface RecoveryInfo {
  remaining: number;
  reminder: boolean;
  exists: boolean;
}

interface SessionTtlData {
  value: number | null;
  envValue: string | null;
  envOverridden: boolean;
}

interface StreamTimeoutData {
  value: number | null;
}

export default function SecuritySettings() {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [pending, setPending] = useState<PendingTotp | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [unbindCode, setUnbindCode] = useState("");
  const [rebindCode, setRebindCode] = useState("");
  const [showRebind, setShowRebind] = useState(false);
  const [regenCode, setRegenCode] = useState("");
  const [showRegen, setShowRegen] = useState(false);
  const [newApiKey, setNewApiKey] = useState("");
  const [newApiKeyConfirm, setNewApiKeyConfirm] = useState("");
  const [apiKeyCode, setApiKeyCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  // 弹窗内的恢复码是否来自换绑（换绑后会话已被吊销，关闭弹窗时必须提示重新登录）
  const [recoveryIsRebind, setRecoveryIsRebind] = useState(false);
  const [recoveryInfo, setRecoveryInfo] = useState<RecoveryInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ttlData, setTtlData] = useState<SessionTtlData | null>(null);
  const [ttlDraft, setTtlDraft] = useState("");
  const [ttlBusy, setTtlBusy] = useState(false);
  const [ttlError, setTtlError] = useState<string | null>(null);
  const [ttlSaved, setTtlSaved] = useState(false);
  const [streamData, setStreamData] = useState<StreamTimeoutData | null>(null);
  const [streamDraft, setStreamDraft] = useState("");
  const [streamBusy, setStreamBusy] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamSaved, setStreamSaved] = useState(false);

  const loadStatus = useCallback(async () => {
    const res = await apiFetch("/api/admin/auth/totp");
    const json = await res.json();
    if (json.success) {
      setStatus(json.data as TotpStatus);
    }
  }, []);

  const loadRecoveryInfo = useCallback(async () => {
    const res = await apiFetch("/api/admin/auth/recovery-codes");
    const json = await res.json();
    if (json.success) {
      setRecoveryInfo(json.data as RecoveryInfo);
    }
  }, []);

  const loadRuntimeSettings = useCallback(async () => {
    const [ttlRes, streamRes] = await Promise.all([
      apiFetch("/api/admin/settings/session"),
      apiFetch("/api/admin/settings/stream"),
    ]);
    const ttlJson = await ttlRes.json();
    const streamJson = await streamRes.json();
    if (ttlJson.success) {
      const t = ttlJson.data as SessionTtlData;
      setTtlData(t);
      setTtlDraft(t.value !== null ? String(t.value) : "");
    }
    if (streamJson.success) {
      const s = streamJson.data as StreamTimeoutData;
      setStreamData(s);
      setStreamDraft(s.value !== null ? String(s.value) : "");
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadRecoveryInfo();
    loadRuntimeSettings();
  }, [loadStatus, loadRecoveryInfo, loadRuntimeSettings]);

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

  // 换绑第一步：用旧 secret 验证当前动态码，通过后展示新二维码
  const handleRebindVerify = async () => {
    if (!rebindCode.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/auth/totp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentCode: rebindCode.trim() }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Failed to verify current TOTP code");
        return;
      }
      setShowRebind(false);
      setRebindCode("");
      setPending(json.data as PendingTotp);
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
      const isRebind = status?.totpEnabled === true;
      setPending(null);
      setConfirmCode("");
      if (json.data?.recoveryCodes) {
        setRecoveryCodes(json.data.recoveryCodes as string[]);
        setRecoveryIsRebind(isRebind);
      }
      if (isRebind) {
        // 换绑成功后 bumpTokenEpoch 已吊销全部会话：此时任何 API 请求都会 401
        // 提前把用户踢回登录页，导致 recovery codes 弹窗来不及展示。故不再刷新
        // 状态，弹窗关闭时统一提示并跳转登录。
        if (!json.data?.recoveryCodes) {
          alert(
            "2FA has been rebound. All sessions were revoked — please log in again."
          );
          notifyUnauthorized();
        }
      } else {
        loadStatus();
        loadRecoveryInfo();
      }
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
      loadRecoveryInfo();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  // 生成/重新生成 recovery codes（需当前 TOTP 验证，不吊销会话）
  const handleRegenerateCodes = async () => {
    if (!regenCode.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/auth/recovery-codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentCode: regenCode.trim() }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Failed to regenerate recovery codes");
        return;
      }
      setShowRegen(false);
      setRegenCode("");
      if (json.data?.recoveryCodes) {
        setRecoveryCodes(json.data.recoveryCodes as string[]);
      }
      loadRecoveryInfo();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  // 「我已检查」：清除 recovery code 登录提醒标记
  const handleDismissReminder = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/admin/auth/recovery-codes/reminder", {
        method: "DELETE",
      });
      loadRecoveryInfo();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  const handleChangeApiKey = async () => {
    if (newApiKey.length < 16 || busy) {
      setError("New key must be at least 16 characters with 2 character classes");
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

  const handleSaveTtl = async () => {
    setTtlBusy(true);
    setTtlError(null);
    setTtlSaved(false);
    try {
      const res = await apiFetch("/api/admin/settings/session", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: ttlDraft }),
      });
      const json = await res.json();
      if (json.success) {
        setTtlSaved(true);
        loadRuntimeSettings();
      } else {
        setTtlError(json.error || "Failed to save");
      }
    } catch {
      setTtlError("Network error");
    } finally {
      setTtlBusy(false);
    }
  };

  const handleSaveStream = async () => {
    setStreamBusy(true);
    setStreamError(null);
    setStreamSaved(false);
    try {
      const res = await apiFetch("/api/admin/settings/stream", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: streamDraft }),
      });
      const json = await res.json();
      if (json.success) {
        setStreamSaved(true);
        loadRuntimeSettings();
      } else {
        setStreamError(json.error || "Failed to save");
      }
    } catch {
      setStreamError("Network error");
    } finally {
      setStreamBusy(false);
    }
  };

  const showRecoveryBanner =
    status?.totpEnabled &&
    recoveryInfo &&
    !recoveryInfo.exists &&
    !pending;
  const showExhaustedBanner =
    status?.totpEnabled &&
    recoveryInfo &&
    recoveryInfo.exists &&
    recoveryInfo.remaining === 0 &&
    !pending;

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

        {status?.totpEnabled && !pending && !showRebind && (
          <button
            type="button"
            onClick={() => setShowRebind(true)}
            disabled={busy}
            className="rounded border border-blue-200 px-3 py-1.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50"
          >
            Rebind 2FA
          </button>
        )}

        {showRebind && (
          <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-4">
            <p className="mb-3 text-sm text-gray-600">
              Enter your current 6-digit code to start rebinding. Rebinding revokes
              all existing sessions.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={rebindCode}
                onChange={(e) => setRebindCode(e.target.value)}
                placeholder="Current 6-digit code"
                inputMode="numeric"
                maxLength={6}
                className="w-36 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={handleRebindVerify}
                disabled={busy}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Verify
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowRebind(false);
                  setRebindCode("");
                }}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                Cancel
              </button>
            </div>
          </div>
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

      {/* Recovery codes */}
      {status?.totpEnabled && (
        <div className="mb-6">
          <h3 className="mb-2 text-sm font-medium text-gray-700">
            Recovery Codes
            {recoveryInfo && (
              <span className="ml-2 text-xs text-gray-400">
                {recoveryInfo.remaining} remaining
              </span>
            )}
          </h3>

          {recoveryInfo?.reminder && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
              <span>
                Recovery code was used to log in. Please review and regenerate your
                recovery codes.
              </span>
              <button
                type="button"
                onClick={handleDismissReminder}
                disabled={busy}
                className="min-h-10 rounded border border-yellow-300 px-3 py-1.5 text-xs font-medium hover:bg-yellow-100 disabled:opacity-50"
              >
                I&apos;ve reviewed
              </button>
            </div>
          )}

          {showRecoveryBanner && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
              <span>
                No recovery codes generated yet. Generate some to keep a backup
                login method if you lose your authenticator device.
              </span>
              <button
                type="button"
                onClick={() => setShowRegen(true)}
                disabled={busy}
                className="min-h-10 rounded border border-yellow-300 px-3 py-1.5 text-xs font-medium hover:bg-yellow-100 disabled:opacity-50"
              >
                Generate codes
              </button>
            </div>
          )}

          {showExhaustedBanner && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <span>
                All recovery codes have been used. Regenerate new ones to keep a
                backup login method.
              </span>
              <button
                type="button"
                onClick={() => setShowRegen(true)}
                disabled={busy}
                className="min-h-10 rounded border border-red-300 px-3 py-1.5 text-xs font-medium hover:bg-red-100 disabled:opacity-50"
              >
                Regenerate
              </button>
            </div>
          )}

          {showRegen && (
            <div className="mt-2 rounded border border-gray-200 bg-gray-50 p-3">
              <p className="mb-3 text-xs text-gray-500">
                Enter your current TOTP code to generate new recovery codes. Old
                codes are invalidated immediately.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={regenCode}
                  onChange={(e) => setRegenCode(e.target.value)}
                  placeholder="Current 6-digit code"
                  inputMode="numeric"
                  maxLength={6}
                  className="w-36 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={handleRegenerateCodes}
                  disabled={busy}
                  className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Generate
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowRegen(false);
                    setRegenCode("");
                  }}
                  className="text-xs text-gray-400 hover:text-gray-600"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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
            placeholder="New API key (min 16 chars, 2 classes)"
            className="w-full sm:w-56 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <input
            type="password"
            autoComplete="new-password"
            value={newApiKeyConfirm}
            onChange={(e) => setNewApiKeyConfirm(e.target.value)}
            placeholder="Confirm new key"
            className="w-full sm:w-56 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {status?.totpEnabled && (
            <input
              value={apiKeyCode}
              onChange={(e) => setApiKeyCode(e.target.value)}
              placeholder="TOTP code"
              inputMode="numeric"
              maxLength={6}
              className="w-full sm:w-28 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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

      {/* Session token lifetime */}
      <div className="mt-6 border-t pt-4">
        <h3 className="mb-2 text-sm font-medium text-gray-700">
          Session token lifetime
        </h3>
        <p className="mb-3 text-xs text-gray-400">
          Affects only newly issued tokens; already-issued tokens keep their
          original expiry. Overrides{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">SESSION_TOKEN_TTL_HOURS</code>{" "}
          env (default 24h).
        </p>

        {ttlData?.envOverridden && (
          <div className="mb-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
            env SESSION_TOKEN_TTL_HOURS has been overridden by the panel.
          </div>
        )}
        {ttlData?.envValue && !ttlData.envOverridden && (
          <div className="mb-3 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
            Currently falling back to env SESSION_TOKEN_TTL_HOURS (
            {ttlData.envValue}h). Save a value here to take over.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            max={720}
            value={ttlDraft}
            onChange={(e) => {
              setTtlDraft(e.target.value);
              setTtlSaved(false);
            }}
            placeholder="24"
            className="w-full sm:w-32 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-500">hours (1–720)</span>
          <button
            type="button"
            onClick={handleSaveTtl}
            disabled={ttlBusy}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {ttlBusy ? "Saving..." : "Save"}
          </button>
        </div>
        {ttlDraft.trim() === "" && (
          <p className="mt-2 text-xs text-gray-400">
            Empty = fall back to env / default 24h.
          </p>
        )}
        {ttlError && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {ttlError}
          </div>
        )}
        {ttlSaved && (
          <div className="mt-3 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
            Saved. New logins will use the updated lifetime.
          </div>
        )}
      </div>

      {/* 全局登出 */}
      <div className="mt-6 border-t pt-4">
        <h3 className="mb-2 text-sm font-medium text-gray-700">Revoke All Sessions</h3>
        <p className="mb-3 text-xs text-gray-400">
          Immediately invalidates every logged-in session (including this one). You will need to
          log in again.
        </p>
        <button
          type="button"
          onClick={async () => {
            if (!window.confirm("Revoke ALL sessions? You will be logged out.")) return;
            setBusy(true);
            setError(null);
            try {
              const res = await apiFetch("/api/admin/auth/sessions", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({}),
              });
              const json = await res.json();
              if (json.success) {
                alert("All sessions revoked. Log in again.");
              } else {
                setError(json.error || "Failed to revoke sessions");
              }
            } catch {
              setError("Network error");
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
          className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
        >
          Revoke All Sessions
        </button>
      </div>

      {/* Stream idle timeout */}
      <div className="mt-6 border-t pt-4">
        <h3 className="mb-2 text-sm font-medium text-gray-700">
          Stream idle timeout
        </h3>
        <p className="mb-3 text-xs text-gray-400">
          Streaming responses are aborted after receiving no data for this
          duration (prevents stuck upstream connections from lingering). Applies
          to new streams; default 30 minutes.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            max={1440}
            value={streamDraft}
            onChange={(e) => {
              setStreamDraft(e.target.value);
              setStreamSaved(false);
            }}
            placeholder="30"
            className="w-full sm:w-32 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-500">minutes (1–1440)</span>
          <button
            type="button"
            onClick={handleSaveStream}
            disabled={streamBusy}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {streamBusy ? "Saving..." : "Save"}
          </button>
        </div>
        {streamDraft.trim() === "" && (
          <p className="mt-2 text-xs text-gray-400">
            Empty = fall back to default 30 minutes.
          </p>
        )}
        {streamError && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {streamError}
          </div>
        )}
        {streamSaved && (
          <div className="mt-3 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
            Saved. New streams will use the updated timeout.
          </div>
        )}
      </div>

      {/* Recovery codes 明文弹窗：仅生成成功时展示一次，关闭后无法再次查看 */}
      {recoveryCodes && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-0 md:p-4">
          <div className="flex h-full w-full flex-col overflow-y-auto rounded-none bg-white p-6 shadow-xl md:h-auto md:max-h-[85vh] md:w-[480px] md:rounded-lg">
            <h3 className="mb-2 text-lg font-semibold">Recovery Codes</h3>
            <p className="mb-4 text-sm text-amber-600">
              Save these codes now — they will not be shown again. Each code can be
              used once to log in if you lose your authenticator device.
            </p>
            <div className="mb-6 space-y-2">
              {recoveryCodes.map((code) => (
                <CopyableCode
                  key={code}
                  className="block rounded border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-base tracking-widest"
                >
                  {code}
                </CopyableCode>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setRecoveryCodes(null);
                setRecoveryIsRebind(false);
                if (recoveryIsRebind) {
                  alert(
                    "2FA has been rebound. All sessions were revoked — please log in again."
                  );
                  notifyUnauthorized();
                }
              }}
              className="mt-auto min-h-10 w-full rounded bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 active:scale-[0.98] transition-all"
            >
              I saved them
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
