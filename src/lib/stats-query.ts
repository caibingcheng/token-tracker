import { db } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { sql, and, eq, inArray } from "drizzle-orm";
import {
  TOP_N_RAW_MODELS,
  TOP_N_DISPLAY,
  aggregateByNormalizedModel,
  normalizeModel,
  type StatItem,
} from "@/lib/model-utils";
import { resolveProviderFilter } from "@/lib/provider-utils";
import { toNum } from "@/lib/number-utils";

export interface StatItemWithGroup extends StatItem {
  group: string;
}

export interface StatItemWithGroupAndModel extends StatItemWithGroup {
  model: string;
}

export interface TotalStatItem extends StatItemWithGroup {
  lastActiveAt?: string;
}

export type StatsQueryResult =
  | TotalStatItem[]
  | StatItemWithGroup[]
  | StatItemWithGroupAndModel[]
  | StatItem[];

// Helper to build combined WHERE clause
function buildWhereClause(
  dateFilter: Date | null,
  providerFilter: string[] | null,
  modelFilter: string[] | null
) {
  const conditions = [];

  if (dateFilter) {
    conditions.push(
      sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`
    );
  }

  if (providerFilter && providerFilter.length > 0) {
    if (providerFilter.length === 1) {
      conditions.push(eq(tokenRecords.provider, providerFilter[0]));
    } else {
      conditions.push(inArray(tokenRecords.provider, providerFilter));
    }
  }

  if (modelFilter && modelFilter.length > 0) {
    if (modelFilter.length === 1) {
      conditions.push(eq(tokenRecords.model, modelFilter[0]));
    } else {
      conditions.push(inArray(tokenRecords.model, modelFilter));
    }
  }

  return conditions.length > 0 ? and(...conditions) : null;
}

function getDateGroupExpr(granularity: string) {
  if (granularity === "week") {
    return sql<string>`TO_CHAR(${tokenRecords.createdAt}, 'YYYY-WW')`;
  }
  if (granularity === "month") {
    return sql<string>`TO_CHAR(${tokenRecords.createdAt}, 'YYYY-MM')`;
  }
  return sql<string>`TO_CHAR(${tokenRecords.createdAt}, 'YYYY-MM-DD')`;
}

export async function executeStatsQuery(params: {
  groupBy: string;
  range: string;
  provider: string;
  granularity?: string;
  providerFilter?: string[] | null;
  model?: string;
  modelFilter?: string[] | null;
  limit?: number | null;
}): Promise<StatsQueryResult> {
  const {
    groupBy,
    range,
    provider,
    granularity,
    providerFilter: precomputedProviderFilter,
    model,
    modelFilter: precomputedModelFilter,
    limit,
  } = params;

  // 计算时间范围
  let dateFilter: Date | null = null;
  if (range !== "all") {
    const days = parseInt(range, 10);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(`Invalid range: ${range}`);
    }
    const now = new Date();
    dateFilter = new Date(now);
    dateFilter.setDate(dateFilter.getDate() - days);
  }

  // Resolve provider filter if a specific one is selected
  let providerFilter: string[] | null = precomputedProviderFilter ?? null;
  if (provider !== "all" && !providerFilter) {
    const allProviderRows = await db
      .selectDistinct({ provider: tokenRecords.provider })
      .from(tokenRecords);
    const allProviderNames: string[] = allProviderRows
      .map((r) => r.provider)
      .filter((n): n is string => n !== null && n !== undefined);

    providerFilter = resolveProviderFilter(provider, allProviderNames);

    if (!providerFilter || providerFilter.length === 0) {
      throw new Error(`Unknown provider: ${provider}`);
    }
  }

  // Resolve model filter if a specific one is selected
  let modelFilter: string[] | null = precomputedModelFilter ?? null;
  if (model && model !== "all" && !modelFilter) {
    const allModelRows = await db
      .selectDistinct({ model: tokenRecords.model })
      .from(tokenRecords);
    const allRawModels: string[] = allModelRows
      .map((r) => r.model)
      .filter((n): n is string => n !== null && n !== undefined);

    // 找到所有原始 model 名称中归一化后等于所选 model 的
    const matchedRawModels: string[] = [];
    for (const raw of allRawModels) {
      if (normalizeModel(raw) === model) {
        matchedRawModels.push(raw);
      }
    }

    if (matchedRawModels.length === 0) {
      throw new Error(`Unknown model: ${model}`);
    }
    modelFilter = matchedRawModels;
  }

  let query;

  if (groupBy === "none") {
    query = db
      .select({
        group: sql<string>`'total'`,
        totalInput:
          sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
        totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
        totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
        totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
        totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
        count: sql<number>`COUNT(*)`,
        lastActiveAt: sql<string>`MAX(${tokenRecords.createdAt})`,
      })
      .from(tokenRecords);

    const whereClause = buildWhereClause(dateFilter, providerFilter, modelFilter);
    if (whereClause) {
      query = query.where(whereClause);
    }
  } else if (groupBy === "date") {
    const effectiveGranularity = granularity || "day";
    const groupExpr = getDateGroupExpr(effectiveGranularity);

    query = db
      .select({
        group: groupExpr,
        totalInput:
          sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
        totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
        totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
        totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
        totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(tokenRecords)
      .groupBy(groupExpr)
      .orderBy(groupExpr);

    const whereClause = buildWhereClause(dateFilter, providerFilter, modelFilter);
    if (whereClause) {
      query = query.where(whereClause);
    }
  } else if (groupBy === "date-model") {
    const effectiveGranularity = granularity || "day";
    const groupExpr = getDateGroupExpr(effectiveGranularity);

    query = db
      .select({
        group: groupExpr,
        model: tokenRecords.model,
        totalInput:
          sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
        totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
        totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
        totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
        totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(tokenRecords)
      .groupBy(groupExpr, tokenRecords.model)
      .orderBy(groupExpr, tokenRecords.model);

    const whereClause = buildWhereClause(dateFilter, providerFilter, modelFilter);
    if (whereClause) {
      query = query.where(whereClause);
    }
  } else if (groupBy === "model") {
    // 先按原始 model 分组取 Top N，再应用层归一化合并
    // 当 modelFilter 生效时（按特定归一化 model 筛选），不限制原始 model 数量
    const whereClause = buildWhereClause(dateFilter, providerFilter, modelFilter);

    const effectiveLimit = limit === null ? null : TOP_N_RAW_MODELS;

    let rawData;
    if (modelFilter || effectiveLimit === null) {
      // 有 modelFilter 或不限制时，不限制数量
      const query = db
        .select({
          group: tokenRecords.model,
          totalInput:
            sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
          totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords)
        .groupBy(tokenRecords.model)
        .orderBy(
          sql`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead}) DESC`
        );
      rawData = whereClause ? await query.where(whereClause) : await query;
    } else {
      // 无 modelFilter 时限制原始 model 数量
      const query = db
        .select({
          group: tokenRecords.model,
          totalInput:
            sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
          totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords)
        .groupBy(tokenRecords.model)
        .orderBy(
          sql`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead}) DESC`
        )
        .limit(TOP_N_RAW_MODELS);
      rawData = whereClause ? await query.where(whereClause) : await query;
    }

    const data = aggregateByNormalizedModel(
      rawData.map((row) => ({
        group: String(row.group),
        totalInput: toNum(row.totalInput),
        totalOutput: toNum(row.totalOutput),
        totalInputCached: toNum(row.totalInputCached),
        totalInputUncached: toNum(row.totalInputUncached),
        totalCacheWrite: toNum(row.totalCacheWrite),
        count: toNum(row.count),
      }))
    );

    if (!modelFilter && effectiveLimit !== null) {
      return data.slice(0, TOP_N_DISPLAY);
    }
    return data;
  } else {
    // provider
    query = db
      .select({
        group: tokenRecords.provider,
        totalInput:
          sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
        totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
        totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
        totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
        totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(tokenRecords)
      .groupBy(tokenRecords.provider)
      .orderBy(
        sql`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead}) DESC`
      );

    const whereClause = buildWhereClause(dateFilter, providerFilter, modelFilter);
    if (whereClause) {
      query = query.where(whereClause);
    }
  }

  const data = await query;
  return data as StatsQueryResult;
}
