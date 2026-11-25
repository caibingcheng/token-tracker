import { LRUCache } from "lru-cache";
import { AsyncLocalStorage } from "async_hooks";

const TTL_MS = parseInt(process.env.API_CACHE_TTL_MS || "10000", 10);
const MAX_SIZE = parseInt(process.env.API_CACHE_MAX_SIZE || "1000", 10);
// 字节上限：`max` 只限条数，1 条 dashboard 聚合结果可达数百 KB（365 天热力图 +
// 模型/Provider/Agent 维度），1000 条就能堆出几十 MB 常驻堆。按字节限制才是真正的内存边界。
// 实测（30 万行库 + 混合负载）把 24MB 降到 8MB 对命中率无可测影响：TTL 只有 10s，
// 个人低 QPS 场景下缓存跨请求命中本来就少，不值得为它常驻两位数 MB。
const MAX_BYTES = parseInt(
  process.env.API_CACHE_MAX_BYTES || String(8 * 1024 * 1024),
  10
);
const BUCKET_MS = 10000;
const DEBUG = process.env.API_CACHE_DEBUG === "true";

export const cacheContext = new AsyncLocalStorage<{ skipCache?: boolean }>();

export function withSkipCache<T>(fn: () => T | Promise<T>): Promise<T> {
  return cacheContext.run({ skipCache: true }, fn) as Promise<T>;
}

const queryCache = new LRUCache<string, any>({
  max: MAX_SIZE,
  maxSize: MAX_BYTES,
  sizeCalculation: estimateEntrySize,
  ttl: TTL_MS,
  allowStale: false,
  updateAgeOnGet: false,
});

// 缓存值 = better-sqlite3 的原始行对象（数组或单行）。这里只用 JSON 长度做
// 近似字节数：仅在 set 时计算，dashboard 聚合结果最大几十 KB，代价远小于
// 让几十 MB 行对象长期驻留堆内（V8 不归还 OS 时直接体现在 RSS 上）。
function estimateEntrySize(value: unknown): number {
  if (value === undefined || value === null) return 8;
  try {
    return JSON.stringify(value).length + 64;
  } catch {
    return 4096;
  }
}

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function normalizeParam(value: unknown): unknown {
  if (value instanceof Date) {
    return bucketISOString(value.toISOString());
  }
  if (typeof value === "string" && ISO_DATE_REGEX.test(value)) {
    return bucketISOString(value);
  }
  return value;
}

function bucketISOString(iso: string): string {
  const ms = new Date(iso).getTime();
  const bucketed = Math.floor(ms / BUCKET_MS) * BUCKET_MS;
  return new Date(bucketed).toISOString();
}

function normalizeParams(params: unknown): unknown {
  if (params == null) return [];
  if (Array.isArray(params)) {
    return params.map(normalizeParam);
  }
  if (typeof params === "object") {
    const obj = params as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = normalizeParam(obj[key]);
    }
    return result;
  }
  return [normalizeParam(params)];
}

function buildKey(sql: string, normalizedParams: unknown): string {
  return `${sql}||${JSON.stringify(normalizedParams)}`;
}

export function invalidateQueryCache(): void {
  queryCache.clear();
}

export function wrapDatabaseClient(client: any): void {
  if (TTL_MS <= 0) return;

  console.log(
    "[QueryCache] enabled, TTL=%dms, max=%d, maxBytes=%dMB (add API_CACHE_DEBUG=true for hit/miss logs)",
    TTL_MS,
    MAX_SIZE,
    Math.round(MAX_BYTES / 1048576)
  );

  const originalPrepare = client.prepare.bind(client);

  let activated = false;
  client.prepare = function (sql: string) {
    try {
      const stmt = originalPrepare(sql);
      const trimmed = sql.trimStart().toLowerCase();

      if (
        trimmed.startsWith("select") ||
        trimmed.startsWith("pragma") ||
        trimmed.startsWith("with")
      ) {
        return wrapReader(stmt, sql);
      }
      return wrapWriter(stmt, sql);
    } catch (err) {
      if (!activated) {
        activated = true;
        console.error("[QueryCache] activation error, disabling cache:", err);
      }
      return originalPrepare(sql);
    }
  };
}

function wrapReader(stmt: any, sql: string): any {
  const origAll = stmt.all.bind(stmt);
  const origGet = stmt.get.bind(stmt);

  stmt.all = function (...args: any[]) {
    const ctx = cacheContext.getStore();
    if (ctx?.skipCache) return origAll(...args);

    try {
      let normalized: unknown;
      let callArgs: any[];
      if (args.length === 1 && typeof args[0] === "object" && !Array.isArray(args[0])) {
        normalized = normalizeParams(args[0]);
        callArgs = [normalized];
      } else {
        normalized = normalizeParams(args);
        callArgs = normalized as any[];
      }

      const key = buildKey(sql, normalized);
      const cached = queryCache.get(key);
      if (cached !== undefined) {
        if (DEBUG) console.log("[Cache] HIT", key.slice(0, 120));
        return cached;
      }

      if (DEBUG) console.log("[Cache] MISS", key.slice(0, 120));
      const result = origAll(...callArgs);
      queryCache.set(key, result);
      return result;
    } catch (err) {
      console.error("[QueryCache] read error, falling back:", err);
      return origAll(...args);
    }
  };

  stmt.get = function (...args: any[]) {
    const ctx = cacheContext.getStore();
    if (ctx?.skipCache) return origGet(...args);

    try {
      let normalized: unknown;
      let callArgs: any[];
      if (args.length === 1 && typeof args[0] === "object" && !Array.isArray(args[0])) {
        normalized = normalizeParams(args[0]);
        callArgs = [normalized];
      } else {
        normalized = normalizeParams(args);
        callArgs = normalized as any[];
      }

      const key = buildKey(sql, normalized);
      const cached = queryCache.get(key);
      if (cached !== undefined) {
        if (DEBUG) console.log("[Cache] HIT", key.slice(0, 120));
        return cached;
      }

      if (DEBUG) console.log("[Cache] MISS", key.slice(0, 120));
      const result = origGet(...callArgs);
      queryCache.set(key, result);
      return result;
    } catch (err) {
      console.error("[QueryCache] read error, falling back:", err);
      return origGet(...args);
    }
  };

  return stmt;
}

function wrapWriter(stmt: any, _sql: string): any {
  const origAll = stmt.all.bind(stmt);
  const origGet = stmt.get.bind(stmt);
  const origRun = stmt.run.bind(stmt);

  stmt.all = function (...args: any[]) {
    try {
      const result = origAll(...args);
      invalidateQueryCache();
      return result;
    } catch (err) {
      console.error("[QueryCache] write error, falling back:", err);
      return origAll(...args);
    }
  };

  stmt.get = function (...args: any[]) {
    try {
      const result = origGet(...args);
      invalidateQueryCache();
      return result;
    } catch (err) {
      console.error("[QueryCache] write error, falling back:", err);
      return origGet(...args);
    }
  };

  stmt.run = function (...args: any[]) {
    try {
      const result = origRun(...args);
      invalidateQueryCache();
      return result;
    } catch (err) {
      console.error("[QueryCache] write error, falling back:", err);
      return origRun(...args);
    }
  };

  return stmt;
}
