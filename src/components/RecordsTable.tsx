"use client";

import { useEffect, useRef, useState } from "react";

export interface Record {
  id: number;
  model: string;
  normalizedModel: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  createdAt: string;
}

interface RecordsTableProps {
  selectedProvider?: string;
  selectedModel?: string;
  selectedModelName?: string;
  refreshKey?: number;
  showHeader?: boolean;
}

const STORAGE_KEY = "token-tracker-api-key";

interface AuthCardProps {
  inputKey: string;
  setInputKey: (value: string) => void;
  onSubmit: () => void;
  authError: string | null;
}

function AuthCard({ inputKey, setInputKey, onSubmit, authError }: AuthCardProps) {
  return (
    <div className="p-6">
      <div className="max-w-sm mx-auto text-center">
        <div className="mb-4">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-gray-400">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <h4 className="text-base font-semibold text-gray-900 mb-1">Authentication Required</h4>
        <p className="text-sm text-gray-500 mb-4">Please enter your API Key to view records.</p>
        <div className="flex gap-2">
          <input
            type="password"
            value={inputKey}
            onChange={(e) => setInputKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit();
            }}
            placeholder="Enter API Key..."
            className="flex-1 rounded border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            onClick={onSubmit}
            className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 active:scale-95 transition-all"
          >
            Submit
          </button>
        </div>
        {authError && (
          <div className="mt-3 bg-red-50 border border-red-200 rounded p-3 text-sm text-red-600">
            {authError}
          </div>
        )}
      </div>
    </div>
  );
}

interface AuthStatusProps {
  onHome: () => void;
  onRefresh: () => void;
  onLogout: () => void;
  canGoHome: boolean;
}

function AuthStatus({ onHome, onRefresh, onLogout, canGoHome }: AuthStatusProps) {
  return (
    <div className="flex items-center justify-end px-6 py-3">
      <div className="flex items-center gap-3">
        <button
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
        <button
          onClick={onLogout}
          className="text-gray-400 hover:text-red-600 transition-colors p-1"
          title="Logout"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
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

export default function RecordsTable({ selectedProvider = "all", selectedModel = "all", selectedModelName, refreshKey = 0, showHeader = true }: RecordsTableProps) {
  const [records, setRecords] = useState<Record[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [apiKey, setApiKey] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [fetchTrigger, setFetchTrigger] = useState(0);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      setApiKey(stored);
    } else {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (apiKey) {
      localStorage.setItem(STORAGE_KEY, apiKey);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [apiKey]);

  const [queryKey, setQueryKey] = useState(0);

  // Reset page and bump queryKey when filters change
  useEffect(() => {
    setPage(1);
    setQueryKey(k => k + 1);
  }, [selectedProvider, selectedModel]);

  // Fetch records
  useEffect(() => {
    if (!apiKey) return;

    setLoading(true);
    setError(null);
    setAuthError(null);

    const headers: HeadersInit = {
      "X-API-Key": apiKey,
    };

    const url = new URL("/api/records", window.location.origin);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", "20");
    if (selectedProvider !== "all") {
      url.searchParams.set("provider", selectedProvider);
    }
    if (selectedModel !== "all") {
      url.searchParams.set("model", selectedModel);
    }

    fetch(url.toString(), { headers })
      .then((res) => {
        if (res.status === 401) {
          setApiKey(null);
          setAuthError("Invalid or missing API Key");
          throw new Error("Unauthorized");
        }
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
        if (err.message !== "Unauthorized") {
          setError(err.message);
        }
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, queryKey, refreshKey, apiKey]);

  const formatNumber = (num: number) => new Intl.NumberFormat("en-US").format(num);
  const formatDate = (date: string) => new Date(date).toLocaleString();

  const handleSubmitKey = () => {
    const trimmed = inputKey.trim();
    if (!trimmed) return;
    setApiKey(trimmed);
    setInputKey("");
    setAuthError(null);
  };

  const handleLogout = () => {
    setApiKey(null);
    setInputKey("");
    setAuthError(null);
    setRecords([]);
    setPage(1);
    setTotalPages(1);
  };

  const handleRefresh = () => {
    setFetchTrigger((prev) => prev + 1);
  };

  const handleHome = () => {
    setPage(1);
  };

  if (!apiKey) {
    return (
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {showHeader && (
          <div className="p-6 pb-0">
            <h3 className="text-lg font-semibold">Recent Records</h3>
        <FilterHint selectedModelName={selectedModelName} />
      </div>
    )}
    <AuthCard
      inputKey={inputKey}
      setInputKey={setInputKey}
      onSubmit={handleSubmitKey}
      authError={authError}
    />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <AuthStatus onHome={handleHome} onRefresh={handleRefresh} onLogout={handleLogout} canGoHome={page > 1} />
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
        <AuthStatus onHome={handleHome} onRefresh={handleRefresh} onLogout={handleLogout} canGoHome={page > 1} />
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
      <AuthStatus onHome={handleHome} onRefresh={handleRefresh} onLogout={handleLogout} canGoHome={page > 1} />
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
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input (Uncached)</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input (Cached)</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Output</th>
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
                  title={`Original Model: ${record.model}`}
                >
                  {record.normalizedModel}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.inputTokens)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.cacheRead)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.outputTokens)}</td>
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
                <p className="text-sm font-medium text-gray-900" title={`Original: ${record.model}`}>
                  {record.normalizedModel}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-gray-500">Input (Uncached)</p>
                <p className="text-sm font-semibold text-gray-900">{formatNumber(record.inputTokens)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Input (Cached)</p>
                <p className="text-sm font-semibold text-gray-900">{formatNumber(record.cacheRead)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Output</p>
                <p className="text-sm font-semibold text-gray-900">{formatNumber(record.outputTokens)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="px-4 md:px-6 py-4 flex justify-between items-center border-t">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
          className="px-3 py-2 text-sm bg-gray-100 rounded disabled:opacity-50 flex items-center justify-center"
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
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
          className="px-3 py-2 text-sm bg-gray-100 rounded disabled:opacity-50 flex items-center justify-center"
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
