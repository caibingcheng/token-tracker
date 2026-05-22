import { unstable_cache } from "next/cache";
import { revalidateTag } from "next/cache";
import { executeStatsQuery } from "@/lib/stats-query";

// ── 缓存条目 ──
interface CacheEntry<T> {
  data: T;
  isValid: boolean;
}

// ── AB 面双缓冲 ──
let activeCache = new Map<string, CacheEntry<unknown>>();
let standbyCache = new Map<string, CacheEntry<unknown>>();

// ── 版本号与定时器 ──
let rebuildVersion = 0;
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
const REBUILD_DELAY_MS = 2000;

// ── 持久缓存标签 ──
const STATS_CACHE_TAG = "api-stats";
const PROVIDERS_CACHE_TAG = "api-providers";

// ── Stats 参数接口 ──
export interface StatsParams {
  groupBy: string;
  range: string;
  provider: string;
  granularity?: string;
}

// ── 生成 Stats 缓存键 ──
function statsHotKey(params: StatsParams): string {
  return [
    "stats",
    params.groupBy,
    params.range,
    params.provider,
    params.granularity ?? "none",
  ].join(":");
}

// ── 模块级预定义 unstable_cache ──
const statsCacheFn = unstable_cache(
  async (groupBy: string, range: string, provider: string, granularity?: string) => {
    return await executeStatsQuery({ groupBy, range, provider, granularity });
  },
  ["stats"],
  { tags: [STATS_CACHE_TAG], revalidate: false }
);

const providersCacheFn = unstable_cache(
  async (queryFn: () => Promise<unknown>) => {
    return await queryFn();
  },
  ["providers:list"],
  { tags: [PROVIDERS_CACHE_TAG], revalidate: false }
);

// ── 获取缓存的 Stats（从活跃面读取）──
export async function getCachedStats<T>(
  params: StatsParams,
  queryFn: () => Promise<T>
): Promise<T> {
  const key = statsHotKey(params);

  // 1. 活跃面
  const entry = activeCache.get(key) as CacheEntry<T> | undefined;
  if (entry?.isValid) return entry.data;

  // 2. 持久缓存回退
  try {
    const data = await statsCacheFn(params.groupBy, params.range, params.provider, params.granularity) as T;
    activeCache.set(key, { data, isValid: true });
    return data;
  } catch (err) {
    console.warn("[Cache] Persistent cache miss, falling back to query:", err);
    const data = await queryFn();
    activeCache.set(key, { data, isValid: true });
    return data;
  }
}

// ── 获取缓存的 Providers（从活跃面读取）──
export async function getCachedProviders<T>(
  queryFn: () => Promise<T>
): Promise<T> {
  const key = "providers:list";
  const entry = activeCache.get(key) as CacheEntry<T> | undefined;
  if (entry?.isValid) return entry.data;

  try {
    const data = await providersCacheFn(queryFn as () => Promise<unknown>) as T;
    activeCache.set(key, { data, isValid: true });
    return data;
  } catch (err) {
    console.warn("[Cache] Providers persistent cache miss:", err);
    const data = await queryFn();
    activeCache.set(key, { data, isValid: true });
    return data;
  }
}

// ── 使 Stats 缓存失效（Debounce 触发重建）──
export async function invalidateStatsCache(): Promise<void> {
  rebuildVersion++;
  const currentVersion = rebuildVersion;

  // 清除旧定时器
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
  }

  // 新增：清除所有内存缓存
  activeCache.clear();

  // 标记持久缓存失效
  await revalidateTag(STATS_CACHE_TAG);

  // 2 秒后重建（Debounce）
  rebuildTimer = setTimeout(() => {
    void rebuildStatsCaches(currentVersion);
  }, REBUILD_DELAY_MS);

  console.log("[Cache] Stats cache invalidated and cleared");
}

// ── 使 Providers 缓存失效 ──
export async function invalidateProvidersCache(): Promise<void> {
  await revalidateTag(PROVIDERS_CACHE_TAG);
  activeCache.delete("providers:list");
  console.log("[Cache] Providers cache invalidated");
}

// ── 重建 Stats 缓存（内部，串行 + 版本号保护）──
async function rebuildStatsCaches(expectedVersion: number): Promise<void> {
  const queries = [
    { params: { groupBy: "none", range: "all", provider: "all" }, key: statsHotKey({ groupBy: "none", range: "all", provider: "all" }) },
    { params: { groupBy: "date", range: "7d", provider: "all" }, key: statsHotKey({ groupBy: "date", range: "7d", provider: "all" }) },
    { params: { groupBy: "model", range: "7d", provider: "all" }, key: statsHotKey({ groupBy: "model", range: "7d", provider: "all" }) },
    { params: { groupBy: "provider", range: "7d", provider: "all" }, key: statsHotKey({ groupBy: "provider", range: "7d", provider: "all" }) },
  ];

  try {
    if (expectedVersion !== rebuildVersion) {
      return;
    }

    // 串行重建（避免并发竞争）
    for (const { params, key } of queries) {
      if (expectedVersion !== rebuildVersion) {
        standbyCache.clear();
        return;
      }

      const data = await executeStatsQuery(params);
      standbyCache.set(key, { data, isValid: true });
    }

    // 版本检查（切换前）
    if (expectedVersion !== rebuildVersion) {
      standbyCache.clear();
      return;
    }

    // 原子切换：备用面 → 活跃面
    [activeCache, standbyCache] = [standbyCache, activeCache];

    // 清除旧的备用面（现在包含旧数据）
    standbyCache.clear();

    console.log("[Cache] Stats cache rebuilt and switched successfully");
  } catch (err) {
    console.error("[Cache] Stats cache rebuild failed:", err);
    standbyCache.clear();
  } finally {
    rebuildTimer = null;
  }
}

// ── 兼容接口：触发 invalidate 即可（重建已由 debounce 自动处理）──
/** @deprecated 使用 invalidateStatsCache() 替代 */
export function rebuildCommonCaches(): void {
  void invalidateStatsCache();
}
