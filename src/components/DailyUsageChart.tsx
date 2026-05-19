"use client";

import { useMemo } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export interface DailyData {
  group: string;
  totalInput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalOutput: number;
  count: number;
}

interface DailyUsageChartProps {
  rawData: DailyData[];
  loading: boolean;
  error: string | null;
}

const COLORS = {
  input: "#3B82F6",
  cache: "#93C5FD",
  output: "#1E40AF",
  hitRate: "#F59E0B",
};

const WINDOW_DAYS = 30;

function formatNumber(num: number) {
  return new Intl.NumberFormat("en-US").format(num);
}

function formatAxisNumber(num: number) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  }
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

export default function DailyUsageChart({ rawData, loading, error }: DailyUsageChartProps) {
  const data = useMemo(() => {
    const apiData = new Map<string, DailyData>();
    rawData.forEach((item) => {
      apiData.set(item.group, item);
    });

    const last30Days = getLast30Days();
    const mapped = last30Days.map((date) => {
      const existing = apiData.get(date);
      if (existing) {
        const cached = Number(existing.totalInputCached) || 0;
        const uncached = Number(existing.totalInputUncached) || 0;
        const totalInput = cached + uncached;
        return {
          ...existing,
          totalInputCached: cached,
          totalInputUncached: uncached,
          totalOutput: Number(existing.totalOutput) || 0,
          totalInput: Number(existing.totalInput) || 0,
          count: Number(existing.count) || 0,
          cacheHitRate: totalInput > 0 ? Number(((cached / totalInput) * 100).toFixed(1)) : 0,
        };
      }
      return {
        group: date,
        totalInput: 0,
        totalInputCached: 0,
        totalInputUncached: 0,
        totalOutput: 0,
        count: 0,
        cacheHitRate: 0,
      };
    });

    // 隐藏前导0：将开头连续的 cacheHitRate === 0 设为 null
    let firstNonZeroIndex = -1;
    for (let i = 0; i < mapped.length; i++) {
      if (mapped[i].cacheHitRate > 0) {
        firstNonZeroIndex = i;
        break;
      }
    }
    if (firstNonZeroIndex > 0) {
      for (let i = 0; i < firstNonZeroIndex; i++) {
        (mapped[i] as Record<string, unknown>).cacheHitRate = null;
      }
    }

    return mapped;
  }, [rawData]);

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
        <ComposedChart
          data={data}
          margin={{ top: 10, right: 50, left: 0, bottom: 0 }}
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
            yAxisId="left"
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => formatAxisNumber(v)}
            domain={[0, (dataMax: number) => {
              if (dataMax === 0) return 100;
              const magnitude = Math.pow(10, Math.floor(Math.log10(dataMax)));
              const normalized = dataMax / magnitude;
              let step: number;
              if (normalized <= 2) step = magnitude / 2;
              else if (normalized <= 5) step = magnitude;
              else step = magnitude * 2;
              return Math.max(step, Math.ceil(dataMax / step) * step);
            }]}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 11, fill: COLORS.hitRate }}
            tickFormatter={(v: number) => `${v}%`}
            domain={[0, 100]}
          />
          <Tooltip
            formatter={(value, name) => {
              if (name === "Cache Hit Rate") {
                if (value === null || value === undefined) return ["—", name];
                return [`${value}%`, name];
              }
              if (value === null || value === undefined) return ["—", name];
              return [formatNumber(Number(value)), name];
            }}
            labelFormatter={(label: string) => `Date: ${label}`}
          />
          <Bar
            yAxisId="left"
            dataKey="totalInputUncached"
            stackId="tokens"
            fill={COLORS.input}
            name="Input"
          />
          <Bar
            yAxisId="left"
            dataKey="totalInputCached"
            stackId="tokens"
            fill={COLORS.cache}
            name="Cache Read"
          />
          <Bar
            yAxisId="left"
            dataKey="totalOutput"
            stackId="tokens"
            fill={COLORS.output}
            name="Output"
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="cacheHitRate"
            stroke={COLORS.hitRate}
            strokeWidth={3}
            dot={{ r: 4, fill: COLORS.hitRate, strokeWidth: 0 }}
            activeDot={{ r: 6, fill: COLORS.hitRate, stroke: "#fff", strokeWidth: 2 }}
            name="Cache Hit Rate"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
