"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import StatsCards, { Stats } from "./StatsCards";
import RecordsTable from "./RecordsTable";
import DailyUsageChart, { DailyData } from "./DailyUsageChart";
import { useAnimatedNumber } from "@/hooks/useAnimatedNumber";

interface ModelStat {
  group: string;
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalCacheWrite: number;
  count: number;
}

const DAILY_RANGE_OPTIONS = [3, 7, 14, 30];

function formatTimeAgo(date: Date | null): string {
  if (!date) return "Never";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function AnimatedCell({ value }: { value: number }) {
  const animated = useAnimatedNumber(value, 600);
  return <span>{new Intl.NumberFormat("en-US").format(Math.round(animated))}</span>;
}

export default function Dashboard() {
  // Data states
  const [stats, setStats] = useState<Stats | null>(null);
  const [topModels, setTopModels] = useState<ModelStat[]>([]);
  const [dailyData, setDailyData] = useState<DailyData[]>([]);

  // Provider filter states
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("all");
  const selectedProviderRef = useRef<string>("all");

  // Loading states
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingTop5, setLoadingTop5] = useState(true);
  const [loadingDaily, setLoadingDaily] = useState(true);

  // Error states
  const [errorStats, setErrorStats] = useState<string | null>(null);
  const [errorTop5, setErrorTop5] = useState<string | null>(null);
  const [errorDaily, setErrorDaily] = useState<string | null>(null);

  // Daily range state
  const [dailyRange, setDailyRange] = useState(7);
  const dailyRangeRef = useRef(7);

  // Polling
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [recordsRefreshKey, setRecordsRefreshKey] = useState(0);

  // Refs to avoid stale closures and infinite loops
  const statsRef = useRef<Stats | null>(null);
  const topModelsRef = useRef<ModelStat[]>([]);
  const dailyDataRef = useRef<DailyData[]>([]);
  const isVisibleRef = useRef(true);
  const isFetchingRef = useRef(false);

  // Keep refs in sync with states
  statsRef.current = stats;
  topModelsRef.current = topModels;
  dailyDataRef.current = dailyData;
  dailyRangeRef.current = dailyRange;

  // Keep provider ref in sync with state
  useEffect(() => {
    selectedProviderRef.current = selectedProvider;
  }, [selectedProvider]);

  // Debounce refs
  const dailyRangeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch provider list on mount
  useEffect(() => {
    async function fetchProviders() {
      try {
        const res = await fetch("/api/providers");
        const json = await res.json();
        if (json.success && Array.isArray(json.data)) {
          setProviders(json.data);
        }
      } catch (err) {
        console.error("Failed to fetch providers:", err);
      }
    }
    fetchProviders();
  }, []);

  const fetchAll = useCallback(async (options?: { skipLoading?: boolean; skipRecordsRefresh?: boolean }) => {
    if (!isVisibleRef.current || isFetchingRef.current) return;
    isFetchingRef.current = true;

    const isFirstLoad = !statsRef.current && !topModelsRef.current && !dailyDataRef.current;
    if (!options?.skipLoading && isFirstLoad) {
      setLoadingStats(true);
      setLoadingTop5(true);
      setLoadingDaily(true);
    }

    setErrorStats(null);
    setErrorTop5(null);
    setErrorDaily(null);

    try {
      const currentProvider = selectedProviderRef.current;
      const currentDailyRange = dailyRangeRef.current;

      // Build URLs with provider filter
      const statsUrl = new URL("/api/stats?groupBy=none&range=all", window.location.origin);
      const top5Url = new URL(`/api/stats?groupBy=model&range=${currentDailyRange}d`, window.location.origin);
      const dailyUrl = new URL(`/api/stats?groupBy=date&range=${currentDailyRange}d`, window.location.origin);

      if (currentProvider !== "all") {
        statsUrl.searchParams.set("provider", currentProvider);
        top5Url.searchParams.set("provider", currentProvider);
        dailyUrl.searchParams.set("provider", currentProvider);
      }

      const [statsRes, top5Res, dailyRes] = await Promise.all([
        fetch(statsUrl.toString()),
        fetch(top5Url.toString()),
        fetch(dailyUrl.toString()),
      ]);

      let newStats: Stats | null = null;
      let newTop5: ModelStat[] = [];
      let newDaily: DailyData[] = [];

      // Stats
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        if (statsData.success && statsData.data.length > 0) {
          const item = statsData.data[0];
          newStats = {
            totalInput: Number(item.totalInput || 0),
            totalOutput: Number(item.totalOutput || 0),
            totalInputCached: Number(item.totalInputCached || 0),
            totalInputUncached: Number(item.totalInputUncached || 0),
            totalCacheWrite: Number(item.totalCacheWrite || 0),
            count: Number(item.count || 0),
          };
          setStats(newStats);
        }
      } else {
        setErrorStats(`HTTP ${statsRes.status}`);
      }

      // Top N
      if (top5Res.ok) {
        const top5Data = await top5Res.json();
        if (top5Data.success) {
          newTop5 = top5Data.data.slice(0, 5);
          setTopModels(newTop5);
        }
      } else {
        setErrorTop5(`HTTP ${top5Res.status}`);
      }

      // Daily
      if (dailyRes.ok) {
        const dailyDataResult = await dailyRes.json();
        if (dailyDataResult.success) {
          newDaily = dailyDataResult.data;
          setDailyData(newDaily);
        }
      } else {
        setErrorDaily(`HTTP ${dailyRes.status}`);
      }

      setLastUpdated(new Date());
    } catch (err) {
      console.error("Fetch error:", err);
      setErrorStats("Network error");
      setErrorTop5("Network error");
      setErrorDaily("Network error");
    } finally {
      if (!options?.skipLoading) {
        setLoadingStats(false);
        setLoadingTop5(false);
        setLoadingDaily(false);
      }
      isFetchingRef.current = false;
      if (!options?.skipRecordsRefresh) {
        setRecordsRefreshKey(k => k + 1);
      }
    }
  }, []);

  // Initial fetch on mount
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Visibility change handler
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        isVisibleRef.current = false;
      } else {
        isVisibleRef.current = true;
        fetchAll({ skipLoading: true });
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [fetchAll]);

  // Handle provider selection change
  const handleProviderChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setSelectedProvider(value);
    selectedProviderRef.current = value;
    fetchAll({ skipLoading: true });
  }, [fetchAll]);

  // Handle daily range change
  const handleDailyRangeChange = useCallback((newRange: number) => {
    setDailyRange(newRange);
    dailyRangeRef.current = newRange;
    if (dailyRangeTimeoutRef.current) {
      clearTimeout(dailyRangeTimeoutRef.current);
    }
    dailyRangeTimeoutRef.current = setTimeout(() => {
      fetchAll({ skipLoading: true, skipRecordsRefresh: true });
    }, 300);
  }, [fetchAll]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (dailyRangeTimeoutRef.current) {
        clearTimeout(dailyRangeTimeoutRef.current);
      }
    };
  }, []);

  const formatNumber = (num: number) => new Intl.NumberFormat("en-US").format(num);

  return (
    <main className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-2">
          <h1 className="text-xl md:text-3xl font-bold">Token Tracker Dashboard</h1>
          <div className="flex items-center gap-4">
            {/* Provider Filter */}
            <div className="flex items-center gap-2">
              <label htmlFor="provider-select" className="text-sm text-gray-600">
                Provider:
              </label>
              <select
                id="provider-select"
                value={selectedProvider}
                onChange={handleProviderChange}
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="all">All Providers</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <StatsCards stats={stats} loading={loadingStats} error={errorStats} />

        <DailyUsageChart
          rawData={dailyData}
          loading={loadingDaily}
          error={errorDaily}
          range={dailyRange}
          onRangeChange={handleDailyRangeChange}
        />

        {/* Top N Models */}
        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h2 className="text-lg font-semibold mb-1">
            Top 5 Model Families
          </h2>
          {loadingTop5 && (
            <div className="space-y-3">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded animate-pulse"></div>
              ))}
            </div>
          )}
          {errorTop5 && <p className="text-red-600">Error: {errorTop5}</p>}
          {!loadingTop5 && !errorTop5 && topModels.length === 0 && (
            <p className="text-gray-500">No data available</p>
          )}
          {!loadingTop5 && !errorTop5 && topModels.length > 0 && (
            <>
              {/* Desktop Table */}
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
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total Output</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cache Write</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Requests</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {topModels.map((model) => {
                          const allTokens = model.totalInput + model.totalOutput;
                          const percentage = totalAllTokens > 0 ? (allTokens / totalAllTokens) * 100 : 0;
                          return (
                            <tr
                              key={model.group}
                              style={{
                                background: `linear-gradient(to right, rgb(239 246 255) ${percentage}%, transparent ${percentage}%)`
                              }}
                            >
                              <td className="px-4 py-3 text-sm font-medium text-gray-900">{model.group}</td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right"><AnimatedCell value={model.totalInput} /></td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right"><AnimatedCell value={model.totalInputCached} /></td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right"><AnimatedCell value={model.totalOutput} /></td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right"><AnimatedCell value={model.totalCacheWrite} /></td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right"><AnimatedCell value={model.count} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  );
                })()}
              </div>

              {/* Mobile Cards */}
              <div className="md:hidden space-y-3">
                {(() => {
                  const maxAllTokens = Math.max(...topModels.map(m => m.totalInput + m.totalOutput));
                  return topModels.map((model) => {
                    const allTokens = model.totalInput + model.totalOutput;
                    const percentage = maxAllTokens > 0 ? (allTokens / maxAllTokens) * 100 : 0;
                    return (
                      <div
                        key={model.group}
                        className="rounded-lg border border-gray-200 overflow-hidden"
                        style={{
                          background: `linear-gradient(to right, rgb(239 246 255) ${percentage}%, transparent ${percentage}%)`
                        }}
                      >
                        <div className="px-4 py-3 font-medium text-gray-900 border-b border-gray-100">
                          {model.group}
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
                            <p className="text-xs text-gray-500">Total Output</p>
                            <p className="text-sm font-semibold text-gray-900">{formatNumber(model.totalOutput)}</p>
                          </div>
                          <div>
                            <p className="text-xs text-gray-500">Cache Write</p>
                            <p className="text-sm font-semibold text-gray-900">{formatNumber(model.totalCacheWrite)}</p>
                          </div>
                          <div className="col-span-2">
                            <p className="text-xs text-gray-500">Requests</p>
                            <p className="text-sm font-semibold text-gray-900">{formatNumber(model.count)}</p>
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

        <RecordsTable selectedProvider={selectedProvider} refreshKey={recordsRefreshKey} />

        {/* Footer */}
        <div className="mt-8 py-4 border-t border-gray-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-2 text-sm text-gray-500">
          <span>Updated {formatTimeAgo(lastUpdated)}</span>
        </div>
      </div>
    </main>
  );
}
