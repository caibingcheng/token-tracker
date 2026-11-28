// relay ⇄ 中心 的往返延迟（RTT）：5h 窗口 × 1min tick，aggregate 在 relay 算完再上报。
//
// 为什么只存内存：与 lastPlanOutcome 同类，重启清零可接受（中心侧已存的桶不受影响）；
// 落盘会把 relay.state.json 从「配对凭证」变成「时序数据」，权限与轮转语义都变复杂。
//
// 上报口径（见 plan-client.sendReport）：每次 report 带上「上一分钟已闭合桶 + 当前分钟实时桶」，
// 中心按 (deviceId, kind, bucketStart) 覆盖写 —— 已闭合桶内容不再变化，重传天然幂等。
export type RttKind = "plan" | "report";

/** 展示窗口：5h */
export const RTT_WINDOW_MS = 5 * 60 * 60 * 1000;
/** 一个 tick = 1min */
export const RTT_TICK_MS = 60 * 1000;
/** 窗口桶数（300） */
export const RTT_BUCKETS = RTT_WINDOW_MS / RTT_TICK_MS;

export interface RttBucketWire {
  kind: RttKind;
  /** 桶起点，epoch ms 且整分钟对齐 */
  start: number;
  count: number;
  sumMs: number;
  maxMs: number;
  lastMs: number;
}

interface Bucket {
  count: number;
  sumMs: number;
  maxMs: number;
  lastMs: number;
}

const store: Record<RttKind, Map<number, Bucket>> = {
  plan: new Map(),
  report: new Map(),
};

function bucketStart(now: number): number {
  return Math.floor(now / RTT_TICK_MS) * RTT_TICK_MS;
}

/** 记一个 RTT 样本（毫秒）。非有限 / 负数 / 超过窗口长度的样本直接丢弃（时钟跳变、超时占位） */
export function recordRtt(kind: RttKind, ms: number, now = Date.now()): void {
  if (!Number.isFinite(ms) || ms < 0 || ms > RTT_WINDOW_MS) return;
  const start = bucketStart(now);
  const map = store[kind];
  const bucket = map.get(start) ?? { count: 0, sumMs: 0, maxMs: 0, lastMs: 0 };
  const value = Math.round(ms);
  bucket.count += 1;
  bucket.sumMs += value;
  bucket.maxMs = Math.max(bucket.maxMs, value);
  bucket.lastMs = value;
  map.set(start, bucket);
  // 修剪：只留窗口内的桶（Map 大小恒为 ≤ 300 + 当前桶）
  const cutoff = start - RTT_WINDOW_MS;
  for (const key of map.keys()) if (key < cutoff) map.delete(key);
}

/**
 * 待上报的桶快照：上一分钟（已闭合，值稳定）+ 当前分钟（实时，下一次通信会覆盖刷新）。
 * 只在两个桶有样本时返回；无流量 → 空数组（中心不写任何行）。
 */
export function rttSnapshot(now = Date.now()): RttBucketWire[] {
  const current = bucketStart(now);
  const out: RttBucketWire[] = [];
  for (const kind of ["plan", "report"] as const) {
    for (const start of [current - RTT_TICK_MS, current]) {
      const bucket = store[kind].get(start);
      if (bucket) out.push({ kind, start, ...bucket });
    }
  }
  return out;
}

/** 仅测试用：清空缓冲 */
export function resetRttForTest(): void {
  store.plan.clear();
  store.report.clear();
}
