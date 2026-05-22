import { db } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import {
  TOP_N_RAW_MODELS,
  TOP_N_DISPLAY,
  aggregateByNormalizedModel,
  type StatItem,
} from "@/lib/model-utils";
import { deanonymizeProvider } from "@/lib/provider-utils";

// Helper to build combined WHERE clause
function buildWhereClause(
  dateFilter: Date | null,
  providerFilter: string | null
) {
  if (dateFilter && providerFilter) {
    return sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()} AND ${tokenRecords.provider} = ${providerFilter}`;
  } else if (dateFilter) {
    return sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`;
  } else if (providerFilter) {
    return sql`${tokenRecords.provider} = ${providerFilter}`;
  }
  return null;
}

export async function executeStatsQuery(params: {
  groupBy: string;
  range: string;
  provider: string;
  granularity?: string;
}): Promise<unknown> {
  const { groupBy, range, provider, granularity } = params;

  // 计算时间范围
  let dateFilter: Date | null = null;
  if (range !== "all") {
    const days = parseInt(range);
    dateFilter = new Date();
    dateFilter.setDate(dateFilter.getDate() - days);
  }

  // Deanonymize provider if a specific one is selected
  let providerFilter: string | null = null;
  if (provider !== "all") {
    const allProviderRows = await db
      .selectDistinct({ provider: tokenRecords.provider })
      .from(tokenRecords);
    const allProviderNames: string[] = allProviderRows
      .map((r) => r.provider)
      .filter((n): n is string => n !== null && n !== undefined);

    providerFilter = deanonymizeProvider(provider, allProviderNames);

    if (!providerFilter) {
      throw new Error(`Unknown provider: ${provider}`);
    }
  }

  let query;

  if (groupBy === "none") {
    query = db
      .select({
        group: sql<string>`'total'`,
        totalInput: sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
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
        totalInput: sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
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
        totalInput: sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
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
        totalInput: sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
        totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
        totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
        totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
        totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(tokenRecords)
      .groupBy(tokenRecords.provider)
      .orderBy(sql`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead}) DESC`);

    const whereClause = buildWhereClause(dateFilter, providerFilter);
    if (whereClause) {
      query = query.where(whereClause);
    }
  }

  const data = await query;
  return data;
}
