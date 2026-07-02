"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Stats } from "./StatsCards";
import { TodayData } from "./TodayOverview";
import { DailyData } from "./DailyUsageChart";
import { type ModelPricing, calculateCost } from "@/lib/cost-utils";
import { formatNumber, toNum } from "@/lib/number-utils";
import { useNumberFormat } from "./NumberFormatContext";

interface PriceSimulatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  stats: Stats | null;
  todayData: TodayData | null;
  dailyData: DailyData[];
  totalDays: number;
  loading: boolean;
}

interface SectionData {
  title: string;
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalCacheWrite: number;
  actualCost: number;
  simulatedCost: number;
}

interface ModelOption {
  canonicalId: string;
  displayName: string;
}

interface ProviderGroup {
  provider: string;
  models: ModelOption[];
}

function formatCost(num: number): string {
  const n = toNum(num);
  if (n <= 0) return "$0.0000";
  return `$${n.toFixed(4)}`;
}

function extractInputs(
  data: Pick<
    Stats | TodayData | DailyData,
    "totalInput" | "totalInputCached" | "totalCacheWrite" | "totalOutput"
  >
): {
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  outputTokens: number;
} {
  const totalInput = toNum(data.totalInput);
  const totalInputCached = toNum(data.totalInputCached);
  return {
    inputTokens: totalInput - totalInputCached,
    cacheRead: totalInputCached,
    cacheWrite: toNum(data.totalCacheWrite),
    outputTokens: toNum(data.totalOutput),
  };
}

function computeSection(
  title: string,
  data:
    | (Pick<
        Stats | TodayData | DailyData,
        | "totalInput"
        | "totalInputCached"
        | "totalInputUncached"
        | "totalCacheWrite"
        | "totalOutput"
        | "totalCost"
      >)
    | null,
  pricing: ModelPricing | null
): SectionData | null {
  if (!data) return null;

  const inputs = extractInputs(data);
  const actualCost = toNum(data.totalCost);
  const simulatedCost = pricing
    ? calculateCost({ ...inputs, pricing })
    : 0;

  return {
    title,
    totalInput: toNum(data.totalInput),
    totalOutput: toNum(data.totalOutput),
    totalInputCached: toNum(data.totalInputCached),
    totalInputUncached: toNum(data.totalInputUncached),
    totalCacheWrite: toNum(data.totalCacheWrite),
    actualCost,
    simulatedCost,
  };
}

function aggregateDailyDataForRange(
  data: DailyData[],
  days: number
): Pick<
  SectionData,
  | "totalInput"
  | "totalOutput"
  | "totalInputCached"
  | "totalInputUncached"
  | "totalCacheWrite"
