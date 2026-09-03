import { db, tokenRecords } from "@/lib/db";
import { buildWhereClause } from "@/lib/stats-query";
import {
  localDateKeyFromUtcDate,
  computeRangeStartDateKey,
} from "@/lib/timezone-utils";
import { normalizeModel } from "@/lib/model-utils";
import { loadUpstreamModelRows, RECENT_ACTIVITY_WINDOW_MS } from "@/lib/model-prices-service";
import { loadHiddenSources } from "@/lib/auth/settings";
import { toNum } from "@/lib/number-utils";
import { providerGroupKey, type HiddenProviderGroup } from "@/lib/provider-utils";
import type { ModelAliasRule } from "@/lib/model-registry";
import type { AgentUaFilter } from "@/lib/agent-utils";
import { gte } from "drizzle-orm";
import { withSkipCache } from "@/lib/db/cache";

// 近 30 天有记录（本机 + 推送）模型集合（与 model_prices 面板同源）
async function loadRecentActivityModels(): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - RECENT_ACTIVITY_WINDOW_MS).toISOString();
  const rows = (await withSkipCache(async () =>
    db
      .selectDistinct({ model: tokenRecords.model })
      .from(tokenRecords)
      .where(gte(tokenRecords.createdAt, cutoff))
  )) as Array<{ model: string }>;
  return new Set(rows.map((r) => r.model));
}

// 延迟统计：TTFT（流式首 token）/ 总延迟 / 生成速度。
// ttft_ms 仅流式请求有值（非流式为 NULL），latency_ms 为全部请求。
// byModel 只保留当前启用上游 enabled_models 中的 model（active 过滤，与
// model_prices 同源），daily 为全量历史（按浏览器时区日期分组）。

export interface LatencyRow {
  model: string;
  provider: string | null;
  ttftMs: number | null;
  latencyMs: number | null;
  outputTokens: number;
  createdAt: string;
}

export interface LatencyModelStat {
  model: string; // 归一化后的 model 名
  provider: string;
  count: number; // 全部请求数
  streamCount: number; // 流式请求数（ttft_ms 非 NULL）
  avgTtftMs: number | null; // 仅流式行
  p50TtftMs: number | null; // 仅流式行
  avgLatencyMs: number | null; // 全部行（有 latency_ms 的行）
  outputTokensPerSec: number | null; // 仅流式且 latency > ttft 的行
}

