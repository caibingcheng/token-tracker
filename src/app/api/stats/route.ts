import { NextRequest, NextResponse } from "next/server";
import { initDatabase } from "@/lib/db";
import { executeStatsQuery, type StatsQueryResult, type TotalStatItem, type StatItemWithGroupAndModel } from "@/lib/stats-query";
import { type StatItem } from "@/lib/model-utils";
import { unstable_cache } from "next/cache";
import { normalizeModel, getPricing } from "@/lib/model-registry";
import { toNum } from "@/lib/number-utils";
import {
  aggregateCost,
  addToAggregate,
  checkPricingConsistency,
  emptyAggregatedCost,
  finalizeAggregate,
  type AggregatedCost,
  type CostInput,
} from "@/lib/cost-utils";
import { STATS_CACHE_TAG } from "@/lib/cache";
import {
  resolveDashboardFilters,
  validateFilterOrThrow,
} from "@/lib/dashboard-utils";

function isTotalStatItems(data: StatsQueryResult): data is TotalStatItem[] {
  return Array.isArray(data) && (data.length === 0 || "lastActiveAt" in data[0]);
}

function isStatItemsWithGroup(data: StatsQueryResult): data is Array<StatItem & { group: string }> {
  return Array.isArray(data);
}

function isStatItemsWithModel(data: StatsQueryResult): data is StatItemWithGroupAndModel[] {
  return Array.isArray(data) && data.length > 0 && "model" in data[0];
}

function toCostInput(item: StatItem): CostInput {
  return {
    inputTokens: toNum(item.totalInputUncached),
    cacheRead: toNum(item.totalInputCached),
    cacheWrite: toNum(item.totalCacheWrite),
    outputTokens: toNum(item.totalOutput),
    pricing: getPricing(item.group),
  };
}

function aggregateCostByDate(
  rows: Array<StatItem & { group: string; model: string }>
): Map<string, { aggregate: AggregatedCost; inputs: CostInput[] }> {
  const map = new Map<string, { aggregate: AggregatedCost; inputs: CostInput[] }>();

  for (const row of rows) {
    const date = String(row.group);
    const canonicalId = normalizeModel(String(row.model));
    const input: CostInput = {
      inputTokens: toNum(row.totalInputUncached),
      cacheRead: toNum(row.totalInputCached),
      cacheWrite: toNum(row.totalCacheWrite),
      outputTokens: toNum(row.totalOutput),
      pricing: getPricing(canonicalId),
    };

    const existing = map.get(date);
    if (existing) {
      addToAggregate(existing.aggregate, input);
      existing.inputs.push(input);
    } else {
      const agg = emptyAggregatedCost();
      addToAggregate(agg, input);
      map.set(date, { aggregate: agg, inputs: [input] });
    }
  }

  map.forEach(({ aggregate }) => finalizeAggregate(aggregate));

  return map;
}

function formatDateKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

interface DayData {
  group: string;
  totalInput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalOutput: number;
  totalCacheWrite: number;
  count: number;
  totalCost: number;
  costPerMillionTokens: number;
  costPerMillionInput: number;
  costPerMillionCacheRead: number;
  costPerMillionCacheWrite: number;
  costPerMillionOutput: number;
}

interface StatsResult {
  total: Array<{
    group: string;
    totalInput: number;
    totalOutput: number;
    totalInputCached: number;
    totalInputUncached: number;
    totalCacheWrite: number;
    count: number;
    lastActiveAt?: string;
    totalCost: number;
    costPerMillionTokens: number;
    costPerMillionInput: number;
    costPerMillionCacheRead: number;
    costPerMillionCacheWrite: number;
    costPerMillionOutput: number;
  }>;
  today: DayData | null;
  yesterday: DayData | null;
}

