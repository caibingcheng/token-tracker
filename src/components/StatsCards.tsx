"use client";

export interface Stats {
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalCacheWrite: number;
  count: number;
}

interface StatsCardsProps {
  stats: Stats | null;
  loading: boolean;
  error: string | null;
}

export default function StatsCards({ stats, loading, error }: StatsCardsProps) {
  const formatNumber = (num: number) => new Intl.NumberFormat("en-US").format(num);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-white rounded-lg shadow p-6 animate-pulse">
            <div className="h-4 bg-gray-200 rounded w-20 mb-2"></div>
            <div className="h-8 bg-gray-200 rounded w-24"></div>
          </div>
        ))}
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

  const cards = [
    {
      label: "Total Input",
      value: stats?.totalInput || 0,
      color: "blue",
      breakdown: [
        { label: "Cached", value: stats?.totalInputCached || 0 },
        { label: "Uncached", value: stats?.totalInputUncached || 0 },
      ],
    },
    { label: "Total Output", value: stats?.totalOutput || 0, color: "green" },
    { label: "Cache Write", value: stats?.totalCacheWrite || 0, color: "purple" },
    { label: "Total Requests", value: stats?.count || 0, color: "orange" },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {cards.map((card) => (
        <div key={card.label} className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm font-medium text-gray-500">{card.label}</h3>
          <p className="text-2xl font-bold mt-2">{formatNumber(card.value)}</p>
          {card.breakdown && (
            <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-2 gap-2">
              {card.breakdown.map((item) => (
                <div key={item.label}>
                  <p className="text-xs text-gray-400">{item.label}</p>
                  <p className="text-sm font-semibold text-gray-700">{formatNumber(item.value)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
