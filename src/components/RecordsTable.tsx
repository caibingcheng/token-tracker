"use client";

import { useEffect, useState } from "react";
import { formatNumber, formatLatencyMs } from "@/lib/number-utils";
import { useNumberFormat } from "./NumberFormatContext";
import { apiFetch } from "@/lib/client/api-client";

export interface Record {
  id: number;
  model: string;
  normalizedModel: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  requestModel?: string | null;
  latencyMs?: number | null;
  ttftMs?: number | null;
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

interface ToolbarProps {
  onHome: () => void;
  onRefresh: () => void;
  canGoHome: boolean;
}

function Toolbar({ onHome, onRefresh, canGoHome }: ToolbarProps) {
  return (
    <div className="flex items-center justify-end px-6 py-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onHome}
          disabled={!canGoHome}
          className="text-gray-400 hover:text-blue-600 disabled:opacity-30 transition-colors p-1"
          title="First page"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="19 20 9 12 19 4 19 20"/>
            <line x1="5" y1="19" x2="5" y2="5"/>
          </svg>
        </button>
        <button
          type="button"
          onClick={onRefresh}
          className="text-gray-400 hover:text-blue-600 transition-colors p-1"
          title="Refresh"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
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

export default function RecordsTable({ selectedProvider = "all", selectedModel = "all", selectedModelName, selectedAgent = "all", refreshKey = 0, showHeader = true }: RecordsTableProps) {
  const [records, setRecords] = useState<Record[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [queryKey, setQueryKey] = useState(0);
  const { compact } = useNumberFormat();

  // Reset page and bump queryKey when filters change
  useEffect(() => {
    setPage(1);
    setQueryKey(k => k + 1);
  }, [selectedProvider, selectedModel, selectedAgent]);

  // Fetch records（认证由 ApiKeyGate/api-client 统一处理，401 自动回输入页）
  useEffect(() => {
    setLoading(true);
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
        if (result.success) {
          setRecords(result.data);
          setTotalPages(result.pagination.totalPages);
        } else {
          setError(result.error || "Failed to load records");
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [page, queryKey, refreshKey, selectedProvider, selectedModel, selectedAgent]);

  const formatDate = (date: string) => new Date(date).toLocaleString();

  const handleRefresh = () => {
    setQueryKey((prev) => prev + 1);
  };

  const handleHome = () => {
    setPage(1);
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <Toolbar onHome={handleHome} onRefresh={handleRefresh} canGoHome={page > 1} />
        {showHeader && (
          <div className="p-6 pb-0">
            <h3 className="text-lg font-semibold">Recent Records</h3>
            <FilterHint selectedModelName={selectedModelName} />
          </div>
        )}
        <div className="p-6">
          <div className="h-4 bg-gray-200 rounded w-full mb-4 animate-pulse"></div>
          <div className="h-4 bg-gray-200 rounded w-full mb-4 animate-pulse"></div>
          <div className="h-4 bg-gray-200 rounded w-full mb-4 animate-pulse"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <Toolbar onHome={handleHome} onRefresh={handleRefresh} canGoHome={page > 1} />
        {showHeader && (
          <div className="p-6 pb-0">
            <h3 className="text-lg font-semibold">Recent Records</h3>
            <FilterHint selectedModelName={selectedModelName} />
          </div>
        )}
        <div className="p-6">
          <p className="text-red-600">Error: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <Toolbar onHome={handleHome} onRefresh={handleRefresh} canGoHome={page > 1} />
      {showHeader && (
        <div className="p-6 pb-0">
          <h3 className="text-lg font-semibold">Recent Records</h3>
          <FilterHint selectedModelName={selectedModelName} />
        </div>
      )}

      <div className="hidden md:block overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Agent</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input (Uncached)</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input (Cached)</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Output</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">TTFT</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Latency</th>
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
                  {record.agent}
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
                <p className="text-xs text-gray-400 mt-1">{record.agent}</p>
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
          </div>
        ))}
      </div>

      <div className="px-4 md:px-6 py-4 flex justify-between items-center border-t">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
          className="px-3 py-2 text-sm bg-gray-100 rounded disabled:opacity-50 flex items-center justify-center min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0"
          title="Previous"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <span className="text-sm text-gray-600">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
          className="px-3 py-2 text-sm bg-gray-100 rounded disabled:opacity-50 flex items-center justify-center min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0"
          title="Next"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
