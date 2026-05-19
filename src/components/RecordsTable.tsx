"use client";

export interface Record {
  id: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  createdAt: string;
}

interface RecordsTableProps {
  records: Record[];
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  loading: boolean;
  error: string | null;
}

export default function RecordsTable({
  records,
  page,
  totalPages,
  onPageChange,
  loading,
  error,
}: RecordsTableProps) {
  const formatNumber = (num: number) => new Intl.NumberFormat("en-US").format(num);
  const formatDate = (date: string) => new Date(date).toLocaleString();

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <h3 className="text-lg font-semibold p-6 pb-0">Recent Records</h3>
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
        <h3 className="text-lg font-semibold p-6 pb-0">Recent Records</h3>
        <div className="p-6">
          <p className="text-red-600">Error: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <h3 className="text-lg font-semibold p-6 pb-0">Recent Records</h3>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider</th>
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
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{record.model}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{record.provider}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.inputTokens)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.cacheRead)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.outputTokens)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.cacheWrite)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-6 py-4 flex justify-between items-center border-t">
        <button
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page === 1}
          className="px-4 py-2 bg-gray-100 rounded disabled:opacity-50"
        >
          Previous
        </button>
        <span className="text-sm text-gray-600">
          Page {page} of {totalPages}
        </span>
        <button
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          className="px-4 py-2 bg-gray-100 rounded disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
