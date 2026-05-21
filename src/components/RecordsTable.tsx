"use client";

import { useEffect, useState } from "react";
import { normalizeModel } from "@/lib/model-utils";

export interface Record {
  id: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  createdAt: string;
}

interface RecordsTableProps {
  selectedProvider?: string;
  refreshKey?: number;
}

export default function RecordsTable({ selectedProvider = "all", refreshKey = 0 }: RecordsTableProps) {
  const [records, setRecords] = useState<Record[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/records?page=${page}&limit=20${selectedProvider !== "all" ? `&provider=${selectedProvider}` : ""}`)
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
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page, refreshKey, selectedProvider]);

  useEffect(() => {
    setPage(1);
  }, [selectedProvider]);

  const formatNumber = (num: number) => new Intl.NumberFormat("en-US").format(num);
  const formatDate = (date: string) => new Date(date).toLocaleString();

  const ProviderHint = () => {
    if (selectedProvider === "all") return null;
    return (
      <p className="text-xs text-gray-400 mt-1">
        Filtered by {selectedProvider}
      </p>
    );
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="p-6 pb-0">
          <h3 className="text-lg font-semibold">Recent Records</h3>
          <ProviderHint />
        </div>
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
        <div className="p-6 pb-0">
          <h3 className="text-lg font-semibold">Recent Records</h3>
          <ProviderHint />
        </div>
        <div className="p-6">
          <p className="text-red-600">Error: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <div className="p-6 pb-0">
        <h3 className="text-lg font-semibold">Recent Records</h3>
        <ProviderHint />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input (Uncached)</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input (Cached)</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Output</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cache Write</th>
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
                  {normalizeModel(record.model)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.inputTokens)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.cacheRead)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.outputTokens)}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.cacheWrite)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-6 py-4 flex justify-between items-center border-t">
        <div className="flex gap-2">
          <button
            onClick={() => setPage(1)}
            disabled={page === 1}
            className="px-4 py-2 bg-gray-100 rounded disabled:opacity-50"
          >
            Home
          </button>
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-4 py-2 bg-gray-100 rounded disabled:opacity-50"
          >
            Previous
          </button>
        </div>
        <span className="text-sm text-gray-600">
          Page {page} of {totalPages}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
          className="px-4 py-2 bg-gray-100 rounded disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
