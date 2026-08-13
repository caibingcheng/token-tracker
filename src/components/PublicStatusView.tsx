"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import StatsCards, { Stats } from "./StatsCards";
import TodayOverview, { TodayData } from "./TodayOverview";
import DailyUsageChart, { DailyData } from "./DailyUsageChart";
import UsageHeatmap, { HeatmapData } from "./UsageHeatmap";
import { NumberFormatProvider } from "./NumberFormatContext";
import { getClientTimezoneOffsetMinutes } from "@/lib/timezone-utils";

// 未登录公开面板。数据来自 /status/data 公开端点（服务端按 elements 裁剪）；
// 本组件按元素开关条件渲染。数据端点 404（status_page_config 未启用）时回调 onDisabled。
// preview 模式：登录后预览公开效果（ApiKeyGate 传入），404 时显示错误条而非回调 onDisabled，
// header 的 Login 按钮替换为「← Back to Dashboard」（onExit）。

interface PublicStatusViewProps {
  onDisabled: () => void;
  onLoginRequest: () => void;
  preview?: boolean;
  onExit?: () => void;
}

interface StatusElements {
  total: boolean;
  today: boolean;
  daily: boolean;
  heatmap: boolean;
  hourly: boolean;
  topModels: boolean;
  cost: boolean;
}

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

interface StatusData {
  elements: StatusElements;
  total: Stats | null;
  totalDays: number;
  today: TodayData | null;
  yesterday: TodayData | null;
  daily: DailyData[];
  heatmap: HeatmapData[];
  hourly: DailyData[];
  topModels: ModelStat[];
  totalTopModels: ModelStat[];
  todayModels: ModelStat[];
  dailyModels: Record<string, ModelStat[]>;
  timezoneOffsetMinutes: number;
}

function toNumber(value: unknown): number {
  return Number(value || 0);
}

function mapStats(value: unknown): Stats | null {
  if (!value) return null;
  const v = value as Record<string, unknown>;
  return {
    totalInput: toNumber(v.totalInput),
    totalOutput: toNumber(v.totalOutput),
    totalInputCached: toNumber(v.totalInputCached),
    totalInputUncached: toNumber(v.totalInputUncached),
    totalCacheWrite: toNumber(v.totalCacheWrite),
    count: toNumber(v.count),
    totalCost: toNumber(v.totalCost),
    costPerMillionTokens: toNumber(v.costPerMillionTokens),
    costPerMillionInput: toNumber(v.costPerMillionInput),
    costPerMillionCacheRead: toNumber(v.costPerMillionCacheRead),
    costPerMillionCacheWrite: toNumber(v.costPerMillionCacheWrite),
    costPerMillionOutput: toNumber(v.costPerMillionOutput),
  };
}

function mapToday(value: unknown): TodayData | null {
  if (!value) return null;
  return mapStats(value);
}

function mapModel(value: unknown): ModelStat {
  const v = value as Record<string, unknown>;
  return {
    group: String(v.group ?? ""),
    canonicalId: String(v.canonicalId ?? v.group ?? ""),
    displayName: String(v.displayName ?? v.group ?? ""),
    totalInput: toNumber(v.totalInput),
    totalOutput: toNumber(v.totalOutput),
    totalInputCached: toNumber(v.totalInputCached),
    totalInputUncached: toNumber(v.totalInputUncached),
    totalCacheWrite: toNumber(v.totalCacheWrite),
    count: toNumber(v.count),
    totalCost: toNumber(v.totalCost),
    costPerMillionTokens: toNumber(v.costPerMillionTokens),
    costPerMillionInput: toNumber(v.costPerMillionInput),
    costPerMillionCacheRead: toNumber(v.costPerMillionCacheRead),
    costPerMillionCacheWrite: toNumber(v.costPerMillionCacheWrite),
    costPerMillionOutput: toNumber(v.costPerMillionOutput),
  };
}

