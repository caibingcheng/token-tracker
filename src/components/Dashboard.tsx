"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import Link from "next/link";
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
import {
  NumberFormatProvider,
  useNumberFormat,
} from "./NumberFormatContext";
import { getClientTimezoneOffsetMinutes } from "@/lib/timezone-utils";
import { apiFetch } from "@/lib/client/api-client";
import { usePublicPreview } from "./ApiKeyGate";

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

interface SectionNavItem {
  id: string;
  label: string;
  children?: SectionNavItem[];
}

const SECTIONS: SectionNavItem[] = [
  { id: "heatmap-section", label: "Heatmap" },
  { id: "stats-section", label: "Stats" },
  { id: "today-section", label: "Today" },
  {
    id: "trends-section",
    label: "Trends",
    children: [
      { id: "trends-token", label: "Token" },
      { id: "trends-cost", label: "Cost" },
      { id: "trends-latency", label: "Latency" },
    ],
  },
  { id: "records-section", label: "Records" },
];

function SectionNav() {
  const [activeId, setActiveId] = useState<string | null>(SECTIONS[0]?.id ?? null);
  const [activeChildId, setActiveChildId] = useState<string | null>(null);
  const isClickScrollingRef = useRef(false);
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  const updateActiveFromScroll = useCallback(() => {
    if (isClickScrollingRef.current) return;

    // 以 viewport 顶部往下 25% 处作为当前栏目判定线
    const scrollOffset = window.innerHeight * 0.25;
    let currentId = SECTIONS[0]?.id ?? null;
    for (const { id } of SECTIONS) {
      const el = document.getElementById(id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top <= scrollOffset) {
        currentId = id;
      } else {
        break;
      }
    }
    setActiveId(currentId);

    // Trends 内部子锚点判定（卡片条件渲染，可能不存在）
    let currentChildId: string | null = null;
    if (currentId === "trends-section") {
      const trends = SECTIONS.find((s) => s.id === currentId);
      for (const child of trends?.children ?? []) {
        const el = document.getElementById(child.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top <= scrollOffset) {
          currentChildId = child.id;
        } else {
          break;
        }
      }
    }
    setActiveChildId(currentChildId);
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        updateActiveFromScroll();
        rafRef.current = null;
      });
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    updateActiveFromScroll();

    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [updateActiveFromScroll]);

  useEffect(() => {
    return () => {
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
      }
    };
  }, []);

  const scrollTo = (id: string) => {
    const isChild = SECTIONS.some((s) =>
      (s.children ?? []).some((c) => c.id === id)
    );
    const parentId = isChild ? "trends-section" : id;

    setActiveId(parentId);
    setActiveChildId(isChild ? id : null);
    isClickScrollingRef.current = true;
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
    }
    clickTimeoutRef.current = setTimeout(() => {
      isClickScrollingRef.current = false;
      updateActiveFromScroll();
    }, 600);

    // 子锚点对应卡片可能未渲染（条件显示），回退滚动到 Trends section
    const target =
      document.getElementById(id) ??
      (isChild ? document.getElementById("trends-section") : null);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <nav
      className="hidden md:flex fixed left-6 top-1/2 -translate-y-1/2 z-40 flex-col gap-4"
      aria-label="Section navigation"
    >
      {SECTIONS.map(({ id, label, children }) => {
        const isActive = activeId === id;
        return (
          <div key={id} className="flex flex-col">
            <button
              type="button"
              onClick={() => scrollTo(id)}
              className="group flex items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 rounded-md"
              aria-current={isActive ? "location" : undefined}
            >
              <span
                className={`
                  inline-flex h-2 w-2 rounded-full transition-all duration-300 ease-out
                  ${isActive
                    ? "bg-blue-600 scale-125"
                    : "bg-gray-300 group-hover:bg-blue-500 group-hover:scale-110"
                  }
                `}
              />
              <span
                className={`
                  text-sm transition-all duration-300 ease-out
                  ${isActive
                    ? "translate-x-0 scale-105 font-medium text-gray-900"
                    : "text-gray-400 group-hover:text-gray-700 group-hover:translate-x-0.5 group-hover:scale-105"
                  }
                `}
              >
                {label}
              </span>
            </button>
            {children && (
              <div className="ml-5 mt-1 space-y-0.5 border-l border-gray-200 pl-3">
                {children.map((child) => {
                  const isChildActive =
                    isActive && activeChildId === child.id;
                  return (
                    <button
                      key={child.id}
                      type="button"
                      onClick={() => scrollTo(child.id)}
                      className="group flex items-center gap-2 rounded-md py-0.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
                      aria-current={isChildActive ? "location" : undefined}
                    >
                      <span
                        className={`
                          inline-flex h-1.5 w-1.5 rounded-full transition-all duration-300 ease-out
                          ${isChildActive
                            ? "bg-blue-500"
                            : "bg-gray-300 group-hover:bg-blue-400"
                          }
                        `}
                      />
                      <span
                        className={`
                          text-xs transition-all duration-300 ease-out
                          ${isChildActive
                            ? "font-medium text-blue-700"
                            : "text-gray-400 group-hover:text-gray-600"
                          }
                        `}
                      >
                        {child.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function NumberFormatToggle() {
  const { compact, setCompact } = useNumberFormat();

  return (
    <div
      className="inline-flex items-center rounded-md overflow-hidden border border-gray-300 bg-white"
      role="group"
      aria-label="Number format"
    >
      <button
        type="button"
        onClick={() => setCompact(false)}
        aria-pressed={!compact}
        className={`px-3 py-1.5 text-xs font-medium transition-colors ${
          !compact
            ? "bg-blue-600 text-white"
            : "text-gray-600 hover:bg-gray-50"
        }`}
      >
        123
      </button>
      <button
        type="button"
        onClick={() => setCompact(true)}
        aria-pressed={compact}
        className={`px-3 py-1.5 text-xs font-medium transition-colors ${
          compact
            ? "bg-blue-600 text-white"
            : "text-gray-600 hover:bg-gray-50"
        }`}
      >
        K/M/B
      </button>
    </div>
  );
}

export default function Dashboard({ priceUpdateTime }: DashboardProps) {
  const { togglePreview } = usePublicPreview();
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
    <NumberFormatProvider>
      <main className="min-h-screen bg-gray-50 p-4 pb-20 md:p-8 md:pb-8">
        <SectionNav />
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
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-2">
            <div className="flex min-w-0 flex-1 items-start justify-between gap-2 w-full sm:w-auto">
              <div className="min-w-0">
                <h1 className="text-xl md:text-3xl font-bold truncate">
                  Token Tracker Dashboard
                </h1>
                {lastActiveAt && (
                  <p className="text-xs text-gray-400 mt-1">
                    Last active token at {lastActiveAt.toLocaleString()}
                  </p>
                )}
              </div>
            </div>

            <div className="hidden sm:flex flex-row items-center gap-3">
              <NumberFormatToggle />
              <button
                type="button"
                onClick={() => setIsSimulatorOpen(true)}
                className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
              >
                Price Simulation
              </button>
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
              <button
                type="button"
                onClick={togglePreview}
                className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                title="Preview the public status page"
              >
                Public View
              </button>
              <Link
                href="/admin"
                className="text-sm text-gray-400 hover:text-blue-600 transition-colors"
              >
                Admin →
              </Link>
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
  </NumberFormatProvider>
);
}
