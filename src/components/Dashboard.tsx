"use client";

import { useEffect, useState } from "react";
import StatsCards from "./StatsCards";
import RecordsTable from "./RecordsTable";

interface ModelStat {
  group: string;
  totalInput: number;
  totalOutput: number;
  count: number;
}

export default function Dashboard() {
  const [range, setRange] = useState("30d");
  const [topModels, setTopModels] = useState<ModelStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch("/api/stats?groupBy=model")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((result) => {
        if (result.success) {
          setTopModels(result.data.slice(0, 5));
        } else {
          setError(result.error || "Failed to load model data");
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const formatNumber = (num: number) => new Intl.NumberFormat("en-US").format(num);

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Token Tracker Dashboard</h1>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="px-4 py-2 border rounded-lg"
          >
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
            <option value="90d">Last 90 Days</option>
            <option value="all">All Time</option>
          </select>
        </div>

        <StatsCards />

        {/* Top 5 Models */}
        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h2 className="text-lg font-semibold mb-4">Top 5 Models</h2>
          {loading && (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-12 bg-gray-100 rounded animate-pulse"></div>
              ))}
            </div>
          )}
          {error && <p className="text-red-600">Error: {error}</p>}
          {!loading && !error && topModels.length === 0 && (
            <p className="text-gray-500">No data available</p>
          )}
          {!loading && !error && topModels.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input Tokens</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Output Tokens</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Requests</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {topModels.map((model) => (
                    <tr key={model.group}>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{model.group}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{formatNumber(model.totalInput)}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{formatNumber(model.totalOutput)}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{formatNumber(model.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <RecordsTable />
      </div>
    </main>
  );
}
