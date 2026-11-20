// 仅在 Node.js 服务器运行时加载（由 ./instrumentation.ts 按 NEXT_RUNTIME 分派）。
//
// 周期性内存归还：实测 V8 的 major GC 触发阈值随堆上限缩放，生产容器运行数天后 RSS 从
// ~42MB 基线涨到 ~100MB+ 且空闲后不回落。这里每 5 分钟检查一次 RSS，偏高时触发 full GC
// 主动归还内存。依赖 --expose-gc（Dockerfile NODE_OPTIONS 已配置），无该 flag 时静默跳过。

const RECLAIM_INTERVAL_MS = 5 * 60 * 1000;
const RECLAIM_RSS_THRESHOLD_BYTES = 64 * 1024 * 1024;

export function registerNode() {
  if (process.env.NODE_ENV !== "production") return;
  if (typeof globalThis.gc !== "function") return;

  const g = globalThis as typeof globalThis & { __ttMemoryReclaimTimer?: NodeJS.Timeout };
  if (g.__ttMemoryReclaimTimer) return;

  const timer = setInterval(() => {
    if (process.memoryUsage().rss > RECLAIM_RSS_THRESHOLD_BYTES) {
      globalThis.gc?.();
    }
  }, RECLAIM_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  g.__ttMemoryReclaimTimer = timer;
}
