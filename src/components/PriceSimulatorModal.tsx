"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Stats } from "./StatsCards";
import { TodayData } from "./TodayOverview";
import { DailyData } from "./DailyUsageChart";
import { type ModelPricing } from "@/lib/cost-utils";
import {
  parseCacheRateInput,
  parsePriceInput,
  simulatePricing,
} from "@/lib/price-simulation";
import { formatNumber, toNum } from "@/lib/number-utils";
import { useNumberFormat } from "./NumberFormatContext";
import {
  getClientTimezoneOffsetMinutes,
  localDateKeyFromUtcDate,
} from "@/lib/timezone-utils";
import { apiFetch } from "@/lib/client/api-client";

interface FilterOption {
  id: string;
  name: string;
}

interface PriceSimulatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 打开时的默认数据过滤（同步 dashboard 当前状态） */
  defaultAgent: string;
  defaultProvider: string;
  defaultModel: string;
  agents: FilterOption[];
  providers: FilterOption[];
  models: FilterOption[];
}

interface RangeBucket {
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalCacheWrite: number;
  totalCost: number;
}

interface SectionData {
  id: string;
  title: string;
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalCacheWrite: number;
  actualCost: number;
  simulatedCost: number;
  actualCacheRate: number;
  simulatedCacheRate: number;
}

interface ModelOption {
  canonicalId: string;
  displayName: string;
}

interface ProviderGroup {
  provider: string;
  models: ModelOption[];
}

interface ModelsDevProvider {
  id: string;
  name: string;
}

interface DashboardSnapshot {
  total: Stats | null;
  today: TodayData | null;
  daily: DailyData[];
  totalDays: number;
}

interface SectionSource {
  id: string;
  title: string;
  data: RangeBucket | null;
}

const UNCATEGORIZED = "Uncategorized";
const RANGE_OPTIONS = [3, 7, 14, 30];
const PRICE_FIELDS = [
  { key: "input", label: "Input" },
  { key: "cacheRead", label: "Cache Read" },
  { key: "cacheWrite", label: "Cache Write" },
  { key: "output", label: "Output" },
] as const;

type PriceField = (typeof PRICE_FIELDS)[number]["key"];
type PriceDraft = Record<PriceField, string>;

function emptyPriceDraft(): PriceDraft {
  return { input: "", cacheRead: "", cacheWrite: "", output: "" };
}

function formatCost(num: number): string {
  const n = toNum(num);
  if (n <= 0) return "$0.0000";
  return `$${n.toFixed(4)}`;
}

function formatRate(rate: number): string {
  return `${(toNum(rate) * 100).toFixed(1)}%`;
}

function buildSection(
  source: SectionSource,
  pricing: ModelPricing | null,
  cacheRate: number | null
): SectionData | null {
  if (!source.data) return null;

  const totalInput = toNum(source.data.totalInput);
  const cacheRead = toNum(source.data.totalInputCached);
  const cacheWrite = toNum(source.data.totalCacheWrite);
  const outputTokens = toNum(source.data.totalOutput);
  const simulated = simulatePricing({
    totalInput,
    cacheRead,
    cacheWrite,
    outputTokens,
    pricing,
    cacheRate,
  });

  return {
    id: source.id,
    title: source.title,
    totalInput,
    totalOutput: outputTokens,
    totalInputCached: cacheRead,
    totalInputUncached: toNum(source.data.totalInputUncached),
    totalCacheWrite: cacheWrite,
    actualCost: toNum(source.data.totalCost),
    simulatedCost: simulated.cost,
    actualCacheRate: simulated.actualCacheRate,
    simulatedCacheRate: simulated.simulatedCacheRate,
  };
}

function aggregateDailyDataForRange(
  data: DailyData[],
  days: number,
  timezoneOffsetMinutes: number
): RangeBucket | null {
  if (!data || data.length === 0) return null;

  const today = new Date();
  const cutoffKey = localDateKeyFromUtcDate(
    new Date(today.getTime() - days * 24 * 60 * 60 * 1000),
    timezoneOffsetMinutes
  );

  const filtered = data.filter((item) => item.group >= cutoffKey);
  if (filtered.length === 0) return null;

  return filtered.reduce(
    (acc, item) => ({
      totalInput: acc.totalInput + toNum(item.totalInput),
      totalOutput: acc.totalOutput + toNum(item.totalOutput),
      totalInputCached: acc.totalInputCached + toNum(item.totalInputCached),
      totalInputUncached:
        acc.totalInputUncached + toNum(item.totalInputUncached),
      totalCacheWrite: acc.totalCacheWrite + toNum(item.totalCacheWrite),
      totalCost: acc.totalCost + toNum(item.totalCost),
    }),
    {
      totalInput: 0,
      totalOutput: 0,
      totalInputCached: 0,
      totalInputUncached: 0,
      totalCacheWrite: 0,
      totalCost: 0,
    }
  );
}

