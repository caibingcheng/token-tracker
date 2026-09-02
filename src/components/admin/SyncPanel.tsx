"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import { CopyableCode } from "./CopyableCode";
import { copyText } from "@/lib/clipboard";
import { maskVirtualKey } from "@/lib/mask-utils";

// Admin Sync tab：多实例同步管理。
// - A 角色能力：ingest token 管理（创建/启停/解绑/删除）+ 实例水位查看/删除
// - B 角色能力：同步配置（A URL + token + instance name）+ 推送状态/手动触发/跳过/重置

export interface IngestTokenItem {
  id: number;
  name: string;
  apiKey: string | null;
  enabled: boolean;
  boundUid: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface SyncInstanceItem {
  uid: string;
  instanceName: string | null;
  epoch: string;
  lastRecordId: number;
  updatedAt: string | null;
}

export interface SyncStatusData {
  configured: boolean;
  targetUrl: string | null;
  hasToken: boolean;
  instance: string;
  uid: string;
  epoch: string;
  cursor: number;
  pendingCount: number;
  maxRecordId: number;
  droppedCount: number;
  boundUid: string | null;
  lastSuccessAt: string | null;
  lastError: {
    type: "auth" | "batch_rejected" | "network" | "server" | "internal";
    message: string;
    firstFailedAt: string;
  } | null;
  lastAttemptAt: string | null;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "—";
  }
}

// 输入时实时校验：空值不算错（留空 = 不修改/不配置），有输入才校验
function validateTargetUrlInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol === "http:" || u.protocol === "https:") return null;
    return "Must be an http(s) URL";
  } catch {
    return "Must be a valid http(s) URL";
  }
}

function validateTokenInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!trimmed.startsWith("it-")) return "Must be non-empty and start with it-";
  return null;
}

