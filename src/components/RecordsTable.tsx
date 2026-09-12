"use client";

import { useEffect, useRef, useState } from "react";
import { formatNumber, formatLatencyMs } from "@/lib/number-utils";
import { useNumberFormat } from "./NumberFormatContext";
import { apiFetch } from "@/lib/client/api-client";

export interface Record {
  id: number;
  model: string;
  normalizedModel: string;
  providerName?: string | null;
  agent: string;
  keyName: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  requestModel?: string | null;
  latencyMs?: number | null;
  ttftMs?: number | null;
  status?: string | null;
  createdAt: string;
}

interface RecordsTableProps {
  selectedProvider?: string;
  selectedModel?: string;
  selectedModelName?: string;
  selectedAgent?: string;
  refreshKey?: number;
  showHeader?: boolean;
}

const AUTO_REFRESH_INTERVAL_MS = 15000;

function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return <span className="text-gray-400">-</span>;
  switch (status) {
    case "no_usage":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
          No usage
        </span>
      );
    case "client_aborted":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
          Client aborted
        </span>
      );
    case "stream_interrupted":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">
          Stream interrupted
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800">
          {status}
        </span>
      );
  }
}

interface ToolbarProps {
  onRefresh: () => void;
  refreshing: boolean;
  autoRefresh: boolean;
  onToggleAutoRefresh: () => void;
}

