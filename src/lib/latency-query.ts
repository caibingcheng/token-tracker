import { db, tokenRecords, initDatabase, getRawClient } from "@/lib/db";
import { buildWhereClause } from "@/lib/stats-query";
import {
  localDateKeyFromUtcDate,
  computeRangeStartDateKey,
} from "@/lib/timezone-utils";
import { normalizeModel } from "@/lib/model-utils";
import { loadUpstreamModelRows, RECENT_ACTIVITY_WINDOW_MS } from "@/lib/model-prices-service";
import { toNum } from "@/lib/number-utils";
import { providerGroupKey, type HiddenProviderGroup } from "@/lib/provider-utils";
import type { ModelAliasRule } from "@/lib/model-registry";
import type { AgentUaFilter } from "@/lib/agent-utils";
import { gte, sql } from "drizzle-orm";
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

export interface LatencyAggregateOptions {
  activeModels: Set<string>;
  groups?: HiddenProviderGroup[];
  aliases?: ModelAliasRule[];
}

function accumulateIntoModelBuckets(
  buckets: Map<string, ModelBucket>,
  row: LatencyRow,
  opts: LatencyAggregateOptions
): void {
  const { activeModels, groups = [], aliases = [] } = opts;
  if (!activeModels.has(row.model)) return;
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

function finalizeModelBuckets(
  buckets: Map<string, ModelBucket>
): LatencyModelStat[] {
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

// 增量聚合器：调用方逐行 add，不保留原始行。
// 原本 queryLatencyStats 先把整个区间的行（30 天 × 1 万条 = 30 万个对象）
// 物化成数组，光这一层就占 90–150MB 常驻堆；游标逐行 + 增量聚合后
// 只保留分位数所需的两组数字（同区间约 2–5MB）。
export class LatencyModelAccumulator {
  private buckets = new Map<string, ModelBucket>();
  constructor(private readonly opts: LatencyAggregateOptions) {}
  add(row: LatencyRow): void {
    accumulateIntoModelBuckets(this.buckets, row, this.opts);
  }
  finish(): LatencyModelStat[] {
    return finalizeModelBuckets(this.buckets);
  }
}

export class LatencyDailyAccumulator {
  private buckets = new Map<string, number[]>();
  constructor(private readonly timezoneOffsetMinutes: number) {}
  add(row: LatencyRow): void {
    if (!(row.ttftMs !== null && Number.isFinite(row.ttftMs))) return;
    const date = localDateKeyFromUtcDate(
      new Date(row.createdAt),
      this.timezoneOffsetMinutes
    );
    const list = this.buckets.get(date);
    if (list) {
      list.push(row.ttftMs);
    } else {
      this.buckets.set(date, [row.ttftMs]);
    }
  }
  finish(): LatencyDayStat[] {
    return Array.from(this.buckets.entries())
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
}

export class LatencyByDateModelAccumulator {
  private byDate = new Map<string, Map<string, ModelBucket>>();
  constructor(
    private readonly opts: LatencyAggregateOptions,
    private readonly timezoneOffsetMinutes: number
  ) {}
  add(row: LatencyRow): void {
    const date = localDateKeyFromUtcDate(
      new Date(row.createdAt),
      this.timezoneOffsetMinutes
    );
    let buckets = this.byDate.get(date);
    if (!buckets) {
      buckets = new Map<string, ModelBucket>();
      this.byDate.set(date, buckets);
    }
    accumulateIntoModelBuckets(buckets, row, this.opts);
  }
  finish(): Record<string, LatencyModelStat[]> {
    const result: Record<string, LatencyModelStat[]> = {};
    this.byDate.forEach((buckets, date) => {
      result[date] = finalizeModelBuckets(buckets);
    });
    return result;
  }
}

export function aggregateLatencyByModel(
  rows: LatencyRow[],
  activeModels: Set<string>,
  groups: HiddenProviderGroup[] = [],
  aliases: ModelAliasRule[] = []
): LatencyModelStat[] {
  const acc = new LatencyModelAccumulator({ activeModels, groups, aliases });
  for (const row of rows) acc.add(row);
  return acc.finish();
}

export function aggregateLatencyDaily(
  rows: LatencyRow[],
  timezoneOffsetMinutes: number
): LatencyDayStat[] {
  const acc = new LatencyDailyAccumulator(timezoneOffsetMinutes);
  for (const row of rows) acc.add(row);
  return acc.finish();
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
  const acc = new LatencyByDateModelAccumulator(
    { activeModels, groups, aliases },
    timezoneOffsetMinutes
  );
  for (const row of rows) acc.add(row);
  return acc.finish();
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

  const whereClause = buildWhereClause(
    dateFilter,
    providerFilter ?? null,
    modelFilter ?? null,
    agentUaFilter ?? null,
    timezoneOffsetMinutes
  );

  const activeModels = await loadActiveModelSet();

  // 字段名显式别名：下面用 raw 游标读列数组，位置必须与 select 顺序一一对应，
  // 而 drizzle 默认不输出 `as` 别名（ttft_ms vs ttftMs）
  const baseQuery = db.select({
    model: sql<string>`${tokenRecords.model}`.as("model"),
    provider: sql<string | null>`${tokenRecords.provider}`.as("provider"),
    ttftMs: sql<number | null>`${tokenRecords.ttftMs}`.as("ttftMs"),
    latencyMs: sql<number | null>`${tokenRecords.latencyMs}`.as("latencyMs"),
    outputTokens: sql<number>`${tokenRecords.outputTokens}`.as("outputTokens"),
    createdAt: sql<string>`${tokenRecords.createdAt}`.as("createdAt"),
  })
    .from(tokenRecords);
  const finalQuery = whereClause ? baseQuery.where(whereClause) : baseQuery;
  const { sql: sqlText, params: sqlParams } = finalQuery.toSQL();

  const byModelAcc = new LatencyModelAccumulator({
    activeModels,
    groups,
    aliases,
  });
  const dailyAcc = new LatencyDailyAccumulator(timezoneOffsetMinutes);
  const byDateModelAcc = new LatencyByDateModelAccumulator(
    { activeModels, groups, aliases },
    timezoneOffsetMinutes
  );

  // 游标逐行消费：区间内可能有 30 万行，一次性物化成对象数组就是 90–150MB 常驻堆。
  // raw 模式再省掉每行一个对象的分配（列顺序 = 上面 select 的顺序）。
  await initDatabase();
  const stmt = getRawClient().prepare(sqlText);
  const cursor = stmt.raw(true).iterate(...sqlParams);
  let processed = 0;
  let completed = false;
  try {
    for (const r of cursor) {
      const row: LatencyRow = {
        model: r[0],
        provider: r[1],
        ttftMs: r[2],
        latencyMs: r[3],
        outputTokens: r[4],
        createdAt: r[5],
      };
      byModelAcc.add(row);
      dailyAcc.add(row);
      byDateModelAcc.add(row);
      processed++;
    }
    completed = true;
  } finally {
    // 异常中断游标时要显式归还 statement，否则连接会保持 busy
    if (!completed) cursor.return?.();
  }

  if (process.env.LATENCY_QUERY_DEBUG === "true") {
    console.log(`[latency] scanned ${processed} rows for range=${range}`);
  }

  return {
    byModel: byModelAcc.finish(),
    daily: dailyAcc.finish(),
    dailyByModel: byDateModelAcc.finish(),
  };
}
