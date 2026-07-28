import { LRUCache } from "lru-cache";
import { AsyncLocalStorage } from "async_hooks";

const TTL_MS = parseInt(process.env.API_CACHE_TTL_MS || "10000", 10);
const MAX_SIZE = parseInt(process.env.API_CACHE_MAX_SIZE || "1000", 10);
const BUCKET_MS = 10000;
const DEBUG = process.env.API_CACHE_DEBUG === "true";

export const cacheContext = new AsyncLocalStorage<{ skipCache?: boolean }>();

export function withSkipCache<T>(fn: () => T | Promise<T>): Promise<T> {
  return cacheContext.run({ skipCache: true }, fn) as Promise<T>;
}

const queryCache = new LRUCache<string, any>({
  max: MAX_SIZE,
  ttl: TTL_MS,
  allowStale: false,
  updateAgeOnGet: false,
});

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

  console.log("[QueryCache] enabled, TTL=%dms, max=%d (add API_CACHE_DEBUG=true for hit/miss logs)", TTL_MS, MAX_SIZE);

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
