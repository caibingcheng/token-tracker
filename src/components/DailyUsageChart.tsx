"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { useAnimatedNumber } from "@/hooks/useAnimatedNumber";
import { formatNumber } from "@/lib/number-utils";
import {
  localDateKeyFromUtcDate,
  addDaysLocal,
} from "@/lib/timezone-utils";
import {
  BarChart,
  Bar,
  Cell,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useNumberFormat } from "./NumberFormatContext";

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  return isMobile;
}

export interface DailyData {
  group: string;
  totalInput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalOutput: number;
  totalCacheWrite: number;
  count: number;
  totalCost: number;
  costPerMillionTokens: number;
  costPerMillionInput: number;
  costPerMillionCacheRead: number;
  costPerMillionCacheWrite: number;
  costPerMillionOutput: number;
}

interface TopModel {
  group: string;
  canonicalId: string;
  displayName: string;
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalCacheWrite: number;
  count: number;
  totalCost: number;
  costPerMillionTokens: number;
  costPerMillionInput: number;
  costPerMillionCacheRead: number;
  costPerMillionCacheWrite: number;
  costPerMillionOutput: number;
}

type SortField = 'totalInput' | 'totalInputCached' | 'cacheHitRate' | 'totalOutput' | 'costPerMillionTokens' | 'totalCost' | 'count';

function getMetricValue(m: TopModel, field: SortField): number {
  switch (field) {
    case 'cacheHitRate': return m.totalInput > 0 ? m.totalInputCached / m.totalInput : 0;
    case 'totalInput': return m.totalInput;
    case 'totalInputCached': return m.totalInputCached;
    case 'totalOutput': return m.totalOutput;
    case 'totalCost': return m.totalCost;
    case 'costPerMillionTokens': return m.costPerMillionTokens;
    case 'count': return m.count;
  }
}

