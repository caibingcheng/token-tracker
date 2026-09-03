"use client";

import { formatNumber } from "@/lib/number-utils";
import type { Stats } from "./StatsCards";
import type { TodayData } from "./TodayOverview";

interface MobileSummaryProps {
  stats: Stats | null;
  today: TodayData | null;
  loading: boolean;
  error: string | null;
}

export default function MobileSummary({
  stats,
  today,
  loading,
  error,
}: MobileSummaryProps) {
  const hasData = Boolean(today || stats);

  if (!hasData) {
    if (loading) {
      return (
        <div className="flex animate-pulse flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-2">
            <div className="h-3 w-10 rounded bg-gray-200" />
            <div className="h-12 w-32 rounded bg-gray-200" />
          </div>
          <div className="h-3 w-24 rounded bg-gray-200" />
        </div>
      );
    }
    if (error) {
      return <p className="text-sm text-gray-400">{error}</p>;
    }
    return null;
  }

  const todayTotal =
    (today?.totalInput ?? 0) + (today?.totalOutput ?? 0);
  const total = (stats?.totalInput ?? 0) + (stats?.totalOutput ?? 0);

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-2">
        <p className="text-sm text-gray-400">Today</p>
        <p className="text-5xl font-bold tabular-nums text-gray-900">
          {formatNumber(todayTotal, true)}
        </p>
      </div>
      <div className="flex flex-col items-center gap-1">
        <p className="text-xs text-gray-400">Total</p>
        <p className="text-sm tabular-nums text-gray-600">
          {formatNumber(total, true)}
        </p>
      </div>
    </div>
  );
}