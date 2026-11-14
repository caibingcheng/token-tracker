"use client";

import { formatNumber } from "@/lib/number-utils";
import { useNumberFormat } from "./NumberFormatContext";
import type { Stats } from "./StatsCards";
import type { TodayData } from "./TodayOverview";

export interface MobileTopModel {
  displayName: string;
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalCost: number;
}

interface MobileSummaryProps {
  stats: Stats | null;
  today: TodayData | null;
  todayTopModels?: MobileTopModel[];
  loading: boolean;
  error: string | null;
}

function formatCost(num: number): string {
  if (num <= 0) return "$0.0000";
  return `$${num.toFixed(4)}`;
}

function formatRatio(num: number): string {
  return `${num.toFixed(1)}%`;
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <p className="text-xs text-gray-400">{label}</p>
      <p className="mt-1 text-lg font-bold tabular-nums text-gray-900">{value}</p>
    </div>
  );
}

export default function MobileSummary({
  stats,
  today,
  todayTopModels,
  loading,
  error,
}: MobileSummaryProps) {
  const { compact } = useNumberFormat();
  const hasData = Boolean(today || stats);

  if (!hasData) {
    if (loading) {
      return (
        <div className="flex animate-pulse flex-col gap-4">
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <div className="mx-auto h-3 w-10 rounded bg-gray-200" />
            <div className="mx-auto mt-3 h-10 w-32 rounded bg-gray-200" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="rounded-xl bg-white p-4 shadow-sm">
                <div className="h-3 w-16 rounded bg-gray-200" />
                <div className="mt-2 h-5 w-20 rounded bg-gray-200" />
              </div>
            ))}
          </div>
        </div>
      );
    }
    if (error) {
      return <p className="text-sm text-gray-400">{error}</p>;
    }
    return null;
  }

  const todayTotal = (today?.totalInput ?? 0) + (today?.totalOutput ?? 0);
  const total = (stats?.totalInput ?? 0) + (stats?.totalOutput ?? 0);
  const cacheHitRate =
    today && today.totalInput > 0
      ? (today.totalInputCached / today.totalInput) * 100
      : 0;

  const models = todayTopModels ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-white p-5 text-center shadow-sm">
        <p className="text-sm text-gray-400">Today</p>
        <p className="mt-1 text-4xl font-bold tabular-nums text-gray-900">
          {formatNumber(todayTotal, compact)}
        </p>
        <p className="mt-1 text-xs text-gray-400 tabular-nums">
          {formatNumber(today?.count ?? 0, compact)} requests
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Hit Rate Today" value={formatRatio(cacheHitRate)} />
        <StatTile label="Cost Today" value={formatCost(today?.totalCost ?? 0)} />
        <StatTile label="Total Cost" value={formatCost(stats?.totalCost ?? 0)} />
        <StatTile label="Total Tokens" value={formatNumber(total, compact)} />
      </div>

      <section className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-700">
          Today Top 5 Models
        </h2>
        {models.length === 0 ? (
          <p className="mt-3 text-sm text-gray-400">No model data</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {models.map((model, index) => {
              const hitRate =
                model.totalInput > 0
                  ? (model.totalInputCached / model.totalInput) * 100
                  : 0;
              return (
                <li
                  key={`${model.displayName}-${index}`}
                  className="rounded-lg bg-gray-50 p-3"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="flex min-w-0 items-baseline gap-2">
                      <span className="text-xs font-semibold text-gray-400">
                        #{index + 1}
                      </span>
                      <span
                        className="truncate text-sm font-medium text-gray-900"
                        title={model.displayName}
                      >
                        {model.displayName}
                      </span>
                    </p>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-gray-900">
                      {formatCost(model.totalCost)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs tabular-nums text-gray-500">
                    in {formatNumber(model.totalInput, compact)} · out{" "}
                    {formatNumber(model.totalOutput, compact)} · hit{" "}
                    {formatRatio(hitRate)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