function SortHeader({
  field, sortBy, sortOrder, onSort, children, className,
}: {
  field: string;
  sortBy: string;
  sortOrder: 'desc' | 'asc';
  onSort: (field: any) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const isActive = sortBy === field;
  return (
    <th
      className={`${className} px-4 py-3 text-right text-xs font-medium uppercase cursor-pointer select-none transition-colors overflow-hidden ${isActive ? 'text-blue-700' : 'text-gray-500 hover:text-gray-700'}`}
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {isActive && <span>{sortOrder === 'desc' ? '▼' : '▲'}</span>}
      </span>
    </th>
  );
}

function AnimatedCell({ value }: { value: number }) {
  const { compact } = useNumberFormat();
  const animated = useAnimatedNumber(value, 600);
  return <span>{formatNumber(animated, compact)}</span>;
}

interface DailyUsageChartProps {
  rawData: DailyData[];
  loading: boolean;
  error: string | null;
  range: number;
  onRangeChange: (range: number) => void;
  topModels?: TopModel[];
  dailyTopModels?: Record<string, TopModel[]>;
  hourly?: DailyData[];
  timezoneOffsetMinutes?: number;
}

const COLORS = {
  input: "#3B82F6",
  cache: "#93C5FD",
  output: "#1E40AF",
  hitRate: "#F59E0B",
  price: "#10B981",
};

const ACTIVE_AXIS_COLOR = "#2563EB";

const RANGE_OPTIONS = [3, 7, 14, 30];

function formatCost(num: number): string {
  if (num <= 0) return "$0.0000";
  return `$${num.toFixed(4)}`;
}

function formatPriceAxis(num: number): string {
  if (num >= 1) return `$${num.toFixed(1)}`;
  if (num >= 0.01) return `$${num.toFixed(2)}`;
  return `$${num.toFixed(3)}`;
}

function calculatePriceDomain(data: Array<{ costPerMillionTokens: number }>): [number, number] {
  if (!data || data.length === 0) return [0, 1];
  const max = Math.max(...data.map((d) => d.costPerMillionTokens || 0), 0);
  if (!max || max === 0) return [0, 1];
  const headroom = max * 0.2;
  const raw = max + headroom;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  let step: number;
  if (normalized <= 1) step = magnitude / 5;
  else if (normalized <= 2) step = magnitude / 2;
  else if (normalized <= 5) step = magnitude;
  else step = magnitude * 2;
  return [0, Math.max(step, Math.ceil(raw / step) * step)];
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

function formatXAxisDate(value: string): string {
  const parts = value.split("-");
  return parts.length >= 3 ? `${Number(parts[1])}-${Number(parts[2])}` : value;
}

interface CustomXAxisTickProps {
  x?: number;
  y?: number;
  payload?: { value?: string };
  index?: number;
  selectedDate?: string | null;
  hoveredDate?: string | null;
}

function CustomXAxisTick({
  x = 0,
  y = 0,
  payload,
  index = 0,
  selectedDate,
  hoveredDate,
}: CustomXAxisTickProps) {
  const value = payload?.value ?? "";
  const isSelected = value === selectedDate;
  const isHovered = value === hoveredDate;
  const isActive = isSelected || isHovered;
  const showLabel = index !== -1 || isActive;
  return (
    <g transform={`translate(${x},${y})`}>
      {showLabel && (
        <text
          dy={12}
          textAnchor="middle"
          fill={isActive ? ACTIVE_AXIS_COLOR : "#6B7280"}
          fontSize={11}
          fontWeight={isSelected ? 700 : isActive ? 600 : 400}
        >
          {formatXAxisDate(value)}
        </text>
      )}
      {isActive && (
        <polygon
          points={isSelected ? "0,25 -5,32 5,32" : "0,26 -4,31 4,31"}
          fill={ACTIVE_AXIS_COLOR}
        />
      )}
    </g>
  );
}

function formatDate(date: Date, timezoneOffsetMinutes: number): string {
  return localDateKeyFromUtcDate(date, timezoneOffsetMinutes);
}

function getLastNDays(days: number, timezoneOffsetMinutes: number): string[] {
  const result: string[] = [];
  const now = new Date();
  const localNow = new Date(now.getTime() - timezoneOffsetMinutes * 60000);
  const end = new Date(
    Date.UTC(
      localNow.getUTCFullYear(),
      localNow.getUTCMonth(),
      localNow.getUTCDate()
    )
  );
  let current = addDaysLocal(end, -(days - 1), timezoneOffsetMinutes);
  for (let i = 0; i < days; i++) {
    result.push(formatDate(current, timezoneOffsetMinutes));
    current = addDaysLocal(current, 1, timezoneOffsetMinutes);
  }
  return result;
}

function getXAxisInterval(range: number): number {
  if (range <= 7) return 0;
  if (range <= 14) return 1;
  return 4;
}

function HourlyDistributionCard({ hourly, range, timezoneOffsetMinutes }: { hourly?: DailyData[]; range: number; timezoneOffsetMinutes?: number }) {
  const { compact } = useNumberFormat();
  const { buckets, maxAvg } = useMemo(() => {
    const map = new Map<number, number>();
    for (const row of hourly ?? []) {
      const hour = Number(row.group);
      if (Number.isNaN(hour)) continue;
      map.set(hour, (map.get(hour) || 0) + (row.totalInput || 0) + (row.totalOutput || 0));
    }
    const buckets = Array.from({ length: 24 }, (_, i) => {
      const totalTokens = map.get(i) || 0;
      return {
        hour: i,
        totalTokens,
        avgTokens: range > 0 ? totalTokens / range : 0,
      };
    });
    const maxAvg = Math.max(...buckets.map((b) => b.avgTokens), 0);
    return { buckets, maxAvg };
  }, [hourly, range]);

  return (
    <div className="bg-white rounded-lg shadow p-4 flex flex-col">
      <p className="text-xs text-gray-400">
        Hourly Distribution
      </p>
      <div className="flex-1 flex items-end gap-px h-16 mt-2">
        {buckets.map((b) => {
          const heightPct =
            maxAvg > 0 && b.avgTokens > 0
              ? Math.max((b.avgTokens / maxAvg) * 100, 4)
              : 0;
          return (
            <div
              key={b.hour}
              className="flex-1 bg-blue-500 rounded-sm hover:bg-blue-600"
              style={{ height: `${heightPct}%` }}
              title={`${String(b.hour).padStart(2, "0")}:00 · avg ${formatNumber(
                Math.round(b.avgTokens),
                compact
              )} tokens · total ${formatNumber(b.totalTokens, compact)}`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-gray-400 mt-1">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  );
}

function SummarySection({
  summary,
  hourly,
  range,
  timezoneOffsetMinutes,
}: {
  summary: {
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalRequests: number;
    totalCost: number;
    cacheHitRate: number;
    costPerMillionTokens: number;
    costPerMillionInput: number;
    costPerMillionCacheRead: number;
    costPerMillionOutput: number;
  };
  hourly?: DailyData[];
  range: number;
  timezoneOffsetMinutes?: number;
}) {
  const { compact } = useNumberFormat();
  const animatedTotalInput = useAnimatedNumber(summary.totalInput, 600);
  const animatedTotalOutput = useAnimatedNumber(summary.totalOutput, 600);
  const animatedTotalRequests = useAnimatedNumber(summary.totalRequests, 600);
  const animatedCostPerMillion = useAnimatedNumber(summary.costPerMillionTokens, 600);
  const animatedCostPerMillionInput = useAnimatedNumber(summary.costPerMillionInput, 600);
  const animatedCostPerMillionCacheRead = useAnimatedNumber(summary.costPerMillionCacheRead, 600);
  const animatedCostPerMillionOutput = useAnimatedNumber(summary.costPerMillionOutput, 600);

  const inputCached = summary.totalCacheRead;
  const inputUncached = summary.totalInput - summary.totalCacheRead;
  const outputRatio = summary.totalInput + summary.totalOutput > 0
    ? (summary.totalOutput / (summary.totalInput + summary.totalOutput)) * 100
    : 0;
  const avgInputPerReq = summary.totalRequests > 0 ? summary.totalInput / summary.totalRequests : 0;
  const avgOutputPerReq = summary.totalRequests > 0 ? summary.totalOutput / summary.totalRequests : 0;
  const avgCostPerReq = summary.totalRequests > 0 ? summary.totalCost / summary.totalRequests : 0;

  interface CardItem {
    label: string;
    value: number;
    isCost: boolean;
    breakdown?: { label: string; value: number | string; isCost?: boolean }[];
  }

  const cards: CardItem[] = [
    {
      label: "Total Input",
      value: animatedTotalInput,
      isCost: false,
      breakdown: [
        { label: "Cached", value: inputCached },
        { label: "Uncached", value: inputUncached },
        { label: "Hit Rate", value: `${summary.cacheHitRate}%` },
      ],
    },
    {
      label: "Total Output",
      value: animatedTotalOutput,
      isCost: false,
      breakdown: [
        { label: "Of tokens", value: `${outputRatio.toFixed(1)}%` },
      ],
    },
    {
      label: "Total Request",
      value: animatedTotalRequests,
      isCost: false,
      breakdown: [
        { label: "Avg input / req", value: Math.round(avgInputPerReq) },
        { label: "Avg output / req", value: Math.round(avgOutputPerReq) },
        { label: "Avg cost / req", value: avgCostPerReq, isCost: true },
      ],
    },
    {
      label: "Avg cost / 1M tokens",
      value: animatedCostPerMillion,
      isCost: true,
      breakdown: [
        { label: "In", value: animatedCostPerMillionInput, isCost: true },
        { label: "Cache", value: animatedCostPerMillionCacheRead, isCost: true },
        { label: "Out", value: animatedCostPerMillionOutput, isCost: true },
        { label: "Total Cost", value: summary.totalCost, isCost: true },
      ],
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
      {cards.map((card) => (
        <div key={card.label} className="bg-white rounded-lg shadow p-4 flex flex-col">
          <p className="text-xs text-gray-400" title={card.label === "Avg cost / 1M tokens" ? "Pricing from models.dev" : undefined}>
            {card.label}
          </p>
          <p className="text-lg font-bold mt-1">
            {card.isCost ? formatCost(card.value) : formatNumber(card.value, compact)}
          </p>
          {card.breakdown && (
            <div className="mt-2 pt-2 border-t border-gray-100 grid grid-cols-2 gap-2">
              {card.breakdown.map((b) => (
                <div key={b.label} className="min-w-0">
                  <p className="text-[10px] text-gray-400 truncate">{b.label}</p>
                  <p className="text-xs font-medium text-gray-700 break-words">
                    {typeof b.value === 'string' ? b.value : (b.isCost ? formatCost(b.value) : formatNumber(b.value, compact))}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <HourlyDistributionCard hourly={hourly} range={range} timezoneOffsetMinutes={timezoneOffsetMinutes} />
    </div>
  );
}

function TokenBarTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number; name: string }>;
  label?: string;
}) {
  const { compact } = useNumberFormat();
  if (!active || !payload || payload.length === 0) return null;
  const reversed = [...payload].reverse();
  return (
    <div className="bg-white border border-gray-200 rounded-md shadow-sm p-2 text-xs">
      <p className="font-medium text-gray-700 mb-1">{label}</p>
      <div className="space-y-0.5">
        {reversed.map((entry) => (
          <p key={entry.name} className="text-gray-600">
            <span className="font-medium">{entry.name}:</span> {formatNumber(Number(entry.value), compact)}
          </p>
        ))}
      </div>
    </div>
  );
}

function RatioCostTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number; name: string }>;
  label?: string;
}) {
  const { compact } = useNumberFormat();
  if (!active || !payload || payload.length === 0) return null;
  const filtered = payload.filter((entry) => {
    const name = String(entry.name || "");
    return name.trim() !== "" && name !== "dummy";
  });
  if (filtered.length === 0) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-md shadow-sm p-2 text-xs">
      <p className="font-medium text-gray-700 mb-1">{label}</p>
      <div className="space-y-0.5">
        {filtered.map((entry) => {
          const name = String(entry.name);
          let value: string;
          if (name === "Cache Hit Ratio") {
            value = `${entry.value}%`;
          } else if (name === "Avg cost / 1M") {
            value = formatPriceAxis(Number(entry.value));
          } else {
            value = formatNumber(Number(entry.value), compact);
          }
          return (
            <p key={name} className="text-gray-600">
              <span className="font-medium">{name}:</span> {value}
            </p>
          );
        })}
      </div>
    </div>
  );
}

function formatSelectedDateLabel(
  dateStr: string,
  timezoneOffsetMinutes: number
): string {
  const today = formatDate(new Date(), timezoneOffsetMinutes);
  if (dateStr === today) {
    return "Today";
  }
  const parts = dateStr.split("-").map(Number);
  if (parts.length >= 3) {
    const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }
  return dateStr;
}

export default function DailyUsageChart({
  rawData,
  loading,
  error,
  range,
  onRangeChange,
  topModels,
  dailyTopModels,
  hourly,
  timezoneOffsetMinutes = 0,
}: DailyUsageChartProps) {
  const { compact } = useNumberFormat();
  const isMobile = useIsMobile();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [sortBy, setSortBy] = useState<SortField>('totalInput');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const handleSort = useCallback((field: typeof sortBy) => {
    if (field !== sortBy) {
      setSortBy(field);
      setSortOrder('desc');
    } else {
      setSortOrder(o => o === 'desc' ? 'asc' : 'desc');
    }
  }, [sortBy]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        chartRef.current &&
        !chartRef.current.contains(event.target as Node)
      ) {
        setSelectedDate(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleChartMouseMove = useCallback(
    (state: { activeLabel?: string | number }) => {
      if (state && state.activeLabel) {
        setHoveredDate(String(state.activeLabel));
      }
    },
    []
  );

  const handleChartMouseLeave = useCallback(() => {
    setHoveredDate(null);
  }, []);

  const handleChartClick = useCallback(
    (state: { activeLabel?: string | number }) => {
      if (!state || !state.activeLabel) {
        setSelectedDate(null);
        return;
      }
      const date = String(state.activeLabel);
      setSelectedDate((prev) => (prev === date ? null : date));
    },
    []
  );

  const activeTopModels = useMemo(() => {
    const source = selectedDate
      ? (dailyTopModels?.[selectedDate] ?? [])
      : (topModels ?? []);

    return [...source]
      .sort((a, b) => {
        const aVal = getMetricValue(a, sortBy);
        const bVal = getMetricValue(b, sortBy);
        return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
      })
      .slice(0, 5);
  }, [selectedDate, dailyTopModels, topModels, sortBy, sortOrder]);

  const data = useMemo(() => {
    const apiData = new Map<string, DailyData>();
    rawData.forEach((item) => {
      apiData.set(item.group, item);
    });

    const lastNDays = getLastNDays(range, timezoneOffsetMinutes);
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
          totalInput: Number(existing.totalInput) || 0,
          totalOutput: Number(existing.totalOutput) || 0,
          totalCacheWrite: Number(existing.totalCacheWrite) || 0,
          count: Number(existing.count) || 0,
          totalCost: Number(existing.totalCost) || 0,
          costPerMillionTokens: Number(existing.costPerMillionTokens) || 0,
          costPerMillionInput: Number(existing.costPerMillionInput || 0),
          costPerMillionCacheRead: Number(existing.costPerMillionCacheRead || 0),
          costPerMillionCacheWrite: Number(existing.costPerMillionCacheWrite || 0),
          costPerMillionOutput: Number(existing.costPerMillionOutput || 0),
          cacheHitRate: totalInput > 0 ? Number(((cached / totalInput) * 100).toFixed(1)) : 0,
          dummy: 0,
        };
      }
      return {
        group: date,
        totalInput: 0,
        totalInputCached: 0,
        totalInputUncached: 0,
        totalOutput: 0,
        totalCacheWrite: 0,
        count: 0,
        totalCost: 0,
        costPerMillionTokens: 0,
        costPerMillionInput: 0,
        costPerMillionCacheRead: 0,
        costPerMillionCacheWrite: 0,
        costPerMillionOutput: 0,
        cacheHitRate: 0,
        dummy: 0,
      };
    });

    return mapped;
  }, [rawData, range, timezoneOffsetMinutes]);

  const tokenDomain = useMemo(() => {
    const max = Math.max(
      ...data.map((d) => d.totalInputCached + d.totalInputUncached + d.totalOutput),
      0
    );
    if (!max || max === 0) return [0, 100] as [number, number];
    const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
    const normalized = max / magnitude;
    let step: number;
    if (normalized <= 2) step = magnitude / 2;
    else if (normalized <= 5) step = magnitude;
    else step = magnitude * 2;
    return [0, Math.max(step, Math.ceil(max / step) * step)] as [number, number];
  }, [data]);

  const priceDomain = useMemo(() => calculatePriceDomain(data), [data]);

  const summary = useMemo(() => {
    if (data.length === 0) return null;
    const totalInput = data.reduce((s, d) => s + d.totalInput, 0);
    const totalInputUncached = data.reduce((s, d) => s + d.totalInputUncached, 0);
    const totalCacheRead = data.reduce((s, d) => s + d.totalInputCached, 0);
    const totalOutput = data.reduce((s, d) => s + d.totalOutput, 0);
    const totalRequests = data.reduce((s, d) => s + d.count, 0);
    const totalCost = data.reduce((s, d) => s + d.totalCost, 0);
    const totalCacheWrite = data.reduce((s, d) => s + d.totalCacheWrite, 0);
    const effectiveTokens = totalInput + totalCacheWrite + totalOutput;

    const totalInputCost = data.reduce((s, d) => s + d.totalInputUncached * (d.costPerMillionInput / 1_000_000), 0);
    const totalCacheReadCost = data.reduce((s, d) => s + d.totalInputCached * (d.costPerMillionCacheRead / 1_000_000), 0);
    const totalOutputCost = data.reduce((s, d) => s + d.totalOutput * (d.costPerMillionOutput / 1_000_000), 0);

    return {
      totalInput,
      totalOutput,
      totalCacheRead,
      totalRequests,
      totalCost,
      cacheHitRate: totalInput > 0 ? Number(((totalCacheRead / totalInput) * 100).toFixed(1)) : 0,
      costPerMillionTokens: effectiveTokens > 0 ? (totalCost / effectiveTokens) * 1_000_000 : 0,
      costPerMillionInput: totalInputUncached > 0 ? (totalInputCost / totalInputUncached) * 1_000_000 : 0,
      costPerMillionCacheRead: totalCacheRead > 0 ? (totalCacheReadCost / totalCacheRead) * 1_000_000 : 0,
      costPerMillionOutput: totalOutput > 0 ? (totalOutputCost / totalOutput) * 1_000_000 : 0,
    };
  }, [data]);

  return (
    <div ref={chartRef} className="bg-white rounded-lg shadow p-3 md:p-6 mb-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-4 gap-2">
        <h2 className="text-lg font-semibold">Last {range} Daily Usage</h2>
        <div className="inline-flex rounded-md overflow-hidden flex-shrink-0">
          {RANGE_OPTIONS.map((days, index) => (
            <button
              key={days}
              type="button"
              onClick={() => onRangeChange(days)}
              aria-pressed={range === days}
              className={`
                px-2 md:px-3 py-1 text-xs md:text-sm font-medium transition-all active:scale-95
                ${range === days
                  ? "bg-blue-600 text-white md:hover:bg-blue-700"
                  : "bg-gray-100 text-gray-600 md:hover:bg-blue-50 md:hover:text-blue-700"
                }
                ${index !== RANGE_OPTIONS.length - 1 ? "border-r border-gray-200" : ""}
              `}
            >
              {days}d
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="h-[540px] bg-gray-100 rounded animate-pulse" />
      )}

      {error && <p className="text-red-600">Error: {error}</p>}

      {!loading && !error && data.length === 0 && (
        <p className="text-gray-500">No data available</p>
      )}

          {!loading && !error && data.length > 0 && (
        <div>
          {summary && (
            <SummarySection summary={summary} hourly={hourly} range={range} timezoneOffsetMinutes={timezoneOffsetMinutes} />
          )}

          <div className="space-y-6 hidden md:block">
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Daily Token Usage</h3>
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data}
                    margin={{ top: 10, right: 100, left: 55, bottom: 10 }}
                    barCategoryGap="20%"
                    syncId="daily"
                    onClick={handleChartClick}
                    onMouseMove={handleChartMouseMove}
                    onMouseLeave={handleChartMouseLeave}
                    className="cursor-pointer"
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="group"
                      ticks={data.map((d) => d.group)}
                      tick={(props) => {
                        const index = props.index ?? 0;
                        const interval = getXAxisInterval(range);
                        const showLabel = interval === 0 || index % (interval + 1) === 0;
                        return (
                          <CustomXAxisTick
                            {...props}
                            selectedDate={selectedDate}
                            hoveredDate={hoveredDate}
                            index={showLabel ? index : -1}
                          />
                        );
                      }}
                      interval={0}
                      minTickGap={15}
                    />
                    <YAxis
                      yAxisId="left"
                      tick={{ fontSize: 11 }}
                      width={45}
                      tickFormatter={(v: number) => formatAxisNumber(v)}
                      domain={tokenDomain}
                    />
                    <Tooltip content={<TokenBarTooltip />} cursor={false} />
                    <Bar
                      yAxisId="left"
                      dataKey="totalInputCached"
                      stackId="tokens"
                      fill={COLORS.cache}
                      name="Cache"
                    >
                      {data.map((entry, index) => (
                        <Cell
                          key={`cell-cache-${index}`}
                          fill={COLORS.cache}
                        />
                      ))}
                    </Bar>
                    <Bar
                      yAxisId="left"
                      dataKey="totalInputUncached"
                      stackId="tokens"
                      fill={COLORS.input}
                      name="UnCache"
                    >
                      {data.map((entry, index) => (
                        <Cell
                          key={`cell-input-${index}`}
                          fill={COLORS.input}
                        />
                      ))}
                    </Bar>
                    <Bar
                      yAxisId="left"
                      dataKey="totalOutput"
                      stackId="tokens"
                      fill={COLORS.output}
                      name="Output"
                    >
                      {data.map((entry, index) => (
                        <Cell
                          key={`cell-output-${index}`}
                          fill={COLORS.output}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Daily Ratio & Cost</h3>
              <div className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={data}
                    margin={{ top: 10, right: 55, left: 55, bottom: 10 }}
                    syncId="daily"
                    barCategoryGap="20%"
                    onClick={handleChartClick}
                    onMouseMove={handleChartMouseMove}
                    onMouseLeave={handleChartMouseLeave}
                    className="cursor-pointer"
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="group"
                      ticks={data.map((d) => d.group)}
                      tick={(props) => {
                        const index = props.index ?? 0;
                        const interval = getXAxisInterval(range);
                        const showLabel = interval === 0 || index % (interval + 1) === 0;
                        return (
                          <CustomXAxisTick
                            {...props}
                            selectedDate={selectedDate}
                            hoveredDate={hoveredDate}
                            index={showLabel ? index : -1}
                          />
                        );
                      }}
                      interval={0}
                      minTickGap={15}
                    />
                    <YAxis
                      yAxisId="left"
                      tick={{ fontSize: 11, fill: COLORS.hitRate }}
                      width={45}
                      tickFormatter={(v: number) => `${v}%`}
                      domain={[0, 100]}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fontSize: 11, fill: COLORS.price }}
                      width={45}
                      tickFormatter={(v: number) => formatPriceAxis(v)}
                      domain={priceDomain}
                    />
                    <Tooltip content={<RatioCostTooltip />} cursor={false} />
                    <Bar
                      yAxisId="left"
                      dataKey="dummy"
                      fill="transparent"
                      stroke="none"
                      name=""
                      isAnimationActive={false}
                    />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="cacheHitRate"
                      stroke={COLORS.hitRate}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: COLORS.hitRate, stroke: "#fff", strokeWidth: 1 }}
                      name="Cache Hit Ratio"
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="costPerMillionTokens"
                      stroke={COLORS.price}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: COLORS.price, stroke: "#fff", strokeWidth: 1 }}
                      name="Avg cost / 1M"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {isMobile && (
            <div className="md:hidden my-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-center text-sm text-gray-500">
              Charts are available on desktop
            </div>
          )}

          {activeTopModels && activeTopModels.length > 0 && (
            <div className="mt-8">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-1 gap-2">
                <h3 className="text-lg font-semibold">
                  {selectedDate
                    ? `Top 5 Model Families - ${formatSelectedDateLabel(selectedDate, timezoneOffsetMinutes)}`
                    : "Top 5 Model Families"}
                </h3>
                {selectedDate && (
                  <button
                    type="button"
                    onClick={() => setSelectedDate(null)}
                    className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-full transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                    Reset to range total
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500 mb-3">
                {selectedDate
                  ? `Showing top models for ${selectedDate}`
                  : "Click a day in the charts above to see its top models"}
              </p>
              <div className="hidden md:block overflow-x-auto">
                {(() => {
                  return (
                    <table className="w-full" style={{ tableLayout: 'fixed' }}>
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="w-[20%] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase overflow-hidden">Model</th>
                          <SortHeader className="w-[12%]" field="totalInput" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort}>Total Input</SortHeader>
                          <SortHeader className="w-[11%]" field="totalInputCached" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort}>Cache Read</SortHeader>
                          <SortHeader className="w-[12%]" field="cacheHitRate" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort}>Cache Hit Rate</SortHeader>
                          <SortHeader className="w-[11%]" field="totalOutput" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort}>Total Output</SortHeader>
                          <SortHeader className="w-[15%]" field="costPerMillionTokens" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort}>Avg cost / 1M tokens</SortHeader>
                          <SortHeader className="w-[10%]" field="totalCost" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort}>Total Cost</SortHeader>
                          <SortHeader className="w-[9%]" field="count" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort}>Requests</SortHeader>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {activeTopModels.map((model) => {
                          const metricTotal = activeTopModels.reduce((sum, m) => sum + getMetricValue(m, sortBy), 0);
                          const metricVal = getMetricValue(model, sortBy);
                          const percentage = metricTotal > 0 ? (metricVal / metricTotal) * 100 : 0;
                          const cacheHitRate = model.totalInput > 0
                            ? (model.totalInputCached / model.totalInput * 100).toFixed(1) + '%'
                            : '0%';
                          return (
                            <tr
                              key={model.group}
                              style={{
                                background: `linear-gradient(to right, rgb(239 246 255) ${percentage}%, transparent ${percentage}%)`
                              }}
                            >
                              <td className="px-4 py-3 text-sm font-medium text-gray-900 overflow-hidden">{model.displayName}</td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden"><AnimatedCell value={model.totalInput} /></td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden"><AnimatedCell value={model.totalInputCached} /></td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden">{cacheHitRate}</td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden"><AnimatedCell value={model.totalOutput} /></td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden">
                                <div className="flex flex-col items-end">
                                  <span>{formatCost(model.costPerMillionTokens)}</span>
                                </div>
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden">{formatCost(model.totalCost)}</td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden"><AnimatedCell value={model.count} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  );
                })()}
              </div>
              <div className="md:hidden mb-3">
                <select
                  value={sortBy}
                  onChange={(e) => handleSort(e.target.value as typeof sortBy)}
                  className="text-xs border border-gray-200 rounded px-2 py-1.5 bg-white text-gray-700 w-full"
                >
                  <option value="totalInput">Total Input</option>
                  <option value="totalOutput">Total Output</option>
                  <option value="totalInputCached">Cache Read</option>
                  <option value="cacheHitRate">Cache Hit Rate</option>
                  <option value="totalCost">Total Cost</option>
                  <option value="costPerMillionTokens">Avg Cost / 1M</option>
                  <option value="count">Requests</option>
                </select>
              </div>
              <div className="md:hidden space-y-3">
                {(() => {
                  const metricTotal = activeTopModels.reduce((sum, m) => sum + getMetricValue(m, sortBy), 0);
                  return activeTopModels.map((model) => {
                    const metricVal = getMetricValue(model, sortBy);
                    const percentage = metricTotal > 0 ? (metricVal / metricTotal) * 100 : 0;
                    return (
                        <div
                          key={model.group}
                          className="rounded-lg border border-gray-200 overflow-hidden"
                          style={{
                            background: `linear-gradient(to right, rgb(239 246 255) ${percentage}%, transparent ${percentage}%)`
                          }}
                        >
                          <div className="px-4 py-3 font-medium text-gray-900 border-b border-gray-100">
                            {model.displayName}
                          </div>
                          <div className="px-4 py-3 grid grid-cols-2 gap-3">
                            <div>
                              <p className="text-xs text-gray-500">Total Input</p>
                              <p className="text-sm font-semibold text-gray-900">{formatNumber(model.totalInput, compact)}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Cache Read</p>
                              <p className="text-sm font-semibold text-gray-900">{formatNumber(model.totalInputCached, compact)}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Cache Hit Rate</p>
                              <p className="text-sm font-semibold text-gray-900">
                                {model.totalInput > 0 ? (model.totalInputCached / model.totalInput * 100).toFixed(1) + '%' : '0%'}
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Total Output</p>
                              <p className="text-sm font-semibold text-gray-900">{formatNumber(model.totalOutput, compact)}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500" title="Pricing from models.dev">Avg cost / 1M tokens</p>
                              <p className="text-sm font-semibold text-gray-900">{formatCost(model.costPerMillionTokens)}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Total Cost</p>
                              <p className="text-sm font-semibold text-gray-900">{formatCost(model.totalCost)}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Requests</p>
                              <p className="text-sm font-semibold text-gray-900">{formatNumber(model.count, compact)}</p>
                            </div>
                          </div>
                        </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}
          {activeTopModels && activeTopModels.length === 0 && (
            <div className="mt-8">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-1 gap-2">
                <h3 className="text-lg font-semibold">
                  {selectedDate
                    ? `Top 5 Model Families - ${formatSelectedDateLabel(selectedDate, timezoneOffsetMinutes)}`
                    : "Top 5 Model Families"}
                </h3>
                {selectedDate && (
                  <button
                    type="button"
                    onClick={() => setSelectedDate(null)}
                    className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-full transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                    Reset to range total
                  </button>
                )}
              </div>
              <p className="text-gray-500">
                {selectedDate ? "No data for selected date" : "No data available"}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
