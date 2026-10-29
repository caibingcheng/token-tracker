"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import ColumnPicker from "../ColumnPicker";
import {
  AUDIT_COLUMNS,
  DEFAULT_AUDIT_COLUMNS,
  normalizeAuditColumns,
  type AuditColumnId,
} from "@/lib/audit-columns";
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
  // 库里出现过的 action 去重列表（后端 selectDistinct），供筛选下拉
  actions?: string[];
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

const PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 50;
const ALL_ACTIONS = "all";

function ActionBadge({ action }: { action: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
        ACTION_COLORS[action] ?? "bg-gray-50 text-gray-600"
      }`}
    >
      {action}
    </span>
  );
}

function DetailsCell({
  item,
  expandedId,
  onToggle,
}: {
  item: AuditLogItem;
  expandedId: number | null;
  onToggle: (id: number) => void;
}) {
  if (item.details == null) return <span className="text-gray-300">—</span>;

  const open = expandedId === item.id;
  return (
    <button
      type="button"
      onClick={() => onToggle(item.id)}
      title={open ? "Collapse details" : "Expand details"}
      className={`flex min-h-[40px] md:min-h-0 md:block max-w-[260px] items-center rounded bg-gray-50 px-2 py-1 text-left font-mono text-xs text-gray-600 hover:bg-gray-100 ${
        open ? "whitespace-pre-wrap break-all" : "truncate"
      }`}
    >
      {JSON.stringify(item.details, null, open ? 2 : undefined)}
    </button>
  );
}

function PagerButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="px-2 py-2 text-gray-700 bg-gray-100 rounded disabled:opacity-50 flex items-center justify-center min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0"
    >
      {children}
    </button>
  );
}

function PagerIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export default function AuditLogsPanel() {
  const [data, setData] = useState<AuditLogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [action, setAction] = useState<string>(ALL_ACTIONS);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [pageInput, setPageInput] = useState("1");
  // 列可见性：DB 配置（audit_columns），加载前先按默认全显示
  const [visibleColumns, setVisibleColumns] = useState<AuditColumnId[]>(DEFAULT_AUDIT_COLUMNS);
  const [columnsError, setColumnsError] = useState<string | null>(null);
  // 请求序号（防旧响应覆盖新数据）/ 列配置保存序号（防旧失败回滚新值）
  const requestSeqRef = useRef(0);
  const columnsSaveSeqRef = useRef(0);

  const load = useCallback(async () => {
    // 请求序号：筛选/页码/条数连续变更时，旧响应不得覆盖新数据（否则下拉显示新 Action、表格却是旧 Action）
    const seq = ++requestSeqRef.current;
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (action !== ALL_ACTIONS) params.set("action", action);
      const res = await apiFetch(`/api/admin/audit-logs?${params.toString()}`);
      const json = await res.json();
      if (seq !== requestSeqRef.current) return;
      if (json.success) {
        setData(json.data);
        setError(null);
      } else {
        setError(json.error || "Failed to load audit logs");
      }
    } catch {
      if (seq !== requestSeqRef.current) return;
      setError("Network error");
    } finally {
      // 旧请求不得提前清掉新请求的 loading
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [page, pageSize, action]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  // 列可见性：打开页面读 DB 配置（已被本地修改过则不覆盖），改动即时落库；失败回退上一次成功的值
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/admin/settings/audit-columns")
      .then((res) => res.json())
      .then((json: { success?: boolean; data?: { columns?: unknown } }) => {
        if (cancelled || !json.success || columnsSaveSeqRef.current > 0) return;
        setVisibleColumns(normalizeAuditColumns(json.data?.columns));
      })
      .catch(() => {
        // 读失败保持默认全显示（不阻塞表格）
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const columnsRef = useRef<AuditColumnId[]>(DEFAULT_AUDIT_COLUMNS);
  useEffect(() => {
    columnsRef.current = visibleColumns;
  }, [visibleColumns]);

  const changeColumns = useCallback((next: AuditColumnId[]) => {
    const previous = columnsRef.current;
    const seq = ++columnsSaveSeqRef.current;
    columnsRef.current = next;
    setVisibleColumns(next);
    setColumnsError(null);
    apiFetch("/api/admin/settings/audit-columns", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ columns: next }),
    })
      .then(async (res) => {
        if (res.ok) return;
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error || `HTTP ${res.status}`);
      })
      .catch((err: unknown) => {
        // 已有更新的保存（更靠后的 seq）：旧失败不得把新值回滚掉
        if (seq !== columnsSaveSeqRef.current) return;
        columnsRef.current = previous;
        setVisibleColumns(previous);
        setColumnsError(err instanceof Error ? err.message : "Failed to save columns");
      });
  }, []);

  const changePageSize = (size: number) => {
    setPageSize(size);
    setPage(1);
  };

  const changeAction = (value: string) => {
    setAction(value);
    setPage(1);
    setExpandedId(null);
  };

  const toggleDetails = (id: number) => {
    setExpandedId(expandedId === id ? null : id);
  };

  const items = data?.items ?? [];
  const totalPages = data?.totalPages ?? 1;
  const hasItems = items.length > 0;
  const isFirstPage = page <= 1;
  const isLastPage = page >= totalPages;
  const visibleDefs = AUDIT_COLUMNS.filter((column) => visibleColumns.includes(column.id));

  const commitPageInput = () => {
    const parsed = parseInt(pageInput, 10);
    if (!Number.isFinite(parsed)) {
      setPageInput(String(page));
      return;
    }
    const next = Math.min(Math.max(1, parsed), totalPages);
    setPageInput(String(next));
    if (next !== page) {
      setPage(next);
    }
  };

  const renderCell = (item: AuditLogItem, id: AuditColumnId) => {
    switch (id) {
      case "time":
        return (
          <AdminTd key={id} className="whitespace-nowrap text-sm text-gray-900">
            {new Date(item.createdAt).toLocaleString()}
          </AdminTd>
        );
      case "action":
        return (
          <AdminTd key={id}>
            <ActionBadge action={item.action} />
          </AdminTd>
        );
      case "actor":
        return (
          <AdminTd key={id} className="whitespace-nowrap text-sm text-gray-900">
            {item.actor ?? "—"}
          </AdminTd>
        );
      case "target":
        return (
          <AdminTd key={id} className="whitespace-nowrap text-sm">
            {item.targetType ? (
              <span className="text-gray-700">
                {item.targetType}
                {item.targetId != null ? ` #${item.targetId}` : ""}
              </span>
            ) : (
              <span className="text-gray-300">—</span>
            )}
          </AdminTd>
        );
      case "ip":
        return (
          <AdminTd key={id} className="whitespace-nowrap text-sm text-gray-500">
            {item.ip ?? "—"}
          </AdminTd>
        );
      case "userAgent":
        return (
          <AdminTd key={id} className="max-w-[220px] truncate text-sm text-gray-500" title={item.userAgent ?? undefined}>
            {item.userAgent ?? <span className="text-gray-300">—</span>}
          </AdminTd>
        );
      case "details":
        return (
          <AdminTd key={id}>
            <DetailsCell item={item} expandedId={expandedId} onToggle={toggleDetails} />
          </AdminTd>
        );
    }
  };

  return (
    <div>
      <p className="mb-3 text-sm text-gray-500">
        Admin actions recorded here: login, key &amp; TOTP changes, upstream / virtual key management.
      </p>

      <div className="sticky top-0 z-20 -mx-4 mb-6 bg-gray-50 px-4 py-3 md:-mx-8 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={action}
              onChange={(e) => changeAction(e.target.value)}
              aria-label="Filter by action"
              className="min-h-[40px] min-w-0 max-w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 md:min-h-0"
            >
              <option value={ALL_ACTIONS}>All Actions</option>
              {(data?.actions ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            {action !== ALL_ACTIONS && (
              <button
                type="button"
                onClick={() => changeAction(ALL_ACTIONS)}
                className="inline-flex min-h-[40px] items-center rounded border border-gray-300 bg-white px-3 text-sm font-medium text-gray-600 shadow-sm hover:bg-gray-50 md:min-h-0 md:py-1.5"
              >
                Reset
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ColumnPicker
              columns={AUDIT_COLUMNS}
              value={visibleColumns}
              onChange={changeColumns}
              error={columnsError}
            />
            <label className="flex items-center gap-2 text-xs text-gray-600">
              Rows
              <select
                value={pageSize}
                onChange={(e) => changePageSize(Number(e.target.value))}
                aria-label="Rows per page"
                className="h-10 min-w-0 rounded border border-gray-300 bg-white px-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 md:h-8 md:text-xs"
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              title="Refresh"
              className={`inline-flex h-10 items-center justify-center rounded px-3 text-sm font-medium transition-colors bg-gray-100 disabled:cursor-default md:h-8 md:text-xs ${
                loading ? "text-blue-600 animate-pulse" : "text-gray-600 hover:bg-gray-200"
              }`}
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      <AdminTableCard flush>
        {error && hasItems && (
          <div className="mx-6 mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Refresh failed: {error}
          </div>
        )}

        {loading ? (
          <div className="p-6">
            <div className="h-4 bg-gray-200 rounded w-full mb-4 animate-pulse"></div>
            <div className="h-4 bg-gray-200 rounded w-full mb-4 animate-pulse"></div>
            <div className="h-4 bg-gray-200 rounded w-full mb-4 animate-pulse"></div>
          </div>
        ) : error && !hasItems ? (
          <div className="p-6">
            <p className="text-red-600">Error: {error}</p>
          </div>
        ) : (
          <>
            <AdminTable>
              <AdminTableHead
                columns={visibleDefs.map((column) => ({ label: column.label }))}
              />
              <AdminTableBody>
                {items.map((item) => (
                  <tr key={item.id}>
                    {visibleDefs.map((column) => renderCell(item, column.id))}
                  </tr>
                ))}
                {!hasItems && (
                  <AdminTableEmptyRow colSpan={visibleDefs.length}>
                    No audit records yet.
                  </AdminTableEmptyRow>
                )}
              </AdminTableBody>
            </AdminTable>

            <AdminMobileCards>
              {items.map((item) => (
                <AdminMobileCard key={item.id} className="bg-white shadow">
                  <div className="flex justify-between items-start gap-2 mb-2">
                    {visibleColumns.includes("action") && <ActionBadge action={item.action} />}
                    {visibleColumns.includes("time") && (
                      <span className="ml-auto min-w-0 text-right text-xs text-gray-400 break-words">
                        {new Date(item.createdAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    {visibleColumns.includes("actor") && (
                      <div className="min-w-0">
                        <span className="text-gray-400">Actor: </span>
                        <span className="text-gray-700 break-all">{item.actor ?? "—"}</span>
                      </div>
                    )}
                    {visibleColumns.includes("ip") && (
                      <div className="min-w-0">
                        <span className="text-gray-400">IP: </span>
                        <span className="text-gray-700 break-all">{item.ip ?? "—"}</span>
                      </div>
                    )}
                    {visibleColumns.includes("target") && (
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
                    )}
                    {visibleColumns.includes("userAgent") && (
                      <div className="col-span-2 min-w-0">
                        <span className="text-gray-400">User-Agent: </span>
                        <span className="block truncate text-gray-700" title={item.userAgent ?? undefined}>
                          {item.userAgent ?? "—"}
                        </span>
                      </div>
                    )}
                  </div>
                  {visibleColumns.includes("details") && item.details != null && (
                    <div className="mt-2">
                      <DetailsCell item={item} expandedId={expandedId} onToggle={toggleDetails} />
                    </div>
                  )}
                </AdminMobileCard>
              ))}
              {!hasItems && <AdminMobileEmpty>No audit records yet.</AdminMobileEmpty>}
            </AdminMobileCards>

            <div className="border-t px-4 py-4 md:px-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm text-gray-600">
                  Page {page} of {totalPages}
                </span>
                <div className="flex items-center gap-2">
                  <PagerButton onClick={() => setPage(1)} disabled={isFirstPage} label="First page">
                    <PagerIcon>
                      <polygon points="19 20 9 12 19 4 19 20" />
                      <line x1="5" y1="19" x2="5" y2="5" />
                    </PagerIcon>
                  </PagerButton>
                  <PagerButton
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={isFirstPage}
                    label="Previous page"
                  >
                    <PagerIcon>
                      <polyline points="15 18 9 12 15 6" />
                    </PagerIcon>
                  </PagerButton>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={pageInput}
                    onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitPageInput();
                      }
                    }}
                    onBlur={commitPageInput}
                    aria-label="Page number"
                    title="Jump to page"
                    style={{ width: `${Math.max(String(totalPages).length + 2, 4)}ch` }}
                    className="h-10 md:h-8 px-0 text-base md:text-sm text-center tabular-nums border border-gray-200 rounded bg-gray-50 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <PagerButton
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={isLastPage}
                    label="Next page"
                  >
                    <PagerIcon>
                      <polyline points="9 18 15 12 9 6" />
                    </PagerIcon>
                  </PagerButton>
                  <PagerButton
                    onClick={() => setPage(totalPages)}
                    disabled={isLastPage}
                    label="Last page"
                  >
                    <PagerIcon>
                      <polygon points="5 4 15 12 5 20 5 4" />
                      <line x1="19" y1="5" x2="19" y2="19" />
                    </PagerIcon>
                  </PagerButton>
                </div>
              </div>
            </div>
          </>
        )}
      </AdminTableCard>
    </div>
  );
}
