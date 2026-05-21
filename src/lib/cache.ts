import { unstable_cache } from "next/cache";
import { revalidateTag } from "next/cache";

// ── 缓存条目元数据 ──
interface CacheEntry<T> {
  data: T;
  isValid: boolean; // true = 有效，false = 已失效（等待 ingest 后清除）
}

// ── 全局热缓存 Map（实例级别，不跨实例共享） ──
const hotCache = new Map<string, CacheEntry<unknown>>();

// ── 后台刷新锁，防止缓存雪崩（cache stampede） ──
const pendingRefreshes = new Map<string, Promise<unknown>>();

// ── 持久缓存标签（用于 unstable_cache + revalidateTag） ──
const STATS_CACHE_TAG = "api-stats";
const PROVIDERS_CACHE_TAG = "api-providers";

// ── 热缓存键生成 ──
function hotKey(...parts: string[]): string {
  return parts.join(":");
}

// ── 从热缓存读取（永久有效，无 SWR） ──
function getHot<T>(key: string): T | null {
  const entry = hotCache.get(key) as CacheEntry<T> | undefined;
  if (!entry || !entry.isValid) return null;
  return entry.data;
}

// ── 写入热缓存（永久存储，直到被显式清除） ──
function setHot<T>(key: string, data: T): void {
  hotCache.set(key, { data, isValid: true });
}

// ── Stats 参数接口 ──
export interface StatsParams {
  groupBy: string;
  range: string;
  provider: string;
  granularity?: string;
}

// ── 生成 Stats 缓存键 ──
function statsHotKey(params: StatsParams): string {
  return hotKey(
    "stats",
    params.groupBy,
    params.range,
    params.provider,
    params.granularity ?? "none"
  );
}

// ── 后台刷新函数（防缓存雪崩） ──
async function refreshInBackground<T>(
  key: string,
  queryFn: () => Promise<T>
): Promise<void> {
  // 如果已有相同 key 的刷新在进行中，跳过
  if (pendingRefreshes.has(key)) return;

  const promise = (async () => {
    try {
      const freshData = await queryFn();
      setHot(key, freshData);
    } catch (err) {
      console.error(`[Cache] Background refresh failed for key "${key}":`, err);
    } finally {
      pendingRefreshes.delete(key);
    }
  })();

  pendingRefreshes.set(key, promise);
  // fire-and-forget，不阻塞请求
  void promise;
}

// ── 持久缓存包装（unstable_cache） ──
async function getPersistentStats<T>(
  params: StatsParams,
  queryFn: () => Promise<T>
): Promise<T> {
  const key = statsHotKey(params);
  const cachedFn = unstable_cache(
    async () => {
      return await queryFn();
    },
    [key],
    { tags: [STATS_CACHE_TAG], revalidate: false }
  );
  return cachedFn();
}

// ── 获取缓存的 Stats（含持久缓存回退） ──
export async function getCachedStats<T>(
  params: StatsParams,
  queryFn: () => Promise<T>
): Promise<T> {
  const key = statsHotKey(params);

  // 1. 尝试热缓存（永久有效，除非被 ingest 失效）
  const hot = getHot<T>(key);
  if (hot) return hot;

  // 2. 热缓存未命中 → 尝试持久缓存（unstable_cache）
  try {
    const data = await getPersistentStats(params, queryFn);
    setHot(key, data);
    return data;
  } catch {
    // 持久缓存失败 → 直接查库
    const data = await queryFn();
    setHot(key, data);
    return data;
  }
}

// ── 获取缓存的 Providers ──
export async function getCachedProviders<T>(
  queryFn: () => Promise<T>
): Promise<T> {
  const key = "providers:list";

  // 1. 热缓存（永久有效，除非被 ingest 失效）
  const hot = getHot<T>(key);
  if (hot) return hot;

  // 2. 持久缓存
  try {
    const cachedFn = unstable_cache(
      async () => queryFn(),
      [key],
      { tags: [PROVIDERS_CACHE_TAG], revalidate: false }
    );
    const data = await cachedFn();
    setHot(key, data);
    return data;
  } catch {
    const data = await queryFn();
    setHot(key, data);
    return data;
  }
}

// ── 使 Stats 缓存失效 ──
export function invalidateStatsCache(): void {
  // 1. 通知 Vercel Data Cache 清除所有带 STATS_CACHE_TAG 的条目
  revalidateTag(STATS_CACHE_TAG);

  // 2. 清除本实例热缓存中的 stats 条目
  const keysToDelete: string[] = [];
  hotCache.forEach((_entry, key) => {
    if (key.startsWith("stats:")) {
      keysToDelete.push(key);
    }
  });
  for (const key of keysToDelete) {
    hotCache.delete(key);
  }
  console.log("[Cache] Stats cache invalidated");
}

// ── 使 Providers 缓存失效 ──
export function invalidateProvidersCache(): void {
  revalidateTag(PROVIDERS_CACHE_TAG);
  hotCache.delete("providers:list");
  console.log("[Cache] Providers cache invalidated");
}

// ── 重建常用缓存键（ingest 后触发，确保 Dashboard 即时加载） ──
export async function rebuildCommonCaches(): Promise<void> {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    `http://localhost:${process.env.PORT || 3000}`;

  const commonQueries = [
    { endpoint: "/api/stats?groupBy=none&range=all", key: "stats:none:all:none" },
    { endpoint: "/api/stats?groupBy=date&range=7d", key: "stats:date:7d:all:none" },
    { endpoint: "/api/stats?groupBy=model&range=7d", key: "stats:model:7d:all:none" },
    { endpoint: "/api/stats?groupBy=provider&range=7d", key: "stats:provider:7d:all:none" },
    { endpoint: "/api/providers", key: "providers:list" },
  ];

  for (const { endpoint, key } of commonQueries) {
    void refreshInBackground(key, async () => {
      const res = await fetch(`${baseUrl}${endpoint}`);
      if (!res.ok)
        throw new Error(`Failed to rebuild cache for ${endpoint}`);
      const json = await res.json();
      return json.data;
    });
  }
}
