"use client";

import { useAnimatedNumber } from "@/hooks/useAnimatedNumber";

export interface TodayData {
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalCacheWrite: number;
  count: number;
}

interface TodayOverviewProps {
  today: TodayData | null;
  yesterday: TodayData | null;
  loading: boolean;
}

function formatNumber(num: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(num));
}

function ChangeBadge({ today, yesterday }: { today: number; yesterday: number }) {
  if (yesterday === 0) {
    return today > 0 ? (
      <span className="text-xs text-green-600 font-medium">↑ New</span>
    ) : (
      <span className="text-xs text-gray-400 font-medium">—</span>
    );
  }
  const change = ((today - yesterday) / yesterday) * 100;
  const isUp = change >= 0;
  return (
    <span className={`text-xs font-medium ${isUp ? "text-green-600" : "text-red-600"}`}>
      {isUp ? "↑" : "↓"} {Math.abs(change).toFixed(1)}%
    </span>
  );
}

export default function TodayOverview({ today, yesterday, loading }: TodayOverviewProps) {
  const animatedInput = useAnimatedNumber(today?.totalInput || 0, 600);
  const animatedOutput = useAnimatedNumber(today?.totalOutput || 0, 600);
  const animatedCount = useAnimatedNumber(today?.count || 0, 600);
  const animatedCacheWrite = useAnimatedNumber(today?.totalCacheWrite || 0, 600);

  const todayDate = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mb-8 border-l-4 border-blue-500 animate-pulse">
        <div className="h-6 bg-gray-200 rounded w-32 mb-4"></div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-gray-50 rounded-lg p-4">
              <div className="h-3 bg-gray-200 rounded w-16 mb-2"></div>
              <div className="h-6 bg-gray-200 rounded w-20 mb-2"></div>
              <div className="h-3 bg-gray-200 rounded w-12"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const items = [
    {
      label: "Total Input",
      value: animatedInput,
      today: today?.totalInput || 0,
      yesterday: yesterday?.totalInput || 0,
      breakdown: [
        { label: "Cached", value: today?.totalInputCached || 0 },
        { label: "Uncached", value: today?.totalInputUncached || 0 },
      ],
    },
    {
      label: "Total Output",
      value: animatedOutput,
      today: today?.totalOutput || 0,
      yesterday: yesterday?.totalOutput || 0,
    },
    {
      label: "Cache Write",
      value: animatedCacheWrite,
      today: today?.totalCacheWrite || 0,
      yesterday: yesterday?.totalCacheWrite || 0,
    },
    {
      label: "Requests",
      value: animatedCount,
      today: today?.count || 0,
      yesterday: yesterday?.count || 0,
    },
  ];

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-8 border-l-4 border-blue-500">
      <h2 className="text-lg font-semibold mb-4">Today ({todayDate})</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {items.map((item) => (
          <div key={item.label} className="bg-gray-50 rounded-lg p-4">
            <p className="text-xs text-gray-500 mb-1">{item.label}</p>
            <p className="text-xl md:text-2xl font-bold text-gray-900">{formatNumber(item.value)}</p>
            <div className="mt-1">
              <ChangeBadge today={item.today} yesterday={item.yesterday} />
            </div>
            {item.breakdown && (
              <div className="mt-2 pt-2 border-t border-gray-200 grid grid-cols-2 gap-2">
                {item.breakdown.map((b) => (
                  <div key={b.label}>
                    <p className="text-[10px] text-gray-400">{b.label}</p>
                    <p className="text-xs font-medium text-gray-700">{formatNumber(b.value)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
