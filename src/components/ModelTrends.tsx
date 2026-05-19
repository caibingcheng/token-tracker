"use client";

import { useEffect, useState, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";

interface ModelTrendData {
  group: string;
  model: string;
  totalInput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalOutput: number;
  totalCacheWrite: number;
  count: number;
}

interface ModelGroup {
  model: string;
  totalRequests: number;
  data: ModelTrendData[];
}

export default function ModelTrends({ range = "30d" }: { range?: string }) {
  const [rawData, setRawData] = useState<ModelTrendData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/stats?groupBy=date-model&range=${range}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((result) => {
        if (result.success) {
          setRawData(result.data);
        } else {
          setError(result.error || "Failed to load trend data");
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [range]);

  const modelGroups = useMemo(() => {
    const grouped = new Map<string, ModelTrendData[]>();
    rawData.forEach((item) => {
      if (!grouped.has(item.model)) {
        grouped.set(item.model, []);
      }
      grouped.get(item.model)!.push(item);
    });

    const result: ModelGroup[] = [];
    grouped.forEach((data, model) => {
      data.sort((a, b) => a.group.localeCompare(b.group));
      const totalRequests = data.reduce((sum, d) => sum + d.count, 0);
      result.push({ model, totalRequests, data });
    });

    return result;
  }, [rawData]);

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <h3 className="text-lg font-semibold mb-4">Token Usage by Model</h3>
        <div className="h-[300px] bg-gray-100 rounded animate-pulse"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <h3 className="text-lg font-semibold mb-4">Token Usage by Model</h3>
        <p className="text-red-600">Error: {error}</p>
      </div>
    );
  }

  if (modelGroups.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <h3 className="text-lg font-semibold mb-4">Token Usage by Model</h3>
        <p className="text-gray-500">No data available</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h3 className="text-lg font-semibold">Token Usage by Model</h3>
      {modelGroups.map(({ model, totalRequests, data }) => (
        <div key={model} className="bg-white rounded-lg shadow p-6">
          <div className="mb-4">
            <h4 className="text-base font-semibold">{model}</h4>
            <p className="text-sm text-gray-500">
              API Requests: {totalRequests.toLocaleString()}
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left: Request Count Trend */}
            <div>
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="group" />
                  <YAxis />
                  <Tooltip />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="#3B82F6"
                    fill="#3B82F6"
                    fillOpacity={0.3}
                    name="Requests"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Right: Token Usage Stacked Bar */}
            <div>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="group" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar
                    dataKey="totalInputCached"
                    stackId="input"
                    fill="#93C5FD"
                    name="Input (Cached)"
                  />
                  <Bar
                    dataKey="totalInputUncached"
                    stackId="input"
                    fill="#3B82F6"
                    name="Input (Uncached)"
                  />
                  <Bar
                    dataKey="totalOutput"
                    fill="#1E40AF"
                    name="Output"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
