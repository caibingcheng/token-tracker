"use client";

import { useState } from "react";
import StatsCards from "./StatsCards";
import ModelTrends from "./ModelTrends";
import ModelDistributionChart from "./ModelDistributionChart";
import ProviderDistributionChart from "./ProviderDistributionChart";
import RecordsTable from "./RecordsTable";

export default function Dashboard() {
  const [range, setRange] = useState("30d");

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Token Tracker Dashboard</h1>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="px-4 py-2 border rounded-lg"
          >
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
            <option value="90d">Last 90 Days</option>
            <option value="all">All Time</option>
          </select>
        </div>

        <StatsCards />
        <ModelTrends range={range} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
          <ModelDistributionChart />
          <ProviderDistributionChart />
        </div>

        <RecordsTable />
      </div>
    </main>
  );
}
