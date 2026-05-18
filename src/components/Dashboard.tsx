"use client";

import { useState } from "react";
import StatsCards from "./StatsCards";
import TrendChart from "./TrendChart";
import ModelDistributionChart from "./ModelDistributionChart";
import ProviderDistributionChart from "./ProviderDistributionChart";
import RecordsTable from "./RecordsTable";

export default function Dashboard() {
  const [apiKey, setApiKey] = useState("");
  const [isConfigured, setIsConfigured] = useState(false);
  const [range, setRange] = useState("30d");

  const handleConfigure = () => {
    if (apiKey.trim()) {
      localStorage.setItem("token-tracker-api-key", apiKey.trim());
      setIsConfigured(true);
    }
  };

  if (!isConfigured) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-white rounded-lg shadow p-8 max-w-md w-full">
          <h2 className="text-2xl font-bold mb-4">Token Tracker</h2>
          <p className="text-gray-600 mb-4">
            Enter your API Key to view your token usage dashboard.
          </p>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Enter API Key"
            className="w-full px-4 py-2 border rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleConfigure}
            className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition"
          >
            Connect
          </button>
        </div>
      </div>
    );
  }

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
        <TrendChart range={range} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
          <ModelDistributionChart />
          <ProviderDistributionChart />
        </div>

        <RecordsTable />
      </div>
    </main>
  );
}
