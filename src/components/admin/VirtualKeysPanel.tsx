"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import { formatNumber } from "@/lib/number-utils";
import { maskVirtualKey } from "@/lib/mask-utils";
import { modelMatchesPattern, type Protocol } from "@/lib/gateway/model-router";
import { CopyableCode } from "./CopyableCode";
import ActionMenu from "./ActionMenu";
import { copyText } from "@/lib/clipboard";
import { QuotaBar, MiniQuotaBar, type QuotaUsageData } from "./QuotaProgress";

export interface VirtualKeyItem {
  id: number;
  name: string;
  apiKey: string;
  enabled: boolean;
  comment: string | null;
  enabledModels: string;
  lastUsedAt: string | null;
  maxRpm: number | null;
  maxTpm: number | null;
  maxDailyTokens: number | null;
  maxMonthlyTokens: number | null;
  createdAt: string;
  quotaUsage: QuotaUsageData | null;
  usage: {
    requestCount: number;
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheWrite: number;
  } | null;
}

interface UsageDetail {
  name: string;
  enabled: boolean;
  lastUsedAt: string | null;
  maxRpm: number | null;
  maxTpm: number | null;
  maxDailyTokens: number | null;
  maxMonthlyTokens: number | null;
  quotaUsage: QuotaUsageData | null;
  usage: {
    requestCount: number;
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheWrite: number;
    lastActiveAt: string | null;
  };
  recent: Array<{
    id: number;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    status: string | null;
    userAgent: string | null;
    createdAt: string;
  }>;
}

interface ResolvedModelRoute {
  protocol: Protocol;
  model: string;
}

interface ModelsData {
  resolvedRoutes: ResolvedModelRoute[];
}

