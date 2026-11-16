"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import RecordsTable from "./RecordsTable";
import ColumnPicker, { ColumnChecklist } from "./ColumnPicker";
import MultiSelect from "./MultiSelect";
import { DEFAULT_RECORD_COLUMNS, RECORD_COLUMNS, normalizeRecordColumns, type RecordColumnId } from "@/lib/records-columns";
import { apiFetch } from "@/lib/client/api-client";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import ModalPortal from "./ModalPortal";
import { useSidebarActions, NumberFormatToggle } from "./AppSidebar";

type FilterKey = "provider" | "model" | "agent";

interface FilterOption {
  id: string;
  name: string;
}

// 顺序与 Dashboard 筛选栏一致：Agent → Provider → Model
const FILTERS: Array<{ key: FilterKey; label: string; endpoint: string; allLabel: string }> = [
  { key: "agent", label: "Agent", endpoint: "/api/agents", allLabel: "All Agents" },
  { key: "provider", label: "Provider", endpoint: "/api/providers", allLabel: "All Providers" },
  { key: "model", label: "Model", endpoint: "/api/models", allLabel: "All Models" },
];

// URL 里的空串 / "all"（旧链接）视为未筛选
function isActiveFilter(value: string): boolean {
  return value !== "" && value !== "all";
}

const PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const;

function FilterIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

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
  // 自动刷新默认开启（页面可见时每 15s 静默刷新，可手动关掉）
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // 列可见性：DB 配置（records_columns），加载前先按默认全显示
  const [visibleColumns, setVisibleColumns] = useState<RecordColumnId[]>(DEFAULT_RECORD_COLUMNS);
  const [columnsError, setColumnsError] = useState<string | null>(null);
  // 移动端筛选抽屉（筛选 + 行数 + 列可见性）
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // URL 里每个维度可带多个同名参数（?agent=a&agent=b）；空数组 = 不筛选
  const selected = useMemo(
    () => ({
      provider: searchParams.getAll("provider").filter(isActiveFilter),
      model: searchParams.getAll("model").filter(isActiveFilter),
      agent: searchParams.getAll("agent").filter(isActiveFilter),
    }),
    [searchParams]
  );
  const hasFilter =
    selected.provider.length > 0 ||
    selected.model.length > 0 ||
    selected.agent.length > 0;
  const activeFilterCount = FILTERS.filter((filter) => selected[filter.key].length > 0).length;

  // 移动端抽屉：Esc 关闭（抽屉是浮层，Esc 是键盘用户的退出路径）
  useEffect(() => {
    if (!filterSheetOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterSheetOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [filterSheetOpen]);
  useBodyScrollLock(filterSheetOpen);

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

  // 列可见性：打开页面读 DB 配置，改动即时落库；失败回退上一次成功的值
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/admin/settings/records-columns")
      .then((res) => res.json())
      .then((json: { success?: boolean; data?: { columns?: unknown } }) => {
        if (cancelled || !json.success) return;
        setVisibleColumns(normalizeRecordColumns(json.data?.columns));
      })
      .catch(() => {
        // 读失败保持默认全显示（不阻塞表格）
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const columnsRef = useRef<RecordColumnId[]>(DEFAULT_RECORD_COLUMNS);
  useEffect(() => {
    columnsRef.current = visibleColumns;
  }, [visibleColumns]);

  const changeColumns = useCallback((next: RecordColumnId[]) => {
    const previous = columnsRef.current;
    columnsRef.current = next;
    setVisibleColumns(next);
    setColumnsError(null);
    apiFetch("/api/admin/settings/records-columns", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ columns: next }),
    })
      .then(async (res) => {
        if (res.ok) return;
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error || `HTTP ${res.status}`);
      })
      .catch((err: unknown) => {
        columnsRef.current = previous;
        setVisibleColumns(previous);
        setColumnsError(err instanceof Error ? err.message : "Failed to save columns");
      });
  }, []);

  // URL 变更的乐观快照：连续快速修改多个下拉时，第二次不能基于上一次 render 的旧 searchParams 复制，
  // 否则会把前一次写入的参数覆盖掉
  const queryRef = useRef(searchParams.toString());
  useEffect(() => {
    queryRef.current = searchParams.toString();
  }, [searchParams]);

  const setFilter = useCallback(
    (key: FilterKey, values: string[]) => {
      const params = new URLSearchParams(queryRef.current);
      params.delete(key);
      for (const value of values) params.append(key, value);
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
      <div className="w-full">
        <div className="sticky top-0 z-20 -mx-4 mb-4 bg-gray-50 px-4 py-3 md:-mx-8 md:mb-6 md:px-8">
          {/* 移动端：一行「筛选 / 刷新 / 自动」；筛选、行数、列可见性收进底部抽屉 */}
          <div className="flex items-center gap-2 md:hidden">
            <button
              type="button"
              onClick={() => setFilterSheetOpen(true)}
              className="inline-flex min-h-[40px] min-w-0 flex-1 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 shadow-sm active:scale-[0.99]"
            >
              <FilterIcon />
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1.5 text-[11px] font-semibold tabular-nums text-white">
                  {activeFilterCount}
                </span>
              )}
              <span className="ml-auto text-gray-400">
                <ChevronDownIcon />
              </span>
            </button>
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              aria-label="Refresh"
              className={`inline-flex h-10 w-10 items-center justify-center rounded-lg transition-colors bg-gray-100 disabled:cursor-default ${
                refreshing ? "text-blue-600 animate-pulse" : "text-gray-600"
              }`}
            >
              <RefreshIcon />
            </button>
            <button
              type="button"
              onClick={toggleAutoRefresh}
              aria-pressed={autoRefresh}
              aria-label={`Auto refresh every 15s: ${autoRefresh ? "on" : "off"}`}
              className={`inline-flex h-10 shrink-0 items-center justify-center rounded-lg px-3 text-xs font-medium transition-colors ${
                autoRefresh
                  ? "text-blue-700 bg-blue-100"
                  : "text-gray-600 bg-gray-100"
              }`}
            >
              Auto 15s
            </button>
          </div>

          {/* 桌面端：筛选栏横排（移动端已换为上面的抽屉入口） */}
          <div className="hidden md:flex md:flex-wrap md:items-center md:justify-between md:gap-2">
            <div className="grid grid-cols-3 gap-2 md:flex md:flex-wrap md:items-center md:gap-2">
              {FILTERS.map((filter) => (
                <MultiSelect
                  key={filter.key}
                  label={filter.label}
                  allLabel={filter.allLabel}
                  options={options[filter.key]}
                  value={selected[filter.key]}
                  onChange={(next) => setFilter(filter.key, next)}
                />
              ))}
              {hasFilter && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="hidden min-h-[40px] items-center rounded border border-gray-300 bg-white px-3 text-sm font-medium text-gray-600 shadow-sm hover:bg-gray-50 md:inline-flex md:min-h-0 md:py-1.5"
                >
                  Reset
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <ColumnPicker
                columns={RECORD_COLUMNS}
                value={visibleColumns}
                onChange={changeColumns}
                error={columnsError}
              />
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <span className="hidden md:inline">Rows</span>
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  aria-label="Rows per page"
                  className="h-10 min-w-0 rounded border border-gray-300 bg-white px-2 text-base md:text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 md:h-8 md:text-xs"
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
                className={`inline-flex h-10 items-center justify-center gap-1 rounded px-3 text-sm font-medium transition-colors bg-gray-100 disabled:cursor-default md:h-8 md:text-xs ${
                  refreshing
                    ? "text-blue-600 animate-pulse"
                    : "text-gray-600 hover:bg-gray-200"
                }`}
              >
                {/* 刷新与自动刷新：移动端入口在抽屉外的顶栏，这里只服务桌面 */}
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

        {/* 移动端筛选抽屉：筛选 / 行数 / 列可见性（桌面端这些控件直接在顶栏）。
            z-50 与全站弹窗同层（MobileTabBar 已降到 z-40），抽屉才能盖住底栏 */}
        {filterSheetOpen && (
          <ModalPortal>
          <div className="fixed inset-0 z-50 md:hidden">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setFilterSheetOpen(false)}
              aria-hidden="true"
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Filters"
              className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl bg-white shadow-xl"
            >
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                <h2 className="text-base font-semibold text-gray-900">Filters</h2>
                <button
                  type="button"
                  onClick={() => setFilterSheetOpen(false)}
                  aria-label="Close filters"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-gray-500 active:bg-gray-100"
                >
                  <CloseIcon />
                </button>
              </div>

              <div className="flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
                <div className="space-y-3">
                  {FILTERS.map((filter) => (
                    <div key={filter.key}>
                      <span className="mb-1 block text-xs font-medium uppercase text-gray-500">
                        {filter.label}
                      </span>
                      <MultiSelect
                        label={filter.label}
                        allLabel={filter.allLabel}
                        options={options[filter.key]}
                        value={selected[filter.key]}
                        onChange={(next) => setFilter(filter.key, next)}
                      />
                    </div>
                  ))}
                </div>

                <div>
                  <span className="mb-2 block text-xs font-medium uppercase text-gray-500">
                    Rows per page
                  </span>
                  <div className="grid grid-cols-4 gap-2">
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <button
                        key={size}
                        type="button"
                        onClick={() => setPageSize(size)}
                        aria-pressed={pageSize === size}
                        className={`min-h-[44px] rounded-lg text-sm font-medium tabular-nums transition-colors ${
                          pageSize === size
                            ? "bg-blue-600 text-white"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <span className="mb-2 block text-xs font-medium uppercase text-gray-500">
                    Columns
                  </span>
                  <div className="rounded-lg bg-gray-50 p-1">
                    <ColumnChecklist
                      columns={RECORD_COLUMNS}
                      value={visibleColumns}
                      onChange={changeColumns}
                      error={columnsError}
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 border-t border-gray-100 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
                <button
                  type="button"
                  onClick={resetFilters}
                  disabled={!hasFilter}
                  className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 disabled:opacity-40"
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={() => setFilterSheetOpen(false)}
                  className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
          </ModalPortal>
        )}

        <RecordsTable
          selectedProvider={selected.provider}
          selectedModel={selected.model}
          selectedAgent={selected.agent}
          pageSize={pageSize}
          autoRefresh={autoRefresh}
          refreshKey={refreshKey}
          visibleColumns={visibleColumns}
          onRefreshingChange={handleRefreshingChange}
        />
      </div>
    </main>
  );
}