const statsCacheFn = unstable_cache(
  async (
    provider: string,
    providerFilter: string[] | null,
    model: string,
    modelFilter: string[] | null
  ) => {
    const [total, totalModels, dailyModel] = await Promise.all([
      executeStatsQuery({
        groupBy: "none",
        range: "all",
        provider,
        providerFilter,
        model,
        modelFilter,
      }),
      executeStatsQuery({
        groupBy: "model",
        range: "all",
        provider,
        providerFilter,
        model,
        modelFilter,
        limit: null,
      }),
      executeStatsQuery({
        groupBy: "date-model",
        range: "all",
        provider,
        granularity: "day",
        providerFilter,
        model,
        modelFilter,
      }),
    ]);

    // Total summary (all-time)
    const totalArr = isTotalStatItems(total) ? total : [];
    const totalModelsArr = isStatItemsWithGroup(totalModels) ? totalModels : [];

    const totalInputs = totalModelsArr.map(toCostInput);
    const totalAggregate = aggregateCost(totalInputs);
    const totalConsistency = checkPricingConsistency(totalInputs, totalAggregate);
    if (!totalConsistency.ok) {
      console.warn("Total pricing mismatch:", totalConsistency.mismatches);
    }

    const totalResult = totalArr.map((item) => ({
      ...item,
      totalCost: totalAggregate.totalCost,
      costPerMillionTokens: totalAggregate.costPerMillionTokens,
      costPerMillionInput: totalAggregate.costPerMillionInput,
      costPerMillionCacheRead: totalAggregate.costPerMillionCacheRead,
      costPerMillionCacheWrite: totalAggregate.costPerMillionCacheWrite,
      costPerMillionOutput: totalAggregate.costPerMillionOutput,
    }));

    // Today / Yesterday cost aggregation
    const dailyModelArr = isStatItemsWithModel(dailyModel) ? dailyModel : [];
    const dailyCostMap = aggregateCostByDate(dailyModelArr);

    // Today / Yesterday keys (UTC)
    const todayKey = formatDateKey(new Date());
    const yesterdayDate = new Date();
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterdayKey = formatDateKey(yesterdayDate);

    // We need raw counts per date, so query date grouping
    const dateRows = await executeStatsQuery({
      groupBy: "date",
      range: "all",
      provider,
      granularity: "day",
      providerFilter,
      model,
      modelFilter,
    });
    const dateArr = isStatItemsWithGroup(dateRows) ? dateRows : [];
    const countMap = new Map<string, number>();
    for (const row of dateArr) {
      countMap.set(String(row.group), toNum(row.count));
    }

    function buildDayData(key: string): DayData | null {
      const entry = dailyCostMap.get(key);
      if (!entry) return null;
      const { aggregate, inputs } = entry;
      if (inputs.length > 0) {
        const consistency = checkPricingConsistency(inputs, aggregate);
        if (!consistency.ok) {
          console.warn(`Daily pricing mismatch for ${key}:`, consistency.mismatches);
        }
      }

      return {
        group: key,
        totalInput: aggregate.inputTokens + aggregate.cacheReadTokens,
        totalInputCached: aggregate.cacheReadTokens,
        totalInputUncached: aggregate.inputTokens,
        totalOutput: aggregate.outputTokens,
        totalCacheWrite: aggregate.cacheWriteTokens,
        count: countMap.get(key) ?? 0,
        totalCost: aggregate.totalCost,
        costPerMillionTokens: aggregate.costPerMillionTokens,
        costPerMillionInput: aggregate.costPerMillionInput,
        costPerMillionCacheRead: aggregate.costPerMillionCacheRead,
        costPerMillionCacheWrite: aggregate.costPerMillionCacheWrite,
        costPerMillionOutput: aggregate.costPerMillionOutput,
      };
    }

    const today = buildDayData(todayKey);
    const yesterday = buildDayData(yesterdayKey);

    return { total: totalResult, today, yesterday };
  },
  ["stats"],
  { tags: [STATS_CACHE_TAG], revalidate: false }
);

export async function GET(request: NextRequest) {
  await initDatabase();
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || "all";
    const model = searchParams.get("model") || "all";

    const { providerFilter, modelFilter } = await resolveDashboardFilters(
      provider,
      model
    );

    validateFilterOrThrow(provider, providerFilter, model, modelFilter);

    const data = await statsCacheFn(provider, providerFilter, model, modelFilter);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown")) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 }
      );
    }
    console.error("Stats error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
