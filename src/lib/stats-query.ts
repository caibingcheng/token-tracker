import { db, tokenRecords, getDateGroupExpr } from "@/lib/db";
import { sql, and, eq, inArray, notInArray, isNull } from "drizzle-orm";
import {
  localDateKeyToUtcStartISO,
  computeRangeStartDateKey,
} from "@/lib/timezone-utils";
import {
  TOP_N_RAW_MODELS,
  TOP_N_DISPLAY,
  aggregateByNormalizedModel,
  normalizeModel,
  type StatItem,
} from "@/lib/model-utils";
import { resolveProviderFilter, loadHiddenProviderGroups } from "@/lib/provider-utils";
import { loadModelAliases, loadHiddenSources } from "@/lib/auth/settings";
import type { AgentUaFilter } from "@/lib/agent-utils";
import { toNum } from "@/lib/number-utils";
import { loadPriceMap, computeModelCost } from "@/lib/pricing";

export interface StatItemWithGroup extends StatItem {
  group: string;
}

export interface StatItemWithGroupAndModel extends StatItemWithGroup {
  model: string;
  provider?: string;
}

export interface TotalStatItem extends StatItemWithGroup {
  firstActiveAt?: string;
  lastActiveAt?: string;
}

export type StatsQueryResult =
  | TotalStatItem[]
  | StatItemWithGroup[]
  | StatItemWithGroupAndModel[]
  | StatItem[];