function parseEnabledModelsInput(raw: string): string[] {
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

function parseEnabledModelsValue(raw: string): string[] {
  const tryParse = (input: string): string[] | null => {
    try {
      const parsed = JSON.parse(input);
      if (!Array.isArray(parsed)) return null;
      return parsed.map((m) => String(m));
    } catch {
      return null;
    }
  };
  let result = tryParse(raw);
  let depth = 0;
  while (result && result.length === 1 && depth < 10) {
    const nested = tryParse(result[0]);
    if (!nested) break;
    result = nested;
    depth++;
  }
  return result ?? parseEnabledModelsInput(raw);
}

function formatQuota(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function quotaInputToField(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function quotaText(key: VirtualKeyItem): string {
  const parts: string[] = [];
  if (key.maxRpm != null) parts.push(`${key.maxRpm} rpm`);
  if (key.maxTpm != null) parts.push(`${formatQuota(key.maxTpm)} tpm`);
  if (key.maxDailyTokens != null) parts.push(`${formatQuota(key.maxDailyTokens)} daily`);
  if (key.maxMonthlyTokens != null) parts.push(`${formatQuota(key.maxMonthlyTokens)} monthly`);
  return parts.length > 0 ? parts.join(" / ") : "—";
}

function hasAnyQuotaLimit(key: VirtualKeyItem): boolean {
  return (
    key.maxRpm != null ||
    key.maxTpm != null ||
    key.maxDailyTokens != null ||
    key.maxMonthlyTokens != null
  );
}

function computeResolvedModels(vkEnabledModels: string, modelsData: ModelsData | null): string[] {
  if (!modelsData) return [];
  const patterns = parseEnabledModelsValue(vkEnabledModels);
  const models = Array.from(new Set(modelsData.resolvedRoutes.map((r) => r.model)));
  if (patterns.includes("*")) return models.sort();
  return models.filter((m) => patterns.some((p) => modelMatchesPattern(p, m))).sort();
}

export default function VirtualKeysPanel() {
  const [keys, setKeys] = useState<VirtualKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [nameInput, setNameInput] = useState("");
  const [commentInput, setCommentInput] = useState("");
  const [modelsInput, setModelsInput] = useState("*");
  const [quotaInputs, setQuotaInputs] = useState({ rpm: "", tpm: "", daily: "", monthly: "" });
  const [saving, setSaving] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [usageDetail, setUsageDetail] = useState<UsageDetail | null>(null);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<VirtualKeyItem | null>(null);
  const [hideHistory, setHideHistory] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [modelsData, setModelsData] = useState<ModelsData | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/admin/virtual-keys");
      const json = await res.json();
      if (json.success) {
        setKeys(json.data);
      } else {
        setError(json.error || "Failed to load virtual keys");
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const res = await apiFetch("/api/admin/models");
      const json = await res.json();
      if (json.success) {
        setModelsData(json.data);
      }
    } catch {
      // ignore: non-critical display data
    }
  }, []);

  useEffect(() => {
    load();
    loadModels();
  }, [load, loadModels]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = nameInput.trim();
    if (!name || saving) return;
    const enabledModels = parseEnabledModelsInput(modelsInput);
    if (enabledModels.length === 0) {
      setError("Enabled models must be non-empty (use '*' for all)");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = editingId
        ? await apiFetch(`/api/admin/virtual-keys/${editingId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name,
              comment: commentInput.trim(),
              enabledModels,
              maxRpm: quotaInputToField(quotaInputs.rpm),
              maxTpm: quotaInputToField(quotaInputs.tpm),
              maxDailyTokens: quotaInputToField(quotaInputs.daily),
              maxMonthlyTokens: quotaInputToField(quotaInputs.monthly),
            }),
          })
        : await apiFetch("/api/admin/virtual-keys", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name,
              comment: commentInput.trim(),
              enabledModels,
              maxRpm: quotaInputToField(quotaInputs.rpm),
              maxTpm: quotaInputToField(quotaInputs.tpm),
              maxDailyTokens: quotaInputToField(quotaInputs.daily),
              maxMonthlyTokens: quotaInputToField(quotaInputs.monthly),
            }),
          });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Failed to save virtual key");
        return;
      }
      if (!editingId) {
        setCreatedKey(json.data.apiKey as string);
      }
      setNameInput("");
      setCommentInput("");
      setModelsInput("*");
      setQuotaInputs({ rpm: "", tpm: "", daily: "", monthly: "" });
      setEditingId(null);
      load();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (key: VirtualKeyItem) => {
    setEditingId(key.id);
    setNameInput(key.name);
    setCommentInput(key.comment ?? "");
    setModelsInput(parseEnabledModelsValue(key.enabledModels).join(", "));
    setQuotaInputs({
      rpm: key.maxRpm != null ? String(key.maxRpm) : "",
      tpm: key.maxTpm != null ? String(key.maxTpm) : "",
      daily: key.maxDailyTokens != null ? String(key.maxDailyTokens) : "",
      monthly: key.maxMonthlyTokens != null ? String(key.maxMonthlyTokens) : "",
    });
    setCreatedKey(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const toggleEnabled = async (key: VirtualKeyItem) => {
    await apiFetch(`/api/admin/virtual-keys/${key.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !key.enabled }),
    });
    load();
  };

  const remove = async (key: VirtualKeyItem) => {
    setPendingDelete(key);
    setHideHistory(false);
  };

  const confirmRemove = async () => {
    if (!pendingDelete) return;
    setPendingDelete(null);
    const query = hideHistory ? "?hideHistory=1" : "";
    await apiFetch(`/api/admin/virtual-keys/${pendingDelete.id}${query}`, {
      method: "DELETE",
    });
    if (expandedId === pendingDelete.id) {
      setExpandedId(null);
      setUsageDetail(null);
    }
    load();
  };

  const toggleUsage = async (key: VirtualKeyItem) => {
    if (expandedId === key.id) {
      setExpandedId(null);
      setUsageDetail(null);
      return;
    }
    setExpandedId(key.id);
    setUsageDetail(null);
    const res = await apiFetch(`/api/admin/virtual-keys/${key.id}/usage`);
    const json = await res.json();
    if (json.success) {
      setUsageDetail(json.data);
    }
  };

  const refreshUsage = async (key: VirtualKeyItem) => {
    setRefreshingId(key.id);
    try {
      const res = await apiFetch(`/api/admin/virtual-keys/${key.id}/usage`);
      const json = await res.json();
      if (json.success) {
        setUsageDetail(json.data);
      } else {
        setError(json.error || "Failed to refresh usage");
      }
    } catch {
      setError("Network error");
    } finally {
      setRefreshingId(null);
    }
  };

  const copyKey = async (key: VirtualKeyItem) => {
    const ok = await copyText(key.apiKey);
    if (ok) {
      setCopied(key.id);
      setTimeout(() => setCopied(null), 1500);
    } else {
      setError("Copy failed. Please copy the key manually.");
    }
  };

  if (loading) {
    return <div className="h-40 flex items-center justify-center text-gray-400">Loading...</div>;
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
      )}

      {/* 创建表单 */}
      <div className="rounded-lg bg-white p-4 shadow">
        <h2 className="mb-3 text-base font-semibold">
          {editingId ? `Edit Virtual Key #${editingId}` : "New Virtual Key"}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Name</label>
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Agent name, e.g. claude-code-desktop"
              title="Agent name used to identify this key in usage records. Unique across all virtual keys."
              required
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Comment</label>
            <input
              value={commentInput}
              onChange={(e) => setCommentInput(e.target.value)}
              placeholder="Comment (optional)"
              title="Optional note describing this key's purpose or owner. Editable later."
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Enabled Models</label>
            <input
              value={modelsInput}
              onChange={(e) => setModelsInput(e.target.value)}
              placeholder="Enabled models, e.g. * or gpt-4o, claude-*"
              title="Comma-separated model allowlist. '*' allows all models; prefix wildcards like 'gpt-*' are supported. Requests for other models are rejected with 403."
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Quota Limits</label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label className="mb-0.5 block text-xs font-medium text-gray-600">Max RPM</label>
                <input
                  value={quotaInputs.rpm}
                  onChange={(e) => setQuotaInputs((q) => ({ ...q, rpm: e.target.value }))}
                  placeholder="0 = unlimited"
                  title="Max requests per minute (60s window). Empty = unlimited, 0 = unlimited."
                  inputMode="numeric"
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <p className="mt-0.5 text-xs text-gray-400">Requests per minute</p>
              </div>
              <div>
                <label className="mb-0.5 block text-xs font-medium text-gray-600">Max TPM</label>
                <input
                  value={quotaInputs.tpm}
                  onChange={(e) => setQuotaInputs((q) => ({ ...q, tpm: e.target.value }))}
                  placeholder="0 = unlimited"
                  title="Max tokens per minute (60s window). Empty = unlimited, 0 = unlimited."
                  inputMode="numeric"
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <p className="mt-0.5 text-xs text-gray-400">Tokens per minute</p>
              </div>
              <div>
                <label className="mb-0.5 block text-xs font-medium text-gray-600">Max Daily Tokens</label>
                <input
                  value={quotaInputs.daily}
                  onChange={(e) => setQuotaInputs((q) => ({ ...q, daily: e.target.value }))}
                  placeholder="0 = unlimited"
                  title="Max tokens per UTC calendar day. Empty = unlimited, 0 = unlimited."
                  inputMode="numeric"
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <p className="mt-0.5 text-xs text-gray-400">Per UTC calendar day</p>
              </div>
              <div>
                <label className="mb-0.5 block text-xs font-medium text-gray-600">Max Monthly Tokens</label>
                <input
                  value={quotaInputs.monthly}
                  onChange={(e) => setQuotaInputs((q) => ({ ...q, monthly: e.target.value }))}
                  placeholder="0 = unlimited"
                  title="Max tokens per UTC calendar month. Empty = unlimited, 0 = unlimited."
                  inputMode="numeric"
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <p className="mt-0.5 text-xs text-gray-400">Per UTC calendar month</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : editingId ? "Save" : "Create"}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setNameInput("");
                  setCommentInput("");
                  setModelsInput("*");
                  setQuotaInputs({ rpm: "", tpm: "", daily: "", monthly: "" });
                }}
                className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            )}
          </div>
        </form>

        {createdKey && (
          <div className="mt-4 rounded border border-green-200 bg-green-50 p-4">
            <p className="mb-2 text-sm font-medium text-green-700">
              Key created — copy it now, it won&apos;t be shown again:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-white border border-green-200 px-3 py-2 text-sm">
                {createdKey}
              </code>
              <button
                type="button"
                onClick={async () => {
                  const ok = await copyText(createdKey);
                  if (!ok) setError("Copy failed. Please copy the key manually.");
                }}
                className="rounded border border-green-300 px-3 py-2 text-sm text-green-700 hover:bg-green-100"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => setCreatedKey(null)}
                className="rounded border border-green-300 px-3 py-2 text-sm text-green-700 hover:bg-green-100"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 列表 */}
      <div className="space-y-3">
        {keys.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-gray-400">
            No virtual keys yet. Create one above.
          </div>
        )}
        {keys.map((key) => (
          <div key={key.id} className="rounded-lg bg-white p-3 shadow">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${key.enabled ? "bg-green-500" : "bg-gray-300"}`} />
                <span className="font-semibold text-sm">{key.name}</span>
                <code className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600 break-all max-w-[200px]">
                  {maskVirtualKey(key.apiKey)}
                </code>
                <span className="text-[11px] text-gray-500" title="Quota limits (rpm / tpm / daily / monthly tokens)">
                  {quotaText(key)}
                </span>
              </div>
              <div className="hidden md:flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => copyKey(key)}
                  className="text-xs text-gray-500 hover:text-blue-600"
                >
                  {copied === key.id ? "Copied!" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={() => toggleUsage(key)}
                  className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  Usage
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(key)}
                  className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => toggleEnabled(key)}
                  className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  {key.enabled ? "Revoke" : "Enable"}
                </button>
                <button
                  type="button"
                  onClick={() => remove(key)}
                  className="rounded border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
              <ActionMenu
                items={[
                  { label: copied === key.id ? "Copied!" : "Copy", onClick: () => copyKey(key) },
                  { label: "Usage", onClick: () => toggleUsage(key) },
                  { label: "Edit", onClick: () => startEdit(key) },
                  { label: key.enabled ? "Revoke" : "Enable", onClick: () => toggleEnabled(key) },
                  { label: "Delete", onClick: () => remove(key), variant: "danger" },
                ]}
              />
            </div>

            {/* 限额进度条：仅显示配置了限额的维度 */}
            {hasAnyQuotaLimit(key) && key.quotaUsage && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {key.maxRpm != null && (
                  <MiniQuotaBar label="RPM" current={key.quotaUsage.rpm} limit={key.maxRpm} />
                )}
                {key.maxTpm != null && (
                  <MiniQuotaBar label="TPM" current={key.quotaUsage.tpm} limit={key.maxTpm} />
                )}
                {key.maxDailyTokens != null && (
                  <MiniQuotaBar
                    label="Daily"
                    current={key.quotaUsage.dailyTokens}
                    limit={key.maxDailyTokens}
                  />
                )}
                {key.maxMonthlyTokens != null && (
                  <MiniQuotaBar
                    label="Monthly"
                    current={key.quotaUsage.monthlyTokens}
                    limit={key.maxMonthlyTokens}
                  />
                )}
              </div>
            )}

            {/* 配置信息默认展开：Comment / Created / Last Used 一行（桌面三列，移动端竖排） */}
            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
              <div className="min-w-0 rounded border border-gray-100 bg-gray-50/60 p-2">
                <span className="text-xs font-medium text-gray-500">Comment</span>
                <div className="mt-0.5 truncate text-xs text-gray-700" title={key.comment ?? undefined}>
                  {key.comment || "—"}
                </div>
              </div>
              <div className="min-w-0 rounded border border-gray-100 bg-gray-50/60 p-2">
                <span className="text-xs font-medium text-gray-500">Created</span>
                <div
                  className="mt-0.5 truncate text-xs text-gray-700"
                  title={new Date(key.createdAt).toLocaleString()}
                >
                  {new Date(key.createdAt).toLocaleString()}
                </div>
              </div>
              <div className="min-w-0 rounded border border-gray-100 bg-gray-50/60 p-2">
                <span className="text-xs font-medium text-gray-500">Last Used</span>
                <div
                  className="mt-0.5 truncate text-xs text-gray-700"
                  title={key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : undefined}
                >
                  {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "—"}
                </div>
              </div>
              <div className="rounded border border-gray-100 bg-gray-50/60 p-2 md:col-span-3">
                <span className="text-xs font-medium text-gray-500">Enabled Models</span>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {parseEnabledModelsValue(key.enabledModels).length === 0 && (
                    <span className="text-xs text-gray-300">(none)</span>
                  )}
                  {parseEnabledModelsValue(key.enabledModels).map((m) => (
                    <CopyableCode
                      key={m}
                      className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px]"
                    >
                      {m}
                    </CopyableCode>
                  ))}
                </div>
              </div>

              <div className="rounded border border-gray-100 bg-blue-50/40 p-2 md:col-span-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-gray-500">Resolved Allowed Models</span>
                  <span className="text-[10px] text-gray-400">
                    {computeResolvedModels(key.enabledModels, modelsData).length} concrete models
                  </span>
                </div>
                <div className="mt-1.5 max-h-32 overflow-y-auto">
                  {(() => {
                    const resolved = computeResolvedModels(key.enabledModels, modelsData);
                    return resolved.length === 0 ? (
                      <span className="text-xs text-gray-400">
                        No concrete models matched by this allowlist.
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {resolved.map((m) => (
                          <CopyableCode
                            key={m}
                            className="rounded border border-blue-100 bg-white px-1.5 py-0.5 text-[11px] text-blue-700"
                          >
                            {m}
                          </CopyableCode>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>

            {expandedId === key.id && usageDetail && (
              <div className="mt-3">
                <div className="mb-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => refreshUsage(key)}
                    disabled={refreshingId === key.id}
                    className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {refreshingId === key.id ? "Refreshing..." : "Refresh"}
                  </button>
                </div>

                <div className="mb-2 grid grid-cols-2 md:grid-cols-6 gap-2 rounded bg-gray-50 p-2 text-sm">
                  <div>
                    <p className="text-xs text-gray-400">Requests</p>
                    <p className="font-semibold">{formatNumber(usageDetail.usage.requestCount, true)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Input</p>
                    <p className="font-semibold">{formatNumber(usageDetail.usage.totalInput, true)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Output</p>
                    <p className="font-semibold">{formatNumber(usageDetail.usage.totalOutput, true)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Cache Read</p>
                    <p className="font-semibold">{formatNumber(usageDetail.usage.totalCacheRead, true)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Cache Write</p>
                    <p className="font-semibold">{formatNumber(usageDetail.usage.totalCacheWrite, true)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">First record</p>
                    <p className="font-semibold text-xs">
                      {usageDetail.usage.lastActiveAt
                        ? new Date(usageDetail.usage.lastActiveAt).toLocaleDateString()
                        : "—"}
                    </p>
                  </div>
                </div>

                <div className="mb-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <QuotaBar label="RPM" current={usageDetail.quotaUsage?.rpm ?? 0} limit={usageDetail.maxRpm} />
                  <QuotaBar label="TPM" current={usageDetail.quotaUsage?.tpm ?? 0} limit={usageDetail.maxTpm} />
                  <QuotaBar
                    label="Daily Tokens"
                    current={usageDetail.quotaUsage?.dailyTokens ?? 0}
                    limit={usageDetail.maxDailyTokens}
                  />
                  <QuotaBar
                    label="Monthly Tokens"
                    current={usageDetail.quotaUsage?.monthlyTokens ?? 0}
                    limit={usageDetail.maxMonthlyTokens}
                  />
                </div>

                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-400">
                        <th className="px-2 py-1">Date</th>
                        <th className="px-2 py-1">Model</th>
                        <th className="px-2 py-1">Provider</th>
                        <th className="px-2 py-1">User-Agent</th>
                        <th className="px-2 py-1 text-right">In</th>
                        <th className="px-2 py-1 text-right">Out</th>
                        <th className="px-2 py-1 text-right">Cache</th>
                        <th className="px-2 py-1">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {usageDetail.recent.map((r) => (
                        <tr key={r.id}>
                          <td className="px-2 py-1 whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                          <td className="px-2 py-1 max-w-[180px] truncate" title={r.model}>{r.model}</td>
                          <td className="px-2 py-1">{r.provider}</td>
                          <td className="px-2 py-1 max-w-[200px] truncate" title={r.userAgent ?? undefined}>
                            {r.userAgent ?? <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-2 py-1 text-right">{formatNumber(r.inputTokens, true)}</td>
                          <td className="px-2 py-1 text-right">{formatNumber(r.outputTokens, true)}</td>
                          <td className="px-2 py-1 text-right">{formatNumber(r.cacheRead, true)}</td>
                          <td className="px-2 py-1">
                            {r.status ? (
                              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600">
                                {r.status}
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                      {usageDetail.recent.length === 0 && (
                        <tr>
                          <td colSpan={8} className="px-2 py-4 text-center text-gray-400">
                            No records yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="md:hidden space-y-3">
                  {usageDetail.recent.map((r) => (
                    <div key={r.id} className="rounded-lg border border-gray-200 p-3">
                      <div className="flex justify-between items-start gap-2 mb-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate" title={r.model}>{r.model}</p>
                          <p className="text-xs text-gray-500">{r.provider}</p>
                        </div>
                        {r.status ? (
                          <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600">
                            {r.status}
                          </span>
                        ) : (
                          <span className="shrink-0 text-gray-300">—</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mb-2">
                        {new Date(r.createdAt).toLocaleString()}
                        {r.userAgent && <span className="block truncate mt-0.5" title={r.userAgent}>{r.userAgent}</span>}
                      </p>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <p className="text-gray-400">In</p>
                          <p className="font-semibold text-gray-900">{formatNumber(r.inputTokens, true)}</p>
                        </div>
                        <div>
                          <p className="text-gray-400">Out</p>
                          <p className="font-semibold text-gray-900">{formatNumber(r.outputTokens, true)}</p>
                        </div>
                        <div>
                          <p className="text-gray-400">Cache</p>
                          <p className="font-semibold text-gray-900">{formatNumber(r.cacheRead, true)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                  {usageDetail.recent.length === 0 && (
                    <div className="py-4 text-center text-gray-400">No records yet.</div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="flex h-full w-full flex-col rounded-none bg-white shadow-xl md:h-auto md:max-w-md md:rounded-lg">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h3 className="font-semibold">Revoke &amp; delete key</h3>
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="text-2xl leading-none text-gray-400 hover:text-gray-600"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <p className="text-sm text-gray-700">
                Revoke and delete key{" "}
                <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">
                  {pendingDelete.name}
                </code>
                ? Its usage records are kept in history.
              </p>
              <label className="mt-4 flex items-center gap-3 min-h-[40px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={hideHistory}
                  onChange={(e) => setHideHistory(e.target.checked)}
                  className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">
                  Also hide its historical data
                </span>
              </label>
              <p className="mt-1 text-xs text-gray-400">
                Adds it to Hidden Sources (Display tab) so its records disappear
                from filters and totals. Uncheck later to restore.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmRemove}
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
