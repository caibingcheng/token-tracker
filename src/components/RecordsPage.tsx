"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import RecordsTable from "./RecordsTable";
import { apiFetch } from "@/lib/client/api-client";
import { useSidebarActions, NumberFormatToggle } from "./AppSidebar";

type FilterKey = "provider" | "model" | "agent";

interface FilterOption {
  id: string;
  name: string;
}

// 顺序与 Dashboard 筛选栏一致：Agent → Provider → Model
const FILTERS: Array<{ key: FilterKey; endpoint: string; allLabel: string }> = [
  { key: "agent", endpoint: "/api/agents", allLabel: "All Agents" },
  { key: "provider", endpoint: "/api/providers", allLabel: "All Providers" },
  { key: "model", endpoint: "/api/models", allLabel: "All Models" },
];

const PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const;

export default function RecordsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setSidebarActions } = useSidebarActions();

  const [options, setOptions] = useState<Record<FilterKey, FilterOption[]>>({
    provider: [],
    model: [],
    agent: [],
  });
  const [pageSize, setPageSize] = useState<number>(100);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const selected = useMemo(
    () => ({
      provider: searchParams.get("provider") ?? "all",
      model: searchParams.get("model") ?? "all",
      agent: searchParams.get("agent") ?? "all",
    }),
    [searchParams]
  );
  const hasFilter =
    selected.provider !== "all" ||
    selected.model !== "all" ||
    selected.agent !== "all";

  const handleRefreshingChange = useCallback((value: boolean) => {
    setRefreshing(value);
  }, []);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  // 开启自动刷新时立即取一次，避免等满 15 秒才有数据
  const toggleAutoRefresh = useCallback(() => {
    setAutoRefresh((enabled) => {
      if (!enabled) setRefreshKey((key) => key + 1);
      return !enabled;
    });
  }, []);

  // 桌面侧栏底部放数字格式切换：RecordsTable 的 123 / K/M/B 显示依赖该全局开关
  useEffect(() => {
    setSidebarActions(<NumberFormatToggle />);
    return () => setSidebarActions(null);
  }, [setSidebarActions]);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled(
      FILTERS.map((filter) =>
        apiFetch(filter.endpoint)
          .then((res) => res.json())
          .then((json: { success?: boolean; data?: FilterOption[] }) =>
            json.success && Array.isArray(json.data) ? json.data : []
          )
      )
    ).then((results) => {
      if (cancelled) return;
      const next: Record<FilterKey, FilterOption[]> = {
        provider: [],
        model: [],
        agent: [],
      };
      FILTERS.forEach((filter, index) => {
        const result = results[index];
        if (result && result.status === "fulfilled") {
          next[filter.key] = result.value;
        }
      });
      setOptions(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // URL 变更的乐观快照：连续快速修改多个下拉时，第二次不能基于上一次 render 的旧 searchParams 复制，
  // 否则会把前一次写入的参数覆盖掉
  const queryRef = useRef(searchParams.toString());
  useEffect(() => {
    queryRef.current = searchParams.toString();
  }, [searchParams]);

  const setFilter = useCallback(
    (key: FilterKey, value: string) => {
      const params = new URLSearchParams(queryRef.current);
      if (value === "all") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      const query = params.toString();
      queryRef.current = query;
      // replace: 筛选变化不进浏览器历史，避免后退键要按很多次才离开页面
      router.replace(query ? `/records?${query}` : "/records", { scroll: false });
    },
    [router]
  );

  const resetFilters = useCallback(() => {
    queryRef.current = "";
    router.replace("/records", { scroll: false });
  }, [router]);

  return (
    <main className="min-h-screen bg-gray-50 p-4 pb-20 md:p-8 md:pb-8">
      <div className="max-w-7xl mx-auto">
        <div className="sticky top-0 z-20 -mx-4 mb-6 bg-gray-50 px-4 py-3 md:-mx-8 md:px-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {FILTERS.map((filter) => (
                <select
                  key={filter.key}
                  value={selected[filter.key]}
                  onChange={(e) => setFilter(filter.key, e.target.value)}
                  aria-label={filter.allLabel}
                  className="min-h-[40px] min-w-0 max-w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 md:min-h-0"
                >
                  <option value="all">{filter.allLabel}</option>
                  {options[filter.key].map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              ))}
              {hasFilter && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="inline-flex min-h-[40px] items-center rounded border border-gray-300 bg-white px-3 text-sm font-medium text-gray-600 shadow-sm hover:bg-gray-50 md:min-h-0 md:py-1.5"
                >
                  Reset
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-gray-600">
                Rows
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  aria-label="Rows per page"
                  className="h-10 min-w-0 rounded border border-gray-300 bg-white px-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 md:h-8 md:text-xs"
                >
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={refresh}
                disabled={refreshing}
                title="Refresh"
                className={`inline-flex h-10 items-center justify-center rounded px-3 text-sm font-medium transition-colors bg-gray-100 disabled:cursor-default md:h-8 md:text-xs ${
                  refreshing
                    ? "text-blue-600 animate-pulse"
                    : "text-gray-600 hover:bg-gray-200"
                }`}
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={toggleAutoRefresh}
                aria-pressed={autoRefresh}
                title={`Auto refresh every 15s: ${autoRefresh ? "on" : "off"}`}
                className={`inline-flex h-10 items-center justify-center rounded px-3 text-sm font-medium transition-colors md:h-8 md:text-xs ${
                  autoRefresh
                    ? "text-blue-700 bg-blue-100"
                    : "text-gray-600 bg-gray-100 hover:bg-gray-200"
                }`}
              >
                Auto 15s
              </button>
            </div>
          </div>
        </div>

        <RecordsTable
          selectedProvider={selected.provider}
          selectedModel={selected.model}
          selectedAgent={selected.agent}
          pageSize={pageSize}
          autoRefresh={autoRefresh}
          refreshKey={refreshKey}
          onRefreshingChange={handleRefreshingChange}
        />
      </div>
    </main>
  );
}
