"use client";

import { useEffect, useState, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface DailyData {
  group: string;
  totalInput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalOutput: number;
  count: number;
}

const COLORS = {
  input: "#3B82F6",
  cache: "#93C5FD",
  output: "#1E40AF",
};

const WINDOW_DAYS = 30;

function formatNumber(num: number) {
  return new Intl.NumberFormat("en-US").format(num);
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getLast30Days(): string[] {
  const days: string[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(formatDate(d));
  }
  return days;
}

export default function DailyUsageChart() {
  const [data, setData] = useState<DailyData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch("/api/stats?groupBy=date&range=30d")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((result) => {
        if (result.success) {
          const apiData = new Map<string, DailyData>();
          result.data.forEach((item: DailyData) => {
            apiData.set(item.group, item);
          });

          const last30Days = getLast30Days();
          const merged = last30Days.map((date) => {
            const existing = apiData.get(date);
            if (existing) return existing;
            return {
              group: date,
              totalInput: 0,
              totalInputCached: 0,
              totalInputUncached: 0,
              totalOutput: 0,
              count: 0,
            };
          });

          setData(merged);
        } else {
          setError(result.error || "Failed to load data");
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const summary = useMemo(() => {
    if (data.length === 0) return null;
    return {
      totalInput: data.reduce((s, d) => s + d.totalInput, 0),
      totalOutput: data.reduce((s, d) => s + d.totalOutput, 0),
      totalCacheRead: data.reduce((s, d) => s + d.totalInputCached, 0),
      totalRequests: data.reduce((s, d) => s + d.count, 0),
    };
  }, [data]);

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
          <h3 className="text-sm font-medium text-gray-500 mb-3">
            Last {WINDOW_DAYS} Days Summary
          </h3>
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
      <ResponsiveContainer width="100%" height={280}>
        <BarChart
          data={data}
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
          barCategoryGap="20%"
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="group"
            tick={{ fontSize: 11 }}
            interval={4}
            tickFormatter={(value: string) => {
              const parts = value.split("-");
              return parts.length >= 3 ? `${Number(parts[1])}-${Number(parts[2])}` : value;
            }}
          />
          <YAxis
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => formatNumber(v)}
          />
          <Tooltip
            formatter={(value: number, name: string) => [formatNumber(value), name]}
            labelFormatter={(label: string) => `Date: ${label}`}
          />
          <Bar
            dataKey="totalInputUncached"
            stackId="tokens"
            fill={COLORS.input}
            name="Input"
          />
          <Bar
            dataKey="totalInputCached"
            stackId="tokens"
            fill={COLORS.cache}
            name="Cache Read"
          />
          <Bar
            dataKey="totalOutput"
            stackId="tokens"
            fill={COLORS.output}
            name="Output"
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
