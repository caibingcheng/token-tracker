"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Brush,
  Cell,
} from "recharts";

interface DailyData {
  group: string;
  totalInput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalOutput: number;
  count: number;
}

interface Summary {
  startDate: string;
  endDate: string;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalRequests: number;
}

const COLORS = {
  input: "#3B82F6",
  cache: "#93C5FD",
  output: "#1E40AF",
};

const DEFAULT_WINDOW = 30;

function formatNumber(num: number) {
  return new Intl.NumberFormat("en-US").format(num);
}

export default function DailyUsageChart() {
  const [data, setData] = useState<DailyData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [brushRange, setBrushRange] = useState<{ startIndex: number; endIndex: number } | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch("/api/stats?groupBy=date&range=all")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((result) => {
        if (result.success) {
          const sorted = result.data.sort((a: DailyData, b: DailyData) =>
            a.group.localeCompare(b.group)
          );
          setData(sorted);
          // Default: last 30 days
          const end = sorted.length - 1;
          const start = Math.max(0, end - DEFAULT_WINDOW + 1);
          setBrushRange({ startIndex: start, endIndex: end });
        } else {
          setError(result.error || "Failed to load data");
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const summary = useMemo<Summary | null>(() => {
    if (!brushRange || data.length === 0) return null;
    const { startIndex, endIndex } = brushRange;
    const slice = data.slice(startIndex, endIndex + 1);
    if (slice.length === 0) return null;
    return {
      startDate: slice[0].group,
      endDate: slice[slice.length - 1].group,
      totalInput: slice.reduce((s, d) => s + d.totalInput, 0),
      totalOutput: slice.reduce((s, d) => s + d.totalOutput, 0),
      totalCacheRead: slice.reduce((s, d) => s + d.totalInputCached, 0),
      totalRequests: slice.reduce((s, d) => s + d.count, 0),
    };
  }, [brushRange, data]);

  const handleBrushChange = useCallback((range: { startIndex?: number; endIndex?: number }) => {
    if (typeof range.startIndex === "number" && typeof range.endIndex === "number") {
      setBrushRange({ startIndex: range.startIndex, endIndex: range.endIndex });
    }
  }, []);

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <div className="h-[300px] bg-gray-100 rounded animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <p className="text-red-600">Error: {error}</p>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <p className="text-gray-500">No data available</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-8">
      {/* Summary Card */}
      {summary && (
        <div className="mb-6 p-4 bg-gray-50 rounded-lg">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-sm font-medium text-gray-500">
              Summary ({summary.startDate} ~ {summary.endDate})
            </h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-gray-400">Total Input</p>
              <p className="text-lg font-bold text-gray-900">{formatNumber(summary.totalInput)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Cache Read</p>
              <p className="text-lg font-bold text-blue-600">{formatNumber(summary.totalCacheRead)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Total Output</p>
              <p className="text-lg font-bold text-gray-900">{formatNumber(summary.totalOutput)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Requests</p>
              <p className="text-lg font-bold text-gray-900">{formatNumber(summary.totalRequests)}</p>
            </div>
          </div>
        </div>
      )}

      <h2 className="text-lg font-semibold mb-4">Daily Token Usage</h2>
      <ResponsiveContainer width="100%" height={350}>
        <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="group"
            tick={{ fontSize: 12 }}
            tickFormatter={(value: string) => {
              const parts = value.split("-");
              return parts.length >= 2 ? `${parts[1]}-${parts[2] || parts[1]}` : value;
            }}
          />
          <YAxis tick={{ fontSize: 12 }} tickFormatter={(v: number) => formatNumber(v)} />
          <Tooltip
            formatter={(value: number, name: string) => [formatNumber(value), name]}
            labelFormatter={(label: string) => `Date: ${label}`}
          />
          <Bar dataKey="totalInputUncached" stackId="tokens" fill={COLORS.input} name="Input" />
          <Bar dataKey="totalInputCached" stackId="tokens" fill={COLORS.cache} name="Cache Read" />
          <Bar dataKey="totalOutput" stackId="tokens" fill={COLORS.output} name="Output" />
          <Brush
            dataKey="group"
            height={30}
            stroke="#3B82F6"
            startIndex={brushRange?.startIndex}
            endIndex={brushRange?.endIndex}
            onChange={handleBrushChange}
            travellerWidth={8}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
