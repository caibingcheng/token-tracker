import { db } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { sql, and, eq, inArray } from "drizzle-orm";
import {
  TOP_N_RAW_MODELS,
  TOP_N_DISPLAY,
  aggregateByNormalizedModel,
  type StatItem,
} from "@/lib/model-utils";
import { resolveProviderFilter } from "@/lib/provider-utils";

// Helper to build combined WHERE clause
function buildWhereClause(
  dateFilter: Date | null,
  providerFilter: string[] | null
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

  return conditions.length > 0 ? and(...conditions) : null;
}

export async function executeStatsQuery(params: {
  groupBy: string;
  range: string;
  provider: string;
  granularity?: string;
  providerFilter?: string[] | null;
}): Promise<unknown> {
  const {
    groupBy,
    range,
    provider,
    granularity,
    providerFilter: precomputedFilter,
  } = params;

  // 计算时间范围
  let dateFilter: Date | null = null;
  if (range !== "all") {
    const days = parseInt(range);
    dateFilter = new Date();
    dateFilter.setDate(dateFilter.getDate() - days);
  }

  // Resolve provider filter if a specific one is selected
  let providerFilter: string[] | null = precomputedFilter ?? null;
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

    const whereClause = buildWhereClause(dateFilter, providerFilter);
    if (whereClause) {
      query = query.where(whereClause);
    }
  } else if (groupBy === "date") {
    const effectiveGranularity = granularity || "day";
    let dateFormat: string;

    if (effectiveGranularity === "week") {
      dateFormat = "YYYY-WW";
    } else if (effectiveGranularity === "month") {
      dateFormat = "YYYY-MM";
    } else {
      dateFormat = "YYYY-MM-DD";
    }

    // 使用 sql.raw 内联格式字符串，避免 GROUP BY 参数化问题
    const groupExpr = sql<string>`TO_CHAR(${tokenRecords.createdAt}, ${sql.raw(`'${dateFormat}'`)})`;

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

    const whereClause = buildWhereClause(dateFilter, providerFilter);
    if (whereClause) {
      query = query.where(whereClause);
    }
  } else if (groupBy === "date-model") {
    const effectiveGranularity = granularity || "day";
    let dateFormat: string;
    if (effectiveGranularity === "week") {
      dateFormat = "YYYY-WW";
    } else if (effectiveGranularity === "month") {
      dateFormat = "YYYY-MM";
    } else {
      dateFormat = "YYYY-MM-DD";
    }
    const groupExpr = sql<string>`TO_CHAR(${tokenRecords.createdAt}, ${sql.raw(`'${dateFormat}'`)})`;

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

    const whereClause = buildWhereClause(dateFilter, providerFilter);
    if (whereClause) {
      query = query.where(whereClause);
    }
  } else if (groupBy === "model") {
    // 先按原始 model 分组取 Top 20，再应用层归一化合并取 Top 5
    const rawQuery = db
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

    const whereClause = buildWhereClause(dateFilter, providerFilter);
    const rawData = whereClause
      ? await rawQuery.where(whereClause)
      : await rawQuery;

    const data = aggregateByNormalizedModel(
      rawData as unknown as StatItem[]
    ).slice(0, TOP_N_DISPLAY);

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

    const whereClause = buildWhereClause(dateFilter, providerFilter);
    if (whereClause) {
      query = query.where(whereClause);
    }
  }

  const data = await query;
  return data;
}
