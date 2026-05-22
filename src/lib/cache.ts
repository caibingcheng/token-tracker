import { unstable_cache } from "next/cache";

// ── Providers 缓存标签 ──
const PROVIDERS_CACHE_TAG = "api-providers";

// ── Providers 缓存函数 ──
export const providersCacheFn = unstable_cache(
  async (queryFn: () => Promise<unknown>) => {
    return await queryFn();
  },
  ["providers:list"],
  { tags: [PROVIDERS_CACHE_TAG], revalidate: false }
);

// ── 获取缓存的 Providers ──
export async function getCachedProviders<T>(
  queryFn: () => Promise<T>
): Promise<T> {
  return (await providersCacheFn(queryFn as () => Promise<unknown>)) as T;
}