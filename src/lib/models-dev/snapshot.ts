import fs from "fs";
import path from "path";

// models.dev 快照管理：本地缓存 data/models-dev-cache.json，
// 懒刷新（7 天 TTL + 手动强制），拉取失败静默回退旧快照。
export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SNAPSHOT_FILE_NAME = "models-dev-cache.json";

export interface ModelsDevCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelsDevModel {
  id: string;
  name?: string;
  cost: ModelsDevCost;
  last_updated?: string;
  [key: string]: unknown;
}

export interface ModelsDevProvider {
  id: string;
  name?: string;
  models: Record<string, ModelsDevModel>;
  [key: string]: unknown;
}

export type ModelsDevData = Record<string, ModelsDevProvider>;

export interface ModelsDevSnapshot {
  fetchedAt: string;
  data: ModelsDevData;
}

// 快照路径：与 SQLite 同目录（data/），便于 Docker 卷挂载持久化
export function resolveSnapshotPath(dbPath?: string): string {
  const source = dbPath ?? process.env.SQLITE_DATABASE_PATH;
  const dir = source ? path.dirname(source) : "data";
  return path.join(dir, SNAPSHOT_FILE_NAME);
}

export function isValidModelsDevData(data: unknown): data is ModelsDevData {
  if (data === null || typeof data !== "object") return false;
  const providers = data as Record<string, unknown>;
  const entries = Object.entries(providers);
  if (entries.length === 0) return false;
  // 部分合法即可（api.json 可能包含异常 provider，容忍个别坏数据）
  let validCount = 0;
  for (const [, p] of entries) {
    if (
      p &&
      typeof p === "object" &&
      typeof (p as ModelsDevProvider).models === "object" &&
      (p as ModelsDevProvider).models !== null
    ) {
      validCount++;
    }
  }
  return validCount > 0;
}

export function readSnapshotFile(filePath?: string): ModelsDevSnapshot | null {
  const p = filePath ?? resolveSnapshotPath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ModelsDevSnapshot>;
    if (
      typeof parsed.fetchedAt !== "string" ||
      !isValidModelsDevData(parsed.data)
    ) {
      return null;
    }
    return { fetchedAt: parsed.fetchedAt, data: parsed.data };
  } catch {
    return null;
  }
}

export function writeSnapshotFile(
  snapshot: ModelsDevSnapshot,
  filePath?: string
): void {
  const p = filePath ?? resolveSnapshotPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(snapshot), "utf-8");
  } catch (err) {
    console.warn(`[models.dev] Failed to write snapshot to ${p}:`, err);
  }
}

export async function fetchModelsDevData(
  fetchImpl: typeof fetch = fetch
): Promise<ModelsDevData | null> {
  try {
    const res = await fetchImpl(MODELS_DEV_API_URL, {
      headers: { "accept-encoding": "identity" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`[models.dev] Fetch failed with status ${res.status}`);
      return null;
    }
    const data: unknown = await res.json();
    if (!isValidModelsDevData(data)) {
      console.warn("[models.dev] Fetch returned invalid data shape");
      return null;
    }
    return data;
  } catch (err) {
    console.warn("[models.dev] Fetch error:", err);
    return null;
  }
}

let parsedCache: ModelsDevSnapshot | null = null;
let inflightRefresh: Promise<ModelsDevSnapshot | null> | null = null;

// 读取快照（内存缓存解析结果，避免重复 parse 3.6MB）。
// 懒刷新：fetchedAt 超过 7 天 → 后台异步拉新（不阻塞当前请求），本次仍返回旧快照。
// force=true 时同步拉取并落盘。
export async function getSnapshot(
  opts: {
    filePath?: string;
    force?: boolean;
    fetchImpl?: typeof fetch;
    now?: Date;
  } = {}
): Promise<ModelsDevSnapshot | null> {
  if (parsedCache) {
    const age = Date.now() - new Date(parsedCache.fetchedAt).getTime();
    const stale = age > SNAPSHOT_TTL_MS;
    if (opts.force || stale) {
      // 已有 in-flight 刷新则复用；否则后台拉取（fire-and-forget，不阻塞）
      if (!inflightRefresh) {
        inflightRefresh = doRefresh(opts).finally(() => {
          inflightRefresh = null;
        });
      }
      inflightRefresh.catch(() => {});
    }
    if (!opts.force) return parsedCache;
    return await inflightRefresh;
  }

  const disk = readSnapshotFile(opts.filePath);
  if (disk) {
    parsedCache = disk;
    const age = Date.now() - new Date(disk.fetchedAt).getTime();
    if (opts.force || age > SNAPSHOT_TTL_MS) {
      if (!inflightRefresh) {
        inflightRefresh = doRefresh(opts).finally(() => {
          inflightRefresh = null;
        });
      }
      inflightRefresh.catch(() => {});
    }
    if (!opts.force) return disk;
    return await inflightRefresh;
  }

  // 无本地快照：同步拉取（首次使用，无旧快照可回退）
  if (!inflightRefresh) {
    inflightRefresh = doRefresh(opts).finally(() => {
      inflightRefresh = null;
    });
  }
  return await inflightRefresh;
}

// 强制刷新快照（admin API 手动触发）
export async function refreshSnapshot(opts: {
  filePath?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
} = {}): Promise<ModelsDevSnapshot | null> {
  return getSnapshot({ ...opts, force: true });
}

async function doRefresh(opts: {
  filePath?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<ModelsDevSnapshot | null> {
  const data = await fetchModelsDevData(opts.fetchImpl);
  if (!data) return parsedCache ?? readSnapshotFile(opts.filePath) ?? null;
  const snapshot: ModelsDevSnapshot = {
    fetchedAt: (opts.now ?? new Date()).toISOString(),
    data,
  };
  parsedCache = snapshot;
  writeSnapshotFile(snapshot, opts.filePath);
  return snapshot;
}

// 测试辅助：清空内存缓存（含 in-flight）
export function resetSnapshotCache(): void {
  parsedCache = null;
  inflightRefresh = null;
}