> & { totalCost: number } | null {
  if (!data || data.length === 0) return null;

  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setUTCDate(today.getUTCDate() - days + 1);
  cutoff.setUTCHours(0, 0, 0, 0);

  const filtered = data.filter((item) => {
    const date = new Date(`${item.group}T00:00:00Z`);
    return date >= cutoff;
  });

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

const RANGE_OPTIONS = [3, 7, 14, 30];

function groupModelsByProvider(models: ModelPricing[]): ProviderGroup[] {
  const map = new Map<string, ModelOption[]>();
  for (const model of models) {
    const slashIndex = model.canonicalId.indexOf("/");
    const provider = slashIndex >= 0 ? model.canonicalId.slice(0, slashIndex) : "other";
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
      <span className={`font-medium ${isSaving ? "text-green-600" : "text-red-600"}`}>
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

const SIMULATION_PROVIDER_KEY = "token-tracker-simulation-provider";
const SIMULATION_MODEL_KEY = "token-tracker-simulation-model";

export default function PriceSimulatorModal({
  isOpen,
  onClose,
  stats,
  todayData,
  dailyData,
  totalDays,
  loading,
}: PriceSimulatorModalProps) {
  const { compact } = useNumberFormat();
  const dialogRef = useRef<HTMLDivElement>(null);

  const [allModels, setAllModels] = useState<ModelPricing[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");

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

    setModelsLoading(true);
    setModelsError(null);

    let defaultProvider = "";
    let defaultModel = "";
    try {
      defaultProvider = localStorage.getItem(SIMULATION_PROVIDER_KEY) || "";
      defaultModel = localStorage.getItem(SIMULATION_MODEL_KEY) || "";
    } catch {
      // ignore storage errors
    }

    fetch("/api/model-pricing")
      .then((res) => res.json())
      .then((json) => {
        if (json.success && Array.isArray(json.data)) {
          setAllModels(json.data);

          // Validate defaults against loaded models
          const groups = groupModelsByProvider(json.data);
          const providerExists = groups.some(
            (g) => g.provider === defaultProvider
          );
          const modelExists = providerExists
            ? groups
                .find((g) => g.provider === defaultProvider)
                ?.models.some((m) => m.canonicalId === defaultModel)
            : false;

          setSelectedProvider(providerExists ? defaultProvider : "");
          setSelectedModelId(modelExists ? defaultModel : "");
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

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dialogRef.current &&
        !dialogRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onClose]);

  const providerGroups = useMemo(
    () => groupModelsByProvider(allModels),
    [allModels]
  );

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

  const sections = useMemo<SectionData[]>(() => {
    if (!selectedModel) return [];

    const result: SectionData[] = [];

    const totalSection = computeSection(
      `Total Summary (${totalDays} Day${totalDays !== 1 ? "s" : ""})`,
      stats,
      selectedModel
    );
    if (totalSection) result.push(totalSection);

    const todaySection = computeSection("Today", todayData, selectedModel);
    if (todaySection) result.push(todaySection);

    for (const days of RANGE_OPTIONS) {
      const rangeData = aggregateDailyDataForRange(dailyData, days);
      const rangeSection = computeSection(
        `Last ${days} Days`,
        rangeData,
        selectedModel
      );
      if (rangeSection) result.push(rangeSection);
    }

    return result;
  }, [stats, todayData, dailyData, selectedModel, totalDays]);

  const hasData = stats !== null || todayData !== null || dailyData.length > 0;

  const rows = useMemo(
    () => [
      {
        label: "Total Input",
        key: "totalInput" as const,
        isCost: false,
      },
      {
        label: "Cache Read",
        key: "totalInputCached" as const,
        isCost: false,
      },
      {
        label: "Cache Write",
        key: "totalCacheWrite" as const,
        isCost: false,
      },
      {
        label: "Output",
        key: "totalOutput" as const,
        isCost: false,
      },
      {
        label: "Actual cost",
        key: "actualCost" as const,
        isCost: true,
      },
      {
        label: "Simulated cost",
        key: "simulatedCost" as const,
        isCost: true,
        highlight: true,
      },
      {
        label: "Difference",
        render: (section: SectionData) => (
          <DiffCell actual={section.actualCost} simulated={section.simulatedCost} />
        ),
      },
      {
        label: "Avg cost / 1M tokens",
        render: (section: SectionData) => {
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
    ],
    []
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-0 md:p-4">
      <div
        ref={dialogRef}
        className="w-full h-full md:h-auto md:w-full md:max-w-4xl md:max-h-[90vh] md:rounded-lg bg-white shadow-xl flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold">Price Simulation</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-2xl leading-none text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
            <div>
              <label
                htmlFor="simulator-provider"
                className="block text-sm font-medium text-gray-700 mb-2"
              >
                Provider
              </label>
              <select
                id="simulator-provider"
                value={selectedProvider}
                onChange={(e) => updateSelection(e.target.value, "")}
                disabled={modelsLoading || providerGroups.length === 0}
                className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
              >
                <option value="">Select provider</option>
                {providerGroups.map((g) => (
                  <option key={g.provider} value={g.provider}>
                    {g.provider}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="simulator-model"
                className="block text-sm font-medium text-gray-700 mb-2"
              >
                Model
              </label>
              <select
                id="simulator-model"
                value={selectedModelId}
                onChange={(e) => updateSelection(selectedProvider, e.target.value)}
                disabled={!selectedProvider || availableModels.length === 0}
                className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
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

          {modelsLoading && (
            <p className="text-sm text-gray-500 mb-4">Loading models...</p>
          )}

          {modelsError && (
            <p className="text-sm text-red-600 mb-4">{modelsError}</p>
          )}

          {!modelsLoading && !modelsError && providerGroups.length === 0 && (
            <p className="text-sm text-gray-500 mb-4">
              No priced models available.
            </p>
          )}

          {loading && (
            <p className="text-sm text-gray-500 mb-4">
              Loading dashboard data...
            </p>
          )}

          {!loading && !hasData && (
            <p className="text-sm text-gray-500 mb-4">No data available.</p>
          )}

          {!loading && hasData && !selectedModel && (
            <p className="text-sm text-gray-500">
              Select a provider and model to see the simulated cost.
            </p>
          )}

          {!loading && hasData && selectedModel && sections.length > 0 && (
            <div className="overflow-x-auto -mx-4 px-4">
              <table className="min-w-full border-collapse">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left text-xs font-medium text-gray-500 uppercase py-3 px-3 sticky left-0 bg-white min-w-[160px]">
                      Metric
                    </th>
                    {sections.map((section) => (
                      <th
                        key={section.title}
                        className="text-right text-xs font-medium text-gray-500 uppercase py-3 px-3 min-w-[140px]"
                      >
                        {section.title}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((row) => (
                    <tr key={row.label} className="hover:bg-gray-50">
                      <td className="py-3 px-3 text-sm text-gray-600 sticky left-0 bg-white">
                        {row.label}
                      </td>
                      {sections.map((section) => (
                        <td
                          key={`${row.label}-${section.title}`}
                          className="py-3 px-3 text-sm text-right"
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
                                ? formatCost(section[row.key])
                                : formatNumber(section[row.key], compact)}
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
