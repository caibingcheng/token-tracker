"use client";

import { useMemo } from "react";
import { useAnimatedNumber } from "@/hooks/useAnimatedNumber";
import {
  BarChart,
  Bar,
  ComposedChart,
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

function AnimatedCell({ value }: { value: number }) {
  const animated = useAnimatedNumber(value, 600);
  return <span>{new Intl.NumberFormat("en-US").format(Math.round(animated))}</span>;
}

interface DailyUsageChartProps {
  rawData: DailyData[];
  loading: boolean;
  error: string | null;
  range: number;
  onRangeChange: (range: number) => void;
  topModels?: TopModel[];
}

const COLORS = {
  input: "#3B82F6",
  cache: "#93C5FD",
  output: "#1E40AF",
  hitRate: "#F59E0B",
  price: "#10B981",
};

const RANGE_OPTIONS = [3, 7, 14, 30];

function formatNumber(num: number) {
  return new Intl.NumberFormat("en-US").format(num);
}

function formatCost(num: number): string {
  if (num <= 0) return "$0.00";
  return `$${num.toFixed(2)}`;
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

function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getLastNDays(days: number): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    result.push(formatDate(d));
  }
  return result;
}

function getXAxisInterval(range: number): number {
  if (range <= 7) return 0;
  if (range <= 14) return 1;
  return 4;
}

function SummarySection({
  summary,
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
}) {
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
      ],
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {cards.map((card) => (
        <div key={card.label} className="bg-white rounded-lg shadow p-4 flex flex-col">
          <p className="text-xs text-gray-400" title={card.label === "Avg cost / 1M tokens" ? "Pricing from models.dev" : undefined}>
            {card.label}
          </p>
          <p className="text-lg font-bold mt-1">
            {card.isCost ? formatCost(card.value) : formatNumber(card.value)}
          </p>
          {card.breakdown && (
            <div className="mt-2 pt-2 border-t border-gray-100 grid grid-cols-2 gap-2">
              {card.breakdown.map((b) => (
                <div key={b.label} className="min-w-0">
                  <p className="text-[10px] text-gray-400 truncate">{b.label}</p>
                  <p className="text-xs font-medium text-gray-700 break-words">
                    {typeof b.value === 'string' ? b.value : (b.isCost ? formatCost(b.value) : formatNumber(b.value))}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TokenBarTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number; name: string }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const reversed = [...payload].reverse();
  return (
    <div className="bg-white border border-gray-200 rounded-md shadow-sm p-2 text-xs">
      <p className="font-medium text-gray-700 mb-1">{label}</p>
      <div className="space-y-0.5">
        {reversed.map((entry) => (
          <p key={entry.name} className="text-gray-600">
            <span className="font-medium">{entry.name}:</span> {formatNumber(Number(entry.value))}
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
            value = formatNumber(Number(entry.value));
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

export default function DailyUsageChart({ rawData, loading, error, range, onRangeChange, topModels }: DailyUsageChartProps) {
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
  }, [rawData, range]);

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
    <div className="bg-white rounded-lg shadow p-6 mb-8">
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
            <SummarySection summary={summary} />
          )}

          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Daily Token Usage</h3>
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data}
                    margin={{ top: 10, right: 100, left: 55, bottom: 10 }}
                    barCategoryGap="20%"
                    syncId="daily"
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="group"
                      tick={{ fontSize: 11 }}
                      interval={getXAxisInterval(range)}
                      minTickGap={15}
                      tickFormatter={(value: string) => {
                        const parts = value.split("-");
                        return parts.length >= 3 ? `${Number(parts[1])}-${Number(parts[2])}` : value;
                      }}
                    />
                    <YAxis
                      yAxisId="left"
                      tick={{ fontSize: 11 }}
                      width={45}
                      tickFormatter={(v: number) => formatAxisNumber(v)}
                      domain={tokenDomain}
                    />
                    <Tooltip content={<TokenBarTooltip />} />
                    <Bar
                      yAxisId="left"
                      dataKey="totalInputCached"
                      stackId="tokens"
                      fill={COLORS.cache}
                      name="Cache"
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
                      dataKey="totalOutput"
                      stackId="tokens"
                      fill={COLORS.output}
                      name="Output"
                    />
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
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="group"
                      tick={{ fontSize: 11 }}
                      interval={getXAxisInterval(range)}
                      minTickGap={15}
                      tickFormatter={(value: string) => {
                        const parts = value.split("-");
                        return parts.length >= 3 ? `${Number(parts[1])}-${Number(parts[2])}` : value;
                      }}
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
                    <Tooltip content={<RatioCostTooltip />} />
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
          {topModels && topModels.length > 0 && (
            <div className="mt-8">
              <h3 className="text-lg font-semibold mb-1">Top 5 Model Families</h3>
              <div className="hidden md:block overflow-x-auto">
                {(() => {
                  const totalAllTokens = topModels.reduce((sum, m) => sum + m.totalInput + m.totalOutput, 0);
                  return (
                    <table className="w-full">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total Input</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cache Read</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cache Hit Rate</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total Output</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase" title="Pricing from models.dev">Avg cost / 1M tokens</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Requests</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {topModels.map((model) => {
                          const allTokens = model.totalInput + model.totalOutput;
                          const percentage = totalAllTokens > 0 ? (allTokens / totalAllTokens) * 100 : 0;
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
                              <td className="px-4 py-3 text-sm font-medium text-gray-900">{model.displayName}</td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right"><AnimatedCell value={model.totalInput} /></td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right"><AnimatedCell value={model.totalInputCached} /></td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right">{cacheHitRate}</td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right"><AnimatedCell value={model.totalOutput} /></td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right">
                                <div className="flex flex-col items-end">
                                  <span>{formatCost(model.costPerMillionTokens)}</span>
                                </div>
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right"><AnimatedCell value={model.count} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  );
                })()}
              </div>
              <div className="md:hidden space-y-3">
                {(() => {
                  const totalAllTokens = topModels.reduce((sum, m) => sum + m.totalInput + m.totalOutput, 0);
                  return topModels.map((model) => {
                    const allTokens = model.totalInput + model.totalOutput;
                    const percentage = totalAllTokens > 0 ? (allTokens / totalAllTokens) * 100 : 0;
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
                              <p className="text-sm font-semibold text-gray-900">{formatNumber(model.totalInput)}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Cache Read</p>
                              <p className="text-sm font-semibold text-gray-900">{formatNumber(model.totalInputCached)}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Cache Hit Rate</p>
                              <p className="text-sm font-semibold text-gray-900">
                                {model.totalInput > 0 ? (model.totalInputCached / model.totalInput * 100).toFixed(1) + '%' : '0%'}
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Total Output</p>
                              <p className="text-sm font-semibold text-gray-900">{formatNumber(model.totalOutput)}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500" title="Pricing from models.dev">Avg cost / 1M tokens</p>
                              <p className="text-sm font-semibold text-gray-900">{formatCost(model.costPerMillionTokens)}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Requests</p>
                              <p className="text-sm font-semibold text-gray-900">{formatNumber(model.count)}</p>
                            </div>
                          </div>
                        </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}
          {topModels && topModels.length === 0 && (
            <div className="mt-8">
              <h3 className="text-lg font-semibold mb-1">Top 5 Model Families</h3>
              <p className="text-gray-500">No data available</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
