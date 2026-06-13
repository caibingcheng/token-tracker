import { NextRequest, NextResponse } from "next/server";
import { initDatabase, db } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { executeStatsQuery, type StatsQueryResult, type TotalStatItem, type StatItemWithGroupAndModel } from "@/lib/stats-query";
import { type StatItem } from "@/lib/model-utils";
import { unstable_cache } from "next/cache";
import { resolveProviderFilter } from "@/lib/provider-utils";
import { resolveNormalizedModelFilter } from "@/lib/model-utils";
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

const DASHBOARD_CACHE_TAG = "api-dashboard";

interface DashboardRow {
  group: string;
  totalInput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalOutput: number;
  totalCacheWrite: number;
  count: number;
  lastActiveAt?: string;
}

// Type guards for StatsQueryResult narrowing
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

const dashboardCacheFn = unstable_cache(
  async (
    range: string,
    provider: string,
    providerFilter: string[] | null,
    model: string,
    modelFilter: string[] | null
  ) => {
    const [total, totalModels, daily, dailyModel, models] = await Promise.all([
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

    // Total summary
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

    // Daily cost aggregation
    const dailyArr = isStatItemsWithGroup(daily) ? daily : [];
    const dailyModelArr = isStatItemsWithModel(dailyModel) ? dailyModel : [];
    const dailyCostMap = aggregateCostByDate(dailyModelArr);

    const dailyResult = dailyArr.map((item) => {
      const { aggregate, inputs } = dailyCostMap.get(item.group) ?? {
        aggregate: null,
        inputs: [],
      };
      if (aggregate && inputs.length > 0) {
        const consistency = checkPricingConsistency(inputs, aggregate);
        if (!consistency.ok) {
          console.warn(`Daily pricing mismatch for ${item.group}:`, consistency.mismatches);
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
    const modelsArr = isStatItemsWithGroup(models) ? models : [];
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

    return { total: totalResult, daily: dailyResult, models: modelsResult };
  },
  ["dashboard"],
  { tags: [DASHBOARD_CACHE_TAG], revalidate: false }
);

const VALID_RANGES = ["3d", "7d", "14d", "30d"];

export async function GET(request: NextRequest) {
  await initDatabase();
  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get("range") || "7d";
    const provider = searchParams.get("provider") || "all";
    const model = searchParams.get("model") || "all";

    // 参数校验
    if (!VALID_RANGES.includes(range)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid range. Must be one of: ${VALID_RANGES.join(", ")}`,
        },
        { status: 400 }
      );
    }

    // 预先查询 provider mapping（避免 N+1 查询）
    let providerFilter: string[] | null = null;
    if (provider !== "all") {
      const allProviderRows = await db
        .selectDistinct({ provider: tokenRecords.provider })
        .from(tokenRecords);
      const allProviderNames = allProviderRows
        .map((r) => r.provider)
        .filter((n): n is string => n !== null && n !== undefined);

      providerFilter = resolveProviderFilter(provider, allProviderNames);

      if (!providerFilter || providerFilter.length === 0) {
        return NextResponse.json(
          { success: false, error: `Unknown provider: ${provider}` },
          { status: 400 }
        );
      }
    }

    // 预先查询 model mapping（避免 N+1 查询）
    let modelFilter: string[] | null = null;
    if (model !== "all") {
      const allModelRows = await db
        .selectDistinct({ model: tokenRecords.model })
        .from(tokenRecords);
      const allRawModels = allModelRows
        .map((r) => r.model)
        .filter((n): n is string => n !== null && n !== undefined);

      modelFilter = resolveNormalizedModelFilter(model, allRawModels);

      if (!modelFilter || modelFilter.length === 0) {
        return NextResponse.json(
          { success: false, error: `Unknown model: ${model}` },
          { status: 400 }
        );
      }
    }

    const data = await dashboardCacheFn(
      range,
      provider,
      providerFilter,
      model,
      modelFilter
    );
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Dashboard error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