// Helper to build combined WHERE clause
// agentUaFilter：Agent 维度（派生工具名）按 UA 反找后的集合——unknown → IS NULL
// （user_agent 列可空）；否则 user_agent IN (uas)。exclude.agents（Hidden Sources
// excludedVirtualKeys）仍按 agent 列（来源 key 名）NOT IN 排除，语义不变。
export function buildWhereClause(
  dateFilter: Date | string | null,
  providerFilter: string[] | null,
  modelFilter: string[] | null,
  agentUaFilter: AgentUaFilter,
  timezoneOffsetMinutes?: number,
  exclude?: { providers: string[]; agents: string[] }
) {
  const conditions = [];

  if (dateFilter) {
    if (typeof dateFilter === "string" && timezoneOffsetMinutes !== undefined) {
      // 直比较 UTC 日界起始时刻：可命中 idx_token_records_created_at（strftime 套列不可命中）
      const utcStart = localDateKeyToUtcStartISO(dateFilter, timezoneOffsetMinutes);
      conditions.push(sql`${tokenRecords.createdAt} >= ${utcStart}`);
    } else if (dateFilter instanceof Date) {
      conditions.push(
        sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`
      );
    }
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

  if (agentUaFilter) {
    if ("unknown" in agentUaFilter) {
      conditions.push(isNull(tokenRecords.userAgent));
    } else if (agentUaFilter.uas.length > 0) {
      conditions.push(inArray(tokenRecords.userAgent, agentUaFilter.uas));
    }
  }

  // 独立排除的隐藏数据源（excluded 列表，与隐藏状态无关）：provider/agent 列均 notNull，
  // 直接 NOT IN 排除；'unknown' 等遗留值不在排除列表中时自然保留
  if (exclude) {
    if (exclude.providers.length > 0) {
      conditions.push(notInArray(tokenRecords.provider, exclude.providers));
    }
    if (exclude.agents.length > 0) {
      conditions.push(notInArray(tokenRecords.agent, exclude.agents));
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
  model?: string;
  modelFilter?: string[] | null;
  agentUaFilter: AgentUaFilter;
  limit?: number | null;
  timezoneOffsetMinutes?: number;
}): Promise<StatsQueryResult> {
  const groups = await loadHiddenProviderGroups();
  const aliases = await loadModelAliases();
  const hiddenSources = await loadHiddenSources();
  // 独立排除列表（不依赖隐藏状态；空数组由 buildWhereClause 跳过）
  const exclude = {
    providers: hiddenSources.excludedUpstreams,
    agents: hiddenSources.excludedVirtualKeys,
  };
  const {
    groupBy,
    range,
    provider,
    granularity,
    providerFilter: precomputedProviderFilter,
    model,
    modelFilter: precomputedModelFilter,
    agentUaFilter,
    limit,
    timezoneOffsetMinutes,
  } = params;

  // 计算时间范围
  let dateFilter: Date | string | null = null;
  if (range !== "all") {
    const days = parseInt(range, 10);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(`Invalid range: ${range}`);
    }
    if (timezoneOffsetMinutes !== undefined) {
      dateFilter = computeRangeStartDateKey(
        days,
        timezoneOffsetMinutes
      );
    } else {
      dateFilter = new Date();
      dateFilter.setDate(dateFilter.getDate() - days);
    }
  }

  // Resolve provider filter if a specific one is selected
  let providerFilter: string[] | null = precomputedProviderFilter ?? null;
  if (provider !== "all" && !providerFilter) {
    const allProviderRows = await db
      .selectDistinct({ provider: tokenRecords.provider })
      .from(tokenRecords);
      const allProviderNames: string[] = allProviderRows
        .map((r: any) => r.provider)
        .filter((n: any): n is string => n !== null && n !== undefined);

    providerFilter = resolveProviderFilter(provider, allProviderNames, groups);

    if (!providerFilter || providerFilter.length === 0) {
      throw new Error(`Unknown provider: ${provider}`);
    }
  }

  // Resolve model filter if a specific one is selected
  let modelFilter: string[] | null = precomputedModelFilter ?? null;
  if (model && model !== "all" && !modelFilter) {
    const allModelRows = await db
      .selectDistinct({ model: tokenRecords.model, provider: tokenRecords.provider })
      .from(tokenRecords);
      const allRawModels: string[] = allModelRows
        .map((r: any) => r.model)
        .filter((n: any): n is string => n !== null && n !== undefined);
    const providerByModel = new Map<string, string>();
    for (const row of allModelRows) {
      if (row.model && row.provider) {
        providerByModel.set(row.model, row.provider);
      }
    }

    // 找到所有原始 model 名称中归一化后等于所选 model 的
    const matchedRawModels: string[] = [];
    for (const raw of allRawModels) {
      const provider = providerByModel.get(raw);
      if (normalizeModel(raw, provider, groups, aliases) === model) {
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
        firstActiveAt: sql<string>`MIN(${tokenRecords.createdAt})`,
        lastActiveAt: sql<string>`MAX(${tokenRecords.createdAt})`,
      })
      .from(tokenRecords);

    const whereClause = buildWhereClause(
      dateFilter,
      providerFilter,
      modelFilter,
      agentUaFilter,
      timezoneOffsetMinutes,
      exclude
    );
    if (whereClause) {
      query = query.where(whereClause);
    }
  } else if (groupBy === "date") {
    const effectiveGranularity = granularity || "day";
    const groupExpr = getDateGroupExpr(
      effectiveGranularity,
      timezoneOffsetMinutes
    );

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

    const whereClause = buildWhereClause(
      dateFilter,
      providerFilter,
      modelFilter,
      agentUaFilter,
      timezoneOffsetMinutes,
      exclude
    );
    if (whereClause) {
      query = query.where(whereClause);
    }
  } else if (groupBy === "date-model") {
    const effectiveGranularity = granularity || "day";
    const groupExpr = getDateGroupExpr(
      effectiveGranularity,
      timezoneOffsetMinutes
    );

    const priceMap = await loadPriceMap();

    query = db
      .select({
        group: groupExpr,
        model: tokenRecords.model,
        provider: tokenRecords.provider,
        totalInput:
          sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
        totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
        totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
        totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
        totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(tokenRecords)
      .groupBy(groupExpr, tokenRecords.provider, tokenRecords.model)
      .orderBy(groupExpr, tokenRecords.provider, tokenRecords.model);

    const whereClause = buildWhereClause(
      dateFilter,
      providerFilter,
      modelFilter,
      agentUaFilter,
      timezoneOffsetMinutes,
      exclude
    );
    if (whereClause) {
      query = query.where(whereClause);
    }

    const rows = await query;
    // 成本按真实 model 名定价（模型级行附加 cost，供上层 roll up）
    return rows.map((row: any) =>
      attachCost(row, priceMap, String(row.model))
    );
  } else if (groupBy === "model") {
    // 先按 (provider, 原始 model) 分组取 Top N，再应用层归一化合并
    // 当 modelFilter 生效时（按特定归一化 model 筛选），不限制原始 model 数量
    const whereClause = buildWhereClause(
      dateFilter,
      providerFilter,
      modelFilter,
      agentUaFilter,
      timezoneOffsetMinutes,
      exclude
    );

    const effectiveLimit = limit === null ? null : TOP_N_RAW_MODELS;

    let rawData;
    if (modelFilter || effectiveLimit === null) {
      // 有 modelFilter 或不限制时，不限制数量
      const query = db
        .select({
          group: tokenRecords.model,
          provider: tokenRecords.provider,
          totalInput:
            sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
          totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords)
        .groupBy(tokenRecords.provider, tokenRecords.model)
        .orderBy(
          sql`SUM(${tokenRecords.inputTokens}) DESC`
        );
      rawData = whereClause ? await query.where(whereClause) : await query;
    } else {
      // 无 modelFilter 时限制原始 model 数量
      const query = db
        .select({
          group: tokenRecords.model,
          provider: tokenRecords.provider,
          totalInput:
            sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
          totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords)
        .groupBy(tokenRecords.provider, tokenRecords.model)
        .orderBy(
          sql`SUM(${tokenRecords.inputTokens}) DESC`
        )
        .limit(TOP_N_RAW_MODELS);
      rawData = whereClause ? await query.where(whereClause) : await query;
    }

    const priceMap = await loadPriceMap();
    const data = aggregateByNormalizedModel(
      rawData.map((row: any) =>
        attachCost(row, priceMap, String(row.group))
      ),
      groups,
      aliases
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
        sql`SUM(${tokenRecords.inputTokens}) DESC`
      );

    const whereClause = buildWhereClause(
      dateFilter,
      providerFilter,
      modelFilter,
      agentUaFilter,
      timezoneOffsetMinutes,
      exclude
    );
    if (whereClause) {
      query = query.where(whereClause);
    }
  }

  const data = await query;
  return data as StatsQueryResult;
}

// 给模型级分组行附加成本聚合（按真实 model 名定价；未定价 → 全 0）
function attachCost(
  row: any,
  priceMap: Map<string, any>,
  modelName: string
): StatItemWithGroupAndModel {
  return {
    group: String(row.group),
    model: modelName,
    provider: row.provider ?? undefined,
    totalInput: toNum(row.totalInput),
    totalOutput: toNum(row.totalOutput),
    totalInputCached: toNum(row.totalInputCached),
    totalInputUncached: toNum(row.totalInputUncached),
    totalCacheWrite: toNum(row.totalCacheWrite),
    count: toNum(row.count),
    cost: computeModelCost(
      modelName,
      {
        inputTokens: toNum(row.totalInputUncached),
        cacheRead: toNum(row.totalInputCached),
        cacheWrite: toNum(row.totalCacheWrite),
        outputTokens: toNum(row.totalOutput),
      },
      priceMap
    ),
  };
}
