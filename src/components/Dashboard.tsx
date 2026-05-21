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

const INITIAL_INTERVAL = 60_000; // 60s
const MAX_INTERVAL = 300_000; // 5min

function formatTimeAgo(date: Date | null): string {
  if (!date) return "Never";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  return `${Math.ceil(ms / 60_000)}min`;
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

  // NEW: Provider filter states
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

  // Polling
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [nextRefreshIn, setNextRefreshIn] = useState(INITIAL_INTERVAL);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Refs to avoid stale closures and infinite loops
  const statsRef = useRef<Stats | null>(null);
  const topModelsRef = useRef<ModelStat[]>([]);
  const dailyDataRef = useRef<DailyData[]>([]);
  const pollIntervalRef = useRef(INITIAL_INTERVAL);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isVisibleRef = useRef(true);
  const isFetchingRef = useRef(false);
  const autoRefreshRef = useRef(false);

  // Keep refs in sync with states
  statsRef.current = stats;
  topModelsRef.current = topModels;
  dailyDataRef.current = dailyData;
  autoRefreshRef.current = autoRefresh;

  // Keep provider ref in sync with state
  useEffect(() => {
    selectedProviderRef.current = selectedProvider;
  }, [selectedProvider]);

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
  }, []); // Empty deps — fetch once on mount

  const fetchAll = useCallback(async (options?: { skipLoading?: boolean }) => {
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

      // Build URLs with provider filter
      const statsUrl = new URL("/api/stats?groupBy=none&range=all", window.location.origin);
      const top5Url = new URL("/api/stats?groupBy=model", window.location.origin);
      const dailyUrl = new URL("/api/stats?groupBy=date&range=30d", window.location.origin);

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

      // Top 5
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

      // Dynamic interval: check if data changed vs previous fetch
      const prevStats = JSON.stringify(statsRef.current);
      const prevTop5 = JSON.stringify(topModelsRef.current);
      const prevDaily = JSON.stringify(dailyDataRef.current);
      const currStats = JSON.stringify(newStats);
      const currTop5 = JSON.stringify(newTop5);
      const currDaily = JSON.stringify(newDaily);

      const changed =
        currStats !== prevStats ||
        currTop5 !== prevTop5 ||
        currDaily !== prevDaily;

      if (changed) {
        pollIntervalRef.current = INITIAL_INTERVAL;
      } else {
        pollIntervalRef.current = Math.min(pollIntervalRef.current * 2, MAX_INTERVAL);
      }
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
    }
  }, []); // No dependencies - refs handle everything

  // Polling loop - runs once on mount
  useEffect(() => {
    let mounted = true;

    const runLoop = async () => {
      if (!mounted) return;
      await fetchAll();
      if (!mounted) return;

      if (autoRefreshRef.current) {
        timeoutRef.current = setTimeout(() => {
          runLoop();
        }, pollIntervalRef.current);
      }
    };

    // Initial fetch on mount (always runs once)
    fetchAll();

    return () => {
      mounted = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [fetchAll]);

  // Visibility change handler
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        isVisibleRef.current = false;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      } else {
        isVisibleRef.current = true;
        if (autoRefreshRef.current) {
          // Immediate refresh on tab focus, then resume normal loop
          fetchAll().then(() => {
            if (!autoRefreshRef.current) return;
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            timeoutRef.current = setTimeout(() => {
              // Triggered by autoRefresh effect below
            }, pollIntervalRef.current);
          });
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [fetchAll]);

  // Start/stop polling when autoRefresh toggle changes
  useEffect(() => {
    if (autoRefresh) {
      // Start polling: fetch now, then schedule next
      fetchAll().then(() => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => {
          const runLoop = async () => {
            await fetchAll();
            if (autoRefreshRef.current) {
              timeoutRef.current = setTimeout(runLoop, pollIntervalRef.current);
            }
          };
          runLoop();
        }, pollIntervalRef.current);
      });
    } else {
      // Stop polling
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    }
  }, [autoRefresh, fetchAll]);

  // Countdown timer for footer
  useEffect(() => {
    const interval = setInterval(() => {
      if (!lastUpdated) return;
      const elapsed = Date.now() - lastUpdated.getTime();
      const remaining = Math.max(0, pollIntervalRef.current - elapsed);
      setNextRefreshIn(remaining);
    }, 1000);

    return () => clearInterval(interval);
  }, [lastUpdated]);

  // Handle provider selection change
  const handleProviderChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setSelectedProvider(value);
    // Note: fetchAll reads from selectedProviderRef.current, so we need
    // to ensure the ref is updated before calling fetchAll
    selectedProviderRef.current = value;
    fetchAll({ skipLoading: true });
  }, [fetchAll]);

  const formatNumber = (num: number) => new Intl.NumberFormat("en-US").format(num);

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Token Tracker Dashboard</h1>
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

            {/* Auto Refresh */}
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              Auto Refresh
            </label>
          </div>
        </div>

        <StatsCards stats={stats} loading={loadingStats} error={errorStats} />

        <DailyUsageChart rawData={dailyData} loading={loadingDaily} error={errorDaily} />

        {/* Top 5 Models */}
        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h2 className="text-lg font-semibold mb-1">Top 5 Model Families</h2>
          {loadingTop5 && (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-12 bg-gray-100 rounded animate-pulse"></div>
              ))}
            </div>
          )}
          {errorTop5 && <p className="text-red-600">Error: {errorTop5}</p>}
          {!loadingTop5 && !errorTop5 && topModels.length === 0 && (
            <p className="text-gray-500">No data available</p>
          )}
          {!loadingTop5 && !errorTop5 && topModels.length > 0 && (
            <div className="overflow-x-auto">
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
          )}
        </div>

        <RecordsTable selectedProvider={selectedProvider} />

        {/* Footer */}
        <div className="mt-8 py-4 border-t border-gray-200 flex justify-between items-center text-sm text-gray-500">
          <span>Updated {formatTimeAgo(lastUpdated)}</span>
          {autoRefresh ? (
            <span>Next refresh in {formatDuration(nextRefreshIn)}</span>
          ) : (
            <span>Auto refresh disabled</span>
          )}
        </div>
      </div>
    </main>
  );
}
