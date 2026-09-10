"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import StatsCards, { Stats } from "./StatsCards";
import RecordsTable from "./RecordsTable";
import DailyUsageChart, {
  DailyData,
  LatencyModelStat,
  LatencyDayStat,
  ProviderStat,
  RANGE_OPTIONS,
} from "./DailyUsageChart";
import TodayOverview, { TodayData } from "./TodayOverview";
import MobileSummary from "./MobileSummary";
import PriceSimulatorModal from "./PriceSimulatorModal";
import UsageHeatmap, { HeatmapData } from "./UsageHeatmap";
import { getClientTimezoneOffsetMinutes } from "@/lib/timezone-utils";
import { apiFetch } from "@/lib/client/api-client";
import { useSidebarActions, NumberFormatToggle } from "./AppSidebar";

interface ModelStat {
  group: string;
  canonicalId: string;
  displayName: string;
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalCacheWrite: number;
  count: number;
  totalCost: number;
  costPerMillionTokens: number;
  costPerMillionInput: number;
  costPerMillionCacheRead: number;
  costPerMillionCacheWrite: number;
  costPerMillionOutput: number;
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

interface DashboardProps {
  priceUpdateTime?: React.ReactNode;
}

export default function Dashboard({ priceUpdateTime }: DashboardProps) {
  const { setSidebarActions } = useSidebarActions();
  const [stats, setStats] = useState<Stats | null>(null);
  const [topModels, setTopModels] = useState<ModelStat[]>([]);
  const [totalTopModels, setTotalTopModels] = useState<ModelStat[]>([]);
  const [todayTopModels, setTodayTopModels] = useState<ModelStat[]>([]);
  const [dailyTopModels, setDailyTopModels] = useState<Record<string, ModelStat[]>>({});
  const [topProviders, setTopProviders] = useState<ProviderStat[]>([]);
  const [dailyProviders, setDailyProviders] = useState<Record<string, ProviderStat[]>>({});
  const [dailyData, setDailyData] = useState<DailyData[]>([]);
  const [heatmapData, setHeatmapData] = useState<HeatmapData[]>([]);
  const [hourlyData, setHourlyData] = useState<DailyData[]>([]);
  const [latencyByModel, setLatencyByModel] = useState<LatencyModelStat[]>([]);
  const [latencyDaily, setLatencyDaily] = useState<LatencyDayStat[]>([]);
  const [dailyLatencyByModel, setDailyLatencyByModel] = useState<Record<string, LatencyModelStat[]>>({});
  const [timezoneOffsetMinutes, setTimezoneOffsetMinutes] = useState<number>(0);
  const clientTimezoneOffsetMinutes = useMemo(
    () => getClientTimezoneOffsetMinutes(),
    []
  );
  const [todayData, setTodayData] = useState<TodayData | null>(null);
  const [yesterdayData, setYesterdayData] = useState<TodayData | null>(null);
  const [lastActiveAt, setLastActiveAt] = useState<Date | null>(null);
  const [totalDays, setTotalDays] = useState<number>(0);

  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("all");
  const selectedProviderRef = useRef<string>("all");

  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedModel, setSelectedModel] = useState<string>("all");
  const selectedModelRef = useRef<string>("all");

  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  const selectedAgentRef = useRef<string>("all");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dailyRange, setDailyRange] = useState(7);
  const dailyRangeRef = useRef(7);
  const [isRangeInitialized, setIsRangeInitialized] = useState(false);

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshDuration, setRefreshDuration] = useState<number | null>(null);
  const [recordsRefreshKey, setRecordsRefreshKey] = useState(0);

  const [, setTick] = useState(0);

  const [recordsVisible, setRecordsVisible] = useState(false);
  const [isSimulatorOpen, setIsSimulatorOpen] = useState(false);

  // 桌面侧栏底部操作组：仅 Dashboard 页注册，Admin 页不挂载自动消失
  const dashboardActions = useMemo(
    () => (
      <div className="flex flex-col gap-2">
        <NumberFormatToggle />
        <button
          type="button"
          onClick={() => setIsSimulatorOpen(true)}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
        >
          Price Simulation
        </button>
      </div>
    ),
    []
  );

  useEffect(() => {
    setSidebarActions(dashboardActions);
    return () => setSidebarActions(null);
  }, [setSidebarActions, dashboardActions]);

  const isMobile = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches,
    []
  );

  const statsRef = useRef<Stats | null>(null);
  const topModelsRef = useRef<ModelStat[]>([]);
  const dailyDataRef = useRef<DailyData[]>([]);
  const isVisibleRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    statsRef.current = stats;
  }, [stats]);

  useEffect(() => {
    topModelsRef.current = topModels;
  }, [topModels]);

  useEffect(() => {
    dailyDataRef.current = dailyData;
  }, [dailyData]);

  useEffect(() => {
    dailyRangeRef.current = dailyRange;
  }, [dailyRange]);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    selectedProviderRef.current = selectedProvider;
  }, [selectedProvider]);

  useEffect(() => {
    selectedAgentRef.current = selectedAgent;
  }, [selectedAgent]);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await apiFetch("/api/providers");
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setProviders(json.data);
      }
    } catch (err) {
      console.error("Failed to fetch providers:", err);
    }
  }, []);

  const fetchModels = useCallback(async () => {
    try {
      const res = await apiFetch("/api/models");
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setModels(json.data);
      }
    } catch (err) {
      console.error("Failed to fetch models:", err);
    }
  }, []);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await apiFetch("/api/agents");
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setAgents(json.data);
      }
    } catch (err) {
      console.error("Failed to fetch agents:", err);
    }
  }, []);

  useEffect(() => {
    if (isMobile) return;
    fetchProviders();
    fetchModels();
    fetchAgents();
  }, [fetchProviders, fetchModels, fetchAgents, isMobile]);

  const buildDashboardUrl = useCallback(() => {
    const url = new URL("/api/dashboard", window.location.origin);
    url.searchParams.set("range", `${dailyRangeRef.current}d`);
    url.searchParams.set(
      "tzOffset",
      String(clientTimezoneOffsetMinutes)
    );
    if (selectedProviderRef.current !== "all") {
      url.searchParams.set("provider", selectedProviderRef.current);
    }
    if (selectedModelRef.current !== "all") {
      url.searchParams.set("model", selectedModelRef.current);
    }
    if (selectedAgentRef.current !== "all") {
      url.searchParams.set("agent", selectedAgentRef.current);
    }
    return url.toString();
  }, [clientTimezoneOffsetMinutes]);

  const fetchDashboard = useCallback(
    async (options?: {
      skipLoading?: boolean;
      skipRecordsRefresh?: boolean;
      signal?: AbortSignal;
      onDataReady?: (endTime: number) => void;
    }) => {
      if (!isVisibleRef.current) return;

      let aborted = false;
      const isFirstLoad = !statsRef.current && !dailyDataRef.current;
      if (!options?.skipLoading && isFirstLoad) {
        setLoading(true);
      }

      setError(null);

      try {
        const res = await apiFetch(buildDashboardUrl(), {
          signal: options?.signal,
        });
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          return;
        }

        const json = await res.json();
        if (!json.success) {
          setError(json.error || "Dashboard error");
          return;
        }

        const { total, totalDays, totalTopModels, today, yesterday, daily, models, todayModels, dailyModels, topProviders, dailyProviders, heatmap, hourly, latency, timezoneOffsetMinutes: responseTimezoneOffsetMinutes } = json.data;

        setTotalDays(Number(totalDays) || 0);

        setStats(
          total?.[0]
            ? {
                totalInput: Number(total[0].totalInput || 0),
                totalOutput: Number(total[0].totalOutput || 0),
                totalInputCached: Number(total[0].totalInputCached || 0),
                totalInputUncached: Number(total[0].totalInputUncached || 0),
                totalCacheWrite: Number(total[0].totalCacheWrite || 0),
                count: Number(total[0].count || 0),
                totalCost: Number(total[0].totalCost || 0),
                costPerMillionTokens: Number(total[0].costPerMillionTokens || 0),
                costPerMillionInput: Number(total[0].costPerMillionInput || 0),
                costPerMillionCacheRead: Number(total[0].costPerMillionCacheRead || 0),
                costPerMillionCacheWrite: Number(total[0].costPerMillionCacheWrite || 0),
                costPerMillionOutput: Number(total[0].costPerMillionOutput || 0),
              }
            : null
        );
        if (total?.[0]?.lastActiveAt) {
          setLastActiveAt(new Date(total[0].lastActiveAt));
        }

        setTodayData(
          today
            ? {
                totalInput: Number(today.totalInput || 0),
                totalOutput: Number(today.totalOutput || 0),
                totalInputCached: Number(today.totalInputCached || 0),
                totalInputUncached: Number(today.totalInputUncached || 0),
                totalCacheWrite: Number(today.totalCacheWrite || 0),
                count: Number(today.count || 0),
                totalCost: Number(today.totalCost || 0),
                costPerMillionTokens: Number(today.costPerMillionTokens || 0),
                costPerMillionInput: Number(today.costPerMillionInput || 0),
                costPerMillionCacheRead: Number(today.costPerMillionCacheRead || 0),
                costPerMillionCacheWrite: Number(today.costPerMillionCacheWrite || 0),
                costPerMillionOutput: Number(today.costPerMillionOutput || 0),
              }
            : null
        );

        setYesterdayData(
          yesterday
            ? {
                totalInput: Number(yesterday.totalInput || 0),
                totalOutput: Number(yesterday.totalOutput || 0),
                totalInputCached: Number(yesterday.totalInputCached || 0),
                totalInputUncached: Number(yesterday.totalInputUncached || 0),
                totalCacheWrite: Number(yesterday.totalCacheWrite || 0),
                count: Number(yesterday.count || 0),
                totalCost: Number(yesterday.totalCost || 0),
                costPerMillionTokens: Number(yesterday.costPerMillionTokens || 0),
                costPerMillionInput: Number(yesterday.costPerMillionInput || 0),
                costPerMillionCacheRead: Number(yesterday.costPerMillionCacheRead || 0),
                costPerMillionCacheWrite: Number(yesterday.costPerMillionCacheWrite || 0),
                costPerMillionOutput: Number(yesterday.costPerMillionOutput || 0),
              }
            : null
        );

        setTopModels(
          models?.map((m: ModelStat) => ({
            group: m.group,
            canonicalId: m.canonicalId || m.group,
            displayName: m.displayName || m.group,
            totalInput: Number(m.totalInput || 0),
            totalOutput: Number(m.totalOutput || 0),
            totalInputCached: Number(m.totalInputCached || 0),
            totalInputUncached: Number(m.totalInputUncached || 0),
            totalCacheWrite: Number(m.totalCacheWrite || 0),
            count: Number(m.count || 0),
            totalCost: Number(m.totalCost || 0),
            costPerMillionTokens: Number(m.costPerMillionTokens || 0),
            costPerMillionInput: Number(m.costPerMillionInput || 0),
            costPerMillionCacheRead: Number(m.costPerMillionCacheRead || 0),
            costPerMillionCacheWrite: Number(m.costPerMillionCacheWrite || 0),
            costPerMillionOutput: Number(m.costPerMillionOutput || 0),
          })) ?? []
        );

        setTotalTopModels(
          totalTopModels?.slice(0, 5).map((m: ModelStat) => ({
            group: m.group,
            canonicalId: m.canonicalId || m.group,
            displayName: m.displayName || m.group,
            totalInput: Number(m.totalInput || 0),
            totalOutput: Number(m.totalOutput || 0),
            totalInputCached: Number(m.totalInputCached || 0),
            totalInputUncached: Number(m.totalInputUncached || 0),
            totalCacheWrite: Number(m.totalCacheWrite || 0),
            count: Number(m.count || 0),
            totalCost: Number(m.totalCost || 0),
            costPerMillionTokens: Number(m.costPerMillionTokens || 0),
            costPerMillionInput: Number(m.costPerMillionInput || 0),
            costPerMillionCacheRead: Number(m.costPerMillionCacheRead || 0),
            costPerMillionCacheWrite: Number(m.costPerMillionCacheWrite || 0),
            costPerMillionOutput: Number(m.costPerMillionOutput || 0),
          })) ?? []
        );

        setTodayTopModels(
          todayModels?.slice(0, 5).map((m: ModelStat) => ({
            group: m.group,
            canonicalId: m.canonicalId || m.group,
            displayName: m.displayName || m.group,
            totalInput: Number(m.totalInput || 0),
            totalOutput: Number(m.totalOutput || 0),
            totalInputCached: Number(m.totalInputCached || 0),
            totalInputUncached: Number(m.totalInputUncached || 0),
            totalCacheWrite: Number(m.totalCacheWrite || 0),
            count: Number(m.count || 0),
            totalCost: Number(m.totalCost || 0),
            costPerMillionTokens: Number(m.costPerMillionTokens || 0),
            costPerMillionInput: Number(m.costPerMillionInput || 0),
            costPerMillionCacheRead: Number(m.costPerMillionCacheRead || 0),
            costPerMillionCacheWrite: Number(m.costPerMillionCacheWrite || 0),
            costPerMillionOutput: Number(m.costPerMillionOutput || 0),
          })) ?? []
        );

        setDailyTopModels(dailyModels ?? {});

        setTopProviders(
          topProviders?.map((p: ProviderStat) => ({
            provider: p.provider,
            providerName: p.providerName || p.provider,
            totalInput: Number(p.totalInput || 0),
            totalInputCached: Number(p.totalInputCached || 0),
            totalOutput: Number(p.totalOutput || 0),
            totalCost: Number(p.totalCost || 0),
            count: Number(p.count || 0),
          })) ?? []
        );

        const parsedDailyProviders: Record<string, ProviderStat[]> = {};
        for (const [date, list] of Object.entries(
          (dailyProviders ?? {}) as Record<string, ProviderStat[]>
        )) {
          parsedDailyProviders[date] = list.map((p) => ({
            provider: p.provider,
            providerName: p.providerName || p.provider,
            totalInput: Number(p.totalInput || 0),
            totalInputCached: Number(p.totalInputCached || 0),
            totalOutput: Number(p.totalOutput || 0),
            totalCost: Number(p.totalCost || 0),
            count: Number(p.count || 0),
          }));
        }
        setDailyProviders(parsedDailyProviders);

        setDailyData(daily ?? []);
        setHeatmapData(heatmap ?? []);
        setHourlyData(hourly ?? []);
        setLatencyByModel(latency?.byModel ?? []);
        setLatencyDaily(latency?.daily ?? []);
        setDailyLatencyByModel(
          (latency?.dailyByModel ?? {}) as Record<string, LatencyModelStat[]>
        );
        setTimezoneOffsetMinutes(
          typeof responseTimezoneOffsetMinutes === "number"
            ? responseTimezoneOffsetMinutes
            : clientTimezoneOffsetMinutes
        );

        setLastUpdated(new Date());

        options?.onDataReady?.(performance.now());
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          aborted = true;
          return;
        }
        console.error("Fetch dashboard error:", err);
        setError("Network error");
      } finally {
        if (!aborted && !options?.skipLoading) {
          setLoading(false);
        }
        if (!aborted && !options?.skipRecordsRefresh) {
          setRecordsRefreshKey((k) => k + 1);
        }
      }
    },
    [buildDashboardUrl, clientTimezoneOffsetMinutes]
  );

  const refreshFilters = useCallback(
    async (onReady?: (endTime: number) => void) => {
      if (isMobile) {
        onReady?.(performance.now());
        return;
      }
      await Promise.allSettled([fetchProviders(), fetchModels(), fetchAgents()]);
      onReady?.(performance.now());
    },
    [fetchProviders, fetchModels, fetchAgents, isMobile]
  );

  const refreshAll = useCallback(
    async (options?: {
      skipLoading?: boolean;
      skipRecordsRefresh?: boolean;
      signal?: AbortSignal;
    }) => {
      const startTime = performance.now();
      let dashboardEndTime = 0;
      let filtersEndTime = 0;

      await Promise.allSettled([
        fetchDashboard({
          ...options,
          onDataReady: (endTime) => {
            dashboardEndTime = endTime;
          },
        }),
        refreshFilters((endTime) => {
          filtersEndTime = endTime;
        }),
      ]);

      if (dashboardEndTime > 0 && filtersEndTime > 0) {
        setRefreshDuration(Math.round(Math.max(dashboardEndTime, filtersEndTime) - startTime));
      }
    },
    [fetchDashboard, refreshFilters]
  );

  const scheduleRefresh = useCallback(
    (options?: { skipLoading?: boolean; skipRecordsRefresh?: boolean }) => {
      if (!isVisibleRef.current) return;

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }

      abortControllerRef.current = new AbortController();
      refreshTimeoutRef.current = setTimeout(() => {
        refreshAll({ ...options, signal: abortControllerRef.current?.signal });
      }, 150);
    },
    [refreshAll]
  );

  useEffect(() => {
    const saved = localStorage.getItem("token-tracker-daily-range");
    if (saved) {
      const parsed = Number(saved);
      if (DAILY_RANGE_OPTIONS.includes(parsed)) {
        setDailyRange(parsed);
        dailyRangeRef.current = parsed;
      }
    }
    setIsRangeInitialized(true);
  }, []);

  useEffect(() => {
    if (isRangeInitialized) {
      scheduleRefresh();
    }
  }, [isRangeInitialized, scheduleRefresh]);

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      setSelectedProvider(value);
      selectedProviderRef.current = value;
      scheduleRefresh({ skipLoading: true });
    },
    [scheduleRefresh]
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      setSelectedModel(value);
      selectedModelRef.current = value;
      scheduleRefresh({ skipLoading: true });
    },
    [scheduleRefresh]
  );

  const handleAgentChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      setSelectedAgent(value);
      selectedAgentRef.current = value;
      scheduleRefresh({ skipLoading: true });
    },
    [scheduleRefresh]
  );

  const handleDailyRangeChange = useCallback(
    (newRange: number) => {
      setDailyRange(newRange);
      dailyRangeRef.current = newRange;
      localStorage.setItem("token-tracker-daily-range", String(newRange));
      scheduleRefresh({ skipLoading: true });
    },
    [scheduleRefresh]
  );

  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        refreshAll({ skipLoading: true, skipRecordsRefresh: true });
      }
    }, 120000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      isVisibleRef.current = document.visibilityState === "visible";
      if (document.visibilityState === "visible") {
        refreshAll({ skipLoading: true, skipRecordsRefresh: true });
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [refreshAll]);

  useEffect(() => {
    const interval = setInterval(() => {
      setTick((n) => n + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const selectedModelName = useMemo(
    () => models.find((m) => m.id === selectedModel)?.name || selectedModel,
    [models, selectedModel]
  );

  const selectedAgentName = useMemo(
    () => agents.find((a) => a.id === selectedAgent)?.name || selectedAgent,
    [agents, selectedAgent]
  );

  return (
    <main className="min-h-screen bg-gray-50 p-4 pb-20 md:p-8 md:pb-8">
      <div className="md:hidden flex min-h-[calc(100dvh-6rem)] items-center justify-center">
          <div className="flex flex-col items-center gap-6 text-center">
            <h1 className="text-lg font-bold text-gray-900 truncate">
              Token Tracker
            </h1>
            <MobileSummary
              stats={stats}
              today={todayData}
              loading={loading}
              error={error}
            />
          </div>
        </div>
        <div className="hidden md:block max-w-7xl mx-auto">
          {lastActiveAt && (
            <p className="text-xs text-gray-400 mb-3">
              Last active token at {lastActiveAt.toLocaleString()}
            </p>
          )}

          <div className="sticky top-0 z-20 -mx-8 bg-gray-50 px-8 py-3 mb-6">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedAgent}
                onChange={handleAgentChange}
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="all">All Agents</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <select
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
              <select
                value={selectedModel}
                onChange={handleModelChange}
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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

        <section id="heatmap-section" className="scroll-mt-28">
          <UsageHeatmap data={heatmapData} loading={loading} timezoneOffsetMinutes={timezoneOffsetMinutes} />
        </section>

        <section id="stats-section" className="scroll-mt-28">
          <StatsCards stats={stats} totalDays={totalDays} loading={loading} error={error} topModels={totalTopModels} />
        </section>

        <section id="today-section" className="scroll-mt-28">
          <TodayOverview
            today={todayData}
            yesterday={yesterdayData}
            loading={loading}
            topModels={todayTopModels}
          />
        </section>

        <section id="trends-section" className="scroll-mt-28">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-4 gap-2">
            <h2 className="text-lg font-semibold">Last {dailyRange} Daily Usage</h2>
            <div className="inline-flex rounded-md overflow-hidden flex-shrink-0">
              {RANGE_OPTIONS.map((days, index) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => handleDailyRangeChange(days)}
                  aria-pressed={dailyRange === days}
                  className={`
                    px-2 md:px-3 py-1 text-xs md:text-sm font-medium transition-all active:scale-95 min-h-[40px] md:min-h-0
                    ${dailyRange === days
                      ? "bg-blue-600 text-white md:hover:bg-blue-700"
                      : "bg-gray-100 text-gray-600 md:hover:bg-blue-50 md:hover:text-blue-700"
                    }
                    ${index !== RANGE_OPTIONS.length - 1 ? "border-r border-gray-200" : ""}
                  `}
                >
                  {days}d
                </button>
              ))}
            </div>
          </div>
          <DailyUsageChart
            rawData={dailyData}
            loading={loading}
            error={error}
            range={dailyRange}
            topModels={topModels}
            dailyTopModels={dailyTopModels}
            topProviders={topProviders}
            dailyProviders={dailyProviders}
            hourly={hourlyData}
            latencyDaily={latencyDaily}
            latencyByModel={latencyByModel}
            dailyLatencyByModel={dailyLatencyByModel}
            timezoneOffsetMinutes={timezoneOffsetMinutes}
          />
        </section>

        <section id="records-section" className="scroll-mt-28">
          <div className="bg-white rounded-lg shadow overflow-hidden mb-8">
            <button
              onClick={() => setRecordsVisible(!recordsVisible)}
              className="w-full px-6 py-4 flex justify-between items-center hover:bg-gray-50 transition-colors"
            >
              <div className="text-left">
                <h2 className="text-lg font-semibold">Recent Records</h2>
                <div className="flex flex-wrap gap-x-3 text-xs text-gray-400 mt-1">
                  {selectedAgent !== "all" && (
                    <span>Agent: {selectedAgentName}</span>
                  )}
                  {selectedModel !== "all" && (
                    <span>Model: {selectedModelName}</span>
                  )}
                </div>
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
                selectedModelName={selectedModelName}
                selectedAgent={selectedAgent}
                refreshKey={recordsRefreshKey}
                showHeader={false}
              />
            )}
          </div>
        </section>

        <div className="mt-8 py-4 border-t border-gray-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-2 text-sm text-gray-500">
          <span>
            Updated {formatTimeAgo(lastUpdated)}
            {refreshDuration !== null && ` · Refreshed in ${refreshDuration}ms`}
          </span>
          {priceUpdateTime}
        </div>

        <PriceSimulatorModal
          isOpen={isSimulatorOpen}
          onClose={() => setIsSimulatorOpen(false)}
          stats={stats}
          todayData={todayData}
          dailyData={dailyData}
          totalDays={totalDays}
          loading={loading}
          timezoneOffsetMinutes={timezoneOffsetMinutes}
        />
      </div>
    </main>
  );
}