function Toolbar({ onRefresh, refreshing, autoRefresh, onToggleAutoRefresh }: ToolbarProps) {
  return (
    <div className="flex items-center justify-end px-6 py-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className={`inline-flex items-center justify-center px-3 h-10 md:h-8 text-sm md:text-xs font-medium rounded transition-colors bg-gray-100 disabled:cursor-default ${
            refreshing ? "text-blue-600 animate-pulse" : "text-gray-600 hover:bg-gray-200"
          }`}
          title="Refresh"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={onToggleAutoRefresh}
          aria-pressed={autoRefresh}
          className={`inline-flex items-center justify-center px-3 h-10 md:h-8 text-sm md:text-xs font-medium rounded transition-colors ${
            autoRefresh
              ? "text-blue-700 bg-blue-100"
              : "text-gray-600 bg-gray-100 hover:bg-gray-200"
          }`}
          title={autoRefresh ? "Auto refresh every 15s: on" : "Auto refresh every 15s: off"}
        >
          Auto 15s
        </button>
      </div>
    </div>
  );
}

function FilterHint({ selectedModelName }: { selectedModelName?: string }) {
  if (!selectedModelName || selectedModelName === "all") return null;
  return (
    <p className="text-xs text-gray-400 mt-1">
      Filtered by {selectedModelName}
    </p>
  );
}

interface PagerButtonProps {
  onClick: () => void;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}

function PagerButton({ onClick, disabled, label, children }: PagerButtonProps) {
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

function IconFirst() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="19 20 9 12 19 4 19 20"/>
      <line x1="5" y1="19" x2="5" y2="5"/>
    </svg>
  );
}

function IconLast() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 4 15 12 5 20 5 4"/>
      <line x1="19" y1="5" x2="19" y2="19"/>
    </svg>
  );
}

function IconPrev() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  );
}

function IconNext() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  );
}

export default function RecordsTable({ selectedProvider = "all", selectedModel = "all", selectedModelName, selectedAgent = "all", refreshKey = 0, showHeader = true }: RecordsTableProps) {
  const [records, setRecords] = useState<Record[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [pageInput, setPageInput] = useState("1");

  const [queryKey, setQueryKey] = useState(0);
  const { compact } = useNumberFormat();

  // 首次加载才切换骨架屏；后续刷新（手动 / 自动 / 父级 refreshKey）保持表格挂载，静默替换数据
  const loadedOnceRef = useRef(false);
  // 请求序号：慢响应晚到时不覆盖更新的结果
  const requestSeqRef = useRef(0);

  // Reset page and bump queryKey when filters change
  useEffect(() => {
    setPage(1);
    setQueryKey(k => k + 1);
  }, [selectedProvider, selectedModel, selectedAgent]);

  // 自动刷新（15s），页面不可见时跳过
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setQueryKey((k) => k + 1);
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  // Fetch records（认证由 ApiKeyGate/api-client 统一处理，401 自动回输入页）
  useEffect(() => {
    const seq = ++requestSeqRef.current;
    if (loadedOnceRef.current) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    const url = new URL("/api/records", window.location.origin);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", "20");
    if (selectedProvider !== "all") {
      url.searchParams.set("provider", selectedProvider);
    }
    if (selectedModel !== "all") {
      url.searchParams.set("model", selectedModel);
    }
    if (selectedAgent !== "all") {
      url.searchParams.set("agent", selectedAgent);
    }

    apiFetch(url.toString())
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((result) => {
        if (seq !== requestSeqRef.current) return;
        if (result.success) {
          loadedOnceRef.current = true;
          const nextTotalPages = Math.max(1, Number(result.pagination?.totalPages) || 1);
          setTotalPages(nextTotalPages);
          // 页码越界（数据被删除/过滤后总页数收缩）时回到末页重取
          if (page > nextTotalPages) {
            setPage(nextTotalPages);
            return;
          }
          setRecords(result.data);
        } else {
          setError(result.error || "Failed to load records");
        }
      })
      .catch((err) => {
        if (seq !== requestSeqRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seq !== requestSeqRef.current) return;
        setLoading(false);
        setRefreshing(false);
      });
  }, [page, queryKey, refreshKey, selectedProvider, selectedModel, selectedAgent]);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const formatDate = (date: string) => new Date(date).toLocaleString();

  const handleRefresh = () => {
    setQueryKey((prev) => prev + 1);
  };

  const handleToggleAutoRefresh = () => {
    if (!autoRefresh) {
      setQueryKey((prev) => prev + 1);
    }
    setAutoRefresh((prev) => !prev);
  };

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

  const isFirstPage = page <= 1;
  const isLastPage = page >= totalPages;
  const hasRecords = records.length > 0;
  // 输入框宽度按最大页码位数自适应（位数 + 2ch 余量）
  const pageInputWidth = `${Math.max(String(totalPages).length + 2, 4)}ch`;

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <Toolbar
        onRefresh={handleRefresh}
        refreshing={refreshing}
        autoRefresh={autoRefresh}
        onToggleAutoRefresh={handleToggleAutoRefresh}
      />
      {showHeader && (
        <div className="p-6 pb-0">
          <h3 className="text-lg font-semibold">Recent Records</h3>
          <FilterHint selectedModelName={selectedModelName} />
        </div>
      )}

      {error && hasRecords && (
        <div className="mx-4 md:mx-6 mt-3 px-3 py-2 rounded border border-red-200 bg-red-50 text-sm text-red-700">
          Refresh failed: {error}
        </div>
      )}

      {loading ? (
        <div className="p-6">
          <div className="h-4 bg-gray-200 rounded w-full mb-4 animate-pulse"></div>
          <div className="h-4 bg-gray-200 rounded w-full mb-4 animate-pulse"></div>
          <div className="h-4 bg-gray-200 rounded w-full mb-4 animate-pulse"></div>
        </div>
      ) : error && !hasRecords ? (
        <div className="p-6">
          <p className="text-red-600">Error: {error}</p>
        </div>
      ) : (
        <>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Agent</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Key</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input (Uncached)</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input (Cached)</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Output</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">TTFT</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Latency</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {records.map((record) => (
                  <tr key={record.id}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {formatDate(record.createdAt)}
                    </td>
                    <td
                      className="px-6 py-4 whitespace-nowrap text-sm text-gray-900"
                      title={
                        record.requestModel && record.requestModel !== record.model
                          ? `Requested: ${record.requestModel} → Upstream: ${record.model}`
                          : `Model: ${record.model}`
                      }
                    >
                      {record.normalizedModel}
                      {record.requestModel && record.requestModel !== record.model && (
                        <span className="ml-1.5 text-[10px] text-gray-400" title={`Original request model: ${record.requestModel}`}>
                          ← {record.requestModel}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {record.providerName || "-"}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {record.agent}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {record.keyName || "-"}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                      {formatNumber(record.inputTokens, compact)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                      {formatNumber(record.cacheRead, compact)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                      {formatNumber(record.outputTokens, compact)}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                      {formatLatencyMs(record.ttftMs)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                      {formatLatencyMs(record.latencyMs)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <StatusBadge status={record.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="md:hidden p-4 space-y-3">
            {records.map((record) => (
              <div key={record.id} className="border border-gray-200 rounded-lg p-4">
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <p className="text-xs text-gray-500">Date</p>
                    <p className="text-sm font-medium text-gray-900">{formatDate(record.createdAt)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-500">Model</p>
                    <p
                      className="text-sm font-medium text-gray-900"
                      title={
                        record.requestModel && record.requestModel !== record.model
                          ? `Requested: ${record.requestModel} → Upstream: ${record.model}`
                          : `Model: ${record.model}`
                      }
                    >
                      {record.normalizedModel}
                    </p>
                    {record.requestModel && record.requestModel !== record.model && (
                      <p className="text-xs text-gray-400 mt-0.5" title="Original request model">
                        ← {record.requestModel}
                      </p>
                    )}
                    <p className="text-xs text-gray-400 mt-0.5">{record.providerName || "-"}</p>
                    <p className="text-xs text-gray-400 mt-1">{record.agent}</p>
                    <p className="text-xs text-gray-400 mt-0.5">Key: {record.keyName || "-"}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-gray-500">Input (Uncached)</p>
                    <p className="text-sm font-semibold text-gray-900">{formatNumber(record.inputTokens, compact)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Input (Cached)</p>
                    <p className="text-sm font-semibold text-gray-900">{formatNumber(record.cacheRead, compact)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Output</p>
                    <p className="text-sm font-semibold text-gray-900">{formatNumber(record.outputTokens, compact)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">TTFT</p>
                    <p className="text-sm font-semibold text-gray-900">{formatLatencyMs(record.ttftMs)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Latency</p>
                    <p className="text-sm font-semibold text-gray-900">{formatLatencyMs(record.latencyMs)}</p>
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="text-xs text-gray-500">Status</p>
                  <div className="mt-1">
                    <StatusBadge status={record.status} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="px-4 md:px-6 py-4 border-t">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm text-gray-600">
                Page {page} of {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <PagerButton onClick={() => setPage(1)} disabled={isFirstPage} label="First page">
                  <IconFirst />
                </PagerButton>
                <PagerButton onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={isFirstPage} label="Previous page">
                  <IconPrev />
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
                  style={{ width: pageInputWidth }}
                  className="h-10 md:h-8 px-0 text-base md:text-sm text-center tabular-nums border border-gray-200 rounded bg-gray-50 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <PagerButton onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={isLastPage} label="Next page">
                  <IconNext />
                </PagerButton>
                <PagerButton onClick={() => setPage(totalPages)} disabled={isLastPage} label="Last page">
                  <IconLast />
                </PagerButton>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