export interface LatencyDayStat {
  group: string; // 本地日期键（YYYY-MM-DD）
  streamCount: number;
  avgTtftMs: number | null;
  p50TtftMs: number | null;
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const frac = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * frac;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

interface ModelBucket {
  provider: string;
  normalized: string;
  ttft: number[];
  latency: number[];
  streamOutTokens: number;
  streamTimeMs: number;
  count: number;
  streamCount: number;
}

export function aggregateLatencyByModel(
  rows: LatencyRow[],
  activeModels: Set<string>,
  groups: HiddenProviderGroup[] = [],
  aliases: ModelAliasRule[] = []
): LatencyModelStat[] {
  const buckets = new Map<string, ModelBucket>();

  for (const row of rows) {
    if (!activeModels.has(row.model)) continue;
    const rawProvider = row.provider ?? "unknown";
    const provider = providerGroupKey(rawProvider, groups);
    const normalized = normalizeModel(row.model, rawProvider, groups, aliases);
    const key = `${provider}\u0000${normalized}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        provider,
        normalized,
        ttft: [],
        latency: [],
        streamOutTokens: 0,
        streamTimeMs: 0,
        count: 0,
        streamCount: 0,
      };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (row.latencyMs !== null && Number.isFinite(row.latencyMs)) {
      bucket.latency.push(row.latencyMs);
    }
    if (row.ttftMs !== null && Number.isFinite(row.ttftMs)) {
      bucket.streamCount += 1;
      bucket.ttft.push(row.ttftMs);
      if (row.latencyMs !== null && row.latencyMs > row.ttftMs) {
        bucket.streamOutTokens += toNum(row.outputTokens);
        bucket.streamTimeMs += row.latencyMs - row.ttftMs;
      }
    }
  }

  const result: LatencyModelStat[] = Array.from(buckets.values()).map(
    (bucket) => {
      const sortedTtft = [...bucket.ttft].sort((a, b) => a - b);
      const p50 = percentile(sortedTtft, 0.5);
      const avgTtft = mean(bucket.ttft);
      const avgLatency = mean(bucket.latency);
      const outputTokensPerSec =
        bucket.streamTimeMs > 0
          ? Math.round(
              (bucket.streamOutTokens / (bucket.streamTimeMs / 1000)) * 10
            ) / 10
          : null;
      return {
        model: bucket.normalized,
        provider: bucket.provider,
        count: bucket.count,
        streamCount: bucket.streamCount,
        avgTtftMs: avgTtft !== null ? Math.round(avgTtft) : null,
        p50TtftMs: p50 !== null ? Math.round(p50) : null,
        avgLatencyMs: avgLatency !== null ? Math.round(avgLatency) : null,
        outputTokensPerSec,
      };
    }
  );

  // p50 TTFT 升序（快者在前），无流式样本的行排最后，同值按请求数降序
  return result.sort((a, b) => {
    const aP50 = a.p50TtftMs === null ? Infinity : a.p50TtftMs;
    const bP50 = b.p50TtftMs === null ? Infinity : b.p50TtftMs;
    if (aP50 !== bP50) return aP50 - bP50;
    return b.count - a.count;
  });
}

export function aggregateLatencyDaily(
  rows: LatencyRow[],
  timezoneOffsetMinutes: number
): LatencyDayStat[] {
  const buckets = new Map<string, number[]>();

  for (const row of rows) {
    const date = localDateKeyFromUtcDate(
      new Date(row.createdAt),
      timezoneOffsetMinutes
    );
    if (!(row.ttftMs !== null && Number.isFinite(row.ttftMs))) continue;
    const list = buckets.get(date);
    if (list) {
      list.push(row.ttftMs);
    } else {
      buckets.set(date, [row.ttftMs]);
    }
  }

  return Array.from(buckets.entries())
    .map(([group, ttft]) => {
      const sorted = [...ttft].sort((a, b) => a - b);
      const p50 = percentile(sorted, 0.5);
      const avg = mean(ttft);
      return {
        group,
        streamCount: ttft.length,
        avgTtftMs: avg !== null ? Math.round(avg) : null,
        p50TtftMs: p50 !== null ? Math.round(p50) : null,
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group));
}

// 按本地日期分桶的 byModel 聚合（Speed 表格选中某日联动；口径与 range 总计一致：
// active 过滤 + 归一化 + p50 升序）
export function aggregateLatencyByModelByDate(
  rows: LatencyRow[],
  activeModels: Set<string>,
  timezoneOffsetMinutes: number,
  groups: HiddenProviderGroup[] = [],
  aliases: ModelAliasRule[] = []
): Record<string, LatencyModelStat[]> {
  const byDate = new Map<string, LatencyRow[]>();
  for (const row of rows) {
    const date = localDateKeyFromUtcDate(
      new Date(row.createdAt),
      timezoneOffsetMinutes
    );
    const bucket = byDate.get(date);
    if (bucket) {
      bucket.push(row);
    } else {
      byDate.set(date, [row]);
    }
  }

  const result: Record<string, LatencyModelStat[]> = {};
  byDate.forEach((dateRows, date) => {
    result[date] = aggregateLatencyByModel(
      dateRows,
      activeModels,
      groups,
      aliases
    );
  });
  return result;
}

// 当前启用 upstream 的非通配 enabled_models 并集 ∪ 近 30 天有记录的模型
// （与 model_prices 面板的 active/近期流量可见性同源；推送记录计入近期流量）
export async function loadActiveModelSet(): Promise<Set<string>> {
  const [rows, recent] = await Promise.all([
    loadUpstreamModelRows(),
    loadRecentActivityModels(),
  ]);
  return new Set([...rows.map((r) => r.model), ...Array.from(recent)]);
}

export async function queryLatencyStats(params: {
  range: string;
  providerFilter?: string[] | null;
  modelFilter?: string[] | null;
  agentUaFilter?: AgentUaFilter;
  timezoneOffsetMinutes: number;
  groups: HiddenProviderGroup[];
  aliases: ModelAliasRule[];
}): Promise<{
  byModel: LatencyModelStat[];
  daily: LatencyDayStat[];
  dailyByModel: Record<string, LatencyModelStat[]>;
}> {
  const {
    range,
    providerFilter,
    modelFilter,
    agentUaFilter,
    timezoneOffsetMinutes,
    groups,
    aliases,
  } = params;

  const days = parseInt(range, 10);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`Invalid range: ${range}`);
  }
  const dateFilter = computeRangeStartDateKey(
    days,
    timezoneOffsetMinutes
  );

  // 独立排除列表（不依赖隐藏状态；空数组由 buildWhereClause 跳过）
  const hiddenSources = await loadHiddenSources();
  const exclude = {
    providers: hiddenSources.excludedUpstreams,
    agents: hiddenSources.excludedVirtualKeys,
  };

  const whereClause = buildWhereClause(
    dateFilter,
    providerFilter ?? null,
    modelFilter ?? null,
    agentUaFilter ?? null,
    timezoneOffsetMinutes,
    exclude
  );

  let query = db
    .select({
      model: tokenRecords.model,
      provider: tokenRecords.provider,
      ttftMs: tokenRecords.ttftMs,
      latencyMs: tokenRecords.latencyMs,
      outputTokens: tokenRecords.outputTokens,
      createdAt: tokenRecords.createdAt,
    })
    .from(tokenRecords);
  if (whereClause) {
    query = query.where(whereClause);
  }
  const rows = await query;

  const activeModels = await loadActiveModelSet();
  return {
    byModel: aggregateLatencyByModel(rows, activeModels, groups, aliases),
    daily: aggregateLatencyDaily(rows, timezoneOffsetMinutes),
    dailyByModel: aggregateLatencyByModelByDate(
      rows,
      activeModels,
      timezoneOffsetMinutes,
      groups,
      aliases
    ),
  };
}
