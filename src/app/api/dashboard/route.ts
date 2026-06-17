import { NextRequest, NextResponse } from "next/server";
import { initDatabase } from "@/lib/db";
import {
  executeStatsQuery,
  type StatsQueryResult,
  type TotalStatItem,
  type StatItemWithGroupAndModel,
} from "@/lib/stats-query";
import { type StatItem } from "@/lib/model-utils";
import { unstable_cache } from "next/cache";
import { normalizeModel, getDisplayName, getPricing } from "@/lib/model-registry";
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
import {
  resolveDashboardFilters,
  validateFilterOrThrow,
  FilterValidationError,
} from "@/lib/dashboard-utils";
import { DASHBOARD_CACHE_TAG } from "@/lib/cache";

function isTotalStatItems(data: StatsQueryResult): data is TotalStatItem[] {
  return Array.isArray(data) && (data.length === 0 || "lastActiveAt" in data[0]);
}

function isStatItemsWithGroup(
  data: StatsQueryResult
): data is Array<StatItem & { group: string }> {
  return Array.isArray(data) && data.length > 0 && "group" in data[0];
}

function isStatItemsWithModel(
  data: StatsQueryResult
): data is StatItemWithGroupAndModel[] {
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
  const map = new Map<
    string,
    { aggregate: AggregatedCost; inputs: CostInput[] }
  >();

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

interface ModelStat extends StatItem {
  canonicalId: string;
  displayName: string;
  totalCost: number;
  costPerMillionTokens: number;
  costPerMillionInput: number;
  costPerMillionCacheRead: number;
  costPerMillionCacheWrite: number;
  costPerMillionOutput: number;
}

interface DashboardData {
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
  daily: DayData[];
  models: ModelStat[];
}

function buildDayData(
  key: string,
  costMap: Map<string, { aggregate: AggregatedCost; inputs: CostInput[] }>,
  countMap: Map<string, number>
): DayData | null {
  const entry = costMap.get(key);
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

const dashboardCacheFn = unstable_cache(
  async (
    range: string,
    provider: string,
    providerFilter: string[] | null,
    model: string,
    modelFilter: string[] | null
  ): Promise<DashboardData> => {
    const [
      total,
      totalModels,
      dailyModelAll,
      dateAll,
      dailyRange,
      dailyModelRange,
      modelsRange,
    ] = await Promise.all([
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
        range: "2d",
        provider,
        granularity: "day",
        providerFilter,
        model,
        modelFilter,
      }),
      executeStatsQuery({
        groupBy: "date",
        range: "2d",
        provider,
        granularity: "day",
        providerFilter,
        model,
        modelFilter,
      }),
      executeStatsQuery({
        groupBy: "date",
        range,
        provider,
        granularity: "day",
        providerFilter,
        model,
        modelFilter,
      }),
      executeStatsQuery({
        groupBy: "date-model",
        range,
        provider,
        granularity: "day",
        providerFilter,
        model,
        modelFilter,
      }),
      executeStatsQuery({
        groupBy: "model",
        range,
        provider,
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
    const dailyModelAllArr = isStatItemsWithModel(dailyModelAll)
      ? dailyModelAll
      : [];
    const dailyCostMapAll = aggregateCostByDate(dailyModelAllArr);

    // Today / Yesterday keys (UTC)
    const todayKey = formatDateKey(new Date());
    const yesterdayDate = new Date();
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterdayKey = formatDateKey(yesterdayDate);

    // Raw counts per date
    const dateAllArr = isStatItemsWithGroup(dateAll) ? dateAll : [];
    const countMapAll = new Map<string, number>();
    for (const row of dateAllArr) {
      countMapAll.set(String(row.group), toNum(row.count));
    }

    const today = buildDayData(todayKey, dailyCostMapAll, countMapAll);
    const yesterday = buildDayData(yesterdayKey, dailyCostMapAll, countMapAll);

    // Daily cost aggregation for selected range
    const dailyArr = isStatItemsWithGroup(dailyRange) ? dailyRange : [];
    const dailyModelRangeArr = isStatItemsWithModel(dailyModelRange)
      ? dailyModelRange
      : [];
    const dailyCostMapRange = aggregateCostByDate(dailyModelRangeArr);

    const dailyResult = dailyArr.map((item) => {
      const { aggregate, inputs } = dailyCostMapRange.get(item.group) ?? {
        aggregate: null,
        inputs: [],
      };
      if (aggregate && inputs.length > 0) {
        const consistency = checkPricingConsistency(inputs, aggregate);
        if (!consistency.ok) {
          console.warn(
            `Daily pricing mismatch for ${item.group}:`,
            consistency.mismatches
          );
        }
      }
      return {
        ...item,
        totalCost: aggregate?.totalCost ?? 0,
        costPerMillionTokens: aggregate?.costPerMillionTokens ?? 0,
        costPerMillionInput: aggregate?.costPerMillionInput ?? 0,
        costPerMillionCacheRead: aggregate?.costPerMillionCacheRead ?? 0,
        costPerMillionCacheWrite: aggregate?.costPerMillionCacheWrite ?? 0,
        costPerMillionOutput: aggregate?.costPerMillionOutput ?? 0,
      };
    });

    // Top models with cost
    const modelsArr = isStatItemsWithGroup(modelsRange) ? modelsRange : [];
    const modelsResult = modelsArr.map((item) => {
      const inputs = [toCostInput(item)];
      const aggregate = aggregateCost(inputs);
      const consistency = checkPricingConsistency(inputs, aggregate);
      if (!consistency.ok) {
        console.warn(`Model pricing mismatch for ${item.group}:`, consistency.mismatches);
      }
      return {
        ...item,
        canonicalId: item.group,
        displayName: getDisplayName(item.group),
        totalCost: aggregate.totalCost,
        costPerMillionTokens: aggregate.costPerMillionTokens,
        costPerMillionInput: aggregate.costPerMillionInput,
        costPerMillionCacheRead: aggregate.costPerMillionCacheRead,
        costPerMillionCacheWrite: aggregate.costPerMillionCacheWrite,
        costPerMillionOutput: aggregate.costPerMillionOutput,
      };
    });

    return { total: totalResult, today, yesterday, daily: dailyResult, models: modelsResult };
  },
  ["dashboard"],
  { tags: [DASHBOARD_CACHE_TAG], revalidate: false }
);

const VALID_RANGES = ["3d", "7d", "14d", "30d"];

export async function GET(request: NextRequest) {
  try {
    await initDatabase();

    const { searchParams } = new URL(request.url);
    const range = searchParams.get("range") || "7d";
    const provider = searchParams.get("provider") || "all";
    const model = searchParams.get("model") || "all";

    if (!VALID_RANGES.includes(range)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid range. Must be one of: ${VALID_RANGES.join(", ")}`,
        },
        { status: 400 }
      );
    }

    const { providerFilter, modelFilter } = await resolveDashboardFilters(
      provider,
      model
    );

    validateFilterOrThrow(provider, providerFilter, model, modelFilter);

    const data = await dashboardCacheFn(
      range,
      provider,
      providerFilter?.slice().sort() ?? null,
      model,
      modelFilter?.slice().sort() ?? null
    );
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof FilterValidationError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 }
      );
    }
    console.error("Dashboard error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
