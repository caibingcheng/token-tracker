// 进程内滑动窗口限流（按 key 分桶，TTL 懒清扫）。
// 与 auth/login 的按 IP 限流同思路，但按键参数化：
// - pair/start：全局桶（getRateLimitKey 的可信 IP 语义在调用方处理）
// - pair/poll：code_hash
// - device/plan、device/report：deviceId（§12.4 per-device 20 rps）
// 限流必须在读 body 之前执行（调用方顺序保证）。
export interface SlidingWindowLimiter {
  /** true = 超出限额（调用方返回 429） */
  hit(key: string, now?: number): boolean;
  /** 成功路径清零（登录类语义；plan/report 不需要） */
  reset(key: string): void;
  size(): number;
}

export function createSlidingWindowLimiter(opts: {
  windowMs: number;
  max: number;
}): SlidingWindowLimiter {
  const buckets = new Map<string, number[]>();
  let sweepCounter = 0;
  return {
    hit(key, now = Date.now()) {
      sweepCounter++;
      if (sweepCounter % 64 === 0) {
        for (const [k, times] of buckets) {
          if (times.length === 0 || times[times.length - 1]! < now - opts.windowMs) buckets.delete(k);
        }
      }
      const times = (buckets.get(key) ?? []).filter((t) => t > now - opts.windowMs);
      if (times.length >= opts.max) {
        buckets.set(key, times);
        return true;
      }
      times.push(now);
      buckets.set(key, times);
      return false;
    },
    reset(key) {
      buckets.delete(key);
    },
    size() {
      return buckets.size;
    },
  };
}
