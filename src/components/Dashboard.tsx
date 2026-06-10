"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import StatsCards, { Stats } from "./StatsCards";
import RecordsTable from "./RecordsTable";
import DailyUsageChart, { DailyData } from "./DailyUsageChart";
import { useAnimatedNumber } from "@/hooks/useAnimatedNumber";
import TodayOverview, { TodayData } from "./TodayOverview";

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
  if (seconds < 60) return `${seconds}s ago`;
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
  const [todayData, setTodayData] = useState<TodayData | null>(null);
  const [yesterdayData, setYesterdayData] = useState<TodayData | null>(null);
  const [lastActiveAt, setLastActiveAt] = useState<Date | null>(null);

  // Provider filter states
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("all");
  const selectedProviderRef = useRef<string>("all");

  // Model filter states
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedModel, setSelectedModel] = useState<string>("all");
  const selectedModelRef = useRef<string>("all");

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
  const [isRangeInitialized, setIsRangeInitialized] = useState(false);

  // Polling
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [recordsRefreshKey, setRecordsRefreshKey] = useState(0);

  // Tick for updating footer time display
  const [, setTick] = useState(0);

  // Recent Records visibility
  const [recordsVisible, setRecordsVisible] = useState(false);

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

  // Keep model ref in sync with state
  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  // Keep provider ref in sync with state
  useEffect(() => {
    selectedProviderRef.current = selectedProvider;
  }, [selectedProvider]);

  // Debounce refs
  const dailyRangeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch provider and model lists on mount
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
    async function fetchModels() {
      try {
        const res = await fetch("/api/models");
        const json = await res.json();
        if (json.success && Array.isArray(json.data)) {
          setModels(json.data);
        }
      } catch (err) {
        console.error("Failed to fetch models:", err);
      }
    }
    fetchProviders();
    fetchModels();
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

      const currentModel = selectedModelRef.current;

      // Build Dashboard URL
      const dashboardUrl = new URL("/api/dashboard", window.location.origin);
      dashboardUrl.searchParams.set("range", `${currentDailyRange}d`);
      if (currentProvider !== "all") {
        dashboardUrl.searchParams.set("provider", currentProvider);
      }
      if (currentModel !== "all") {
        dashboardUrl.searchParams.set("model", currentModel);
      }

      const dashboardRes = await fetch(dashboardUrl.toString());

      let newStats: Stats | null = null;
      let newTop5: ModelStat[] = [];
      let newDaily: DailyData[] = [];

      if (dashboardRes.ok) {
        const dashboardData = await dashboardRes.json();
        if (dashboardData.success) {
          const { total, daily, models } = dashboardData.data;

          // Stats
          if (total && total.length > 0) {
            const item = total[0];
            newStats = {
              totalInput: Number(item.totalInput || 0),
              totalOutput: Number(item.totalOutput || 0),
              totalInputCached: Number(item.totalInputCached || 0),
              totalInputUncached: Number(item.totalInputUncached || 0),
              totalCacheWrite: Number(item.totalCacheWrite || 0),
              count: Number(item.count || 0),
            };
            if (item.lastActiveAt) {
              setLastActiveAt(new Date(item.lastActiveAt));
            }
            setStats(newStats);
          }

          // Top N
          if (models) {
            newTop5 = models.slice(0, 5);
            setTopModels(newTop5);
          }

          // Daily
          if (daily) {
            newDaily = daily;
            
            // Extract today and yesterday data
            const todayStr = new Date().toISOString().split('T')[0];
            const yesterdayDate = new Date();
            yesterdayDate.setDate(yesterdayDate.getDate() - 1);
            const yesterdayStr = yesterdayDate.toISOString().split('T')[0];
            
            const todayItem = daily.find((d: DailyData) => d.group === todayStr);
            const yesterdayItem = daily.find((d: DailyData) => d.group === yesterdayStr);
            
            setTodayData(todayItem ? {
              totalInput: Number(todayItem.totalInput || 0),
              totalOutput: Number(todayItem.totalOutput || 0),
              totalInputCached: Number(todayItem.totalInputCached || 0),
              totalInputUncached: Number(todayItem.totalInputUncached || 0),
              totalCacheWrite: Number(todayItem.totalCacheWrite || 0),
              count: Number(todayItem.count || 0),
            } : null);
            
            setYesterdayData(yesterdayItem ? {
              totalInput: Number(yesterdayItem.totalInput || 0),
              totalOutput: Number(yesterdayItem.totalOutput || 0),
              totalInputCached: Number(yesterdayItem.totalInputCached || 0),
              totalInputUncached: Number(yesterdayItem.totalInputUncached || 0),
              totalCacheWrite: Number(yesterdayItem.totalCacheWrite || 0),
              count: Number(yesterdayItem.count || 0),
            } : null);
            
            setDailyData(newDaily);
          }
        }
      } else {
        setErrorStats(`HTTP ${dashboardRes.status}`);
        setErrorTop5(`HTTP ${dashboardRes.status}`);
        setErrorDaily(`HTTP ${dashboardRes.status}`);
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

  // Read saved daily range from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('token-tracker-daily-range');
    if (saved) {
      const parsed = Number(saved);
      if (DAILY_RANGE_OPTIONS.includes(parsed)) {
        setDailyRange(parsed);
        dailyRangeRef.current = parsed;
      }
    }
    setIsRangeInitialized(true);
  }, []);

  // Initial fetch after range is initialized
  useEffect(() => {
    if (isRangeInitialized) {
      fetchAll();
    }
  }, [isRangeInitialized, fetchAll]);

  // Handle provider selection change
  const handleProviderChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setSelectedProvider(value);
    selectedProviderRef.current = value;
    fetchAll({ skipLoading: true });
  }, [fetchAll]);

  // Handle model selection change
  const handleModelChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setSelectedModel(value);
    selectedModelRef.current = value;
    fetchAll({ skipLoading: true });
  }, [fetchAll]);

  // Handle daily range change
  const handleDailyRangeChange = useCallback((newRange: number) => {
    setDailyRange(newRange);
    dailyRangeRef.current = newRange;
    localStorage.setItem('token-tracker-daily-range', String(newRange));
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

  // Auto polling every 120s
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchAll({ skipLoading: true, skipRecordsRefresh: true });
      }
    }, 120000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // Visibility change listener
  useEffect(() => {
    const handleVisibilityChange = () => {
      isVisibleRef.current = document.visibilityState === 'visible';
      if (document.visibilityState === 'visible') {
        fetchAll({ skipLoading: true, skipRecordsRefresh: true });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [fetchAll]);

  // Update footer time every 1s
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(n => n + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatNumber = (num: number) => new Intl.NumberFormat("en-US").format(num);

  return (
    <main className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-2">
          <div>
            <h1 className="text-xl md:text-3xl font-bold">Token Tracker Dashboard</h1>
            {lastActiveAt && (
              <p className="text-sm text-gray-500 mt-1">
                Last active token at {lastActiveAt.toLocaleString()}
              </p>
            )}
          </div>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
            {/* Provider Filter */}
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <label htmlFor="provider-select" className="text-sm text-gray-600 shrink-0">
                Provider:
              </label>
              <select
                id="provider-select"
                value={selectedProvider}
                onChange={handleProviderChange}
                className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="all">All Providers</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            {/* Model Filter */}
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <label htmlFor="model-select" className="text-sm text-gray-600 shrink-0">
                Model:
              </label>
              <select
                id="model-select"
                value={selectedModel}
                onChange={handleModelChange}
                className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="all">All Models</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <StatsCards stats={stats} loading={loadingStats} error={errorStats} />

        <TodayOverview 
          today={todayData} 
          yesterday={yesterdayData} 
          loading={loadingDaily} 
        />

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
            Last {dailyRange} Days Top 5 Model Families
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
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cache Hit Rate</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total Output</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cache Write</th>
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
                              <td className="px-4 py-3 text-sm font-medium text-gray-900">{model.group}</td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right"><AnimatedCell value={model.totalInput} /></td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right"><AnimatedCell value={model.totalInputCached} /></td>
                              <td className="px-4 py-3 text-sm text-gray-600 text-right">{cacheHitRate}</td>
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
                            <p className="text-xs text-gray-500">Cache Write</p>
                            <p className="text-sm font-semibold text-gray-900">{formatNumber(model.totalCacheWrite)}</p>
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
            </>
          )}
        </div>

        {/* Recent Records Toggle */}
        <div className="bg-white rounded-lg shadow overflow-hidden mb-8">
          <button
            onClick={() => setRecordsVisible(!recordsVisible)}
            className="w-full px-6 py-4 flex justify-between items-center hover:bg-gray-50 transition-colors"
          >
            <div className="text-left">
              <h2 className="text-lg font-semibold">Recent Records</h2>
              {selectedProvider !== "all" && (
                <p className="text-xs text-gray-400 mt-1">
              {selectedProvider !== "all" && selectedModel !== "all"
                ? `Filtered by ${selectedProvider} + ${selectedModel}`
                : selectedProvider !== "all"
                ? `Filtered by ${selectedProvider}`
                : selectedModel !== "all"
                ? `Filtered by ${selectedModel}`
                : ""}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-gray-400">
            {recordsVisible ? "▼" : "▶"}
          </span>
        </div>
      </button>

      {recordsVisible && (
        <RecordsTable
          selectedProvider={selectedProvider}
          selectedModel={selectedModel}
          refreshKey={recordsRefreshKey}
          showHeader={false}
        />
      )}
        </div>

        {/* Footer */}
        <div className="mt-8 py-4 border-t border-gray-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-2 text-sm text-gray-500">
          <span>Updated {formatTimeAgo(lastUpdated)}</span>
        </div>
      </div>
    </main>
  );
}
