import { unstable_cache } from "next/cache";

// ── Providers 缓存标签 ──
export const PROVIDERS_CACHE_TAG = "api-providers";

// ── Models 缓存标签 ──
export const MODELS_CACHE_TAG = "api-models";

// ── Stats 缓存标签 ──
export const STATS_CACHE_TAG = "api-stats";

// ── Providers 缓存函数 ──
export const providersCacheFn = unstable_cache(
  async (queryFn: () => Promise<unknown>) => {
    return await queryFn();
  },
  ["providers:list"],
  { tags: [PROVIDERS_CACHE_TAG], revalidate: false }
);

// ── Models 缓存函数 ──
export const modelsCacheFn = unstable_cache(
  async (queryFn: () => Promise<unknown>) => {
    return await queryFn();
  },
  ["models:list"],
  { tags: [MODELS_CACHE_TAG], revalidate: false }
);

// ── 获取缓存的 Providers ──
export async function getCachedProviders<T>(
  queryFn: () => Promise<T>
): Promise<T> {
  return (await providersCacheFn(queryFn as () => Promise<unknown>)) as T;
}

// ── 获取缓存的 Models ──
export async function getCachedModels<T>(
  queryFn: () => Promise<T>
): Promise<T> {
  return (await modelsCacheFn(queryFn as () => Promise<unknown>)) as T;
}