export default function PublicStatusView({
  onDisabled,
  onLoginRequest,
  preview = false,
  onExit,
}: PublicStatusViewProps) {
  const clientTimezoneOffsetMinutes = useMemo(
    () => getClientTimezoneOffsetMinutes(),
    []
  );
  const [data, setData] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const onDisabledRef = useRef(onDisabled);
  onDisabledRef.current = onDisabled;
  const previewRef = useRef(preview);
  previewRef.current = preview;

  const fetchData = useCallback(
    async (options?: { signal?: AbortSignal }) => {
      setError(null);
      try {
        const url = new URL("/status/data", window.location.origin);
        url.searchParams.set("tzOffset", String(clientTimezoneOffsetMinutes));
        const res = await fetch(url.toString(), { signal: options?.signal });
        if (res.status === 404) {
          if (previewRef.current) {
            setError("Status page is not enabled");
            return;
          }
          onDisabledRef.current();
          return;
        }
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          return;
        }
        const json = await res.json();
        if (!json.success) {
          setError(json.error || "Status error");
          return;
        }
        const d = json.data as Record<string, unknown>;
        const elements = (d.elements ?? {}) as StatusElements;
        setData({
          elements,
          total: mapStats(d.total),
          totalDays: toNumber(d.totalDays),
          today: mapToday(d.today),
          yesterday: mapToday(d.yesterday),
          daily: Array.isArray(d.daily) ? (d.daily as DailyData[]) : [],
          heatmap: Array.isArray(d.heatmap) ? (d.heatmap as HeatmapData[]) : [],
          hourly: Array.isArray(d.hourly) ? (d.hourly as DailyData[]) : [],
          topModels: Array.isArray(d.topModels) ? (d.topModels as unknown[]).map(mapModel) : [],
          totalTopModels: Array.isArray(d.totalTopModels) ? (d.totalTopModels as unknown[]).map(mapModel) : [],
          todayModels: Array.isArray(d.todayModels) ? (d.todayModels as unknown[]).map(mapModel) : [],
          dailyModels:
            d.dailyModels && typeof d.dailyModels === "object"
              ? Object.fromEntries(
                  Object.entries(d.dailyModels as Record<string, unknown[]>).map(
                    ([date, models]) => [
                      date,
                      Array.isArray(models) ? models.map(mapModel) : [],
                    ]
                  )
                )
              : {},
          timezoneOffsetMinutes:
            typeof d.timezoneOffsetMinutes === "number"
              ? d.timezoneOffsetMinutes
              : clientTimezoneOffsetMinutes,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        console.error("Fetch status data error:", err);
        setError("Network error");
      } finally {
        setLoading(false);
      }
    },
    [clientTimezoneOffsetMinutes]
  );

  useEffect(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    fetchData({ signal: abortControllerRef.current?.signal });
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [fetchData]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchData();
      }
    }, 120000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const elements = data?.elements;
  const showTopModels = !!elements?.topModels;
  const showCost = !!elements?.cost;

  return (
    <NumberFormatProvider>
      <main className="min-h-screen bg-gray-50 p-4 pb-8 md:p-8">
        <div className="max-w-7xl mx-auto">
          <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <h1 className="text-xl md:text-3xl font-bold truncate">
                Token Tracker
              </h1>
              <p className="text-xs text-gray-400 mt-1">
                {preview
                  ? "Public view preview · updated periodically"
                  : "Public usage overview · updated periodically"}
              </p>
            </div>
            {preview ? (
              <button
                type="button"
                onClick={onExit}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-600 shadow-sm hover:bg-gray-50 hover:text-gray-800 active:scale-[0.98] transition-all min-h-[40px]"
              >
                ← Back to Dashboard
              </button>
            ) : (
              <button
                type="button"
                onClick={onLoginRequest}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 active:scale-[0.98] transition-all min-h-[40px]"
              >
                Login
              </button>
            )}
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-8">
              <p className="text-red-600">{error}</p>
            </div>
          )}

          {!error && data && (
            <>
              {elements?.heatmap && (
                <section className="mb-8">
                  <UsageHeatmap
                    data={data.heatmap}
                    loading={loading}
                    timezoneOffsetMinutes={data.timezoneOffsetMinutes}
                  />
                </section>
              )}

              {elements?.total && (
                <section>
                  <StatsCards
                    stats={data.total}
                    totalDays={data.totalDays}
                    loading={loading}
                    error={error}
                    showCost={showCost}
                    showTopModels={showTopModels}
                    topModels={showTopModels ? data.totalTopModels : undefined}
                  />
                </section>
              )}

              {elements?.today && (
                <section>
                  <TodayOverview
                    today={data.today}
                    yesterday={data.yesterday}
                    loading={loading}
                    showCost={showCost}
                    showTopModels={showTopModels}
                    topModels={showTopModels ? data.todayModels : undefined}
                  />
                </section>
              )}

              {elements?.daily && (
                <section>
                  <DailyUsageChart
                    rawData={data.daily}
                    loading={loading}
                    error={error}
                    range={30}
                    showCost={showCost}
                    showHourly={!!elements.hourly}
                    showTopModels={showTopModels}
                    topModels={showTopModels ? data.topModels : undefined}
                    dailyTopModels={showTopModels ? data.dailyModels : undefined}
                    hourly={elements.hourly ? data.hourly : undefined}
                    timezoneOffsetMinutes={data.timezoneOffsetMinutes}
                  />
                </section>
              )}
            </>
          )}

          <div className="mt-8 py-4 border-t border-gray-200 text-center text-xs text-gray-400">
            Powered by Token Tracker
          </div>
        </div>
      </main>
    </NumberFormatProvider>
  );
}
