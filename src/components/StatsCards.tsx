"use client";

import { useEffect, useState } from "react";

interface Stats {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  count: number;
}

export default function StatsCards() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const apiKey = localStorage.getItem("token-tracker-api-key") || "";
    if (!apiKey) return;

    fetch("/api/stats?groupBy=date&range=all", {
      headers: { "X-API-Key": apiKey },
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          const totals = data.data.reduce(
            (acc: Stats, item: any) => ({
              totalInput: acc.totalInput + Number(item.totalInput || 0),
              totalOutput: acc.totalOutput + Number(item.totalOutput || 0),
              totalCacheRead: acc.totalCacheRead + Number(item.totalCacheRead || 0),
              totalCacheWrite: acc.totalCacheWrite + Number(item.totalCacheWrite || 0),
              count: acc.count + Number(item.count || 0),
            }),
            { totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, count: 0 }
          );
          setStats(totals);
        }
      });
  }, []);

  const formatNumber = (num: number) => new Intl.NumberFormat("en-US").format(num);

  const cards = [
    { label: "Total Input", value: stats?.totalInput || 0, color: "blue" },
    { label: "Total Output", value: stats?.totalOutput || 0, color: "green" },
    { label: "Total Cache", value: (stats?.totalCacheRead || 0) + (stats?.totalCacheWrite || 0), color: "purple" },
    { label: "Total Requests", value: stats?.count || 0, color: "orange" },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {cards.map((card) => (
        <div key={card.label} className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm font-medium text-gray-500">{card.label}</h3>
          <p className="text-2xl font-bold mt-2">{formatNumber(card.value)}</p>
        </div>
      ))}
    </div>
  );
}