function ErrorBadge({ type }: { type: string }) {
  const cls =
    type === "auth"
      ? "border-red-200 bg-red-50 text-red-700"
      : type === "batch_rejected"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-gray-200 bg-gray-50 text-gray-600";
  const label =
    type === "auth"
      ? "Auth"
      : type === "batch_rejected"
        ? "Rejected"
        : type === "server"
          ? "Server"
          : type === "network"
            ? "Network"
            : "Internal";
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

export default function SyncPanel() {
  // ---- ingest tokens（A 角色）----
  const [tokens, setTokens] = useState<IngestTokenItem[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newTokenPlain, setNewTokenPlain] = useState<{ name: string; apiKey: string } | null>(null);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [tokensSuccess, setTokensSuccess] = useState<string | null>(null);

  // ---- sync instances（A 角色）----
  const [instances, setInstances] = useState<SyncInstanceItem[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [instancesSuccess, setInstancesSuccess] = useState<string | null>(null);
  const [pendingDeleteInstance, setPendingDeleteInstance] = useState<SyncInstanceItem | null>(null);
  const [deleteInstanceRecords, setDeleteInstanceRecords] = useState(false);

  // ---- B 端配置 ----
  const [targetUrl, setTargetUrl] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [configuredInstance, setConfiguredInstance] = useState("");
  const [boundUid, setBoundUid] = useState<string | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSuccess, setConfigSuccess] = useState<string | null>(null);

  // ---- B 端状态 ----
  const [status, setStatus] = useState<SyncStatusData | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [skipInput, setSkipInput] = useState("");
  const [skipping, setSkipping] = useState(false);
  const [resetting, setResetting] = useState(false);

  // ---- 通用 ----
  const [loading, setLoading] = useState(true);
  const [copiedToken, setCopiedToken] = useState<number | null>(null);

  const copyTokenKey = async (token: IngestTokenItem) => {
    if (!token.apiKey) return;
    const ok = await copyText(token.apiKey);
    if (ok) {
      setCopiedToken(token.id);
      setTimeout(() => setCopiedToken(null), 1500);
    }
  };

  const loadTokens = useCallback(async () => {
    try {
      const res = await apiFetch("/api/admin/ingest-tokens");
      const json = await res.json();
      if (json.success) {
        setTokens(json.data as IngestTokenItem[]);
      } else {
        setTokensError(json.error || "Failed to load ingest tokens");
      }
    } catch {
      setTokensError("Network error");
    }
  }, []);

  const loadInstances = useCallback(async () => {
    try {
      const res = await apiFetch("/api/admin/sync-instances");
      const json = await res.json();
      if (json.success) {
        setInstances(json.data as SyncInstanceItem[]);
      } else {
        setInstancesError(json.error || "Failed to load sync instances");
      }
    } catch {
      setInstancesError("Network error");
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await apiFetch("/api/admin/sync/config");
      const json = await res.json();
      if (json.success) {
        const data = json.data as {
          targetUrl: string | null;
          hasToken: boolean;
          instance: string;
          uid: string;
          epoch: string;
          boundUid: string | null;
        };
        setTargetUrl(data.targetUrl ?? "");
        setTokenInput(""); // 不回显
        setConfiguredInstance(data.instance);
        setInstanceName(data.instance);
        setBoundUid(data.boundUid);
      }
    } catch {
      // 静默
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/api/admin/sync/status");
      const json = await res.json();
      if (json.success) {
        setStatus(json.data as SyncStatusData);
      } else {
        setStatusError(json.error || "Failed to load sync status");
      }
    } catch {
      setStatusError("Network error");
    }
  }, []);

  const reloadAll = useCallback(async () => {
    setLoading(true);
    setTokensError(null);
    setInstancesError(null);
    setStatusError(null);
    await Promise.all([loadTokens(), loadInstances(), loadConfig(), loadStatus()]);
    setLoading(false);
  }, [loadTokens, loadInstances, loadConfig, loadStatus]);

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);

  // ---- ingest token actions ----
  const createToken = async () => {
    const name = tokenName.trim();
    if (!name) return;
    setCreating(true);
    setTokensError(null);
    setTokensSuccess(null);
    try {
      const res = await apiFetch("/api/admin/ingest-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (json.success) {
        setNewTokenPlain({ name, apiKey: json.data.apiKey });
        setTokenName("");
        await loadTokens();
      } else {
        setTokensError(json.error || "Failed to create token");
      }
    } catch {
      setTokensError("Network error");
    } finally {
      setCreating(false);
    }
  };

  const toggleToken = async (token: IngestTokenItem) => {
    setTokensError(null);
    try {
      const res = await apiFetch(`/api/admin/ingest-tokens/${token.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !token.enabled }),
      });
      const json = await res.json();
      if (!json.success) {
        setTokensError(json.error || "Failed to update token");
      }
      await loadTokens();
    } catch {
      setTokensError("Network error");
    }
  };

  const unbindToken = async (token: IngestTokenItem) => {
    if (!window.confirm(`Unbind ingest token "${token.name}"? The next push will bind to the new instance uid.`)) return;
    setTokensError(null);
    try {
      const res = await apiFetch(`/api/admin/ingest-tokens/${token.id}/unbind`, { method: "POST" });
      const json = await res.json();
      if (!json.success) {
        setTokensError(json.error || "Failed to unbind token");
      }
      await loadTokens();
    } catch {
      setTokensError("Network error");
    }
  };

  const deleteToken = async (token: IngestTokenItem) => {
    if (!window.confirm(`Delete ingest token "${token.name}"? B side will start failing pushes.`)) return;
    setTokensError(null);
    try {
      const res = await apiFetch(`/api/admin/ingest-tokens/${token.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.success) {
        setTokensError(json.error || "Failed to delete token");
      }
      await loadTokens();
    } catch {
      setTokensError("Network error");
    }
  };

  // ---- sync instance actions ----
  const deleteInstance = async (instance: SyncInstanceItem) => {
    setPendingDeleteInstance(instance);
    setDeleteInstanceRecords(false);
    setInstancesSuccess(null);
  };

  const confirmDeleteInstance = async () => {
    if (!pendingDeleteInstance) return;
    const query = deleteInstanceRecords ? "?deleteRecords=1" : "";
    setPendingDeleteInstance(null);
    setInstancesError(null);
    setInstancesSuccess(null);
    try {
      const res = await apiFetch(
        `/api/admin/sync-instances/${encodeURIComponent(pendingDeleteInstance.uid)}${query}`,
        { method: "DELETE" }
      );
      const json = await res.json();
      if (json.success) {
        const deletedRecords: number = json.data?.deletedRecords ?? 0;
        setInstancesSuccess(
          deleteInstanceRecords
            ? deletedRecords > 0
              ? `Instance deleted — ${deletedRecords} pushed record(s) removed`
              : "Instance deleted (no pushed records to remove)"
            : "Instance deleted — history kept"
        );
      } else {
        setInstancesError(json.error || "Failed to delete instance");
      }
      await loadInstances();
    } catch {
      setInstancesError("Network error");
    }
  };

  // ---- B 端配置 ----
  const saveConfig = async () => {
    setConfigBusy(true);
    setConfigError(null);
    setConfigSuccess(null);
    try {
      const body: Record<string, unknown> = {};
      if (targetUrl.trim() !== "") body.targetUrl = targetUrl.trim();
      if (tokenInput.trim() !== "") body.token = tokenInput.trim();
      if (instanceName.trim() !== configuredInstance) body.instance = instanceName.trim();
      if (Object.keys(body).length === 0) {
        setConfigError("Nothing to save");
        return;
      }
      // 新建同步配置（尚无已存 token）时 token 必填：空 token 保存无意义（无法推送），就地报错
      const hasStoredToken = !!status?.hasToken;
      if (!hasStoredToken && tokenInput.trim() === "") {
        setConfigError("Ingest token is required (it-…) before saving a new sync config");
        return;
      }
      // 已存在同步配置（URL 或 token 已保存）时，任何一次 Save 都是对现有配置的替换，
      // 保存前必须 double check，避免误覆盖
      const alreadyConfigured = targetUrl.trim() !== "" || !!status?.hasToken;
      if (alreadyConfigured) {
        const ok = window.confirm(
          "An existing sync configuration is set. Saving will REPLACE it " +
            "(URL / token / instance). Pushes and the A-side TOFU binding are affected. Continue?"
        );
        if (!ok) {
          setConfigBusy(false);
          setConfigError("Not saved — existing sync config preserved");
          return;
        }
      }
      const res = await apiFetch("/api/admin/sync/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) {
        const data = json.data as {
          targetUrl: string | null;
          hasToken: boolean;
          instance: string;
          uid: string;
          epoch: string;
          boundUid: string | null;
        };
        setTargetUrl(data.targetUrl ?? "");
        setTokenInput("");
        setConfiguredInstance(data.instance);
        setInstanceName(data.instance);
        setBoundUid(data.boundUid);
        setConfigSuccess("Sync config saved");
        await loadStatus();
      } else {
        setConfigError(json.error || "Failed to save config");
      }
    } catch {
      setConfigError("Network error");
    } finally {
      setConfigBusy(false);
    }
  };

  // ---- B 端状态操作 ----
  const triggerSync = async () => {
    setSyncing(true);
    setStatusError(null);
    try {
      const res = await apiFetch("/api/admin/sync/trigger", { method: "POST" });
      const json = await res.json();
      if (!json.success) {
        setStatusError(json.error || "Sync failed");
      }
      await loadStatus();
    } catch {
      setStatusError("Network error");
    } finally {
      setSyncing(false);
    }
  };

  const skipRecords = async () => {
    const upToRecordId = Number(skipInput.trim());
    if (!Number.isInteger(upToRecordId) || upToRecordId <= 0) {
      setStatusError("Enter a positive record id to skip up to");
      return;
    }
    if (!window.confirm(`Skip and drop all pending records up to id ${upToRecordId}? This cannot be undone.`)) return;
    setSkipping(true);
    setStatusError(null);
    try {
      const res = await apiFetch("/api/admin/sync/skip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ upToRecordId }),
      });
      const json = await res.json();
      if (!json.success) {
        setStatusError(json.error || "Skip failed");
      }
      setSkipInput("");
      await loadStatus();
    } catch {
      setStatusError("Network error");
    } finally {
      setSkipping(false);
    }
  };

  const resetSync = async () => {
    if (
      !window.confirm(
        "Reset sync state (cursor → 0, new epoch, unlock uid)? " +
          "The next push will replay ALL local history. Use only when A already deleted this " +
          "instance's records (Sync Instances → Delete with the delete-records checkbox) or A was " +
          "rebuilt — otherwise A-side data will be duplicated. This cannot be undone."
      )
    )
      return;
    setResetting(true);
    setStatusError(null);
    try {
      const res = await apiFetch("/api/admin/sync/reset", { method: "POST" });
      const json = await res.json();
      if (!json.success) {
        setStatusError(json.error || "Reset failed");
      }
      setBoundUid(null);
      await Promise.all([loadConfig(), loadStatus()]);
    } catch {
      setStatusError("Network error");
    } finally {
      setResetting(false);
    }
  };

  const urlError = validateTargetUrlInput(targetUrl);
  const tokenError = validateTokenInput(tokenInput);
  const canSaveConfig =
    !configBusy &&
    urlError === null &&
    tokenError === null &&
    (targetUrl.trim() !== "" || tokenInput.trim() !== "" || instanceName.trim() !== configuredInstance);

  return (
    <div className="space-y-6">
      {loading ? (
        <div className="py-12 text-center text-sm text-gray-400">Loading…</div>
      ) : (
        <>
          {/* 大卡 1：本实例本地同步（B 角色） */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-800">Local Sync — push this instance to A</h2>
            <h3 className="mb-2 text-xs font-semibold text-gray-600">Configuration</h3>
            <p className="mb-3 text-xs text-gray-500">
              Push this instance&apos;s token records to a central (A) instance. Leave empty to disable.
            </p>
            <p className="mb-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
              Saving replaces the current sync URL / token if already configured (you&apos;ll be asked to confirm). Changing the target or token affects pushes to the old A and its TOFU binding.
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-600">A ingest URL ({"/ingest/records"})</span>
                <input
                  type="text"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://tracker.example.com/ingest/records"
                  className={`w-full rounded border px-3 py-2 text-sm focus:outline-none focus:ring-1 md:text-xs ${
                    urlError
                      ? "border-red-300 focus:border-red-500 focus:ring-red-500"
                      : "border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                  }`}
                />
                {urlError && <p className="mt-1 text-xs text-red-600">{urlError}</p>}
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-600">Ingest token (it-…)</span>
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder={status?.hasToken ? "•••• (already set, leave empty to keep)" : "it-…"}
                  className={`w-full rounded border px-3 py-2 text-sm focus:outline-none focus:ring-1 md:text-xs ${
                    tokenError
                      ? "border-red-300 focus:border-red-500 focus:ring-red-500"
                      : "border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                  }`}
                />
                {tokenError && <p className="mt-1 text-xs text-red-600">{tokenError}</p>}
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-600">Instance name (display only)</span>
                <input
                  type="text"
                  value={instanceName}
                  onChange={(e) => setInstanceName(e.target.value)}
                  placeholder="[a-z0-9-]"
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 md:text-xs"
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              The instance name is a display name — renaming is safe at any time. Your stable identity is the uid
              ({status?.uid ? status.uid.slice(0, 12) + "…" : "—"}), which never changes.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={saveConfig}
                disabled={!canSaveConfig}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 min-h-[40px] md:min-h-0"
              >
                {configBusy ? "Saving…" : "Save config"}
              </button>
              {configError && <span className="text-xs text-red-600">{configError}</span>}
              {configSuccess && <span className="text-xs text-green-600">{configSuccess}</span>}
            </div>

            <div className="mt-5 border-t border-gray-100 pt-4">
              <h3 className="mb-2 text-xs font-semibold text-gray-600">Status</h3>
              {status?.configured === false && (
                <p className="mb-3 text-xs text-gray-500">
                  Not configured — this instance does not push anywhere.
                </p>
              )}
            {statusError && <p className="mb-3 text-xs text-red-600">{statusError}</p>}
            {status?.lastError && (
              <div className="mb-3 flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                <ErrorBadge type={status.lastError.type} />
                <div>
                  <p className="font-medium">{status.lastError.message}</p>
                  <p className="mt-0.5 text-red-500">
                    First failed at {formatDate(status.lastError.firstFailedAt)} — retrying with backoff, nothing dropped.
                  </p>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
              <div className="rounded border border-gray-100 bg-gray-50 p-2.5 col-span-2 md:col-span-4">
                <p className="text-gray-400">Target URL</p>
                <p className="mt-0.5 font-mono font-medium break-all">
                  {status?.targetUrl ?? "—"}
                  {!status?.configured && status && <span className="ml-1 text-gray-400">(not configured)</span>}
                </p>
              </div>
              <div className="rounded border border-gray-100 bg-gray-50 p-2.5">
                <p className="text-gray-400">Instance (uid)</p>
                <p className="mt-0.5 font-mono font-medium break-all">
                  {status?.instance ?? "—"}
                  <span className="ml-1 text-gray-400">{status?.uid ? `(${status.uid.slice(0, 12)}…)` : ""}</span>
                </p>
              </div>
              <div className="rounded border border-gray-100 bg-gray-50 p-2.5">
                <p className="text-gray-400">Cursor / Max ID</p>
                <p className="mt-0.5 font-mono font-medium">
                  {status?.cursor ?? "—"} / {status?.maxRecordId ?? "—"}
                </p>
              </div>
              <div className="rounded border border-gray-100 bg-gray-50 p-2.5">
                <p className="text-gray-400">Pending</p>
                <p className="mt-0.5 font-mono font-medium">
                  {status?.pendingCount ?? "—"}
                  {status && status.pendingCount > 0 && <span className="ml-1 text-amber-600">unpushed</span>}
                </p>
              </div>
              <div className="rounded border border-gray-100 bg-gray-50 p-2.5">
                <p className="text-gray-400">Dropped</p>
                <p className="mt-0.5 font-mono font-medium">{status?.droppedCount ?? "—"}</p>
              </div>
              <div className="rounded border border-gray-100 bg-gray-50 p-2.5">
                <p className="text-gray-400">Bound on A (uid)</p>
                <p className="mt-0.5 font-mono font-medium break-all">{status?.boundUid ?? "—"}</p>
              </div>
              <div className="rounded border border-gray-100 bg-gray-50 p-2.5">
                <p className="text-gray-400">Last success</p>
                <p className="mt-0.5 font-medium">{formatDate(status?.lastSuccessAt)}</p>
              </div>
              <div className="rounded border border-gray-100 bg-gray-50 p-2.5">
                <p className="text-gray-400">Last attempt</p>
                <p className="mt-0.5 font-medium">{formatDate(status?.lastAttemptAt)}</p>
              </div>
              <div className="rounded border border-gray-100 bg-gray-50 p-2.5">
                <p className="text-gray-400">Epoch</p>
                <p className="mt-0.5 font-mono font-medium">{status?.epoch ? status.epoch.slice(0, 12) + "…" : "—"}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={triggerSync}
                disabled={syncing || !status?.configured}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 min-h-[40px] md:min-h-0"
              >
                {syncing ? "Syncing…" : "Sync now"}
              </button>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={skipInput}
                  onChange={(e) => setSkipInput(e.target.value)}
                  placeholder="skip up to record id"
                  className="w-40 rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 md:text-xs"
                />
                <button
                  type="button"
                  onClick={skipRecords}
                  disabled={skipping}
                  className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50 min-h-[40px] md:min-h-0"
                >
                  Skip
                </button>
              </div>
              <button
                type="button"
                onClick={resetSync}
                disabled={resetting}
                className="rounded border border-red-300 bg-white px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 min-h-[40px] md:min-h-0"
              >
                {resetting ? "Resetting…" : "Reset sync state"}
              </button>
            </div>
            </div>
          </section>

          {/* 大卡 2：远端 ingest（A 角色） */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-800">Remote Ingest — other instances push into this one</h2>
            <h3 className="mb-2 text-xs font-semibold text-gray-600">Ingest Tokens</h3>
            <p className="mb-3 text-xs text-gray-500">
              One token per B instance. The first push binds the token to that instance&apos;s stable uid (TOFU).
            </p>
            {tokensError && <p className="mb-2 text-xs text-red-600">{tokensError}</p>}
            {tokensSuccess && <p className="mb-2 text-xs text-green-600">{tokensSuccess}</p>}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                placeholder="token name (e.g. bing-mbp)"
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 md:w-64 md:text-xs"
              />
              <button
                type="button"
                onClick={createToken}
                disabled={creating || !tokenName.trim()}
                className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 min-h-[40px] md:min-h-0"
              >
                {creating ? "Creating…" : "Create token"}
              </button>
            </div>

            {newTokenPlain && (
              <div className="mb-4 rounded border border-green-200 bg-green-50 p-3">
                <p className="text-xs font-medium text-green-800">
                  Token created — copy it now, it will not be shown again:
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="rounded bg-white px-2 py-1 font-mono text-xs break-all">{newTokenPlain.apiKey}</code>
                  <button
                    type="button"
                    onClick={() => copyText(newTokenPlain.apiKey)}
                    className="rounded border border-green-300 bg-white px-2 py-1 text-xs text-green-700 hover:bg-green-100"
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewTokenPlain(null)}
                    className="rounded border border-green-300 bg-white px-2 py-1 text-xs text-green-700 hover:bg-green-100"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}

            {/* 桌面表格 */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400">
                    <th className="px-2 py-2">Name</th>
                    <th className="px-2 py-2">Key</th>
                    <th className="px-2 py-2">Enabled</th>
                    <th className="px-2 py-2">Bound uid</th>
                    <th className="px-2 py-2">Last used</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {tokens.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-2 py-4 text-center text-xs text-gray-400">
                        No ingest tokens yet.
                      </td>
                    </tr>
                  )}
                  {tokens.map((token) => (
                    <tr key={token.id}>
                      <td className="px-2 py-2">
                        <CopyableCode className="text-xs">{token.name}</CopyableCode>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2">
                          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-600 break-all max-w-[180px]">
                            {token.apiKey ? maskVirtualKey(token.apiKey) : "—"}
                          </code>
                          {token.apiKey && (
                            <button
                              type="button"
                              onClick={() => copyTokenKey(token)}
                              className="text-xs text-gray-500 hover:text-blue-600"
                            >
                              {copiedToken === token.id ? "Copied!" : "Copy"}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          onClick={() => toggleToken(token)}
                          className={`rounded px-2 py-0.5 text-xs font-medium ${
                            token.enabled
                              ? "bg-green-100 text-green-700 hover:bg-green-200"
                              : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                          }`}
                        >
                          {token.enabled ? "enabled" : "disabled"}
                        </button>
                      </td>
                      <td className="px-2 py-2 font-mono text-xs break-all max-w-[200px]">
                        {token.boundUid ?? <span className="text-gray-400">(unbound)</span>}
                      </td>
                      <td className="px-2 py-2 text-xs text-gray-500">{formatDate(token.lastUsedAt)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap text-xs">
                        {token.boundUid && (
                          <>
                            <button
                              type="button"
                              onClick={() => unbindToken(token)}
                              className="text-amber-600 hover:text-amber-800"
                            >
                              Unbind
                            </button>
                            {" · "}
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => deleteToken(token)}
                          className="text-red-500 hover:text-red-700"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 移动端卡片 */}
            <div className="md:hidden space-y-3">
              {tokens.length === 0 && (
                <p className="py-4 text-center text-xs text-gray-400">No ingest tokens yet.</p>
              )}
              {tokens.map((token) => (
                <div key={token.id} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CopyableCode className="text-xs">{token.name}</CopyableCode>
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        {token.boundUid ?? "(unbound)"} · {formatDate(token.lastUsedAt)}
                      </p>
                      {token.apiKey && (
                        <p className="mt-1 flex items-center gap-2">
                          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-600 break-all">
                            {maskVirtualKey(token.apiKey)}
                          </code>
                          <button
                            type="button"
                            onClick={() => copyTokenKey(token)}
                            className="text-xs text-gray-500"
                          >
                            {copiedToken === token.id ? "Copied!" : "Copy"}
                          </button>
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleToken(token)}
                        className={`rounded px-2 py-1 text-[11px] font-medium min-h-[32px] ${
                          token.enabled
                            ? "bg-green-100 text-green-700"
                            : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        {token.enabled ? "enabled" : "disabled"}
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-xs">
                    {token.boundUid && (
                      <button
                        type="button"
                        onClick={() => unbindToken(token)}
                        className="text-amber-600"
                      >
                        Unbind
                      </button>
                    )}
                    <button type="button" onClick={() => deleteToken(token)} className="text-red-500">
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Sync Instances（并入大卡 2） */}
            <div className="mt-5 border-t border-gray-100 pt-4">
              <h3 className="mb-2 text-xs font-semibold text-gray-600">Sync Instances (watermarks)</h3>
              <p className="mb-3 text-xs text-gray-500">
                Dedup watermark per B instance (keyed by stable uid). Deleting a row lets a new instance start clean (re-Token+push).
              </p>
              {instancesError && <p className="mb-2 text-xs text-red-600">{instancesError}</p>}
              {instancesSuccess && <p className="mb-2 text-xs text-green-600">{instancesSuccess}</p>}

            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400">
                    <th className="px-2 py-2">Instance (uid)</th>
                    <th className="px-2 py-2">Epoch</th>
                    <th className="px-2 py-2 text-right">Last record id</th>
                    <th className="px-2 py-2">Updated</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {instances.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-2 py-4 text-center text-xs text-gray-400">
                        No pushed instances yet.
                      </td>
                    </tr>
                  )}
                  {instances.map((inst) => (
                    <tr key={inst.uid}>
                      <td className="px-2 py-2">
                        {inst.instanceName && (
                          <CopyableCode className="text-xs">{inst.instanceName}</CopyableCode>
                        )}
                        <div className="font-mono text-[11px] text-gray-400 break-all">{inst.uid}</div>
                      </td>
                      <td className="px-2 py-2 font-mono text-xs text-gray-500">
                        {inst.epoch.slice(0, 12)}…
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs">{inst.lastRecordId}</td>
                      <td className="px-2 py-2 text-xs text-gray-500">{formatDate(inst.updatedAt)}</td>
                      <td className="px-2 py-2 text-right text-xs">
                        <button
                          type="button"
                          onClick={() => deleteInstance(inst)}
                          className="text-red-500 hover:text-red-700"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="md:hidden space-y-3">
              {instances.length === 0 && (
                <p className="py-4 text-center text-xs text-gray-400">No pushed instances yet.</p>
              )}
              {instances.map((inst) => (
                <div key={inst.uid} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      {inst.instanceName && (
                        <CopyableCode className="text-xs">{inst.instanceName}</CopyableCode>
                      )}
                      <p className="mt-0.5 font-mono text-[10px] text-gray-400 break-all">{inst.uid}</p>
                      <p className="mt-0.5 text-[11px] text-gray-400">{formatDate(inst.updatedAt)}</p>
                    </div>
                    <button type="button" onClick={() => deleteInstance(inst)} className="text-xs text-red-500">
                      Delete
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="text-gray-400">Epoch</span>
                    <span className="font-mono">{inst.epoch.slice(0, 12)}…</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs">
                    <span className="text-gray-400">Last record id</span>
                    <span className="font-mono">{inst.lastRecordId}</span>
                  </div>
                </div>
              ))}
              </div>
            </div>
          </section>
        </>
      )}

      {pendingDeleteInstance && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="flex h-full w-full flex-col rounded-none bg-white shadow-xl md:h-auto md:max-w-md md:rounded-lg">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h3 className="font-semibold">Delete sync instance</h3>
              <button
                type="button"
                onClick={() => setPendingDeleteInstance(null)}
                className="text-2xl leading-none text-gray-400 hover:text-gray-600"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <p className="text-sm text-gray-700">
                Delete watermark for instance{" "}
                {pendingDeleteInstance.instanceName && (
                  <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">
                    {pendingDeleteInstance.instanceName}
                  </code>
                )}{" "}
                <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">
                  {pendingDeleteInstance.uid}
                </code>
                ? Its watermark will be lost; the next push re-binds (token binding on A still applies).
              </p>
              <label className="mt-4 flex items-center gap-3 min-h-[40px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={deleteInstanceRecords}
                  onChange={(e) => setDeleteInstanceRecords(e.target.checked)}
                  className="h-5 w-5 rounded border-gray-300 text-red-600 focus:ring-red-500"
                />
                <span className="text-sm text-gray-700">Also delete its pushed records</span>
              </label>
              <p className="mt-1 text-xs text-gray-400">
                Permanently removes this instance&apos;s pushed history, not recoverable. Required when the B side will Reset and re-push everything — otherwise records would duplicate.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
              <button
                type="button"
                onClick={() => setPendingDeleteInstance(null)}
                className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDeleteInstance}
                className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}