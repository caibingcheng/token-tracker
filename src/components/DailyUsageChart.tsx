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
import { formatLatencyMs } from "@/lib/number-utils";

export interface LatencyModelStat {
  model: string;
  displayName: string;
  provider: string;
  providerName: string;
  count: number;
  streamCount: number;
  avgTtftMs: number | null;
  p50TtftMs: number | null;
  avgLatencyMs: number | null;
  outputTokensPerSec: number | null;
}

export interface LatencyDayStat {
  group: string;
  streamCount: number;
  avgTtftMs: number | null;
  p50TtftMs: number | null;
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

export interface ProviderStat {
  provider: string;
  providerName: string;
  totalInput: number;
  totalInputCached: number;
  totalOutput: number;
  totalCost: number;
  count: number;
}

type SortField = 'totalInput' | 'totalInputCached' | 'cacheHitRate' | 'totalOutput' | 'count';

type CostSortField = 'totalCost' | 'costPerMillionTokens' | 'inputCost' | 'cacheCost' | 'outputCost' | 'count' | 'avgCostPerReq';

function getMetricValue(m: TopModel, field: SortField): number {
  switch (field) {
    case 'cacheHitRate': return m.totalInput > 0 ? m.totalInputCached / m.totalInput : 0;
    case 'totalInput': return m.totalInput;
    case 'totalInputCached': return m.totalInputCached;
    case 'totalOutput': return m.totalOutput;
    case 'count': return m.count;
  }
}

function getCostMetricValue(m: TopModel, field: CostSortField): number {
  switch (field) {
    case 'totalCost': return m.totalCost;
    case 'costPerMillionTokens': return m.costPerMillionTokens;
    case 'inputCost': return m.totalInputUncached * (m.costPerMillionInput / 1_000_000);
    case 'cacheCost': return m.totalInputCached * (m.costPerMillionCacheRead / 1_000_000);
    case 'outputCost': return m.totalOutput * (m.costPerMillionOutput / 1_000_000);
    case 'avgCostPerReq': return m.count > 0 ? m.totalCost / m.count : 0;
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
  topModels?: TopModel[];
  dailyTopModels?: Record<string, TopModel[]>;
  topProviders?: ProviderStat[];
  dailyProviders?: Record<string, ProviderStat[]>;
  hourly?: DailyData[];
  latencyDaily?: LatencyDayStat[];
  latencyByModel?: LatencyModelStat[];
  dailyLatencyByModel?: Record<string, LatencyModelStat[]>;
  timezoneOffsetMinutes?: number;
  showCost?: boolean;
  showHourly?: boolean;
  showTopModels?: boolean;
}

const COLORS = {
  input: "#3B82F6",
  cache: "#93C5FD",
  output: "#1E40AF",
  hitRate: "#F59E0B",
  price: "#10B981",
  ttft: "#8B5CF6",
  ttftAvg: "#F43F5E",
};

const ACTIVE_AXIS_COLOR = "#2563EB";

const PROVIDER_COLORS = [
  "#3B82F6",
  "#10B981",
  "#F59E0B",
  "#8B5CF6",
  "#EC4899",
  "#94A3B8",
];

function niceTokenDomain(max: number): [number, number] {
  if (!max || max === 0) return [0, 100] as [number, number];
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const normalized = max / magnitude;
  let step: number;
  if (normalized <= 2) step = magnitude / 2;
  else if (normalized <= 5) step = magnitude;
  else step = magnitude * 2;
  return [0, Math.max(step, Math.ceil(max / step) * step)] as [number, number];
}

function ChartLegend({
  items,
}: {
  items: Array<{ color: string; label: string; dashed?: boolean; bar?: boolean; key?: string }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2">
      {items.map((item) => (
        <span key={item.key ?? item.label} className="inline-flex items-center gap-1.5 text-xs text-gray-500">
          <span
            className={
              item.bar
                ? "inline-block h-2.5 w-2.5 rounded-sm"
                : "inline-block h-0.5 w-4 rounded"
            }
            style={
              item.bar
                ? { backgroundColor: item.color }
                : item.dashed
                  ? {
                      background: `repeating-linear-gradient(90deg, ${item.color} 0 4px, transparent 4px 7px)`,
                    }
                  : { backgroundColor: item.color }
            }
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export const RANGE_OPTIONS = [3, 7, 14, 30];

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
    <div className="col-span-2 sm:col-span-1 bg-white rounded-lg shadow p-4 flex flex-col">
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
  showCost = true,
  showHourly = true,
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
  showCost?: boolean;
  showHourly?: boolean;
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
        ...(showCost
          ? [{ label: "Avg cost / req", value: avgCostPerReq, isCost: true as const }]
          : []),
      ],
    },
    ...(showCost
      ? [{
          label: "Avg cost / 1M tokens",
          value: animatedCostPerMillion,
          isCost: true,
          breakdown: [
            { label: "In", value: animatedCostPerMillionInput, isCost: true },
            { label: "Cache", value: animatedCostPerMillionCacheRead, isCost: true },
            { label: "Out", value: animatedCostPerMillionOutput, isCost: true },
            { label: "Total Cost", value: summary.totalCost, isCost: true },
          ],
        }]
      : []),
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
      {showHourly && (
        <HourlyDistributionCard hourly={hourly} range={range} timezoneOffsetMinutes={timezoneOffsetMinutes} />
      )}
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

function TtftTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{
    name?: string;
    value: number | null;
    payload?: { streamCount?: number };
  }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const filtered = payload.filter((entry) => String(entry.name || "").trim() !== "");
  if (filtered.length === 0) return null;
  const streamCount = filtered[0].payload?.streamCount ?? 0;
  return (
    <div className="bg-white border border-gray-200 rounded-md shadow-sm p-2 text-xs">
      <p className="font-medium text-gray-700 mb-1">{label}</p>
      <div className="space-y-0.5">
        {filtered.map((entry) => (
          <p key={entry.name} className="text-gray-600">
            <span className="font-medium">{entry.name}:</span>{" "}
            {entry.value == null ? "-" : formatLatencyMs(Number(entry.value))}
          </p>
        ))}
        <p className="text-gray-600">
          <span className="font-medium">Streams:</span> {streamCount}
        </p>
      </div>
    </div>
  );
}

function formatTokensPerSec(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${v.toFixed(1)}/s`;
}

function TopProvidersTable({
  providers,
  selectedDate,
}: {
  providers: ProviderStat[];
  selectedDate: string | null;
}) {
  const { compact } = useNumberFormat();
  const totalInputSum = providers.reduce((sum, p) => sum + p.totalInput, 0);

  return (
    <div>
      {providers.length === 0 ? (
        <p className="text-gray-500">
          {selectedDate ? "No data for selected date" : "No data available"}
        </p>
      ) : (
        <>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full" style={{ tableLayout: "fixed" }}>
              <thead className="bg-gray-50">
                <tr>
                  <th className="w-[24%] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase overflow-hidden">Provider</th>
                  <th className="w-[19%] px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase overflow-hidden">Total Input</th>
                  <th className="w-[17%] px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase overflow-hidden">Cache Read</th>
                  <th className="w-[18%] px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase overflow-hidden">Total Output</th>
                  <th className="w-[12%] px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase overflow-hidden">Total Cost</th>
                  <th className="w-[10%] px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase overflow-hidden">Requests</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {providers.map((p) => {
                  const percentage =
                    totalInputSum > 0 ? (p.totalInput / totalInputSum) * 100 : 0;
                  return (
                    <tr
                      key={p.provider}
                      style={{
                        background: `linear-gradient(to right, rgb(239 246 255) ${percentage}%, transparent ${percentage}%)`,
                      }}
                    >
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 overflow-hidden">{p.providerName}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden"><AnimatedCell value={p.totalInput} /></td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden"><AnimatedCell value={p.totalInputCached} /></td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden"><AnimatedCell value={p.totalOutput} /></td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden">{formatCost(p.totalCost)}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden"><AnimatedCell value={p.count} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="md:hidden space-y-3">
            {providers.map((p) => {
              const percentage =
                totalInputSum > 0 ? (p.totalInput / totalInputSum) * 100 : 0;
              return (
                <div
                  key={p.provider}
                  className="rounded-lg border border-gray-200 overflow-hidden"
                  style={{
                    background: `linear-gradient(to right, rgb(239 246 255) ${percentage}%, transparent ${percentage}%)`,
                  }}
                >
                  <div className="px-4 py-3 font-medium text-gray-900 border-b border-gray-100">
                    {p.providerName}
                  </div>
                  <div className="px-4 py-3 grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs text-gray-500">Total Input</p>
                      <p className="text-sm font-semibold text-gray-900">{formatNumber(p.totalInput, compact)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Cache Read</p>
                      <p className="text-sm font-semibold text-gray-900">{formatNumber(p.totalInputCached, compact)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Total Output</p>
                      <p className="text-sm font-semibold text-gray-900">{formatNumber(p.totalOutput, compact)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Total Cost</p>
                      <p className="text-sm font-semibold text-gray-900">{formatCost(p.totalCost)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Requests</p>
                      <p className="text-sm font-semibold text-gray-900">{formatNumber(p.count, compact)}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function SpeedTable({ byModel }: { byModel: LatencyModelStat[] }) {
  return (
    <div>
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">p50 TTFT</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Avg TTFT</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Avg Total</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">tok/s</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {byModel.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-gray-400">
                  No streaming requests in this period
                </td>
              </tr>
            )}
            {byModel.map((m) => (
              <tr key={`${m.provider}\u0000${m.model}`}>
                <td className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">
                  {m.displayName}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                  {m.providerName}
                </td>
                <td className="px-4 py-3 text-sm text-gray-900 text-right whitespace-nowrap">
                  {formatLatencyMs(m.p50TtftMs)}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600 text-right whitespace-nowrap">
                  {formatLatencyMs(m.avgTtftMs)}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600 text-right whitespace-nowrap">
                  {formatLatencyMs(m.avgLatencyMs)}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600 text-right whitespace-nowrap">
                  {formatTokensPerSec(m.outputTokensPerSec)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="md:hidden space-y-3">
        {byModel.length === 0 && (
          <p className="text-center text-sm text-gray-400 py-4">
            No streaming requests in this period
          </p>
        )}
        {byModel.map((m) => (
          <div
            key={`${m.provider}\u0000${m.model}`}
            className="border border-gray-200 rounded-lg p-4"
          >
            <div className="flex justify-between items-start mb-3">
              <div>
                <p className="text-sm font-medium text-gray-900">{m.displayName}</p>
                <p className="text-xs text-gray-400 mt-0.5">{m.providerName}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-gray-500">p50 TTFT</p>
                <p className="text-sm font-semibold text-gray-900">{formatLatencyMs(m.p50TtftMs)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Avg TTFT</p>
                <p className="text-sm font-semibold text-gray-900">{formatLatencyMs(m.avgTtftMs)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Avg Total</p>
                <p className="text-sm font-semibold text-gray-900">{formatLatencyMs(m.avgLatencyMs)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">tok/s</p>
                <p className="text-sm font-semibold text-gray-900">{formatTokensPerSec(m.outputTokensPerSec)}</p>
              </div>
            </div>
          </div>
        ))}
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
  topModels,
  dailyTopModels,
  topProviders,
  dailyProviders,
  hourly,
  latencyDaily,
  latencyByModel,
  dailyLatencyByModel,
  timezoneOffsetMinutes = 0,
  showCost = true,
  showHourly = true,
  showTopModels = true,
}: DailyUsageChartProps) {
  const { compact } = useNumberFormat();
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

  const [costSortBy, setCostSortBy] = useState<CostSortField>('totalCost');
  const [costSortOrder, setCostSortOrder] = useState<'desc' | 'asc'>('desc');
  const handleCostSort = useCallback((field: typeof costSortBy) => {
    if (field !== costSortBy) {
      setCostSortBy(field);
      setCostSortOrder('desc');
    } else {
      setCostSortOrder(o => o === 'desc' ? 'asc' : 'desc');
    }
  }, [costSortBy]);

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

  const sortedCostModels = useMemo(() => {
    return [...activeTopModels]
      .sort((a, b) => {
        const aVal = getCostMetricValue(a, costSortBy);
        const bVal = getCostMetricValue(b, costSortBy);
        return costSortOrder === 'desc' ? bVal - aVal : aVal - bVal;
      });
  }, [activeTopModels, costSortBy, costSortOrder]);

  const activeProviders = useMemo(() => {
    if (selectedDate) {
      const day = dailyProviders?.[selectedDate] ?? [];
      return [...day]
        .sort((a, b) => b.totalInput - a.totalInput)
        .slice(0, 5);
    }
    return topProviders ?? [];
  }, [selectedDate, dailyProviders, topProviders]);

  const providerChartData = useMemo(() => {
    const top5Providers = (topProviders ?? []).slice(0, 5);
    const top5Keys = new Set(top5Providers.map((p) => p.provider));
    const lastNDays = getLastNDays(range, timezoneOffsetMinutes);
    return lastNDays.map((date) => {
      const row: Record<string, number | string> = { group: date };
      const dayProviders = dailyProviders?.[date] ?? [];
      for (const p of dayProviders) {
        if (top5Keys.has(p.provider)) {
          row[p.provider] = (Number(row[p.provider]) || 0) + p.totalInput;
        } else {
          row.others = (Number(row.others) || 0) + p.totalInput;
        }
      }
      return row;
    });
  }, [topProviders, dailyProviders, range, timezoneOffsetMinutes]);

  const providerTokenDomain = useMemo(() => {
    const max = Math.max(
      ...providerChartData.map((d) =>
        Object.entries(d).reduce(
          (sum, [key, value]) =>
            key === "group" ? sum : sum + (Number(value) || 0),
          0
        )
      ),
      0
    );
    return niceTokenDomain(max);
  }, [providerChartData]);

  const hasProviderOthers = useMemo(
    () => providerChartData.some((d) => (Number(d.others) || 0) > 0),
    [providerChartData]
  );

  const modelChartData = useMemo(() => {
    const top5Models = (topModels ?? []).slice(0, 5);
    const keyByGroup = new Map(
      top5Models.map((m, i) => [m.group, `model-${i}`] as const)
    );
    const top5Groups = new Set(keyByGroup.keys());
    const lastNDays = getLastNDays(range, timezoneOffsetMinutes);
    return lastNDays.map((date) => {
      const row: Record<string, number | string> = { group: date };
      const dayModels = dailyTopModels?.[date] ?? [];
      for (const m of dayModels) {
        if (top5Groups.has(m.group)) {
          const key = keyByGroup.get(m.group)!;
          row[key] = (Number(row[key]) || 0) + m.totalInput;
        } else {
          row.others = (Number(row.others) || 0) + m.totalInput;
        }
      }
      return row;
    });
  }, [topModels, dailyTopModels, range, timezoneOffsetMinutes]);

  const modelTokenDomain = useMemo(() => {
    const max = Math.max(
      ...modelChartData.map((d) =>
        Object.entries(d).reduce(
          (sum, [key, value]) =>
            key === "group" ? sum : sum + (Number(value) || 0),
          0
        )
      ),
      0
    );
    return niceTokenDomain(max);
  }, [modelChartData]);

  const hasModelOthers = useMemo(
    () => modelChartData.some((d) => (Number(d.others) || 0) > 0),
    [modelChartData]
  );

  const activeLatencyByModel = useMemo(() => {
    if (selectedDate) {
      return dailyLatencyByModel?.[selectedDate] ?? [];
    }
    return latencyByModel ?? [];
  }, [selectedDate, dailyLatencyByModel, latencyByModel]);

  const data = useMemo(() => {
    const apiData = new Map<string, DailyData>();
    rawData.forEach((item) => {
      apiData.set(item.group, item);
    });

    const latencyMap = new Map<string, LatencyDayStat>();
    (latencyDaily ?? []).forEach((item) => {
      latencyMap.set(item.group, item);
    });

    const lastNDays = getLastNDays(range, timezoneOffsetMinutes);
    const mapped = lastNDays.map((date) => {
      const lat = latencyMap.get(date);
      const latencyFields = {
        p50TtftMs: lat?.p50TtftMs ?? null,
        avgTtftMs: lat?.avgTtftMs ?? null,
        streamCount: lat?.streamCount ?? 0,
      };
      const existing = apiData.get(date);
      if (existing) {
        const cached = Number(existing.totalInputCached) || 0;
        const uncached = Number(existing.totalInputUncached) || 0;
        const totalInput = cached + uncached;
        return {
          ...existing,
          ...latencyFields,
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
        ...latencyFields,
      };
    });

    return mapped;
  }, [rawData, range, timezoneOffsetMinutes, latencyDaily]);

  const tokenDomain = useMemo(() => {
    const max = Math.max(
      ...data.map((d) => d.totalInputCached + d.totalInputUncached + d.totalOutput),
      0
    );
    return niceTokenDomain(max);
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
    <div ref={chartRef} className="space-y-6 mb-8">
      {loading && (
        <div className="h-[540px] bg-gray-100 rounded animate-pulse" />
      )}

      {error && <p className="text-red-600">Error: {error}</p>}

      {!loading && !error && data.length === 0 && (
        <p className="text-gray-500">No data available</p>
      )}

          {!loading && !error && data.length > 0 && (
        <div className="space-y-6">
          {summary && (
            <SummarySection
              summary={summary}
              hourly={hourly}
              range={range}
              timezoneOffsetMinutes={timezoneOffsetMinutes}
              showCost={showCost}
              showHourly={showHourly}
            />
          )}

<div id="trends-token" className="bg-white rounded-lg shadow p-3 md:p-6 scroll-mt-28">
              <h3 className="text-lg font-semibold mb-2">
                {selectedDate
                  ? `Daily Token Usage - ${formatSelectedDateLabel(selectedDate, timezoneOffsetMinutes)}`
                  : "Daily Token Usage"}
              </h3>
              <div className={showTopModels ? 'hidden md:block' : ''}>
                <ChartLegend
                  items={[
                    { color: COLORS.cache, label: "Cache", bar: true },
                    { color: COLORS.input, label: "Uncache", bar: true },
                    { color: COLORS.output, label: "Output", bar: true },
                  ]}
                />
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

              {showTopModels && topProviders && topProviders.length > 0 && (
                <div className="mt-8">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-1 gap-2">
                    <h4 className="text-lg font-semibold">
                      {selectedDate
                        ? `Top 5 Upstreams - ${formatSelectedDateLabel(selectedDate, timezoneOffsetMinutes)}`
                        : "Top 5 Upstreams"}
                    </h4>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">
                    {selectedDate
                      ? `Showing top upstreams for ${selectedDate}`
                      : "Daily usage stacked by upstream provider; providers outside Top 5 merged into Others"}
                  </p>
                  <div className="hidden md:block mb-4">
                    <ChartLegend
                      items={[
                        ...(topProviders ?? []).map((p, i) => ({
                          color: PROVIDER_COLORS[i % PROVIDER_COLORS.length],
                          label: p.providerName,
                          bar: true,
                          key: p.provider,
                        })),
                        ...(hasProviderOthers
                          ? [
                              {
                                color: PROVIDER_COLORS[PROVIDER_COLORS.length - 1],
                                label: "Others",
                                bar: true,
                                key: "others",
                              },
                            ]
                          : []),
                      ]}
                    />
                    <div className="h-[240px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={providerChartData}
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
                            domain={providerTokenDomain}
                          />
                          <Tooltip content={<TokenBarTooltip />} cursor={false} />
                          {(topProviders ?? []).map((p, i) => (
                            <Bar
                              key={p.provider}
                              yAxisId="left"
                              dataKey={p.provider}
                              stackId="providers"
                              fill={PROVIDER_COLORS[i % PROVIDER_COLORS.length]}
                              name={p.providerName}
                            />
                          ))}
                          {hasProviderOthers && (
                            <Bar
                              yAxisId="left"
                              dataKey="others"
                              stackId="providers"
                              fill={PROVIDER_COLORS[PROVIDER_COLORS.length - 1]}
                              name="Others"
                            />
                          )}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <TopProvidersTable providers={activeProviders} selectedDate={selectedDate} />
                </div>
              )}

              {showTopModels && (
                <div className="mt-8">
                  <div className="mb-1">
                    <h4 className="text-lg font-semibold">
                      {selectedDate
                        ? `Top 5 Model Families - ${formatSelectedDateLabel(selectedDate, timezoneOffsetMinutes)}`
                        : "Top 5 Model Families"}
                    </h4>
                  </div>
                  {activeTopModels.length === 0 ? (
                    <p className="text-gray-500">
                      {selectedDate ? "No data for selected date" : "No data available"}
                    </p>
                  ) : (
                    <>
                      <p className="text-xs text-gray-500 mb-3">
                        {selectedDate
                          ? `Showing top models for ${selectedDate}`
                          : "Click a day in the charts above to see its top models"}
                      </p>

                      <div className="hidden md:block mb-4">
                        <ChartLegend
                          items={[
                            ...(topModels ?? []).slice(0, 5).map((m, i) => ({
                              color: PROVIDER_COLORS[i % PROVIDER_COLORS.length],
                              label: m.displayName,
                              bar: true,
                              key: `model-${i}`,
                            })),
                            ...(hasModelOthers
                              ? [
                                  {
                                    color: PROVIDER_COLORS[PROVIDER_COLORS.length - 1],
                                    label: "Others",
                                    bar: true,
                                    key: "others",
                                  },
                                ]
                              : []),
                          ]}
                        />
                        <div className="h-[240px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart
                              data={modelChartData}
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
                                domain={modelTokenDomain}
                              />
                              <Tooltip content={<TokenBarTooltip />} cursor={false} />
                              {(topModels ?? []).slice(0, 5).map((m, i) => (
                                <Bar
                                  key={`model-${i}`}
                                  yAxisId="left"
                                  dataKey={`model-${i}`}
                                  stackId="models"
                                  fill={PROVIDER_COLORS[i % PROVIDER_COLORS.length]}
                                  name={m.displayName}
                                />
                              ))}
                              {hasModelOthers && (
                                <Bar
                                  yAxisId="left"
                                  dataKey="others"
                                  stackId="models"
                                  fill={PROVIDER_COLORS[PROVIDER_COLORS.length - 1]}
                                  name="Others"
                                />
                              )}
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>

                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full" style={{ tableLayout: 'fixed' }}>
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="w-[24%] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase overflow-hidden">Model</th>
                              <SortHeader className="w-[19%]" field="totalInput" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort}>Total Input</SortHeader>
                              <SortHeader className="w-[17%]" field="totalInputCached" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort}>Cache Read</SortHeader>
                              <SortHeader className="w-[16%]" field="cacheHitRate" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort}>Cache Hit Rate</SortHeader>
                              <SortHeader className="w-[15%]" field="totalOutput" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort}>Total Output</SortHeader>
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
                                  <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden"><AnimatedCell value={model.count} /></td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
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
                                    <p className="text-xs text-gray-500">Requests</p>
                                    <p className="text-sm font-semibold text-gray-900">{formatNumber(model.count, compact)}</p>
                                  </div>
                                </div>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

          {showCost && (
              <div id="trends-cost" className="bg-white rounded-lg shadow p-3 md:p-6 scroll-mt-28">
                <h3 className="text-lg font-semibold mb-2">
                  {selectedDate
                    ? `Daily Ratio & Cost - ${formatSelectedDateLabel(selectedDate, timezoneOffsetMinutes)}`
                    : "Daily Ratio & Cost"}
                </h3>
                <div className="hidden md:block">
                  <ChartLegend
                    items={[
                      { color: COLORS.hitRate, label: "Cache Hit Ratio" },
                      { color: COLORS.price, label: "Avg cost / 1M" },
                    ]}
                  />
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

                <div className="mt-8">
                  <h4 className="text-lg font-semibold mb-2">
                    {selectedDate
                      ? `Cost by Model - ${formatSelectedDateLabel(selectedDate, timezoneOffsetMinutes)}`
                      : "Cost by Model"}
                  </h4>
                  {activeTopModels.length === 0 ? (
                    <p className="text-gray-500">
                      {selectedDate ? "No data for selected date" : "No data available"}
                    </p>
                  ) : (
                    <>
                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full" style={{ tableLayout: 'fixed' }}>
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="w-[20%] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase overflow-hidden">Model</th>
                              <SortHeader className="w-[12%]" field="totalCost" sortBy={costSortBy} sortOrder={costSortOrder} onSort={handleCostSort}>Total Cost</SortHeader>
                              <SortHeader className="w-[12%]" field="costPerMillionTokens" sortBy={costSortBy} sortOrder={costSortOrder} onSort={handleCostSort}>Avg cost / 1M</SortHeader>
                              <SortHeader className="w-[12%]" field="inputCost" sortBy={costSortBy} sortOrder={costSortOrder} onSort={handleCostSort}>Input Cost</SortHeader>
                              <SortHeader className="w-[12%]" field="cacheCost" sortBy={costSortBy} sortOrder={costSortOrder} onSort={handleCostSort}>Cache Cost</SortHeader>
                              <SortHeader className="w-[12%]" field="outputCost" sortBy={costSortBy} sortOrder={costSortOrder} onSort={handleCostSort}>Output Cost</SortHeader>
                              <SortHeader className="w-[10%]" field="count" sortBy={costSortBy} sortOrder={costSortOrder} onSort={handleCostSort}>Requests</SortHeader>
                              <SortHeader className="w-[10%]" field="avgCostPerReq" sortBy={costSortBy} sortOrder={costSortOrder} onSort={handleCostSort}>Avg cost / req</SortHeader>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-200">
                            {sortedCostModels.map((model) => {
                              const metricTotal = sortedCostModels.reduce((sum, m) => sum + getCostMetricValue(m, costSortBy), 0);
                              const metricVal = getCostMetricValue(model, costSortBy);
                              const percentage = metricTotal > 0 ? (metricVal / metricTotal) * 100 : 0;
                              const inputCost = model.totalInputUncached * (model.costPerMillionInput / 1_000_000);
                              const cacheCost = model.totalInputCached * (model.costPerMillionCacheRead / 1_000_000);
                              const outputCost = model.totalOutput * (model.costPerMillionOutput / 1_000_000);
                              const avgCostPerReq = model.count > 0 ? model.totalCost / model.count : 0;
                              return (
                                <tr
                                  key={`cost-${model.group}`}
                                  style={{
                                    background: `linear-gradient(to right, rgb(239 246 255) ${percentage}%, transparent ${percentage}%)`
                                  }}
                                >
                                  <td className="px-4 py-3 text-sm font-medium text-gray-900 overflow-hidden">{model.displayName}</td>
                                  <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden">{formatCost(model.totalCost)}</td>
                                  <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden">{formatCost(model.costPerMillionTokens)}</td>
                                  <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden">{formatCost(inputCost)}</td>
                                  <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden">{formatCost(cacheCost)}</td>
                                  <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden">{formatCost(outputCost)}</td>
                                  <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden"><AnimatedCell value={model.count} /></td>
                                  <td className="px-4 py-3 text-sm text-gray-600 text-right overflow-hidden">{formatCost(avgCostPerReq)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="md:hidden mb-3">
                        <select
                          value={costSortBy}
                          onChange={(e) => handleCostSort(e.target.value as typeof costSortBy)}
                          className="text-xs border border-gray-200 rounded px-2 py-1.5 bg-white text-gray-700 w-full"
                        >
                          <option value="totalCost">Total Cost</option>
                          <option value="costPerMillionTokens">Avg Cost / 1M</option>
                          <option value="inputCost">Input Cost</option>
                          <option value="cacheCost">Cache Cost</option>
                          <option value="outputCost">Output Cost</option>
                          <option value="count">Requests</option>
                          <option value="avgCostPerReq">Avg Cost / Req</option>
                        </select>
                      </div>
                      <div className="md:hidden space-y-3">
                        {(() => {
                          const metricTotal = sortedCostModels.reduce((sum, m) => sum + getCostMetricValue(m, costSortBy), 0);
                          return sortedCostModels.map((model) => {
                            const metricVal = getCostMetricValue(model, costSortBy);
                            const percentage = metricTotal > 0 ? (metricVal / metricTotal) * 100 : 0;
                            const inputCost = model.totalInputUncached * (model.costPerMillionInput / 1_000_000);
                            const cacheCost = model.totalInputCached * (model.costPerMillionCacheRead / 1_000_000);
                            const outputCost = model.totalOutput * (model.costPerMillionOutput / 1_000_000);
                            const avgCostPerReq = model.count > 0 ? model.totalCost / model.count : 0;
                            return (
                              <div
                                key={`cost-${model.group}`}
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
                                    <p className="text-xs text-gray-500">Total Cost</p>
                                    <p className="text-sm font-semibold text-gray-900">{formatCost(model.totalCost)}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-500">Avg cost / 1M</p>
                                    <p className="text-sm font-semibold text-gray-900">{formatCost(model.costPerMillionTokens)}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-500">Input Cost</p>
                                    <p className="text-sm font-semibold text-gray-900">{formatCost(inputCost)}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-500">Cache Cost</p>
                                    <p className="text-sm font-semibold text-gray-900">{formatCost(cacheCost)}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-500">Output Cost</p>
                                    <p className="text-sm font-semibold text-gray-900">{formatCost(outputCost)}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-500">Requests</p>
                                    <p className="text-sm font-semibold text-gray-900">{formatNumber(model.count, compact)}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-500">Avg cost / req</p>
                                    <p className="text-sm font-semibold text-gray-900">{formatCost(avgCostPerReq)}</p>
                                  </div>
                                </div>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

          {(data.some((d) => d.streamCount > 0) || latencyByModel) && (
            <div id="trends-latency" className="bg-white rounded-lg shadow p-3 md:p-6 scroll-mt-28">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-semibold">
                  {selectedDate
                    ? `Latency - ${formatSelectedDateLabel(selectedDate, timezoneOffsetMinutes)}`
                    : "Latency"}
                </h3>
                <span
                  className="text-xs text-gray-400 cursor-help"
                  title="TTFT = 流式请求首个 chunk 到达耗时（首 token 延迟）；Latency = 整请求耗时；tok/s = 流式生成速度（不含首 token 等待）。TTFT 仅流式请求有值，Streams 列展示其样本量。"
                >
                  ?
                </span>
              </div>
              {data.some((d) => d.streamCount > 0) && (
                <div className="hidden md:block">
                  <p className="text-xs text-gray-400">Daily TTFT (p50 / avg)</p>
                  <ChartLegend
                    items={[
                      { color: COLORS.ttft, label: "p50 TTFT" },
                      { color: COLORS.ttftAvg, label: "Avg TTFT", dashed: true },
                    ]}
                  />
                  <div className="h-[200px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart
                        data={data}
                        margin={{ top: 10, right: 100, left: 55, bottom: 10 }}
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
                          tick={{ fontSize: 11, fill: COLORS.ttft }}
                          width={45}
                          tickFormatter={(v: number) => formatLatencyMs(v)}
                          domain={[0, "auto"]}
                        />
                        <Tooltip content={<TtftTooltip />} cursor={false} />
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
                          dataKey="p50TtftMs"
                          stroke={COLORS.ttft}
                          strokeWidth={2}
                          dot={{ r: 2.5, fill: COLORS.ttft, strokeWidth: 0 }}
                          activeDot={{ r: 4, fill: COLORS.ttft, stroke: "#fff", strokeWidth: 1 }}
                          name="p50 TTFT"
                          connectNulls={false}
                        />
                        <Line
                          yAxisId="left"
                          type="monotone"
                          dataKey="avgTtftMs"
                          stroke={COLORS.ttftAvg}
                          strokeWidth={2}
                          strokeDasharray="5 3"
                          dot={{ r: 2.5, fill: COLORS.ttftAvg, strokeWidth: 0 }}
                          activeDot={{ r: 4, fill: COLORS.ttftAvg, stroke: "#fff", strokeWidth: 1 }}
                          name="Avg TTFT"
                          connectNulls={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
              {latencyByModel && (
                <div className={data.some((d) => d.streamCount > 0) ? "mt-8" : ""}>
                  <SpeedTable byModel={activeLatencyByModel} />
                </div>
              )}
            </div>
          )}

          </div>
      )}
    </div>
  );
}
