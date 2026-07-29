import { NextRequest, NextResponse } from "next/server";
import { initDatabase } from "@/lib/db";
import {
  executeStatsQuery,
  type StatsQueryResult,
  type TotalStatItem,
  type StatItemWithGroupAndModel,
} from "@/lib/stats-query";
import { aggregateByNormalizedModel, type StatItem } from "@/lib/model-utils";
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
import { TOP_N_DISPLAY, TOP_N_RAW_MODELS } from "@/lib/model-utils";
import {
  resolveDashboardFilters,
  validateFilterOrThrow,
  FilterValidationError,
} from "@/lib/dashboard-utils";
import {
  localDateKeyFromUtcDate,
} from "@/lib/timezone-utils";
export const dynamic = "force-dynamic";

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

function aggregateTopModelsByDate(
  rows: Array<StatItem & { group: string; model: string; provider?: string }>
): Map<string, ModelStat[]> {
  const byDate = new Map<string, StatItem[]>();

  for (const row of rows) {
    const date = String(row.group);
    if (!byDate.has(date)) {
      byDate.set(date, []);
    }
    byDate.get(date)!.push({
      group: String(row.model),
      provider: row.provider,
      totalInput: toNum(row.totalInput),
      totalOutput: toNum(row.totalOutput),
      totalInputCached: toNum(row.totalInputCached),
      totalInputUncached: toNum(row.totalInputUncached),
      totalCacheWrite: toNum(row.totalCacheWrite),
      count: toNum(row.count),
    });
  }

  const result = new Map<string, ModelStat[]>();
  byDate.forEach((items, date) => {
    const aggregated = aggregateByNormalizedModel(items).slice(0, TOP_N_RAW_MODELS);
    const models = aggregated.map((item) => {
      const inputs = [toCostInput(item)];
      const aggregate = aggregateCost(inputs);
      const consistency = checkPricingConsistency(inputs, aggregate);
      if (!consistency.ok) {
        console.warn(
          `Daily model pricing mismatch for ${date}/${item.group}:`,
          consistency.mismatches
        );
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
    result.set(date, models);
  });

  return result;
}

function aggregateCostByDate(
  rows: Array<StatItem & { group: string; model: string; provider?: string }>
): Map<string, { aggregate: AggregatedCost; inputs: CostInput[] }> {
  const map = new Map<
    string,
    { aggregate: AggregatedCost; inputs: CostInput[] }
  >();

  for (const row of rows) {
    const date = String(row.group);
    const canonicalId = normalizeModel(String(row.model), row.provider);
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

function formatDateKey(date: Date, timezoneOffsetMinutes?: number): string {
  if (timezoneOffsetMinutes !== undefined) {
    return localDateKeyFromUtcDate(date, timezoneOffsetMinutes);
  }
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getTotalDays(firstActiveAt?: string, timezoneOffsetMinutes?: number): number {
  if (!firstActiveAt) return 0;
  const first = new Date(firstActiveAt);
  if (Number.isNaN(first.getTime())) return 0;
  const today = new Date();
  const offsetFn =
    timezoneOffsetMinutes !== undefined
      ? (d: Date) => localDateKeyFromUtcDate(d, timezoneOffsetMinutes)
      : (d: Date) =>
          `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const firstKey = offsetFn(first);
  const todayKey = offsetFn(today);
  const start = new Date(`${firstKey}T00:00:00Z`).getTime();
  const end = new Date(`${todayKey}T00:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  const diffMs = end - start;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(1, diffDays + 1);
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
    firstActiveAt?: string;
    lastActiveAt?: string;
    totalCost: number;
    costPerMillionTokens: number;
    costPerMillionInput: number;
    costPerMillionCacheRead: number;
    costPerMillionCacheWrite: number;
    costPerMillionOutput: number;
  }>;
  totalDays: number;
  totalTopModels: ModelStat[];
  today: DayData | null;
  yesterday: DayData | null;
  daily: DayData[];
  models: ModelStat[];
  todayModels: ModelStat[];
  dailyModels: Record<string, ModelStat[]>;
  heatmap: DayData[];
  hourly: DayData[];
  timezoneOffsetMinutes: number;
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

async function queryDashboard(
    range: string,
    provider: string,
    providerFilter: string[] | null,
    model: string,
    modelFilter: string[] | null,
    agentFilter: string | null,
    timezoneOffsetMinutes?: number
  ): Promise<DashboardData> {
    const [
      total,
      totalModels,
      dailyModelAll,
      dateAll,
      dailyRange,
      dailyModelRange,
      modelsRange,
      heatmap,
      hourly,
    ] = await Promise.all([
      executeStatsQuery({
        groupBy: "none",
        range: "all",
        provider,
        providerFilter,
        model,
        modelFilter,
        agentFilter,
        timezoneOffsetMinutes,
      }),
      executeStatsQuery({
        groupBy: "model",
        range: "all",
        provider,
        providerFilter,
        model,
        modelFilter,
        agentFilter,
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
        agentFilter,
        timezoneOffsetMinutes,
      }),
      executeStatsQuery({
        groupBy: "date",
        range: "2d",
        provider,
        granularity: "day",
        providerFilter,
        model,
        modelFilter,
        agentFilter,
        timezoneOffsetMinutes,
      }),
      executeStatsQuery({
        groupBy: "date",
        range,
        provider,
        granularity: "day",
        providerFilter,
        model,
        modelFilter,
        agentFilter,
        timezoneOffsetMinutes,
      }),
      executeStatsQuery({
        groupBy: "date-model",
        range,
        provider,
        granularity: "day",
        providerFilter,
        model,
        modelFilter,
        agentFilter,
        timezoneOffsetMinutes,
      }),
      executeStatsQuery({
        groupBy: "model",
        range,
        provider,
        providerFilter,
        model,
        modelFilter,
        agentFilter,
        timezoneOffsetMinutes,
      }),
      executeStatsQuery({
        groupBy: "date",
        range: "365d",
        provider,
        granularity: "day",
        providerFilter,
        model,
        modelFilter,
        agentFilter,
        timezoneOffsetMinutes,
      }),
      executeStatsQuery({
        groupBy: "date",
        range,
        provider,
        granularity: "hour",
        providerFilter,
        model,
        modelFilter,
        agentFilter,
        timezoneOffsetMinutes,
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

    const totalDays = getTotalDays(
      totalArr[0]?.firstActiveAt,
      timezoneOffsetMinutes
    );

    // Total top models (all-time)
    const totalTopModelsAggregated = aggregateByNormalizedModel(
      totalModelsArr.map((row) => ({
        group: String(row.group),
        provider: row.provider,
        totalInput: toNum(row.totalInput),
        totalOutput: toNum(row.totalOutput),
        totalInputCached: toNum(row.totalInputCached),
        totalInputUncached: toNum(row.totalInputUncached),
        totalCacheWrite: toNum(row.totalCacheWrite),
        count: toNum(row.count),
      }))
    ).slice(0, TOP_N_DISPLAY);
    const totalTopModelsResult = totalTopModelsAggregated.map((item) => {
      const inputs = [toCostInput(item)];
      const aggregate = aggregateCost(inputs);
      const consistency = checkPricingConsistency(inputs, aggregate);
      if (!consistency.ok) {
        console.warn(
          `Total top model pricing mismatch for ${item.group}:`,
          consistency.mismatches
        );
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

    // Today / Yesterday cost aggregation
    const dailyModelAllArr = isStatItemsWithModel(dailyModelAll)
      ? dailyModelAll
      : [];
    const dailyCostMapAll = aggregateCostByDate(dailyModelAllArr);

    // Today / Yesterday keys (local timezone)
    const todayKey = formatDateKey(new Date(), timezoneOffsetMinutes);
    const yesterdayDate = new Date();
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterdayKey = formatDateKey(yesterdayDate, timezoneOffsetMinutes);

    // Raw counts per date
    const dateAllArr = isStatItemsWithGroup(dateAll) ? dateAll : [];
    const countMapAll = new Map<string, number>();
    for (const row of dateAllArr) {
      countMapAll.set(String(row.group), toNum(row.count));
    }

    const today = buildDayData(todayKey, dailyCostMapAll, countMapAll);
    const yesterday = buildDayData(yesterdayKey, dailyCostMapAll, countMapAll);

    // Today's top models (UTC date key, consistent with today/yesterday)
    const todayModelRows = dailyModelAllArr
      .filter((row) => String(row.group) === todayKey)
      .map((row) => ({
        group: String(row.model),
        provider: row.provider,
        totalInput: toNum(row.totalInput),
        totalOutput: toNum(row.totalOutput),
        totalInputCached: toNum(row.totalInputCached),
        totalInputUncached: toNum(row.totalInputUncached),
        totalCacheWrite: toNum(row.totalCacheWrite),
        count: toNum(row.count),
      }));
    const todayModelsAggregated = aggregateByNormalizedModel(todayModelRows).slice(0, 5);
    const todayModelsResult = todayModelsAggregated.map((item) => {
      const inputs = [toCostInput(item)];
      const aggregate = aggregateCost(inputs);
      const consistency = checkPricingConsistency(inputs, aggregate);
      if (!consistency.ok) {
        console.warn(`Today model pricing mismatch for ${item.group}:`, consistency.mismatches);
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

    const dailyTopModelsMap = aggregateTopModelsByDate(dailyModelRangeArr);

    return {
      total: totalResult,
      totalDays,
      totalTopModels: totalTopModelsResult,
      today,
      yesterday,
      daily: dailyResult,
      models: modelsResult,
      todayModels: todayModelsResult,
      dailyModels: Object.fromEntries(dailyTopModelsMap),
      heatmap: isStatItemsWithGroup(heatmap)
        ? heatmap.map((row) => ({
            group: String(row.group),
            totalInput: toNum(row.totalInput),
            totalOutput: toNum(row.totalOutput),
            totalInputCached: toNum(row.totalInputCached),
            totalInputUncached: toNum(row.totalInputUncached),
            totalCacheWrite: toNum(row.totalCacheWrite),
            count: toNum(row.count),
            totalCost: 0,
            costPerMillionTokens: 0,
            costPerMillionInput: 0,
            costPerMillionCacheRead: 0,
            costPerMillionCacheWrite: 0,
            costPerMillionOutput: 0,
          }))
        : [],
      hourly: isStatItemsWithGroup(hourly)
        ? hourly.map((row) => ({
            group: String(row.group),
            totalInput: toNum(row.totalInput),
            totalOutput: toNum(row.totalOutput),
            totalInputCached: toNum(row.totalInputCached),
            totalInputUncached: toNum(row.totalInputUncached),
            totalCacheWrite: toNum(row.totalCacheWrite),
            count: toNum(row.count),
            totalCost: 0,
            costPerMillionTokens: 0,
            costPerMillionInput: 0,
            costPerMillionCacheRead: 0,
            costPerMillionCacheWrite: 0,
            costPerMillionOutput: 0,
          }))
        : [],
      timezoneOffsetMinutes:
        timezoneOffsetMinutes !== undefined
          ? timezoneOffsetMinutes
          : 0,
    };
}

const VALID_RANGES = ["3d", "7d", "14d", "30d"];

export async function GET(request: NextRequest) {
  try {
    await initDatabase();

    const { searchParams } = new URL(request.url);
    const range = searchParams.get("range") || "7d";
    const provider = searchParams.get("provider") || "all";
    const model = searchParams.get("model") || "all";
    const agent = searchParams.get("agent") || "all";
    const tzOffsetParam = searchParams.get("tzOffset");

    let timezoneOffsetMinutes: number | undefined;
    if (tzOffsetParam !== null) {
      timezoneOffsetMinutes = parseInt(tzOffsetParam, 10);
      if (
        Number.isNaN(timezoneOffsetMinutes) ||
        timezoneOffsetMinutes < -720 ||
        timezoneOffsetMinutes > 720
      ) {
        return NextResponse.json(
          {
            success: false,
            error: "Invalid tzOffset. Must be an integer between -720 and 720.",
          },
          { status: 400 }
        );
      }
    }

    if (!VALID_RANGES.includes(range)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid range. Must be one of: ${VALID_RANGES.join(", ")}`,
        },
        { status: 400 }
      );
    }

    const { providerFilter, modelFilter, agentFilter } = await resolveDashboardFilters(
      provider,
      model,
      agent
    );

    validateFilterOrThrow(provider, providerFilter, model, modelFilter);

    const data = await queryDashboard(
      range,
      provider,
      providerFilter?.slice().sort() ?? null,
      model,
      modelFilter?.slice().sort() ?? null,
      agentFilter,
      timezoneOffsetMinutes
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