function groupModelsByProvider(models: ModelPricing[]): ProviderGroup[] {
  const map = new Map<string, ModelOption[]>();
  for (const model of models) {
    let provider = model.provider ?? "";
    if (!provider) {
      const slashIndex = model.canonicalId.indexOf("/");
      provider = slashIndex >= 0 ? model.canonicalId.slice(0, slashIndex) : "";
    }
    if (!provider) provider = UNCATEGORIZED;
    const option: ModelOption = {
      canonicalId: model.canonicalId,
      displayName: model.displayName || model.canonicalId,
    };
    if (!map.has(provider)) {
      map.set(provider, []);
    }
    map.get(provider)!.push(option);
  }

  const groups: ProviderGroup[] = [];
  Array.from(map.entries()).forEach(([provider, modelsList]) => {
    modelsList.sort((a: ModelOption, b: ModelOption) =>
      a.displayName.localeCompare(b.displayName)
    );
    groups.push({ provider, models: modelsList });
  });
  groups.sort((a, b) => a.provider.localeCompare(b.provider));
  return groups;
}

function DiffCell({
  actual,
  simulated,
}: {
  actual: number;
  simulated: number;
}) {
  const diff = simulated - actual;
  const isSaving = diff < 0;
  const percent = actual > 0 ? (Math.abs(diff) / actual) * 100 : 0;

  return (
    <div className="flex flex-col">
      <span
        className={`font-medium ${isSaving ? "text-green-600" : "text-red-600"}`}
      >
        {isSaving ? "−" : "+"}
        {formatCost(Math.abs(diff))}
      </span>
      <span className="text-xs text-gray-500">
        {isSaving ? "↓" : "↑"} {percent.toFixed(1)}%
      </span>
    </div>
  );
}

function AvgCostCell({
  actualCost,
  simulatedCost,
  effectiveTokens,
}: {
  actualCost: number;
  simulatedCost: number;
  effectiveTokens: number;
}) {
  const actualAvg =
    effectiveTokens > 0 ? (actualCost / effectiveTokens) * 1_000_000 : 0;
  const simulatedAvg =
    effectiveTokens > 0 ? (simulatedCost / effectiveTokens) * 1_000_000 : 0;

  return (
    <div className="flex flex-col">
      <span className="text-gray-700">{formatCost(actualAvg)}</span>
      <span className="text-xs text-blue-600 font-medium">
        → {formatCost(simulatedAvg)}
      </span>
    </div>
  );
}

function CacheRateCell({
  section,
  draft,
  onChange,
}: {
  section: SectionData;
  draft: string;
  onChange: (sectionId: string, value: string) => void;
}) {
  const isOverride = draft !== "";
  const value = isOverride ? draft : formatRate(section.actualCacheRate).replace("%", "");

  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={0}
          max={100}
          step={0.5}
          value={value}
          onChange={(e) => onChange(section.id, e.target.value)}
          aria-label={`Simulated cache rate for ${section.title}`}
          className={`w-20 rounded border px-2 py-1 text-right text-base md:text-sm focus:outline-none focus:ring-1 ${
            isOverride
              ? "border-blue-400 bg-blue-50/40 font-medium text-blue-700 focus:border-blue-500 focus:ring-blue-500"
              : "border-gray-200 text-gray-600 focus:border-blue-500 focus:ring-blue-500"
          }`}
        />
        <span className="text-xs text-gray-400">%</span>
      </div>
      {isOverride && (
        <span className="text-xs text-gray-400">
          actual {formatRate(section.actualCacheRate)}
        </span>
      )}
    </div>
  );
}

const SIMULATION_PROVIDER_KEY = "token-tracker-simulation-provider";
const SIMULATION_MODEL_KEY = "token-tracker-simulation-model";
const SEARCH_DEBOUNCE_MS = 300;

