"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import {
  AdminMobileCard,
  AdminMobileCards,
  AdminMobileEmpty,
  AdminTable,
  AdminTableBody,
  AdminTableCard,
  AdminTableEmptyRow,
  AdminTableHead,
  AdminTd,
} from "./table";

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

      <AdminTableCard>
        <AdminTable>
          <AdminTableHead
            columns={[
              { label: "Time" },
              { label: "Action" },
              { label: "Actor" },
              { label: "Target" },
              { label: "IP" },
              { label: "User-Agent" },
              { label: "Details" },
            ]}
          />
          <AdminTableBody>
            {data?.items.map((item) => (
              <tr key={item.id}>
                <AdminTd className="whitespace-nowrap">{new Date(item.createdAt).toLocaleString()}</AdminTd>
                <AdminTd>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                      ACTION_COLORS[item.action] ?? "bg-gray-50 text-gray-600"
                    }`}
                  >
                    {item.action}
                  </span>
                </AdminTd>
                <AdminTd>{item.actor ?? "—"}</AdminTd>
                <AdminTd>
                  {item.targetType ? (
                    <span className="text-gray-700">
                      {item.targetType}
                      {item.targetId != null ? ` #${item.targetId}` : ""}
                    </span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </AdminTd>
                <AdminTd>{item.ip ?? "—"}</AdminTd>
                <AdminTd className="max-w-[200px] truncate" title={item.userAgent ?? undefined}>
                  {item.userAgent ?? <span className="text-gray-300">—</span>}
                </AdminTd>
                <AdminTd>
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
                </AdminTd>
              </tr>
            ))}
            {(!data || data.items.length === 0) && !loading && (
              <AdminTableEmptyRow colSpan={7}>No audit records yet.</AdminTableEmptyRow>
            )}
          </AdminTableBody>
        </AdminTable>
      </AdminTableCard>

      <AdminMobileCards>
        {data?.items.map((item) => {
          const hasDetails = item.details != null;
          return (
            <AdminMobileCard key={item.id} className="bg-white shadow">
              <div className="flex justify-between items-start gap-2 mb-2">
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                    ACTION_COLORS[item.action] ?? "bg-gray-50 text-gray-600"
                  }`}
                >
                  {item.action}
                </span>
                <span className="min-w-0 text-right text-xs text-gray-400 break-words">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div className="min-w-0">
                  <span className="text-gray-400">Actor: </span>
                  <span className="text-gray-700 break-all">{item.actor ?? "—"}</span>
                </div>
                <div className="min-w-0">
                  <span className="text-gray-400">IP: </span>
                  <span className="text-gray-700 break-all">{item.ip ?? "—"}</span>
                </div>
                <div className="min-w-0">
                  <span className="text-gray-400">Target: </span>
                  <span className="text-gray-700">
                    {item.targetType ? (
                      <>
                        {item.targetType}
                        {item.targetId != null ? ` #${item.targetId}` : ""}
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                </div>
                <div className="col-span-2 min-w-0">
                  <span className="text-gray-400">User-Agent: </span>
                  <span className="block truncate text-gray-700" title={item.userAgent ?? undefined}>
                    {item.userAgent ?? "—"}
                  </span>
                </div>
              </div>
              {hasDetails && (
                <button
                  type="button"
                  onClick={() => toggleDetails(item.id)}
                  className="mt-2 w-full max-w-full truncate rounded bg-gray-50 px-2 py-1.5 text-left font-mono text-xs text-gray-600 hover:bg-gray-100"
                >
                  {expandedId === item.id
                    ? JSON.stringify(item.details, null, 2)
                    : JSON.stringify(item.details)}
                </button>
              )}
            </AdminMobileCard>
          );
        })}
        {(!data || data.items.length === 0) && !loading && (
          <AdminMobileEmpty>No audit records yet.</AdminMobileEmpty>
        )}
      </AdminMobileCards>

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
