// relay ⇄ 中心 RTT 的分钟桶（仅中心使用）。
//
// relay 侧已经算好聚合（count/sum/max/last），中心只做覆盖写：
// 已闭合桶的内容不再变化，所以 report 重试重传同一份快照是幂等的（不会重复累加）。
// 5h 窗口 = 300 桶/kind；过期行由 store.maybeSweep 的 60s 节流清扫。
import { gte, lt, sql } from "drizzle-orm";
import { db, deviceLatencyBucketsTable, initDatabase } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";

export type RttKind = "plan" | "report";

/** 展示窗口：5h */
export const RTT_WINDOW_MS = 5 * 60 * 60 * 1000;
/** 一个 tick = 1min */
export const RTT_TICK_MS = 60 * 1000;
/** 窗口点数（300） */
export const RTT_POINTS = RTT_WINDOW_MS / RTT_TICK_MS;

/** 单样本上限：relay 的 plan/report 都带 15s fetch timeout，60s 已是宽容上限（挡住伪造的大数） */
const MAX_SAMPLE_MS = 60_000;
/** 一次 report 最多接受 8 个桶（relay 正常只发 4 个：2 kind × 2 分钟） */
const MAX_BUCKETS_PER_REPORT = 8;
const MAX_BUCKET_COUNT = 100_000;

export interface RttBucketInput {
  kind: RttKind;
  /** 桶起点，epoch ms 且整分钟对齐 */
  start: number;
  count: number;
  sumMs: number;
  maxMs: number;
  lastMs: number;
}

function intOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function bucketStart(now: number): number {
  return Math.floor(now / RTT_TICK_MS) * RTT_TICK_MS;
}

/**
 * 解析 relay 上报的桶快照。字段全部自校验（relay 不可信）：分钟对齐、窗口内、count/sum/max 自洽。
 * 不合法项逐条丢弃、绝不整体 400 —— RTT 只是可观测性数据，不该让一次已完成的请求回报失败。
 */
export function parseRttBuckets(raw: unknown, now = Date.now()): RttBucketInput[] {
  if (!Array.isArray(raw)) return [];
  const current = bucketStart(now);
  const out: RttBucketInput[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_BUCKETS_PER_REPORT)) {
    if (typeof item !== "object" || item === null) continue;
    const b = item as Record<string, unknown>;
    const kind = b.kind === "plan" || b.kind === "report" ? b.kind : null;
    if (!kind) continue;
    const start = intOrNull(b.start);
    const count = intOrNull(b.count);
    const sumMs = intOrNull(b.sumMs);
    const maxMs = intOrNull(b.maxMs);
    const lastMs = intOrNull(b.lastMs);
    if (start === null || count === null || sumMs === null || maxMs === null || lastMs === null) continue;
    if (start % RTT_TICK_MS !== 0) continue;
    // 容忍一个桶的时钟漂移（relay 比中心快），但不接受更远的历史/未来
    if (start < current - RTT_WINDOW_MS || start > current + RTT_TICK_MS) continue;
    if (count <= 0 || count > MAX_BUCKET_COUNT) continue;
    if (maxMs > MAX_SAMPLE_MS || lastMs > MAX_SAMPLE_MS) continue;
    // sum 的物理上限：每个样本都不超过单样本上限
    if (sumMs > count * MAX_SAMPLE_MS) continue;
    const key = `${kind}:${start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, start, count, sumMs, maxMs, lastMs });
  }
  return out;
}

/** 覆盖写（`ON CONFLICT DO UPDATE`）：同一桶重传结果一致 */
export async function recordRttBuckets(deviceId: number, buckets: RttBucketInput[]): Promise<void> {
  if (buckets.length === 0) return;
  await initDatabase();
  await withSkipCache(async () => {
    await db
      .insert(deviceLatencyBucketsTable)
      .values(
        buckets.map((b) => ({
          deviceId,
          kind: b.kind,
          bucketStart: b.start,
          count: b.count,
          sumMs: b.sumMs,
          maxMs: b.maxMs,
          lastMs: b.lastMs,
        }))
      )
      .onConflictDoUpdate({
        target: [
          deviceLatencyBucketsTable.deviceId,
          deviceLatencyBucketsTable.kind,
          deviceLatencyBucketsTable.bucketStart,
        ],
        set: {
          count: sql`excluded.count`,
          sumMs: sql`excluded.sum_ms`,
          maxMs: sql`excluded.max_ms`,
          lastMs: sql`excluded.last_ms`,
        },
      });
  });
}

/** 删除出窗口的行（由 store.maybeSweep 的 60s 节流调用） */
export async function sweepRttBuckets(now = Date.now()): Promise<void> {
  await withSkipCache(async () => {
    await db
      .delete(deviceLatencyBucketsTable)
      .where(lt(deviceLatencyBucketsTable.bucketStart, now - RTT_WINDOW_MS - RTT_TICK_MS));
  });
}

export interface RttStats {
  /** 最近一个有样本的桶里最后一个样本的毫秒数 */
  latestMs: number | null;
  /** 5h 加权平均（Σsum / Σcount） */
  avgMs: number | null;
  /** 5h 内单次最大 */
  maxMs: number | null;
  /** 5h 样本数 */
  samples: number;
}

export interface DeviceLatency {
  plan: RttStats;
  report: RttStats;
}

interface Accumulator {
  sum: number;
  count: number;
  max: number;
  latestStart: number;
  latestMs: number;
}

function newAccumulator(): Accumulator {
  return { sum: 0, count: 0, max: 0, latestStart: -1, latestMs: 0 };
}

function toStats(acc: Accumulator): RttStats {
  return {
    latestMs: acc.latestStart >= 0 ? acc.latestMs : null,
    avgMs: acc.count > 0 ? Math.round(acc.sum / acc.count) : null,
    maxMs: acc.count > 0 ? acc.max : null,
    samples: acc.count,
  };
}

/** 空概览（没有样本的设备）：页面统一按同一形状渲染 */
export function emptyDeviceLatency(): DeviceLatency {
  return { plan: toStats(newAccumulator()), report: toStats(newAccumulator()) };
}

/** 所有设备的 5h RTT 概览（列表页一次查完，不做 per-device 查询） */
export async function latencySummaries(now = Date.now()): Promise<Map<number, DeviceLatency>> {
  await initDatabase();
  const current = bucketStart(now);
  const first = current - (RTT_POINTS - 1) * RTT_TICK_MS;
  const rows = (await withSkipCache(async () =>
    db
      .select()
      .from(deviceLatencyBucketsTable)
      .where(gte(deviceLatencyBucketsTable.bucketStart, first))
  )) as any[];

  const perDevice = new Map<number, { plan: Accumulator; report: Accumulator }>();
  for (const row of rows) {
    const count = Number(row.count);
    if (count <= 0) continue;
    const deviceId = Number(row.deviceId);
    let entry = perDevice.get(deviceId);
    if (!entry) {
      entry = { plan: newAccumulator(), report: newAccumulator() };
      perDevice.set(deviceId, entry);
    }
    const acc = row.kind === "report" ? entry.report : entry.plan;
    const start = Number(row.bucketStart);
    acc.count += count;
    acc.sum += Number(row.sumMs);
    acc.max = Math.max(acc.max, Number(row.maxMs));
    if (start >= acc.latestStart && Number(row.lastMs) > 0) {
      acc.latestStart = start;
      acc.latestMs = Number(row.lastMs);
    }
  }

  const result = new Map<number, DeviceLatency>();
  for (const [deviceId, entry] of perDevice) {
    result.set(deviceId, { plan: toStats(entry.plan), report: toStats(entry.report) });
  }
  return result;
}
