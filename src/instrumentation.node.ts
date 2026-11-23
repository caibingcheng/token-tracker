// 仅 Node.js 服务器运行时加载（由 src/server/index.ts 在启动时直接调用 registerNode()）。
// 曾经的 NEXT_RUNTIME 分派层 src/instrumentation.ts 随 Next 服务端移除已删除。
//
// 周期性内存归还：实测 V8 的 major GC 触发阈值随堆上限缩放，生产容器运行数天后 RSS 从
// ~42MB 基线涨到 ~100MB+ 且空闲后不回落。这里定期检查 RSS，偏高时触发 full GC
// 主动归还内存。依赖 --expose-gc（Dockerfile NODE_OPTIONS 已配置），无该 flag 时静默跳过。
//
// 采样间隔取 30s：压测（43 rps 混合负载）下 V8 heapTotal 能在 5min 内从 51MB 涨到 206MB，
// 5min/60s 的窗口都来不及回收，峰值全部落在 RSS 上。空闲扫描本身几乎零成本，
// 只有 RSS 超阈值时才真正 GC。

const RECLAIM_INTERVAL_MS = 30 * 1000;
const RECLAIM_RSS_THRESHOLD_BYTES = 80 * 1024 * 1024;

export function registerNode() {
  if (process.env.NODE_ENV !== "production") return;
  if (typeof globalThis.gc !== "function") return;

  const g = globalThis as typeof globalThis & { __ttMemoryReclaimTimer?: NodeJS.Timeout };
  if (g.__ttMemoryReclaimTimer) return;

  const timer = setInterval(() => {
    const before = process.memoryUsage();
    if (before.rss <= RECLAIM_RSS_THRESHOLD_BYTES) return;
    // 不做「上次 GC 后涨了多少」判断：glibc/jemalloc 的 [heap] 不会因 V8 full GC
    // 归还，rss 基线本身就高于阈值时那套判断会永久失效。大堆 full GC 约 10–50ms，
    // 30s 一次的空闲开销 <0.2% CPU，而少掉的 RSS 是几十 MB。
    globalThis.gc?.();
    if (process.env.MEM_RECLAIM_DEBUG === "true") {
      const after = process.memoryUsage();
      console.log(
        `[mem] reclaim rss ${(before.rss / 1048576).toFixed(1)}→${(after.rss / 1048576).toFixed(1)}MB, ` +
          `heapTotal ${(before.heapTotal / 1048576).toFixed(1)}→${(after.heapTotal / 1048576).toFixed(1)}MB, ` +
          `heapUsed ${(before.heapUsed / 1048576).toFixed(1)}→${(after.heapUsed / 1048576).toFixed(1)}MB`
      );
    }
  }, RECLAIM_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  g.__ttMemoryReclaimTimer = timer;
}
