"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import { formatNumber } from "@/lib/number-utils";

export interface VirtualKeyItem {
  id: number;
  name: string;
  apiKey: string;
  enabled: boolean;
  lastUsedAt: string | null;
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
    createdAt: string;
  }>;
}

export default function VirtualKeysPanel() {
  const [keys, setKeys] = useState<VirtualKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [nameInput, setNameInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [usageDetail, setUsageDetail] = useState<UsageDetail | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

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

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = nameInput.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/virtual-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Failed to create virtual key");
        return;
      }
      setCreatedKey(json.data.apiKey as string);
      setNameInput("");
      load();
    } catch {
      setError("Network error");
    } finally {
      setCreating(false);
    }
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
        <h2 className="mb-4 text-lg font-semibold">New Virtual Key</h2>
        <form onSubmit={create} className="flex gap-3">
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="Agent name, e.g. claude-code-desktop"
            required
            className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={creating}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? "Creating..." : "Create"}
          </button>
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
              <span className="font-semibold">{key.name}</span>
              <code className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 break-all max-w-xs">
                {key.apiKey}
              </code>
              <button
                type="button"
                onClick={() => copyKey(key)}
                className="text-xs text-gray-500 hover:text-blue-600"
              >
                {copied === key.id ? "Copied!" : "Copy"}
              </button>
              {key.lastUsedAt && (
                <span className="text-xs text-gray-400">
                  last used {new Date(key.lastUsedAt).toLocaleString()}
                </span>
              )}
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

            {key.usage && (
              <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-3 rounded bg-gray-50 p-3 text-sm">
                <div>
                  <p className="text-xs text-gray-400">Requests</p>
                  <p className="font-semibold">{formatNumber(key.usage.requestCount, true)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Input</p>
                  <p className="font-semibold">{formatNumber(key.usage.totalInput, true)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Output</p>
                  <p className="font-semibold">{formatNumber(key.usage.totalOutput, true)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Cache Read</p>
                  <p className="font-semibold">{formatNumber(key.usage.totalCacheRead, true)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Cache Write</p>
                  <p className="font-semibold">{formatNumber(key.usage.totalCacheWrite, true)}</p>
                </div>
              </div>
            )}

            {expandedId === key.id && usageDetail && (
              <div className="mt-4">
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

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-400">
                        <th className="px-2 py-1">Date</th>
                        <th className="px-2 py-1">Model</th>
                        <th className="px-2 py-1">Provider</th>
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
                          <td colSpan={7} className="px-2 py-4 text-center text-gray-400">
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
