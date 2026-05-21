"use client";

import { useMemo, useRef, useEffect } from "react";
import { useAnimatedNumber } from "@/hooks/useAnimatedNumber";
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
  range: number;
  onRangeChange: (range: number) => void;
}

const COLORS = {
  input: "#3B82F6",
  cache: "#93C5FD",
  output: "#1E40AF",
  hitRate: "#F59E0B",
};

const RANGE_OPTIONS = [3, 7, 14, 30];

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

function getLastNDays(days: number): string[] {
  const result: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    result.push(formatDate(d));
  }
  return result;
}

function SummarySection({
  summary,
}: {
  summary: { totalInput: number; totalOutput: number; totalCacheRead: number; totalRequests: number; cacheHitRate: number };
}) {
  const animatedTotalInput = useAnimatedNumber(summary.totalInput, 600);
  const animatedTotalOutput = useAnimatedNumber(summary.totalOutput, 600);
  const animatedTotalCacheRead = useAnimatedNumber(summary.totalCacheRead, 600);
  const animatedTotalRequests = useAnimatedNumber(summary.totalRequests, 600);

  return (
    <div className="mb-6 p-4 bg-gray-50 rounded-lg">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div>
          <p className="text-xs text-gray-400">Total Input</p>
          <p className="text-lg font-bold text-gray-900">{formatNumber(animatedTotalInput)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Cache Read</p>
          <p className="text-lg font-bold text-gray-900">{formatNumber(animatedTotalCacheRead)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Total Output</p>
          <p className="text-lg font-bold text-gray-900">{formatNumber(animatedTotalOutput)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Total Requests</p>
          <p className="text-lg font-bold text-gray-900">{formatNumber(animatedTotalRequests)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Avg Hit Rate</p>
          <p className="text-lg font-bold" style={{ color: COLORS.hitRate }}>{summary.cacheHitRate}%</p>
        </div>
      </div>
    </div>
  );
}

export default function DailyUsageChart({ rawData, loading, error, range, onRangeChange }: DailyUsageChartProps) {
  const h2Ref = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const el = h2Ref.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      // 注意：不使用 stopPropagation，避免意外阻止事件

      const currentIndex = RANGE_OPTIONS.indexOf(range);
      let newIndex: number;
      if (e.deltaY < 0) {
        newIndex = (currentIndex + 1) % RANGE_OPTIONS.length;
      } else {
        newIndex = (currentIndex - 1 + RANGE_OPTIONS.length) % RANGE_OPTIONS.length;
      }
      onRangeChange(RANGE_OPTIONS[newIndex]);
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [range, onRangeChange]);
  const data = useMemo(() => {
    const apiData = new Map<string, DailyData>();
    rawData.forEach((item) => {
      apiData.set(item.group, item);
    });

    const lastNDays = getLastNDays(range);
    const mapped = lastNDays.map((date) => {
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

    return mapped;
  }, [rawData, range]);

  const summary = useMemo(() => {
    if (data.length === 0) return null;
    const totalInput = data.reduce((s, d) => s + d.totalInput, 0);
    const totalCacheRead = data.reduce((s, d) => s + d.totalInputCached, 0);
    return {
      totalInput,
      totalOutput: data.reduce((s, d) => s + d.totalOutput, 0),
      totalCacheRead,
      totalRequests: data.reduce((s, d) => s + d.count, 0),
      cacheHitRate: totalInput > 0 ? Number(((totalCacheRead / totalInput) * 100).toFixed(1)) : 0,
    };
  }, [data]);

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-8">
      {/* 标题始终渲染，确保 ref 有效 */}
      <h2
        ref={h2Ref}
        className="text-lg font-semibold mb-4 cursor-ns-resize select-none"
      >
        Last {range} Daily Usage
      </h2>

      {loading && (
        <div className="h-[280px] bg-gray-100 rounded animate-pulse" />
      )}

      {error && <p className="text-red-600">Error: {error}</p>}

      {!loading && !error && data.length === 0 && (
        <p className="text-gray-500">No data available</p>
      )}

      {!loading && !error && data.length > 0 && (
        <>
          {summary && (
            <SummarySection summary={summary} />
          )}

          {/* Mobile: compact dual Y-axis with hit rate line */}
          <div className="md:hidden h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={data}
                margin={{ top: 10, right: 10, left: 5, bottom: 10 }}
                barCategoryGap="20%"
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="group"
                  tick={{ fontSize: 10 }}
                  interval="preserveStartEnd"
                  minTickGap={15}
                  tickFormatter={(value: string) => {
                    const parts = value.split("-");
                    return parts.length >= 3 ? `${Number(parts[1])}-${Number(parts[2])}` : value;
                  }}
                />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 10 }}
                  width={35}
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
                  tick={{ fontSize: 10, fill: COLORS.hitRate }}
                  width={30}
                  tickFormatter={(v: number) => `${v}%`}
                  domain={[0, 100]}
                />
                <Tooltip
                  formatter={(value, name) => {
                    if (name === "Cache Hit Ratio") {
                      if (value === null || value === undefined) return ["—", name];
                      return [`${value}%`, name];
                    }
                    if (value === null || value === undefined) return ["—", name];
                    return [formatNumber(Number(value)), name];
                  }}
                  labelFormatter={(label: string) => `Date: ${label}`}
                  itemSorter={(item) => {
                    const order = ["Cache", "UnCache", "Output", "Cache Hit Ratio"];
                    return order.indexOf(String(item.name));
                  }}
                />
                <Bar
                  yAxisId="left"
                  dataKey="totalOutput"
                  stackId="tokens"
                  fill={COLORS.output}
                  name="Output"
                />
                <Bar
                  yAxisId="left"
                  dataKey="totalInputUncached"
                  stackId="tokens"
                  fill={COLORS.input}
                  name="UnCache"
                />
                <Bar
                  yAxisId="left"
                  dataKey="totalInputCached"
                  stackId="tokens"
                  fill={COLORS.cache}
                  name="Cache"
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="cacheHitRate"
                  stroke={COLORS.hitRate}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: COLORS.hitRate, stroke: "#fff", strokeWidth: 1 }}
                  name="Cache Hit Ratio"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Desktop: dual Y-axis with line */}
          <div className="hidden md:block h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={data}
                margin={{ top: 10, right: 50, left: 0, bottom: 0 }}
                barCategoryGap="40%"
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
                    if (name === "Cache Hit Ratio") {
                      return [`${value}%`, name];
                    }
                    if (value === null || value === undefined) return ["—", name];
                    return [formatNumber(Number(value)), name];
                  }}
                  labelFormatter={(label: string) => `Date: ${label}`}
                  itemSorter={(item) => {
                    const order = ["Cache", "UnCache", "Output", "Cache Hit Ratio"];
                    return order.indexOf(String(item.name));
                  }}
                />
                <Bar
                  yAxisId="left"
                  dataKey="totalOutput"
                  stackId="tokens"
                  fill={COLORS.output}
                  name="Output"
                />
                <Bar
                  yAxisId="left"
                  dataKey="totalInputUncached"
                  stackId="tokens"
                  fill={COLORS.input}
                  name="UnCache"
                />
                <Bar
                  yAxisId="left"
                  dataKey="totalInputCached"
                  stackId="tokens"
                  fill={COLORS.cache}
                  name="Cache"
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="cacheHitRate"
                  stroke={COLORS.hitRate}
                  strokeWidth={3}
                  dot={false}
                  activeDot={false}
                  name="Cache Hit Ratio"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
