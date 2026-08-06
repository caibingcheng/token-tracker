"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import { formatNumber } from "@/lib/number-utils";
import { maskVirtualKey } from "@/lib/mask-utils";

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

  const [expandedConfigId, setExpandedConfigId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [usageDetail, setUsageDetail] = useState<UsageDetail | null>(null);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);

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

  useEffect(() => {
    load();
  }, [load]);

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
    if (!confirm(`Revoke & delete key "${key.name}"?`)) return;
    await apiFetch(`/api/admin/virtual-keys/${key.id}`, { method: "DELETE" });
    if (expandedId === key.id) {
      setExpandedId(null);
      setUsageDetail(null);
    }
    if (expandedConfigId === key.id) {
      setExpandedConfigId(null);
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
    try {
      await navigator.clipboard.writeText(key.apiKey);
    } catch {
      // clipboard unavailable
    }
    setCopied(key.id);
    setTimeout(() => setCopied(null), 1500);
  };

  if (loading) {
    return <div className="h-40 flex items-center justify-center text-gray-400">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
      )}

      {/* 创建表单 */}
      <div className="rounded-lg bg-white p-6 shadow">
        <h2 className="mb-4 text-lg font-semibold">
          {editingId ? `Edit Virtual Key #${editingId}` : "New Virtual Key"}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
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
            <label className="mb-1 block text-sm font-medium text-gray-700">Comment</label>
            <input
              value={commentInput}
              onChange={(e) => setCommentInput(e.target.value)}
              placeholder="Comment (optional)"
              title="Optional note describing this key's purpose or owner. Editable later."
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Enabled Models</label>
            <input
              value={modelsInput}
              onChange={(e) => setModelsInput(e.target.value)}
              placeholder="Enabled models, e.g. * or gpt-4o, claude-*"
              title="Comma-separated model allowlist. '*' allows all models; prefix wildcards like 'gpt-*' are supported. Requests for other models are rejected with 403."
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Quota Limits</label>
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
                onClick={() => navigator.clipboard?.writeText(createdKey)}
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
          <div key={key.id} className="rounded-lg bg-white p-5 shadow">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`h-2 w-2 rounded-full ${key.enabled ? "bg-green-500" : "bg-gray-300"}`} />
              <button
                type="button"
                onClick={() =>
                  setExpandedConfigId(expandedConfigId === key.id ? null : key.id)
                }
                className="text-gray-400 hover:text-gray-600"
                title={expandedConfigId === key.id ? "Collapse" : "Expand"}
              >
                {expandedConfigId === key.id ? "▾" : "▸"}
              </button>
              <span className="font-semibold">{key.name}</span>
              {key.comment && (
                <span className="text-xs text-gray-400 truncate max-w-[200px]" title={key.comment}>
                  {key.comment}
                </span>
              )}
              <code className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 break-all max-w-xs">
                {maskVirtualKey(key.apiKey)}
              </code>
              <button
                type="button"
                onClick={() => copyKey(key)}
                className="text-xs text-gray-500 hover:text-blue-600"
              >
                {copied === key.id ? "Copied!" : "Copy"}
              </button>
              <span className="text-xs text-gray-400">
                created {new Date(key.createdAt).toLocaleDateString()}
              </span>
              {key.lastUsedAt && (
                <span className="text-xs text-gray-400">
                  last used {new Date(key.lastUsedAt).toLocaleString()}
                </span>
              )}
              <span className="text-xs text-gray-500" title="Quota limits (rpm / tpm / daily / monthly tokens)">
                {(() => {
                  const parts: string[] = [];
                  if (key.maxRpm != null) parts.push(`${key.maxRpm} rpm`);
                  if (key.maxTpm != null) parts.push(`${formatQuota(key.maxTpm)} tpm`);
                  if (key.maxDailyTokens != null) parts.push(`${formatQuota(key.maxDailyTokens)} daily`);
                  if (key.maxMonthlyTokens != null) parts.push(`${formatQuota(key.maxMonthlyTokens)} monthly`);
                  return parts.length > 0 ? parts.join(" / ") : "—";
                })()}
              </span>
              <div className="ml-auto flex items-center gap-2">
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
            </div>

            {expandedConfigId === key.id && (
              <div className="mt-4 space-y-4 border-l-2 border-gray-100 pl-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-gray-400">API Key</div>
                    <code className="break-all text-xs">{maskVirtualKey(key.apiKey)}</code>
                  </div>
                  <div className="flex flex-wrap gap-6">
                    <div>
                      <div className="text-xs text-gray-400">Status</div>
                      <div className="text-xs">{key.enabled ? "Enabled" : "Revoked"}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">Created</div>
                      <div className="text-xs">{new Date(key.createdAt).toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">Last Used</div>
                      <div className="text-xs">
                        {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "—"}
                      </div>
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <div className="text-xs text-gray-400">Comment</div>
                    <div className="text-xs">{key.comment || "—"}</div>
                  </div>
                  <div className="md:col-span-2">
                    <div className="text-xs text-gray-400">Enabled Models</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {key.enabledModels.length === 0 && (
                        <span className="text-xs text-gray-300">(none)</span>
                      )}
                      {parseEnabledModelsValue(key.enabledModels).map((m) => (
                        <code key={m} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                          {m}
                        </code>
                      ))}
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <div className="text-xs text-gray-400">Quota Limits</div>
                    <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                      <span>
                        RPM: <span className="font-medium">{key.maxRpm ?? "∞"}</span>
                      </span>
                      <span>
                        TPM: <span className="font-medium">{formatQuota(key.maxTpm)}</span>
                      </span>
                      <span>
                        Daily: <span className="font-medium">{formatQuota(key.maxDailyTokens)}</span>
                      </span>
                      <span>
                        Monthly: <span className="font-medium">{formatQuota(key.maxMonthlyTokens)}</span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {expandedId === key.id && usageDetail && (
              <div className="mt-4">
                <div className="mb-3 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => refreshUsage(key)}
                    disabled={refreshingId === key.id}
                    className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {refreshingId === key.id ? "Refreshing..." : "Refresh"}
                  </button>
                </div>

                <div className="mb-3 grid grid-cols-2 md:grid-cols-6 gap-3 rounded bg-gray-50 p-3 text-sm">
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

                <div className="mb-3 rounded border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600">
                  <span className="text-gray-400">Quota: </span>
                  <span>
                    {usageDetail.maxRpm != null ? `${usageDetail.maxRpm} rpm` : "∞ rpm"}
                    {usageDetail.maxTpm != null ? ` / ${formatQuota(usageDetail.maxTpm)} tpm` : " / ∞ tpm"}
                    {usageDetail.maxDailyTokens != null
                      ? ` / ${formatQuota(usageDetail.maxDailyTokens)} daily`
                      : " / ∞ daily"}
                    {usageDetail.maxMonthlyTokens != null
                      ? ` / ${formatQuota(usageDetail.maxMonthlyTokens)} monthly`
                      : " / ∞ monthly"}
                  </span>
                </div>

                <div className="overflow-x-auto">
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
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