export default function PriceSimulatorModal({
  isOpen,
  onClose,
  defaultAgent,
  defaultProvider,
  defaultModel,
  agents,
  providers,
  models,
}: PriceSimulatorModalProps) {
  const { compact } = useNumberFormat();
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  // 数据过滤（独立于 dashboard，默认同步 dashboard 状态）
  const [filterAgent, setFilterAgent] = useState(defaultAgent);
  const [filterProvider, setFilterProvider] = useState(defaultProvider);
  const [filterModel, setFilterModel] = useState(defaultModel);

  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  const [allModels, setAllModels] = useState<ModelPricing[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [priceDraft, setPriceDraft] = useState<PriceDraft | null>(null);

  const [cacheRateDrafts, setCacheRateDrafts] = useState<Record<string, string>>(
    {}
  );

  const [modelsDevProviders, setModelsDevProviders] = useState<
    ModelsDevProvider[]
  >([]);
  const loadedProvidersRef = useRef<Set<string>>(new Set());
  const loadingProvidersRef = useRef<Set<string>>(new Set());
  const [providerLoading, setProviderLoading] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ModelPricing[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchActive, setSearchActive] = useState(false);

  // 打开时同步 dashboard 当前过滤（用 ref 避免把 default* 放进 effect 依赖）
  const defaultsRef = useRef({ agent: defaultAgent, provider: defaultProvider, model: defaultModel });
  defaultsRef.current = {
    agent: defaultAgent,
    provider: defaultProvider,
    model: defaultModel,
  };

  const updateSelection = (provider: string, modelId: string) => {
    setSelectedProvider(provider);
    setSelectedModelId(modelId);
    try {
      if (provider) {
        localStorage.setItem(SIMULATION_PROVIDER_KEY, provider);
      } else {
        localStorage.removeItem(SIMULATION_PROVIDER_KEY);
      }
      if (modelId) {
        localStorage.setItem(SIMULATION_MODEL_KEY, modelId);
      } else {
        localStorage.removeItem(SIMULATION_MODEL_KEY);
      }
    } catch {
      // ignore storage errors
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    setFilterAgent(defaultsRef.current.agent);
    setFilterProvider(defaultsRef.current.provider);
    setFilterModel(defaultsRef.current.model);
    setCacheRateDrafts({});
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    setModelsLoading(true);
    setModelsError(null);
    setSearchQuery("");
    setSearchResults([]);
    setSearchError(null);
    setSearchActive(false);
    loadedProvidersRef.current.clear();
    loadingProvidersRef.current.clear();

    let defaultProviderId = "";
    let defaultModelId = "";
    try {
      defaultProviderId = localStorage.getItem(SIMULATION_PROVIDER_KEY) || "";
      defaultModelId = localStorage.getItem(SIMULATION_MODEL_KEY) || "";
    } catch {
      // ignore storage errors
    }

    apiFetch("/api/model-pricing")
      .then((res) => res.json())
      .then((json) => {
        if (json.success && Array.isArray(json.data)) {
          setAllModels(json.data);
          if (Array.isArray(json.providers)) {
            setModelsDevProviders(json.providers);
          }

          // Validate defaults against loaded models
          const groups = groupModelsByProvider(json.data);
          const providerExists = groups.some(
            (g) => g.provider === defaultProviderId
          );
          const modelExists = providerExists
            ? groups
                .find((g) => g.provider === defaultProviderId)
                ?.models.some((m) => m.canonicalId === defaultModelId)
            : false;

          setSelectedProvider(providerExists ? defaultProviderId : "");
          setSelectedModelId(modelExists ? defaultModelId : "");
        } else {
          setModelsError(json.error || "Failed to load models");
        }
      })
      .catch((err) => {
        setModelsError(
          err instanceof Error ? err.message : "Failed to load models"
        );
      })
      .finally(() => {
        setModelsLoading(false);
      });
  }, [isOpen]);

  // 数据区间数据：独立按模拟器内的过滤拉取 dashboard 聚合（range 固定 30d 覆盖所有区间）
  useEffect(() => {
    if (!isOpen) return;

    const controller = new AbortController();
    const url = new URL("/api/dashboard", window.location.origin);
    url.searchParams.set("range", "30d");
    url.searchParams.set(
      "tzOffset",
      String(getClientTimezoneOffsetMinutes())
    );
    if (filterProvider !== "all") {
      url.searchParams.set("provider", filterProvider);
    }
    if (filterModel !== "all") {
      url.searchParams.set("model", filterModel);
    }
    if (filterAgent !== "all") {
      url.searchParams.set("agent", filterAgent);
    }

    setDataLoading(true);
    setDataError(null);

    apiFetch(url.toString(), { signal: controller.signal })
      .then((res) => res.json())
      .then((json) => {
        if (controller.signal.aborted) return;
        if (!json.success) {
          setDataError(json.error || "Failed to load data");
          setSnapshot(null);
          return;
        }
        const data = json.data ?? {};
        const totalRow = Array.isArray(data.total) ? data.total[0] : null;
        setSnapshot({
          total: totalRow
            ? {
                totalInput: Number(totalRow.totalInput || 0),
                totalOutput: Number(totalRow.totalOutput || 0),
                totalInputCached: Number(totalRow.totalInputCached || 0),
                totalInputUncached: Number(totalRow.totalInputUncached || 0),
                totalCacheWrite: Number(totalRow.totalCacheWrite || 0),
                count: Number(totalRow.count || 0),
                totalCost: Number(totalRow.totalCost || 0),
                costPerMillionTokens: Number(totalRow.costPerMillionTokens || 0),
                costPerMillionInput: Number(totalRow.costPerMillionInput || 0),
                costPerMillionCacheRead: Number(
                  totalRow.costPerMillionCacheRead || 0
                ),
                costPerMillionCacheWrite: Number(
                  totalRow.costPerMillionCacheWrite || 0
                ),
                costPerMillionOutput: Number(totalRow.costPerMillionOutput || 0),
              }
            : null,
          today: data.today
            ? {
                totalInput: Number(data.today.totalInput || 0),
                totalOutput: Number(data.today.totalOutput || 0),
                totalInputCached: Number(data.today.totalInputCached || 0),
                totalInputUncached: Number(data.today.totalInputUncached || 0),
                totalCacheWrite: Number(data.today.totalCacheWrite || 0),
                count: Number(data.today.count || 0),
                totalCost: Number(data.today.totalCost || 0),
                costPerMillionTokens: Number(data.today.costPerMillionTokens || 0),
                costPerMillionInput: Number(data.today.costPerMillionInput || 0),
                costPerMillionCacheRead: Number(
                  data.today.costPerMillionCacheRead || 0
                ),
                costPerMillionCacheWrite: Number(
                  data.today.costPerMillionCacheWrite || 0
                ),
                costPerMillionOutput: Number(data.today.costPerMillionOutput || 0),
              }
            : null,
          daily: Array.isArray(data.daily) ? data.daily : [],
          totalDays: Number(data.totalDays) || 0,
        });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setDataError(
          err instanceof Error ? err.message : "Failed to load data"
        );
        setSnapshot(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDataLoading(false);
      });

    return () => controller.abort();
  }, [isOpen, filterAgent, filterProvider, filterModel]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleSearchClickOutside = (e: MouseEvent) => {
      if (
        searchActive &&
        searchBoxRef.current &&
        !searchBoxRef.current.contains(e.target as Node)
      ) {
        setSearchActive(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("mousedown", handleSearchClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("mousedown", handleSearchClickOutside);
    };
  }, [isOpen, onClose, searchActive]);

  // models.dev 全量搜索（防抖 + 竞态保护）
  useEffect(() => {
    if (!isOpen) return;

    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      apiFetch(`/api/model-pricing?search=${encodeURIComponent(q)}`)
        .then((res) => res.json())
        .then((json) => {
          if (cancelled) return;
          if (json.success && Array.isArray(json.data)) {
            setSearchResults(json.data);
          } else {
            setSearchError(json.error || "Failed to search models");
            setSearchResults([]);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setSearchError(
            err instanceof Error ? err.message : "Failed to search models"
          );
          setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, searchQuery]);

  const providerGroups = useMemo(
    () => groupModelsByProvider(allModels),
    [allModels]
  );

  const providerOptions = useMemo(() => {
    const loaded = new Set(providerGroups.map((g) => g.provider));
    const options: string[] = providerGroups.map((g) => g.provider);
    for (const p of modelsDevProviders) {
      if (!loaded.has(p.id)) {
        options.push(p.id);
      }
    }
    return options;
  }, [providerGroups, modelsDevProviders]);

  const providerLabel = (id: string): string => {
    if (id === UNCATEGORIZED) return id;
    return modelsDevProviders.find((p) => p.id === id)?.name ?? id;
  };

  // 懒加载某 provider 的 models.dev 全量模型（幂等：已加载 / in-flight 时跳过）。
  // 任何路径选中 provider（下拉或搜索）都走这里，保证模型下拉可选中该 provider 全部模型。
  const loadProviderModels = useCallback((providerId: string) => {
    if (!providerId) return;
    if (loadedProvidersRef.current.has(providerId)) return;
    if (loadingProvidersRef.current.has(providerId)) return;
    loadingProvidersRef.current.add(providerId);
    setProviderLoading(true);
    apiFetch(`/api/model-pricing?provider=${encodeURIComponent(providerId)}`)
      .then((res) => res.json())
      .then((json) => {
        if (json.success && Array.isArray(json.data)) {
          setAllModels((prev) => {
            const existing = new Set(prev.map((m) => m.canonicalId));
            const fresh = json.data.filter(
              (m: ModelPricing) => !existing.has(m.canonicalId)
            );
            return fresh.length > 0 ? [...prev, ...fresh] : prev;
          });
          loadedProvidersRef.current.add(providerId);
        } else {
          setModelsError(json.error || "Failed to load models");
        }
      })
      .catch((err) => {
        setModelsError(
          err instanceof Error ? err.message : "Failed to load models"
        );
      })
      .finally(() => {
        loadingProvidersRef.current.delete(providerId);
        setProviderLoading(false);
      });
  }, []);

  const selectSearchResult = (model: ModelPricing) => {
    setAllModels((prev) =>
      prev.some((m) => m.canonicalId === model.canonicalId)
        ? prev
        : [...prev, model]
    );
    const slashIndex = model.canonicalId.indexOf("/");
    const provider =
      slashIndex >= 0 ? model.canonicalId.slice(0, slashIndex) : "";
    updateSelection(provider, model.canonicalId);
    // 同步懒加载该 provider 全量模型，避免模型下拉只剩搜索选中的单个模型
    loadProviderModels(provider);
    setSearchQuery("");
    setSearchResults([]);
    setSearchError(null);
    setSearchActive(false);
  };

  // 选中未加载的 models.dev provider → 懒加载该 provider 全部模型
  useEffect(() => {
    if (!isOpen || !selectedProvider) return;
    loadProviderModels(selectedProvider);
  }, [isOpen, selectedProvider, loadProviderModels]);

  const selectedModel = useMemo<ModelPricing | null>(() => {
    if (!selectedModelId) return null;
    return allModels.find((m) => m.canonicalId === selectedModelId) || null;
  }, [selectedModelId, allModels]);

  const availableModels = useMemo(() => {
    const group = providerGroups.find((g) => g.provider === selectedProvider);
    return group?.models ?? [];
  }, [providerGroups, selectedProvider]);

  useEffect(() => {
    if (selectedProvider && availableModels.length > 0) {
      const stillAvailable = availableModels.some(
        (m) => m.canonicalId === selectedModelId
      );
      if (!stillAvailable) {
        setSelectedModelId(availableModels[0].canonicalId);
      }
    } else if (!selectedProvider) {
      setSelectedModelId("");
    }
  }, [selectedProvider, availableModels, selectedModelId]);

  // 切换目标模型 → 手动价草稿回到官方价
  useEffect(() => {
    setPriceDraft(null);
  }, [selectedModelId]);

  const modelPriceDraft = useMemo<PriceDraft | null>(() => {
    if (!selectedModel) return null;
    return {
      input: String(selectedModel.inputPrice),
      cacheRead: String(selectedModel.cacheReadPrice),
      cacheWrite: String(selectedModel.cacheWritePrice),
      output: String(selectedModel.outputPrice),
    };
  }, [selectedModel]);

  const priceValues = priceDraft ?? modelPriceDraft;

  const priceDirty = Boolean(
    priceDraft &&
      modelPriceDraft &&
      PRICE_FIELDS.some((f) => priceDraft[f.key] !== modelPriceDraft[f.key])
  );

  // 手动价覆盖官方价；非法输入（空/负/NaN）回退官方价
  const simulatedModel = useMemo<ModelPricing | null>(() => {
    if (!selectedModel) return null;
    if (!priceValues) return selectedModel;
    return {
      canonicalId: selectedModel.canonicalId,
      displayName: selectedModel.displayName,
      inputPrice:
        parsePriceInput(priceValues.input) ?? selectedModel.inputPrice,
      cacheReadPrice:
        parsePriceInput(priceValues.cacheRead) ?? selectedModel.cacheReadPrice,
      cacheWritePrice:
        parsePriceInput(priceValues.cacheWrite) ??
        selectedModel.cacheWritePrice,
      outputPrice:
        parsePriceInput(priceValues.output) ?? selectedModel.outputPrice,
    };
  }, [selectedModel, priceValues]);

  const sectionSources = useMemo<SectionSource[]>(() => {
    if (!snapshot) return [];
    const tz = getClientTimezoneOffsetMinutes();
    const sources: SectionSource[] = [
      {
        id: "total",
        title: `Total Summary (${snapshot.totalDays} Day${
          snapshot.totalDays !== 1 ? "s" : ""
        })`,
        data: snapshot.total,
      },
      { id: "today", title: "Today", data: snapshot.today },
    ];

    for (const days of RANGE_OPTIONS) {
      sources.push({
        id: `${days}d`,
        title: `Last ${days} Days`,
        data: aggregateDailyDataForRange(snapshot.daily, days, tz),
      });
    }
    return sources;
  }, [snapshot]);

  const sections = useMemo<SectionData[]>(() => {
    return sectionSources
      .map((source) =>
        buildSection(
          source,
          simulatedModel,
          parseCacheRateInput(cacheRateDrafts[source.id] ?? "")
        )
      )
      .filter((section): section is SectionData => section !== null);
  }, [sectionSources, simulatedModel, cacheRateDrafts]);

  const setSectionCacheRate = useCallback(
    (sectionId: string, value: string) => {
      setCacheRateDrafts((prev) => ({ ...prev, [sectionId]: value }));
    },
    []
  );

  const resetCacheRates = useCallback(() => {
    setCacheRateDrafts({});
  }, []);

  const hasOverrides = Object.values(cacheRateDrafts).some(
    (value) => value.trim() !== ""
  );

  const syncFiltersFromDashboard = () => {
    setFilterAgent(defaultsRef.current.agent);
    setFilterProvider(defaultsRef.current.provider);
    setFilterModel(defaultsRef.current.model);
  };

  const hasData = Boolean(
    snapshot &&
      (snapshot.total ||
        snapshot.today ||
        snapshot.daily.length > 0)
  );

  const rows: Array<{
    label: string;
    key?: keyof SectionData;
    isCost?: boolean;
    highlight?: boolean;
    render?: (section: SectionData) => ReactNode;
  }> = [
    { label: "Total Input", key: "totalInput" },
    { label: "Cache Read", key: "totalInputCached" },
    { label: "Cache Write", key: "totalCacheWrite" },
    { label: "Output", key: "totalOutput" },
    {
      label: "Cache rate",
      render: (section) => (
        <CacheRateCell
          section={section}
          draft={cacheRateDrafts[section.id] ?? ""}
          onChange={setSectionCacheRate}
        />
      ),
    },
    { label: "Actual cost", key: "actualCost", isCost: true },
    {
      label: "Simulated cost",
      key: "simulatedCost",
      isCost: true,
      highlight: true,
    },
    {
      label: "Difference",
      render: (section) => (
        <DiffCell
          actual={section.actualCost}
          simulated={section.simulatedCost}
        />
      ),
    },
    {
      label: "Avg cost / 1M tokens",
      render: (section) => {
        const effectiveTokens =
          section.totalInput + section.totalCacheWrite + section.totalOutput;
        return (
          <AvgCostCell
            actualCost={section.actualCost}
            simulatedCost={section.simulatedCost}
            effectiveTokens={effectiveTokens}
          />
        );
      },
    },
  ];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-0 md:p-4">
      <div
        ref={dialogRef}
        className="w-full h-full md:h-auto md:w-full md:max-w-7xl md:max-h-[92vh] md:rounded-lg bg-white shadow-xl flex flex-col"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold">Price Simulation</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-[40px] min-w-[40px] items-center justify-center text-2xl leading-none text-gray-400 hover:text-gray-600 md:min-h-0 md:min-w-0"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 overflow-y-auto flex-1">
          {/* 数据过滤：独立于 dashboard */}
          <section className="mb-6">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-sm font-semibold text-gray-800">Data Scope</h3>
              <button
                type="button"
                onClick={syncFiltersFromDashboard}
                className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
              >
                Sync from dashboard
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label
                  htmlFor="simulator-filter-agent"
                  className="block text-xs font-medium text-gray-500 mb-1"
                >
                  Agent
                </label>
                <select
                  id="simulator-filter-agent"
                  value={filterAgent}
                  onChange={(e) => setFilterAgent(e.target.value)}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-base md:text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="all">All Agents</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="simulator-filter-provider"
                  className="block text-xs font-medium text-gray-500 mb-1"
                >
                  Provider
                </label>
                <select
                  id="simulator-filter-provider"
                  value={filterProvider}
                  onChange={(e) => setFilterProvider(e.target.value)}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-base md:text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="all">All Providers</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="simulator-filter-model"
                  className="block text-xs font-medium text-gray-500 mb-1"
                >
                  Model
                </label>
                <select
                  id="simulator-filter-model"
                  value={filterModel}
                  onChange={(e) => setFilterModel(e.target.value)}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-base md:text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
          </section>

          {/* 目标模型（定价来源） */}
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-gray-800 mb-2">
              Target Model
            </h3>

            <div ref={searchBoxRef} className="relative mb-4">
              <div className="relative">
                <input
                  id="simulator-search"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSearchActive(true);
                  }}
                  onFocus={() => setSearchActive(true)}
                  placeholder="Search models.dev, e.g. claude, gpt, gemini, deepseek..."
                  className="w-full rounded border border-gray-300 bg-white pl-9 pr-9 py-2 text-base md:text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <svg
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"
                  />
                </svg>
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery("");
                      setSearchResults([]);
                      setSearchError(null);
                      setSearchActive(false);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-600"
                    aria-label="Clear search"
                  >
                    ✕
                  </button>
                )}
              </div>

              {searchActive && searchQuery.trim() && (
                <div className="absolute left-0 right-0 z-10 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-y-auto">
                  {searching && (
                    <p className="px-4 py-3 text-sm text-gray-500">
                      Searching...
                    </p>
                  )}
                  {!searching && searchError && (
                    <p className="px-4 py-3 text-sm text-red-600">
                      {searchError}
                    </p>
                  )}
                  {!searching &&
                    !searchError &&
                    searchResults.length === 0 && (
                      <p className="px-4 py-3 text-sm text-gray-500">
                        No models found.
                      </p>
                    )}
                  {!searching &&
                    !searchError &&
                    searchResults.map((m) => {
                      const slashIndex = m.canonicalId.indexOf("/");
                      const provider =
                        slashIndex >= 0
                          ? m.canonicalId.slice(0, slashIndex)
                          : UNCATEGORIZED;
                      return (
                        <button
                          key={m.canonicalId}
                          type="button"
                          onClick={() => selectSearchResult(m)}
                          className="w-full text-left px-4 py-2.5 hover:bg-blue-50 border-b border-gray-100 last:border-b-0"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm text-gray-900 break-all">
                              <span className="inline-block bg-gray-100 text-gray-600 text-xs font-medium rounded px-1.5 py-0.5 mr-2">
                                {provider}
                              </span>
                              {m.displayName}
                            </span>
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            in ${m.inputPrice} · out ${m.outputPrice}
                            {m.cacheReadPrice !== m.inputPrice && (
                              <> · cacheRead ${m.cacheReadPrice}</>
                            )}
                            {m.cacheWritePrice !== m.inputPrice && (
                              <> · cacheWrite ${m.cacheWritePrice}</>
                            )}
                            /1M
                          </div>
                        </button>
                      );
                    })}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <div>
                <label
                  htmlFor="simulator-provider"
                  className="block text-xs font-medium text-gray-500 mb-1"
                >
                  Provider
                </label>
                <select
                  id="simulator-provider"
                  value={selectedProvider}
                  onChange={(e) => updateSelection(e.target.value, "")}
                  disabled={
                    modelsLoading ||
                    (providerGroups.length === 0 &&
                      modelsDevProviders.length === 0)
                  }
                  className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-base md:text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
                >
                  <option value="">Select provider</option>
                  {providerOptions.map((id) => (
                    <option key={id} value={id}>
                      {providerLabel(id)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="simulator-model"
                  className="block text-xs font-medium text-gray-500 mb-1"
                >
                  Model
                </label>
                <select
                  id="simulator-model"
                  value={selectedModelId}
                  onChange={(e) =>
                    updateSelection(selectedProvider, e.target.value)
                  }
                  disabled={!selectedProvider || availableModels.length === 0}
                  className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-base md:text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
                >
                  <option value="">Select model</option>
                  {availableModels.map((m) => (
                    <option key={m.canonicalId} value={m.canonicalId}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* 手动调价 */}
            <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-600">
                  Prices ($ / 1M tokens) — editable
                </span>
                {priceDirty && (
                  <button
                    type="button"
                    onClick={() => setPriceDraft(null)}
                    className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
                  >
                    Reset to model price
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {PRICE_FIELDS.map((field) => {
                  const raw = priceValues ? priceValues[field.key] : "";
                  const invalid = raw.trim() !== "" && parsePriceInput(raw) === null;
                  return (
                    <div key={field.key}>
                      <label
                        htmlFor={`simulator-price-${field.key}`}
                        className="block text-xs text-gray-500 mb-1"
                      >
                        {field.label}
                      </label>
                      <input
                        id={`simulator-price-${field.key}`}
                        type="number"
                        min={0}
                        step="0.01"
                        value={raw}
                        disabled={!selectedModel}
                        onChange={(e) => {
                          const base = priceValues ?? emptyPriceDraft();
                          setPriceDraft({
                            ...base,
                            [field.key]: e.target.value,
                          });
                        }}
                        className={`w-full rounded border bg-white px-2 py-1.5 text-base md:text-sm focus:outline-none focus:ring-1 disabled:bg-gray-100 disabled:text-gray-400 ${
                          invalid
                            ? "border-red-400 focus:border-red-500 focus:ring-red-500"
                            : "border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                        }`}
                      />
                    </div>
                  );
                })}
              </div>
              {!selectedModel && (
                <p className="text-xs text-gray-400 mt-2">
                  Select a target model to load its official prices.
                </p>
              )}
            </div>
          </section>

          {/* cache rate 说明 + 一键回到实际 */}
          <section className="mb-6 flex flex-wrap items-center gap-3">
            <p className="text-xs text-gray-400">
              Cache rate is editable per section in the table below: Total Input
              stays fixed, tokens are redistributed between cached / uncached.
              Clear a cell to follow that section&apos;s actual cache rate.
            </p>
            {hasOverrides && (
              <button
                type="button"
                onClick={resetCacheRates}
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 shadow-sm hover:bg-gray-50"
              >
                Follow actual for all
              </button>
            )}
          </section>

          {modelsLoading && (
            <p className="text-sm text-gray-500 mb-4">Loading models...</p>
          )}

          {!modelsLoading && providerLoading && (
            <p className="text-sm text-gray-500 mb-4">
              Loading provider models...
            </p>
          )}

          {modelsError && (
            <p className="text-sm text-red-600 mb-4">{modelsError}</p>
          )}

          {!modelsLoading &&
            !providerLoading &&
            !modelsError &&
            providerGroups.length === 0 &&
            modelsDevProviders.length === 0 && (
              <p className="text-sm text-gray-500 mb-4">
                No providers available.
              </p>
            )}

          {dataLoading && (
            <p className="text-sm text-gray-500 mb-4">Loading data...</p>
          )}

          {dataError && (
            <p className="text-sm text-red-600 mb-4">{dataError}</p>
          )}

          {!dataLoading && !dataError && !hasData && (
            <p className="text-sm text-gray-500 mb-4">
              No data available for the selected scope.
            </p>
          )}

          {!dataLoading && hasData && !selectedModel && (
            <p className="text-sm text-gray-500">
              Select a target provider and model to see the simulated cost.
            </p>
          )}

          {!dataLoading && hasData && selectedModel && sections.length > 0 && (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left text-xs font-medium text-gray-500 uppercase py-3 px-4 sticky left-0 bg-white min-w-[190px]">
                      Metric
                    </th>
                    {sections.map((section) => (
                      <th
                        key={section.id}
                        className="text-right text-xs font-medium text-gray-500 uppercase py-3 px-4 min-w-[170px]"
                      >
                        {section.title}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((row) => (
                    <tr key={row.label} className="hover:bg-gray-50">
                      <td className="py-3 px-4 text-sm text-gray-600 sticky left-0 bg-white">
                        {row.label}
                      </td>
                      {sections.map((section) => (
                        <td
                          key={`${row.label}-${section.id}`}
                          className="py-3 px-4 text-sm text-right align-middle"
                        >
                          {row.render ? (
                            row.render(section)
                          ) : (
                            <span
                              className={`${
                                row.highlight
                                  ? "text-blue-600 font-medium"
                                  : "text-gray-900"
                              }`}
                            >
                              {row.isCost
                                ? formatCost(toNum(section[row.key!]))
                                : formatNumber(toNum(section[row.key!]), compact)}
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
