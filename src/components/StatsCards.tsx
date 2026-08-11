"use client";

import { useAnimatedNumber } from "@/hooks/useAnimatedNumber";
import { formatNumber } from "@/lib/number-utils";
import TopModelsCards from "./TopModelsCards";
import { useNumberFormat } from "./NumberFormatContext";

export interface Stats {
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

interface TopModel {
  displayName: string;
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalCost: number;
}

interface StatsCardsProps {
  stats: Stats | null;
  totalDays?: number;
  loading: boolean;
  error: string | null;
  topModels?: TopModel[];
  showCost?: boolean;
  showTopModels?: boolean;
}

function formatCost(num: number): string {
  if (num <= 0) return "$0.0000";
  return `$${num.toFixed(4)}`;
}

function formatRatio(num: number): string {
  return `${num.toFixed(1)}%`;
}

interface BreakdownItem {
  label: string;
  value: number;
  isCost?: boolean;
  isRatio?: boolean;
}

interface CardValue {
  label: string;
  value: number;
  isCost: boolean;
  breakdown?: BreakdownItem[];
}

function formatValue(num: number, isCost: boolean, isRatio?: boolean, compact?: boolean): string {
  if (isRatio) return formatRatio(num);
  return isCost ? formatCost(num) : formatNumber(num, compact ?? false);
}

export default function StatsCards({ stats, totalDays = 0, loading, error, topModels, showCost = true, showTopModels = true }: StatsCardsProps) {
  const { compact } = useNumberFormat();
  const animatedTotalInput = useAnimatedNumber(stats?.totalInput || 0, 600);
  const animatedTotalOutput = useAnimatedNumber(stats?.totalOutput || 0, 600);
  const animatedTotalInputCached = useAnimatedNumber(stats?.totalInputCached || 0, 600);
  const animatedTotalInputUncached = useAnimatedNumber(stats?.totalInputUncached || 0, 600);
  const animatedCount = useAnimatedNumber(stats?.count || 0, 600);
  const animatedCostPerMillion = useAnimatedNumber(stats?.costPerMillionTokens || 0, 600);

  const outputRatio =
    stats && stats.totalInput + stats.totalOutput > 0
      ? (stats.totalOutput / (stats.totalInput + stats.totalOutput)) * 100
      : 0;

  const avgInputPerReq = stats && stats.count > 0 ? stats.totalInput / stats.count : 0;
  const avgOutputPerReq = stats && stats.count > 0 ? stats.totalOutput / stats.count : 0;
  const avgCostPerReq = stats && stats.count > 0 ? stats.totalCost / stats.count : 0;

  const cacheHitRate =
    stats && stats.totalInput > 0
      ? (stats.totalInputCached / stats.totalInput) * 100
      : 0;

  const cardValues: CardValue[] = [
    {
      label: "Total Input",
      value: animatedTotalInput,
      isCost: false,
      breakdown: [
        { label: "Cached", value: animatedTotalInputCached },
        { label: "Uncached", value: animatedTotalInputUncached },
        { label: "Hit Rate", value: cacheHitRate, isRatio: true },
      ],
    },
    {
      label: "Total Output",
      value: animatedTotalOutput,
      isCost: false,
      breakdown: [
        { label: "Of tokens", value: outputRatio, isRatio: true },
      ],
    },
    {
      label: "Total Requests",
      value: animatedCount,
      isCost: false,
      breakdown: [
        { label: "Avg input / req", value: Math.round(avgInputPerReq), isCost: false },
        { label: "Avg output / req", value: Math.round(avgOutputPerReq), isCost: false },
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
            { label: "Input / 1M", value: stats?.costPerMillionInput || 0, isCost: true },
            { label: "Cache read / 1M", value: stats?.costPerMillionCacheRead || 0, isCost: true },
            { label: "Output / 1M", value: stats?.costPerMillionOutput || 0, isCost: true },
            { label: "Total Cost", value: stats?.totalCost || 0, isCost: true },
          ],
        }]
      : []),
  ];

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mb-8 animate-pulse">
        <div className="h-6 bg-gray-200 rounded w-40 mb-4"></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-gray-50 rounded-lg p-4 md:p-6">
              <div className="h-4 bg-gray-200 rounded w-20 mb-2"></div>
              <div className="h-8 bg-gray-200 rounded w-24"></div>
            </div>
          ))}
        </div>
        {showTopModels && <TopModelsCards title="Top 5 Models" models={[]} loading />}
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-8">
        <p className="text-red-600">Error loading stats: {error}</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-8">
      <h2 className="text-lg font-semibold mb-4">
        Total Summary ({totalDays} Day{totalDays !== 1 ? "s" : ""})
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cardValues.map((card) => (
          <div key={card.label} className="bg-gray-50 rounded-lg p-4 md:p-6 flex flex-col">
            <h3 className="text-sm font-medium text-gray-500" title={card.label === "Avg cost / 1M tokens" ? "Pricing from models.dev" : undefined}>
              {card.label}
            </h3>
            <p className="text-xl md:text-2xl font-bold mt-2">
              {card.isCost ? formatCost(card.value) : formatNumber(card.value, compact)}
            </p>
            {card.breakdown && (
              <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-2 gap-2">
                {card.breakdown.map((item) => (
                  <div key={item.label} className="min-w-0">
                    <p className="text-xs text-gray-400 truncate">{item.label}</p>
                    <p className="text-sm font-semibold text-gray-700 break-words">{formatValue(item.value, item.isCost ?? false, item.isRatio, compact)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {showTopModels && (
        <TopModelsCards title="Top 5 Models" models={topModels ?? []} loading={loading} />
      )}
    </div>
  );
}
