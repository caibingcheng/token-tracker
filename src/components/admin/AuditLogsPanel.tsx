"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";

interface AuditLogItem {
  id: number;
  action: string;
  actor: string | null;
  targetType: string | null;
  targetId: number | null;
  ip: string | null;
  userAgent: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

interface AuditLogsResponse {
  items: AuditLogItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const ACTION_COLORS: Record<string, string> = {
  login_success: "bg-green-50 text-green-600",
  login_failure: "bg-red-50 text-red-600",
  api_key_changed: "bg-red-50 text-red-600",
  totp_enabled: "bg-blue-50 text-blue-600",
  totp_disabled: "bg-blue-50 text-blue-600",
  upstream_created: "bg-green-50 text-green-600",
  upstream_updated: "bg-amber-50 text-amber-600",
  upstream_deleted: "bg-red-50 text-red-600",
  virtual_key_created: "bg-green-50 text-green-600",
  virtual_key_updated: "bg-amber-50 text-amber-600",
  virtual_key_deleted: "bg-red-50 text-red-600",
  upstream_key_created: "bg-green-50 text-green-600",
  upstream_key_updated: "bg-amber-50 text-amber-600",
  upstream_key_deleted: "bg-red-50 text-red-600",
};

export default function AuditLogsPanel() {
  const [data, setData] = useState<AuditLogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiFetch(`/api/admin/audit-logs?page=${page}&pageSize=50`);
      const json = await res.json();
      if (json.success) {
        setData(json.data);
      } else {
        setError(json.error || "Failed to load audit logs");
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleDetails = (id: number) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Admin actions recorded here: login, key &amp; TOTP changes, upstream / virtual key management.
        </p>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
      )}

      <div className="overflow-x-auto rounded-lg bg-white shadow">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-400">
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">IP</th>
              <th className="px-3 py-2">User-Agent</th>
              <th className="px-3 py-2">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data?.items.map((item) => (
              <tr key={item.id}>
                <td className="px-3 py-2 whitespace-nowrap">{new Date(item.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                      ACTION_COLORS[item.action] ?? "bg-gray-50 text-gray-600"
                    }`}
                  >
                    {item.action}
                  </span>
                </td>
                <td className="px-3 py-2">{item.actor ?? "—"}</td>
                <td className="px-3 py-2">
                  {item.targetType ? (
                    <span className="text-gray-700">
                      {item.targetType}
                      {item.targetId != null ? ` #${item.targetId}` : ""}
                    </span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="px-3 py-2">{item.ip ?? "—"}</td>
                <td className="px-3 py-2 max-w-[200px] truncate" title={item.userAgent ?? undefined}>
                  {item.userAgent ?? <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-2">
                  {item.details != null ? (
                    <button
                      type="button"
                      onClick={() => toggleDetails(item.id)}
                      className="max-w-[240px] truncate rounded bg-gray-50 px-2 py-1 text-left font-mono text-xs text-gray-600 hover:bg-gray-100"
                    >
                      {expandedId === item.id
                        ? JSON.stringify(item.details, null, 2)
                        : JSON.stringify(item.details)}
                    </button>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
              </tr>
            ))}
            {(!data || data.items.length === 0) && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-gray-400">
                  No audit records yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm text-gray-600">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded border border-gray-300 px-3 py-1 text-xs disabled:opacity-40"
          >
            ← Prev
          </button>
          <span>
            Page {data.page} / {data.totalPages} · {data.total} records
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
            disabled={page >= data.totalPages}
            className="rounded border border-gray-300 px-3 py-1 text-xs disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
